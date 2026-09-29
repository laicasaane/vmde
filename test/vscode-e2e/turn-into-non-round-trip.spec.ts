import { expect, test } from 'vscode-test-playwright'
import { readFileSync } from 'node:fs'
import { FIXTURE } from './find-replace-fixture-helpers'
import { reopenVmdeFixture, waitForE2EReadiness } from './webview-helpers'
import type { TurnIntoProbeResult } from './turn-into-probe'
import {
  TOKEN,
  chooseHeading2,
  far,
  findFar,
  focusEditor,
  headingPlan,
  hostEquals,
  near,
  openFixture,
  record,
  registerReportHooks,
  saveAndCompare,
  selectTarget,
  selectionState,
  startReport,
  unchanged,
} from './turn-into-non-round-trip-helpers'

registerReportHooks()

type Context = Awaited<ReturnType<typeof openFixture>>

async function twoFrames(ctx: Context) {
  await ctx.frame
    .locator('body')
    .evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    )
}

async function beginWork(ctx: Context) {
  const source = await ctx.host()
  await ctx.frame
    .locator('body')
    .evaluate(
      (_body, exact) => (window as any).__vmdeTurnIntoProbe.start(exact),
      source,
    )
}

async function endWork(ctx: Context): Promise<TurnIntoProbeResult> {
  await ctx.frame
    .locator('body')
    .evaluate(() => (window as any).__vmdeTurnIntoProbe.endWorkload())
  await twoFrames(ctx)
  return ctx.frame
    .locator('body')
    .evaluate(() => (window as any).__vmdeTurnIntoProbe.stop())
}

function recordWork(label: string, work: TurnIntoProbeResult) {
  const { luteCalls, ...counts } = work
  record(label, {
    ...counts,
    luteCalls: luteCalls.map(({ at, kind, inputLength }) => ({
      at,
      fragment: kind === 'fragment',
      inputLength,
    })),
  })
}

async function requestPositive(ctx: Context) {
  const picker = ctx.workbox.locator('.quick-input-widget input').first()
  await beginWork(ctx)
  const outcome = {
    quickPickOpened: false,
    currentTypeIsParagraph: false,
    heading2Offered: false,
    timeToPickerMs: 0,
  }
  const started = performance.now()
  let work!: TurnIntoProbeResult
  try {
    await Promise.all([
      picker.waitFor({ state: 'visible', timeout: 10_000 }),
      ctx.evaluateInVSCode(async (vscode: typeof import('vscode')) => {
        await vscode.commands.executeCommand('vmde.turnInto')
      }, []),
    ])
    outcome.quickPickOpened = true
    outcome.timeToPickerMs = performance.now() - started
    outcome.currentTypeIsParagraph =
      (await picker.getAttribute('placeholder')) === 'Current: Paragraph'
    await expect(
      ctx.workbox.getByRole('option', { name: /Heading 2/u }).first(),
    ).toBeVisible()
    outcome.heading2Offered = true
  } finally {
    work = await endWork(ctx)
    record('native_request', outcome)
    recordWork('native_request_work', work)
  }
  return { value: outcome, work }
}

function assertRequestBudget(work: TurnIntoProbeResult, viaFind: boolean) {
  expect(
    work.snapshotChangesInstrumented && work.indexBuildChangesInstrumented,
  ).toBe(true)
  expect(work.request.observed).toBe(true)
  expect(work.request.indexBuilds).toBe(0)
  expect(work.request.editSyncSnapshotCalls).toBeLessThanOrEqual(1)
  expect(work.request.fullGetValueCalls).toBeLessThanOrEqual(1)
  expect(work.request.rootLuteCalls).toBeLessThanOrEqual(2)
  expect(work.request.fragmentLuteCalls).toBeLessThanOrEqual(1)
  expect(work.request.markerInsertions).toBe(0)
  expect(work.blockTransformCaptureCalls).toBe(1)
  expect(work.blockTransformIndexProofs).toBe(1)
  expect(work.blockTransformLegacyProofs).toBe(0)
  expect(work.blockTransformOptionsReturned).toBe(1)
  if (viaFind) {
    expect(work.fullGetValueCalls).toBeLessThanOrEqual(4)
    expect(work.rootLuteCalls).toBeLessThanOrEqual(9)
    expect(work.indexBuilds).toBeLessThanOrEqual(1)
  }
}

async function warmCaretIndex(ctx: Context) {
  const paragraph = ctx.frame
    .locator(`#app .vditor-${ctx.mode} .vditor-reset > p`)
    .filter({ hasText: near.fragment })
  await expect(paragraph).toHaveCount(1)
  expect(
    await paragraph.evaluate((node, mode) => {
      const root = (window as any).vditor.vditor[mode].element
      return node.isConnected && root.contains(node)
    }, ctx.mode),
  ).toBe(true)
  await paragraph.hover({ position: { x: 8, y: 8 } })
  await twoFrames(ctx)
  return paragraph
}

async function undoDepth(ctx: Context): Promise<number> {
  return ctx.frame.locator('body').evaluate(() => {
    const inner = (window as any).vditor.vditor
    return inner.undo[inner.currentMode].undoStack.length
  })
}

async function waitForOpeningUndo(ctx: Context) {
  await expect
    .poll(() => undoDepth(ctx), { timeout: 10_000 })
    .toBeGreaterThan(0)
  return undoDepth(ctx)
}

async function prepareCapture(ctx: Context, viaFind: boolean) {
  if (viaFind) {
    record('find_setup', await findFar(ctx))
    return waitForOpeningUndo(ctx)
  }
  // The opening Undo checkpoint inserts/removes a transient wbr and invalidates the index.
  // Finish that known setup work before hover, so the request measures an actually warm entry.
  const undoDepthAtWarmup = await waitForOpeningUndo(ctx)
  await warmCaretIndex(ctx)
  await selectTarget(ctx, near)
  const undoDepthAtRequest = await undoDepth(ctx)
  record('caret_warmup', { undoDepthAtWarmup, undoDepthAtRequest })
  expect(undoDepthAtRequest).toBe(undoDepthAtWarmup)
  return undoDepthAtRequest
}

async function exactEquals(ctx: Context, source: string) {
  await expect
    .poll(
      () =>
        ctx.frame
          .locator('body')
          .evaluate(
            (_body, expected) =>
              (window as any).__vmdeE2EExactMarkdown() === expected,
            source,
          ),
      { timeout: 5_000 },
    )
    .toBe(true)
}

async function hostState(ctx: Context) {
  return ctx.evaluateInVSCode(
    (vscode: typeof import('vscode'), [file]: [string]) => {
      const doc = vscode.workspace.textDocuments.find(
        (value) => value.uri.fsPath === file,
      )
      return { version: doc?.version ?? -1, dirty: doc?.isDirty ?? false }
    },
    [ctx.file],
  )
}

async function verifyRedoReopen(ctx: Context, plan: string) {
  await focusEditor(ctx)
  await ctx.xtest.key('ctrl+y')
  expect(await hostEquals(ctx, plan)).toBe(true)
  await exactEquals(ctx, plan)
  expect(await saveAndCompare(ctx, plan)).toBe(true)
  ctx.frame = await reopenVmdeFixture(
    ctx.evaluateInVSCode,
    ctx.workbox,
    ctx.file,
    90_000,
    '.vditor-ir',
  )
  await waitForE2EReadiness(
    ctx.frame,
    (state) =>
      state.routerReady && state.editorEpoch > 0 && state.mode === 'ir',
    { timeout: 90_000, message: 'Task 604 redo reopen readiness' },
  )
  expect(await hostEquals(ctx, plan)).toBe(true)
  expect(readFileSync(ctx.file, 'utf8') === plan).toBe(true)
  record('redo_reopen', { hostMatchesPlan: true, diskMatchesPlan: true })
}

test.describe('Task 604 real VS Code regression', () => {
  test.skip(
    process.env.VMDE_XTEST !== '1',
    'requires the isolated Xvfb/Openbox XTEST session',
  )

  for (const [id, mode, viaFind] of [
    ['R1', 'ir', false],
    ['R2', 'ir', true],
    ['R3', 'wysiwyg', false],
    ['R4', 'wysiwyg', true],
  ] as const) {
    test(`${id} ${mode} ${viaFind ? 'Find' : 'caret'} opens Turn Into and preserves exact save/Undo`, async ({
      workbox,
      electronApp,
      evaluateInVSCode,
      baseDir,
    }) => {
      const args = { workbox, electronApp, evaluateInVSCode, baseDir }
      test.setTimeout(240_000)
      startReport(`s6-${id.toLowerCase()}`, 'cp2')
      const ctx = await openFixture(args, FIXTURE, mode, id.toLowerCase())
      const openingUndoDepth = await prepareCapture(ctx, viaFind)
      const opened = await requestPositive(ctx)
      record(
        'selection_after_request',
        await selectionState(ctx, viaFind ? TOKEN : ''),
      )
      await unchanged(ctx)
      assertRequestBudget(opened.work, viaFind)
      expect(opened.value.quickPickOpened).toBe(true)
      expect(
        opened.value.currentTypeIsParagraph && opened.value.heading2Offered,
      ).toBe(true)
      if (!viaFind) {
        await ctx.workbox.mouse.move(0, 0)
        await beginWork(ctx)
        await warmCaretIndex(ctx)
        const hover = await endWork(ctx)
        recordWork('post_request_hover', hover)
        expect(hover.indexBuilds).toBe(0)
      }
      await beginWork(ctx)
      await chooseHeading2(ctx)
      const plan = headingPlan(FIXTURE, viaFind ? far : near)
      const applied = await hostEquals(ctx, plan)
      recordWork('choice_work', await endWork(ctx))
      record('apply_host', applied)
      // A silent Find-route choice is the N3(iii) stop condition; retain the work evidence.
      expect(applied).toBe(true)
      const saved = await saveAndCompare(ctx, plan)
      record('apply_disk', saved)
      expect(saved).toBe(true)
      await expect
        .poll(() => undoDepth(ctx), { timeout: 10_000 })
        .toBeGreaterThan(openingUndoDepth)
      record('undo_checkpoints', {
        openingUndoDepth,
        appliedUndoDepth: await undoDepth(ctx),
      })
      record('host_before_undo', await hostState(ctx))
      await focusEditor(ctx)
      await ctx.xtest.key('ctrl+z')
      const restored = await hostEquals(ctx, FIXTURE)
      record('host_after_undo', await hostState(ctx))
      const restoredDisk = await saveAndCompare(ctx, FIXTURE)
      record('undo', { hostRestored: restored, diskRestored: restoredDisk })
      expect(restored && restoredDisk).toBe(true)
      await exactEquals(ctx, FIXTURE)
      record('exact_after_undo', true)
      if (id === 'R1') await verifyRedoReopen(ctx, plan)
    })
  }
})
