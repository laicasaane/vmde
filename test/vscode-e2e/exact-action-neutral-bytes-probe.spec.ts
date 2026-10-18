/**
 * Task 630 D6 probe — does typing after an exact action revert the action's neutral bytes?
 *
 * Mechanism under test (Task 630 Part 1, D6): plain posts minimize against `cleanBaseline ??
 * currentText` (`src/writeback/writeback-controller.ts`), which is reset only at open and at save. An
 * exact action that leaves neutral bytes (here SV table-format padding) therefore might have those
 * bytes reverted by the next typing elsewhere in the document.
 *
 * Steps: open the normalizing fixture in SV; run Format table in the table; record the host bytes
 * (the action result); type one character in another paragraph; compare the host bytes to the action
 * result with that character inserted; Save and type once more to see whether the baseline reset
 * changes the outcome. The probe records the outcome (console line and test annotation); it asserts
 * no verdict. Only instrument validity (the action changed the host, the typing reached the host) is
 * recorded as a flag, never as a failure.
 *
 * Privacy: lengths, short hashes and changed intervals only; no document text is printed.
 *
 * @probe — excluded from the default run; run with `npm --prefix test/vscode-e2e run test:probes`.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import {
  AFTER_SAVE_MS,
  type Ctx,
  closeAll,
  disposeObservers,
  endSelectionGesture,
  hostText,
  makeKit,
  openDocument,
  QUIET_MS,
  select,
  UNDO_LOCK_MS,
} from './helpers/shortcut-xtest-kit'

const NORMALIZING = readFileSync(
  path.join(__dirname, 'fixtures', 'exact-actions-normalizing.md'),
  'utf8',
)

const fingerprint = (text: string) => ({
  length: text.length,
  sha: createHash('sha256').update(text).digest('hex').slice(0, 12),
})

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

const hostBecomes = (ctx: Ctx, predicate: (text: string) => boolean) =>
  expect
    .poll(async () => predicate((await hostText(ctx)) ?? ''), {
      timeout: 15_000,
    })
    .toBe(true)
    .then(
      () => true,
      () => false,
    )

async function typeIn(ctx: Ctx, token: string, character: string) {
  const before = (await hostText(ctx)) ?? ''
  await select(ctx, token, { collapsed: true, offset: 2 })
  await endSelectionGesture(ctx)
  await ctx.kit.xtest.type(character, 20)
  const reached = await hostBecomes(ctx, (text) => text !== before)
  await ctx.kit.workbox.waitForTimeout(UNDO_LOCK_MS)
  return { before, after: (await hostText(ctx)) ?? '', reached }
}

test.describe('Task 630 D6 probe (OS-level XTEST) @probe', () => {
  test.skip(
    process.env.VMDE_XTEST !== '1',
    'requires isolated Xvfb/Openbox XTEST',
  )

  test('probe: typing after an exact SV table-format keeps or reverts its padding @probe', async ({
    workbox,
    electronApp,
    evaluateInVSCode,
    baseDir,
  }, testInfo) => {
    test.setTimeout(600_000)
    const kit = await makeKit(
      workbox,
      electronApp,
      evaluateInVSCode,
      baseDir,
      '630-d6',
    )
    const ctx = await openDocument(
      kit,
      'exact-neutral-bytes-sv.md',
      NORMALIZING,
      'sv',
    )
    const record: Record<string, unknown> = {}
    try {
      await select(ctx, 'cellone', { collapsed: true, offset: 3 })
      await endSelectionGesture(ctx)
      await kit.workbox.waitForTimeout(800)
      await kit.host(async (vscode) => {
        await vscode.commands.executeCommand('vmde.formatTable')
      }, [])
      record.actionReachedHost = await hostBecomes(
        ctx,
        (text) => text !== ctx.initial,
      )
      await kit.workbox.waitForTimeout(QUIET_MS)
      const actionResult = (await hostText(ctx)) ?? ''
      record.initial = fingerprint(ctx.initial)
      record.actionResult = fingerprint(actionResult)
      record.actionInterval = changedInterval(ctx.initial, actionResult)

      const typed = await typeIn(ctx, 'editword', 'x')
      const at = actionResult.indexOf('editword') + 2
      const expectedKept = `${actionResult.slice(0, at)}x${actionResult.slice(at)}`
      record.typingReachedHost = typed.reached
      record.afterTyping = fingerprint(typed.after)
      record.typingKeptActionResult = typed.after === expectedKept
      record.afterTypingVsExpected = changedInterval(expectedKept, typed.after)
      // Whether the padding bytes of the action result are gone again.
      record.afterTypingEqualsInitialPlusChar = (() => {
        const insertAt = ctx.initial.indexOf('editword') + 2
        return (
          typed.after ===
          `${ctx.initial.slice(0, insertAt)}x${ctx.initial.slice(insertAt)}`
        )
      })()

      // After Save the clean baseline resets: does one more character behave differently?
      await kit.host(
        async (vscode, [fsPath]: [string]) => {
          const document = vscode.workspace.textDocuments.find(
            (candidate) => candidate.uri.fsPath === fsPath,
          )
          await document?.save()
        },
        [ctx.file],
      )
      await kit.workbox.waitForTimeout(AFTER_SAVE_MS)
      const second = await typeIn(ctx, 'editword', 'y')
      const insertAgain = typed.after.indexOf('editword') + 2
      const expectedSecond = `${typed.after.slice(0, insertAgain)}y${typed.after.slice(insertAgain)}`
      record.secondTypingReachedHost = second.reached
      record.afterSave = fingerprint(typed.after)
      record.secondTypingKeptBytes = second.after === expectedSecond
      record.secondTypingVsExpected = changedInterval(
        expectedSecond,
        second.after,
      )
    } catch (error) {
      record.measurementError = String((error as Error)?.message ?? error)
        .split('\n')[0]
        ?.slice(0, 300)
    } finally {
      await disposeObservers(kit)
      await closeAll(kit, ctx.file)
    }
    const line = JSON.stringify(record)
    console.log('[630 D6 probe]', line)
    testInfo.annotations.push({ type: '630-d6-outcome', description: line })
  })
})
