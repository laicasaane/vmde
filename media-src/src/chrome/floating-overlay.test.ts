// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest'
import { createFloatingOverlay, floatingPosition } from './floating-overlay'

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
