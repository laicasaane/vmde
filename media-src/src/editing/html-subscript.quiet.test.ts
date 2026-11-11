// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest'
import { observeHtmlSubscripts } from './html-subscript'

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

describe('HTML subscript quiet write', () => {
  it('hides the owned wrapper and marker hiding from a quiet observer only', () => {
    document.body.innerHTML =
      '<div id="root"><p>H<span data-type="html-inline">&lt;sub&gt;</span>2<span data-type="html-inline">&lt;/sub&gt;</span>O</p></div>'
    const root = document.getElementById('root')!
    const { quiet, plain, unregister } = watch(root)
    const dispose = observeHtmlSubscripts(root)
    expect(root.querySelector('sub[data-vmde-html-subscript]')).not.toBeNull()
    expect(quiet.takeRecords()).toHaveLength(0)
    expect(plain.takeRecords().length).toBeGreaterThan(0)
    dispose()
    unregister()
  })
})
