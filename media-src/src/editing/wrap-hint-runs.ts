/**
 * Task 640 S2c — the DOM side of the wrap-hint engine that needs no layout: which text may carry
 * hints, how a stretch of text and its hint spans is read as one "run", and how a run's hints are
 * rewritten. Tested in jsdom; `wrap-hint-engine.ts` adds the measuring, scheduling and observers.
 *
 * A run is a maximal stretch of consecutive Text nodes and hint spans that share a parent: text
 * on both sides of an element (`ab <strong>c</strong> de`) are two runs, so a word is planned per
 * text part, never across an element boundary (accepted in the Part 1 record).
 */
import {
  expectOwnTexts,
  insertWrapHint,
  insertWrapHintBefore,
  removeWrapHints,
  WRAP_HINT_CLASS,
} from '../util/wrap-hint-mark'

/** The nearest block whose content box is the line box of the text. */
export const LINE_CONTAINER =
  'p, li, h1, h2, h3, h4, h5, h6, blockquote, summary, dd, dt'

/**
 * Never hinted, in any mode: fenced code and other `pre` (the editing surface itself is a
 * `pre.vditor-reset`), tables (S2d), hidden Markdown syntax (IR markers, which include link URLs and
 * the heading `#`), images and their IR source, inline HTML and entities, math, footnote references,
 * front matter, HTML and math blocks, the TOC, code-reference chips and the hidden callout marker.
 */
const NEVER =
  'pre:not(.vditor-reset), table, .vditor-ir__marker, [data-type="img"], [data-type="html-inline"], [data-type="html-entity"], [data-type="math-inline"], [data-type="footnotes-ref"], [data-type="yaml-front-matter"], [data-type="html-block"], [data-type="math-block"], [data-type="toc-block"], .vmde-code-ref-chip, .vmde-callout__marker, img, svg, math, script, style, textarea, button, input, select'
/** Raw HTML inline elements of Preview (and inline code, which is planned first and on its own). */
const NOT_PROSE =
  'code, kbd, sub, sup, u, ins, abbr, samp, var, small, font, mark'
/**
 * Rendered previews and widgets (`data-render`, the IR/WYSIWYG preview halves) and anything not
 * editable text (`contenteditable="false"`), except the callout preview and title, which are
 * plain text the callouts module rebuilds and which have to be hinted again after each rebuild.
 */
const SOFT =
  '[data-render], [contenteditable="false"], .vditor-ir__preview, .vditor-wysiwyg__preview'
const SOFT_ALLOWED = '.vmde-callout__preview, .vmde-callout__title'

function excluded(element: Element, extra?: string): boolean {
  if (element.closest(NEVER)) return true
  if (extra && element.closest(extra)) return true
  const soft = element.closest(SOFT)
  return soft !== null && !soft.matches(SOFT_ALLOWED)
}

/** Inline `<code>` elements of a block that the engine may hint, in document order. */
export function inlineCodesWithin(block: Element): HTMLElement[] {
  return Array.from(block.querySelectorAll<HTMLElement>('code')).filter(
    (code) => !excluded(code),
  )
}

/** Text nodes shorter than this cannot be a word worth the style reads, unless a hint is beside them. */
const MIN_PROSE_NODE = 8
const isHintNode = (node: Node | null): boolean =>
  node !== null &&
  node.nodeType === Node.ELEMENT_NODE &&
  (node as Element).classList.contains(WRAP_HINT_CLASS)

/**
 * The elements of a block that hold hintable text outside inline code: paragraphs, list items,
 * headings, quotes, emphasis, link text and the callout preview. A parent counts when one of its
 * Text children is long enough to hold a long word (or is already split by a hint).
 */
export function proseParentsWithin(block: Element): Element[] {
  const parents = new Set<Element>()
  const walker = block.ownerDocument.createTreeWalker(
    block,
    NodeFilter.SHOW_TEXT,
  )
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement
    if (!parent || parents.has(parent)) continue
    const long =
      (node as Text).length >= MIN_PROSE_NODE ||
      isHintNode(node.previousSibling) ||
      isHintNode(node.nextSibling)
    if (long && parent.closest(LINE_CONTAINER) && !excluded(parent, NOT_PROSE))
      parents.add(parent)
  }
  return [...parents]
}

export interface TextRun {
  parent: Element
  nodes: Text[]
  /** Start offset of each node in `text`. */
  starts: number[]
  /** The run's text without its hints. */
  text: string
  spans: Element[]
  /** Offsets in `text` where a hint span sits, ascending. */
  hints: number[]
}

/** The runs of `parent`'s direct children. */
export function runsOf(parent: Element): TextRun[] {
  const runs: TextRun[] = []
  let run: TextRun | null = null
  for (const child of Array.from(parent.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      run ??= { parent, nodes: [], starts: [], text: '', spans: [], hints: [] }
      run.nodes.push(child as Text)
      run.starts.push(run.text.length)
      run.text += (child as Text).data
    } else if (isHintNode(child) && run) {
      run.spans.push(child as Element)
      run.hints.push(run.text.length)
    } else if (run) {
      runs.push(run)
      run = null
    }
  }
  if (run) runs.push(run)
  return runs
}

const sameOffsets = (a: readonly number[], b: readonly number[]): boolean =>
  a.length === b.length && a.every((value, index) => value === b[index])

export { sameOffsets }

/**
 * One hint at `offset` of the run's text: inside a Text node it splits the node; on the boundary
 * of two adjacent Text nodes (Vditor's caret marker leaves such a split behind) it goes between
 * them. Nothing happens for an offset the text does not have.
 */
function insertHintAt(run: TextRun, offset: number): void {
  const inside = run.starts.findIndex(
    (start, i) => start < offset && offset < start + run.nodes[i].length,
  )
  if (inside !== -1) {
    insertWrapHint(run.nodes[inside], offset - run.starts[inside])
    return
  }
  const boundary = run.starts.findIndex((start, i) => i > 0 && start === offset)
  if (boundary !== -1) insertWrapHintBefore(run.nodes[boundary])
}

/**
 * Make the hints of `run` exactly `offsets` (offsets in its text). Writes nothing and returns
 * false when it already does. Otherwise the run's old hints go (`Node.normalize` merges the text
 * again and keeps a live Selection on its characters) and the new ones are inserted from the
 * end, so every earlier offset stays valid. Other runs of the same parent are not touched.
 */
export function rewriteRun(run: TextRun, offsets: readonly number[]): boolean {
  const wanted = [...new Set(offsets)]
    .filter((offset) => offset > 0 && offset < run.text.length)
    .sort((a, b) => a - b)
  if (sameOffsets(run.hints, wanted)) return false
  const first = run.nodes[0]
  removeWrapHints(run.parent, run.spans)
  for (let index = wanted.length - 1; index >= 0; index -= 1) {
    const fresh = runsOf(run.parent).find(
      (candidate) => candidate.nodes[0] === first,
    )
    if (!fresh) return true
    insertHintAt(fresh, wanted[index])
  }
  expectOwnTexts(run.parent)
  return true
}

/** The only run of `element`, or null when it has none or several (it holds another element). */
function onlyRun(element: Element): TextRun | null {
  const runs = runsOf(element)
  return runs.length === 1 ? runs[0] : null
}

/** Offsets in the text of `element` (a code with only text and hints) where a hint span sits. */
export function readHintOffsets(element: Element): number[] {
  return onlyRun(element)?.hints ?? []
}

/** `rewriteRun` for an element made of one run (inline code). False for any other element. */
export function rewriteHints(
  element: Element,
  offsets: readonly number[],
): boolean {
  const run = onlyRun(element)
  return run ? rewriteRun(run, offsets) : false
}
