// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Task 580 CP2-1 — each gate of the `editor-action` dispatcher, in its documented order. The
// caret, composition, readiness and log collaborators are mocked; the gate logic and the DOM
// focus/selection checks are real.
const h = vi.hoisted(() => ({
  invalidateCaret: vi.fn(),
  isCompositionActive: vi.fn(() => false),
  activeModeElement: vi.fn((): HTMLElement | null => null),
  completeActivity: vi.fn(),
  beginE2EActivity: vi.fn(),
  markE2EError: vi.fn(),
  logToHost: vi.fn(),
  reportError: vi.fn(),
}))
vi.mock('../editing/caret', () => ({ invalidateCaret: h.invalidateCaret }))
vi.mock('../util/caret-gesture', () => ({
  isCompositionActive: h.isCompositionActive,
}))
vi.mock('../util/source-map', () => ({
  activeModeElement: h.activeModeElement,
}))
vi.mock('../testing/e2e-readiness', () => ({
  beginE2EActivity: h.beginE2EActivity,
  markE2EError: h.markE2EError,
}))
vi.mock('../util/webview-log', () => ({
  logToHost: h.logToHost,
  reportError: h.reportError,
}))

import {
  configureEditorActionHooks,
  registerEditorActionRunner,
  runEditorAction,
} from './editor-actions'

let surface: HTMLElement
let previewButton: HTMLElement
const cleanups: (() => void)[] = []

function register(
  action: Parameters<typeof registerEditorActionRunner>[0],
  runner = vi.fn(),
) {
  cleanups.push(registerEditorActionRunner(action, runner))
  return runner
}

function placeCaretInSurface() {
  surface.focus()
  const range = document.createRange()
  range.setStart(surface.querySelector('p')!.firstChild!, 1)
  range.collapse(true)
  getSelection()?.removeAllRanges()
  getSelection()?.addRange(range)
}

function focusFindInput(): HTMLInputElement {
  const input = document.createElement('input')
  input.type = 'text'
  input.value = 'needle'
  document.body.append(input)
  input.focus()
  return input
}

beforeEach(() => {
  vi.clearAllMocks()
  h.beginE2EActivity.mockReturnValue(h.completeActivity)
  document.body.innerHTML = ''
  surface = document.createElement('div')
  surface.setAttribute('contenteditable', 'true')
  surface.tabIndex = 0
  surface.innerHTML = '<p>text</p>'
  document.body.append(surface)
  previewButton = document.createElement('button')
  h.activeModeElement.mockReturnValue(surface)
  ;(window as any).vditor = {
    vditor: {
      currentMode: 'ir',
      ir: { element: surface },
      toolbar: { elements: { preview: { children: [previewButton] } } },
    },
  }
})

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
  ;(window as any).vditor = undefined
})

describe('runEditorAction gates', () => {
  it('drops an action with no registered runner before any side effect', () => {
    placeCaretInSurface()
    runEditorAction('fold')
    expect(h.invalidateCaret).not.toHaveBeenCalled()
    expect(h.beginE2EActivity).not.toHaveBeenCalled()
    expect(h.logToHost).toHaveBeenCalledWith(
      '[editor-action] fold dropped: no runner registered',
    )
  })

  it('drops every action while IME composition is active', () => {
    const run = register('fold')
    h.isCompositionActive.mockReturnValue(true)
    placeCaretInSurface()
    runEditorAction('fold')
    h.isCompositionActive.mockReturnValue(false)
    expect(run).not.toHaveBeenCalled()
    expect(h.invalidateCaret).not.toHaveBeenCalled()
    expect(h.logToHost).toHaveBeenCalledWith(
      '[editor-action] fold dropped: IME composition active',
    )
  })

  it('drops surface-editing actions while Preview shows, but still folds', () => {
    const heading = register('heading-2')
    const fold = register('fold')
    previewButton.classList.add('vditor-menu--current')
    placeCaretInSurface()
    runEditorAction('heading-2')
    runEditorAction('fold')
    expect(heading).not.toHaveBeenCalled()
    expect(fold).toHaveBeenCalledTimes(1)
    expect(h.logToHost).toHaveBeenCalledWith(
      '[editor-action] heading-2 dropped: Preview or read-only',
    )
  })

  // Task 580 CP2-6: the selection can stay in the hidden surface behind Preview.
  it('drops the selection actions while Preview shows', () => {
    const selectAll = register('select-all')
    const expand = register('expand-selection')
    previewButton.classList.add('vditor-menu--current')
    placeCaretInSurface()
    runEditorAction('select-all')
    runEditorAction('expand-selection')
    expect(selectAll).not.toHaveBeenCalled()
    expect(expand).not.toHaveBeenCalled()
    expect(h.logToHost).toHaveBeenCalledWith(
      '[editor-action] select-all dropped: Preview',
    )
  })

  it('runs the selection actions on a read-only surface', () => {
    const selectAll = register('select-all')
    surface.setAttribute('contenteditable', 'false')
    placeCaretInSurface()
    runEditorAction('select-all')
    expect(selectAll).toHaveBeenCalledTimes(1)
  })

  it('drops surface-editing actions on a read-only surface', () => {
    const toggle = register('toggle-task-checkbox')
    const switchMode = register('switch-to-sv')
    surface.setAttribute('contenteditable', 'false')
    placeCaretInSurface()
    runEditorAction('toggle-task-checkbox')
    runEditorAction('switch-to-sv')
    expect(toggle).not.toHaveBeenCalled()
    expect(switchMode).not.toHaveBeenCalled()
  })

  it('invalidates the pending caret intent before the runner', () => {
    const order: string[] = []
    h.invalidateCaret.mockImplementation(() => order.push('invalidate'))
    register(
      'move-block-down',
      vi.fn(() => order.push('run')),
    )
    placeCaretInSurface()
    runEditorAction('move-block-down')
    expect(order).toEqual(['invalidate', 'run'])
  })

  it('selects the focused VMDE input for Select All instead of running the editor action', () => {
    const selectAll = register('select-all')
    placeCaretInSurface()
    const input = focusFindInput()
    runEditorAction('select-all')
    expect(selectAll).not.toHaveBeenCalled()
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, 6])
  })

  it('does nothing for any other action while a VMDE input has focus', () => {
    const fold = register('fold')
    const heading = register('heading-1')
    placeCaretInSurface()
    const input = focusFindInput()
    input.setSelectionRange(2, 2)
    runEditorAction('fold')
    runEditorAction('heading-1')
    expect(fold).not.toHaveBeenCalled()
    expect(heading).not.toHaveBeenCalled()
    expect([input.selectionStart, input.selectionEnd]).toEqual([2, 2])
  })

  it('requires focus inside the editing surface for editor-focus actions', () => {
    const move = register('move-block-up')
    placeCaretInSurface()
    const outside = document.createElement('button')
    document.body.append(outside)
    outside.focus()
    runEditorAction('move-block-up')
    expect(move).not.toHaveBeenCalled()
    expect(h.logToHost).toHaveBeenCalledWith(
      '[editor-action] move-block-up dropped: outside editor-focus',
    )
    surface.focus()
    runEditorAction('move-block-up')
    expect(move).toHaveBeenCalledTimes(1)
  })

  it('requires the selection inside the editing surface for editor-selection actions', () => {
    const expand = register('expand-selection')
    const outside = document.createElement('p')
    outside.textContent = 'outside'
    document.body.append(outside)
    const range = document.createRange()
    range.selectNodeContents(outside)
    getSelection()?.removeAllRanges()
    getSelection()?.addRange(range)
    runEditorAction('expand-selection')
    expect(expand).not.toHaveBeenCalled()
    placeCaretInSurface()
    runEditorAction('expand-selection')
    expect(expand).toHaveBeenCalledTimes(1)
  })

  it('drops editor-scoped actions when no editing surface exists', () => {
    const move = register('table-move-row-up')
    placeCaretInSurface()
    h.activeModeElement.mockReturnValue(null)
    runEditorAction('table-move-row-up')
    expect(move).not.toHaveBeenCalled()
  })

  it('runs webview-scoped actions wherever the selection is', () => {
    const unfold = register('unfold')
    getSelection()?.removeAllRanges()
    runEditorAction('unfold')
    expect(unfold).toHaveBeenCalledTimes(1)
  })

  it('restores the selection, then takes the boundary, then runs inside one E2E activity', () => {
    const order: string[] = []
    const restoreSelection = vi.fn(() => order.push('restore'))
    const takeUndoBoundary = vi.fn(() => order.push('boundary'))
    cleanups.push(
      configureEditorActionHooks({ restoreSelection, takeUndoBoundary }),
    )
    h.beginE2EActivity.mockImplementation(() => {
      order.push('begin')
      return () => order.push('complete')
    })
    register(
      'table-align-center',
      vi.fn(() => order.push('run')),
    )
    placeCaretInSurface()
    runEditorAction('table-align-center')
    expect(restoreSelection).toHaveBeenCalledWith('table-align-center')
    expect(takeUndoBoundary).toHaveBeenCalledWith('table-align-center')
    expect(h.beginE2EActivity).toHaveBeenCalledWith(
      'editor-action:table-align-center',
    )
    expect(order).toEqual(['restore', 'boundary', 'begin', 'run', 'complete'])
  })

  it('reports a failing runner and still completes its E2E activity', () => {
    const error = new Error('boom')
    register(
      'heading-3',
      vi.fn(() => {
        throw error
      }),
    )
    placeCaretInSurface()
    expect(() => runEditorAction('heading-3')).not.toThrow()
    expect(h.markE2EError).toHaveBeenCalledWith(
      'editor-action:heading-3',
      error,
    )
    expect(h.reportError).toHaveBeenCalledWith(
      error,
      'editor-action heading-3 failed',
    )
    expect(h.completeActivity).toHaveBeenCalledTimes(1)
  })

  it('unregisters a runner and restores the no-op hooks', () => {
    const restoreSelection = vi.fn()
    const resetHooks = configureEditorActionHooks({ restoreSelection })
    const run = vi.fn()
    const unregister = registerEditorActionRunner('fold', run)
    unregister()
    resetHooks()
    placeCaretInSurface()
    runEditorAction('fold')
    expect(run).not.toHaveBeenCalled()
    const replacement = register('fold')
    runEditorAction('fold')
    expect(replacement).toHaveBeenCalledTimes(1)
    expect(restoreSelection).not.toHaveBeenCalled()
  })
})
