import { expect, test } from './coverage-fixture'
import {
  caretOffset,
  hostSource,
  ORIGINAL,
  open,
  selectOffsets,
  undoIsExact,
} from './sv-selection-helpers'

type Page = import('@playwright/test').Page

// Task 629 — Enter and Backspace over a non-collapsed SV selection. Keys are Playwright keys on the
// mouseops SV harness; the real-VS-Code OS-key test is a separate spec. Expected sources and carets
// come from the task contract: Enter replaces the selection with one line break (Vditor's own Enter
// then runs on a collapsed caret at the selection start); Backspace removes exactly the selection
// and never the character at column 0 in front of it.

/** Source offsets of the first `from` through the end of the first `to` that follows it. */
const rangeOf = (source: string, from: string, to = from) => {
  const start = source.indexOf(from)
  return [start, source.indexOf(to, start) + to.length] as const
}

/**
 * The last `edit` message the host received (the debounced serialize-and-post of the harness). It is
 * `getValue()`, which carries SV's trailing editable newline: the expected source plus one `\n`.
 */
const lastEdit = (page: Page) =>
  page.evaluate(
    () =>
      ((window as any).__posted as { command: string; content: string }[])
        .filter((m) => m.command === 'edit')
        .at(-1)?.content,
  )

/** Selects from (text node equal to `fromNode`, offset) to (text node equal to `toNode`, offset). */
const selectNodes = (
  page: Page,
  from: readonly [string, number],
  to: readonly [string, number],
) =>
  page.evaluate(
    ([a, b]) => {
      const el = (window as any).__modeEl() as HTMLElement
      el.focus()
      const find = (text: string) => {
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
        for (let n = walker.nextNode(); n; n = walker.nextNode())
          if (n.textContent === text) return n
        throw new Error(`text node "${text}" not found`)
      }
      const r = document.createRange()
      r.setStart(find(a[0] as string), a[1] as number)
      r.setEnd(find(b[0] as string), b[1] as number)
      getSelection()!.removeAllRanges()
      getSelection()!.addRange(r)
      return r.toString()
    },
    [from, to] as const,
  )

/** Reverses the live selection: anchor at its end, focus at its start (a drag from right to left). */
const reverseSelection = (page: Page) =>
  page.evaluate(() => {
    const s = getSelection()!
    const r = s.getRangeAt(0)
    s.setBaseAndExtent(
      r.endContainer,
      r.endOffset,
      r.startContainer,
      r.startOffset,
    )
  })

/** A collapsed caret at source offset `at`. */
const caretAt = (page: Page, at: number) => selectOffsets(page, at, at)

const SETTLE_MS = 300 // past Vditor's re-spin and the debounced host post

test.describe('Enter over a non-collapsed SV selection (Task 629 a)', () => {
  const cells: {
    name: string
    from: string
    to: string
    expected: string
    caret: number
  }[] = [
    {
      name: 'ravo (mid-line)',
      from: 'ravo',
      to: 'ravo',
      expected: 'Alpha line\nB\n line\nCharlie line\n',
      caret: 13,
    },
    {
      name: 'Bravo (line start)',
      from: 'Bravo',
      to: 'Bravo',
      expected: 'Alpha line\n\n line\nCharlie line\n',
      caret: 12,
    },
    {
      name: 'ravo line and Char (across lines)',
      from: 'ravo',
      to: 'Char',
      expected: 'Alpha line\nB\nlie line\n',
      caret: 13,
    },
    {
      name: 'a whole line with its newline',
      from: 'Bravo line\n',
      to: 'Bravo line\n',
      expected: 'Alpha line\n\nCharlie line\n',
      caret: 12,
    },
    {
      name: 'Bravo line to the document end',
      from: 'Bravo',
      to: 'Charlie line',
      expected: 'Alpha line\n\n\n',
      caret: 12,
    },
  ]

  for (const c of cells) {
    test(`${c.name}: the selection is replaced by one line break; exact source, caret, host edit, one Undo`, async ({
      page,
    }) => {
      await open(page)
      const [start, end] = rangeOf(ORIGINAL, c.from, c.to)
      await selectOffsets(page, start, end)
      await page.keyboard.press('Enter')
      await expect.poll(() => hostSource(page)).toBe(c.expected)
      expect(await caretOffset(page)).toEqual({
        collapsed: true,
        offset: c.caret,
      })
      await expect.poll(() => lastEdit(page)).toBe(`${c.expected}\n`)
      await undoIsExact(page, ORIGINAL)
    })
  }

  test('edge: a backward selection of ravo gives the same result', async ({
    page,
  }) => {
    await open(page)
    const [start, end] = rangeOf(ORIGINAL, 'ravo')
    await selectOffsets(page, start, end)
    await reverseSelection(page)
    await page.keyboard.press('Enter')
    await expect
      .poll(() => hostSource(page))
      .toBe('Alpha line\nB\n line\nCharlie line\n')
    expect(await caretOffset(page)).toEqual({ collapsed: true, offset: 13 })
    await undoIsExact(page, ORIGINAL)
  })

  test('edge: a selection on line 1 (Alpha) is replaced by one line break', async ({
    page,
  }) => {
    await open(page)
    await selectOffsets(page, 0, 5)
    await page.keyboard.press('Enter')
    await expect
      .poll(() => hostSource(page))
      .toBe('\n line\nBravo line\nCharlie line\n')
    expect(await caretOffset(page)).toEqual({ collapsed: true, offset: 1 })
    await undoIsExact(page, ORIGINAL)
  })

  test('edge: a one-character line (x) is replaced by one line break', async ({
    page,
  }) => {
    const source = 'a\nx\nfoo\n'
    await open(page, source)
    await selectNodes(page, ['x', 0], ['x', 1])
    await page.keyboard.press('Enter')
    await expect.poll(() => hostSource(page)).toBe('a\n\n\nfoo\n')
    expect(await caretOffset(page)).toEqual({ collapsed: true, offset: 3 })
    await undoIsExact(page, source)
  })

  test('edge: list continuation still works (the result equals Delete, then Enter on the collapsed caret)', async ({
    page,
  }) => {
    const source = '- one\n- two\n'
    const [start, end] = rangeOf(source, 'two')
    // Control: native Delete of `two` (mid-line, so native), then Vditor's own Enter at the caret.
    await open(page, source)
    await selectOffsets(page, start, end)
    await page.keyboard.press('Delete')
    await page.waitForTimeout(SETTLE_MS)
    await page.keyboard.press('Enter')
    await page.waitForTimeout(SETTLE_MS)
    const control = {
      source: await hostSource(page),
      caret: await caretOffset(page),
    }
    // Subject: Enter over the selected `two`.
    await open(page, source)
    await selectOffsets(page, start, end)
    await page.keyboard.press('Enter')
    await page.waitForTimeout(SETTLE_MS)
    expect({
      source: await hostSource(page),
      caret: await caretOffset(page),
    }).toEqual(control)
    await undoIsExact(page, source)
  })

  test('control: a collapsed Enter after B still gives one line break', async ({
    page,
  }) => {
    await open(page)
    await caretAt(page, 12)
    await page.keyboard.press('Enter')
    await expect
      .poll(() => hostSource(page))
      .toBe('Alpha line\nB\nravo line\nCharlie line\n')
    expect(await caretOffset(page)).toEqual({ collapsed: true, offset: 13 })
    await undoIsExact(page, ORIGINAL)
  })

  test('edge: Enter over a whole-document selection leaves what Delete leaves (one newline) plus the line break', async ({
    page,
  }) => {
    await open(page)
    await page.evaluate(() =>
      ((window as any).__modeEl() as HTMLElement).focus(),
    )
    await page.keyboard.press('Control+a')
    await page.keyboard.press('Enter')
    await expect.poll(() => hostSource(page)).toBe('\n\n')
    await undoIsExact(page, ORIGINAL)
  })
})

test.describe('Backspace over a non-collapsed SV selection that starts at column 1 (Task 629 b)', () => {
  const cells: {
    name: string
    source: string
    from: string
    to: string
    expected: string
    caret: number
  }[] = [
    {
      name: 'ravo',
      source: ORIGINAL,
      from: 'ravo',
      to: 'ravo',
      expected: 'Alpha line\nB line\nCharlie line\n',
      caret: 12,
    },
    {
      name: 'ravo line and Char (across lines)',
      source: ORIGINAL,
      from: 'ravo',
      to: 'Char',
      expected: 'Alpha line\nBlie line\n',
      caret: 12,
    },
    {
      name: 'ravo in the block after a blank line',
      source: 'Alpha line\n\nBravo line\n\nCharlie line\n',
      from: 'ravo',
      to: 'ravo',
      expected: 'Alpha line\n\nB line\n\nCharlie line\n',
      caret: 13,
    },
    {
      name: 'a heading marker line (# Head from column 1)',
      source: 'Intro\n\n## Heading\n',
      from: '# Head',
      to: '# Head',
      expected: 'Intro\n\n#ing\n',
      caret: 8,
    },
    {
      name: 'the first fenced code line (irst from column 1)',
      source: 'Alpha\n\n```js\nfirst\nsecond\n```\n',
      from: 'irst',
      to: 'irst',
      expected: 'Alpha\n\n```js\nf\nsecond\n```\n',
      caret: 14,
    },
  ]

  for (const c of cells) {
    test(`${c.name}: column 0 stays; exact source, caret, host edit, one Undo`, async ({
      page,
    }) => {
      await open(page, c.source)
      const [start, end] = rangeOf(c.source, c.from, c.to)
      await selectOffsets(page, start, end)
      await page.keyboard.press('Backspace')
      await expect.poll(() => hostSource(page)).toBe(c.expected)
      expect(await caretOffset(page)).toEqual({
        collapsed: true,
        offset: c.caret,
      })
      await expect.poll(() => lastEdit(page)).toBe(`${c.expected}\n`)
      await undoIsExact(page, c.source)
    })
  }

  test('edge: a one-character line (from after x to after f) keeps x', async ({
    page,
  }) => {
    const source = 'a\nx\nfoo\n'
    await open(page, source)
    await selectNodes(page, ['x', 1], ['foo', 1])
    await page.keyboard.press('Backspace')
    await expect.poll(() => hostSource(page)).toBe('a\nxoo\n')
    expect(await caretOffset(page)).toEqual({ collapsed: true, offset: 3 })
    await undoIsExact(page, source)
  })

  const controls: {
    name: string
    from: string
    to: string
    expected: string
  }[] = [
    {
      name: 'a selection that starts at column 2 (avo)',
      from: 'avo',
      to: 'avo',
      expected: 'Alpha line\nBr line\nCharlie line\n',
    },
    {
      name: 'a selection on line 1 that starts at column 1 (lph)',
      from: 'lph',
      to: 'lph',
      expected: 'Aa line\nBravo line\nCharlie line\n',
    },
  ]

  for (const c of controls) {
    test(`control: ${c.name} is unchanged`, async ({ page }) => {
      await open(page)
      const [start, end] = rangeOf(ORIGINAL, c.from, c.to)
      await selectOffsets(page, start, end)
      await page.keyboard.press('Backspace')
      await expect.poll(() => hostSource(page)).toBe(c.expected)
      await undoIsExact(page, ORIGINAL)
    })
  }

  test('control: a collapsed caret at column 1 still deletes column 0', async ({
    page,
  }) => {
    await open(page)
    await caretAt(page, 12)
    await page.keyboard.press('Backspace')
    await expect
      .poll(() => hostSource(page))
      .toBe('Alpha line\nravo line\nCharlie line\n')
    await undoIsExact(page, ORIGINAL)
  })
})
