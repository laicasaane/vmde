// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { applyCodeRefs } from './code-ref-decorate'
import {
  _resetCodeRefResolutionForTests,
  applyCodeRefResolution,
  requestCodeRefResolution,
} from './code-ref-resolve'

import { registerQuietObserver } from '../util/mutation-impact'

// Task 733: a view-only write must not reach a quiet observer (the unit-DOM shadow model), while an
// ordinary observer on the same root still sees it.
function watch(root: HTMLElement) {
  const options = {
    childList: true,
    subtree: true,
    attributes: true,
    characterData: true,
  }
  const quiet = new MutationObserver(() => undefined)
  quiet.observe(root, options)
  const plain = new MutationObserver(() => undefined)
  plain.observe(root, options)
  const unregister = registerQuietObserver(quiet, () => undefined)
  return { quiet, plain, unregister }
}

afterEach(() => {
  document.body.replaceChildren()
  vi.useRealTimers()
})

describe('code reference decoration quiet write', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    _resetCodeRefResolutionForTests()
  })

  it('hides the chip split and inline-code attributes from a quiet observer only', () => {
    document.body.innerHTML =
      '<div id="root"><p>see src/a.ts:4 and <code>src/b.ts:9</code></p></div>'
    const root = document.getElementById('root')!
    const post = vi.fn()
    requestCodeRefResolution('src/a.ts', post)
    requestCodeRefResolution('src/b.ts', post)
    vi.advanceTimersByTime(50)
    applyCodeRefResolution(post.mock.calls[0][0].requestId, [
      'src/a.ts',
      'src/b.ts',
    ])
    const { quiet, plain, unregister } = watch(root)
    applyCodeRefs(root, post)
    expect(root.querySelector('span[data-code-ref]')).not.toBeNull()
    expect(root.querySelector('code[data-code-ref]')).not.toBeNull()
    expect(quiet.takeRecords()).toHaveLength(0)
    expect(plain.takeRecords().length).toBeGreaterThan(0)
    unregister()
  })
})
