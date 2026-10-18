// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Disposables } from '../util/disposables'

// Task 661: the toolbar rows, collapse state and overflow flow install once per toolbar element,
// before the first paint of a streamed open and at the same spot for every other open.
const m = vi.hoisted(() => {
  const calls: string[] = []
  const record = (name: string) =>
    vi.fn((..._args: unknown[]) => {
      calls.push(name)
      return vi.fn()
    })
  return {
    calls,
    ensureToolbarRows: record('rows'),
    guardToolbarScroll: record('guard'),
    installEscapeToolbar: record('escape'),
    refreshToolbarRoving: record('roving'),
    installToolbarCollapse: record('collapse'),
    installToolbarOverflow: record('overflow'),
    toolbarState: { element: undefined as HTMLElement | undefined },
  }
})
const {
  calls,
  ensureToolbarRows,
  guardToolbarScroll,
  installEscapeToolbar,
  refreshToolbarRoving,
  installToolbarCollapse,
  installToolbarOverflow,
  toolbarState,
} = m

vi.mock('../chrome/toolbar-layout', () => ({
  ensureToolbarRows: m.ensureToolbarRows,
}))
vi.mock('../chrome/toolbar-scroll-guard', () => ({
  guardToolbarScroll: m.guardToolbarScroll,
}))
vi.mock('../chrome/toolbar-collapse', () => ({
  installToolbarCollapse: m.installToolbarCollapse,
}))
vi.mock('../chrome/toolbar-overflow', () => ({
  installToolbarOverflow: m.installToolbarOverflow,
}))
vi.mock('../editing/escape-toolbar', () => ({
  installEscapeToolbar: m.installEscapeToolbar,
  refreshToolbarRoving: m.refreshToolbarRoving,
}))
vi.mock('../util/inner-vditor', () => ({
  innerVditor: () => ({ toolbar: { element: m.toolbarState.element } }),
}))

import { installToolbarFlow } from './toolbar-flow-install'

describe('installToolbarFlow', () => {
  beforeEach(() => {
    calls.length = 0
    for (const mock of [
      ensureToolbarRows,
      guardToolbarScroll,
      installEscapeToolbar,
      refreshToolbarRoving,
      installToolbarCollapse,
      installToolbarOverflow,
    ])
      mock.mockClear()
    toolbarState.element = document.createElement('div')
    ;(window as unknown as { vditor: unknown }).vditor = {}
  })

  it('(e) installs rows, guard, escape, roving, collapse and overflow in order and registers the observers', () => {
    const observers = new Disposables()
    const set = vi.spyOn(observers, 'set')
    installToolbarFlow(observers)
    expect(calls).toEqual([
      'rows',
      'guard',
      'escape',
      'roving',
      'collapse',
      'overflow',
    ])
    expect(set.mock.calls.map(([key]) => key)).toEqual([
      'escape-toolbar',
      'toolbar-collapse',
      'toolbar-overflow',
    ])
    expect(installToolbarOverflow).toHaveBeenCalledWith(
      toolbarState.element,
      refreshToolbarRoving,
    )
  })

  it('(i) builds the rows before the collapse state and the first overflow measurement', () => {
    installToolbarFlow(new Disposables())
    const order = (mock: { mock: { invocationCallOrder: number[] } }) =>
      mock.mock.invocationCallOrder[0]
    expect(order(ensureToolbarRows)).toBeLessThan(order(installToolbarCollapse))
    expect(order(installToolbarCollapse)).toBeLessThan(
      order(installToolbarOverflow),
    )
  })

  it('(f) a second call for the same toolbar element changes nothing', () => {
    const observers = new Disposables()
    installToolbarFlow(observers)
    installToolbarFlow(observers)
    for (const mock of [
      ensureToolbarRows,
      guardToolbarScroll,
      installEscapeToolbar,
      refreshToolbarRoving,
      installToolbarCollapse,
      installToolbarOverflow,
    ])
      expect(mock).toHaveBeenCalledTimes(1)
  })

  it('(g) a new toolbar element (re-init) installs again', () => {
    const observers = new Disposables()
    installToolbarFlow(observers)
    toolbarState.element = document.createElement('div')
    installToolbarFlow(observers)
    expect(ensureToolbarRows).toHaveBeenCalledTimes(2)
    expect(installToolbarOverflow).toHaveBeenCalledTimes(2)
  })

  it('(h) without a toolbar only the escape-toolbar observer is set', () => {
    toolbarState.element = undefined
    const observers = new Disposables()
    const set = vi.spyOn(observers, 'set')
    installToolbarFlow(observers)
    expect(set.mock.calls.map(([key]) => key)).toEqual(['escape-toolbar'])
    expect(calls).toEqual(['escape'])
  })
})
