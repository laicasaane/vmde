// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { codeCopyText, installCodeCopy } from './code-copy'

describe('codeCopyText', () => {
  it("uses Vditor's hidden textarea, so line-number nodes never reach the clipboard", () => {
    const textarea = document.createElement('textarea')
    textarea.value = 'const answer = 42;\u200B'
    expect(codeCopyText(textarea)).toBe('const answer = 42;')
  })
})

describe('installCodeCopy', () => {
  const disposers: Array<() => void> = []
  afterEach(() => {
    while (disposers.length > 0) disposers.pop()?.()
    document.body.innerHTML = ''
  })

  function setup() {
    document.body.innerHTML =
      '<div id="root"><div class="vditor-copy"><textarea>line one\u200B</textarea>' +
      '<span data-vmde-copy-code="true"><svg id="icon"></svg></span></div>' +
      '<p id="other">text</p></div>'
    const post = vi.fn()
    const dispose = installCodeCopy(window, post)
    disposers.push(dispose)
    const button = document.querySelector('[data-vmde-copy-code]') as Element
    const root = document.getElementById('root') as HTMLElement
    return { post, dispose, button, root }
  }

  function press(target: Element, type: string, init: MouseEventInit = {}) {
    const event = new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      ...init,
    })
    target.dispatchEvent(event)
    return event
  }

  it('posts the code payload for the CSP-safe delegated button', () => {
    const { post, button } = setup()
    press(button, 'click')
    expect(post).toHaveBeenCalledTimes(1)
    expect(post).toHaveBeenCalledWith({
      command: 'copy-code',
      content: 'line one',
    })
  })

  it('prevents the default of a primary mousedown on the button, so the caret never moves', () => {
    const { button } = setup()
    expect(press(button, 'mousedown', { button: 0 }).defaultPrevented).toBe(
      true,
    )
    // A press on the inner icon counts as a press on the button.
    const icon = document.getElementById('icon') as Element
    expect(press(icon, 'mousedown', { button: 0 }).defaultPrevented).toBe(true)
    // Modifier keys do not change the decision.
    expect(
      press(button, 'mousedown', { button: 0, shiftKey: true })
        .defaultPrevented,
    ).toBe(true)
  })

  it('leaves a mousedown elsewhere alone', () => {
    setup()
    const other = document.getElementById('other') as Element
    expect(press(other, 'mousedown', { button: 0 }).defaultPrevented).toBe(
      false,
    )
  })

  it('leaves right and middle button mousedown on the button alone, so the context menu keeps working', () => {
    const { button } = setup()
    expect(press(button, 'mousedown', { button: 2 }).defaultPrevented).toBe(
      false,
    )
    expect(press(button, 'mousedown', { button: 1 }).defaultPrevented).toBe(
      false,
    )
  })

  it('consumes the click in the capture phase, so no root bubble listener sees it', () => {
    const { post, button, root } = setup()
    const rootBubble = vi.fn()
    root.addEventListener('click', rootBubble)
    const event = press(button, 'click')
    expect(post).toHaveBeenCalledTimes(1)
    expect(event.defaultPrevented).toBe(true)
    expect(rootBubble).not.toHaveBeenCalled()
  })

  it('does not consume a click elsewhere', () => {
    const { post, root } = setup()
    const rootBubble = vi.fn()
    root.addEventListener('click', rootBubble)
    press(document.getElementById('other') as Element, 'click')
    expect(post).not.toHaveBeenCalled()
    expect(rootBubble).toHaveBeenCalledTimes(1)
  })

  it('dispose removes both listeners', () => {
    const { post, dispose, button, root } = setup()
    dispose()
    const rootBubble = vi.fn()
    root.addEventListener('click', rootBubble)
    expect(press(button, 'mousedown', { button: 0 }).defaultPrevented).toBe(
      false,
    )
    press(button, 'click')
    expect(post).not.toHaveBeenCalled()
    expect(rootBubble).toHaveBeenCalledTimes(1)
  })
})
