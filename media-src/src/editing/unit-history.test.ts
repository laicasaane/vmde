// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { historyStoreOf } from './history-store'
import { requestCaret } from './caret'
import { installUnitHistory } from './unit-history'
import type { HistoryCapture } from '../util/unit-changes'

// Task 733 (task 004): the unit engine against a fake model port and a fake delta publisher. The
// engine keeps entries (captures, caret intents, native-step counts), restores them through the port,
// publishes one history delta per Undo or Redo, and answers the history store for a claimed inner
// Vditor. The engine does not exist before task 004's implementation segment, so these tests fail on
// the missing module and the missing `window.__vmdeUnitHistory` hook.

const engine = vi.hoisted(() => ({ value: 'unit' as 'unit' | 'vditor' }))
vi.mock('./history-store', async (original) => ({
  ...(await original<typeof import('./history-store')>()),
  get IR_HISTORY_ENGINE() {
    return engine.value
  },
}))
vi.mock('./caret', async (original) => ({
  ...(await original<typeof import('./caret')>()),
  requestCaret: vi.fn(() => true),
}))

interface Hook {
  claims(vditor: unknown): boolean
  undo(vditor: unknown): void
  redo(vditor: unknown): void
  record(vditor: unknown): void
  recordFirstPosition(vditor: unknown, event: Event): void
  clear(vditor: unknown): void
  resetIcon(vditor: unknown): void
  seedBaseline(vditor: unknown, event?: Event): boolean
}
const hookOf = () =>
  (window as unknown as { __vmdeUnitHistory: Hook }).__vmdeUnitHistory

const slot = () => ({
  hasUndo: false,
  lastText: '',
  redoStack: [],
  undoStack: [],
})

/** A capture stands for one DOM change; the engine treats it as opaque. */
const cap = (name: string) => ({ name }) as unknown as HistoryCapture

let uninstall: (() => void) | undefined

function rig(options: { port?: boolean } = {}) {
  const root = document.createElement('div')
  root.className = 'vditor-reset vditor-ir'
  root.setAttribute('contenteditable', 'true')
  root.innerHTML = '<p>first</p><p>second</p><p>third</p>'
  document.body.appendChild(root)
  const button = (): HTMLElement => {
    const wrap = document.createElement('div')
    wrap.appendChild(document.createElement('button'))
    return wrap
  }
  const vditor = {
    currentMode: 'ir',
    ir: { element: root, composingLock: false, processTimeoutId: undefined },
    undo: { ir: slot(), sv: slot(), wysiwyg: slot() },
    toolbar: { elements: { undo: button(), redo: button() } },
    options: {},
  }
  const state = {
    captures: [] as Array<HistoryCapture | undefined>,
    restores: [] as Array<[HistoryCapture, 'before' | 'after']>,
    restoreResult: true,
    pending: false,
    ready: true,
    claimable: true,
    published: [] as Array<['undo' | 'redo', number]>,
    publishResult: 'delta' as 'delta' | 'nothing' | 'fallback',
    sequence: 0,
    epoch: 1 as number | undefined,
  }
  const port =
    options.port === false
      ? undefined
      : {
          ready: () => state.ready,
          claimable: () => state.claimable,
          pending: () => state.pending,
          capture: () => state.captures.shift(),
          restore: (c: HistoryCapture, side: 'before' | 'after') => {
            state.restores.push([c, side])
            return state.restoreResult
          },
        }
  uninstall = installUnitHistory(window, {
    port: () => port as never,
    publishHistory: (kind, steps) => {
      state.published.push([kind, steps])
      return state.publishResult
    },
    lastPostedSequence: () => state.sequence,
    epoch: () => state.epoch,
  })
  const hook = hookOf()
  const names = (list: Array<[HistoryCapture, string]>) =>
    list.map(([c, side]) => [(c as unknown as { name: string }).name, side])
  /** Records an entry for `capture`; the first call only creates the base. */
  const record = (capture?: HistoryCapture) => {
    state.captures.push(capture)
    hook.record(vditor)
  }
  const caretAt = (index: number, offset: number) => {
    const text = root.querySelectorAll('p')[index].firstChild as Text
    const range = document.createRange()
    range.setStart(text, offset)
    range.collapse(true)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
  }
  return { root, vditor, state, hook, names, record, caretAt }
}

beforeEach(() => {
  engine.value = 'unit'
  vi.mocked(requestCaret).mockClear()
})
afterEach(() => {
  uninstall?.()
  uninstall = undefined
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

describe('claims', () => {
  it('is true in IR with the unit engine and a port', () => {
    const r = rig()
    expect(r.hook.claims(r.vditor)).toBe(true)
  })
  it('is false outside IR', () => {
    const r = rig()
    for (const mode of ['wysiwyg', 'sv']) {
      r.vditor.currentMode = mode
      expect(r.hook.claims(r.vditor)).toBe(false)
    }
  })
  it("is false when the engine is 'vditor'", () => {
    const r = rig()
    engine.value = 'vditor'
    expect(r.hook.claims(r.vditor)).toBe(false)
  })
  it('is false without a port (no model session in this init)', () => {
    const r = rig({ port: false })
    expect(r.hook.claims(r.vditor)).toBe(false)
  })
  it('keeps claiming while the port is not ready, so the engines never alternate inside one history', () => {
    const r = rig()
    r.state.ready = false
    expect(r.hook.claims(r.vditor)).toBe(true)
  })
  it('reads the state at every call', () => {
    const r = rig()
    expect(r.hook.claims(r.vditor)).toBe(true)
    engine.value = 'vditor'
    expect(r.hook.claims(r.vditor)).toBe(false)
    engine.value = 'unit'
    expect(r.hook.claims(r.vditor)).toBe(true)
  })
  it('uninstalling removes the hook', () => {
    rig()
    uninstall?.()
    uninstall = undefined
    expect(hookOf()).toBeUndefined()
  })
})

describe('stacks', () => {
  it('records three entries; undo twice and redo once restore in order', () => {
    const r = rig()
    r.record() // the base
    const [a, b, c] = [cap('A'), cap('B'), cap('C')]
    for (const capture of [a, b, c]) r.record(capture)
    r.hook.undo(r.vditor)
    r.hook.undo(r.vditor)
    r.hook.redo(r.vditor)
    expect(r.names(r.state.restores)).toEqual([
      ['C', 'before'],
      ['B', 'before'],
      ['B', 'after'],
    ])
    expect(r.state.published.map(([kind]) => kind)).toEqual([
      'undo',
      'undo',
      'redo',
    ])
  })

  it('the first record only creates the base: no entry, an empty-history report', () => {
    const r = rig()
    const store = historyStoreOf(r.vditor)
    const seen: boolean[] = []
    store?.onEntryRecorded((entry) => seen.push(entry.wasEmpty))
    r.record()
    expect(seen).toEqual([true])
    expect(store?.top()).toBeUndefined()
    r.hook.undo(r.vditor)
    expect(r.state.restores).toEqual([])
  })

  it('a record with nothing captured adds no entry', () => {
    const r = rig()
    r.record()
    const store = historyStoreOf(r.vditor)
    const revision = store?.revision()
    r.record(undefined)
    expect(store?.top()).toBeUndefined()
    expect(store?.revision()).toBe(revision)
  })

  it('a new record after an Undo clears Redo', () => {
    const r = rig()
    r.record()
    r.record(cap('A'))
    r.record(cap('B'))
    r.hook.undo(r.vditor)
    r.record(cap('C'))
    r.hook.redo(r.vditor)
    expect(r.names(r.state.restores)).toEqual([['B', 'before']])
  })

  it('Undo of a pending change records it first, so it gets its own entry', () => {
    const r = rig()
    r.record()
    r.record(cap('A'))
    r.state.captures.push(cap('P')) // a change made since the last record
    r.hook.undo(r.vditor)
    expect(r.names(r.state.restores)).toEqual([['P', 'before']])
  })

  it('keeps at most 50 entries', () => {
    const r = rig()
    r.record()
    for (let i = 0; i < 60; i++) r.record(cap(`E${i}`))
    for (let i = 0; i < 60; i++) r.hook.undo(r.vditor)
    expect(r.state.restores).toHaveLength(50)
    expect(r.names(r.state.restores)[49]).toEqual(['E10', 'before'])
  })

  it('does nothing while the root is not editable or a composition runs', () => {
    const r = rig()
    r.record()
    r.record(cap('A'))
    r.root.setAttribute('contenteditable', 'false')
    r.hook.undo(r.vditor)
    r.root.setAttribute('contenteditable', 'true')
    r.vditor.ir.composingLock = true
    r.hook.undo(r.vditor)
    expect(r.state.restores).toEqual([])
    expect(r.state.published).toEqual([])
  })

  it('the toolbar enables Undo with one entry above the base and Redo after an Undo', () => {
    const r = rig()
    const disabled = (name: 'undo' | 'redo') =>
      r.vditor.toolbar.elements[name].children[0].classList.contains(
        'vditor-menu--disabled',
      )
    r.record()
    r.hook.resetIcon(r.vditor)
    expect(disabled('undo')).toBe(true)
    r.record(cap('A'))
    expect(disabled('undo')).toBe(false)
    expect(disabled('redo')).toBe(true)
    r.hook.undo(r.vditor)
    expect(disabled('redo')).toBe(false)
  })
})

describe('steps', () => {
  /** The entry flush of the store listener posts `count` deltas, as the checkpoint flush does. */
  function flushDeltas(r: ReturnType<typeof rig>, count: number) {
    historyStoreOf(r.vditor)?.onEntryRecorded(() => {
      r.state.sequence += count
    })
  }

  it('same epoch: the sequence difference between open and close, read after the listener flush', () => {
    const r = rig()
    r.state.sequence = 4
    r.record() // base: open sequence 4
    flushDeltas(r, 2)
    r.record(cap('A'))
    r.hook.undo(r.vditor)
    expect(r.state.published).toEqual([['undo', 2]])
  })

  it('another epoch: no native count is known, so the host walks the minimum of 1 step', () => {
    const r = rig()
    r.state.sequence = 4
    r.record()
    flushDeltas(r, 2)
    r.record(cap('A'))
    r.state.epoch = 2
    r.hook.undo(r.vditor)
    expect(r.state.published).toEqual([['undo', 1]])
  })

  it('an entry with only whole-text posts (a count of 0) sends steps 1: a history delta always carries steps >= 1', () => {
    const r = rig()
    r.record()
    r.record(cap('A'))
    r.hook.undo(r.vditor)
    r.hook.redo(r.vditor)
    expect(r.state.published).toEqual([
      ['undo', 1],
      ['redo', 1],
    ])
  })

  it('an epoch change without a rebuild keeps the entries', () => {
    const r = rig()
    r.record()
    r.record(cap('A'))
    r.state.epoch = 3
    r.hook.undo(r.vditor)
    expect(r.names(r.state.restores)).toEqual([['A', 'before']])
  })

  it('the open state moves with each Undo: the next entry counts from the sequence after the restore', () => {
    const r = rig()
    r.state.sequence = 1
    r.record()
    r.record(cap('A'))
    r.state.sequence = 5 // the Undo published deltas
    r.hook.undo(r.vditor)
    flushDeltas(r, 3)
    r.record(cap('B'))
    r.hook.undo(r.vditor)
    expect(r.state.published.at(-1)).toEqual(['undo', 3])
  })
})

describe('publication results', () => {
  it("'nothing' (the restore changed no text): no throw, the entry still moves to Redo", () => {
    const r = rig()
    r.record()
    r.record(cap('A'))
    r.state.publishResult = 'nothing'
    expect(() => r.hook.undo(r.vditor)).not.toThrow()
    r.hook.redo(r.vditor)
    expect(r.names(r.state.restores)).toEqual([
      ['A', 'before'],
      ['A', 'after'],
    ])
  })

  it("'fallback' (whole-text went out): the entry still moves to Redo", () => {
    const r = rig()
    r.record()
    r.record(cap('A'))
    r.state.publishResult = 'fallback'
    r.hook.undo(r.vditor)
    r.hook.redo(r.vditor)
    expect(r.state.restores).toHaveLength(2)
  })
})

describe('drops', () => {
  it('a mode switch and a return to IR drop both stacks', () => {
    const r = rig()
    r.record()
    r.record(cap('A'))
    r.record(cap('B'))
    r.hook.undo(r.vditor)
    r.vditor.currentMode = 'wysiwyg'
    expect(r.hook.claims(r.vditor)).toBe(false)
    r.vditor.currentMode = 'ir'
    expect(r.hook.claims(r.vditor)).toBe(true)
    r.state.restores.length = 0
    r.hook.undo(r.vditor)
    r.hook.redo(r.vditor)
    expect(r.state.restores).toEqual([])
  })

  it('clear gives an empty history in a new slot', () => {
    const r = rig()
    r.record()
    r.record(cap('A'))
    const store = historyStoreOf(r.vditor)
    const before = store?.slot()
    r.hook.clear(r.vditor)
    expect(store?.slot()).not.toBe(before)
    expect(store?.isEmpty()).toBe(true)
    r.hook.undo(r.vditor)
    expect(r.state.restores).toEqual([])
  })
})

describe('caret', () => {
  it('Undo requests the caret recorded before the entry and Redo the caret after it, after the restore', () => {
    const r = rig()
    r.caretAt(0, 0)
    r.record() // base caret: paragraph 0, offset 0
    r.caretAt(1, 3)
    r.record(cap('A'))
    r.hook.undo(r.vditor)
    expect(requestCaret).toHaveBeenLastCalledWith(
      expect.objectContaining({ blockPath: [0], offsetInBlock: 0 }),
    )
    r.hook.redo(r.vditor)
    expect(requestCaret).toHaveBeenLastCalledWith(
      expect.objectContaining({ blockPath: [1], offsetInBlock: 3 }),
    )
    expect(requestCaret).toHaveBeenCalledTimes(2)
  })

  it('a non-collapsed selection is kept as anchor and focus', () => {
    const r = rig()
    r.caretAt(0, 0)
    r.record()
    const first = r.root.querySelectorAll('p')[1].firstChild as Text
    const range = document.createRange()
    range.setStart(first, 1)
    range.setEnd(first, 4)
    window.getSelection()?.removeAllRanges()
    window.getSelection()?.addRange(range)
    r.record(cap('A'))
    r.hook.undo(r.vditor)
    r.hook.redo(r.vditor)
    expect(requestCaret).toHaveBeenLastCalledWith(
      expect.objectContaining({
        anchor: expect.objectContaining({ blockPath: [1], offsetInBlock: 1 }),
        focus: expect.objectContaining({ blockPath: [1], offsetInBlock: 4 }),
      }),
    )
  })

  it('never writes a caret marker into the DOM', () => {
    const r = rig()
    r.caretAt(1, 2)
    r.record()
    r.record(cap('A'))
    r.hook.undo(r.vditor)
    expect(r.root.querySelector('wbr')).toBeNull()
    expect(r.root.innerHTML).not.toContain('VDITOR-CARET')
  })
})

describe('refused restore', () => {
  it('empties both stacks, posts nothing and logs one count-only line', () => {
    const lines: string[] = []
    for (const method of ['debug', 'info', 'log', 'warn'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        lines.push(args.map(String).join(' '))
      })
    }
    const r = rig()
    r.root.querySelector('p')!.textContent = 'secret-word'
    r.record()
    r.record(cap('A'))
    r.record(cap('B'))
    r.state.restoreResult = false
    r.hook.undo(r.vditor)
    expect(r.state.published).toEqual([])
    const store = historyStoreOf(r.vditor)
    expect(store?.top()).toBeUndefined()
    expect(store?.redoTop()).toBeUndefined()
    r.state.restoreResult = true
    r.state.restores.length = 0
    r.hook.undo(r.vditor)
    r.hook.redo(r.vditor)
    expect(r.state.restores).toEqual([])
    const refused = lines.filter((l) =>
      l.includes('[unit-history] restore refused'),
    )
    expect(refused).toHaveLength(1)
    expect(lines.join('\n')).not.toContain('secret-word')
  })
})

describe('first position and seed', () => {
  it('seedBaseline creates the base once and refuses a second time', () => {
    const r = rig()
    expect(r.hook.seedBaseline(r.vditor)).toBe(true)
    expect(r.hook.seedBaseline(r.vditor)).toBe(false)
  })

  it('recordFirstPosition rewrites the base caret while the history is empty and not during a composition', () => {
    const r = rig()
    r.caretAt(0, 0)
    r.record()
    r.caretAt(2, 1)
    r.vditor.ir.composingLock = true
    r.hook.recordFirstPosition(r.vditor, new KeyboardEvent('keydown'))
    r.vditor.ir.composingLock = false
    r.hook.recordFirstPosition(r.vditor, new KeyboardEvent('keydown'))
    r.caretAt(1, 1)
    r.record(cap('A'))
    r.hook.undo(r.vditor)
    expect(requestCaret).toHaveBeenLastCalledWith(
      expect.objectContaining({ blockPath: [2], offsetInBlock: 1 }),
    )
  })
})

describe('store delegation', () => {
  it('top, redoTop, base and slot are engine tokens that change with the history', () => {
    const r = rig()
    const store = historyStoreOf(r.vditor)
    r.record()
    const base = store?.base()
    expect(base).toBeDefined()
    expect(store?.top()).toBeUndefined()
    r.record(cap('A'))
    const first = store?.top()
    expect(first).toBeDefined()
    expect(first).not.toBe(base)
    r.record(cap('B'))
    expect(store?.top()).not.toBe(first)
    r.hook.undo(r.vditor)
    expect(store?.top()).toBe(first)
    expect(store?.redoTop()).toBeDefined()
    // The old engine's slots are not written.
    expect(r.vditor.undo.ir.undoStack).toEqual([])
  })

  it('the revision grows on a record, an Undo and a Redo; baseSnapshot is undefined for unit entries', () => {
    const r = rig()
    const store = historyStoreOf(r.vditor)
    r.record()
    r.record(cap('A'))
    const top = store?.top()
    const revisions = [store?.revision()]
    r.hook.undo(r.vditor)
    revisions.push(store?.revision())
    r.hook.redo(r.vditor)
    revisions.push(store?.revision())
    expect(revisions[1]).toBeGreaterThan(revisions[0] as number)
    expect(revisions[2]).toBeGreaterThan(revisions[1] as number)
    expect(store?.baseSnapshot(top as never)).toBeUndefined()
  })

  it('isSourceNeutral reads no innerHTML and follows the port pending state', () => {
    const r = rig()
    const store = historyStoreOf(r.vditor)
    r.record()
    const read = vi.spyOn(Element.prototype, 'innerHTML', 'get')
    expect(store?.isSourceNeutral()).toBe(true)
    r.state.pending = true
    expect(store?.isSourceNeutral()).toBe(false)
    expect(read).not.toHaveBeenCalled()
  })

  it('amendTopCaret keeps the entry token: unchanged for the same caret, coalesced for a moved one', () => {
    const r = rig()
    const store = historyStoreOf(r.vditor)
    r.caretAt(0, 0)
    r.record()
    r.caretAt(1, 1)
    r.record(cap('A'))
    const top = store?.top()
    expect(store?.amendTopCaret()).toBe('unchanged')
    r.caretAt(1, 4)
    expect(store?.amendTopCaret()).toBe('coalesced')
    expect(store?.top()).toBe(top)
    r.hook.redo(r.vditor)
    r.hook.undo(r.vditor)
    r.hook.redo(r.vditor)
    expect(requestCaret).toHaveBeenLastCalledWith(
      expect.objectContaining({ blockPath: [1], offsetInBlock: 4 }),
    )
  })

  it('a pending change refuses an amend unless the source is unchanged', () => {
    const r = rig()
    const store = historyStoreOf(r.vditor)
    r.record()
    r.record(cap('A'))
    r.state.pending = true
    expect(store?.amendTopCaret()).toBe('refused')
  })

  it('a savepoint restores the stacks it saw and is refused after a clear', () => {
    const r = rig()
    const store = historyStoreOf(r.vditor)
    r.record()
    r.record(cap('A'))
    const savepoint = store?.savepoint()
    r.record(cap('B'))
    expect(store?.restore(savepoint as never)).toBe(true)
    expect(store?.top()).toBeDefined()
    r.hook.clear(r.vditor)
    expect(store?.restore(savepoint as never)).toBe(false)
  })

  it('the engine reports each recorded entry to the store listeners with the slot', () => {
    const r = rig()
    const store = historyStoreOf(r.vditor)
    const seen: Array<{ wasEmpty: boolean; mode: string }> = []
    store?.onEntryRecorded((entry) =>
      seen.push({ wasEmpty: entry.wasEmpty, mode: entry.mode }),
    )
    r.record()
    r.record(cap('A'))
    expect(seen).toEqual([
      { wasEmpty: true, mode: 'ir' },
      { wasEmpty: false, mode: 'ir' },
    ])
  })
})

// Review repair (F1): a model that is off for a permanent reason observes nothing, so the unit engine
// could not record an edit. The old engine must then hold the history.
describe('claims while the model is off for a permanent reason', () => {
  it('is false when the port is not claimable, and the old IR slot is reset on the hand-over', () => {
    const r = rig()
    r.record()
    r.record(cap('A'))
    expect(r.hook.claims(r.vditor)).toBe(true)
    r.vditor.undo.ir.undoStack.push(['stale'])
    r.state.claimable = false
    expect(r.hook.claims(r.vditor)).toBe(false)
    expect(r.vditor.undo.ir).toEqual({
      hasUndo: false,
      lastText: '',
      redoStack: [],
      undoStack: [],
    })
    expect(historyStoreOf(r.vditor)?.isEmpty()).toBe(true)
  })

  it('claims again, with an empty history, when the model comes back', () => {
    const r = rig()
    r.record()
    r.record(cap('A'))
    r.state.claimable = false
    r.hook.claims(r.vditor)
    r.state.claimable = true
    expect(r.hook.claims(r.vditor)).toBe(true)
    r.hook.undo(r.vditor)
    expect(r.state.restores).toEqual([])
  })
})

// Review repair (F5): a pending change the caller says leaves the source unchanged.
describe('amendTopCaret with a pending change', () => {
  it('refuses when the source may have changed', () => {
    const r = rig()
    r.record()
    r.record(cap('A'))
    r.state.pending = true
    expect(historyStoreOf(r.vditor)?.amendTopCaret()).toBe('refused')
    expect(r.state.captures).toEqual([])
  })

  it('a view-only pending change (the port captures nothing) is no entry', () => {
    const r = rig()
    r.record()
    r.record(cap('A'))
    r.state.pending = true
    const store = historyStoreOf(r.vditor)
    const top = store?.top()
    r.caretAt(1, 2)
    expect(store?.amendTopCaret({ sourceUnchanged: true })).toBe('coalesced')
    expect(store?.top()).toBe(top)
  })

  it('a real pending change becomes an entry of its own', () => {
    const r = rig()
    r.record()
    r.record(cap('A'))
    r.state.pending = true
    r.state.captures.push(cap('B'))
    const store = historyStoreOf(r.vditor)
    const top = store?.top()
    expect(store?.amendTopCaret({ sourceUnchanged: true })).toBe('coalesced')
    expect(store?.top()).not.toBe(top)
    r.state.pending = false
    r.hook.undo(r.vditor)
    expect(r.names(r.state.restores)).toEqual([['B', 'before']])
  })
})

// Review repair (F6): the caret before the first change is unknown when the base is created with it.
describe('the first entry', () => {
  it('Undo of an entry recorded together with the base requests no caret', () => {
    const r = rig()
    r.caretAt(1, 3)
    r.record(cap('A')) // base and first entry in one record
    r.hook.undo(r.vditor)
    expect(r.names(r.state.restores)).toEqual([['A', 'before']])
    expect(requestCaret).not.toHaveBeenCalled()
  })
})
