/**
 * Task 601 — Undo or Redo pressed while the latest edit's undo checkpoint is still pending, in the
 * real VS Code webview with OS-level XTEST input.
 *
 * Vditor records an edit in its undo stack `undoDelay` (800 ms) after the edit; IR prose typing
 * first waits for edit-activity's 220 ms settle. Before Task 601 an Undo inside that window popped
 * the previous entry: the webview removed the two latest edits while the host's native undo removed
 * one, and the pending edit could not be redone. VMDE now drains the pending checkpoint and posts
 * the pending edit to the host before the history transition (undo-boundaries.ts).
 *
 * Each leg types `X` after `delta.`, waits until `X` has its own checkpoint and reached the host,
 * types `W`, and runs the history while `W` is demonstrably pending: a read-only wrapper outside
 * VMDE's history wrapper records, at the engine call (or at the toolbar press, before VMDE's
 * capture preparation), the active stack, whether `W` is in the DOM, whether an edit's checkpoint
 * callback is pending and the time since the `W` key. A leg whose window closed fails as "pending
 * window missed": that is a missed setup window, not behavior evidence either way. The wrappers only
 * count and record; they never change timers, history, source, selection or routing.
 *
 * Mechanisms are named in every leg record: keys are XTEST (`helpers/xtest-input.ts`); the toolbar
 * Undo/Redo is a Playwright mouse click; `vmde.format.undo`/`redo` run through
 * `vscode.commands.executeCommand`. Each test first sends one Ctrl+Z to an untouched, settled
 * document (the first XTEST Ctrl chord of a session sometimes never reached the webview in the Task
 * 598 investigation). A measured key is never retried. Host comparisons stay booleans or lengths.
 *
 * The large-fixture test uses the Find fixture (174 KB, incremental IR serialization). After typing,
 * its host text is Vditor's normalized serialization (Task 597 ruling 6), so expectations derive from
 * the host text read after `X` settles, and an Undo back to the opened bytes compares the webview
 * with its own rendering of them. Its Find leg types into the Find input and presses Ctrl+Z there
 * (today's document Undo; Task 603 item 2 owns changing that): Find typing must leave nothing to
 * drain or publish. IME composition refusal is covered by unit and Chromium tests (handoff §3 item 4:
 * the smallest appropriate layer).
 */
import { readFileSync } from 'node:fs'
import { expect, test } from 'vscode-test-playwright'
import {
  FIXTURE as LARGE,
  UNIQUE_PROSE_TOKEN as TOKEN,
} from './find-replace-fixture-helpers'
import {
  type Ctx,
  closeAll,
  difference,
  evalFrame,
  expectHost,
  hostState,
  type Kit,
  leg,
  type Mode,
  makeKit,
  openDocument,
  openEditor,
  report,
  select,
} from './helpers/shortcut-xtest-kit'
import { waitForInitialUndoSnapshot } from './webview-helpers'

// A small document that round-trips exactly through every mode's serializer (Task 598's DOC).
const DOC =
  '# Probe\n\nAlpha bravo charlie delta.\n\nEcho `foxtrot` golf hotel.\n\nIndia juliet kilo lima.\n'
// Where `X`, `W` and `Y` are typed: after `delta.` in DOC, after the unique prose token in the large
// Find fixture.
const ANCHOR = 'delta.'
// Negative-observation window after a transition: longer than the mode's 800 ms checkpoint delay
// plus IR's 220 ms settle and the 250 ms edit-sync debounce, and than a host round trip.
const STABLE_MS = 1500
const LABEL = 'Task 601 pending checkpoint'

type Route = 'keyboard' | 'toolbar' | 'command'

interface Entry {
  kind: string
  at: string
  sinceKey: number
  undo: number
  redo: number
  hasW: boolean
  pendingCallback: boolean
}

interface Probe {
  entries: Entry[]
  undos: number
  redos: number
  adds: number
}

// --- In-page probes (each runs inside the webview and must stay self-contained) ---

// Records the state at each history entry. It wraps the engine outside VMDE's history wrapper, so
// it runs before VMDE's preparation; a toolbar press is recorded at mousedown, before VMDE's
// capture-phase preparation on click.
function installProbe(): boolean {
  const w = window as any
  const inner = w.vditor?.vditor
  if (!inner?.undo) return false
  if (w.__t601) return true
  const undo = inner.undo
  const probe: Probe & { lastKeyAt: number; marker: string } = {
    marker: '',
    entries: [],
    undos: 0,
    redos: 0,
    adds: 0,
    lastKeyAt: 0,
  }
  window.addEventListener(
    'keydown',
    (event) => {
      if (event.isTrusted && event.key === 'W')
        probe.lastKeyAt = performance.now()
    },
    true,
  )
  const record = (kind: string, at: string) => {
    const mode = inner.currentMode
    const pending = inner[mode]?.vmdeAfterRender
    if (probe.entries.length < 40)
      probe.entries.push({
        kind,
        at,
        sinceKey: Math.round(performance.now() - probe.lastKeyAt),
        undo: undo[mode].undoStack.length,
        redo: undo[mode].redoStack.length,
        // Whether the pending edit is in the live DOM (the marker is set before `W` is typed).
        hasW:
          !!probe.marker &&
          !!inner[mode]?.element?.textContent?.includes(probe.marker),
        pendingCallback:
          !!pending?.options?.enableAddUndoStack &&
          !!pending.options.enableInput,
      })
  }
  for (const kind of ['undo', 'redo'] as const) {
    const original = undo[kind]
    undo[kind] = function (vditor: unknown) {
      probe[`${kind}s`]++
      record(kind, 'engine')
      return original.call(this, vditor)
    }
  }
  const add = undo.addToUndoStack
  undo.addToUndoStack = function (vditor: unknown) {
    probe.adds++
    return add.call(this, vditor)
  }
  window.addEventListener(
    'mousedown',
    (event) => {
      for (const kind of ['undo', 'redo'])
        if (
          inner.toolbar?.elements?.[kind]?.children[0]?.contains(
            event.target as Node,
          )
        )
          record(kind, 'toolbar-press')
    },
    true,
  )
  w.__t601 = probe
  return true
}

function readProbe(): Probe & { stack: string } {
  const w = window as any
  const inner = w.vditor.vditor
  const slot = inner.undo[inner.currentMode]
  return {
    ...w.__t601,
    stack: `${slot.undoStack.length}/${slot.redoStack.length}`,
  }
}

function setMarker(_body: Element, marker: string) {
  ;(window as any).__t601.marker = marker
}

// Resolves as soon as the active undo stack reaches `depth` (or false after 3 s).
async function waitForDepth(_body: Element, depth: number): Promise<boolean> {
  const inner = (window as any).vditor.vditor
  const started = performance.now()
  while (performance.now() - started < 3_000) {
    if (inner.undo[inner.currentMode].undoStack.length >= depth) return true
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
  return false
}

function readRendered(): string {
  return (window as any).vditor.getValue()
}

// The live caret: collapsed, in an editable block of the active root, focused, painted, and whether
// the block text before it ends with `before`.
function readCaret(_body: Element, before: string) {
  const inner = (window as any).vditor.vditor
  const root = inner[inner.currentMode].element as HTMLElement
  const selection = getSelection()
  const node = selection?.focusNode ?? null
  const state = {
    collapsed: !!selection?.isCollapsed,
    editable: false,
    painted: false,
    before: false,
  }
  if (!selection?.rangeCount || !node || node === root || !root.contains(node))
    return state
  const element =
    node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as Element)
  const block = element?.closest('[data-block], p, li, h1, h2, h3, pre')
  state.editable =
    !!block &&
    block !== root &&
    root.contains(block) &&
    !element?.closest('.vditor-ir__preview, .vditor-wysiwyg__preview')
  if (block) {
    const head = document.createRange()
    head.selectNodeContents(block)
    head.setEnd(node, selection.focusOffset)
    state.before = head.toString().endsWith(before)
  }
  const range = selection.getRangeAt(0)
  const rect = range.getClientRects()[0] ?? range.getBoundingClientRect()
  state.painted = rect.height > 0
  return state
}

// --- Test-side helpers ---

const probe = (kit: Kit) => evalFrame(kit, readProbe, 0)
const rendered = (kit: Kit) => evalFrame(kit, readRendered, 0)

// The host document's text, version and dirty state.
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

// SV's `getValue()` keeps a trailing newline the host does not (Task 598 measured); compare SV
// without trailing newlines. The host assertions stay exact.
const agrees = (mode: Mode, webview: string, host: string) =>
  mode === 'sv'
    ? webview.replace(/​(?=\n*$)/gu, '').replace(/\n+$/, '') ===
      host.replace(/\n+$/, '')
    : webview === host

const runCommand = (kit: Kit, command: string) =>
  kit.host(
    async (vscode, [id]: [string]) => {
      await vscode.commands.executeCommand(id)
    },
    [command],
  )

async function history(ctx: Ctx, kind: 'undo' | 'redo', route: Route) {
  if (route === 'toolbar')
    await ctx.kit
      .frame()
      .locator(`.vditor-toolbar [data-type="${kind}"]`)
      .first()
      .click()
  else if (route === 'command') await runCommand(ctx.kit, `vmde.format.${kind}`)
  else await ctx.kit.xtest.key(kind === 'undo' ? 'ctrl+z' : 'ctrl+y')
}

// After a transition: host exact, webview agreeing, and nothing late for STABLE_MS (no extra
// version, no extra engine call or entry, the same stacks).
// `webview` is the expected serialization when it differs from the host: on the large fixture the
// opened bytes are not Vditor's normalized rendering (Task 597 ruling 6), so after an Undo back to
// them the webview is compared with its own rendering of the opened document.
async function expectSettled(
  ctx: Ctx,
  expected: string,
  what: string,
  webviewExpected = expected,
) {
  await expectHost(ctx, expected, what)
  const first = await hostDoc(ctx)
  const before = await probe(ctx.kit)
  await ctx.kit.workbox.waitForTimeout(STABLE_MS) // negative-observation window
  const after = await probe(ctx.kit)
  const host = await hostDoc(ctx)
  const webview = await rendered(ctx.kit)
  expect(
    {
      host: host.text === expected,
      version: host.version,
      webview: agrees(ctx.mode, webview, webviewExpected),
      stack: after.stack,
      adds: after.adds,
      engine: after.undos + after.redos,
    },
    `${ctx.mode}: ${what}, stable`,
  ).toEqual({
    host: true,
    version: first.version,
    webview: true,
    stack: before.stack,
    adds: before.adds,
    engine: before.undos + before.redos,
  })
  return host
}

async function expectCaret(ctx: Ctx, before: string) {
  const seen = { caret: null as unknown }
  try {
    await expect
      .poll(
        async () => {
          seen.caret = await evalFrame(ctx.kit, readCaret, before)
          return seen.caret
        },
        { timeout: 5_000 },
      )
      .toEqual({ collapsed: true, editable: true, painted: true, before: true })
  } catch {
    throw new Error(
      `${ctx.mode}: caret after ${before} ${JSON.stringify(seen.caret)}`,
    )
  }
}

// Types `X` after `anchor` and waits until it has its own checkpoint and reached the host. The
// large fixture's host text after typing is Vditor's normalized serialization (Task 597 ruling 6),
// so the later expectations derive from the host text read here instead of from the opened bytes.
async function settleX(ctx: Ctx, anchor = ANCHOR) {
  await waitForInitialUndoSnapshot(ctx.kit.frame())
  expect(await evalFrame(ctx.kit, installProbe, 0), 'probe installed').toBe(
    true,
  )
  await select(ctx, anchor, { collapsed: true, offset: anchor.length })
  const opened = Number((await probe(ctx.kit)).stack.split('/')[0])
  const renderedOpened = await rendered(ctx.kit)
  await ctx.kit.xtest.type('X')
  if (!ctx.large)
    await expectHost(
      ctx,
      ctx.initial.replace(anchor, `${anchor}X`),
      'X reaches the host',
    )
  await expect
    .poll(async () => (await hostDoc(ctx)).text?.includes(`${anchor}X`), {
      timeout: 15_000,
      message: `${ctx.mode}: X reaches the host`,
    })
    .toBe(true)
  await expect
    .poll(async () => (await probe(ctx.kit)).stack, {
      timeout: 5_000,
      message: `${ctx.mode}: X has its own checkpoint`,
    })
    .toBe(`${opened + 1}/0`)
  await ctx.kit.workbox.waitForTimeout(500)
  const withX = (await hostDoc(ctx)).text as string
  // The oracle below splices at the anchor, so it must occur once.
  expect(withX.split(`${anchor}X`).length, 'anchor occurs once').toBe(2)
  const at = (suffix: string) =>
    withX.replace(`${anchor}X`, `${anchor}${suffix}`)
  return {
    depth: opened + 1,
    renderedOpened,
    withX,
    withXW: at('XW'),
    withXWY: at('XWY'),
  }
}

// The history entry of this leg proves `W` arrived and its checkpoint had not landed.
function expectPending(
  entry: Entry | undefined,
  depthAfterX: number,
  limit: number,
) {
  const pending =
    !!entry &&
    entry.hasW &&
    entry.undo === depthAfterX &&
    entry.redo === 0 &&
    entry.sinceKey < limit
  if (!pending)
    throw new Error(`pending window missed: ${JSON.stringify(entry ?? null)}`)
}

// Leg: X settled, W pending, Undo by `route` after `delay` ms, then Redo by the same route, then
// one OS key at the restored caret; on the small document also save (and optionally reopen).
async function pendingLeg(
  ctx: Ctx,
  route: Route,
  delay: number,
  options: { anchor?: string; reopen?: boolean } = {},
) {
  const anchor = options.anchor ?? ANCHOR
  const { depth, withX, withXW, withXWY } = await settleX(ctx, anchor)
  const marks = await probe(ctx.kit)
  const opened = await hostDoc(ctx)
  await evalFrame(ctx.kit, setMarker, `${anchor}XW`)
  await ctx.kit.xtest.type('W')
  if (delay) await ctx.kit.workbox.waitForTimeout(delay)
  await history(ctx, 'undo', route)
  const afterUndo = await probe(ctx.kit)
  const entry = afterUndo.entries[marks.entries.length]
  // IR's settle runs 220 ms after the key; before it, the checkpoint callback is not armed yet.
  const limit = delay === 0 ? 220 : ctx.mode === 'ir' ? 1000 : 800
  expectPending(entry, depth, limit)
  const undone = await expectSettled(ctx, withX, `${route} Undo removes only W`)
  expect(
    {
      engine: afterUndo.undos - marks.undos,
      dirty: undone.dirty,
      stack: (await probe(ctx.kit)).stack,
    },
    `${ctx.mode}: one engine Undo, W's own entry popped`,
  ).toEqual({ engine: 1, dirty: true, stack: `${depth}/1` })
  await expectCaret(ctx, `${anchor}X`)
  await history(ctx, 'redo', route)
  const redone = await expectSettled(ctx, withXW, `${route} Redo restores W`)
  expect((await probe(ctx.kit)).stack, `${ctx.mode}: Redo branch used`).toBe(
    `${depth + 1}/0`,
  )
  await expectCaret(ctx, `${anchor}XW`)
  await ctx.kit.xtest.type('Y')
  await expectHost(ctx, withXWY, 'the next key lands at the restored caret')
  const facts = {
    mechanism: route === 'keyboard' ? 'XTEST keys' : route,
    fixture: ctx.large ? 'large' : 'small',
    delay,
    entry,
    depthAfterX: depth,
    versions: [opened.version, undone.version, redone.version],
    leavesEdit: true,
  }
  if (ctx.large) return facts
  expect(
    readFileSync(ctx.file, 'utf8') === ctx.initial,
    'disk unchanged before save',
  ).toBe(true)
  await runCommand(ctx.kit, 'workbench.action.files.save')
  await expect
    .poll(() => readFileSync(ctx.file, 'utf8') === withXWY, {
      message: 'save writes the final bytes',
    })
    .toBe(true)
  if (!options.reopen) return facts
  await closeAll(ctx.kit, ctx.file)
  await openEditor(ctx)
  await ctx.kit.workbox.waitForTimeout(STABLE_MS) // negative-observation window: no post on reopen
  const reopened = await hostDoc(ctx)
  expect(
    {
      host: reopened.text === withXWY,
      dirty: reopened.dirty,
      webview: agrees(ctx.mode, await rendered(ctx.kit), withXWY),
    },
    'reopen keeps the saved bytes',
  ).toEqual({ host: true, dirty: false, webview: true })
  return { ...facts, savedAndReopened: true }
}

// Leg (large fixture): typing in the Find input is not editor input. With X settled, Ctrl+F, a
// query typed into the Find input, then Ctrl+Z from that input (today's document Undo, Task 603
// item 2): nothing is drained or published, and the Undo removes exactly X.
async function findTypingLeg(ctx: Ctx) {
  const { depth, withX, renderedOpened } = await settleX(ctx, TOKEN)
  const widget = ctx.kit.frame().locator('.vmde-find-replace')
  await ctx.kit.xtest.key('ctrl+f')
  await expect(widget).toBeVisible({ timeout: 10_000 })
  const input = widget.locator('[data-find]')
  await expect(input).toBeFocused()
  await ctx.kit.xtest.key('ctrl+a')
  const marks = await probe(ctx.kit)
  const before = await hostDoc(ctx)
  await ctx.kit.xtest.type('zq')
  await expect(input).toHaveValue('zq')
  await ctx.kit.xtest.key('ctrl+z')
  await expect
    .poll(async () => (await probe(ctx.kit)).undos - marks.undos, {
      timeout: 5_000,
      message: 'Ctrl+Z from the Find input reaches the document Undo',
    })
    .toBe(1)
  const after = await probe(ctx.kit)
  const entry = after.entries[marks.entries.length]
  expect(
    { undo: entry?.undo, redo: entry?.redo, adds: after.adds - marks.adds },
    'no pending edit and nothing drained at the Undo',
  ).toEqual({ undo: depth, redo: 0, adds: 0 })
  expect(before.text === withX, 'Find typing published nothing').toBe(true)
  await expectSettled(
    ctx,
    ctx.initial,
    'Undo from the Find input removes X',
    renderedOpened,
  )
  const findState = {
    value: await input.inputValue(),
    focused: await input.evaluate(
      (element) => element === document.activeElement,
    ),
  }
  await runCommand(ctx.kit, 'vmde.format.redo')
  await expectSettled(ctx, withX, 'Redo restores X')
  return { mechanism: 'XTEST keys in Find', entry, findState, leavesEdit: true }
}

// Leg: the first edit on the seeded baseline, Undo by toolbar while its checkpoint is pending. The
// seed is the only entry, so Vditor still shows Undo disabled; preparation enables it.
async function firstEditToolbarLeg(ctx: Ctx) {
  await waitForInitialUndoSnapshot(ctx.kit.frame())
  expect(await evalFrame(ctx.kit, installProbe, 0), 'probe installed').toBe(
    true,
  )
  await select(ctx, 'delta.', { collapsed: true, offset: 6 })
  const before = await probe(ctx.kit)
  await evalFrame(ctx.kit, setMarker, 'delta.W')
  await ctx.kit.xtest.type('W')
  await ctx.kit.workbox.waitForTimeout(300)
  await history(ctx, 'undo', 'toolbar')
  const entry = (await probe(ctx.kit)).entries[before.entries.length]
  if (
    entry?.undo !== 1 ||
    entry.redo !== 0 ||
    !entry.hasW ||
    entry.sinceKey > 800
  )
    throw new Error(`pending window missed: ${JSON.stringify(entry ?? null)}`)
  const undone = await expectSettled(
    ctx,
    DOC,
    'toolbar Undo removes the first edit',
  )
  expect(undone.dirty, 'clean after Undo').toBe(false)
  await history(ctx, 'redo', 'toolbar')
  await expectSettled(ctx, DOC.replace('delta.', 'delta.W'), 'toolbar Redo')
  return { mechanism: 'toolbar', entry, leavesEdit: true }
}

// Leg (WYSIWYG): W's checkpoint has landed but its 250 ms publication is still queued. The Undo
// must post W to the host first, so the host undoes W and not X.
async function publicationGapLeg(ctx: Ctx) {
  const { depth, withX } = await settleX(ctx)
  const marks = await probe(ctx.kit)
  await evalFrame(ctx.kit, setMarker, 'delta.XW')
  await ctx.kit.xtest.type('W')
  // Polled inside the page, so the Undo follows the checkpoint within the 250 ms publication delay.
  expect(
    await evalFrame(ctx.kit, waitForDepth, depth + 1),
    `${ctx.mode}: W's checkpoint lands`,
  ).toBe(true)
  await history(ctx, 'undo', 'keyboard')
  const entry = (await probe(ctx.kit)).entries[marks.entries.length]
  // Setup validity: the checkpoint landed (deeper stack) and the key was under 1.05 s ago.
  if (!entry || entry.undo !== depth + 1 || entry.sinceKey > 1_050)
    throw new Error(
      `publication window missed: ${JSON.stringify(entry ?? null)}`,
    )
  await expectSettled(ctx, withX, 'Undo after the checkpoint removes only W')
  return { mechanism: 'XTEST keys', entry, leavesEdit: true }
}

async function warmUp(kit: Kit) {
  const ctx = await openDocument(kit, 'warm-up.md', DOC, 'ir')
  await waitForInitialUndoSnapshot(kit.frame())
  await select(ctx, 'delta.', { collapsed: true, offset: 6 })
  await kit.xtest.key('ctrl+z')
  await kit.workbox.waitForTimeout(STABLE_MS) // negative-observation window
  const state = await hostState(ctx)
  expect(
    {
      text: state.text === DOC,
      dirty: state.dirty,
      ...difference(state.text, DOC),
    },
    'warm-up Ctrl+Z on an untouched document changes nothing',
  ).toMatchObject({ text: true, dirty: false })
}

test.describe('Task 601 Undo before a pending checkpoint', () => {
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

  for (const mode of ['ir', 'wysiwyg', 'sv'] as const) {
    test(`${mode}: keyboard at 300 and 700 ms, toolbar and command`, async ({
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
      await warmUp(kit)
      const ctx = await openDocument(kit, `pending-${mode}.md`, DOC, mode)
      await leg(ctx, 'keyboard-300', () =>
        pendingLeg(ctx, 'keyboard', 300, { reopen: mode === 'ir' }),
      )
      await leg(ctx, 'keyboard-700', () => pendingLeg(ctx, 'keyboard', 700))
      await leg(ctx, 'toolbar-300', () => pendingLeg(ctx, 'toolbar', 300))
      await leg(ctx, 'command-300', () => pendingLeg(ctx, 'command', 300))
      if (mode === 'ir') {
        await leg(ctx, 'keyboard-pre-settle', () =>
          pendingLeg(ctx, 'keyboard', 0),
        )
        await leg(ctx, 'first-edit-toolbar', () => firstEditToolbarLeg(ctx))
      }
      if (mode === 'wysiwyg')
        await leg(ctx, 'publication-gap', () => publicationGapLeg(ctx))
      report(`${mode}`, ctx.results, LABEL)
    })
  }

  test('ir large fixture: pending Undo/Redo and Undo from the Find input', async ({
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
    await warmUp(kit)
    const ctx = await openDocument(kit, 'pending-large.md', LARGE, 'ir')
    await leg(ctx, 'large-keyboard-300', () =>
      pendingLeg(ctx, 'keyboard', 300, { anchor: TOKEN }),
    )
    await leg(ctx, 'large-find-typing', () => findTypingLeg(ctx))
    report('ir large', ctx.results, LABEL)
  })
})
