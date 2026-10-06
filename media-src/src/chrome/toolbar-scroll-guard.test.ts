// @vitest-environment jsdom
//
// The toolbar scroll pin (restore an upward jump after a toolbar click) and Task 597's intentional
// history-reveal exemption. jsdom has no layout, so the editor's scroll geometry is stubbed.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  guardToolbarScroll,
  markIntentionalHistoryReveal,
} from './toolbar-scroll-guard'

let frames: FrameRequestCallback[]
let scrollTop: number
let toolbar: HTMLElement
let editor: HTMLElement

function fireFrames(count: number): void {
  for (let i = 0; i < count; i++) {
    const pending = frames
    frames = []
    for (const callback of pending) callback(performance.now())
  }
}

// mousedown then click, as a real toolbar press; `onClick` runs as the button's own handler,
// before the guard's bubble listener (where Vditor's menu items run).
function press(button: HTMLElement, onClick: () => void): void {
  const handler = () => onClick()
  button.addEventListener('click', handler)
  button.dispatchEvent(
    new MouseEvent('mousedown', { bubbles: true, cancelable: true }),
  )
  button.click()
  button.removeEventListener('click', handler)
}

beforeEach(() => {
  frames = []
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.push(callback)
    return frames.length
  })
  document.body.innerHTML =
    '<div class="vditor"><div class="vditor-toolbar"><button id="undo"></button><button id="bold"></button></div><pre id="editor"></pre></div>'
  toolbar = document.querySelector('.vditor-toolbar') as HTMLElement
  editor = document.getElementById('editor') as HTMLElement
  editor.style.overflowY = 'auto'
  Object.defineProperty(editor, 'clientHeight', {
    value: 100,
    configurable: true,
  })
  Object.defineProperty(editor, 'scrollHeight', {
    value: 1000,
    configurable: true,
  })
  scrollTop = 500
  Object.defineProperty(editor, 'scrollTop', {
    get: () => scrollTop,
    set: (value: number) => {
      scrollTop = value
    },
    configurable: true,
  })
  guardToolbarScroll(
    { getCurrentMode: () => 'ir', vditor: { ir: { element: editor } } },
    toolbar,
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('guardToolbarScroll', () => {
  const button = (id: string) => document.getElementById(id) as HTMLElement

  it('pins an upward jump caused by a toolbar action back to the pressed position', () => {
    press(button('bold'), () => {
      scrollTop = 0
    })
    expect(scrollTop).toBe(500)
    scrollTop = 0
    fireFrames(1)
    expect(scrollTop).toBe(500)
  })

  it('leaves an intentional history reveal made by the clicked action in place', () => {
    press(button('undo'), () => {
      markIntentionalHistoryReveal()
      scrollTop = 74
    })
    expect(scrollTop).toBe(74)
    fireFrames(3)
    expect(scrollTop).toBe(74)
  })

  it('stops pinning when a history reveal happens later in the pin window', () => {
    press(button('undo'), () => {
      scrollTop = 0
    })
    expect(scrollTop).toBe(500)
    markIntentionalHistoryReveal()
    scrollTop = 74
    fireFrames(3)
    expect(scrollTop).toBe(74)
  })

  it('pins again on the next ordinary toolbar press', () => {
    press(button('undo'), () => {
      markIntentionalHistoryReveal()
      scrollTop = 74
    })
    scrollTop = 500
    press(button('bold'), () => {
      scrollTop = 0
    })
    expect(scrollTop).toBe(500)
  })
})
