/**
 * Task 603 — undo routing hygiene, in the real VS Code webview with OS-level XTEST input.
 *
 * This file holds leg 3 (item 3, written in Task 603 Part 2 step S2); legs 1 and 2 (Ctrl+Shift+E
 * and the Find and Replace inputs) are added by step S3.
 *
 * Leg 3: an external change starts one webview history base. `setHostUpdateValue` (the host's
 * `update` handler) clears the history inside Vditor's `setValue` (the base keeps a root-level caret
 * marker, so Task 597's restore places the caret at the edit on the Undo that returns to it), and
 * `setValue` also armed Vditor's delayed after-render record: 800 ms later that record added a
 * second history entry with the same text and only a different caret, so the user's second Ctrl+Z
 * after one typed character moved the caret and changed no text. The router now turns that record's
 * undo entry off. The history starts at the external change (Owner rule 2026-09-28): one base,
 * nothing after it until a real edit.
 *
 * Each leg applies the external change as a `WorkspaceEdit` through the extension host, waits for
 * the webview to show it, observes whether any entry follows, types one character with OS keys at
 * the restored caret, and presses Ctrl+Z twice. A key whose Undo never reached the webview would
 * make "the second Undo changed nothing" pass vacuously, so every Ctrl+Z is counted at the engine
 * (a read-only wrapper outside VMDE's history wrapper that never changes timers, history or
 * selection) and the leg fails if the count did not move. Host comparisons are booleans so
 * fixture text stays out of failure output.
 */
import { expect, test } from 'vscode-test-playwright'
import {
  type Ctx,
  evalFrame,
  expectHost,
  type Kit,
  leg,
  makeKit,
  openDocument,
  report,
  select,
} from './helpers/shortcut-xtest-kit'
import { waitForInitialUndoSnapshot } from './webview-helpers'

// A small document that round-trips exactly through every mode's serializer (Task 598's DOC).
const DOC =
  '# Probe\n\nAlpha bravo charlie delta.\n\nEcho `foxtrot` golf hotel.\n\nIndia juliet kilo lima.\n'
const EXTERNAL = DOC.replace('juliet', 'JULIET')
// One character typed at the restored caret (`br|avo`).
const TYPED = EXTERNAL.replace('bravo', 'brYavo')
// The caret goes inside `bravo`, away from the externally changed `juliet`.
const CARET_TOKEN = 'bravo'
const CARET_OFFSET = 2
// Negative-observation window: longer than the 800 ms undo delay plus IR's 220 ms settle, the
// 250 ms edit sync and a host round trip.
const STABLE_MS = 1500
const LABEL = 'Task 603 undo routing'

// --- In-page probes (each runs inside the webview and must stay self-contained) ---

// Counts the engine's Undo calls. Installed once per document, outside VMDE's history wrapper.
function installWatch(): boolean {
  const w = window as any
  const inner = w.vditor?.vditor
  if (!inner?.undo) return false
  if (w.__t603) return true
  const watch = { undos: 0 }
  const original = inner.undo.undo
  inner.undo.undo = function (vditor: unknown) {
    watch.undos++
    return original.call(this, vditor)
  }
  w.__t603 = watch
  return true
}

function readState() {
  const w = window as any
  const inner = w.vditor.vditor
  const mode = inner.currentMode
  const slot = inner.undo[mode]
  const root = inner[mode].element as HTMLElement
  const selection = getSelection()
  let caret: number | null = null
  if (
    selection?.rangeCount &&
    selection.anchorNode &&
    root.contains(selection.anchorNode)
  ) {
    const range = document.createRange()
    range.selectNodeContents(root)
    range.setEnd(selection.anchorNode, selection.anchorOffset)
    caret = range.toString().length
  }
  const base: string | undefined = slot.undoStack[0]?.[0]?.diffs?.[0]?.[1]
  return {
    undo: slot.undoStack.length as number,
    redo: slot.redoStack.length as number,
    caret,
    collapsed: selection?.isCollapsed ?? null,
    focused: document.hasFocus() && root.contains(document.activeElement),
    value: w.vditor.getValue() as string,
    // Whether the base entry's caret marker sits inside a text run ("br<wbr>avo"), not on the root.
    baseCaretOnText: !!base && /[A-Za-z]<wbr>[A-Za-z]/.test(base),
    undoDisabled:
      !!inner.toolbar?.elements?.undo?.children[0]?.classList.contains(
        'vditor-menu--disabled',
      ),
    engineUndos: (w.__t603?.undos ?? 0) as number,
  }
}

// --- Test-side helpers ---

const webview = (ctx: Ctx) => evalFrame(ctx.kit, readState, 0)

const hostDoc = (ctx: Ctx) =>
  ctx.kit.host(
    (vscode, [fsPath]: [string]) => {
      const document = vscode.workspace.textDocuments.find(
        (candidate) => candidate.uri.fsPath === fsPath,
      )
      return {
        text: document?.getText() ?? null,
        version: document?.version ?? -1,
        dirty: document?.isDirty ?? null,
      }
    },
    [ctx.file],
  )

// An external change: a WorkspaceEdit through the extension host replaces `from` with `to`.
async function applyExternalEdit(ctx: Ctx, from: string, to: string) {
  const applied = await ctx.kit.host(
    async (vscode, [fsPath, find, replace]: [string, string, string]) => {
      const document = await vscode.workspace.openTextDocument(
        vscode.Uri.file(fsPath),
      )
      const start = document.positionAt(document.getText().indexOf(find))
      const edit = new vscode.WorkspaceEdit()
      edit.replace(
        document.uri,
        new vscode.Range(start, start.translate(0, find.length)),
        replace,
      )
      return vscode.workspace.applyEdit(edit)
    },
    [ctx.file, from, to],
  )
  expect(applied, 'the WorkspaceEdit applies').toBe(true)
}

// Ctrl+Z through the OS, proven to have reached the engine (one more Undo call than `before`).
async function undoByKey(ctx: Ctx, before: number, what: string) {
  await ctx.kit.xtest.key('ctrl+z')
  await expect
    .poll(async () => (await webview(ctx)).engineUndos, {
      timeout: 5_000,
      message: `${ctx.mode}: ${what} reaches the Undo engine`,
    })
    .toBe(before + 1)
}

// Opens the document in the leg's mode, waits for Vditor's own first snapshot, installs the engine
// watch and sends one Ctrl+Z to the untouched document (the first XTEST Ctrl chord of a session
// sometimes never reached the webview in the Task 598 investigation; this one changes nothing).
async function prepare(ctx: Ctx) {
  await waitForInitialUndoSnapshot(ctx.kit.frame())
  expect(await evalFrame(ctx.kit, installWatch, 0), 'watch installed').toBe(
    true,
  )
  await select(ctx, CARET_TOKEN, { collapsed: true, offset: CARET_OFFSET })
  await ctx.kit.xtest.key('ctrl+z')
  await ctx.kit.workbox.waitForTimeout(STABLE_MS) // negative-observation window
  const state = await webview(ctx)
  expect(
    { undo: state.undo, redo: state.redo, value: state.value.length > 0 },
    `${ctx.mode}: the warm-up Ctrl+Z on an untouched document changes nothing`,
  ).toEqual({ undo: 1, redo: 0, value: true })
}

// Three legs on the same external change, so a failure in one leaves the others observable:
//   base  - after the change the history holds exactly its base (a root-level caret marker), and
//           nothing is added 800 ms later (no caret-only entry; Undo stays disabled);
//   undo  - one typed character, then Ctrl+Z twice: the first removes the character, the second
//           changes neither text, caret, focus nor the host's bytes and version;
//   quick - the character typed straight after the update, inside the 800 ms window of the
//           update's own render record, still gets its own step.
type Kind = 'base' | 'undo' | 'quick'

async function externalChangeLeg(ctx: Ctx, kind: Kind) {
  await prepare(ctx)
  const opened = await hostDoc(ctx)
  const before = await webview(ctx)
  await applyExternalEdit(ctx, 'juliet', 'JULIET')
  await expectHost(ctx, EXTERNAL, 'the external change reaches the host')
  await expect
    .poll(async () => (await webview(ctx)).value.includes('JULIET'), {
      timeout: 10_000,
      message: `${ctx.mode}: the webview shows the external change`,
    })
    .toBe(true)
  if (kind === 'quick') {
    // Inside the update's 800 ms window: its own render record is still armed.
    await ctx.kit.xtest.type('Y')
    await ctx.kit.workbox.waitForTimeout(STABLE_MS) // negative-observation window
  } else {
    await ctx.kit.workbox.waitForTimeout(STABLE_MS) // negative-observation window
  }
  const settled = await webview(ctx)
  if (kind === 'base') {
    // One base, with a root-level marker, and nothing after it: Undo is disabled and has no step.
    // The live caret is the restored one.
    const observed = {
      undo: settled.undo,
      redo: settled.redo,
      undoDisabled: settled.undoDisabled,
      baseCaretOnText: settled.baseCaretOnText,
      caret: settled.caret,
    }
    expect(
      observed,
      `${ctx.mode}: the external change leaves one history base (observed ${JSON.stringify(observed)})`,
    ).toEqual({
      undo: 1,
      redo: 0,
      undoDisabled: true,
      baseCaretOnText: false,
      caret: before.caret,
    })
    return { mechanism: 'WorkspaceEdit', leavesEdit: true }
  }
  if (kind === 'undo') await ctx.kit.xtest.type('Y')
  await expectHost(ctx, TYPED, 'Y reaches the host at the restored caret')
  await ctx.kit.workbox.waitForTimeout(STABLE_MS) // negative-observation window
  const typed = await webview(ctx)
  if (kind === 'quick') {
    // The base and the typed edit's own step, nothing between them.
    const steps = { undo: typed.undo, redo: typed.redo }
    expect(
      steps,
      `${ctx.mode}: base plus the quick edit's own step (observed ${JSON.stringify(steps)})`,
    ).toEqual({ undo: 2, redo: 0 })
  }

  await undoByKey(ctx, typed.engineUndos, 'the first Ctrl+Z')
  await expectHost(ctx, EXTERNAL, 'the first Ctrl+Z undoes Y only')
  await ctx.kit.workbox.waitForTimeout(STABLE_MS) // negative-observation window
  const first = await webview(ctx)
  const firstHost = await hostDoc(ctx)
  // The first Ctrl+Z removes Y and only Y, and Task 597's restore puts the caret where Y was (`br|avo`).
  // The history depth is asserted where it matters: for the quick edit here (its own step popped),
  // for the two-Undo leg after the second Ctrl+Z.
  const firstState = {
    y: first.value.includes('Y'),
    external: first.value.includes('JULIET'),
    caret: first.caret,
    ...(kind === 'quick' ? { undo: first.undo, redo: first.redo } : {}),
  }
  expect(
    firstState,
    `${ctx.mode}: the first Ctrl+Z (observed ${JSON.stringify({ ...firstState, undo: first.undo, redo: first.redo })})`,
  ).toEqual({
    y: false,
    external: true,
    caret: before.caret,
    ...(kind === 'quick' ? { undo: 1, redo: 1 } : {}),
  })
  if (kind === 'quick')
    return { mechanism: 'WorkspaceEdit, XTEST keys', leavesEdit: true }

  await undoByKey(ctx, first.engineUndos, 'the second Ctrl+Z')
  await ctx.kit.workbox.waitForTimeout(STABLE_MS) // negative-observation window
  const second = await webview(ctx)
  const secondHost = await hostDoc(ctx)
  // The history starts at the external change: the second Undo changes neither text nor caret nor
  // focus, in the webview or on the host (same bytes, same version).
  const unchanged = {
    value: second.value === first.value,
    caret: second.caret,
    collapsed: second.collapsed,
    focused: second.focused,
    undo: second.undo,
    redo: second.redo,
    hostText: secondHost.text === firstHost.text,
    hostVersion: secondHost.version,
    hostDirty: secondHost.dirty,
  }
  expect(
    unchanged,
    `${ctx.mode}: the second Ctrl+Z changes nothing (observed ${JSON.stringify(unchanged)}; depth before the first Ctrl+Z ${typed.undo}, first-Undo caret ${first.caret})`,
  ).toEqual({
    value: true,
    caret: first.caret,
    collapsed: first.collapsed,
    focused: first.focused,
    undo: 1,
    redo: 1,
    hostText: true,
    hostVersion: firstHost.version,
    hostDirty: firstHost.dirty,
  })
  expect(first.focused, `${ctx.mode}: the editor keeps focus`).toBe(true)
  return {
    mechanism: 'WorkspaceEdit, XTEST keys',
    depthBeforeUndo: typed.undo,
    versions: [opened.version, firstHost.version, secondHost.version],
    caret: [before.caret, first.caret, second.caret],
    leavesEdit: true,
  }
}

async function openMode(kit: Kit, mode: Ctx['mode'], name: string) {
  return openDocument(kit, `${name}-${mode}.md`, DOC, mode)
}

test.describe('Task 603 undo routing hygiene', () => {
  test.skip(
    process.env.VMDE_XTEST !== '1',
    'requires isolated Xvfb/Openbox XTEST',
  )

  test.afterEach(async ({ evaluateInVSCode }) => {
    await evaluateInVSCode(async (vscode) => {
      await vscode.workspace
        .getConfiguration('vmde')
        .update('editor.defaultMode', undefined, true)
    })
  })

  // Leg 3 (item 3): an external change starts one history base.
  for (const mode of ['ir', 'wysiwyg', 'sv'] as const) {
    test(`${mode}: an external change starts one history base`, async ({
      workbox,
      electronApp,
      evaluateInVSCode,
      baseDir,
    }) => {
      test.setTimeout(600_000)
      const kit = await makeKit(
        workbox,
        electronApp,
        evaluateInVSCode,
        baseDir,
        LABEL,
      )
      const ctx = await openMode(kit, mode, 'external')
      await leg(ctx, 'external-base', () => externalChangeLeg(ctx, 'base'))
      await leg(ctx, 'external-undo-twice', () =>
        externalChangeLeg(ctx, 'undo'),
      )
      await leg(ctx, 'external-quick-edit', () =>
        externalChangeLeg(ctx, 'quick'),
      )
      report(mode, ctx.results, LABEL)
    })
  }
})
