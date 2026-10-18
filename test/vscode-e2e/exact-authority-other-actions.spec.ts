/**
 * Task 630 S3 — real-VS-Code specs of the other exact-authority actions after a typed edit.
 *
 * Contract under test (Task 630, on Task 607's mechanism): every action that posts exact bytes
 * acquires the host's exact text first (publishing pending typing), plans on it and posts with
 * `before` equal to it. After OS-level typing, each action therefore changes only its own span of
 * the host text, a single native Undo restores the typed state, Save writes the action result, and
 * a host text that moved on without the webview is never overwritten.
 *
 * Actions: Details toggle, Insert Picture, Insert ID (named anchor), emoji insertion, selection
 * bubble link (applies on a non-normalizing document, the folded missing-`before` cause; declines
 * without writing on a normalizing one), link popover Edit and Unlink, and both outline
 * section-move routes (the webview outline panel drag and the native outline tree drop). A stale-host cell checks that an edit the webview
 * never saw is not overwritten.
 *
 * Each cell records its evidence and its contract violations instead of stopping the test. Every key
 * is OS-level XTEST input into the focused VS Code window (docs/os-keyboard-testing-setup.md).
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
  type Mode,
  makeKit,
  openDocument,
  QUIET_MS,
  recover,
  select,
  UNDO_LOCK_MS,
} from './helpers/shortcut-xtest-kit'
import { clickToolbarControl } from './webview-helpers'

const fixture = (name: string) =>
  readFileSync(path.join(__dirname, 'fixtures', name), 'utf8')
const NORMALIZING = fixture('exact-authority-actions.md')
const PLAIN = fixture('exact-authority-plain.md')

// How long the host text is polled for the state a native Undo or Redo key leads to.
const UNDO_SETTLE_MS = 6_000
const EVIDENCE_DIR = path.resolve(__dirname, '../../tmp/630')

const PICTURE =
  '<picture><source media="(prefers-color-scheme: dark)" srcset="dark.png"><img src="light.png" alt="Pic"></picture>'
const ANCHOR_NAME = 'authority-anchor'
const NEW_URL = 'https://changed.example/path'
const EXTERNAL_MARK = '<!-- external -->\n'

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

function uniqueIndex(text: string, needle: string) {
  const at = text.indexOf(needle)
  expect(at, 'span anchor exists').toBeGreaterThanOrEqual(0)
  expect(text.lastIndexOf(needle), 'span anchor is unique').toBe(at)
  return at
}

const tokenSpan = (text: string, needle: string): Span => {
  const start = uniqueIndex(text, needle)
  return { start, end: start + needle.length }
}
const pointSpan = (text: string, needle: string): Span => {
  const end = uniqueIndex(text, needle) + needle.length
  return { start: end, end }
}
const insertAfter = (text: string, needle: string, insert: string) => {
  const at = pointSpan(text, needle).start
  return text.slice(0, at) + insert + text.slice(at)
}
const replaceToken = (text: string, needle: string, replacement: string) => {
  const span = tokenSpan(text, needle)
  return text.slice(0, span.start) + replacement + text.slice(span.end)
}

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
  console.log('[630 S3]', line)
  mkdirSync(EVIDENCE_DIR, { recursive: true })
  appendFileSync(path.join(EVIDENCE_DIR, `s3-${ctx.mode}.jsonl`), `${line}\n`)
}

function finish(label: string, results: Record<string, unknown>[]) {
  const failed = results.filter((result) => result.ok !== true)
  console.log(
    `[630 S3 ${label}] cells=${results.length} failed=${failed.length}`,
    JSON.stringify(failed.map((result) => [result.id, result.violations])),
  )
  expect(
    failed.map((result) => ({ id: result.id, violations: result.violations })),
    `${label}: cells that violate the contract`,
  ).toEqual([])
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

// One typed character in the paragraph before the table: an editor input (a trusted `input`).
async function typeCharacter(ctx: Ctx) {
  const { kit } = ctx
  await select(ctx, 'editword', { collapsed: true, offset: 2 })
  await endSelectionGesture(ctx)
  await kit.xtest.type('x', 20)
  const changed = await hostBecomes(ctx, (text) => text !== ctx.initial)
  // Vditor's Undo debounce (800 ms): the edit is its own native Undo step before the action.
  await kit.workbox.waitForTimeout(UNDO_LOCK_MS)
  const reference = (await hostText(ctx)) ?? ''
  const at = ctx.initial.indexOf('editword') + 2
  return {
    reference,
    changed,
    insertOnly:
      reference === `${ctx.initial.slice(0, at)}x${ctx.initial.slice(at)}`,
  }
}

// Mirrors the selection into Vditor's saved range, as the toolbar specs do before a toolbar click.
const syncVditorRange = (ctx: Ctx) =>
  evalFrame(
    ctx.kit,
    (_body, mode: Mode) => {
      const selection = getSelection()
      if (selection?.rangeCount)
        (window as any).vditor.vditor[mode].range = selection
          .getRangeAt(0)
          .cloneRange()
    },
    ctx.mode,
  )

async function placeCaret(ctx: Ctx, token: string, offset: number) {
  await select(ctx, token, { collapsed: true, offset })
  await endSelectionGesture(ctx)
  await syncVditorRange(ctx)
}

const focusEditor = (ctx: Ctx) =>
  ctx.kit
    .frame()
    .locator(`.vditor-${ctx.mode}`)
    .first()
    .click({ position: { x: 4, y: 4 } })

// ---------------------------------------------------------------------------------------------
// Action drivers: each runs the action and returns anything the expectation needs.

const DETAILS_PARAGRAPH = 'detailsword paragraph for the wrapper'

async function selectDetailsParagraph(ctx: Ctx) {
  await select(ctx, DETAILS_PARAGRAPH)
  await endSelectionGesture(ctx)
  await expect(
    ctx.kit.frame().locator('.vditor-toolbar [data-type="details"]').first(),
  ).toBeEnabled()
}

async function runDetails(ctx: Ctx) {
  await selectDetailsParagraph(ctx)
  await clickToolbarControl(ctx.kit.frame(), 'details')
  return {}
}

async function runPicture(ctx: Ctx) {
  const frame = ctx.kit.frame()
  await placeCaret(ctx, 'pictureword', 'pictureword '.length)
  await clickToolbarControl(frame, 'insert-picture')
  const dialog = frame.locator('[data-vmde-picture-dialog]')
  await dialog.locator('input[name="fallback"]').fill('light.png')
  await dialog.locator('input[name="alt"]').fill('Pic')
  await dialog.locator('input[name="dark"]').fill('dark.png')
  await dialog.locator('button[type="submit"]').click()
  return {}
}

async function runAnchor(ctx: Ctx) {
  const frame = ctx.kit.frame()
  await placeCaret(ctx, 'anchorword', 'anchorword '.length)
  await clickToolbarControl(frame, 'insert-anchor')
  const dialog = frame.locator('[data-vmde-anchor-dialog]')
  await dialog.locator('input').fill(ANCHOR_NAME)
  await dialog.locator('button[type="submit"]').click()
  return {}
}

async function runEmoji(ctx: Ctx) {
  const frame = ctx.kit.frame()
  await placeCaret(ctx, 'emojiword', 'emojiword '.length)
  await clickToolbarControl(frame, 'emoji')
  const tile = frame
    .locator(
      '.vmde-emoji-picker [data-emoji-grid="catalog"] .vmde-emoji-picker__tile',
    )
    .first()
  await tile.waitFor({ state: 'visible', timeout: 30_000 })
  const emoji = (await tile.textContent()) ?? ''
  await tile.click()
  return { emoji }
}

async function runBubbleLink(ctx: Ctx) {
  const frame = ctx.kit.frame()
  await select(ctx, 'bubbleword')
  await endSelectionGesture(ctx)
  await evalFrame(
    ctx.kit,
    () => {
      document.dispatchEvent(new Event('selectionchange'))
    },
    0,
  )
  const bubble = frame.locator('.vmde-selection-bubble')
  await expect(bubble).toBeVisible({ timeout: 15_000 })
  await bubble.getByRole('button', { name: 'Link', exact: true }).click()
  return {}
}

// After typing, the click-time source binding needs the host's exact text; the popover's Edit and
// Unlink stay disabled until that arrives, so the popover is reopened until they are enabled.
async function openLinkPopover(ctx: Ctx) {
  const frame = ctx.kit.frame()
  const label = frame
    .locator('.vditor-ir [data-type="a"] .vditor-ir__link')
    .first()
  const popover = frame.locator('.vmde-link-popover')
  const edit = popover.getByRole('button', { name: 'Edit URL' })
  for (let attempt = 0; attempt < 8; attempt++) {
    await label.scrollIntoViewIfNeeded()
    await label.click()
    await expect(popover).toBeVisible()
    if (await edit.isEnabled()) return popover
    await ctx.kit.xtest.key('Escape')
    await ctx.kit.workbox.waitForTimeout(1_000)
  }
  throw new Error('link popover actions stayed disabled after typing')
}

async function runPopoverEdit(ctx: Ctx) {
  const popover = await openLinkPopover(ctx)
  await popover.getByRole('button', { name: 'Edit URL' }).click()
  const field = popover.getByRole('textbox', { name: 'URL' })
  await expect(field).toBeVisible()
  await expect(field).toBeFocused()
  await ctx.kit.xtest.key('ctrl+a')
  await ctx.kit.xtest.type(NEW_URL, 20)
  await expect(field).toHaveValue(NEW_URL)
  await popover.getByRole('button', { name: 'Save' }).click()
  return {}
}

async function runPopoverUnlink(ctx: Ctx) {
  const popover = await openLinkPopover(ctx)
  await popover.getByRole('button', { name: 'Unlink' }).click()
  return {}
}

async function runOutlineDrag(ctx: Ctx) {
  const frame = ctx.kit.frame()
  await evalFrame(
    ctx.kit,
    () => {
      const inner = (window as any).vditor.vditor
      inner.outline.toggle(inner, true)
    },
    0,
  )
  const rows = frame.locator('.vditor-outline li > span[data-target-id]')
  await expect(rows).toHaveCount(3)
  await expect.poll(() => rows.first().getAttribute('draggable')).toBe('true')
  // The same synthetic drag the outline-reorder spec uses: Section B dropped before Section A.
  await evalFrame(
    ctx.kit,
    () => {
      const all = Array.from(
        document.querySelectorAll<HTMLElement>(
          '.vditor-outline li > span[data-target-id]',
        ),
      )
      const source = all.find((row) => row.textContent?.includes('Section B'))!
      const target = all.find((row) => row.textContent?.includes('Section A'))!
      const data = new DataTransfer()
      source.dispatchEvent(
        new DragEvent('dragstart', { bubbles: true, dataTransfer: data }),
      )
      const rect = target.getBoundingClientRect()
      for (const type of ['dragover', 'drop'])
        target.dispatchEvent(
          new DragEvent(type, {
            bubbles: true,
            cancelable: true,
            clientY: rect.top + 1,
            dataTransfer: data,
          }),
        )
    },
    0,
  )
  return {}
}

async function runOutlineTree(ctx: Ctx) {
  await ctx.kit.host(async (vscode) => {
    const api = vscode.extensions.getExtension('Laicasaane.vmde')
      ?.exports as any
    if (!api?.outlineProvider || !api?.outlineDragAndDrop)
      throw new Error('outline test seam is unavailable')
    const deadline = Date.now() + 10_000
    while (api.outlineProvider.getChildren().length < 3) {
      if (Date.now() > deadline) throw new Error('outline tree never filled')
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    const [, sectionA, sectionB] = api.outlineProvider.getChildren()
    const data = new vscode.DataTransfer()
    const token = new vscode.CancellationTokenSource().token
    await api.outlineDragAndDrop.handleDrag([sectionB], data, token)
    await api.outlineDragAndDrop.handleDrop(sectionA, data, token)
  }, [])
  return {}
}

// ---------------------------------------------------------------------------------------------
// Scenarios: the driver, the span the action may change and the exact result the contract allows.

interface Scenario {
  id: string
  modes: Mode[]
  document: 'normalizing' | 'plain'
  // The action must fail closed: no host change at all (Task 630 leaves it open, see its record).
  declines?: boolean
  run(ctx: Ctx): Promise<Record<string, string>>
  span(reference: string, ran: Record<string, string>): Span
  expected(reference: string, ran: Record<string, string>): string
}

const wrapDetails = (paragraph: string) =>
  `<details>\n<summary>Details</summary>\n\n${paragraph}\n\n</details>`

const OUTLINE_SPAN = (reference: string): Span => ({
  start: uniqueIndex(reference, '# Section A'),
  end: reference.length,
})
const OUTLINE_EXPECTED = (reference: string) =>
  `${reference.slice(0, uniqueIndex(reference, '# Section A'))}# Section B\n\nsection B body\n\n# Section A\n\nsection A body\n`

const LINK_MARKUP = '[popword label](https://example.test/a "kept title")'

const SCENARIOS: Scenario[] = [
  {
    id: 'details-toggle',
    modes: ['ir', 'wysiwyg'],
    document: 'normalizing',
    run: runDetails,
    span: (reference) => tokenSpan(reference, DETAILS_PARAGRAPH),
    expected: (reference) =>
      replaceToken(
        reference,
        DETAILS_PARAGRAPH,
        wrapDetails(DETAILS_PARAGRAPH),
      ),
  },
  {
    id: 'inline-picture',
    modes: ['ir'],
    document: 'normalizing',
    run: runPicture,
    span: (reference) => pointSpan(reference, 'pictureword '),
    expected: (reference) => insertAfter(reference, 'pictureword ', PICTURE),
  },
  {
    id: 'named-anchor',
    modes: ['ir', 'wysiwyg'],
    document: 'normalizing',
    run: runAnchor,
    span: (reference) => pointSpan(reference, 'anchorword '),
    expected: (reference) =>
      insertAfter(reference, 'anchorword ', `<a name="${ANCHOR_NAME}"></a>`),
  },
  {
    id: 'emoji',
    modes: ['ir', 'wysiwyg'],
    document: 'normalizing',
    run: runEmoji,
    span: (reference) => pointSpan(reference, 'emojiword '),
    expected: (reference, ran) =>
      insertAfter(reference, 'emojiword ', ran.emoji),
  },
  {
    // Open product gap (new task): on a normalizing document the selection-bubble Link cannot map
    // the live range onto the exact text and declines. The contract here is that it declines
    // silently and writes nothing.
    id: 'bubble-link-normalizing',
    modes: ['ir', 'wysiwyg'],
    document: 'normalizing',
    declines: true,
    run: runBubbleLink,
    span: (reference) => tokenSpan(reference, 'bubbleword'),
    expected: (reference) => reference,
  },
  {
    // The folded cause: on a document that does not normalize, the typed input used to revoke the
    // owned base, so the post carried no `before` and the host refused it.
    id: 'bubble-link-plain',
    modes: ['ir', 'wysiwyg'],
    document: 'plain',
    run: runBubbleLink,
    span: (reference) => tokenSpan(reference, 'bubbleword'),
    expected: (reference) =>
      replaceToken(reference, 'bubbleword', '[bubbleword]()'),
  },
  {
    id: 'popover-edit',
    modes: ['ir'],
    document: 'normalizing',
    run: runPopoverEdit,
    span: (reference) => tokenSpan(reference, 'https://example.test/a'),
    expected: (reference) =>
      replaceToken(reference, 'https://example.test/a', NEW_URL),
  },
  {
    id: 'popover-unlink',
    modes: ['ir'],
    document: 'normalizing',
    run: runPopoverUnlink,
    span: (reference) => tokenSpan(reference, LINK_MARKUP),
    expected: (reference) =>
      replaceToken(reference, LINK_MARKUP, 'popword label'),
  },
  {
    id: 'outline-drag',
    modes: ['ir', 'wysiwyg'],
    document: 'normalizing',
    run: runOutlineDrag,
    span: OUTLINE_SPAN,
    expected: OUTLINE_EXPECTED,
  },
  {
    id: 'outline-tree-drop',
    modes: ['ir', 'wysiwyg'],
    document: 'normalizing',
    run: runOutlineTree,
    span: OUTLINE_SPAN,
    expected: OUTLINE_EXPECTED,
  },
]

const DOCUMENTS = {
  normalizing: { name: 'actions', content: NORMALIZING },
  plain: { name: 'plain', content: PLAIN },
}

// Typing, then one action, then Save, then native Undo and Redo.
async function actionAfterTyping(ctx: Ctx, check: Check, scenario: Scenario) {
  const { kit } = ctx
  const rendered = await evalFrame(
    kit,
    () => (window as any).vditor.getValue() as string,
    0,
  )
  // Positive control: the normalizing fixture really normalizes (the defect has bytes to leak) and
  // the plain fixture really does not (the folded cause needs no normalization).
  const normalizes = rendered !== ctx.initial
  if (scenario.document === 'normalizing')
    check(
      normalizes,
      'fixture does not normalize in this mode (instrument invalid)',
    )
  if (scenario.document === 'plain')
    check(!normalizes, 'fixture normalizes in this mode (instrument invalid)')

  const typed = await typeCharacter(ctx)
  check(
    typed.changed,
    'the typed character never reached the host (instrument invalid)',
  )
  check(
    typed.insertOnly,
    'the typing changed more than one character (instrument invalid)',
  )
  const reference = typed.reference

  const ran = await scenario.run(ctx)
  if (scenario.declines) {
    await kit.workbox.waitForTimeout(QUIET_MS * 2)
    const afterDecline = (await hostText(ctx)) ?? ''
    check(afterDecline === reference, 'the declined action changed the host')
    return {
      action: scenario.id,
      document: scenario.document,
      fixtureNormalizes: normalizes,
      reference: fingerprint(reference),
      hostAfter: fingerprint(afterDecline),
      declined: afterDecline === reference,
    }
  }
  const span = scenario.span(reference, ran)
  const expected = scenario.expected(reference, ran)
  const applied = await hostBecomes(ctx, (text) => text !== reference, 20_000)
  await kit.workbox.waitForTimeout(QUIET_MS)
  const afterAction = (await hostText(ctx)) ?? ''
  check(applied, 'the action did not change the host (instrument invalid)')
  check(
    !outsideSpanChanged(reference, afterAction, span),
    'bytes outside the action span changed',
  )
  check(afterAction === expected, 'host differs from the intended exact result')

  // Save: disk and host agree on the action result.
  await kit.host(
    async (vscode, [fsPath]: [string]) => {
      const document = vscode.workspace.textDocuments.find(
        (candidate) => candidate.uri.fsPath === fsPath,
      )
      if (!document || !(await document.save()))
        throw new Error('the document did not save')
    },
    [ctx.file],
  )
  await kit.workbox.waitForTimeout(AFTER_SAVE_MS)
  const saved = await hostState(ctx)
  const disk = readFileSync(ctx.file, 'utf8')
  check(
    disk === afterAction,
    'disk after Save differs from the host after the action',
  )
  check(saved.text === afterAction, 'Save changed the host text')

  // One native Undo restores the typed state; Redo restores the action result.
  await focusEditor(ctx)
  await kit.workbox.waitForTimeout(UNDO_LOCK_MS)
  await kit.xtest.key('ctrl+z')
  await kit.workbox.waitForTimeout(QUIET_MS)
  await hostBecomes(ctx, (text) => text === reference, UNDO_SETTLE_MS)
  const afterUndo = (await hostText(ctx)) ?? ''
  await kit.xtest.key('ctrl+y')
  await kit.workbox.waitForTimeout(QUIET_MS)
  await hostBecomes(ctx, (text) => text === afterAction, UNDO_SETTLE_MS)
  const afterRedo = (await hostText(ctx)) ?? ''
  check(afterUndo === reference, 'one Undo does not restore the typed state')
  check(afterRedo === afterAction, 'Redo does not restore the action result')

  return {
    action: scenario.id,
    document: scenario.document,
    fixtureNormalizes: normalizes,
    reference: fingerprint(reference),
    span,
    hostAfter: fingerprint(afterAction),
    interval: changedInterval(reference, afterAction),
    equalsExpected: afterAction === expected,
    disk: { ...fingerprint(disk), equalsHost: disk === afterAction },
    undo: {
      host: fingerprint(afterUndo),
      equalsReference: afterUndo === reference,
    },
    redo: {
      host: fingerprint(afterRedo),
      equalsActionResult: afterRedo === afterAction,
    },
  }
}

// ---------------------------------------------------------------------------------------------
// Stale host: an edit the webview never saw must not be overwritten.

function installUpdateFilterInPage() {
  const page = window as any
  if (page.__hideHostUpdates630) return
  page.__hideHostUpdates630 = true
  // Capture phase on the window runs before the router's listener: the host's `update` push is
  // hidden, so the webview keeps working from the text it had before the outside edit.
  window.addEventListener(
    'message',
    (event) => {
      if (event.data?.command === 'update') event.stopImmediatePropagation()
    },
    true,
  )
}

const frameDetailsButton = (ctx: Ctx) =>
  ctx.kit
    .frame()
    .locator('.vditor-toolbar [data-type="details"]')
    .first()
    .click({ timeout: 5_000 })

async function staleHostCell(ctx: Ctx, check: Check) {
  const { kit } = ctx
  const scenario = SCENARIOS.find(
    (candidate) => candidate.id === 'details-toggle',
  )!
  const typed = await typeCharacter(ctx)
  check(
    typed.changed,
    'the typed character never reached the host (instrument invalid)',
  )
  const reference = typed.reference
  // The selection (and so the enabled toolbar button) is set up before the outside edit.
  await selectDetailsParagraph(ctx)
  await evalFrame(kit, installUpdateFilterInPage, 0)
  await kit.host(
    async (vscode, [fsPath, mark]: [string, string]) => {
      const document = vscode.workspace.textDocuments.find(
        (candidate) => candidate.uri.fsPath === fsPath,
      )!
      const edit = new vscode.WorkspaceEdit()
      edit.insert(document.uri, new vscode.Position(0, 0), mark)
      if (!(await vscode.workspace.applyEdit(edit)))
        throw new Error('the outside edit was not applied')
    },
    [ctx.file, EXTERNAL_MARK],
  )
  const external = EXTERNAL_MARK + reference
  check(
    await hostBecomes(ctx, (text) => text === external),
    'the outside edit never reached the host (instrument invalid)',
  )
  // A button the outside edit disabled is a refusal too: nothing may be written.
  const clicked = await frameDetailsButton(ctx).then(
    () => true,
    () => false,
  )
  await kit.workbox.waitForTimeout(QUIET_MS * 2)
  const after = (await hostText(ctx)) ?? ''
  check(
    after.startsWith(EXTERNAL_MARK),
    'the action overwrote the outside edit',
  )
  const rest = after.slice(EXTERNAL_MARK.length)
  const intended = scenario.expected(reference, {})
  check(
    rest === reference || rest === intended,
    'bytes other than the action span changed on a stale host',
  )
  return {
    action: 'details-toggle',
    reference: fingerprint(reference),
    hostAfter: fingerprint(after),
    // Recorded, not asserted: a refused action leaves the outside edit alone; an action that
    // rebased onto it must have changed only its own span.
    clicked,
    outcome:
      after === external ? 'refused' : rest === intended ? 'rebased' : 'other',
    interval: changedInterval(external, after),
  }
}

// ---------------------------------------------------------------------------------------------

test.describe('Task 630 S3 other exact-authority actions after typing (OS-level XTEST, contract cells)', () => {
  test.skip(
    process.env.VMDE_XTEST !== '1',
    'requires isolated Xvfb/Openbox XTEST',
  )

  for (const mode of ['ir', 'wysiwyg'] as const) {
    test(`${mode}: each action after a typed character changes only its span, Undo restores the typed state and Save writes the result`, async ({
      workbox,
      electronApp,
      evaluateInVSCode,
      baseDir,
    }) => {
      test.setTimeout(1_800_000)
      const kit = await makeKit(
        workbox,
        electronApp,
        evaluateInVSCode,
        baseDir,
        '630-s3',
      )
      const scenarios = SCENARIOS.filter((scenario) =>
        scenario.modes.includes(mode),
      )
      const results: Record<string, unknown>[] = []
      try {
        for (const scenario of scenarios) {
          const { name, content } = DOCUMENTS[scenario.document]
          const ctx = await openDocument(
            kit,
            `exact-authority-${name}-${scenario.id}-${mode}.md`,
            content,
            mode,
          )
          try {
            await cell(ctx, scenario.id, (check) =>
              actionAfterTyping(ctx, check, scenario),
            )
          } finally {
            await disposeObservers(kit)
            await closeAll(kit, ctx.file)
          }
          results.push(...ctx.results)
        }
      } finally {
        await disposeObservers(kit)
      }
      finish(`${mode} actions`, results)
    })
  }

  for (const mode of ['ir', 'wysiwyg'] as const) {
    test(`${mode}: an outside edit the webview never saw is not overwritten by a following action`, async ({
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
        '630-s3',
      )
      const ctx = await openDocument(
        kit,
        `exact-authority-stale-${mode}.md`,
        NORMALIZING,
        mode,
      )
      try {
        await cell(ctx, 'stale-host-details', (check) =>
          staleHostCell(ctx, check),
        )
      } finally {
        await disposeObservers(kit)
        await closeAll(kit, ctx.file)
      }
      finish(`${mode} stale host`, ctx.results)
    })
  }
})
