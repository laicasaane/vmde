// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import type Vditor from 'vditor'
import { installSectionHoist } from './section-hoist'
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
  vi.restoreAllMocks()
  document.body.replaceChildren()
})

describe('section hoist quiet write', () => {
  it('hides the hoist-hidden attribute from a quiet observer only', () => {
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      callback(0)
      return 1
    })
    document.body.innerHTML =
      '<div class="vditor"><div class="vditor-content"><div class="vditor-ir"><pre class="vditor-reset"><p data-block="0">pre</p><h1 id="a" data-block="0">A</h1><p data-block="0">a body</p><h1 id="b" data-block="0">B</h1></pre></div></div></div>'
    const ir = document.querySelector<HTMLElement>('.vditor-ir > pre')!
    const editor = {
      vditor: { currentMode: 'ir', ir: { element: ir } },
      getValue: () => '',
    } as unknown as Vditor
    let saved: unknown = {}
    const state = {
      getState: <T = unknown>() => saved as T,
      setState: <T>(next: T) => {
        saved = next
        return next
      },
    }
    const controller = installSectionHoist(editor, state)
    const { quiet, plain, unregister } = watch(ir, ['data-vmde-hoist-hidden'])
    controller.hoistHeading(0)
    expect(ir.querySelector('[data-vmde-hoist-hidden]')).not.toBeNull()
    expect(quiet.takeRecords()).toHaveLength(0)
    expect(plain.takeRecords().length).toBeGreaterThan(0)
    controller.dispose()
    unregister()
  })
})
