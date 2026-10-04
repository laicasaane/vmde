import { expect, test } from './coverage-fixture'
import { openRewrapHarness, placeRewrapCaret } from './rewrap-helpers'

const value = (page: import('@playwright/test').Page) =>
  page.evaluate(() => (window as any).__rewrap.editor.getValue() as string)

const undoLength = (page: import('@playwright/test').Page) =>
  page.evaluate(() => {
    const inner = (window as any).__rewrap.editor.vditor
    return inner.undo[inner.currentMode].undoStack.length as number
  })

// Task 580 CP2-4 — heading shift has no default key: Ctrl+Shift+[ / ] belong to Fold / Unfold and
// the webview no longer matches them. The commands' `shift-heading-level` route runs the same
// shift the harness exposes as `__rewrap.shiftHeading(direction, section)`.
const shiftHeading = (
  page: import('@playwright/test').Page,
  direction: -1 | 1,
  section = false,
) =>
  page.evaluate(
    ([d, s]) => (window as any).__rewrap.shiftHeading(d, s) as boolean,
    [direction, section] as const,
  )

for (const mode of ['ir', 'wysiwyg', 'sv'] as const) {
  test(`${mode}: Demote Heading shifts one heading with exact caret and one-step undo; the old chords are inert`, async ({
    page,
  }) => {
    await openRewrapHarness(page, mode, false, false, 12, true)
    const initial = await value(page)
    const beforeUndo = await undoLength(page)
    await placeRewrapCaret(page, 'Child', 2)

    for (const chord of [
      'Control+Shift+]',
      'Control+Shift+[',
      'Control+Alt+Shift+]',
      'Control+Alt+Shift+[',
    ])
      await page.keyboard.press(chord)
    await page.waitForTimeout(100)
    expect(await value(page)).toBe(initial)

    // Vditor's own keydown handling may split the caret's text node, so the caret stays where it
    // was placed instead of being searched for again; the caret assertion below checks it.
    expect(await shiftHeading(page, 1)).toBe(true)

    await expect
      .poll(() => value(page))
      .toBe(initial.replace('## Child', '### Child'))
    const state = await page.evaluate(() => ({
      ...(window as any).__rewrap.state(),
      caret: (window as any).__rewrap.cursorOffset(),
    }))
    expect(state.syncs).toBe(1)
    expect(state.error).toBe('')
    expect(state.caret).toBe(initial.indexOf('Child') + 3)
    await expect.poll(() => undoLength(page)).toBeGreaterThan(beforeUndo)

    await page.keyboard.press('Control+z')
    await expect.poll(() => value(page)).toBe(initial)
  })
}

test('a selection spanning a root shifts its complete subtree and refuses partial clamp', async ({
  page,
}) => {
  await openRewrapHarness(page, 'ir', false, false, 12, true)
  const initial = await value(page)
  await page.evaluate(() => {
    const inner = (window as any).__rewrap.editor.vditor
    const editor = inner.ir.element as HTMLElement
    const headings = Array.from(
      editor.querySelectorAll<HTMLElement>('h1,h2,h3'),
    )
    const root = headings.find((heading) =>
      heading.textContent?.includes('Root'),
    )!
    const sibling = headings.find((heading) =>
      heading.textContent?.includes('Sibling'),
    )!
    const textNode = (element: HTMLElement, needle: string) => {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (node.textContent?.includes(needle)) return node as Text
      }
      throw new Error(`${needle} heading text missing`)
    }
    const rootText = textNode(root, 'Root')
    const siblingText = textNode(sibling, 'Sibling')
    editor.focus({ preventScroll: true })
    const range = document.createRange()
    range.setStart(rootText, rootText.data.indexOf('Root'))
    range.setEnd(
      siblingText,
      siblingText.data.indexOf('Sibling') + 'Sibling'.length,
    )
    const selection = getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
  })

  expect(await shiftHeading(page, 1)).toBe(true)

  await expect
    .poll(() => value(page))
    .toBe(
      initial
        .replace('# Root', '## Root')
        .replace('## Child', '### Child')
        .replace('### Grandchild', '#### Grandchild')
        .replace('## Sibling', '### Sibling'),
    )
  await page.keyboard.press('Control+z')
  await expect.poll(() => value(page)).toBe(initial)

  await page.evaluate(() => {
    ;(window as any).__headingInfo = []
    ;(window as any).vscode = {
      ...(window as any).vscode,
      postMessage: (message: unknown) => {
        ;(window as any).__headingInfo.push(message)
      },
    }
  })
  await placeRewrapCaret(page, 'Root', 1)
  expect(await shiftHeading(page, -1)).toBe(false)
  await page.waitForTimeout(100)
  expect(await value(page)).toBe(initial)
  expect(
    await page.evaluate(() => (window as any).__headingInfo),
  ).toContainEqual({
    command: 'info',
    content: 'Heading level cannot be promoted above H1.',
  })
})

test('setext source converts to ATX through the shared transaction', async ({
  page,
}) => {
  await openRewrapHarness(page, 'sv', false, false, 12, true)
  await placeRewrapCaret(page, 'Setext', 2)

  expect(
    await page.evaluate(() => (window as any).__rewrap.shiftHeading(1, false)),
  ).toBe(true)

  await expect.poll(() => value(page)).toContain('### Setext\n')
  expect(await value(page)).not.toContain('------')
})
