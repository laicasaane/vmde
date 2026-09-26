// Task 196 rework — exact-source ↔ rendered-text offset alignment. Vditor's serialization (and SV's
// text) differs from the exact file bytes in normalized regions (table padding, bullets, blank
// lines). A bounded Myers diff pairs the unchanged characters; an exact offset maps only inside
// such an equal run, so a match in normalized source is reported unmappable instead of guessed.

/** One run of identical characters: `exact[exactStart + i] === rendered[renderedStart + i]`. */
interface EqualRun {
  exactStart: number
  renderedStart: number
  length: number
}

export interface OffsetAlignment {
  /** The rendered offset for an exact offset inside (or at an edge of) an equal run, else null.
   * `start` prefers a run beginning at `offset`; `end` prefers a run ending there. */
  toRendered(offset: number, bias: 'start' | 'end'): number | null
}

// Line diffs of large documents stay well inside this; beyond it only the common prefix and
// suffix are aligned (the middle is reported unmappable, never approximated).
const LINE_DIFF_LIMIT = 2000
const CHAR_DIFF_LIMIT = 600
const CHAR_HUNK_LIMIT = 20_000

/** Myers' O((N+M)D) diff; returns the matched index pairs in order, or null past `limit` edits. */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the standard forward pass plus trace backtrack of Myers' algorithm.
function myersPairs(
  n: number,
  m: number,
  same: (a: number, b: number) => boolean,
  limit: number,
): Array<[number, number]> | null {
  const max = Math.min(n + m, limit)
  const offset = max + 1
  const v = new Int32Array(2 * max + 3)
  const trace: Int32Array[] = []
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice())
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])
          ? v[offset + k + 1]
          : v[offset + k - 1] + 1
      let y = x - k
      while (x < n && y < m && same(x, y)) {
        x++
        y++
      }
      v[offset + k] = x
      if (x >= n && y >= m) {
        const pairs: Array<[number, number]> = []
        let cx = n
        let cy = m
        for (let step = d; step > 0; step--) {
          const previous = trace[step]
          const ck = cx - cy
          const pk =
            ck === -step ||
            (ck !== step &&
              previous[offset + ck - 1] < previous[offset + ck + 1])
              ? ck + 1
              : ck - 1
          const px = previous[offset + pk]
          const py = px - pk
          while (cx > px && cy > py) pairs.push([--cx, --cy])
          cx = px
          cy = py
        }
        while (cx > 0 && cy > 0) pairs.push([--cx, --cy])
        return pairs.reverse()
      }
    }
  }
  return null
}

function lineTokens(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/gu) ?? []
}

function appendRun(
  runs: EqualRun[],
  exactStart: number,
  renderedStart: number,
  length: number,
): void {
  if (length <= 0) return
  const last = runs.at(-1)
  if (
    last &&
    last.exactStart + last.length === exactStart &&
    last.renderedStart + last.length === renderedStart
  )
    last.length += length
  else runs.push({ exactStart, renderedStart, length })
}

function charRuns(
  runs: EqualRun[],
  exact: string,
  rendered: string,
  exactBase: number,
  renderedBase: number,
): void {
  if (!exact.length || !rendered.length) return
  if (exact.length > CHAR_HUNK_LIMIT || rendered.length > CHAR_HUNK_LIMIT)
    return
  const pairs = myersPairs(
    exact.length,
    rendered.length,
    (a, b) => exact.charCodeAt(a) === rendered.charCodeAt(b),
    CHAR_DIFF_LIMIT,
  )
  for (const [a, b] of pairs ?? [])
    appendRun(runs, exactBase + a, renderedBase + b, 1)
}

interface Lines {
  lines: string[]
  starts: number[]
  base: number
}

function lines(text: string, base: number): Lines {
  const tokens = lineTokens(text)
  const starts = [0]
  for (const line of tokens) starts.push(starts.at(-1)! + line.length)
  return { lines: tokens, starts, base }
}

function sliceLines(source: Lines, from: number, to: number): Lines {
  return {
    lines: source.lines.slice(from, to),
    starts: source.starts
      .slice(from, to + 1)
      .map((start) => start - source.starts[from]),
    base: source.base + source.starts[from],
  }
}

function joined(source: Lines): string {
  return source.lines.join('')
}

/** Walk line pairs in order, handing each paired line and each unpaired gap between them on. */
function walkPairs(
  exact: Lines,
  rendered: Lines,
  pairs: Array<[number, number]>,
  onPair: (a: number, b: number) => void,
  onGap: (exactGap: Lines, renderedGap: Lines) => void,
): void {
  let ea = 0
  let ra = 0
  const end: [number, number] = [exact.lines.length, rendered.lines.length]
  for (const [a, b] of [...pairs, end]) {
    if (a > ea || b > ra)
      onGap(sliceLines(exact, ea, a), sliceLines(rendered, ra, b))
    if (a < exact.lines.length) onPair(a, b)
    ea = a + 1
    ra = b + 1
  }
}

// Blank lines carry no identity: Vditor adds or drops them around blocks, and pairing one blank
// line with another across a table would strand the whole table. They never anchor a pairing and
// are aligned by the character diff of the gap they fall into.
function anchors(line: string): boolean {
  return line.trim() !== ''
}

// Markdown normalization rewrites table padding, delimiter dashes, pipes and bullet markers;
// lines equal under this key are the same logical line and are character-diffed pairwise.
function lineKey(line: string): string {
  return line.replace(/[\s|:*+-]/gu, '')
}

/** A changed hunk. Lines that pair by `lineKey` are character-diffed one pair at a time (a wide
 * padded table stays a series of small per-row diffs instead of one diff past the edit bound);
 * the unpaired lines between them are diffed together. Only characters proven equal by those
 * diffs are aligned, so the key never decides an offset by itself. */
function hunkRuns(runs: EqualRun[], exact: Lines, rendered: Lines): void {
  const exactKeys = exact.lines.map(lineKey)
  const renderedKeys = rendered.lines.map(lineKey)
  const pairs =
    myersPairs(
      exactKeys.length,
      renderedKeys.length,
      (a, b) => exactKeys[a] === renderedKeys[b] && exactKeys[a] !== '',
      LINE_DIFF_LIMIT,
    ) ?? []
  walkPairs(
    exact,
    rendered,
    pairs,
    (a, b) =>
      charRuns(
        runs,
        exact.lines[a],
        rendered.lines[b],
        exact.base + exact.starts[a],
        rendered.base + rendered.starts[b],
      ),
    (exactGap, renderedGap) =>
      charRuns(
        runs,
        joined(exactGap),
        joined(renderedGap),
        exactGap.base,
        renderedGap.base,
      ),
  )
}

function middleRuns(
  runs: EqualRun[],
  exactText: string,
  renderedText: string,
  exactBase: number,
  renderedBase: number,
): void {
  const exact = lines(exactText, exactBase)
  const rendered = lines(renderedText, renderedBase)
  const pairs = myersPairs(
    exact.lines.length,
    rendered.lines.length,
    (a, b) => exact.lines[a] === rendered.lines[b] && anchors(exact.lines[a]),
    LINE_DIFF_LIMIT,
  )
  if (!pairs) return
  walkPairs(
    exact,
    rendered,
    pairs,
    (a, b) =>
      appendRun(
        runs,
        exact.base + exact.starts[a],
        rendered.base + rendered.starts[b],
        exact.lines[a].length,
      ),
    (exactGap, renderedGap) => hunkRuns(runs, exactGap, renderedGap),
  )
}

/** Align exact source to a rendered text. Identical inputs map one to one. */
export function alignText(exact: string, rendered: string): OffsetAlignment {
  const runs: EqualRun[] = []
  if (exact === rendered) appendRun(runs, 0, 0, exact.length)
  else {
    let prefix = 0
    const shortest = Math.min(exact.length, rendered.length)
    while (
      prefix < shortest &&
      exact.charCodeAt(prefix) === rendered.charCodeAt(prefix)
    )
      prefix++
    let suffix = 0
    while (
      suffix < shortest - prefix &&
      exact.charCodeAt(exact.length - 1 - suffix) ===
        rendered.charCodeAt(rendered.length - 1 - suffix)
    )
      suffix++
    appendRun(runs, 0, 0, prefix)
    middleRuns(
      runs,
      exact.slice(prefix, exact.length - suffix),
      rendered.slice(prefix, rendered.length - suffix),
      prefix,
      prefix,
    )
    appendRun(runs, exact.length - suffix, rendered.length - suffix, suffix)
  }
  return {
    toRendered: (offset, bias) => {
      // Last run starting at or before `offset`; with an `end` bias a run ending exactly at
      // `offset` wins over one starting there.
      let low = 0
      let high = runs.length - 1
      let found = -1
      while (low <= high) {
        const middle = (low + high) >> 1
        if (runs[middle].exactStart <= offset) {
          found = middle
          low = middle + 1
        } else high = middle - 1
      }
      if (found < 0) return null
      let run = runs[found]
      if (
        bias === 'end' &&
        run.exactStart === offset &&
        found > 0 &&
        runs[found - 1].exactStart + runs[found - 1].length === offset
      )
        run = runs[found - 1]
      const delta = offset - run.exactStart
      return delta <= run.length ? run.renderedStart + delta : null
    },
  }
}
