// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  requestCaret,
  resetCaretAuthorityForTests,
  setCaretPaintabilityProbeForTests,
} from './caret'
import { installIrMarkerReveal } from './editor-caret'

interface Harness {
  editor: HTMLElement
  before: Text
  after: Text
  strong: HTMLElement
  strongText: Text
  strongMarker: Text
  link: HTMLElement
  linkText: Text
  code: HTMLElement
  codeText: Text
  listText: Text
  tableText: Text
  runFrame(): void
  runDwell(): void
  hasFrame(): boolean
  hasDwell(): boolean
  setComposition(active: boolean): void
  dispose(): void
}

function placeCaret(node: Node, offset: number): void {
  const range = document.createRange()
  range.setStart(node, offset)
  range.collapse(true)
  const selection = getSelection()!
  selection.removeAllRanges()
  selection.addRange(range)
}

function placeRange(
  start: Node,
  startOffset: number,
  end: Node,
  endOffset: number,
): void {
  const range = document.createRange()
  range.setStart(start, startOffset)
  range.setEnd(end, endOffset)
  const selection = getSelection()!
  selection.removeAllRanges()
  selection.addRange(range)
}

function makeInline(
  tag: 'strong' | 'a' | 'code',
  text: string,
): { node: HTMLElement; content: Text; marker: Text } {
  const node = document.createElement(tag)
  node.className = 'vditor-ir__node'
  node.dataset.type = tag
  const opening = document.createElement('span')
  opening.className = 'vditor-ir__marker'
  opening.textContent = tag === 'code' ? '`' : tag === 'a' ? '[' : '**'
  const content = document.createTextNode(text)
  const closing = document.createElement('span')
  closing.className = 'vditor-ir__marker'
  closing.textContent = tag === 'code' ? '`' : tag === 'a' ? '](url)' : '**'
  node.append(opening, content, closing)
  return { node, content, marker: opening.firstChild as Text }
}

function createHarness(): Harness {
  const editor = document.createElement('div')
  editor.className = 'vditor-ir vditor-reset'
  const block = document.createElement('p')
  block.dataset.block = '0'
  const before = document.createTextNode('before')
  const after = document.createTextNode('after')
  const strong = makeInline('strong', 'bold')
  const link = makeInline('a', 'link')
  const code = makeInline('code', 'code')
  block.append(
    before,
    strong.node,
    after,
    link.node,
    document.createTextNode('middle'),
    code.node,
  )
  const list = document.createElement('ul')
  const item = document.createElement('li')
  const listText = document.createTextNode('list prose')
  item.append(listText)
  list.append(item)
  const table = document.createElement('table')
  const cell = document.createElement('td')
  const tableText = document.createTextNode('table prose')
  cell.append(tableText)
  table.append(cell)
  editor.append(block, list, table)
  document.body.append(editor)

  let frameCallback: FrameRequestCallback | undefined
  let dwellCallback: (() => void) | undefined
  let compositionActive = false
  let compositionListener: ((active: boolean) => void) | undefined
  const inner = { currentMode: 'ir', ir: { element: editor } }
  ;(window as unknown as { vditor: unknown }).vditor = { vditor: inner }
  const dispose = installIrMarkerReveal({
    document,
    getVditor: () => inner,
    requestFrame: (callback) => {
      frameCallback = callback
      return 1
    },
    cancelFrame: () => {
      frameCallback = undefined
    },
    setDwell: (callback) => {
      dwellCallback = callback
      return 1
    },
    clearDwell: () => {
      dwellCallback = undefined
    },
    compositionActive: () => compositionActive,
    subscribeComposition: (listener) => {
      compositionListener = listener
      return () => {
        compositionListener = undefined
      }
    },
  })

  return {
    editor,
    before,
    after,
    strong: strong.node,
    strongText: strong.content,
    strongMarker: strong.marker,
    link: link.node,
    linkText: link.content,
    code: code.node,
    codeText: code.content,
    listText,
    tableText,
    runFrame() {
      const callback = frameCallback
      frameCallback = undefined
      if (!callback) throw new Error('no marker frame scheduled')
      callback(0)
    },
    runDwell() {
      const callback = dwellCallback
      dwellCallback = undefined
      if (!callback) throw new Error('no marker dwell scheduled')
      callback()
    },
    hasFrame: () => Boolean(frameCallback),
    hasDwell: () => Boolean(dwellCallback),
    setComposition(active) {
      compositionActive = active
      compositionListener?.(active)
    },
    dispose,
  }
}

describe('IR marker reveal controller', () => {
  beforeEach(() => {
    document.body.replaceChildren()
  })

  afterEach(() => {
    ;(window as unknown as { vditor?: unknown }).vditor = undefined
    resetCaretAuthorityForTests()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it.each([
    ['inside strong', (h: Harness) => [h.strongText, 2] as const, 'strong'],
    [
      'before strong',
      (h: Harness) => [h.before, h.before.data.length] as const,
      'strong',
    ],
    ['after strong', (h: Harness) => [h.after, 0] as const, 'strong'],
    ['inside link', (h: Harness) => [h.linkText, 2] as const, 'a'],
    ['inside code', (h: Harness) => [h.codeText, 2] as const, 'code'],
  ])(
    'resolves %s without an editor-wide expanded-node query',
    (_, position, type) => {
      const harness = createHarness()
      const [node, offset] = position(harness)
      placeCaret(node, offset)
      const query = vi.spyOn(harness.editor, 'querySelectorAll')
      document.dispatchEvent(new Event('selectionchange'))

      harness.runFrame()

      expect(query).not.toHaveBeenCalled()
      expect(
        harness.editor.querySelector<HTMLElement>(`[data-type="${type}"]`)
          ?.classList,
      ).toContain('vditor-ir__node--expand')
      harness.dispose()
    },
  )

  it('does not rewrite the selection for Backspace inside an already visible marker', () => {
    const harness = createHarness()
    harness.strong.classList.add('vditor-ir__node--expand')
    placeCaret(harness.strongMarker, 1)
    const selection = getSelection()!
    const removeAllRanges = vi.spyOn(selection, 'removeAllRanges')
    const addRange = vi.spyOn(selection, 'addRange')
    harness.editor.dispatchEvent(
      new InputEvent('beforeinput', {
        bubbles: true,
        inputType: 'deleteContentBackward',
      }),
    )
    document.dispatchEvent(new Event('selectionchange'))

    harness.runFrame()

    expect(removeAllRanges).not.toHaveBeenCalled()
    expect(addRange).not.toHaveBeenCalled()
    expect(getSelection()?.anchorNode).toBe(harness.strongMarker)
    expect(getSelection()?.anchorOffset).toBe(1)
    harness.dispose()
  })

  it.each([
    ['plain prose', (h: Harness) => h.after],
    ['list prose', (h: Harness) => h.listText],
    ['table prose', (h: Harness) => h.tableText],
  ])(
    'does not scan or rewrite the selection for Backspace in %s',
    (_, target) => {
      const harness = createHarness()
      const text = target(harness)
      placeCaret(text, text.data.length)
      const selection = getSelection()!
      const removeAllRanges = vi.spyOn(selection, 'removeAllRanges')
      const addRange = vi.spyOn(selection, 'addRange')
      const query = vi.spyOn(harness.editor, 'querySelectorAll')
      harness.editor.dispatchEvent(
        new InputEvent('beforeinput', {
          bubbles: true,
          inputType: 'deleteContentBackward',
        }),
      )
      document.dispatchEvent(new Event('selectionchange'))

      harness.runFrame()

      expect(query).not.toHaveBeenCalled()
      expect(removeAllRanges).not.toHaveBeenCalled()
      expect(addRange).not.toHaveBeenCalled()
      harness.dispose()
    },
  )

  it('keeps the previous local node visible until cross-node dwell expires', () => {
    const harness = createHarness()
    placeCaret(harness.strongText, 2)
    document.dispatchEvent(new Event('selectionchange'))
    harness.runFrame()

    placeCaret(harness.linkText, 2)
    document.dispatchEvent(new Event('selectionchange'))
    harness.runFrame()

    expect(harness.strong.classList).toContain('vditor-ir__node--expand')
    expect(harness.link.classList).toContain('vditor-ir__node--expand')
    harness.runDwell()
    expect(harness.strong.classList).not.toContain('vditor-ir__node--expand')
    expect(harness.link.classList).toContain('vditor-ir__node--expand')
    harness.dispose()
  })

  it('collapses the prior local node after a cross-node selection settles', () => {
    const harness = createHarness()
    placeCaret(harness.strongText, 2)
    document.dispatchEvent(new Event('selectionchange'))
    harness.runFrame()

    placeRange(harness.strongText, 1, harness.linkText, 2)
    document.dispatchEvent(new Event('selectionchange'))
    harness.runFrame()

    expect(harness.strong.classList).toContain('vditor-ir__node--expand')
    harness.runDwell()
    expect(harness.strong.classList).not.toContain('vditor-ir__node--expand')
    expect(harness.link.classList).not.toContain('vditor-ir__node--expand')
    harness.dispose()
  })

  it('drops detached prior nodes and expands the rebuilt local target', () => {
    const harness = createHarness()
    placeCaret(harness.strongText, 2)
    document.dispatchEvent(new Event('selectionchange'))
    harness.runFrame()
    harness.strong.remove()

    placeCaret(harness.linkText, 2)
    document.dispatchEvent(new Event('selectionchange'))
    harness.runFrame()

    expect(harness.strong.isConnected).toBe(false)
    expect(harness.link.classList).toContain('vditor-ir__node--expand')
    harness.runDwell()
    expect(harness.link.classList).toContain('vditor-ir__node--expand')
    harness.dispose()
  })

  it('keeps the caret inside an empty expanded Link URL marker', () => {
    const harness = createHarness()
    const url = document.createElement('span')
    url.className = 'vditor-ir__marker vditor-ir__marker--link'
    harness.link.insertBefore(url, harness.link.lastChild)
    harness.link.classList.add('vditor-ir__node--expand')
    placeCaret(url, 0)
    document.dispatchEvent(new Event('selectionchange'))

    harness.runFrame()

    expect(getSelection()?.anchorNode).toBe(url)
    expect(getSelection()?.anchorOffset).toBe(0)
    harness.dispose()
  })

  it('normalizes one hidden-marker navigation landing through the caret authority', () => {
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn(() => 91),
    )
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    const harness = createHarness()
    placeCaret(harness.strongMarker, 1)
    const selection = getSelection()!
    const removeAllRanges = vi.spyOn(selection, 'removeAllRanges')
    const addRange = vi.spyOn(selection, 'addRange')
    document.dispatchEvent(
      new KeyboardEvent('keydown', { bubbles: true, key: 'Home' }),
    )
    document.dispatchEvent(new Event('selectionchange'))

    harness.runFrame()

    expect(removeAllRanges).toHaveBeenCalledTimes(1)
    expect(addRange).toHaveBeenCalledTimes(1)
    expect(getSelection()?.anchorNode).toBe(harness.strong.parentNode)
    expect(getSelection()?.anchorOffset).toBe(1)
    harness.dispose()
  })

  it('keeps a pointer edit inside a marker that was already visible', () => {
    const harness = createHarness()
    harness.strong.classList.add('vditor-ir__node--expand')
    placeCaret(harness.strongMarker, 1)
    const selection = getSelection()!
    const removeAllRanges = vi.spyOn(selection, 'removeAllRanges')
    const addRange = vi.spyOn(selection, 'addRange')
    harness.strongMarker.parentElement?.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true }),
    )
    document.dispatchEvent(new Event('selectionchange'))

    harness.runFrame()

    expect(removeAllRanges).not.toHaveBeenCalled()
    expect(addRange).not.toHaveBeenCalled()
    expect(getSelection()?.anchorNode).toBe(harness.strongMarker)
    harness.dispose()
  })

  it('does not normalize arrow navigation out of an editable fenced-code source', () => {
    const harness = createHarness()
    const block = document.createElement('div')
    block.className = 'vditor-ir__node vditor-ir__node--expand'
    block.dataset.block = '0'
    block.dataset.type = 'code-block'
    const source = document.createElement('pre')
    source.className = 'vditor-ir__marker vditor-ir__marker--pre'
    const code = document.createElement('code')
    const text = document.createTextNode('alpha\nbeta\ngamma')
    code.append(text)
    source.append(code)
    block.append(source)
    harness.editor.append(block)
    placeCaret(text, 8)
    document.dispatchEvent(
      new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowRight' }),
    )
    document.dispatchEvent(new Event('selectionchange'))

    harness.runFrame()

    expect(getSelection()?.anchorNode).toBe(text)
    expect(getSelection()?.anchorOffset).toBe(8)
    harness.dispose()
  })

  it('keeps an authoritative restore inside a rebuilt visible marker', () => {
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn(() => 91),
    )
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    setCaretPaintabilityProbeForTests(() => true)
    const harness = createHarness()
    harness.strong.classList.add('vditor-ir__node--expand')
    requestCaret({ node: harness.strongMarker, offset: 1 })
    document.dispatchEvent(new Event('selectionchange'))

    harness.runFrame()

    expect(getSelection()?.anchorNode).toBe(harness.strongMarker)
    expect(getSelection()?.anchorOffset).toBe(1)
    harness.dispose()
  })

  it('defers marker reconciliation until composition ends', () => {
    const harness = createHarness()
    harness.setComposition(true)
    placeCaret(harness.codeText, 2)
    document.dispatchEvent(new Event('selectionchange'))
    harness.runFrame()
    expect(harness.code.classList).not.toContain('vditor-ir__node--expand')

    harness.setComposition(false)
    expect(harness.hasFrame()).toBe(true)
    harness.runFrame()
    expect(harness.code.classList).toContain('vditor-ir__node--expand')
    harness.dispose()
  })

  it('disposal cancels pending frame and dwell work and removes input listeners', () => {
    const harness = createHarness()
    const remove = vi.spyOn(document, 'removeEventListener')
    placeCaret(harness.strongText, 2)
    document.dispatchEvent(new Event('selectionchange'))
    expect(harness.hasFrame()).toBe(true)
    harness.runFrame()
    expect(harness.hasDwell()).toBe(true)

    harness.dispose()

    expect(harness.hasFrame()).toBe(false)
    expect(harness.hasDwell()).toBe(false)
    expect(remove).toHaveBeenCalledWith(
      'beforeinput',
      expect.any(Function),
      true,
    )
    document.dispatchEvent(new Event('selectionchange'))
    expect(harness.hasFrame()).toBe(false)
  })
})
