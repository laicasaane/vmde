/**
 * Task 619 — Split View (SV) edits of a selection that starts at a line start, in real VS Code with
 * OS-level XTEST input (docs/os-keyboard-testing-setup.md; Openbox must run without key bindings).
 *
 * Chromium's native delete of a range that starts just after a line's newline span also removes the
 * hidden newline of the previous line, so two source lines join. VMDE now owns those edits
 * (media-src/src/editing/sv-selection-edit-dom.ts). Every key here is an OS key; the expected host
 * texts are the pure string result of removing the selected characters and nothing else. Each edit
 * is followed by one OS Ctrl+Z, which must restore the opened bytes exactly with a clean document.
 *
 * Merged Task 618: SV type-over of a whole-document selection must give `X\n`, with the undo snapshot
 * already taken before Select All and with it still pending at Select All (a read-only wrapper
 * around the engine's snapshot call proves which window each leg was in).
 *
 * Host text is read from the VS Code TextDocument, never from the webview. A selection is placed
 * with VMDE's caret authority by source offset in the editor text (the shape a drag from a line
 * start produces); the edit key is always OS-level.
 */
import { expect, test } from 'vscode-test-playwright'
import {
  type Ctx,
  endSelectionGesture,
  evalFrame,
  expectHost,
  hostState,
  type Kit,
  leg,
  makeKit,
  openDocument,
  QUIET_MS,
  report,
  select,
  UNDO_LOCK_MS,
} from './helpers/shortcut-xtest-kit'
import {
  waitForE2EReadiness,
  waitForInitialUndoSnapshot,
} from './webview-helpers'

const LABEL = 'Task 619 SV selection edit'
const ORIGINAL = 'Alpha line\nBravo line\nCharlie line\n'
const TWO = 'Alpha bravo charlie\n\nDelta echo foxtrot\n'
const BLOCKS = 'Alpha line\n\nBravo line\n\nCharlie line\n'
const SENTINEL = 'SENTINEL-not-a-cut'
// Re-init: a constructor-only option (initOnlyChanged), reset after every test.
const REINIT_SETTING = 'editor.codeLineNumbers'

// --- In-page probes (each runs inside the webview and must stay self-contained) ---

// Selects source offsets [start, end) of the SV editor text, registered with VMDE's caret authority.
// A start on a text-node boundary goes to the start of the next node, an end to the end of the
// earlier node: the shape a drag from a line start produces. Returns the selected text.
async function selectOffsetsInPage(
  _body: Element,
  args: { start: number; end: number },
): Promise<{ selected: string; text: string }> {
  const inner = (window as any).vditor.vditor
  const root = inner.sv.element as HTMLElement
  const nodes: { node: Text; at: number; len: number }[] = []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let acc = 0
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const len = (node.textContent ?? '').length
    nodes.push({ node: node as Text, at: acc, len })
    acc += len
  }
  const first = nodes.find((entry) => entry.at + entry.len > args.start)
  const last = nodes.find((entry) => entry.at + entry.len >= args.end)
  if (!first || !last) throw new Error('offsets out of range')
  root.focus({ preventScroll: true })
  const range = document.createRange()
  range.setStart(first.node, args.start - first.at)
  range.setEnd(last.node, args.end - last.at)
  const selection = getSelection()!
  selection.removeAllRanges()
  selection.addRange(range)
  const requestCaret = (window as any).__vmdeRequestCaret
  if (typeof requestCaret === 'function')
    requestCaret({
      anchor: { node: first.node, offset: args.start - first.at },
      focus: { node: last.node, offset: args.end - last.at },
    })
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  )
  const settled = getSelection()
  const live = settled?.rangeCount ? settled.getRangeAt(0) : null
  return {
    selected: live && root.contains(live.startContainer) ? live.toString() : '',
    text: root.textContent ?? '',
  }
}

// The caret after an edit: collapsed, inside the SV surface, its source offset and whether it has
// a painted position (a collapsed range has no rect inside some empty nodes, so the node's own
// rect is the fallback).
function caretInPage() {
  const inner = (window as any).vditor.vditor
  const root = inner.sv.element as HTMLElement
  const selection = getSelection()
  const range = selection?.rangeCount ? selection.getRangeAt(0) : null
  if (!range || !selection)
    return { collapsed: false, inSurface: false, offset: -1, painted: false }
  const inSurface = root.contains(range.startContainer)
  const before = document.createRange()
  before.selectNodeContents(root)
  before.setEnd(selection.focusNode ?? root, selection.focusOffset)
  const rect = range.getBoundingClientRect()
  const owner =
    range.startContainer instanceof Element
      ? range.startContainer
      : range.startContainer.parentElement
  const fallback = owner?.getBoundingClientRect()
  return {
    collapsed: selection.isCollapsed,
    inSurface,
    offset: inSurface ? before.toString().length : -1,
    painted:
      (rect.height > 0 && rect.width >= 0) ||
      (!!fallback && fallback.height > 0 && fallback.width > 0),
    focused: document.hasFocus() && root.contains(document.activeElement),
  }
}

// A read-only wrapper around the engine's snapshot call and the trusted keys, to name the window of
// the Task 618 legs. It records times only; it never changes timers, history, source or selection.
function installSnapshotProbe(): boolean {
  const page = window as any
  const inner = page.vditor?.vditor
  if (!inner?.undo) return false
  if (page.__t619) return true
  const probe = {
    snapshots: [] as number[],
    keys: [] as { key: string; ctrl: boolean; at: number }[],
  }
  const original = inner.undo.addToUndoStack
  inner.undo.addToUndoStack = function (vditor: unknown) {
    probe.snapshots.push(performance.now())
    return original.call(this, vditor)
  }
  window.addEventListener(
    'keydown',
    (event) => {
      if (event.isTrusted)
        probe.keys.push({
          key: event.key,
          ctrl: event.ctrlKey,
          at: performance.now(),
        })
    },
    true,
  )
  page.__t619 = probe
  return true
}

function readSnapshotProbe() {
  return (window as any).__t619 as {
    snapshots: number[]
    keys: { key: string; ctrl: boolean; at: number }[]
  }
}

// --- Host helpers ---

const readClipboard = (kit: Kit) =>
  kit.host(async (vscode) => vscode.env.clipboard.readText(), [])

const writeClipboard = (kit: Kit, text: string) =>
  kit.host(
    async (vscode, [value]: [string]) => {
      await vscode.env.clipboard.writeText(value)
    },
    [text],
  )

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
  await expectHost(
    ctx,
    ctx.initial,
    `${label}: one Undo restores the exact source`,
  )
  await expectDirty(ctx, false, `${label}: clean after the Undo`)
}

// Places a selection on source [from, to) of the opened text and ends it with an OS gesture.
async function selectSource(ctx: Ctx, from: string, to: string = from) {
  const start = ctx.initial.indexOf(from)
  const end = ctx.initial.indexOf(to, start) + to.length
  expect(start, `${from} is in the document`).toBeGreaterThanOrEqual(0)
  const placed = await evalFrame(ctx.kit, selectOffsetsInPage, { start, end })
  expect(placed.selected, 'the selection holds exactly the intended text').toBe(
    ctx.initial.slice(start, end),
  )
  await endSelectionGesture(ctx)
  return { start, end }
}

interface EditCell {
  /** First and last source text of the selection (the last defaults to the first). */
  from: string
  to?: string
  /** The OS gesture that edits. */
  act: (kit: Kit) => Promise<void>
  /** The host text after the edit: the original minus the selection (plus the typed text). */
  expected: string
  /** The clipboard after the edit, for a cut. */
  clipboard?: string
}

async function editCell(ctx: Ctx, cell: EditCell) {
  const { kit } = ctx
  await selectSource(ctx, cell.from, cell.to)
  if (cell.clipboard !== undefined) await writeClipboard(kit, SENTINEL)
  await cell.act(kit)
  await expectHost(ctx, cell.expected, 'the edit removes only the selection')
  await expectDirty(ctx, true, 'the edit marks the document dirty')
  if (cell.clipboard !== undefined)
    await expect
      .poll(() => readClipboard(kit), {
        message: 'the cut reached the clipboard',
      })
      .toBe(cell.clipboard)
  await undoRestores(ctx, 'edit')
  return { mechanism: 'XTEST keys' }
}

// The first XTEST Ctrl chord of a session sometimes never reaches the webview (Task 598), so one
// Ctrl+Z on the untouched, settled document goes first and must change nothing.
async function warmUp(ctx: Ctx) {
  await waitForInitialUndoSnapshot(ctx.kit.frame())
  await select(ctx, 'Alpha', { collapsed: true, offset: 2 })
  await ctx.kit.xtest.key('ctrl+z')
  await ctx.kit.workbox.waitForTimeout(QUIET_MS) // negative-observation window
  const state = await hostState(ctx)
  expect(
    { text: state.text === ctx.initial, dirty: state.dirty },
    'warm-up Ctrl+Z on an untouched document changes nothing',
  ).toEqual({ text: true, dirty: false })
}

// Where the engine's snapshots ran relative to the keys of a whole-document type-over, and whether
// that is the window the leg is meant to exercise.
function snapshotWindow(
  probe: ReturnType<typeof readSnapshotProbe>,
  pending: boolean,
) {
  const at = (name: string, ctrl = false) =>
    probe.keys.find((entry) => entry.key === name && entry.ctrl === ctrl)?.at
  const typedAt = at('Z')
  const selectAllAt = at('a', true)
  const overAt = at('X')
  if (
    typedAt === undefined ||
    selectAllAt === undefined ||
    overAt === undefined
  )
    throw new Error(`probe missed a key: ${JSON.stringify(probe.keys)}`)
  const afterTyping = probe.snapshots.filter((time) => time >= typedAt)
  const before = afterTyping.filter((time) => time < selectAllAt).length
  const between = afterTyping.filter(
    (time) => time > selectAllAt && time < overAt,
  ).length
  const valid = pending ? between > 0 : before > 0 && between === 0
  if (!valid)
    throw new Error(
      `${pending ? 'pending window' : 'non-pending setup'} missed: ${JSON.stringify({ before, between })}`,
    )
  return { before, between }
}

// Task 618: type Z at the end, Select All, type X. The source must be `X\n` and one Undo exact.
async function wholeDocumentTypeOver(ctx: Ctx, pending: boolean) {
  const { kit } = ctx
  expect(
    await evalFrame(kit, installSnapshotProbe, 0),
    'the snapshot probe installed',
  ).toBe(true)
  await select(ctx, 'foxtrot', { collapsed: true, offset: 'foxtrot'.length })
  await endSelectionGesture(ctx)
  await kit.xtest.type('Z')
  const typed = TWO.replace('foxtrot', 'foxtrotZ')
  // Without a pending snapshot: the typed edit's snapshot has run before Select All. With one: it
  // is still pending at Select All and runs on the whole-document selection, so Select All follows
  // the key at once (the probe proves the window) and the snapshot is awaited before X.
  if (!pending) {
    await kit.workbox.waitForTimeout(UNDO_LOCK_MS)
    await expectHost(ctx, typed, 'Z reached the host')
  }
  await kit.xtest.key('ctrl+a')
  if (pending) await kit.workbox.waitForTimeout(UNDO_LOCK_MS)
  await kit.xtest.type('X')
  await expectHost(ctx, 'X\n', 'type-over of the whole document gives X')
  await expectDirty(ctx, true, 'the type-over marks the document dirty')
  const ran = snapshotWindow(
    await evalFrame(kit, readSnapshotProbe, 0),
    pending,
  )
  await kit.workbox.waitForTimeout(UNDO_LOCK_MS)
  await kit.xtest.key('ctrl+z')
  await expectHost(
    ctx,
    typed,
    'one Undo restores the text before the type-over',
  )
  return {
    mechanism: 'XTEST keys',
    snapshotsBeforeSelectAll: ran.before,
    snapshotsBetween: ran.between,
    leavesEdit: true,
  }
}

const key = (name: string) => (kit: Kit) => kit.xtest.key(name)
const typeText = (text: string) => (kit: Kit) => kit.xtest.type(text)

test.describe('Task 619 SV selection edits at a line start', () => {
  test.skip(
    process.env.VMDE_XTEST !== '1',
    'requires isolated Xvfb/Openbox XTEST',
  )

  test.afterEach(async ({ evaluateInVSCode }) => {
    await evaluateInVSCode(async (vscode) => {
      const config = vscode.workspace.getConfiguration('vmde')
      await config.update('editor.defaultMode', undefined, true)
      await config.update('editor.codeLineNumbers', undefined, true)
    })
  })

  test('sv: Delete, Backspace, type-over, cut and word delete from a line start, and the controls', async ({
    workbox,
    electronApp,
    evaluateInVSCode,
    baseDir,
  }) => {
    test.setTimeout(900_000)
    const kit = await makeKit(
      workbox,
      electronApp,
      evaluateInVSCode,
      baseDir,
      LABEL,
    )
    const ctx = await openDocument(kit, 'sv-line-start.md', ORIGINAL, 'sv')
    await warmUp(ctx)

    const lineMid = 'Alpha line\nB line\nCharlie line\n'
    const withoutBravo = 'Alpha line\n line\nCharlie line\n'

    // The defect cells: a selection that starts at the start of the second line.
    await leg(ctx, 'delete-bravo', () =>
      editCell(ctx, {
        from: 'Bravo',
        act: key('Delete'),
        expected: withoutBravo,
      }),
    )
    await leg(ctx, 'backspace-bravo', () =>
      editCell(ctx, {
        from: 'Bravo',
        act: key('BackSpace'),
        expected: withoutBravo,
      }),
    )
    await leg(ctx, 'type-over-bravo', () =>
      editCell(ctx, {
        from: 'Bravo',
        act: typeText('X'),
        expected: 'Alpha line\nX line\nCharlie line\n',
      }),
    )
    await leg(ctx, 'cut-bravo', () =>
      editCell(ctx, {
        from: 'Bravo',
        act: key('ctrl+x'),
        expected: withoutBravo,
        clipboard: 'Bravo',
      }),
    )
    await leg(ctx, 'delete-line-content', () =>
      editCell(ctx, {
        from: 'Bravo line',
        act: key('Delete'),
        expected: 'Alpha line\n\nCharlie line\n',
      }),
    )
    await leg(ctx, 'delete-whole-line', () =>
      editCell(ctx, {
        from: 'Bravo line\n',
        act: key('Delete'),
        expected: 'Alpha line\nCharlie line\n',
      }),
    )
    // Item 6: a word-delete key over an owned selection deletes exactly the selection.
    await leg(ctx, 'ctrl-backspace-bravo', () =>
      editCell(ctx, {
        from: 'Bravo',
        act: key('ctrl+BackSpace'),
        expected: withoutBravo,
      }),
    )

    // Controls: selections the edit does not own keep their native result.
    await leg(ctx, 'control-mid-line-ravo', () =>
      editCell(ctx, { from: 'ravo', act: key('Delete'), expected: lineMid }),
    )
    await leg(ctx, 'control-line-1-alpha', () =>
      editCell(ctx, {
        from: 'Alpha',
        act: key('Delete'),
        expected: ' line\nBravo line\nCharlie line\n',
      }),
    )
    // Task 614: a collapsed Ctrl+X cuts exactly the caret's line, as before.
    await leg(ctx, 'control-collapsed-line-cut', async () => {
      await select(ctx, 'Bravo', { collapsed: true, offset: 2 })
      await endSelectionGesture(ctx)
      await writeClipboard(kit, SENTINEL)
      await kit.xtest.key('ctrl+x')
      await expectHost(
        ctx,
        'Alpha line\nCharlie line\n',
        'the collapsed cut removes exactly the line',
      )
      await expect
        .poll(() => readClipboard(kit), {
          message: 'the line reached the clipboard',
        })
        .toBe('Bravo line\n')
      await undoRestores(ctx, 'collapsed cut')
      return { mechanism: 'XTEST keys' }
    })
    // Whole document: Ctrl+A then Delete (not owned: the selection starts at offset 0) and one exact
    // Undo. The two readers differ by Vditor's trailing editable newline: the webview's rendered
    // value is `\n` (the Task 619 record's figure), the host document is empty.
    await leg(ctx, 'control-whole-document-delete', async () => {
      await select(ctx, 'Bravo', { collapsed: true, offset: 2 })
      await endSelectionGesture(ctx)
      await kit.xtest.key('ctrl+a')
      await kit.xtest.key('Delete')
      await expectHost(
        ctx,
        '',
        'whole-document Delete empties the host document',
      )
      expect(
        await evalFrame(
          kit,
          () => (window as any).vditor.getValue() as string,
          0,
        ),
        'the rendered value is one newline',
      ).toBe('\n')
      await undoRestores(ctx, 'whole-document Delete')
      return { mechanism: 'XTEST keys' }
    })
    report('line-start edits', ctx.results, LABEL)
  })

  // Task 618: Select All then type a character over the whole SV document.
  test('sv: type-over of a whole-document selection gives X, with and without a pending snapshot', async ({
    workbox,
    electronApp,
    evaluateInVSCode,
    baseDir,
  }) => {
    test.setTimeout(900_000)
    const kit = await makeKit(
      workbox,
      electronApp,
      evaluateInVSCode,
      baseDir,
      LABEL,
    )
    const ctx = await openDocument(kit, 'sv-whole-document.md', TWO, 'sv')
    await warmUp(ctx)

    await leg(ctx, 'type-over-no-pending-snapshot', () =>
      wholeDocumentTypeOver(ctx, false),
    )
    await leg(ctx, 'type-over-pending-snapshot', () =>
      wholeDocumentTypeOver(ctx, true),
    )
    report('whole-document type-over', ctx.results, LABEL)
  })

  // The editor is re-initialised (a constructor-only option changes); the owned edit and its cut
  // bridge must survive the instance swap (the new instance installs before the old one disposes).
  test('sv: Ctrl+X over Bravo is still exact after the editor re-initialises', async ({
    workbox,
    electronApp,
    evaluateInVSCode,
    baseDir,
  }) => {
    test.setTimeout(900_000)
    const kit = await makeKit(
      workbox,
      electronApp,
      evaluateInVSCode,
      baseDir,
      LABEL,
    )
    const ctx = await openDocument(kit, 'sv-reinit.md', ORIGINAL, 'sv')
    await warmUp(ctx)
    const frame = kit.frame()
    // A re-init opens the default mode, so the default is SV before the setting that re-initialises.
    await kit.host(async (vscode) => {
      await vscode.workspace
        .getConfiguration('vmde')
        .update('editor.defaultMode', 'sv', true)
    }, [])
    await kit.workbox.waitForTimeout(QUIET_MS)
    const before = await waitForE2EReadiness(
      frame,
      (state) => state.routerReady && state.mode === 'sv',
      { message: 'still in SV after the default mode changed' },
    )
    await kit.host(
      async (vscode, [name]: [string]) => {
        await vscode.workspace
          .getConfiguration('vmde')
          .update(name, true, vscode.ConfigurationTarget.Global)
      },
      [REINIT_SETTING],
    )
    const after = await waitForE2EReadiness(
      frame,
      (state) =>
        state.routerReady &&
        state.editorEpoch > before.editorEpoch &&
        state.mode === 'sv',
      {
        timeout: 60_000,
        message: 'the setting change re-initialised the SV editor',
      },
    )
    await kit.workbox.waitForTimeout(6500) // caret.ts re-asserts the entry caret for about 5 s
    await waitForInitialUndoSnapshot(frame)
    await leg(ctx, 'cut-bravo-after-reinit', async () => {
      const result = await editCell(ctx, {
        from: 'Bravo',
        act: key('ctrl+x'),
        expected: 'Alpha line\n line\nCharlie line\n',
        clipboard: 'Bravo',
      })
      return {
        ...result,
        editorEpochBefore: before.editorEpoch,
        editorEpochAfter: after.editorEpoch,
      }
    })
    report('re-init', ctx.results, LABEL)
  })

  // Probe: blocks separated by blank lines. A space typed over a selection that spans blocks; the
  // host text and the caret are recorded. Exact: the lines before the selection stay, the selected
  // words are gone, and one Undo restores the opened bytes.
  test('sv: probe, a space typed over a multi-block selection', async ({
    workbox,
    electronApp,
    evaluateInVSCode,
    baseDir,
  }) => {
    test.setTimeout(900_000)
    const kit = await makeKit(
      workbox,
      electronApp,
      evaluateInVSCode,
      baseDir,
      LABEL,
    )
    const ctx = await openDocument(kit, 'sv-blocks.md', BLOCKS, 'sv')
    await warmUp(ctx)
    await leg(ctx, 'space-over-multi-block', async () => {
      await selectSource(ctx, 'Bravo line', 'Charlie')
      await kit.xtest.key('space')
      const pure = 'Alpha line\n\n  line\n'
      await expect
        .poll(async () => (await hostState(ctx)).text !== ctx.initial, {
          message: 'the space replaced the selection',
        })
        .toBe(true)
      await kit.workbox.waitForTimeout(QUIET_MS)
      const host = (await hostState(ctx)).text ?? ''
      const caret = await evalFrame(kit, caretInPage, 0)
      console.log(
        `[${LABEL} probe]`,
        JSON.stringify({ host, pureMatch: host === pure, caret }),
      )
      expect(
        host.startsWith('Alpha line\n\n'),
        'the text before the selection stays',
      ).toBe(true)
      expect(
        host.includes('Bravo') || host.includes('Charlie'),
        'selected words are gone',
      ).toBe(false)
      expect(
        host.endsWith(' line\n'),
        'the text after the selection stays',
      ).toBe(true)
      await undoRestores(ctx, 'space over multi-block selection')
      return { mechanism: 'XTEST keys', host, pureMatch: host === pure, caret }
    })
    report('multi-block probe', ctx.results, LABEL)
  })
})
