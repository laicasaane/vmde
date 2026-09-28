// @vitest-environment jsdom
/**
 * The selection-performance and Find & Replace probes classify Lute calls and live marker inserts
 * for the "0 whole-document work" gates (Tasks 196, 574, 578). These tests feed each probe the
 * real rewrap marker shape (`rewrap-command.ts` prefixes a private-use character) and whole-document
 * inputs, so a gate that asserts 0 can actually fail.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { installFindReplaceProbe } from '../vscode-e2e/find-replace-probe'
import { installSelectionPerformanceProbe } from '../vscode-e2e/selection-performance-probe'

// Same values as `SOURCE_START_BASE`/`SOURCE_END_BASE` in media-src/src/editing/rewrap-command.ts.
const START_MARKER = '\uE100VMDE_REWRAP_START'
const END_MARKER = '\uE101VMDE_REWRAP_END'
const MARKDOWN = 'alpha beta\n\ngamma delta\n'

type LuteFn = (input: string) => string
interface FakeEditor {
  root: HTMLElement
  lute: Record<string, LuteFn>
  outer: { getValue(): string; setValue(markdown: string): void }
}

function installFakeEditor(): FakeEditor {
  const root = document.createElement('div')
  root.innerHTML = '<p>alpha beta</p><p>gamma delta</p>'
  document.body.append(root)
  const lute: Record<string, LuteFn> = {
    VditorIRDOM2Md: () => MARKDOWN,
    VditorDOM2Md: () => MARKDOWN,
    Md2VditorIRDOM: () => root.innerHTML,
    Md2VditorDOM: () => root.innerHTML,
  }
  const outer = {
    getValue: () => MARKDOWN,
    setValue: (_markdown: string) => {
      // The fake editor ignores writes; the probe wrapper records them.
    },
    vditor: { currentMode: 'ir', lute, ir: { element: root } },
  }
  ;(window as unknown as { vditor: unknown }).vditor = outer
  return { root, lute, outer }
}

function insertIntoRoot(root: HTMLElement, text: string): void {
  const range = document.createRange()
  range.setStart(root.firstChild!.firstChild!, 5)
  range.collapse(true)
  range.insertNode(document.createTextNode(text))
}

afterEach(() => {
  document.body.innerHTML = ''
  const win = window as unknown as Record<string, unknown>
  delete win.vditor
  delete win.__selectionPerformanceProbe
  delete win.__vmdeFindReplaceProbe
})

describe('selection performance probe', () => {
  it('counts the prefixed rewrap markers as live marker insertions', () => {
    const { root } = installFakeEditor()
    installSelectionPerformanceProbe(MARKDOWN)
    const probe = (window as any).__selectionPerformanceProbe
    probe.start()
    insertIntoRoot(root, START_MARKER)
    insertIntoRoot(root, `${END_MARKER}_`)
    insertIntoRoot(root, 'plain text')
    const result = probe.stop()
    expect(result.rangeInsertCalls).toBe(3)
    expect(result.liveMarkerInsertions).toBe(2)
  })

  it('counts a marked live-root serialization as a root Lute call', () => {
    const { root, lute } = installFakeEditor()
    installSelectionPerformanceProbe(MARKDOWN)
    const probe = (window as any).__selectionPerformanceProbe
    const unmarked = root.innerHTML
    probe.start()
    insertIntoRoot(root, START_MARKER)
    lute.VditorIRDOM2Md(root.innerHTML)
    lute.VditorIRDOM2Md('<p>alpha</p>')
    const result = probe.stop()
    expect(root.innerHTML).not.toBe(unmarked)
    expect(result.rootLuteCalls).toBe(1)
    expect(result.fragmentLuteCalls).toBe(1)
  })
})

describe('find replace probe', () => {
  it('counts a whole-document Markdown render as a root Lute call', () => {
    const { lute, outer } = installFakeEditor()
    installFindReplaceProbe()
    const probe = (window as any).__vmdeFindReplaceProbe
    probe.start()
    lute.Md2VditorIRDOM(outer.getValue())
    lute.Md2VditorIRDOM('gamma delta\n')
    const result = probe.stop()
    expect(result.rootLuteCalls).toBe(1)
    expect(result.fragmentLuteCalls).toBe(1)
  })

  it('counts a render of the setValue document as a root Lute call', () => {
    const { lute, outer } = installFakeEditor()
    installFindReplaceProbe()
    const probe = (window as any).__vmdeFindReplaceProbe
    probe.start()
    outer.setValue('replaced document\n')
    lute.Md2VditorIRDOM('replaced document\n')
    const result = probe.stop()
    expect(result.setValueCalls).toBe(1)
    expect(result.rootLuteCalls).toBe(1)
  })

  it('counts a marked live-root serialization as a root Lute call', () => {
    const { root, lute } = installFakeEditor()
    installFindReplaceProbe()
    const probe = (window as any).__vmdeFindReplaceProbe
    probe.start()
    const markedClone = root.innerHTML.replace('alpha', `alpha${START_MARKER}`)
    lute.VditorIRDOM2Md(markedClone)
    lute.VditorIRDOM2Md(root.innerHTML)
    const result = probe.stop()
    expect(result.rootLuteCalls).toBe(2)
    expect(result.fragmentLuteCalls).toBe(0)
  })
})
