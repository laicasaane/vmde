import { describe, it, expect, vi } from 'vitest'
import { installVditorHistoryCoupling } from './undo-keybind'

const clearTableCellSelections = vi.hoisted(() => vi.fn())
vi.mock('./table-cell-selection', () => ({ clearTableCellSelections }))

describe('installVditorHistoryCoupling', () => {
  it('wraps undo and redo with the exact before/after Markdown transition', () => {
    let value = 'after edit'
    const inner = {
      undo: {
        undo: vi.fn((_inner: unknown) => {
          value = 'before edit'
        }),
        redo: vi.fn((_inner: unknown) => {
          value = 'after edit'
        }),
      },
    }
    const post = vi.fn()
    const win = {
      vditor: { vditor: inner, getValue: () => value },
    } as any

    installVditorHistoryCoupling(win, post)
    inner.undo.undo(inner)
    inner.undo.redo(inner)

    expect(post.mock.calls.map(([message]) => message)).toEqual([
      {
        command: 'history-transition',
        kind: 'undo',
        before: 'after edit',
        after: 'before edit',
      },
      {
        command: 'history-transition',
        kind: 'redo',
        before: 'before edit',
        after: 'after edit',
      },
    ])
  })

  it('is idempotent and does not couple an empty history step', () => {
    const post = vi.fn()
    const undo = vi.fn()
    const inner = {
      undo: { undo, redo: vi.fn() },
    }
    const win = {
      vditor: { vditor: inner, getValue: () => 'unchanged' },
    } as any

    installVditorHistoryCoupling(win, post)
    installVditorHistoryCoupling(win, post)
    inner.undo.undo(inner)

    expect(undo).toHaveBeenCalledTimes(1)
    expect(post).not.toHaveBeenCalled()
  })
})

// Task 580 CP2-3: the table rectangle clears on the undo/redo path, not on the Z/Y keys, so the
// command, toolbar and any rebound key all drop it before the engine rewrites the DOM.
describe('installVditorHistoryCoupling table rectangle', () => {
  it('clears every table-cell rectangle before each undo and redo engine call', () => {
    clearTableCellSelections.mockClear()
    const order: string[] = []
    clearTableCellSelections.mockImplementation(() => order.push('clear'))
    const inner = {
      undo: {
        undo: vi.fn((_inner: unknown) => order.push('undo')),
        redo: vi.fn((_inner: unknown) => order.push('redo')),
      },
    }
    const win = { vditor: { vditor: inner, getValue: () => 'same' } } as any

    installVditorHistoryCoupling(win, vi.fn())
    inner.undo.undo(inner)
    inner.undo.redo(inner)

    expect(order).toEqual(['clear', 'undo', 'clear', 'redo'])
  })
})

describe('undo-keybind module surface', () => {
  it('no longer matches Z/Y keys in the webview (VS Code keybindings own them)', async () => {
    const mod = await import('./undo-keybind')
    expect(Object.keys(mod)).toEqual(['installVditorHistoryCoupling'])
  })
})
