import type Vditor from 'vditor'
import { innerVditor } from '../util/inner-vditor'
import {
  activeModeElement,
  blockIndexForRevealLine,
  lineStartOffset,
  offsetToLine,
  readableSourceLines,
  sourceLineForReveal,
} from '../util/source-map'
import {
  currentBlockProjection,
  resolveAdvisoryBlockHandleUnits,
  resolveBlockHandleUnits,
} from './block-handle'
import { unitFeedOf, type UnitFeed, type UnitLines } from '../util/unit-changes'
import { logToHost } from '../util/webview-log'
import {
  ensureHoistBlockVisible,
  ensureHoistTargetVisible,
} from './section-hoist'
import { topLevelBlocks } from './section-range'
import { ensureFoldTargetVisible } from './section-fold'
import { scrollBehavior } from '../util/reduced-motion'

// Flash the heading you click in the outline (task 13). Vditor's outline items
// carry `span[data-target-id]` = the heading element's id; after Vditor scrolls
// to it, we flash that heading. Mode-independent (IR/WYSIWYG/SV) — it resolves
// the heading by id, so there is no source-line mapping to get wrong.

export const FLASH_CLASS = 'heading-flash'
const SCROLL_SETTLE_MS = 60
const FLASH_DURATION_MS = 1400

export function setupOutlineFlash(vditor: Vditor): void {
  const outlineEl: HTMLElement | undefined = (vditor as any)?.vditor?.outline
    ?.element
  if (!outlineEl) {
    return
  }
  // Capture phase: Vditor's own outline handler (on the inner list) calls
  // stopPropagation() on item clicks, so a bubble-phase listener here would
  // never fire. Capture runs top-down before that, so we still see the click.
  outlineEl.addEventListener(
    'click',
    (e) => {
      const item = (e.target as HTMLElement | null)?.closest('[data-target-id]')
      const id = item?.getAttribute('data-target-id')
      if (!id) {
        return
      }
      const index = Array.from(
        outlineEl.querySelectorAll<HTMLElement>('[data-target-id]'),
      ).indexOf(item as HTMLElement)
      if (index >= 0) ensureHoistTargetVisible(index)
      // Let Vditor scroll first, then flash the heading it landed on.
      setTimeout(() => flashHeading(id), SCROLL_SETTLE_MS)
    },
    true,
  )
}

// A trusted pointer click moves the selection into Vditor's non-editable inline
// ToC before its IR bubble listener runs, and that listener can abort before its
// own scroll step. Capture the generated target id first; the heading stays the
// scroll authority and the editable DOM is untouched.
export function setupInlineTocNavigation(): void {
  document.getElementById('app')?.addEventListener(
    'click',
    (event) => {
      const row = (event.target as HTMLElement | null)?.closest<HTMLElement>(
        '.vditor-ir .vditor-toc [data-target-id]',
      )
      const target = row
        ?.closest('.vditor-ir')
        ?.querySelector<HTMLElement>(`#${CSS.escape(row.dataset.targetId!)}`)
      if (!target) return
      event.stopPropagation()
      target.scrollIntoView({ block: 'start' })
    },
    true,
  )
}

function flashElement(el: HTMLElement): void {
  el.classList.add(FLASH_CLASS)
  setTimeout(() => el.classList.remove(FLASH_CLASS), FLASH_DURATION_MS)
}

function flashHeading(id: string): void {
  const heading = document.getElementById(id)
  if (!heading) {
    return
  }
  flashElement(heading)
}

function sourceRevealCaretTarget(block: HTMLElement): Node {
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      const parent = node.parentElement
      return parent?.closest(
        '.vditor-ir__marker, .vditor-ir__preview, [data-render]',
      )
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT
    },
  })
  return walker.nextNode() ?? block
}

// Task 730 — a source block of the live document: one top-level block or one list item, with the
// source span it owns (offsets into `getValue()`).
interface RevealUnit {
  element: HTMLElement
  members: HTMLElement[]
  start: number
  end: number
}

interface RevealPoint {
  node: Node
  offset: number
}

/** Task 730 — the unit that holds `offset`: the owning unit, else (a blank separator line) the
 * next one, else the last. Spans are in document order. */
export function spanIndexForOffset(
  spans: readonly { start: number; end: number }[],
  offset: number,
): number | null {
  if (spans.length === 0) return null
  const owning = spans.findIndex(
    (span) => offset >= span.start && offset < span.end,
  )
  if (owning >= 0) return owning
  const next = spans.findIndex((span) => span.start > offset)
  return next >= 0 ? next : spans.length - 1
}

// Task 730 — the scanner's block count drifts from Vditor's DOM on a list with blank lines
// between its items (the scanner splits it, Vditor keeps one <ol>): measured 242 scanner blocks
// for 185 DOM blocks, so a line near the end of a long document mapped past the last block and
// the reveal gave up. The block handle's units pair each top-level block and list item with its
// source span through Lute serialization; when they cannot be paired, the caller falls back to
// the scanner.
function revealUnits(editor: HTMLElement, markdown: string): RevealUnit[] {
  const units =
    resolveBlockHandleUnits(
      editor,
      markdown,
      markdown,
      currentBlockProjection(),
    ) ?? resolveAdvisoryBlockHandleUnits(editor, markdown)
  return units ? [...units].sort((left, right) => left.start - right.start) : []
}

// Text that is not on screen in IR/WYSIWYG: hidden marker source, rendered previews, the hidden
// code source of a WYSIWYG code block, and decorations.
const HIDDEN_TEXT =
  '.vditor-ir__marker, .vditor-ir__preview, [data-render], .vditor-wysiwyg__pre, svg, .katex-mathml, .vditor-copy'
const LINE_BREAKING = /^(P|LI|TR|TD|TH|H[1-6]|BLOCKQUOTE|PRE|DIV|UL|OL|TABLE)$/u
const LINE_ELEMENT =
  'p, li, tr, h1, h2, h3, h4, h5, h6, blockquote, pre, dt, dd'

interface TextSegment {
  node: Text
  start: number
  end: number
}

/** The visible text of `members`, one line per block element, with the text node of every
 * character (like Preview Find's collector, for the edit surface). */
function visibleText(members: readonly HTMLElement[]): {
  text: string
  segments: TextSegment[]
} {
  let text = ''
  const segments: TextSegment[] = []
  const breakLine = () => {
    if (text !== '' && !text.endsWith('\n')) text += '\n'
  }
  const visit = (node: Node): void => {
    if (node instanceof Text) {
      segments.push({
        node,
        start: text.length,
        end: text.length + node.data.length,
      })
      text += node.data
      return
    }
    if (!(node instanceof HTMLElement) || node.matches(HIDDEN_TEXT)) return
    const breaks = LINE_BREAKING.test(node.tagName)
    if (breaks) breakLine()
    for (const child of Array.from(node.childNodes)) visit(child)
    if (breaks) breakLine()
  }
  for (const member of members) visit(member)
  return { text, segments }
}

function pointAt(
  segments: readonly TextSegment[],
  offset: number,
  bias: 'start' | 'end',
): RevealPoint | null {
  const found =
    bias === 'end'
      ? segments.find((s) => offset > s.start && offset <= s.end)
      : segments.find((s) => offset >= s.start && offset < s.end)
  return found ? { node: found.node, offset: offset - found.start } : null
}

// The prefixes of a readable line tried in turn, longest first: inline syntax the readable form
// keeps (math, emoji shortcodes, entities) can stop a long prefix from matching.
function needles(readable: string): string[] {
  const firstWord = readable.split(' ')[0] ?? ''
  return [readable.slice(0, 24), readable.slice(0, 12), firstWord]
    .map((needle) => needle.trim())
    .filter((needle, index, all) => needle && all.indexOf(needle) === index)
}

/** Task 730 — where `targetLine` starts in a unit's visible text: walk the unit's source lines in
 * order and find each line's readable start after the previous one, so a word repeated on an
 * earlier line is not taken. Null when the target line's text is not on screen (a code line
 * hidden behind its preview, a blank line). */
function lineOffsetInUnit(
  text: string,
  readable: readonly string[],
  firstLine: number,
  targetLine: number,
): number | null {
  let cursor = 0
  for (let line = firstLine; line <= targetLine; line++) {
    let found = -1
    let length = 0
    for (const needle of needles(readable[line] ?? '')) {
      found = text.indexOf(needle, cursor)
      length = needle.length
      if (found >= 0) break
    }
    if (line === targetLine) return found >= 0 ? found : null
    if (found >= 0) cursor = found + length
  }
  return null
}

interface LinePlace {
  unit: { element: HTMLElement; members: readonly HTMLElement[] }
  start: RevealPoint
  end: RevealPoint
  lineElement: HTMLElement
}

// Where 0-based getValue() line `line` sits in the live edit surface.
function placeLine(
  units: readonly RevealUnit[],
  markdown: string,
  readable: readonly string[],
  line: number,
): LinePlace | null {
  const index = spanIndexForOffset(units, lineStartOffset(markdown, line))
  const unit = index === null ? undefined : units[index]
  if (!unit) return null
  return placeInUnit(unit, readable, offsetToLine(markdown, unit.start), line)
}

// Where `line` sits inside one unit whose first source line is `firstLine`; `readable` holds the
// readable text of the source lines the unit's lines index into.
function placeInUnit(
  unit: { element: HTMLElement; members: readonly HTMLElement[] },
  readable: readonly string[],
  firstLine: number,
  line: number,
): LinePlace {
  const { text, segments } = visibleText(unit.members)
  const offset =
    line >= firstLine ? lineOffsetInUnit(text, readable, firstLine, line) : null
  const startPoint = offset === null ? null : pointAt(segments, offset, 'start')
  const lineEnd =
    offset === null
      ? null
      : text.indexOf('\n', offset) < 0
        ? text.length
        : text.indexOf('\n', offset)
  const endPoint = lineEnd === null ? null : pointAt(segments, lineEnd, 'end')
  const fallback = {
    node: sourceRevealCaretTarget(unit.element),
    offset: 0,
  }
  const start = startPoint ?? fallback
  const parent =
    start.node instanceof HTMLElement ? start.node : start.node.parentElement
  const candidate = startPoint
    ? parent?.closest<HTMLElement>(LINE_ELEMENT)
    : null
  return {
    unit,
    start,
    end: endPoint ?? start,
    lineElement:
      candidate && unit.element.contains(candidate) ? candidate : unit.element,
  }
}

function topLevelAncestor(
  editor: HTMLElement,
  element: HTMLElement,
): HTMLElement {
  let current = element
  while (current.parentElement && current.parentElement !== editor)
    current = current.parentElement
  return current
}

/** Task 733 / 006 — the unit that holds `line`: the owning unit, else (a blank separator line) the
 * next one, else the last; 0 before the first. Same semantics as `spanIndexForOffset`. */
export function unitIndexForLine(
  lines: readonly { startLine: number; endLine: number }[],
  line: number,
): number {
  let lo = 0
  let hi = lines.length - 1
  let at = 0
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (lines[mid]!.startLine <= line) {
      at = mid
      lo = mid + 1
    } else hi = mid - 1
  }
  return line > (lines[at]?.endLine ?? 0) && at + 1 < lines.length ? at + 1 : at
}

// The unit's Markdown serialized alone through the live Lute (a list item inside a shallow copy of
// its list, Q-47); `undefined` when Lute is missing or throws.
function unitMarkdown(
  vditor: any,
  members: readonly HTMLElement[],
  el: HTMLElement,
  isItem: boolean,
): string | undefined {
  const lute = vditor?.vditor?.lute
  if (!lute) return undefined
  try {
    let html = members.map((member) => member.outerHTML).join('')
    if (isItem && el.parentElement) {
      const shell = el.parentElement.cloneNode(false) as HTMLElement
      shell.innerHTML = html
      html = shell.outerHTML
    }
    return (lute.VditorIRDOM2Md(html) as string).replace(/^\n+/, '')
  } catch {
    return undefined
  }
}

// Where host line `line` sits inside its unit; `null` sends the caller to the existing path.
function placeFromUnit(
  vditor: any,
  feed: UnitFeed,
  entry: UnitLines,
  line: number,
): LinePlace | null {
  const el = entry.el
  // A root child that wraps a table counts as a table unit too (unit pairing).
  const table =
    el.tagName === 'TABLE'
      ? (el as HTMLTableElement)
      : el.querySelector<HTMLTableElement>(':scope > table')
  if (table) {
    // A table row needs no Lute: the delimiter line has no row and shows the header.
    const k = line - entry.startLine
    const row = table.rows[k <= 1 ? 0 : k - 1]
    if (!row) return null
    const { text, segments } = visibleText([row])
    const start = pointAt(segments, 0, 'start')
    const end = pointAt(segments, text.length, 'end')
    if (!start) return null
    return {
      unit: { element: el, members: [el] },
      start,
      end: end ?? start,
      lineElement: row,
    }
  }
  const live = feed.liveUnitOf(el)
  const members = live?.members ?? [el]
  const md = unitMarkdown(vditor, members, el, live?.kind === 'list-item')
  if (md === undefined) return null
  return placeInUnit(
    { element: el, members },
    readableSourceLines(md),
    0,
    line - entry.startLine,
  )
}

// The confirmed line ranges, publishing pending typing once when they are not confirmed yet. R-1:
// the lines are read after the publish and the feed root is checked again.
function confirmedLinesOf(
  feed: UnitFeed,
  editor: HTMLElement,
): readonly UnitLines[] | undefined {
  let lines = feed.confirmedLines()
  if (!lines) {
    if (!feed.confirmNow() || feed.root !== editor) return undefined
    lines = feed.confirmedLines()
  }
  return lines && lines.length > 0 ? lines : undefined
}

// `undefined` sends the caller to the existing path.
function revealFromUnits(
  vditor: any,
  editor: HTMLElement,
  line: number,
  endLine: number | undefined,
): boolean | undefined {
  if (innerVditor()?.currentMode !== 'ir') return undefined
  const feed = unitFeedOf(window)
  if (!feed || feed.root !== editor || !feed.isLive()) return undefined
  try {
    const lines = confirmedLinesOf(feed, editor)
    if (!lines) return undefined
    if (!Number.isInteger(line) || line < 0) return false
    // A line past the confirmed text means the host is ahead of the model: let the rendered-text
    // path decide, which can report "not there yet" so the router retries.
    if (line > lines[lines.length - 1]!.endLine) return undefined
    const place = placeFromUnit(
      vditor,
      feed,
      lines[unitIndexForLine(lines, line)]!,
      line,
    )
    if (!place) return undefined
    const endPlace =
      endLine !== undefined && endLine > line
        ? placeFromUnit(
            vditor,
            feed,
            lines[unitIndexForLine(lines, endLine)]!,
            endLine,
          )
        : null
    finishReveal(editor, place, endPlace)
    return true
  } catch {
    return undefined
  }
}

/** Reveal a 0-based Markdown source line in the live IR/WYSIWYG editor: scroll the line into view,
 * flash it and put the caret at its start. With `endLine`, the lines from `line` to the end of
 * `endLine` are selected instead (Task 730). Returns false while the editor or target is not
 * rendered yet, so message-router can retry the same way it does headings. */
export function revealSourceLine(
  vditor: Vditor,
  line: number,
  lineText?: string,
  endLine?: number,
  endLineText?: string,
): boolean {
  const mode = innerVditor()?.currentMode
  if (mode !== 'ir' && mode !== 'wysiwyg') return false
  const editor = activeModeElement(vditor)
  if (!editor) return false
  // Task 733 / 006: a host line (always sent with its text) is a model line, so a live unit feed
  // places it without serializing the document. A caller without line text stays on the rendered
  // text path.
  const viaUnits =
    lineText === undefined
      ? undefined
      : revealFromUnits(vditor, editor, line, endLine)
  if (viaUnits !== undefined) return viaUnits
  const markdown = vditor.getValue()
  const canonicalLine = sourceLineForReveal(markdown, line, lineText)
  if (canonicalLine === null) return false
  const units = revealUnits(editor, markdown)
  const readable = readableSourceLines(markdown)
  const place = placeLine(units, markdown, readable, canonicalLine)
  if (!place) return legacyRevealSourceLine(editor, markdown, canonicalLine)
  const canonicalEnd =
    endLine === undefined
      ? null
      : sourceLineForReveal(markdown, endLine, endLineText)
  const endPlace =
    canonicalEnd !== null && canonicalEnd > canonicalLine
      ? placeLine(units, markdown, readable, canonicalEnd)
      : null
  finishReveal(editor, place, endPlace)
  return true
}

// Fold and hoist the target open, scroll and flash the line, and put the caret (or the range up to
// `endPlace`) there.
function finishReveal(
  editor: HTMLElement,
  place: LinePlace,
  endPlace: LinePlace | null,
): void {
  const block = topLevelAncestor(editor, place.unit.element)
  ensureFoldTargetVisible(block)
  ensureHoistBlockVisible(block)
  place.lineElement.scrollIntoView({
    behavior: scrollBehavior(),
    block: 'start',
  })
  flashElement(place.lineElement)
  const requestCaret = (
    window as unknown as {
      __vmdeRequestCaret?: (
        intent: RevealPoint | { anchor: RevealPoint; focus: RevealPoint },
      ) => boolean
    }
  ).__vmdeRequestCaret
  requestCaret?.(
    endPlace ? { anchor: place.start, focus: endPlace.end } : place.start,
  )
}

// The pre-730 block-index path, kept for a document whose units cannot be paired at all. A block
// index past the live blocks is a miss, not a reveal of some other block.
function legacyRevealSourceLine(
  editor: HTMLElement,
  markdown: string,
  line: number,
): boolean {
  const index = blockIndexForRevealLine(markdown, line)
  if (index === null) return false
  const target = topLevelBlocks(editor)[index]
  if (!target) return false
  ensureFoldTargetVisible(target)
  ensureHoistBlockVisible(target)
  target.scrollIntoView({ behavior: scrollBehavior(), block: 'start' })
  flashElement(target)
  ;(
    window as unknown as {
      __vmdeRequestCaret?: (intent: RevealPoint) => boolean
    }
  ).__vmdeRequestCaret?.({ node: sourceRevealCaretTarget(target), offset: 0 })
  return true
}

// Task 78's `scroll-to-heading` (Nth heading in doc order, class `h1-h6`), pulled out of
// message-router.ts's `handleScrollToHeading` so task 243 can reuse the EXACT same scroll+flash
// mechanism for anchor-link clicks — same-doc `#fragment` clicks resolve to an index (see
// src/heading-slug.ts's resolveFragment) and call this directly (no host round-trip); the host
// `scroll-to-heading` message (cross-doc `file.md#frag`, and the outline-tree reveal command)
// still goes through message-router's handler, which now just forwards here. ONE mechanism,
// two callers — not two mechanisms, per task 243's "reuse, don't duplicate" instruction.
export function scrollToHeadingIndex(
  vditor: Vditor,
  index: number,
  // Task 468 — message-router.ts's `scrollToHeadingWithRetry` polls this every 50ms while a
  // freshly-opened panel is still rendering its headings into the DOM. Without a way to skip the
  // trace line below, a worst-case give-up would emit ~40 near-identical Output-channel lines for
  // what's meant to be a rare edge case — `quiet` lets the retry loop log its own concise
  // summary (first attempt / success-after-N-ms / gave-up) instead. The single-call callers
  // (outline-tree click, same-doc `#fragment`) never pass this, so their logging is unchanged.
  quiet = false,
): boolean {
  // A heading outside the current hoist has no layout box. Clear the view scope before resolving
  // and scrolling so outline keyboard, host reveal and same-document anchors share one path.
  ensureHoistTargetVisible(index)
  // Task 458 — while the full Preview overlay is showing, Vditor's own `Outline.render()`
  // (vendored) generates the outline's ids from `preview.previewElement`'s headings, not the
  // (hidden) IR/WYSIWYG element `activeModeElement` returns — the vendor's own outline click
  // handler branches the same way (`vditor.preview.element.contains(contentElement)`). Without
  // this branch, activating an outline item by KEYBOARD while Preview is open would scroll+flash a
  // heading in the hidden edit pane instead of the visible preview — invisible to the user, and a
  // silent mismatch from what a mouse click on the same item does. Mirrors the vendor's condition
  // exactly, so it stays correct if that condition ever changes.
  //
  // Measured (task 458, real VS Code, `anchor-links.spec.ts` run both WITH and WITHOUT this
  // branch): entering `sv` split-view mode ALSO flips `preview.element.style.display` to `'block'`
  // (`setPreviewMode.ts`) — split-view's right pane literally IS `preview.previewElement`. That
  // looked like a risk of hijacking this branch for the pre-existing message-router/anchor-link
  // callers in the common sv case, not just the Preview-overlay edge case. It is NOT: `EditMode.ts`
  // (`setEditMode`) unconditionally resets `preview.element.style.display` to `'none'` on every
  // entry into `ir`/`wysiwyg` (the only modes anchor-links.spec.ts and message-router's callers
  // exercise) — so this branch is a no-op for both there. Confirmed in real VS Code:
  // `anchor-links.spec.ts` (untracked, owned by task 243) passes both with and without this branch
  // — team-lead ran it on today's tree, `--repeat-each=2 --retries=0`, 2/2 green both ways.
  const previewShown =
    innerVditor()?.preview?.element?.style.display === 'block'
  const el = previewShown
    ? innerVditor()?.preview?.previewElement
    : activeModeElement(vditor)
  const headings = el?.querySelectorAll('h1, h2, h3, h4, h5, h6')
  const target = headings?.[index] as HTMLElement | undefined
  // Task 243 — a window-array diagnostic (real VS Code, since removed) proved a cross-doc
  // `scroll-to-heading` reaches here correctly: DOM already built, right index, right heading
  // matched by text, every time. Kept this one trace line (Output channel "VMDE", trace
  // level — house style, not console.log) as ongoing shipped diagnostics for the next time
  // something upstream of this function needs debugging. Skipped when `quiet` (see the param's
  // own comment) — the retry loop's own summary line covers that case instead.
  if (!quiet) {
    logToHost(
      `[scroll-to-heading] index=${index} activeModeElement=${!!el} headingCount=${
        headings ? headings.length : 'n/a'
      }`,
    )
  }
  if (!el || !target) return false
  ensureFoldTargetVisible(target)
  target.scrollIntoView({ behavior: scrollBehavior(), block: 'start' })
  flashElement(target)
  return true
}
