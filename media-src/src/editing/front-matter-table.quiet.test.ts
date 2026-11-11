// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest'
import { parseFrontMatterProperties } from '../../../src/shared/front-matter'
import { createRealLute } from '../testing/real-lute'
import { decorateFrontMatter } from './front-matter-table'
import { registerQuietObserver } from '../util/mutation-impact'

// Task 733: a view-only write must not reach a quiet observer (the unit-DOM shadow model), while an
// ordinary observer on the same root still sees it.
function watch(root: HTMLElement, attributeFilter?: string[]) {
  const options: MutationObserverInit = {
    childList: true,
    subtree: true,
    attributes: true,
    characterData: true,
    ...(attributeFilter ? { attributeFilter } : {}),
  }
  const quiet = new MutationObserver(() => undefined)
  quiet.observe(root, options)
  const plain = new MutationObserver(() => undefined)
  plain.observe(root, options)
  const unregister = registerQuietObserver(quiet, () => undefined)
  return { quiet, plain, unregister }
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('front matter table quiet write', () => {
  it('hides the table insert and state attribute from a quiet observer only', () => {
    const lute = createRealLute('ir')
    const root = document.createElement('div')
    root.className = 'vditor-reset vditor-ir'
    root.innerHTML = lute.render('---\ntitle: "Hello"\n---\n\n# Heading\n')
    document.body.appendChild(root)
    const block = root.querySelector<HTMLElement>(
      'div[data-type="yaml-front-matter"]',
    )!
    const { quiet, plain, unregister } = watch(root)
    decorateFrontMatter(block, parseFrontMatterProperties('title: "Hello"'))
    expect(block.querySelector('.vmde-front-matter')).not.toBeNull()
    expect(quiet.takeRecords()).toHaveLength(0)
    expect(plain.takeRecords().length).toBeGreaterThan(0)
    unregister()
  })
})
