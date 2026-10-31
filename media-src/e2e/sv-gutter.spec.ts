import { test, expect } from './coverage-fixture'
import type { Page } from '@playwright/test'

// Task 645: the Split View source gutter. Line numbers sit on each source line's first visual row;
// every further wrapped row shows `↳` at the gutter's left edge with a sub-number counted from 1,
// right-aligned with the line numbers. The overlay lives under <body>, outside the editable pane,
// so copy, Find, save and Undo never see it. Class contract for the overlay (P2-6):
//   body > .vmde-sv-gutter > .vmde-sv-gutter__layer
//     .vmde-sv-gutter__num                 one per source line
//     .vmde-sv-gutter__sub > .vmde-sv-gutter__mark (the ↳) + .vmde-sv-gutter__subnum
test.use({ viewport: { width: 900, height: 700 } })

const WORD = 'word '
const WRAPPED = WORD.repeat(70) // wraps to a handful of rows in the Split source pane
const VERY_WRAPPED = WORD.repeat(300) // wraps to more than 10 rows
const DOC = `Alpha line\n\n${WRAPPED.trim()}\n\nTail line\n`

async function open(page: Page, doc: string, query = '') {
  await page.goto(`/sv-pane.html${query}`)
  await page.waitForFunction(() => (window as any).__ready === true)
  await page.waitForSelector('.vditor-sv', { state: 'visible' })
  await page.evaluate((md) => (window as any).__setDoc(md), doc)
  await page.evaluate(() =>
    (window as any).__applyBodyOptions({ sourceLineNumbers: true }),
  )
}

type Measure = {
  lineCount: number
  hostLines: number
  rowCounts: number[]
  firstRowCenters: number[]
  rowCenters: number[][]
  nums: { text: string; center: number; right: number }[]
  subs: {
    text: string
    markText: string
    center: number
    markLeft: number
    right: number
  }[]
  layerLeft: number
  layerWidth: number
  ch: number
  insideEditor: boolean
}

// Reads the pane's rows from the DOM (Range rects per source line) and the overlay's labels.
const measure = (page: Page): Promise<Measure> =>
  page.evaluate(() => {
    const sv = document.querySelector('.vditor-sv') as HTMLElement
    const overlay = document.querySelector(
      'body > .vmde-sv-gutter',
    ) as HTMLElement | null
    const nls = Array.from(sv.querySelectorAll('[data-type="newline"]'))
    const rowCenters: number[][] = nls.map((nl, i) => {
      const range = document.createRange()
      if (i === 0) range.setStart(sv, 0)
      else range.setStartAfter(nls[i - 1])
      range.setEndBefore(nl)
      const tops = new Map<number, number>()
      for (const rect of range.getClientRects())
        if (rect.height > 0 && rect.width > 0)
          tops.set(Math.round(rect.top), rect.top + rect.height / 2)
      if (!tops.size) {
        const br = (nl.firstElementChild as HTMLElement).getBoundingClientRect()
        tops.set(Math.round(br.top), br.top + br.height / 2)
      }
      return [...tops.entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1])
    })
    const hostText = (sv.textContent ?? '').replace(/​(?=\n*$)/gu, '')
    const rects = (selector: string) =>
      Array.from(overlay?.querySelectorAll(selector) ?? []).map((el) => ({
        el: el as HTMLElement,
        rect: (el as HTMLElement).getBoundingClientRect(),
      }))
    let ch = 0
    if (overlay) {
      const probe = document.createElement('span')
      probe.style.cssText =
        'position:absolute;visibility:hidden;white-space:pre'
      probe.textContent = '0'.repeat(20)
      overlay.appendChild(probe)
      ch = probe.getBoundingClientRect().width / 20
      probe.remove()
    }
    const layer = overlay?.querySelector(
      '.vmde-sv-gutter__layer',
    ) as HTMLElement | null
    const layerRect = layer?.getBoundingClientRect()
    return {
      lineCount: nls.length,
      hostLines: hostText.replace(/\n$/, '').split('\n').length,
      rowCounts: rowCenters.map((rows) => rows.length),
      firstRowCenters: rowCenters.map((rows) => rows[0]),
      rowCenters,
      nums: rects('.vmde-sv-gutter__num').map(({ el, rect }) => ({
        text: el.textContent ?? '',
        center: rect.top + rect.height / 2,
        right: rect.right,
      })),
      subs: rects('.vmde-sv-gutter__sub').map(({ el, rect }) => ({
        text: el.querySelector('.vmde-sv-gutter__subnum')?.textContent ?? '',
        markText: el.querySelector('.vmde-sv-gutter__mark')?.textContent ?? '',
        center: rect.top + rect.height / 2,
        markLeft:
          (
            el.querySelector('.vmde-sv-gutter__mark') as HTMLElement | null
          )?.getBoundingClientRect().left ?? Number.NaN,
        right:
          (
            el.querySelector('.vmde-sv-gutter__subnum') as HTMLElement | null
          )?.getBoundingClientRect().right ?? Number.NaN,
      })),
      layerLeft: layerRect?.left ?? Number.NaN,
      layerWidth: layerRect?.width ?? Number.NaN,
      ch,
      insideEditor: !!overlay?.closest('.vditor'),
    }
  })

const sumSubs = (m: Measure) => m.rowCounts.reduce((n, c) => n + c - 1, 0)

// The gutter has caught up with the pane: one number per line and one sub-number per wrapped row.
async function settled(page: Page) {
  await expect
    .poll(async () => {
      const m = await measure(page)
      return m.nums.length === m.lineCount && m.subs.length === sumSubs(m)
    })
    .toBe(true)
  return measure(page)
}

const expectedColumns = (m: Measure) => {
  const maxSub = Math.max(0, ...m.rowCounts.map((c) => c - 1))
  const digits = (n: number) => String(n).length
  return Math.max(digits(m.lineCount), maxSub > 0 ? 2 + digits(maxSub) : 0)
}

test('each source line gets its number on its first visual row, matching the host lines', async ({
  page,
}) => {
  await open(page, DOC)
  const m = await settled(page)
  expect(m.lineCount).toBe(m.hostLines)
  expect(m.nums.map((n) => n.text)).toEqual(
    Array.from({ length: m.lineCount }, (_, i) => String(i + 1)),
  )
  for (const [i, num] of m.nums.entries())
    expect(Math.abs(num.center - m.firstRowCenters[i])).toBeLessThanOrEqual(2)
  expect(m.insideEditor).toBe(false)
})

test('wrapped rows show ↳ at the left edge and a sub-number right-aligned with the line numbers', async ({
  page,
}) => {
  await open(page, DOC)
  const m = await settled(page)
  expect(m.rowCounts.some((c) => c > 1)).toBe(true)
  const wrappedRows: number[] = []
  for (const rows of m.rowCenters) wrappedRows.push(...rows.slice(1))
  expect(m.subs).toHaveLength(wrappedRows.length)
  for (const [i, sub] of m.subs.entries()) {
    expect(sub.markText).toBe('↳')
    expect(Math.abs(sub.center - wrappedRows[i])).toBeLessThanOrEqual(2)
    expect(Math.abs(sub.markLeft - m.layerLeft)).toBeLessThanOrEqual(1)
    expect(Math.abs(sub.right - m.nums[0].right)).toBeLessThanOrEqual(1)
  }
  let k = 0
  for (const count of m.rowCounts)
    for (let sub = 1; sub < count; sub++)
      expect(m.subs[k++].text).toBe(String(sub))
})

for (const [name, doc] of [
  ['no wrapped row', 'a\n\nb\n'],
  ['sub-numbers below 10', DOC],
  ['sub-numbers from 10', `x\n\n${VERY_WRAPPED.trim()}\n`],
] as const) {
  test(`the gutter is as narrow as its content allows (${name})`, async ({
    page,
  }) => {
    await open(page, doc)
    const m = await settled(page)
    expect(m.layerWidth / m.ch).toBeCloseTo(expectedColumns(m), 1)
  })
}

test('the sub-number columns widen only at 10 and 100 wrapped rows', async ({
  page,
}) => {
  await open(page, `x\n\n${VERY_WRAPPED.trim()}\n`)
  const m = await settled(page)
  const maxSub = Math.max(...m.rowCounts) - 1
  expect(maxSub).toBeGreaterThanOrEqual(10)
  expect(maxSub).toBeLessThan(100)
  expect(Math.round(m.layerWidth / m.ch)).toBe(4)
})

test('resizing the pane updates the wrapped rows', async ({ page }) => {
  await open(page, DOC)
  const before = await settled(page)
  await page.setViewportSize({ width: 640, height: 700 })
  await expect
    .poll(async () => (await measure(page)).subs.length)
    .toBeGreaterThan(before.subs.length)
  const after = await settled(page)
  expect(after.subs.length).toBe(sumSubs(after))
})

test('Enter, delete, paste and Undo keep the numbers equal to the host lines', async ({
  page,
}) => {
  await open(page, DOC)
  await settled(page)
  await page.waitForTimeout(900) // past the Undo delay: the opening snapshot settles first
  const caretAtEndOfFirstLine = () =>
    page.evaluate(() => {
      const sv = document.querySelector('.vditor-sv') as HTMLElement
      sv.focus()
      const text = sv.querySelector('[data-type="text"]') as HTMLElement
      const range = document.createRange()
      range.selectNodeContents(text)
      range.collapse(false)
      const selection = getSelection()!
      selection.removeAllRanges()
      selection.addRange(range)
    })
  const caughtUp = async () => {
    const m = await settled(page)
    expect(m.lineCount).toBe(m.hostLines)
    expect(m.nums).toHaveLength(m.hostLines)
    return m.hostLines
  }
  const start = await caughtUp()

  await caretAtEndOfFirstLine()
  await page.keyboard.press('Enter')
  await expect.poll(async () => (await measure(page)).hostLines).toBe(start + 1)
  expect(await caughtUp()).toBe(start + 1)

  await page.keyboard.press('Backspace')
  await expect.poll(async () => (await measure(page)).hostLines).toBe(start)
  expect(await caughtUp()).toBe(start)

  await caretAtEndOfFirstLine()
  await page.evaluate(() => {
    const sv = document.querySelector('.vditor-sv') as HTMLElement
    const data = new DataTransfer()
    data.setData('text/plain', 'p\nq\nr')
    sv.dispatchEvent(
      new ClipboardEvent('paste', {
        clipboardData: data,
        bubbles: true,
        cancelable: true,
      }),
    )
  })
  await expect.poll(async () => (await measure(page)).hostLines).toBe(start + 2)
  expect(await caughtUp()).toBe(start + 2)

  await page.waitForTimeout(900) // past the Undo delay so the paste is its own step
  await page.evaluate(() => {
    const inner = (window as any).vditor.vditor
    inner.undo.undo(inner)
  })
  await expect
    .poll(async () => (await measure(page)).hostLines)
    .toBeLessThan(start + 2)
  await caughtUp()
})

test('turning the numbers on and off leaves the pane DOM, caret and selection untouched', async ({
  page,
}) => {
  await open(page, DOC)
  await settled(page)
  const snapshot = () =>
    page.evaluate(() => {
      const sv = document.querySelector('.vditor-sv') as HTMLElement
      const selection = getSelection()!
      return {
        html: sv.innerHTML,
        text: sv.textContent,
        anchor: selection.anchorNode ? selection.anchorOffset : -1,
        collapsed: selection.isCollapsed,
      }
    })
  await page.evaluate(() => {
    const sv = document.querySelector('.vditor-sv') as HTMLElement
    sv.focus()
    const text = sv.querySelector('[data-type="text"]') as Text | HTMLElement
    const range = document.createRange()
    range.setStart(text.firstChild ?? text, 2)
    range.collapse(true)
    getSelection()!.removeAllRanges()
    getSelection()!.addRange(range)
  })
  const before = await snapshot()
  await page.evaluate(() =>
    (window as any).__applyBodyOptions({ sourceLineNumbers: false }),
  )
  await expect(page.locator('body > .vmde-sv-gutter')).toHaveCount(0)
  expect(await snapshot()).toEqual(before)
  await page.evaluate(() =>
    (window as any).__applyBodyOptions({ sourceLineNumbers: true }),
  )
  await settled(page)
  expect(await snapshot()).toEqual(before)
})

test('select-all copy text never contains gutter text', async ({ page }) => {
  await open(page, DOC)
  await settled(page)
  const selected = await page.evaluate(() => {
    const sv = document.querySelector('.vditor-sv') as HTMLElement
    sv.focus()
    const range = document.createRange()
    range.selectNodeContents(sv)
    getSelection()!.removeAllRanges()
    getSelection()!.addRange(range)
    return {
      text: getSelection()!.toString(),
      gutterInsideSelection: range.intersectsNode(
        document.querySelector('.vmde-sv-gutter') as Node,
      ),
    }
  })
  expect(selected.text).not.toContain('↳')
  expect(selected.gutterInsideSelection).toBe(false)
})

test('Instant Rendering shows no gutter', async ({ page }) => {
  await page.goto('/sv-pane.html?mode=ir')
  await page.waitForFunction(() => (window as any).__ready === true)
  await page.evaluate(() =>
    (window as any).__applyBodyOptions({ sourceLineNumbers: true }),
  )
  await expect(page.locator('.vmde-sv-gutter')).toHaveCount(0)
})
