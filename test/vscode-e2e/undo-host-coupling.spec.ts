/**
 * Task 602 — one webview Undo/Redo step that spans several host writes, in the real VS Code
 * webview with OS-level XTEST input.
 *
 * Edit-sync publishes typing every 250 ms, and each host write is its own native undo stop. Vditor
 * records one history entry `undoDelay` (800 ms) after typing stops, so `X`, a 300–600 ms pause and
 * `Q` reach the host as two writes but form one webview entry. Before Task 602 one native Undo
 * removed only `Q`: the host kept `X` while the editor showed the text without it, and Save wrote
 * that to disk. The host now walks native history until its text provably matches the webview
 * result (history-coupling.ts).
 *
 * Each journey opens a fresh document in one mode, places the caret after the anchor, types `X`, a
 * gap and `Q` (or a twelve-key burst) with XTEST, waits until the post-`Q` checkpoint ran and the host
 * published the text, then presses Ctrl+Z and Ctrl+Y. Expected states are authored independently:
 * host states are the file's raw bytes with the insertion spliced in; webview states are Vditor's
 * rendering read at open with the same insertion. After each press it asserts the exact host and
 * webview texts, the dirty flag (clean at the saved state), that every host change of that press
 * came from native history (no later plain write) and that nothing changed for 2.6 s after it.
 * Variants save after Undo or Redo and reopen, run native text-editor Undo/Redo on the same
 * document to show that VMDE kept its native history, prime a large WYSIWYG document so later
 * entries use the 2,000 ms delay, or type a second entry and run Undo ×2 then Redo ×2. The large
 * fixture's host holds Vditor's normalized serialization after typing (Task 597 ruling 6); its Undo
 * must return to the exact original bytes (Owner decision 2026-10-07) and its Redo to the published
 * text. At a long gap (two entries) its intermediate host state is the last host text that held
 * exactly the first keys, read from the host's own change events.
 *
 * One further test runs the special journeys, each on its own fresh document: a twelve-key IR entry, a
 * mode switch after edits, an outside change between webview edits (WorkspaceEdit and a text editor
 * on the same document), the checkpoint flush (F: an entry recorded while an edit post is pending
 * publishes it at once, shown with the Enter boundary 100 ms after a key, and the F-correctness
 * journey X, Enter, Y whose first Undo needs X to have had its own host write) and the 64-step limit
 * (an entry over more than 64 host writes is refused, rolled back and resynchronized by the next
 * plain edit: exact text, dirty).
 *
 * Read-only in-page wrappers record trusted keys, Vditor's recorded entries and engine calls; a host
 * listener records document versions, reasons, dirty states and texts. They never change timers,
 * history or routing. Comparisons are booleans, labels and lengths, so fixture text stays out of the
 * output.
 */
import { readFileSync } from 'node:fs'
import { expect, test } from 'vscode-test-playwright'
import {
  FIXTURE as LARGE,
  UNIQUE_PROSE_TOKEN as LARGE_ANCHOR,
} from './find-replace-fixture-helpers'
import {
  type Ctx,
  closeAll,
  difference,
  evalFrame,
  hostState,
  type Kit,
  type Mode,
  makeKit,
  openDocument,
  openEditor,
  select,
  switchMode,
} from './helpers/shortcut-xtest-kit'
import { waitForInitialUndoSnapshot } from './webview-helpers'

const LABEL = 'Task 602 coupling'
// Round-trips exactly through every mode's serializer (Task 598's DOC).
const DOC =
  '# Probe\n\nAlpha bravo charlie delta.\n\nEcho `foxtrot` golf hotel.\n\nIndia juliet kilo lima.\n'
const ANCHOR = 'delta.'
// The last paragraph: nothing follows its end, so Enter's new paragraph is the last block.
const LAST_ANCHOR = 'lima.'
// Above the 1,500 ms floor and above the largest checkpoint delay (2,000 ms, large WYSIWYG) plus
// the 250 ms edit-sync debounce.
const STABLE_MS = 2600
// TextDocumentChangeReason: 1 = Undo, 2 = Redo; 0 here = a plain edit (no reason).
const REASON = { undo: 1, redo: 2 } as const
// history-coupling.ts MAX_NATIVE_STEPS.
const MAX_NATIVE_STEPS = 64

interface Journey {
  name: string
  mode: Mode
  gap: number
  typed?: string
  crlf?: boolean
  large?: boolean
  // Typed and settled before the measured keys; on a large WYSIWYG document the first post
  // widens Vditor's undoDelay to 2,000 ms for the later entries.
  prime?: string
  // A second entry typed after the first settled: Undo ×2, then Redo ×2.
  chain?: string
  after?: 'save-reopen' | 'redo-save-reopen' | 'native-history'
}

interface State {
  host: string
  view: string
  dirty: boolean
}

// --- In-page recorder ---

function installRecorder(): boolean {
  const w = window as any
  const inner = w.vditor?.vditor
  if (!inner?.undo) return false
  if (w.__t602) return true
  const undo = inner.undo
  const record: any = { keys: [], entries: [], engine: [] }
  window.addEventListener(
    'keydown',
    (event) => {
      if (event.isTrusted)
        record.keys.push({ key: event.key, ctrl: event.ctrlKey, t: Date.now() })
    },
    true,
  )
  const depth = () => undo[inner.currentMode].undoStack.length as number
  const add = undo.addToUndoStack
  undo.addToUndoStack = function (...args: unknown[]) {
    const before = depth()
    const result = add.apply(this, args)
    record.entries.push({ t: Date.now(), before, after: depth() })
    return result
  }
  for (const kind of ['undo', 'redo']) {
    const original = undo[kind]
    undo[kind] = function (...args: unknown[]) {
      record.engine.push({ kind, t: Date.now() })
      return original.apply(this, args)
    }
  }
  w.__t602 = record
  return true
}

function readRecorder() {
  const w = window as any
  const inner = w.vditor.vditor
  const slot = inner.undo[inner.currentMode]
  const pending = inner[inner.currentMode]?.vmdeAfterRender
  return {
    keys: w.__t602.keys as { key: string; t: number }[],
    entries: w.__t602.entries as { t: number; before: number; after: number }[],
    engine: w.__t602.engine.length as number,
    depth: slot.undoStack.length as number,
    redoDepth: slot.redoStack.length as number,
    // Task 601: an armed after-render callback means an entry is still pending.
    armed:
      !!pending?.options?.enableAddUndoStack && !!pending.options.enableInput,
    value: w.vditor.getValue() as string,
    undoDelay: Number(inner.options?.undoDelay),
  }
}

// --- Host recorder ---

const installHostRecorder = (ctx: Ctx) =>
  ctx.kit.host(
    (vscode, [fsPath]: [string]) => {
      const g = globalThis as any
      g.__t602Host ??= {}
      g.__t602Subs ??= []
      const record = { events: [] as unknown[], texts: [] as string[] }
      g.__t602Host[fsPath] = record
      g.__t602Subs.push(
        vscode.workspace.onDidChangeTextDocument((event) => {
          if (event.document.uri.fsPath !== fsPath) return
          if (!event.contentChanges.length) return
          record.events.push({
            t: Date.now(),
            version: event.document.version,
            reason: event.reason ?? 0,
            dirty: event.document.isDirty,
          })
          record.texts.push(event.document.getText())
        }),
      )
    },
    [ctx.file],
  )

const readHost = (ctx: Ctx) =>
  ctx.kit.host(
    (vscode, [fsPath]: [string]) => {
      const document = vscode.workspace.textDocuments.find(
        (candidate) => candidate.uri.fsPath === fsPath,
      )
      return {
        text: document?.getText() ?? null,
        version: document?.version ?? -1,
        dirty: document?.isDirty ?? null,
        events: (globalThis as any).__t602Host[fsPath].events as {
          t: number
          version: number
          reason: number
          dirty: boolean
        }[],
      }
    },
    [ctx.file],
  )

// The text after each recorded host change, from `from` on.
const hostTexts = (ctx: Ctx, from: number) =>
  ctx.kit.host(
    (_vscode, [fsPath, start]: [string, number]) =>
      ((globalThis as any).__t602Host[fsPath].texts as string[]).slice(start),
    [ctx.file, from],
  )

const disposeHostRecorder = (kit: Kit) =>
  kit.host(() => {
    const g = globalThis as any
    for (const sub of g.__t602Subs ?? []) sub.dispose()
    g.__t602Subs = []
    g.__t602Host = {}
  }, [])

const lengths = (actual: string | null, expected: string) =>
  actual === expected ? true : difference(actual, expected)

const crlf = (text: string) =>
  text.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n')

// SV's editable DOM ends in one extra newline span; edit posts and the host omit it.
const svTrim = (text: string) =>
  text.replace(/​(?=\n*$)/gu, '').replace(/\n+$/, '')

const page = (kit: Kit) => evalFrame(kit, readRecorder, 0)

async function warmUp(kit: Kit) {
  const ctx = await openDocument(kit, 'warm-up.md', DOC, 'ir')
  await waitForInitialUndoSnapshot(kit.frame())
  await select(ctx, ANCHOR, { collapsed: true, offset: ANCHOR.length })
  await kit.xtest.key('ctrl+z')
  await kit.workbox.waitForTimeout(1500)
  await closeAll(kit, ctx.file)
}

// Opens `content` in `mode` with both recorders and the caret after `anchor`.
async function openRecorded(
  kit: Kit,
  name: string,
  content: string,
  mode: Mode,
  anchor: string,
) {
  const ctx = await openDocument(kit, name, content, mode)
  await installHostRecorder(ctx)
  await waitForInitialUndoSnapshot(kit.frame())
  expect(await evalFrame(kit, installRecorder, 0), 'recorder').toBe(true)
  await select(ctx, anchor, { collapsed: true, offset: anchor.length })
  const start = await page(kit)
  expect(
    start.value.split(anchor).length,
    'anchor unique in the rendering',
  ).toBe(2)
  return { ctx, R0: start.value }
}

// Types `typed` at the caret, `gap` ms between keys, then waits for the natural settle: the last
// key's checkpoint ran, nothing is armed, the host holds `${at}${typed}` and stayed quiet for
// 400 ms. `kept` is how many of the keys an Undo keeps: those before the last entry recorded
// between the first and the last key (a gap above undoDelay).
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one polling loop with the settle conditions
async function typeAndSettle(ctx: Ctx, at: string, typed: string, gap: number) {
  const { kit } = ctx
  const start = await page(kit)
  const hostStart = await readHost(ctx)
  if (gap <= 100 && typed.length === 2) await kit.xtest.type(typed, gap)
  else
    for (let index = 0; index < typed.length; index++) {
      await kit.xtest.type(typed[index])
      if (index < typed.length - 1) await kit.workbox.waitForTimeout(gap)
    }
  const last = typed.at(-1) as string
  let now = start
  let host = await readHost(ctx)
  let quietSince = Date.now()
  let settled = false
  for (const deadline = Date.now() + 15_000; Date.now() < deadline; ) {
    await kit.workbox.waitForTimeout(50)
    now = await page(kit)
    const next = await readHost(ctx)
    if (next.version !== host.version) quietSince = Date.now()
    host = next
    const lastKey = now.keys
      .slice(start.keys.length)
      .filter((key) => key.key === last)
      .at(-1)
    if (
      lastKey &&
      now.entries.some((entry) => entry.t > lastKey.t) &&
      !now.armed &&
      (host.text ?? '').includes(`${at}${typed}`) &&
      Date.now() - quietSince >= 400
    ) {
      settled = true
      break
    }
  }
  expect(settled, 'natural settle after typing').toBe(true)
  const keys = now.keys
    .slice(start.keys.length)
    .filter((key) => typed.includes(key.key))
  expect(keys.map((key) => key.key).join(''), 'typed keys delivered').toBe(
    typed,
  )
  const lastKeyAt = keys.at(-1)?.t ?? 0
  const boundary = now.entries
    .slice(start.entries.length)
    .filter(
      (entry) =>
        entry.after > entry.before &&
        entry.t > (keys[0]?.t ?? 0) &&
        entry.t < lastKeyAt,
    )
    .at(-1)
  const kept = boundary ? keys.filter((key) => key.t < boundary.t).length : 0
  return {
    page: now,
    host,
    kept,
    hostEventsBefore: hostStart.events.length,
    shape: {
      entries: now.depth - start.depth,
      keptByUndo: kept,
      hostWrites: host.events.length - hostStart.events.length,
      gapMs: keys.length > 1 ? lastKeyAt - (keys[0]?.t ?? 0) : null,
    },
  }
}

// One Ctrl+Z or Ctrl+Y: delivery, convergence, exact texts, dirty, the route of the host changes
// and a negative-observation window. The native route: every host change of the press came from
// native history. The resync route (the step limit): exactly `resync.undo`/`resync.redo` native
// Undo/Redo changes (the refused walk and its rollback), then at least one plain write.
async function historyStep(
  ctx: Ctx,
  kind: 'undo' | 'redo',
  expected: State & { disk: string; resync?: { undo: number; redo: number } },
) {
  const { kit } = ctx
  const before = await page(kit)
  const hostBefore = await readHost(ctx)
  const pressAt = Date.now()
  await kit.xtest.key(kind === 'undo' ? 'ctrl+z' : 'ctrl+y')
  await expect
    .poll(async () => (await page(kit)).engine, {
      timeout: 5000,
      message: `${kind} reached the engine`,
    })
    .toBe(before.engine + 1)
  // Converged: no host version change for 400 ms (and, on the resync route, a plain write seen).
  let host = await readHost(ctx)
  let since = Date.now()
  const plainSeen = () =>
    host.events
      .slice(hostBefore.events.length)
      .some((event) => event.reason === 0)
  for (const deadline = Date.now() + 15_000; Date.now() < deadline; ) {
    await kit.workbox.waitForTimeout(50)
    const now = await readHost(ctx)
    if (now.version !== host.version) since = Date.now()
    host = now
    if (Date.now() - since >= 400 && (!expected.resync || plainSeen())) break
  }
  const view = await page(kit)
  await kit.workbox.waitForTimeout(STABLE_MS)
  const hostEnd = await readHost(ctx)
  const viewEnd = await page(kit)
  const events = hostEnd.events.slice(hostBefore.events.length)
  const count = (reason: number) =>
    events.filter((event) => event.reason === reason).length
  const reasons = {
    undo: count(REASON.undo),
    redo: count(REASON.redo),
    plain: count(0),
  }
  const observed = {
    host: lengths(host.text, expected.host),
    view: lengths(view.value, expected.view),
    dirty: host.dirty,
    disk: readFileSync(ctx.file, 'utf8') === expected.disk,
    route: expected.resync
      ? {
          undo: reasons.undo,
          redo: reasons.redo,
          plainLast: reasons.plain > 0 && events.at(-1)?.reason === 0,
        }
      : events.every((event) => event.reason === REASON[kind]),
    nativeSteps: events.length,
    msToConverge: since - pressAt,
    stable:
      hostEnd.version === host.version &&
      hostEnd.text === host.text &&
      viewEnd.value === view.value,
  }
  expect(observed, `${ctx.file} ${kind}`).toEqual({
    host: true,
    view: true,
    dirty: expected.dirty,
    disk: true,
    route: expected.resync ? { ...expected.resync, plainLast: true } : true,
    nativeSteps: observed.nativeSteps,
    msToConverge: observed.msToConverge,
    stable: true,
  })
  // The 400 ms quiet window can only end before the walk does if a pause between two native steps
  // of the press reaches it: report the longest such pause, and the pause from the last native step
  // to the first plain write (the resync route).
  const native = events.filter((event) => event.reason !== 0)
  const walkMaxGapMs = native
    .slice(1)
    .reduce((max, event, index) => Math.max(max, event.t - native[index].t), 0)
  const firstPlain = events.find((event) => event.reason === 0)
  const lastNative = native.at(-1)
  return {
    nativeSteps: observed.nativeSteps,
    ms: observed.msToConverge,
    walkMaxGapMs,
    nativeToPlainMs:
      firstPlain && lastNative ? firstPlain.t - lastNative.t : null,
    reasons,
  }
}

// Saves, closes and reopens the document; disk, host and the reopened view must hold `state`.
async function saveAndReopen(ctx: Ctx, state: State) {
  const { kit } = ctx
  await kit.host(async (vscode) => {
    await vscode.commands.executeCommand('workbench.action.files.save')
  }, [])
  await kit.workbox.waitForTimeout(2500)
  const saved = await hostState(ctx)
  const disk = readFileSync(ctx.file, 'utf8')
  await closeAll(kit, ctx.file)
  await openEditor(ctx)
  const reopened = await evalFrame(
    kit,
    () => (window as any).vditor.getValue() as string,
    0,
  )
  const observed = {
    disk: lengths(disk, state.host),
    host: lengths(saved.text, state.host),
    dirty: saved.dirty,
    reopenedView: lengths(reopened, state.view),
    reopenedDisk: readFileSync(ctx.file, 'utf8') === state.host,
  }
  expect(observed, 'Save and reopen').toEqual({
    disk: true,
    host: true,
    dirty: false,
    reopenedView: true,
    reopenedDisk: true,
  })
  return observed
}

// VMDE's Undo/Redo kept VS Code's history: a text editor on the same document undoes the host
// writes one stop at a time back to the saved bytes (clean), and redoes them to the typed text.
async function nativeHistory(ctx: Ctx, base: string, top: string) {
  const native = await ctx.kit.host(
    async (vscode, [fsPath, baseText, topText]: [string, string, string]) => {
      const document = vscode.workspace.textDocuments.find(
        (candidate) => candidate.uri.fsPath === fsPath,
      )
      if (!document) return null
      await vscode.window.showTextDocument(document, {
        viewColumn: vscode.ViewColumn.Beside,
        preserveFocus: false,
        preview: false,
      })
      const step = async (command: string) => {
        await vscode.commands.executeCommand(command)
        await new Promise((resolve) => setTimeout(resolve, 150))
        return document.getText()
      }
      let undos = 0
      let atBase = false
      while (undos < 16 && !atBase) {
        const text = await step('undo')
        undos++
        atBase = text === baseText
      }
      const cleanAtBase = atBase && !document.isDirty
      let redos = 0
      let atTop = false
      while (redos < undos && !atTop) {
        atTop = (await step('redo')) === topText
        redos++
      }
      return { undos, atBase, cleanAtBase, redos, atTop }
    },
    [ctx.file, base, top],
  )
  expect(native, 'native text-editor history').toMatchObject({
    atBase: true,
    cleanAtBase: true,
    atTop: true,
  })
  expect(native?.redos).toBe(native?.undos)
  return native
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one sequential journey per document; each phase depends on the one before
async function journey(kit: Kit, j: Journey) {
  const content = j.large
    ? j.crlf
      ? crlf(LARGE)
      : LARGE
    : j.crlf
      ? crlf(DOC)
      : DOC
  const anchor = j.large ? LARGE_ANCHOR : ANCHOR
  const typed = j.typed ?? 'XQ'
  const ins = (text: string, insert: string) =>
    text.replace(anchor, `${anchor}${insert}`)
  const { ctx, R0 } = await openRecorded(
    kit,
    `coupling-${j.mode}-${j.name}.md`,
    content,
    j.mode,
    anchor,
  )
  const result: Record<string, unknown> = { id: `${j.mode}:${j.name}` }
  const disk = content
  try {
    if (!j.large) {
      const lf = content.replace(/\r\n/g, '\n')
      if (j.mode === 'sv')
        // SV's rendering carries its trailing editable newline span; compare in SV form.
        expect(svTrim(R0), 'the small fixture round-trips in SV form').toBe(
          svTrim(lf),
        )
      else expect(R0, 'the small fixture round-trips').toBe(lf)
    }
    // The state an Undo of the measured keys returns to when they form one entry.
    let base: State = { host: content, view: R0, dirty: false }
    let prefix = ''
    if (j.prime) {
      const primed = await typeAndSettle(ctx, anchor, j.prime, 0)
      const view = ins(R0, j.prime)
      expect(lengths(primed.page.value, view), 'primed view').toBe(true)
      const host = j.large
        ? (primed.host.text as string)
        : ins(content, j.prime)
      expect(lengths(primed.host.text, host), 'primed host').toBe(true)
      base = { host, view, dirty: true }
      prefix = j.prime
      result.primed = { undoDelay: primed.page.undoDelay, ...primed.shape }
    }

    // --- Type ---
    const typing = await typeAndSettle(ctx, `${anchor}${prefix}`, typed, j.gap)
    const kept = typing.kept
    const viewTyped = ins(R0, prefix + typed)
    expect(
      lengths(typing.page.value, viewTyped),
      'one intended insertion',
    ).toBe(true)
    // The large fixture publishes Vditor's normalized serialization: the Redo target is the text
    // the host held before Undo, after proving it carries exactly the typed insertion.
    const hostTyped = j.large
      ? (typing.host.text as string)
      : ins(content, prefix + typed)
    expect(
      lengths(typing.host.text, hostTyped),
      'host published the typing',
    ).toBe(true)
    const typedState: State = { host: hostTyped, view: viewTyped, dirty: true }
    result.shape = typing.shape
    // Undo returns to the state of Vditor's last entry before the last key: the base, or (at a
    // long gap) the text with the keys typed before that entry.
    let target = base
    if (kept) {
      const partial = `${anchor}${prefix}${typed.slice(0, kept)}`
      // The large fixture's partial host text is the last one that held exactly those keys.
      const host = j.large
        ? (await hostTexts(ctx, typing.hostEventsBefore))
            .filter(
              (text) =>
                text.includes(partial) &&
                !text.includes(`${anchor}${prefix}${typed}`),
            )
            .at(-1)
        : ins(content, prefix + typed.slice(0, kept))
      expect(host, 'the partial host state was published').toBeDefined()
      target = {
        host: host as string,
        view: ins(R0, prefix + typed.slice(0, kept)),
        dirty: true,
      }
    }

    if (j.chain) {
      const second = await typeAndSettle(
        ctx,
        `${anchor}${prefix}${typed}`,
        j.chain,
        j.gap,
      )
      result.chain = second.shape
      expect(second.kept, 'the second entry is one entry').toBe(0)
      const top: State = {
        host: j.large
          ? (second.host.text as string)
          : ins(content, prefix + typed + j.chain),
        view: ins(R0, prefix + typed + j.chain),
        dirty: true,
      }
      expect(lengths(second.page.value, top.view), 'second insertion').toBe(
        true,
      )
      expect(lengths(second.host.text, top.host), 'second published').toBe(true)
      result.steps = [
        await historyStep(ctx, 'undo', { ...typedState, disk }),
        await historyStep(ctx, 'undo', { ...target, disk }),
        await historyStep(ctx, 'redo', { ...typedState, disk }),
        await historyStep(ctx, 'redo', { ...top, disk }),
      ]
      return result
    }

    // --- Undo, then Redo ---
    result.undo = await historyStep(ctx, 'undo', { ...target, disk })
    if (j.after === 'save-reopen') {
      result.saveReopen = await saveAndReopen(ctx, target)
      return result
    }
    result.redo = await historyStep(ctx, 'redo', { ...typedState, disk })
    if (j.mode === 'sv')
      expect(svTrim(viewTyped), 'SV view equals the host text').toBe(
        svTrim(hostTyped.replace(/\r\n/g, '\n')),
      )
    else if (!j.large)
      expect(viewTyped, 'view equals the host text').toBe(
        hostTyped.replace(/\r\n/g, '\n'),
      )
    if (j.after === 'redo-save-reopen')
      result.saveReopen = await saveAndReopen(ctx, typedState)
    if (j.after === 'native-history')
      result.nativeHistory = await nativeHistory(ctx, content, hostTyped)
    return result
  } finally {
    await closeAll(kit, ctx.file).catch(() => undefined)
    await disposeHostRecorder(kit).catch(() => undefined)
  }
}

async function run(kit: Kit, journeys: Journey[]) {
  const results: Record<string, unknown>[] = []
  for (const j of journeys) {
    const result = await journey(kit, j)
    results.push(result)
    console.log(`[${LABEL}] ${JSON.stringify(result)}`)
  }
  return results
}

// At least one journey formed the defect's shape: one webview entry over two or more host writes.
const expectMultiWriteEntry = (results: Record<string, unknown>[]) =>
  expect(
    results.some((result) => {
      const shape = result.shape as { entries: number; hostWrites: number }
      return shape.entries === 1 && shape.hostWrites >= 2
    }),
    'one entry spanning several host writes formed at least once',
  ).toBe(true)

// Mode switch after edits: an IR entry over two writes, a switch to `target`, an entry there over
// two writes, Undo/Redo in `target` (its history starts at the switch), then back to IR: IR's own
// history (opened, IR typing, the switch back) is undone and redone across all four host writes.
async function modeSwitchJourney(kit: Kit, target: 'sv' | 'wysiwyg') {
  const { ctx, R0 } = await openRecorded(
    kit,
    `coupling-switch-${target}.md`,
    DOC,
    'ir',
    ANCHOR,
  )
  const result: Record<string, unknown> = { id: `switch:${target}` }
  try {
    const first = await typeAndSettle(ctx, ANCHOR, 'XQ', 400)
    const A: State = {
      host: DOC.replace(ANCHOR, `${ANCHOR}XQ`),
      view: R0.replace(ANCHOR, `${ANCHOR}XQ`),
      dirty: true,
    }
    expect(lengths(first.host.text, A.host), 'IR typing published').toBe(true)
    expect(first.kept, 'IR typing is one entry').toBe(0)
    const writesBefore = (await readHost(ctx)).events.length
    ctx.mode = target
    await switchMode(ctx, target)
    const switched = await readHost(ctx)
    expect(
      { text: switched.text === A.host, writes: switched.events.length },
      'the switch publishes nothing',
    ).toEqual({ text: true, writes: writesBefore })
    const RT = (await page(kit)).value
    await select(ctx, `${ANCHOR}XQ`, {
      collapsed: true,
      offset: ANCHOR.length + 2,
    })
    const second = await typeAndSettle(ctx, `${ANCHOR}XQ`, 'YZ', 400)
    expect(second.kept, `${target} typing is one entry`).toBe(0)
    const B: State = {
      host: DOC.replace(ANCHOR, `${ANCHOR}XQYZ`),
      view: RT.replace(`${ANCHOR}XQ`, `${ANCHOR}XQYZ`),
      dirty: true,
    }
    expect(
      lengths(second.host.text, B.host),
      `${target} typing published`,
    ).toBe(true)
    result.shapes = [first.shape, second.shape]
    const disk = DOC
    const steps = [
      await historyStep(ctx, 'undo', { ...A, view: RT, disk }),
      await historyStep(ctx, 'redo', { ...B, disk }),
    ]
    ctx.mode = 'ir'
    await switchMode(ctx, 'ir')
    const back = await page(kit)
    const viewB = R0.replace(ANCHOR, `${ANCHOR}XQYZ`)
    expect(lengths(back.value, viewB), 'IR shows the switched edits').toBe(true)
    await select(ctx, `${ANCHOR}XQYZ`, {
      collapsed: true,
      offset: ANCHOR.length + 4,
    })
    steps.push(
      await historyStep(ctx, 'undo', { ...A, disk }),
      await historyStep(ctx, 'undo', {
        host: DOC,
        view: R0,
        dirty: false,
        disk,
      }),
      await historyStep(ctx, 'redo', { ...A, disk }),
      await historyStep(ctx, 'redo', { ...B, view: viewB, disk }),
    )
    result.steps = steps
    return result
  } finally {
    await closeAll(kit, ctx.file).catch(() => undefined)
    await disposeHostRecorder(kit).catch(() => undefined)
  }
}

// An outside change between webview edits: IR typing (one entry, two writes), then a change VMDE
// did not make (a WorkspaceEdit, or an edit in a text editor on the same document) that the
// webview receives as an update (which clears Vditor's history), then typing again. Undo returns
// to the outside change and Redo restores the typing, through native history; a further Undo past
// the update has no webview entry left and changes nothing.
async function externalChangeJourney(
  kit: Kit,
  route: 'workspace-edit' | 'text-editor',
) {
  const { ctx, R0 } = await openRecorded(
    kit,
    `coupling-external-${route}.md`,
    DOC,
    'ir',
    ANCHOR,
  )
  const result: Record<string, unknown> = { id: `external:${route}` }
  try {
    const first = await typeAndSettle(ctx, ANCHOR, 'XQ', 400)
    expect(first.kept, 'first typing is one entry').toBe(0)
    const C: State = {
      host: DOC.replace(ANCHOR, `${ANCHOR}XQ`).replace('kilo', 'KILO'),
      view: R0.replace(ANCHOR, `${ANCHOR}XQ`).replace('kilo', 'KILO'),
      dirty: true,
    }
    const applied = await kit.host(
      async (vscode, [fsPath, how]: [string, string]) => {
        const document = vscode.workspace.textDocuments.find(
          (candidate) => candidate.uri.fsPath === fsPath,
        )
        if (!document) return false
        const offset = document.getText().indexOf('kilo')
        const range = new vscode.Range(
          document.positionAt(offset),
          document.positionAt(offset + 4),
        )
        if (how === 'workspace-edit') {
          const edit = new vscode.WorkspaceEdit()
          edit.replace(document.uri, range, 'KILO')
          return vscode.workspace.applyEdit(edit)
        }
        const editor = await vscode.window.showTextDocument(document, {
          viewColumn: vscode.ViewColumn.Beside,
          preserveFocus: false,
          preview: false,
        })
        const ok = await editor.edit((builder) =>
          builder.replace(range, 'KILO'),
        )
        // The text editor stays open beside: closing the tab of a dirty document reverted it to
        // the disk bytes (measured), which is not what an outside edit does. Only the focus returns.
        await vscode.commands.executeCommand(
          'vscode.openWith',
          document.uri,
          'vmde.editor',
          { viewColumn: vscode.ViewColumn.One, preserveFocus: false },
        )
        return ok
      },
      [ctx.file, route],
    )
    expect(applied, 'outside change applied').toBe(true)
    let received: unknown = false
    for (const deadline = Date.now() + 10_000; Date.now() < deadline; ) {
      received = lengths((await page(kit)).value, C.view)
      if (received === true) break
      await kit.workbox.waitForTimeout(100)
    }
    expect(
      received === true ||
        JSON.stringify({
          view: received,
          host: lengths((await readHost(ctx)).text, C.host),
        }),
      'the webview received the outside change',
    ).toBe(true)
    // The update's render and its first history entry settled: Vditor's history holds the entry,
    // no after-render callback is armed and the host holds the outside change.
    let updated = await readHost(ctx)
    let settled = await page(kit)
    for (const deadline = Date.now() + 10_000; Date.now() < deadline; ) {
      if (settled.depth >= 1 && !settled.armed && updated.text === C.host) break
      await kit.workbox.waitForTimeout(100)
      updated = await readHost(ctx)
      settled = await page(kit)
    }
    expect(
      {
        depth: settled.depth >= 1,
        armed: settled.armed,
        host: lengths(updated.text, C.host),
      },
      'the update settled and the host holds the outside change',
    ).toEqual({ depth: true, armed: false, host: true })
    await select(ctx, `${ANCHOR}XQ`, {
      collapsed: true,
      offset: ANCHOR.length + 2,
    })
    const second = await typeAndSettle(ctx, `${ANCHOR}XQ`, 'YZ', 400)
    expect(second.kept, 'second typing is one entry').toBe(0)
    const D: State = {
      host: C.host.replace(`${ANCHOR}XQ`, `${ANCHOR}XQYZ`),
      view: C.view.replace(`${ANCHOR}XQ`, `${ANCHOR}XQYZ`),
      dirty: true,
    }
    expect(lengths(second.host.text, D.host), 'second typing published').toBe(
      true,
    )
    result.shapes = [first.shape, second.shape]
    const disk = DOC
    result.steps = [
      await historyStep(ctx, 'undo', { ...C, disk }),
      await historyStep(ctx, 'redo', { ...D, disk }),
      await historyStep(ctx, 'undo', { ...C, disk }),
      // Vditor's history starts at the update: one more Undo has no entry and changes nothing.
      await historyStep(ctx, 'undo', { ...C, disk }),
    ]
    const end = await page(kit)
    result.bottom = { depth: end.depth, redo: end.redoDepth }
    return result
  } finally {
    await closeAll(kit, ctx.file).catch(() => undefined)
    await disposeHostRecorder(kit).catch(() => undefined)
  }
}

type PageRead = Awaited<ReturnType<typeof page>>
type HostRead = Awaited<ReturnType<typeof readHost>>

// Polls until `ready` holds for the page and host readings and the host stayed quiet for 400 ms.
// Returns the last readings and whether it settled within 15 s.
async function pollSettled(
  ctx: Ctx,
  start: PageRead,
  hostStart: HostRead,
  ready: (now: PageRead, host: HostRead) => boolean,
) {
  const { kit } = ctx
  let now = start
  let host = hostStart
  let quietSince = Date.now()
  for (const deadline = Date.now() + 15_000; Date.now() < deadline; ) {
    await kit.workbox.waitForTimeout(50)
    now = await page(kit)
    const next = await readHost(ctx)
    if (next.version !== host.version) quietSince = Date.now()
    host = next
    if (ready(now, host) && Date.now() - quietSince >= 400)
      return { now, host, settled: true }
  }
  return { now, host, settled: false }
}

// Checkpoint flush F at runtime. `X`, then Enter 100 ms later: Enter's undo boundary records the
// entry for the text with `X` while X's 250 ms edit post is still pending. F publishes it at that
// entry, so the host receives the `X` state as its own write before X's debounce could have fired
// (without F, Enter's input restarts the debounce and one later write carries both). The empty
// paragraph is a semantic no-op the host does not write, so Undo to the X state needs no native
// step, the next Undo reaches the opened bytes (clean) natively, and Redo ×2 returns.
async function flushJourney(kit: Kit) {
  const { ctx, R0 } = await openRecorded(
    kit,
    'coupling-flush.md',
    DOC,
    'ir',
    ANCHOR,
  )
  const result: Record<string, unknown> = { id: 'ir:flush-enter' }
  try {
    const start = await page(kit)
    const hostStart = await readHost(ctx)
    await kit.xtest.type('X')
    await kit.workbox.waitForTimeout(100)
    await kit.xtest.key('Return')
    const { now, host, settled } = await pollSettled(
      ctx,
      start,
      hostStart,
      (current, hostNow) => {
        const enter = current.keys
          .slice(start.keys.length)
          .find((key) => key.key === 'Enter')
        return (
          !!enter &&
          !current.armed &&
          hostNow.text !== DOC &&
          Date.now() - enter.t >= 1500
        )
      },
    )
    expect(
      settled ||
        JSON.stringify({
          armed: now.armed,
          host: lengths(host.text, now.value),
          entries: now.entries.slice(start.entries.length),
          keys: now.keys.slice(start.keys.length),
          events: host.events.slice(hostStart.events.length),
        }),
      'settled after X and Enter',
    ).toBe(true)
    const keys = now.keys.slice(start.keys.length)
    const xAt = keys.find((key) => key.key === 'X')?.t ?? 0
    const enterAt = keys.find((key) => key.key === 'Enter')?.t ?? 0
    const events = host.events.slice(hostStart.events.length)
    const texts = await hostTexts(ctx, hostStart.events.length)
    const withX = DOC.replace(ANCHOR, `${ANCHOR}X`)
    const xWrite = texts.indexOf(withX)
    // The webview recorder (page) and the host recorder (extension host) both stamp `Date.now()`:
    // the same system wall clock on this machine, so the two sets of timestamps are directly
    // comparable.
    const xWriteFromEnter = xWrite >= 0 ? events[xWrite].t - enterAt : null
    const facts = {
      enterWhileXPending: enterAt > xAt && enterAt - xAt < 230,
      xWriteSeen: xWrite >= 0,
      // With F the entry at Enter posts X at once. Without F, Enter's input restarts the 250 ms
      // debounce, so the first write that carries X comes at least 250 ms after Enter.
      xWriteAtEnter:
        xWriteFromEnter !== null &&
        xWriteFromEnter >= 0 &&
        xWriteFromEnter < 150,
      entriesAdded: now.depth - start.depth,
      hostAtX: host.text === withX,
    }
    result.facts = {
      ...facts,
      xToEnterMs: enterAt - xAt,
      xWriteFromEnterMs: xWriteFromEnter,
      hostWrites: events.length,
    }
    console.log(`[${LABEL}] ${JSON.stringify(result)}`)
    expect(facts, 'the entry at Enter published the pending X').toEqual({
      enterWhileXPending: true,
      xWriteSeen: true,
      xWriteAtEnter: true,
      entriesAdded: 2,
      hostAtX: true,
    })
    // The empty paragraph Enter adds is a semantic no-op the writeback does not write, so the host
    // stays at the X state while the editor shows the paragraph (both after Enter and after Redo).
    const top: State = { host: withX, view: now.value, dirty: true }
    const xState: State = {
      host: withX,
      view: R0.replace(ANCHOR, `${ANCHOR}X`),
      dirty: true,
    }
    const disk = DOC
    result.steps = [
      await historyStep(ctx, 'undo', { ...xState, disk }),
      await historyStep(ctx, 'undo', {
        host: DOC,
        view: R0,
        dirty: false,
        disk,
      }),
      await historyStep(ctx, 'redo', { ...xState, disk }),
      await historyStep(ctx, 'redo', { ...top, disk }),
    ]
    return result
  } finally {
    await closeAll(kit, ctx.file).catch(() => undefined)
    await disposeHostRecorder(kit).catch(() => undefined)
  }
}

// F correctness with natural timing and no product seam. `X`, Enter 100 ms later, `Y` 100 ms after
// Enter, at the end of the last paragraph. Vditor records three entries: the X state (Enter's
// boundary), the empty paragraph Enter adds, and the text with `Y`. Observed in real VS Code: Y
// lands after X in the same paragraph (the empty paragraph Enter adds has no line box), and an
// empty last paragraph does not serialize, so the host text and the view are `...lima.X` and
// `...lima.XY`. Edit-sync's 250 ms debounce would publish X only after Y had started: the host
// would never hold the X state, and one later write would carry `XY`. Checkpoint flush F publishes
// X at Enter's entry, so X gets its own host write. Undo from the `XY` state then reaches the X
// state through one native step (host and webview equal, dirty, no plain write). Without F that
// Undo cannot be proved: no host text for the X state exists, so the walk refuses, rolls back, and
// the webview's next plain edit resyncs the host (right text, native history rewritten); the
// route assertion (every host change of the press is a native Undo) and the single-step assertion
// then fail.
async function flushUndoJourney(kit: Kit) {
  const { ctx, R0 } = await openRecorded(
    kit,
    'coupling-flush-undo.md',
    DOC,
    'ir',
    LAST_ANCHOR,
  )
  const result: Record<string, unknown> = { id: 'ir:flush-undo-x-enter-y' }
  try {
    const start = await page(kit)
    const hostStart = await readHost(ctx)
    await kit.xtest.type('X')
    await kit.workbox.waitForTimeout(100)
    await kit.xtest.key('Return')
    await kit.workbox.waitForTimeout(100)
    await kit.xtest.type('Y')
    const withX = DOC.replace(LAST_ANCHOR, `${LAST_ANCHOR}X`)
    const withXY = DOC.replace(LAST_ANCHOR, `${LAST_ANCHOR}XY`)
    const viewX = R0.replace(LAST_ANCHOR, `${LAST_ANCHOR}X`)
    const viewXY = R0.replace(LAST_ANCHOR, `${LAST_ANCHOR}XY`)
    const { now, host, settled } = await pollSettled(
      ctx,
      start,
      hostStart,
      (current, hostNow) => {
        const yKey = current.keys
          .slice(start.keys.length)
          .find((key) => key.key === 'Y')
        return (
          !!yKey &&
          current.entries.some((entry) => entry.t > yKey.t) &&
          !current.armed &&
          hostNow.text === withXY
        )
      },
    )
    expect(
      settled ||
        JSON.stringify({
          armed: now.armed,
          host: lengths(host.text, withXY),
          view: lengths(now.value, viewXY),
          entries: now.entries.slice(start.entries.length),
          keys: now.keys.slice(start.keys.length),
        }),
      'settled after X, Enter and Y',
    ).toBe(true)
    const keys = now.keys.slice(start.keys.length)
    const enterAt = keys.find((key) => key.key === 'Enter')?.t ?? 0
    const events = host.events.slice(hostStart.events.length)
    const texts = await hostTexts(ctx, hostStart.events.length)
    const xWrite = texts.indexOf(withX)
    const facts = {
      xHadItsOwnHostWrite: xWrite >= 0,
      entriesAdded: now.depth - start.depth,
      view: lengths(now.value, viewXY),
      host: lengths(host.text, withXY),
    }
    result.facts = {
      ...facts,
      xWriteFromEnterMs: xWrite >= 0 ? events[xWrite].t - enterAt : null,
      hostWrites: texts.length,
    }
    console.log(`[${LABEL}] ${JSON.stringify(result)}`)
    expect(facts, 'X reached the host on its own').toEqual({
      xHadItsOwnHostWrite: true,
      entriesAdded: 3,
      view: true,
      host: true,
    })
    // The empty paragraph state and the X state show the same text, and the host holds the same
    // text for both: the second Undo and Redo change no host text.
    const xState: State = { host: withX, view: viewX, dirty: true }
    const disk = DOC
    const steps = [
      await historyStep(ctx, 'undo', { ...xState, disk }),
      await historyStep(ctx, 'undo', { ...xState, disk }),
      await historyStep(ctx, 'undo', {
        host: DOC,
        view: R0,
        dirty: false,
        disk,
      }),
      await historyStep(ctx, 'redo', { ...xState, disk }),
      await historyStep(ctx, 'redo', { ...xState, disk }),
      await historyStep(ctx, 'redo', {
        host: withXY,
        view: viewXY,
        dirty: true,
        disk,
      }),
    ]
    result.steps = steps
    // The Undo that needs F: exactly one native step and no other host change.
    expect(
      { nativeSteps: steps[0].nativeSteps, reasons: steps[0].reasons },
      'Undo to the X state is a single native step',
    ).toEqual({ nativeSteps: 1, reasons: { undo: 1, redo: 0, plain: 0 } })
    return result
  } finally {
    await closeAll(kit, ctx.file).catch(() => undefined)
    await disposeHostRecorder(kit).catch(() => undefined)
  }
}

// The 64-step limit: one entry over more than 64 host writes (90 keys 400 ms apart). Undo walks 64
// native steps without a proof, rolls the 64 back, and the webview's next plain edit resyncs the
// host: exact text, dirty at the saved bytes (the documented fallback). Redo has no native Redo
// left after that plain write and resyncs the same way. Save and reopen are exact.
async function stepLimitJourney(kit: Kit) {
  const { ctx, R0 } = await openRecorded(
    kit,
    'coupling-step-limit.md',
    DOC,
    'ir',
    ANCHOR,
  )
  const alphabet = 'abcdefghijklmnopqrstuvwxyz'
  const typed = `X${alphabet.repeat(3)}${alphabet.slice(0, 10)}Q`
  const result: Record<string, unknown> = { id: 'ir:step-limit-90x400' }
  try {
    const typing = await typeAndSettle(ctx, ANCHOR, typed, 400)
    result.shape = typing.shape
    console.log(`[${LABEL}] ${JSON.stringify(result)}`)
    expect(
      { entries: typing.shape.entries, kept: typing.kept },
      'one entry for the typing',
    ).toEqual({ entries: 1, kept: 0 })
    expect(
      typing.shape.hostWrites,
      'the entry spans more host writes than the step limit',
    ).toBeGreaterThan(MAX_NATIVE_STEPS)
    const typedState: State = {
      host: DOC.replace(ANCHOR, `${ANCHOR}${typed}`),
      view: R0.replace(ANCHOR, `${ANCHOR}${typed}`),
      dirty: true,
    }
    expect(lengths(typing.host.text, typedState.host), 'published').toBe(true)
    const disk = DOC
    result.undo = await historyStep(ctx, 'undo', {
      host: DOC,
      view: R0,
      dirty: true,
      disk,
      resync: { undo: MAX_NATIVE_STEPS, redo: MAX_NATIVE_STEPS },
    })
    result.redo = await historyStep(ctx, 'redo', {
      ...typedState,
      disk,
      resync: { undo: 0, redo: 0 },
    })
    result.saveReopen = await saveAndReopen(ctx, typedState)
    return result
  } finally {
    await closeAll(kit, ctx.file).catch(() => undefined)
    await disposeHostRecorder(kit).catch(() => undefined)
  }
}

test.describe('Task 602 Undo/Redo across host writes', () => {
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

  const setup = async (fixtures: {
    workbox: unknown
    electronApp: Parameters<typeof makeKit>[1]
    evaluateInVSCode: unknown
    baseDir: string
  }) => {
    const kit = await makeKit(
      fixtures.workbox,
      fixtures.electronApp,
      fixtures.evaluateInVSCode,
      fixtures.baseDir,
      LABEL,
    )
    await warmUp(kit)
    return kit
  }

  test('ir: gaps 50/300/600/1200, CRLF, Save and reopen, native history', async ({
    workbox,
    electronApp,
    evaluateInVSCode,
    baseDir,
  }) => {
    test.setTimeout(900_000)
    const kit = await setup({ workbox, electronApp, evaluateInVSCode, baseDir })
    const results = await run(kit, [
      { name: 'lf-50', mode: 'ir', gap: 50 },
      { name: 'lf-300', mode: 'ir', gap: 300 },
      { name: 'lf-600', mode: 'ir', gap: 600, after: 'native-history' },
      { name: 'lf-1200', mode: 'ir', gap: 1200 },
      { name: 'crlf-50', mode: 'ir', gap: 50, crlf: true },
      { name: 'crlf-300', mode: 'ir', gap: 300, crlf: true },
      { name: 'crlf-600', mode: 'ir', gap: 600, crlf: true },
      { name: 'crlf-1200', mode: 'ir', gap: 1200, crlf: true },
      { name: 'lf-600-save', mode: 'ir', gap: 600, after: 'save-reopen' },
      {
        name: 'crlf-600-redo-save',
        mode: 'ir',
        gap: 600,
        crlf: true,
        after: 'redo-save-reopen',
      },
    ])
    expectMultiWriteEntry(results)
  })

  test('sv: gaps 50/300/600/1200, CRLF, Save and reopen, native history', async ({
    workbox,
    electronApp,
    evaluateInVSCode,
    baseDir,
  }) => {
    test.setTimeout(900_000)
    const kit = await setup({ workbox, electronApp, evaluateInVSCode, baseDir })
    const results = await run(kit, [
      { name: 'lf-50', mode: 'sv', gap: 50 },
      { name: 'lf-300', mode: 'sv', gap: 300 },
      { name: 'lf-600', mode: 'sv', gap: 600, after: 'native-history' },
      { name: 'lf-1200', mode: 'sv', gap: 1200 },
      { name: 'crlf-50', mode: 'sv', gap: 50, crlf: true },
      { name: 'crlf-300', mode: 'sv', gap: 300, crlf: true },
      { name: 'crlf-600', mode: 'sv', gap: 600, crlf: true },
      { name: 'crlf-1200', mode: 'sv', gap: 1200, crlf: true },
      { name: 'lf-600-save', mode: 'sv', gap: 600, after: 'save-reopen' },
      {
        name: 'lf-600-redo-save',
        mode: 'sv',
        gap: 600,
        after: 'redo-save-reopen',
      },
    ])
    expectMultiWriteEntry(results)
  })

  test('wysiwyg: gaps 50/300/600/1200 and CRLF', async ({
    workbox,
    electronApp,
    evaluateInVSCode,
    baseDir,
  }) => {
    test.setTimeout(900_000)
    const kit = await setup({ workbox, electronApp, evaluateInVSCode, baseDir })
    await run(kit, [
      { name: 'lf-50', mode: 'wysiwyg', gap: 50 },
      { name: 'lf-300', mode: 'wysiwyg', gap: 300 },
      { name: 'lf-600', mode: 'wysiwyg', gap: 600 },
      { name: 'lf-1200', mode: 'wysiwyg', gap: 1200 },
      { name: 'crlf-50', mode: 'wysiwyg', gap: 50, crlf: true },
      { name: 'crlf-300', mode: 'wysiwyg', gap: 300, crlf: true },
      { name: 'crlf-600', mode: 'wysiwyg', gap: 600, crlf: true },
      { name: 'crlf-1200', mode: 'wysiwyg', gap: 1200, crlf: true },
      {
        name: 'lf-600-redo-save',
        mode: 'wysiwyg',
        gap: 600,
        after: 'redo-save-reopen',
      },
    ])
  })

  test('Redo chains: Undo ×2 then Redo ×2 in every mode', async ({
    workbox,
    electronApp,
    evaluateInVSCode,
    baseDir,
  }) => {
    test.setTimeout(900_000)
    const kit = await setup({ workbox, electronApp, evaluateInVSCode, baseDir })
    const results = await run(kit, [
      { name: 'chain-400', mode: 'ir', gap: 400, chain: 'YZ' },
      { name: 'chain-crlf-400', mode: 'ir', gap: 400, crlf: true, chain: 'YZ' },
      { name: 'chain-400', mode: 'sv', gap: 400, chain: 'YZ' },
      { name: 'chain-400', mode: 'wysiwyg', gap: 400, chain: 'YZ' },
      {
        name: 'large-chain-400',
        mode: 'ir',
        gap: 400,
        large: true,
        chain: 'YZ',
      },
    ])
    expectMultiWriteEntry(results)
  })

  test('large fixture: IR gaps 50/300/600/1200, LF and CRLF', async ({
    workbox,
    electronApp,
    evaluateInVSCode,
    baseDir,
  }) => {
    test.setTimeout(1_200_000)
    const kit = await setup({ workbox, electronApp, evaluateInVSCode, baseDir })
    const results = await run(
      kit,
      [50, 300, 600, 1200].flatMap((gap): Journey[] => [
        { name: `large-lf-${gap}`, mode: 'ir', gap, large: true },
        { name: `large-crlf-${gap}`, mode: 'ir', gap, large: true, crlf: true },
      ]),
    )
    expectMultiWriteEntry(results)
  })

  test('large fixture: WYSIWYG gaps, CRLF and the primed 2,000 ms delay', async ({
    workbox,
    electronApp,
    evaluateInVSCode,
    baseDir,
  }) => {
    test.setTimeout(1_500_000)
    const kit = await setup({ workbox, electronApp, evaluateInVSCode, baseDir })
    const journeys: Journey[] = [50, 300, 600, 1200].flatMap(
      (gap): Journey[] => [
        { name: `large-lf-${gap}`, mode: 'wysiwyg', gap, large: true },
        {
          name: `large-crlf-${gap}`,
          mode: 'wysiwyg',
          gap,
          large: true,
          crlf: true,
        },
      ],
    )
    const primed: Journey[] = [
      { name: 'large-lf-1200-primed', gap: 1200 },
      // 1,500 ms stays clearly inside the 2,000 ms undoDelay (the keys remain one entry).
      { name: 'large-lf-1500-primed', gap: 1500 },
      { name: 'large-crlf-1500-primed', gap: 1500, crlf: true },
    ].map(
      (cell): Journey => ({
        ...cell,
        mode: 'wysiwyg',
        large: true,
        prime: 'P',
      }),
    )
    const results = await run(kit, [...journeys, ...primed])
    for (const result of results.slice(journeys.length))
      expect(
        {
          undoDelay: (result.primed as { undoDelay: number }).undoDelay,
          entries: (result.shape as { entries: number }).entries,
        },
        `${result.id}: primed entries use the 2,000 ms delay`,
      ).toEqual({ undoDelay: 2000, entries: 1 })
  })

  test('large fixture: SV gaps 50/300/600/1200, LF and CRLF', async ({
    workbox,
    electronApp,
    evaluateInVSCode,
    baseDir,
  }) => {
    test.setTimeout(1_200_000)
    const kit = await setup({ workbox, electronApp, evaluateInVSCode, baseDir })
    await run(
      kit,
      [50, 300, 600, 1200].flatMap((gap): Journey[] => [
        { name: `large-lf-${gap}`, mode: 'sv', gap, large: true },
        { name: `large-crlf-${gap}`, mode: 'sv', gap, large: true, crlf: true },
      ]),
    )
  })

  // The journeys below each open their own fresh document and close it in a `finally`, so the dirty
  // document, the rewritten native history and the mode one leaves behind never reach the next.
  // They share one VS Code boot. A failing journey is recorded and the rest still run.
  test('ir: twelve-key burst, step limit, mode switch, outside change and checkpoint flush', async ({
    workbox,
    electronApp,
    evaluateInVSCode,
    baseDir,
  }) => {
    test.setTimeout(1_800_000)
    const kit = await setup({ workbox, electronApp, evaluateInVSCode, baseDir })
    const failures: string[] = []
    const attempt = async <T>(name: string, body: () => Promise<T>) => {
      try {
        const result = await body()
        console.log(`[${LABEL}] ${name} ok`)
        return result
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.log(`[${LABEL}] ${name} FAILED: ${message}`)
        failures.push(`${name}: ${message}`)
        return undefined
      }
    }
    const shapes: Record<string, unknown>[] = []

    // A twelve-key IR entry within the step limit: 12 host writes, 12 native steps.
    await attempt('twelve-key burst', async () => {
      const results = await run(kit, [
        { name: 'burst-12x400', mode: 'ir', gap: 400, typed: 'XabcdefghijQ' },
      ])
      const shape = results[0].shape as { hostWrites: number }
      expect(
        shape.hostWrites,
        'the burst reached the host as several writes',
      ).toBeGreaterThanOrEqual(4)
    })

    await attempt('step limit', async () => {
      const result = await stepLimitJourney(kit)
      console.log(`[${LABEL}] ${JSON.stringify(result)}`)
    })

    for (const target of ['sv', 'wysiwyg'] as const)
      await attempt(`mode switch to ${target}`, async () => {
        const result = await modeSwitchJourney(kit, target)
        console.log(`[${LABEL}] ${JSON.stringify(result)}`)
        for (const shape of result.shapes as unknown[]) shapes.push({ shape })
      })

    for (const route of ['workspace-edit', 'text-editor'] as const)
      await attempt(`outside change by ${route}`, async () => {
        const result = await externalChangeJourney(kit, route)
        console.log(`[${LABEL}] ${JSON.stringify(result)}`)
        for (const shape of result.shapes as unknown[]) shapes.push({ shape })
      })

    await attempt(
      'mode switch and outside change formed multi-write entries',
      async () => expectMultiWriteEntry(shapes),
    )
    await attempt('checkpoint flush at Enter', async () =>
      console.log(`[${LABEL}] ${JSON.stringify(await flushJourney(kit))}`),
    )
    await attempt('checkpoint flush Undo', async () =>
      console.log(`[${LABEL}] ${JSON.stringify(await flushUndoJourney(kit))}`),
    )

    expect(failures, 'every special journey passed').toEqual([])
  })
})
