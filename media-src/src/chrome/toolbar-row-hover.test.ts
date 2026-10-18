// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  installToolbarRowHover,
  placeRowHover,
  ROW_HOVER_CLASS,
  ROW_HOVER_DELAY_MS,
  ROW_HOVER_GAP_PX,
  ROW_TIP_ATTRIBUTE,
} from './toolbar-row-hover'

const rect = (left: number, top: number, width: number, height: number) => ({
  left,
  top,
  width,
  height,
  right: left + width,
  bottom: top + height,
  x: left,
  y: top,
  toJSON: () => ({}),
})

function stubRect(el: Element, box: ReturnType<typeof rect>) {
  Object.defineProperty(el, 'getBoundingClientRect', {
    value: () => box,
    configurable: true,
  })
}

function build() {
  document.body.innerHTML =
    '<div class="vditor-toolbar">' +
    '<div class="vditor-toolbar__item"><button data-type="more">More</button>' +
    '<div class="vditor-hint" style="display:block">' +
    `<div><button id="r1" data-type="settings" ${ROW_TIP_ATTRIBUTE}="Open the settings" aria-description="Open the settings"><span id="r1-label">Settings</span></button></div>` +
    `<div><button id="r2" data-type="about" ${ROW_TIP_ATTRIBUTE}="About this editor" aria-description="About this editor">About</button></div>` +
    '<div><button id="plain" data-type="plain">No tip</button></div>' +
    '</div></div></div>'
  const toolbar = document.querySelector<HTMLElement>('.vditor-toolbar')!
  const panel = toolbar.querySelector<HTMLElement>('.vditor-hint')!
  const r1 = document.getElementById('r1')!
  const r2 = document.getElementById('r2')!
  stubRect(panel, rect(600, 40, 200, 120))
  stubRect(r1, rect(600, 60, 200, 30))
  stubRect(r2, rect(600, 90, 200, 30))
  return { toolbar, panel, r1, r2 }
}

const hover = () =>
  document.querySelector<HTMLElement>(`body > .${ROW_HOVER_CLASS}`)

/** Size the hover box (jsdom has no layout) after the module created it. */
const sizeHover = (width: number, height: number) =>
  stubRect(hover()!, rect(0, 0, width, height))

const fire = (el: Element, type: string, init: MouseEventInit = {}) =>
  el.dispatchEvent(new MouseEvent(type, { bubbles: true, ...init }))

describe('placeRowHover', () => {
  const viewport = { width: 1000, height: 700 }
  const size = { width: 120, height: 26 }

  it('opens to the right of the menu, vertically centred on the row', () => {
    expect(
      placeRowHover(
        rect(100, 60, 200, 30),
        rect(100, 40, 200, 120),
        size,
        viewport,
      ),
    ).toEqual({ left: 300 + ROW_HOVER_GAP_PX, top: 62 })
  })

  it('opens to the left of the menu when the right side has no room', () => {
    expect(
      placeRowHover(
        rect(780, 60, 200, 30),
        rect(780, 40, 200, 120),
        size,
        viewport,
      ),
    ).toEqual({ left: 780 - ROW_HOVER_GAP_PX - 120, top: 62 })
  })

  it('clamps inside the viewport when neither side has room', () => {
    const narrow = { width: 150, height: 700 }
    const placed = placeRowHover(
      rect(10, 60, 130, 30),
      rect(10, 40, 130, 120),
      size,
      narrow,
    )
    expect(placed.left).toBeGreaterThanOrEqual(0)
    expect(placed.left + size.width).toBeLessThanOrEqual(narrow.width)
  })

  it('clamps the top and bottom edges', () => {
    const top = placeRowHover(
      rect(100, 0, 200, 10),
      rect(100, 0, 200, 100),
      size,
      viewport,
    )
    expect(top.top).toBe(0)
    const bottom = placeRowHover(
      rect(100, 690, 200, 10),
      rect(100, 600, 200, 100),
      size,
      viewport,
    )
    expect(bottom.top).toBe(viewport.height - size.height)
  })
})

describe('installToolbarRowHover', () => {
  let dispose: () => void
  beforeEach(() => {
    vi.useFakeTimers()
    Object.defineProperty(window, 'innerWidth', {
      value: 1000,
      configurable: true,
    })
    Object.defineProperty(window, 'innerHeight', {
      value: 700,
      configurable: true,
    })
  })
  afterEach(() => {
    dispose?.()
    vi.useRealTimers()
    document.body.innerHTML = ''
  })

  it('appends one hidden role=tooltip box to the body and keeps the 500 ms delay a constant', () => {
    const { toolbar } = build()
    dispose = installToolbarRowHover(toolbar)
    expect(ROW_HOVER_DELAY_MS).toBe(500)
    const boxes = document.querySelectorAll(`body > .${ROW_HOVER_CLASS}`)
    expect(boxes).toHaveLength(1)
    expect(boxes[0].getAttribute('role')).toBe('tooltip')
    expect(boxes[0].hasAttribute('hidden')).toBe(true)
  })

  it('shows the row description beside the menu after the delay, not before', () => {
    const { toolbar, r1 } = build()
    dispose = installToolbarRowHover(toolbar)
    sizeHover(120, 26)
    fire(r1, 'mouseover')
    vi.advanceTimersByTime(ROW_HOVER_DELAY_MS - 1)
    expect(hover()!.hasAttribute('hidden')).toBe(true)
    vi.advanceTimersByTime(1)
    expect(hover()!.hasAttribute('hidden')).toBe(false)
    expect(hover()!.textContent).toBe('Open the settings')
    // The 600..800 menu leaves room on its right in a 1000 px viewport.
    expect(hover()!.style.left).toBe(`${800 + ROW_HOVER_GAP_PX}px`)
    expect(hover()!.style.top).toBe('62px')
  })

  it('flips to the left when the menu is at the right edge', () => {
    const { toolbar, r1, panel } = build()
    stubRect(panel, rect(850, 40, 140, 120))
    stubRect(r1, rect(850, 60, 140, 30))
    dispose = installToolbarRowHover(toolbar)
    sizeHover(120, 26)
    fire(r1, 'mouseover')
    vi.advanceTimersByTime(ROW_HOVER_DELAY_MS)
    expect(hover()!.style.left).toBe(`${850 - ROW_HOVER_GAP_PX - 120}px`)
  })

  it('adds no aria-describedby and keeps aria-description', () => {
    const { toolbar, r1 } = build()
    dispose = installToolbarRowHover(toolbar)
    fire(r1, 'mouseover')
    vi.advanceTimersByTime(ROW_HOVER_DELAY_MS)
    expect(r1.hasAttribute('aria-describedby')).toBe(false)
    expect(r1.getAttribute('aria-description')).toBe('Open the settings')
  })

  it('ignores a row without a description', () => {
    const { toolbar } = build()
    dispose = installToolbarRowHover(toolbar)
    fire(document.getElementById('plain')!, 'mouseover')
    vi.advanceTimersByTime(ROW_HOVER_DELAY_MS * 2)
    expect(hover()!.hasAttribute('hidden')).toBe(true)
  })

  it('hides on pointer leave and cancels a pending show', () => {
    const { toolbar, r1 } = build()
    dispose = installToolbarRowHover(toolbar)
    fire(r1, 'mouseover')
    vi.advanceTimersByTime(ROW_HOVER_DELAY_MS - 100)
    fire(r1, 'mouseout', { relatedTarget: document.body })
    vi.advanceTimersByTime(1000)
    expect(hover()!.hasAttribute('hidden')).toBe(true)

    fire(r1, 'mouseover')
    vi.advanceTimersByTime(ROW_HOVER_DELAY_MS)
    expect(hover()!.hasAttribute('hidden')).toBe(false)
    fire(r1, 'mouseout', { relatedTarget: document.body })
    expect(hover()!.hasAttribute('hidden')).toBe(true)
  })

  it('keeps the box when the pointer only moves between children of the same row', () => {
    const { toolbar, r1 } = build()
    dispose = installToolbarRowHover(toolbar)
    fire(r1, 'mouseover')
    vi.advanceTimersByTime(ROW_HOVER_DELAY_MS)
    const label = document.getElementById('r1-label')!
    fire(r1, 'mouseout', { relatedTarget: label })
    fire(label, 'mouseover')
    expect(hover()!.hasAttribute('hidden')).toBe(false)
  })

  it('moves to the next row with a new delay', () => {
    const { toolbar, r1, r2 } = build()
    dispose = installToolbarRowHover(toolbar)
    fire(r1, 'mouseover')
    vi.advanceTimersByTime(ROW_HOVER_DELAY_MS)
    fire(r1, 'mouseout', { relatedTarget: r2 })
    fire(r2, 'mouseover')
    expect(hover()!.hasAttribute('hidden')).toBe(true)
    vi.advanceTimersByTime(ROW_HOVER_DELAY_MS)
    expect(hover()!.textContent).toBe('About this editor')
  })

  it('shows at once when a row gains keyboard focus and hides when it loses it', () => {
    const { toolbar, r2 } = build()
    dispose = installToolbarRowHover(toolbar)
    r2.focus()
    expect(hover()!.hasAttribute('hidden')).toBe(false)
    expect(hover()!.textContent).toBe('About this editor')
    r2.blur()
    expect(hover()!.hasAttribute('hidden')).toBe(true)
  })

  it('does not show for focus that follows a pointer press', () => {
    const { toolbar, r2 } = build()
    dispose = installToolbarRowHover(toolbar)
    fire(r2, 'mousedown')
    r2.focus()
    expect(hover()!.hasAttribute('hidden')).toBe(true)
  })

  it.each([
    [
      'Escape',
      () =>
        document.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
        ),
    ],
    ['click', (el: Element) => fire(el, 'click')],
    ['scroll', () => window.dispatchEvent(new Event('scroll'))],
  ])('hides on %s', (_name, act) => {
    const { toolbar, r1 } = build()
    dispose = installToolbarRowHover(toolbar)
    r1.focus()
    expect(hover()!.hasAttribute('hidden')).toBe(false)
    act(r1)
    expect(hover()!.hasAttribute('hidden')).toBe(true)
  })

  it('hides when the menu closes, even while the pointer stays on the row', async () => {
    const { toolbar, r1, panel } = build()
    dispose = installToolbarRowHover(toolbar)
    fire(r1, 'mouseover')
    vi.advanceTimersByTime(ROW_HOVER_DELAY_MS)
    expect(hover()!.hasAttribute('hidden')).toBe(false)
    panel.style.display = 'none'
    await Promise.resolve()
    expect(hover()!.hasAttribute('hidden')).toBe(true)
  })

  it('does not show a pending tip for a menu that closed during the delay', () => {
    const { toolbar, r1, panel } = build()
    dispose = installToolbarRowHover(toolbar)
    fire(r1, 'mouseover')
    vi.advanceTimersByTime(ROW_HOVER_DELAY_MS - 1)
    panel.style.display = 'none'
    vi.advanceTimersByTime(1)
    expect(hover()!.hasAttribute('hidden')).toBe(true)
  })

  it('hides when the row loses its description (the control returned to the toolbar row)', async () => {
    const { toolbar, r1 } = build()
    dispose = installToolbarRowHover(toolbar)
    r1.focus()
    expect(hover()!.hasAttribute('hidden')).toBe(false)
    r1.removeAttribute(ROW_TIP_ATTRIBUTE)
    await Promise.resolve()
    expect(hover()!.hasAttribute('hidden')).toBe(true)
  })

  it('the disposer removes the element and every listener', () => {
    const { toolbar, r1 } = build()
    const remove = vi.spyOn(document, 'removeEventListener')
    dispose = installToolbarRowHover(toolbar)
    dispose()
    expect(hover()).toBeNull()
    expect(remove).toHaveBeenCalled()
    fire(r1, 'mouseover')
    r1.focus()
    vi.advanceTimersByTime(ROW_HOVER_DELAY_MS * 2)
    expect(hover()).toBeNull()
    remove.mockRestore()
  })
})
