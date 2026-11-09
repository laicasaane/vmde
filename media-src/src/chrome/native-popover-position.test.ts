// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { installNativePopoverPlacement } from './native-popover-position'
import { innerVditor } from '../util/inner-vditor'

vi.mock('../util/inner-vditor', () => ({ innerVditor: vi.fn() }))

function rect(top: number, left = 20, width = 200, height = 20): DOMRect {
  return {
    top,
    left,
    width,
    height,
    bottom: top + height,
    right: left + width,
    x: left,
    y: top,
    toJSON: () => ({}),
  }
}

describe('installNativePopoverPlacement', () => {
  const rangeRect = Range.prototype.getBoundingClientRect
  let teardown: (() => void) | undefined
  afterEach(() => {
    teardown?.()
    teardown = undefined
    document.body.replaceChildren()
    vi.unstubAllGlobals()
    Range.prototype.getBoundingClientRect = rangeRect
  })

  it('stops following a heading owner once the caret moves to a plain paragraph', () => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe = vi.fn()
        unobserve = vi.fn()
        disconnect = vi.fn()
      },
    )
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      frames.push(cb)
      return frames.length
    })
    vi.stubGlobal('cancelAnimationFrame', () => undefined)
    const editor = document.createElement('div')
    editor.innerHTML = '<h2>Heading</h2><p>Plain paragraph</p>'
    const popover = document.createElement('div')
    popover.style.display = 'block'
    popover.style.left = '20px'
    popover.style.top = '300px'
    document.body.append(editor, popover)
    const heading = editor.querySelector('h2')!
    const paragraph = editor.querySelector('p')!
    heading.getBoundingClientRect = () => rect(100)
    paragraph.getBoundingClientRect = () => rect(300)
    popover.getBoundingClientRect = () => {
      const top = Number.parseFloat(popover.style.top)
      return rect(top, Number.parseFloat(popover.style.left), 100, 30)
    }
    vi.stubGlobal('innerWidth', 1000)
    vi.stubGlobal('innerHeight', 800)
    vi.mocked(innerVditor).mockReturnValue({
      currentMode: 'wysiwyg',
      wysiwyg: { element: editor, popover },
    } as never)
    const place = (node: Node) => {
      const range = document.createRange()
      range.setStart(node, 0)
      range.collapse(true)
      const selection = document.getSelection()!
      selection.removeAllRanges()
      selection.addRange(range)
      document.dispatchEvent(new Event('selectionchange'))
    }
    const flush = () => {
      for (const cb of frames.splice(0)) cb(0)
    }
    Range.prototype.getBoundingClientRect = () => rect(100)
    teardown = installNativePopoverPlacement()

    place(heading.firstChild!)
    flush()
    expect(Number.parseFloat(popover.style.top)).toBeLessThan(100)

    // Vditor places its own popover for the paragraph; VMDE must not pull it back to the heading.
    popover.style.top = '280px'
    place(paragraph.firstChild!)
    flush()
    expect(popover.style.top).toBe('280px')
  })
})
