import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from './coverage-fixture'
import {
  installSelectionPerformanceProbe,
  type SelectionPerformanceProbeResult,
} from '../../test/vscode-e2e/selection-performance-probe'

const LARGE_SOURCE = readFileSync(
  path.join(
    __dirname,
    '../../test/vscode-e2e/fixtures/large-observable-models-synthetic.md',
  ),
  'utf8',
)
const LARGE_SHA256 =
  'a4a39d6f6c605eb82b0e03a236f67388bceeae9a85450b0d4285053b28299f65'
const OBSERVATION_MS = 500
const SELECTION_STEPS = 12

type Mode = 'ir' | 'wysiwyg'
type Page = import('@playwright/test').Page

interface Measurement extends SelectionPerformanceProbeResult {
  harness: 'details' | 'selection-bubble' | 'block-handle'
  mode: Mode
  input: 'drag' | 'slow-keyboard' | 'burst-keyboard' | 'cold-hover'
  selectedLength: number
  forward: boolean
  sourceUnchanged: boolean
  detailsEnabled: boolean | null
  bubbleVisible: boolean | null
  maxKeyGapMs: number
  /** Task 577 Checkpoint 1: whether the index/cache was warmed by a prior read before this
   * phase's workload began (cold = the first interaction after a fresh setValue). */
  warmth: 'warm' | 'cold'
}

function summarize(measurement: Measurement) {
  const sorted = [...measurement.frameGapsMs].sort((a, b) => a - b)
  return {
    harness: measurement.harness,
    mode: measurement.mode,
    input: measurement.input,
    workloadMs: measurement.elapsedWorkloadMs,
    observedMs: measurement.elapsedObservedMs,
    selectionEvents: measurement.selectionEvents,
    selectedLength: measurement.selectedLength,
    forward: measurement.forward,
    fullGetValueCalls: measurement.fullGetValueCalls,
    liveMarkerInsertions: measurement.liveMarkerInsertions,
    rangeInsertCalls: measurement.rangeInsertCalls,
    luteEntryPoints: measurement.luteEntryPoints,
    rootLuteCalls: measurement.rootLuteCalls,
    fragmentLuteCalls: measurement.fragmentLuteCalls,
    blockHandleSnapshots: measurement.blockHandleSnapshots,
    blockHandleProofs: measurement.blockHandleProofs,
    indexBuilds: measurement.indexBuilds,
    indexBuildsInstrumented: measurement.indexBuildsInstrumented,
    sampledFrames: measurement.sampledFrames,
    rafP95Ms: sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? 0,
    rafMaxMs: sorted.at(-1) ?? 0,
    longTasks: measurement.longTaskDurationsMs.length,
    longTaskMs: Math.round(
      measurement.longTaskDurationsMs.reduce(
        (sum, duration) => sum + duration,
        0,
      ),
    ),
    maxKeyGapMs: measurement.maxKeyGapMs,
    warmth: measurement.warmth,
    detailsEnabled: measurement.detailsEnabled,
    bubbleVisible: measurement.bubbleVisible,
    sourceUnchanged: measurement.sourceUnchanged,
    // Task 577 Checkpoint 1 settle recorder — see selection-performance-probe.ts.
    settleObserved: measurement.settleObserved,
    settleBubblePresent: measurement.settleBubblePresent,
    releaseToShowMs: measurement.releaseToShowMs,
    releaseToVisibleFrameMs: measurement.releaseToVisibleFrameMs,
    settleLongestTaskMs: measurement.settleLongestTaskMs,
    settleMaxRafGapMs: measurement.settleMaxRafGapMs,
    settleIndexBuildsBeforeVisible: measurement.settleIndexBuildsBeforeVisible,
    settleFullGetValueBeforeVisible:
      measurement.settleFullGetValueBeforeVisible,
    settleLiveMarkersBeforeVisible: measurement.settleLiveMarkersBeforeVisible,
    settleBubbleTogglesBeforeVisible:
      measurement.settleBubbleTogglesBeforeVisible,
    settleIndexBuildsAfterVisible: measurement.settleIndexBuildsAfterVisible,
    settleFullGetValueAfterVisible: measurement.settleFullGetValueAfterVisible,
    settleLiveMarkersAfterVisible: measurement.settleLiveMarkersAfterVisible,
    settleBubbleTogglesAfterVisible:
      measurement.settleBubbleTogglesAfterVisible,
  }
}

async function setSource(page: Page, markdown: string): Promise<string> {
  return page.evaluate((source) => {
    const editor = (window as any).__details?.editor ?? (window as any).vditor
    editor.setValue(source)
    return editor.getValue() as string
  }, markdown)
}

async function installProbe(page: Page, markdown: string): Promise<void> {
  await page.evaluate(installSelectionPerformanceProbe, markdown)
}

async function startProbe(page: Page): Promise<void> {
  await page.evaluate(() => (window as any).__selectionPerformanceProbe.start())
}

async function endProbeWorkload(page: Page): Promise<void> {
  await page.evaluate(() =>
    (window as any).__selectionPerformanceProbe.endWorkload(),
  )
}

async function finishProbe(
  page: Page,
): Promise<SelectionPerformanceProbeResult> {
  await page.waitForTimeout(OBSERVATION_MS)
  return page.evaluate(() => (window as any).__selectionPerformanceProbe.stop())
}

async function selectionState(page: Page) {
  return page.evaluate(() => {
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

async function sourceUnchanged(page: Page, markdown: string): Promise<boolean> {
  return page.evaluate((source) => {
    const editor = (window as any).__details?.editor ?? (window as any).vditor
    return editor.getValue() === source
  }, markdown)
}

interface TextGeometry {
  startX: number
  endX: number
  y: number
  clickX: number
  clickY: number
}

async function textGeometry(
  paragraph: import('@playwright/test').Locator,
): Promise<TextGeometry> {
  const geometry = await paragraph.evaluate((element) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
    let text: Text | null = null
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.textContent && node.textContent.length >= 12) {
        text = node as Text
        break
      }
    }
    if (!text) return null
    const startRange = document.createRange()
    startRange.setStart(text, 0)
    startRange.setEnd(text, 1)
    const endRange = document.createRange()
    endRange.setStart(text, 11)
    endRange.setEnd(text, 12)
    const first = startRange.getBoundingClientRect()
    const last = endRange.getBoundingClientRect()
    const bounds = element.getBoundingClientRect()
    if (
      first.width <= 0 ||
      first.height <= 0 ||
      last.width <= 0 ||
      last.height <= 0
    )
      return null
    return {
      startX: first.left + Math.min(1, first.width / 2),
      endX: last.right - 1,
      y: first.top + first.height / 2,
      clickX: first.left + Math.min(1, first.width / 2) - bounds.left,
      clickY: first.top + first.height / 2 - bounds.top,
    }
  })
  if (!geometry)
    throw new Error('selection paragraph has no 12-character text node')
  return geometry
}

async function waitForSource(page: Page, markdown: string): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate((source) => {
          const editor =
            (window as any).__details?.editor ?? (window as any).vditor
          return editor.getValue() === source
        }, markdown),
      { timeout: 60_000 },
    )
    .toBe(true)
}

async function measureDrag(
  page: Page,
  paragraph: import('@playwright/test').Locator,
  harness: Measurement['harness'],
  mode: Mode,
  markdown: string,
  detailsButton?: import('@playwright/test').Locator,
  // Task 577 Checkpoint 1: a genuinely cold drag must arm the probe BEFORE the mouse first
  // approaches the paragraph, because that approach move is itself a block-handle hover that can
  // build the index — arming after it (the pre-existing warm-drag order below) would hide that
  // cost from the counters entirely instead of attributing it.
  warmth: Measurement['warmth'] = 'warm',
): Promise<Measurement> {
  // A mousedown inside an existing selection starts native text drag-and-drop instead of a new
  // selection (mirrors the real-VS-Code helper's fix): the bubble-harness warm-drag phase now
  // follows a keyboard phase that leaves an extended selection, so this must run unconditionally.
  await page.evaluate(() => window.getSelection()?.removeAllRanges())
  await page.waitForTimeout(100)
  const { startX, endX, y } = await textGeometry(paragraph)
  if (warmth === 'cold') await startProbe(page)
  await page.mouse.move(startX, y)
  if (warmth === 'warm') await startProbe(page)
  await page.mouse.down()
  for (let step = 1; step <= SELECTION_STEPS; step++) {
    const x = startX + ((endX - startX) * step) / SELECTION_STEPS
    await page.mouse.move(x, y)
    if (step < SELECTION_STEPS) await page.waitForTimeout(60)
  }
  await page.mouse.up()
  await endProbeWorkload(page)
  const result = await finishProbe(page)
  const state = await selectionState(page)
  return {
    ...result,
    harness,
    mode,
    input: 'drag',
    warmth,
    selectedLength: state.length,
    forward: state.forward,
    sourceUnchanged: await sourceUnchanged(page, markdown),
    detailsEnabled: detailsButton ? await detailsButton.isEnabled() : null,
    bubbleVisible:
      harness === 'selection-bubble'
        ? await page.locator('.vmde-selection-bubble').isVisible()
        : null,
    maxKeyGapMs: 0,
  }
}

async function measureKeyboard(
  page: Page,
  paragraph: import('@playwright/test').Locator,
  mode: Mode,
  burst: boolean,
  markdown = LARGE_SOURCE,
  harness: Measurement['harness'] = 'selection-bubble',
  detailsButton?: import('@playwright/test').Locator,
  warmth: Measurement['warmth'] = 'warm',
): Promise<Measurement> {
  const geometry = await textGeometry(paragraph)
  await paragraph.click({
    position: { x: geometry.clickX, y: geometry.clickY },
  })
  await page.keyboard.press('Home')
  await page.waitForTimeout(50)
  await startProbe(page)
  if (burst) {
    await page.keyboard.down('Shift')
    for (let step = 0; step < SELECTION_STEPS; step++)
      await page.keyboard.press('ArrowRight')
    await page.keyboard.up('Shift')
  } else {
    for (let step = 0; step < SELECTION_STEPS; step++) {
      await page.keyboard.press('Shift+ArrowRight')
      await page.waitForTimeout(60)
    }
  }
  await endProbeWorkload(page)
  const result = await finishProbe(page)
  const state = await selectionState(page)
  const keyGaps = result.shiftRightKeyTimesMs
    .slice(1)
    .map((time, index) => time - result.shiftRightKeyTimesMs[index])
  return {
    ...result,
    harness,
    mode,
    input: burst ? 'burst-keyboard' : 'slow-keyboard',
    warmth,
    selectedLength: state.length,
    forward: state.forward,
    sourceUnchanged: await sourceUnchanged(page, markdown),
    detailsEnabled: detailsButton ? await detailsButton.isEnabled() : null,
    bubbleVisible:
      harness === 'selection-bubble'
        ? await page.locator('.vmde-selection-bubble').isVisible()
        : null,
    maxKeyGapMs: Math.max(0, ...keyGaps),
  }
}

async function measureColdHover(
  page: Page,
  paragraph: import('@playwright/test').Locator,
  mode: Mode,
  markdown: string,
): Promise<Measurement> {
  const box = await paragraph.boundingBox()
  if (!box) throw new Error('selection paragraph has no layout box')
  await page.mouse.move(1, 1)
  await startProbe(page)
  await page.mouse.move(box.x + 8, box.y + 10)
  await endProbeWorkload(page)
  const result = await finishProbe(page)
  return {
    ...result,
    harness: 'block-handle',
    mode,
    input: 'cold-hover',
    warmth: 'cold',
    selectedLength: 0,
    forward: false,
    sourceUnchanged: await sourceUnchanged(page, markdown),
    detailsEnabled: null,
    bubbleVisible: null,
    maxKeyGapMs: 0,
  }
}

test('large document selection display avoids source work in IR and WYSIWYG', async ({
  page,
}) => {
  test.setTimeout(240_000)
  expect(createHash('sha256').update(LARGE_SOURCE).digest('hex')).toBe(
    LARGE_SHA256,
  )
  const measurements: Measurement[] = []

  for (const mode of ['ir', 'wysiwyg'] as const) {
    await page.goto(`/details.html?mode=${mode}`)
    await page.waitForFunction(() => (window as any).__ready === true)
    const detailsSource = await setSource(page, LARGE_SOURCE)
    await waitForSource(page, detailsSource)
    await page
      .locator(`.vditor-${mode} .vditor-reset > p:visible`)
      .first()
      .waitFor()
    await installProbe(page, detailsSource)
    const detailsButton = page
      .locator('.vditor-toolbar [data-type="details"]')
      .first()
    const detailsParagraph = page
      .locator(`.vditor-${mode} .vditor-reset > p:visible`)
      .first()
    measurements.push(
      await measureKeyboard(
        page,
        detailsParagraph,
        mode,
        false,
        detailsSource,
        'details',
        detailsButton,
      ),
    )
    measurements.push(
      await measureKeyboard(
        page,
        detailsParagraph,
        mode,
        true,
        detailsSource,
        'details',
        detailsButton,
      ),
    )

    await page.goto('/selection-bubble.html')
    await page.waitForFunction(() => (window as any).__ready === true)
    let bubbleSource = await setSource(page, LARGE_SOURCE)
    await waitForSource(page, bubbleSource)
    if (mode === 'wysiwyg') {
      await page.evaluate(() =>
        (window as any).__setSelectionBubbleMode('wysiwyg'),
      )
      await page
        .locator('.vditor-wysiwyg .vditor-reset > p:visible')
        .first()
        .waitFor()
      bubbleSource = await page.evaluate(
        () => (window as any).vditor.getValue() as string,
      )
      await waitForSource(page, bubbleSource)
    }
    await installProbe(page, bubbleSource)
    const bubbleParagraph = page
      .locator(`.vditor-${mode} .vditor-reset > p:visible`)
      .first()
    // First interaction after a fresh setValue: the index/cache is cold (Task 577 Checkpoint 1
    // H4/H5 isolation — the bubble harness has no separate block-handle hover to warm it first).
    measurements.push(
      await measureKeyboard(
        page,
        bubbleParagraph,
        mode,
        false,
        bubbleSource,
        'selection-bubble',
        undefined,
        'cold',
      ),
    )
    measurements.push(
      await measureKeyboard(page, bubbleParagraph, mode, true, bubbleSource),
    )
    // Warm drag on the bubble harness: isolates bubble-local settle cost (selectionOwner,
    // formatIsActive, overlay.show) from block-handle's own presentation cache, which the
    // block-handle-only harness below cannot do (it never installs the bubble).
    measurements.push(
      await measureDrag(
        page,
        bubbleParagraph,
        'selection-bubble',
        mode,
        bubbleSource,
      ),
    )
    // Cold drag on the bubble harness: a fresh revision so the drag itself is the first
    // interaction, mirroring the real-VS-Code cold-drag phase for the same H3/H4 isolation.
    let bubbleColdSource = await setSource(page, LARGE_SOURCE)
    await waitForSource(page, bubbleColdSource)
    if (mode === 'wysiwyg') {
      await page.evaluate(() =>
        (window as any).__setSelectionBubbleMode('wysiwyg'),
      )
      await page
        .locator('.vditor-wysiwyg .vditor-reset > p:visible')
        .first()
        .waitFor()
      bubbleColdSource = await page.evaluate(
        () => (window as any).vditor.getValue() as string,
      )
      await waitForSource(page, bubbleColdSource)
    }
    await installProbe(page, bubbleColdSource)
    const bubbleColdParagraph = page
      .locator(`.vditor-${mode} .vditor-reset > p:visible`)
      .first()
    measurements.push(
      await measureDrag(
        page,
        bubbleColdParagraph,
        'selection-bubble',
        mode,
        bubbleColdSource,
        undefined,
        'cold',
      ),
    )

    await page.goto('/block-handle.html')
    await page.waitForFunction(() => (window as any).__ready === true)
    let blockSource = await page.evaluate((source) => {
      ;(window as any).__blockHandleExactInput = source
      ;(window as any).vditor.setValue(source)
      return (window as any).vditor.getValue() as string
    }, LARGE_SOURCE)
    await waitForSource(page, blockSource)
    if (mode === 'wysiwyg') {
      await page.evaluate(() => (window as any).__switchMode('wysiwyg'))
      await page
        .locator('.vditor-wysiwyg .vditor-reset > p:visible')
        .first()
        .waitFor()
      blockSource = await page.evaluate(
        () => (window as any).vditor.getValue() as string,
      )
      await waitForSource(page, blockSource)
    }
    const blockParagraph = page
      .locator(`.vditor-${mode} .vditor-reset > p:visible`)
      .first()
    await installProbe(page, blockSource)
    measurements.push(
      await measureColdHover(page, blockParagraph, mode, blockSource),
    )
    await page.mouse.move(1, 1)
    await page.mouse.move(20, 20)
    await blockParagraph.hover()
    await blockParagraph.hover()
    measurements.push(
      await measureDrag(
        page,
        blockParagraph,
        'block-handle',
        mode,
        blockSource,
      ),
    )
  }

  await page.goto('/selection-bubble.html')
  await page.waitForFunction(() => (window as any).__ready === true)
  const smallSource = 'Short paragraph for the selection control.\n'
  const smallEditorSource = await setSource(page, smallSource)
  await waitForSource(page, smallEditorSource)
  await installProbe(page, smallEditorSource)
  const smallParagraph = page
    .locator('.vditor-ir .vditor-reset > p:visible')
    .first()
  const smallControl = await measureKeyboard(
    page,
    smallParagraph,
    'ir',
    false,
    smallEditorSource,
    'selection-bubble',
    undefined,
    'cold',
  )
  measurements.push(smallControl)
  // Warm-key control: same small document, second keyboard phase so the index is already built.
  // Separates fixed latency (H5) from document-size-dependent settle cost on the small doc.
  measurements.push(
    await measureKeyboard(page, smallParagraph, 'ir', true, smallEditorSource),
  )

  const passive = measurements.filter((entry) => entry.input !== 'cold-hover')
  const drag = measurements.filter(
    (entry) => entry.harness === 'block-handle' && entry.input === 'drag',
  )
  const keyboard = measurements.filter(
    (entry) =>
      entry.input === 'slow-keyboard' || entry.input === 'burst-keyboard',
  )
  const coldHover = measurements.filter((entry) => entry.input === 'cold-hover')
  // Owner decision (2026-09-26): mouse drags stay at 0 full serializations/markers/index builds;
  // a keyboard phase may cost at most one index build (and the one full getValue it forces),
  // attributable to Vditor's own keydown DOM mutations (Undo.recordFirstPosition/addCaret,
  // fixCJKPosition) — see the task's "Design decisions" table. That is a PER-PHASE ceiling, not an
  // aggregate budget, because summing across phases would hide a phase that regressed to 2+.
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
      fullGetValueCalls: drag.reduce(
        (sum, entry) => sum + entry.fullGetValueCalls,
        0,
      ),
      liveMarkerInsertions: drag.reduce(
        (sum, entry) => sum + entry.liveMarkerInsertions,
        0,
      ),
      blockHandleSnapshots: drag.reduce(
        (sum, entry) => sum + entry.blockHandleSnapshots,
        0,
      ),
      blockHandleProofs: drag.reduce(
        (sum, entry) => sum + entry.blockHandleProofs,
        0,
      ),
      indexBuilds: drag.reduce((sum, entry) => sum + entry.indexBuilds, 0),
    },
    coldHover: {
      // First selection display after open: below incremental admission on this fixture, so IR
      // and WYSIWYG both take one full getValue (H2), not the pre-Checkpoint-3 two.
      fullGetValueCalls: Math.max(
        0,
        ...coldHover.map((entry) => entry.fullGetValueCalls),
      ),
    },
    passive: {
      sampledFrames: passive.reduce(
        (sum, entry) => sum + entry.sampledFrames,
        0,
      ),
    },
  }
  console.log(
    '[Task 574 selection performance]',
    JSON.stringify({
      fixtureBytes: Buffer.byteLength(LARGE_SOURCE, 'utf8'),
      fixtureSha256: LARGE_SHA256,
      measurements: measurements.map(summarize),
      metrics,
    }),
  )

  expect(
    measurements
      .filter((entry) => entry.input !== 'cold-hover')
      .every((entry) => entry.selectedLength > 0 && entry.forward),
  ).toBe(true)
  expect(measurements.every((entry) => entry.sourceUnchanged)).toBe(true)
  expect(measurements.every((entry) => entry.sampledFrames > 0)).toBe(true)
  expect(
    measurements
      .filter((entry) => entry.harness === 'details')
      .every((entry) => entry.detailsEnabled),
  ).toBe(true)
  expect(
    measurements
      .filter((entry) => entry.harness === 'selection-bubble')
      .every((entry) => entry.bubbleVisible),
  ).toBe(true)
  expect(metrics.drag.fullGetValueCalls).toBe(0)
  expect(metrics.drag.liveMarkerInsertions).toBe(0)
  expect(metrics.drag.blockHandleSnapshots).toBe(0)
  expect(metrics.drag.blockHandleProofs).toBe(0)
  expect(metrics.drag.indexBuilds).toBe(0)
  expect(metrics.keyboard.liveMarkerInsertions).toBe(0)
  expect(metrics.keyboard.maxFullGetValueCallsPerPhase).toBeLessThanOrEqual(1)
  expect(metrics.keyboard.maxIndexBuildsPerPhase).toBeLessThanOrEqual(1)
  expect(metrics.keyboard.indexBuildsInstrumented).toBe(true)
  expect(metrics.coldHover.fullGetValueCalls).toBeLessThanOrEqual(1)
  expect(metrics.passive.sampledFrames).toBeGreaterThan(0)
  expect(
    measurements
      .filter((entry) => entry.input === 'burst-keyboard')
      .every((entry) => entry.maxKeyGapMs < 32),
  ).toBe(true)

  // Task 577 Checkpoint 1 hard gates (H4/H5 isolation). This isolated harness never wires Details
  // to the shared index, so the settle-time index rebuild real VS Code shows (see the real-VS-Code
  // spec's red assertions and the task record's Checkpoint 1 results) cannot happen here — these
  // are expected to stay green, proving the bubble's own cost (H4) and the fixed debounce+frame
  // latency (H5) are small on their own, in isolation from the index-build race.
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
  // 32 ms debounce + two frames at 16.7 ms, the same shape as the handoff's Chromium bound.
  expect(
    settleObservedMeasurements.every(
      (entry) => entry.releaseToShowMs <= 32 + 2 * 16.7,
    ),
  ).toBe(true)
})
