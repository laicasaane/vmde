// Minimal-diff write-back (task 61).
//
// When the visual editor saves, the webview sends the full reserialized markdown
// (`vditor.getValue()`). Vditor's serialization reflows constructs the user never
// touched — table column padding, blank-line normalization, `>`-prefix spacing, … —
// so a single edit rewrites the whole file and produces a noisy git diff.
//
// This rebuilds the text to write so that every block the user did NOT actually change
// keeps its ORIGINAL bytes; only genuinely-changed blocks take Vditor's reserialized
// form. A block counts as "unchanged" iff it RESERIALIZES to the corresponding new
// block (`reserialize(originalBlock) === newBlock`): the two mean the same thing, only
// the surface bytes differ, so swapping in the original bytes is a semantic no-op and
// always safe. Any block that doesn't match — a real edit, or a context-sensitive
// block (list item, ref-using paragraph) whose isolated reserialization legitimately
// differs — falls back to the editor's output. Matching is greedy and in-order with
// consumption, so repeated identical blocks pair left-to-right.
//
// Cost note: `reserialize` is a Lute round-trip; callers should memoize it per source
// block (the original blocks don't change between edits) and gate by document size.

import { FENCE, splitRowCells } from '../shared/md-scan'

// Split markdown into blocks on blank lines, keeping fenced code blocks (``` / ~~~)
// intact even when they contain blank lines. Separators (blank-line runs) are dropped;
// callers rejoin with a single blank line. Returns [] for whitespace-only input.
export function splitBlocks(md: string): string[] {
  const lines = md.split('\n')
  const blocks: string[] = []
  let cur: string[] = []
  let fence: string | null = null
  const flush = () => {
    if (cur.length) blocks.push(cur.join('\n'))
    cur = []
  }
  for (const line of lines) {
    const m = line.match(FENCE)
    if (fence) {
      cur.push(line)
      // close on a fence of the same kind (>= length is fine for our purposes)
      if (m && line.trim().startsWith(fence[0])) fence = null
      continue
    }
    if (m) {
      // opening fence — enter fenced state; the block continues until it closes
      fence = m[1][0]
      cur.push(line)
      continue
    }
    if (line.trim() === '') {
      flush()
      continue
    }
    cur.push(line)
  }
  flush()
  return blocks
}

// Build the text to write: original bytes for unchanged blocks, editor output for the
// rest. `reserialize(b)` returns the markdown `b` serializes to, or undefined if it
// can't (Lute not warm) — undefined disables matching for that block (safe: falls back
// to the new block).
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: block-level diff matching for minimal on-save edits, with the Lute-unwarm fallback; pre-existing (task 469 baseline)
export function minimalDiffWriteback(
  original: string,
  next: string,
  reserialize: (block: string) => string | undefined,
): string {
  const ob = splitBlocks(original)
  const nb = splitBlocks(next)
  if (!ob.length || !nb.length) return next

  // Reserialized form of each original block (trailing newlines trimmed for compare).
  const trim = (s: string) => s.replace(/\n+$/, '')
  const serOb = ob.map((b) => {
    const r = reserialize(b)
    return r === undefined ? undefined : trim(r)
  })

  const used = new Array(ob.length).fill(false)
  const out: string[] = []
  let from = 0
  for (const blk of nb) {
    const key = trim(blk)
    let found = -1
    for (let k = from; k < ob.length; k++) {
      if (!used[k] && serOb[k] !== undefined && serOb[k] === key) {
        found = k
        break
      }
    }
    if (found >= 0) {
      out.push(ob[found])
      used[found] = true
      from = found + 1
    } else if (
      // No whole-block match. If this is an edited table whose original sits in the
      // next unconsumed slot, recurse one level (task 60): keep the original bytes of
      // rows/cells that are semantically unchanged so a one-cell edit can't reflow the
      // spacing of cells the user never touched.
      from < ob.length &&
      !used[from] &&
      serOb[from] !== undefined &&
      isTableBlock(blk) &&
      isTableBlock(ob[from])
    ) {
      out.push(mergeTableBlock(ob[from], blk, reserialize))
      used[from] = true
      from += 1
    } else {
      out.push(blk)
    }
  }

  // Preserve the original's trailing-newline shape so the final line never churns.
  const trailing = (original.match(/\n*$/) || [''])[0]
  return out.join('\n\n').replace(/\n*$/, '') + trailing
}

// Whole-document no-op test (task 61 v2, Layer 1). The user's NET edit is zero iff the
// editor's reserialized output `next` is semantically identical to the clean baseline
// (disk bytes at open / last save). Both operands go through the SAME whole-document
// reserialize, so the comparison is robust to constructs the block splitter can't handle:
// the IR round-trip is lossy for loose lists (they collapse to tight) — but BOTH sides
// collapse identically, so a reverted loose-list doc is still detected as a no-op. When
// detected, the caller restores the baseline bytes VERBATIM, so the document returns to
// disk exactly and the tab goes clean (fixes the dirty-after-undo bug). Returns false if
// reserialize is unavailable (cold Lute) — safe: the caller falls through to block-level
// minimization, which is what shipped before this layer existed.
export function isSemanticNoop(
  baseline: string,
  next: string,
  reserializeWhole: (md: string) => string | undefined,
): boolean {
  const a = reserializeWhole(baseline)
  if (a === undefined) return false
  const b = reserializeWhole(next)
  if (b === undefined) return false
  const norm = (s: string) => s.replace(/\r\n/g, '\n').replace(/\n+$/, '')
  return norm(a) === norm(b)
}

// A GFM table block: a `|`-bearing header line followed by a delimiter line whose
// cells are only `-`, `:` and spaces (e.g. `| --- | :-: |`).
function isTableBlock(block: string): boolean {
  const lines = block.split('\n')
  if (lines.length < 2) return false
  if (!lines[0].includes('|')) return false
  const delimCells = splitRow(lines[1])
  return (
    delimCells.length > 0 && delimCells.every((c) => /^:?-+:?$/.test(c.trim()))
  )
}

// Split one table row into trimmed cell texts (shared raw split from md-scan.ts, 185/3e).
function splitRow(line: string): string[] {
  return splitRowCells(line).map((c) => c.trim())
}

// The alignment flags of a delimiter row (`:` left/right presence per column),
// used to decide whether the original delimiter row can be kept verbatim.
function alignKey(cells: string[]): string {
  return cells
    .map((c) => `${c.startsWith(':') ? 'l' : ''}${c.endsWith(':') ? 'r' : ''}`)
    .join(',')
}

interface RowCellSpan {
  contentStart: number
  contentEnd: number
}

function isHorizontalSpace(char: string): boolean {
  return char === ' ' || char === '\t'
}

// Return replacement intervals only when this raw row has the same cells as the established
// splitRow contract. Ambiguous escaped-border and multi-backslash pipes keep the canonical fallback.
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: validates raw row boundaries and escape parity before allowing byte-preserving splices
function originalRowCellSpans(
  raw: string,
  cells: string[],
): RowCellSpan[] | null {
  const sourceEnd = raw.endsWith('\r') ? raw.length - 1 : raw.length
  let trimmedStart = 0
  let trimmedEnd = sourceEnd
  while (trimmedStart < trimmedEnd && isHorizontalSpace(raw[trimmedStart]))
    trimmedStart++
  while (trimmedEnd > trimmedStart && isHorizontalSpace(raw[trimmedEnd - 1]))
    trimmedEnd--
  if (trimmedStart === trimmedEnd) return null

  let bodyStart = trimmedStart
  let bodyEnd = trimmedEnd
  if (raw[bodyStart] === '|') bodyStart++
  if (raw[bodyEnd - 1] === '|') {
    if (raw[bodyEnd - 2] === '\\') return null
    bodyEnd--
  }

  const delimiters: number[] = []
  for (let index = bodyStart; index < bodyEnd; index++) {
    if (raw[index] !== '|') continue
    let backslashes = 0
    for (
      let previous = index - 1;
      previous >= bodyStart && raw[previous] === '\\';
      previous--
    ) {
      backslashes++
    }
    if (backslashes > 1) return null
    if (backslashes === 0) delimiters.push(index)
  }

  const spans: RowCellSpan[] = []
  let start = bodyStart
  for (const end of [...delimiters, bodyEnd]) {
    let contentStart = start
    let contentEnd = end
    while (contentStart < contentEnd && isHorizontalSpace(raw[contentStart]))
      contentStart++
    while (contentEnd > contentStart && isHorizontalSpace(raw[contentEnd - 1]))
      contentEnd--
    spans.push({ contentStart, contentEnd })
    start = end + 1
  }

  if (spans.length !== cells.length) return null
  return spans.every(
    (span, index) =>
      raw.slice(span.contentStart, span.contentEnd).trim() === cells[index],
  )
    ? spans
    : null
}

function spliceChangedRow(
  raw: string,
  originalCells: string[],
  nextCells: string[],
  changed: boolean[],
): string | null {
  const spans = originalRowCellSpans(raw, originalCells)
  if (!spans) return null
  let result = raw
  for (let index = spans.length - 1; index >= 0; index--) {
    if (!changed[index]) continue
    const span = spans[index]
    result =
      result.slice(0, span.contentStart) +
      nextCells[index] +
      result.slice(span.contentEnd)
  }
  const resultCells = splitRow(result)
  return resultCells.length === nextCells.length &&
    resultCells.every((cell, index) => cell === nextCells[index])
    ? result
    : null
}

// Merge an edited table against its original, preserving the ORIGINAL bytes of any
// row/cell that is semantically unchanged. Returns `next` unchanged when the tables
// don't line up (different row or column counts) — the safe fallback (= today's
// behavior). A cell is "unchanged" iff it reserializes (inside a table) to the same
// thing as the editor's cell, so swapping the original text back is a semantic no-op.
export function mergeTableBlock(
  original: string,
  next: string,
  reserialize: (block: string) => string | undefined,
): string {
  const oLines = original.split('\n')
  const nLines = next.split('\n')
  if (oLines.length !== nLines.length) return next

  // Reserialize a single cell inside a 1-column table so the comparison sees the same
  // trim Lute applies in real table context. Memoized per call.
  const cellCache = new Map<string, string | undefined>()
  const cellRT = (text: string): string | undefined => {
    if (cellCache.has(text)) return cellCache.get(text)
    const r = reserialize(`| ${text.replace(/\|/g, '\\|')} |\n| - |`)
    const v = r === undefined ? undefined : splitRow(r.split('\n')[0])[0]
    cellCache.set(text, v)
    return v
  }
  // Two cells are equivalent if identical, or if they reserialize identically (so the
  // only difference is reflow the editor would apply anyway, e.g. the task-60 trim).
  const cellEq = (a: string, b: string): boolean => {
    if (a === b) return true
    const ra = cellRT(a)
    const rb = cellRT(b)
    return ra !== undefined && ra === rb
  }

  const mergedLines: string[] = []
  for (let r = 0; r < oLines.length; r++) {
    const oRaw = oLines[r]
    const nRaw = nLines[r]
    if (oRaw === nRaw) {
      mergedLines.push(oRaw)
      continue
    }
    const oCells = splitRow(oRaw)
    const nCells = splitRow(nRaw)
    if (oCells.length !== nCells.length) return next

    // Delimiter row (always row index 1): structural — keep the original bytes when
    // the alignment is unchanged, else take the editor's.
    if (r === 1) {
      mergedLines.push(alignKey(oCells) === alignKey(nCells) ? oRaw : nRaw)
      continue
    }

    let allKept = true
    const changed: boolean[] = []
    const cells = nCells.map((nCell, c) => {
      if (cellEq(oCells[c], nCell)) {
        changed.push(false)
        return oCells[c]
      }
      allKept = false
      changed.push(true)
      return nCell
    })
    // Whole rows retain their original bytes. Changed rows replace only proven content spans;
    // the established canonical form remains the safe fallback for ambiguous raw boundaries.
    mergedLines.push(
      allKept
        ? oRaw
        : (spliceChangedRow(oRaw, oCells, cells, changed) ??
            `| ${cells.join(' | ')} |`),
    )
  }
  return mergedLines.join('\n')
}

// Task 390 — force ONE explicitly-changed block into the write-back.
//
// The link button turning a selected URL into `[url](url)` produces a document that is SEMANTICALLY
// IDENTICAL to what is on disk: GFM autolinks a bare `https://x`, so both sides reserialize to the
// same canonical markdown (measured against our pinned Lute). The minimal-diff write-back therefore
// classifies the edit as a no-op and keeps the original bytes — correct as a general rule, and the
// reason an edit never reflows blocks the user did not touch, but it also means a deliberate button
// press would leave the file unchanged.
//
// So the webview names the single block it changed, and only that block's bytes are replaced. Every
// other block keeps its original bytes, which is what makes this safe to apply on top of the normal
// minimization rather than instead of it.
export function applyExplicitBlock(
  text: string,
  explicitBlock: string,
  reserialize: (block: string) => string | undefined,
): string {
  const trim = (s: string) => s.replace(/\n+$/, '')
  const wanted = reserialize(explicitBlock)
  if (wanted === undefined) return text
  const target = trim(explicitBlock)
  // Walk the blocks by OFFSET rather than rejoining them: splitBlocks drops the blank-line
  // separators, so reassembling would normalise spacing the user never touched — the exact thing
  // the minimal diff exists to avoid. Replacing one slice in place leaves every byte around it.
  let cursor = 0
  for (const block of splitBlocks(text)) {
    const at = text.indexOf(block, cursor)
    if (at < 0) continue
    cursor = at + block.length
    // Already written in the explicit form — nothing to force.
    if (trim(block) === target) return text
    const canonical = reserialize(block)
    if (canonical === undefined || trim(canonical) !== trim(wanted)) continue
    // The FIRST canonical match only: the block is identified by meaning, and an identical
    // paragraph elsewhere in the document is not the one the user just acted on.
    return text.slice(0, at) + target + text.slice(at + block.length)
  }
  return text
}
