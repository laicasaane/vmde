// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { installWrapHints } from './wrap-hint-engine'

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
