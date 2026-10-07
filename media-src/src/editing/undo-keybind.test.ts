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

// Task 601: the injected preparation settles a pending edit before `before` is read, once per
// engine call, for Undo and Redo alike.
describe('installVditorHistoryCoupling preparation', () => {
  it('prepares once before reading the start value and calling the engine', () => {
    const order: string[] = []
    let value = 'X'
    const inner = {
      undo: {
        undo: vi.fn((_inner: unknown) => {
          order.push('undo')
          value = 'X'
        }),
        redo: vi.fn((_inner: unknown) => {
          order.push('redo')
          value = 'XW'
        }),
      },
    }
    const prepare = vi.fn((target: unknown) => {
      order.push('prepare')
      expect(target).toBe(inner)
      value = 'XW'
      return true
    })
    const post = vi.fn((message: { kind: string }) =>
      order.push(`post:${message.kind}`),
    )
    const win = {
      vditor: {
        vditor: inner,
        getValue: () => {
          order.push('getValue')
          return value
        },
      },
    } as any

    installVditorHistoryCoupling(win, post, prepare)
    inner.undo.undo(inner)

    expect(order).toEqual([
      'prepare',
      'getValue',
      'undo',
      'getValue',
      'post:undo',
    ])
    expect(post).toHaveBeenCalledWith({
      command: 'history-transition',
      kind: 'undo',
      before: 'XW',
      after: 'X',
    })
    order.length = 0
    prepare.mockImplementation(() => {
      order.push('prepare')
      return true
    })
    inner.undo.redo(inner)
    expect(order).toEqual([
      'prepare',
      'getValue',
      'redo',
      'getValue',
      'post:redo',
    ])
    expect(prepare).toHaveBeenCalledTimes(2)
  })
})

describe('installVditorHistoryCoupling refusal', () => {
  it('makes no engine call and posts nothing when preparation refuses', () => {
    const undo = vi.fn()
    const redo = vi.fn()
    const inner = { undo: { undo, redo } }
    const post = vi.fn()
    const getValue = vi.fn(() => 'value')
    const win = { vditor: { vditor: inner, getValue } } as any
    installVditorHistoryCoupling(win, post, () => false)
    expect(inner.undo.undo(inner)).toBeUndefined()
    inner.undo.redo(inner)
    expect(undo).not.toHaveBeenCalled()
    expect(redo).not.toHaveBeenCalled()
    expect(getValue).not.toHaveBeenCalled()
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

// Task 602: entry reports drive the checkpoint flush and the history base; transitions use the
// injected text form.
describe('installVditorHistoryCoupling entry reports', () => {
  function engine(mode = 'ir') {
    let value = 'base'
    const slot = { undoStack: [] as unknown[] }
    const order: string[] = []
    const undo: any = {
      ir: slot,
      sv: slot,
      addToUndoStack: vi.fn((_inner: unknown) => {
        if (value !== slot.undoStack.at(-1)) slot.undoStack.push(value)
      }),
      vmdeSeedBaseline: vi.fn((_inner: unknown) => {
        if (slot.undoStack.length) return false
        slot.undoStack.push(value)
        return true
      }),
      undo: vi.fn(),
      redo: vi.fn(),
    }
    const inner = { currentMode: mode, undo }
    const win = {
      vditor: { vditor: inner, getValue: () => `${value}\n` },
    } as any
    const onEntryRecorded = vi.fn(() => order.push('entry'))
    const onHistoryBase = vi.fn((_mode: string, _content: string) =>
      order.push('base'),
    )
    return {
      inner,
      undo,
      slot,
      win,
      order,
      onEntryRecorded,
      onHistoryBase,
      set: (next: string) => {
        value = next
      },
    }
  }

  it('reports each recorded entry, and the first entry of an empty stack as the base after it', () => {
    const e = engine()
    installVditorHistoryCoupling(e.win, vi.fn(), () => true, {
      onEntryRecorded: e.onEntryRecorded,
      onHistoryBase: e.onHistoryBase,
    })

    e.undo.addToUndoStack(e.inner)
    e.set('edited')
    e.undo.addToUndoStack(e.inner)

    expect(e.order).toEqual(['entry', 'base', 'entry'])
    expect(e.onHistoryBase).toHaveBeenCalledExactlyOnceWith('ir', 'base\n')
  })

  it('reports nothing when Vditor records no new entry', () => {
    const e = engine()
    installVditorHistoryCoupling(e.win, vi.fn(), () => true, {
      onEntryRecorded: e.onEntryRecorded,
      onHistoryBase: e.onHistoryBase,
    })
    e.undo.addToUndoStack(e.inner)
    e.order.length = 0

    e.undo.addToUndoStack(e.inner)
    expect(e.undo.vmdeSeedBaseline(e.inner)).toBe(false)

    expect(e.order).toEqual([])
  })

  it('reports the Task 598 seed as the base', () => {
    const e = engine('sv')
    installVditorHistoryCoupling(e.win, vi.fn(), () => true, {
      readText: () => 'sv host form',
      onEntryRecorded: e.onEntryRecorded,
      onHistoryBase: e.onHistoryBase,
    })

    expect(e.undo.vmdeSeedBaseline(e.inner)).toBe(true)

    expect(e.order).toEqual(['entry', 'base'])
    expect(e.onHistoryBase).toHaveBeenCalledWith('sv', 'sv host form')
  })

  it('reads transitions through the injected text form', () => {
    const e = engine('sv')
    const post = vi.fn()
    let text = 'after'
    e.undo.undo = vi.fn(() => {
      text = 'before'
    })
    installVditorHistoryCoupling(e.win, post, () => true, {
      readText: () => text,
    })

    e.undo.undo(e.inner)

    expect(post).toHaveBeenCalledWith({
      command: 'history-transition',
      kind: 'undo',
      before: 'after',
      after: 'before',
    })
  })
})

describe('undo-keybind module surface', () => {
  it('no longer matches Z/Y keys in the webview (VS Code keybindings own them)', async () => {
    const mod = await import('./undo-keybind')
    expect(Object.keys(mod)).toEqual(['installVditorHistoryCoupling'])
  })
})
