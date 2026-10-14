/**
 * Task 607 S1 — real-VS-Code reproductions of "actions after a trusted edit".
 *
 * Contract under test (Task 607, Owner decision D1): after a trusted edit (OS-level typing or a
 * paste) the host text is the reference. A following Turn Into, Find Replace, table action or Move
 * Block must change only the action's own span of that reference; every byte outside the span stays
 * as the host held it, host, disk and native Undo/Redo agree, and Move Block moves after an edit and
 * its Undo while a genuine host/webview mismatch still answers `stale`.
 *
 * Each cell asserts the contract, so a cell FAILS while the defect reproduces. Every key is
 * OS-level XTEST input into the verified, focused VS Code window (docs/os-keyboard-testing-setup.md);
 * the setup (opening files, placing carets, commands, the Turn Into QuickPick) uses the shared kit.
 *
 * Privacy: the evidence is lengths, short hashes and changed intervals only. No document text is
 * printed or written, and a failed assertion names the violated contract line, not the content.
 */
import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import {
  AFTER_SAVE_MS,
  type Ctx,
  closeAll,
  disposeObservers,
  endSelectionGesture,
  evalFrame,
  firstLine,
  hostState,
  hostText,
  makeKit,
  openDocument,
  QUIET_MS,
  recover,
  SMALL as ROUND_TRIP,
  select,
  UNDO_LOCK_MS,
} from './helpers/shortcut-xtest-kit'

type Mode = 'ir' | 'wysiwyg'
const MODES: Mode[] = ['ir', 'wysiwyg']

const NORMALIZING = readFileSync(
  path.join(__dirname, 'fixtures', 'exact-actions-normalizing.md'),
  'utf8',
)
const EVIDENCE_DIR = path.resolve(__dirname, '../../tmp/607')

// ---------------------------------------------------------------------------------------------
// Privacy-safe measurement helpers (lengths, hashes and intervals only).

const sha = (text: string | null) =>
  text === null
    ? null
    : createHash('sha256').update(text).digest('hex').slice(0, 12)
const fingerprint = (text: string | null) =>
  text === null ? null : { length: text.length, sha: sha(text) }

// The smallest interval of `before` that was replaced to get `after`.
function changedInterval(before: string, after: string) {
  let head = 0
  while (
    head < before.length &&
    head < after.length &&
    before[head] === after[head]
  )
    head++
  let tail = 0
  while (
    tail < before.length - head &&
    tail < after.length - head &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  )
    tail++
  return {
    start: head,
    beforeEnd: before.length - tail,
    afterEnd: after.length - tail,
  }
}

interface Span {
  start: number
  end: number
}

// Whether any byte of `reference` outside `span` is different in `after`.
function outsideSpanChanged(reference: string, after: string, span: Span) {
  const head = reference.slice(0, span.start)
  const tail = reference.slice(span.end)
  return !(
    after.length >= head.length + tail.length &&
    after.startsWith(head) &&
    after.endsWith(tail)
  )
}

const lineSpan = (text: string, needle: string): Span => {
  const at = text.indexOf(needle)
  expect(at, 'span anchor exists exactly once').toBeGreaterThanOrEqual(0)
  expect(text.lastIndexOf(needle)).toBe(at)
  const start = text.lastIndexOf('\n', at) + 1
  const end = text.indexOf('\n', at)
  return { start, end: end < 0 ? text.length : end }
}

// The table's lines in `text`: from its first to its last pipe line.
function tableSpan(text: string): Span {
  const lines = text.split('\n')
  const first = lines.findIndex((line) => line.startsWith('|'))
  let last = first
  while (lines[last + 1]?.startsWith('|')) last++
  const start = lines.slice(0, first).join('\n').length + (first > 0 ? 1 : 0)
  const end = lines.slice(0, last + 1).join('\n').length
  return { start, end }
}
const pipeLines = (text: string) =>
  text.split('\n').filter((line) => line.startsWith('|')).length

// ---------------------------------------------------------------------------------------------
// Cells: a cell records its evidence and its contract violations instead of stopping the test.

type Check = (condition: boolean, violation: string) => void

async function cell(
  ctx: Ctx,
  id: string,
  body: (check: Check) => Promise<Record<string, unknown>>,
) {
  const result: Record<string, unknown> = { id: `${ctx.mode}:${id}` }
  const violations: string[] = []
  const check: Check = (condition, violation) => {
    if (!condition) violations.push(violation)
  }
  try {
    Object.assign(result, await body(check))
  } catch (error) {
    result.measurementError = firstLine(error).slice(0, 300)
    violations.push('the cell could not complete its measurement')
  }
  result.violations = violations
  result.ok = violations.length === 0
  try {
    // Every cell starts from the opened bytes.
    result.reopened = await recover(ctx, true)
  } catch (error) {
    result.recoveryError = firstLine(error).slice(0, 300)
  }
  ctx.results.push(result)
  const line = JSON.stringify(result)
  console.log('[607 S1]', line)
  mkdirSync(EVIDENCE_DIR, { recursive: true })
  appendFileSync(path.join(EVIDENCE_DIR, `s1-${ctx.mode}.jsonl`), `${line}\n`)
}

function finish(label: string, results: Record<string, unknown>[]) {
  const failed = results.filter((result) => result.ok !== true)
  console.log(
    `[607 S1 ${label}] cells=${results.length} failed=${failed.length}`,
    JSON.stringify(failed.map((result) => [result.id, result.violations])),
  )
  expect(
    failed.map((result) => ({ id: result.id, violations: result.violations })),
    `${label}: cells that violate the contract`,
  ).toEqual([])
}

// ---------------------------------------------------------------------------------------------
// Webview trace: host→webview and webview→host messages, kept in page memory only.

function installTraceInPage() {
  const page = window as any
  if (page.__t607) return
  const trace = {
    inbound: [] as any[],
    outbound: [] as any[],
    send: null as any,
  }
  page.__t607 = trace
  window.addEventListener('message', (event) => {
    const data = event.data
    if (data && typeof data.command === 'string')
      trace.inbound.push({
        command: data.command,
        status: data.status,
        requestId: data.requestId,
        content: typeof data.content === 'string' ? data.content : undefined,
      })
  })
  // The platform handle is frozen, but senders read the `vscode` global at call time, so a
  // forwarding wrapper records what the webview posts without changing it.
  const original = page.vscode
  trace.send = (message: unknown) => original.postMessage(message)
  page.vscode = {
    postMessage(message: any) {
      trace.outbound.push({
        command: message?.command,
        exact: message?.exact,
        requestId: message?.requestId,
        before:
          typeof message?.before === 'string' ? message.before : undefined,
        content:
          typeof message?.content === 'string' ? message.content : undefined,
        raw: message?.command === 'request-block-action' ? message : undefined,
      })
      return original.postMessage(message)
    },
    getState: () => original.getState(),
    setState: (state: unknown) => original.setState(state),
  }
}

async function installTrace(ctx: Ctx) {
  await evalFrame(ctx.kit, installTraceInPage, 0)
}

const traceMark = (ctx: Ctx) =>
  evalFrame(
    ctx.kit,
    () => {
      const trace = (window as any).__t607
      return { inbound: trace.inbound.length, outbound: trace.outbound.length }
    },
    0,
  )

async function traceSince(
  ctx: Ctx,
  mark: { inbound: number; outbound: number },
) {
  const raw = await evalFrame(
    ctx.kit,
    (_body, from: { inbound: number; outbound: number }) => {
      const trace = (window as any).__t607
      return {
        inbound: trace.inbound.slice(from.inbound).map((m: any) => ({
          command: m.command,
          status: m.status,
          requestId: m.requestId,
          content: m.content,
        })),
        outbound: trace.outbound.slice(from.outbound).map((m: any) => ({
          command: m.command,
          exact: m.exact,
          requestId: m.requestId,
          before: m.before,
          content: m.content,
        })),
      }
    },
    mark,
  )
  return {
    // Host→webview messages that matter to the actions; the rest are counted by name only.
    outcomes: raw.inbound
      .filter((m) => m.command === 'block-action-outcome')
      .map((m) => ({
        status: m.status,
        hostAtDecision: fingerprint(m.content ?? null),
      })),
    inboundCommands: raw.inbound.map((m) => m.command),
    requests: raw.outbound
      .filter((m) => m.command === 'request-block-action')
      .map((m) => ({ before: fingerprint(m.before ?? null) })),
    edits: raw.outbound
      .filter((m) => m.command === 'edit')
      .map((m) => ({
        exact: m.exact === true,
        content: fingerprint(m.content ?? null),
      })),
    // Raw strings stay in memory for comparisons; they are never printed.
    rawBefore: raw.outbound
      .filter((m) => m.command === 'request-block-action')
      .map((m) => m.before as string),
    rawHostAtDecision: raw.inbound
      .filter((m) => m.command === 'block-action-outcome')
      .map((m) => m.content as string | undefined),
  }
}

// ---------------------------------------------------------------------------------------------
// Steps.

const hostBecomes = (
  ctx: Ctx,
  predicate: (text: string) => boolean,
  timeout = 15_000,
) =>
  expect
    .poll(async () => predicate((await hostText(ctx)) ?? ''), { timeout })
    .toBe(true)
    .then(
      () => true,
      () => false,
    )

// A trusted edit in the paragraph before the normalizing table, by OS typing or an OS paste.
async function trustedEdit(ctx: Ctx, kind: 'type' | 'paste') {
  const { kit } = ctx
  const typed = kind === 'type' ? 'x' : 'pq'
  if (kind === 'paste')
    await kit.host(
      async (vscode, [text]: [string]) => {
        await vscode.env.clipboard.writeText(text)
      },
      [typed],
    )
  await select(ctx, 'editword', { collapsed: true, offset: 2 })
  await endSelectionGesture(ctx)
  if (kind === 'type') await kit.xtest.type(typed, 20)
  else await kit.xtest.key('ctrl+v')
  const changed = await hostBecomes(ctx, (text) => text !== ctx.initial)
  // Vditor's Undo debounce (800 ms): the edit is its own native Undo step before the action.
  await kit.workbox.waitForTimeout(UNDO_LOCK_MS)
  const reference = (await hostText(ctx)) ?? ''
  const at = ctx.initial.indexOf('editword') + 2
  return {
    reference,
    changed,
    insertOnly:
      reference === ctx.initial.slice(0, at) + typed + ctx.initial.slice(at),
  }
}

async function runTurnInto(ctx: Ctx) {
  const { kit } = ctx
  await select(ctx, 'turnword', { collapsed: true, offset: 2 })
  await endSelectionGesture(ctx)
  const picker = kit.workbox.locator('.quick-input-widget input').first()
  // The command resolves with the QuickPick, so it is started and awaited after the choice.
  const command = kit.host(async (vscode) => {
    await vscode.commands.executeCommand('vmde.turnInto')
  }, [])
  await picker.waitFor({ state: 'visible', timeout: 10_000 })
  await picker.focus()
  await expect(picker).toBeFocused()
  await kit.xtest.key('ctrl+a')
  await kit.xtest.type('Heading 2', 20)
  await expect
    .poll(async () => (await picker.inputValue()) === 'Heading 2')
    .toBe(true)
  await kit.xtest.key('Return')
  await picker.waitFor({ state: 'hidden', timeout: 10_000 })
  await command
}

async function runFindReplace(ctx: Ctx) {
  const { kit } = ctx
  const widget = kit.frame().locator('.vmde-find-replace')
  const findInput = widget.locator('[data-find]')
  const replaceInput = widget.locator('[data-replace]')
  await select(ctx, 'findword', { collapsed: true, offset: 2 })
  await endSelectionGesture(ctx)
  await kit.xtest.key('ctrl+f')
  await expect(widget).toBeVisible({ timeout: 10_000 })
  await expect(findInput).toBeFocused()
  await kit.xtest.key('ctrl+a')
  await kit.xtest.type('findword', 20)
  await expect(findInput).toHaveValue('findword')
  await kit.xtest.key('ctrl+h')
  await expect(replaceInput).toBeFocused()
  await kit.xtest.key('ctrl+a')
  await kit.xtest.type('zzword', 20)
  await expect(replaceInput).toHaveValue('zzword')
  await expect(widget.locator('[data-status]')).toHaveText('1 of 1')
  await kit.xtest.key('ctrl+shift+1')
}

async function closeFind(ctx: Ctx) {
  const widget = ctx.kit.frame().locator('.vmde-find-replace')
  if (!(await widget.isVisible())) return
  await ctx.kit.xtest.key('Escape')
  await expect(widget).toBeHidden()
}

async function runTableAction(ctx: Ctx) {
  const { kit } = ctx
  await select(ctx, 'cellone', { collapsed: true, offset: 3 })
  await endSelectionGesture(ctx)
  // A cell click's caret and Vditor's pending render settle first (as the table specs do).
  await kit.workbox.waitForTimeout(800)
  await kit.host(async (vscode) => {
    await vscode.commands.executeCommand('vmde.table.insertRowBelow')
  }, [])
}

type ActionName = 'turn-into' | 'find-replace' | 'table-insert-row'

// The action's span in the reference and the exact result the contract allows, where one exists.
function intended(action: ActionName, reference: string) {
  if (action === 'turn-into') {
    const span = lineSpan(reference, 'turnword')
    return {
      span,
      expected: `${reference.slice(0, span.start)}## ${reference.slice(span.start)}`,
    }
  }
  if (action === 'find-replace') {
    const at = reference.indexOf('findword')
    expect(reference.lastIndexOf('findword')).toBe(at)
    return {
      span: { start: at, end: at + 'findword'.length },
      expected:
        reference.slice(0, at) +
        'zzword' +
        reference.slice(at + 'findword'.length),
    }
  }
  return { span: tableSpan(reference), expected: null as string | null }
}

const ACTIONS: Record<ActionName, (ctx: Ctx) => Promise<void>> = {
  'turn-into': runTurnInto,
  'find-replace': runFindReplace,
  'table-insert-row': runTableAction,
}

// Trusted edit, then one action, then Save, then native Undo and Redo.
async function actionAfterEdit(
  ctx: Ctx,
  check: Check,
  edit: 'type' | 'paste',
  action: ActionName,
) {
  const { kit } = ctx
  await installTrace(ctx)
  const rendered = await evalFrame(
    kit,
    () => (window as any).vditor.getValue() as string,
    0,
  )
  // Positive control: the document really normalizes, so the defect has bytes to leak.
  const normalizes = rendered !== ctx.initial
  check(
    normalizes,
    'fixture does not normalize in this mode (instrument invalid)',
  )

  const trusted = await trustedEdit(ctx, edit)
  check(
    trusted.changed,
    'the trusted edit never reached the host (instrument invalid)',
  )
  const reference = trusted.reference
  const { span, expected } = intended(action, reference)
  const mark = await traceMark(ctx)

  await ACTIONS[action](ctx)
  const appliedExpectation =
    action === 'table-insert-row'
      ? (text: string) => pipeLines(text) === pipeLines(reference) + 1
      : (text: string) => text !== reference
  const applied = await hostBecomes(ctx, appliedExpectation, 20_000)
  if (action === 'find-replace') await closeFind(ctx)
  await kit.workbox.waitForTimeout(QUIET_MS)
  const afterAction = (await hostText(ctx)) ?? ''
  const afterTrace = await traceSince(ctx, mark)
  check(applied, 'the action did not change the host (instrument invalid)')

  const outside = outsideSpanChanged(reference, afterAction, span)
  check(!outside, 'bytes outside the action span changed')
  if (expected !== null)
    check(
      afterAction === expected,
      'host differs from the intended exact result',
    )
  else
    check(
      pipeLines(afterAction) === pipeLines(reference) + 1,
      'the table did not gain exactly one row',
    )

  // Save: disk and host agree on the action result.
  await kit.xtest.key('ctrl+s')
  await kit.workbox.waitForTimeout(AFTER_SAVE_MS)
  const saved = await hostState(ctx)
  const disk = readFileSync(ctx.file, 'utf8')
  check(
    disk === afterAction,
    'disk after Save differs from the host after the action',
  )
  check(saved.text === afterAction, 'Save changed the host text')

  // Native Undo then Redo (one XTEST key each).
  await kit.xtest.key('ctrl+z')
  await kit.workbox.waitForTimeout(QUIET_MS)
  const afterUndo = (await hostText(ctx)) ?? ''
  await kit.xtest.key('ctrl+y')
  await kit.workbox.waitForTimeout(QUIET_MS)
  const afterRedo = (await hostText(ctx)) ?? ''
  check(
    afterUndo === reference,
    'one Undo does not restore the host text from before the action',
  )
  check(afterRedo === afterAction, 'Redo does not restore the action result')
  const webviewExact = await evalFrame(
    kit,
    () => (window as any).__vmdeE2EExactMarkdown?.() as string | undefined,
    0,
  )
  // Recorded, not asserted: the webview's own exact source is internal state; the contract is
  // about the host, the disk and Undo/Redo.

  return {
    edit: {
      kind: edit,
      initial: fingerprint(ctx.initial),
      reference: fingerprint(reference),
      insertOnly: trusted.insertOnly,
      referenceChangedBytesVsInitial: changedInterval(ctx.initial, reference),
    },
    fixtureNormalizes: normalizes,
    action: {
      name: action,
      intendedSpan: span,
      hostAfter: fingerprint(afterAction),
      interval: changedInterval(reference, afterAction),
      outsideSpanChanged: outside,
      equalsIntendedResult: expected === null ? null : afterAction === expected,
      lengthDelta: afterAction.length - reference.length,
      pipeLinesBefore: pipeLines(reference),
      pipeLinesAfter: pipeLines(afterAction),
      posted: afterTrace.edits,
    },
    disk: { ...fingerprint(disk), equalsHost: disk === afterAction },
    undo: {
      host: fingerprint(afterUndo),
      equalsReference: afterUndo === reference,
      equalsInitial: afterUndo === ctx.initial,
    },
    redo: {
      host: fingerprint(afterRedo),
      equalsActionResult: afterRedo === afterAction,
    },
    webview: {
      exact: fingerprint(webviewExact ?? null),
      equalsHost: webviewExact === afterRedo,
      intervalVsHost: changedInterval(afterRedo, webviewExact ?? ''),
    },
  }
}

// ---------------------------------------------------------------------------------------------
// Move Block.

// Down from `moveword paragraph` and Up from `after paragraph` swap the same two adjacent
// paragraphs, so both directions have one intended result.
const SWAP_FROM = 'moveword paragraph\n\nafter paragraph'
const SWAP_TO = 'after paragraph\n\nmoveword paragraph'
const CARET_TOKEN = { Down: 'moveword paragraph', Up: 'after paragraph' }

function movedText(reference: string) {
  expect(reference.split(SWAP_FROM).length - 1, 'move anchor is unique').toBe(1)
  return reference.replace(SWAP_FROM, SWAP_TO)
}

type MovePrelude = 'fresh' | 'type' | 'paste' | 'bold-undo'

// Prepares the Move Block reference: the host text the move must start from.
async function movePrelude(ctx: Ctx, check: Check, prelude: MovePrelude) {
  const { kit } = ctx
  if (prelude === 'fresh') return { reference: ctx.initial, prepared: true }
  if (prelude === 'bold-undo') {
    // Task 622's leg: Ctrl+I on italicword, 1.2 s, Ctrl+Z (the host is back to the exact source).
    await select(ctx, 'italicword')
    await endSelectionGesture(ctx)
    await kit.xtest.key('ctrl+i')
    const italic = await hostBecomes(ctx, (text) =>
      text.includes('*italicword*'),
    )
    check(italic, 'Ctrl+I never reached the host (instrument invalid)')
    await kit.workbox.waitForTimeout(UNDO_LOCK_MS)
    await kit.xtest.key('ctrl+z')
    const restored = await hostBecomes(ctx, (text) => text === ctx.initial)
    check(restored, 'Undo did not restore the exact source (precondition)')
    await kit.workbox.waitForTimeout(QUIET_MS)
    return {
      reference: (await hostText(ctx)) ?? '',
      prepared: italic && restored,
    }
  }
  const typed = prelude === 'type' ? 'x' : 'pq'
  if (prelude === 'paste')
    await kit.host(
      async (vscode, [text]: [string]) => {
        await vscode.env.clipboard.writeText(text)
      },
      [typed],
    )
  await select(ctx, 'boldword', { collapsed: true, offset: 2 })
  await endSelectionGesture(ctx)
  if (prelude === 'type') await kit.xtest.type(typed, 20)
  else await kit.xtest.key('ctrl+v')
  const changed = await hostBecomes(ctx, (text) => text !== ctx.initial)
  check(changed, 'the trusted edit never reached the host (instrument invalid)')
  await kit.workbox.waitForTimeout(UNDO_LOCK_MS)
  return { reference: (await hostText(ctx)) ?? '', prepared: changed }
}

async function moveBlockCell(
  ctx: Ctx,
  check: Check,
  prelude: MovePrelude,
  direction: 'Down' | 'Up',
) {
  const { kit } = ctx
  await installTrace(ctx)
  const prepared = await movePrelude(ctx, check, prelude)
  const reference = prepared.reference
  const expected = movedText(reference)
  await select(ctx, CARET_TOKEN[direction], { collapsed: true, offset: 2 })
  await endSelectionGesture(ctx)
  const before = await hostState(ctx)
  const mark = await traceMark(ctx)
  await kit.xtest.key(`alt+${direction}`)
  const moved = await hostBecomes(ctx, (text) => text === expected, 6_000)
  await kit.workbox.waitForTimeout(QUIET_MS)
  const after = await hostState(ctx)
  const trace = await traceSince(ctx, mark)
  const status = trace.outcomes.at(-1)?.status ?? 'none'
  check(moved, 'Move Block did not produce the intended exact result')
  check(status === 'applied', `Move Block outcome is ${status}, not applied`)

  // Stale diagnosis: the webview's `before` against the host text at the decision.
  const staleDiagnosis = trace.rawBefore.map((webviewBefore, index) => {
    const hostAtDecision = trace.rawHostAtDecision[index]
    return {
      webviewBefore: fingerprint(webviewBefore),
      hostAtDecision: fingerprint(hostAtDecision ?? null),
      equal:
        hostAtDecision === undefined ? null : webviewBefore === hostAtDecision,
      webviewBeforeEqualsReference: webviewBefore === reference,
      webviewBeforeVsReference: changedInterval(reference, webviewBefore),
    }
  })

  // One native Undo restores the host text from before the move. A move that never happened has
  // nothing to undo (a key here would undo the earlier edit), so Undo and Redo run only after one.
  let undone: Awaited<ReturnType<typeof hostState>> | null = null
  let redone: Awaited<ReturnType<typeof hostState>> | null = null
  if (moved) {
    await kit.workbox.waitForTimeout(UNDO_LOCK_MS)
    await kit.xtest.key('ctrl+z')
    await kit.workbox.waitForTimeout(QUIET_MS)
    undone = await hostState(ctx)
    check(
      undone.text === reference,
      'one Undo does not restore the host text from before the move',
    )
    await kit.xtest.key('ctrl+y')
    await kit.workbox.waitForTimeout(QUIET_MS)
    redone = await hostState(ctx)
    check(redone.text === expected, 'Redo does not restore the moved text')
  }
  return {
    prelude,
    direction,
    reference: fingerprint(reference),
    referenceIsInitial: reference === ctx.initial,
    hostBeforeMove: { ...fingerprint(before.text), dirty: before.dirty },
    hostAfterMove: { ...fingerprint(after.text), dirty: after.dirty },
    interval: changedInterval(reference, after.text ?? ''),
    equalsIntended: after.text === expected,
    outcomes: trace.outcomes,
    inboundCommands: trace.inboundCommands,
    requests: trace.requests,
    staleDiagnosis,
    undo: undone && {
      ...fingerprint(undone.text),
      equalsReference: undone.text === reference,
      dirty: undone.dirty,
    },
    redo: redone && {
      ...fingerprint(redone.text),
      equalsMoved: redone.text === expected,
    },
  }
}

// Measurement only (no contract): Up from `moveword paragraph`, whose previous block is a list.
async function moveUpOverListCell(ctx: Ctx) {
  const { kit } = ctx
  await installTrace(ctx)
  await select(ctx, 'moveword', { collapsed: true, offset: 2 })
  await endSelectionGesture(ctx)
  const mark = await traceMark(ctx)
  await kit.xtest.key('alt+Up')
  await kit.workbox.waitForTimeout(QUIET_MS)
  const trace = await traceSince(ctx, mark)
  const state = await hostState(ctx)
  return {
    measurementOnly: true,
    outcomes: trace.outcomes,
    inboundCommands: trace.inboundCommands,
    requests: trace.requests,
    hostUnchanged: state.text === ctx.initial,
  }
}

// A genuine mismatch (the posted `before` is not the host text) must stay `stale` and change nothing.
async function realMismatchCell(ctx: Ctx, check: Check) {
  const { kit } = ctx
  await installTrace(ctx)
  await select(ctx, 'moveword', { collapsed: true, offset: 2 })
  await endSelectionGesture(ctx)
  const first = await traceMark(ctx)
  await kit.xtest.key('alt+Down')
  const moved = await hostBecomes(ctx, (text) => text !== ctx.initial, 6_000)
  check(moved, 'the fresh move never reached the host (instrument invalid)')
  await kit.workbox.waitForTimeout(UNDO_LOCK_MS)
  await kit.xtest.key('ctrl+z')
  const restored = await hostBecomes(ctx, (text) => text === ctx.initial)
  check(restored, 'Undo did not restore the exact source (precondition)')
  await kit.workbox.waitForTimeout(QUIET_MS)
  const captured = await traceSince(ctx, first)
  check(
    captured.requests.length === 1,
    'the real move request was not captured (instrument invalid)',
  )
  const mark = await traceMark(ctx)
  // Replays the captured valid request with a `before` that differs from the host text.
  const replayed = await evalFrame(
    kit,
    () => {
      const trace = (window as any).__t607
      const request = trace.outbound.find(
        (m: any) => m.command === 'request-block-action',
      )
      if (!request) return false
      trace.send({
        ...request.raw,
        requestId: 'replay-607',
        before: `${request.raw.before} `,
      })
      return true
    },
    0,
  )
  check(replayed, 'no request to replay (instrument invalid)')
  await expect
    .poll(async () => (await traceSince(ctx, mark)).outcomes.length, {
      timeout: 6_000,
    })
    .toBeGreaterThan(0)
  await kit.workbox.waitForTimeout(QUIET_MS)
  const trace = await traceSince(ctx, mark)
  const hostAfter = await hostState(ctx)
  check(
    trace.outcomes.at(-1)?.status === 'stale',
    'a real mismatch did not answer stale',
  )
  check(hostAfter.text === ctx.initial, 'a stale answer changed the host text')
  return {
    outcomes: trace.outcomes,
    inboundCommands: trace.inboundCommands,
    hostAfter: fingerprint(hostAfter.text),
    hostUnchanged: hostAfter.text === ctx.initial,
  }
}

// ---------------------------------------------------------------------------------------------

test.describe('Task 607 S1 actions after a trusted edit (OS-level XTEST, contract cells)', () => {
  test.skip(
    process.env.VMDE_XTEST !== '1',
    'requires isolated Xvfb/Openbox XTEST',
  )

  for (const mode of MODES) {
    test(`${mode}: Turn Into, Find Replace and a table action after a typed or pasted edit change only their span`, async ({
      workbox,
      electronApp,
      evaluateInVSCode,
      baseDir,
    }) => {
      test.setTimeout(1_200_000)
      const kit = await makeKit(
        workbox,
        electronApp,
        evaluateInVSCode,
        baseDir,
        '607-s1',
      )
      const ctx = await openDocument(
        kit,
        `exact-actions-${mode}.md`,
        NORMALIZING,
        mode,
      )
      try {
        for (const edit of ['type', 'paste'] as const)
          for (const action of [
            'turn-into',
            'find-replace',
            'table-insert-row',
          ] as const)
            await cell(ctx, `${edit}+${action}`, (check) =>
              actionAfterEdit(ctx, check, edit, action),
            )
      } finally {
        await disposeObservers(kit)
        await closeAll(kit, ctx.file)
      }
      finish(`${mode} normalizing`, ctx.results)
    })

    test(`${mode}: Move Block Down and Up move after an edit and its Undo, fresh moves are unchanged, a real mismatch stays stale`, async ({
      workbox,
      electronApp,
      evaluateInVSCode,
      baseDir,
    }) => {
      test.setTimeout(1_200_000)
      const kit = await makeKit(
        workbox,
        electronApp,
        evaluateInVSCode,
        baseDir,
        '607-s1',
      )
      const ctx = await openDocument(
        kit,
        `exact-move-${mode}.md`,
        ROUND_TRIP,
        mode,
      )
      try {
        for (const prelude of ['fresh', 'bold-undo', 'type', 'paste'] as const)
          for (const direction of ['Down', 'Up'] as const)
            await cell(
              ctx,
              `move-${direction.toLowerCase()}-${prelude}`,
              (check) => moveBlockCell(ctx, check, prelude, direction),
            )
        await cell(ctx, 'move-up-over-list-fresh-measurement', () =>
          moveUpOverListCell(ctx),
        )
        await cell(ctx, 'move-real-mismatch-stale', (check) =>
          realMismatchCell(ctx, check),
        )
      } finally {
        await disposeObservers(kit)
        await closeAll(kit, ctx.file)
      }
      finish(`${mode} move block`, ctx.results)
    })
  }
})
