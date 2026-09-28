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

  describe('block IR markers (Task 600)', () => {
    let harness: Harness

    beforeEach(() => {
      vi.stubGlobal(
        'requestAnimationFrame',
        vi.fn(() => 91),
      )
      vi.stubGlobal('cancelAnimationFrame', vi.fn())
      harness = createHarness()
    })

    afterEach(() => harness.dispose())

    function insertBlock(html: string): HTMLElement {
      harness.editor.insertAdjacentHTML('beforeend', html)
      return harness.editor.lastElementChild as HTMLElement
    }

    function insertAtxHeading() {
      const heading = insertBlock(
        '<h1 data-block="0" class="vditor-ir__node" data-marker="#"><span class="vditor-ir__marker vditor-ir__marker--heading" data-type="heading-marker"># </span>Probe</h1>',
      )
      return {
        heading,
        marker: heading.firstChild!.firstChild as Text,
        content: heading.lastChild as Text,
      }
    }

    function keyDown(key: string, ctrlKey = false): void {
      harness.editor.dispatchEvent(
        new KeyboardEvent('keydown', { bubbles: true, key, ctrlKey }),
      )
    }

    function runSelectionFrame(): void {
      document.dispatchEvent(new Event('selectionchange'))
      harness.runFrame()
    }

    it('U1 keeps Ctrl+Home inside ATX content with exactly one selection write', () => {
      const { marker, content } = insertAtxHeading()
      placeCaret(marker, 0)
      keyDown('Home', true)
      const selection = getSelection()!
      const removeAllRanges = vi.spyOn(selection, 'removeAllRanges')
      const addRange = vi.spyOn(selection, 'addRange')

      runSelectionFrame()

      expect(selection.anchorNode).toBe(content)
      expect(selection.anchorOffset).toBe(0)
      expect(selection.anchorNode).not.toBe(harness.editor)
      expect(removeAllRanges).toHaveBeenCalledTimes(1)
      expect(addRange).toHaveBeenCalledTimes(1)
    })

    it('U2 keeps End before a trailing setext marker', () => {
      const heading = insertBlock(
        '<h1 data-block="0" class="vditor-ir__node">Title<span class="vditor-ir__marker vditor-ir__marker--heading" data-render="2">\n===</span></h1>',
      )
      placeCaret(heading.lastChild!.firstChild!, 0)
      keyDown('End')

      runSelectionFrame()

      expect(getSelection()?.anchorNode).toBe(heading.firstChild)
      expect(getSelection()?.anchorOffset).toBe(5)
    })

    it('U3 keeps End before a trailing heading ID', () => {
      const heading = insertBlock(
        '<h2 data-block="0" class="vditor-ir__node" data-marker="##"><span class="vditor-ir__marker vditor-ir__marker--heading">## </span>Title<span class="vditor-ir__marker" data-type="heading-id"> {custom}</span></h2>',
      )
      placeCaret(heading.lastChild!.firstChild!, 2)
      keyDown('End')

      runSelectionFrame()

      expect(getSelection()?.anchorNode).toBe(heading.childNodes[1])
      expect(getSelection()?.anchorOffset).toBe(5)
    })

    it('U4 lands before inline content inside the heading', () => {
      const heading = insertBlock(
        '<h1 data-block="0" class="vditor-ir__node" data-marker="#"><span class="vditor-ir__marker vditor-ir__marker--heading"># </span><strong class="vditor-ir__node"><span class="vditor-ir__marker">**</span>bold<span class="vditor-ir__marker">**</span></strong> tail</h1>',
      )
      placeCaret(heading.firstChild!.firstChild!, 0)

      runSelectionFrame()

      expect(getSelection()?.anchorNode).toBe(heading)
      expect(getSelection()?.anchorOffset).toBe(1)
    })

    it('U5 keeps a quoted heading caret inside its own content', () => {
      const quote = insertBlock(
        '<blockquote data-block="0"><h1 data-block="0" class="vditor-ir__node" data-marker="#"><span class="vditor-ir__marker vditor-ir__marker--heading"># </span>Quoted</h1></blockquote>',
      )
      const heading = quote.firstElementChild!
      placeCaret(heading.firstChild!.firstChild!, 0)

      runSelectionFrame()

      expect(getSelection()?.anchorNode).toBe(heading.lastChild)
      expect(getSelection()?.anchorOffset).toBe(0)
      expect(getSelection()?.anchorNode).not.toBe(quote)
    })

    it('U6 leaves ArrowUp in a fence info string to Vditor without a selection write', () => {
      const block = insertBlock(
        '<div data-block="0" data-type="code-block" class="vditor-ir__node"><span class="vditor-ir__marker">```</span><span class="vditor-ir__marker vditor-ir__marker--info" data-type="code-block-info">\u200bjs</span><pre class="vditor-ir__marker vditor-ir__marker--pre"><code>alpha\nbeta</code></pre></div>',
      )
      const info = block.childNodes[1].firstChild!
      placeCaret(info, 2)
      keyDown('ArrowUp')
      const selection = getSelection()!
      const removeAllRanges = vi.spyOn(selection, 'removeAllRanges')
      const addRange = vi.spyOn(selection, 'addRange')

      runSelectionFrame()

      expect(selection.anchorNode).toBe(info)
      expect(selection.anchorOffset).toBe(2)
      expect(removeAllRanges).not.toHaveBeenCalled()
      expect(addRange).not.toHaveBeenCalled()
    })

    it('U7 lets ArrowLeft walk visible syntax from inside the same heading', () => {
      const { heading, marker, content } = insertAtxHeading()
      placeCaret(content, 0)
      runSelectionFrame()
      expect(heading.classList).toContain('vditor-ir__node--expand')
      keyDown('ArrowLeft')
      placeCaret(marker, 1)
      const selection = getSelection()!
      const removeAllRanges = vi.spyOn(selection, 'removeAllRanges')
      const addRange = vi.spyOn(selection, 'addRange')

      runSelectionFrame()

      expect(selection.anchorNode).toBe(marker)
      expect(selection.anchorOffset).toBe(1)
      expect(removeAllRanges).not.toHaveBeenCalled()
      expect(addRange).not.toHaveBeenCalled()
    })

    it('U8 normalizes Home even when the heading was already expanded', () => {
      const { marker, content } = insertAtxHeading()
      placeCaret(content, 3)
      runSelectionFrame()
      keyDown('Home')
      placeCaret(marker, 0)

      runSelectionFrame()

      expect(getSelection()?.anchorNode).toBe(content)
      expect(getSelection()?.anchorOffset).toBe(0)
    })

    it('U9 normalizes an ArrowDown landing from outside the expanded heading', () => {
      const { heading, marker, content } = insertAtxHeading()
      heading.classList.add('vditor-ir__node--expand')
      placeCaret(harness.before, 2)
      runSelectionFrame()
      keyDown('ArrowDown')
      placeCaret(marker, 0)

      runSelectionFrame()

      expect(getSelection()?.anchorNode).toBe(content)
      expect(getSelection()?.anchorOffset).toBe(0)
    })

    it('U10 normalizes a pointer landing in a hidden heading marker', () => {
      const { marker, content } = insertAtxHeading()
      marker.parentElement!.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true }),
      )
      placeCaret(marker, 1)

      runSelectionFrame()

      expect(getSelection()?.anchorNode).toBe(content)
      expect(getSelection()?.anchorOffset).toBe(0)
    })

    it('U11 preserves a pointer edit in an already visible heading marker', () => {
      const { heading, marker } = insertAtxHeading()
      heading.classList.add('vditor-ir__node--expand')
      marker.parentElement!.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true }),
      )
      placeCaret(marker, 1)
      const selection = getSelection()!
      const removeAllRanges = vi.spyOn(selection, 'removeAllRanges')
      const addRange = vi.spyOn(selection, 'addRange')

      runSelectionFrame()

      expect(selection.anchorNode).toBe(marker)
      expect(selection.anchorOffset).toBe(1)
      expect(removeAllRanges).not.toHaveBeenCalled()
      expect(addRange).not.toHaveBeenCalled()
    })

    it('U12 keeps Home inside an empty heading after its marker', () => {
      const heading = insertBlock(
        '<h1 data-block="0" class="vditor-ir__node" data-marker="#"><span class="vditor-ir__marker vditor-ir__marker--heading"># </span></h1>',
      )
      placeCaret(heading.firstChild!.firstChild!, 0)
      keyDown('Home')

      runSelectionFrame()

      expect(getSelection()?.anchorNode).toBe(heading)
      expect(getSelection()?.anchorOffset).toBe(1)
    })

    it('U13 avoids editor-wide queries during block-marker normalization', () => {
      const { marker } = insertAtxHeading()
      placeCaret(marker, 0)
      keyDown('Home', true)
      const query = vi.spyOn(harness.editor, 'querySelectorAll')

      runSelectionFrame()

      expect(query).not.toHaveBeenCalled()
    })
  })
})
