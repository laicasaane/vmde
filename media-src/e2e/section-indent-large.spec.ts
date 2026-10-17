import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { expect, test } from './coverage-fixture'

// Task 649 S5: work bounds of section indentation on the Task 573 synthetic large document.
// Mechanism assertions (counters from the E2E-only mutation ledger and the opt-in source-index
// counter) run in CI; wall-clock times are recorded in the test output, not asserted. Targets from
// the task record: full pass at most 4 ms in IR and 8 ms in Split's preview pane, local pass median
// at most 1 ms.

const LARGE_SOURCE = readFileSync(
  path.join(
    __dirname,
    '../../test/vscode-e2e/fixtures/large-observable-models-synthetic.md',
  ),
  'utf8',
)

type Mode = 'ir' | 'sv'
const SURFACE: Record<Mode, string> = {
  ir: '.vditor-ir > .vditor-reset',
  sv: '.vditor-preview > .vditor-reset',
}

interface HelperStats {
  callbacks: number
  records: number
  full: number
  local: number
  skipped: number
  blocks: number
}

function initFor(mode: Mode, sectionIndent: boolean) {
  return {
    command: 'update',
    type: 'init',
    content: LARGE_SOURCE,
    cdn: '/vditor',
    // The E2E ledger (`__vmdeMutationImpactStats`) exists only when the init message asks for it.
    e2e: true,
    options: {
      showToolbar: true,
      useVscodeThemeColor: true,
      enableFullWidth: true,
      contentTheme: 'auto',
      defaultMode: mode,
      sectionIndent,
      sectionIndentSize: 24,
    },
    theme: 'light',
    themeKind: 'light',
    wiki: { enabled: false },
  }
}
type Init = ReturnType<typeof initFor>

async function openLarge(
  page: Page,
  mode: Mode,
  sectionIndent: boolean,
): Promise<Init> {
  const init = initFor(mode, sectionIndent)
  await page.setViewportSize({ width: 1100, height: 800 })
  await page.addInitScript((i) => {
    const win = window as any
    win.__posted = []
    win.__vmdeBlockHandleCacheMetrics = { indexBuilds: 0 }
    win.acquireVsCodeApi = () => ({
      postMessage: (m: any) => {
        win.__posted.push(m)
        if (m?.command === 'ready') window.postMessage(i, '*')
      },
      getState: () => undefined,
      setState: () => undefined,
    })
    // Times every MutationObserver callback that ran a section-indent pass: a callback belongs to
    // the controller when it moved that helper's full or local counter.
    const times = { full: [] as number[], local: [] as number[] }
    win.__indentTimes = times
    const Native = window.MutationObserver
    const stat = () =>
      win.__vmdeMutationImpactStats?.helpers?.['section-indent']
    win.MutationObserver = class extends Native {
      constructor(callback: MutationCallback) {
        super(function (this: MutationObserver, records, observer) {
          const before = stat()
          const full = before?.full ?? 0
          const local = before?.local ?? 0
          const t0 = performance.now()
          callback.call(observer, records, observer)
          const elapsed = performance.now() - t0
          const after = stat()
          if (!after) return
          if (after.full > full) times.full.push(elapsed)
          else if (after.local > local) times.local.push(elapsed)
        })
      }
    }
    // Upper bound for the enable pass: the span of one config-changed message dispatch, from this
    // first listener to the last listener added after load.
    win.__cfgStart = 0
    window.addEventListener('message', (e: MessageEvent) => {
      if (e.data?.command === 'config-changed')
        win.__cfgStart = performance.now()
    })
  }, init)
  await page.goto('/prerender.html', { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(
    () =>
      !document.getElementById('vmde-prerender') &&
      !!document.querySelector('#app .vditor-reset'),
    undefined,
    { timeout: 60_000 },
  )
  await page.waitForFunction(
    (sel) =>
      (document.querySelector(sel)?.children.length ?? 0) > 100 &&
      !!(window as any).__vmdeMutationImpactStats,
    SURFACE[mode],
    { timeout: 60_000 },
  )
  await page.evaluate(() =>
    window.addEventListener('message', (e: MessageEvent) => {
      if (e.data?.command === 'config-changed')
        (window as any).__cfgSpan =
          performance.now() - (window as any).__cfgStart
    }),
  )
  await settle(page)
  return init
}

const settle = (page: Page): Promise<void> =>
  page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        setTimeout(
          () =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          600,
        ),
      ),
  )

const helper = (page: Page): Promise<HelperStats | null> =>
  page.evaluate(
    () =>
      (window as any).__vmdeMutationImpactStats?.helpers?.['section-indent'] ??
      null,
  )

async function resetLedger(page: Page): Promise<void> {
  await page.evaluate(() => {
    const win = window as any
    const stats = win.__vmdeMutationImpactStats
    stats.rawCallbacks = 0
    stats.rawRecords = 0
    stats.helpers = {}
    win.__indentTimes.full.length = 0
    win.__indentTimes.local.length = 0
    win.__vmdeBlockHandleCacheMetrics.indexBuilds = 0
  })
}

const attrCount = (page: Page): Promise<number> =>
  page.evaluate(() => document.querySelectorAll('[data-vmde-indent]').length)

const rootCount = (page: Page): Promise<number> =>
  page.evaluate(
    () => document.querySelectorAll('[data-vmde-indent-root]').length,
  )

const median = (values: readonly number[]): number => {
  if (!values.length) return Number.NaN
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

const round = (n: number): number => Math.round(n * 100) / 100

async function setIndent(page: Page, init: Init, on: boolean): Promise<void> {
  await page.evaluate(
    ({ init, on }) =>
      window.postMessage(
        {
          ...init,
          command: 'config-changed',
          options: { ...init.options, sectionIndent: on },
        },
        '*',
      ),
    { init, on },
  )
  await settle(page)
}

// Puts the caret at the end of the first paragraph below depth 0 (or any paragraph when the
// setting is off) and returns its text so the caller can confirm typing landed.
async function caretInParagraph(page: Page): Promise<void> {
  await page.locator('.vditor-ir').click({ position: { x: 8, y: 8 } })
  const ok = await page.evaluate(() => {
    const paragraphs = Array.from(
      document.querySelectorAll('.vditor-ir > .vditor-reset > p'),
    ).filter((p) => (p.textContent ?? '').trim().length > 20)
    const target = (paragraphs.find((p) =>
      p.hasAttribute('data-vmde-indent'),
    ) ?? paragraphs[3]) as HTMLElement | undefined
    if (!target) return false
    target.scrollIntoView({ block: 'center' })
    const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT)
    let text: Text | null = null
    for (let n = walker.nextNode(); n; n = walker.nextNode()) text = n as Text
    if (!text) return false
    const range = document.createRange()
    range.setStart(text, text.data.length)
    range.collapse(true)
    const selection = getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    target.focus()
    return true
  })
  expect(ok, 'a paragraph with text exists in the large document').toBe(true)
}

// Budget (a): with the setting off nothing is observed, marked or written, even while typing and
// re-rendering (IR and Split's preview pane).
for (const mode of ['ir', 'sv'] as const) {
  test(`${mode}: setting off runs no section-indent pass and writes no attribute`, async ({
    page,
  }) => {
    await openLarge(page, mode, false)
    await resetLedger(page)
    expect(await attrCount(page)).toBe(0)
    expect(await rootCount(page)).toBe(0)

    if (mode === 'ir') {
      await caretInParagraph(page)
      await page.keyboard.type('abcdefgh')
    }
    await page.evaluate(
      (src) => (window as any).vditor.setValue(src),
      LARGE_SOURCE,
    )
    await settle(page)

    expect(await helper(page)).toBeNull()
    expect(await attrCount(page)).toBe(0)
    expect(await rootCount(page)).toBe(0)
  })
}

// Budgets (b) and (d, local pass): typing in a paragraph of the large document runs only local
// passes, never a full one, and writes no more attributes than the blocks it affects.
test('ir: typing in a paragraph runs only local passes bounded by the affected blocks', async ({
  page,
}) => {
  const init = await openLarge(page, 'ir', false)
  await setIndent(page, init, true)
  expect(await attrCount(page)).toBeGreaterThan(100)
  expect(await rootCount(page)).toBeGreaterThan(0)

  await caretInParagraph(page)
  await page.evaluate(() => {
    const win = window as any
    win.__indentWrites = 0
    const observer = new MutationObserver((records) => {
      for (const r of records)
        if (r.attributeName === 'data-vmde-indent') win.__indentWrites++
    })
    observer.observe(document.querySelector('.vditor-ir > .vditor-reset')!, {
      attributes: true,
      subtree: true,
      attributeFilter: ['data-vmde-indent'],
    })
  })
  await resetLedger(page)
  const typed = 'abcdefghij'
  const before = await page.evaluate(() => (window as any).vditor.getValue())
  await page.keyboard.type(typed)
  await expect
    .poll(() => page.evaluate(() => (window as any).vditor.getValue()))
    .toContain(typed)
  expect(await page.evaluate(() => (window as any).vditor.getValue())).not.toBe(
    before,
  )
  await settle(page)

  const stats = (await helper(page))!
  const writes = await page.evaluate(() => (window as any).__indentWrites)
  const times = await page.evaluate(() => (window as any).__indentTimes)
  expect(stats, 'typing reached the controller').not.toBeNull()
  expect(stats.local).toBeGreaterThan(0)
  expect(stats.full).toBe(0)
  // Each local pass names one affected block (a paragraph edit never widens).
  expect(stats.blocks).toBeLessThanOrEqual(stats.local * 2)
  // A paragraph edit changes no depth, so the pass writes nothing.
  expect(writes).toBeLessThanOrEqual(stats.blocks)
  console.log(
    `S5 (b) ir typing: ${JSON.stringify({ ...stats, attributeWrites: writes })}`,
  )
  console.log(
    `S5 (d) ir local pass: median ${round(median(times.local))} ms over ${times.local.length} passes (target <= 1 ms)`,
  )
})

// Budget (d, full pass): a re-render replaces the whole surface; record the full pass time. IR and
// Split's preview pane.
for (const mode of ['ir', 'sv'] as const) {
  test(`${mode}: records the full-pass time of a whole-document re-render`, async ({
    page,
  }) => {
    const init = await openLarge(page, mode, false)
    await setIndent(page, init, true)
    const enableSpan = await page.evaluate(() => (window as any).__cfgSpan)
    expect(await attrCount(page)).toBeGreaterThan(100)

    const samples: number[] = []
    for (let i = 0; i < 5; i++) {
      await resetLedger(page)
      // Split's preview pane morphs an unchanged render in place (no child change), so alternate a
      // trailing heading to force a childList change; IR replaces the whole surface either way.
      const source =
        i % 2 === 0 ? `${LARGE_SOURCE}\n## tokExtra\n` : LARGE_SOURCE
      await page.evaluate((src) => (window as any).vditor.setValue(src), source)
      await settle(page)
      const full = await page.evaluate(
        () => (window as any).__indentTimes.full as number[],
      )
      const stats = await helper(page)
      expect(stats, `re-render ${i} reached the controller`).not.toBeNull()
      expect(stats!.full).toBeGreaterThan(0)
      samples.push(...full)
    }
    expect(samples.length).toBeGreaterThan(0)
    console.log(
      `S5 (d) ${mode} full pass: median ${round(median(samples))} ms, max ${round(Math.max(...samples))} ms over ${samples.length} passes (target <= ${mode === 'ir' ? 4 : 8} ms); enable message dispatch upper bound ${round(enableSpan)} ms`,
    )
  })
}

// Budget (c): pointer movement and wheel scrolling add no source-index build and no indent work.
test('ir: pointer and wheel do no indent work and add no source-index build', async ({
  page,
}) => {
  const init = await openLarge(page, 'ir', false)

  const sweep = async () => {
    await resetLedger(page)
    for (let step = 0; step < 6; step++) {
      for (let x = 120; x <= 900; x += 130)
        await page.mouse.move(x, 120 + step * 90)
      await page.mouse.wheel(0, 500)
      await page.waitForTimeout(60)
    }
    await settle(page)
    return page.evaluate(
      () => (window as any).__vmdeBlockHandleCacheMetrics.indexBuilds as number,
    )
  }

  const offBuilds = await sweep()
  await setIndent(page, init, true)
  const onBuilds = await sweep()
  const stats = await helper(page)

  expect(onBuilds).toBeLessThanOrEqual(offBuilds)
  // Scrolling and hovering mutate no block, so the controller is never even woken.
  expect(stats?.full ?? 0).toBe(0)
  expect(stats?.local ?? 0).toBe(0)
  console.log(
    `S5 (c) ir pointer+wheel: indexBuilds off ${offBuilds}, on ${onBuilds}; section-indent ${JSON.stringify(stats)}`,
  )
})
