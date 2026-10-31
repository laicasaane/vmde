// Task 243 — the ONE heading-anchor resolver: parses headings from raw markdown text, splits
// off an explicit `{#custom-id}` marker, computes GitHub/GitLab-flavor slugs, and resolves a
// clicked `#fragment` to a heading's ordinal INDEX in document order. Pure, no vscode/DOM
// dependency — imported by both the host (src/asset-link-actions.ts, task 243 step 4:
// `file.md#frag`) and the webview (media-src/src/, task 243 step 3: same-doc anchors), the
// same cross-tree import shape as src/echarts-theme.ts already used from media-src/src/.
//
// The index is the payoff: it's exactly what the EXISTING `scroll-to-heading` handler already
// consumes (media-src/src/message-router.ts handleScrollToHeading indexes into
// `el.querySelectorAll('h1..h6')`, and src/commands.ts's `vmde.outlineReveal` posts that same
// message by index). Resolving a fragment to an index — instead of trying to match it against a
// DOM `id` — lets both the same-doc (in-process) and cross-doc (post-message after open) cases
// reuse that ONE scroll+flash mechanism rather than inventing a second. (Measured first, task
// 243 probe: Vditor's own heading `id` attributes, even with Lute's `SetHeadingID(true)` on,
// always carry Vditor's own mode/index bookkeeping suffix — e.g. `wysiwyg-The-Heading_0`, or
// `custom-id_1` in Preview — never a bare slug a hand-authored link could match. Matching by
// DOM id was never viable; index-based resolution against our OWN parse of the source text is.)

import { ATX_HEADING, createFenceTracker } from './md-scan'

export type SlugifyMode = 'github' | 'gitlab'

interface HeadingRecord {
  level: number
  /** Display text with any trailing `{#custom-id}` marker stripped. */
  text: string
  /** Explicit `{#custom-id}` id, if the heading carries one (without `#`/braces). */
  customId?: string
  /** 0-based ordinal among ALL headings in document order — the SAME index
   *  `scroll-to-heading` expects (the Nth heading, not the Nth heading of its level). */
  index: number
  /** Zero-based source line of the heading. */
  line: number
}

// Kramdown/Lute inline-attribute-list heading-id marker: `{#custom-id}` at the END of the
// heading text (optionally preceded by whitespace). Lute only supports the bare `#id` form (no
// `.class` list) — see the task-243 probe's IR dump, which showed
// `<span data-type="heading-id"> {#custom-id}</span>` as a single-token marker — so this
// deliberately doesn't try to parse a Kramdown `{: #id .class}` attribute list.
const HEADING_ID_MARKER = /\s*\{#([^\s}]+)\}\s*$/

/** Split a raw ATX heading's text into its display portion and an explicit `{#custom-id}`,
 *  if present. Exported for the L1 unit tests to pin the marker syntax independent of the
 *  full parse/slug/resolve pipeline. */
export function extractCustomId(rawHeadingText: string): {
  text: string
  customId?: string
} {
  const m = HEADING_ID_MARKER.exec(rawHeadingText)
  if (!m) return { text: rawHeadingText }
  return { text: rawHeadingText.slice(0, m.index), customId: m[1] }
}

// GitHub's heading-slug algorithm (github-slugger, the library GitHub's own markdown renderer
// uses): lowercase, drop everything that isn't a Unicode letter/mark/number/underscore/space/
// hyphen, then turn each literal space into a hyphen. No trimming, no collapsing runs of
// hyphens/spaces — verified byte-for-byte against `github-slugger@2` for unicode, emoji,
// punctuation, leading-digit and whitespace-run cases (see test/backend/heading-slug.test.ts).
const GITHUB_STRIP = /[^\p{L}\p{N}\p{M}_ -]/gu

// GitLab's algorithm (`Gitlab::HeadingSlug.from_text`, "mimics Comrak's anchorizer"): the same
// shape as GitHub's, but keeps the whole Unicode "Connector Punctuation" category (\p{Pc} — of
// which ASCII `_` is the common case) instead of only the literal underscore. Verified against
// the actual Ruby source (`text.downcase.gsub(/[^\p{L}\p{M}\p{N}\p{Pc} -]/, '').tr(' ', '-')`)
// run locally — for every realistic heading the two flavors agree; \p{Pc} only diverges from a
// literal `_` on rare non-ASCII connector-punctuation code points.
const GITLAB_STRIP = /[^\p{L}\p{N}\p{M}\p{Pc} -]/gu

/** Slugify heading TEXT (not the whole record — callers combine this with dedupeSlugs for a
 *  whole document). No de-duplication here; see resolveFragment / dedupeSlugs for that. */
export function slugify(text: string, mode: SlugifyMode = 'github'): string {
  const stripped = text
    .toLowerCase()
    .replace(mode === 'gitlab' ? GITLAB_STRIP : GITHUB_STRIP, '')
  return stripped.replace(/ /g, '-')
}

// Both GitHub's github-slugger and GitLab's TableOfContentsFilter de-duplicate a repeated slug
// by appending `-N` (N = 1, 2, 3, … the Nth repeat) — and, subtly, a LATER heading whose slug
// happens to collide with an EARLIER heading's *already-suffixed* result gets suffixed again
// (e.g. "Foo", "Foo", "Foo-1" → "foo", "foo-1", "foo-1-1", not two "foo-1"s). A flat counter
// keyed by the un-suffixed base slug would miss that last case, so this mirrors the real
// occurrence-tracking algorithm (github-slugger's `occurrences` map) exactly rather than
// reimplementing just the common case.
function dedupeSlugs(slugs: string[]): string[] {
  const occurrences = new Map<string, number>()
  return slugs.map((original) => {
    let result = original
    while (occurrences.has(result)) {
      const n = (occurrences.get(original) ?? 0) + 1
      occurrences.set(original, n)
      result = `${original}-${n}`
    }
    occurrences.set(result, 0)
    return result
  })
}

/** Parse ATX headings out of a raw markdown STRING (not a vscode.TextDocument — the webview has
 *  no TextDocument, only `vditor.getValue()`; the host side passes `document.getText()`).
 *  Fence-aware (a `# comment` inside a fenced code block is not a heading), mirroring
 *  outline-tree.ts's `parseHeadings` — both consume the same `ATX_HEADING`/`FENCE_ANY_INDENT`
 *  from md-scan.ts so the two scanners can't drift on what counts as a heading line. */
export function parseHeadingsFromMarkdown(markdown: string): HeadingRecord[] {
  const out: HeadingRecord[] = []
  const tracker = createFenceTracker()
  let index = 0
  // Normalize CRLF so a Windows-authored doc doesn't leave a trailing \r in the heading text.
  for (const [sourceLine, rawLine] of markdown.split('\n').entries()) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    if (tracker.consume(line)) continue
    const m = ATX_HEADING.exec(line)
    if (!m) continue
    const { text, customId } = extractCustomId(m[2])
    out.push({
      level: m[1].length,
      text,
      customId,
      index: index++,
      line: sourceLine,
    })
  }
  return out
}

/** Resolve a clicked `#fragment` (already stripped of its leading `#`) against a document's
 *  headings: an explicit `{#custom-id}` match wins over a slug match, matching the task's
 *  "custom ids FIRST, then GitHub-style slugs" order. Returns the heading's ordinal index (for
 *  `scroll-to-heading`), or undefined if nothing matches. `fragment` is compared as-is — callers
 *  are responsible for any percent-decoding of the href before calling this (matching how
 *  link-target.ts already percent-decodes `local.path`, so the two stay consistent). */
export function resolveFragment(
  headings: HeadingRecord[],
  fragment: string,
  mode: SlugifyMode = 'github',
): number | undefined {
  if (!fragment) return undefined
  const byCustomId = new Map<string, number>()
  for (const h of headings) {
    if (h.customId !== undefined && !byCustomId.has(h.customId)) {
      byCustomId.set(h.customId, h.index)
    }
  }
  if (byCustomId.has(fragment)) return byCustomId.get(fragment)

  const slugs = dedupeSlugs(headings.map((h) => slugify(h.text, mode)))
  const bySlug = new Map<string, number>()
  headings.forEach((h, i) => {
    if (!bySlug.has(slugs[i])) bySlug.set(slugs[i], h.index)
  })
  return bySlug.get(fragment)
}
