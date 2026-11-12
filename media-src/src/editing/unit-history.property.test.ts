// @vitest-environment jsdom
import fc from 'fast-check'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { patchLuteGapRepair } from '../../../src/shared/lute-gap-repair'
import { patchLuteTableCodePipes } from '../../../src/shared/table-code-pipes'
import { createModelSession, type ModelSession } from '../bridge/model-session'
import type { UnitLute } from '../bridge/unit-lute'
import { createRealLute } from '../testing/real-lute'
import { installUnitHistory } from './unit-history'

// Task 733 (task 004): property test of the unit engine over a real model session, real Lute and a
// jsdom IR root. Random sequences of in-cell, in-paragraph, Enter and Backspace edits, one history
// entry after each; Undo all, then Redo all. At every step the model text equals the text recorded
// at that checkpoint and the DOM canon equals the canon of that text. The oracle is the recorded
// state of each checkpoint, not the old engine (handoff 004-P1 section 9, Q-P1-8 option a). The seed
// is fixed; a failing property prints it with the shrunk counterexample.

const engine = vi.hoisted(() => ({ value: 'unit' as 'unit' | 'vditor' }))
vi.mock('./history-store', async (original) => ({
  ...(await original<typeof import('./history-store')>()),
  get IR_HISTORY_ENGINE() {
    return engine.value
  },
}))

const RUN = { seed: 733004, numRuns: 40 }
const TIMEOUT = 120_000
const DOC =
  'alpha\n\nbeta\n\ngamma\n\n| a | b |\n| - | - |\n| c | d |\n| e | f |\n\n- one\n- two\n- three\n'

let lute: UnitLute
beforeAll(() => {
  const real = createRealLute('ir')
  patchLuteTableCodePipes(real.lute)
  patchLuteGapRepair(real.lute)
  lute = real.lute
})

type Op =
  | { kind: 'cell'; at: number; word: string }
  | { kind: 'paragraph'; at: number; word: string }
  | { kind: 'enter'; at: number; word: string }
  | { kind: 'backspace'; at: number }
  | { kind: 'item'; at: number; word: string }
  | { kind: 'enterItem'; at: number; word: string }
  | { kind: 'mergeItems'; at: number }

const word = fc.stringMatching(/^[a-z]{1,6}$/u)
const opArbitrary: fc.Arbitrary<Op> = fc.oneof(
  fc.record({ kind: fc.constant('cell' as const), at: fc.nat(3), word }),
  fc.record({ kind: fc.constant('paragraph' as const), at: fc.nat(9), word }),
  fc.record({ kind: fc.constant('enter' as const), at: fc.nat(9), word }),
  fc.record({ kind: fc.constant('backspace' as const), at: fc.nat(9) }),
  fc.record({ kind: fc.constant('item' as const), at: fc.nat(9), word }),
  fc.record({ kind: fc.constant('enterItem' as const), at: fc.nat(9), word }),
  fc.record({ kind: fc.constant('mergeItems' as const), at: fc.nat(9) }),
)

/** The structure the user sees, independent of editor-only attributes: tag and text per block. */
function canon(root: ParentNode): string[] {
  return Array.from(root.children).map(
    (el) =>
      `${el.localName}:${Array.from(el.querySelectorAll('td, th'))
        .map((cell) => cell.textContent)
        .join('|')}${el.localName === 'table' ? '' : (el.textContent ?? '')}`,
  )
}

/** The pre-touch proof of the model runs before the editor changes a block. */
const fire = (el: Element) =>
  el.dispatchEvent(new Event('beforeinput', { bubbles: true }))

const paragraphsOf = (root: HTMLElement) =>
  Array.from(root.querySelectorAll(':scope > p'))
const itemsOf = (root: HTMLElement) => Array.from(root.querySelectorAll('li'))

type Handlers = {
  [K in Op['kind']]: (root: HTMLElement, op: Extract<Op, { kind: K }>) => void
}

const HANDLERS: Handlers = {
  cell(root, op) {
    const cells = Array.from(root.querySelectorAll('td'))
    const cell = cells[op.at % cells.length]
    fire(cell)
    cell.textContent = `${op.word}${cell.textContent}`
  },
  paragraph(root, op) {
    const paragraphs = paragraphsOf(root)
    const target = paragraphs[op.at % paragraphs.length]
    fire(target)
    target.textContent = `${target.textContent}${op.word}`
  },
  enter(root, op) {
    const paragraphs = paragraphsOf(root)
    const added = document.createElement('p')
    added.setAttribute('data-block', '0')
    added.textContent = '​'
    paragraphs[op.at % paragraphs.length].after(added)
    fire(added)
    added.textContent = op.word
  },
  // Backspace at a paragraph start merges the paragraph into the one before it.
  backspace(root, op) {
    const paragraphs = paragraphsOf(root)
    const index = 1 + (op.at % Math.max(1, paragraphs.length - 1))
    const target = paragraphs[index]
    if (!target) return
    const previous = paragraphs[index - 1]
    fire(previous)
    fire(target)
    previous.textContent = `${previous.textContent}${target.textContent}`
    target.remove()
  },
  item(root, op) {
    const items = itemsOf(root)
    if (items.length === 0) return
    const item = items[op.at % items.length]
    fire(item)
    item.textContent = `${item.textContent}${op.word}`
  },
  // Enter in a list item adds an item after it.
  enterItem(root, op) {
    const items = itemsOf(root)
    if (items.length === 0) return
    const item = items[op.at % items.length]
    fire(item)
    const added = item.cloneNode(false) as HTMLElement
    added.textContent = op.word
    item.after(added)
  },
  // Backspace at an item start merges the item into the one before it.
  mergeItems(root, op) {
    const items = itemsOf(root)
    if (items.length < 2) return
    const index = 1 + (op.at % (items.length - 1))
    fire(items[index - 1])
    fire(items[index])
    items[index - 1].textContent =
      `${items[index - 1].textContent}${items[index].textContent}`
    items[index].remove()
  },
}

/** Edits the DOM the way the editor does for one operation; an inapplicable operation does nothing. */
function applyOp(root: HTMLElement, op: Op): void {
  ;(HANDLERS[op.kind] as (root: HTMLElement, op: Op) => void)(root, op)
}

interface Checkpoint {
  text: string
  canon: string[]
}

let session: ModelSession | undefined
let uninstall: (() => void) | undefined
afterEach(() => {
  uninstall?.()
  session?.dispose()
  uninstall = undefined
  session = undefined
  document.body.replaceChildren()
})

/** Plays `ops`, records a checkpoint after each, then undoes all and redoes all. */
function play(ops: Op[]): string[] {
  const failures: string[] = []
  const root = document.createElement('div')
  root.className = 'vditor-reset vditor-ir'
  root.setAttribute('contenteditable', 'true')
  document.body.appendChild(root)
  session = createModelSession({
    win: window,
    getRoot: () => root,
    getLute: () => lute,
    getMode: () => 'ir',
    isPreviewShowing: () => false,
    isStreaming: () => false,
    isComposing: () => false,
    e2e: true,
    countFallbackPublication: () => undefined,
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => undefined,
    now: () => 0,
    setTimeout: () => 0,
    clearTimeout: () => undefined,
    inViewport: () => false,
  })
  root.innerHTML = lute.Md2VditorIRDOM(DOC)
  session.onHostText(DOC, 1)
  session.onEditDomComplete()
  const delta = session.deltaPort()
  let sequence = 0
  const sync = () => {
    sequence += 1
    return delta.prepareDelta(sequence).kind
  }
  const vditor = {
    currentMode: 'ir',
    ir: { element: root, composingLock: false, processTimeoutId: undefined },
    undo: {
      ir: { hasUndo: false, lastText: '', redoStack: [], undoStack: [] },
    },
    options: {},
  }
  const port = (session as unknown as { historyPort(): never }).historyPort()
  uninstall = installUnitHistory(window, {
    port: () => port,
    // The restore wrote ordinary DOM edits: the sync computes their text change, as a publication does.
    publishHistory: () => (sync() === 'changes' ? 'delta' : 'nothing'),
    lastPostedSequence: () => sequence,
    epoch: () => 1,
  })
  const hook = (
    window as unknown as {
      __vmdeUnitHistory: {
        record(v: unknown): void
        undo(v: unknown): void
        redo(v: unknown): void
      }
    }
  ).__vmdeUnitHistory
  const checkpoint = (): Checkpoint => ({
    text: delta.modelText() as string,
    canon: canon(root),
  })
  const expectedCanon = (text: string) => {
    const detached = document.createElement('div')
    detached.innerHTML = lute.Md2VditorIRDOM(text)
    return canon(detached)
  }

  hook.record(vditor) // the base
  const checkpoints: Checkpoint[] = [checkpoint()]
  for (const op of ops) {
    applyOp(root, op)
    // A publication syncs the model between the edit and the checkpoint.
    sync()
    hook.record(vditor)
    const next = checkpoint()
    if (next.text !== checkpoints.at(-1)?.text) checkpoints.push(next)
  }
  const compare = (label: string, expected: Checkpoint) => {
    const now = checkpoint()
    if (now.text !== expected.text)
      failures.push(`${label}: model text differs`)
    if (JSON.stringify(now.canon) !== JSON.stringify(expectedCanon(now.text)))
      failures.push(`${label}: DOM canon differs from its text`)
  }
  for (let step = checkpoints.length - 1; step > 0; step--) {
    hook.undo(vditor)
    compare(`undo to ${step - 1}`, checkpoints[step - 1])
  }
  for (let step = 1; step < checkpoints.length; step++) {
    hook.redo(vditor)
    compare(`redo to ${step}`, checkpoints[step])
  }
  return failures
}

describe('unit history properties (seed 733004)', { timeout: TIMEOUT }, () => {
  it('Undo all then Redo all returns the model text and the DOM canon of every checkpoint', () => {
    fc.assert(
      fc.property(
        fc.array(opArbitrary, { minLength: 1, maxLength: 8 }),
        (ops) => {
          expect(play(ops)).toEqual([])
          uninstall?.()
          session?.dispose()
          document.body.replaceChildren()
        },
      ),
      RUN,
    )
  })

  it('one fixed sequence of every operation kind is restored in both directions', () => {
    const ops: Op[] = [
      { kind: 'paragraph', at: 0, word: 'one' },
      { kind: 'cell', at: 3, word: 'cell' },
      { kind: 'enter', at: 1, word: 'new' },
      { kind: 'backspace', at: 2 },
      { kind: 'paragraph', at: 1, word: 'two' },
    ]
    expect(play(ops)).toEqual([])
  })
})
