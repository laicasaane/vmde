import {
  appendFileSync,
  copyFileSync,
  mkdirSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import {
  reopenVmdeFixture,
  settle,
  waitForE2EReadiness,
  waitForInitialUndoSnapshot,
  type wf,
} from './webview-helpers'

// @probe — Task 691: non-asserting timing of four mode switches (Preview on, Preview off,
// IR to Split, Split to IR) on three fixture sizes. It asserts only the starting state and that
// every switch settles. It uses only hooks that exist on the 30426a37 reference and on dev
// (`__vmdePreviewRendered`, `__vmdeInvalidatePreview`, `vditor.vditor.*`, the toolbar DOM), and
// logs `__vmdeOpenMetrics` when present. Run with VMDE_PROBES=1; run the same file in both
// worktrees. One test() is one session (one VS Code boot).
//
// Environment: VMDE_PROBE_REV (label, default "dev"), VMDE_PROBE_SESSION (label, default "1"),
// VMDE_PROBE_OUT (JSONL path, default tmp/691/mode-switch-probe.jsonl), VMDE_PROBE_CYCLES
// (measured cycles, default 10), VMDE_PROBE_WARMUP (discarded cycles, default 2),
// VMDE_PROBE_REUSE_PAIRS (extra Preview on/off pairs, default 3).

type Frame = ReturnType<typeof wf>
type Evaluate = Parameters<typeof reopenVmdeFixture>[0]

// Local on purpose: preview-mode-helpers.ts does not exist on the reference revision.
const setConfig = (evaluate: Evaluate, key: string, value: unknown) =>
  evaluate(
    async (vscode: typeof import('vscode'), args: string[]) => {
      await vscode.workspace
        .getConfiguration('vmde')
        .update(
          args[0],
          args[1] === 'undefined' ? undefined : JSON.parse(args[1]),
          vscode.ConfigurationTarget.Global,
        )
    },
    [key, value === undefined ? 'undefined' : JSON.stringify(value)],
  )
type Kind = 'on' | 'off' | 'sv' | 'ir'

const REV = process.env.VMDE_PROBE_REV ?? 'dev'
const SESSION = process.env.VMDE_PROBE_SESSION ?? '1'
const OUT =
  process.env.VMDE_PROBE_OUT ??
  path.resolve(__dirname, '../../tmp/691/mode-switch-probe.jsonl')
const CYCLES = Number(process.env.VMDE_PROBE_CYCLES ?? 10)
const WARMUP = Number(process.env.VMDE_PROBE_WARMUP ?? 2)
const REUSE_PAIRS = Number(process.env.VMDE_PROBE_REUSE_PAIRS ?? 3)
const PREVIEW_BUTTON = '.vditor-toolbar [data-type="preview"]'
const OUTLINE_BUTTON = '.vditor-toolbar [data-type="outline"]'
const IDLE_GAP_MS = 500

const FIXTURES = {
  small: 'all-renderers.md',
  mid: 'perf-prose.md',
  large: 'large-observable-models-synthetic.md',
} as const

interface Sample {
  kind: Kind
  ok: boolean
  paintMs: number | null
  eventMs: number | null
  settledMs: number | null
  predicateMs: number | null
  longTaskCount: number
  longTaskMs: number
  longTaskMaxMs: number
  renderedAtMs: number[]
  calls?: { n: string; at: number; d: number }[]
  failure?: string
}

/** Install the in-page instrumentation once per session. */
const instrument = (frame: Frame) =>
  frame.locator('body').evaluate(() => {
    const w = window as unknown as Record<string, any>
    if (w.__probe) return w.__probe.sources
    const P: Record<string, any> = {
      rendered: [] as number[],
      longTasks: [] as { start: number; end: number }[],
      events: [] as { startTime: number; duration: number; name: string }[],
      expect: null,
      cur: null,
    }
    w.__probe = P
    const supported = PerformanceObserver.supportedEntryTypes ?? []
    P.sources = {
      longtask: supported.includes('longtask'),
      event: supported.includes('event'),
    }
    const drain = () => {
      for (const e of longSink?.takeRecords() ?? [])
        P.longTasks.push({ start: e.startTime, end: e.startTime + e.duration })
      for (const e of eventObserver?.takeRecords() ?? [])
        P.events.push({
          startTime: e.startTime,
          duration: e.duration,
          name: e.name,
        })
    }
    const longSink = P.sources.longtask
      ? new PerformanceObserver((list) => {
          for (const e of list.getEntries())
            P.longTasks.push({
              start: e.startTime,
              end: e.startTime + e.duration,
            })
        })
      : null
    longSink?.observe({ type: 'longtask', buffered: true })
    const eventObserver = P.sources.event
      ? new PerformanceObserver((list) => {
          for (const e of list.getEntries())
            P.events.push({
              startTime: e.startTime,
              duration: e.duration,
              name: e.name,
            })
        })
      : null
    eventObserver?.observe({
      type: 'event',
      durationThreshold: 16,
      buffered: true,
    } as PerformanceObserverInit)
    // Fallback long-task source: rAF gaps over 50 ms (as d2-edit-perf.spec.ts does).
    if (!P.sources.longtask) {
      let last = performance.now()
      const tick = () => {
        const now = performance.now()
        if (now - last > 50) P.longTasks.push({ start: last, end: now })
        last = now
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    }
    // Record every __vmdePreviewRendered call, whatever object the hook is (re)assigned to.
    let hook = w.__vmdePreviewRendered
    Object.defineProperty(w, '__vmdePreviewRendered', {
      configurable: true,
      enumerable: true,
      get() {
        if (typeof hook !== 'function') return hook
        return function (this: unknown, ...args: unknown[]) {
          P.rendered.push(performance.now())
          return hook.apply(this, args)
        }
      },
      set(value) {
        hook = value
      },
    })
    const inner = () => w.vditor?.vditor
    const shown = (el: HTMLElement | null | undefined) =>
      !!el && getComputedStyle(el).display !== 'none'
    P.predicates = {
      on: (t0: number, needRender: boolean) => {
        const v = inner()
        return (
          shown(v?.preview?.element) &&
          (v?.preview?.previewElement?.childElementCount ?? 0) > 0 &&
          (!needRender || P.rendered.some((t: number) => t > t0))
        )
      },
      off: () => {
        const v = inner()
        const mode = v?.currentMode
        const pane = mode ? v?.[mode]?.element : null
        const button = document.querySelector(
          '.vditor-toolbar [data-type="preview"]',
        )
        return (
          shown(pane?.parentElement) &&
          !shown(v?.preview?.element) &&
          !button?.classList.contains('vditor-menu--current')
        )
      },
      sv: (t0: number) => {
        const v = inner()
        return (
          v?.currentMode === 'sv' &&
          (v?.sv?.element?.childElementCount ?? 0) > 0 &&
          shown(v?.preview?.element) &&
          P.rendered.some((t: number) => t > t0)
        )
      },
      ir: () => {
        const v = inner()
        return (
          v?.currentMode === 'ir' &&
          (v?.ir?.element?.childElementCount ?? 0) > 0 &&
          !shown(v?.preview?.element)
        )
      },
    }
    P.arm = (kind: string, needRender: boolean) => {
      P.expect = { kind, needRender }
    }
    document.addEventListener(
      'click',
      (event) => {
        const target = event.target
        if (!(target instanceof Element) || !P.expect) return
        const hit =
          target.closest('.vditor-toolbar [data-type="preview"]') ??
          target.closest('button[data-mode]')
        if (!hit) return
        const { kind, needRender } = P.expect as {
          kind: string
          needRender: boolean
        }
        P.expect = null
        const t0 = performance.now()
        const cur: Record<string, any> = { kind, t0, eventTs: event.timeStamp }
        P.cur = cur
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            cur.tPaint = performance.now()
          }),
        )
        cur.done = new Promise((resolve) => {
          let tPred: number | null = null
          let tPredPaint: number | null = null
          // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: in-page measurement loop of a probe that asserts nothing
          const finish = (ok: boolean, quietFrom: number, failure?: string) => {
            drain()
            const inWindow = P.longTasks.filter(
              (l: { start: number; end: number }) =>
                l.end > t0 && l.start < quietFrom,
            )
            const entry = P.events.find(
              (e: { name: string; startTime: number }) =>
                e.name === 'click' && Math.abs(e.startTime - cur.eventTs) < 2,
            )
            const sample: Sample = {
              kind: kind as Kind,
              ok,
              paintMs: cur.tPaint === undefined ? null : cur.tPaint - t0,
              eventMs: entry ? entry.duration : null,
              settledMs: ok ? quietFrom - t0 : null,
              predicateMs: tPred === null ? null : tPred - t0,
              longTaskCount: inWindow.length,
              longTaskMs: inWindow.reduce(
                (a: number, l: { start: number; end: number }) =>
                  a + (l.end - l.start),
                0,
              ),
              longTaskMaxMs: inWindow.reduce(
                (a: number, l: { start: number; end: number }) =>
                  Math.max(a, l.end - l.start),
                0,
              ),
              renderedAtMs: P.rendered
                .filter((t: number) => t > t0)
                .map((t: number) => t - t0),
              calls: P.calls?.length
                ? P.calls
                    .filter((c: { start: number }) => c.start >= t0)
                    .map((c: { n: string; start: number; d: number }) => ({
                      n: c.n,
                      at: c.start - t0,
                      d: c.d,
                    }))
                : undefined,
              failure,
            }
            resolve(sample)
          }
          // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: in-page measurement loop of a probe that asserts nothing
          const frame = (now: number) => {
            now = performance.now()
            if (now - t0 > 30_000) {
              finish(false, now, `timeout waiting for ${kind}`)
              return
            }
            if (tPred === null) {
              if (P.predicates[kind](t0, needRender)) {
                tPred = now
                requestAnimationFrame(() =>
                  requestAnimationFrame(() => {
                    tPredPaint = performance.now()
                  }),
                )
              }
            } else if (tPredPaint !== null) {
              drain()
              const lastLong = P.longTasks.reduce(
                (a: number, l: { start: number; end: number }) =>
                  l.end > t0 ? Math.max(a, l.end) : a,
                0,
              )
              const quietFrom = Math.max(tPredPaint, lastLong)
              if (now - quietFrom >= 300) {
                finish(true, quietFrom)
                return
              }
            }
            requestAnimationFrame(frame)
          }
          requestAnimationFrame(frame)
        })
      },
      true,
    )
    return P.sources
  })

const arm = (frame: Frame, kind: Kind, needRender: boolean) =>
  frame
    .locator('body')
    .evaluate(
      (_b, a) =>
        (window as unknown as Record<string, any>).__probe.arm(
          a.kind,
          a.needRender,
        ),
      { kind, needRender },
    )

const result = (frame: Frame) =>
  frame
    .locator('body')
    .evaluate(
      () => (window as unknown as Record<string, any>).__probe.cur.done,
    ) as Promise<Sample>

const invalidate = (frame: Frame) =>
  frame.locator('body').evaluate(() => {
    ;(window as unknown as Record<string, any>).__vmdeInvalidatePreview?.(
      'content',
    )
  })

// Task 691 step 2: route switch and call timers (VMDE_PROBE_ATTR=ab|wrap).
const ATTR = process.env.VMDE_PROBE_ATTR
const stashRoute = (frame: Frame) =>
  frame.locator('body').evaluate(() => {
    const w = window as unknown as Record<string, any>
    w.__probeStash = {
      hook: w.__vmdeRenderFullPreview,
      owns: w.__vmdeFullPreviewOwnsOutline,
    }
    return [typeof w.__probeStash.hook, typeof w.__probeStash.owns]
  })
const setRoute = (frame: Frame, route: 'A' | 'B') =>
  frame.locator('body').evaluate((_b, r) => {
    const w = window as unknown as Record<string, any>
    if (r === 'A') {
      w.__vmdeRenderFullPreview = w.__probeStash.hook
      w.__vmdeFullPreviewOwnsOutline = w.__probeStash.owns
    } else {
      delete w.__vmdeRenderFullPreview
      delete w.__vmdeFullPreviewOwnsOutline
    }
  }, route)
const wrapCalls = (frame: Frame) =>
  frame.locator('body').evaluate(() => {
    const w = window as unknown as Record<string, any>
    const P = w.__probe
    P.calls = []
    const v = w.vditor.vditor
    const wrap = (obj: any, key: string, name: string) => {
      const orig = obj?.[key]
      if (typeof orig !== 'function') return false
      obj[key] = function (this: unknown, ...a: unknown[]) {
        const t = performance.now()
        try {
          return orig.apply(this, a)
        } finally {
          P.calls.push({ n: name, start: t, d: performance.now() - t })
        }
      }
      return true
    }
    return {
      hook: wrap(w, '__vmdeRenderFullPreview', 'hook'),
      morph: wrap(w, '__vmdeMorphPreview', 'morph'),
      md2html: wrap(v.lute, 'Md2HTML', 'Md2HTML'),
      outline: wrap(v.outline, 'render', 'outline.render'),
      previewRender: wrap(v.preview, 'render', 'preview.render'),
    }
  })

const startState = (frame: Frame) =>
  frame.locator('body').evaluate(() => {
    const v = (window as unknown as Record<string, any>).vditor?.vditor
    const preview = v?.preview?.element as HTMLElement | undefined
    return {
      mode: v?.currentMode as string | undefined,
      previewShown: !!preview && getComputedStyle(preview).display !== 'none',
      outlineShown: (() => {
        const panel = document.querySelector<HTMLElement>('.vditor-outline')
        return !!panel && getComputedStyle(panel).display !== 'none'
      })(),
      openMetrics:
        (window as unknown as Record<string, any>).__vmdeOpenMetrics ?? null,
    }
  })

async function ensureOutline(frame: Frame, want: boolean) {
  if ((await startState(frame)).outlineShown !== want) {
    await frame.locator(OUTLINE_BUTTON).click()
    await expect
      .poll(async () => (await startState(frame)).outlineShown, {
        timeout: 10_000,
      })
      .toBe(want)
    // The remembered outline state is saved by the host shortly after the click.
    await settle(frame, 1000)
  }
}

interface Row {
  fixture: string
  variant: string
  cycle: number
  route?: 'A' | 'B'
  phase: 'warmup' | 'measured' | 'reuse'
  sample: Sample
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: probe session driver, asserts nothing
async function runSession(
  fixtureKey: keyof typeof FIXTURES,
  variant: 'defaults' | 'outline' | 'gutter',
  fns: {
    evaluateInVSCode: Parameters<typeof reopenVmdeFixture>[0]
    workbox: Parameters<typeof reopenVmdeFixture>[1]
    baseDir: string
  },
) {
  const { evaluateInVSCode, workbox, baseDir } = fns
  mkdirSync(path.dirname(OUT), { recursive: true })
  const source = path.join(__dirname, 'fixtures', FIXTURES[fixtureKey])
  const file = path.join(baseDir, `probe-${fixtureKey}.md`)
  copyFileSync(source, file)
  const loadStart = os.loadavg()[0]
  const write = (record: Record<string, unknown>) => {
    const line = JSON.stringify({
      rev: REV,
      session: SESSION,
      fixture: fixtureKey,
      variant,
      ...record,
    })
    appendFileSync(OUT, `${line}\n`)
    // eslint-disable-next-line no-console
    console.log(`[mode-switch-probe] ${line}`)
  }
  if (variant === 'gutter')
    await setConfig(evaluateInVSCode, 'editor.sourceLineNumbers', true)
  try {
    const frame = await reopenVmdeFixture(evaluateInVSCode, workbox, file)
    await waitForE2EReadiness(frame, (s) => s.routerReady && s.mode === 'ir', {
      timeout: 60_000,
      message: 'IR ready',
    })
    await waitForInitialUndoSnapshot(frame, 30_000)
    // The open's own rendering work (large fixtures) is quiet before the first timed switch.
    await settle(frame, 3000)
    await ensureOutline(frame, variant === 'outline')
    const start = await startState(frame)
    expect(start.mode, 'session starts in IR').toBe('ir')
    expect(start.previewShown, 'session starts with Preview off').toBe(false)
    const sources = await instrument(frame)
    if (ATTR) {
      write({
        record: 'attr-setup',
        attr: ATTR,
        stash: await stashRoute(frame),
      })
      if (ATTR === 'wrap')
        write({ record: 'attr-wrap', wrapped: await wrapCalls(frame) })
    }
    write({
      record: 'session',
      bytes: statSync(file).size,
      sources,
      loadStart,
      openMetrics: start.openMetrics,
    })

    const step = async (
      kind: Kind,
      needRender: boolean,
      row: Omit<Row, 'sample' | 'fixture' | 'variant'>,
    ) => {
      await arm(frame, kind, needRender)
      if (kind === 'on' || kind === 'off') {
        await frame.locator(PREVIEW_BUTTON).click()
      } else {
        await frame.locator('.vditor-toolbar [data-type="edit-mode"]').click()
        await frame.locator(`button[data-mode="${kind}"]`).click()
      }
      const sample = await result(frame)
      write({ record: 'sample', ...row, ...sample })
      if (!sample.ok)
        throw new Error(
          `${fixtureKey}/${variant}: ${sample.failure ?? 'not settled'} (${kind}, ${row.phase} ${row.cycle})`,
        )
      await settle(frame, IDLE_GAP_MS)
    }

    let cdp: import('@playwright/test').CDPSession | null = null
    if (process.env.VMDE_PROBE_PROFILE) {
      try {
        cdp = await workbox.context().newCDPSession(workbox)
        await cdp.send('Profiler.enable')
        await cdp.send('Profiler.setSamplingInterval', { interval: 100 })
        await cdp.send('Profiler.start')
        write({ record: 'profile', status: 'started' })
      } catch (error) {
        write({ record: 'profile', status: `not attached: ${String(error)}` })
      }
    }
    for (let cycle = 0; ATTR && cycle < WARMUP + CYCLES; cycle++) {
      const phase = cycle < WARMUP ? 'warmup' : 'measured'
      for (const route of ATTR === 'ab'
        ? (['A', 'B'] as const)
        : (['A'] as const)) {
        if (ATTR === 'ab') await setRoute(frame, route)
        await invalidate(frame)
        await step('on', true, { cycle, phase, route })
        await step('off', false, { cycle, phase, route })
      }
    }
    for (let cycle = 0; !ATTR && cycle < WARMUP + CYCLES; cycle++) {
      const phase = cycle < WARMUP ? 'warmup' : 'measured'
      await invalidate(frame)
      await step('on', true, { cycle, phase })
      await step('off', false, { cycle, phase })
      await step('sv', true, { cycle, phase })
      await step('ir', false, { cycle, phase })
    }
    // Reuse variant: prime one fresh render, then pairs that the Task 530 reuse can skip.
    if (!ATTR) {
      await invalidate(frame)
      await step('on', true, { cycle: -1, phase: 'reuse' })
      await step('off', false, { cycle: -1, phase: 'reuse' })
    }
    for (let pair = 0; !ATTR && pair < REUSE_PAIRS; pair++) {
      await step('on', false, { cycle: pair, phase: 'reuse' })
      await step('off', false, { cycle: pair, phase: 'reuse' })
    }
    if (cdp) {
      const { profile } = (await cdp.send('Profiler.stop')) as {
        profile: unknown
      }
      writeFileSync(
        OUT.replace(/\.jsonl$/, `-${fixtureKey}.cpuprofile`),
        JSON.stringify(profile),
      )
      write({ record: 'profile', status: 'saved' })
    }
    const end = await startState(frame)
    write({
      record: 'end',
      mode: end.mode,
      previewShown: end.previewShown,
      loadStart,
      loadEnd: os.loadavg()[0],
    })
  } finally {
    if (variant === 'gutter')
      await setConfig(evaluateInVSCode, 'editor.sourceLineNumbers', undefined)
    if (variant === 'outline') {
      const frame = await reopenVmdeFixture(evaluateInVSCode, workbox, file)
      await ensureOutline(frame, false).catch(() => undefined)
    }
  }
}

for (const key of ['small', 'mid', 'large'] as const) {
  test(`@probe mode-switch fixture=${key} variant=defaults`, async ({
    workbox,
    evaluateInVSCode,
    baseDir,
  }) => {
    test.setTimeout(900_000)
    await runSession(key, 'defaults', { evaluateInVSCode, workbox, baseDir })
  })
}

test('@probe mode-switch fixture=large variant=outline', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(900_000)
  await runSession('large', 'outline', { evaluateInVSCode, workbox, baseDir })
})

// Feature cost on dev only: the reference has no source line-number setting.
test('@probe mode-switch fixture=large variant=gutter', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.skip(!process.env.VMDE_PROBE_GUTTER, 'dev only: set VMDE_PROBE_GUTTER=1')
  test.setTimeout(900_000)
  await runSession('large', 'gutter', { evaluateInVSCode, workbox, baseDir })
})
