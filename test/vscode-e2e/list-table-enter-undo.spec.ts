/**
 * Task 628 — Enter (or a paste, or a toolbar Bold) followed by a key inside a list item or the last
 * table cell, then Undo twice and Redo twice, in real VS Code with OS-level (XTEST) keys.
 *
 * The contract (task record): after two Undos the host text equals the opened bytes and the document
 * is clean; two Redos return the host to the text the key left (text symmetry). Each boundary state
 * (Enter, paste, toolbar action) reaches the host at the boundary, so Enter and the next key are two
 * host writes even at a 100 ms gap, and each Undo is one native step, never a native Undo followed
 * by a native Redo (the pre-fix refusal and rollback).
 *
 * Two Undo cadences: "fast" presses the next Undo 500 ms after the host is quiet; "resynced" waits
 * at least 1.5 s and 700 ms of quiet, so any resync write has landed first.
 *
 * Needs the isolated Xvfb/Openbox XTEST session of docs/os-keyboard-testing-setup.md
 * (`VMDE_XTEST=1`). Records lengths and booleans only. One `test()` block: every state shares one
 * VS Code boot, and the cases run one after another on fresh documents.
 */
import { expect, test } from 'vscode-test-playwright'
import {
  type Ctx,
  closeAll,
  evalFrame,
  firstLine,
  type Kit,
  type Mode,
  makeKit,
  openDocument,
  select,
} from './helpers/shortcut-xtest-kit'
import { waitForInitialUndoSnapshot } from './webview-helpers'

const LABEL = 'Task 628 S3'
const PREFIX = '# Probe\n\nAlpha bravo charlie delta.\n\n'
const BLOCKS = {
  list: { text: '- echo\n- foxtrot', anchor: 'foxtrot' },
  table: {
    text: '| Echo | Golf |\n| --- | --- |\n| foxtrot | hotel |',
    anchor: 'hotel',
  },
  paragraph: { text: 'India juliet kilo lima.', anchor: 'lima.' },
  heading: { text: '## Echo foxtrot', anchor: 'foxtrot' },
  quote: { text: '> Echo foxtrot golf.', anchor: 'golf.' },
  code: { text: '```js\nconst echo = 1\n```', anchor: null },
} as const

type BlockKind = keyof typeof BLOCKS
type Action = 'enter' | 'paste' | 'bold'
type Cadence = 'fast' | 'resynced'

interface Case {
  id: string
  mode: Mode
  block: BlockKind
  action: Action
  gap: number
  cadence: Cadence
  /** Exact host writes from the action to the settled key (Enter cases); null = not asserted. */
  writes: number | null
  /** Each Undo is one native step (list and table cases: the entry states are host states). */
  oneStepUndo: boolean
}

type Row = Record<string, unknown>

// --- Page side ---

function installRecorder(_body: Element): boolean {
  const w = window as any
  const inner = w.vditor?.vditor
  if (!inner?.undo) return false
  if (w.__t628) return true
  const rec = { engineUndo: 0, engineRedo: 0 }
  w.__t628 = rec
  const undo = inner.undo
  const undoFn = undo.undo
  undo.undo = function (...args: unknown[]) {
    rec.engineUndo++
    return undoFn.apply(this, args)
  }
  const redoFn = undo.redo
  undo.redo = function (...args: unknown[]) {
    rec.engineRedo++
    return redoFn.apply(this, args)
  }
  return true
}

function readLive(_body: Element) {
  const w = window as any
  return {
    engineUndo: w.__t628.engineUndo as number,
    engineRedo: w.__t628.engineRedo as number,
    value: w.vditor.getValue() as string,
  }
}

const focusEnd = (_body: Element) => {
  const inner = (window as any).vditor.vditor
  ;(inner[inner.currentMode].element as HTMLElement).focus()
}

// --- Host side ---

interface HostEvent {
  t: number
  version: number
  reason: number
  dirty: boolean
  text: string
}

const installHost = (ctx: Ctx) =>
  ctx.kit.host(
    (vscode, [fsPath]: [string]) => {
      const g = globalThis as any
      g.__t628Host ??= {}
      g.__t628Subs ??= []
      const record = { events: [] as unknown[] }
      g.__t628Host[fsPath] = record
      g.__t628Subs.push(
        vscode.workspace.onDidChangeTextDocument((event) => {
          if (event.document.uri.fsPath !== fsPath) return
          if (!event.contentChanges.length) return
          record.events.push({
            t: Date.now(),
            version: event.document.version,
            reason: event.reason ?? 0,
            dirty: event.document.isDirty,
            text: event.document.getText(),
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
        events: (globalThis as any).__t628Host[fsPath].events as HostEvent[],
      }
    },
    [ctx.file],
  )

const disposeHost = (kit: Kit) =>
  kit.host(() => {
    const g = globalThis as any
    for (const sub of g.__t628Subs ?? []) sub.dispose()
    g.__t628Subs = []
    g.__t628Host = {}
  }, [])

// --- Driver ---

const wait = (kit: Kit, ms: number) => kit.workbox.waitForTimeout(ms)

// Waits until the host has been quiet for `quietMs` (and `minMs` has passed), capped at `capMs`.
async function quietHost(
  ctx: Ctx,
  minMs: number,
  capMs: number,
  quietMs: number,
) {
  const startedAt = Date.now()
  let host = await readHost(ctx)
  let quiet = Date.now()
  for (;;) {
    await wait(ctx.kit, 100)
    const next = await readHost(ctx)
    if (next.version !== host.version) quiet = Date.now()
    host = next
    const now = Date.now()
    if (now - startedAt >= minMs && now - quiet >= quietMs) return host
    if (now - startedAt >= capMs) return host
  }
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one sequential real-VS-Code case; each branch is one asserted fact
async function runCase(
  kit: Kit,
  c: Case,
): Promise<{ row: Row; failures: string[] }> {
  const row: Row = {
    id: c.id,
    mode: c.mode,
    block: c.block,
    action: c.action,
    gapMs: c.gap,
    cadence: c.cadence,
  }
  const failures: string[] = []
  const check = (ok: boolean, what: string) => {
    if (!ok) failures.push(`${c.id}: ${what}`)
  }
  let ctx: Ctx | undefined
  try {
    const block = BLOCKS[c.block]
    const content = `${PREFIX}${block.text}\n`
    ctx = await openDocument(kit, `m628-${c.id}.md`, content, c.mode)
    check(ctx.results[0].ok === true, 'exact open bytes, clean')
    await installHost(ctx)
    await waitForInitialUndoSnapshot(kit.frame())
    check((await evalFrame(kit, installRecorder, 0)) === true, 'recorder')
    if (block.anchor) {
      await select(ctx, block.anchor, {
        collapsed: true,
        offset: block.anchor.length,
      })
    } else {
      await evalFrame(kit, focusEnd, 0)
      await kit.xtest.key('ctrl+End')
    }
    await wait(kit, 300)

    const opened = await readHost(ctx)
    check(opened.text === content && opened.dirty === false, 'opened clean')
    const openedText = opened.text

    // --- the action, a gap, the key
    if (c.action === 'paste')
      await kit.host(async (vscode) => {
        await vscode.env.clipboard.writeText('pq')
      }, [])
    if (c.action === 'enter') await kit.xtest.key('Return')
    else if (c.action === 'paste') await kit.xtest.key('ctrl+v')
    else
      await kit
        .frame()
        .locator('.vditor-toolbar [data-type="bold"]')
        .click({ timeout: 5000 })
    await wait(kit, c.gap)
    await kit.xtest.type('Y')
    const settled = await quietHost(ctx, 1500, 8000, 700)
    const typedText = settled.text
    const typedWrites = settled.events.length - opened.events.length
    row.typedWrites = typedWrites
    row.typedLen = typedText?.length ?? null
    check(
      typedText !== openedText && !!typedText?.includes('Y'),
      'the key reached the host',
    )
    if (c.block === 'list' && c.action === 'enter')
      check(
        typedText === `${PREFIX}- echo\n- foxtrot\n- Y\n`,
        'Enter then Y makes a new list item holding Y',
      )
    if (c.writes !== null)
      check(
        typedWrites === c.writes,
        `host writes from Enter to the settled key: ${typedWrites}, expected ${c.writes}`,
      )

    let cursor = settled.events.length
    // biome-ignore-start lint/complexity/noExcessiveCognitiveComplexity: one OS key press with its waits and reads
    const press = async (
      kind: 'undo' | 'redo',
      n: number,
      settleMs: number,
    ) => {
      const before = await evalFrame(kit, readLive, 0)
      await kit.xtest.key(kind === 'undo' ? 'ctrl+z' : 'ctrl+y')
      for (const deadline = Date.now() + 3000; Date.now() < deadline; ) {
        await wait(kit, 100)
        const now = await evalFrame(kit, readLive, 0)
        if (
          kind === 'undo'
            ? now.engineUndo > before.engineUndo
            : now.engineRedo > before.engineRedo
        )
          break
      }
      const slow = c.cadence === 'resynced'
      await quietHost(ctx as Ctx, slow ? 1500 : 0, 8000, slow ? 700 : 500)
      if (settleMs) await wait(kit, settleMs)
      const host = await readHost(ctx as Ctx)
      const events = host.events.slice(cursor)
      cursor = host.events.length
      const native = (reason: number) =>
        events.filter((e) => e.reason === reason).length
      const out = {
        press: `${kind}${n}`,
        host,
        nativeUndo: native(1),
        nativeRedo: native(2),
        writes: events.length,
      }
      row[`${kind}${n}`] = {
        writes: out.writes,
        nativeUndo: out.nativeUndo,
        nativeRedo: out.nativeRedo,
        len: host.text?.length ?? null,
        eqOpened: host.text === openedText,
        eqTyped: host.text === typedText,
        dirty: host.dirty,
      }
      return out
    }
    // biome-ignore-end lint/complexity/noExcessiveCognitiveComplexity: one OS key press with its waits and reads

    const undo1 = await press('undo', 1, 0)
    if (c.oneStepUndo) {
      check(
        undo1.nativeUndo === 1 && undo1.nativeRedo === 0,
        `Undo 1 is one native step with no native Redo (undo ${undo1.nativeUndo}, redo ${undo1.nativeRedo})`,
      )
      check(
        undo1.host.text !== typedText && undo1.host.text !== openedText,
        'after Undo 1 the host holds the earlier entry state, not the typed text',
      )
    }
    const undo2 = await press('undo', 2, 3000)
    if (c.oneStepUndo)
      check(
        undo2.nativeUndo === 1 && undo2.nativeRedo === 0,
        `Undo 2 is one native step with no native Redo (undo ${undo2.nativeUndo}, redo ${undo2.nativeRedo})`,
      )
    check(
      undo2.host.text === openedText,
      'after two Undos the host equals the opened bytes',
    )
    check(undo2.host.dirty === false, 'after two Undos the document is clean')
    await press('redo', 1, 0)
    const redo2 = await press('redo', 2, 1500)
    check(
      redo2.host.text === typedText,
      'after two Redos the host equals the typed text',
    )
  } catch (error) {
    failures.push(`${c.id}: ${firstLine(error)}`)
  } finally {
    if (ctx) {
      await closeAll(kit, ctx.file).catch(() => undefined)
      await disposeHost(kit).catch(() => undefined)
    }
  }
  console.log(`[${LABEL}] ${JSON.stringify({ ...row, failures })}`)
  return { row, failures }
}

const enter = (
  mode: Mode,
  block: BlockKind,
  gap: number,
  cadence: Cadence,
  writes: number | null,
  oneStepUndo: boolean,
): Case => ({
  id: `${mode}-${block}-enter-${gap}-${cadence}`,
  mode,
  block,
  action: 'enter',
  gap,
  cadence,
  writes,
  oneStepUndo,
})

function buildCases(): Case[] {
  const cases: Case[] = []
  // Acceptance 2-3: list item and table last cell, both editable modes, both gaps, both cadences.
  // Enter and the key are two host writes (the Enter state is published at the boundary).
  for (const mode of ['ir', 'wysiwyg'] as const)
    for (const block of ['list', 'table'] as const)
      for (const gap of [100, 1000])
        for (const cadence of ['fast', 'resynced'] as const)
          cases.push(enter(mode, block, gap, cadence, 2, true))
  // Acceptance 4: the SV list (one assertion set).
  cases.push(enter('sv', 'list', 100, 'fast', 2, true))
  // Acceptance 5: controls. The Enter states of a paragraph, a heading and a blockquote (its empty
  // quote line) serialize differently from, or like, the opened text but render like it, so the
  // boundary publishes nothing and only the key writes the host (one write); the code case
  // records its write count and asserts only the undo contract.
  for (const mode of ['ir', 'wysiwyg'] as const) {
    cases.push(enter(mode, 'paragraph', 100, 'fast', 1, false))
    cases.push(enter(mode, 'heading', 100, 'fast', 1, false))
    cases.push(enter(mode, 'quote', 100, 'fast', 1, false))
    cases.push(enter(mode, 'code', 100, 'fast', null, false))
  }
  // Paste and toolbar Bold followed by a key within 250 ms, in a list item.
  for (const mode of ['ir', 'wysiwyg'] as const)
    for (const action of ['paste', 'bold'] as const)
      cases.push({
        id: `${mode}-list-${action}-100-fast`,
        mode,
        block: 'list',
        action,
        gap: 100,
        cadence: 'fast',
        writes: null,
        oneStepUndo: false,
      })
  return cases
}

test.describe('Task 628 Enter + key + Undo/Redo in lists and tables', () => {
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

  test('two Undos return the host to the opened bytes, clean; two Redos return the typed text', async ({
    workbox,
    electronApp,
    evaluateInVSCode,
    baseDir,
  }) => {
    test.setTimeout(3_300_000)
    const kit = await makeKit(
      workbox,
      electronApp,
      evaluateInVSCode,
      baseDir,
      LABEL,
    )
    // First open of a session is slower; measure none of it.
    const warm = await openDocument(
      kit,
      'warm-628.md',
      `${PREFIX}${BLOCKS.list.text}\n`,
      'ir',
    )
    await waitForInitialUndoSnapshot(kit.frame())
    await closeAll(kit, warm.file)

    const cases = buildCases()
    const failures: string[] = []
    const rows: Row[] = []
    for (const c of cases) {
      const result = await runCase(kit, c)
      rows.push(result.row)
      failures.push(...result.failures)
    }
    await test.info().attach('rows.json', {
      body: JSON.stringify(rows, null, 1),
      contentType: 'application/json',
    })
    expect(failures).toEqual([])
  })
})
