// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest'
import { applyCallouts } from './callouts'

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

afterEach(() => document.body.replaceChildren())

describe('callout decoration quiet write', () => {
  it('hides the data-callout, class and preview writes from a quiet observer only', () => {
    document.body.innerHTML =
      '<div id="root" class="vditor-ir"><blockquote data-block="0"><p>[!NOTE]\nbody</p></blockquote></div>'
    const root = document.getElementById('root')!
    const { quiet, plain, unregister } = watch(root)
    applyCallouts(root)
    expect(root.querySelector('blockquote')!.getAttribute('data-callout')).toBe(
      'note',
    )
    expect(root.querySelector('.vmde-callout__preview')).not.toBeNull()
    expect(quiet.takeRecords()).toHaveLength(0)
    expect(plain.takeRecords().length).toBeGreaterThan(0)
    unregister()
  })
})
