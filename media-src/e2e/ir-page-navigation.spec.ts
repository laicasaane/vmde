import type { Page } from '@playwright/test'
import { expect, test } from './coverage-fixture'

// Task 612 — PageUp/PageDown travel next to collapsed inline code in IR (Chromium harness).
// Task 369 takes the collapsed code markers out of flow, and Chromium's native page move then stops
// dead next to them (zero caret travel). `ir-page-navigation.ts` redoes a stalled press from where
// it started, so the markers and Task 369's layout stay as they are.

const WORD_JOINER = '⁠'
const FONTS: Record<string, string> = {
  default: '',
  serif: '"DejaVu Serif", serif',
}
const VIEWPORTS = {
  default: { width: 1280, height: 720, editor: 320, lines: 60 },
  large: { width: 1600, height: 1000, editor: 900, lines: 150 },
} as const

// Vditor's own hiding of the markers, i.e. Task 369's rule undone: what the native page move does in
// the same document when the code markers are in flow.
const STOCK_CODE_MARKERS = `.vditor-ir .vditor-reset .vditor-ir__node:not(.vditor-ir__node--expand)[data-type='code'] > .vditor-ir__marker { position: static !important; display: inline-block !important; width: 0 !important; height: 0 !important; overflow: hidden !important; }`

interface Measurement {
  docY: number
  x: number
  scrollTop: number
  clientHeight: number
  lineHeight: number
  anchorDocY: number
  collapsed: boolean
  selected: string
}

async function load(
  page: Page,
  o: {
    kind: string
    viewport?: keyof typeof VIEWPORTS
    font?: string
    width?: number
    /** Native reference: no repair installed and Vditor's stock inline-block code markers. */
    native?: boolean
  },
) {
  const vp = VIEWPORTS[o.viewport ?? 'default']
  await page.setViewportSize({ width: vp.width, height: vp.height })
  const q = new URLSearchParams({
    doc: o.kind,
    mode: 'ir',
    height: String(vp.editor),
    font: FONTS[o.font ?? 'default'],
    n: String(vp.lines),
  })
  if (o.width) q.set('width', String(o.width))
  // RED check: the native move without the repair (`P612_NOPATCH=1`).
  if (process.env.P612_NOPATCH || o.native) q.set('nopatch', '1')
  await page.goto(`/ir-page-navigation.html?${q}`)
  await page.waitForFunction(
    () => (window as unknown as { __ready?: boolean }).__ready,
  )
  if (o.native) await page.addStyleTag({ content: STOCK_CODE_MARKERS })
  await page.waitForTimeout(300)
}

const place = (page: Page, where: string) =>
  page.evaluate(
    (w) =>
      (
        window as unknown as { __probe: { place(x: string): boolean } }
      ).__probe.place(w),
    where,
  )

const measure = (page: Page) =>
  page.evaluate(() =>
    (
      window as unknown as { __probe: { measure(): Measurement | null } }
    ).__probe.measure(),
  ) as Promise<Measurement>

const value = (page: Page) =>
  page.evaluate(() =>
    (window as unknown as { vditor: { getValue(): string } }).vditor.getValue(),
  )

const copy = (page: Page) =>
  page.evaluate(() =>
    (
      window as unknown as {
        __probe: { copySelection(): { plain: string; html: string } }
      }
    ).__probe.copySelection(),
  )

interface PressRun {
  travel: number[]
  /** Caret x (viewport) after each press. */
  x: number[]
  /** Total scroll offset change over all presses. */
  scrolled: number
  /** Caret y within the view after the last press. */
  endViewportY: number
}

// Caret travel (px) of each press, after letting the marker controller settle.
async function pressRun(
  page: Page,
  key: string,
  presses: number,
): Promise<PressRun> {
  const start = await measure(page)
  const run: PressRun = { travel: [], x: [], scrolled: 0, endViewportY: 0 }
  let prev = start.docY
  let last = start
  for (let i = 0; i < presses; i++) {
    await page.keyboard.press(key)
    await page.waitForTimeout(160)
    last = await measure(page)
    run.travel.push(Math.abs(last.docY - prev))
    run.x.push(last.x)
    prev = last.docY
  }
  run.scrolled = Math.abs(last.scrollTop - start.scrollTop)
  run.endViewportY = last.docY - last.scrollTop
  return run
}

// The reference measured in the same document, viewport and font: what the native move does when the
// code markers are in flow. (A plain-text document has a different line pitch, so its travel differs
// by whole lines from a code document's; see the Task 612 record.)
async function controlRun(
  page: Page,
  kind: string,
  viewport: keyof typeof VIEWPORTS,
  font: string,
  start: string,
  key: string,
  presses: number,
) {
  await load(page, { kind, viewport, font, native: true })
  expect(await place(page, start)).toBe(true)
  await page.waitForTimeout(160)
  return pressRun(page, key, presses)
}

const CASES: {
  viewport: keyof typeof VIEWPORTS
  font: string
}[] = [
  { viewport: 'default', font: 'default' },
  { viewport: 'default', font: 'serif' },
  { viewport: 'large', font: 'default' },
]
const KINDS = ['code', 'mixed', 'wcode']
const STRICT_KINDS = ['code']
const MOVES: [string, string][] = [
  ['anchor-end', 'PageUp'],
  ['mid-mid', 'PageUp'],
  ['mid-end', 'PageUp'],
  ['anchor-top-end', 'PageDown'],
  ['mid-start', 'PageDown'],
  ['mid-mid', 'PageDown'],
]
const PRESSES = 3

for (const { viewport, font } of CASES)
  test(`PageUp/PageDown near collapsed code move a page like plain text (${viewport} viewport, ${font} font)`, async ({
    page,
  }) => {
    test.setTimeout(300_000)
    const controls = new Map<string, PressRun>()
    for (const kind of KINDS)
      for (const [start, key] of MOVES)
        controls.set(
          `${kind}|${start}|${key}`,
          await controlRun(page, kind, viewport, font, start, key, PRESSES),
        )
    for (const kind of KINDS) {
      for (const [start, key] of MOVES) {
        await load(page, { kind, viewport, font })
        expect(await place(page, start)).toBe(true)
        await page.waitForTimeout(160)
        const { clientHeight: ch, lineHeight: lh } = await measure(page)
        const run = await pressRun(page, key, PRESSES)
        const control = controls.get(`${kind}|${start}|${key}`) as PressRun
        const where = `${kind} ${start} ${key}`
        run.travel.forEach((t, i) => {
          const label = `${where} press ${i + 1}`
          expect(t, `${label}: travel ${t} of ${ch}`).toBeGreaterThanOrEqual(
            0.7 * ch,
          )
          expect(t, `${label}: at most one page`).toBeLessThanOrEqual(ch)
          // Same document, same start: a press that follows the native one lands within 1.5 lines.
          // `mixed` and `wrapped code` documents have lines of different heights, where native paging
          // itself lands a whole block either side of the reference once the starts diverge after
          // the first press (measured, see the Task 612 record), so only the single-height document
          // is compared press by press.
          if (STRICT_KINDS.includes(kind))
            expect(
              Math.abs(t - control.travel[i]),
              `${label}: vs native reference ${control.travel[i]}`,
            ).toBeLessThanOrEqual(1.5 * lh)
        })
        // The page key leaves the caret in view (a caret rect can sit up to a line above the view's
        // top edge when the native alignment uses the line box, as in link lines).
        expect(
          run.endViewportY,
          `${where}: caret in view at ${run.endViewportY}`,
        ).toBeGreaterThanOrEqual(-lh)
        expect(run.endViewportY).toBeLessThan(ch)
        if (STRICT_KINDS.includes(kind)) {
          // Criterion (2): the scroll offset follows the native reference over all presses.
          expect(
            Math.abs(run.scrolled - control.scrolled),
            `${where}: scrolled ${run.scrolled} vs native reference ${control.scrolled}`,
          ).toBeLessThanOrEqual(1.5 * lh)
          // Goal x: the caret column does not drift between presses 2 and 3 (press 1 may clamp to a
          // shorter line than the start; wrapped lines end at different columns).
          expect(
            Math.abs(run.x[2] - run.x[1]),
            `${where}: caret x ${run.x.join(', ')}`,
          ).toBeLessThanOrEqual(24)
        }
      }
    }
  })

// The Task 286 ejection writes element positions; on a wrapped paragraph the container's rect is the
// paragraph's first row, so the caret row must come from the child it sits next to.
test('a caret at the end of a wrapped paragraph is measured on its last row and pages a page', async ({
  page,
}) => {
  test.setTimeout(120_000)
  for (const key of ['PageUp', 'PageDown']) {
    await load(page, { kind: 'wcode' })
    expect(await place(page, 'mid-elem-end')).toBe(true)
    await page.waitForTimeout(160)
    const rows = await page.evaluate(() => {
      const probe = (window as unknown as { __probe: { surface: HTMLElement } })
        .__probe
      const selection = getSelection() as Selection
      const block = (selection.anchorNode as Element).closest(
        '[data-block]',
      ) as HTMLElement
      const blockTop =
        block.getBoundingClientRect().top -
        probe.surface.getBoundingClientRect().top +
        probe.surface.scrollTop
      return { blockTop, blockHeight: block.getBoundingClientRect().height }
    })
    const start = await measure(page)
    // wrapped code line: three or more visual rows; the caret is on the last one
    expect(rows.blockHeight).toBeGreaterThan(2.5 * start.lineHeight)
    expect(start.docY - rows.blockTop).toBeGreaterThan(1.5 * start.lineHeight)
    const run = await pressRun(page, key, 2)
    for (const t of run.travel) {
      expect(
        t,
        `${key} from a wrapped element position`,
      ).toBeGreaterThanOrEqual(0.7 * start.clientHeight)
      expect(t).toBeLessThanOrEqual(start.clientHeight)
    }
  }
})

test('Shift+PageUp/PageDown extend a selection a page from a code line, anchor fixed', async ({
  page,
}) => {
  test.setTimeout(120_000)
  for (const [start, key] of [
    ['mid-mid', 'Shift+PageUp'],
    ['mid-end', 'Shift+PageUp'],
    ['mid-mid', 'Shift+PageDown'],
  ] as const) {
    await load(page, { kind: 'code' })
    expect(await place(page, start)).toBe(true)
    await page.waitForTimeout(160)
    const before = await measure(page)
    const anchorPosition = () =>
      page.evaluate(() => {
        // The anchor as (block index, characters before it in the block). The editor may split the
        // anchor's text node when a repaired selection is written, so the position is what counts.
        const s = getSelection() as Selection
        const node = s.anchorNode as Node
        const block = (
          node.nodeType === Node.ELEMENT_NODE
            ? (node as Element)
            : node.parentElement
        )?.closest('[data-block]') as HTMLElement
        const prefix = document.createRange()
        prefix.setStart(block, 0)
        prefix.setEnd(node, s.anchorOffset)
        return {
          block: Array.from(block.parentElement?.children ?? []).indexOf(block),
          chars: prefix.toString().length,
        }
      })
    const anchorBefore = await anchorPosition()
    await page.keyboard.press(key)
    await page.waitForTimeout(160)
    const after = await measure(page)
    const label = `${start} ${key}`
    expect(after.collapsed, `${label}: selection extended`).toBe(false)
    expect(
      await anchorPosition(),
      `${label}: anchor position unchanged`,
    ).toEqual(anchorBefore)
    expect(
      Math.abs(after.docY - before.docY),
      `${label}: focus travel`,
    ).toBeGreaterThanOrEqual(0.7 * before.clientHeight)
    const copied = await copy(page)
    expect(copied.plain, `${label}: copy keeps content`).toContain('code-')
    // A selection that starts and ends outside every code node copies whole nodes: backticks pair up.
    expect(
      (copied.plain.match(/`/g) ?? []).length % 2,
      `${label}: balanced backticks in "${copied.plain.slice(0, 60)}"`,
    ).toBe(0)
    expect(copied.plain).not.toContain(WORD_JOINER)
    expect(copied.html).not.toContain(WORD_JOINER)
    expect(after.selected).not.toContain(WORD_JOINER)
  }
})

test('typing after a PageUp landing next to code keeps the markers and adds no word joiner', async ({
  page,
}) => {
  test.setTimeout(120_000)
  await load(page, { kind: 'code' })
  expect(await place(page, 'mid-mid')).toBe(true)
  await page.waitForTimeout(160)
  const before = await value(page)
  const startY = (await measure(page)).docY
  await page.keyboard.press('PageUp')
  await page.waitForTimeout(250)
  expect(startY - (await measure(page)).docY).toBeGreaterThan(100)
  await page.keyboard.type('Z')
  await page.waitForTimeout(200)
  const after = await value(page)
  expect(after.replace('Z', '')).toBe(before)
  expect(after.match(/Z/g)?.length).toBe(1)
  expect(after.split('`').length).toBe(before.split('`').length)
  expect(after).not.toContain(WORD_JOINER)
})

test('Task 369 stays: the collapsed code marker is still out of flow and 0 wide', async ({
  page,
}) => {
  await load(page, { kind: 'geo', width: 320 })
  const info = await page.evaluate(() => {
    const marker = document.querySelector(
      '.vditor-ir__node[data-type="code"] > .vditor-ir__marker',
    ) as HTMLElement
    return {
      position: getComputedStyle(marker).position,
      width: marker.getBoundingClientRect().width,
    }
  })
  expect(info).toEqual({ position: 'absolute', width: 0 })
})

test('expanding the code node still shows the backticks', async ({ page }) => {
  await load(page, { kind: 'geo', width: 320 })
  await page.evaluate(() => {
    const code = document.querySelector('.vditor-ir code') as HTMLElement
    const surface = document.querySelector(
      '.vditor-ir .vditor-reset',
    ) as HTMLElement
    surface.focus()
    const range = document.createRange()
    range.setStart(code.firstChild as Node, 2)
    range.collapse(true)
    const sel = getSelection() as Selection
    sel.removeAllRanges()
    sel.addRange(range)
  })
  await page.waitForTimeout(250)
  const info = await page.evaluate(() => {
    const node = document.querySelector(
      '.vditor-ir__node[data-type="code"]',
    ) as HTMLElement
    const marker = node.querySelector('.vditor-ir__marker') as HTMLElement
    return {
      expanded: node.classList.contains('vditor-ir__node--expand'),
      markerWidth: marker.getBoundingClientRect().width,
    }
  })
  expect(info.expanded).toBe(true)
  expect(info.markerWidth).toBeGreaterThan(4)
})
