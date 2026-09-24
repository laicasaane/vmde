// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'
import {
  createPreviewState,
  installPreviewState,
  runPreviewEntry,
} from './preview-state'

describe('Preview render revision state', () => {
  it('reuses only a successfully committed current connected pane for the same instance', () => {
    const instance = {}
    const pane = document.createElement('div')
    document.body.appendChild(pane)
    const state = createPreviewState(instance)
    expect(state.canReuse(instance, pane)).toBe(false)
    state.markRendered(instance, pane)
    expect(state.canReuse(instance, pane)).toBe(true)
    expect(state.canReuse({}, pane)).toBe(false)
    pane.remove()
    expect(state.canReuse(instance, pane)).toBe(false)
  })

  it('invalidates content and render configuration independently and recommits once', () => {
    const instance = {}
    const pane = document.createElement('div')
    document.body.appendChild(pane)
    const state = createPreviewState(instance)
    state.markRendered(instance, pane)
    state.invalidateContent()
    expect(state.canReuse(instance, pane)).toBe(false)
    state.markRendered(instance, pane)
    expect(state.canReuse(instance, pane)).toBe(true)
    state.invalidateConfig()
    expect(state.canReuse(instance, pane)).toBe(false)
  })

  it('binds only the newest exact source snapshot to its delayed render token', () => {
    const state = createPreviewState({}) as ReturnType<
      typeof createPreviewState
    > & {
      captureMarkdown?: (markdown: string) => number
      commitMarkdown?: (renderId: number) => string | undefined
    }
    expect(typeof state.captureMarkdown).toBe('function')
    expect(typeof state.commitMarkdown).toBe('function')
    if (!state.captureMarkdown || !state.commitMarkdown) return

    const obsolete = state.captureMarkdown('older source\r\n')
    const current = state.captureMarkdown('latest exact source\r\n')

    expect(state.commitMarkdown(obsolete)).toBeUndefined()
    expect(state.commitMarkdown(current)).toBe('latest exact source\r\n')
    expect(state.commitMarkdown(current)).toBeUndefined()

    const nextRender = state.captureMarkdown('same bytes, new render')
    expect(state.commitMarkdown(nextRender)).toBe('same bytes, new render')
  })

  it('delivers the exact captured source only after its matching preview render commits', () => {
    const pane = document.createElement('div')
    const owner = { preview: { previewElement: pane } }
    document.body.appendChild(pane)
    const rendered = vi.fn()
    ;(window as any).__vmdePreviewSourceRendered = rendered
    const dispose = installPreviewState(owner, () => 'live source')

    try {
      const capture = (window as any).__vmdeCapturePreviewSource
      expect(typeof capture).toBe('function')
      if (typeof capture !== 'function') return
      const obsolete = capture('stale source')
      const current = capture('captured source\r\n')

      ;(window as any).__vmdePreviewRendered?.(owner, pane, obsolete)
      expect(rendered).not.toHaveBeenCalled()
      expect((window as any).__vmdeEnterPreview?.(owner)).toBe(false)

      ;(window as any).__vmdePreviewRendered?.(owner, pane, current)
      expect(rendered).toHaveBeenCalledWith(
        owner,
        pane,
        'captured source\r\n',
        current,
      )
      expect(rendered).toHaveBeenCalledTimes(1)
      expect((window as any).__vmdeEnterPreview?.(owner)).toBe(true)

      const contentInvalidated = capture('source before content invalidation')
      ;(window as any).__vmdeInvalidatePreview?.('content')
      ;(window as any).__vmdePreviewRendered?.(owner, pane, contentInvalidated)
      expect(rendered).toHaveBeenCalledTimes(1)
      expect((window as any).__vmdeEnterPreview?.(owner)).toBe(false)

      const configInvalidated = capture('source before config invalidation')
      ;(window as any).__vmdeInvalidatePreview?.('config')
      ;(window as any).__vmdePreviewRendered?.(owner, pane, configInvalidated)
      expect(rendered).toHaveBeenCalledTimes(1)
    } finally {
      dispose()
      delete (window as any).__vmdePreviewSourceRendered
      pane.remove()
    }
  })

  it('skips every render callback on reuse and renders once after invalidation', () => {
    const instance = {}
    const pane = document.createElement('div')
    pane.innerHTML = '<p>stable</p>'
    document.body.appendChild(pane)
    const child = pane.firstChild
    const state = createPreviewState(instance)
    const render = vi.fn()
    const reused = vi.fn()
    state.markRendered(instance, pane)

    expect(runPreviewEntry(state, instance, pane, render, reused)).toBe(true)
    expect(render).not.toHaveBeenCalled()
    expect(reused).toHaveBeenCalledOnce()
    expect(pane.firstChild).toBe(child)

    state.invalidateContent()
    expect(runPreviewEntry(state, instance, pane, render, reused)).toBe(false)
    expect(render).toHaveBeenCalledOnce()
  })
})
