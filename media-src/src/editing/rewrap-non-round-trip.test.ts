// @vitest-environment jsdom
// Task 606 S2a: proof-only Rewrap on documents whose rendering differs from their source.
// Real Lute renders and serializes the documents; the shared source index and the Task 604 proof
// supply the exact offsets. Each case names the acceptance item or edge case it covers.
//
// Case group -> record item (tasks/606, Acceptance A1-A4 and Part 1 handoff Contract C1-C6):
//   single/multi-unit proven selection, exact-plan payload, bytes outside target ... A1, A2, C1, C2
//   unproven endpoint, unavailable proof, auto-wrap path (no rendered fallback) ..... A1, C2, C3, Owner proof-only
//   legacy capture only when unprovable and round-trip, vs the exact snapshot ........ C3
//   caret-independence of rewrapMarkdownDocument bytes (planner only; document Rewrap keeps the
//     line-based caret, proof extension: Task 670) ................................... C4
//   selection scope exact sync, one Undo step, history record/replay, history guard ... A2, C5
//   edge cases: backward, nested list, list/table boundary selections, table/code/
//     front matter caret, CRLF, mixed endings, surrogate pair ......................... Edge cases
//   Not here: passive Details inserts no live marker (C6) -> Chromium step S4 (needs the
//     details-toggle passive path and a real index); cold index, mode switch between prepare and
//     run, caret-bias two-boundary decline -> S4 / not constructible with this fixture.
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
  hasRewrapDocumentHistoryTransition,
  recordRewrapDocumentHistory,
  runRewrapCommand,
  runHeadingLevelShift,
  runRewrapDocumentCommand,
  takeRewrapDocumentHistorySync,
} from './rewrap-command'
import { rewrapMarkdownDocument, rewrapMarkdownRange } from './rewrap-markdown'
import { shiftMarkdownHeadingLevels } from '../nav/section-range'
import { proveSelectionSource } from './selection-source-proof'

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
function markedCaret(marked: string, planned: string): number {
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
    recordRewrapDocumentHistory({
      owner: m.inner,
      mode,
      nativeState,
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
    recordRewrapDocumentHistory({
      owner: m.inner,
      mode,
      nativeState,
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

// Known limitation (Task 670): the proof cannot pair a front matter block, so Rewrap and heading
// shift decline on a document that has one. A `$$` block is paired when the document round-trips.
describe.each(['ir', 'wysiwyg'] as const)(
  '%s: Rewrap and heading shift beside front matter and math',
  (mode) => {
    const FRONT = `---\ntitle: x\n---\n\n# Head\n\n${P1}\n`

    it('Rewrap declines after front matter (Task 670)', () => {
      const m = mount(mode, FRONT)
      select(point(m.root, 'three', 2))
      expect(runRewrapCommand(window, m.deps)).toBe(false)
      expect(m.setValues).toEqual([])
      expect(m.deps.syncExact).not.toHaveBeenCalled()
    })

    it('heading shift declines after front matter (Task 670)', () => {
      const m = mount(mode, FRONT)
      select(point(m.root, 'Head', 1))
      expect(runHeadingLevelShift(window, m.deps, 1)).toBe(false)
      expect(m.setValues).toEqual([])
      expect(m.deps.syncExact).not.toHaveBeenCalled()
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
