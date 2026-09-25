import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { expect, test } from 'vscode-test-playwright'
import { createXtestInput } from './helpers/xtest-input'
import {
  docText,
  reopenVmdeFixture,
  waitForE2EReadiness,
  wf,
} from './webview-helpers'
import {
  installSelectionPerformanceProbe,
  type SelectionPerformanceProbeResult,
} from './selection-performance-probe'

const FIXTURE = path.join(
  __dirname,
  'fixtures',
  'large-observable-models-synthetic.md',
)
const FIXTURE_SHA256 = 'a4a39d6f6c605eb82b0e03a236f67388bceeae9a85450b0d4285053b28299f65'
const STEPS = 12
const OBSERVATION_MS = 500

type Mode = 'ir' | 'wysiwyg'
type InputKind = 'cold-hover' | 'drag' | 'slow-keyboard' | 'burst-keyboard'

interface SelectionMeasurement extends SelectionPerformanceProbeResult {
  mode: Mode
  input: InputKind
  selectedLength: number
  forward: boolean
  detailsEnabled: boolean
  bubbleVisible: boolean
  hostUnchanged: boolean
  hostDocumentFound: boolean
  hostTextLength: number
  diskUnchanged: boolean
  maxKeyGapMs: number
}

function summary(result: SelectionMeasurement) {
  const gaps = [...result.frameGapsMs].sort((a, b) => a - b)
  return {
    mode: result.mode,
    input: result.input,
    workloadMs: result.elapsedWorkloadMs,
    observedMs: result.elapsedObservedMs,
    selectionEvents: result.selectionEvents,
    selectedLength: result.selectedLength,
    forward: result.forward,
    fullGetValueCalls: result.fullGetValueCalls,
    liveMarkerInsertions: result.liveMarkerInsertions,
    rangeInsertCalls: result.rangeInsertCalls,
    luteEntryPoints: result.luteEntryPoints,
    rootLuteCalls: result.rootLuteCalls,
    fragmentLuteCalls: result.fragmentLuteCalls,
    blockHandleSnapshots: result.blockHandleSnapshots,
    blockHandleProofs: result.blockHandleProofs,
    sampledFrames: result.sampledFrames,
    rafP95Ms: gaps[Math.max(0, Math.ceil(gaps.length * 0.95) - 1)] ?? 0,
    rafMaxMs: gaps.at(-1) ?? 0,
    longTasks: result.longTaskDurationsMs.length,
    longTaskMs: Math.round(
      result.longTaskDurationsMs.reduce((sum, duration) => sum + duration, 0),
    ),
    maxKeyGapMs: result.maxKeyGapMs,
    detailsEnabled: result.detailsEnabled,
    bubbleVisible: result.bubbleVisible,
    hostUnchanged: result.hostUnchanged,
    hostDocumentFound: result.hostDocumentFound,
    hostTextLength: result.hostTextLength,
    diskUnchanged: result.diskUnchanged,
  }
}

async function readSelection(frame: ReturnType<typeof wf>) {
  return frame.locator('body').evaluate(() => {
    const selection = window.getSelection()
    if (!selection || selection.isCollapsed || !selection.anchorNode || !selection.focusNode)
      return { length: 0, forward: false }
    const ordered = document.createRange()
    ordered.setStart(selection.anchorNode, selection.anchorOffset)
    ordered.setEnd(selection.focusNode, selection.focusOffset)
    return { length: selection.toString().length, forward: !ordered.collapsed }
  })
}

async function nextProbe(frame: ReturnType<typeof wf>) {
  await frame
    .locator('body')
    .evaluate(() => (window as any).__selectionPerformanceProbe.start())
}

async function endWorkload(frame: ReturnType<typeof wf>) {
  await frame
    .locator('body')
    .evaluate(() => (window as any).__selectionPerformanceProbe.endWorkload())
}

async function stopProbe(frame: ReturnType<typeof wf>) {
  await frame
    .locator('body')
    .evaluate(
      (_body, duration) => new Promise((resolve) => setTimeout(resolve, duration)),
      OBSERVATION_MS,
    )
  return frame
    .locator('body')
    .evaluate(() => (window as any).__selectionPerformanceProbe.stop()) as Promise<SelectionPerformanceProbeResult>
}

async function sourceIsUnchanged(
  frame: ReturnType<typeof wf>,
  evaluateInVSCode: (fn: unknown, args?: unknown[]) => Promise<unknown>,
  file: string,
  initial: string,
): Promise<{
  host: boolean
  hostDocumentFound: boolean
  hostTextLength: number
  disk: boolean
}> {
  const hostText = (await docText(evaluateInVSCode as never, file)) as string
  return {
    host: hostText === initial,
    hostDocumentFound: hostText.length > 0,
    hostTextLength: hostText.length,
    disk: readFileSync(file, 'utf8') === initial,
  }
}

async function measureDrag(
  workbox: import('@playwright/test').Page,
  frame: ReturnType<typeof wf>,
  paragraph: import('@playwright/test').Locator,
  mode: Mode,
  file: string,
  initial: string,
  evaluateInVSCode: (fn: unknown, args?: unknown[]) => Promise<unknown>,
): Promise<SelectionMeasurement> {
  const box = await paragraph.boundingBox()
  if (!box) throw new Error('selection paragraph has no layout box')
  const y = box.y + Math.min(box.height / 2, 12)
  const startX = box.x + 6
  const endX = Math.min(startX + 12 * 7, box.x + box.width - 2)
  await workbox.mouse.move(startX, y)
  await nextProbe(frame)
  await workbox.mouse.down()
  for (let step = 1; step <= STEPS; step++) {
    await workbox.mouse.move(startX + ((endX - startX) * step) / STEPS, y)
    if (step < STEPS) await new Promise((resolve) => setTimeout(resolve, 60))
  }
  await workbox.mouse.up()
  await endWorkload(frame)
  const result = await stopProbe(frame)
  const selected = await readSelection(frame)
  const source = await sourceIsUnchanged(frame, evaluateInVSCode, file, initial)
  return {
    ...result,
    mode,
    input: 'drag',
    selectedLength: selected.length,
    forward: selected.forward,
    detailsEnabled: await frame.locator('.vditor-toolbar [data-type="details"]').first().isEnabled(),
    bubbleVisible: await frame.locator('.vmde-selection-bubble').isVisible(),
    hostUnchanged: source.host,
    hostDocumentFound: source.hostDocumentFound,
    hostTextLength: source.hostTextLength,
    diskUnchanged: source.disk,
    maxKeyGapMs: 0,
  }
}

async function placeCaretAtParagraphStart(
  workbox: import('@playwright/test').Page,
  frame: ReturnType<typeof wf>,
  paragraph: import('@playwright/test').Locator,
  xtest: Awaited<ReturnType<typeof createXtestInput>>,
): Promise<void> {
  await paragraph.click({ position: { x: 6, y: 8 } })
  await xtest.key('Home')
  await frame
    .locator('body')
    .evaluate(() => new Promise((resolve) => setTimeout(resolve, 50)))
  void workbox
}

async function measureKeyboard(
  workbox: import('@playwright/test').Page,
  frame: ReturnType<typeof wf>,
  paragraph: import('@playwright/test').Locator,
  mode: Mode,
  kind: 'slow-keyboard' | 'burst-keyboard',
  xtest: Awaited<ReturnType<typeof createXtestInput>>,
  file: string,
  initial: string,
  evaluateInVSCode: (fn: unknown, args?: unknown[]) => Promise<unknown>,
): Promise<SelectionMeasurement> {
  await placeCaretAtParagraphStart(workbox, frame, paragraph, xtest)
  await nextProbe(frame)
  if (kind === 'slow-keyboard') {
    for (let step = 0; step < STEPS; step++) {
      await xtest.key('shift+Right')
      if (step < STEPS - 1)
        await new Promise((resolve) => setTimeout(resolve, 60))
    }
  } else {
    for (let step = 0; step < STEPS; step++) await xtest.key('shift+Right')
  }
  await endWorkload(frame)
  const result = await stopProbe(frame)
  const selected = await readSelection(frame)
  const source = await sourceIsUnchanged(frame, evaluateInVSCode, file, initial)
  const keyGaps = result.shiftRightKeyTimesMs
    .slice(1)
    .map((time, index) => time - result.shiftRightKeyTimesMs[index])
  return {
    ...result,
    mode,
    input: kind,
    selectedLength: selected.length,
    forward: selected.forward,
    detailsEnabled: await frame.locator('.vditor-toolbar [data-type="details"]').first().isEnabled(),
    bubbleVisible: await frame.locator('.vmde-selection-bubble').isVisible(),
    hostUnchanged: source.host,
    hostDocumentFound: source.hostDocumentFound,
    hostTextLength: source.hostTextLength,
    diskUnchanged: source.disk,
    maxKeyGapMs: Math.max(0, ...keyGaps),
  }
}

async function measureColdHover(
  workbox: import('@playwright/test').Page,
  frame: ReturnType<typeof wf>,
  paragraph: import('@playwright/test').Locator,
  mode: Mode,
  file: string,
  initial: string,
  evaluateInVSCode: (fn: unknown, args?: unknown[]) => Promise<unknown>,
): Promise<SelectionMeasurement> {
  await workbox.mouse.move(1, 1)
  await nextProbe(frame)
  await paragraph.hover()
  await endWorkload(frame)
  const result = await stopProbe(frame)
  const source = await sourceIsUnchanged(frame, evaluateInVSCode, file, initial)
  return {
    ...result,
    mode,
    input: 'cold-hover',
    selectedLength: 0,
    forward: false,
    detailsEnabled: true,
    bubbleVisible: false,
    hostUnchanged: source.host,
    hostDocumentFound: source.hostDocumentFound,
    hostTextLength: source.hostTextLength,
    diskUnchanged: source.disk,
    maxKeyGapMs: 0,
  }
}

test.describe('Task 574 OS-level selection acceptance', () => {
  test.skip(
    process.env.VMDE_XTEST !== '1',
    'requires isolated Xvfb/Openbox XTEST',
  )

  test('large document selection stays responsive without passive source work', async ({
    workbox,
    electronApp,
    evaluateInVSCode,
    baseDir,
  }) => {
    test.setTimeout(300_000)
    const initial = readFileSync(FIXTURE, 'utf8')
    expect(createHash('sha256').update(initial).digest('hex')).toBe(FIXTURE_SHA256)
    const file = path.join(baseDir, 'selection-performance-synthetic.md')
    writeFileSync(file, initial)
    await workbox.context().addInitScript(() => {
      ;(window as any).__vmdeBlockHandleCacheMetrics = {
        blockHandleSnapshotCalls: 0,
        blockTransformCaptureCalls: 0,
      }
    })
    await evaluateInVSCode(async (vscode) => {
      await vscode.extensions.getExtension('Laicasaane.vmde')?.activate()
      await vscode.workspace
        .getConfiguration('vmde')
        .update('editor.defaultMode', 'ir', true)
      await vscode.workspace
        .getConfiguration('vmde')
        .update('restorePosition', false, true)
    })
    await evaluateInVSCode(
      async (vscode, [uri]: [string]) => {
        await vscode.commands.executeCommand(
          'vscode.openWith',
          vscode.Uri.file(uri),
          'vmde.editor',
        )
      },
      [file] as [string],
    )
    const frame = wf(workbox)
    await waitForE2EReadiness(
      frame,
      (state) => state.editorEpoch > 0 && state.mode === 'ir',
      {
        timeout: 90_000,
        message: 'Task 574 large synthetic fixture readiness',
      },
    )
    try {
      await expect
        .poll(
          async () => (
            ((await docText(evaluateInVSCode as never, file)) as string) ===
            initial
          ),
          { timeout: 60_000, message: 'host text matches synthetic fixture' },
        )
        .toBe(true)
    } catch (error) {
      const hostMetadata = await evaluateInVSCode(
        async (vscode: typeof import('vscode'), [uri]: [string]) => {
          const document = vscode.workspace.textDocuments.find(
            (candidate) => candidate.uri.fsPath === uri,
          )
          return {
            found: Boolean(document),
            length: document?.getText().length ?? -1,
            dirty: document?.isDirty ?? false,
          }
        },
        [file] as [string],
      )
      console.log('[Task 574 host baseline diagnostics]', JSON.stringify(hostMetadata))
      throw error
    }
    await frame
      .locator('body')
      .evaluate(installSelectionPerformanceProbe, initial)
    const xtest = await createXtestInput(electronApp, workbox)
    expect(xtest.client.visible).toBe(true)
    await xtest.activateAndFocus()

    const measurements: SelectionMeasurement[] = []
    for (const mode of ['ir', 'wysiwyg'] as const) {
      if (mode === 'wysiwyg') {
        await frame.locator('.vditor-toolbar [data-type="edit-mode"]').click()
        await frame.locator('button[data-mode="wysiwyg"]').click()
        await waitForE2EReadiness(frame, (state) => state.mode === 'wysiwyg', {
          message: 'Task 574 WYSIWYG selection readiness',
        })
      }
      const paragraph = frame
        .locator(`.vditor-${mode} .vditor-reset > p`)
        .first()
      await expect(paragraph).toBeVisible()

      const cold = await measureColdHover(
        workbox,
        frame,
        paragraph,
        mode,
        file,
        initial,
        evaluateInVSCode,
      )
      measurements.push(cold)
      const box = await paragraph.boundingBox()
      if (!box) throw new Error('selection paragraph has no layout box')
      await workbox.mouse.move(box.x + 8, box.y + 10)
      await workbox.mouse.move(box.x + 9, box.y + 10)
      await frame
        .locator('body')
        .evaluate(() => new Promise((resolve) => setTimeout(resolve, 100)))

      measurements.push(
        await measureDrag(
          workbox,
          frame,
          paragraph,
          mode,
          file,
          initial,
          evaluateInVSCode,
        ),
      )
      measurements.push(
        await measureKeyboard(
          workbox,
          frame,
          paragraph,
          mode,
          'slow-keyboard',
          xtest,
          file,
          initial,
          evaluateInVSCode,
        ),
      )
      measurements.push(
        await measureKeyboard(
          workbox,
          frame,
          paragraph,
          mode,
          'burst-keyboard',
          xtest,
          file,
          initial,
          evaluateInVSCode,
        ),
      )
    }

    const passive = measurements.filter((entry) => entry.input !== 'cold-hover')
    const drag = measurements.filter((entry) => entry.input === 'drag')
    const metrics = {
      passive: {
        fullGetValueCalls: passive.reduce((sum, entry) => sum + entry.fullGetValueCalls, 0),
        liveMarkerInsertions: passive.reduce((sum, entry) => sum + entry.liveMarkerInsertions, 0),
        sampledFrames: passive.reduce((sum, entry) => sum + entry.sampledFrames, 0),
      },
      drag: {
        blockHandleSnapshots: drag.reduce((sum, entry) => sum + entry.blockHandleSnapshots, 0),
        blockHandleProofs: drag.reduce((sum, entry) => sum + entry.blockHandleProofs, 0),
      },
    }
    console.log(
      '[Task 574 OS selection performance]',
      JSON.stringify({
        fixtureBytes: Buffer.byteLength(initial, 'utf8'),
        fixtureSha256: FIXTURE_SHA256,
        xtestClient: { visible: xtest.client.visible, title: xtest.client.title },
        measurements: measurements.map(summary),
        metrics,
      }),
    )

    expect(
      measurements
        .filter((entry) => entry.input !== 'cold-hover')
        .every((entry) => entry.selectedLength > 0 && entry.forward),
    ).toBe(true)
    expect(measurements.every((entry) => entry.hostUnchanged && entry.diskUnchanged)).toBe(true)
    expect(measurements.every((entry) => entry.sampledFrames > 0)).toBe(true)
    expect(measurements.filter((entry) => entry.input === 'slow-keyboard').every((entry) => entry.shiftRightKeyTimesMs.length === STEPS)).toBe(true)
    expect(measurements.filter((entry) => entry.input === 'drag').every((entry) => entry.detailsEnabled && entry.bubbleVisible)).toBe(true)
    expect(metrics.passive.fullGetValueCalls).toBe(0)
    expect(metrics.passive.liveMarkerInsertions).toBe(0)
    expect(metrics.drag.blockHandleSnapshots).toBe(0)
    expect(metrics.drag.blockHandleProofs).toBe(0)
    expect(metrics.passive.sampledFrames).toBeGreaterThan(0)
    expect(measurements.filter((entry) => entry.input === 'burst-keyboard').every((entry) => entry.maxKeyGapMs < 32)).toBe(true)

    await evaluateInVSCode(async (vscode) => {
      await vscode.commands.executeCommand('workbench.action.files.save')
    })
    expect(readFileSync(file, 'utf8') === initial).toBe(true)
    const reopened = await reopenVmdeFixture(
      evaluateInVSCode as never,
      workbox,
      file,
      60_000,
    )
    await waitForE2EReadiness(reopened, (state) => state.editorEpoch > 0, {
      message: 'Task 574 reopened selection fixture readiness',
    })
    const reopenedText = (await docText(evaluateInVSCode as never, file)) as string
    expect(reopenedText === initial && readFileSync(file, 'utf8') === initial).toBe(true)
  })
})
