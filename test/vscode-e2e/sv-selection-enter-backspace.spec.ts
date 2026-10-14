/**
 * Task 629 — Split View (SV) Enter over a selection and Backspace over a selection that starts at
 * column 1, in real VS Code with OS-level XTEST input (docs/os-keyboard-testing-setup.md; Openbox
 * must run without key bindings).
 *
 * Contract rows (the task record, Part 1 handoff):
 * - Enter over a non-collapsed selection replaces the selection with one line break: the selected
 *   text is gone, one break is inserted at the selection start, the caret is collapsed after it.
 * - Backspace over a selection that starts at column 1 of a line deletes exactly the selection and
 *   keeps the character at column 0.
 * - Each edit reaches the host document as a normal user edit (dirty), and one OS Ctrl+Z restores
 *   the opened bytes exactly with a clean document.
 *
 * Item (c), IME composition over a line-start selection, is covered in Chromium only: the XTEST
 * helper offers `key` and `type`, and the isolated display has no input-method session.
 *
 * Host text is read from the VS Code TextDocument, never from the webview. A selection is placed
 * with VMDE's caret authority by source offset in the editor text; the edit key is always OS-level.
 */
import { expect, test } from 'vscode-test-playwright'
import {
  type Ctx,
  endSelectionGesture,
  evalFrame,
  expectHost,
  hostState,
  type Kit,
  leg as runCase,
  makeKit,
  openDocument,
  QUIET_MS,
  report,
  select,
  UNDO_LOCK_MS,
} from './helpers/shortcut-xtest-kit'
import { waitForInitialUndoSnapshot } from './webview-helpers'

const LABEL = 'Task 629 SV Enter and Backspace over a selection'
const ORIGINAL = 'Alpha line\nBravo line\nCharlie line\n'

// --- In-page probes (each runs inside the webview and must stay self-contained) ---

// Selects source offsets [from, to) of the SV editor text and registers the range with VMDE's
// caret authority. A start on a text-node boundary goes to the start of the next node, an end to
// the end of the earlier node: the shape a drag from a line start produces.
async function placeRangeInPage(
  _body: Element,
  args: { from: number; to: number },
): Promise<string> {
  const root = (window as any).vditor.vditor.sv.element as HTMLElement
  const spans: { node: Text; begin: number; size: number }[] = []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let total = 0
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const size = (node.nodeValue ?? '').length
    spans.push({ node: node as Text, begin: total, size })
    total += size
  }
  const head = spans.find((span) => span.begin + span.size > args.from)
  const tail = spans.find((span) => span.begin + span.size >= args.to)
  if (!head || !tail) throw new Error('offsets out of range')
  root.focus({ preventScroll: true })
  const anchor = { node: head.node, offset: args.from - head.begin }
  const focus = { node: tail.node, offset: args.to - tail.begin }
  const range = document.createRange()
  range.setStart(anchor.node, anchor.offset)
  range.setEnd(focus.node, focus.offset)
  const live = getSelection()!
  live.removeAllRanges()
  live.addRange(range)
  ;(window as any).__vmdeRequestCaret?.({ anchor, focus })
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  )
  const settled = getSelection()
  return settled?.rangeCount && root.contains(settled.anchorNode)
    ? settled.toString()
    : ''
}

// The caret after an edit: whether it is collapsed inside the SV surface and its source offset.
function caretOffsetInPage() {
  const root = (window as any).vditor.vditor.sv.element as HTMLElement
  const live = getSelection()
  if (!live?.rangeCount || !root.contains(live.focusNode))
    return { collapsed: false, offset: -1 }
  const before = document.createRange()
  before.selectNodeContents(root)
  before.setEnd(live.focusNode!, live.focusOffset)
  return { collapsed: live.isCollapsed, offset: before.toString().length }
}

// --- Host helpers ---

async function expectDirty(ctx: Ctx, expected: boolean, label: string) {
  await expect
    .poll(async () => (await hostState(ctx)).dirty, { message: label })
    .toBe(expected)
}

// One OS Ctrl+Z, after the edit has its own undo checkpoint, restores the opened bytes exactly and
// leaves the document clean.
async function undoRestores(ctx: Ctx, label: string) {
  await ctx.kit.workbox.waitForTimeout(UNDO_LOCK_MS)
  await ctx.kit.xtest.key('ctrl+z')
  await expectHost(ctx, ctx.initial, `${label}: one Undo restores the source`)
  await expectDirty(ctx, false, `${label}: clean after the Undo`)
}

interface Cell {
  /** The exact source text to select. */
  from: string
  /** The OS key that edits. */
  key: string
  /** The host text after the edit. */
  expected: string
  /** The collapsed caret's source offset after the edit. */
  caret: number
}

// Places a selection, presses the key, then checks host text, dirty state, the collapsed caret and
// one exact Undo.
async function selectionEdit(ctx: Ctx, cell: Cell) {
  const start = ctx.initial.indexOf(cell.from)
  const end = start + cell.from.length
  expect(start, `${cell.from} is in the document`).toBeGreaterThanOrEqual(0)
  const selected = await evalFrame(ctx.kit, placeRangeInPage, {
    from: start,
    to: end,
  })
  expect(selected, 'the selection holds exactly the intended text').toBe(
    ctx.initial.slice(start, end),
  )
  await endSelectionGesture(ctx)
  await ctx.kit.xtest.key(cell.key)
  return finishEdit(ctx, cell.expected, cell.caret)
}

async function finishEdit(ctx: Ctx, expected: string, caret: number) {
  await expectHost(ctx, expected, 'the host text is the contract result')
  await expectDirty(ctx, true, 'the edit marks the document dirty')
  await expect
    .poll(() => evalFrame(ctx.kit, caretOffsetInPage, 0), {
      message: 'the caret is collapsed at the contract offset',
    })
    .toEqual({ collapsed: true, offset: caret })
  await undoRestores(ctx, 'edit')
  return { mechanism: 'XTEST keys' }
}

test.describe('Task 629 SV Enter and Backspace over a selection', () => {
  test.skip(
    process.env.VMDE_XTEST !== '1',
    'requires isolated Xvfb/Openbox XTEST',
  )

  test('sv: Enter over a selection and Backspace from column 1, and the controls', async ({
    workbox,
    electronApp,
    evaluateInVSCode,
    baseDir,
  }) => {
    test.setTimeout(900_000)
    const kit: Kit = await makeKit(
      workbox,
      electronApp,
      evaluateInVSCode,
      baseDir,
      LABEL,
    )
    const ctx = await openDocument(kit, 'sv-enter-backspace.md', ORIGINAL, 'sv')
    // The first XTEST Ctrl chord of a session sometimes never reaches the webview (Task 598), so
    // one Ctrl+Z on the untouched, settled document goes first and must change nothing.
    await waitForInitialUndoSnapshot(kit.frame())
    await select(ctx, 'Alpha', { collapsed: true, offset: 2 })
    await kit.xtest.key('ctrl+z')
    await kit.workbox.waitForTimeout(QUIET_MS) // negative-observation window
    const warm = await hostState(ctx)
    expect(
      { text: warm.text === ctx.initial, dirty: warm.dirty },
      'warm-up Ctrl+Z on an untouched document changes nothing',
    ).toEqual({ text: true, dirty: false })

    // (a) Enter over a non-collapsed selection: the selection is replaced by one line break.
    await runCase(ctx, 'enter-over-ravo', () =>
      selectionEdit(ctx, {
        from: 'ravo',
        key: 'Return',
        expected: 'Alpha line\nB\n line\nCharlie line\n',
        caret: 13,
      }),
    )
    await runCase(ctx, 'enter-over-bravo-line-start', () =>
      selectionEdit(ctx, {
        from: 'Bravo',
        key: 'Return',
        expected: 'Alpha line\n\n line\nCharlie line\n',
        caret: 12,
      }),
    )
    await runCase(ctx, 'enter-over-cross-line', () =>
      selectionEdit(ctx, {
        from: 'ravo line\nChar',
        key: 'Return',
        expected: 'Alpha line\nB\nlie line\n',
        caret: 13,
      }),
    )
    // Control: a collapsed caret after B is the unchanged native split.
    await runCase(ctx, 'control-enter-collapsed', async () => {
      await select(ctx, 'Bravo', { collapsed: true, offset: 1 })
      await endSelectionGesture(ctx)
      await kit.xtest.key('Return')
      return finishEdit(ctx, 'Alpha line\nB\nravo line\nCharlie line\n', 13)
    })

    // (b) Backspace over a selection that starts at column 1: column 0 stays.
    await runCase(ctx, 'backspace-over-ravo-column-1', () =>
      selectionEdit(ctx, {
        from: 'ravo',
        key: 'BackSpace',
        expected: 'Alpha line\nB line\nCharlie line\n',
        caret: 12,
      }),
    )
    await runCase(ctx, 'backspace-over-cross-line-column-1', () =>
      selectionEdit(ctx, {
        from: 'ravo line\nChar',
        key: 'BackSpace',
        expected: 'Alpha line\nBlie line\n',
        caret: 12,
      }),
    )
    // Control: a selection that starts at column 2 is the unchanged native delete.
    await runCase(ctx, 'control-backspace-column-2', () =>
      selectionEdit(ctx, {
        from: 'avo',
        key: 'BackSpace',
        expected: 'Alpha line\nBr line\nCharlie line\n',
        caret: 13,
      }),
    )
    report('Enter and Backspace over a selection', ctx.results, LABEL)
  })
})
