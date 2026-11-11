// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest'
import { installWebviewContext } from './webview-context'

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

describe('webview context quiet write', () => {
  it('hides the data-vscode-context stamp from a quiet observer only', () => {
    document.body.innerHTML =
      '<div id="root"><p><img src="a.png" alt="a"></p></div>'
    const root = document.getElementById('root')!
    const { quiet, plain, unregister } = watch(root)
    const dispose = installWebviewContext(root)
    expect(root.querySelector('img')!.hasAttribute('data-vscode-context')).toBe(
      true,
    )
    expect(quiet.takeRecords()).toHaveLength(0)
    expect(plain.takeRecords().length).toBeGreaterThan(0)
    dispose()
    unregister()
  })
})
