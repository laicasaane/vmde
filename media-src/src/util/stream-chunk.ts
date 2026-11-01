// Pure chunking + reference-definition logic for the streaming IR render (task 49).
// Kept free of Vditor/DOM imports so it can be unit-tested in plain Node (vitest);
// the DOM/Vditor-coupled driver lives in stream-render.ts.

// Chunk size — mirror src/lute-host.ts MAX_PRERENDER_CHARS (separate build units;
// keep in sync). Bench: a 4 KB IR render blocks ~11-18 ms (warm).
export const STREAM_CHUNK_CHARS = 4_000

const BLOCKQUOTE_PREFIX = '(?: {0,3}> ?)*'
const LIST_MARKER_RE = new RegExp(
  `^${BLOCKQUOTE_PREFIX} {0,3}(?:[-+*]|\\d+[.)])\\s+`,
)
const LIST_CONTINUATION_RE = /^(?: {2,}|\t| {0,3}> ?)/

interface SourceLine {
  text: string
  start: number
  end: number
}

function sourceLines(markdown: string): SourceLine[] {
  const lines: SourceLine[] = []
  const pattern = /([^\n]*)(\n|$)/g
  for (;;) {
    const match = pattern.exec(markdown)
    if (!match || match[0] === '') break
    lines.push({
      text: match[1],
      start: match.index,
      end: match.index + match[0].length,
    })
    if (!match[2]) break
  }
  return lines
}

function continuesListRun(line: string, afterBlank: boolean): boolean {
  return (
    LIST_MARKER_RE.test(line) || LIST_CONTINUATION_RE.test(line) || !afterBlank
  )
}

function listRuns(markdown: string): Array<[number, number]> {
  const lines = sourceLines(markdown)
  const runs: Array<[number, number]> = []
  for (let index = 0; index < lines.length; index++) {
    if (!LIST_MARKER_RE.test(lines[index].text)) continue
    const start = lines[index].start
    let end = lines[index].end
    let scan = index + 1
    let sawBlank = false
    while (scan < lines.length) {
      const line = lines[scan]
      if (line.text.trim() === '') {
        sawBlank = true
        scan++
        continue
      }
      if (!continuesListRun(line.text, sawBlank)) break
      sawBlank = false
      end = line.end
      scan++
    }
    runs.push([start, end])
    index = scan - 1
  }
  return runs
}

// A cold Lute parse derives tightness, ordinals, and marker classes from the whole list. If a
// candidate boundary lands inside one run, keep that run in one chunk: back up when its start is a
// useful cut, otherwise allow one oversize chunk through the run's end. Losslessness is unchanged.
function avoidListSplit(
  runs: Array<[number, number]>,
  chunkStart: number,
  cut: number,
  size: number,
): number {
  const absoluteCut = chunkStart + cut
  const run = runs.find(
    ([start, end]) => absoluteCut > start && absoluteCut < end,
  )
  if (!run) return cut
  const start = run[0] - chunkStart
  const end = run[1] - chunkStart
  return start >= size / 2 ? start : end
}

// Split markdown into successive block-boundary chunks (same logic as
// src/lute-host.ts:prerenderPrefix, applied repeatedly): cut on a blank line, else a
// newline, and drop a dangling unterminated ``` fence so a chunk never ends mid-code.
// Lossless: the chunks concatenate back to the input exactly.
// Task 643: full Preview chunks at a larger `size` than the edit modes' default.
export function chunkize(
  md: string,
  size: number = STREAM_CHUNK_CHARS,
): string[] {
  const chunks: string[] = []
  let rest = md
  let consumed = 0
  const runs = listRuns(md)
  while (rest.length > size) {
    let s = rest.slice(0, size)
    const blank = s.lastIndexOf('\n\n')
    if (blank >= size / 2) {
      s = s.slice(0, blank)
    } else {
      const nl = s.lastIndexOf('\n')
      if (nl > 0) s = s.slice(0, nl)
    }
    const fences = [...s.matchAll(/^```/gm)]
    if (fences.length % 2 === 1) s = s.slice(0, fences[fences.length - 1].index)
    s = rest.slice(0, avoidListSplit(runs, consumed, s.length, size))
    if (s.length === 0) s = rest.slice(0, size) // safety: never empty
    chunks.push(s)
    rest = rest.slice(s.length)
    consumed += s.length
  }
  if (rest.length) chunks.push(rest)
  return chunks
}

const RE_FN_DEF = /^\s{0,3}\[\^([^\]]+)\]:/
const RE_LINK_DEF = /^\s{0,3}\[([^\]^][^\]]*)\]:\s*\S/
const norm = (l: string) => l.trim().toLowerCase().replace(/\s+/g, ' ')

// Map every reference/footnote definition label → its source line(s). Footnote defs
// may have indented continuation lines; consume them so the whole def is injected.
// Footnote labels are keyed with a leading "^" to keep them distinct from link refs.
export function buildDefMap(md: string): Map<string, string> {
  const lines = md.split('\n')
  const map = new Map<string, string>()
  for (let i = 0; i < lines.length; i++) {
    let m = lines[i].match(RE_FN_DEF)
    if (m) {
      let def = lines[i]
      let j = i + 1
      while (j < lines.length && /^(\s{4,}|\t)/.test(lines[j])) {
        def += `\n${lines[j]}`
        j++
      }
      map.set(`^${norm(m[1])}`, def)
      i = j - 1
      continue
    }
    m = lines[i].match(RE_LINK_DEF)
    if (m) map.set(norm(m[1]), lines[i])
  }
  return map
}

// Labels DEFINED inside a chunk (so we don't re-inject — and strip — its own defs).
export function definedIn(chunk: string): Set<string> {
  const s = new Set<string>()
  for (const line of chunk.split('\n')) {
    let m = line.match(RE_FN_DEF)
    if (m) {
      s.add(`^${norm(m[1])}`)
      continue
    }
    m = line.match(RE_LINK_DEF)
    if (m) s.add(norm(m[1]))
  }
  return s
}

// Labels USED in a chunk: [text][label], [label][], and footnote refs [^label].
export function usedIn(chunk: string): Set<string> {
  const s = new Set<string>()
  for (const m of chunk.matchAll(/\]\[([^\]]+)\]/g)) s.add(norm(m[1]))
  for (const m of chunk.matchAll(/\[([^\]^][^\]]*)\]\[\]/g)) s.add(norm(m[1]))
  for (const m of chunk.matchAll(/\[\^([^\]]+)\]/g)) s.add(`^${norm(m[1])}`)
  return s
}

// The external defs a chunk needs (cited but not defined locally), as injectable
// markdown text plus the label sets to strip back out after render. A label prefixed
// with "^" is a footnote.
export function externalDefsFor(
  chunk: string,
  defMap: Map<string, string>,
): { text: string; linkLabels: Set<string>; fnLabels: Set<string> } {
  const used = usedIn(chunk)
  const have = definedIn(chunk)
  const linkLabels = new Set<string>()
  const fnLabels = new Set<string>()
  let text = ''
  for (const lbl of used) {
    if (have.has(lbl) || !defMap.has(lbl)) continue
    text += `${defMap.get(lbl)}\n`
    if (lbl.startsWith('^')) fnLabels.add(lbl)
    else linkLabels.add(lbl)
  }
  return { text, linkLabels, fnLabels }
}

// Normalize a label the same way the maps/sets do — used by the DOM strip in
// stream-render.ts to match rendered def blocks back to injected labels.
export const normLabel = norm
