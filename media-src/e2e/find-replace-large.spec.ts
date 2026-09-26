/**
 * Task 196 Checkpoint 1 — large-fixture Find & Replace reproduction, work counters, source-fidelity
 * (root cause 5) probe, and red regression assertions, in Chromium.
 *
 * Split from `find-replace.spec.ts` (which keeps the migrated small-contract cases) so a hang or a
 * long red run in one mode does not block or hide the others (handoff step 3: "prefer one test per
 * mode"). Every phase below is wrapped with a Playwright action-level `timeout`, which rejects on
 * schedule even if the page's main thread is still busy — the current `installFindReplace` refresh
 * path is a SYNCHRONOUS handler (`serializeFindClone` + Lute), so a timed-out action leaves the
 * browser still finishing that work in the background; the next action simply queues behind it. That
 * is the accepted cost of measuring an unfixed synchronous hot path (task record's Warning).
 *
 * Evidence goal (coordinator guidance, 2026-09-26): not a full timeline of every phase, but "does a
 * refresh complete, and what does ONE completed refresh cost". `query-first-keystroke` gets one long
 * deadline so a single refresh has a real chance to finish and its counters are captured; once ANY
 * heavy phase in a mode times out, every later heavy phase in that mode is skipped and recorded as
 * `notMeasured` instead of queuing more work onto an already-busy page. The cheap/structural phases
 * (navigate, scroll) still run regardless — they are the contrast this checkpoint needs (fast
 * regardless of document size) and do not depend on a live match set to stay cheap.
 */
import { createHash } from 'node:crypto'
import { expect, test } from './coverage-fixture'
import { installFindReplaceProbe } from '../../test/vscode-e2e/find-replace-probe'
import {
  FIXTURE,
  FIXTURE_SHA256,
  QUERY_TOKEN,
  CROSS_REGION_TOKEN,
  PAIR_TOKEN,
  BOLD_TOKEN,
  wholeWordCount,
  substringCount,
  classifyLines,
  regionCounts,
  literalMatches,
  applyReplacements,
  type LineKind,
} from '../../test/vscode-e2e/find-replace-fixture-helpers'

type Mode = 'ir' | 'wysiwyg' | 'sv'
type Page = import('@playwright/test').Page

interface PhaseResult {
  phase: string
  mode: Mode
  timedOut: boolean
  /** True when this phase was never attempted because an earlier heavy phase in the same mode
   * already timed out — the rest of the fields are zeroed/absent, not measured zeros. */
  notMeasured?: boolean
  notMeasuredReason?: string
  wallMs: number
  elapsedWorkloadMs?: number
  fullGetValueCalls?: number
  luteEntryPoints?: Record<string, number>
  rootLuteCalls?: number
  fragmentLuteCalls?: number
  editorDeepClones?: number
  setValueCalls?: number
  mutationObserversCreated?: number
  indexBuilds?: number
  indexBuildsInstrumented?: boolean
  longTaskCount?: number
  longTaskTotalMs?: number
  longTaskMaxMs?: number
  maxRafGapMs?: number
  overlayCount?: number
}

async function readSourceFidelity(page: Page): Promise<{
  equal: boolean
  exactLength: number
  gotLength: number
  firstDiffOffset: number
  firstDiffRegion: LineKind | 'n/a'
}> {
  const got = (await page.evaluate(
    () => (window as any).__getValue() as string,
  )) as string
  if (got === FIXTURE)
    return {
      equal: true,
      exactLength: FIXTURE.length,
      gotLength: got.length,
      firstDiffOffset: -1,
      firstDiffRegion: 'n/a',
    }
  let offset = 0
  const max = Math.min(FIXTURE.length, got.length)
  while (offset < max && FIXTURE[offset] === got[offset]) offset++
  const line = FIXTURE.slice(0, offset).split('\n').length - 1
  const kinds = classifyLines(FIXTURE)
  return {
    equal: false,
    exactLength: FIXTURE.length,
    gotLength: got.length,
    firstDiffOffset: offset,
    firstDiffRegion: kinds[line] ?? 'n/a',
  }
}

// query-first-keystroke gets a much longer deadline than every other heavy phase: the evidence
// goal for it specifically is "does ONE refresh complete at all", so it needs enough room that a
// timeout there means "still hasn't happened in a very long time", not "hadn't happened yet at the
// same bound every other phase uses". Every other heavy phase keeps the previous 150s bound.
const FIRST_KEYSTROKE_DEADLINE_MS = 400_000
const HEAVY_DEADLINE_MS = 150_000
const LIGHT_DEADLINE_MS = 60_000

async function runPhase(
  page: Page,
  mode: Mode,
  phase: string,
  workload: () => Promise<void>,
  deadlineMs: number,
): Promise<PhaseResult> {
  await page.evaluate(() => (window as any).__vmdeFindReplaceProbe.start())
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
    console.log(`[Task 196 phase timeout] ${mode}/${phase}: ${String(error)}`)
  }
  const wallMs = Date.now() - started
  await page.evaluate(() =>
    (window as any).__vmdeFindReplaceProbe.endWorkload(),
  )
  const raw = (await page.evaluate(() =>
    (window as any).__vmdeFindReplaceProbe.stop(),
  )) as ReturnType<typeof installFindReplaceProbe> extends void
    ? Record<string, unknown>
    : never
  const result = { phase, mode, timedOut, wallMs, ...(raw as any) }
  // Logged per-phase, not only in the end-of-test summary: a later phase's hard failure (a `poll`
  // or a non-soft `expect`) would otherwise discard every earlier phase's counters along with it —
  // exactly what happened to this file's first IR run (12.9m, failed before the summary printed).
  console.log(
    `[Task 196 phase result] ${mode}/${phase}`,
    JSON.stringify(result),
  )
  return result
}

function notMeasured(mode: Mode, phase: string, reason: string): PhaseResult {
  const result: PhaseResult = {
    phase,
    mode,
    timedOut: false,
    notMeasured: true,
    notMeasuredReason: reason,
    wallMs: 0,
  }
  console.log(`[Task 196 phase skipped] ${mode}/${phase}: ${reason}`)
  return result
}

/** Runs a heavy phase only while `blocked.value` is false; once any heavy phase times out, every
 * later heavy phase records `notMeasured` instead of queuing more work onto a page that is (per the
 * task record's Warning) likely still finishing the SAME synchronous work in the background. */
async function runGatedHeavyPhase(
  page: Page,
  mode: Mode,
  phase: string,
  workload: () => Promise<void>,
  deadlineMs: number,
  blocked: { value: boolean },
): Promise<PhaseResult> {
  if (blocked.value) return notMeasured(mode, phase, 'blocked by prior timeout')
  const result = await runPhase(page, mode, phase, workload, deadlineMs)
  if (result.timedOut) blocked.value = true
  return result
}

async function setupFixture(page: Page, mode: Mode): Promise<void> {
  await page.goto('/structural-selection.html')
  await page.waitForFunction(
    () => (window as unknown as { __ready?: boolean }).__ready,
  )
  await page.waitForTimeout(250)
  await page.evaluate((source) => (window as any).__setValue(source), FIXTURE)
  if (mode !== 'ir')
    await page.evaluate((next) => (window as any).__switchMode(next), mode)
  await expect
    .poll(() => page.evaluate(() => (window as any).__mode()), {
      timeout: 30_000,
    })
    .toBe(mode)
  await page.evaluate(installFindReplaceProbe)
}

function summarize(results: PhaseResult[]) {
  return results.map((r) => ({
    phase: r.phase,
    mode: r.mode,
    timedOut: r.timedOut,
    notMeasured: r.notMeasured ?? false,
    wallMs: r.wallMs,
    fullGetValueCalls: r.fullGetValueCalls,
    rootLuteCalls: r.rootLuteCalls,
    fragmentLuteCalls: r.fragmentLuteCalls,
    editorDeepClones: r.editorDeepClones,
    setValueCalls: r.setValueCalls,
    mutationObserversCreated: r.mutationObserversCreated,
    indexBuilds: r.indexBuilds,
    indexBuildsInstrumented: r.indexBuildsInstrumented,
    longTaskCount: r.longTaskCount,
    longTaskTotalMs: r.longTaskTotalMs,
    longTaskMaxMs: r.longTaskMaxMs,
    maxRafGapMs: r.maxRafGapMs,
    overlayCount: r.overlayCount,
  }))
}

// One probe-driven regression walks every Checkpoint 1 phase in a fixed order, gating each heavy
// one behind the same `blocked` flag (coordinator guidance, 2026-09-26) — splitting it would scatter
// the gating rule across several functions passing `blocked`/`results`/`widget` back and forth,
// which is harder to audit than one linear, heavily-commented sequence.
for (const mode of ['ir', 'wysiwyg', 'sv'] as const) {
  test(`Task 196 Checkpoint 1: large-fixture Find & Replace work counters (${mode})`, async ({
    page,
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: see the comment above the loop.
  }) => {
    test.setTimeout(1_200_000)
    expect(createHash('sha256').update(FIXTURE).digest('hex')).toBe(
      FIXTURE_SHA256,
    )
    await setupFixture(page, mode)
    const results: PhaseResult[] = []
    // Flips true the first time any HEAVY phase in this mode times out; every later heavy phase is
    // then recorded as `notMeasured` rather than attempted (coordinator guidance, 2026-09-26).
    const blocked = { value: false }

    // --- Root cause 5: source-fidelity probe (no refresh cost: getValue() only). ---
    const fidelity = await readSourceFidelity(page)
    console.log(
      `[Task 196 root-cause-5] mode=${mode}`,
      JSON.stringify(fidelity),
    )

    const widget = page.locator('.vmde-find-replace')
    await page.evaluate(() => (window as any).__openFindReplace())
    await expect(widget).toBeVisible()
    const find = widget.locator('[data-find]')
    const status = widget.locator('[data-status]')

    // --- Query keystroke phases. The FIRST keystroke is this checkpoint's headline measurement:
    // does one refresh complete, and at what cost. ---
    results.push(
      await runGatedHeavyPhase(
        page,
        mode,
        'query-first-keystroke',
        () =>
          find.pressSequentially(QUERY_TOKEN[0]!, {
            timeout: FIRST_KEYSTROKE_DEADLINE_MS,
          }),
        FIRST_KEYSTROKE_DEADLINE_MS,
        blocked,
      ),
    )
    results.push(
      await runGatedHeavyPhase(
        page,
        mode,
        mode === 'sv' ? 'query-remaining-keystrokes' : 'query-second-keystroke',
        () =>
          find.pressSequentially(
            mode === 'sv' ? QUERY_TOKEN.slice(1) : QUERY_TOKEN[1]!,
            { timeout: HEAVY_DEADLINE_MS },
          ),
        HEAVY_DEADLINE_MS,
        blocked,
      ),
    )

    // --- Toggle phases (case, then word). Reused by the migrated bold/pair cases below, which
    // both need case+word ON for their derived counts to hold — if blocked, those later cases are
    // skipped too (their `notMeasured` fill()s below are gated the same way). ---
    results.push(
      await runGatedHeavyPhase(
        page,
        mode,
        'toggle-case',
        () =>
          widget
            .locator('[data-action="case"]')
            .click({ timeout: HEAVY_DEADLINE_MS }),
        HEAVY_DEADLINE_MS,
        blocked,
      ),
    )
    results.push(
      await runGatedHeavyPhase(
        page,
        mode,
        'toggle-word',
        () =>
          widget
            .locator('[data-action="word"]')
            .click({ timeout: HEAVY_DEADLINE_MS }),
        HEAVY_DEADLINE_MS,
        blocked,
      ),
    )

    // --- Navigation and scroll are CHEAP/STRUCTURAL: move() reads the existing pointCache (no
    // refresh/cachePoints) and renderOverlays performs no editor clone/serialize. Run unconditionally
    // — they are the contrast this checkpoint needs (fast regardless of document size, and even
    // regardless of whether an earlier heavy phase left the match set stale). ---
    results.push(
      await runPhase(
        page,
        mode,
        'navigate-next5-previous5',
        async () => {
          for (let i = 0; i < 5; i++)
            await widget
              .locator('[data-action="next"]')
              .click({ timeout: LIGHT_DEADLINE_MS })
          for (let i = 0; i < 5; i++)
            await widget
              .locator('[data-action="previous"]')
              .click({ timeout: LIGHT_DEADLINE_MS })
        },
        LIGHT_DEADLINE_MS,
      ),
    )
    results.push(
      await runPhase(
        page,
        mode,
        'scroll-x5',
        async () => {
          for (let i = 0; i < 5; i++)
            await page.evaluate(() => (window as any).__scrollEditor(300))
        },
        LIGHT_DEADLINE_MS,
      ),
    )

    // --- Editor click + type with Find open: onDocumentClick / onEditorInput schedule a full
    // refresh (root cause 3). Reverted with the widget's own undo hook so later phases see the
    // original fixture text. SV's root element carries BOTH classes on itself
    // (`class="vditor-sv vditor-reset"`, Vditor's `sv/index.ts`) rather than nesting `.vditor-reset`
    // inside `.vditor-sv` the way IR/WYSIWYG do — a descendant selector never matches it. ---
    const editorSelector =
      mode === 'sv' ? '.vditor-sv' : `.vditor-${mode} .vditor-reset`
    const clickPhase = await runGatedHeavyPhase(
      page,
      mode,
      'editor-click-type',
      async () => {
        await page
          .locator(editorSelector)
          .first()
          .click({ position: { x: 8, y: 8 }, timeout: HEAVY_DEADLINE_MS })
        await page.keyboard.type('x', { delay: 0 })
      },
      HEAVY_DEADLINE_MS,
      blocked,
    )
    results.push(clickPhase)
    if (!clickPhase.notMeasured)
      await page.evaluate(() => (window as any).__undoFindReplace())

    // --- Mapping-completeness (migrated: "maps each prose, code, and table occurrence"). Skipped
    // wholesale once blocked — its expected-count computation and assertion are meaningless against
    // a page whose Find state a prior timeout already left indeterminate. ---
    let crossRegionExpected: {
      prose: number
      fence: number
      table: number
    } | null = null
    if (!blocked.value) {
      const preMappingValue = (await page.evaluate(
        () => (window as any).__getValue() as string,
      )) as string
      crossRegionExpected = regionCounts(
        preMappingValue,
        CROSS_REGION_TOKEN,
        true,
      )
      const crossRegionTotal =
        crossRegionExpected.prose +
        crossRegionExpected.fence +
        crossRegionExpected.table
      results.push(
        await runGatedHeavyPhase(
          page,
          mode,
          'mapping-query',
          () => find.fill(CROSS_REGION_TOKEN, { timeout: HEAVY_DEADLINE_MS }),
          HEAVY_DEADLINE_MS,
          blocked,
        ),
      )
      if (!blocked.value)
        await expect
          .soft(status)
          .toHaveText(`1/${crossRegionTotal}`, { timeout: 5_000 })
          .catch(() => {
            /* recorded via expect.soft; continue so later phases still run */
          })
    } else {
      results.push(
        notMeasured(mode, 'mapping-query', 'blocked by prior timeout'),
      )
    }

    // --- Replace All (migrated: "Replace All covers prose, fenced source, and table in one undo
    // step"). Byte-identity-outside-match is checked against the LIVE getValue() before the edit
    // (what the widget actually searched), independent of root-cause-5's exact-vs-rendered check. ---
    if (!blocked.value) {
      const replaceValue = (await page.evaluate(
        () => (window as any).__getValue() as string,
      )) as string
      const replaceAllMatches = literalMatches(
        replaceValue,
        CROSS_REGION_TOKEN,
        true,
      )
      const expectedAfterReplaceAll = applyReplacements(
        replaceValue,
        replaceAllMatches,
        'ZZZZ',
      )
      await widget.locator('[data-replace]').fill('ZZZZ')
      const replaceAllPhase = await runGatedHeavyPhase(
        page,
        mode,
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
        const afterReplaceAll = (await page.evaluate(
          () => (window as any).__getValue() as string,
        )) as string
        expect
          .soft(afterReplaceAll, 'replace-all changed only the matched ranges')
          .toBe(expectedAfterReplaceAll)
        expect
          .soft(
            replaceAllPhase.setValueCalls,
            'replace-all issues exactly one setValue',
          )
          .toBe(1)
        await page.evaluate(() => (window as any).__undoFindReplace())
        await expect
          .poll(() => page.evaluate(() => (window as any).__getValue()), {
            timeout: 30_000,
          })
          .toBe(replaceValue)
      }
    } else {
      results.push(notMeasured(mode, 'replace-all', 'blocked by prior timeout'))
    }

    // --- Marker-safe single replace inside inline formatting (migrated), 1 match, case-sensitive
    // (case/word toggles are still ON, unless a prior timeout already blocked this mode). ---
    if (!blocked.value) {
      await widget.locator('[data-replace]').fill('Ldbwx')
      const replaceSinglePhase = await runGatedHeavyPhase(
        page,
        mode,
        'replace-single-bold',
        async () => {
          await find.fill(BOLD_TOKEN, { timeout: HEAVY_DEADLINE_MS })
          await widget
            .locator('[data-action="replace"]')
            .click({ timeout: HEAVY_DEADLINE_MS })
        },
        HEAVY_DEADLINE_MS,
        blocked,
      )
      results.push(replaceSinglePhase)
      if (!replaceSinglePhase.notMeasured && !replaceSinglePhase.timedOut) {
        await expect
          .poll(
            () => page.evaluate(() => (window as any).__getValue() as string),
            { timeout: 30_000 },
          )
          .toContain('Ldbwx')
        expect
          .soft(
            await page.evaluate(() => (window as any).__getValue() as string),
            'no leaked find-caret marker',
          )
          .not.toContain('VMDE_FIND_CARET')
        await page.evaluate(() => (window as any).__undoFindReplace())
      }
    } else {
      results.push(
        notMeasured(mode, 'replace-single-bold', 'blocked by prior timeout'),
      )
    }

    // --- Repeated same-block occurrence (migrated), exactly 2 matches, same prose line. ---
    if (!blocked.value) {
      const pairPhase = await runGatedHeavyPhase(
        page,
        mode,
        'repeated-block-query',
        () => find.fill(PAIR_TOKEN, { timeout: HEAVY_DEADLINE_MS }),
        HEAVY_DEADLINE_MS,
        blocked,
      )
      results.push(pairPhase)
      if (!pairPhase.notMeasured && !pairPhase.timedOut) {
        await expect
          .soft(status)
          .toHaveText('1/2', { timeout: 5_000 })
          .catch(() => {
            /* expect.soft already recorded the mismatch; keep the phase run going */
          })
        const overlayCountAfterPair = await page
          .locator('.vmde-find-overlay')
          .count()
        expect
          .soft(
            overlayCountAfterPair,
            'repeated-block paints 2 distinct fragments',
          )
          .toBe(2)
      }
    } else {
      results.push(
        notMeasured(mode, 'repeated-block-query', 'blocked by prior timeout'),
      )
    }

    // --- Case/word toggle escalation + Escape (migrated). Reset both toggles OFF first (cheap —
    // no matches for PAIR_TOKEN survive the reset in a way that changes clone cost), then measure
    // the escalating restriction on QUERY_TOKEN: substring(CI) -> whole-word(CI) -> whole-word(CS). ---
    if (!blocked.value) {
      await widget.locator('[data-action="case"]').click()
      await widget.locator('[data-action="word"]').click()
      const toggleBaseValue = (await page.evaluate(
        () => (window as any).__getValue() as string,
      )) as string
      const substringCi = substringCount(toggleBaseValue, QUERY_TOKEN, false)
      const wholeCi = wholeWordCount(toggleBaseValue, QUERY_TOKEN, false)
      const wholeCs = wholeWordCount(toggleBaseValue, QUERY_TOKEN, true)
      const fillPhase = await runGatedHeavyPhase(
        page,
        mode,
        'toggle-escalation-fill',
        () => find.fill(QUERY_TOKEN, { timeout: HEAVY_DEADLINE_MS }),
        HEAVY_DEADLINE_MS,
        blocked,
      )
      results.push(fillPhase)
      if (!fillPhase.notMeasured && !fillPhase.timedOut)
        await expect
          .soft(status)
          .toHaveText(`1/${substringCi}`, { timeout: 5_000 })
          .catch(() => {
            /* expect.soft already recorded the mismatch; keep the phase run going */
          })
      const wordPhase = await runGatedHeavyPhase(
        page,
        mode,
        'toggle-escalation-word',
        () =>
          widget
            .locator('[data-action="word"]')
            .click({ timeout: HEAVY_DEADLINE_MS }),
        HEAVY_DEADLINE_MS,
        blocked,
      )
      results.push(wordPhase)
      if (!wordPhase.notMeasured && !wordPhase.timedOut)
        await expect
          .soft(status)
          .toHaveText(`1/${wholeCi}`, { timeout: 5_000 })
          .catch(() => {
            /* expect.soft already recorded the mismatch; keep the phase run going */
          })
      const casePhase = await runGatedHeavyPhase(
        page,
        mode,
        'toggle-escalation-case',
        () =>
          widget
            .locator('[data-action="case"]')
            .click({ timeout: HEAVY_DEADLINE_MS }),
        HEAVY_DEADLINE_MS,
        blocked,
      )
      results.push(casePhase)
      if (!casePhase.notMeasured && !casePhase.timedOut)
        await expect
          .soft(status)
          .toHaveText(`1/${wholeCs}`, { timeout: 5_000 })
          .catch(() => {
            /* expect.soft already recorded the mismatch; keep the phase run going */
          })
    } else {
      results.push(
        notMeasured(mode, 'toggle-escalation-fill', 'blocked by prior timeout'),
        notMeasured(mode, 'toggle-escalation-word', 'blocked by prior timeout'),
        notMeasured(mode, 'toggle-escalation-case', 'blocked by prior timeout'),
      )
    }
    await find.press('Escape')
    await expect.soft(widget).toBeHidden()

    console.log(
      `[Task 196 Checkpoint 1 work counters] mode=${mode}`,
      JSON.stringify({
        fixtureBytes: Buffer.byteLength(FIXTURE, 'utf8'),
        fixtureSha256: FIXTURE_SHA256,
        rootCause5: fidelity,
        crossRegionExpected,
        blocked: blocked.value,
        results: summarize(results),
      }),
    )

    // --- Red assertions (Part 1 handoff step 7; expected red on the current implementation). Soft
    // so one failure does not hide the others' evidence in this same report.
    //
    // Clone attribution caveat (coordinator guidance, 2026-09-26): `editorDeepClones` counts every
    // `cloneNode(true)` on the active editor root, not only Find's own `serializeFindClone` clone —
    // Vditor's own Undo (`undo/index.ts`) and word-Counter (`toolbar/Counter.ts`) modules also clone
    // the root for unrelated reasons. Attributing by call-stack function name was tried and found
    // impractical: the production bundle this harness serves is minified (`build.mjs`: `minify:
    // !watch`), and `serializeFindClone` does not appear as a literal in `media/dist/main.js`, so a
    // stack-trace check can never match. `rootLuteCalls` (whole-document `VditorIRDOM2Md`/
    // `VditorDOM2Md`) has no such ambiguity — nothing else in Vditor serializes the whole document on
    // a keystroke/scroll/click — so it is the PRIMARY attributable-to-Find signal below;
    // `editorDeepClones` is reported for context with this caveat, not gated as precisely. ---
    const secondKeystroke = results.find(
      (r) =>
        r.phase === 'query-second-keystroke' ||
        r.phase === 'query-remaining-keystrokes',
    )
    if (secondKeystroke && !secondKeystroke.notMeasured) {
      expect
        .soft(
          secondKeystroke.rootLuteCalls,
          'a query keystroke causes 0 whole-document Lute calls',
        )
        .toBe(0)
      expect
        .soft(
          secondKeystroke.editorDeepClones,
          'a query keystroke causes 0 editor deep clones (see clone-attribution caveat above)',
        )
        .toBe(0)
    }
    const scrollPhase = results.find((r) => r.phase === 'scroll-x5')!
    expect
      .soft(
        scrollPhase.rootLuteCalls,
        'scroll causes 0 whole-document Lute calls',
      )
      .toBe(0)
    expect
      .soft(
        scrollPhase.editorDeepClones,
        'scroll causes 0 editor deep clones (see clone-attribution caveat above)',
      )
      .toBe(0)
    if (!clickPhase.notMeasured)
      expect
        .soft(
          clickPhase.fullGetValueCalls,
          'an editor click with Find open causes 0 getValue calls',
        )
        .toBe(0)
  })
}
