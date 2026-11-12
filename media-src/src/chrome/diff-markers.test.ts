// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from 'vitest'
import {
  computeBlockMarkers,
  renderDiffMarkers,
  renderPreviewDiffMarkers,
  type BlockBox,
} from './diff-markers'
import type { DiffChange } from './diff-markers'
import {
  provideUnitFeed,
  type UnitFeed,
  type UnitLines,
} from '../util/unit-changes'

// computeBlockMarkers is the pure core of the git gutter: given each top-level
// block's text + geometry, the markdown source, and the diff changes, decide
// which blocks get a bar and of what type. Block→source mapping uses the same
// sample+indexOf trick as the cursor mapping; overlap picks the highest-priority
// change (removed > modified > added).
const md = [
  '# Title',
  '',
  'First paragraph.',
  '',
  'Second paragraph.',
  '',
].join('\n')

function box(text: string, top: number, height = 20): BlockBox {
  return { text, top, height }
}

describe('computeBlockMarkers', () => {
  it('returns no markers when there are no changes', () => {
    const blocks = [box('Title', 0), box('First paragraph.', 40)]
    expect(computeBlockMarkers(blocks, md, [])).toEqual([])
  })

  it('marks the block whose source lines overlap an added change', () => {
    // "Second paragraph." is on source line 4
    const blocks = [
      box('Title', 0),
      box('First paragraph.', 40),
      box('Second paragraph.', 80),
    ]
    const changes: DiffChange[] = [{ startLine: 4, endLine: 5, type: 'added' }]
    const markers = computeBlockMarkers(blocks, md, changes)
    expect(markers).toEqual([{ top: 80, height: 20, type: 'added' }])
  })

  it('marks the first paragraph for a change on its line', () => {
    const blocks = [box('First paragraph.', 40)]
    const changes: DiffChange[] = [{ startLine: 2, endLine: 3, type: 'added' }]
    expect(computeBlockMarkers(blocks, md, changes)).toEqual([
      { top: 40, height: 20, type: 'added' },
    ])
  })

  it('picks the highest-priority type when changes overlap a block', () => {
    const blocks = [box('First paragraph.', 40)]
    const changes: DiffChange[] = [
      { startLine: 2, endLine: 3, type: 'added' },
      { startLine: 2, endLine: 3, type: 'modified' },
    ]
    // modified (2) outranks added (1)
    expect(computeBlockMarkers(blocks, md, changes)[0].type).toBe('modified')
  })

  it('maps a list block whose DOM text concatenates adjacent list items', () => {
    const listMd = [
      'Before paragraph.',
      '',
      '- first item',
      '- second item edited',
      '',
      'After paragraph.',
    ].join('\n')
    const blocks = [box('first itemsecond item edited', 47, 42)]
    const changes: DiffChange[] = [
      { startLine: 3, endLine: 4, type: 'modified' },
    ]

    expect(computeBlockMarkers(blocks, listMd, changes)).toEqual([
      { top: 47, height: 42, type: 'modified' },
    ])
  })

  it('skips empty-text blocks and blocks that map nowhere', () => {
    const blocks = [box('   ', 0), box('not in the source at all', 40)]
    const changes: DiffChange[] = [{ startLine: 0, endLine: 9, type: 'added' }]
    expect(computeBlockMarkers(blocks, md, changes)).toEqual([])
  })
})

// Task 721 — the Git change bars in full Preview live in a layer beside the Preview pane.
describe('renderPreviewDiffMarkers (Task 721)', () => {
  const setup = (display: string) => {
    const scroller = document.createElement('div')
    scroller.className = 'vditor-preview'
    scroller.style.display = display
    const pane = document.createElement('div')
    pane.className = 'vditor-reset'
    pane.innerHTML = '<p>alpha line</p><p>beta line</p><p>gamma line</p>'
    scroller.append(pane)
    document.body.replaceChildren(scroller)
    const rect = (left: number, top: number, height: number) =>
      ({ left, top, height }) as DOMRect
    vi.spyOn(scroller, 'getBoundingClientRect').mockReturnValue(
      rect(0, 100, 600),
    )
    vi.spyOn(pane, 'getBoundingClientRect').mockReturnValue(rect(40, 100, 300))
    Array.from(pane.children).forEach((child, index) => {
      vi.spyOn(child, 'getBoundingClientRect').mockReturnValue(
        rect(40, 110 + index * 30, index === 1 ? 0 : 20),
      )
    })
    const vditor = {
      vditor: {
        currentMode: 'ir',
        preview: { element: scroller, previewElement: pane },
      },
      getValue: () => 'alpha line\n\nbeta line\n\ngamma line\n',
    }
    return { scroller, pane, vditor }
  }

  it('draws bars outside the morph-owned pane, at measured block positions', () => {
    const { scroller, pane, vditor } = setup('block')
    const count = renderPreviewDiffMarkers(vditor, [
      { startLine: 0, endLine: 3, type: 'modified' },
      { startLine: 4, endLine: 5, type: 'added' },
    ])
    // The hidden (zero-height) folded block gets no bar.
    expect(count).toBe(2)
    expect(pane.querySelector('.me-diff-marker')).toBeNull()
    const layer = scroller.querySelector<HTMLElement>(
      ':scope > .me-diff-layer',
    )!
    expect(layer.style.left).toBe('40px')
    const bars = Array.from(layer.children) as HTMLElement[]
    expect(bars.map((bar) => [bar.className, bar.style.top])).toEqual([
      ['me-diff-marker me-diff-marker--modified', '10px'],
      ['me-diff-marker me-diff-marker--added', '70px'],
    ])
  })

  it('removes the layer when Preview is not shown', () => {
    const { scroller, vditor } = setup('block')
    renderPreviewDiffMarkers(vditor, [
      { startLine: 0, endLine: 1, type: 'added' },
    ])
    scroller.style.display = 'none'
    expect(
      renderPreviewDiffMarkers(vditor, [
        { startLine: 0, endLine: 1, type: 'added' },
      ]),
    ).toBe(0)
    expect(scroller.querySelector('.me-diff-layer')).toBeNull()
  })
})

// Task 733 / 006 (Q-28): while the unit feed describes the editor and has confirmed lines, the bars
// come from the units' line ranges and geometry, with no getValue() of the document.
describe('renderDiffMarkers from model lines', () => {
  const RANGES: Array<[number, number]> = [
    [0, 0],
    [2, 4],
    [6, 6],
    [8, 9],
    [11, 11],
  ]
  afterEach(() => {
    provideUnitFeed(window, undefined)
    document.body.replaceChildren()
  })

  function rig(withFeed = true, confirmed = true, confirmResult = true) {
    const editor = document.createElement('div')
    document.body.append(editor)
    const els = RANGES.map((_, i) => {
      const el = document.createElement('p')
      el.textContent = `block ${i}`
      // jsdom has no layout: offsetTop/offsetHeight are 0 and offsetParent is null, so stub them.
      Object.defineProperty(el, 'offsetTop', { value: i * 100 })
      Object.defineProperty(el, 'offsetHeight', { value: 40 + i })
      Object.defineProperty(el, 'offsetParent', {
        value: editor,
        configurable: true,
      })
      editor.append(el)
      return el
    })
    const lines: UnitLines[] = RANGES.map(([startLine, endLine], i) => ({
      el: els[i]!,
      startLine,
      endLine,
    }))
    let ready = confirmed
    const confirmNow = vi.fn(() => {
      ready = confirmResult
      return confirmResult
    })
    const feed: UnitFeed = {
      root: editor,
      isLive: () => true,
      liveUnitOf: () => undefined,
      liveUnits: () => [],
      onUnitsChanged: () => () => undefined,
      confirmNow,
      confirmedLines: () => (ready ? lines : undefined),
    }
    if (withFeed) provideUnitFeed(window, feed)
    const getValue = vi.fn(() => '')
    const vditor = {
      getValue,
      vditor: { currentMode: 'ir', ir: { element: editor } },
    }
    return { editor, els, vditor, getValue, confirmNow, feed }
  }

  const bars = (editor: HTMLElement) =>
    Array.from(editor.querySelectorAll<HTMLElement>('.me-diff-marker'))

  it('marks the unit holding a line and skips a separator line', () => {
    const { editor, vditor, getValue } = rig()
    const n = renderDiffMarkers(vditor, [
      { startLine: 3, endLine: 4, type: 'modified' },
      { startLine: 7, endLine: 8, type: 'added' },
    ])
    expect(n).toBe(1)
    const found = bars(editor)
    expect(found).toHaveLength(1)
    expect(found[0]!.classList.contains('me-diff-marker--modified')).toBe(true)
    expect(found[0]!.style.top).toBe('100px')
    expect(found[0]!.style.height).toBe('41px')
    expect(getValue).not.toHaveBeenCalled()
  })

  it('marks every unit a range overlaps', () => {
    const { editor, vditor } = rig()
    renderDiffMarkers(vditor, [{ startLine: 6, endLine: 9, type: 'added' }])
    expect(bars(editor).map((b) => b.style.top)).toEqual(['200px', '300px'])
  })

  it('keeps the highest-priority type when two changes hit one unit', () => {
    const { editor, vditor } = rig()
    renderDiffMarkers(vditor, [
      { startLine: 2, endLine: 3, type: 'added' },
      { startLine: 4, endLine: 5, type: 'removed' },
    ])
    const found = bars(editor)
    expect(found).toHaveLength(1)
    expect(found[0]!.classList.contains('me-diff-marker--removed')).toBe(true)
  })

  it('takes the existing getValue path without a feed', () => {
    const { vditor, getValue } = rig(false)
    renderDiffMarkers(vditor, [{ startLine: 0, endLine: 1, type: 'added' }])
    expect(getValue).toHaveBeenCalledTimes(1)
  })

  it('confirms once when the lines are not yet confirmed, then re-reads them', () => {
    const { editor, vditor, getValue, confirmNow } = rig(true, false)
    renderDiffMarkers(vditor, [
      { startLine: 3, endLine: 4, type: 'modified' },
      { startLine: 7, endLine: 8, type: 'added' },
    ])
    expect(confirmNow).toHaveBeenCalledTimes(1)
    expect(bars(editor)).toHaveLength(1)
    expect(getValue).not.toHaveBeenCalled()
  })

  const change: DiffChange[] = [{ startLine: 3, endLine: 4, type: 'modified' }]

  it('takes the existing path when the confirm reports false', () => {
    const { vditor, getValue, confirmNow } = rig(true, false, false)
    renderDiffMarkers(vditor, change)
    expect(confirmNow).toHaveBeenCalledTimes(1)
    expect(getValue).toHaveBeenCalledTimes(1)
  })

  it('takes the existing path for a foreign root, a model that is not live, wysiwyg or a throwing feed', () => {
    const foreign = rig()
    provideUnitFeed(window, {
      ...foreign.feed,
      root: document.createElement('div'),
    })
    renderDiffMarkers(foreign.vditor, change)
    expect(foreign.getValue).toHaveBeenCalledTimes(1)

    const idle = rig()
    provideUnitFeed(window, { ...idle.feed, isLive: () => false })
    renderDiffMarkers(idle.vditor, change)
    expect(idle.getValue).toHaveBeenCalledTimes(1)

    const wysiwyg = rig()
    wysiwyg.vditor.vditor.currentMode = 'wysiwyg'
    ;(wysiwyg.vditor.vditor as any).wysiwyg = { element: wysiwyg.editor }
    renderDiffMarkers(wysiwyg.vditor, change)
    expect(wysiwyg.getValue).toHaveBeenCalledTimes(1)
    expect(wysiwyg.confirmNow).not.toHaveBeenCalled()

    const broken = rig()
    provideUnitFeed(window, {
      ...broken.feed,
      confirmedLines: () => {
        throw new Error('feed failure')
      },
    })
    renderDiffMarkers(broken.vditor, change)
    expect(broken.getValue).toHaveBeenCalledTimes(1)
  })

  it('skips a unit whose offsetParent chain does not reach the editor', () => {
    const { editor, els, vditor } = rig()
    Object.defineProperty(els[1], 'offsetParent', { value: null })
    expect(renderDiffMarkers(vditor, change)).toBe(0)
    expect(bars(editor)).toHaveLength(0)
  })

  it('takes the bar height from the last member of a multi-member unit', () => {
    const { editor, els, vditor, feed } = rig()
    const tail = document.createElement('p')
    Object.defineProperty(tail, 'offsetTop', { value: 180 })
    Object.defineProperty(tail, 'offsetHeight', { value: 30 })
    Object.defineProperty(tail, 'offsetParent', { value: editor })
    editor.append(tail)
    provideUnitFeed(window, {
      ...feed,
      liveUnitOf: (node: Node) =>
        node === els[1]
          ? {
              el: els[1],
              members: [els[1], tail],
              kind: 'paragraph',
              top: els[1],
            }
          : undefined,
    } as UnitFeed)
    renderDiffMarkers(vditor, change)
    const [bar] = bars(editor)
    expect(bar?.style.top).toBe('100px')
    expect(bar?.style.height).toBe('110px')
  })
})
