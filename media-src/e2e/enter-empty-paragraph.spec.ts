import type { Page } from '@playwright/test'
import { expect, test } from './coverage-fixture'

// Tasks 625 + 627. Enter at the end of a paragraph or heading makes Vditor add an empty `<p>`; its
// `p:empty::before { content: ' ' }` is the only thing that gives that `<p>` a line box, and only
// under `white-space: pre-wrap`. main.css collapses whitespace on prose blocks (the soft-break
// reflow rule), so without a counter-rule the new `<p>` is height 0 and the caret in it is
// canonicalized into a NEIGHBOURING block when the first key carries Shift (Vditor's
// `fixCJKPosition` seeds a ZWSP on an unshifted first key, which masks the defect). The keybugs
// harness serves the source main.css, so this spec fails whenever the empty `<p>` loses its line
// box. The real-VS-Code twin is test/vscode-e2e/enter-new-paragraph.spec.ts (XTEST keys).

type Mode = 'ir' | 'wysiwyg'

const PREFIX = '# Probe\n\nAlpha bravo charlie delta.\n\n'
const MIDDLE =
  '# Probe\n\nAlpha bravo charlie delta.\n\nEcho `foxtrot` golf hotel.\n\nIndia juliet kilo lima.\n'

interface Case {
  id: string
  doc: string
  /** Token whose end holds the caret before Enter. */
  anchor: string
  /** Host text after Enter and a Shift+Y. */
  expected: Record<Mode, string>
}

const CASES: Case[] = [
  {
    id: 'middle paragraph',
    doc: MIDDLE,
    anchor: 'delta.',
    expected: {
      ir: MIDDLE.replace('delta.\n\n', 'delta.\n\nY\n\n'),
      wysiwyg: MIDDLE.replace('delta.\n\n', 'delta.\n\nY\n\n'),
    },
  },
  {
    id: 'last paragraph',
    doc: MIDDLE,
    anchor: 'lima.',
    expected: {
      ir: MIDDLE.replace(/lima\.\n$/, 'lima.\n\nY\n'),
      wysiwyg: MIDDLE.replace(/lima\.\n$/, 'lima.\n\nY\n'),
    },
  },
  {
    id: 'last heading',
    doc: `${PREFIX}## Echo foxtrot\n`,
    anchor: 'foxtrot',
    expected: {
      ir: `${PREFIX}## Echo foxtrot\n\nY\n`,
      wysiwyg: `${PREFIX}## Echo foxtrot\n\nY\n`,
    },
  },
  {
    // Vditor's own blockquote rule: the new empty paragraph is INSIDE the quote.
    id: 'last blockquote',
    doc: `${PREFIX}> Echo foxtrot golf.\n`,
    anchor: 'golf.',
    expected: {
      ir: `${PREFIX}> Echo foxtrot golf.\n>\n> Y\n`,
      wysiwyg: `${PREFIX}> Echo foxtrot golf.\n>\n> Y\n`,
    },
  },
]

async function open(page: Page, mode: Mode, doc: string, anchor: string) {
  await page.goto(`/keybugs.html?mode=${mode}`)
  await page.waitForFunction(() => (window as any).__ready === true)
  await page.evaluate(
    async ([value, token]) => {
      const editor = (window as any).vditor
      editor.setValue(value)
      await new Promise((resolve) => setTimeout(resolve, 100))
      const root = (window as any).__modeEl() as HTMLElement
      root.focus()
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = node as Text
        // Code and diagram blocks hold a source and a render copy: only the editable source counts.
        if (text.parentElement?.closest('[data-render]')) continue
        const at = text.data.indexOf(token)
        if (at < 0) continue
        const range = document.createRange()
        range.setStart(text, at + token.length)
        range.collapse(true)
        const selection = window.getSelection()!
        selection.removeAllRanges()
        selection.addRange(range)
        return
      }
      throw new Error(`no editable text containing ${token}`)
    },
    [doc, anchor],
  )
}

// The block holding the caret right now: its tag, whether it has no children, and its rendered height.
const caretBlock = (page: Page) =>
  page.evaluate(() => {
    const node = window.getSelection()?.anchorNode ?? null
    const element = node instanceof Element ? node : node?.parentElement
    const block = element?.closest('p, h1, h2, h3, h4, h5, h6, li')
    return block
      ? {
          tag: block.tagName.toLowerCase(),
          empty: block.childNodes.length === 0,
          height: Math.round(block.getBoundingClientRect().height * 10) / 10,
        }
      : null
  })

for (const mode of ['ir', 'wysiwyg'] as const) {
  test.describe(`Enter then a Shift key (${mode})`, () => {
    for (const c of CASES) {
      test(`${c.id}: the new paragraph has a line box and takes the first Shift+Y`, async ({
        page,
      }) => {
        await open(page, mode, c.doc, c.anchor)
        await page.keyboard.press('Enter')
        await page.waitForTimeout(100)
        // The paragraph Enter added is empty and the caret is in it; without a line box its height is 0.
        const block = await caretBlock(page)
        expect.soft(block?.tag, 'caret is in a paragraph').toBe('p')
        expect.soft(block?.empty, 'the new paragraph is empty').toBe(true)
        expect
          .soft(block?.height, 'the empty paragraph has a line box')
          .toBeGreaterThan(0)
        await page.keyboard.press('Shift+Y')
        await page.waitForTimeout(300)
        const value = await page.evaluate(() =>
          (window as any).vditor.getValue(),
        )
        expect(value, 'Y is in the new paragraph, the rest is exact').toBe(
          c.expected[mode],
        )
      })
    }
  })
}

// The soft-break reflow rule (white-space: normal on prose blocks) must keep applying to NON-empty
// blocks: only the empty paragraph gets its line box back.
test('non-empty paragraphs still collapse whitespace (reflow rule kept)', async ({
  page,
}) => {
  await open(page, 'ir', MIDDLE, 'lima.')
  const whiteSpace = await page.evaluate(() =>
    Array.from(
      (window as any)
        .__modeEl()
        .querySelectorAll('p') as NodeListOf<HTMLElement>,
    ).map((p) => getComputedStyle(p).whiteSpace),
  )
  expect(whiteSpace.length).toBeGreaterThan(0)
  expect(new Set(whiteSpace)).toEqual(new Set(['normal']))
})
