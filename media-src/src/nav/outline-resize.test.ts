import { describe, expect, it } from 'vitest'
import {
  MIN_WIDTH,
  clampOutlineWidth,
  keyboardWidthDelta,
  shownOutlineWidth,
  widthToPersist,
} from './outline-resize'

describe('clampOutlineWidth', () => {
  it('passes through a width within bounds', () => {
    expect(clampOutlineWidth(250, 2000)).toBe(250)
  })

  it('floors at MIN_WIDTH', () => {
    expect(clampOutlineWidth(10, 2000)).toBe(MIN_WIDTH)
  })

  it('caps at 50% of the viewport', () => {
    expect(clampOutlineWidth(5000, 2000)).toBe(1000)
  })

  it('floors the viewport-relative max to a whole pixel', () => {
    expect(clampOutlineWidth(5000, 1001)).toBe(500) // floor(1001 * 0.5) = 500
  })
})

describe('keyboardWidthDelta', () => {
  it('ArrowRight shrinks a RIGHT-side outline (the boundary moves toward its own edge)', () => {
    expect(keyboardWidthDelta('ArrowRight', 'right', 10)).toBe(-10)
  })

  it('ArrowLeft grows a RIGHT-side outline (the boundary moves away from its own edge)', () => {
    expect(keyboardWidthDelta('ArrowLeft', 'right', 10)).toBe(10)
  })

  it('ArrowRight grows a LEFT-side outline', () => {
    expect(keyboardWidthDelta('ArrowRight', 'left', 10)).toBe(10)
  })

  it('ArrowLeft shrinks a LEFT-side outline', () => {
    expect(keyboardWidthDelta('ArrowLeft', 'left', 10)).toBe(-10)
  })

  it('matches the drag path sign convention for both sides (magnitude = step)', () => {
    for (const position of ['left', 'right'] as const) {
      expect(Math.abs(keyboardWidthDelta('ArrowRight', position, 7))).toBe(7)
      expect(Math.abs(keyboardWidthDelta('ArrowLeft', position, 7))).toBe(7)
      // Left and Right are always opposite in sign for a given side.
      expect(keyboardWidthDelta('ArrowRight', position, 7)).toBe(
        -keyboardWidthDelta('ArrowLeft', position, 7),
      )
    }
  })
})

// Task 650 Decision 5 ("Clamp" acceptance row): the CSS clamps the SHOWN width, the stored var may
// be oversized, so keyboard steps and aria-valuenow must start from the shown width.
describe('shownOutlineWidth', () => {
  it('clamps an oversized var to 50% of the viewport (keyboard basis = shown width)', () => {
    expect(shownOutlineWidth('5000px', 1000)).toBe(500)
    // one ArrowLeft step on a right-side outline starts from 500, not 5000
    expect(
      shownOutlineWidth('5000px', 1000) +
        keyboardWidthDelta('ArrowLeft', 'right'),
    ).toBe(510)
  })

  it('raises an undersized var to MIN_WIDTH', () => {
    expect(shownOutlineWidth('50px', 1000)).toBe(MIN_WIDTH)
  })

  it('passes an in-range var through unchanged', () => {
    expect(shownOutlineWidth('321px', 2000)).toBe(321)
  })

  it('falls back to the 200px CSS default when the var is unset or malformed', () => {
    expect(shownOutlineWidth('', 2000)).toBe(200)
    expect(shownOutlineWidth('abc', 2000)).toBe(200)
  })

  it('caps the default at 50% of a narrow viewport', () => {
    expect(shownOutlineWidth('', 300)).toBe(150)
  })
})

// Task 656 Acceptance 1 and 2 at the rule level: a gesture persists only a width it actually
// changed, and only a usable one.
describe('widthToPersist', () => {
  it('returns undefined when the gesture left the width unchanged', () => {
    expect(widthToPersist(250, 250)).toBeUndefined()
    expect(widthToPersist(250.5, 250.5)).toBeUndefined()
  })

  it('returns the written width when it differs from the start width', () => {
    expect(widthToPersist(250, 270)).toBe(270)
  })

  it('returns undefined for no write or an unusable width', () => {
    expect(widthToPersist(250, undefined)).toBeUndefined()
    expect(widthToPersist(250, Number.NaN)).toBeUndefined()
    expect(widthToPersist(250, 0)).toBeUndefined()
    expect(widthToPersist(250, -5)).toBeUndefined()
  })
})
