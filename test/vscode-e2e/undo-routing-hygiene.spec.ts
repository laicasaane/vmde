/**
 * Task 603 — undo routing hygiene, in the real VS Code webview with OS-level XTEST input.
 *
 * Leg 1 (item 1, a regression guard): Ctrl+Shift+E opens Explorer and takes focus out of the
 * webview. It is not an undo boundary; Task 580 already removed the cause of item 1, so this leg
 * also passes on the pre-603 product. After an authored step and the chord, host text, host version
 * and the webview Undo depth are unchanged, and after the editor is refocused one Ctrl+Z undoes
 * exactly the authored step. (Ctrl+Z with Explorer focused would go to Explorer's own file-operation
 * undo, which is why the editor is refocused first.)
 *
 * Leg 2 (item 2, large fixture): Undo and Redo keys with focus in the Find or Replace input edit
 * the input's own text, through the VMDE-kept field history (editing/text-field-history.ts).
 * Before Task 603 VS Code's Ctrl+Z reached `vmde.format.undo` and undid the document; the first
 * fix ran `document.execCommand('undo')`, which pops Chromium's one frame-wide undo stack and so
 * unapplied the editor's step whenever the field had nothing left (Vditor recorded a same-text
 * history entry). The leg checks input value, focus, match count, host bytes and version, and the
 * document's Undo depth and engine Undo count, for Ctrl+Z, Ctrl+Y and Ctrl+Shift+Z in each input;
 * that Ctrl+Z, Ctrl+Y and Ctrl+Shift+Z right after opening Find (an empty field history) change
 * neither the input nor the document; that Ctrl+Z after a field's one step is undone changes
 * nothing; and that an editor edit made after the Find typing does not take the Find field's
 * Undo (the interleaved case).
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
  FIXTURE as LARGE,
  UNIQUE_PROSE_TOKEN as TOKEN,
} from './find-replace-fixture-helpers'
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
  sidebarVisible,
  UNDO_LOCK_MS,
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
// The Find query: a character the large fixture contains many times, so the match count is visible.
const QUERY_CHAR = 'e'
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

// --- Legs 1 and 2 ---

// Focus facts for leg 1: whether the webview document has OS focus and where the caret sits.
function readFocus() {
  const inner = (window as any).vditor.vditor
  const root = inner[inner.currentMode].element as HTMLElement
  return {
    documentFocus: document.hasFocus(),
    inEditor: root.contains(document.activeElement),
  }
}

// Focus and values of the Find widget (leg 2), and the document's Undo depth.
function readFind() {
  const w = window as any
  const inner = w.vditor.vditor
  const slot = inner.undo[inner.currentMode]
  const widget = document.querySelector<HTMLElement>('.vmde-find-replace')
  const find = widget?.querySelector<HTMLInputElement>('[data-find]')
  const replace = widget?.querySelector<HTMLInputElement>('[data-replace]')
  const active = document.activeElement
  return {
    find: find?.value ?? null,
    replace: replace?.value ?? null,
    focus: !document.hasFocus()
      ? 'none'
      : active === find
        ? 'find'
        : active === replace
          ? 'replace'
          : 'other',
    status:
      widget?.querySelector<HTMLElement>('[data-status]')?.textContent ?? null,
    depth: `${slot.undoStack.length}/${slot.redoStack.length}`,
    engineUndos: (w.__t603?.undos ?? 0) as number,
  }
}

const findState = (ctx: Ctx) => evalFrame(ctx.kit, readFind, 0)

const runCommand = (kit: Kit, command: string) =>
  kit.host(
    async (vscode, [id]: [string]) => {
      await vscode.commands.executeCommand(id)
    },
    [command],
  )

// Leg 1: Ctrl+Shift+E is not an undo boundary and not an edit.
async function explorerChordLeg(ctx: Ctx) {
  await waitForInitialUndoSnapshot(ctx.kit.frame())
  expect(await evalFrame(ctx.kit, installWatch, 0), 'watch installed').toBe(
    true,
  )
  await select(ctx, 'delta.', { collapsed: true, offset: 'delta.'.length })
  const opened = await webview(ctx)
  await ctx.kit.xtest.type('X')
  const withX = DOC.replace('delta.', 'delta.X')
  await expectHost(ctx, withX, 'X reaches the host')
  await ctx.kit.workbox.waitForTimeout(UNDO_LOCK_MS)
  const authored = await webview(ctx)
  const hostBefore = await hostDoc(ctx)
  expect(authored.undo, 'the authored step has its own entry').toBe(
    opened.undo + 1,
  )

  await ctx.kit.xtest.key('ctrl+shift+e')
  await expect
    .poll(() => sidebarVisible(ctx.kit), {
      timeout: 10_000,
      message: 'Ctrl+Shift+E opens Explorer',
    })
    .toBe(true)
  await expect
    .poll(async () => (await evalFrame(ctx.kit, readFocus, 0)).documentFocus, {
      timeout: 10_000,
      message: 'focus leaves the webview',
    })
    .toBe(false)
  await ctx.kit.workbox.waitForTimeout(STABLE_MS) // negative-observation window
  const afterChord = await webview(ctx)
  const hostChord = await hostDoc(ctx)
  const chord = {
    value: afterChord.value === authored.value,
    undo: afterChord.undo,
    redo: afterChord.redo,
    hostText: hostChord.text === hostBefore.text,
    hostVersion: hostChord.version,
    engineUndos: afterChord.engineUndos,
  }
  expect(
    chord,
    `${ctx.mode}: Ctrl+Shift+E changes neither the document nor its history (observed ${JSON.stringify(chord)})`,
  ).toEqual({
    value: true,
    undo: authored.undo,
    redo: 0,
    hostText: true,
    hostVersion: hostBefore.version,
    engineUndos: authored.engineUndos,
  })

  // Explorer has focus; Ctrl+Z there would be Explorer's own undo. Refocus the editor first.
  await runCommand(ctx.kit, 'workbench.action.focusActiveEditorGroup')
  await expect
    .poll(async () => (await evalFrame(ctx.kit, readFocus, 0)).inEditor, {
      timeout: 10_000,
      message: 'the editor has focus again',
    })
    .toBe(true)
  await undoByKey(ctx, afterChord.engineUndos, 'Ctrl+Z after refocusing')
  await expectHost(ctx, DOC, 'one Ctrl+Z undoes exactly the authored step')
  await ctx.kit.workbox.waitForTimeout(STABLE_MS) // negative-observation window
  const undone = await webview(ctx)
  const hostUndone = await hostDoc(ctx)
  expect(
    { undo: undone.undo, redo: undone.redo, value: undone.value.includes('X') },
    `${ctx.mode}: the authored step is the only one undone`,
  ).toEqual({ undo: authored.undo - 1, redo: 1, value: false })
  return {
    mechanism: 'XTEST keys',
    versions: [hostBefore.version, hostChord.version, hostUndone.version],
    leavesEdit: true,
  }
}

// Leg 2's document baseline and its "nothing moved" check: host text and version, the webview value,
// the document's Undo depth and the engine's Undo count. `rebase` moves it once, after the
// interleaved case's own authored edit.
async function documentBaseline(ctx: Ctx) {
  let base = await hostDoc(ctx)
  let baseFind = await findState(ctx)
  let baseValue = (await webview(ctx)).value
  return {
    version: () => base.version,
    async rebase() {
      base = await hostDoc(ctx)
      baseFind = await findState(ctx)
      baseValue = (await webview(ctx)).value
    },
    async expectUntouched(what: string) {
      await ctx.kit.workbox.waitForTimeout(800) // negative-observation window
      const host = await hostDoc(ctx)
      const view = await findState(ctx)
      const observed = {
        host: host.text === base.text,
        version: host.version,
        webview: (await webview(ctx)).value === baseValue,
        depth: view.depth,
        engineUndos: view.engineUndos,
      }
      expect(
        observed,
        `${what}: the document is untouched (observed ${JSON.stringify(observed)}, baseline depth ${baseFind.depth})`,
      ).toEqual({
        host: true,
        version: base.version,
        webview: true,
        depth: baseFind.depth,
        engineUndos: baseFind.engineUndos,
      })
    },
  }
}

// After the replace input's one step is redone: undo it, then press Undo again with nothing left.
// Neither press may reach the document (Chromium's frame-wide stack held the editor's step below).
async function expectReplaceExhausted(
  ctx: Ctx,
  expectDocument: (what: string) => Promise<void>,
  start: Awaited<ReturnType<typeof findState>>,
  typed: Awaited<ReturnType<typeof findState>>,
) {
  await ctx.kit.xtest.key('ctrl+z')
  await expect
    .poll(async () => (await findState(ctx)).replace, {
      timeout: 5_000,
      message: 'Ctrl+Z reverts the replace input',
    })
    .toBe(start.replace)
  await ctx.kit.xtest.key('ctrl+z')
  await expectDocument('Ctrl+Z after the replace input is exhausted')
  const exhausted = await findState(ctx)
  expect(
    { replace: exhausted.replace, focus: exhausted.focus },
    'an exhausted Undo changes nothing and keeps focus',
  ).toEqual({ replace: start.replace, focus: 'replace' })
  await ctx.kit.xtest.key('ctrl+y')
  await expect
    .poll(async () => (await findState(ctx)).replace, {
      timeout: 5_000,
      message: 'Ctrl+Y redoes the replace input again',
    })
    .toBe(typed.replace)
}

// Interleaved: Find typing, then an authored editor edit that is newer than it, then back to Find.
// The Find field's own Undo and Redo still act on the Find text alone; the editor edit (newer in
// Chromium's frame-wide stack) is not taken, and focus stays in Find.
async function interleavedFindLeg(
  ctx: Ctx,
  document_: Awaited<ReturnType<typeof documentBaseline>>,
) {
  const findBefore = await findState(ctx)
  expect(findBefore.find, 'Find holds the typed query').toBe(QUERY_CHAR)
  const edited = `${TOKEN}X`
  await select(ctx, edited, { collapsed: true, offset: edited.length })
  await ctx.kit.xtest.type('Y')
  await expect
    .poll(async () => (await hostDoc(ctx)).text?.includes(`${edited}Y`), {
      timeout: 15_000,
      message: 'Y reaches the host',
    })
    .toBe(true)
  await ctx.kit.workbox.waitForTimeout(UNDO_LOCK_MS)
  await document_.rebase()
  await ctx.kit.frame().locator('.vmde-find-replace [data-find]').click()
  await expect
    .poll(async () => (await findState(ctx)).focus, {
      timeout: 5_000,
      message: 'Find input has focus again',
    })
    .toBe('find')
  const interleaved: string[] = []
  for (const [key, expected] of [
    ['ctrl+z', ''],
    ['ctrl+y', QUERY_CHAR],
    ['ctrl+z', ''],
    ['ctrl+shift+z', QUERY_CHAR],
  ] as const) {
    await ctx.kit.xtest.key(key)
    await expect
      .poll(async () => (await findState(ctx)).find, {
        timeout: 5_000,
        message: `${key} acts on the Find text after an editor edit`,
      })
      .toBe(expected)
    await document_.expectUntouched(`${key} in Find after an editor edit`)
    expect(
      (await findState(ctx)).focus,
      `focus stays in Find after ${key}`,
    ).toBe('find')
    interleaved.push(`${key}:${JSON.stringify(expected)}`)
  }
  return interleaved
}

// Undo and Redo straight after opening Find: the field's history is empty (its seed is a
// programmatic value). Nothing changes in the field or the document, depth included.
async function expectEmptyFindHistory(
  ctx: Ctx,
  document_: Awaited<ReturnType<typeof documentBaseline>>,
) {
  const frame = ctx.kit.frame()
  await ctx.kit.xtest.key('ctrl+f')
  await expect(frame.locator('.vmde-find-replace')).toBeVisible({
    timeout: 10_000,
  })
  await expect(frame.locator('.vmde-find-replace [data-find]')).toBeFocused()
  const empty = await findState(ctx)
  for (const key of ['ctrl+z', 'ctrl+y', 'ctrl+shift+z']) {
    await ctx.kit.xtest.key(key)
    await document_.expectUntouched(`${key} in the empty Find input`)
    const after = await findState(ctx)
    expect(
      { find: after.find, focus: after.focus, status: after.status },
      `${key} in the empty Find input changes nothing and keeps focus`,
    ).toEqual({ find: empty.find, focus: 'find', status: empty.status })
  }
  return { find: empty.find, status: empty.status }
}

// Leg 2 (large fixture, IR): Undo/Redo keys in the Find and Replace inputs.
async function findInputLeg(ctx: Ctx) {
  await waitForInitialUndoSnapshot(ctx.kit.frame())
  expect(await evalFrame(ctx.kit, installWatch, 0), 'watch installed').toBe(
    true,
  )
  // An authored edit gives a wrongly routed Undo something to remove.
  await select(ctx, TOKEN, { collapsed: true, offset: TOKEN.length })
  await ctx.kit.xtest.type('X')
  await expect
    .poll(async () => (await hostDoc(ctx)).text?.includes(`${TOKEN}X`), {
      timeout: 15_000,
      message: 'X reaches the host',
    })
    .toBe(true)
  await ctx.kit.workbox.waitForTimeout(UNDO_LOCK_MS)
  const facts: Record<string, unknown> = {}
  const frame = ctx.kit.frame()
  const document_ = await documentBaseline(ctx)
  const expectDocument = document_.expectUntouched

  facts.emptyFindUndo = await expectEmptyFindHistory(ctx, document_)

  // One character each: OS-typed characters are separate native undo steps in a text input, so one
  // Ctrl+Z reverts exactly this text.
  const inputs = [
    { name: 'find', text: QUERY_CHAR },
    { name: 'replace', text: 'q' },
  ] as const
  for (const { name, text } of inputs) {
    if (name === 'replace') {
      const row = frame.locator('#vmde-find-replace-row')
      if (await row.isHidden())
        await frame
          .locator('.vmde-find-replace [data-action="toggle-replace"]')
          .click()
      await frame.locator('.vmde-find-replace [data-replace]').click()
    }
    await expect
      .poll(async () => (await findState(ctx)).focus, {
        timeout: 5_000,
        message: `${name} input has focus`,
      })
      .toBe(name)
    if (name === 'find') {
      // Ctrl+F prefills Find with the word at the caret (set programmatically, so it is not in the
      // input's own history). Clear it, so the typed text is the only step to undo.
      await ctx.kit.xtest.key('ctrl+a')
      await ctx.kit.xtest.key('BackSpace')
      await expect
        .poll(async () => (await findState(ctx)).find, {
          timeout: 5_000,
          message: 'the prefilled query is cleared',
        })
        .toBe('')
      await ctx.kit.workbox.waitForTimeout(800) // the match count settles
    }
    const start = await findState(ctx)
    await ctx.kit.xtest.type(text)
    await expect
      .poll(async () => (await findState(ctx))[name], {
        timeout: 10_000,
        message: `${name} input holds the typed text`,
      })
      .toBe(text)
    await ctx.kit.workbox.waitForTimeout(800) // the match count settles
    const typed = await findState(ctx)
    await expectDocument(`typing in the ${name} input`)

    await ctx.kit.xtest.key('ctrl+z')
    await expect
      .poll(async () => (await findState(ctx))[name], {
        timeout: 5_000,
        message: `Ctrl+Z reverts the ${name} input's typing`,
      })
      .toBe(start[name])
    await expectDocument(`Ctrl+Z in the ${name} input`)
    const undone = await findState(ctx)
    expect(undone.focus, `focus stays in the ${name} input after Ctrl+Z`).toBe(
      name,
    )
    // The Find count follows the query; the Replace input does not touch it.
    expect(
      undone.status,
      `${name}: the match count after Ctrl+Z (typed ${typed.status}, before ${start.status})`,
    ).toBe(start.status)

    const redoKeys: string[] = []
    for (const redoKey of ['ctrl+y', 'ctrl+shift+z']) {
      await ctx.kit.xtest.key(redoKey)
      await expect
        .poll(async () => (await findState(ctx))[name], {
          timeout: 5_000,
          message: `${redoKey} redoes the ${name} input's typing`,
        })
        .toBe(typed[name])
      await ctx.kit.workbox.waitForTimeout(800) // the match count settles
      await expectDocument(`${redoKey} in the ${name} input`)
      const redone = await findState(ctx)
      expect(
        { focus: redone.focus, status: redone.status },
        `${name}: ${redoKey} keeps focus and restores the match count`,
      ).toEqual({ focus: name, status: typed.status })
      redoKeys.push(redoKey)
      if (redoKey === 'ctrl+y') {
        // Undo again so the second Redo key has history to redo.
        await ctx.kit.xtest.key('ctrl+z')
        await expect
          .poll(async () => (await findState(ctx))[name], {
            timeout: 5_000,
            message: `Ctrl+Z again reverts the ${name} input`,
          })
          .toBe(start[name])
      }
    }
    facts[name] = {
      typed: typed.status,
      afterUndo: undone.status,
      redoKeys,
    }
    if (name === 'replace')
      await expectReplaceExhausted(ctx, document_.expectUntouched, start, typed)
  }

  facts.interleaved = await interleavedFindLeg(ctx, document_)
  return {
    mechanism: 'XTEST keys in Find and Replace',
    facts,
    versions: [document_.version()],
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

  // Leg 1 (item 1): Ctrl+Shift+E is not an undo boundary.
  for (const mode of ['ir', 'wysiwyg', 'sv'] as const) {
    test(`${mode}: Ctrl+Shift+E leaves the document and its history alone`, async ({
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
      const ctx = await openMode(kit, mode, 'explorer')
      await leg(ctx, 'explorer-chord', () => explorerChordLeg(ctx))
      report(mode, ctx.results, LABEL)
    })
  }

  // Leg 2 (item 2): Undo and Redo keys in the Find and Replace inputs.
  test('ir large fixture: Undo/Redo keys in the Find and Replace inputs', async ({
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
    const ctx = await openDocument(kit, 'find-inputs-large.md', LARGE, 'ir')
    await leg(ctx, 'find-inputs', () => findInputLeg(ctx))
    report('ir large', ctx.results, LABEL)
  })
})
