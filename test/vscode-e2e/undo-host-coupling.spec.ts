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
 * Variants save after Undo and reopen, or run native text-editor Undo/Redo on the same document to
 * show that VMDE kept its native history. The large fixture's host holds Vditor's normalized
 * serialization after typing (Task 597 ruling 6); its Undo must return to the exact original bytes
 * (Owner decision 2026-10-07) and its Redo to the published text.
 *
 * Read-only in-page wrappers record trusted keys, Vditor's recorded entries and engine calls; a host
 * listener records document versions, reasons and dirty states. They never change timers, history
 * or routing. Comparisons are booleans, labels and lengths, so fixture text stays out of the output.
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
} from './helpers/shortcut-xtest-kit'
import { waitForInitialUndoSnapshot } from './webview-helpers'

const LABEL = 'Task 602 coupling'
// Round-trips exactly through every mode's serializer (Task 598's DOC).
const DOC =
  '# Probe\n\nAlpha bravo charlie delta.\n\nEcho `foxtrot` golf hotel.\n\nIndia juliet kilo lima.\n'
const ANCHOR = 'delta.'
// Above the 1,500 ms floor and above the largest checkpoint delay (2,000 ms, large WYSIWYG) plus
// the 250 ms edit-sync debounce.
const STABLE_MS = 2600
// TextDocumentChangeReason: 1 = Undo, 2 = Redo.
const REASON = { undo: 1, redo: 2 } as const

interface Journey {
  name: string
  mode: Mode
  gap: number
  typed?: string
  crlf?: boolean
  large?: boolean
  after?: 'redo' | 'save-reopen' | 'native-history'
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
    // Task 601: an armed after-render callback means an entry is still pending.
    armed:
      !!pending?.options?.enableAddUndoStack && !!pending.options.enableInput,
    value: w.vditor.getValue() as string,
  }
}

// --- Host recorder ---

const installHostRecorder = (ctx: Ctx) =>
  ctx.kit.host(
    (vscode, [fsPath]: [string]) => {
      const g = globalThis as any
      g.__t602Host ??= {}
      g.__t602Subs ??= []
      const record = { events: [] as unknown[] }
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

const disposeHostRecorder = (kit: Kit) =>
  kit.host(() => {
    const g = globalThis as any
    for (const sub of g.__t602Subs ?? []) sub.dispose()
    g.__t602Subs = []
  }, [])

const lengths = (actual: string | null, expected: string) =>
  actual === expected ? true : difference(actual, expected)

const crlf = (text: string) =>
  text.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n')

// SV's editable DOM ends in one extra newline span; edit posts and the host omit it.
const svTrim = (text: string) =>
  text.replace(/​(?=\n*$)/gu, '').replace(/\n+$/, '')

async function warmUp(kit: Kit) {
  const ctx = await openDocument(kit, 'warm-up.md', DOC, 'ir')
  await waitForInitialUndoSnapshot(kit.frame())
  await select(ctx, ANCHOR, { collapsed: true, offset: ANCHOR.length })
  await kit.xtest.key('ctrl+z')
  await kit.workbox.waitForTimeout(1500)
  await closeAll(kit, ctx.file)
}

// One Ctrl+Z or Ctrl+Y: delivery, convergence, exact texts, dirty, native-only host changes and a
// negative-observation window.
async function historyStep(
  ctx: Ctx,
  kind: 'undo' | 'redo',
  expected: { host: string; view: string; dirty: boolean; disk: string },
) {
  const { kit } = ctx
  const before = await evalFrame(kit, readRecorder, 0)
  const hostBefore = await readHost(ctx)
  const pressAt = Date.now()
  await kit.xtest.key(kind === 'undo' ? 'ctrl+z' : 'ctrl+y')
  await expect
    .poll(async () => (await evalFrame(kit, readRecorder, 0)).engine, {
      timeout: 5000,
      message: `${kind} reached the engine`,
    })
    .toBe(before.engine + 1)
  // Converged: no host version change for 400 ms.
  let host = await readHost(ctx)
  let since = Date.now()
  for (const deadline = Date.now() + 8000; Date.now() < deadline; ) {
    await kit.workbox.waitForTimeout(50)
    const now = await readHost(ctx)
    if (now.version !== host.version) since = Date.now()
    host = now
    if (Date.now() - since >= 400) break
  }
  const page = await evalFrame(kit, readRecorder, 0)
  await kit.workbox.waitForTimeout(STABLE_MS)
  const hostEnd = await readHost(ctx)
  const pageEnd = await evalFrame(kit, readRecorder, 0)
  const events = hostEnd.events.slice(hostBefore.events.length)
  const observed = {
    host: lengths(host.text, expected.host),
    view: lengths(page.value, expected.view),
    dirty: host.dirty,
    disk: readFileSync(ctx.file, 'utf8') === expected.disk,
    nativeOnly: events.every((event) => event.reason === REASON[kind]),
    nativeSteps: events.length,
    msToConverge: since - pressAt,
    stable:
      hostEnd.version === host.version &&
      hostEnd.text === host.text &&
      pageEnd.value === page.value,
  }
  expect(observed, `${ctx.file} ${kind}`).toEqual({
    host: true,
    view: true,
    dirty: expected.dirty,
    disk: true,
    nativeOnly: true,
    nativeSteps: observed.nativeSteps,
    msToConverge: observed.msToConverge,
    stable: true,
  })
  return { nativeSteps: observed.nativeSteps, ms: observed.msToConverge }
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
  const ctx = await openDocument(
    kit,
    `coupling-${j.mode}-${j.name}.md`,
    content,
    j.mode,
  )
  const result: Record<string, unknown> = { id: `${j.mode}:${j.name}` }
  try {
    await installHostRecorder(ctx)
    await waitForInitialUndoSnapshot(kit.frame())
    expect(await evalFrame(kit, installRecorder, 0), 'recorder').toBe(true)
    await select(ctx, anchor, { collapsed: true, offset: anchor.length })
    const start = await evalFrame(kit, readRecorder, 0)
    const R0 = start.value
    expect(R0.split(anchor).length, 'anchor unique in the rendering').toBe(2)
    if (!j.large && j.mode !== 'sv')
      expect(R0, 'the small fixture round-trips').toBe(
        content.replace(/\r\n/g, '\n'),
      )

    // --- Type ---
    if (j.gap <= 100 && typed.length === 2) await kit.xtest.type(typed, j.gap)
    else
      for (let index = 0; index < typed.length; index++) {
        await kit.xtest.type(typed[index])
        if (index < typed.length - 1) await kit.workbox.waitForTimeout(j.gap)
      }
    // --- Natural settle: the last key's checkpoint ran, nothing is armed, the host published the
    // typed text and stayed quiet for 400 ms. ---
    const last = typed.at(-1) as string
    let page = start
    let host = await readHost(ctx)
    let quietSince = Date.now()
    let settled = false
    for (const deadline = Date.now() + 15_000; Date.now() < deadline; ) {
      await kit.workbox.waitForTimeout(50)
      page = await evalFrame(kit, readRecorder, 0)
      const now = await readHost(ctx)
      if (now.version !== host.version) quietSince = Date.now()
      host = now
      const lastKey = page.keys.filter((key) => key.key === last).at(-1)
      if (
        lastKey &&
        page.entries.some((entry) => entry.t > lastKey.t) &&
        !page.armed &&
        (host.text ?? '').includes(`${anchor}${typed}`) &&
        Date.now() - quietSince >= 400
      ) {
        settled = true
        break
      }
    }
    expect(settled, 'natural settle after typing').toBe(true)
    const keys = page.keys.filter((key) => typed.includes(key.key))
    expect(keys.map((key) => key.key).join(''), 'typed keys delivered').toBe(
      typed,
    )
    const view0 = R0
    const viewTyped = ins(R0, typed)
    expect(lengths(page.value, viewTyped), 'one intended insertion').toBe(true)
    const T0 = content
    // The large fixture publishes Vditor's normalized serialization: the Redo target is the text
    // the host held before Undo, after proving it carries exactly the typed insertion.
    const hostTyped = j.large ? (host.text as string) : ins(content, typed)
    expect(lengths(host.text, hostTyped), 'host published the typing').toBe(
      true,
    )
    // Undo returns to the state of Vditor's last entry before the last key: the opened text,
    // or (at a long gap) the text with the keys typed before that entry.
    const lastKeyAt = keys.at(-1)?.t ?? 0
    const boundary = page.entries
      .filter(
        (entry) =>
          entry.after > entry.before &&
          entry.t > (keys[0]?.t ?? 0) &&
          entry.t < lastKeyAt,
      )
      .at(-1)
    const kept = boundary ? keys.filter((key) => key.t < boundary.t).length : 0
    result.shape = {
      entries: page.depth - start.depth,
      keptByUndo: kept,
      hostWrites: host.events.length,
      gapMs: keys.length > 1 ? lastKeyAt - (keys[0]?.t ?? 0) : null,
    }
    // The large fixture's intermediate host text is a normalized serialization this spec does not
    // derive; its 600 ms journeys form one entry.
    if (j.large) expect(kept, 'large journey: one entry for the typing').toBe(0)

    // --- Undo, then Redo ---
    const undoHost = kept ? ins(content, typed.slice(0, kept)) : T0
    const undoView = kept ? ins(R0, typed.slice(0, kept)) : view0
    result.undo = await historyStep(ctx, 'undo', {
      host: undoHost,
      view: undoView,
      dirty: kept > 0,
      disk: T0,
    })
    if (j.after === 'save-reopen') {
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
        disk: lengths(disk, undoHost),
        host: lengths(saved.text, undoHost),
        dirty: saved.dirty,
        reopenedView: lengths(reopened, undoView),
        reopenedDisk: readFileSync(ctx.file, 'utf8') === undoHost,
      }
      expect(observed, 'Undo, Save, reopen').toEqual({
        disk: true,
        host: true,
        dirty: false,
        reopenedView: true,
        reopenedDisk: true,
      })
      result.saveReopen = observed
      return result
    }
    result.redo = await historyStep(ctx, 'redo', {
      host: hostTyped,
      view: viewTyped,
      dirty: true,
      disk: T0,
    })
    if (j.mode === 'sv')
      expect(svTrim(viewTyped), 'SV view equals the host text').toBe(
        svTrim(hostTyped.replace(/\r\n/g, '\n')),
      )
    else if (!j.large)
      expect(viewTyped, 'view equals the host text').toBe(
        hostTyped.replace(/\r\n/g, '\n'),
      )

    if (j.after === 'native-history') {
      // VMDE's Undo/Redo kept VS Code's history: a text editor on the same document undoes the
      // host writes one stop at a time back to the saved bytes (clean), and redoes them to the
      // typed text.
      const native = await kit.host(
        async (vscode, [fsPath, base, top]: [string, string, string]) => {
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
            atBase = text === base
          }
          const cleanAtBase = atBase && !document.isDirty
          let redos = 0
          let atTop = false
          while (redos < undos && !atTop) {
            atTop = (await step('redo')) === top
            redos++
          }
          return { undos, atBase, cleanAtBase, redos, atTop }
        },
        [ctx.file, T0, hostTyped],
      )
      expect(native, 'native text-editor history').toMatchObject({
        atBase: true,
        cleanAtBase: true,
        atTop: true,
      })
      expect(native?.redos).toBe(native?.undos)
      result.nativeHistory = native
    }
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
      { name: 'crlf-300', mode: 'ir', gap: 300, crlf: true },
      { name: 'crlf-600', mode: 'ir', gap: 600, crlf: true },
      { name: 'lf-600-save', mode: 'ir', gap: 600, after: 'save-reopen' },
    ])
    expectMultiWriteEntry(results)
  })

  test('ir: a twelve-key entry within the step limit', async ({
    workbox,
    electronApp,
    evaluateInVSCode,
    baseDir,
  }) => {
    test.setTimeout(600_000)
    const kit = await setup({ workbox, electronApp, evaluateInVSCode, baseDir })
    const results = await run(kit, [
      { name: 'burst-12x400', mode: 'ir', gap: 400, typed: 'XabcdefghijQ' },
    ])
    const shape = results[0].shape as { hostWrites: number }
    expect(
      shape.hostWrites,
      'the burst reached the host as several writes',
    ).toBeGreaterThanOrEqual(4)
  })

  test('sv: gaps 300/600, CRLF, Save and reopen, native history', async ({
    workbox,
    electronApp,
    evaluateInVSCode,
    baseDir,
  }) => {
    test.setTimeout(900_000)
    const kit = await setup({ workbox, electronApp, evaluateInVSCode, baseDir })
    const results = await run(kit, [
      { name: 'lf-300', mode: 'sv', gap: 300 },
      { name: 'lf-600', mode: 'sv', gap: 600, after: 'native-history' },
      { name: 'crlf-600', mode: 'sv', gap: 600, crlf: true },
      { name: 'lf-1200', mode: 'sv', gap: 1200 },
      { name: 'lf-600-save', mode: 'sv', gap: 600, after: 'save-reopen' },
    ])
    expectMultiWriteEntry(results)
  })

  test('wysiwyg: gaps 600/1200 and CRLF', async ({
    workbox,
    electronApp,
    evaluateInVSCode,
    baseDir,
  }) => {
    test.setTimeout(600_000)
    const kit = await setup({ workbox, electronApp, evaluateInVSCode, baseDir })
    await run(kit, [
      { name: 'lf-600', mode: 'wysiwyg', gap: 600 },
      { name: 'lf-1200', mode: 'wysiwyg', gap: 1200 },
      { name: 'crlf-600', mode: 'wysiwyg', gap: 600, crlf: true },
    ])
  })

  test('large fixture: IR LF and CRLF, WYSIWYG, SV', async ({
    workbox,
    electronApp,
    evaluateInVSCode,
    baseDir,
  }) => {
    test.setTimeout(1_200_000)
    const kit = await setup({ workbox, electronApp, evaluateInVSCode, baseDir })
    const results = await run(kit, [
      { name: 'large-lf-600', mode: 'ir', gap: 600, large: true },
      { name: 'large-crlf-600', mode: 'ir', gap: 600, large: true, crlf: true },
      { name: 'large-lf-600', mode: 'wysiwyg', gap: 600, large: true },
      { name: 'large-lf-600', mode: 'sv', gap: 600, large: true },
    ])
    expectMultiWriteEntry(results)
  })
})
