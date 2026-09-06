import { wf } from './webview-helpers'
// Task 430 — phase-resolved PlantUML render timing. MEASUREMENT (like perf-timeline.spec.ts): the
// assertions are structural (the breakdown exists, its arithmetic holds, the gate is inert when off),
// not a performance gate — numbers vary by machine and this instrument exists to make them legible,
// not to fail CI on them (see the task's "Out of scope: a CI performance gate").
//
// NAMING (per the `*-probe.spec.ts` convention the `@probe` tier keys off): this is deliberately NOT
// named `plantuml-phase-timing-probe.spec.ts`. It is the task 430 DELIVERABLE — a reusable instrument
// meant to be re-run whenever a future PlantUML perf claim needs re-deriving (same posture as
// `perf-timeline.spec.ts`, which the task explicitly modelled this on), not a one-off scratch probe
// written to answer a question and then discarded. Recorded in tasks/430-…md as the reason it stays.
//
// Three data points, all from the SAME C4 fixture so they're comparable:
//   1. COLD   — first-ever render of block A in this VS Code instance: pays every phase in full.
//   2. WARM (engine) — block B, same open, right after A: same `nonClass` engine instance + already-
//      loaded C4 stdlib map, so `engineImport` should collapse toward 0 while `stdlibExpand` (textual
//      expansion only) + `engineRender` are still paid close to in full.
//   3. WARM (cache-hit) — close the editor and re-open the SAME file (the `abc-flip-cache-hit.spec.ts`
//      pattern: VMDE_E2E wipes the disk render-cache once per TEST, not per document open, so a
//      re-open WITHIN one test hits the now-populated store). `renderPlantumlBlock` — and therefore
//      every phase — is never entered on that path (paintCached short-circuits before
//      `plantumlRender`'s per-block loop even allocates a `PumlTiming`), so the instrument correctly
//      reports NOTHING for it: the cache path's cost relative to phase 1-5 is exactly zero renderer
//      work, which is the finding, not a bug in the instrument.
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'

const C4_FIXTURE = path.join(__dirname, 'fixtures', 'plantuml-timing-c4.md')
const PLAIN_FIXTURE = path.join(__dirname, 'fixtures', 'plantuml-loading.md')

interface PumlTimingRecord {
  targetId: string
  engineKind: string
  settledBy: string
  engineDiscarded: boolean
  queueWait: number
  engineImport: number
  stdlibExpand: number
  engineRender: number
  postProcess: number
  total: number
}

test('phase-resolved timing: cold vs engine-warm vs cache-hit on the same C4 fixture (task 430)', async ({
  workbox,
  evaluateInVSCode,
}) => {
  test.setTimeout(180_000)

  // Arm the gate BEFORE any webview document exists — addInitScript runs on every subsequent
  // document this Page creates, including the nested webview iframes (same technique as
  // script-load-failures.spec.ts) and survives the close+re-open below (it's registered on the
  // Page/workbox, not the iframe that gets torn down).
  await workbox.addInitScript(() => {
    ;(
      window as unknown as { __vmdePumlTimingEnabled?: boolean }
    ).__vmdePumlTimingEnabled = true
  })

  const openIt = () =>
    evaluateInVSCode(
      async (vscode: typeof import('vscode'), args: string[]) => {
        await vscode.extensions.getExtension('Laicasaane.vmde')?.activate()
        await vscode.commands.executeCommand(
          'vscode.openWith',
          vscode.Uri.file(args[0]),
          'vmde.editor',
        )
      },
      [C4_FIXTURE] as [string],
    )

  // ── Pass 1: COLD (block A) + WARM-engine (block B) ───────────────────────────────────────────
  await openIt()
  let frame = wf(workbox)
  await frame.locator('.vditor-ir').first().waitFor({ timeout: 60_000 })
  await expect
    .poll(
      () => frame.locator('.vditor-ir__preview .language-plantuml svg').count(),
      {
        timeout: 60_000,
      },
    )
    .toBeGreaterThanOrEqual(2)
  // Let both blocks' recordPumlTiming calls land (they fire synchronously off the MutationObserver),
  // AND give the rAF-debounced render-cache PUT (reportRenders) time to round-trip to the host and
  // land on disk before Pass 2 closes this editor — same 3s settle `abc-flip-cache-hit.spec.ts` uses
  // for exactly this reason (a shorter window measured flaky under load: the close can race the PUT).
  // task 512: retain — no client-side cache-PUT acknowledgement exists.
  await frame
    .locator('body')
    .evaluate(() => new Promise((r) => setTimeout(r, 3000)))

  const coldPass = await frame.locator('body').evaluate(() => {
    const w = window as unknown as { __vmdePumlTimings?: PumlTimingRecord[] }
    return w.__vmdePumlTimings ?? []
  })
  // eslint-disable-next-line no-console
  console.log(`[puml-timing] cold pass: ${JSON.stringify(coldPass, null, 1)}`)

  expect(coldPass.length, 'both C4 blocks produced a timing record').toBe(2)
  for (const [i, r] of coldPass.entries()) {
    // Arithmetic invariant (also unit-tested in plantuml-timing.test.ts, re-checked here against the
    // REAL webview's numbers rather than a fake clock): total is exactly the sum of the five phases.
    const sum =
      r.queueWait +
      r.engineImport +
      r.stdlibExpand +
      r.engineRender +
      r.postProcess
    expect(sum, `block ${i} total == sum of phases`).toBeCloseTo(r.total, 5)
    expect(
      r.settledBy,
      `block ${i} settled via the observer, not the 5s wedge fallback`,
    ).toBe('observer')
    expect(
      r.engineDiscarded,
      `block ${i} did not trip the isClassSource safety net`,
    ).toBe(false)
    expect(r.engineKind).toBe('nonClass') // C4/Rel()/Person() sources — see isClassSource
  }

  const [blockA, blockB] = coldPass
  // eslint-disable-next-line no-console
  console.log(
    `[puml-timing] engine share on the cold block (task 352's ~90% claim, re-derived here): ` +
      `${((blockA.engineRender / blockA.total) * 100).toFixed(1)}%`,
  )
  // eslint-disable-next-line no-console
  console.log(
    `[puml-timing] engineImport cold=${blockA.engineImport.toFixed(1)}ms vs warm=${blockB.engineImport.toFixed(1)}ms`,
  )

  // ── Pass 2: close + re-open the SAME file → a genuine render-cache HIT ────────────────────────
  await evaluateInVSCode(async (vscode: typeof import('vscode')) => {
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor')
  })
  await openIt()
  frame = wf(workbox)
  await frame.locator('.vditor-ir').first().waitFor({ timeout: 60_000 })
  await expect
    .poll(
      () => frame.locator('.vditor-ir__preview .language-plantuml svg').count(),
      {
        timeout: 60_000,
      },
    )
    .toBeGreaterThanOrEqual(2)
  await expect
    .poll(
      async () => ({
        hits: await frame
          .locator(
            '.vditor-ir__preview .language-plantuml[data-vmde-cache-hit]',
          )
          .count(),
        timings: await frame.locator('body').evaluate(() => {
          const w = window as unknown as {
            __vmdePumlTimings?: PumlTimingRecord[]
          }
          return w.__vmdePumlTimings?.length ?? 0
        }),
      }),
      { timeout: 30_000 },
    )
    .toEqual({ hits: 2, timings: 0 })

  const hitCount = await frame
    .locator('.vditor-ir__preview .language-plantuml[data-vmde-cache-hit]')
    .count()
  const warmPass = await frame.locator('body').evaluate(() => {
    const w = window as unknown as { __vmdePumlTimings?: PumlTimingRecord[] }
    return w.__vmdePumlTimings ?? []
  })
  // eslint-disable-next-line no-console
  console.log(
    `[puml-timing] cache-hit pass: hits=${hitCount}/2, timing records=${JSON.stringify(warmPass)}`,
  )

  expect(
    hitCount,
    'the re-open must be served from the render cache (both blocks)',
  ).toBe(2)
  // The whole point of this pass: a cache HIT never enters `renderPlantumlBlock`, so no phase is ever
  // started for it — the cheapest possible "warm" number is exactly zero renderer work, not a small
  // one. If this ever produces records, either the cache regressed to a miss (see the hitCount
  // assertion above, which would already have failed) or a `PumlTiming` leaked across the two passes.
  expect(
    warmPass.length,
    'a cache hit records NO timing — renderPlantumlBlock never ran',
  ).toBe(0)
})

test('phase timing is inert when the flag is off — no window global, default open (task 430)', async ({
  workbox,
  evaluateInVSCode,
}) => {
  test.setTimeout(120_000)
  // Deliberately NO addInitScript here — this is what every real user's session looks like.
  await evaluateInVSCode(
    async (vscode: typeof import('vscode'), args: string[]) => {
      await vscode.extensions.getExtension('Laicasaane.vmde')?.activate()
      await vscode.commands.executeCommand(
        'vscode.openWith',
        vscode.Uri.file(args[0]),
        'vmde.editor',
      )
    },
    [PLAIN_FIXTURE] as [string],
  )
  const frame = wf(workbox)
  await frame
    .locator('.vditor-ir__preview .language-plantuml svg')
    .first()
    .waitFor({ timeout: 60_000 })
  // task 512: retain — exactly 1s and the assertion is negative (the timing global must remain
  // absent after the normal-open instrumentation window).
  await frame
    .locator('body')
    .evaluate(() => new Promise((r) => setTimeout(r, 1000)))

  const timings = await frame
    .locator('body')
    .evaluate(
      () =>
        (window as unknown as { __vmdePumlTimings?: unknown })
          .__vmdePumlTimings,
    )
  // eslint-disable-next-line no-console
  console.log(
    `[puml-timing] gate-off window global: ${JSON.stringify(timings)}`,
  )
  expect(
    timings,
    'no timing collection on a normal open — the gate defaults off',
  ).toBeUndefined()
})
