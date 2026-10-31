// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushSourceGutter, setSourcePaneOptions } from './sv-gutter'

// Task 645: lifecycle of the Split View source gutter. The overlay lives under <body>, outside
// `.vditor`, so Undo snapshots, Find and the editor-area mutation observers never see it; turning
// the feature off removes the overlay and every listener.
const OFF = { lineNumbers: false, currentLine: false }
const ON = { lineNumbers: true, currentLine: false }

function mountPane(): { root: HTMLElement; sv: HTMLElement } {
  document.body.innerHTML = `
    <div class="vditor"><div class="vditor-content">
      <pre class="vditor-sv vditor-reset" contenteditable="true" tabindex="0" style="line-height: 22px"><div data-block="0"><span data-type="text">Alpha</span><span data-type="newline"><br></span><span data-type="newline"><br></span></div></pre>
      <div class="vditor-preview"></div>
    </div></div>`
  return {
    root: document.querySelector('.vditor') as HTMLElement,
    sv: document.querySelector('.vditor-sv') as HTMLElement,
  }
}

beforeEach(() => {
  mountPane()
})

afterEach(() => {
  setSourcePaneOptions(OFF)
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('source gutter lifecycle (task 645)', () => {
  it('creates one aria-hidden overlay under <body>, outside .vditor, and reuses it', () => {
    setSourcePaneOptions(ON)
    const overlay = document.querySelector('body > .vmde-sv-gutter')
    expect(overlay).not.toBeNull()
    expect(overlay?.getAttribute('aria-hidden')).toBe('true')
    expect(overlay?.closest('.vditor')).toBeNull()
    setSourcePaneOptions(ON)
    expect(document.querySelectorAll('.vmde-sv-gutter')).toHaveLength(1)
    expect(document.querySelector('body > .vmde-sv-gutter')).toBe(overlay)
  })

  it('writes no node, attribute or text inside .vditor while turning on, updating and turning off', () => {
    const { root } = mountPane()
    const observer = new MutationObserver(vi.fn())
    observer.observe(root, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    })
    setSourcePaneOptions(ON)
    flushSourceGutter()
    setSourcePaneOptions({ lineNumbers: true, currentLine: true })
    flushSourceGutter()
    setSourcePaneOptions(OFF)
    expect(observer.takeRecords()).toHaveLength(0)
    observer.disconnect()
  })

  it('removes the overlay when turned off and detaches the scroll listener it attached', () => {
    const { sv } = mountPane()
    const add = vi.spyOn(sv, 'addEventListener')
    const remove = vi.spyOn(sv, 'removeEventListener')
    setSourcePaneOptions(ON)
    const scrollAdds = add.mock.calls.filter((call) => call[0] === 'scroll')
    expect(scrollAdds.length).toBeGreaterThan(0)
    setSourcePaneOptions(OFF)
    expect(document.querySelector('.vmde-sv-gutter')).toBeNull()
    for (const [type, handler] of scrollAdds)
      expect(remove).toHaveBeenCalledWith(type, handler, expect.anything())
  })

  it('turning off when it was never on is a no-op', () => {
    expect(() => setSourcePaneOptions(OFF)).not.toThrow()
    expect(document.querySelector('.vmde-sv-gutter')).toBeNull()
  })

  it('counts its passes in the test hook', () => {
    setSourcePaneOptions(ON)
    flushSourceGutter()
    const stats = (window as any).__vmdeSvGutterStats
    expect(stats).toEqual(
      expect.objectContaining({
        globalPasses: expect.any(Number),
        windowPasses: expect.any(Number),
        labelWrites: expect.any(Number),
      }),
    )
  })
})

// Current-row highlight (task 645): the band's position travels in two registered variables on one
// CSSOM rule in <head>, never as a node or attribute inside `.vditor`. Layout does not exist in jsdom,
// so the geometry is stubbed: the pane top is 50px, the caret's row is a 16px box at 100px, and the
// pane's line height is 22px, so the band is centred on 108 and starts at 108 - 11 - 50 = 47px.
describe('current row band (task 645)', () => {
  const CURRENT = { lineNumbers: false, currentLine: true }
  const rectsOf = (top: number, bottom: number) =>
    [
      {
        top,
        bottom,
        left: 10,
        right: 18,
        width: 8,
        height: bottom - top,
      },
    ] as unknown as DOMRectList

  function stub(sv: HTMLElement) {
    sv.getBoundingClientRect = () =>
      ({
        top: 50,
        bottom: 450,
        left: 0,
        right: 400,
        width: 400,
        height: 400,
      }) as DOMRect
    ;(Range.prototype as any).getClientRects = () => rectsOf(100, 116)
  }

  function placeCaret(sv: HTMLElement, collapsed: boolean) {
    const text = sv.querySelector('[data-type="text"]')?.firstChild as Text
    const range = document.createRange()
    range.setStart(text, 1)
    if (collapsed) range.collapse(true)
    else range.setEnd(text, 4)
    // Focus first: jsdom resets the selection when an editable element takes focus.
    sv.focus()
    const selection = getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))
  }

  const rule = () =>
    (document.getElementById('vmde-sv-pane-state') as HTMLStyleElement | null)
      ?.sheet?.cssRules[0] as CSSStyleRule | undefined
  const read = (name: string) => rule()?.style.getPropertyValue(name)

  afterEach(() => {
    delete (Range.prototype as any).getClientRects
  })

  it('writes the band for a collapsed caret in the focused pane and creates no overlay', () => {
    const { sv } = mountPane()
    stub(sv)
    setSourcePaneOptions(CURRENT)
    placeCaret(sv, true)
    flushSourceGutter()
    expect(read('--vmde-sv-row-top')).toBe('47px')
    expect(read('--vmde-sv-row-height')).toBe('22px')
    expect(document.querySelector('.vmde-sv-gutter')).toBeNull()
  })

  it('hides the band for a non-collapsed selection and when the pane loses focus', () => {
    const { sv } = mountPane()
    stub(sv)
    setSourcePaneOptions(CURRENT)
    placeCaret(sv, false)
    flushSourceGutter()
    expect(read('--vmde-sv-row-height')).toBe('0px')
    placeCaret(sv, true)
    flushSourceGutter()
    expect(read('--vmde-sv-row-height')).toBe('22px')
    sv.blur()
    flushSourceGutter()
    expect(read('--vmde-sv-row-height')).toBe('0px')
  })

  it('writes no node, attribute or text inside .vditor and removes the rule when turned off', () => {
    const { root, sv } = mountPane()
    stub(sv)
    const observer = new MutationObserver(vi.fn())
    observer.observe(root, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    })
    setSourcePaneOptions(CURRENT)
    placeCaret(sv, true)
    flushSourceGutter()
    expect(observer.takeRecords()).toHaveLength(0)
    setSourcePaneOptions(OFF)
    expect(document.getElementById('vmde-sv-pane-state')).toBeNull()
    observer.disconnect()
  })
})
