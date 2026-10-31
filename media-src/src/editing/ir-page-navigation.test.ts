// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import {
  installIrPageNavigation,
  isStalledPress,
  isUsableHit,
  landingOutsideInlineNode,
  type PageGeometry,
  planPagePress,
  alignScrollTop,
} from './ir-page-navigation'

// Task 612 — the geometry of the stalled-press repair. jsdom has no layout engine, so the DOM side
// (hit test, scroll, caret write) is covered by the Chromium and real-VS-Code specs.

const geometry = (overrides: Partial<PageGeometry> = {}): PageGeometry => ({
  caretY: 1200,
  lineHeight: 21,
  clientHeight: 400,
  scrollHeight: 3000,
  scrollTop: 1000,
  firstLineY: 10,
  lastLineY: 2900,
  ...overrides,
})

describe('planPagePress', () => {
  it('moves about 87.5% of the viewport and scrolls only as far as the landing needs', () => {
    const up = planPagePress('up', geometry())
    expect(up.expectedTravel).toBe(350)
    expect(up.targetY).toBe(1200 - 350 + 21)
    // landing line top 850, one line of margin above it
    expect(up.scrollTop).toBe(850 - 21)
    const down = planPagePress('down', geometry())
    expect(down.targetY).toBe(1200 + 350)
    // landing line bottom 1571, one line of margin below it
    expect(down.scrollTop).toBe(1550 + 21 + 21 - 400)
  })

  it('leaves the scroll offset alone when the landing line is already in view', () => {
    // The caret is on the bottom row of the view; one page up lands near the top of the same view.
    const plan = planPagePress(
      'up',
      geometry({ caretY: 1380, scrollTop: 1000 }),
    )
    expect(plan.scrollTop).toBe(1000)
    const down = planPagePress(
      'down',
      geometry({ caretY: 1030, scrollTop: 1000 }),
    )
    expect(down.scrollTop).toBe(1000 + (1380 + 21 + 21 - 1400))
  })

  it('clamps the scroll offset and the target line to the document', () => {
    const top = planPagePress('up', geometry({ caretY: 100, scrollTop: 50 }))
    expect(top.scrollTop).toBe(0)
    expect(top.targetY).toBe(10 + 21)
    expect(top.expectedTravel).toBe(90)
    const bottom = planPagePress(
      'down',
      geometry({ caretY: 2800, scrollTop: 2300, scrollHeight: 2940 }),
    )
    expect(bottom.scrollTop).toBe(2540)
    expect(bottom.targetY).toBe(2900)
    expect(bottom.expectedTravel).toBe(100)
  })

  it('reports the document edge when fewer than two lines remain', () => {
    expect(planPagePress('up', geometry({ caretY: 40 })).atEdge).toBe(true)
    expect(planPagePress('down', geometry({ caretY: 2870 })).atEdge).toBe(true)
    expect(planPagePress('up', geometry()).atEdge).toBe(false)
  })

  it('never steps less than one line in a tiny viewport', () => {
    const plan = planPagePress('down', geometry({ clientHeight: 10 }))
    expect(plan.expectedTravel).toBe(21)
  })
})

describe('isStalledPress', () => {
  const plan = { expectedTravel: 350, atEdge: false }
  it('flags a press that barely moved', () => {
    expect(isStalledPress(plan, 0)).toBe(true)
    expect(isStalledPress(plan, 37)).toBe(true)
    expect(isStalledPress(plan, 260)).toBe(true)
  })
  it('accepts a native press', () => {
    expect(isStalledPress(plan, 263)).toBe(false)
    expect(isStalledPress(plan, 350)).toBe(false)
  })
  it('never flags a press at the document edge', () => {
    expect(isStalledPress({ expectedTravel: 40, atEdge: true }, 0)).toBe(false)
  })
})

describe('installIrPageNavigation', () => {
  const irVditor = (surface: HTMLElement) =>
    ({ currentMode: 'ir', ir: { element: surface } }) as never

  const press = (
    target: EventTarget = document,
    init: KeyboardEventInit = {},
  ) =>
    target.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'PageUp', bubbles: true, ...init }),
    )

  it('acts only in IR on a trusted page key, and stops after removal', () => {
    const surface = document.createElement('div')
    document.body.append(surface)
    const frames: FrameRequestCallback[] = []
    let mode: 'ir' | 'wysiwyg' = 'wysiwyg'
    const trusted = vi.fn(() => true)
    const dispose = installIrPageNavigation({
      getVditor: () =>
        mode === 'ir'
          ? irVditor(surface)
          : ({ currentMode: 'wysiwyg' } as never),
      requestFrame: (callback) => frames.push(callback),
      isTrustedKey: trusted,
    })
    // Not IR: the mode guard stops the press before it reads the selection.
    press(surface)
    expect(trusted).toHaveBeenCalledTimes(1)
    expect(frames).toHaveLength(0)
    // IR but jsdom has no selection inside the editor: still nothing is scheduled.
    mode = 'ir'
    press(surface)
    expect(frames).toHaveLength(0)
    // Other keys never reach the trust check.
    press(surface, { key: 'a' })
    expect(trusted).toHaveBeenCalledTimes(2)
    dispose()
    press(surface)
    expect(trusted).toHaveBeenCalledTimes(2)
    surface.remove()
  })

  it('ignores untrusted, composing and chorded page keys', () => {
    const surface = document.createElement('div')
    document.body.append(surface)
    const getVditor = vi.fn(() => irVditor(surface))
    const dispose = installIrPageNavigation({
      getVditor,
      requestFrame: () => 1,
      isTrustedKey: () => false,
    })
    press(surface)
    expect(getVditor).not.toHaveBeenCalled()
    dispose()
    const trustedGetVditor = vi.fn(() => irVditor(surface))
    const disposeTrusted = installIrPageNavigation({
      getVditor: trustedGetVditor,
      requestFrame: () => 1,
      isTrustedKey: () => true,
    })
    press(surface, { ctrlKey: true })
    press(surface, { altKey: true })
    press(surface, { metaKey: true })
    press(surface, { isComposing: true })
    expect(trustedGetVditor).not.toHaveBeenCalled()
    disposeTrusted()
    surface.remove()
  })
})

describe('landingOutsideInlineNode', () => {
  const block = (html: string) => {
    const host = document.createElement('div')
    host.innerHTML = `<p data-block="0">${html}</p>`
    return host.firstElementChild as HTMLElement
  }
  const strong =
    '<span class="vditor-ir__node" data-type="strong"><span class="vditor-ir__marker">**</span><strong>bold</strong><span class="vditor-ir__marker">**</span></span>'

  it('moves an end-of-content landing to just after the node', () => {
    const p = block(strong)
    const text = p.querySelector('strong')?.firstChild as Text
    expect(landingOutsideInlineNode(text, 4)).toEqual({ node: p, offset: 1 })
  })

  it('moves a start-of-content landing to just before the node', () => {
    const p = block(`lead ${strong}`)
    const text = p.querySelector('strong')?.firstChild as Text
    expect(landingOutsideInlineNode(text, 0)).toEqual({ node: p, offset: 1 })
  })

  it('leaves landings inside the content, in plain text and next to other content alone', () => {
    const p = block(`lead ${strong} tail`)
    const text = p.querySelector('strong')?.firstChild as Text
    expect(landingOutsideInlineNode(text, 2)).toBeNull()
    expect(landingOutsideInlineNode(p.firstChild as Text, 5)).toBeNull()
    const inner = block(
      '<span class="vditor-ir__node" data-type="strong"><span class="vditor-ir__marker">**</span><strong>a<em>b</em></strong><span class="vditor-ir__marker">**</span></span>',
    )
    const a = inner.querySelector('strong')?.firstChild as Text
    expect(landingOutsideInlineNode(a, 1)).toBeNull()
  })

  it('climbs to the outermost node when nodes nest', () => {
    const p = block(
      '<span class="vditor-ir__node" data-type="strong"><span class="vditor-ir__marker">**</span><strong><span class="vditor-ir__node" data-type="code"><span class="vditor-ir__marker">`</span><code>co</code><span class="vditor-ir__marker">`</span></span></strong><span class="vditor-ir__marker">**</span></span>',
    )
    const text = p.querySelector('code')?.firstChild as Text
    expect(landingOutsideInlineNode(text, 2)).toEqual({ node: p, offset: 1 })
  })
})

describe('isUsableHit', () => {
  const surface = document.createElement('div')
  surface.innerHTML = '<p data-block="0">text</p>'
  document.body.append(surface)
  const hit = (node: Node, offset: number) => {
    const range = document.createRange()
    range.setStart(node, offset)
    range.collapse(true)
    return range
  }

  it('accepts a position inside a block', () => {
    const text = surface.querySelector('p')?.firstChild as Text
    expect(isUsableHit(surface, hit(text, 2))).toBe(true)
    expect(isUsableHit(surface, hit(surface.firstChild as Node, 0))).toBe(true)
  })

  it('rejects a hit on the editor root, which no marker normalization would repair', () => {
    expect(isUsableHit(surface, hit(surface, 0))).toBe(false)
    expect(isUsableHit(surface, hit(surface, 1))).toBe(false)
  })

  it('rejects a hit outside the editor', () => {
    const outside = document.createElement('p')
    outside.textContent = 'elsewhere'
    document.body.append(outside)
    expect(isUsableHit(surface, hit(outside.firstChild as Node, 1))).toBe(false)
    outside.remove()
  })
})

describe('alignScrollTop', () => {
  it('aligns the landing line with the top of the view', () => {
    expect(alignScrollTop(1100, 400, 3000)).toBe(1100)
    expect(alignScrollTop(700, 400, 3000)).toBe(700)
  })

  it('stays inside the scrollable range', () => {
    expect(alignScrollTop(-50, 400, 3000)).toBe(0)
    expect(alignScrollTop(2990, 400, 3000)).toBe(2600)
  })
})
