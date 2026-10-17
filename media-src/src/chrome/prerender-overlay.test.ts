// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { showRealToolbarInOverlay } from './prerender-overlay'
import { TWO_ROWS_CLASS } from './toolbar-overflow'
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

  // Task 642: the copy runs one synchronous flow pass, so it shows the rows and More contents the
  // live toolbar will show instead of one overflowing row.
  it('runs one flow pass on the copy so it shows the same rows as the live toolbar', () => {
    const overlay = document.createElement('div')
    overlay.id = 'vmde-prerender'
    const placeholder = document.createElement('div')
    placeholder.className = 'vditor-toolbar'
    overlay.append(placeholder)
    document.body.append(overlay)
    const real = document.createElement('div')
    real.className = 'vditor-toolbar'
    const names = ['bold', 'italic', 'preview', 'edit-mode', 'more']
    real.innerHTML =
      names
        .map(
          (name) =>
            `<div class="vditor-toolbar__item"><button data-type="${name}"></button>${
              name === 'more' ? '<div class="vditor-hint"></div>' : ''
            }</div>`,
        )
        .join('') +
      '<div class="vditor-toolbar__item"><button data-type="collapse-toolbar" aria-expanded="true"></button></div>'
    for (const el of real.querySelectorAll<HTMLElement>(
      '.vditor-toolbar__item',
    ))
      el.getBoundingClientRect = () => ({ width: 30 }) as DOMRect
    ;(window as unknown as { vditor: unknown }).vditor = {
      vditor: { toolbar: { element: real } },
    }
    // jsdom has no layout: the overlay is 100px wide, so the 5 controls (150px) need two rows.
    overlay.getBoundingClientRect = () => ({ width: 100 }) as DOMRect
    const originalClone = real.cloneNode.bind(real)
    real.cloneNode = ((deep?: boolean) => {
      const clone = originalClone(deep) as HTMLElement
      for (const el of clone.querySelectorAll<HTMLElement>(
        '.vditor-toolbar__item',
      ))
        el.getBoundingClientRect = () => ({ width: 30 }) as DOMRect
      return clone
    }) as typeof real.cloneNode

    showRealToolbarInOverlay()

    const copy = overlay.querySelector('.vditor-toolbar') as HTMLElement
    const rows = copy.querySelectorAll<HTMLElement>(
      ':scope > .vmde-toolbar-row',
    )
    expect(rows).toHaveLength(2)
    expect(copy.classList.contains(TWO_ROWS_CLASS)).toBe(true)
    expect(rows[1].hidden).toBe(false)
    expect(rows[1].querySelector('[data-type="more"]')).not.toBeNull()
  })
})
