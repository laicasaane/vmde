// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fixResponsiveTables } from './responsive-tables'
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
  // The write runs from a debounce timer, so the records reach the callbacks while the test awaits;
  // collect what each observer is delivered or can still take.
  const quietSeen: MutationRecord[] = []
  const plainSeen: MutationRecord[] = []
  const quiet = new MutationObserver((records) => quietSeen.push(...records))
  quiet.observe(root, options)
  const plain = new MutationObserver((records) => plainSeen.push(...records))
  plain.observe(root, options)
  const unregister = registerQuietObserver(quiet, () => undefined)
  return {
    quietRecords: () => [...quietSeen, ...quiet.takeRecords()],
    plainRecords: () => [...plainSeen, ...plain.takeRecords()],
    unregister,
  }
}

describe('responsive tables quiet width removal', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.useRealTimers()
    document.body.replaceChildren()
  })

  it('hides the width attribute removal from a quiet observer only', async () => {
    document.body.innerHTML =
      '<div class="vditor"><pre class="vditor-reset"><div data-block="0"><table id="t" width="40"><tbody><tr><td>A</td></tr></tbody></table></div></pre></div>'
    const root = document.querySelector<HTMLElement>('.vditor')!
    // Only `width` is under test; the `class` and `style` writes stay ignored attributes.
    const { quietRecords, plainRecords, unregister } = watch(root, ['width'])
    fixResponsiveTables()
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(16)
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(16)
    expect(document.getElementById('t')!.hasAttribute('width')).toBe(false)
    expect(quietRecords()).toHaveLength(0)
    expect(plainRecords().length).toBeGreaterThan(0)
    unregister()
  })
})
