// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  anchorRect,
  createHoverTip,
  installHoverTips,
  placeHoverTip,
} from './hover-tip'
import { ROW_HOVER_GAP_PX } from './toolbar-row-hover'

// Task 732 — the toolbar-style hover box for outline, link and image tooltips.

const viewport = { width: 800, height: 600 }
const box = { width: 100, height: 26 }

describe('placeHoverTip', () => {
  it('centres the box under the anchor', () => {
    expect(
      placeHoverTip({ left: 300, right: 400, top: 100, bottom: 120 }, box, viewport),
    ).toEqual({ left: 300, top: 120 + ROW_HOVER_GAP_PX })
  })

  it('flips above when below does not fit', () => {
    expect(
      placeHoverTip({ left: 300, right: 400, top: 580, bottom: 598 }, box, viewport),
    ).toEqual({ left: 300, top: 580 - ROW_HOVER_GAP_PX - box.height })
  })

  it('stays inside the viewport at both side edges', () => {
    expect(
      placeHoverTip({ left: 0, right: 20, top: 10, bottom: 30 }, box, viewport).left,
    ).toBe(0)
    expect(
      placeHoverTip({ left: 780, right: 800, top: 10, bottom: 30 }, box, viewport)
        .left,
    ).toBe(700)
  })

  it('stays below and clamped when neither side fits', () => {
    const tall = { width: 100, height: 700 }
    expect(
      placeHoverTip({ left: 300, right: 400, top: 10, bottom: 30 }, tall, viewport)
        .top,
    ).toBe(0)
  })
})

describe('anchorRect', () => {
  it('picks the line box under the pointer, else the bounding box', () => {
    const element = document.createElement('a')
    const lines = [
      { left: 500, right: 700, top: 0, bottom: 20 },
      { left: 0, right: 120, top: 20, bottom: 40 },
    ]
    element.getClientRects = () => lines as unknown as DOMRectList
    element.getBoundingClientRect = () =>
      ({ left: 0, right: 700, top: 0, bottom: 40 }) as DOMRect
    expect(anchorRect(element, 50, 30)).toBe(lines[1])
    expect(anchorRect(element, 300, 30)).toEqual({
      left: 0,
      right: 700,
      top: 0,
      bottom: 40,
    })
  })
})

describe('installHoverTips', () => {
  afterEach(() => {
    vi.useRealTimers()
    document.body.innerHTML = ''
  })

  it('shows the resolved text at once, hides on leave, notifies targets', () => {
    const target = document.createElement('span')
    target.textContent = 'entry'
    const other = document.createElement('p')
    document.body.append(target, other)
    const seen: Array<Element | null> = []
    const dispose = installHoverTips(
      document,
      (at) => (at === target ? { element: target, text: 'Full text' } : null),
      (element) => seen.push(element),
    )
    const tip = document.querySelector<HTMLElement>('.vmde-hover-tip')
    expect(tip?.getAttribute('role')).toBe('tooltip')
    target.dispatchEvent(new MouseEvent('pointerover', { bubbles: true }))
    expect(tip?.hidden).toBe(false)
    expect(tip?.textContent).toBe('Full text')
    expect(target.hasAttribute('title')).toBe(false)
    other.dispatchEvent(new MouseEvent('pointerover', { bubbles: true }))
    expect(tip?.hidden).toBe(true)
    expect(seen).toEqual([target, null])
    dispose()
    expect(document.querySelector('.vmde-hover-tip')).toBeNull()
  })

  it('with a delay, drops a pending box whose element is removed before it ends', () => {
    vi.useFakeTimers()
    const target = document.createElement('span')
    document.body.append(target)
    const tip = createHoverTip(document, 100)
    tip.show(target, 'x', 0, 0)
    target.remove()
    vi.advanceTimersByTime(100)
    expect(tip.shownText()).toBeNull()
    tip.dispose()
  })
})
