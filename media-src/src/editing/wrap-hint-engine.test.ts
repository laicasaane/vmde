// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { vi } from 'vitest'
import {
  applyWrapHintsSetting,
  installWrapHints,
  setWrapHintsMinLastPiece,
} from './wrap-hint-engine'

afterEach(() => {
  document.body.replaceChildren()
})

describe('installWrapHints without an IntersectionObserver', () => {
  it('is inert: no observer, no write, a callable disposer', () => {
    document.body.innerHTML = `<div class="vditor-reset"><p><code>a${'/b'.repeat(80)}</code></p></div>`
    const surface = document.querySelector('.vditor-reset') as HTMLElement
    const dispose = installWrapHints(() => [surface])
    expect(typeof dispose).toBe('function')
    expect(surface.querySelector('.vmde-wrap-hint')).toBeNull()
    dispose()
  })
})

// Task 640 S2e: the live setting. jsdom has the observers' stubs below, so the engine can be
// installed; the re-plan itself is proven in Chromium (wrap-hints.spec.ts).
describe('setWrapHintsMinLastPiece / applyWrapHintsSetting', () => {
  it('does nothing without an installed engine', () => {
    expect(setWrapHintsMinLastPiece(0)).toBe(false)
    expect(() => applyWrapHintsSetting(0)).not.toThrow()
  })

  it('reports a change once, ignores the same value, and is gone after dispose', () => {
    class FakeObserver {
      observe() {
        // Nothing to observe in the fake.
      }
      unobserve() {
        // Nothing to release in the fake.
      }
      disconnect() {
        // Nothing to release in the fake.
      }
    }
    vi.stubGlobal('IntersectionObserver', FakeObserver)
    vi.stubGlobal('MutationObserver', FakeObserver)
    vi.stubGlobal('ResizeObserver', FakeObserver)
    vi.stubGlobal('requestAnimationFrame', () => 1)
    vi.stubGlobal('cancelAnimationFrame', () => undefined)
    document.body.innerHTML = '<div class="vditor-reset"></div>'
    const surface = document.querySelector('.vditor-reset') as HTMLElement
    const dispose = installWrapHints(() => [surface], { minLastPiece: 3 })
    expect(setWrapHintsMinLastPiece(3)).toBe(false)
    expect(setWrapHintsMinLastPiece(0)).toBe(true)
    expect(setWrapHintsMinLastPiece(0)).toBe(false)
    // An invalid value in the payload resolves to the default 3, which is a change from 0.
    expect(setWrapHintsMinLastPiece(3)).toBe(true)
    dispose()
    expect(setWrapHintsMinLastPiece(5)).toBe(false)
    vi.unstubAllGlobals()
  })
})
