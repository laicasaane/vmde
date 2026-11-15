import { readFileSync } from 'node:fs'
import path from 'node:path'
import { build } from 'esbuild'
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

// Task 012-16 M-1 and M-2 (D-13 design sections 3 and 11.4): the native cost of Selection changes and of
// the style and layout flush after a DOM write, against the document size, in Chromium without VS Code.
// For f = 1, 4, 16 the harness renders the table-heavy fixture through Lute and times one warm-up and 20
// repetitions of each variant from the handler start to the next animation frame. The spec reports
// median and p90 of the handler time and of `deferred` (frame time minus variant a's at the same
// factor), the design's "grows" test, the M-2 decision rules 1 to 5, and one trace of variant g per
// factor that splits the flush into style and layout work. The decision itself is recorded in the task
// handoff.
//
// Opt-in like `init-bench.spec.ts` (a measurement, not a regression check):
//   BENCH=1 npm --prefix media-src run test:e2e -- selection-cost
//
// The harness is a perf-only page that the shared harness registry does not list (it stays out of
// coverage, like the bench page): the spec bundles it with esbuild and serves the page and the bundle
// through `page.route`. The Lute script and the stylesheets come from the e2e server.

const RUN = process.env.BENCH === '1'
const here = __dirname
const FACTORS = [1, 4, 16] as const
const VARIANTS = [
  'a',
  'b',
  'c',
  'd',
  'e',
  'f',
  'g',
  'g1',
  'g-cell',
  'h-live',
  'h-clone',
  'k-off',
  'k-contain',
  'k-cv',
  'k-contain-cell',
  'k-cv-cell',
] as const
const REPETITIONS = 20
const CONTAINMENT = [
  'k-contain',
  'k-cv',
  'k-contain-cell',
  'k-cv-cell',
] as const

type Variant = (typeof VARIANTS)[number]
type StyleMode = 'production' | 'off' | 'contain' | 'cv'
interface Sample {
  handler: number
  toFrame: number
  rootFocused: boolean
  caretOk: boolean | null
}
interface Stats {
  median: number
  p90: number
}
interface TraceEvent {
  name: string
  ph: string
  ts: number
  dur?: number
  tid: number
  args?: {
    elementCount?: number
    beginData?: { dirtyObjects?: number; totalObjects?: number }
    data?: { type?: string }
  }
}

function styleMode(variant: Variant): StyleMode {
  if (variant === 'k-off') return 'off'
  if (variant === 'k-contain' || variant === 'k-contain-cell') return 'contain'
  if (variant === 'k-cv' || variant === 'k-cv-cell') return 'cv'
  return 'production'
}

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((x, y) => x - y)
  const index = Math.min(
    sorted.length - 1,
    Math.ceil(fraction * sorted.length) - 1,
  )
  return sorted[Math.max(0, index)]
}

function stats(values: number[]): Stats {
  return { median: percentile(values, 0.5), p90: percentile(values, 0.9) }
}

/** The design's test: the f16 median is at least 3 times the f1 median and at least 2 ms above it. */
function grows(f1: number, f16: number): boolean {
  return f16 >= 3 * f1 && f16 - f1 >= 2
}

async function openHarness(page: Page): Promise<void> {
  const bundle = await build({
    entryPoints: [path.join(here, 'selection-cost-harness.ts')],
    bundle: true,
    format: 'iife',
    write: false,
  })
  const script = bundle.outputFiles[0].text
  const html = readFileSync(path.join(here, 'selection-cost.html'), 'utf8')
  await page.route('**/selection-cost.html', (route) =>
    route.fulfill({ contentType: 'text/html', body: html }),
  )
  await page.route('**/selection-cost.js', (route) =>
    route.fulfill({ contentType: 'text/javascript', body: script }),
  )
  await page.goto('/selection-cost.html')
  await page.waitForFunction(
    () =>
      (window as unknown as { __selectionCostReady?: boolean })
        .__selectionCostReady === true,
  )
}

async function twoFrames(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  )
}

async function sample(page: Page, variant: Variant): Promise<Sample> {
  await page.evaluate((v) => {
    const api = (window as any).__selectionCost
    api.prepare(v)
    api.arm(v)
  }, variant)
  // Two frames settle the preparation's own selection work before the timed change.
  await twoFrames(page)
  if (variant !== 'e') await page.keyboard.press('Shift')
  const result: Sample = await page.evaluate(() =>
    (window as any).__selectionCost.take(),
  )
  if (result.caretOk !== null)
    expect(result.caretOk, `variant ${variant} places the caret`).toBe(true)
  return result
}

interface FlushSums {
  keydownMs: number
  styleCount: number
  styleMs: number
  elementCount: number
  layoutCount: number
  layoutMs: number
  dirtyObjects: number
  totalObjects: number
  /** Other complete trace events of at least 0.5 ms inside the dispatch, by event name (ms). */
  otherMs: Record<string, number>
}

function keydownDispatch(events: TraceEvent[]): TraceEvent & { dur: number } {
  const keydown = events.find(
    (e) =>
      e.name === 'EventDispatch' &&
      e.ph === 'X' &&
      e.args?.data?.type === 'keydown',
  )
  if (!keydown || keydown.dur === undefined)
    throw new Error('no keydown dispatch in the trace')
  return keydown as TraceEvent & { dur: number }
}

function addLayout(
  sums: FlushSums,
  open: Map<number, TraceEvent>,
  e: TraceEvent,
): void {
  // Layout may be recorded as one complete event or as a begin and end pair on the same thread.
  if (e.ph === 'E') {
    const begin = open.get(e.tid)
    if (begin) sums.layoutMs += (e.ts - begin.ts) / 1000
    open.delete(e.tid)
    return
  }
  sums.layoutCount++
  sums.dirtyObjects += e.args?.beginData?.dirtyObjects ?? 0
  sums.totalObjects += e.args?.beginData?.totalObjects ?? 0
  if (e.ph === 'X') sums.layoutMs += (e.dur ?? 0) / 1000
  else open.set(e.tid, e)
}

function addEvent(
  sums: FlushSums,
  open: Map<number, TraceEvent>,
  e: TraceEvent,
): void {
  const ms = (e.dur ?? 0) / 1000
  if (e.name === 'Layout') addLayout(sums, open, e)
  else if (e.name === 'UpdateLayoutTree' && e.ph === 'X') {
    sums.styleCount++
    sums.styleMs += ms
    sums.elementCount += e.args?.elementCount ?? 0
  } else if (e.ph === 'X' && ms >= 0.5)
    sums.otherMs[e.name] = (sums.otherMs[e.name] ?? 0) + ms
}

/** Sums the style and layout events inside the keydown dispatch of one traced sample of variant g. */
function sumFlush(events: TraceEvent[]): FlushSums {
  const keydown = keydownDispatch(events)
  const from = keydown.ts
  const to = keydown.ts + keydown.dur
  const sums: FlushSums = {
    keydownMs: keydown.dur / 1000,
    styleCount: 0,
    styleMs: 0,
    elementCount: 0,
    layoutCount: 0,
    layoutMs: 0,
    dirtyObjects: 0,
    totalObjects: 0,
    otherMs: {},
  }
  const openLayout = new Map<number, TraceEvent>()
  const inside = events.filter(
    (e) => e !== keydown && e.tid === keydown.tid && e.ts >= from && e.ts <= to,
  )
  for (const e of inside) addEvent(sums, openLayout, e)
  return sums
}

async function traceG(page: Page): Promise<FlushSums> {
  const cdp = await page.context().newCDPSession(page)
  const events: TraceEvent[] = []
  cdp.on('Tracing.dataCollected', (params) => {
    events.push(...(params.value as unknown as TraceEvent[]))
  })
  const complete = new Promise<void>((resolve) => {
    cdp.once('Tracing.tracingComplete', () => resolve())
  })
  await cdp.send('Tracing.start', {
    traceConfig: {
      includedCategories: [
        'devtools.timeline',
        'disabled-by-default-devtools.timeline',
      ],
    },
    transferMode: 'ReportEvents',
  })
  await sample(page, 'g')
  await cdp.send('Tracing.end')
  await complete
  await cdp.detach()
  return sumFlush(events)
}

test.describe('native selection cost (M-1, M-2)', () => {
  test.skip(!RUN, 'set BENCH=1 to run the selection cost measurement')
  test.describe.configure({ timeout: 900_000 })

  test('times the variants against the document size', async ({
    page,
  }, testInfo) => {
    await openHarness(page)
    const report: Record<string, unknown> = {}
    const handler: Record<string, Record<number, Stats>> = {}
    const toFrame: Record<string, Record<number, Stats>> = {}
    const traces: Record<string, FlushSums> = {}
    for (const factor of FACTORS) {
      const size = await page.evaluate(
        (f) => (window as any).__selectionCost.load(f),
        factor,
      )
      report[`f${factor}`] = { size }
      for (const variant of VARIANTS) {
        await page.evaluate(
          (mode) => (window as any).__selectionCost.configure(mode),
          styleMode(variant),
        )
        await twoFrames(page)
        // One untimed repetition warms the code paths at this size and style.
        await sample(page, variant)
        const samples: Sample[] = []
        for (let i = 0; i < REPETITIONS; i++)
          samples.push(await sample(page, variant))
        handler[variant] = {
          ...handler[variant],
          [factor]: stats(samples.map((s) => s.handler)),
        }
        toFrame[variant] = {
          ...toFrame[variant],
          [factor]: stats(samples.map((s) => s.toFrame)),
        }
        const rootFocused = samples.filter((s) => s.rootFocused).length
        ;(report[`f${factor}`] as Record<string, unknown>)[variant] = {
          handler: handler[variant][factor],
          toFrame: toFrame[variant][factor],
          rootFocused,
        }
      }
      await page.evaluate(() =>
        (window as any).__selectionCost.configure('production'),
      )
      await twoFrames(page)
      await sample(page, 'g')
      traces[`f${factor}`] = await traceG(page)
    }

    const deferred = (variant: Variant, factor: number): number =>
      toFrame[variant][factor].median - toFrame.a[factor].median
    const h = (variant: Variant, factor: number): number =>
      handler[variant][factor].median
    const summary: Record<string, unknown> = {}
    for (const variant of VARIANTS) {
      summary[variant] = {
        handler: FACTORS.map((f) => h(variant, f)),
        deferred: FACTORS.map((f) => deferred(variant, f)),
        growsHandler: grows(h(variant, 1), h(variant, 16)),
        growsDeferred: grows(deferred(variant, 1), deferred(variant, 16)),
      }
    }
    const gGrows = grows(h('g', 1), h('g', 16))
    const gCellGrows = grows(h('g-cell', 1), h('g-cell', 16))
    const lever = (variant: (typeof CONTAINMENT)[number]): boolean =>
      h(variant, 16) <= 2 * h(variant, 1) + 2 &&
      (variant.endsWith('-cell') ? gCellGrows : gGrows)
    const kOffFlat = !grows(h('k-off', 1), h('k-off', 16))
    const levers = Object.fromEntries(CONTAINMENT.map((v) => [v, lever(v)]))
    const rules = {
      rule1V2Ships: h('g1', 16) <= h('g', 16) - 2,
      rule2V3aShips: h('h-clone', 16) <= 0.5 * h('h-live', 16),
      rule3LeverCandidates: levers,
      rule4StylesheetCause: kOffFlat && gGrows,
      rule5NoLever:
        !Object.values(levers).some(Boolean) && !(kOffFlat && gGrows),
    }
    report.summary = summary
    report.traces = traces
    report.rules = rules
    const json = JSON.stringify(report, null, 2)
    await testInfo.attach('selection-cost.json', {
      body: json,
      contentType: 'application/json',
    })
    console.log(`selection-cost M-2 result\n${json}`)
    expect(Object.keys(summary)).toHaveLength(VARIANTS.length)
  })
})
