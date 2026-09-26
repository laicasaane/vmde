/**
 * Task 196 Checkpoint 1 — large-fixture Find & Replace reproduction, work counters, source-fidelity
 * (root cause 5) probe, and red regression assertions, through real VS Code's webview/custom-editor
 * pipeline. Split from `find-replace.spec.ts` (which keeps the migrated small-contract acceptance
 * case) so a slow or timed-out phase here cannot hide that spec's result — same reasoning as the
 * Chromium split in `media-src/e2e/find-replace-large.spec.ts`.
 *
 * The current `installFindReplace` refresh path is a SYNCHRONOUS handler; a Playwright action
 * `timeout` rejects on schedule even while the renderer is still busy (see that Chromium spec's
 * header comment). Real VS Code adds Electron/XTEST/X11 round-trip latency on top, so phases here
 * use longer deadlines than the Chromium spec and fewer of them (task record Warning: keep the real
 * run bounded).
 */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import { createXtestInput } from './helpers/xtest-input'
import { docText, waitForE2EReadiness, wf } from './webview-helpers'
import { installFindReplaceProbe } from './find-replace-probe'
import {
  FIXTURE_SHA256,
  QUERY_TOKEN,
  CROSS_REGION_TOKEN,
  literalMatches,
  applyReplacements,
} from './find-replace-fixture-helpers'

const FIXTURE_PATH = path.join(
  __dirname,
  'fixtures',
  'large-observable-models-synthetic.md',
)

interface PhaseResult {
  phase: string
  timedOut: boolean
  wallMs: number
  [key: string]: unknown
}

// The task record's Warning caps a real VS Code run at "< ~10 min" total. `query-first-keystroke`
// is this file's headline measurement (coordinator guidance, 2026-09-26: "does it complete, and
// what does ONE completed refresh cost"), so it gets a long deadline to give a single refresh a
// real chance — measured evidence already shows it can exceed 90s without completing. Once it (or
// any other phase) times out, every later phase is skipped and recorded `notMeasured` instead of
// queuing more work onto a frame the task record's Warning says is likely still busy, so the run
// still finishes well under the 10-minute cap.
const FIRST_KEYSTROKE_DEADLINE_MS = 240_000
const HEAVY_DEADLINE_MS = 90_000
const LIGHT_DEADLINE_MS = 45_000

/** `Locator.evaluate(pageFunction, arg, options)` — the deadline MUST go in the third position; an
 * earlier version of this file passed `{ timeout }` as the second (`arg`) position, where it is
 * silently serialized and ignored, so every call kept Playwright's 30s default regardless of the
 * value written at the call site (caught by an actual red run: a real-VS-Code phase failed the
 * whole test at exactly 30s despite an explicit 180s deadline). This helper makes that mistake
 * impossible to repeat. */
function evaluateWithDeadline<R>(
  frame: ReturnType<typeof wf>,
  fn: () => R,
  deadlineMs: number,
): Promise<R> {
  return frame.locator('body').evaluate(fn, undefined, { timeout: deadlineMs })
}

/** Logged per-phase, not only in the end-of-test summary: a later phase's hard failure would
 * otherwise discard every earlier phase's counters along with it (the same gap the Chromium spec's
 * `runPhase` fixes the same way — see that file's comment for the run this was caught on). */
function finishPhase(result: PhaseResult): PhaseResult {
  console.log(
    `[Task 196 real-VS-Code phase result] ${result.phase}`,
    JSON.stringify(result),
  )
  return result
}

function notMeasured(phase: string, reason: string): PhaseResult {
  return finishPhase({
    phase,
    timedOut: false,
    notMeasured: true,
    notMeasuredReason: reason,
    wallMs: 0,
  })
}

/** Runs a phase only while `blocked.value` is false; once any phase times out, every later phase
 * records `notMeasured` instead of queuing more work onto a frame the task record's Warning says is
 * likely still finishing the same synchronous work (coordinator guidance, 2026-09-26). */
async function runGatedPhase(
  frame: ReturnType<typeof wf>,
  phase: string,
  workload: () => Promise<void>,
  deadlineMs: number,
  blocked: { value: boolean },
): Promise<PhaseResult> {
  if (blocked.value) return notMeasured(phase, 'blocked by prior timeout')
  const result = await runPhase(frame, phase, workload, deadlineMs)
  if (result.timedOut) blocked.value = true
  return result
}

async function runPhase(
  frame: ReturnType<typeof wf>,
  phase: string,
  workload: () => Promise<void>,
  deadlineMs: number,
): Promise<PhaseResult> {
  try {
    await evaluateWithDeadline(
      frame,
      () => (window as any).__vmdeFindReplaceProbe.start(),
      deadlineMs,
    )
  } catch (error) {
    console.log(
      `[Task 196 real-VS-Code probe unreachable before ${phase}] ${String(error)}`,
    )
    return finishPhase({
      phase,
      timedOut: true,
      wallMs: 0,
      probeUnavailable: true,
    })
  }
  const started = Date.now()
  let timedOut = false
  try {
    await Promise.race([
      workload(),
      new Promise<never>((_resolve, reject) =>
        setTimeout(
          () => reject(new Error(`[${phase}] exceeded ${deadlineMs}ms`)),
          deadlineMs,
        ),
      ),
    ])
  } catch (error) {
    timedOut = true
    console.log(
      `[Task 196 real-VS-Code phase timeout] ${phase}: ${String(error)}`,
    )
  }
  const wallMs = Date.now() - started
  // A timed-out workload can leave the renderer's main thread still finishing the same synchronous
  // work (see this file's header comment), so the probe's own `endWorkload`/`stop` calls need the
  // SAME generous deadline as the workload — Playwright's 30s default action timeout on `.evaluate`
  // would otherwise fail the whole test even though the phase's own timeout already recorded the
  // slowness. A frame that never responds within that deadline reports a `probeUnavailable` result
  // instead of throwing, so one unreachable phase does not blank out every later phase's evidence.
  try {
    await evaluateWithDeadline(
      frame,
      () => (window as any).__vmdeFindReplaceProbe.endWorkload(),
      deadlineMs,
    )
    const raw = await evaluateWithDeadline(
      frame,
      () => (window as any).__vmdeFindReplaceProbe.stop(),
      deadlineMs,
    )
    return finishPhase({ phase, timedOut, wallMs, ...(raw as object) })
  } catch (error) {
    console.log(
      `[Task 196 real-VS-Code probe unreachable] ${phase}: ${String(error)}`,
    )
    return finishPhase({
      phase,
      timedOut: true,
      wallMs,
      probeUnavailable: true,
    })
  }
}

test('Task 196 Checkpoint 1: large-fixture Find & Replace work counters (real VS Code, IR)', async ({
  workbox,
  electronApp,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(600_000)
  const initial = readFileSync(FIXTURE_PATH, 'utf8')
  expect(createHash('sha256').update(initial).digest('hex')).toBe(
    FIXTURE_SHA256,
  )
  const file = path.join(baseDir, 'find-replace-large-synthetic.md')
  writeFileSync(file, initial)

  await evaluateInVSCode(async (vscode) => {
    await vscode.extensions.getExtension('Laicasaane.vmde')?.activate()
    await vscode.workspace
      .getConfiguration('vmde')
      .update('editor.defaultMode', 'ir', true)
  })
  await evaluateInVSCode(
    async (vscode, args: [string]) => {
      await vscode.commands.executeCommand(
        'vscode.openWith',
        vscode.Uri.file(args[0]),
        'vmde.editor',
      )
    },
    [file] as [string],
  )
  const frame = wf(workbox)
  await waitForE2EReadiness(
    frame,
    (state) => state.editorEpoch > 0 && state.mode === 'ir',
    { timeout: 90_000, message: 'Task 196 large fixture readiness' },
  )
  await expect
    .poll(
      async () =>
        ((await docText(evaluateInVSCode as never, file)) as string) ===
        initial,
      { timeout: 60_000, message: 'host text matches synthetic fixture' },
    )
    .toBe(true)

  // --- Root cause 5: does getValue() (what Find actually searches) match the exact file the host
  // opened, before any Find interaction? ---
  const openedValue = await frame
    .locator('body')
    .evaluate(() =>
      (
        window as unknown as { vditor: { getValue(): string } }
      ).vditor.getValue(),
    )
  const rootCause5 =
    openedValue === initial
      ? { equal: true }
      : {
          equal: false,
          exactLength: initial.length,
          gotLength: openedValue.length,
        }
  console.log(
    '[Task 196 root-cause-5 real-VS-Code]',
    JSON.stringify(rootCause5),
  )

  await frame.locator('body').evaluate(installFindReplaceProbe)
  const xtest = await createXtestInput(electronApp, workbox)
  expect(xtest.client.visible).toBe(true)
  await xtest.activateAndFocus()

  const results: PhaseResult[] = []
  const widget = frame.locator('.vmde-find-replace')

  results.push(
    await runPhase(
      frame,
      'open',
      async () => {
        await xtest.key('ctrl+f')
        await expect(widget).toBeVisible({ timeout: HEAVY_DEADLINE_MS })
      },
      HEAVY_DEADLINE_MS,
    ),
  )
  // `query-first-keystroke` is this checkpoint's headline real-VS-Code measurement: does one
  // refresh complete, and at what cost (coordinator guidance, 2026-09-26). It gets a long deadline
  // for that reason. Once it (or any later phase) times out, `blocked` skips everything after —
  // the run still finishes well under the task record's "< ~10 min" cap instead of queuing more
  // work onto a frame the header comment says is likely still busy.
  const blocked = { value: false }
  const keystroke = await runGatedPhase(
    frame,
    'query-first-keystroke',
    () => xtest.type(QUERY_TOKEN[0]!, 20),
    FIRST_KEYSTROKE_DEADLINE_MS,
    blocked,
  )
  results.push(keystroke)
  results.push(
    await runGatedPhase(
      frame,
      'toggle-case',
      () =>
        widget
          .locator('[data-action="case"]')
          .click({ timeout: HEAVY_DEADLINE_MS }),
      HEAVY_DEADLINE_MS,
      blocked,
    ),
  )
  const scroll = await runGatedPhase(
    frame,
    'scroll',
    async () => {
      await frame.locator('.vditor-ir .vditor-reset').first().hover()
      await workbox.mouse.wheel(0, 400)
    },
    LIGHT_DEADLINE_MS,
    blocked,
  )
  results.push(scroll)

  // --- Replace All + Undo, byte-identity-outside-match (item 7) and root-cause-5-adjacent disk
  // check — skipped once blocked (per the guidance above), otherwise bounded by its own deadline
  // like every other phase. The whole block is additionally try/caught: a stuck fill/click here
  // must not blank out the phases already recorded above (real VS Code has no cheap way to race an
  // in-flight cross-process CDP call the way a same-process Node timer can, so a failure here is
  // caught rather than raced). ---
  if (!blocked.value) {
    try {
      await widget
        .locator('[data-find]')
        .fill('', { timeout: HEAVY_DEADLINE_MS })
      await evaluateWithDeadline(
        frame,
        () => (window as any).__vmdeFindReplaceProbe.start(),
        HEAVY_DEADLINE_MS,
      )
      await widget
        .locator('[data-find]')
        .fill(CROSS_REGION_TOKEN, { timeout: HEAVY_DEADLINE_MS })
      await evaluateWithDeadline(
        frame,
        () => (window as any).__vmdeFindReplaceProbe.stop(),
        HEAVY_DEADLINE_MS,
      )
      const preReplaceValue = await evaluateWithDeadline(
        frame,
        () =>
          (
            window as unknown as { vditor: { getValue(): string } }
          ).vditor.getValue(),
        HEAVY_DEADLINE_MS,
      )
      const replaceAllMatches = literalMatches(
        preReplaceValue,
        CROSS_REGION_TOKEN,
        true,
      )
      const expectedAfterReplaceAll = applyReplacements(
        preReplaceValue,
        replaceAllMatches,
        'ZZZZ',
      )
      await widget
        .locator('[data-replace]')
        .fill('ZZZZ', { timeout: HEAVY_DEADLINE_MS })
      const replaceAllPhase = await runGatedPhase(
        frame,
        'replace-all',
        () =>
          widget
            .locator('[data-action="replace-all"]')
            .click({ timeout: HEAVY_DEADLINE_MS }),
        HEAVY_DEADLINE_MS,
        blocked,
      )
      results.push(replaceAllPhase)
      if (!replaceAllPhase.notMeasured && !replaceAllPhase.timedOut) {
        const afterReplaceAll = await evaluateWithDeadline(
          frame,
          () =>
            (
              window as unknown as { vditor: { getValue(): string } }
            ).vditor.getValue(),
          HEAVY_DEADLINE_MS,
        )
        expect
          .soft(afterReplaceAll, 'replace-all changed only the matched ranges')
          .toBe(expectedAfterReplaceAll)
        expect
          .soft(
            replaceAllPhase.setValueCalls,
            'replace-all issues exactly one setValue',
          )
          .toBe(1)

        await widget
          .locator('[data-find]')
          .press('Escape', { timeout: HEAVY_DEADLINE_MS })
        await xtest.key('ctrl+z')
        await expect
          .poll(
            async () =>
              ((await docText(evaluateInVSCode as never, file)) as string) ===
              initial,
            {
              timeout: HEAVY_DEADLINE_MS,
              message: 'Undo restores exact baseline in host text',
            },
          )
          .toBe(true)
        await evaluateInVSCode(async (vscode) => {
          await vscode.commands.executeCommand('workbench.action.files.save')
        })
        const diskAfterUndo = readFileSync(file, 'utf8')
        expect
          .soft(diskAfterUndo, 'Undo + save restores exact disk bytes')
          .toBe(initial)
      }
    } catch (error) {
      console.log(
        `[Task 196 real-VS-Code replace-all block failed] ${String(error)}`,
      )
    }
  } else {
    results.push(notMeasured('replace-all', 'blocked by prior timeout'))
  }

  console.log(
    '[Task 196 Checkpoint 1 work counters real-VS-Code]',
    JSON.stringify({
      fixtureBytes: Buffer.byteLength(initial, 'utf8'),
      fixtureSha256: FIXTURE_SHA256,
      rootCause5,
      blocked: blocked.value,
      results,
    }),
  )

  // --- Red assertions (Part 1 handoff step 7), soft so every phase's evidence is still reported
  // together even when (as expected now) some fail.
  //
  // Clone attribution caveat (coordinator guidance, 2026-09-26): `editorDeepClones` counts every
  // `cloneNode(true)` on the active editor root, not only Find's own `serializeFindClone` clone —
  // Vditor's own Undo (`undo/index.ts`) and word-Counter (`toolbar/Counter.ts`) modules also clone
  // the root for unrelated reasons. Attributing by call-stack function name was tried and found
  // impractical: the shipped bundle is minified (`media-src/build.mjs`: `minify: !watch`), and
  // `serializeFindClone` does not appear as a literal in `media/dist/main.js`, so a stack-trace
  // check can never match. `rootLuteCalls` (whole-document `VditorIRDOM2Md`/`VditorDOM2Md`) has no
  // such ambiguity — nothing else in Vditor serializes the whole document on a keystroke or scroll
  // — so it is the PRIMARY attributable-to-Find signal below; `editorDeepClones` is reported for
  // context with this caveat, not gated as precisely. ---
  if (!keystroke.notMeasured) {
    expect
      .soft(
        keystroke.rootLuteCalls,
        'a query keystroke causes 0 whole-document Lute calls',
      )
      .toBe(0)
    expect
      .soft(
        keystroke.editorDeepClones,
        'a query keystroke causes 0 editor deep clones (see clone-attribution caveat above)',
      )
      .toBe(0)
  }
  if (!scroll.notMeasured) {
    expect
      .soft(scroll.rootLuteCalls, 'scroll causes 0 whole-document Lute calls')
      .toBe(0)
    expect
      .soft(
        scroll.editorDeepClones,
        'scroll causes 0 editor deep clones (see clone-attribution caveat above)',
      )
      .toBe(0)
  }
  const wholeSession = results.reduce(
    (sum, r) => sum + ((r.indexBuilds as number) ?? 0),
    0,
  )
  expect
    .soft(
      wholeSession,
      'a whole Find session with no edits builds the index at most once',
    )
    .toBeLessThanOrEqual(1)
})
