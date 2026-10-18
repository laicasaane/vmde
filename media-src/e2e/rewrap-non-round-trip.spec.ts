// Task 606: Rewrap, auto-wrap and heading shift on a document whose rendering
// differs from its source (the table is written without padding, so Lute rewrites it). Each action
// applies only on a proven target and posts the exact plan, changing only the target bytes; an
// unprovable target declines with no edit.
import type { Page } from '@playwright/test'
import { expect, test } from './coverage-fixture'
import { placeRewrapCaret } from './rewrap-helpers'

const TABLE = '|a|b|\n|---|---|\n|x|y|'
const P1 =
  'Alpha one two three four five six seven eight nine ten eleven twelve.'
const P2 = 'Omega red orange yellow green blue indigo violet purple pink brown.'
const SOURCE = `${TABLE}\n\n# Title one\n\n## Sub heading\n\n${P1}\n\n${P2}\n`

async function open(
  page: Page,
  mode: 'ir' | 'wysiwyg',
  extra = '',
): Promise<void> {
  await page.goto(
    `/rewrap.html?mode=${mode}&column=30${extra}&fixture=${encodeURIComponent(SOURCE)}`,
  )
  await page.waitForFunction(() => (window as any).__ready === true)
  // The fixture must not round-trip, or the cases would not exercise the proof.
  expect(
    await page.evaluate(() => (window as any).__rewrap.editor.getValue()),
  ).not.toBe(SOURCE)
}

const posts = (page: Page) =>
  page.evaluate(
    () =>
      (window as any).__rewrap.state().exactPosts as Array<{
        markdown: string
        undoMarkdown: string
        hostBefore?: string
      }>,
  )

const rendered = (page: Page) =>
  page.evaluate(() => (window as any).__rewrap.editor.getValue() as string)

/** The edit stays inside [start, end) of the source; every other byte is the source's. */
function expectOnlyWithin(markdown: string, start: number, end: number) {
  expect(markdown.slice(0, start)).toBe(SOURCE.slice(0, start))
  expect(markdown.slice(markdown.length - (SOURCE.length - end))).toBe(
    SOURCE.slice(end),
  )
  expect(markdown).not.toBe(SOURCE)
  expect(markdown.startsWith(`${TABLE}\n\n`)).toBe(true)
}

for (const mode of ['ir', 'wysiwyg'] as const) {
  test.describe(mode, () => {
    test('selection Rewrap on a proven caret posts the exact plan and changes only its paragraph', async ({
      page,
    }) => {
      await open(page, mode)
      await placeRewrapCaret(page, 'three', 2)

      expect(await page.evaluate(() => (window as any).__rewrap.run())).toBe(
        true,
      )

      const [post, ...rest] = await posts(page)
      expect(rest).toEqual([])
      const p1 = SOURCE.indexOf(P1)
      expectOnlyWithin(post.markdown, p1, p1 + P1.length)
      expect(post.undoMarkdown).toBe(SOURCE)
      expect(post.markdown).toContain(`\n\n${P2}\n`)
      expect(
        await page.evaluate(() => (window as any).__rewrap.state().error),
      ).toBe('')
    })

    test('selection Rewrap on an unprovable target declines with no edit', async ({
      page,
    }) => {
      await open(page, mode)
      const before = await rendered(page)
      await page.evaluate(() => {
        const inner = (window as any).vditor.vditor
        const root = inner[inner.currentMode].element as HTMLElement
        const range = document.createRange()
        // An element offset includes syntax boundaries, so it is never provable.
        range.setStart(root, 0)
        range.collapse(true)
        const selection = getSelection()!
        selection.removeAllRanges()
        selection.addRange(range)
      })

      expect(await page.evaluate(() => (window as any).__rewrap.run())).toBe(
        false,
      )
      expect(await posts(page)).toEqual([])
      expect(await rendered(page)).toBe(before)
    })

    test('heading shift on a proven caret changes only the heading line', async ({
      page,
    }) => {
      await open(page, mode, '&heading=1')
      await placeRewrapCaret(page, 'Sub', 1)

      expect(
        await page.evaluate(() => (window as any).__rewrap.shiftHeading(1)),
      ).toBe(true)

      const [post] = await posts(page)
      expect(post.markdown).toBe(SOURCE.replace('## Sub', '### Sub'))
      expect(post.undoMarkdown).toBe(SOURCE)
    })

    test('heading shift on an unprovable caret declines with no edit', async ({
      page,
    }) => {
      await open(page, mode, '&heading=1')
      const before = await rendered(page)
      await page.evaluate(() => {
        const inner = (window as any).vditor.vditor
        const root = inner[inner.currentMode].element as HTMLElement
        const range = document.createRange()
        range.setStart(root, 0)
        range.collapse(true)
        const selection = getSelection()!
        selection.removeAllRanges()
        selection.addRange(range)
      })

      expect(
        await page.evaluate(() => (window as any).__rewrap.shiftHeading(1)),
      ).toBe(false)
      expect(await posts(page)).toEqual([])
      expect(await rendered(page)).toBe(before)
    })

    test('auto-wrap after typing posts an exact plan that changes only the typed paragraph', async ({
      page,
    }) => {
      await open(page, mode, '&auto=1&delay=300')
      await placeRewrapCaret(page, 'three', 5)

      await page.keyboard.type('z')

      await expect.poll(async () => (await posts(page)).length).toBe(1)
      const [post] = await posts(page)
      const p1 = SOURCE.indexOf(P1)
      expect(post.markdown.slice(0, p1)).toBe(SOURCE.slice(0, p1))
      expect(post.markdown.endsWith(`\n\n${P2}\n`)).toBe(true)
      expect(post.markdown).toContain('threez')
      expect(post.markdown).not.toContain(P1)
    })
  })
}
