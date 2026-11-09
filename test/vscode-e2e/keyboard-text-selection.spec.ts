/**
 * Task 714 — keyboard text selection inside every Markdown construct, in IR, WYSIWYG and SV, with
 * OS-level XTEST keys in the real VS Code webview.
 *
 * One test per edit mode opens `fixtures/keyboard-text-selection.md`, places a collapsed caret in
 * the middle of each construct's token through VMDE's caret authority, presses each selection key
 * once and compares the selection with what a native selection gives in a plain paragraph with the
 * same text. The expectation is computed from the DOM text and its line boxes before the key press,
 * never from the code under test:
 *
 * - Shift+ArrowLeft / Shift+ArrowRight: the one character before / after the caret.
 * - Shift+Home / Shift+End: the visible characters of the caret's visual line, inside its nearest
 *   block-level box, before / after the caret. Inside an inline-block box (IR `kbd`, WYSIWYG
 *   inline-math source) only that box's line counts: Chromium's native line edge (decision D6).
 * - Ctrl+Shift+ArrowLeft / Ctrl+Shift+ArrowRight (Linux word keys): the token part before / after
 *   the caret (each token is one word).
 * - Shift+ArrowUp / Shift+ArrowDown: the selection extends to another line, so its visible text
 *   ends with the line part before the caret (Up) or starts with the line part after it (Down).
 *   On the document's first or last line native selection stops at the line edge, so the predicate
 *   also accepts exactly that line part.
 *
 * Tables follow the provisional decision D1 (option A): plain Shift+Arrow is text selection while
 * the caret can still move inside the cell in that direction; the cell rectangle starts only when
 * the caret is already at the cell edge in that direction (Left/Right: no visible text before /
 * after the caret in the cell; Up/Down: the caret is on the cell's first / last line) and a
 * neighbouring cell exists, or when a rectangle is already active. SV has no rectangle (source text).
 *
 * Visible text: hidden markers (`display: none`, zero-size boxes) and whitespace are left out of both
 * the expectation and the measured selection, so IR's collapsed markers do not count as selected text.
 * The measured selection judges each text node by its visibility before the key press, so markers
 * that IR reveals or hides because the selection moved do not change the count. IR marker text
 * outside the caret's own inline node is syntax and never counts, in the expectation or the outcome.
 * At a text node edge, Shift+ArrowLeft / Shift+ArrowRight expect the nearest visible character in
 * the neighbouring text node.
 *
 * A body block inside a collapsed `<details>` is reached by clicking the details toggle. A caret in
 * an IR inline node's marker text (footnote label, emoji shortcode) is placed with a real click, the
 * way a user places it: IR moves a programmatic caret there to the node edge.
 *
 * Constructs whose source is hidden until entered (IR and WYSIWYG code, diagram, math, HTML and
 * front-matter blocks, WYSIWYG inline math and inline HTML) are entered with a real click on their
 * rendered preview, which is the editable surface those modes offer; the caret is then placed in the
 * revealed source. A construct whose token is still not placeable records a mismatch.
 *
 * Every mismatch is collected as `"<mode> <construct> <key>: expected <x> got <y>"` and asserted
 * empty at the end, so one run reports the whole matrix. Every press is also logged under
 * `[task-714 ...]` with the selection head and the rectangle cell count.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import {
  closeAll,
  type Ctx,
  difference,
  disposeObservers,
  evalFrame,
  hostText,
  makeKit,
  type Mode,
  openDocument,
  restoreKitSettings,
  selectInPage,
} from './helpers/shortcut-xtest-kit'

const TAG = 'task-714'
const FIXTURE_TEXT = readFileSync(
  path.join(__dirname, 'fixtures', 'keyboard-text-selection.md'),
  'utf8',
)

type KeyName =
  | 'Shift+ArrowLeft'
  | 'Shift+ArrowRight'
  | 'Shift+Home'
  | 'Shift+End'
  | 'Ctrl+Shift+ArrowLeft'
  | 'Ctrl+Shift+ArrowRight'
  | 'Shift+ArrowUp'
  | 'Shift+ArrowDown'

// XTEST keysyms. Up and Down run last for each construct: they may leave the construct, which
// collapses an entered IR/WYSIWYG block and re-renders its preview.
const KEYS: [KeyName, string][] = [
  ['Shift+ArrowLeft', 'shift+Left'],
  ['Shift+ArrowRight', 'shift+Right'],
  ['Shift+Home', 'shift+Home'],
  ['Shift+End', 'shift+End'],
  ['Ctrl+Shift+ArrowLeft', 'ctrl+shift+Left'],
  ['Ctrl+Shift+ArrowRight', 'ctrl+shift+Right'],
  ['Shift+ArrowUp', 'shift+Up'],
  ['Shift+ArrowDown', 'shift+Down'],
]

interface Construct {
  name: string
  token: string
  /** Caret offset inside the token; the middle of the word by default. */
  offset?: number
  /** Modes where the construct has no editable text; the reason is in the comment at its entry. */
  skip?: Mode[]
}

// Every construct of the Task 714 scope list, in fixture order. Horizontal rules hold no text: the
// `cross:rule` case below steps over one.
const CONSTRUCTS: Construct[] = [
  { name: 'front-matter', token: 'frontmattok' },
  { name: 'paragraph', token: 'paratoken' },
  { name: 'heading', token: 'headtoken' },
  { name: 'blockquote', token: 'quotetoken' },
  { name: 'bold', token: 'boldtoken' },
  { name: 'italic', token: 'italictok' },
  { name: 'strike', token: 'striketok' },
  { name: 'inline-code', token: 'inlinecodetok' },
  { name: 'link', token: 'linktexttok' },
  { name: 'wiki-link', token: 'Wikipagetok' },
  // WYSIWYG renders a footnote reference as its number and an emoji as its glyph: the label and the
  // shortcode are not text in that mode, so only the neighbouring text is editable there.
  { name: 'footnote-ref', token: 'fnlabeltok', skip: ['wysiwyg'] },
  { name: 'emoji', token: 'heart', offset: 2, skip: ['wysiwyg'] },
  { name: 'emoji-adjacent-text', token: 'emojitailtok' },
  { name: 'inline-math', token: 'mathinlinetok' },
  { name: 'inline-html', token: 'kbdtoken' },
  { name: 'list-unordered', token: 'ultoken' },
  { name: 'list-ordered', token: 'oltoken' },
  { name: 'list-task', token: 'tasktoken' },
  { name: 'list-nested', token: 'nestedtok' },
  { name: 'table-head-cell', token: 'headcelltok' },
  { name: 'table-center-cell', token: 'centercell' },
  { name: 'table-multiline-first', token: 'cellfirsttok' },
  { name: 'table-multiline-last', token: 'celllasttok' },
  { name: 'table-aligned', token: 'alignedtok' },
  { name: 'table-in-list', token: 'listcelltok' },
  { name: 'table-in-quote', token: 'quotecelltok' },
  { name: 'callout', token: 'callouttok' },
  { name: 'table-in-callout', token: 'calloutcelltok' },
  // IR and WYSIWYG project the summary as a non-editable toggle label (details.ts ensureToggle);
  // its `<summary>` source is editable only in SV here, so the summary runs in SV only. Whether the
  // projected label should accept a caret is Task 714 open question Q3.
  { name: 'details-summary', token: 'summarytok', skip: ['ir', 'wysiwyg'] },
  { name: 'details-body', token: 'detailsbodytok' },
  { name: 'table-in-details', token: 'detailcelltok' },
  { name: 'code-fenced', token: 'fencedtok' },
  { name: 'code-indented', token: 'indentok' },
  { name: 'diagram-mermaid', token: 'mermaidtok' },
  { name: 'diagram-echarts', token: 'echartstok' },
  { name: 'diagram-mindmap', token: 'mindmaptok' },
  { name: 'diagram-flowchart', token: 'flowtok' },
  { name: 'diagram-graphviz', token: 'graphviztok' },
  { name: 'diagram-plantuml', token: 'plantumltok' },
  { name: 'diagram-markmap', token: 'markmaptok' },
  { name: 'diagram-abc', token: 'abctoken' },
  { name: 'diagram-smiles', token: 'CCCCCCCCCO' },
  { name: 'diagram-math', token: 'mathblocktok' },
  { name: 'math-block', token: 'dollarmathtok' },
  { name: 'diagram-wavedrom', token: 'wavedromtok' },
  { name: 'diagram-nomnoml', token: 'nomnomltok' },
  { name: 'diagram-geojson', token: 'geojsontok' },
  { name: 'diagram-topojson', token: 'topojsontok' },
  { name: 'diagram-vega', token: 'vegatoken' },
  { name: 'diagram-vega-lite', token: 'vegalitetok' },
  { name: 'diagram-stl', token: 'stltoken' },
  { name: 'diagram-d2', token: 'd2token' },
  { name: 'html-block', token: 'htmlblocktok' },
  { name: 'footnote-definition', token: 'footdeftok' },
]

// Shift+ArrowDown from the last line of a paragraph into the next construct. `into` is a word of
// that construct; in IR and WYSIWYG the selection focus must land in the block that holds it. In SV
// the next source line is the blank separator line, so only the line predicate applies there.
const CROSSINGS: { name: string; token: string; into: string }[] = [
  { name: 'cross:paragraph-to-table', token: 'crosstable', into: 'Crosshead' },
  { name: 'cross:paragraph-to-list', token: 'crosslist', into: 'crossitem' },
  { name: 'cross:paragraph-to-code', token: 'crosscode', into: 'fencedtok' },
  { name: 'cross:paragraph-over-rule', token: 'crossrule', into: 'Afterrule' },
]

interface Expectation {
  placed: boolean
  /** Why no expectation could be computed, with the caret's element. */
  reason?: string
  /** The caret's ancestors up to its block box, with their `display`. */
  chain?: string
  left: string
  right: string
  lineBefore: string
  lineAfter: string
  /** Shift+Home / Shift+End: the line part inside the caret's inline-block box, if any (D6). */
  homeBefore: string
  homeAfter: string
  /** Per direction: the D1 rectangle starts (caret at the cell edge and a neighbour cell exists). */
  cell: { up: boolean; down: boolean; left: boolean; right: boolean } | null
}

interface Outcome {
  visible: string
  head: string
  collapsed: boolean
  rect: number
  focusInTarget: boolean | null
  /** The focus node's element path, to name where a crossing landed. */
  focusPath: string
  /** preventDefault / stopPropagation calls on the trusted keydown, with their stack heads. */
  calls: string[]
  /** Whether the keydown reached a window bubble-phase listener (false: propagation stopped). */
  bubbled: boolean
  /** Editor-root DOM mutations between the keydown and the measurement. */
  mutations: number
  /** The selection at each `selectionchange` after the keydown: focus element, offset, collapsed. */
  trace: string[]
}

// ---------------------------------------------------------------------------------------------
// Webview-side probes (run inside the VMDE frame; self-contained).

// Marks the block that holds `token` in hidden source text so the spec can click its preview.
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one self-contained page probe picks the click target for a details body, a callout or a hidden block source
function markHiddenBlockInPage(_body: Element, token: string): boolean {
  const inner = (window as any).vditor.vditor
  const root = inner[inner.currentMode].element as HTMLElement
  for (const old of document.querySelectorAll('[data-k714-enter]'))
    old.removeAttribute('data-k714-enter')
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!(node.nodeValue ?? '').includes(token)) continue
    // A collapsed `<details>` hides its body blocks: open it with its toggle, the way a user does.
    const hidden = node.parentElement?.closest('[data-vmde-details-hidden]')
    if (hidden) {
      let start = hidden.previousElementSibling
      while (start && !start.hasAttribute('data-vmde-details-start'))
        start = start.previousElementSibling
      const toggle = start?.querySelector(':scope > .vmde-details__toggle')
      if (!toggle) continue
      toggle.setAttribute('data-k714-enter', '1')
      toggle.scrollIntoView({ block: 'center' })
      return true
    }
    // IR callouts keep their source in a hidden paragraph inside the blockquote; the clickable
    // surface is the blockquote's callout preview, so fall back to the top-level block.
    let top: Element | null = node.parentElement
    while (top && top.parentElement !== root) top = top.parentElement
    const block =
      node.parentElement?.closest('.vditor-ir__node, .vditor-wysiwyg__block') ??
      top
    if (!block) continue
    block.setAttribute('data-k714-enter', '1')
    block.scrollIntoView({ block: 'center' })
    return true
  }
  return false
}

// Where `token` sits, for a placement failure: its parent element's markup and display.
function tokenContextInPage(_body: Element, token: string): string {
  const inner = (window as any).vditor.vditor
  const root = inner[inner.currentMode].element as HTMLElement
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!(node.nodeValue ?? '').includes(token)) continue
    const parent = node.parentElement!
    const block = parent.closest('[data-block="0"]') ?? parent
    return `display=${getComputedStyle(parent).display} rects=${parent.getClientRects().length} in ${block.outerHTML.slice(0, 300)}`
  }
  return 'token not in the surface text'
}

// Marks the top-level block that holds `word` as the crossing target.
function markTargetInPage(_body: Element, word: string): boolean {
  const inner = (window as any).vditor.vditor
  const root = inner[inner.currentMode].element as HTMLElement
  for (const old of document.querySelectorAll('[data-k714-target]'))
    old.removeAttribute('data-k714-target')
  const block = Array.from(root.children).find((child) =>
    (child.textContent ?? '').includes(word),
  )
  block?.setAttribute('data-k714-target', '1')
  return Boolean(block)
}

// The expectation for every key from the collapsed caret, read from the DOM text and line boxes.
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one self-contained page probe walks the caret's block, its line boxes and its table cell
function expectationInPage(_body: Element, mode: string): Expectation {
  const none: Expectation = {
    placed: false,
    left: '',
    right: '',
    lineBefore: '',
    lineAfter: '',
    homeBefore: '',
    homeAfter: '',
    cell: null,
  }
  const inner = (window as any).vditor.vditor
  const root = inner[inner.currentMode].element as HTMLElement
  const selection = getSelection()
  const node = selection?.focusNode
  if (!node || node.nodeType !== Node.TEXT_NODE || !root.contains(node))
    return {
      ...none,
      reason: `focus ${node?.nodeName ?? 'none'} in ${(node instanceof Element ? node : node?.parentElement)?.outerHTML.slice(0, 200) ?? 'none'}`,
    }
  const text = node as Text
  const offset = selection!.focusOffset
  const strip = (value: string) =>
    value.replace(/[\s\u200b\u2060\ufeff]+/gu, '')
  const charRect = (target: Text, index: number) => {
    if (index < 0 || index >= target.data.length) return null
    const range = document.createRange()
    range.setStart(target, index)
    range.setEnd(target, index + 1)
    for (const rect of Array.from(range.getClientRects()))
      if (rect.width > 0 && rect.height > 0) return rect
    return null
  }
  const isBlock = (element: Element) => {
    const display = getComputedStyle(element).display
    return !display.startsWith('inline') && display !== 'contents'
  }
  let block: Element = text.parentElement!
  const chain: string[] = []
  // D6 (Task 714): inside an inline-block box (IR `kbd`, WYSIWYG inline-math source) Shift+Home /
  // Shift+End keep Chromium's native line edge of that box, not of the paragraph line.
  let inlineBox: Element | null = null
  while (block !== root && !isBlock(block)) {
    if (!inlineBox && getComputedStyle(block).display === 'inline-block')
      inlineBox = block
    chain.push(
      `${block.tagName.toLowerCase()}.${block.className}:${getComputedStyle(block).display}`,
    )
    block = block.parentElement!
  }
  chain.push(
    `${block.tagName.toLowerCase()}:${getComputedStyle(block).display}`,
  )
  const caret = charRect(text, offset) ?? charRect(text, offset - 1)
  if (!caret)
    return {
      ...none,
      reason: `no box at the caret in ${text.parentElement?.outerHTML.slice(0, 200)}`,
    }
  const middle = (caret.top + caret.bottom) / 2
  let lineBefore = ''
  let lineAfter = ''
  let homeBefore = ''
  let homeAfter = ''
  let allBefore = ''
  let allAfter = ''
  let firstTop: number | null = null
  let lastBottom: number | null = null
  // The nearest visible characters before / after the caret in its block, for a caret at a text
  // node edge (measured, WYSIWYG callout: a re-render left the caret at the end of one text node
  // with the token's next character in the next one; native Shift+ArrowRight selects that one).
  let previousChar = ''
  let nextChar: string | null = null
  // IR marker text counts only inside the caret's own inline node (the same rule as outcomeInPage).
  const ownNode = text.parentElement?.closest('.vditor-ir__node')
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT)
  for (let current = walker.nextNode(); current; current = walker.nextNode()) {
    const item = current as Text
    if (
      item.parentElement?.closest(
        '.vditor-ir__preview, .vditor-wysiwyg__preview',
      )
    )
      continue
    if (
      item.parentElement?.closest('.vditor-ir__marker') &&
      !ownNode?.contains(item)
    )
      continue
    const relation = item === text ? 0 : text.compareDocumentPosition(item)
    for (let index = 0; index < item.data.length; index++) {
      const rect = charRect(item, index)
      if (!rect) continue
      if (strip(item.data[index]) !== '') {
        firstTop ??= rect.top
        lastBottom = rect.bottom
      }
      const before =
        item === text
          ? index < offset
          : (relation & Node.DOCUMENT_POSITION_PRECEDING) !== 0
      if (before) allBefore += item.data[index]
      else allAfter += item.data[index]
      if (before) previousChar = item.data[index]
      else nextChar ??= item.data[index]
      if (rect.top > middle || rect.bottom < middle) continue
      if (before) lineBefore += item.data[index]
      else lineAfter += item.data[index]
      if (inlineBox && !inlineBox.contains(item)) continue
      if (before) homeBefore += item.data[index]
      else homeAfter += item.data[index]
    }
  }
  let cell: Expectation['cell'] = null
  const cellElement =
    mode === 'sv' ? null : text.parentElement?.closest('td, th')
  if (cellElement instanceof HTMLTableCellElement && cellElement === block) {
    const table = cellElement.closest('table')!
    const rows = Array.from(table.rows)
    const row = cellElement.parentElement as HTMLTableRowElement
    const rowIndex = rows.indexOf(row)
    const column = Array.from(row.cells).indexOf(cellElement)
    const half = caret.height / 2
    cell = {
      up: firstTop !== null && caret.top - firstTop < half && rowIndex > 0,
      down:
        lastBottom !== null &&
        lastBottom - caret.bottom < half &&
        rowIndex < rows.length - 1,
      left: strip(allBefore) === '' && column > 0,
      right: strip(allAfter) === '' && column < row.cells.length - 1,
    }
  }
  return {
    placed: true,
    left: text.data[offset - 1] ?? previousChar,
    right: text.data[offset] ?? nextChar ?? '',
    lineBefore: strip(lineBefore),
    lineAfter: strip(lineAfter),
    homeBefore: strip(homeBefore),
    homeAfter: strip(homeAfter),
    cell,
    chain: chain.join(' < '),
  }
}

// Records which text nodes are visible right before a key press (see outcomeInPage).
function snapshotVisibilityInPage(_body: Element, _arg: number): boolean {
  // IR and WYSIWYG hide an inline node's markers and source once the selection leaves it, and reveal
  // the markers of nodes the selection covers. A plain paragraph shows the same text throughout, so
  // the outcome judges each text node by whether it was visible before the key (see outcomeInPage).
  const inner = (window as any).vditor.vditor
  const root = inner[inner.currentMode].element as HTMLElement
  // The caret's own inline node reveals its source and markers a frame after a programmatic caret
  // lands, so that source counts as visible; its rendered parts keep their measured visibility.
  const focus = getSelection()?.focusNode
  const own = (
    focus instanceof Element ? focus : focus?.parentElement
  )?.closest('.vditor-ir__node, .vditor-wysiwyg__block')
  const shown = new WeakMap<Text, boolean>()
  const all = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let item = all.nextNode(); item; item = all.nextNode()) {
    const parent = item.parentElement
    if (
      own?.contains(item) &&
      !parent?.closest(
        '[data-render], .vditor-ir__preview, .vditor-wysiwyg__preview',
      )
    ) {
      shown.set(item as Text, true)
      continue
    }
    const range = document.createRange()
    range.selectNodeContents(item)
    shown.set(
      item as Text,
      Array.from(range.getClientRects()).some(
        (rect) => rect.width > 0 && rect.height > 0,
      ),
    )
  }
  ;(window as any).__k714Shown = shown
  return true
}

// The selection after a key press: its visible text, rectangle cell count and crossing target.
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one self-contained page probe walks the selected text nodes and their boxes
async function outcomeInPage(_body: Element, _arg: number): Promise<Outcome> {
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  )
  const inner = (window as any).vditor.vditor
  const root = inner[inner.currentMode].element as HTMLElement
  const selection = getSelection()
  const range = selection?.rangeCount ? selection.getRangeAt(0) : null
  let visible = ''
  const anchorNode = selection?.anchorNode
  const anchorOwner = (
    anchorNode instanceof Element ? anchorNode : anchorNode?.parentElement
  )?.closest('.vditor-ir__node, .vditor-wysiwyg__block')
  if (range) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!range.intersectsNode(node)) continue
      const parent = node.parentElement
      if (parent?.closest('.vditor-ir__preview, .vditor-wysiwyg__preview'))
        continue
      // Visible before the key: counted even if now hidden; hidden before: never counted. A node
      // created by the key counts where it is visible now.
      const before = (window as any).__k714Shown?.get(node) as
        | boolean
        | undefined
      if (before === false) continue
      // IR marker text outside the inline node that holds the anchor is syntax, not text of a plain
      // paragraph: skip it whether or not it had a box before the key (the anchor's own node keeps
      // its source). Measured: IR revealed the `:heart:`, `[^fnlabeltok]`, `$`, `<kbd>` and `</kbd>`
      // markers of neighbouring nodes before the press (boxes at the snapshot) after earlier presses
      // in the same paragraph, while the construct's expectation had left them out.
      if (parent?.closest('.vditor-ir__marker') && !anchorOwner?.contains(node))
        continue
      const text = node as Text
      const start = node === range.startContainer ? range.startOffset : 0
      const end = node === range.endContainer ? range.endOffset : text.length
      for (let index = start; index < end; index++) {
        const part = document.createRange()
        part.setStart(text, index)
        part.setEnd(text, index + 1)
        if (
          before === true ||
          Array.from(part.getClientRects()).some(
            (rect) => rect.width > 0 && rect.height > 0,
          )
        )
          visible += text.data[index]
      }
    }
  }
  const target = document.querySelector('[data-k714-target]')
  const path: string[] = []
  for (
    let element =
      selection?.focusNode instanceof Element
        ? selection.focusNode
        : (selection?.focusNode?.parentElement ?? null);
    element && element !== root && path.length < 4;
    element = element.parentElement
  )
    path.push(
      `${element.tagName.toLowerCase()}${element.getAttribute('data-type') ? `[${element.getAttribute('data-type')}]` : ''}`,
    )
  const fresh = {
    calls: [],
    bubbled: false,
    mutations: 0,
    trace: [],
    armed: false,
  }
  const log = (window as any).__k714KeyLog ?? fresh
  ;(window as any).__k714KeyLog = fresh
  return {
    visible: visible.replace(/[\s\u200b\u2060\ufeff]+/gu, ''),
    head: (range?.toString() ?? '').slice(0, 60),
    collapsed: selection?.isCollapsed ?? true,
    rect: root.querySelectorAll('.vmde-cell-selected').length,
    focusInTarget: target
      ? target.contains(selection?.focusNode ?? null)
      : null,
    focusPath: path.join('<'),
    calls: log.calls,
    bubbled: log.bubbled,
    mutations: log.mutations,
    trace: log.trace,
  }
}

// Records who cancels or stops a trusted selection keydown: each preventDefault /
// stopPropagation / stopImmediatePropagation call with the head of its stack (bundle positions,
// resolved through media/dist/main.js.map for the report), and whether the event still reached a
// window bubble-phase listener. Diagnostics only: the patched methods still run.
function installKeyLogInPage(_body: Element, _arg: number): boolean {
  const win = window as any
  win.__k714KeyLog = {
    calls: [],
    bubbled: false,
    mutations: 0,
    trace: [],
    armed: false,
  }
  if (win.__k714KeyLogInstalled) return true
  win.__k714KeyLogInstalled = true
  const watched = (event: Event) =>
    event instanceof KeyboardEvent &&
    event.isTrusted &&
    event.type === 'keydown' &&
    /^(?:Arrow|Home|End)/u.test(event.key)
  for (const name of [
    'preventDefault',
    'stopPropagation',
    'stopImmediatePropagation',
  ] as const) {
    const original = Event.prototype[name]
    Event.prototype[name] = function (this: Event) {
      if (watched(this)) {
        const stack = (new Error().stack ?? '')
          .split('\n')
          .slice(2, 4)
          .map((line) =>
            line
              .trim()
              .replace(/^at /u, '')
              .replace(/\(?.*\//u, ''),
          )
        win.__k714KeyLog.calls.push(`${name}@${stack.join(' < ')}`)
      }
      return original.call(this)
    }
  }
  window.addEventListener('keydown', (event) => {
    if (watched(event)) win.__k714KeyLog.bubbled = true
  })
  window.addEventListener(
    'keydown',
    (event) => {
      if (watched(event)) win.__k714KeyLog.armed = true
    },
    true,
  )
  document.addEventListener('selectionchange', () => {
    const log = win.__k714KeyLog
    if (!log.armed || log.trace.length >= 6) return
    const selection = getSelection()
    const node = selection?.focusNode
    const element = node instanceof Element ? node : node?.parentElement
    log.trace.push(
      `${element?.tagName.toLowerCase() ?? 'none'}${element?.className ? `.${String(element.className).split(' ')[0]}` : ''}@${selection?.focusOffset}${selection?.isCollapsed ? ':collapsed' : ''}`,
    )
  })
  new MutationObserver((records) => {
    if (win.__k714KeyLog.armed) win.__k714KeyLog.mutations += records.length
  }).observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
  })
  return true
}

// ---------------------------------------------------------------------------------------------

const quote = (value: string) => JSON.stringify(value.slice(0, 60))
const describe = (outcome: Outcome) =>
  `${quote(outcome.visible)} [rect ${outcome.rect}${outcome.collapsed ? ', collapsed' : ''}${outcome.bubbled ? '' : ', propagation stopped'}${outcome.calls.length ? `, ${outcome.calls.join('; ')}` : ''}${outcome.mutations ? `, ${outcome.mutations} mutations` : ''}]`

// Whether the selection focus is in a text node that holds `token`.
function caretInTokenInPage(_body: Element, token: string): boolean {
  const node = getSelection()?.focusNode
  return Boolean(
    node &&
      node.nodeType === Node.TEXT_NODE &&
      (node.nodeValue ?? '').includes(token),
  )
}

// Marks the element to click so that a real click puts the caret before `token[offset]`, and
// returns that point relative to the element. When the token's text is hidden (a collapsed IR
// inline node), marks the node instead (a click reveals its markers) and returns null as the point.
function markClickPointInPage(
  _body: Element,
  args: { token: string; offset: number },
): { point: { x: number; y: number } | null } | null {
  const inner = (window as any).vditor.vditor
  const root = inner[inner.currentMode].element as HTMLElement
  for (const old of document.querySelectorAll('[data-k714-click]'))
    old.removeAttribute('data-k714-click')
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const index = (node.nodeValue ?? '').indexOf(args.token)
    const parent = node.parentElement
    if (
      index < 0 ||
      !parent ||
      parent.closest('.vditor-ir__preview, .vditor-wysiwyg__preview')
    )
      continue
    const range = document.createRange()
    range.setStart(node, index + args.offset)
    range.setEnd(node, index + args.offset + 1)
    const rect = Array.from(range.getClientRects()).find(
      (r) => r.width > 0 && r.height > 0,
    )
    if (!rect) {
      const owner = parent.closest('.vditor-ir__node')
      if (!owner) continue
      owner.setAttribute('data-k714-click', '1')
      return { point: null }
    }
    parent.setAttribute('data-k714-click', '1')
    const box = parent.getBoundingClientRect()
    return {
      point: {
        x: rect.left - box.left + 1,
        y: rect.top - box.top + rect.height / 2,
      },
    }
  }
  return null
}

// Places the caret with a real click on the token's character, the way a user does.
async function clickCaret(ctx: Ctx, token: string, offset: number) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const target = await evalFrame(ctx.kit, markClickPointInPage, {
      token,
      offset,
    })
    if (!target) return false
    const element = ctx.kit.frame().locator('[data-k714-click]').first()
    await element
      .click({
        timeout: 10_000,
        ...(target.point ? { position: target.point } : {}),
      })
      .catch(() => undefined)
    await ctx.kit.workbox.waitForTimeout(150)
    if (target.point && (await evalFrame(ctx.kit, caretInTokenInPage, token)))
      return true
  }
  return false
}

async function placeCaret(ctx: Ctx, token: string, offset: number) {
  const place = () =>
    evalFrame(ctx.kit, selectInPage, { token, collapsed: true, offset })
  if (await place()) {
    // IR moves a programmatic caret out of an inline node's marker text to the node edge
    // (editor-caret.ts normalizeMarkerNavigationCaret); a click keeps it there.
    if (!(await evalFrame(ctx.kit, caretInTokenInPage, token)))
      await clickCaret(ctx, token, offset)
    return true
  }
  // The source is hidden until the block is entered: click its rendered preview. Measured (WYSIWYG
  // diagram-stl after Shift+ArrowUp): the previous press left a selection from the block's source
  // into a preview above it and hid the block's source again; a preview click with that selection
  // still in place did not always re-enter the source (diagram-stl, diagram-mindmap in full runs;
  // both pass alone). Drop the selection first, give the re-rendered preview longer to settle on
  // each retry, and retry twice.
  for (let attempt = 0; attempt < 3; attempt++) {
    await evalFrame(ctx.kit, dropSelectionInPage, 0)
    if (!(await evalFrame(ctx.kit, markHiddenBlockInPage, token))) return false
    const frame = ctx.kit.frame()
    const preview = frame
      .locator(
        '[data-k714-enter] .vditor-ir__preview, [data-k714-enter] .vditor-wysiwyg__preview, [data-k714-enter].vditor-wysiwyg__preview, [data-k714-enter] .vmde-callout__preview',
      )
      .first()
    const target = (await preview.count())
      ? preview
      : frame.locator('[data-k714-enter]').first()
    await target.click({ timeout: 10_000 }).catch(() => undefined)
    await ctx.kit.workbox.waitForTimeout(300 * (attempt + 1))
    if (await place()) return true
  }
  return false
}

// Removes a non-collapsed selection that a previous press left behind.
function dropSelectionInPage(_body: Element, _arg: number): boolean {
  const selection = getSelection()
  if (selection && !selection.isCollapsed) selection.removeAllRanges()
  return true
}

// Retires a rectangle a case left behind; a programmatic caret does not clear it.
async function clearRectangle(ctx: Ctx, outcome: Outcome) {
  if (outcome.rect > 0) await ctx.kit.xtest.key('Escape')
}

async function press(ctx: Ctx, keysym: string): Promise<Outcome> {
  // IR keeps a node's markers revealed for a short dwell (editor-caret.ts MARKER_DWELL_MS) after
  // the previous selection left it; let it expire so the snapshot shows the placed caret's state.
  await ctx.kit.workbox.waitForTimeout(150)
  await evalFrame(ctx.kit, snapshotVisibilityInPage, 0)
  await ctx.kit.xtest.key(keysym)
  await ctx.kit.workbox.waitForTimeout(60) // the OS key reaches the webview asynchronously
  return evalFrame(ctx.kit, outcomeInPage, 0)
}

// The mismatch of one press, or null. `rect` is the D1 expectation for this key.
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one switch over the eight keys keeps every expectation side by side
function judge(
  key: KeyName,
  token: string,
  offset: number,
  expected: Expectation,
  outcome: Outcome,
): string | null {
  const direction =
    key === 'Shift+ArrowUp'
      ? 'up'
      : key === 'Shift+ArrowDown'
        ? 'down'
        : key === 'Shift+ArrowLeft'
          ? 'left'
          : key === 'Shift+ArrowRight'
            ? 'right'
            : null
  if (direction && expected.cell?.[direction])
    return outcome.rect === 2 ? null : `[rect 2] got ${describe(outcome)}`
  const text = outcome.visible
  let ok: boolean
  let want: string
  switch (key) {
    case 'Shift+ArrowLeft':
      want = quote(expected.left)
      ok = text === expected.left
      break
    case 'Shift+ArrowRight':
      want = quote(expected.right)
      ok = text === expected.right
      break
    case 'Shift+Home':
      want = quote(expected.homeBefore)
      ok = text === expected.homeBefore
      break
    case 'Shift+End':
      want = quote(expected.homeAfter)
      ok = text === expected.homeAfter
      break
    case 'Ctrl+Shift+ArrowLeft':
      want = quote(token.slice(0, offset))
      ok = text === token.slice(0, offset)
      break
    case 'Ctrl+Shift+ArrowRight':
      want = quote(token.slice(offset))
      ok = text === token.slice(offset)
      break
    case 'Shift+ArrowUp':
      want = `text ending with ${quote(expected.lineBefore)}`
      ok = text.endsWith(expected.lineBefore)
      break
    default:
      want = `text starting with ${quote(expected.lineAfter)}`
      ok = text.startsWith(expected.lineAfter)
  }
  ok = ok && !outcome.collapsed && outcome.rect === 0
  return ok ? null : `${want} [rect 0] got ${describe(outcome)}`
}

async function runConstruct(
  ctx: Ctx,
  construct: Construct,
  mismatches: string[],
) {
  const offset = construct.offset ?? Math.floor(construct.token.length / 2)
  if (construct.skip?.includes(ctx.mode)) {
    console.log(
      `[${TAG} ${ctx.mode}] skip ${construct.name}: no editable text in this mode`,
    )
    return
  }
  if (!(await placeCaret(ctx, construct.token, offset))) {
    const where = await evalFrame(ctx.kit, tokenContextInPage, construct.token)
    mismatches.push(
      `${ctx.mode} ${construct.name} *: expected caret placement got none (${where})`,
    )
    return
  }
  const expected = await evalFrame(ctx.kit, expectationInPage, ctx.mode)
  console.log(
    `[${TAG} ${ctx.mode}] expect ${construct.name} ${JSON.stringify(expected)}`,
  )
  if (!expected.placed) {
    mismatches.push(
      `${ctx.mode} ${construct.name} *: expected caret in token text got ${expected.reason}`,
    )
    return
  }
  for (const [key, keysym] of KEYS) {
    if (!(await placeCaret(ctx, construct.token, offset))) {
      const where = await evalFrame(
        ctx.kit,
        tokenContextInPage,
        construct.token,
      )
      mismatches.push(
        `${ctx.mode} ${construct.name} ${key}: expected caret placement got none (${where})`,
      )
      continue
    }
    const outcome = await press(ctx, keysym)
    const problem = judge(key, construct.token, offset, expected, outcome)
    console.log(
      `[${TAG} ${ctx.mode}] ${construct.name} ${key} ${problem ? 'FAIL' : 'ok'} ${JSON.stringify(outcome)}`,
    )
    if (problem)
      mismatches.push(
        `${ctx.mode} ${construct.name} ${key}: expected ${problem}`,
      )
    await clearRectangle(ctx, outcome)
  }
}

async function runCrossing(
  ctx: Ctx,
  crossing: (typeof CROSSINGS)[number],
  mismatches: string[],
) {
  const offset = Math.floor(crossing.token.length / 2)
  const label = `${ctx.mode} ${crossing.name} Shift+ArrowDown`
  if (!(await placeCaret(ctx, crossing.token, offset))) {
    mismatches.push(`${label}: expected caret placement got none`)
    return
  }
  const expected = await evalFrame(ctx.kit, expectationInPage, ctx.mode)
  const marked =
    ctx.mode === 'sv'
      ? false
      : await evalFrame(ctx.kit, markTargetInPage, crossing.into)
  const outcome = await press(ctx, 'shift+Down')
  console.log(
    `[${TAG} ${ctx.mode}] ${crossing.name} ${JSON.stringify(outcome)}`,
  )
  // IR and WYSIWYG may land the focus at the start of the next block's hidden source, so the
  // selection gains no visible text there; the focus position is the evidence instead.
  const lineOk =
    expected.placed &&
    outcome.visible.startsWith(expected.lineAfter) &&
    (ctx.mode !== 'sv' || outcome.visible.length > expected.lineAfter.length) &&
    outcome.rect === 0
  const targetOk =
    ctx.mode === 'sv' || (marked && outcome.focusInTarget === true)
  if (!lineOk || !targetOk)
    mismatches.push(
      `${label}: expected text starting with ${quote(expected.lineAfter)} and focus in the block of ${crossing.into} got ${describe(outcome)} focusInTarget=${outcome.focusInTarget} focus=${outcome.focusPath}`,
    )
  await clearRectangle(ctx, outcome)
}

// D1 rectangle cases in the 3×3 table's center cell: at the cell end Shift+ArrowRight starts the
// rectangle and Shift+ArrowDown extends it; at the cell start Shift+ArrowLeft starts it and
// Shift+ArrowUp extends it.
async function runRectangle(ctx: Ctx, mismatches: string[]) {
  const sequences: {
    name: string
    token: string
    offset: number
    steps: [string, string, number][]
  }[] = [
    {
      name: 'rect:cell-end',
      token: 'endcelltok',
      offset: 'endcelltok'.length,
      steps: [
        ['Shift+ArrowRight', 'shift+Right', 2],
        ['Shift+ArrowDown', 'shift+Down', 4],
      ],
    },
    {
      name: 'rect:cell-start',
      token: 'startcelltok',
      offset: 0,
      steps: [
        ['Shift+ArrowLeft', 'shift+Left', 2],
        ['Shift+ArrowUp', 'shift+Up', 4],
      ],
    },
  ]
  for (const sequence of sequences) {
    if (!(await placeCaret(ctx, sequence.token, sequence.offset))) {
      mismatches.push(
        `${ctx.mode} ${sequence.name} *: expected caret placement got none`,
      )
      continue
    }
    let last: Outcome | null = null
    for (const [key, keysym, cells] of sequence.steps) {
      last = await press(ctx, keysym)
      console.log(
        `[${TAG} ${ctx.mode}] ${sequence.name} ${key} ${JSON.stringify(last)}`,
      )
      if (last.rect !== cells)
        mismatches.push(
          `${ctx.mode} ${sequence.name} ${key}: expected [rect ${cells}] got ${describe(last)}`,
        )
    }
    if (last) await clearRectangle(ctx, last)
  }
}

for (const mode of ['ir', 'wysiwyg', 'sv'] as Mode[]) {
  test.describe('Task 714 keyboard text selection (OS-level XTEST)', () => {
    test.skip(
      process.env.VMDE_XTEST !== '1',
      'requires isolated Xvfb/Openbox XTEST',
    )
    test.afterEach(restoreKitSettings)

    test(`${mode}: selection keys extend a text selection in every construct`, async ({
      workbox,
      electronApp,
      evaluateInVSCode,
      baseDir,
    }) => {
      test.setTimeout(1_800_000)
      const kit = await makeKit(
        workbox,
        electronApp,
        evaluateInVSCode,
        baseDir,
        TAG,
      )
      const ctx = await openDocument(
        kit,
        `keyboard-text-selection-${mode}.md`,
        FIXTURE_TEXT,
        mode,
      )
      const mismatches: string[] = []
      try {
        await evalFrame(kit, installKeyLogInPage, 0)
        for (const construct of CONSTRUCTS)
          await runConstruct(ctx, construct, mismatches)
        for (const crossing of CROSSINGS)
          await runCrossing(ctx, crossing, mismatches)
        if (mode !== 'sv') await runRectangle(ctx, mismatches)
        // Selection keys never edit: the host document keeps the fixture bytes.
        const host = await hostText(ctx)
        if (host !== FIXTURE_TEXT)
          mismatches.push(
            `${mode} document *: expected the fixture text unchanged got ${JSON.stringify(difference(host, FIXTURE_TEXT))}`,
          )
      } finally {
        console.log(`[${TAG} ${mode}] mismatches ${JSON.stringify(mismatches)}`)
        await disposeObservers(kit)
        await closeAll(kit, ctx.file)
      }
      expect(mismatches, `${mode}: keyboard selection mismatches`).toEqual([])
    })
  })
}
