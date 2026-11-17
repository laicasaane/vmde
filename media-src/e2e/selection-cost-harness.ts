import { tableHeavyMarkdown } from '../../test/vscode-e2e/table-heavy-markdown'

// Task 012-16 M-1 and M-2 (D-13 design sections 3 and 11.4): measures the native cost of Selection
// changes, live-range mutations and the style and layout flush they force after a DOM write, against the
// document size. The page renders `tableHeavyMarkdown(f)` through Lute into one IR-like editable root and
// times each variant from its start (a keydown handler, or a timer task for variant e) to the next
// animation frame. The caret sits in the first paragraph (before the tables), in a body cell of table A
// (the `-cell` variants) or in the code block (the `h-` variants), so the operation is local while the
// document grows. Driven by `selection-cost.spec.ts` through `window.__selectionCost`.

type Variant =
  | 'a'
  | 'b'
  | 'c'
  | 'd'
  | 'e'
  | 'f'
  | 'g'
  | 'g1'
  | 'g-cell'
  | 'h-live'
  | 'h-clone'
  | 'k-off'
  | 'k-contain'
  | 'k-cv'
  | 'k-contain-cell'
  | 'k-cv-cell'
  | 'k-product'
  | 'k-product-layout'
  | 'k-marker'
  | 'k-product-none'

/** The page style a variant runs under: production, no stylesheets, or one injected containment rule. */
type StyleMode =
  | 'production'
  | 'off'
  | 'contain'
  | 'cv'
  | 'product'
  | 'product-layout'
  | 'marker'
  | 'product-none'
type InjectedMode = Exclude<StyleMode, 'production' | 'off'>

interface Sample {
  /** From the handler start to the handler end (the synchronous part). */
  handler: number
  /** From the handler start to the next animation frame (handler plus the deferred work). */
  toFrame: number
  /** Whether the editable root held focus after the operation. */
  rootFocused: boolean
  /** Whether the caret ended where the variant put it; null for variant d, which moves no caret. */
  caretOk: boolean | null
}

interface LuteInstance {
  Md2VditorIRDOM(markdown: string): string
  SetSanitize(on: boolean): void
}

const BASE_OFFSET = 1
const TARGET_OFFSET = 2
// Rules that the containment variants inject (D-13 design section 11.4, k-contain and k-cv). Task 025-E
// adds the candidate product rules: top-level IR blocks contained with the product selector
// (`layout style`, then `layout` alone), and task 028-E's narrow rule that makes each inline-code node
// the containing block of its two absolutely positioned markers. Task 025-T adds `product-none`: the shipped
// page with the product containment rule switched off, the in-run reference of the gain case.
const STYLE_RULES: Record<InjectedMode, string> = {
  contain: '#root > * { contain: layout style; }',
  cv: '#root > table { content-visibility: auto; contain-intrinsic-size: auto 800px; }',
  product: '.vditor-ir .vditor-reset > * { contain: layout style; }',
  'product-layout': '.vditor-ir .vditor-reset > * { contain: layout; }',
  marker:
    ".vditor-ir .vditor-reset .vditor-ir__node[data-type='code'] { position: relative; }",
  'product-none':
    '.vditor-ir > .vditor-reset > * { contain: none !important; }',
}

const root = document.getElementById('root') as HTMLElement
const outside = document.getElementById('outside') as HTMLInputElement
let pending: Promise<Sample> | null = null
let insertedWbr: HTMLElement | null = null
let writtenText: Text | null = null
let writtenAt = 0
let savedCodeBlock: string | null = null
let expectedCaret: { node: Node; offset: number } | null = null
let injectedStyle: HTMLStyleElement | null = null

/** The first text node in the root that `accept` matches; each matched text is unique in the fixture. */
function findText(accept: (data: string) => boolean, what: string): Text {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (accept((node as Text).data)) return node as Text
  }
  throw new Error(`no text node for ${what}`)
}

function paragraphText(): Text {
  return findText(
    (data) => data.startsWith('First paragraph'),
    'the caret paragraph',
  )
}

function cellText(): Text {
  return findText((data) => data === 'Item a2', 'the caret cell')
}

function codeBlock(): HTMLElement {
  const block = root.querySelector<HTMLElement>('[data-type="code-block"]')
  if (!block) throw new Error('no code block')
  return block
}

/** The source text of the code block (its marker `pre`, not the preview). */
function codeText(): Text {
  const code = codeBlock().querySelector('.vditor-ir__marker--pre code')
  const text = code?.firstChild
  if (!(text instanceof Text)) throw new Error('no code block text')
  return text
}

function isCellVariant(variant: Variant): boolean {
  return variant === 'g-cell' || variant.endsWith('-cell')
}

function caretText(variant: Variant): Text {
  return isCellVariant(variant) ? cellText() : paragraphText()
}

function load(factor: 1 | 4 | 16): { textLength: number; elements: number } {
  const LuteGlobal = (window as unknown as { Lute: { New(): LuteInstance } })
    .Lute
  const lute = LuteGlobal.New()
  lute.SetSanitize(true)
  root.innerHTML = lute.Md2VditorIRDOM(tableHeavyMarkdown(factor))
  return {
    textLength: root.textContent?.length ?? 0,
    elements: root.getElementsByTagName('*').length,
  }
}

/** Sets the page style for the following samples; not timed (the spec waits two frames after it). */
function configure(mode: StyleMode): void {
  injectedStyle?.remove()
  injectedStyle = null
  for (const sheet of Array.from(document.styleSheets))
    sheet.disabled = mode === 'off'
  if (mode !== 'production' && mode !== 'off') {
    injectedStyle = document.createElement('style')
    injectedStyle.textContent = STYLE_RULES[mode]
    document.head.append(injectedStyle)
  }
}

/** Puts the caret at its base position and the focus where the variant needs it; not timed. */
function prepare(variant: Variant): void {
  root.focus()
  if (variant === 'h-live' || variant === 'h-clone') {
    savedCodeBlock = codeBlock().outerHTML
    const text = codeText()
    const lineEnd = text.data.indexOf('\n')
    getSelection()?.setBaseAndExtent(text, lineEnd, text, lineEnd)
    return
  }
  const text = caretText(variant)
  getSelection()?.setBaseAndExtent(text, BASE_OFFSET, text, BASE_OFFSET)
  if (variant === 'f') outside.focus()
}

/** The selection change pair that Vditor's `setSelectionFocus` makes. */
function setSelectionFocus(range: Range): void {
  const selection = getSelection() as Selection
  selection.removeAllRanges()
  selection.addRange(range)
}

function collapsedAt(node: Node, offset: number): Range {
  const range = document.createRange()
  range.setStart(node, offset)
  range.collapse(true)
  return range
}

/** A one-character write in the caret's own text node (cell variants) or in the second paragraph. */
function writeOneCharacter(variant: Variant): void {
  writtenText = isCellVariant(variant)
    ? cellText()
    : findText(
        (data) => data.startsWith('Second paragraph'),
        'the written paragraph',
      )
  // Cell variants write after the caret so the caret's offset stays the same.
  writtenAt = isCellVariant(variant) ? writtenText.data.length : 0
  writtenText.insertData(writtenAt, 'x')
}

/**
 * The IR code block Enter as Vditor runs it (`fixCodeBlock` Enter branch, then `IRInput` and
 * `setRangeByWbr`), on the live Range or (V-3a plus V-2) on a clone with one final selection write. The
 * block's `outerHTML` written with its own HTML stands in for the Lute spin of `IRInput`.
 */
function codeBlockEnter(live: boolean): void {
  const selection = getSelection() as Selection
  const range = live
    ? selection.getRangeAt(0)
    : selection.getRangeAt(0).cloneRange()
  range.extractContents()
  range.insertNode(document.createTextNode('\n'))
  range.collapse(false)
  if (live) setSelectionFocus(range)
  range.insertNode(document.createElement('wbr'))
  const block = codeBlock()
  const html = block.outerHTML
  block.outerHTML = html
  const wbr = root.querySelector('wbr') as HTMLElement
  range.setStartBefore(wbr)
  range.collapse(true)
  wbr.remove()
  if (live) setSelectionFocus(range)
  else
    selection.setBaseAndExtent(
      range.startContainer,
      range.startOffset,
      range.startContainer,
      range.startOffset,
    )
  expectedCaret = { node: range.startContainer, offset: range.startOffset }
}

function operate(variant: Variant): void {
  const selection = getSelection() as Selection
  if (variant === 'h-live' || variant === 'h-clone') {
    codeBlockEnter(variant === 'h-live')
    return
  }
  const text = caretText(variant)
  expectedCaret = { node: text, offset: TARGET_OFFSET }
  switch (variant) {
    case 'a':
    case 'e':
    case 'f':
      setSelectionFocus(collapsedAt(text, TARGET_OFFSET))
      return
    case 'b':
      selection.setBaseAndExtent(text, TARGET_OFFSET, text, TARGET_OFFSET)
      return
    case 'c':
      selection.getRangeAt(0).setStart(text, TARGET_OFFSET)
      return
    case 'd': {
      expectedCaret = null
      const clone = selection.getRangeAt(0).cloneRange()
      insertedWbr = document.createElement('wbr')
      clone.insertNode(insertedWbr)
      return
    }
    case 'g1':
      writeOneCharacter(variant)
      selection.setBaseAndExtent(text, TARGET_OFFSET, text, TARGET_OFFSET)
      return
    default:
      // g, g-cell and the k- variants (product and marker rules included): the write, then the pair.
      writeOneCharacter(variant)
      setSelectionFocus(collapsedAt(text, TARGET_OFFSET))
      return
  }
}

function caretMatches(): boolean | null {
  if (!expectedCaret) return null
  const selection = getSelection()
  if (!selection || selection.rangeCount === 0) return false
  const range = selection.getRangeAt(0)
  return (
    range.collapsed &&
    range.startContainer === expectedCaret.node &&
    range.startOffset === expectedCaret.offset
  )
}

/** Restores the DOM that the variant changed; runs after the sample is taken. */
function cleanup(): void {
  if (insertedWbr) {
    const parent = insertedWbr.parentNode
    insertedWbr.remove()
    parent?.normalize()
    insertedWbr = null
  }
  if (writtenText) {
    writtenText.deleteData(writtenAt, 1)
    writtenText = null
  }
  if (savedCodeBlock !== null) {
    codeBlock().outerHTML = savedCodeBlock
    savedCodeBlock = null
  }
  expectedCaret = null
}

function timed(variant: Variant): Promise<Sample> {
  const start = performance.now()
  operate(variant)
  const handler = performance.now() - start
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      const toFrame = performance.now() - start
      const rootFocused = document.activeElement === root
      const caretOk = caretMatches()
      cleanup()
      resolve({ handler, toFrame, rootFocused, caretOk })
    })
  })
}

/** Arms one variant: a one-shot keydown handler, or (variant e) a timer task that needs no key. */
function arm(variant: Variant): void {
  if (variant === 'e') {
    pending = new Promise((resolve) => {
      setTimeout(() => resolve(timed(variant)), 0)
    })
    return
  }
  pending = new Promise((resolve) => {
    const onKeydown = (event: KeyboardEvent): void => {
      document.removeEventListener('keydown', onKeydown, true)
      event.preventDefault()
      resolve(timed(variant))
    }
    document.addEventListener('keydown', onKeydown, true)
  })
}

async function take(): Promise<Sample> {
  if (!pending) throw new Error('no variant armed')
  const sample = await pending
  pending = null
  return sample
}

;(window as unknown as { __selectionCost: unknown }).__selectionCost = {
  load,
  configure,
  prepare,
  arm,
  take,
}
;(window as unknown as { __selectionCostReady: boolean }).__selectionCostReady =
  true
