import { describe, expect, it } from 'vitest'
import { pinFramesAfterTick } from './preview-scroll-preserve'

// Task 643: the pin that holds the reading position while a streamed Preview or a freshly built edit
// view settles stays on for as long as the content keeps growing.
describe('pinFramesAfterTick', () => {
  it('leaves the remaining frames alone when the content did not grow', () => {
    expect(pinFramesAfterTick(5, 100, false)).toBe(5)
  })

  it('keeps at least the quiet window while the content is growing', () => {
    expect(pinFramesAfterTick(2, 100, true)).toBe(30)
    expect(pinFramesAfterTick(200, 100, true)).toBe(200)
  })

  it('never runs past the overall cap', () => {
    expect(pinFramesAfterTick(2, 3740, true)).toBe(10)
    expect(pinFramesAfterTick(2, 3750, true)).toBe(0)
  })
})
