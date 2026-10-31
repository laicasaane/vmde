import { test, expect } from './coverage-fixture'
import type { Page } from '@playwright/test'

// Task 645: the Split View current-line highlight covers only the visual row that holds the caret
// (a wrapped source line counts each wrapped row as its own line). The band is painted by the pane's
// own background; its position travels in two registered variables, `--vmde-sv-row-top` (content
// coordinates) and `--vmde-sv-row-height`, written on a rule in <head>. It follows keys and clicks and
// is hidden with a non-collapsed selection or without focus.
test.use({ viewport: { width: 900, height: 700 } })

const WRAPPED = 'word '.repeat(70).trim() // about seven rows in the Split source pane
const DOC = `Alpha line\n\n${WRAPPED}\n\nTail line\n`

async function open(page: Page, extra: object = {}) {
  await page.goto('/sv-pane.html')
  await page.waitForFunction(() => (window as any).__ready === true)
  await page.waitForSelector('.vditor-sv', { state: 'visible' })
  await page.evaluate((md) => (window as any).__setDoc(md), DOC)
  await page.evaluate(
    (o) =>
      (window as any).__applyBodyOptions({
        sourceHighlightCurrentLine: true,
        sourceCurrentLineBackground: '#112233',
        ...o,
      }),
    extra,
  )
}

// Puts a collapsed caret in the text of source line `lineText` at `offset` characters.
const placeCaret = (page: Page, lineText: string, offset: number) =>
  page.evaluate(
    ({ lineText, offset }) => {
      const sv = document.querySelector('.vditor-sv') as HTMLElement
      sv.focus()
      const span = Array.from(
        sv.querySelectorAll<HTMLElement>('[data-type="text"]'),
      ).find((el) => (el.textContent ?? '').startsWith(lineText))!
      const range = document.createRange()
      range.setStart(span.firstChild as Text, offset)
      range.collapse(true)
      const selection = getSelection()!
      selection.removeAllRanges()
      selection.addRange(range)
    },
    { lineText, offset },
  )

type State = {
  bandCenter: number | null
  bandHeight: number
  caretCenter: number | null
  background: string
  lineHeight: number
  lineBottom: number | null
  lineTop: number | null
}

// The caret's row center and the bounds of its source line, in viewport coordinates.
const caretInfo = (page: Page) =>
  page.evaluate(() => {
    const selection = getSelection()
    if (!selection?.rangeCount)
      return { caretCenter: null, lineTop: null, lineBottom: null } as const
    const range = selection.getRangeAt(0)
    let rect: DOMRect | undefined = range.getClientRects()[0]
    const container = range.startContainer
    const element =
      container.nodeType === 1
        ? (container as HTMLElement)
        : (container.parentElement as HTMLElement)
    if (!rect) {
      // A caret between nodes has no rect of its own: use the line break of an empty line, or the
      // last row of the text before it.
      const lineBreak = element.closest('[data-type="newline"]')
      if (lineBreak)
        rect = (
          lineBreak.firstElementChild as HTMLElement
        ).getBoundingClientRect()
      else {
        const contents = document.createRange()
        contents.selectNodeContents(element)
        const rects = contents.getClientRects()
        rect = rects[rects.length - 1]
      }
    }
    const text = element.closest('[data-type="text"]')
    const all = text?.getBoundingClientRect()
    return {
      caretCenter: rect ? rect.top + rect.height / 2 : null,
      lineTop: all?.top ?? null,
      lineBottom: all?.bottom ?? null,
    }
  })

// Reads the band from the pane's computed style (viewport coordinates) and the caret's own row.
const state = async (page: Page): Promise<State> => {
  const band = await page.evaluate(() => {
    const sv = document.querySelector('.vditor-sv') as HTMLElement
    const cs = getComputedStyle(sv)
    const svRect = sv.getBoundingClientRect()
    const top = parseFloat(cs.getPropertyValue('--vmde-sv-row-top')) || 0
    const height = parseFloat(cs.getPropertyValue('--vmde-sv-row-height')) || 0
    return {
      bandCenter:
        height > 0
          ? svRect.top + sv.clientTop + top - sv.scrollTop + height / 2
          : null,
      bandHeight: height,
      background: cs.backgroundImage,
      lineHeight: parseFloat(cs.lineHeight),
    }
  })
  return { ...band, ...(await caretInfo(page)) }
}

const bandOnCaret = async (page: Page) => {
  await expect
    .poll(async () => {
      const s = await state(page)
      return (
        s.bandCenter !== null &&
        s.caretCenter !== null &&
        Math.abs(s.bandCenter - s.caretCenter) <= 2
      )
    })
    .toBe(true)
  return state(page)
}

test('only the caret row has the configured background, one row of a wrapped line', async ({
  page,
}) => {
  await open(page)
  await placeCaret(page, 'word word', 150) // a middle row of the wrapped paragraph
  const s = await bandOnCaret(page)
  expect(s.bandHeight).toBeCloseTo(s.lineHeight, 0)
  expect(s.lineBottom! - s.lineTop!).toBeGreaterThan(s.bandHeight * 3)
  expect(s.background).toContain('rgb(17, 34, 51)')
})

test('ArrowDown and ArrowUp move the band between wrapped rows of one source line', async ({
  page,
}) => {
  await open(page)
  await placeCaret(page, 'word word', 110)
  const first = await bandOnCaret(page)
  await page.keyboard.press('ArrowDown')
  const second = await bandOnCaret(page)
  expect(second.bandCenter! - first.bandCenter!).toBeCloseTo(
    first.lineHeight,
    0,
  )
  expect(second.bandHeight).toBe(first.bandHeight)
  await page.keyboard.press('ArrowUp')
  const back = await bandOnCaret(page)
  expect(back.bandCenter!).toBeCloseTo(first.bandCenter!, 0)
})

test('the band follows the caret across source lines, onto an empty line and back', async ({
  page,
}) => {
  await open(page)
  await placeCaret(page, 'Alpha line', 10)
  const alpha = await bandOnCaret(page)
  await page.keyboard.press('ArrowDown') // the empty line below
  const empty = await bandOnCaret(page)
  expect(empty.bandCenter!).toBeGreaterThan(alpha.bandCenter!)
  await page.keyboard.press('ArrowDown') // the first row of the wrapped paragraph
  const wrapped = await bandOnCaret(page)
  expect(wrapped.bandCenter!).toBeGreaterThan(empty.bandCenter!)
})

test('a click moves the band to the clicked row', async ({ page }) => {
  await open(page)
  await placeCaret(page, 'Alpha line', 3)
  const before = await bandOnCaret(page)
  const target = await page.evaluate(() => {
    const span = Array.from(
      document.querySelectorAll<HTMLElement>('.vditor-sv [data-type="text"]'),
    ).find((el) => (el.textContent ?? '').startsWith('Tail line'))!
    const rect = span.getBoundingClientRect()
    return { x: rect.left + 20, y: rect.top + rect.height / 2 }
  })
  await page.mouse.click(target.x, target.y)
  const after = await bandOnCaret(page)
  expect(after.bandCenter!).toBeGreaterThan(before.bandCenter!)
})

test('the band is hidden with a selection and returns for a collapsed caret', async ({
  page,
}) => {
  await open(page)
  await placeCaret(page, 'Alpha line', 2)
  await bandOnCaret(page)
  await page.keyboard.press('Shift+ArrowRight')
  await expect.poll(async () => (await state(page)).bandHeight).toBe(0)
  await page.keyboard.press('ArrowRight')
  await bandOnCaret(page)
})

test('the band is hidden without focus and with the setting off', async ({
  page,
}) => {
  await open(page)
  await placeCaret(page, 'Alpha line', 2)
  await bandOnCaret(page)
  await page.evaluate(() =>
    (document.querySelector('.vditor-sv') as HTMLElement).blur(),
  )
  await expect.poll(async () => (await state(page)).background).toBe('none')
  await placeCaret(page, 'Alpha line', 2)
  await bandOnCaret(page)
  await page.evaluate(() =>
    (window as any).__applyBodyOptions({ sourceHighlightCurrentLine: false }),
  )
  await expect.poll(async () => (await state(page)).background).toBe('none')
  expect((await state(page)).bandHeight).toBe(0)
})

test('an empty or invalid color falls back to the theme highlight color', async ({
  page,
}) => {
  await open(page, { sourceCurrentLineBackground: '' })
  await placeCaret(page, 'Alpha line', 2)
  const empty = await bandOnCaret(page)
  expect(empty.background).not.toContain('rgb(17, 34, 51)')
  expect(empty.background).toContain('linear-gradient')
  await page.evaluate(() =>
    (window as any).__applyBodyOptions({
      sourceHighlightCurrentLine: true,
      sourceCurrentLineBackground: 'red;}',
    }),
  )
  const invalid = await bandOnCaret(page)
  expect(invalid.background).toBe(empty.background)
})

test('Instant Rendering shows no band', async ({ page }) => {
  await page.goto('/sv-pane.html?mode=ir')
  await page.waitForFunction(() => (window as any).__ready === true)
  await page.evaluate(() =>
    (window as any).__applyBodyOptions({ sourceHighlightCurrentLine: true }),
  )
  const sv = await page.evaluate(
    () =>
      getComputedStyle(document.querySelector('.vditor-sv') as Element)
        .backgroundImage,
  )
  expect(sv).toBe('none')
})
