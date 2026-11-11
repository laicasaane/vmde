// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest'
import { observeInlinePictures } from './inline-picture'

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

describe('inline picture quiet write', () => {
  it('hides the presentation insert and marker hiding from a quiet observer only', () => {
    document.body.innerHTML =
      '<div id="root"><p>x<span data-type="html-inline">&lt;picture&gt;</span><span data-type="html-inline">&lt;img src="photo.png" alt="Photo"&gt;</span><span data-type="html-inline">&lt;/picture&gt;</span>y</p></div>'
    const root = document.getElementById('root')!
    const { quiet, plain, unregister } = watch(root)
    const dispose = observeInlinePictures(root)
    expect(root.querySelector('[data-vmde-inline-picture]')).not.toBeNull()
    expect(quiet.takeRecords()).toHaveLength(0)
    expect(plain.takeRecords().length).toBeGreaterThan(0)
    dispose()
    unregister()
  })
})
