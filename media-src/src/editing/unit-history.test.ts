// @vitest-environment jsdom
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import { tableHeavyMarkdown } from '../../../test/vscode-e2e/table-heavy-markdown'
import { patchLuteGapRepair } from '../../../src/shared/lute-gap-repair'
import { patchLuteTableCodePipes } from '../../../src/shared/table-code-pipes'
import { createModelSession, type ModelSession } from '../bridge/model-session'
import type { UnitLute } from '../bridge/unit-lute'
import { countBudget, type Factor, irFixture } from '../testing/budget-harness'
import { createRealLute, svFixture } from '../testing/real-lute'
import { historyStoreOf, type RecordedEntry } from './history-store'
import { invalidateCaret, requestCaret } from './caret'
import { tagCodeSource } from './code-source'
import {
  hasRewrapDocumentHistoryTransition,
  recordRewrapDocumentHistory,
} from './rewrap-command'
import { installUnitHistory } from './unit-history'
import type { HistoryCapture } from '../util/unit-changes'

// Task 733 / 013 (Q-129): the 013 WYSIWYG cases prove the WYSIWYG path while the shipped
// `WYSIWYG_UNITS` stays false. `wysiwygUnitsOn` turns the default of `unitModeOf` on for those
// cases only (set in their describe block); every other case keeps the shipped default.
const wysiwygUnitsOn = vi.hoisted(() => ({ value: false }))
const sourceUnitsOn = vi.hoisted(() => ({ value: false }))
vi.mock('../util/unit-changes', async (original) => {
  const actual = await original<typeof import('../util/unit-changes')>()
  return {
    ...actual,
    unitModeOf: (mode: string | null | undefined, wysiwygUnits?: boolean) =>
      actual.unitModeOf(mode, wysiwygUnits ?? wysiwygUnitsOn.value),
    // Task 733 / 015 (Q-129, Q-131): on for the 015 Source cases only (their describe block).
    get SOURCE_UNITS() {
      return sourceUnitsOn.value
    },
  }
})

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
  // Task 733 / 015-T1: the Source engine constant of task 015 section 6.4.
  get SOURCE_HISTORY_ENGINE() {
    return engine.value
  },
}))
// The caret authority is a fake by default; the B-14 Undo and Redo tests run the real one, so the
// placement's selection writes and paint check are counted with the restore.
const caretMode = vi.hoisted(() => ({ real: false }))
vi.mock('./caret', async (original) => {
  const actual = await original<typeof import('./caret')>()
  return {
    ...actual,
    requestCaret: vi.fn((intent: Parameters<typeof actual.requestCaret>[0]) =>
      caretMode.real ? actual.requestCaret(intent) : true,
    ),
    invalidateCaret: vi.fn(() => {
      if (caretMode.real) actual.invalidateCaret()
    }),
  }
})
// A restored code block renders its preview through Vditor; the render itself is not under test.
vi.mock('vditor/src/ts/util/processCode', () => ({
  processCodeRender: vi.fn(),
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
  settled(vditor: unknown): boolean
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

function rig(
  options: {
    port?: boolean
    root?: HTMLElement
    mode?: 'ir' | 'wysiwyg'
    /** Task 015 (D-7): the mode whose model is live; a dependency the Source engine reads (provisional). */
    liveMode?: () => 'ir' | 'sv' | undefined
    /** Task 015: the Source root the inner Vditor shows. */
    svRoot?: HTMLElement
  } = {},
) {
  const mode = options.mode ?? 'ir'
  // Task 733 / 013: Vditor keeps both mode trees; the rig's paragraphs live in the root of `mode`.
  const other = document.createElement('div')
  other.className = `vditor-reset vditor-${mode === 'ir' ? 'wysiwyg' : 'ir'}`
  other.setAttribute('contenteditable', 'true')
  const root = options.root ?? document.createElement('div')
  if (!options.root) {
    root.className = `vditor-reset vditor-${mode}`
    root.setAttribute('contenteditable', 'true')
    root.innerHTML = '<p>first</p><p>second</p><p>third</p>'
    document.body.appendChild(root)
  }
  const button = (): HTMLElement => {
    const wrap = document.createElement('div')
    wrap.appendChild(document.createElement('button'))
    return wrap
  }
  const vditor = {
    currentMode: mode as string,
    ir: {
      element: mode === 'ir' ? root : other,
      composingLock: false,
      processTimeoutId: undefined,
    },
    wysiwyg: {
      element: mode === 'wysiwyg' ? root : other,
      composingLock: false,
      processTimeoutId: undefined,
    },
    sv: {
      element: options.svRoot ?? other,
      composingLock: false,
      processTimeoutId: undefined,
    },
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
  // A variable, not a literal: `liveMode` is not a dependency of the engine yet (task 015 section 6.2 D-7).
  const deps = {
    ...(options.liveMode ? { liveMode: options.liveMode } : {}),
    port: () => port as never,
    publishHistory: (kind, steps) => {
      state.published.push([kind, steps])
      return state.publishResult
    },
    lastPostedSequence: () => state.sequence,
    epoch: () => state.epoch,
  }
  uninstall = installUnitHistory(window, deps)
  const hook = hookOf()
  const names = (list: Array<[HistoryCapture, string]>) =>
    list.map(([c, side]) => [(c as unknown as { name: string }).name, side])
  /** Records an entry for `capture`; the first call only creates the base. */
  const record = (capture?: HistoryCapture) => {
    state.captures.push(capture)
    hook.record(vditor)
  }
  const caretAt = (index: number, offset: number) => {
    // A first-position key splits the caret's text node (as Vditor's `addCaret` did): join it again.
    root.normalize()
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
  vi.mocked(invalidateCaret).mockClear()
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
  it('is false in Source while no Source model is live', () => {
    const r = rig()
    r.vditor.currentMode = 'sv'
    expect(r.hook.claims(r.vditor)).toBe(false)
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
    r.vditor.currentMode = 'sv'
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
  // DR (selection-bubble): an intent left armed rewrote a later selection set by a command for up to
  // five seconds, so Turn Into acted on the paragraph Redo had selected.
  it('Undo and Redo place the caret once and leave no intent armed', () => {
    const r = rig()
    r.caretAt(0, 0)
    r.record()
    r.caretAt(1, 3)
    r.record(cap('A'))
    vi.mocked(invalidateCaret).mockClear()
    r.hook.undo(r.vditor)
    expect(invalidateCaret).toHaveBeenCalledTimes(1)
    expect(
      vi.mocked(invalidateCaret).mock.invocationCallOrder[0],
    ).toBeGreaterThan(
      vi.mocked(requestCaret).mock.invocationCallOrder.at(-1) ?? 0,
    )
    r.hook.redo(r.vditor)
    expect(invalidateCaret).toHaveBeenCalledTimes(2)
  })

  it('keeps the intent armed when the placement found no position', () => {
    const r = rig()
    r.caretAt(0, 0)
    r.record()
    r.caretAt(1, 3)
    r.record(cap('A'))
    vi.mocked(requestCaret).mockReturnValueOnce(false)
    r.hook.undo(r.vditor)
    expect(invalidateCaret).not.toHaveBeenCalled()
  })

  // DR (HTML superscript): Vditor's patched checkpoint re-asserted the directional selection through
  // the caret authority; a decoration pass that detaches the selected text relies on it.
  it('a checkpoint re-asserts a directional selection through the caret authority', () => {
    const r = rig()
    r.record()
    const text = r.root.querySelectorAll('p')[1].firstChild as Text
    window.getSelection()?.setBaseAndExtent(text, 3, text, 1)
    vi.mocked(requestCaret).mockClear()
    r.record(cap('A'))
    expect(requestCaret).toHaveBeenCalledTimes(1)
    expect(requestCaret).toHaveBeenLastCalledWith({
      anchor: { blockPath: [1], offsetInBlock: 3 },
      focus: { blockPath: [1], offsetInBlock: 1 },
    })
  })

  it('a checkpoint arms nothing while the toolbar holds the focus', () => {
    const r = rig()
    r.record()
    const toolbar = document.createElement('div')
    const button = document.createElement('button')
    toolbar.append(button)
    document.body.append(toolbar)
    ;(r.vditor.toolbar as { element?: HTMLElement }).element = toolbar
    button.focus()
    r.caretAt(1, 2)
    vi.mocked(requestCaret).mockClear()
    r.record(cap('A'))
    expect(requestCaret).not.toHaveBeenCalled()
  })

  it('Undo requests the caret recorded before the entry and Redo the caret after it, after the restore', () => {
    const r = rig()
    r.caretAt(0, 0)
    r.record() // base caret: paragraph 0, offset 0
    r.caretAt(1, 3)
    r.record(cap('A'))
    // A checkpoint re-asserts its own caret (covered below); only the moves are counted here.
    vi.mocked(requestCaret).mockClear()
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

  // DR (Turn Into): the caret moved to the target after the typing entry, and the action's first
  // checkpoint found nothing pending; Undo of the action put the caret back after the typing.
  it('a checkpoint with no change moves the caret the next entry starts from', () => {
    const r = rig()
    r.caretAt(0, 0)
    r.record()
    r.caretAt(1, 3)
    r.record(cap('A')) // the typing entry, caret after it at paragraph 1
    r.caretAt(2, 1)
    r.record() // the action's first checkpoint: nothing pending
    r.record(cap('B')) // the action
    vi.mocked(requestCaret).mockClear()
    r.hook.undo(r.vditor)
    expect(requestCaret).toHaveBeenLastCalledWith(
      expect.objectContaining({ blockPath: [2], offsetInBlock: 1 }),
    )
    // The typing entry keeps the caret it ended with.
    r.hook.undo(r.vditor)
    expect(requestCaret).toHaveBeenLastCalledWith(
      expect.objectContaining({ blockPath: [0], offsetInBlock: 0 }),
    )
  })

  // DR10 (README list item with a soft break): Vditor's first-position keydown (`addCaret`) inserted
  // and removed a caret marker, which split the caret's text node. Chromium's typing then rebalanced
  // whitespace only inside the node before the caret, so the `\n` of a soft break after the caret
  // stayed a line break; typed into one unsplit node, it became a space and the lines joined.
  it('recordFirstPosition splits the caret text node at the caret and leaves no marker', () => {
    const r = rig()
    r.root.innerHTML = '<ul><li>first line.\nsecond line</li></ul>'
    const text = r.root.querySelector('li')?.firstChild as Text
    const range = document.createRange()
    range.setStart(text, 'first line.'.length)
    range.collapse(true)
    window.getSelection()?.removeAllRanges()
    window.getSelection()?.addRange(range)
    r.record()
    const html = r.root.innerHTML
    r.hook.recordFirstPosition(r.vditor, new KeyboardEvent('keydown'))
    expect(r.root.innerHTML).toBe(html)
    const li = r.root.querySelector('li') as HTMLElement
    expect(Array.from(li.childNodes, (node) => node.textContent)).toEqual([
      'first line.',
      '\nsecond line',
    ])
    const live = window.getSelection()?.getRangeAt(0)
    expect(live?.startContainer).toBe(li.firstChild)
    expect(live?.startOffset).toBe('first line.'.length)
  })

  // C7 (first key cost): the split inserted and removed a span at the caret; the native insert grew
  // with the document. Splitting the text node itself adds no element.
  it('recordFirstPosition splits the caret text node without inserting an element', () => {
    const r = rig()
    r.root.innerHTML = '<ul><li>first line.\nsecond line</li></ul>'
    const text = r.root.querySelector('li')?.firstChild as Text
    const range = document.createRange()
    range.setStart(text, 'first line.'.length)
    range.collapse(true)
    window.getSelection()?.removeAllRanges()
    window.getSelection()?.addRange(range)
    r.record()
    // Records are read with takeRecords; the callback has nothing to do.
    const observer = new MutationObserver(() => undefined)
    observer.observe(r.root, { childList: true, subtree: true })
    r.hook.recordFirstPosition(r.vditor, new KeyboardEvent('keydown'))
    const added = observer
      .takeRecords()
      .flatMap((record) => Array.from(record.addedNodes))
    observer.disconnect()
    expect(added.filter((node) => node.nodeType !== Node.TEXT_NODE)).toEqual([])
    const li = r.root.querySelector('li') as HTMLElement
    expect(Array.from(li.childNodes, (node) => node.textContent)).toEqual([
      'first line.',
      '\nsecond line',
    ])
    const live = window.getSelection()?.getRangeAt(0)
    expect(live?.collapsed).toBe(true)
    expect(live?.startContainer).toBe(li.firstChild)
    expect(live?.startOffset).toBe('first line.'.length)
  })

  // C7: a caret marker elsewhere in the document does not stop the split; one in the caret's
  // top-level block does (the marker already splits the text there).
  it('recordFirstPosition checks only the caret block for a caret marker', () => {
    const r = rig()
    r.root.innerHTML = '<p>other<wbr></p><p>first line.\nsecond line</p>'
    const caretIn = (p: HTMLElement) => {
      const range = document.createRange()
      range.setStart(p.firstChild as Text, 'first line.'.length)
      range.collapse(true)
      window.getSelection()?.removeAllRanges()
      window.getSelection()?.addRange(range)
    }
    const target = r.root.querySelectorAll('p')[1] as HTMLElement
    caretIn(target)
    r.record()
    r.hook.recordFirstPosition(r.vditor, new KeyboardEvent('keydown'))
    expect(target.childNodes.length).toBe(2)
    target.normalize()
    target.appendChild(document.createElement('wbr'))
    caretIn(target)
    r.hook.recordFirstPosition(r.vditor, new KeyboardEvent('keydown'))
    expect(target.childNodes.length).toBe(2)
  })

  it('seedBaseline splits the caret text node as the old seed did', () => {
    const r = rig()
    r.root.innerHTML = '<p>first line.\nsecond line</p>'
    const text = r.root.querySelector('p')?.firstChild as Text
    const range = document.createRange()
    range.setStart(text, 'first line.'.length)
    range.collapse(true)
    window.getSelection()?.removeAllRanges()
    window.getSelection()?.addRange(range)
    expect(r.hook.seedBaseline(r.vditor)).toBe(true)
    const p = r.root.querySelector('p') as HTMLElement
    expect(p.childNodes.length).toBe(2)
    expect(r.root.querySelector('.vditor-wbr, wbr')).toBeNull()
  })

  it('recordFirstPosition does not split once the history has an entry', () => {
    const r = rig()
    r.caretAt(0, 0)
    r.record()
    r.record(cap('A'))
    r.caretAt(1, 2)
    r.hook.recordFirstPosition(r.vditor, new KeyboardEvent('keydown'))
    expect(r.root.querySelectorAll('p')[1].childNodes.length).toBe(1)
  })

  // DR (large document Undo caret): the keys of one first edit each called recordFirstPosition, and
  // the base caret followed the typing, so Undo put the caret after the first typed characters.
  it('recordFirstPosition leaves the base caret once the DOM has changed since the base', () => {
    const r = rig()
    r.caretAt(0, 0)
    r.record()
    r.caretAt(2, 1)
    r.hook.recordFirstPosition(r.vditor, new KeyboardEvent('keydown'))
    // The first key changed the DOM; the second key's caret is one character further.
    r.state.pending = true
    r.caretAt(2, 2)
    r.hook.recordFirstPosition(r.vditor, new KeyboardEvent('keydown'))
    r.record(cap('A'))
    vi.mocked(requestCaret).mockClear()
    r.hook.undo(r.vditor)
    expect(requestCaret).toHaveBeenLastCalledWith(
      expect.objectContaining({ blockPath: [2], offsetInBlock: 1 }),
    )
  })
})

// DR (exact actions): an exact action records its bytes for the native Undo
// (`recordRewrapDocumentHistory`). Vditor's Undo moved the record through its replay; the unit
// engine posts a history delta, and the record must still move, or every source proof after the
// Undo declines (`hasRewrapDocumentHistoryTransition` stays true).
describe('an exact action entry', () => {
  it('Undo and Redo post history deltas and move the record with the history', () => {
    const r = rig()
    r.record()
    r.record(cap('A'))
    recordRewrapDocumentHistory({
      owner: r.vditor as never,
      mode: 'ir',
      nativeState: historyStoreOf(r.vditor)?.top() as never,
      beforeRendered: 'a',
      beforeExact: 'a',
      afterRendered: 'b',
      afterExact: 'b',
    })
    r.hook.undo(r.vditor)
    expect(r.state.published).toEqual([['undo', 1]])
    expect(hasRewrapDocumentHistoryTransition(r.vditor as never)).toBe(false)
    r.hook.redo(r.vditor)
    expect(r.state.published).toEqual([
      ['undo', 1],
      ['redo', 1],
    ])
    expect(hasRewrapDocumentHistoryTransition(r.vditor as never)).toBe(false)
    // The record stands on its `after` side again: a second Undo moves it once more.
    r.hook.undo(r.vditor)
    expect(hasRewrapDocumentHistoryTransition(r.vditor as never)).toBe(false)
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

// DR (IR re-entry, deferred edit view): edits made while the model was off were recorded by the old
// engine; taking the history over when the model comes back left them unreachable by Undo.
describe('the hand-over back to the unit engine', () => {
  it('waits while the old engine holds an entry above its base or a Redo entry', () => {
    const r = rig()
    r.state.claimable = false
    expect(r.hook.claims(r.vditor)).toBe(false)
    // The old engine recorded its base and one edit meanwhile.
    r.vditor.undo.ir.undoStack.push(['base'], ['edit'])
    r.state.claimable = true
    expect(r.hook.claims(r.vditor)).toBe(false)
    // Undone to its base, with the edit on its Redo stack: still the old engine's history.
    r.vditor.undo.ir.redoStack.push(r.vditor.undo.ir.undoStack.pop())
    expect(r.hook.claims(r.vditor)).toBe(false)
    // A reset (a host update's `clearStack`) leaves nothing to undo: the unit engine claims.
    r.vditor.undo.ir.undoStack.length = 1
    r.vditor.undo.ir.redoStack.length = 0
    expect(r.hook.claims(r.vditor)).toBe(true)
  })

  // DR (section indent): Vditor's initial record went to the old engine while the model was not yet
  // live; the unit engine took over with no base, so it never settled and an edit had no Undo caret.
  it('starts the unit history with a base when it takes over from the old base', () => {
    const r = rig()
    r.state.claimable = false
    expect(r.hook.claims(r.vditor)).toBe(false)
    r.vditor.undo.ir.undoStack.push(['base'])
    r.state.claimable = true
    expect(r.hook.claims(r.vditor)).toBe(true)
    expect(historyStoreOf(r.vditor)?.base()).toBeDefined()
    expect(r.hook.settled(r.vditor)).toBe(true)
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
    vi.mocked(requestCaret).mockClear()
    r.hook.undo(r.vditor)
    expect(r.names(r.state.restores)).toEqual([['A', 'before']])
    expect(requestCaret).not.toHaveBeenCalled()
  })
})

describe('depth (a read for the end-to-end specs)', () => {
  it('counts the base as one Undo entry, like Vditor slots, and follows Undo', () => {
    const r = rig()
    const hook = r.hook as unknown as {
      depth(v: unknown): { undo: number; redo: number }
    }
    expect(hook.depth(r.vditor)).toEqual({ undo: 0, redo: 0 })
    r.record()
    r.record(cap('A'))
    r.record(cap('B'))
    expect(hook.depth(r.vditor)).toEqual({ undo: 3, redo: 0 })
    r.hook.undo(r.vditor)
    expect(hook.depth(r.vditor)).toEqual({ undo: 2, redo: 1 })
  })
})

// C7 (D-13 design section 1.3): at an element endpoint the caret is already at a node boundary, so the
// split has nothing to split. The inserted and removed marker changed no HTML and cost a native
// insert. The text after the caret stays its own node, which is what the split exists for (a soft
// break after the caret keeps its `\n` when Chromium types into the node before it).
describe('first position at an element endpoint', () => {
  it('recordFirstPosition inserts no node and keeps the text after the caret as its own node', () => {
    const r = rig()
    r.root.innerHTML = '<ul><li><b>first</b>\nsecond line</li></ul>'
    const li = r.root.querySelector('li') as HTMLElement
    const range = document.createRange()
    range.setStart(li, 1)
    range.collapse(true)
    window.getSelection()?.removeAllRanges()
    window.getSelection()?.addRange(range)
    r.record()
    const html = r.root.innerHTML
    const observer = new MutationObserver(() => undefined)
    observer.observe(r.root, { childList: true, subtree: true })
    r.hook.recordFirstPosition(r.vditor, new KeyboardEvent('keydown'))
    const records = observer.takeRecords()
    observer.disconnect()
    expect(records.flatMap((record) => Array.from(record.addedNodes))).toEqual(
      [],
    )
    expect(r.root.innerHTML).toBe(html)
    expect(Array.from(li.childNodes, (node) => node.textContent)).toEqual([
      'first',
      '\nsecond line',
    ])
    const selection = window.getSelection()
    expect([selection?.anchorNode, selection?.anchorOffset]).toEqual([li, 1])
    expect([selection?.focusNode, selection?.focusOffset]).toEqual([li, 1])
  })
})

// ---- B-14 (D-13 design sections 5.2, 11.3 and 12.2) ----
// One flush per operation: no layout-dependent call (selection write, live-range mutation, layout
// read) between two DOM writes of one operation, at most one after its last write. Counted at
// factors 1, 4 and 16 of the table-heavy fixture.

const FACTORS: Factor[] = [1, 4, 16]

/** The probe's tagging of the code block (as 012-11's `probeCodeBlock`). */
function tagProbe(root: HTMLElement): void {
  tagCodeSource(root)
  root
    .querySelector('[data-type="code-block"]')
    ?.classList.add('vditor-ir__node--expand')
}

type Unit = 'cell' | 'item' | 'paragraph' | 'code block'
const UNIT_SELECTOR: Record<Unit, string> = {
  cell: 'tbody td',
  item: 'li',
  paragraph: ':scope > p',
  'code block': '[data-type="code-block"] .vditor-ir__marker--pre > code',
}

/** The first text node of `unit` with more than one visible character. */
function unitText(root: HTMLElement, unit: Unit): Text {
  const element = root.querySelector(UNIT_SELECTOR[unit]) as HTMLElement
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode())
    if ((node as Text).data.trim().length > 1) return node as Text
  throw new Error(`no text in the ${unit}`)
}

function collapseAt(node: Node, offset: number): void {
  const range = document.createRange()
  range.setStart(node, offset)
  range.collapse(true)
  window.getSelection()?.removeAllRanges()
  window.getSelection()?.addRange(range)
}

// Rule 13.17: the factor-16 cell case takes about 2.4 s alone and timed out at the default 5 s in a
// combined run; 30 s is at least five times its alone time.
const FIRST_KEY_SPLIT_TIMEOUT_MS = 30_000

describe('B-14: one flush per first-key split', () => {
  describe.each(FACTORS)(
    'factor %i',
    { timeout: FIRST_KEY_SPLIT_TIMEOUT_MS },
    (factor) => {
      const fixture = () => {
        const { root } = irFixture(tableHeavyMarkdown(factor), tagProbe)
        if (!root.isConnected)
          document.body.append(root.parentElement as Element)
        return root
      }

      it.each(['cell', 'item', 'paragraph', 'code block'] as const)(
        'a text endpoint in a %s: flushes <= 1',
        (unit) => {
          const root = fixture()
          const r = rig({ root })
          const text = unitText(root, unit)
          collapseAt(text, 1)
          r.record()
          const { counts } = countBudget(root, () =>
            r.hook.recordFirstPosition(r.vditor, new KeyboardEvent('keydown')),
          )
          root.normalize()
          expect(counts.flushes).toBeLessThanOrEqual(1)
        },
      )

      it.each(['cell', 'item', 'paragraph'] as const)(
        'an element endpoint in a %s: flushes <= 1',
        (unit) => {
          const root = fixture()
          const r = rig({ root })
          const element = root.querySelector(UNIT_SELECTOR[unit]) as HTMLElement
          collapseAt(element, 0)
          r.record()
          const { counts } = countBudget(root, () =>
            r.hook.recordFirstPosition(r.vditor, new KeyboardEvent('keydown')),
          )
          expect(counts.flushes).toBeLessThanOrEqual(1)
        },
      )
    },
  )
})

describe('B-14: one flush per Undo and Redo', () => {
  let lute: UnitLute
  const sessions: ModelSession[] = []
  beforeAll(() => {
    const real = createRealLute('ir')
    patchLuteTableCodePipes(real.lute)
    patchLuteGapRepair(real.lute)
    lute = real.lute
  })
  beforeEach(() => {
    caretMode.real = true
  })
  afterEach(() => {
    caretMode.real = false
    for (const session of sessions.splice(0)) session.dispose()
    ;(window as unknown as Record<string, unknown>).vditor = undefined
  })

  /**
   * The unit engine over a real model session (its history port restores the units), real Lute,
   * the real caret authority and the probe's IR root shape `div.vditor-ir > pre.vditor-reset`.
   */
  function sessionRig(factor: Factor) {
    const markdown = tableHeavyMarkdown(factor)
    const container = document.createElement('div')
    container.className = 'vditor-ir'
    const root = document.createElement('pre')
    root.className = 'vditor-reset'
    root.setAttribute('contenteditable', 'true')
    container.append(root)
    document.body.append(container)
    const frames: Array<() => void> = []
    const session = createModelSession({
      win: window,
      getRoot: () => root,
      getLute: () => lute,
      getMode: () => 'ir',
      isPreviewShowing: () => false,
      isStreaming: () => false,
      isComposing: () => false,
      e2e: true,
      countFallbackPublication: () => undefined,
      requestAnimationFrame: (cb) => frames.push(cb),
      cancelAnimationFrame: () => undefined,
      now: () => 0,
      setTimeout: () => 0,
      clearTimeout: () => undefined,
      inViewport: () => false,
    })
    sessions.push(session)
    root.innerHTML = lute.Md2VditorIRDOM(markdown)
    tagProbe(root)
    session.onHostText(markdown, 1)
    session.onEditDomComplete()
    const port = (
      session as ModelSession & {
        historyPort(): Parameters<
          Parameters<typeof installUnitHistory>[1]['port']
        > extends never[]
          ? never
          : ReturnType<Parameters<typeof installUnitHistory>[1]['port']>
      }
    ).historyPort()
    const delta = session.deltaPort()
    let sequence = 0
    const vditor = {
      currentMode: 'ir',
      ir: { element: root, composingLock: false, processTimeoutId: undefined },
      undo: { ir: slot(), sv: slot(), wysiwyg: slot() },
      toolbar: { elements: {} },
      options: {},
    }
    // The caret authority finds the editor through the outer Vditor's `vditor`.
    ;(window as unknown as Record<string, unknown>).vditor = { vditor }
    uninstall = installUnitHistory(window, {
      port: () => port,
      publishHistory: () => 'delta',
      lastPostedSequence: () => sequence,
      epoch: () => 1,
    })
    const hook = hookOf()
    return {
      root,
      vditor,
      hook,
      sync(): string | undefined {
        sequence += 1
        delta.prepareDelta(sequence)
        return delta.modelText()
      },
    }
  }

  describe.each(FACTORS)('factor %i', (factor) => {
    it.each(['cell', 'item', 'paragraph', 'code block'] as const)(
      'a %s Undo and its Redo: flushes <= 1 each',
      (unit) => {
        const r = sessionRig(factor)
        const before = r.sync()
        let text = unitText(r.root, unit)
        collapseAt(text, 1)
        r.hook.record(r.vditor)
        // One typed character, as the editor types it: the pre-touch proof, then the text change.
        text.parentElement?.dispatchEvent(
          new Event('beforeinput', { bubbles: true }),
        )
        text.data = `${text.data.slice(0, 1)}x${text.data.slice(1)}`
        collapseAt(text, 2)
        r.hook.record(r.vditor)
        const after = r.sync()
        expect(after).not.toBe(before)

        const undo = countBudget(r.root, () => r.hook.undo(r.vditor))
        expect(r.sync()).toBe(before)
        expect(undo.counts.flushes).toBeLessThanOrEqual(1)
        text = unitText(r.root, unit)
        expect(window.getSelection()?.anchorNode).toBe(text)

        const redo = countBudget(r.root, () => r.hook.redo(r.vditor))
        expect(r.sync()).toBe(after)
        expect(redo.counts.flushes).toBeLessThanOrEqual(1)
      },
      60_000,
    )
  })
})

// ---- Task 733 / 013-T2: the unit engine holds WYSIWYG history (technical task 013 sections 6.2, 6.3) ----
//
// The rig's paragraphs live in the WYSIWYG root; the patched Vditor `Undo` asks `claims` first and
// delegates only when it holds (`patchUndoUnitEngine`), so these cases call the hook the same way.
describe('013 WYSIWYG unit history', () => {
  beforeEach(() => {
    wysiwygUnitsOn.value = true
  })
  afterEach(() => {
    wysiwygUnitsOn.value = false
  })
  type R = ReturnType<typeof rig>
  /** One call of the patched `Undo` method: the engine runs only while it claims the editor. */
  const viaPatch = (r: R, method: 'undo' | 'redo' | 'record'): boolean => {
    if (!r.hook.claims(r.vditor)) return false
    r.hook[method](r.vditor)
    return true
  }
  const recordViaPatch = (r: R, capture?: HistoryCapture): boolean => {
    r.state.captures.push(capture)
    return viaPatch(r, 'record')
  }

  it('claims WYSIWYG with the unit engine and a port, and keeps reading the mode', () => {
    const r = rig({ mode: 'wysiwyg' })
    expect(r.hook.claims(r.vditor)).toBe(true)
    r.vditor.currentMode = 'sv'
    expect(r.hook.claims(r.vditor)).toBe(false)
  })

  it('does not claim WYSIWYG without a port (WYSIWYG units off: no session port)', () => {
    const r = rig({ mode: 'wysiwyg', port: false })
    expect(r.hook.claims(r.vditor)).toBe(false)
  })

  it('records, undoes and redoes a WYSIWYG edit through the model port and publishes each move', () => {
    const r = rig({ mode: 'wysiwyg' })
    expect(recordViaPatch(r)).toBe(true)
    expect(recordViaPatch(r, cap('A'))).toBe(true)
    expect(viaPatch(r, 'undo')).toBe(true)
    expect(viaPatch(r, 'redo')).toBe(true)
    expect(r.names(r.state.restores)).toEqual([
      ['A', 'before'],
      ['A', 'after'],
    ])
    expect(r.state.published.map(([kind]) => kind)).toEqual(['undo', 'redo'])
  })

  it('reports its entries as WYSIWYG entries to the history store', () => {
    const r = rig({ mode: 'wysiwyg' })
    const seen: RecordedEntry[] = []
    const store = historyStoreOf(r.vditor)
    const stop = store?.onEntryRecorded((entry) => seen.push(entry))
    recordViaPatch(r)
    recordViaPatch(r, cap('A'))
    stop?.()
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.every((entry) => entry.mode === 'wysiwyg')).toBe(true)
    expect(store?.top('wysiwyg')).toBeDefined()
  })

  it('B-14: an Undo and a Redo make at most one selection write and one layout flush each', () => {
    const r = rig({ mode: 'wysiwyg' })
    recordViaPatch(r)
    recordViaPatch(r, cap('A'))
    for (const method of ['undo', 'redo'] as const) {
      let moved = false
      const { counts } = countBudget(r.root, () => {
        moved = viaPatch(r, method)
      })
      expect(moved, `${method} delegated`).toBe(true)
      expect(counts.selectionWrites, method).toBeLessThanOrEqual(1)
      expect(counts.flushes, method).toBeLessThanOrEqual(1)
    }
  })

  it('B-14: a first-position key at an element endpoint inserts no node', () => {
    const r = rig({ mode: 'wysiwyg' })
    expect(recordViaPatch(r)).toBe(true)
    const range = document.createRange()
    range.setStart(r.root, 1)
    range.collapse(true)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    const before = r.root.innerHTML
    const { counts } = countBudget(r.root, () => {
      if (r.hook.claims(r.vditor))
        r.hook.recordFirstPosition(r.vditor, new KeyboardEvent('keydown'))
    })
    expect(r.hook.claims(r.vditor)).toBe(true)
    expect(r.root.innerHTML).toBe(before)
    expect(counts.selectionWrites).toBeLessThanOrEqual(1)
    expect(counts.flushes).toBeLessThanOrEqual(1)
  })
})

// Task 733 / 015-T1, S-11 (task 015 sections 6.2 D-7, 6.3 and 6.9 item 2): the unit engine holds Source
// history while the Source model is live. An Undo and a Redo restore through the port once each, publish
// one history delta each, read no Source root HTML and flush layout at most once. The live mode reaches
// the engine through a `liveMode` dependency, provisional (task 015 section 6.4 does not name the
// engine's input; see the 015-T1 handoff).
// Task 733 / 015: factors 4 and 16 build Source or IR fixtures of 51 KB and 208 KB with the real Lute in
// jsdom; the suite timeout is explicit (family rule 13.17).
const FIXTURE_TIMEOUT_MS = 30_000

describe.each([1, 4, 16] as const)(
  'Source history at factor %i (S-11)',
  { timeout: FIXTURE_TIMEOUT_MS },
  (factor) => {
    beforeEach(() => {
      sourceUnitsOn.value = true
    })
    afterEach(() => {
      sourceUnitsOn.value = false
    })
    const sourceRig = () => {
      const svRoot = svFixture(tableHeavyMarkdown(factor))
      const r = rig({ liveMode: () => 'sv', svRoot })
      r.vditor.currentMode = 'sv'
      return { ...r, svRoot }
    }

    it('claims Source with a live Source model and the unit engine', () => {
      const r = sourceRig()
      expect(r.hook.claims(r.vditor)).toBe(true)
      engine.value = 'vditor'
      expect(r.hook.claims(r.vditor)).toBe(false)
    })

    it('undoes and redoes a key by one restore and one delta each', () => {
      const r = sourceRig()
      // The engine must hold Source history; without the claim Vditor's O(document) engine keeps it.
      expect(r.hook.claims(r.vditor)).toBe(true)
      r.record()
      r.record(cap('key'))
      const undo = countBudget(r.svRoot, () => r.hook.undo(r.vditor)).counts
      const redo = countBudget(r.svRoot, () => r.hook.redo(r.vditor)).counts
      expect(r.names(r.state.restores)).toEqual([
        ['key', 'before'],
        ['key', 'after'],
      ])
      expect(r.state.published).toEqual([
        ['undo', 1],
        ['redo', 1],
      ])
      for (const counts of [undo, redo]) {
        expect(counts.innerHtmlReads).toBe(0)
        expect(counts.rootQueries).toBe(0)
        expect(counts.flushes).toBeLessThanOrEqual(1)
      }
    })
  },
)

// Task 733 / 020 (W-C, Q-166, 020-A3): after a kept-text switch from IR into WYSIWYG the model is live
// before any WYSIWYG edit, so Vditor's WYSIWYG stack holds only its first record and the unit engine
// claims the WYSIWYG history. No `unit-history.ts` change is planned: this is a regression guard that
// passes before 020-I; smoke case 5 is the failing proof of W-C.
describe('020 WYSIWYG claim after a kept-text switch', () => {
  beforeEach(() => {
    wysiwygUnitsOn.value = true
  })
  afterEach(() => {
    wysiwygUnitsOn.value = false
  })

  it('claims WYSIWYG at the first record after an IR history', () => {
    const r = rig({ mode: 'ir' })
    expect(r.hook.claims(r.vditor)).toBe(true)
    r.record()
    r.record(cap('ir key'))
    // The switch: Vditor records the first WYSIWYG snapshot, the kept-text model is live in WYSIWYG.
    r.vditor.currentMode = 'wysiwyg'
    ;(r.vditor.undo.wysiwyg.undoStack as unknown[]).push([])
    expect(r.hook.claims(r.vditor), 'claim at the first record').toBe(true)
    r.record()
    r.record(cap('wysiwyg key'))
    r.hook.undo(r.vditor)
    expect(r.names(r.state.restores)).toEqual([['wysiwyg key', 'before']])
  })
})
