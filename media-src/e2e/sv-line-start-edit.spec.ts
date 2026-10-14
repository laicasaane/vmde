import { expect, test } from './coverage-fixture'
import { getValue, gotoMouseops, setDoc } from './mouseops-helpers'

type Page = import('@playwright/test').Page

// Task 619 — SV selection edits that start at a line start. Chromium's delete of such a range also
// removes the hidden newline in the previous line's newline span, so two source lines join. Keys
// are Playwright keys on the mouseops harness; real-VS-Code OS-key legs are separate. Sources are
// read the way the host receives them: the SV text without Vditor's trailing editable newline span.

const ORIGINAL = 'Alpha line\nBravo line\nCharlie line\n'

const hostSource = (page: Page) =>
  page.evaluate(() => {
    const root = (window as any).__modeEl() as HTMLElement
    const clone = root.cloneNode(true) as HTMLElement
    clone
      .querySelector(
        ':scope > [data-block]:last-child > [data-type="newline"]:last-child',
      )
      ?.remove()
    return (clone.textContent ?? '').replace(/\u200B(?=\n*$)/gu, '')
  })

// Select the first text-node occurrence of `needle` (optionally through its line's newline span),
// the shape a user drag produces: the start sits just after the previous line's newline span.
const selectSource = (page: Page, needle: string, includeNewline = false) =>
  page.evaluate(
    ([word, withNewline]) => {
      const el = (window as any).__modeEl() as HTMLElement
      el.focus()
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const i = (n.textContent ?? '').indexOf(word as string)
        if (i < 0) continue
        const r = document.createRange()
        r.setStart(n, i)
        r.setEnd(n, i + (word as string).length)
        if (withNewline) {
          // Extend over the line's own newline span (its <br> and hidden \n).
          const after = n.parentElement?.nextElementSibling
          if (after?.getAttribute('data-type') !== 'newline')
            throw new Error('newline span not found')
          r.setEndAfter(after)
        }
        const s = getSelection()!
        s.removeAllRanges()
        s.addRange(r)
        return r.toString()
      }
      throw new Error(`"${word}" not found`)
    },
    [needle, includeNewline] as const,
  )

const undo = (page: Page) =>
  page.evaluate(() => {
    const inner = (window as any).vditor.vditor
    inner.undo.undo(inner)
  })

async function open(page: Page, source = ORIGINAL) {
  await gotoMouseops(page, 'sv')
  await setDoc(page, source)
  await page.waitForTimeout(900) // past undoDelay: the opening snapshot settles
  expect(await hostSource(page)).toBe(source)
}

async function undoIsExact(page: Page, source: string) {
  await page.waitForTimeout(900) // record the edit as its own Undo step
  await undo(page)
  await expect.poll(() => hostSource(page)).toBe(source)
}

test.describe('SV selection that starts at a line start (Task 619)', () => {
  const defects: {
    name: string
    select: [string, boolean]
    act: (page: Page) => Promise<void>
    expected: string
  }[] = [
    {
      name: 'Delete over Bravo',
      select: ['Bravo', false],
      act: (p) => p.keyboard.press('Delete'),
      expected: 'Alpha line\n line\nCharlie line\n',
    },
    {
      name: 'Backspace over Bravo',
      select: ['Bravo', false],
      act: (p) => p.keyboard.press('Backspace'),
      expected: 'Alpha line\n line\nCharlie line\n',
    },
    {
      name: 'type-over Bravo with X',
      select: ['Bravo', false],
      act: (p) => p.keyboard.type('X'),
      expected: 'Alpha line\nX line\nCharlie line\n',
    },
    {
      name: 'Delete over the content Bravo line',
      select: ['Bravo line', false],
      act: (p) => p.keyboard.press('Delete'),
      expected: 'Alpha line\n\nCharlie line\n',
    },
    {
      name: 'Delete over the whole line Bravo line and its newline',
      select: ['Bravo line', true],
      act: (p) => p.keyboard.press('Delete'),
      expected: 'Alpha line\nCharlie line\n',
    },
  ]

  for (const d of defects) {
    test(`defect: ${d.name} removes only the selection; one Undo is exact`, async ({
      page,
    }) => {
      await open(page)
      await selectSource(page, d.select[0], d.select[1])
      await d.act(page)
      await expect.poll(() => hostSource(page)).toBe(d.expected)
      await undoIsExact(page, ORIGINAL)
    })
  }

  test('defect: Ctrl+X over Bravo cuts exactly Bravo; one Undo is exact', async ({
    page,
  }) => {
    await open(page)
    await page.evaluate(() => {
      const payload: Record<string, string> = {}
      ;(window as any).__cutPayload = payload
      ;((window as any).__modeEl() as HTMLElement).addEventListener(
        'cut',
        (event) => {
          payload.text =
            (event as ClipboardEvent).clipboardData?.getData('text/plain') ?? ''
        },
      )
    })
    await selectSource(page, 'Bravo')
    await page.keyboard.press('Control+x')
    await expect
      .poll(() => hostSource(page))
      .toBe('Alpha line\n line\nCharlie line\n')
    expect(
      await page.evaluate(() => (window as any).__cutPayload.text as string),
    ).toBe('Bravo')
    await undoIsExact(page, ORIGINAL)
  })

  test('control: a mid-line selection (ravo) Delete removes only it', async ({
    page,
  }) => {
    await open(page)
    await selectSource(page, 'ravo')
    await page.keyboard.press('Delete')
    await expect
      .poll(() => hostSource(page))
      .toBe('Alpha line\nB line\nCharlie line\n')
    await undoIsExact(page, ORIGINAL)
  })

  test('control: a selection that starts on line 1 (Alpha) Delete removes only it', async ({
    page,
  }) => {
    await open(page)
    await selectSource(page, 'Alpha')
    await page.keyboard.press('Delete')
    await expect
      .poll(() => hostSource(page))
      .toBe(' line\nBravo line\nCharlie line\n')
    await undoIsExact(page, ORIGINAL)
  })

  test('control: a collapsed Ctrl+X between adjacent lines still cuts exactly that line', async ({
    page,
  }) => {
    await open(page)
    await page.evaluate(() => {
      ;(window as any).__installClipboardLine()
      const payload: Record<string, string> = {}
      ;(window as any).__linePayload = payload
      const el = (window as any).__modeEl() as HTMLElement
      el.addEventListener('cut', (event) => {
        payload.cut =
          (event as ClipboardEvent).clipboardData?.getData('text/plain') ?? ''
      })
      el.focus()
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const i = (n.textContent ?? '').indexOf('Bravo')
        if (i < 0) continue
        const r = document.createRange()
        r.setStart(n, i + 2)
        r.collapse(true)
        getSelection()?.removeAllRanges()
        getSelection()?.addRange(r)
        return
      }
      throw new Error('Bravo not found')
    })
    const before = await getValue(page)
    await page.keyboard.press('Control+x')
    await expect
      .poll(() => getValue(page))
      .toBe(before.replace('Bravo line\n', ''))
    expect(
      await page.evaluate(() => (window as any).__linePayload.cut as string),
    ).toBe('Bravo line\n')
  })

  test('control: whole-document Delete gives a single newline; one Undo is exact', async ({
    page,
  }) => {
    await open(page)
    await page.evaluate(() => {
      const el = (window as any).__modeEl() as HTMLElement
      el.focus()
    })
    await page.keyboard.press('Control+a')
    await page.keyboard.press('Delete')
    await expect.poll(() => getValue(page)).toBe('\n')
    await undoIsExact(page, ORIGINAL)
  })
})
