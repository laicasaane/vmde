import fs from 'node:fs'
import path from 'node:path'
import { test, expect } from './coverage-fixture'
import type { Page } from '@playwright/test'

// Task 645: the source gutter and the current-row highlight on a large document (Task 573's
// synthetic 174 KB fixture). Pure scrolling must cost no global measurement pass, a typed character
// at most one coalesced pass, and the labels written per window pass stay bounded by the window.
// Timings are recorded (printed and attached) for the features off and on in the same run; the
// budgets are relative to the off run so a loaded machine moves both.
test.use({ viewport: { width: 900, height: 700 } })
test.setTimeout(180_000)

const FIXTURE = fs.readFileSync(
  path.join(
    __dirname,
    '../../test/vscode-e2e/fixtures/large-observable-models-synthetic.md',
  ),
  'utf8',
)
const TYPED = 'abcdefghijklmnopqrst' // 20 characters
const SCROLL_FRAMES = 100

type Run = {
  typingMs: number[]
  scrollGaps: number[]
  longTasks: number
  globalPassesDuringScroll: number
  globalPassesDuringTyping: number
  windowPasses: number
  labelWrites: number
  lines: number
}

const percentile = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]
}

async function measureRun(page: Page, on: boolean): Promise<Run> {
  await page.goto('/sv-pane.html')
  await page.waitForFunction(() => (window as any).__ready === true)
  await page.waitForSelector('.vditor-sv', { state: 'visible' })
  await page.evaluate((md) => (window as any).__setDoc(md), FIXTURE)
  await page.evaluate(
    (enabled) =>
      (window as any).__applyBodyOptions({
        sourceLineNumbers: enabled,
        sourceHighlightCurrentLine: enabled,
      }),
    on,
  )
  if (on)
    await expect
      .poll(() => page.locator('.vmde-sv-gutter__num').count())
      .toBeGreaterThan(10)
  await page.waitForTimeout(3500) // the document, observers, the first passes and Vditor's own deferred re-render settle

  await page.evaluate(() => {
    const w = window as any
    w.__typing = []
    w.__longTasks = 0
    new PerformanceObserver((list) => {
      w.__longTasks += list.getEntries().length
    }).observe({ entryTypes: ['longtask'] })
    const sv = document.querySelector('.vditor-sv') as HTMLElement
    let started = 0
    sv.addEventListener('beforeinput', () => {
      started = performance.now()
    })
    sv.addEventListener('input', () => {
      const begin = started
      requestAnimationFrame(() =>
        setTimeout(() => w.__typing.push(performance.now() - begin), 0),
      )
    })
    sv.focus()
    const text = sv.querySelector('[data-type="text"]') as HTMLElement
    const range = document.createRange()
    range.setStart(text.firstChild as Text, 1)
    range.collapse(true)
    getSelection()!.removeAllRanges()
    getSelection()!.addRange(range)
  })
  const stats = () =>
    page.evaluate(
      () =>
        ((window as any).__vmdeSvGutterStats ?? {
          globalPasses: 0,
          windowPasses: 0,
          labelWrites: 0,
        }) as {
          globalPasses: number
          windowPasses: number
          labelWrites: number
        },
    )

  // Three warm-up characters (first-use costs of the editor and the gutter), not part of the samples.
  await page.keyboard.type('xyz', { delay: 80 })
  await page.waitForTimeout(800)
  await page.evaluate(() => {
    ;(window as any).__typing = []
  })
  const beforeTyping = await stats()
  await page.keyboard.type(TYPED, { delay: 80 })
  await expect
    .poll(() => page.evaluate(() => (window as any).__typing.length))
    .toBe(TYPED.length)
  await page.waitForTimeout(3500) // Vditor's own deferred re-render (about 2 s after typing) and the paused-typing pass land before the scroll phase
  const afterTyping = await stats()

  const gaps = await page.evaluate(
    (frames) =>
      new Promise<number[]>((resolve) => {
        const sv = document.querySelector('.vditor-sv') as HTMLElement
        const out: number[] = []
        let last = performance.now()
        let count = 0
        const tick = (now: number) => {
          out.push(now - last)
          last = now
          sv.scrollTop += 300
          if (++count < frames) requestAnimationFrame(tick)
          else resolve(out)
        }
        requestAnimationFrame(tick)
      }),
    SCROLL_FRAMES,
  )
  const afterScroll = await stats()
  const result = await page.evaluate(() => ({
    typing: (window as any).__typing as number[],
    longTasks: (window as any).__longTasks as number,
    lines: document.querySelectorAll('.vditor-sv [data-type="newline"]').length,
  }))
  return {
    typingMs: result.typing,
    scrollGaps: gaps.slice(1),
    longTasks: result.longTasks,
    globalPassesDuringScroll:
      afterScroll.globalPasses - afterTyping.globalPasses,
    globalPassesDuringTyping:
      afterTyping.globalPasses - beforeTyping.globalPasses,
    windowPasses: afterScroll.windowPasses,
    labelWrites: afterScroll.labelWrites,
    lines: result.lines,
  }
}

test('typing and scrolling a large document stay close to the features-off run', async ({
  page,
}, testInfo) => {
  const loadBefore = fs.readFileSync('/proc/loadavg', 'utf8').trim()
  const off = await measureRun(page, false)
  const on = await measureRun(page, true)
  const loadAfter = fs.readFileSync('/proc/loadavg', 'utf8').trim()

  const summary = (name: string, run: Run) => ({
    name,
    lines: run.lines,
    typingP95: Math.round(percentile(run.typingMs, 0.95) * 10) / 10,
    typingMax: Math.round(Math.max(...run.typingMs) * 10) / 10,
    scrollP95: Math.round(percentile(run.scrollGaps, 0.95) * 10) / 10,
    scrollMax: Math.round(Math.max(...run.scrollGaps) * 10) / 10,
    longTasks: run.longTasks,
    globalDuringTyping: run.globalPassesDuringTyping,
    globalDuringScroll: run.globalPassesDuringScroll,
    windowPasses: run.windowPasses,
    labelWrites: run.labelWrites,
  })
  const report = {
    loadBefore,
    loadAfter,
    off: summary('off', off),
    on: summary('on', on),
  }
  console.log(`SV-PANE-LARGE ${JSON.stringify(report)}`)
  await testInfo.attach('sv-pane-large.json', {
    body: JSON.stringify(report, null, 2),
    contentType: 'application/json',
  })

  // Mechanism: pure scrolling costs no global pass; typing costs at most one per character; the
  // labels written per window pass stay inside the rendered window.
  expect(on.globalPassesDuringScroll).toBe(0)
  expect(on.globalPassesDuringTyping).toBeLessThanOrEqual(TYPED.length + 1)
  expect(on.labelWrites / Math.max(1, on.windowPasses)).toBeLessThanOrEqual(400)
  expect(off.globalPassesDuringScroll + off.globalPassesDuringTyping).toBe(0)
  expect(on.lines).toBeGreaterThan(2000)

  // Budgets relative to the features-off run (Task 573 keeps interaction responsive).
  expect(percentile(on.typingMs, 0.95)).toBeLessThanOrEqual(
    percentile(off.typingMs, 0.95) + 8,
  )
  expect(percentile(on.scrollGaps, 0.95)).toBeLessThanOrEqual(
    percentile(off.scrollGaps, 0.95) + 4,
  )
  expect(Math.max(...on.scrollGaps)).toBeLessThan(50)
})
