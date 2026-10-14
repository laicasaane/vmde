import { expect, test } from './coverage-fixture'
import { getValue } from './mouseops-helpers'
import {
  caretOffset,
  hostSource,
  ORIGINAL,
  open,
  redo,
  selectOffsets,
  undoIsExact,
} from './sv-selection-helpers'

type Page = import('@playwright/test').Page

// Task 619 — SV selection edits that start at a line start. Chromium's delete of such a range also
// removes the hidden newline in the previous line's newline span, so two source lines join. Keys
// are Playwright keys on the mouseops harness; real-VS-Code OS-key legs are separate. Sources are
// read the way the host receives them: the SV text without Vditor's trailing editable newline span.

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

// Task 619 repair round: blocks separated by blank lines, a list item and a heading, each with the
// exact source after the edit, one exact Undo, one exact Redo, and the caret at the edit
// (source offset = selection start + inserted length). Expected sources are the pure string result:
// the selected characters go and nothing else.

const BLOCKS = 'Alpha\n\nBravo line\n\nCharlie line\n'

test.describe('SV owned edit across blocks, lists and headings (Task 619)', () => {
  const cells: {
    name: string
    source: string
    from: string
    to: string
    act: (page: Page) => Promise<void>
    insert: string
    expected: string
  }[] = [
    {
      name: 'Delete over Bravo at the start of the middle block',
      source: BLOCKS,
      from: 'Bravo',
      to: 'Bravo',
      act: (p) => p.keyboard.press('Delete'),
      insert: '',
      expected: 'Alpha\n\n line\n\nCharlie line\n',
    },
    {
      name: 'Delete across blocks from Bravo to Char',
      source: BLOCKS,
      from: 'Bravo',
      to: 'Char',
      act: (p) => p.keyboard.press('Delete'),
      insert: '',
      expected: 'Alpha\n\nlie line\n',
    },
    {
      name: 'Backspace across blocks from Bravo to Char',
      source: BLOCKS,
      from: 'Bravo',
      to: 'Char',
      act: (p) => p.keyboard.press('Backspace'),
      insert: '',
      expected: 'Alpha\n\nlie line\n',
    },
    {
      name: 'type-over X across blocks from Bravo to Char',
      source: BLOCKS,
      from: 'Bravo',
      to: 'Char',
      act: (p) => p.keyboard.type('X'),
      insert: 'X',
      expected: 'Alpha\n\nXlie line\n',
    },
    {
      name: 'Delete from Bravo to the document end',
      source: BLOCKS,
      from: 'Bravo',
      to: 'Charlie line',
      act: (p) => p.keyboard.press('Delete'),
      insert: '',
      expected: 'Alpha\n\n\n',
    },
    {
      name: 'Delete over a whole list item line with its marker and newline',
      source: '- one\n- two\n- three\n',
      from: '- two\n',
      to: '- two\n',
      act: (p) => p.keyboard.press('Delete'),
      insert: '',
      expected: '- one\n- three\n',
    },
    {
      name: 'Backspace over a heading line start',
      source: 'Intro\n\n## Heading\n',
      from: '## Head',
      to: '## Head',
      act: (p) => p.keyboard.press('Backspace'),
      insert: '',
      expected: 'Intro\n\ning\n',
    },
  ]

  for (const c of cells) {
    test(`${c.name}: exact source, caret, one Undo and one Redo`, async ({
      page,
    }) => {
      await open(page, c.source)
      const start = c.source.indexOf(c.from)
      const end = c.source.indexOf(c.to, start) + c.to.length
      await selectOffsets(page, start, end)
      await c.act(page)
      await expect.poll(() => hostSource(page)).toBe(c.expected)
      expect(await caretOffset(page)).toEqual({
        collapsed: true,
        offset: start + c.insert.length,
      })
      await undoIsExact(page, c.source)
      await redo(page)
      await expect.poll(() => hostSource(page)).toBe(c.expected)
    })
  }

  test('after a re-init (new install, then the old disposer) Ctrl+X over Bravo still cuts synchronously', async ({
    page,
  }) => {
    await open(page)
    await page.evaluate(() => {
      // What Disposables.set does on a re-init: install the new instance first, then run the old disposer.
      const next = (window as any).__installSvSelectionEdit()
      ;(window as any).__svSelectionEditDispose()
      ;(window as any).__svSelectionEditDispose = next
      // The cut bridge must not fall back to execCommand("delete") for an owned selection.
      const original = document.execCommand
      ;(window as any).__deleteCalls = 0
      document.execCommand = (command: string, ...args: any[]) => {
        if (command === 'delete') (window as any).__deleteCalls++
        return (original as any).call(document, command, ...args)
      }
    })
    await selectSource(page, 'Bravo')
    await page.keyboard.press('Control+x')
    await expect
      .poll(() => hostSource(page))
      .toBe('Alpha line\n line\nCharlie line\n')
    expect(
      await page.evaluate(() => (window as any).__deleteCalls as number),
    ).toBe(0)
    await undoIsExact(page, ORIGINAL)
  })
})
