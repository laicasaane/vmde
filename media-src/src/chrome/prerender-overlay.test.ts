// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { showRealToolbarInOverlay } from './prerender-overlay'
import { COLLAPSED_CLASS, receiveToolbarCollapsed } from './toolbar-collapse'

// Task 631 follow-up F2 (Owner, 2026-10-15): "collapsing state of toolbar must be remembered through
// VSCode sessions". The instant-paint overlay shows a copy of the real toolbar while the editor
// loads; for an editor remembered as collapsed that copy must not paint the expanded toolbar.
function mountOverlayAndRealToolbar() {
  const overlay = document.createElement('div')
  overlay.id = 'vmde-prerender'
  const placeholder = document.createElement('div')
  placeholder.className = 'vditor-toolbar'
  overlay.append(placeholder)
  document.body.append(overlay)

  const real = document.createElement('div')
  real.className = 'vditor-toolbar'
  real.innerHTML =
    '<div class="vditor-toolbar__item"><button data-type="bold"></button></div>' +
    '<div class="vditor-toolbar__item"><button data-type="collapse-toolbar" aria-expanded="true"></button></div>'
  ;(window as unknown as { vditor: unknown }).vditor = {
    vditor: { toolbar: { element: real } },
  }
  return overlay
}

afterEach(() => {
  document.body.replaceChildren()
  receiveToolbarCollapsed(false)
  delete (window as unknown as { vditor?: unknown }).vditor
})

describe('showRealToolbarInOverlay', () => {
  it('shows the toolbar copy collapsed when the shared state is collapsed', () => {
    receiveToolbarCollapsed(true)
    const overlay = mountOverlayAndRealToolbar()

    showRealToolbarInOverlay()

    const copy = overlay.querySelector('.vditor-toolbar') as HTMLElement
    expect(copy.classList.contains(COLLAPSED_CLASS)).toBe(true)
    expect(
      copy
        .querySelector('[data-type="collapse-toolbar"]')
        ?.getAttribute('aria-expanded'),
    ).toBe('false')
  })

  it('shows the toolbar copy expanded when the shared state is expanded', () => {
    const overlay = mountOverlayAndRealToolbar()

    showRealToolbarInOverlay()

    const copy = overlay.querySelector('.vditor-toolbar') as HTMLElement
    expect(copy.querySelector('[data-type="bold"]')).not.toBeNull()
    expect(copy.classList.contains(COLLAPSED_CLASS)).toBe(false)
    expect(
      copy
        .querySelector('[data-type="collapse-toolbar"]')
        ?.getAttribute('aria-expanded'),
    ).toBe('true')
  })
})
