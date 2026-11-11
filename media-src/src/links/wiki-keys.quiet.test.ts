// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest'
import { refreshWikiChips } from './wiki-keys'

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

describe('wiki chip refresh quiet write', () => {
  it('hides the data-wiki-missing, title and role writes from a quiet observer only', () => {
    document.body.innerHTML =
      '<div id="root"><span class="wiki-link-chip" data-wiki-link="1" data-wiki-target="Home">Home</span></div>'
    const root = document.getElementById('root')!
    const { quiet, plain, unregister } = watch(root)
    expect(refreshWikiChips(root, new Set())).toBe(1)
    expect(root.querySelector('span')!.getAttribute('data-wiki-missing')).toBe(
      '1',
    )
    expect(quiet.takeRecords()).toHaveLength(0)
    expect(plain.takeRecords().length).toBeGreaterThan(0)
    unregister()
  })
})
