// @vitest-environment jsdom

import DOMPurify from 'dompurify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { applySvgDataImagePreviews } from './svg-data-image-adapter'
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

const SAFE_SVG =
  'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxIDEiPjxwYXRoIGQ9Ik0wIDBoMXYxSDB6Ii8+PC9zdmc+'

afterEach(() => {
  vi.unstubAllGlobals()
  delete window.DOMPurify
})

describe('SVG data image adapter quiet write', () => {
  it('hides the inline render-only preview append from a quiet observer only', () => {
    window.DOMPurify = DOMPurify
    vi.stubGlobal('URL', {
      createObjectURL: vi.fn(() => 'blob:vmde-safe'),
      revokeObjectURL: vi.fn(),
    })
    const root = document.createElement('div')
    root.innerHTML = `<p><span data-type="html-inline"><code>&lt;img src=&quot;${SAFE_SVG}&quot; alt=&quot;safe icon&quot;&gt;</code></span></p>`
    const { quiet, plain, unregister } = watch(root)
    applySvgDataImagePreviews(root)
    expect(root.querySelector('[data-render="1"] img')).not.toBeNull()
    expect(quiet.takeRecords()).toHaveLength(0)
    expect(plain.takeRecords().length).toBeGreaterThan(0)
    unregister()
  })
})
