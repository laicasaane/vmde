import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { expect, test } from 'vscode-test-playwright'
import { createXtestInput } from './helpers/xtest-input'
import {
  docText,
  reopenVmdeFixture,
  settle,
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
const FIXTURE_SHA256 =
  'a4a39d6f6c605eb82b0e03a236f67388bceeae9a85450b0d4285053b28299f65'
const STEPS = 12
const OBSERVATION_MS = 500

type Mode = 'ir' | 'wysiwyg'
type InputKind =
  | 'cold-hover'
  | 'cold-edit-hover'
  | 'cold-edit-selection'
  | 'drag'
  | 'slow-keyboard'
  | 'burst-keyboard'

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
  /** Task 577 Checkpoint 1: whether the shared source index was warmed by a prior read before
   * this phase's workload began (cold = the first read since a fresh revision or mode switch). */
  warmth: 'warm' | 'cold'
  documentSize: 'large' | 'small'
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
    indexBuilds: result.indexBuilds,
    indexBuildsInstrumented: result.indexBuildsInstrumented,
    sampledFrames: result.sampledFrames,
    rafP95Ms: gaps[Math.max(0, Math.ceil(gaps.length * 0.95) - 1)] ?? 0,
    rafMaxMs: gaps.at(-1) ?? 0,
    longTasks: result.longTaskDurationsMs.length,
    longTaskMs: Math.round(
      result.longTaskDurationsMs.reduce((sum, duration) => sum + duration, 0),
    ),
    maxKeyGapMs: result.maxKeyGapMs,
    warmth: result.warmth,
    documentSize: result.documentSize,
    detailsEnabled: result.detailsEnabled,
    bubbleVisible: result.bubbleVisible,
    hostUnchanged: result.hostUnchanged,
    hostDocumentFound: result.hostDocumentFound,
    hostTextLength: result.hostTextLength,
    diskUnchanged: result.diskUnchanged,
    // Task 577 Checkpoint 1 settle recorder — see selection-performance-probe.ts.
    settleObserved: result.settleObserved,
    settleBubblePresent: result.settleBubblePresent,
    releaseToShowMs: result.releaseToShowMs,
    releaseToVisibleFrameMs: result.releaseToVisibleFrameMs,
    settleLongestTaskMs: result.settleLongestTaskMs,
    settleMaxRafGapMs: result.settleMaxRafGapMs,
    settleIndexBuildsBeforeVisible: result.settleIndexBuildsBeforeVisible,
    settleFullGetValueBeforeVisible: result.settleFullGetValueBeforeVisible,
    settleLiveMarkersBeforeVisible: result.settleLiveMarkersBeforeVisible,
    settleBubbleTogglesBeforeVisible: result.settleBubbleTogglesBeforeVisible,
    settleIndexBuildsAfterVisible: result.settleIndexBuildsAfterVisible,
    settleFullGetValueAfterVisible: result.settleFullGetValueAfterVisible,
    settleLiveMarkersAfterVisible: result.settleLiveMarkersAfterVisible,
    settleBubbleTogglesAfterVisible: result.settleBubbleTogglesAfterVisible,
  }
}

async function readSelection(frame: ReturnType<typeof wf>) {
  return frame.locator('body').evaluate(() => {
    const selection = window.getSelection()
    if (
      !selection ||
      selection.isCollapsed ||
      !selection.anchorNode ||
      !selection.focusNode
    )
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
      (_body, duration) =>
        new Promise((resolve) => setTimeout(resolve, duration)),
      OBSERVATION_MS,
    )
  return frame
    .locator('body')
    .evaluate(() =>
      (window as any).__selectionPerformanceProbe.stop(),
    ) as Promise<SelectionPerformanceProbeResult>
}

async function sourceIsUnchanged(
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
  // Task 577 Checkpoint 1: a genuinely cold drag must arm the probe BEFORE the mouse first
  // approaches the paragraph — that approach move is itself a block-handle hover that can build
  // the index, so arming after it (the pre-existing warm-drag order) would hide that cost from
  // the counters instead of attributing it.
  warmth: SelectionMeasurement['warmth'] = 'warm',
  documentSize: SelectionMeasurement['documentSize'] = 'large',
): Promise<SelectionMeasurement> {
  const box = await paragraph.boundingBox()
  if (!box) throw new Error('selection paragraph has no layout box')
  // A mousedown inside an existing selection starts native text drag-and-drop instead of a new
  // selection, so collapse whatever an earlier phase left before the gesture begins.
  await frame
    .locator('body')
    .evaluate(() => window.getSelection()?.removeAllRanges())
  await settle(frame, 100)
  const y = box.y + Math.min(box.height / 2, 12)
  const startX = box.x + 6
  const endX = Math.min(startX + 12 * 7, box.x + box.width - 2)
  if (warmth === 'cold') await nextProbe(frame)
  await workbox.mouse.move(startX, y)
  if (warmth === 'warm') await nextProbe(frame)
  await workbox.mouse.down()
  for (let step = 1; step <= STEPS; step++) {
    await workbox.mouse.move(startX + ((endX - startX) * step) / STEPS, y)
    if (step < STEPS) await new Promise((resolve) => setTimeout(resolve, 60))
  }
  await workbox.mouse.up()
  await endWorkload(frame)
  const result = await stopProbe(frame)
  const selected = await readSelection(frame)
  const source = await sourceIsUnchanged(evaluateInVSCode, file, initial)
  return {
    ...result,
    mode,
    input: 'drag',
    warmth,
    documentSize,
    selectedLength: selected.length,
    forward: selected.forward,
    detailsEnabled: await frame
      .locator('.vditor-toolbar [data-type="details"]')
      .first()
      .isEnabled(),
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
  caret: 'click' | 'script' = 'click',
  warmth: SelectionMeasurement['warmth'] = 'warm',
  documentSize: SelectionMeasurement['documentSize'] = 'large',
): Promise<SelectionMeasurement> {
  if (caret === 'script') await placeCaretByScript(frame, paragraph)
  else await placeCaretAtParagraphStart(workbox, frame, paragraph, xtest)
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
  const source = await sourceIsUnchanged(evaluateInVSCode, file, initial)
  const keyGaps = result.shiftRightKeyTimesMs
    .slice(1)
    .map((time, index) => time - result.shiftRightKeyTimesMs[index])
  return {
    ...result,
    mode,
    input: kind,
    warmth,
    documentSize,
    selectedLength: selected.length,
    forward: selected.forward,
    detailsEnabled: await frame
      .locator('.vditor-toolbar [data-type="details"]')
      .first()
      .isEnabled(),
    bubbleVisible: await frame.locator('.vmde-selection-bubble').isVisible(),
    hostUnchanged: source.host,
    hostDocumentFound: source.hostDocumentFound,
    hostTextLength: source.hostTextLength,
    diskUnchanged: source.disk,
    maxKeyGapMs: Math.max(0, ...keyGaps),
  }
}

/**
 * Puts a collapsed caret at the paragraph start without any mouse movement. A click would also fire
 * a block-handle hover, warming the source index before the cold-selection measurement starts.
 */
async function placeCaretByScript(
  frame: ReturnType<typeof wf>,
  paragraph: import('@playwright/test').Locator,
  edge: 'start' | 'end' = 'start',
): Promise<void> {
  const placed = await paragraph.evaluate((element, atEnd) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
    let text = walker.nextNode() as Text | null
    for (
      let next = text;
      next && atEnd;
      next = walker.nextNode() as Text | null
    )
      text = next
    const selection = window.getSelection()
    if (!text || !selection) return false
    const range = document.createRange()
    range.setStart(text, atEnd ? text.length : 0)
    range.collapse(true)
    selection.removeAllRanges()
    selection.addRange(range)
    ;(element as HTMLElement).focus()
    return true
  }, edge === 'end')
  expect(placed).toBe(true)
  // Negative-observation wait: let the collapsed-selection selectionchange handlers run before
  // the caller arms the probe, so they are not counted as selection work.
  await settle(frame, 100)
}

/**
 * Negative-observation wait: edit-sync's trailing idle post has no completion marker, so require
 * 600 ms (more than twice the idle debounce) with no further full getValue call. Needs an armed probe.
 */
async function waitForEditSyncQuiet(
  frame: ReturnType<typeof wf>,
): Promise<void> {
  await frame.locator('body').evaluate(async () => {
    const probe = (window as any).__selectionPerformanceProbe
    let last = probe.fullGetValueCalls()
    let quietSince = performance.now()
    const deadline = quietSince + 15_000
    while (performance.now() - quietSince < 600) {
      if (performance.now() > deadline)
        throw new Error('edit-sync did not go quiet after edit and Undo')
      await new Promise((resolve) => setTimeout(resolve, 50))
      const now = probe.fullGetValueCalls()
      if (now !== last) {
        last = now
        quietSince = performance.now()
      }
    }
  })
}

/**
 * One OS-level keystroke then Undo restores the exact bytes but advances the source revision, so the
 * next hover or selection is a cold proof (the Task 573 residual). Returns after edit-sync has gone
 * quiet: its 250 ms idle post runs a full serialization that must not be counted as hover work.
 */
async function editThenUndo(
  workbox: import('@playwright/test').Page,
  frame: ReturnType<typeof wf>,
  paragraph: import('@playwright/test').Locator,
  xtest: Awaited<ReturnType<typeof createXtestInput>>,
  file: string,
  initial: string,
  evaluateInVSCode: (fn: unknown, args?: unknown[]) => Promise<unknown>,
): Promise<void> {
  // A real click gives the webview OS-level keyboard focus; its hover and selection work happens
  // before the Undo below advances the source revision, so it cannot warm the measured phase.
  await paragraph.click({ position: { x: 6, y: 8 } })
  await placeCaretByScript(frame, paragraph, 'end')
  await nextProbe(frame)
  await xtest.type('x', 15)
  await expect
    .poll(
      async () =>
        ((await docText(evaluateInVSCode as never, file)) as string) !==
        initial,
    )
    .toBe(true)
  // Undo racing the trailing idle post yields the rendered document instead of the exact bytes.
  await waitForEditSyncQuiet(frame)
  // Save between the edit and Undo, as large-document-interaction does: the first edit posts the
  // rendered document, and only the host's document Undo restores the exact original bytes. Click
  // the editor before Undo so Ctrl+Z is routed as in that spec; any hover this causes precedes the
  // Undo that advances the revision.
  await evaluateInVSCode(async (vscode) => {
    await vscode.commands.executeCommand('workbench.action.files.save')
  })
  await paragraph.click({ position: { x: 6, y: 8 } })
  await xtest.key('ctrl+z')
  await expect
    .poll(
      async () =>
        ((await docText(evaluateInVSCode as never, file)) as string) ===
        initial,
    )
    .toBe(true)
  await evaluateInVSCode(async (vscode) => {
    await vscode.commands.executeCommand('workbench.action.files.save')
  })
  await expect.poll(() => readFileSync(file, 'utf8') === initial).toBe(true)
  await waitForEditSyncQuiet(frame)
  await stopProbe(frame)
  // Leave the editor so the next hover is a fresh mouse move rather than a resting pointer.
  await workbox.mouse.move(1, 1)
}

async function measureColdHover(
  workbox: import('@playwright/test').Page,
  frame: ReturnType<typeof wf>,
  paragraph: import('@playwright/test').Locator,
  mode: Mode,
  file: string,
  initial: string,
  evaluateInVSCode: (fn: unknown, args?: unknown[]) => Promise<unknown>,
  input: 'cold-hover' | 'cold-edit-hover' = 'cold-hover',
): Promise<SelectionMeasurement> {
  await workbox.mouse.move(1, 1)
  await nextProbe(frame)
  await paragraph.hover()
  await endWorkload(frame)
  const result = await stopProbe(frame)
  const source = await sourceIsUnchanged(evaluateInVSCode, file, initial)
  return {
    ...result,
    mode,
    input,
    warmth: 'cold',
    documentSize: 'large',
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

/**
 * Task 577 Checkpoint 1: switches the active editor mode. `getActiveRoot()` returns a different
 * persistent DOM element per mode, so every switch changes the shared source index's key (root
 * and mode both differ) and invalidates its cached entry — the first read after landing in the
 * new mode is always cold, with no edit or Undo required.
 */
async function switchEditorMode(
  frame: ReturnType<typeof wf>,
  mode: Mode,
): Promise<void> {
  await frame.locator('.vditor-toolbar [data-type="edit-mode"]').click()
  await frame.locator(`button[data-mode="${mode}"]`).click()
  await waitForE2EReadiness(frame, (state) => state.mode === mode, {
    message: `Task 577 switch to ${mode}`,
  })
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
    // Task 577 Checkpoint 1 added several more phases (cold drag x2, cold WYSIWYG keyboard, and a
    // second small-document editor session) on top of Task 574's original budget.
    test.setTimeout(480_000)
    const initial = readFileSync(FIXTURE, 'utf8')
    expect(createHash('sha256').update(initial).digest('hex')).toBe(
      FIXTURE_SHA256,
    )
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
          async () =>
            ((await docText(evaluateInVSCode as never, file)) as string) ===
            initial,
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
      console.log(
        '[Task 574 host baseline diagnostics]',
        JSON.stringify(hostMetadata),
      )
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

      // Cold-after-edit runs in IR only. A WYSIWYG edit posts WYSIWYG's own serialization, so Undo
      // cannot restore this noncanonical fixture's exact bytes there; WYSIWYG cold coverage is the
      // cold-open hover after the mode switch. Each measurement gets its own edit + Undo so the
      // source revision is fresh.
      if (mode === 'ir') {
        await editThenUndo(
          workbox,
          frame,
          paragraph,
          xtest,
          file,
          initial,
          evaluateInVSCode,
        )
        measurements.push(
          await measureColdHover(
            workbox,
            frame,
            paragraph,
            mode,
            file,
            initial,
            evaluateInVSCode,
            'cold-edit-hover',
          ),
        )
        await editThenUndo(
          workbox,
          frame,
          paragraph,
          xtest,
          file,
          initial,
          evaluateInVSCode,
        )
        measurements.push({
          ...(await measureKeyboard(
            workbox,
            frame,
            paragraph,
            mode,
            'slow-keyboard',
            xtest,
            file,
            initial,
            evaluateInVSCode,
            'script',
            'cold',
          )),
          input: 'cold-edit-selection',
        })
      }

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

    // Everything above is Task 574's original phase set, whose aggregates and ceilings below are
    // an already-accepted invariant this checkpoint must not silently loosen. Everything pushed
    // from here on is new Task 577 Checkpoint 1 evidence (cold drags, cold WYSIWYG keyboard, and
    // the small control document) and is aggregated separately below so a red result names the
    // new mechanism instead of masquerading as a Task 574 regression.
    const legacyMeasurementCount = measurements.length

    // Task 577 Checkpoint 1 (b): a cold drag in IR after editThenUndo, and in WYSIWYG directly
    // after the mode switch with no hover — the drag holds the primary button, so it does not
    // warm the index itself; only the approach move before mousedown can.
    await switchEditorMode(frame, 'ir')
    const irParagraph = frame.locator('.vditor-ir .vditor-reset > p').first()
    await expect(irParagraph).toBeVisible()
    await editThenUndo(
      workbox,
      frame,
      irParagraph,
      xtest,
      file,
      initial,
      evaluateInVSCode,
    )
    measurements.push(
      await measureDrag(
        workbox,
        frame,
        irParagraph,
        'ir',
        file,
        initial,
        evaluateInVSCode,
        'cold',
      ),
    )

    // Switching straight from the just-warmed IR mode above already invalidates the shared
    // index's cached entry (root and mode both change), so this WYSIWYG entry is cold with no
    // prior hover in this mode.
    await switchEditorMode(frame, 'wysiwyg')
    const wysiwygParagraph = frame
      .locator('.vditor-wysiwyg .vditor-reset > p')
      .first()
    await expect(wysiwygParagraph).toBeVisible()
    measurements.push(
      await measureDrag(
        workbox,
        frame,
        wysiwygParagraph,
        'wysiwyg',
        file,
        initial,
        evaluateInVSCode,
        'cold',
      ),
    )

    // Task 577 Checkpoint 1 (c): a cold keyboard-only selection in WYSIWYG too — bounce through
    // IR and back so the cold drag above (which warmed WYSIWYG's entry on its approach move)
    // does not leak into this measurement.
    await switchEditorMode(frame, 'ir')
    await switchEditorMode(frame, 'wysiwyg')
    measurements.push(
      await measureKeyboard(
        workbox,
        frame,
        wysiwygParagraph,
        'wysiwyg',
        'slow-keyboard',
        xtest,
        file,
        initial,
        evaluateInVSCode,
        'script',
        'cold',
      ),
    )

    // Task 577 Checkpoint 1 (e): a small ordinary control document, opened after the large
    // fixture phases, separates fixed latency (H5) from document-size-dependent settle cost.
    // No heading: Vditor shows a floating move-up/move-down panel over headings in WYSIWYG that
    // intercepts pointer events at the exact coordinates the click-based caret placement uses.
    const smallControlContent = [
      'A short ordinary paragraph for the settle-latency control measurements.',
      '',
      'A second short paragraph, just as unremarkable as the first one above.',
      '',
    ].join('\n')
    const smallFile = path.join(
      baseDir,
      'selection-performance-control-small.md',
    )
    writeFileSync(smallFile, smallControlContent)
    const smallFrame = await reopenVmdeFixture(
      evaluateInVSCode as never,
      workbox,
      smallFile,
      60_000,
    )
    await waitForE2EReadiness(
      smallFrame,
      (state) => state.editorEpoch > 0 && state.mode === 'ir',
      { message: 'Task 577 small control fixture readiness' },
    )
    await smallFrame
      .locator('body')
      .evaluate(installSelectionPerformanceProbe, smallControlContent)
    const smallParagraphIr = smallFrame
      .locator('.vditor-ir .vditor-reset > p')
      .first()
    await expect(smallParagraphIr).toBeVisible()
    await smallParagraphIr.hover()
    measurements.push(
      await measureDrag(
        workbox,
        smallFrame,
        smallParagraphIr,
        'ir',
        smallFile,
        smallControlContent,
        evaluateInVSCode,
        'warm',
        'small',
      ),
    )
    measurements.push(
      await measureKeyboard(
        workbox,
        smallFrame,
        smallParagraphIr,
        'ir',
        'slow-keyboard',
        xtest,
        smallFile,
        smallControlContent,
        evaluateInVSCode,
        'click',
        'warm',
        'small',
      ),
    )
    await switchEditorMode(smallFrame, 'wysiwyg')
    const smallParagraphWysiwyg = smallFrame
      .locator('.vditor-wysiwyg .vditor-reset > p')
      .first()
    await expect(smallParagraphWysiwyg).toBeVisible()
    await smallParagraphWysiwyg.hover()
    measurements.push(
      await measureDrag(
        workbox,
        smallFrame,
        smallParagraphWysiwyg,
        'wysiwyg',
        smallFile,
        smallControlContent,
        evaluateInVSCode,
        'warm',
        'small',
      ),
    )
    measurements.push(
      await measureKeyboard(
        workbox,
        smallFrame,
        smallParagraphWysiwyg,
        'wysiwyg',
        'slow-keyboard',
        xtest,
        smallFile,
        smallControlContent,
        evaluateInVSCode,
        'click',
        'warm',
        'small',
      ),
    )

    // Task 574's original ceilings below are computed over its own original phase set only (see
    // the `legacyMeasurementCount` comment above) — the new Checkpoint 1 phases get their own
    // aggregate further down instead of silently feeding into (and loosening) these.
    const legacyMeasurements = measurements.slice(0, legacyMeasurementCount)
    const isCold = (entry: SelectionMeasurement) =>
      entry.input === 'cold-hover' ||
      entry.input === 'cold-edit-hover' ||
      entry.input === 'cold-edit-selection'
    const passive = legacyMeasurements.filter((entry) => !isCold(entry))
    const drag = legacyMeasurements.filter((entry) => entry.input === 'drag')
    const keyboard = legacyMeasurements.filter(
      (entry) =>
        entry.input === 'slow-keyboard' || entry.input === 'burst-keyboard',
    )
    const coldOpen = legacyMeasurements.filter(
      (entry) => entry.input === 'cold-hover',
    )
    const coldEditHover = legacyMeasurements.filter(
      (entry) => entry.input === 'cold-edit-hover',
    )
    const coldEditSelection = legacyMeasurements.filter(
      (entry) => entry.input === 'cold-edit-selection',
    )
    // Owner decision (2026-09-26): mouse drags stay at 0 full serializations/markers/index builds;
    // a keyboard phase may cost at most one index build (and the one full getValue it forces),
    // attributable to Vditor's own keydown DOM mutations (Undo.recordFirstPosition/addCaret,
    // fixCJKPosition) — see the task's "Design decisions" table. That is a PER-PHASE ceiling, not
    // an aggregate budget, so a phase that regressed to 2+ cannot hide behind other phases' zeros.
    const metrics = {
      keyboard: {
        liveMarkerInsertions: keyboard.reduce(
          (sum, entry) => sum + entry.liveMarkerInsertions,
          0,
        ),
        maxFullGetValueCallsPerPhase: Math.max(
          0,
          ...keyboard.map((entry) => entry.fullGetValueCalls),
        ),
        maxIndexBuildsPerPhase: Math.max(
          0,
          ...keyboard.map((entry) => entry.indexBuilds),
        ),
        indexBuildsInstrumented: keyboard.every(
          (entry) => entry.indexBuildsInstrumented,
        ),
      },
      drag: {
        // Real VS Code chains every phase on one live page (unlike the isolated Chromium
        // harnesses), so a native drag here follows a real prior selection. `measureDrag`
        // must collapse that selection first (a mousedown inside it would start native
        // text drag-and-drop instead of a new selection), and that collapse is itself a
        // genuine selectionchange. A stack-trace probe confirmed the one resulting index
        // build always happens strictly AFTER pointerup — from block-handle's own next
        // ordinary hover (`hover()` -> `unitAt()` -> `units()`, ready to resume once
        // `nativeSelectionSuppressesHover` sees the button released) or from Details'
        // settle-time read — never from work done while the primary button is held, and
        // the index's per-key cache caps it at one build regardless of how many consumers
        // ask. So this uses the same "at most one per phase" ceiling as the keyboard gate,
        // measured per phase (max), not summed across both modes.
        fullGetValueCalls: Math.max(
          0,
          ...drag.map((entry) => entry.fullGetValueCalls),
        ),
        liveMarkerInsertions: drag.reduce(
          (sum, entry) => sum + entry.liveMarkerInsertions,
          0,
        ),
        blockHandleSnapshots: Math.max(
          0,
          ...drag.map((entry) => entry.blockHandleSnapshots),
        ),
        // Reported, not gated to a fixed ceiling: one index build's own fragment-level proof
        // (resolveBlockHandleUnits's projection verification) scales with the fixture's block
        // count when exact !== rendered, exactly as the existing coldOpen/coldAfterEdit phases
        // already report it uncapped. It is bounded transitively by "at most one index build".
        blockHandleProofs: Math.max(
          0,
          ...drag.map((entry) => entry.blockHandleProofs),
        ),
        indexBuilds: Math.max(0, ...drag.map((entry) => entry.indexBuilds)),
      },
      passive: {
        sampledFrames: passive.reduce(
          (sum, entry) => sum + entry.sampledFrames,
          0,
        ),
      },
      coldOpen: {
        fullGetValueCalls: Math.max(
          0,
          ...coldOpen.map((entry) => entry.fullGetValueCalls),
        ),
      },
      coldAfterEdit: {
        fullGetValueCalls: Math.max(
          0,
          ...coldEditHover.map((entry) => entry.fullGetValueCalls),
        ),
        selectionIndexBuilds: Math.max(
          0,
          ...coldEditSelection.map((entry) => entry.indexBuilds),
        ),
        selectionMarkerInsertions: coldEditSelection.reduce(
          (sum, entry) => sum + entry.liveMarkerInsertions,
          0,
        ),
      },
    }
    console.log(
      '[Task 574 OS selection performance]',
      JSON.stringify({
        fixtureBytes: Buffer.byteLength(initial, 'utf8'),
        fixtureSha256: FIXTURE_SHA256,
        xtestClient: {
          visible: xtest.client.visible,
          title: xtest.client.title,
        },
        measurements: measurements.map(summary),
        metrics,
      }),
    )

    expect(
      measurements
        .filter(
          (entry) => !isCold(entry) || entry.input === 'cold-edit-selection',
        )
        .every((entry) => entry.selectedLength > 0 && entry.forward),
    ).toBe(true)
    expect(coldEditHover.length).toBe(1)
    expect(coldEditSelection.length).toBe(1)
    expect(measurements.every((entry) => entry.sampledFrames > 0)).toBe(true)
    expect(
      measurements
        .filter((entry) => entry.input === 'slow-keyboard')
        .every((entry) => entry.shiftRightKeyTimesMs.length === STEPS),
    ).toBe(true)
    expect(
      measurements
        .filter((entry) => entry.input === 'drag')
        .every((entry) => entry.detailsEnabled && entry.bubbleVisible),
    ).toBe(true)
    // A native drag never builds or serializes while the primary button is held (confirmed by a
    // stack-trace probe during Checkpoint 7 evidence-gathering); real VS Code chains every phase
    // on one live page, unlike the isolated Chromium harnesses, so a drag here follows a real
    // prior selection that measureDrag must collapse first (see the metrics.drag comment above).
    // That collapse is a genuine selectionchange, so — like a keyboard phase — at most one index
    // build (and its one snapshotPair/getValue) may land in the observation window, strictly
    // after release, from block-handle's own next ordinary hover or Details' settle read.
    expect(metrics.drag.fullGetValueCalls).toBeLessThanOrEqual(1)
    expect(metrics.drag.liveMarkerInsertions).toBe(0)
    expect(metrics.drag.blockHandleSnapshots).toBeLessThanOrEqual(1)
    expect(metrics.drag.indexBuilds).toBeLessThanOrEqual(1)
    expect(metrics.keyboard.liveMarkerInsertions).toBe(0)
    expect(metrics.keyboard.maxFullGetValueCallsPerPhase).toBeLessThanOrEqual(1)
    expect(metrics.keyboard.maxIndexBuildsPerPhase).toBeLessThanOrEqual(1)
    expect(metrics.keyboard.indexBuildsInstrumented).toBe(true)
    expect(metrics.coldOpen.fullGetValueCalls).toBeLessThanOrEqual(1)
    expect(metrics.coldAfterEdit.fullGetValueCalls).toBeLessThanOrEqual(1)
    expect(metrics.coldAfterEdit.selectionIndexBuilds).toBeLessThanOrEqual(1)
    expect(metrics.coldAfterEdit.selectionMarkerInsertions).toBe(0)
    expect(metrics.passive.sampledFrames).toBeGreaterThan(0)
    // Source equality is asserted after the work counters so a red run names the mechanism first.
    expect(
      measurements.every((entry) => entry.hostUnchanged && entry.diskUnchanged),
    ).toBe(true)
    // maxKeyGapMs is reported, not gated, here (unlike the Chromium spec's `< 32` assertion on
    // the same field): it is not part of Checkpoint 7's deterministic gate table, and evidence
    // gathered for Checkpoint 7 shows it measures XTEST/Electron/X11 round-trip latency for OS
    // key dispatch into a nested webview iframe, not this task's serialization/index work — it
    // regularly exceeds 32 ms in this environment even on a burst phase with zero index builds
    // and zero full getValue calls. The Chromium harness exercises the same assertion through an
    // in-process synthetic keyboard path (no OS/IPC hop) and it passes there, which is the
    // product-responsiveness signal; this real-VS-Code run keeps the value in the console report
    // for evidence instead of gating acceptance on host machine/XTEST dispatch speed.

    // Task 577 Checkpoint 1 red assertions (expected to fail — see the task record's Checkpoint 1
    // results for the full evidence table). A temporary performance.mark/measure attribution pass
    // (added, run once, then fully removed — `git diff media-src/src` was empty before commit)
    // confirmed a settle-time index rebuild still lands strictly between release and the bubble's
    // first visible frame: it is a genuine race between block-handle's post-release hover
    // (`units()`) and Details' own settle read (`passiveDetailsState` -> `source.read()`), sharing
    // one per-revision index, so whichever fires first in a frame pays the cost and the toolbar
    // cannot paint until it finishes. The exact fallback (H2) and bubble-local cost (H4) were both
    // confirmed absent/negligible in the same pass and are not gated here.
    const settleObservedMeasurements = measurements.filter(
      (entry) => entry.settleObserved,
    )
    expect(settleObservedMeasurements.length).toBeGreaterThan(0)
    expect(
      settleObservedMeasurements.every(
        (entry) => entry.settleIndexBuildsBeforeVisible === 0,
      ),
    ).toBe(true)
    expect(
      settleObservedMeasurements.every(
        (entry) => entry.settleFullGetValueBeforeVisible === 0,
      ),
    ).toBe(true)
    expect(
      settleObservedMeasurements.every(
        (entry) => entry.settleLiveMarkersBeforeVisible === 0,
      ),
    ).toBe(true)
    // Hard bound: a cold build was measured at >=700 ms and XTEST/IPC jitter at 50-60 ms in this
    // environment (Checkpoint 1 handoff), so 150 ms is a generous ceiling on responsive settle —
    // not the eventual UX target.
    expect(
      settleObservedMeasurements.every((entry) => entry.releaseToShowMs <= 150),
    ).toBe(true)
    // Accuracy guard: whatever the settle-time race resolves to, the Details button state must
    // still be the Task 574 expectation once the observation window ends — a raced-out or
    // deferred read must never leave a stale or wrong enabled/pressed state.
    expect(
      measurements
        .filter(
          (entry) => entry.input === 'drag' || entry.input.includes('keyboard'),
        )
        .every((entry) => entry.detailsEnabled),
    ).toBe(true)

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
    const reopenedText = (await docText(
      evaluateInVSCode as never,
      file,
    )) as string
    expect(
      reopenedText === initial && readFileSync(file, 'utf8') === initial,
    ).toBe(true)
  })
})
