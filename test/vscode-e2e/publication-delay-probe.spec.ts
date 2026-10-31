/**
 * Task 624 S1 — publication-delay probe (non-asserting, @probe).
 *
 * Question: during continuous typing, how long does a typed key wait before the webview posts an
 * `edit` message that contains it, and does the host see it? Is the delay bounded by the edit-sync
 * debounce (250 ms) plus one frame, in IR (prose and punctuation), Split View and WYSIWYG?
 *
 * Per run it records, from independent observers: the OS key times (webview trusted `keydown`),
 * `input` event times, Vditor `options.input()` calls, every webview `edit` post (time and size),
 * Vditor undo-stack entries, the host's text-document change events, `document.visibilityState`
 * and `hasFocus()` in the webview and workbench frames, and a 100 ms `setTimeout` lateness sampler
 * (lateness and phase modulo 1000 ms) to show whether the webview's timers run on a throttled grid.
 *
 * Nothing in the editor is changed: the recorders are pass-through wrappers. Texts stay in this
 * process; only lengths, times and flags are exported. Results go to `tmp/624/s1/`.
 *
 * Selection: `VMDE_624_SET` = `ir` | `sv` | `wysiwyg` | `control` | `all` (default `all`).
 * Run: `VMDE_XTEST=1 npm --prefix test/vscode-e2e run test:probes -- publication-delay-probe.spec.ts`
 * inside an isolated Xvfb/Openbox session (see the vmde-testing skill).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import {
  type Ctx,
  closeAll,
  evalFrame,
  type Kit,
  type Mode,
  makeKit,
  openDocument,
  select,
} from './helpers/shortcut-xtest-kit'
import { waitForInitialUndoSnapshot } from './webview-helpers'

const OUT =
  process.env.VMDE_624_OUT ||
  path.join(__dirname, '..', '..', 'tmp', '624', 's1')
const LABEL = 'Task 624 S1'
const ANCHOR = 'delta.'
const HEAD =
  '# Probe\n\nAlpha bravo charlie delta.\n\nEcho foxtrot golf hotel.\n\n'
const SMALL_DOC = `${HEAD}India juliet kilo lima.\n`
const PROSE = readFileSync(
  path.join(__dirname, 'fixtures', 'perf-prose.md'),
  'utf8',
)
// About 160 KB of prose: the anchor paragraph, then the fixture three times.
const LARGE_DOC = `${HEAD}${PROSE}\n${PROSE}\n${PROSE}`
const GAPS = [180, 300, 440, 600]
const RUNS = 8
// The edit-sync debounce plus one frame, with a small allowance for the XTEST and poll overhead.
const BOUND_MS = 250 + 17 + 50

type Case = {
  title: string
  mode: Mode
  large: boolean
  chars: 'prose' | 'punct'
  gaps: number[]
  runs: number
}

const LETTERS = 'abcdefghijklmnopqrstuvwx'
const PUNCT = 'a.b,c;d:e!f?g.h,i;j:k!l?m.n,o;p:q!r?s.t,u;v:w!x?'
const keysFor = (chars: Case['chars'], count: number) =>
  (chars === 'prose' ? LETTERS : PUNCT).slice(0, count)

const CASES: Record<string, Case[]> = {
  ir: [
    {
      title: 'ir-prose',
      mode: 'ir',
      large: true,
      chars: 'prose',
      gaps: GAPS,
      runs: RUNS,
    },
    {
      title: 'ir-punct',
      mode: 'ir',
      large: true,
      chars: 'punct',
      gaps: GAPS,
      runs: RUNS,
    },
  ],
  sv: [
    {
      title: 'sv-prose',
      mode: 'sv',
      large: true,
      chars: 'prose',
      gaps: GAPS,
      runs: RUNS,
    },
  ],
  wysiwyg: [
    {
      title: 'wysiwyg-prose',
      mode: 'wysiwyg',
      large: true,
      chars: 'prose',
      gaps: GAPS,
      runs: RUNS,
    },
  ],
  control: [
    {
      title: 'ir-small-control',
      mode: 'ir',
      large: false,
      chars: 'prose',
      gaps: [440],
      runs: 4,
    },
  ],
}
const SELECTED = (process.env.VMDE_624_SET || 'all')
  .split(',')
  .flatMap((name) => (name === 'all' ? Object.keys(CASES) : [name]))
for (const name of SELECTED)
  if (!CASES[name]) throw new Error(`unknown set ${name}`)

// --- In-page probe (self-contained; runs in the webview frame) ---

function installInPage(): boolean {
  const w = window as any
  const inner = w.vditor?.vditor
  if (!inner?.undo || !w.vscode?.postMessage) return false
  if (w.__p624) return true
  const p: any = {
    keys: [],
    inputs: [],
    optInputs: [],
    posts: [],
    adds: [],
    samples: [],
  }
  const trusted = (list: any[], event: Event, extra: object = {}) => {
    if (event.isTrusted) list.push({ t: Date.now(), ...extra })
  }
  window.addEventListener(
    'keydown',
    (event) => trusted(p.keys, event, { key: event.key }),
    true,
  )
  document.addEventListener('input', (event) => trusted(p.inputs, event), true)
  const undo = inner.undo
  const add = undo.addToUndoStack
  undo.addToUndoStack = function (...args: unknown[]) {
    const result = add.apply(this, args)
    p.adds.push({ t: Date.now() })
    return result
  }
  const api = w.vscode
  const post = api.postMessage
  const wrapper = Object.create(api)
  Object.defineProperty(wrapper, 'postMessage', {
    enumerable: true,
    value: (message: any, ...rest: unknown[]) => {
      if (message?.command === 'edit')
        p.posts.push({
          t: Date.now(),
          len:
            typeof message.content === 'string' ? message.content.length : -1,
          exact: !!message.exact,
          revision: message.revision ?? null,
        })
      return post.call(api, message, ...rest)
    },
  })
  w.vscode = wrapper
  p.wrapped = w.vscode === wrapper
  const input = inner.options.input
  if (typeof input === 'function')
    inner.options.input = function (...args: unknown[]) {
      p.optInputs.push({ t: Date.now() })
      return input.apply(this, args)
    }
  // Timer lateness: a 100 ms timeout chain. Lateness above ~50 ms and a phase that repeats modulo
  // 1000 ms mean the webview's timers run on a throttled grid.
  let expected = performance.now() + 100
  const tick = () => {
    const now = performance.now()
    p.samples.push({
      t: Date.now(),
      late: Math.round(now - expected),
      phase: Math.round(performance.timeOrigin + now) % 1000,
      vis: document.visibilityState,
      focus: document.hasFocus(),
    })
    expected = performance.now() + 100
    setTimeout(tick, 100)
  }
  setTimeout(tick, 100)
  w.__p624 = p
  return true
}

function readInPage(_body: Element, since: number) {
  const p = (window as any).__p624
  const after = (list: any[]) => list.filter((e) => e.t >= since)
  const samples = after(p.samples)
  const late = samples.filter((s: any) => s.late > 150)
  return {
    keys: after(p.keys),
    inputs: after(p.inputs),
    optInputs: after(p.optInputs),
    posts: after(p.posts),
    adds: after(p.adds),
    wrapped: p.wrapped,
    sampler: {
      count: samples.length,
      maxLate: samples.reduce((m: number, s: any) => Math.max(m, s.late), 0),
      lateCount: late.length,
      latePhases: late.slice(0, 60).map((s: any) => s.phase),
      lateTimes: late.slice(0, 60).map((s: any) => s.t),
      visibility: [...new Set(samples.map((s: any) => s.vis))],
      focus: [...new Set(samples.map((s: any) => s.focus))],
    },
  }
}

// --- Host probe ---

const installHost = (ctx: Ctx) =>
  ctx.kit.host(
    (vscode, [fsPath]: [string]) => {
      const g = globalThis as any
      for (const sub of g.__p624Subs ?? []) sub.dispose()
      const rec = {
        events: [] as { t: number; changes: number; len: number }[],
      }
      g.__p624Host = rec
      g.__p624Subs = [
        vscode.workspace.onDidChangeTextDocument((event) => {
          if (event.document.uri.fsPath !== fsPath) return
          rec.events.push({
            t: Date.now(),
            changes: event.contentChanges.length,
            len: event.document.getText().length,
          })
        }),
      ]
    },
    [ctx.file],
  )

const readHost = (kit: Kit, since: number) =>
  kit.host(
    (_vscode, [from]: [number]) =>
      (
        (globalThis as any).__p624Host.events as {
          t: number
          changes: number
          len: number
        }[]
      ).filter((e) => e.t >= from),
    [since],
  )

const disposeHost = (kit: Kit) =>
  kit.host(() => {
    const g = globalThis as any
    for (const sub of g.__p624Subs ?? []) sub.dispose()
    g.__p624Subs = []
  }, [])

const workbenchState = (kit: Kit) =>
  kit.workbox.evaluate(() => ({
    vis: document.visibilityState,
    focus: document.hasFocus(),
  }))

const uptimeNow = () => {
  const [one, five, fifteen] = os.loadavg()
  return {
    load1: +one.toFixed(2),
    load5: +five.toFixed(2),
    load15: +fifteen.toFixed(2),
  }
}

async function runOnce(
  ctx: Ctx,
  c: Case,
  gap: number,
  index: number,
  prev: Record<string, unknown> | null,
) {
  const { kit } = ctx
  const count = gap <= 180 ? 24 : 12
  const keys = keysFor(c.chars, count)
  await select(ctx, ANCHOR, { collapsed: true, offset: ANCHOR.length })
  const wbBefore = await workbenchState(kit)
  const loadBefore = uptimeNow()
  const since = Date.now()
  for (let i = 0; i < keys.length; i++) {
    await kit.xtest.type(keys[i])
    if (i < keys.length - 1) await kit.workbox.waitForTimeout(gap)
  }
  const typedEnd = Date.now()
  // Natural settle: no new post or host change for 700 ms and at least 1,800 ms after the last key
  // (above the 800 ms checkpoint delay and, for large WYSIWYG, its 2,000 ms window plus 250 ms).
  let page = await evalFrame(kit, readInPage, since)
  let quietSince = Date.now()
  let seenPosts = page.posts.length
  const settleStart = Date.now()
  while (Date.now() - settleStart < 9000) {
    page = await evalFrame(kit, readInPage, since)
    if (page.posts.length !== seenPosts) {
      seenPosts = page.posts.length
      quietSince = Date.now()
    }
    if (Date.now() - typedEnd >= 2600 && Date.now() - quietSince >= 700) break
    await kit.workbox.waitForTimeout(100)
  }
  const host = await readHost(kit, since)
  const wbAfter = await workbenchState(kit)
  const loadAfter = uptimeNow()

  const keyTimes: number[] = page.keys.map((k: any) => k.t)
  const postTimes: number[] = page.posts.map((p: any) => p.t)
  const hostTimes: number[] = host.filter((e) => e.changes > 0).map((e) => e.t)
  const firstAfter = (times: number[], t: number) => times.find((x) => x >= t)
  const delays = keyTimes.map((t) => {
    const post = firstAfter(postTimes, t)
    return post === undefined ? null : post - t
  })
  const hostDelays = keyTimes.map((t) => {
    const event = firstAfter(hostTimes, t)
    return event === undefined ? null : event - t
  })
  const gapsActual = keyTimes.slice(1).map((t, i) => t - keyTimes[i])
  const interPost = postTimes.slice(1).map((t, i) => t - postTimes[i])
  const lastKey = keyTimes[keyTimes.length - 1]
  const lastDelay = delays[delays.length - 1]
  const numeric = (list: (number | null)[]) =>
    list.filter((v): v is number => v !== null)
  const maxDelay = numeric(delays).length ? Math.max(...numeric(delays)) : null
  const result = {
    id: `${c.title}:gap${gap}:run${index}`,
    mode: c.mode,
    large: c.large,
    gapRequested: gap,
    keysTyped: keys.length,
    keysSeen: keyTimes.length,
    inputsSeen: page.inputs.length,
    optInputCalls: page.optInputs.length,
    meanActualGap: gapsActual.length
      ? Math.round(gapsActual.reduce((a, b) => a + b, 0) / gapsActual.length)
      : null,
    posts: page.posts.length,
    postTimesRel: postTimes.map((t) => t - (keyTimes[0] ?? since)),
    postLens: page.posts.map((p: any) => p.len),
    entries: page.adds.length,
    entryTimesRel: page.adds.map((a: any) => a.t - (keyTimes[0] ?? since)),
    hostEdits: hostTimes.length,
    hostTimesRel: hostTimes.map((t) => t - (keyTimes[0] ?? since)),
    keyDelays: delays,
    hostKeyDelays: hostDelays,
    maxDelay,
    lastKeyDelay: lastDelay,
    keysOverBound: numeric(delays).filter((d) => d > BOUND_MS).length,
    maxInterPost: interPost.length ? Math.max(...interPost) : null,
    // A post-free stretch longer than 1,000 ms while keys were arriving.
    stallDuringTyping:
      lastKey !== undefined && keyTimes.length > 1
        ? (() => {
            const inWindow = [
              keyTimes[0],
              ...postTimes.filter((t) => t <= lastKey),
              lastKey,
            ]
            let worst = 0
            for (let i = 1; i < inWindow.length; i++)
              worst = Math.max(worst, inWindow[i] - inWindow[i - 1])
            return worst
          })()
        : null,
    sampler: page.sampler,
    webview: { visibility: page.sampler.visibility, focus: page.sampler.focus },
    workbench: { before: wbBefore, after: wbAfter },
    load: { before: loadBefore, after: loadAfter },
    previous: prev,
  }
  return result
}

test.describe('Task 624 S1 publication delay @probe', () => {
  test.skip(
    process.env.VMDE_XTEST !== '1',
    'requires isolated Xvfb/Openbox XTEST',
  )

  test.afterEach(async ({ evaluateInVSCode }) => {
    await evaluateInVSCode(async (vscode) => {
      await vscode.workspace
        .getConfiguration('vmde')
        .update('editor.defaultMode', undefined, true)
    })
  })

  for (const name of SELECTED) {
    for (const c of CASES[name]) {
      test(`${c.title} @probe`, async ({
        workbox,
        electronApp,
        evaluateInVSCode,
        baseDir,
      }) => {
        test.setTimeout(3_000_000)
        const kit = await makeKit(
          workbox,
          electronApp,
          evaluateInVSCode,
          baseDir,
          LABEL,
        )
        const startedAt = new Date().toISOString()
        const ctx = await openDocument(
          kit,
          `p624-${c.title}.md`,
          c.large ? LARGE_DOC : SMALL_DOC,
          c.mode,
        )
        try {
          await installHost(ctx)
          await waitForInitialUndoSnapshot(kit.frame())
          expect(
            await evalFrame(kit, installInPage, 0),
            'probe installed',
          ).toBe(true)
          const results: Record<string, unknown>[] = []
          let prev: Record<string, unknown> | null = null
          for (const gap of c.gaps) {
            for (let index = 0; index < c.runs; index++) {
              const r = await runOnce(ctx, c, gap, index, prev)
              results.push(r)
              prev = {
                id: r.id,
                maxDelay: r.maxDelay,
                lastKeyDelay: r.lastKeyDelay,
                maxLate: (r.sampler as { maxLate: number }).maxLate,
              }
              console.log(
                `[${LABEL}] ${r.id} keys=${r.keysSeen}/${r.keysTyped} posts=${r.posts} hostEdits=${r.hostEdits} maxDelay=${r.maxDelay} last=${r.lastKeyDelay} over=${r.keysOverBound} stall=${r.stallDuringTyping} maxLate=${(r.sampler as { maxLate: number }).maxLate} vis=${(r.webview as { visibility: string[] }).visibility} load1=${(r.load as { before: { load1: number } }).before.load1}`,
              )
            }
          }
          mkdirSync(OUT, { recursive: true })
          writeFileSync(
            path.join(OUT, `results-${c.title}.json`),
            `${JSON.stringify({ startedAt, boundMs: BOUND_MS, results }, null, 1)}\n`,
          )
        } finally {
          await disposeHost(kit)
          await closeAll(kit, ctx.file)
        }
      })
    }
  }
})
