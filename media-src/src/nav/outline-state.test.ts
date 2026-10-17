// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { installOutlineState } from './outline-state'

// Task 650 Decision 3 / 7: only a click on the toolbar Outline button stores, and only when
// Vditor's own handler (bound earlier) changed `options.outline.enable`.

function setup(initial = false) {
  const wrapper = document.createElement('div')
  const button = document.createElement('button')
  wrapper.appendChild(button)
  const state = { enable: initial }
  // Vditor's own handler, bound first on the button (flips enable; a disabled button does nothing).
  let disabled = false
  button.addEventListener('click', () => {
    if (!disabled) state.enable = !state.enable
  })
  const api = { postMessage: vi.fn() }
  const remember = vi.fn()
  const dispose = installOutlineState(wrapper, {
    readEnabled: () => state.enable,
    remember,
    api,
  })
  return {
    button,
    state,
    api,
    remember,
    dispose,
    setDisabled: (v: boolean) => {
      disabled = v
    },
  }
}

describe('installOutlineState', () => {
  it('posts the new state once per user toggle and remembers it for re-init', () => {
    const t = setup(false)
    t.button.click()
    expect(t.api.postMessage).toHaveBeenCalledTimes(1)
    expect(t.api.postMessage).toHaveBeenLastCalledWith({
      command: 'save-outline-open',
      open: true,
    })
    expect(t.remember).toHaveBeenLastCalledWith(true)
    t.button.click()
    expect(t.api.postMessage).toHaveBeenLastCalledWith({
      command: 'save-outline-open',
      open: false,
    })
    expect(t.api.postMessage).toHaveBeenCalledTimes(2)
    expect(t.remember).toHaveBeenLastCalledWith(false)
  })

  it('posts nothing for a click Vditor ignored (disabled button)', () => {
    const t = setup(true)
    t.setDisabled(true)
    t.button.click()
    expect(t.api.postMessage).not.toHaveBeenCalled()
    expect(t.remember).not.toHaveBeenCalled()
  })

  it('posts nothing for programmatic changes (mode switch, re-init) without a click', () => {
    const t = setup(false)
    t.state.enable = true // e.g. a mode switch or re-init path changing enable
    expect(t.api.postMessage).not.toHaveBeenCalled()
    // the next real click compares with the last STORED value: closing back to it changes nothing
    t.button.click()
    expect(t.api.postMessage).not.toHaveBeenCalled()
    t.button.click() // now open again: differs from the stored false, so it is stored
    expect(t.api.postMessage).toHaveBeenCalledWith({
      command: 'save-outline-open',
      open: true,
    })
  })

  it('posts nothing after dispose', () => {
    const t = setup(false)
    t.dispose()
    t.button.click()
    expect(t.api.postMessage).not.toHaveBeenCalled()
  })
})
