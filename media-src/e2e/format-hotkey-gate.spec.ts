import { test, expect } from './coverage-fixture'
import type { Page } from '@playwright/test'
import type { Target } from './format-hotkey-gate-harness'

// Task 596 S3 — parity (drift guard). Vditor's toolbar highlight (highlightToolbarIR /
// highlightToolbarWYSIWYG, debounced 200 ms) decides each button's `vditor-menu--disabled` and
// `vditor-menu--current` class, and a hotkey click obeys those classes. The product gate
// (`toolbarHotkeyGate`, editing/format-hotkey-context.ts) recomputes the same two classes for the
// 12 hotkey names synchronously. For every caret below, in IR and WYSIWYG, Vditor's own highlight
// runs against the real DOM and the 12 buttons must equal the gate. A mismatch after a Vditor
// upgrade means the gate has drifted from Vditor, so the hotkey would act on the wrong context.
//
// The harness (format-hotkey-gate-harness.ts) builds Vditor from source with the real toolbar.

type Mode = 'ir' | 'wysiwyg'

const DOC = [
  '# Heading one',
  '',
  'Alpha bravo charlie delta.',
  '',
  'Echo `foxtrot` golf hotel.',
  '',
  '**India** juliet *kilo* ~~mike~~ november.',
  '',
  '## Head **hbold** and `hcode`',
  '',
  '***both*** words.',
  '',
  '> oscar papa',
  '>',
  '> - qlist item',
  '',
  '- lima mike',
  '  - nested papa',
  '- [ ] task quebec',
  '- list `lcode` tail',
  '',
  '1. romeo sierra',
  '',
  '| a | b |',
  '| - | - |',
  '| cellone | celltwo |',
  '',
  '```js',
  'let code = 1',
  '```',
  '',
  'Tail[^1] ref.',
  '',
  '[^1]: footnote body text.',
  '',
].join('\n')

interface Cell {
  id: string
  at: Target
}

const text = (needle: string, offset = 1, length = 0): Target => ({
  text: [needle, offset, length],
})

const span = (
  from: readonly [string, number],
  to: readonly [string, number],
  backward = false,
): Target => ({ span: { from, to, backward } })

const CELLS: Cell[] = [
  { id: 'heading', at: text('Heading one', 3) },
  { id: 'paragraph caret', at: text('Alpha bravo', 6) },
  { id: 'paragraph range', at: text('bravo', 0, 5) },
  { id: 'paragraph start', at: text('Alpha bravo', 0) },
  { id: 'strong caret', at: text('India', 2) },
  { id: 'strong range', at: text('India', 0, 5) },
  { id: 'em', at: text('kilo', 2) },
  { id: 'strike', at: text('mike', 2) },
  { id: 'plain before code', at: text('Echo ', 5) },
  { id: 'inline code caret', at: text('foxtrot', 3) },
  { id: 'inline code range', at: text('foxtrot', 0, 7) },
  { id: 'plain-to-code range', at: span(['Echo', 1], ['foxtrot', 3]) },
  {
    id: 'code-to-plain backward range',
    at: span(['foxtrot', 3], ['golf', 2], true),
  },
  { id: 'strong-to-plain range', at: span(['India', 2], ['juliet', 3]) },
  { id: 'heading strong', at: text('hbold', 2) },
  { id: 'heading code', at: text('hcode', 2) },
  { id: 'strong and em', at: text('both', 2) },
  { id: 'list item code', at: text('lcode', 2) },
  { id: 'list item after code', at: text('tail', 2) },
  { id: 'quote list item', at: text('qlist', 2) },
  { id: 'code block', at: text('let code', 4) },
  { id: 'quote', at: text('oscar', 2) },
  { id: 'bullet item', at: text('lima mike', 2) },
  { id: 'nested bullet item', at: text('nested papa', 3) },
  { id: 'task item', at: text('task quebec', 3) },
  { id: 'ordered item', at: text('romeo', 2) },
  { id: 'table cell caret', at: text('cellone', 3) },
  { id: 'table cell range', at: text('celltwo', 0, 7) },
  { id: 'footnote reference paragraph', at: text('Tail', 2) },
  { id: 'footnote definition', at: text('footnote body', 4) },
  // Element containers: the first child decides (STRONG for India), and each mode maps the
  // container to a child differently.
  {
    id: 'paragraph contents, strong first',
    at: { contents: { sel: 'p', has: 'India' } },
  },
  {
    id: 'paragraph contents, plain first',
    at: { contents: { sel: 'p', has: 'bravo' } },
  },
  {
    id: 'paragraph contents, code inside',
    at: { contents: { sel: 'p', has: 'foxtrot' } },
  },
  {
    id: 'list item element offset 0',
    at: { el: { sel: 'li', has: 'lima', offset: 0 } },
  },
  {
    id: 'quote element offset 0',
    at: { el: { sel: 'blockquote', has: 'oscar', offset: 0 } },
  },
  {
    id: 'table cell element offset 0',
    at: { el: { sel: 'td', has: 'cellone', offset: 0 } },
  },
  {
    id: 'heading element offset 1',
    at: { el: { sel: 'h1', has: 'Heading', offset: 1 } },
  },
  { id: 'root offset 0', at: { root: 0 } },
  { id: 'root offset 2', at: { root: 2 } },
  { id: 'root offset 5', at: { root: 5 } },
  { id: 'root past last child', at: { root: 'end' } },
]

async function openMode(page: Page, mode: Mode) {
  await page.goto('/format-hotkey-gate.html')
  await page.waitForFunction(() => (window as any).__ready === true)
  await page.evaluate((md) => (window as any).vditor.setValue(md), DOC)
  if (mode !== 'ir')
    await page.evaluate((target) => {
      const toolbar = (window as any).vditor.vditor.toolbar
      toolbar.elements['edit-mode']?.children[0]?.dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      )
      document
        .querySelector(`button[data-mode="${target}"]`)
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    }, mode)
  await expect
    .poll(() => page.evaluate(() => (window as any).vditor.getCurrentMode()))
    .toBe(mode)
}

for (const mode of ['ir', 'wysiwyg'] as const) {
  test(`gate equals Vditor's highlight for every fixture caret (${mode})`, async ({
    page,
  }) => {
    await openMode(page, mode)
    const mismatches: string[] = []
    let compared = 0
    for (const cell of CELLS) {
      const result = await page.evaluate(async (at) => {
        const gate = (window as any).__gate
        gate.place(at)
        gate.poisonAndSchedule()
        return await gate.waitHighlight(2000)
      }, cell.at)
      compared++
      if (!result.ok) {
        const diff = Object.keys(result.expected)
          .filter(
            (name) =>
              JSON.stringify(result.actual[name]) !==
              JSON.stringify(result.expected[name]),
          )
          .map(
            (name) =>
              `${name}: vditor ${JSON.stringify(result.actual[name])} gate ${JSON.stringify(result.expected[name])}`,
          )
        mismatches.push(`${mode} / ${cell.id}: ${diff.join('; ')}`)
      }
    }
    expect(compared).toBe(CELLS.length)
    expect(mismatches).toEqual([])
  })
}

test('the fixture reaches the structures the cells name (IR and WYSIWYG)', async ({
  page,
}) => {
  // Guards the parity cells themselves: a fixture that stopped producing a footnotes block, a
  // table, a task item or a code block would make its cells compare plain text, and pass.
  for (const mode of ['ir', 'wysiwyg'] as const) {
    await openMode(page, mode)
    const found = await page.evaluate(() => {
      const v = (window as any).vditor.vditor
      const root = v[v.currentMode].element as HTMLElement
      return {
        table: !!root.querySelector('td'),
        task: !!root.querySelector('li.vditor-task'),
        ordered: !!root.querySelector('ol > li'),
        nested: !!root.querySelector('li li'),
        quote: !!root.querySelector('blockquote'),
        footnotes: root.innerHTML.includes('footnotes-'),
        codeBlock: root.innerHTML.includes('code-block'),
      }
    })
    expect(found, mode).toEqual({
      table: true,
      task: true,
      ordered: true,
      nested: true,
      quote: true,
      footnotes: true,
      codeBlock: true,
    })
  }
})
