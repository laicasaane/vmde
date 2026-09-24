// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest'
import {
  createFloatingOverlay,
  elementPanelBounds,
  elementPanelPosition,
  floatingPosition,
} from './floating-overlay'

afterEach(() => document.body.replaceChildren())

it('centers above a selection, clamps horizontally, and flips below near the top', () => {
  expect(
    floatingPosition(
      { left: 200, right: 260, top: 120, bottom: 140 },
      { width: 180, height: 32 },
      { width: 500, height: 400 },
    ),
  ).toEqual({ left: 140, top: 80 })
  expect(
    floatingPosition(
      { left: 2, right: 8, top: 4, bottom: 24 },
      { width: 180, height: 32 },
      { width: 240, height: 200 },
    ),
  ).toEqual({ left: 8, top: 32 })
  expect(
    floatingPosition(
      { left: 480, right: 495, top: 120, bottom: 140 },
      { width: 180, height: 32 },
      { width: 500, height: 400 },
    ),
  ).toEqual({ left: 312, top: 80 })
})

it('mounts outside the editor and keeps only one floating surface active', () => {
  document.body.innerHTML = '<div class="vditor-reset"></div>'
  const first = createFloatingOverlay('first')
  const second = createFloatingOverlay('second')
  first.show({ left: 20, right: 40, top: 80, bottom: 100 })
  expect(first.element.hidden).toBe(false)
  second.show({ left: 20, right: 40, top: 80, bottom: 100 })
  expect(first.element.hidden).toBe(true)
  expect(second.element.hidden).toBe(false)
  expect(second.element.closest('.vditor-reset')).toBeNull()
  second.dispose()
  first.dispose()
  expect(document.querySelector('.second')).toBeNull()
})

it('places an element panel outside the whole target when an adjacent side fits', () => {
  const bounds = { left: 8, right: 512, top: 142, bottom: 500 }
  expect(
    elementPanelPosition(
      { left: 11, right: 509, top: 152, bottom: 173 },
      { width: 365, height: 32 },
      bounds,
    ),
  ).toEqual({ left: 11, top: 181 })
  expect(
    elementPanelPosition(
      { left: 11, right: 509, top: 460, bottom: 481 },
      { width: 365, height: 32 },
      bounds,
    ),
  ).toEqual({ left: 11, top: 420 })
})

it('uses a side when vertical placement cannot fit and keeps the panel visible', () => {
  expect(
    elementPanelPosition(
      { left: 100, right: 300, top: 100, bottom: 460 },
      { width: 80, height: 40 },
      { left: 8, right: 500, top: 80, bottom: 480 },
    ),
  ).toEqual({ left: 308, top: 100 })
})

it('uses a caret-safe edge for a tall quote in a narrow editor', () => {
  const target = { left: 11, right: 509, top: 150, bottom: 490 }
  const bounds = { left: 8, right: 512, top: 142, bottom: 500 }
  const panel = { width: 300, height: 48 }
  expect(
    elementPanelPosition(target, panel, bounds, {
      left: 60,
      right: 60,
      top: 152,
      bottom: 168,
    }),
  ).toEqual({ left: 11, top: 452 })
  expect(
    elementPanelPosition(target, panel, bounds, {
      left: 60,
      right: 60,
      top: 470,
      bottom: 486,
    }),
  ).toEqual({ left: 11, top: 142 })
})

it('declines invalid, disconnected, and unfit panel geometry', () => {
  const bounds = { left: 8, right: 512, top: 142, bottom: 500 }
  const panel = { width: 300, height: 48 }
  expect(elementPanelPosition(null, panel, bounds)).toBeNull()
  expect(
    elementPanelPosition(
      { left: NaN, right: 40, top: 150, bottom: 180 },
      panel,
      bounds,
    ),
  ).toBeNull()
  expect(
    elementPanelPosition(
      { left: 11, right: 509, top: 150, bottom: 490 },
      { width: 510, height: 48 },
      bounds,
    ),
  ).toBeNull()
})

it('clips element panels to the visible scrollport below the toolbar', () => {
  expect(
    elementPanelBounds(
      { width: 520, height: 800 },
      { left: 1, right: 519, top: 142, bottom: 499 },
      { bottom: 142 },
    ),
  ).toEqual({ left: 9, right: 511, top: 150, bottom: 491 })
})

it('chooses the left side when the right edge is blocked, including a scrolled target rectangle', () => {
  expect(
    elementPanelPosition(
      { left: 200, right: 480, top: 100, bottom: 460 },
      { width: 80, height: 40 },
      { left: 8, right: 500, top: 80, bottom: 480 },
    ),
  ).toEqual({ left: 112, top: 100 })
  // The same quote after an 80px editor scroll uses the new viewport rectangle.
  expect(
    elementPanelPosition(
      { left: 200, right: 480, top: 20, bottom: 380 },
      { width: 80, height: 40 },
      { left: 8, right: 500, top: 80, bottom: 480 },
    ),
  ).toEqual({ left: 200, top: 388 })
})

it('reflows placement when the panel grows too tall for its previous side', () => {
  const target = { left: 20, right: 420, top: 160, bottom: 230 }
  const bounds = { left: 8, right: 500, top: 80, bottom: 280 }
  expect(
    elementPanelPosition(target, { width: 300, height: 32 }, bounds),
  ).toEqual({ left: 20, top: 238 })
  expect(
    elementPanelPosition(target, { width: 300, height: 55 }, bounds),
  ).toEqual({ left: 20, top: 97 })
})
