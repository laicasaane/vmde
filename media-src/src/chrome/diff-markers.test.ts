// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import {
  computeBlockMarkers,
  renderPreviewDiffMarkers,
  type BlockBox,
} from './diff-markers'
import type { DiffChange } from './diff-markers'

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
