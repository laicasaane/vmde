// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest'
import { renderDiffMarkers } from './diff-markers'
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

describe('diff markers quiet write', () => {
  it('hides the marker bar append from a quiet observer only', () => {
    const root = document.createElement('div')
    root.className = 'vditor-reset'
    root.innerHTML = '<p data-block="0">First paragraph.</p>'
    document.body.appendChild(root)
    const vditor = {
      vditor: { currentMode: 'ir', ir: { element: root } },
      getValue: () => 'First paragraph.\n',
    }
    const { quiet, plain, unregister } = watch(root)
    const count = renderDiffMarkers(vditor, [
      { startLine: 0, endLine: 1, type: 'added' },
    ])
    expect(count).toBe(1)
    expect(root.querySelector('.me-diff-marker')).not.toBeNull()
    expect(quiet.takeRecords()).toHaveLength(0)
    expect(plain.takeRecords().length).toBeGreaterThan(0)
    unregister()
  })
})
