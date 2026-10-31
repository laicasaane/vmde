import { appendFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { test } from './coverage-fixture'

// @probe — Task 612 P2-1. Non-asserting measurements of PageUp/PageDown travel near hidden IR
// markers. Gated by VMDE_PROBES=1 because the matrix takes minutes and asserts nothing:
//   VMDE_PROBES=1 xvfb-run -a npm --prefix media-src run test:e2e -- ir-page-navigation-probes.spec.ts
// Rows go to $VMDE_PROBE_OUT (default tmp/612/p2-1/chromium-rows.json); the analysis script reads them.

test.skip(!process.env.VMDE_PROBES, 'measurement probe: set VMDE_PROBES=1')
test.describe.configure({ mode: 'serial' })

interface Measurement {
  docY: number
  x: number
  scrollTop: number
  clientHeight: number
  scrollHeight: number
  lineHeight: number
  container: string
  text: string
  offset: number
  collapsed: boolean
  rectFallback: boolean
  anchorDocY: number
  selected: string
}
interface Row {
  group: string
  viewport: string
  font: string
  mode: string
  kind: string
  css: string
  start: string
  key: string
  press: number
  m: Measurement | null
  prevDocY: number
}

const FONTS: Record<string, string> = {
  default: '',
  serif: '"DejaVu Serif", serif',
}
const VIEWPORTS: Record<
  string,
  { width: number; height: number; editor: number }
> = {
  default: { width: 1280, height: 720, editor: 320 },
  large: { width: 1600, height: 1000, editor: 900 },
}
// Candidate CSS routes tried live (P2-1). `a`: Task 369's out-of-flow rule for every collapsed inline
// marker. `b`: the same rule for link markers only.
const CSS: Record<string, string> = {
  none: '',
  a: `.vditor-ir .vditor-reset .vditor-ir__node:not(.vditor-ir__node--expand):not([data-block]) > .vditor-ir__marker { position:absolute; display:block; width:0; height:0; overflow:hidden; }`,
  // `d` is a diagnostic only: Vditor's stock inline-block markers for code (undoes Task 369's rule).
  d: `.vditor-ir .vditor-reset .vditor-ir__node:not(.vditor-ir__node--expand)[data-type='code'] > .vditor-ir__marker { position:static; display:inline-block; width:0; height:0; overflow:hidden; }`,
  // `h`: stock inline-block code markers plus a word joiner before the collapsed code node, to keep
  // Task 369's "no break opportunity before the code" without an out-of-flow marker.
  h: `.vditor-ir .vditor-reset .vditor-ir__node:not(.vditor-ir__node--expand)[data-type='code'] > .vditor-ir__marker { position:static; display:inline-block; width:0; height:0; overflow:hidden; } .vditor-ir .vditor-reset .vditor-ir__node:not(.vditor-ir__node--expand)[data-type='code']::before { content:'\\2060'; }`,
  // `i`: Task 369's out-of-flow markers made non-selectable.
  i: `.vditor-ir .vditor-reset .vditor-ir__node:not(.vditor-ir__node--expand)[data-type='code'] > .vditor-ir__marker { position:absolute; display:block; width:0; height:0; overflow:hidden; user-select:none; }`,
  b: `.vditor-ir .vditor-reset .vditor-ir__node:not(.vditor-ir__node--expand)[data-type='a'] > .vditor-ir__marker { position:absolute; display:block; width:0; height:0; overflow:hidden; }`,
}
const PRESSES = 3
const OUT =
  process.env.VMDE_PROBE_OUT ??
  path.resolve(__dirname, '../../tmp/612/p2-1/chromium-rows.jsonl')
mkdirSync(path.dirname(OUT), { recursive: true })
// Append each row as it is measured, so a killed run keeps what it measured.
const rows = {
  push(row: Row) {
    appendFileSync(OUT, `${JSON.stringify(row)}\n`)
  },
}

const probe = <T>(page: Page, fn: string, ...args: unknown[]): Promise<T> =>
  page.evaluate(
    ([name, a]) =>
      (
        window as unknown as {
          __probe: Record<string, (...x: unknown[]) => unknown>
        }
      ).__probe[name as string](...(a as unknown[])),
    [fn, args] as [string, unknown[]],
  ) as Promise<T>

async function load(
  page: Page,
  o: {
    kind: string
    mode: string
    viewport: string
    font: string
    css: string
  },
) {
  const vp = VIEWPORTS[o.viewport]
  await page.setViewportSize({ width: vp.width, height: vp.height })
  const q = new URLSearchParams({
    doc: o.kind,
    mode: o.mode,
    height: String(vp.editor),
    font: FONTS[o.font],
    n: o.viewport === 'large' ? '90' : '60',
    // Measure the native move: the Task 612 repair is not installed.
    nopatch: '1',
  })
  await page.goto(`/ir-page-navigation.html?${q}`)
  await page.waitForFunction(
    () => (window as unknown as { __ready?: boolean }).__ready,
  )
  if (CSS[o.css]) await page.addStyleTag({ content: CSS[o.css] })
  await page.waitForTimeout(300)
}

async function runCase(
  page: Page,
  base: Omit<Row, 'press' | 'm' | 'prevDocY' | 'key' | 'start'>,
  start: string,
  key: string,
) {
  const placed = await probe<boolean>(page, 'place', start)
  if (!placed) throw new Error(`cannot place ${start} for ${base.kind}`)
  await page.waitForTimeout(160)
  let prev =
    (await probe<Measurement | null>(page, 'measure'))?.docY ?? Number.NaN
  rows.push({
    ...base,
    start,
    key: 'start',
    press: 0,
    m: await probe(page, 'measure'),
    prevDocY: prev,
  })
  for (let press = 1; press <= PRESSES; press++) {
    await page.keyboard.press(key)
    await page.waitForTimeout(160)
    const m = await probe<Measurement | null>(page, 'measure')
    rows.push({ ...base, start, key, press, m, prevDocY: prev })
    prev = m?.docY ?? Number.NaN
  }
}

async function modifyCase(
  page: Page,
  base: Omit<Row, 'press' | 'm' | 'prevDocY' | 'key' | 'start'>,
  start: string,
  dir: 'backward' | 'forward',
) {
  await probe<boolean>(page, 'place', start)
  await page.waitForTimeout(160)
  const m0 = await probe<Measurement | null>(page, 'measure')
  const ys = await probe<number[]>(page, 'modifySteps', dir, 14)
  rows.push({
    ...base,
    group: 'modify',
    start,
    key: `modify-${dir}`,
    press: 0,
    m: m0 && { ...m0, text: JSON.stringify(ys.map((y) => Math.round(y))) },
    prevDocY: m0?.docY ?? Number.NaN,
  })
}

const KINDS = [
  'link',
  'code',
  'strong',
  'em',
  'plain',
  'mixed',
  'wlink',
  'wcode',
]
const STARTS_UP = ['anchor-end', 'mid-start', 'mid-mid', 'mid-end']
const STARTS_DOWN = ['anchor-top-end', 'mid-start', 'mid-mid', 'mid-end']

for (const viewport of Object.keys(VIEWPORTS))
  for (const font of Object.keys(FONTS))
    test(`@probe baseline matrix: ${viewport} viewport, ${font} font`, async ({
      page,
    }) => {
      test.setTimeout(3_600_000)
      for (const kind of KINDS) {
        const base = {
          group: 'baseline',
          viewport,
          font,
          mode: 'ir',
          kind,
          css: 'none',
        }
        await load(page, { kind, mode: 'ir', viewport, font, css: 'none' })
        for (const start of STARTS_UP)
          await runCase(page, base, start, 'PageUp')
        for (const start of STARTS_DOWN)
          await runCase(page, base, start, 'PageDown')
      }
    })

test('@probe Shift+PageUp/PageDown selection travel near markers', async ({
  page,
}) => {
  test.setTimeout(1_800_000)
  for (const font of Object.keys(FONTS))
    for (const kind of ['link', 'code', 'strong', 'plain']) {
      const base = {
        group: 'shift',
        viewport: 'default',
        font,
        mode: 'ir',
        kind,
        css: 'none',
      }
      await load(page, {
        kind,
        mode: 'ir',
        viewport: 'default',
        font,
        css: 'none',
      })
      for (const start of ['anchor-end', 'mid-mid'])
        await runCase(page, base, start, 'Shift+PageUp')
      for (const start of ['anchor-top-end', 'mid-mid'])
        await runCase(page, base, start, 'Shift+PageDown')
    }
})

test('@probe Selection.modify line steps near markers', async ({ page }) => {
  test.setTimeout(1_800_000)
  for (const font of Object.keys(FONTS))
    for (const kind of KINDS) {
      const base = {
        group: 'modify',
        viewport: 'default',
        font,
        mode: 'ir',
        kind,
        css: 'none',
      }
      await load(page, {
        kind,
        mode: 'ir',
        viewport: 'default',
        font,
        css: 'none',
      })
      for (const start of ['anchor-end', 'mid-mid', 'mid-end'])
        await modifyCase(page, base, start, 'backward')
      for (const start of ['anchor-top-end', 'mid-mid'])
        await modifyCase(page, base, start, 'forward')
    }
})

test('@probe controls: WYSIWYG and SV with the same documents', async ({
  page,
}) => {
  test.setTimeout(1_800_000)
  for (const mode of ['wysiwyg', 'sv'])
    for (const font of Object.keys(FONTS))
      for (const kind of ['plain', 'link', 'strong']) {
        const base = {
          group: 'control',
          viewport: 'default',
          font,
          mode,
          kind,
          css: 'none',
        }
        await load(page, { kind, mode, viewport: 'default', font, css: 'none' })
        for (const start of ['anchor-end', 'mid-mid'])
          await runCase(page, base, start, 'PageUp')
        for (const start of ['anchor-top-end', 'mid-mid'])
          await runCase(page, base, start, 'PageDown')
      }
})

test('@probe candidate CSS routes a and b', async ({ page }) => {
  test.setTimeout(3_600_000)
  for (const css of ['a', 'b'])
    for (const font of Object.keys(FONTS))
      for (const kind of ['link', 'code', 'strong', 'em', 'mixed']) {
        const base = {
          group: `css-${css}`,
          viewport: 'default',
          font,
          mode: 'ir',
          kind,
          css,
        }
        await load(page, { kind, mode: 'ir', viewport: 'default', font, css })
        for (const start of ['anchor-end', 'mid-mid', 'mid-end'])
          await runCase(page, base, start, 'PageUp')
        for (const start of ['anchor-top-end', 'mid-mid', 'mid-end'])
          await runCase(page, base, start, 'PageDown')
      }
})

for (const cand of ['d', 'h', 'i'])
  test(`@probe diagnostic css-${cand}`, async ({ page }) => {
    test.setTimeout(900_000)
    for (const font of Object.keys(FONTS))
      for (const kind of ['code', 'mixed', 'wcode']) {
        const base = {
          group: `css-${cand}`,
          viewport: 'default',
          font,
          mode: 'ir',
          kind,
          css: cand,
        }
        await load(page, {
          kind,
          mode: 'ir',
          viewport: 'default',
          font,
          css: cand,
        })
        for (const start of ['anchor-end', 'mid-mid', 'mid-end'])
          await runCase(page, base, start, 'PageUp')
        for (const start of ['anchor-top-end', 'mid-start', 'mid-mid'])
          await runCase(page, base, start, 'PageDown')
      }
  })
