import { expect, test } from 'vscode-test-playwright'
import { FIXTURE } from './find-replace-fixture-helpers'
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
  requestAndMeasure,
  saveAndCompare,
  selectTarget,
  selectionState,
  startReport,
  unchanged,
} from './turn-into-non-round-trip-helpers'

registerReportHooks()

test.describe('Task 604 real VS Code regression', () => {
  test.skip(
    process.env.VMDE_XTEST !== '1',
    'requires the isolated Xvfb/Openbox XTEST session',
  )

  for (const viaFind of [false, true]) {
    const id = viaFind ? 'R2' : 'R1'
    test(`${id} IR ${viaFind ? 'Find' : 'caret'} opens Turn Into and preserves exact save/Undo`, async ({
      workbox,
      electronApp,
      evaluateInVSCode,
      baseDir,
    }) => {
      const args = { workbox, electronApp, evaluateInVSCode, baseDir }
      test.setTimeout(180_000)
      startReport(id.toLowerCase())
      const ctx = await openFixture(args, FIXTURE, 'ir', id.toLowerCase())
      if (viaFind) record('find_setup', await findFar(ctx))
      else await selectTarget(ctx, near)
      const opened = await requestAndMeasure(ctx)
      record('native_request', opened)
      record(
        'selection_after_request',
        await selectionState(ctx, viaFind ? TOKEN : ''),
      )
      await unchanged(ctx)
      test.fail(
        true,
        'Task 604: non-round-tripping exact source currently declines capture',
      )
      expect(opened.value.quickPickOpened).toBe(true)
      expect(
        opened.value.currentTypeIsParagraph && opened.value.heading2Offered,
      ).toBe(true)
      await chooseHeading2(ctx)
      const plan = headingPlan(FIXTURE, viaFind ? far : near)
      const applied = await hostEquals(ctx, plan)
      record('apply_host', applied)
      expect(applied).toBe(true)
      const saved = await saveAndCompare(ctx, plan)
      record('apply_disk', saved)
      expect(saved).toBe(true)
      await focusEditor(ctx)
      await ctx.xtest.key('ctrl+z')
      const restored = await hostEquals(ctx, FIXTURE)
      const restoredDisk = await saveAndCompare(ctx, FIXTURE)
      record('undo', { hostRestored: restored, diskRestored: restoredDisk })
      expect(restored && restoredDisk).toBe(true)
    })
  }
})
