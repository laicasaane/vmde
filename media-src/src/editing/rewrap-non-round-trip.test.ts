// @vitest-environment jsdom
// Task 606 S2a: proof-only Rewrap on documents whose rendering differs from their source.
// Real Lute renders and serializes the documents; the shared source index and the Task 604 proof
// supply the exact offsets. Each case names the acceptance item or edge case it covers.
//
// Case group -> record item (tasks/606, Acceptance A1-A4 and Part 1 handoff Contract C1-C6):
//   single/multi-unit proven selection, exact-plan payload, bytes outside target ... A1, A2, C1, C2
//   unproven endpoint, unavailable proof, auto-wrap path (no rendered fallback) ..... A1, C2, C3, Owner proof-only
//   legacy capture only when unprovable and round-trip, vs the exact snapshot ........ C3
//   caret-independent document bytes, exact document caret and stale-capture refusal .... C4
//   selection scope exact sync, one Undo step, history record/replay, history guard ... A2, C5
//   edge cases: backward, nested list, list/table boundary selections, table/code/
//     front matter caret, CRLF, mixed endings, surrogate pair ......................... Edge cases
//   Not here: passive Details inserts no live marker (C6) -> Chromium step S4 (needs the
//     details-toggle passive path and a real index); cold index, mode switch between prepare and
//     run, caret-bias two-boundary decline -> S4 / not constructible with this fixture.
import { type HistoryEntryToken, historyStoreOf } from './history-store'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  currentBlockProjection,
  resolveBlockHandleUnits,
} from '../nav/block-handle'
import { createSourceBlockIndex } from '../nav/source-block-index'
import { createRealLute, type RealLute } from '../testing/real-lute'
import {
  bindRewrapSource,
  captureProvenRewrapSelection,
  captureRewrapSourceSelection,
  captureRewrapSourceRange,
  hasRewrapDocumentHistoryTransition,
  recordRewrapDocumentHistory,
  runRewrapCommand,
  runHeadingLevelShift,
  runRewrapDocumentCommand,
  takeRewrapDocumentHistorySync,
} from './rewrap-command'
import { rewrapMarkdownDocument, rewrapMarkdownRange } from './rewrap-markdown'
import { shiftMarkdownHeadingLevels } from '../nav/section-range'
import { planSelectedLink } from './selection-link-plan'
import { proveSelectionSource } from './selection-source-proof'
import {
  captureCalloutActionTarget,
  runCalloutAction,
  transformCalloutMarkdown,
} from './callouts'

type Mode = 'ir' | 'wysiwyg'
const COLUMN = 30
const P1 =
  'Alpha one two three four five six seven eight nine ten eleven twelve.'
const P2 = 'Omega red orange yellow green blue indigo violet purple pink brown.'
const TABLE = '|a|b|\n|---|---|\n|x|y|'
// The table is written without padding, so Lute rewrites it: rendering differs from source.
const NORMALIZING = `${TABLE}\n\n${P1}\n\n${P2}\n`
const ROUND_TRIP = `${P1}\n\n${P2}\n`

let lutes: Record<Mode, RealLute>
const teardown: Array<() => void> = []
beforeAll(() => {
  lutes = { ir: createRealLute('ir'), wysiwyg: createRealLute('wysiwyg') }
})
/** Dispose every mounted editor, so one case can compare two independent mounts. */
function unmountAll(): void {
  for (const fn of teardown.splice(0).reverse()) fn()
}

afterEach(() => {
  unmountAll()
  vi.restoreAllMocks()
  getSelection()?.removeAllRanges()
  document.body.replaceChildren()
  delete (window as any).vditor
})

interface Mounted {
  real: RealLute
  mode: Mode
  root: HTMLElement
  exact: string
  inner: any
  deps: ReturnType<typeof makeDeps>
  setValues: string[]
  getValue: ReturnType<typeof vi.fn>
  state: { exact: string | null }
  index: ReturnType<typeof createSourceBlockIndex>
  rendered(): string
}

function makeDeps() {
  return {
    column: COLUMN,
    setApplying: vi.fn(),
    invalidate: vi.fn(),
    scheduleSync: vi.fn(),
    syncExact: vi.fn(),
    onError: (error: unknown) => {
      throw error
    },
  }
}

function mount(mode: Mode, source: string, bind = true): Mounted {
  const real = lutes[mode]
  const root = document.createElement('pre')
  root.className = 'vditor-reset'
  root.setAttribute('contenteditable', 'true')
  root.innerHTML = real.render(source)
  document.body.append(root)
  const undoStack: unknown[] = []
  const inner: any = {
    currentMode: mode,
    lute: real.lute,
    [mode]: { element: root },
    options: { undoDelay: 800 },
    undo: {
      [mode]: { undoStack, redoStack: [] },
      addToUndoStack: vi.fn(() => undoStack.push({})),
    },
  }
  const setValues: string[] = []
  const getValue = vi.fn(() => real.serialize(root.innerHTML))
  ;(window as any).vditor = {
    vditor: inner,
    getCurrentMode: () => mode,
    getValue,
    setValue: (markdown: string) => {
      setValues.push(markdown)
      root.innerHTML = real.render(markdown)
    },
  }
  const state: { exact: string | null } = { exact: source }
  const revision = {}
  const snapshotPair = () => ({
    exact: state.exact,
    rendered: real.serialize(root.innerHTML),
  })
  const index = createSourceBlockIndex({
    getActiveRoot: () => root,
    projection: currentBlockProjection,
    snapshotPair,
    snapshotRevision: () => revision,
    resolveUnits: (element, exact, rendered) =>
      resolveBlockHandleUnits(
        element,
        exact,
        rendered,
        currentBlockProjection(),
      ),
  })
  teardown.push(() => index.dispose())
  if (bind) teardown.push(bindRewrapSource({ index, snapshotPair }))
  getValue.mockClear()
  return {
    real,
    mode,
    root,
    exact: source,
    inner,
    deps: makeDeps(),
    setValues,
    getValue,
    state,
    index,
    rendered: () => real.serialize(root.innerHTML),
  }
}

function point(root: HTMLElement, needle: string, delta = 0) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const at = (node as Text).data.indexOf(needle)
    if (at >= 0) return { node: node as Text, offset: at + delta }
  }
  throw new Error(`text "${needle}" missing from the live DOM`)
}

function select(
  start: { node: Node; offset: number },
  end: { node: Node; offset: number } = start,
  backward = false,
): Range {
  const range = document.createRange()
  range.setStart(start.node, start.offset)
  range.setEnd(end.node, end.offset)
  const selection = getSelection()!
  selection.removeAllRanges()
  if (backward) {
    selection.setBaseAndExtent(end.node, end.offset, start.node, start.offset)
  } else {
    selection.addRange(range)
  }
  return range
}

/** An element-offset endpoint: never provable, because element offsets include syntax boundaries. */
function unprovablePoint(root: HTMLElement) {
  return { node: root, offset: 0 }
}

/** The exact plan the selection scope posted; asserts the single exact post first so a missing
 * post fails on that assertion (today the selection scope posts a plain edit) and not on a TypeError. */
function postedPlan(m: Mounted): string {
  expect(m.deps.syncExact).toHaveBeenCalledOnce()
  return m.deps.syncExact.mock.calls[0][0]
}

/** The marker the apply step inserts is the only difference from the planned bytes. */
function _markedCaret(marked: string, planned: string): number {
  let at = 0
  while (at < planned.length && marked[at] === planned[at]) at++
  return at
}

function expectEditWithin(
  exact: string,
  planned: string,
  span: [number, number],
) {
  expect(planned.slice(0, span[0])).toBe(exact.slice(0, span[0]))
  const tail = exact.length - span[1]
  expect(planned.slice(planned.length - tail)).toBe(exact.slice(span[1]))
}

describe.each(['ir', 'wysiwyg'] as const)('%s: proof-only Rewrap', (mode) => {
  it('precondition: the normalizing fixture does not round-trip', () => {
    const real = lutes[mode]
    expect(real.serialize(real.render(NORMALIZING)) === NORMALIZING).toBe(false)
    expect(real.serialize(real.render(ROUND_TRIP)) === ROUND_TRIP).toBe(true)
  })

  // Guards the existing Task 604 proof the cases below rely on (green today, not RED).
  it('precondition: the proof proves a paragraph caret at its source offset and rejects element offsets', () => {
    const m = mount(mode, NORMALIZING)
    const source = {
      index: m.index,
      snapshotPair: () => ({ exact: NORMALIZING, rendered: m.rendered() }),
    }
    const at = point(m.root, 'orange', 3)
    const proof = proveSelectionSource(source, m.root, select(at))
    expect(proof.status).toBe('proven')
    if (proof.status === 'proven') {
      expect(proof.roundTrip).toBe(false)
      expect(proof.start.exact).toBe(NORMALIZING.indexOf('orange') + 3)
    }
    expect(
      proveSelectionSource(source, m.root, select(unprovablePoint(m.root)))
        .status,
    ).toBe('unprovable')
  })

  // Acceptance 1, Contract 1, exact-plan payload assertion.
  it('single paragraph: maps to the exact offsets and changes only the target paragraph bytes', () => {
    const m = mount(mode, NORMALIZING)
    const insertNode = vi.spyOn(Range.prototype, 'insertNode')
    const from = point(m.root, 'three')
    const to = point(m.root, 'eight')
    select(from, to)
    const start = NORMALIZING.indexOf('three')
    const end = NORMALIZING.indexOf('eight')

    const captured = captureProvenRewrapSelection(window)

    expect(captured).toMatchObject({
      markdown: NORMALIZING,
      startOffset: start,
      endOffset: end,
    })
    expect(insertNode).not.toHaveBeenCalled()

    expect(runRewrapCommand(window, m.deps)).toBe(true)
    const plan = rewrapMarkdownRange(
      NORMALIZING,
      start,
      end,
      captured?.caretOffset ?? end,
      COLUMN,
    )
    expect(plan.changed).toBe(true)
    // The selection scope posts the exact plan through `syncExact`.
    expect(postedPlan(m)).toBe(plan.markdown)
    const p1 = NORMALIZING.indexOf(P1)
    expectEditWithin(NORMALIZING, plan.markdown, [p1, p1 + P1.length + 1])
    expect(plan.markdown.slice(0, p1)).toBe(`${TABLE}\n\n`)
    expect(plan.markdown.endsWith(`\n\n${P2}\n`)).toBe(true)
  })

  // Contract 2.
  it('multi-unit selection with both endpoints proven applies to both units only', () => {
    const m = mount(mode, NORMALIZING)
    select(point(m.root, 'three'), point(m.root, 'green'))
    const start = NORMALIZING.indexOf('three')
    const end = NORMALIZING.indexOf('green')

    expect(runRewrapCommand(window, m.deps)).toBe(true)

    const plan = rewrapMarkdownRange(NORMALIZING, start, end, end, COLUMN)
    expect(postedPlan(m)).toBe(plan.markdown)
    expectEditWithin(NORMALIZING, plan.markdown, [
      NORMALIZING.indexOf(P1),
      NORMALIZING.length,
    ])
    expect(plan.markdown.startsWith(`${TABLE}\n\n`)).toBe(true)
  })

  it('multi-unit selection with one unproven endpoint declines without an edit', () => {
    const m = mount(mode, NORMALIZING)
    select(point(m.root, 'three'), unprovablePoint(m.root))
    // Document the proof outcome the decline depends on.
    const range = getSelection()!.getRangeAt(0)
    expect(
      proveSelectionSource(
        {
          index: m.index,
          snapshotPair: () => ({ exact: NORMALIZING, rendered: m.rendered() }),
        },
        m.root,
        range,
      ).status,
    ).toBe('unprovable')

    expect(captureProvenRewrapSelection(window)).toBeNull()
    expect(runRewrapCommand(window, m.deps)).toBe(false)
    expect(m.setValues).toEqual([])
    expect(m.deps.syncExact).not.toHaveBeenCalled()
    expect(m.deps.scheduleSync).not.toHaveBeenCalled()
  })

  // Contract 3.
  it('unprovable proof on a round-trip document: legacy capture is compared with the exact snapshot, not getValue()', () => {
    const m = mount(mode, ROUND_TRIP)
    // A stale rendering must not decide the capture: only the exact snapshot may.
    m.getValue.mockReturnValue('stale rendering')
    select(unprovablePoint(m.root), point(m.root, 'Omega', 5))

    const captured = captureProvenRewrapSelection(window)

    expect(captured).not.toBeNull()
    expect(captured?.markdown).toBe(ROUND_TRIP)
    expect(m.getValue).not.toHaveBeenCalled()
  })

  it('unprovable proof on a non-round-trip document declines (no fallback to the rendered path)', () => {
    const m = mount(mode, NORMALIZING)
    select(unprovablePoint(m.root), point(m.root, 'Omega', 5))

    expect(captureProvenRewrapSelection(window)).toBeNull()
    expect(runRewrapCommand(window, m.deps)).toBe(false)
    expect(m.setValues).toEqual([])
    expect(m.deps.syncExact).not.toHaveBeenCalled()
  })

  it('unavailable proof declines (no owned exact source)', () => {
    const m = mount(mode, NORMALIZING)
    m.state.exact = null
    select(point(m.root, 'three'), point(m.root, 'eight'))

    expect(captureProvenRewrapSelection(window)).toBeNull()
    expect(runRewrapCommand(window, m.deps)).toBe(false)
    expect(m.setValues).toEqual([])
  })

  // Owner rule: auto-wrap shares the capture path (it passes the rendered snapshot as
  // `authoritativeMarkdown`) and declines on an unproven target.
  it('auto-wrap path declines on an unproven target and ignores the rendered snapshot on a proven one', () => {
    const declined = mount(mode, NORMALIZING)
    select(unprovablePoint(declined.root), point(declined.root, 'Omega', 5))
    expect(runRewrapCommand(window, declined.deps, declined.rendered())).toBe(
      false,
    )
    expect(declined.setValues).toEqual([])
    expect(declined.deps.syncExact).not.toHaveBeenCalled()
    expect(declined.deps.scheduleSync).not.toHaveBeenCalled()
    unmountAll()

    const proven = mount(mode, NORMALIZING)
    const at = point(proven.root, 'orange', 3)
    select(at)
    const caret = NORMALIZING.indexOf('orange') + 3
    expect(runRewrapCommand(window, proven.deps, proven.rendered())).toBe(true)
    const plan = rewrapMarkdownRange(NORMALIZING, caret, caret, caret, COLUMN)
    expect(postedPlan(proven)).toBe(plan.markdown)
  })

  // Contract 5.
  it('selection scope applies through the exact sync path with one Undo step and the exact bytes', () => {
    const m = mount(mode, NORMALIZING)
    const renderedBefore = m.rendered()
    const nativeUndo = m.inner.undo.addToUndoStack
    select(point(m.root, 'three'), point(m.root, 'eight'))

    expect(runRewrapCommand(window, m.deps)).toBe(true)

    // Checkpoint before and after the rebuild: one Undo step returns to the first state.
    expect(nativeUndo).toHaveBeenCalledTimes(2)
    // `syncExact(markdown, undoMarkdown, undoRenderedMarkdown, hostBefore?)` is
    // called with the exact bytes and the rendering before the edit; the plain scheduler is idle.
    expect(m.deps.syncExact).toHaveBeenCalledOnce()
    const call = m.deps.syncExact.mock.calls[0]
    expect(call[1]).toBe(NORMALIZING)
    expect(call[2]).toBe(renderedBefore)
    expect(call[3]).toBeUndefined()
    expect(m.deps.scheduleSync).not.toHaveBeenCalled()
    // Delayed snapshots are suppressed, as for the document scope.
    expect(m.inner.undo.addToUndoStack).not.toBe(nativeUndo)
  })

  it('keeps the exact-history guard: declines a proven selection while an exact Undo/Redo transition is pending', () => {
    const m = mount(mode, NORMALIZING)
    select(point(m.root, 'three'), point(m.root, 'eight'))
    // Control: without a pending transition the same selection is proven.
    expect(
      proveSelectionSource(
        {
          index: m.index,
          snapshotPair: () => ({ exact: NORMALIZING, rendered: m.rendered() }),
        },
        m.root,
        getSelection()!.getRangeAt(0),
      ).status,
    ).toBe('proven')
    const nativeState = {}
    m.inner.undo[mode].redoStack.push(nativeState)
    const token = historyStoreOf(m.inner)?.redoTop(mode) as HistoryEntryToken
    expect(token).toBeDefined()
    recordRewrapDocumentHistory({
      owner: m.inner,
      mode,
      nativeState: token,
      beforeRendered: 'before',
      beforeExact: 'before',
      afterRendered: 'after',
      afterExact: 'after',
    })
    expect(hasRewrapDocumentHistoryTransition(m.inner)).toBe(true)

    expect(captureProvenRewrapSelection(window)).toBeNull()
    expect(runRewrapCommand(window, m.deps)).toBe(false)
    expect(m.setValues).toEqual([])
    expect(m.deps.syncExact).not.toHaveBeenCalled()
  })

  // Contract 5: the exact-sync arguments feed the history record, so one native Undo replays the
  // exact bytes before the edit and one Redo replays the planned bytes.
  it('selection scope history: the sync arguments record a transition that Undo and Redo replay exactly', () => {
    const m = mount(mode, NORMALIZING)
    select(point(m.root, 'three'), point(m.root, 'eight'))
    expect(runRewrapCommand(window, m.deps)).toBe(true)
    const planned = postedPlan(m)
    const [, undoExact, undoRendered] = m.deps.syncExact.mock.calls[0]
    expect(planned).not.toBe(NORMALIZING)
    const nativeState = {}
    // After the edit a native Undo pops the pre-edit state onto the redo stack.
    m.inner.undo[mode].redoStack.push(nativeState)
    const token = historyStoreOf(m.inner)?.redoTop(mode) as HistoryEntryToken
    expect(token).toBeDefined()
    recordRewrapDocumentHistory({
      owner: m.inner,
      mode,
      nativeState: token,
      beforeRendered: undoRendered,
      beforeExact: undoExact,
      afterRendered: m.rendered(),
      afterExact: planned,
    })
    expect(hasRewrapDocumentHistoryTransition(m.inner)).toBe(true)

    expect(takeRewrapDocumentHistorySync(m.inner, undoRendered)).toBe(
      NORMALIZING,
    )
    m.inner.undo[mode].redoStack.length = 0
    m.inner.undo[mode].undoStack.push(nativeState)
    expect(takeRewrapDocumentHistorySync(m.inner, m.rendered())).toBe(planned)
  })

  // Edge cases.
  it('backward selection captures the same offsets and plan as the forward selection', () => {
    const forward = mount(mode, NORMALIZING)
    select(point(forward.root, 'three'), point(forward.root, 'eight'))
    const forwardSelection = captureProvenRewrapSelection(window)
    expect(runRewrapCommand(window, forward.deps)).toBe(true)
    const forwardPlan = postedPlan(forward)
    unmountAll()

    const backward = mount(mode, NORMALIZING)
    select(point(backward.root, 'three'), point(backward.root, 'eight'), true)
    expect(getSelection()!.anchorNode).toBe(point(backward.root, 'eight').node)
    const backwardSelection = captureProvenRewrapSelection(window)

    expect(backwardSelection).not.toBeNull()
    expect(backwardSelection).toEqual(forwardSelection)
    expect(runRewrapCommand(window, backward.deps)).toBe(true)
    expect(postedPlan(backward)).toBe(forwardPlan)
  })

  it('an endpoint in a nested list keeps the edit inside the proven unit span', () => {
    const nested = `${TABLE}\n\n- top item\n  - ${P1}\n  - second nested\n- last item\n\n${P2}\n`
    const m = mount(mode, nested)
    select(point(m.root, 'three'))
    const caret = nested.indexOf('three')
    const proof = proveSelectionSource(
      {
        index: m.index,
        snapshotPair: () => ({ exact: nested, rendered: m.rendered() }),
      },
      m.root,
      getSelection()!.getRangeAt(0),
    )
    expect(proof.status).toBe('proven')
    if (proof.status !== 'proven') return

    const ran = runRewrapCommand(window, m.deps)

    const plan = rewrapMarkdownRange(nested, caret, caret, caret, COLUMN)
    expect(plan.changed).toBe(true)
    expect(ran).toBe(true)
    expect(postedPlan(m)).toBe(plan.markdown)
    expectEditWithin(nested, plan.markdown, proof.start.unitExact)
  })

  // Edge case: list and table boundaries. Every unit between the proven endpoints has a paired
  // exact span, and the bytes of the table or list outside the rewrapped paragraphs stay unchanged.
  it('a selection crossing a table is a planner no-op: no edit, no post, table bytes intact', () => {
    const spanning = `${P1}\n\n${TABLE}\n\n${P2}\n`
    const m = mount(mode, spanning)
    const range = select(point(m.root, 'three'), point(m.root, 'green'))
    // Both endpoints are provable, so the decline comes from the planner, not from the proof.
    expect(
      proveSelectionSource(
        {
          index: m.index,
          snapshotPair: () => ({ exact: spanning, rendered: m.rendered() }),
        },
        m.root,
        range,
      ).status,
    ).toBe('proven')
    const start = spanning.indexOf('three')
    const end = spanning.indexOf('green')
    expect(rewrapMarkdownRange(spanning, start, end, end, COLUMN).changed).toBe(
      false,
    )

    expect(runRewrapCommand(window, m.deps)).toBe(false)
    expect(m.setValues).toEqual([])
    expect(m.deps.syncExact).not.toHaveBeenCalled()
    expect(m.deps.scheduleSync).not.toHaveBeenCalled()
  })

  it('a selection starting in a table cell changes no bytes (the planner leaves the table alone)', () => {
    const m = mount(mode, NORMALIZING)
    select(point(m.root, 'x'), point(m.root, 'eight'))
    const start = NORMALIZING.indexOf('x')
    const end = NORMALIZING.indexOf('eight')
    expect(
      rewrapMarkdownRange(NORMALIZING, start, end, end, COLUMN).changed,
    ).toBe(false)

    expect(runRewrapCommand(window, m.deps)).toBe(false)
    expect(m.setValues).toEqual([])
    expect(m.deps.syncExact).not.toHaveBeenCalled()
    expect(m.deps.scheduleSync).not.toHaveBeenCalled()
  })

  it('a selection from a list item into the next paragraph edits only the paragraphs and keeps the list bytes', () => {
    const list = `${TABLE}\n\n- one alpha\n- two gamma\n\n${P1}\n`
    const m = mount(mode, list)
    select(point(m.root, 'two'), point(m.root, 'eight'))
    const start = list.indexOf('two')
    const end = list.indexOf('eight')

    expect(runRewrapCommand(window, m.deps)).toBe(true)

    const plan = rewrapMarkdownRange(list, start, end, end, COLUMN)
    expect(postedPlan(m)).toBe(plan.markdown)
    const head = list.slice(0, list.indexOf(P1))
    expect(plan.markdown.startsWith(head)).toBe(true)
  })

  it.each([
    ['a table cell', `${TABLE}\n\n${P1}\n`, 'x', 1],
    ['a fenced code block', `${TABLE}\n\n\`\`\`\n${P1}\n\`\`\`\n`, 'three', 2],
    [
      'front matter',
      `---\ntitle: ${P1}\n---\n\n${TABLE}\n\n${P2}\n`,
      'three',
      2,
    ],
  ] as const)(
    'a caret inside %s changes no bytes',
    (_name, source, needle, delta) => {
      const m = mount(mode, source)
      select(point(m.root, needle, delta))

      expect(runRewrapCommand(window, m.deps)).toBe(false)
      expect(m.setValues).toEqual([])
      expect(m.deps.syncExact).not.toHaveBeenCalled()
    },
  )
})

// Front matter and math remain separate units while body selections retain exact offsets.
describe.each(['ir', 'wysiwyg'] as const)(
  '%s: Rewrap and heading shift beside front matter and math',
  (mode) => {
    const FRONT = `---\ntitle: x\n---\n\n# Head\n\n${P1}\n`

    it('Rewrap applies after front matter with the exact source prefix', () => {
      const m = mount(mode, FRONT)
      select(point(m.root, 'three', 2))
      expect(runRewrapCommand(window, m.deps)).toBe(true)
      expect(postedPlan(m)).toBe(
        rewrapMarkdownRange(
          FRONT,
          FRONT.indexOf('three') + 2,
          FRONT.indexOf('three') + 2,
          FRONT.indexOf('three') + 2,
          COLUMN,
        ).markdown,
      )
    })

    it('heading shift applies after front matter with shifted offsets', () => {
      const m = mount(mode, FRONT)
      select(point(m.root, 'Head', 1))
      expect(runHeadingLevelShift(window, m.deps, 1)).toBe(true)
      expect(postedPlan(m)).toBe(FRONT.replace('# Head', '## Head'))
    })

    it('proves body ranges with shifted offsets and declines front matter endpoints', () => {
      const prefix = '---\ntitle: x\n---\n\n'
      for (const body of [`# Head\n\n${P1}\n`, `$$x$$\n\n${P1}\n`]) {
        const m = mount(mode, prefix + body)
        const source = {
          index: m.index,
          snapshotPair: () => ({ exact: m.exact, rendered: m.rendered() }),
        }
        const proof = proveSelectionSource(
          source,
          m.root,
          select(point(m.root, 'three', 2), point(m.root, 'eight', 3)),
        )
        expect(proof.status).toBe('proven')
        if (proof.status === 'proven') {
          expect(proof.start.exact).toBe(
            prefix.length + body.indexOf('three') + 2,
          )
          expect(proof.end.exact).toBe(
            prefix.length + body.indexOf('eight') + 3,
          )
        }
        expect(
          proveSelectionSource(
            source,
            m.root,
            select(point(m.root, 'title', 2)),
          ).status,
        ).toBe('unprovable')
        select(point(m.root, 'three', 2))
        expect(runRewrapCommand(window, m.deps, m.rendered())).toBe(true)
        expect(postedPlan(m).startsWith(prefix)).toBe(true)
      }
    })

    it('Rewrap applies after a round-trip `$$` block', () => {
      const m = mount(mode, `$$\nx^2\n$$\n\n${P1}\n`)
      select(point(m.root, 'three', 2))
      expect(runRewrapCommand(window, m.deps)).toBe(true)
    })
  },
)

// Contract 4: the document rewrap bytes never depend on the caret, only the caret offset moves.
// Carets between CR and LF are unreachable (the proof rejects them) and carets on a list marker are
// not rendered text, so both are excluded; every reachable caret must give the same bytes.
describe('rewrapMarkdownDocument caret-independence', () => {
  it.each([
    ['LF', NORMALIZING, 0],
    ['CRLF', NORMALIZING.replace(/\n/g, '\r\n'), 0],
    ['list', `${TABLE}\n\n- one ${P1}\n- two\n\n${P2}\n`, 29],
  ] as const)(
    'writes the same bytes for every reachable caret offset (%s)',
    (_name, source, from) => {
      const bytes = new Set<string>()
      for (let caret = from; caret <= source.length; caret++) {
        if (source[caret - 1] === '\r' && source[caret] === '\n') continue
        bytes.add(rewrapMarkdownDocument(source, caret, COLUMN).markdown)
      }
      expect(bytes.size).toBe(1)
      expect([...bytes][0]).not.toBe(source)
    },
  )
})

// CRLF and boundary edge cases do not depend on the mode.
describe('CRLF and surrogate boundaries', () => {
  const CRLF = NORMALIZING.replace(/\n/g, '\r\n')

  it('CRLF document: edits only the target paragraph and keeps CRLF line endings', () => {
    const m = mount('ir', CRLF)
    select(point(m.root, 'three'), point(m.root, 'eight'))
    const start = CRLF.indexOf('three')
    const end = CRLF.indexOf('eight')

    expect(runRewrapCommand(window, m.deps)).toBe(true)

    const plan = rewrapMarkdownRange(CRLF, start, end, end, COLUMN)
    expect(postedPlan(m)).toBe(plan.markdown)
    const p1 = CRLF.indexOf(P1)
    expectEditWithin(CRLF, plan.markdown, [p1, p1 + P1.length + 2])
    expect(plan.markdown.replace(/\r\n/g, '')).not.toContain('\n')
  })

  // The capture must equal the proof for every caret offset of a soft break: a caret between CR
  // and LF is never reported, and an unproven offset declines. Mixed endings (an LF table in a CRLF
  // document) make the proof reject the offset at the line end, so the decline branch is exercised.
  it.each([
    ['pure CRLF', NORMALIZING.replace(/\n/g, '\r\n'), false],
    ['mixed endings', `${TABLE}\r\n\r\nfirst line\r\nsecond line\r\n`, true],
  ] as const)(
    'every caret offset of a soft break matches the proof (%s)',
    (_name, source, expectDecline) => {
      const m = mount('ir', source)
      const text = point(
        m.root,
        source.includes('first line') ? 'first line' : 'Alpha',
      ).node
      const pair = () => ({ exact: source, rendered: m.rendered() })
      let proofDeclines = 0
      let captureDeclines = 0
      for (let offset = 0; offset <= text.data.length; offset++) {
        const range = select({ node: text, offset })
        const proof = proveSelectionSource(
          { index: m.index, snapshotPair: pair },
          m.root,
          range,
        )
        const captured = captureProvenRewrapSelection(window)
        if (proof.status !== 'proven') proofDeclines++
        if (!captured) captureDeclines++
        else {
          expect(captured.markdown).toBe(source)
          expect(captured.caretOffset).toBe(
            proof.status === 'proven' ? proof.start.exact : -1,
          )
          const at = captured.caretOffset
          expect(source.slice(at - 1, at + 1)).not.toBe('\r\n')
        }
      }
      expect(proofDeclines > 0).toBe(expectDecline)
      expect(captureDeclines).toBe(proofDeclines)
    },
  )

  it('a caret inside a surrogate pair declines', () => {
    const source = `${TABLE}\n\nemoji \u{1F600} and a long enough tail to need a wrap here\n`
    const m = mount('ir', source)
    const { node, offset } = point(m.root, '\u{1F600}')
    const range = select({ node, offset: offset + 1 })
    expect(
      proveSelectionSource(
        {
          index: m.index,
          snapshotPair: () => ({ exact: source, rendered: m.rendered() }),
        },
        m.root,
        range,
      ).status,
    ).toBe('unprovable')

    expect(captureProvenRewrapSelection(window)).toBeNull()
    expect(runRewrapCommand(window, m.deps)).toBe(false)
    expect(m.setValues).toEqual([])
    expect(m.deps.syncExact).not.toHaveBeenCalled()
  })
})

// Task 606 review: the planned bytes never depend on the caret, including carets inside the
// line-start syntax of a heading, fence, list marker or block quote prefix (offset 0 through the
// prefix). Only `caretOffset` may move.
describe('planner bytes are independent of a caret in line-start syntax', () => {
  const LONG = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda'
  const DOCS = [
    ['heading', `# ${LONG}\n\n${P1}\n`],
    ['fence', `\`\`\`js\n${LONG}\n\`\`\`\n\n${P1}\n`],
    ['bullet list', `- ${LONG}\n- two ${LONG}\n\n${P1}\n`],
    ['ordered list', `1. ${LONG}\n2. two ${LONG}\n\n${P1}\n`],
    ['block quote', `> ${LONG}\n> ${LONG}\n\n${P1}\n`],
    ['nested quote list', `> - ${LONG}\n\n${P1}\n`],
  ] as const

  it.each(DOCS)('document scope: %s', (_name, source) => {
    const bytes = new Set<string>()
    for (let caret = 0; caret <= source.length; caret++)
      bytes.add(rewrapMarkdownDocument(source, caret, COLUMN).markdown)
    expect(bytes.size).toBe(1)
  })

  it.each(DOCS)('range scope over the whole document: %s', (_name, source) => {
    const bytes = new Set<string>()
    for (let caret = 0; caret <= source.length; caret++)
      bytes.add(
        rewrapMarkdownRange(source, 0, source.length, caret, COLUMN).markdown,
      )
    expect(bytes.size).toBe(1)
  })
})

// Task 606 S3.1: heading shift is proof-only in IR and WYSIWYG, like selection Rewrap.
describe.each(['ir', 'wysiwyg'] as const)(
  '%s: proof-only heading shift',
  (mode) => {
    const HEADINGS = `${TABLE}\n\n# Title one\n\n## Sub heading\n\n${P2}\n`

    it('a proven caret applies the exact plan, with one Undo step and no plain sync', () => {
      const m = mount(mode, HEADINGS)
      const nativeUndo = m.inner.undo.addToUndoStack
      const renderedBefore = m.rendered()
      const caret = HEADINGS.indexOf('Sub') + 1
      select(point(m.root, 'Sub', 1))

      expect(runHeadingLevelShift(window, m.deps, 1)).toBe(true)

      const plan = shiftMarkdownHeadingLevels({
        markdown: HEADINGS,
        startOffset: caret,
        endOffset: caret,
        caretOffset: caret,
        direction: 1,
        section: false,
      })
      expect(plan.status).toBe('ok')
      if (plan.status !== 'ok') return
      expect(postedPlan(m)).toBe(plan.markdown)
      expect(plan.markdown).toBe(HEADINGS.replace('## Sub', '### Sub'))
      const call = m.deps.syncExact.mock.calls[0]
      expect(call[1]).toBe(HEADINGS)
      expect(call[2]).toBe(renderedBefore)
      expect(call[3]).toBeUndefined()
      expect(m.deps.scheduleSync).not.toHaveBeenCalled()
      expect(nativeUndo).toHaveBeenCalledTimes(2)
    })

    it('an unprovable caret on a non-round-trip document declines without an edit', () => {
      const m = mount(mode, HEADINGS)
      select(unprovablePoint(m.root))

      expect(runHeadingLevelShift(window, m.deps, 1)).toBe(false)
      expect(m.setValues).toEqual([])
      expect(m.deps.syncExact).not.toHaveBeenCalled()
      expect(m.deps.scheduleSync).not.toHaveBeenCalled()
    })

    it('an unavailable proof declines', () => {
      const m = mount(mode, HEADINGS)
      m.state.exact = null
      select(point(m.root, 'Sub', 1))
      expect(runHeadingLevelShift(window, m.deps, 1)).toBe(false)
      expect(m.setValues).toEqual([])
    })

    it('declines with no bound source', () => {
      const m = mount(mode, HEADINGS, false)
      select(point(m.root, 'Sub', 1))
      expect(runHeadingLevelShift(window, m.deps, 1)).toBe(false)
      expect(m.setValues).toEqual([])
    })
  },
)

describe.each(['ir', 'wysiwyg'] as const)(
  '%s: proof-only document Rewrap',
  (mode) => {
    const prefix = '---\ntitle: x\n---\n\n'
    const source = `${prefix}$$\nx^2\n$$\n\n${P1}\n\n${P2}\n`
    it('keeps the exact front matter separator while proving and rewrapping the document caret', () => {
      const m = mount(mode, source)
      // The historical one-byte discrepancy is exactly the source-only blank after YAML.
      expect(m.rendered()).toBe(source.replace('---\n\n$$', () => '---\n$$'))
      expect(source.length - m.rendered().length).toBe(1)
      select(point(m.root, 'three', 2))
      const prepared = captureRewrapSourceSelection(window, { proofOnly: true })
      expect(prepared?.markdown).toBe(source)
      expect(prepared?.caretOffset).toBe(source.indexOf('three') + 2)
      expect(runRewrapDocumentCommand(window, m.deps, source, prepared)).toBe(
        true,
      )
      expect(postedPlan(m)).toBe(
        rewrapMarkdownDocument(source, source.indexOf('three') + 2, COLUMN)
          .markdown,
      )
      expect(m.deps.syncExact.mock.calls[0][3]).toBe(source)
    })
    it('declines unprovable document carets, changed host bytes and a replaced DOM after prepare', () => {
      const m = mount(mode, source)
      select(unprovablePoint(m.root))
      expect(
        captureRewrapSourceSelection(window, { proofOnly: true }),
      ).toBeNull()
      expect(runRewrapDocumentCommand(window, m.deps, source)).toBe(false)
      select(point(m.root, 'three', 2))
      const prepared = captureRewrapSourceSelection(window, { proofOnly: true })
      expect(
        runRewrapDocumentCommand(window, m.deps, m.rendered(), prepared),
      ).toBe(false)
      m.root.innerHTML = m.real.render(source)
      expect(runRewrapDocumentCommand(window, m.deps, source, prepared)).toBe(
        false,
      )
      expect(m.setValues).toEqual([])
      expect(m.deps.syncExact).not.toHaveBeenCalled()
    })
  },
)

it.each(['ir', 'wysiwyg'] as const)(
  '%s: exact range capture for selection Link keeps front matter offsets',
  (mode) => {
    const source = `---\ntitle: doc\n---\n\n${P1}\n`
    const m = mount(mode, source)
    const range = select(point(m.root, 'three'), point(m.root, 'three', 5))
    const captured = captureRewrapSourceRange(window, range, {
      authoritativeMarkdown: source,
    })
    expect(captured).toMatchObject({
      markdown: source,
      startOffset: source.indexOf('three'),
      endOffset: source.indexOf('three') + 5,
    })
  },
)

it('keeps source-mode front matter capture on the source mapping path', () => {
  const source = `---\ntitle: doc\n---\n\n${P1}\n`
  const m = mount('ir', source)
  m.inner.currentMode = 'sv'
  m.inner.sv = { element: m.root }
  m.root.textContent = source
  const range = select(point(m.root, 'three'), point(m.root, 'three', 5))
  expect(
    captureRewrapSourceRange(window, range, { authoritativeMarkdown: source }),
  ).toMatchObject({
    markdown: source,
    startOffset: source.indexOf('three'),
    endOffset: source.indexOf('three') + 5,
  })
})

it.each(['ir', 'wysiwyg'] as const)(
  '%s: front matter does not enable legacy range capture for an already normalizing body',
  (mode) => {
    for (const prefix of ['', '---\ntitle: doc\n---\n\n']) {
      const source = prefix + NORMALIZING
      const m = mount(mode, source)
      const range = select(point(m.root, 'three'), point(m.root, 'three', 5))
      expect(
        captureRewrapSourceRange(window, range, {
          authoritativeMarkdown: source,
        }),
      ).toBeNull()
    }
  },
)

// Task 666: selection Link maps a paragraph selection on a normalizing body through the proof
// (opt-in `proveNormalizingBody`), never through the marker capture.
const FRONT_MATTER = '---\ntitle: doc\n---\n\n'

it.each(['ir', 'wysiwyg'] as const)(
  '%s: Task 666 selection Link capture proves a paragraph on a normalizing body and plans only that span',
  (mode) => {
    for (const prefix of ['', FRONT_MATTER]) {
      const source = prefix + NORMALIZING
      const m = mount(mode, source)
      expect(m.rendered()).not.toBe(source)
      const range = select(point(m.root, 'three'), point(m.root, 'three', 5))
      const captured = captureRewrapSourceRange(window, range, {
        authoritativeMarkdown: source,
        proveNormalizingBody: true,
      })
      const start = source.indexOf('three')
      expect(captured).toMatchObject({
        markdown: source,
        startOffset: start,
        endOffset: start + 5,
      })
      const plan = planSelectedLink(source, start, start + 5, 'three', 'link')
      expect(plan).toMatchObject({
        status: 'changed',
        markdown: `${source.slice(0, start)}[three]()${source.slice(start + 5)}`,
      })
    }
  },
)

// The same rendering as NORMALIZING with a padded table: the owned exact text differs from the
// acquired text, but a proof against it would still be `proven`, so only the exact-text check refuses.
const PADDED_NORMALIZING = `| a | b |\n|---|---|\n| x | y |\n\n${P1}\n\n${P2}\n`

it.each(['ir', 'wysiwyg'] as const)(
  '%s: Task 666 selection Link capture declines when the owned exact text is not the acquired text',
  (mode) => {
    const m = mount(mode, NORMALIZING)
    m.state.exact = PADDED_NORMALIZING
    const range = select(point(m.root, 'three'), point(m.root, 'three', 5))
    // The proof alone would succeed against the owned text: only the exact-text check refuses.
    expect(
      proveSelectionSource(
        {
          index: m.index,
          snapshotPair: () => ({
            exact: m.state.exact,
            rendered: m.rendered(),
          }),
        },
        m.root,
        range,
      ).status,
    ).toBe('proven')
    expect(
      captureRewrapSourceRange(window, range, {
        authoritativeMarkdown: NORMALIZING,
        proveNormalizingBody: true,
      }),
    ).toBeNull()
  },
)

it.each(['ir', 'wysiwyg'] as const)(
  '%s: Task 666 selection Link capture declines a multi-unit selection on a normalizing body without the marker fallback',
  (mode) => {
    const serializer = mode === 'ir' ? 'VditorIRDOM2Md' : 'VditorDOM2Md'
    // Paragraph to paragraph, and table cell to paragraph (the table mapping must not run either).
    for (const [from, to] of [
      ['three', 'Omega'],
      ['y', 'three'],
    ] as const) {
      const m = mount(mode, NORMALIZING)
      const spy = vi.spyOn(m.inner.lute, serializer)
      const before = m.root.innerHTML
      const range = select(point(m.root, from), point(m.root, to, 1))
      // The proof succeeds across two units, so the single-unit rule is what refuses.
      const proof = proveSelectionSource(
        {
          index: m.index,
          snapshotPair: () => ({ exact: NORMALIZING, rendered: m.rendered() }),
        },
        m.root,
        range,
      )
      expect(proof.status).toBe('proven')
      if (proof.status === 'proven')
        expect(proof.start.unit).not.toBe(proof.end.unit)
      spy.mockClear()
      expect(
        captureRewrapSourceRange(window, range, {
          authoritativeMarkdown: NORMALIZING,
          proveNormalizingBody: true,
        }),
      ).toBeNull()
      // Proof-only: the marker serializer never ran and no marker was left in the DOM.
      expect(spy).not.toHaveBeenCalled()
      expect(m.root.innerHTML).toBe(before)
    }
  },
)

// Task 680: the normalizing capture reads the source pair once and hands it to the proof, so a
// large normalizing document does not serialize twice per gesture.
it.each(['ir', 'wysiwyg'] as const)(
  '%s: Task 680 selection Link capture on a normalizing body reads the source pair once',
  (mode) => {
    const m = mount(mode, NORMALIZING, false)
    const counted = vi.fn(() => ({
      exact: m.state.exact,
      rendered: m.rendered(),
    }))
    teardown.push(bindRewrapSource({ index: m.index, snapshotPair: counted }))
    m.index.read()
    const start = NORMALIZING.indexOf('three')

    counted.mockClear()
    const single = select(point(m.root, 'three'), point(m.root, 'three', 5))
    expect(
      captureRewrapSourceRange(window, single, {
        authoritativeMarkdown: NORMALIZING,
        proveNormalizingBody: true,
      }),
    ).toMatchObject({ startOffset: start, endOffset: start + 5 })
    expect(counted).toHaveBeenCalledTimes(1)

    // The Details path (units may cross) shares the capture.
    counted.mockClear()
    const crossing = select(point(m.root, 'three'), point(m.root, 'Omega', 1))
    expect(
      captureRewrapSourceRange(window, crossing, {
        authoritativeMarkdown: NORMALIZING,
        proveNormalizingBody: true,
        proofMayCrossUnits: true,
      }),
    ).not.toBeNull()
    expect(counted).toHaveBeenCalledTimes(1)

    // A stale owned exact text declines on the first read, before any proof.
    counted.mockClear()
    m.state.exact = PADDED_NORMALIZING
    expect(
      captureRewrapSourceRange(window, single, {
        authoritativeMarkdown: NORMALIZING,
        proveNormalizingBody: true,
      }),
    ).toBeNull()
    expect(counted).toHaveBeenCalledTimes(1)
  },
)

it.each(['ir', 'wysiwyg'] as const)(
  '%s: Task 666 a spaced thematic break does not make a normalizing document unprovable',
  (mode) => {
    const source = `${TABLE}\n\n* * *\n\n${P1}\n`
    const m = mount(mode, source)
    expect(m.rendered()).not.toBe(source)
    const range = select(point(m.root, 'three'), point(m.root, 'three', 5))
    const start = source.indexOf('three')
    expect(
      captureRewrapSourceRange(window, range, {
        authoritativeMarkdown: source,
        proveNormalizingBody: true,
      }),
    ).toMatchObject({
      markdown: source,
      startOffset: start,
      endOffset: start + 5,
    })
  },
)

// Task 671: callout apply on a normalizing body maps the retained selection through the proof,
// not through the n-th-line mapping, which edits the wrong one of two identical paragraphs.
// Lute strips the indentation of the first paragraph, so both render as the same line.
const DUPLICATE_LINES =
  '# Duplicate lines\n\neditword paragraph before the duplicates\n\n   dupword paragraph shown twice\n\ndupword paragraph shown twice\n\nclosing paragraph\n'
const DUPLICATE_TEXT = 'dupword paragraph shown twice'
const NOTE = { kind: 'apply', type: 'note', title: 'Proof' } as const

interface CalloutRun {
  ok: boolean
  posted: string[]
  acquire: ReturnType<typeof vi.fn>
}

/** Run one callout apply with a host that holds `source`; `target` reuses a captured target. */
async function applyCallout(
  m: Mounted,
  source: string,
  target?: ReturnType<typeof captureCalloutActionTarget>,
): Promise<CalloutRun> {
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 1)
  const posted: string[] = []
  const acquire = vi.fn(async () => ({ exact: source, rendered: m.rendered() }))
  const ok = await runCalloutAction(
    window,
    {
      acquireExactAuthority: acquire,
      setApplying: vi.fn(),
      postExact: (markdown) => {
        posted.push(markdown)
      },
      onError: (error) => {
        throw error
      },
    },
    NOTE,
    target,
  )
  return { ok, posted, acquire }
}

it.each(['ir', 'wysiwyg'] as const)(
  '%s: Task 671 callout apply on a normalizing body converts the selected one of two duplicate-text paragraphs',
  async (mode) => {
    for (const prefix of ['', FRONT_MATTER]) {
      const source = prefix + DUPLICATE_LINES
      const m = mount(mode, source)
      expect(m.rendered()).not.toBe(source)
      select(
        point(m.root, 'dupword'),
        point(m.root, 'dupword', DUPLICATE_TEXT.length),
      )
      const start = source.indexOf('dupword')
      const run = await applyCallout(m, source)

      expect(run.ok).toBe(true)
      // Only the first paragraph (the indented one) is converted; the second stays as it was.
      expect(run.posted).toEqual([
        transformCalloutMarkdown(
          source,
          start,
          start + DUPLICATE_TEXT.length,
          NOTE,
        ).markdown,
      ])
      expect(run.posted[0]).toContain(
        `> [!NOTE] Proof\n>    ${DUPLICATE_TEXT}\n\n${DUPLICATE_TEXT}\n`,
      )
      unmountAll()
    }
  },
)

it.each(['ir', 'wysiwyg'] as const)(
  '%s: Task 671 callout apply declines an unprovable selection on a normalizing body without the line mapping',
  async (mode) => {
    const m = mount(mode, DUPLICATE_LINES)
    // An element-offset start inside the paragraph: the marker capture and the line mapping would
    // still place it, but the proof refuses element offsets.
    const paragraph = point(m.root, 'dupword').node.parentElement!
    select(
      { node: paragraph, offset: 0 },
      point(m.root, 'dupword', DUPLICATE_TEXT.length),
    )
    const run = await applyCallout(m, DUPLICATE_LINES)

    expect(run.ok).toBe(false)
    expect(run.posted).toEqual([])
    expect(m.setValues).toEqual([])
  },
)

it.each(['ir', 'wysiwyg'] as const)(
  '%s: Task 671 callout apply declines when the retained range no longer belongs to the editor',
  async (mode) => {
    const m = mount(mode, DUPLICATE_LINES)
    select(
      point(m.root, 'dupword'),
      point(m.root, 'dupword', DUPLICATE_TEXT.length),
    )
    const target = captureCalloutActionTarget(window)
    expect(target).not.toBeNull()
    // The editor rebuilds its DOM between the capture and the apply: the captured nodes are gone.
    m.root.innerHTML = m.real.render(DUPLICATE_LINES)
    const run = await applyCallout(m, DUPLICATE_LINES, target)

    expect(run.ok).toBe(false)
    expect(run.posted).toEqual([])
    expect(m.setValues).toEqual([])
  },
)

it.each(['ir', 'wysiwyg'] as const)(
  '%s: Task 671 callout apply keeps CRLF bytes outside the converted paragraph',
  async (mode) => {
    const source = NORMALIZING.replace(/\n/gu, '\r\n')
    const m = mount(mode, source)
    select(point(m.root, 'three'), point(m.root, 'three', 5))
    const start = source.indexOf('three')
    const run = await applyCallout(m, source)

    expect(run.ok).toBe(true)
    expect(run.posted).toEqual([
      transformCalloutMarkdown(source, start, start + 5, NOTE).markdown,
    ])
    // The table and the second paragraph keep their original CRLF bytes.
    expect(
      run.posted[0].startsWith(`${TABLE.replace(/\n/gu, '\r\n')}\r\n`),
    ).toBe(true)
    expect(run.posted[0].endsWith(`${P2}\r\n`)).toBe(true)
  },
)
