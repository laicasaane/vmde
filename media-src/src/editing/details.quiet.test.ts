// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest'
import { createDetailsController } from './details'
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

const htmlBlock = (source: string) =>
  `<div data-block="0" data-type="html-block" class="vditor-ir__node"><pre class="vditor-ir__marker--pre"><code data-type="html-block">${source.replaceAll('<', '&lt;').replaceAll('>', '&gt;')}</code></pre><pre class="vditor-ir__preview" data-render="2"></pre></div>`

afterEach(() => document.body.replaceChildren())

describe('details projection quiet write', () => {
  it('hides the projection attributes and toggle button from a quiet observer only', () => {
    const root = document.createElement('div')
    root.className = 'vditor-reset vditor-ir'
    root.innerHTML =
      htmlBlock('<details><summary>One</summary>') +
      '<p>first</p>' +
      htmlBlock('</details>')
    document.body.replaceChildren(root)
    const { quiet, plain, unregister } = watch(root)
    const controller = createDetailsController(root)
    expect(root.querySelector('[data-vmde-details-hidden]')).not.toBeNull()
    expect(quiet.takeRecords()).toHaveLength(0)
    expect(plain.takeRecords().length).toBeGreaterThan(0)
    controller.dispose()
    unregister()
  })
})
