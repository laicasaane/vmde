// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as CountersModule from './edit-counters'
import type { EditCounters } from './edit-counters'

type AnyFn = (...args: any[]) => any

const originalCloneNode = Node.prototype.cloneNode
const originalQueryAll = Element.prototype.querySelectorAll
const originalInnerHtml = Object.getOwnPropertyDescriptor(
  Element.prototype,
  'innerHTML',
) as PropertyDescriptor
// Task 733 / 012-19: the Selection methods the `selectionWrites` counter wraps, put back after each test.
const SELECTION_WRITES = [
  'addRange',
  'removeAllRanges',
  'setBaseAndExtent',
  'collapse',
  'collapseToStart',
  'collapseToEnd',
  'extend',
  'selectAllChildren',
] as const
const originalSelectionWrites = SELECTION_WRITES.map(
  (name) =>
    [name, Object.getOwnPropertyDescriptor(Selection.prototype, name)] as const,
)

// The module keeps once-per-window state, so each test loads a fresh copy and the afterEach below
// puts the prototypes back.
let installEditCounters: typeof CountersModule.installEditCounters
let countFallbackPublication: typeof CountersModule.countFallbackPublication

function counters(): EditCounters {
  return (window as any).__vmdeEditCounters as EditCounters
}

function makeFixture() {
  // Vditor's mode root (`ir.element`) is the `pre.vditor-reset` INSIDE the `.vditor-ir` container.
  const outer = document.createElement('div')
  outer.className = 'vditor-ir'
  const root = document.createElement('pre')
  root.className = 'vditor-reset'
  root.innerHTML = '<p>hello</p>'
  outer.appendChild(root)
  document.body.appendChild(outer)
  const calls: string[] = []
  const lute = {
    VditorIRDOM2Md: (html: string) => {
      calls.push(`ir2md:${html.length}`)
      return 'md'
    },
    SpinVditorIRDOM: (html: string) => `spin:${html}`,
    Md2VditorIRDOM: (md: string) => `ir:${md}`,
    Md2HTML: (md: string) => `html:${md}`,
  }
  const vditor = {
    getValue: () => 'value',
    vditor: { currentMode: 'ir', lute, ir: { element: root } },
  }
  const posted: unknown[] = []
  const original = Object.freeze({
    postMessage: (message: unknown) => {
      posted.push(message)
      return 'posted'
    },
    getState: () => 'state',
  })
  ;(window as any).vscode = original
  ;(window as any).__vmdeE2EReadiness = {}
  return { outer, root, vditor, lute, posted, original, calls }
}

beforeEach(async () => {
  vi.resetModules()
  ;({ installEditCounters, countFallbackPublication } = await import(
    './edit-counters'
  ))
  delete (window as any).__vmdeEditCounters
})

afterEach(() => {
  Node.prototype.cloneNode = originalCloneNode
  Element.prototype.querySelectorAll = originalQueryAll
  Object.defineProperty(Element.prototype, 'innerHTML', originalInnerHtml)
  for (const [name, descriptor] of originalSelectionWrites)
    if (descriptor) Object.defineProperty(Selection.prototype, name, descriptor)
  window.getSelection()?.removeAllRanges()
  delete (window as any).__vmdeE2EReadiness
  delete (window as any).__vmdeEditCounters
})

describe('installEditCounters', () => {
  it('counts getValue, Lute tables, root clones and posts, and returns originals', () => {
    const { root, vditor, lute } = makeFixture()
    installEditCounters(window, vditor as any)
    counters().reset(10)

    expect(vditor.getValue()).toBe('value')
    expect(counters().fullGetValue).toBe(1)

    const table =
      '<table><tr><td>a</td></tr><tr><td>b</td></tr><tr><td>c</td></tr></table>'
    expect(lute.SpinVditorIRDOM(table)).toBe(`spin:${table}`)
    expect(counters().luteTable).toBe(1)
    expect(counters().luteDocument).toBe(1)

    const list = '<ul><li>a</li><li>b</li><li>c</li></ul>'
    lute.Md2VditorIRDOM('x'.repeat(2))
    lute.VditorIRDOM2Md(list)
    expect(counters().luteList).toBe(1)

    const clone = root.cloneNode(true)
    expect(clone).not.toBe(root)
    expect(counters().rootClone).toBe(1)

    void root.innerHTML
    expect(counters().rootInnerHtmlRead).toBe(1)
    void (clone as Element).innerHTML
    expect(counters().rootInnerHtmlRead).toBe(2)

    const other = document.createElement('div')
    other.cloneNode(true)
    void other.innerHTML
    expect(counters().rootClone).toBe(1)
    expect(counters().rootInnerHtmlRead).toBe(2)

    const edit = { command: 'edit', content: 'x' }
    expect(window.vscode.postMessage(edit as any)).toBe('posted')
    expect(counters().legacyEditPosts).toBe(1)
    expect(counters().maxPostBytes).toBe(JSON.stringify(edit).length)
    window.vscode.postMessage({ command: 'edit-delta' } as any)
    expect(counters().deltaPosts).toBe(1)
    expect((window.vscode as any).getState()).toBe('state')
  })

  it('classifies luteDocument by input length against reset values', () => {
    const { vditor, lute } = makeFixture()
    installEditCounters(window, vditor as any)
    counters().reset(100)
    lute.Md2HTML('x'.repeat(40))
    expect(counters().luteDocument).toBe(0)
    lute.Md2HTML('x'.repeat(60))
    expect(counters().luteDocument).toBe(1)
    countFallbackPublication(window)
    expect(counters().fallbackPublications).toBe(1)
    counters().reset(100)
    expect(counters().fallbackPublications).toBe(0)
    expect(counters().luteDocument).toBe(0)
  })

  // Task 733 / 012-11: a whole fenced code block serialized by Lute (the text path makes none).
  it('counts luteBlock for a VditorIRDOM2Md input that is a top-level code block only', () => {
    // Read by name: the field is added to EditCounters by the implementation segment.
    const luteBlock = () =>
      (counters() as unknown as Record<string, number>).luteBlock
    const { vditor, lute } = makeFixture()
    installEditCounters(window, vditor as any)
    counters().reset(10_000)
    expect(luteBlock()).toBe(0)
    const block =
      '<div data-block="0" data-type="code-block" class="vditor-ir__node"><span data-type="code-block-open-marker">```</span></div>'
    expect(lute.VditorIRDOM2Md(block)).toBe('md')
    expect(luteBlock()).toBe(1)
    // The spin and the render of the same block, and other blocks, are no whole-block serialize.
    lute.SpinVditorIRDOM(block)
    lute.Md2VditorIRDOM(block)
    lute.VditorIRDOM2Md('<p data-block="0">a</p>')
    lute.VditorIRDOM2Md(`<p data-block="0">a</p>${block}`)
    lute.VditorIRDOM2Md(
      '<div data-block="0" data-type="math-block" class="vditor-ir__node"></div>',
    )
    expect(luteBlock()).toBe(1)
    counters().reset(10_000)
    expect(luteBlock()).toBe(0)
  })

  it('installs no second wrapper on a second call', () => {
    const { vditor, lute } = makeFixture()
    installEditCounters(window, vditor as any)
    const getValue = vditor.getValue
    const spin: AnyFn = lute.SpinVditorIRDOM
    const clone = Node.prototype.cloneNode
    const vscodeWrapper = window.vscode
    installEditCounters(window, vditor as any)
    expect(vditor.getValue).toBe(getValue)
    expect(lute.SpinVditorIRDOM).toBe(spin)
    expect(Node.prototype.cloneNode).toBe(clone)
    expect(window.vscode).toBe(vscodeWrapper)
  })

  it('countFallbackPublication does nothing without counters', () => {
    expect(() => countFallbackPublication(window)).not.toThrow()
    expect((window as any).__vmdeEditCounters).toBeUndefined()
  })
})

describe('mode root identity', () => {
  it('counts the editing element and its clone, not the outer container', () => {
    const { outer, root, vditor } = makeFixture()
    installEditCounters(window, vditor as any)
    counters().reset(10)

    const outerClone = outer.cloneNode(true)
    void outer.innerHTML
    void (outerClone as Element).innerHTML
    expect(counters().rootClone).toBe(0)
    expect(counters().rootInnerHtmlRead).toBe(0)

    const clone = root.cloneNode(true)
    expect(counters().rootClone).toBe(1)
    void root.innerHTML
    expect(counters().rootInnerHtmlRead).toBe(1)
    void (clone as Element).innerHTML
    expect(counters().rootInnerHtmlRead).toBe(2)
  })

  it('counts the root of a rebuilt instance', () => {
    const first = makeFixture()
    installEditCounters(window, first.vditor as any)
    const second = makeFixture()
    installEditCounters(window, second.vditor as any)
    counters().reset(10)
    second.root.cloneNode(true)
    expect(counters().rootClone).toBe(1)
  })
})

describe('task 001 counters', () => {
  it('counts a deep table clone inside a mode root, not near misses', () => {
    const { root, vditor } = makeFixture()
    const table = document.createElement('table')
    root.appendChild(table)
    const paragraph = root.querySelector('p') as Element
    const outside = document.createElement('table')
    document.body.appendChild(outside)
    installEditCounters(window, vditor as any)
    counters().reset(10)

    table.cloneNode(true)
    expect(counters().tableClone).toBe(1)
    table.cloneNode(false)
    table.cloneNode()
    paragraph.cloneNode(true)
    outside.cloneNode(true)
    expect(counters().tableClone).toBe(1)
    counters().reset(10)
    expect(counters().tableClone).toBe(0)
  })

  it('counts querySelectorAll on a mode root or #app, not on a child', () => {
    const { outer, root, vditor } = makeFixture()
    const app = document.createElement('div')
    app.id = 'app'
    document.body.appendChild(app)
    installEditCounters(window, vditor as any)
    counters().reset(10)

    const found = root.querySelectorAll('p')
    expect(found).toHaveLength(1)
    expect(counters().rootQueryAll).toBe(1)
    app.querySelectorAll('div')
    expect(counters().rootQueryAll).toBe(2)
    ;(root.querySelector('p') as Element).querySelectorAll('span')
    outer.querySelectorAll('p')
    document.createElement('div').querySelectorAll('p')
    expect(counters().rootQueryAll).toBe(2)
    counters().reset(10)
    expect(counters().rootQueryAll).toBe(0)
  })

  it('counts posted history-delta messages only', () => {
    const { vditor } = makeFixture()
    installEditCounters(window, vditor as any)
    counters().reset(10)

    window.vscode.postMessage({ command: 'history-delta' } as any)
    window.vscode.postMessage({ command: 'history-delta' } as any)
    window.vscode.postMessage({ command: 'edit-delta' } as any)
    window.vscode.postMessage({ command: 'history' } as any)
    expect(counters().historyDeltaPosts).toBe(2)
    expect(counters().deltaPosts).toBe(1)
    counters().reset(10)
    expect(counters().historyDeltaPosts).toBe(0)
  })
})

// Task 733 / 012-19 (D-13 design section 1.3, kept by section 12.2 as a recorded end-to-end counter):
// `selectionWrites` counts the Selection writes into a mode root (so a `removeAllRanges` plus
// `addRange` pair counts 2). Counts only, no text (SR-5). Run 1 (P-1): the wrapper decides from the
// write's node argument, else from the focused element, and reads no Selection property.
describe('selectionWrites (012-19)', () => {
  const selectionWrites = () =>
    (counters() as EditCounters & { selectionWrites?: number }).selectionWrites

  it('counts every Selection write method inside a mode root', () => {
    const { root, vditor } = makeFixture()
    installEditCounters(window, vditor as any)
    // The edited mode root holds focus; the writes without a node argument are decided from it.
    root.tabIndex = -1
    root.focus()
    const paragraph = root.querySelector('p') as HTMLElement
    const text = paragraph.firstChild as Text
    const selection = window.getSelection() as Selection
    selection.setBaseAndExtent(text, 0, text, 0)
    counters().reset(10)
    expect(selectionWrites()).toBe(0)

    const range = document.createRange()
    range.setStart(text, 1)
    range.collapse(true)
    selection.removeAllRanges()
    selection.addRange(range)
    selection.setBaseAndExtent(text, 0, text, 2)
    selection.collapse(text, 1)
    selection.collapseToStart()
    selection.collapseToEnd()
    selection.extend(text, 3)
    selection.selectAllChildren(paragraph)
    expect(selectionWrites()).toBe(8)
    // Reads are not writes.
    selection.getRangeAt(0)
    void selection.anchorNode
    expect(selectionWrites()).toBe(8)
    counters().reset(10)
    expect(selectionWrites()).toBe(0)
  })

  it('does not count writes outside every mode root', () => {
    const { vditor } = makeFixture()
    installEditCounters(window, vditor as any)
    const elsewhere = document.createElement('div')
    elsewhere.textContent = 'outside'
    document.body.appendChild(elsewhere)
    const text = elsewhere.firstChild as Text
    const selection = window.getSelection() as Selection
    selection.setBaseAndExtent(text, 0, text, 0)
    counters().reset(10)
    selection.setBaseAndExtent(text, 1, text, 2)
    selection.collapse(text, 3)
    selection.collapseToEnd()
    expect(selectionWrites()).toBe(0)
  })

  it('reads no Selection property around a write (run 1, P-1)', () => {
    const { root, vditor } = makeFixture()
    installEditCounters(window, vditor as any)
    root.tabIndex = -1
    root.focus()
    const paragraph = root.querySelector('p') as HTMLElement
    const text = paragraph.firstChild as Text
    const selection = window.getSelection() as Selection
    selection.setBaseAndExtent(text, 0, text, 0)
    counters().reset(10)
    const reads = [
      vi.spyOn(Selection.prototype, 'anchorNode', 'get'),
      vi.spyOn(Selection.prototype, 'focusNode', 'get'),
      vi.spyOn(Selection.prototype, 'rangeCount', 'get'),
      vi.spyOn(Selection.prototype, 'getRangeAt'),
    ]
    const range = document.createRange()
    range.setStart(text, 2)
    range.collapse(true)
    selection.removeAllRanges()
    selection.addRange(range)
    selection.setBaseAndExtent(text, 0, text, 1)
    selection.collapse(text, 1)
    selection.collapseToEnd()
    selection.selectAllChildren(paragraph)
    const readCounts = reads.map((spy) => spy.mock.calls.length)
    for (const spy of reads) spy.mockRestore()
    expect(readCounts).toEqual([0, 0, 0, 0])
    expect(selectionWrites()).toBe(6)
  })

  it('installs no second Selection wrapper on a second call', () => {
    const { root, vditor } = makeFixture()
    installEditCounters(window, vditor as any)
    installEditCounters(window, vditor as any)
    const text = (root.querySelector('p') as HTMLElement).firstChild as Text
    window.getSelection()?.setBaseAndExtent(text, 0, text, 0)
    counters().reset(10)
    window.getSelection()?.collapse(text, 2)
    expect(selectionWrites()).toBe(1)
  })
})

describe('no production effect', () => {
  it('creates nothing when the readiness global is absent from the page', async () => {
    // finish-init guards the call on __vmdeE2EReadiness; without it the module is never invoked.
    expect((window as any).__vmdeE2EReadiness).toBeUndefined()
    expect((window as any).__vmdeEditCounters).toBeUndefined()
    expect(Node.prototype.cloneNode).toBe(originalCloneNode)
  })
})
