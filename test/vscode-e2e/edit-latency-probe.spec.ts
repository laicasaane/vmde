import { copyFileSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import { tableHeavyMarkdown } from './table-heavy-markdown'
import { waitForE2EReadiness, wf } from './webview-helpers'

// MEASUREMENT (diagnostic; a gate only with VMDE_PERF_ASSERT=1). Per gated operation (typing at two
// cadences, Backspace, Enter, paste, Undo, Redo in a paragraph, a table cell, a list item and a code
// block; the first pointer move over the document; a selection change) it records:
//   - the Event Timing duration (PerformanceObserver type `event`, durationThreshold 16),
//   - long tasks in the 3 s after the operation,
//   - keydown to the second animation frame after it (second column, kept from the first version).
// Input: VMDE_PERF_FILE (a document, never committed) or VMDE_PERF_FACTOR (1, 4, 16; synthetic
// fixture). VMDE_PROFILE=<dir> adds a CPU profile per profiled operation, plus per row `metrics`
// (CDP Performance.getMetrics differences, milliseconds) and `counters` (the webview's
// `__vmdeEditCounters`, numbers only). VMDE_PERF_OUT=<path> gets the
// same JSON as the `EDIT-LATENCY` line. The JSON holds operation names, places and numbers only,
// never document text. @probe: excluded from the default run.
// VMDE_PERF_MODE=wysiwyg (task 733 / 013): switch to WYSIWYG after the open and measure the same rows
// there; unset (or `ir`) keeps the IR rows unchanged.
// VMDE_PERF_MODE=sv or split (task 733 / 015): switch to Source (preview pane hidden) or Split (preview
// pane shown) and measure the same places in the Source text, located by their first line; both
// values add two switch rows (Source to IR, IR to Source) at the end.

type Frame = ReturnType<typeof wf>

const EVENT_THRESHOLD_MS = 16
const GATE_MS = 50
const LETTERS = 'abcdefghij'

const PERF_MODE: 'ir' | 'wysiwyg' =
  process.env.VMDE_PERF_MODE === 'wysiwyg' ? 'wysiwyg' : 'ir'
/** Task 015: VMDE_PERF_MODE=sv (Source alone) or split (Source with its preview pane); undefined otherwise. */
const SOURCE_MODE: 'sv' | 'split' | undefined =
  process.env.VMDE_PERF_MODE === 'sv' || process.env.VMDE_PERF_MODE === 'split'
    ? process.env.VMDE_PERF_MODE
    : undefined
/** The mode named in the JSON report. */
const REPORTED_MODE = SOURCE_MODE ?? PERF_MODE
/** The Source block of a place: the `data-block` div whose text starts with `prefix`, caret at the end of `line`. */
interface SourcePlace {
  prefix: string
  line: number
}
/** Task 015: the Source block that holds each place of PLACES (same order). */
const SOURCE_PLACES: Record<string, SourcePlace> = {
  paragraph: { prefix: 'Second paragraph', line: 0 },
  // Body row 2 of table A, the row of the IR cell `td` 7.
  'table cell': { prefix: '| Name', line: 3 },
  'list item': { prefix: '- list item', line: 2 },
  'code block': { prefix: '```ts', line: 1 },
}
/** The mode tree the rows run in. */
const MODE_ROOT = `.vditor-${PERF_MODE}`
/** The editable source of a fenced code block in the measured mode. */
const CODE_SOURCE =
  PERF_MODE === 'ir' ? 'pre.vditor-ir__marker--pre' : 'pre.vditor-wysiwyg__pre'

const PLACES = [
  { name: 'paragraph', selector: `${MODE_ROOT} .vditor-reset > p`, nth: 2 },
  {
    name: 'table cell',
    selector: `${MODE_ROOT} .vditor-reset > table td`,
    nth: 7,
  },
  {
    name: 'list item',
    selector: `${MODE_ROOT} .vditor-reset > ul > li`,
    nth: 2,
  },
  {
    name: 'code block',
    // The fenced block's editable source; the YAML front matter is also a `pre > code`, but under
    // `data-type="yaml-front-matter"` with a view-only table preview over it.
    selector: `${MODE_ROOT} .vditor-reset > [data-type="code-block"] ${CODE_SOURCE} > code`,
    nth: 0,
    programmatic: true,
  },
] as const

interface Row {
  operation: string
  place: string
  /** keydown-to-second-frame samples (second column). */
  frames: number
  frameMedianMs: number
  frameMaxMs: number
  /** Event Timing entries at or over the threshold. */
  eventCount: number
  eventMaxMs: number
  longTaskCount: number
  longTaskMs: number
  /** VMDE_PROFILE only: CDP Performance metric differences over the drive plus the 3 s window. */
  metrics?: Metrics
  /** VMDE_PROFILE only: the edit counters after the drive, when the webview installed them. */
  counters?: Record<string, number>
}

interface Metrics {
  recalcStyleMs: number
  recalcStyleCount: number
  layoutMs: number
  layoutCount: number
  scriptMs: number
  taskMs: number
}

type CdpMetrics = Record<string, number>

const tenth = (value: number) => Math.round(value * 10) / 10

/** Differences of two `Performance.getMetrics` readings; CDP durations are seconds, rows hold ms. */
function metricsBetween(before: CdpMetrics, after: CdpMetrics): Metrics {
  const delta = (name: string) => (after[name] ?? 0) - (before[name] ?? 0)
  return {
    recalcStyleMs: tenth(delta('RecalcStyleDuration') * 1000),
    recalcStyleCount: delta('RecalcStyleCount'),
    layoutMs: tenth(delta('LayoutDuration') * 1000),
    layoutCount: delta('LayoutCount'),
    scriptMs: tenth(delta('ScriptDuration') * 1000),
    taskMs: tenth(delta('TaskDuration') * 1000),
  }
}

/**
 * Caret in a collapsed IR code block. Its source is covered by the rendered preview, so a pointer click
 * cannot reach it (the editor intercepts it). Select inside the source, expand the node and focus,
 * as the d2 edit-performance spec does, then the keyboard drives it.
 */
async function placeCaretInCodeSource(
  frame: Frame,
  selector: string,
): Promise<void> {
  // The top window must hold keyboard focus before the page-side selection is set.
  await frame
    .locator(MODE_ROOT)
    .first()
    .click({ position: { x: 4, y: 4 } })
  const placed = await frame.locator('body').evaluate(
    (_body, args) => {
      const [sel, mode] = args as [string, 'ir' | 'wysiwyg']
      const code = document.querySelector(sel)
      const node = code?.closest(
        mode === 'ir' ? '.vditor-ir__node' : '.vditor-wysiwyg__block',
      )
      const source = node?.querySelector<HTMLElement>(
        mode === 'ir' ? '.vditor-ir__marker--pre' : '.vditor-wysiwyg__pre',
      )
      if (!code || !node || !source) return false
      // IR expands the node; WYSIWYG shows the source pre it keeps hidden until the block is entered.
      if (mode === 'ir') node.classList.add('vditor-ir__node--expand')
      else source.style.removeProperty('display')
      // End of the first code line.
      const text = document
        .createTreeWalker(code, NodeFilter.SHOW_TEXT)
        .nextNode() as Text | null
      if (!text) return false
      const content = text.textContent ?? ''
      const newline = content.indexOf('\n')
      const range = document.createRange()
      range.setStart(text, newline < 0 ? content.length : newline)
      range.collapse(true)
      const selection = window.getSelection()
      selection?.removeAllRanges()
      selection?.addRange(range)
      source.focus()
      return true
    },
    [selector, PERF_MODE],
  )
  if (!placed) throw new Error('code block source not found')
}

/** Task 015: dispatches a toolbar click on the edit-mode button of `mode` (the panel is hidden until hover). */
async function clickEditMode(frame: Frame, mode: 'ir' | 'sv'): Promise<void> {
  await frame.locator('body').evaluate((_body, m) => {
    document
      .querySelector(`.vditor-toolbar button[data-mode="${m as string}"]`)
      ?.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true }),
      )
  }, mode)
}

/** Task 015: Source with the preview pane hidden (`sv`) or shown (`split`), through the toolbar. */
async function enterSourceMode(
  frame: Frame,
  sourceMode: 'sv' | 'split',
): Promise<void> {
  const before = await waitForE2EReadiness(
    frame,
    (snapshot) => snapshot.editorEpoch > 0,
    { message: 'the editor finished initialization' },
  )
  await clickEditMode(frame, 'sv')
  await waitForE2EReadiness(
    frame,
    (snapshot) =>
      snapshot.modeEpoch > before.modeEpoch && snapshot.mode === 'sv',
    { message: 'the editor reported Source' },
  )
  // The `both` toolbar button toggles the preview pane; click it only when the pane is not as wanted.
  await frame.locator('body').evaluate((_body, wantPreview) => {
    const pane = document.querySelector<HTMLElement>('.vditor-preview')
    const shown = !!pane && getComputedStyle(pane).display !== 'none'
    if (shown === wantPreview) return
    document
      .querySelector('.vditor-toolbar [data-type="both"]')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  }, sourceMode === 'split')
}

/** Task 015: puts the caret at the end of `place.line` of its Source block and focuses the Source root. */
async function placeCaretInSourceBlock(
  frame: Frame,
  place: SourcePlace,
): Promise<void> {
  await frame
    .locator('.vditor-sv')
    .first()
    .click({ position: { x: 4, y: 4 } })
  const placed = await frame.locator('body').evaluate((_body, target) => {
    const { prefix, line } = target as SourcePlace
    const root = document.querySelector<HTMLElement>('pre.vditor-sv')
    const block = Array.from(root?.children ?? []).find((el) =>
      el.textContent?.startsWith(prefix),
    )
    if (!root || !block) return false
    block.scrollIntoView({ block: 'center' })
    // The offset of the end of `line` in the block's text, then the text node that holds it.
    const text = block.textContent ?? ''
    let end = -1
    for (let i = 0; i <= line; i++) end = text.indexOf('\n', end + 1)
    if (end < 0) return false
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT)
    let seen = 0
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const length = node.textContent?.length ?? 0
      if (seen + length >= end) {
        const range = document.createRange()
        range.setStart(node, end - seen)
        range.collapse(true)
        const selection = window.getSelection()
        selection?.removeAllRanges()
        selection?.addRange(range)
        root.focus()
        return true
      }
      seen += length
    }
    return false
  }, place)
  if (!placed) throw new Error('Source block not found')
}

/** VMDE_PERF_MODE=wysiwyg: switch to WYSIWYG and let the new mode settle; IR: nothing. */
async function enterMeasuredMode(frame: Frame): Promise<void> {
  if (SOURCE_MODE) {
    await enterSourceMode(frame, SOURCE_MODE)
    await frame
      .locator('body')
      .evaluate(() => new Promise((r) => setTimeout(r, 4000)))
    return
  }
  if (PERF_MODE !== 'wysiwyg') return
  await switchToWysiwyg(frame)
  await frame
    .locator('body')
    .evaluate(() => new Promise((r) => setTimeout(r, 4000)))
}

/** Switches the open editor to WYSIWYG through the edit-mode toolbar and waits for the mode report. */
async function switchToWysiwyg(frame: Frame): Promise<void> {
  const before = await waitForE2EReadiness(
    frame,
    (snapshot) => snapshot.editorEpoch > 0,
    { message: 'the editor finished initialization' },
  )
  await frame.locator('body').evaluate(() => {
    const v = (
      window as unknown as {
        vditor: {
          vditor: { toolbar: { elements: Record<string, HTMLElement> } }
        }
      }
    ).vditor.vditor
    v.toolbar.elements['edit-mode']?.children[0]?.dispatchEvent(
      new MouseEvent('click', { bubbles: true }),
    )
    document
      .querySelector('button[data-mode="wysiwyg"]')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await frame.locator('.vditor-wysiwyg').first().waitFor({ timeout: 30_000 })
  await waitForE2EReadiness(
    frame,
    (snapshot) =>
      snapshot.modeEpoch > before.modeEpoch && snapshot.mode === 'wysiwyg',
    { message: 'the editor reported WYSIWYG' },
  )
}

interface Place {
  name: string
  selector: string
  nth: number
  programmatic?: boolean
}

/** Puts the caret in `place`: Source text (task 015), a code block's source, or a click and `end` key. */
async function placeCaretAt(
  frame: Frame,
  end: () => Promise<void>,
  place: Place,
): Promise<void> {
  if (SOURCE_MODE)
    return placeCaretInSourceBlock(frame, SOURCE_PLACES[place.name])
  if (place.programmatic) return placeCaretInCodeSource(frame, place.selector)
  const target = frame.locator(place.selector).nth(place.nth)
  await target.scrollIntoViewIfNeeded()
  await target.click({ timeout: 10_000 })
  await end()
}

/** The first table: in Source (task 015) the `data-block` div that starts with its header row. */
const firstTableOf = (frame: Frame) =>
  SOURCE_MODE
    ? frame
        .locator('pre.vditor-sv > [data-block]')
        .filter({ hasText: /^\| Name/ })
        .first()
    : frame.locator(`${MODE_ROOT} .vditor-reset > table`).first()

/** The block the selection-change row clicks: in Source (task 015) the first paragraph's div. */
const selectionTargetOf = (frame: Frame) =>
  SOURCE_MODE
    ? frame
        .locator('pre.vditor-sv > [data-block]')
        .filter({ hasText: /^First paragraph/ })
        .first()
    : frame.locator(PLACES[0].selector).nth(1)

/** Task 015: the two switch rows, from the toolbar click until the new mode reports (Source to IR,
 *  then back to Source with the same preview pane state). */
async function recordSwitchRows(
  frame: Frame,
  record: (
    operation: string,
    place: string,
    drive: () => Promise<void>,
  ) => Promise<void>,
): Promise<void> {
  const sourceMode = SOURCE_MODE
  if (!sourceMode) return
  await record('mode switch', 'Source to IR', async () => {
    const before = await waitForE2EReadiness(frame, () => true)
    await clickEditMode(frame, 'ir')
    await waitForE2EReadiness(
      frame,
      (snapshot) =>
        snapshot.modeEpoch > before.modeEpoch && snapshot.mode === 'ir',
      { message: 'the editor reported IR' },
    )
  })
  await record('mode switch', 'IR to Source', () =>
    enterSourceMode(frame, sourceMode),
  )
}

const install = (frame: Frame) =>
  frame.locator('body').evaluate((_body, threshold) => {
    const w = window as unknown as {
      __lat: {
        samples: number[]
        events: number[]
        long: number[]
      }
    }
    w.__lat = { samples: [], events: [], long: [] }
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) w.__lat.long.push(entry.duration)
    }).observe({ type: 'longtask', buffered: false })
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) w.__lat.events.push(entry.duration)
    }).observe({
      type: 'event',
      durationThreshold: threshold as number,
      buffered: false,
    } as PerformanceObserverInit)
    document.addEventListener(
      'keydown',
      () => {
        const start = performance.now()
        requestAnimationFrame(() =>
          requestAnimationFrame(() =>
            w.__lat.samples.push(performance.now() - start),
          ),
        )
      },
      true,
    )
  }, EVENT_THRESHOLD_MS)

/** Wait 3 s after the operation (long tasks and late Event Timing entries), then read and clear. */
const take = (frame: Frame) =>
  frame.locator('body').evaluate(async () => {
    await new Promise((r) => setTimeout(r, 3000))
    const w = window as unknown as {
      __lat: { samples: number[]; events: number[]; long: number[] }
    }
    const { samples, events, long } = w.__lat
    w.__lat = { samples: [], events: [], long: [] }
    const sorted = [...samples].sort((a, b) => a - b)
    const pick = (q: number) =>
      Math.round(
        sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ??
          -1,
      )
    return {
      frames: samples.length,
      frameMedianMs: pick(0.5),
      frameMaxMs: Math.round(sorted.at(-1) ?? -1),
      eventCount: events.length,
      eventMaxMs: Math.round(Math.max(0, ...events)),
      longTaskCount: long.length,
      longTaskMs: Math.round(long.reduce((a, b) => a + b, 0)),
    }
  })

function resolveSource(baseDir: string): { file: string; label: string } {
  const file = path.join(baseDir, 'edit-latency.md')
  const source = process.env.VMDE_PERF_FILE
  if (source) {
    copyFileSync(source, file)
    return { file, label: 'file' }
  }
  const factor = Number(process.env.VMDE_PERF_FACTOR ?? '1')
  if (factor !== 1 && factor !== 4 && factor !== 16)
    throw new Error('VMDE_PERF_FACTOR must be 1, 4 or 16')
  writeFileSync(file, tableHeavyMarkdown(factor))
  return { file, label: `factor ${factor}` }
}

test('edit latency on a large document @probe', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(1_800_000)
  const { file, label } = resolveSource(baseDir)
  await evaluateInVSCode(
    async (vscode: typeof import('vscode'), args: string[]) => {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors')
      await vscode.extensions.getExtension('Laicasaane.vmde')?.activate()
      await vscode.commands.executeCommand(
        'vscode.openWith',
        vscode.Uri.file(args[0]),
        'vmde.editor',
      )
    },
    [file],
  )
  const frame = wf(workbox)
  await frame.locator('.vditor-ir').first().waitFor({ timeout: 60_000 })
  await frame
    .locator('body')
    .evaluate(() => new Promise((r) => setTimeout(r, 4000)))
  await enterMeasuredMode(frame)
  await install(frame)

  // VMDE_PROFILE=<dir>: a CPU profile of each profiled burst, taken through a CDP session on the webview frame.
  const profileDir = process.env.VMDE_PROFILE
  let cdp: import('@playwright/test').CDPSession | null = null
  if (profileDir) {
    // The webview runs out of process: take the first non-main frame that owns a CDP session.
    for (const candidate of workbox.frames()) {
      if (candidate === workbox.mainFrame()) continue
      try {
        cdp = await workbox.context().newCDPSession(candidate)
        break
      } catch {
        /* shares its parent's session */
      }
    }
  }
  if (cdp) {
    await cdp.send('Performance.enable')
    await cdp.send('Profiler.enable')
    await cdp.send('Profiler.setSamplingInterval', { interval: 200 })
  }
  const startProfile = async () => {
    if (cdp) await cdp.send('Profiler.start')
  }
  const readMetrics = async (): Promise<CdpMetrics | null> => {
    if (!cdp) return null
    const { metrics } = (await cdp.send('Performance.getMetrics')) as {
      metrics: { name: string; value: number }[]
    }
    return Object.fromEntries(metrics.map((m) => [m.name, m.value]))
  }
  const markdownLength = readFileSync(file, 'utf8').length
  // Zero the counters before the drive; false when the webview did not install them.
  const resetCounters = (): Promise<boolean> =>
    frame.locator('body').evaluate((_body, length) => {
      const counters = (window as any).__vmdeEditCounters
      if (!counters) return false
      counters.reset(length)
      return true
    }, markdownLength)
  // The counter values only (numbers; no document text).
  const readCounters = (): Promise<Record<string, number>> =>
    frame.locator('body').evaluate(() => {
      const counters = (window as any).__vmdeEditCounters ?? {}
      return Object.fromEntries(
        Object.entries(counters).filter(([, v]) => typeof v === 'number'),
      ) as Record<string, number>
    })
  const stopProfile = async (name: string) => {
    if (!cdp || !profileDir) return
    const { profile } = (await cdp.send('Profiler.stop')) as {
      profile: unknown
    }
    writeFileSync(
      path.join(profileDir, `${name.replace(/\W+/g, '-')}.cpuprofile`),
      JSON.stringify(profile),
    )
  }

  const placeCaret = (place: Place) =>
    placeCaretAt(frame, () => workbox.keyboard.press('End'), place)
  const rows: Row[] = []
  const failures: { place: string; operation: string; error: string }[] = []
  // One failed step must not end the run: keep the first line of the message only (a locator call log
  // quotes page text), and carry on with the next operation.
  const fail = (place: string, operation: string, error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    failures.push({
      place,
      operation,
      error: message.split('\n')[0].slice(0, 120),
    })
  }
  const record = async (
    operation: string,
    place: string,
    drive: () => Promise<void>,
  ) => {
    try {
      const countersInstalled = cdp ? await resetCounters() : false
      const metricsBefore = await readMetrics()
      await startProfile()
      await drive()
      const numbers = await take(frame)
      await stopProfile(`${place} ${operation}`)
      const metricsAfter = await readMetrics()
      const extra: Pick<Row, 'metrics' | 'counters'> = {}
      if (metricsBefore && metricsAfter)
        extra.metrics = metricsBetween(metricsBefore, metricsAfter)
      if (countersInstalled) extra.counters = await readCounters()
      rows.push({ operation, place, ...numbers, ...extra })
    } catch (error) {
      fail(place, operation, error)
      await take(frame).catch(() => undefined)
    }
  }
  const press = async (key: string, times: number, gapMs: number) => {
    for (let i = 0; i < times; i++) {
      await workbox.keyboard.press(key)
      await workbox.waitForTimeout(gapMs)
    }
  }
  const type = async (gapMs: number) => {
    for (const ch of LETTERS) {
      await workbox.keyboard.press(ch)
      await workbox.waitForTimeout(gapMs)
    }
  }

  // The first pointer move over the document, then a selection change by click.
  await record('first pointer move', 'table', async () => {
    const firstTable = firstTableOf(frame)
    await firstTable.scrollIntoViewIfNeeded()
    const box = await firstTable.boundingBox()
    if (!box) throw new Error('table has no bounding box')
    await workbox.mouse.move(box.x + 20, box.y + 20)
    await workbox.mouse.move(box.x + box.width / 2, box.y + box.height / 2, {
      steps: 8,
    })
  })
  await record('selection change', 'paragraph', async () => {
    await selectionTargetOf(frame).click()
    await workbox.keyboard.press('ArrowRight')
  })

  for (const place of PLACES) {
    try {
      await placeCaret(place)
      await frame
        .locator('body')
        .evaluate(() => new Promise((r) => setTimeout(r, 1500)))
      await take(frame)
    } catch (error) {
      fail(place.name, 'place caret', error)
      continue
    }
    await record('type 80 ms', place.name, () => type(80))
    await record('type 300 ms', place.name, () => type(300))
    await record('backspace', place.name, () => press('Backspace', 5, 150))
    await record('enter', place.name, () => press('Enter', 2, 400))
    await record('paste', place.name, async () => {
      // A constant synthetic text; the clipboard may refuse the write outside a user gesture.
      await frame
        .locator('body')
        .evaluate(() => navigator.clipboard.writeText('pasted words'))
        .catch(() => undefined)
      await workbox.keyboard.press('Control+v')
    })
    await record('undo', place.name, () => press('Control+z', 5, 400))
    await record('redo', place.name, () => press('Control+y', 5, 400))
  }

  // The first block action after the typing above: Move Block Down re-resolves fresh units through
  // the block handle's own proof, which a model-backed hover no longer warms (task 005 decision 2).
  await placeCaret(PLACES[0]).catch((error) =>
    fail('paragraph', 'place caret', error),
  )
  await frame
    .locator('body')
    .evaluate(() => new Promise((r) => setTimeout(r, 1500)))
  await take(frame)
  await record('first block action', 'paragraph', async () => {
    await evaluateInVSCode(async (vscode: typeof import('vscode')) => {
      await vscode.commands.executeCommand('vmde.moveBlockDown')
    }, [])
  })

  await recordSwitchRows(frame, record)

  const violations = rows
    .filter(
      (row) =>
        row.eventMaxMs > GATE_MS ||
        row.frameMaxMs > GATE_MS ||
        row.longTaskCount > 0,
    )
    .map((row) => `${row.place} ${row.operation}`)
  const json = JSON.stringify({
    source: label,
    mode: REPORTED_MODE,
    gateMs: GATE_MS,
    rows,
    failures,
    violations,
  })
  console.log(`EDIT-LATENCY ${json}`)
  if (process.env.VMDE_PERF_OUT) writeFileSync(process.env.VMDE_PERF_OUT, json)
  if (process.env.VMDE_PERF_ASSERT === '1') {
    expect(failures).toEqual([])
    expect(violations).toEqual([])
  }
  // Without the assert flag the probe fails only when nothing was measured.
  expect(rows.length, 'measured operations').toBeGreaterThan(0)
})
