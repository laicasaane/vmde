/**
 * Task 196 Checkpoint 1 — shared fixture text, derived query tokens, and pure cross-check helpers
 * for the Find & Replace specs (`find-replace.spec.ts`, `find-replace-large.spec.ts`). Factored out
 * so both files derive counts from the SAME loaded fixture text with the SAME logic rather than
 * duplicating it (jscpd budget) or drifting out of sync.
 *
 * Test fixture scope (task record, 2026-09-26): every Find & Replace test in this rework uses only
 * this fixture — no small control document, no other Markdown fixture. The token literals below are
 * short (4-10 letter) ASCII strings picked by a one-off analysis script that regexed the loaded text
 * for exact-case whole-word candidates; every COUNT used in an assertion is recomputed from the
 * fixture text at test time by the functions below, never a number copied from a rendered DOM.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'

export const FIXTURE = readFileSync(
  path.join(__dirname, 'fixtures', 'large-observable-models-synthetic.md'),
  'utf8',
)
export const FIXTURE_SHA256 =
  'a4a39d6f6c605eb82b0e03a236f67388bceeae9a85450b0d4285053b28299f65'

/** Prose+fence+table cross-region token; the same one Part 1's manual probe typed ("F" -> "Fggf"). */
export const QUERY_TOKEN = 'FGGF'
/** Smaller cross-region footprint (prose+fence+table) than QUERY_TOKEN, for lighter mapping checks. */
export const CROSS_REGION_TOKEN = 'ncjw'
/** Exactly 2 case-sensitive whole-word matches, both on one prose line — same-block repeat case. */
export const PAIR_TOKEN = 'etkwysrw'
/** Exactly 1 case-sensitive whole-word match, inside a bold span in a table cell — marker-safe
 * inline-formatting replace case. */
export const BOLD_TOKEN = 'Ldbw'
/** Globally unique (case-insensitive) plain-prose word, touching no markdown syntax — the cheapest
 * possible single-match replace, used for the WYSIWYG/SV shared-transaction case. */
export const UNIQUE_PROSE_TOKEN = 'ldbsra'

export function wholeWordCount(
  text: string,
  token: string,
  caseSensitive: boolean,
): number {
  const flags = caseSensitive ? 'g' : 'gi'
  return (text.match(new RegExp(`\\b${token}\\b`, flags)) ?? []).length
}

export function substringCount(
  text: string,
  token: string,
  caseSensitive: boolean,
): number {
  const flags = caseSensitive ? 'g' : 'gi'
  return (text.match(new RegExp(token, flags)) ?? []).length
}

export type LineKind = 'prose' | 'fence' | 'table' | 'delim' | 'fence-marker'

export function classifyLines(text: string): LineKind[] {
  let inFence = false
  return text.split('\n').map((line): LineKind => {
    if (/^ {0,3}(`{3,}|~{3,})/.test(line)) {
      inFence = !inFence
      return 'fence-marker'
    }
    if (inFence) return 'fence'
    if (/^\s*\|?\s*:?-{1,}:?\s*(?:\|\s*:?-{1,}:?\s*)+\|?\s*$/.test(line))
      return 'delim'
    if (line.includes('|')) return 'table'
    return 'prose'
  })
}

export function regionCounts(
  text: string,
  token: string,
  caseSensitive: boolean,
): { prose: number; fence: number; table: number } {
  const kinds = classifyLines(text)
  const flags = caseSensitive ? 'g' : 'gi'
  const re = new RegExp(`\\b${token}\\b`, flags)
  const out = { prose: 0, fence: 0, table: 0 }
  text.split('\n').forEach((line, index) => {
    const kind = kinds[index]
    if (kind !== 'prose' && kind !== 'fence' && kind !== 'table') return
    out[kind] += (line.match(re) ?? []).length
  })
  return out
}

/** Literal, non-overlapping match offsets — a local re-derivation of `findMarkdownMatches`'s search
 * semantics (case fold, no regex) kept separate from product source so these test files have no
 * import dependency on `selection-scope.ts` (avoids bundling its DOM-only code into the Node test
 * runner that executes this file directly, outside a browser). */
export function literalMatches(
  text: string,
  token: string,
  caseSensitive: boolean,
): { start: number; end: number }[] {
  const hay = caseSensitive ? text : text.toLowerCase()
  const needle = caseSensitive ? token : token.toLowerCase()
  const out: { start: number; end: number }[] = []
  let from = 0
  for (;;) {
    const index = hay.indexOf(needle, from)
    if (index < 0) break
    out.push({ start: index, end: index + token.length })
    from = index + token.length
  }
  return out
}

export function applyReplacements(
  text: string,
  matches: { start: number; end: number }[],
  replacement: string,
): string {
  let out = ''
  let cursor = 0
  for (const match of matches) {
    out += text.slice(cursor, match.start) + replacement
    cursor = match.end
  }
  return out + text.slice(cursor)
}
