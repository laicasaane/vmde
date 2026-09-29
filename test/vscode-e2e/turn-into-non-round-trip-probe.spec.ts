import { expect, test } from 'vscode-test-playwright'
import { FIXTURE } from './find-replace-fixture-helpers'
import {
  SMALL,
  modeMeasurements,
  openFixture,
  readLengths,
  record,
  registerReportHooks,
  selectionRoute,
  smallHistoryControl,
  smallTarget,
  startReport,
  switchMode,
  trustedEditControl,
  unchanged,
} from './turn-into-non-round-trip-helpers'

registerReportHooks()

test.describe('Task 604 real VS Code measurements @probe', () => {
  test.skip(
    process.env.VMDE_XTEST !== '1',
    'requires the isolated Xvfb/Openbox XTEST session',
  )

  test('R0 A @probe measures IR, WYSIWYG and switched SV', async ({
    workbox,
    electronApp,
    evaluateInVSCode,
    baseDir,
  }) => {
    const args = { workbox, electronApp, evaluateInVSCode, baseDir }
    test.setTimeout(420_000)
    startReport('r0-a')
    const ctx = await openFixture(args, FIXTURE, 'ir', 'large-a')
    record('scope', {
      diagnosticAtSourceLegRun: false,
      largeNonRoundTripUndoMeasured: false,
      smallHistoryControlInBootC: true,
    })
    await modeMeasurements(ctx, 'ir')
    for (const mode of ['wysiwyg', 'sv'] as const) {
      await switchMode(ctx, mode)
      await modeMeasurements(ctx, mode)
    }
    await unchanged(ctx)
  })

  test('R0 B @probe measures direct SV and its round-trip control', async ({
    workbox,
    electronApp,
    evaluateInVSCode,
    baseDir,
  }) => {
    const args = { workbox, electronApp, evaluateInVSCode, baseDir }
    test.setTimeout(300_000)
    startReport('r0-b')
    const ctx = await openFixture(args, FIXTURE, 'sv', 'large-b')
    await modeMeasurements(ctx, 'sv_direct')
    const small = await openFixture(args, SMALL, 'sv', 'small-sv')
    record('sv_small_lengths', await readLengths(small))
    record(
      'sv_small_selection',
      await selectionRoute(small, smallTarget, 'caret'),
    )
    await unchanged(small)
  })

  test('R0 C @probe checks the real apply/Undo ceiling and trusted-edit control', async ({
    workbox,
    electronApp,
    evaluateInVSCode,
    baseDir,
  }) => {
    const args = { workbox, electronApp, evaluateInVSCode, baseDir }
    test.setTimeout(540_000)
    startReport('s0b-r0-c-r1', 'cp2')
    const small = await openFixture(args, SMALL, 'ir', 'small-ir')
    await smallHistoryControl(small)
    await unchanged(small)
    const addRange = await openFixture(
      args,
      FIXTURE,
      'ir',
      'trusted-edit-add-range',
    )
    const addRangeResult = await trustedEditControl(addRange, 'addRange')
    await unchanged(addRange)
    const requestCaret = await openFixture(
      args,
      FIXTURE,
      'ir',
      'trusted-edit-request-caret',
    )
    const requestCaretResult = await trustedEditControl(
      requestCaret,
      'requestCaret',
      true,
    )
    await unchanged(requestCaret)
    record('trusted_edit_setup_comparison', {
      addRange: addRangeResult,
      requestCaret: requestCaretResult,
    })
    expect(
      addRangeResult.quickPickOpened &&
        addRangeResult.currentTypeIsParagraph &&
        requestCaretResult.quickPickOpened &&
        requestCaretResult.currentTypeIsParagraph &&
        requestCaretResult.heading2Applied &&
        requestCaretResult.hostOutsideBlockMeasured,
    ).toBe(true)
  })
})
