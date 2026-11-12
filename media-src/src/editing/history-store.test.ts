import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'
import {
  type HistoryEntryToken,
  IR_HISTORY_ENGINE,
  historyStoreOf,
  type RecordedEntry,
} from './history-store'

// Task 003 — the old-engine adapter over a fake inner Vditor. The fake `undo` object has the
// fields of Vditor's `Undo` (per-mode slots with `undoStack`, `redoStack`, `lastText`, `hasUndo`;
// `addToUndoStack`, `undo`, `redo`, `clearStack`, `resetIcon`, `addCaret`, `dmp`) and the two
// build-patched members (`vmdeSeedBaseline`, `vmdeHeldTimer`). It holds no DOM: an entry is a
// diff-match-patch patch list, as in the engine, and the "document" is a string.

// diff-match-patch is Vditor's own dependency (its undo engine builds `undo.dmp` from it).
const DIFF_MATCH_PATCH = 'diff-match-patch'
const DiffMatchPatch = createRequire(import.meta.url)(DIFF_MATCH_PATCH)

interface Slot {
  undoStack: unknown[][]
  redoStack: unknown[][]
  lastText: string
  hasUndo: boolean
}

const freshSlot = (): Slot => ({
  undoStack: [],
  redoStack: [],
  lastText: '',
  hasUndo: true,
})

function fakeInner(initialText = 'ab') {
  const dmp = new DiffMatchPatch()
  // The text the next snapshot reads; `addCaret` returns it.
  const live = { text: initialText }
  const undo: any = {
    dmp,
    ir: freshSlot(),
    wysiwyg: freshSlot(),
    sv: freshSlot(),
    vmdeHeldTimer: undefined as number | undefined,
    addToUndoStack: vi.fn(function (this: any, inner: any) {
      const slot: Slot = this[inner.currentMode]
      const text = this.addCaret(inner)
      slot.undoStack.push(dmp.patch_make(text, slot.lastText))
      slot.lastText = text
      // Vditor's `stackSize`: the oldest entry is dropped past 50.
      if (slot.undoStack.length > 50) slot.undoStack.shift()
      if (slot.hasUndo) slot.redoStack = []
      else slot.hasUndo = true
    }),
    // The patched engine pushes the seed itself; it does not call `addToUndoStack`.
    vmdeSeedBaseline: vi.fn(function (this: any, inner: any) {
      const slot: Slot = this[inner.currentMode]
      if (slot.undoStack.length) return false
      const text = this.addCaret(inner)
      slot.undoStack.push(dmp.patch_make(text, slot.lastText))
      slot.lastText = text
      return true
    }),
    addCaret: vi.fn(() => live.text),
    undo: vi.fn(function (this: any, inner: any) {
      const slot: Slot = this[inner.currentMode]
      if (slot.undoStack.length < 2) return
      const top = slot.undoStack.pop() as unknown[]
      slot.redoStack.push(top)
      slot.lastText = dmp.patch_apply(top, slot.lastText)[0]
      slot.hasUndo = true
    }),
    redo: vi.fn(function (this: any, inner: any) {
      const slot: Slot = this[inner.currentMode]
      const state = slot.redoStack.pop()
      if (!state) return
      slot.undoStack.push(state)
      slot.lastText = live.text
    }),
    // Vditor's `resetStack`: each mode gets a new slot object.
    clearStack: vi.fn(function (this: any) {
      this.ir = freshSlot()
      this.wysiwyg = freshSlot()
      this.sv = freshSlot()
      this.resetIcon()
    }),
    resetIcon: vi.fn(),
  }
  const inner: any = { currentMode: 'ir', undo }
  // The store replaces engine methods with wrappers, so call counts are read from the originals.
  const spies = {
    addToUndoStack: undo.addToUndoStack,
    undo: undo.undo,
    redo: undo.redo,
    clearStack: undo.clearStack,
  }
  return { inner, undo, live, dmp, spies }
}

/** Record `count` entries of different text through the store. */
function pushEntries(
  f: ReturnType<typeof fakeInner>,
  store: ReturnType<typeof historyStoreOf> & {},
  texts: string[],
) {
  for (const text of texts) {
    f.live.text = text
    store.checkpoint()
  }
}

function storeOf(f: ReturnType<typeof fakeInner>) {
  const store = historyStoreOf(f.inner)
  if (!store) throw new Error('no store')
  return store
}

describe('historyStoreOf', () => {
  it('returns one store per inner object', () => {
    const f = fakeInner()
    expect(historyStoreOf(f.inner)).toBeDefined()
    expect(historyStoreOf(f.inner)).toBe(historyStoreOf(f.inner))
    expect(historyStoreOf(fakeInner().inner)).not.toBe(historyStoreOf(f.inner))
  })

  it('returns undefined without an undo object', () => {
    expect(historyStoreOf({ currentMode: 'ir' })).toBeUndefined()
    expect(
      historyStoreOf({ currentMode: 'ir', undo: undefined }),
    ).toBeUndefined()
    expect(historyStoreOf(undefined)).toBeUndefined()
    expect(historyStoreOf(null)).toBeUndefined()
  })

  it('keeps the old engine for IR', () => {
    expect(IR_HISTORY_ENGINE).toBe('vditor')
  })
})

describe('checkpoint and tokens', () => {
  it('checkpoint calls addToUndoStack once with the inner editor', () => {
    const f = fakeInner()
    storeOf(f).checkpoint()
    expect(f.spies.addToUndoStack).toHaveBeenCalledTimes(1)
    expect(f.spies.addToUndoStack).toHaveBeenCalledWith(f.inner)
  })

  it('top returns the same token for the same entry and a new one after a push', () => {
    const f = fakeInner()
    const store = storeOf(f)
    expect(store.top()).toBeUndefined()
    pushEntries(f, store, ['a'])
    const first = store.top()
    expect(first).toBeDefined()
    expect(store.top()).toBe(first)
    expect(store.top('ir')).toBe(first)
    pushEntries(f, store, ['b'])
    expect(store.top()).not.toBe(first)
    expect(store.base()).toBe(first)
  })

  it('top keeps its token after amendTopCaret returned coalesced', () => {
    const f = fakeInner()
    const store = storeOf(f)
    pushEntries(f, store, ['ab', 'abc'])
    const before = store.top() as HistoryEntryToken
    // The live state differs from the last snapshot only in the caret marker.
    f.live.text = 'ab<wbr>c'
    expect(store.amendTopCaret()).toBe('coalesced')
    expect(store.top()).toBe(before)
  })

  it('redoTop names the entry an Undo moved to the redo stack', () => {
    const f = fakeInner()
    const store = storeOf(f)
    pushEntries(f, store, ['a', 'ab'])
    const top = store.top()
    expect(store.redoTop()).toBeUndefined()
    store.undo()
    expect(store.redoTop()).toBe(top)
  })

  it('slot changes after reset and holds otherwise', () => {
    const f = fakeInner()
    const store = storeOf(f)
    pushEntries(f, store, ['a'])
    const slot = store.slot()
    expect(slot).toBeDefined()
    expect(store.slot()).toBe(slot)
    pushEntries(f, store, ['ab'])
    expect(store.slot()).toBe(slot)
    store.reset()
    expect(store.slot()).not.toBe(slot)
  })

  it('reset clears the stacks and records the base checkpoint', () => {
    const f = fakeInner()
    const store = storeOf(f)
    pushEntries(f, store, ['a', 'ab'])
    f.live.text = 'fresh'
    store.reset()
    expect(f.spies.clearStack).toHaveBeenCalledTimes(1)
    expect(f.undo.ir.undoStack).toHaveLength(1)
    expect(f.undo.ir.lastText).toBe('fresh')
  })
})

describe('savepoint and restore', () => {
  it('returns undefined without history in the current mode', () => {
    const f = fakeInner()
    f.undo.ir = undefined
    expect(storeOf(f).savepoint()).toBeUndefined()
  })

  it('restores the stacks, the top entry contents, lastText and hasUndo, and resets the icon', () => {
    const f = fakeInner()
    const store = storeOf(f)
    pushEntries(f, store, ['a', 'ab'])
    const slot = f.undo.ir as Slot
    const stacks = [...slot.undoStack]
    const top = slot.undoStack.at(-1) as unknown[]
    const topContents = [...top]
    const redo = [...slot.redoStack]
    const lastText = slot.lastText
    const savepoint = store.savepoint()
    expect(savepoint).toBeDefined()
    expect(savepoint?.mode).toBe('ir')

    // A mutation like Turn Into's: a new entry, the top rewritten in place, flags changed.
    pushEntries(f, store, ['abc'])
    top.splice(0, top.length)
    slot.redoStack = [[1]]
    slot.hasUndo = false
    f.undo.resetIcon.mockClear()

    expect(store.restore(savepoint as never)).toBe(true)
    expect(slot.undoStack).toEqual(stacks)
    expect(slot.undoStack.at(-1)).toBe(top)
    expect(top).toEqual(topContents)
    expect(slot.redoStack).toEqual(redo)
    expect(slot.lastText).toBe(lastText)
    expect(slot.hasUndo).toBe(true)
    expect(f.undo.resetIcon).toHaveBeenCalledTimes(1)
    expect(f.undo.resetIcon).toHaveBeenCalledWith(f.inner)
  })

  it('returns false after a reset and changes nothing', () => {
    const f = fakeInner()
    const store = storeOf(f)
    pushEntries(f, store, ['a', 'ab'])
    const savepoint = store.savepoint()
    store.reset()
    const slot = f.undo.ir as Slot
    const undoStack = slot.undoStack
    const lastText = slot.lastText
    f.undo.resetIcon.mockClear()

    expect(store.restore(savepoint as never)).toBe(false)
    expect(f.undo.ir).toBe(slot)
    expect(slot.undoStack).toBe(undoStack)
    expect(slot.undoStack).toHaveLength(1)
    expect(slot.lastText).toBe(lastText)
    expect(f.undo.resetIcon).not.toHaveBeenCalled()
  })
})

describe('revision', () => {
  it('increases on push, pop, amend and reset, and not otherwise', () => {
    const f = fakeInner()
    const store = storeOf(f)
    const seen: number[] = [store.revision()]
    const bumped = () => {
      const now = store.revision()
      const grew = now > seen.at(-1)!
      seen.push(now)
      return grew
    }

    pushEntries(f, store, ['ab'])
    expect(bumped()).toBe(true) // push
    pushEntries(f, store, ['abc'])
    expect(bumped()).toBe(true) // push
    expect(bumped()).toBe(false) // nothing happened
    expect(store.isEmpty()).toBe(false)
    expect(store.top()).toBeDefined()
    expect(store.isSourceNeutral()).toBeTypeOf('boolean')
    expect(bumped()).toBe(false) // queries do not count
    store.undo()
    expect(bumped()).toBe(true) // pop
    f.live.text = 'ab<wbr>'
    expect(store.amendTopCaret()).toBe('coalesced')
    expect(bumped()).toBe(true) // amend
    store.reset()
    expect(bumped()).toBe(true) // reset
  })

  it('is tracked per mode', () => {
    const f = fakeInner()
    const store = storeOf(f)
    const sv = store.revision('sv')
    pushEntries(f, store, ['a'])
    expect(store.revision('sv')).toBe(sv)
    expect(store.revision('ir')).toBeGreaterThan(sv)
  })
})

describe('onEntryRecorded', () => {
  it('reports wasEmpty for the first entry of a mode only', () => {
    const f = fakeInner()
    const store = storeOf(f)
    const seen: RecordedEntry[] = []
    const stop = store.onEntryRecorded((entry) => seen.push(entry))

    pushEntries(f, store, ['a', 'ab'])
    expect(seen.map((entry) => entry.wasEmpty)).toEqual([true, false])
    expect(seen.every((entry) => entry.mode === 'ir')).toBe(true)
    // The reported tokens are the ones top() returns.
    expect(seen[1].entry).toBe(store.top())
    expect(seen[1].slot).toBe(store.slot())
    stop()
  })

  it('reports an entry recorded by the engine itself, not only through the store', () => {
    const f = fakeInner()
    const store = storeOf(f)
    const seen: RecordedEntry[] = []
    store.onEntryRecorded((entry) => seen.push(entry))

    // Vditor's own timer and `recordFirstPosition` call these methods directly.
    f.live.text = 'a'
    f.undo.addToUndoStack(f.inner)
    expect(seen).toHaveLength(1)
    expect(seen[0].wasEmpty).toBe(true)
    f.undo.ir = freshSlot()
    f.undo.sv = freshSlot()
    f.undo.wysiwyg = freshSlot()
    expect(f.undo.vmdeSeedBaseline(f.inner)).toBe(true)
    expect(seen).toHaveLength(2)
    expect(seen[1].wasEmpty).toBe(true)
  })

  it('stops reporting after the listener is removed', () => {
    const f = fakeInner()
    const store = storeOf(f)
    const listener = vi.fn()
    const stop = store.onEntryRecorded(listener)
    pushEntries(f, store, ['a'])
    stop()
    pushEntries(f, store, ['ab'])
    expect(listener).toHaveBeenCalledTimes(1)
  })
})

describe('aroundTransition', () => {
  it('runs the hooks around undo and redo in install order', () => {
    const f = fakeInner()
    const store = storeOf(f)
    pushEntries(f, store, ['a', 'ab'])
    const log: string[] = []
    store.aroundTransition((kind, run) => {
      log.push(`first:${kind}:before`)
      run()
      log.push(`first:${kind}:after`)
    })
    store.aroundTransition((kind, run) => {
      log.push(`second:${kind}:before`)
      run()
      log.push(`second:${kind}:after`)
    })

    store.undo()
    expect(log).toEqual([
      'first:undo:before',
      'second:undo:before',
      'second:undo:after',
      'first:undo:after',
    ])
    expect(f.spies.undo).toHaveBeenCalledTimes(1)
    log.length = 0
    store.redo()
    expect(log).toEqual([
      'first:redo:before',
      'second:redo:before',
      'second:redo:after',
      'first:redo:after',
    ])
    expect(f.spies.redo).toHaveBeenCalledTimes(1)
  })

  it('also wraps an Undo called through the engine, as the toolbar does', () => {
    const f = fakeInner()
    const store = storeOf(f)
    pushEntries(f, store, ['a', 'ab'])
    const kinds: string[] = []
    store.aroundTransition((kind, run) => {
      kinds.push(kind)
      run()
    })
    f.undo.undo(f.inner)
    expect(kinds).toEqual(['undo'])
  })

  it('stops a hook after its removal', () => {
    const f = fakeInner()
    const store = storeOf(f)
    pushEntries(f, store, ['a', 'ab', 'abc'])
    const hook = vi.fn((_kind: 'undo' | 'redo', run: () => void) => run())
    const remove = store.aroundTransition(hook)
    store.undo()
    expect(hook).toHaveBeenCalledTimes(1)
    remove()
    store.undo()
    store.redo()
    expect(hook).toHaveBeenCalledTimes(1)
    expect(f.spies.undo).toHaveBeenCalledTimes(2)
  })
})

describe('suppressRecording', () => {
  it('records nothing while suppressed and records again after the release', () => {
    const f = fakeInner()
    const store = storeOf(f)
    const release = store.suppressRecording()
    pushEntries(f, store, ['a'])
    expect(f.undo.ir.undoStack).toHaveLength(0)
    release()
    pushEntries(f, store, ['ab'])
    expect(f.undo.ir.undoStack).toHaveLength(1)
  })

  it('releases only at the last of nested releases', () => {
    const f = fakeInner()
    const store = storeOf(f)
    const outer = store.suppressRecording()
    const inner = store.suppressRecording()
    inner()
    f.live.text = 'a'
    f.undo.addToUndoStack(f.inner)
    expect(f.undo.ir.undoStack).toHaveLength(0)
    outer()
    f.live.text = 'ab'
    f.undo.addToUndoStack(f.inner)
    expect(f.undo.ir.undoStack).toHaveLength(1)
  })
})

describe('review repairs (Task 003)', () => {
  it('counts a push that trims the oldest entry, though the stack length is unchanged', () => {
    const f = fakeInner()
    const store = storeOf(f)
    pushEntries(
      f,
      store,
      Array.from({ length: 50 }, (_, index) => `t${index}`),
    )
    expect(f.undo.ir.undoStack).toHaveLength(50)
    const before = store.revision()
    pushEntries(f, store, ['trimmed'])
    expect(f.undo.ir.undoStack).toHaveLength(50)
    expect(store.revision()).toBeGreaterThan(before)
  })

  it('refuses a transition when a hook does not call run, and bumps nothing', () => {
    const f = fakeInner()
    const store = storeOf(f)
    pushEntries(f, store, ['a', 'ab'])
    store.aroundTransition(() => undefined)
    const before = store.revision()
    store.undo()
    expect(f.spies.undo).not.toHaveBeenCalled()
    expect(store.revision()).toBe(before)
  })

  it('reads the base snapshot of the first entry only', () => {
    const f = fakeInner()
    const store = storeOf(f)
    const snapshots: Array<string | undefined> = []
    store.onEntryRecorded(({ entry }) =>
      snapshots.push(store.baseSnapshot(entry)),
    )
    pushEntries(f, store, ['first', 'second'])
    expect(snapshots).toEqual(['first', undefined])
  })

  it('identifies a primitive entry by value', () => {
    const f = fakeInner()
    const store = storeOf(f)
    f.undo.ir.undoStack.push('x')
    const token = store.top()
    expect(token).toBeDefined()
    expect(store.top()).toBe(token)
  })

  it('calls Undo on the captured engine when the method is detached', () => {
    const f = fakeInner()
    const store = storeOf(f)
    pushEntries(f, store, ['a', 'ab'])
    store.aroundTransition((_kind, run) => run())
    const detached = f.undo.undo
    expect(() => detached(f.inner)).not.toThrow()
    expect(f.spies.undo).toHaveBeenCalledTimes(1)
  })

  it('returns undefined once inner.undo is removed, and a new store for a replaced engine', () => {
    const f = fakeInner()
    const first = storeOf(f)
    const replacement = fakeInner().undo
    f.inner.undo = replacement
    const second = historyStoreOf(f.inner)
    expect(second).toBeDefined()
    expect(second).not.toBe(first)
    f.inner.undo = undefined
    expect(historyStoreOf(f.inner)).toBeUndefined()
  })
})
