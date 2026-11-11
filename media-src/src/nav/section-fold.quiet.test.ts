// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest'
import { createSectionFoldController } from './section-fold'
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

afterEach(() => document.body.replaceChildren())

describe('section fold quiet write', () => {
  it('hides the folded and fold-hidden attributes from a quiet observer only', () => {
    const root = document.createElement('div')
    root.className = 'vditor-reset'
    root.innerHTML =
      '<h1 data-block="0" id="one">One</h1><p data-block="0">body</p><h1 data-block="0" id="two">Two</h1>'
    document.body.appendChild(root)
    const vditor = { vditor: { currentMode: 'ir', ir: { element: root } } }
    const controller = createSectionFoldController(vditor as never)
    // Only the three fold-state attributes are under test; the foldable flags are ignored attributes.
    const { quiet, plain, unregister } = watch(root, [
      'data-vmde-folded',
      'data-vmde-fold-hidden',
      'data-vmde-list-folded',
    ])
    expect(controller.toggleHeading(0)).toBe(true)
    expect(root.querySelector('[data-vmde-fold-hidden]')).not.toBeNull()
    expect(quiet.takeRecords()).toHaveLength(0)
    expect(plain.takeRecords().length).toBeGreaterThan(0)
    controller.dispose()
    unregister()
  })
})
