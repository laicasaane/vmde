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
    const onHistoryBase = vi.fn((_mode: string, _baseId: string) =>
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

  it('reports each recorded entry at once, and the first entry of an empty stack as a base ID', () => {
    const e = engine()
    installVditorHistoryCoupling(e.win, vi.fn(), () => true, {
      onEntryRecorded: e.onEntryRecorded,
      onHistoryBase: e.onHistoryBase as any,
    })

    e.undo.addToUndoStack(e.inner)

    expect(e.order).toEqual(['entry', 'base'])
    expect(e.onHistoryBase).toHaveBeenCalledExactlyOnceWith(
      'ir',
      expect.any(String),
    )
    e.set('edited')
    e.undo.addToUndoStack(e.inner)
    expect(e.order).toEqual(['entry', 'base', 'entry'])
    expect(e.onHistoryBase).toHaveBeenCalledTimes(1)
  })

  // Task 700 (G1, safety test): a checkpoint flush that did not publish registers no base.
  it('registers no base for an entry whose checkpoint flush did not publish (Task 700 G1)', () => {
    const e = engine()
    installVditorHistoryCoupling(e.win, vi.fn(), () => true, {
      onEntryRecorded: () => false,
      onHistoryBase: e.onHistoryBase as any,
    })

    e.undo.addToUndoStack(e.inner)

    expect(e.onHistoryBase).not.toHaveBeenCalled()
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

  it('reports the Task 598 seed as the base ID', () => {
    const e = engine('sv')
    installVditorHistoryCoupling(e.win, vi.fn(), () => true, {
      onEntryRecorded: e.onEntryRecorded,
      onHistoryBase: e.onHistoryBase as any,
    })

    expect(e.undo.vmdeSeedBaseline(e.inner)).toBe(true)

    expect(e.order).toEqual(['entry', 'base'])
    expect(e.onHistoryBase).toHaveBeenCalledWith('sv', expect.any(String))
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

// Task 700 Part 2c: a text-free, ID-based history base. Unlike `engine` above, entries are distinct
// array objects and every mode owns its own slot, so identity bugs cannot hide.
describe('installVditorHistoryCoupling ID-backed base (Task 700)', () => {
  function objectEngine(mode = 'ir', stackSize = 50) {
    let value = 'v0'
    const slot = () => ({ undoStack: [] as any[][], redoStack: [] as any[][] })
    const undo: any = { ir: slot(), sv: slot(), wysiwyg: slot() }
    const inner: any = { currentMode: mode, undo }
    const order: string[] = []
    const record = (m: string) => {
      const s = undo[m]
      s.undoStack.push([{ text: value }])
      if (s.undoStack.length > stackSize) s.undoStack.shift()
    }
    undo.addToUndoStack = vi.fn((target: any) => {
      const m = target?.currentMode ?? inner.currentMode
      const top = undo[m].undoStack.at(-1)
      if (top && top[0].text === value) return
      record(m)
    })
    undo.vmdeSeedBaseline = vi.fn((target: any) => {
      const m = target?.currentMode ?? inner.currentMode
      if (undo[m].undoStack.length) return false
      record(m)
      return true
    })
    const move = (
      from: 'undoStack' | 'redoStack',
      to: 'undoStack' | 'redoStack',
    ) => {
      const s = undo[inner.currentMode]
      const entry = s[from].pop()
      if (entry) s[to].push(entry)
      if (from === 'undoStack') value = s.undoStack.at(-1)?.[0].text ?? value
      else value = entry?.[0].text ?? value
    }
    undo.undo = vi.fn(() => move('undoStack', 'redoStack'))
    undo.redo = vi.fn(() => move('redoStack', 'undoStack'))
    const idle = vi.fn()
    const win = {
      vditor: { vditor: inner, getValue: () => value },
      requestIdleCallback: idle,
    } as any
    const readText = vi.fn(() => value)
    const posts: any[] = []
    const onEntryRecorded = vi.fn(() => order.push('entry'))
    const onHistoryBase = vi.fn((m: string, id: string) =>
      order.push(`base:${m}:${id}`),
    )
    installVditorHistoryCoupling(
      win,
      (m) => posts.push(m),
      () => true,
      {
        readText,
        onEntryRecorded,
        onHistoryBase: onHistoryBase as any,
      },
    )
    return {
      inner,
      undo,
      order,
      posts,
      readText,
      idle,
      onHistoryBase,
      set: (next: string) => {
        value = next
      },
      setMode: (next: string) => {
        inner.currentMode = next
      },
      clearStack: () => {
        for (const m of ['ir', 'sv', 'wysiwyg']) {
          undo[m].undoStack.length = 0
          undo[m].redoStack.length = 0
        }
      },
    }
  }
  const idOf = (e: ReturnType<typeof objectEngine>, i = 0) =>
    e.onHistoryBase.mock.calls[i]?.[1]

  it('reports a timer-created first entry as entry then base, with an ID, no text read and no idle read', () => {
    vi.useFakeTimers()
    try {
      const e = objectEngine()
      e.undo.addToUndoStack(e.inner)

      expect(e.order).toHaveLength(2)
      expect(e.order[0]).toBe('entry')
      expect(typeof idOf(e)).toBe('string')
      expect(idOf(e)).not.toBe('')
      expect(e.order[1]).toBe(`base:ir:${idOf(e)}`)
      vi.advanceTimersByTime(5000)
      expect(e.readText).not.toHaveBeenCalled()
      expect(e.idle).not.toHaveBeenCalled()
      expect(e.onHistoryBase).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports the Task 598 seed as entry then base, with an ID and no text read', () => {
    const e = objectEngine('sv')
    expect(e.undo.vmdeSeedBaseline(e.inner)).toBe(true)

    expect(e.order[0]).toBe('entry')
    expect(typeof idOf(e)).toBe('string')
    expect(e.order[1]).toBe(`base:sv:${idOf(e)}`)
    expect(e.readText).not.toHaveBeenCalled()
  })

  it('reports afterBaseId when Undo reaches the tagged original entry', () => {
    const e = objectEngine()
    e.undo.addToUndoStack(e.inner)
    const id = idOf(e)
    e.set('v1')
    e.undo.addToUndoStack(e.inner)
    e.posts.length = 0

    e.undo.undo(e.inner)

    expect(e.posts).toHaveLength(1)
    expect(e.posts[0]).toMatchObject({ kind: 'undo', afterBaseId: id })
  })

  it('reuses the saved rendered text as beforeBaseId when Redo starts at the base', () => {
    const e = objectEngine()
    e.undo.addToUndoStack(e.inner)
    const id = idOf(e)
    e.set('v1')
    e.undo.addToUndoStack(e.inner)
    e.undo.undo(e.inner)
    e.posts.length = 0

    e.undo.redo(e.inner)

    expect(e.posts[0]).toMatchObject({
      kind: 'redo',
      before: 'v0',
      after: 'v1',
      beforeBaseId: id,
    })
    expect(e.posts[0].afterBaseId).toBeUndefined()
  })

  it('omits beforeBaseId when the current text differs from the saved base text', () => {
    const e = objectEngine()
    e.undo.addToUndoStack(e.inner)
    e.set('v1')
    e.undo.addToUndoStack(e.inner)
    e.undo.undo(e.inner)
    e.set('v0 typed')
    e.posts.length = 0

    e.undo.redo(e.inner)

    expect(e.posts[0]?.beforeBaseId).toBeUndefined()
  })

  it('issues a fresh ID after the stack is cleared and a new first entry is recorded', () => {
    const e = objectEngine()
    e.undo.addToUndoStack(e.inner)
    const first = idOf(e, 0)
    e.clearStack()
    e.set('host update')
    e.undo.addToUndoStack(e.inner)

    expect(e.onHistoryBase).toHaveBeenCalledTimes(2)
    expect(typeof first).toBe('string')
    expect(idOf(e, 1)).not.toBe(first)
  })

  it('gives IR and SV independent IDs, and tags afterBaseId only in the owning slot', () => {
    const e = objectEngine('ir')
    e.undo.addToUndoStack(e.inner)
    e.setMode('sv')
    e.undo.addToUndoStack(e.inner)
    const [ir, sv] = [idOf(e, 0), idOf(e, 1)]
    expect(e.onHistoryBase.mock.calls.map(([m]) => m)).toEqual(['ir', 'sv'])
    expect(typeof ir).toBe('string')
    expect(sv).not.toBe(ir)

    e.set('v1')
    e.undo.addToUndoStack(e.inner)
    e.posts.length = 0
    e.undo.undo(e.inner)
    expect(e.posts[0]).toMatchObject({ afterBaseId: sv })
  })

  it('omits afterBaseId when the original base entry was trimmed from a full stack', () => {
    const e = objectEngine('ir', 50)
    e.undo.addToUndoStack(e.inner)
    expect(typeof idOf(e)).toBe('string')
    for (let i = 1; i <= 50; i++) {
      e.set(`v${i}`)
      e.undo.addToUndoStack(e.inner)
    }
    expect(e.undo.ir.undoStack).toHaveLength(50)
    e.posts.length = 0

    for (let i = 0; i < 49; i++) e.undo.undo(e.inner)

    expect(e.undo.ir.undoStack).toHaveLength(1)
    expect(e.posts.length).toBeGreaterThan(0)
    for (const post of e.posts) expect(post.afterBaseId).toBeUndefined()
  })
})

// Task 700 D6: a base endpoint is recognized by value. Entries store HTML apart from Markdown, so a
// layout-only entry above the base (same Markdown, other HTML) is pushed as Vditor does; the
// `objectEngine` above suppresses same-Markdown pushes and hides that case. An HTML string is
// `<variant>::<markdown>`; its Markdown is the part after the separator.
describe('installVditorHistoryCoupling value-based base endpoint (Task 700 D6)', () => {
  const mdOf = (html: string) => html.slice(html.indexOf('::') + 2)

  function htmlEngine(
    options: {
      mode?: string
      stackSize?: number
      snapshotText?: (mode: string, html: string) => string | undefined
      onEntryRecorded?: () => unknown
    } = {},
  ) {
    const stackSize = options.stackSize ?? 50
    let html = 'a::base'
    const slot = () => ({
      undoStack: [] as any[][],
      redoStack: [] as any[][],
      lastText: undefined as string | undefined,
    })
    const undo: any = { ir: slot(), sv: slot(), wysiwyg: slot() }
    const inner: any = { currentMode: options.mode ?? 'ir', undo }
    const push = (mode: string) => {
      const s = undo[mode]
      if (s.lastText === html) return
      s.undoStack.push([{ html }])
      s.lastText = html
      if (s.undoStack.length > stackSize) s.undoStack.shift()
    }
    undo.addToUndoStack = vi.fn((target: any) =>
      push(target?.currentMode ?? inner.currentMode),
    )
    undo.vmdeSeedBaseline = vi.fn((target: any) => {
      const mode = target?.currentMode ?? inner.currentMode
      if (undo[mode].undoStack.length) return false
      push(mode)
      return true
    })
    const apply = (entry: any[] | undefined) => {
      if (entry) html = entry[0].html
    }
    undo.undo = vi.fn(() => {
      const s = undo[inner.currentMode]
      if (s.undoStack.length < 2) return
      s.redoStack.push(s.undoStack.pop())
      apply(s.undoStack.at(-1))
      s.lastText = html
    })
    undo.redo = vi.fn(() => {
      const s = undo[inner.currentMode]
      const entry = s.redoStack.pop()
      if (!entry) return
      s.undoStack.push(entry)
      apply(entry)
      s.lastText = html
    })
    const snapshotText = vi.fn(
      options.snapshotText ??
        ((_mode: string, snapshot: string) => mdOf(snapshot)),
    )
    const posts: any[] = []
    const onHistoryBase = vi.fn()
    const readText = vi.fn(() => mdOf(html))
    installVditorHistoryCoupling(
      { vditor: { vditor: inner, getValue: () => mdOf(html) } } as any,
      (message) => posts.push(message),
      () => true,
      {
        readText,
        snapshotText,
        onEntryRecorded: options.onEntryRecorded,
        onHistoryBase,
      },
    )
    return {
      inner,
      undo,
      posts,
      snapshotText,
      onHistoryBase,
      readText,
      // Vditor records a new entry for the current HTML (its timer, or a checkpoint).
      record: (next: string) => {
        html = next
        undo.addToUndoStack(inner)
      },
      setMode: (mode: string) => {
        inner.currentMode = mode
      },
      clearStack: () => {
        for (const mode of ['ir', 'sv', 'wysiwyg']) {
          undo[mode].undoStack.length = 0
          undo[mode].redoStack.length = 0
          undo[mode].lastText = undefined
        }
      },
      baseId: (index = 0) => onHistoryBase.mock.calls[index]?.[1] as string,
    }
  }

  it('gives the base ID to the first Undo that lands on a layout-only entry above the base, with one snapshot serialization', () => {
    const e = htmlEngine({ mode: 'wysiwyg' })
    e.record('a::base')
    e.record('styled::base')
    e.record('typed::base typed')
    e.posts.length = 0

    e.undo.undo(e.inner)

    expect(e.posts).toHaveLength(1)
    expect(e.posts[0]).toMatchObject({ before: 'base typed', after: 'base' })
    expect(e.posts[0].afterBaseId).toBe(e.baseId())
    expect(e.snapshotText).toHaveBeenCalledExactlyOnceWith('wysiwyg', 'a::base')
  })

  it('gives the base ID for a first-ever tight-list equivalent snapshot with the same Markdown', () => {
    const e = htmlEngine({ mode: 'wysiwyg' })
    e.record('loose-list::- item')
    e.record('tight-list::- item')
    e.record('tight-list::- itemX')
    e.posts.length = 0

    e.undo.undo(e.inner)

    expect(e.posts[0].afterBaseId).toBe(e.baseId())
  })

  it('caches the base Markdown: later same-Markdown entries need no further serialization', () => {
    const e = htmlEngine()
    e.record('a::base')
    e.record('b::base typed')
    e.record('c::base')
    e.record('d::other')
    e.posts.length = 0

    e.undo.undo(e.inner)
    expect(e.posts[0].afterBaseId).toBe(e.baseId())
    expect(e.snapshotText).toHaveBeenCalledTimes(1)
    e.undo.undo(e.inner)
    expect(e.posts[1].afterBaseId).toBeUndefined()
    e.undo.redo(e.inner)
    expect(e.posts[2]).toMatchObject({ kind: 'redo', after: 'base' })
    expect(e.posts[2].afterBaseId).toBe(e.baseId())
    expect(e.snapshotText).toHaveBeenCalledTimes(1)
  })

  it('names the start by value too: a Redo that starts on a layout-only entry carries beforeBaseId', () => {
    const e = htmlEngine()
    e.record('a::base')
    e.record('styled::base')
    e.record('typed::base typed')
    e.undo.undo(e.inner)
    e.undo.undo(e.inner)
    e.undo.undo(e.inner)
    e.posts.length = 0
    e.undo.redo(e.inner)
    e.undo.redo(e.inner)

    expect(e.posts.at(-1)).toMatchObject({ kind: 'redo', before: 'base' })
    expect(e.posts.at(-1).beforeBaseId).toBe(e.baseId())
  })

  it('makes zero serializer calls on registration, seed, pushes, typing and an unrelated Undo', () => {
    const e = htmlEngine()
    expect(e.undo.vmdeSeedBaseline(e.inner)).toBe(true)
    e.record('b::typed 1')
    e.record('c::typed 2')
    expect(e.snapshotText).not.toHaveBeenCalled()

    e.undo.undo(e.inner)
    // The Undo returned to an entry above the base with other Markdown: resolved once, no ID.
    expect(e.posts[0].afterBaseId).toBeUndefined()
    expect(e.snapshotText).toHaveBeenCalledTimes(1)
  })

  it('serializes once per base and caches a mismatch', () => {
    const e = htmlEngine({ snapshotText: () => 'something else' })
    e.record('a::base')
    e.record('b::base')
    e.record('c::typed')
    e.undo.undo(e.inner)
    e.undo.redo(e.inner)
    e.undo.undo(e.inner)

    expect(e.snapshotText).toHaveBeenCalledTimes(1)
    for (const post of e.posts) {
      expect(post.afterBaseId).toBeUndefined()
      expect(post.beforeBaseId).toBeUndefined()
    }
  })

  it('gives no proof when the serializer fails, and does not retry', () => {
    const e = htmlEngine({
      snapshotText: () => {
        throw new Error('boom')
      },
    })
    e.record('a::base')
    e.record('b::base')
    e.record('c::typed')
    e.undo.undo(e.inner)
    e.undo.redo(e.inner)
    e.undo.undo(e.inner)

    expect(e.snapshotText).toHaveBeenCalledTimes(1)
    for (const post of e.posts) expect(post.afterBaseId).toBeUndefined()

    const missing = htmlEngine({ snapshotText: () => undefined })
    missing.record('a::base')
    missing.record('b::base')
    missing.record('c::typed')
    missing.undo.undo(missing.inner)
    expect(missing.posts[0].afterBaseId).toBeUndefined()
  })

  it('never matches different Markdown, even when the HTML looks alike', () => {
    const e = htmlEngine()
    e.record('a::alpha')
    e.record('b::alpha vditor-ir__node--expand')
    e.record('c::alpha typed')
    e.undo.undo(e.inner)

    expect(e.posts[0]).toMatchObject({ after: 'alpha vditor-ir__node--expand' })
    expect(e.posts[0].afterBaseId).toBeUndefined()
  })

  it('gives no proof after a reset, in another mode slot, or once the base entry was trimmed', () => {
    // Reset: the old tag never proves the new generation.
    const reset = htmlEngine()
    reset.record('a::base')
    reset.clearStack()
    reset.record('n::new base')
    reset.record('m::new base')
    reset.record('t::typed')
    reset.posts.length = 0
    reset.undo.undo(reset.inner)
    expect(reset.posts[0].afterBaseId).toBe(reset.baseId(1))
    expect(reset.baseId(1)).not.toBe(reset.baseId(0))
    expect(reset.snapshotText).toHaveBeenCalledExactlyOnceWith(
      'ir',
      'n::new base',
    )

    // Another mode slot: the ir tag proves nothing for sv.
    const other = htmlEngine()
    other.record('a::base')
    other.setMode('sv')
    other.record('s0::sv text')
    other.record('s1::sv text')
    other.record('s2::typed')
    other.posts.length = 0
    other.undo.undo(other.inner)
    expect(other.posts[0].afterBaseId).toBe(other.baseId(1))
    expect(other.posts[0].afterBaseId).not.toBe(other.baseId(0))

    // Trimmed: 51 entries on a 50-entry stack shift the base out.
    const trimmed = htmlEngine({ stackSize: 50 })
    trimmed.record('a::base')
    for (let i = 1; i <= 49; i += 1) trimmed.record(`v${i}::x${i}`)
    trimmed.record('v50::base')
    trimmed.record('v51::typed')
    expect(trimmed.undo.ir.undoStack[0][0].html).not.toBe('a::base')
    trimmed.posts.length = 0
    trimmed.undo.undo(trimmed.inner)
    expect(trimmed.posts[0]).toMatchObject({ after: 'base' })
    expect(trimmed.posts[0].afterBaseId).toBeUndefined()
    expect(trimmed.snapshotText).not.toHaveBeenCalled()
  })

  // Task 700 F1: a snapshot-derived cache is never overwritten by a direct return that renders
  // other Markdown (a coalesced rewrite folded a change into the base entry): the tag proves
  // nothing more, on that and on later transitions.
  it('treats a direct return that contradicts the snapshot-derived cache as no proof, and keeps it so', () => {
    const e = htmlEngine({
      snapshotText: (_mode, html) => (html === 'a::base' ? 'base' : undefined),
    })
    e.record('a::base')
    e.record('b::base')
    e.record('c::x')
    e.posts.length = 0

    e.undo.undo(e.inner)
    expect(e.posts[0].afterBaseId).toBe(e.baseId())
    // The caret coalescer rewrites the top entry in place: the base entry now renders differently.
    e.undo.ir.undoStack[0][0].html = 'a2::changed'
    e.undo.undo(e.inner)
    expect(e.posts[1]).toMatchObject({ before: 'base', after: 'changed' })
    expect(e.posts[1].afterBaseId).toBeUndefined()
    e.undo.redo(e.inner)
    expect(e.posts[2]).toMatchObject({ before: 'changed', after: 'base' })
    expect(e.posts[2].beforeBaseId).toBeUndefined()
    expect(e.posts[2].afterBaseId).toBeUndefined()
    expect(e.snapshotText).toHaveBeenCalledTimes(1)
  })

  it('marks the cache live when a direct return renders the snapshot-derived Markdown', () => {
    const e = htmlEngine()
    e.record('a::base')
    e.record('b::x')
    e.record('c::base')
    e.record('d::y')
    e.posts.length = 0

    e.undo.undo(e.inner)
    e.undo.undo(e.inner)
    e.undo.undo(e.inner)

    expect(e.posts[0]).toMatchObject({ after: 'base' })
    expect(e.posts[0].afterBaseId).toBe(e.baseId())
    expect(e.posts[1].afterBaseId).toBeUndefined()
    expect(e.posts[2]).toMatchObject({ after: 'base' })
    expect(e.posts[2].afterBaseId).toBe(e.baseId())
    expect(e.snapshotText).toHaveBeenCalledTimes(1)
  })

  // Task 700 F3: a live direct return needs no serialization now or for a later layout-only entry.
  it('sets the cache from a direct return with zero serializations, then matches a later layout-only entry', () => {
    const e = htmlEngine()
    e.record('a::base')
    e.record('b::typed')
    e.posts.length = 0
    e.undo.undo(e.inner)
    expect(e.posts[0].afterBaseId).toBe(e.baseId())
    e.undo.redo(e.inner)
    e.record('c::base')
    e.record('d::more')
    e.posts.length = 0

    e.undo.undo(e.inner)

    expect(e.posts[0]).toMatchObject({ after: 'base' })
    expect(e.posts[0].afterBaseId).toBe(e.baseId())
    expect(e.snapshotText).not.toHaveBeenCalled()
  })

  // Task 700 F3: Vditor's `resetStack` replaces the slot object; the old tag proves nothing for it.
  it('gives no proof once the mode slot object was replaced', () => {
    const e = htmlEngine()
    e.record('a::base')
    e.record('b::base')
    e.record('c::typed')
    const old = e.undo.ir
    e.undo.ir = {
      undoStack: old.undoStack,
      redoStack: old.redoStack,
      lastText: old.lastText,
    }
    e.posts.length = 0

    e.undo.undo(e.inner)

    expect(e.posts[0]).toMatchObject({ after: 'base' })
    expect(e.posts[0].afterBaseId).toBeUndefined()
    expect(e.snapshotText).not.toHaveBeenCalled()
  })

  // Task 700 R2: a reset whose first entry is not published (G1) drops the mode's previous tag.
  it('emits no ID of the previous generation after a reset whose first entry was not published', () => {
    let published = true
    const e = htmlEngine({ onEntryRecorded: () => published })
    e.record('a::base')
    const old = e.baseId()
    e.clearStack()
    published = false
    e.record('n::base')
    published = true
    e.record('m::base typed')
    e.posts.length = 0

    e.undo.undo(e.inner)
    e.undo.redo(e.inner)

    expect(e.onHistoryBase).toHaveBeenCalledTimes(1)
    for (const post of e.posts) {
      expect(post.beforeBaseId).not.toBe(old)
      expect(post.afterBaseId).not.toBe(old)
      expect(post.beforeBaseId).toBeUndefined()
      expect(post.afterBaseId).toBeUndefined()
    }
  })
})

describe('undo-keybind module surface', () => {
  it('no longer matches Z/Y keys in the webview (VS Code keybindings own them)', async () => {
    const mod = await import('./undo-keybind')
    expect(Object.keys(mod)).toEqual(['installVditorHistoryCoupling'])
  })
})
