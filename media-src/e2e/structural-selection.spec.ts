import type { Page } from '@playwright/test'
import { expect, test } from './coverage-fixture'

test.beforeEach(async ({ page }) => {
  await page.goto('/structural-selection.html')
  await page.waitForFunction(
    () => (window as unknown as { __ready?: boolean }).__ready,
  )
  await page.waitForTimeout(250) // let Vditor's asynchronous code render settle before exact ranges
})

const focusText = (page: Page, needle: string) =>
  page.evaluate(
    (text) =>
      (
        window as unknown as { __focusText(needle: string): boolean }
      ).__focusText(text),
    needle,
  )

const focusFenceSource = (page: Page) =>
  page.evaluate(() =>
    (
      window as unknown as { __focusFenceSource(): Promise<boolean> }
    ).__focusFenceSource(),
  )

const selectFenceSourceStage = (page: Page) =>
  page.evaluate(() =>
    (
      window as unknown as { __selectFenceSourceStage(): Promise<boolean> }
    ).__selectFenceSourceStage(),
  )

const selectionText = (page: Page) =>
  page.evaluate(() =>
    (window as unknown as { __selectionText(): string }).__selectionText(),
  )

const markdown = (page: Page) =>
  page.evaluate(() =>
    (window as unknown as { vditor: { getValue(): string } }).vditor.getValue(),
  )

const copySelection = (page: Page) =>
  page.evaluate(() =>
    (
      window as unknown as {
        __copySelection(): { plain: string; html: string }
      }
    ).__copySelection(),
  )

// Task 580 CP2-6 — Expand Selection's Windows/Linux key (VS Code's smartSelect.expand), run through
// the harness's keybinding shim. Ctrl+E no longer expands.
const EXPAND = 'Shift+Alt+ArrowRight'

const expandedTypes = (page: Page) =>
  page.evaluate(() =>
    (window as unknown as { __expandedTypes(): string[] }).__expandedTypes(),
  )

test('Ctrl+A stages current block → whole document and block-copy restores Markdown', async ({
  page,
}) => {
  expect(await focusText(page, 'alpha')).toBe(true)
  await page.keyboard.press('Control+a')
  expect(await selectionText(page)).toBe('alpha bold scope omega')
  expect(await copySelection(page)).toEqual({
    plain: 'alpha **bold scope** omega',
    html: '',
  })

  await page.keyboard.press('Control+a')
  const all = await selectionText(page)
  expect(all).toContain('alpha bold scope omega')
  expect(all).toContain('final paragraph')
})

test('a fence keeps Vditor source stage 0, then widens fence block → document', async ({
  page,
}) => {
  expect(await selectFenceSourceStage(page)).toBe(true)
  expect((await selectionText(page)).trim()).toBe('const fence = true')

  await page.keyboard.press('Control+a')
  const fenceSelection = await selectionText(page)
  expect(fenceSelection).toContain('const fence = true')
  const copied = await copySelection(page)
  expect(copied.plain).toContain('```ts')
  expect(copied.plain).toContain('const fence = true')
  expect(copied.plain).toContain('```')
  expect(copied.html).toBe('')

  await page.keyboard.press('Control+a')
  expect(await selectionText(page)).toContain('final paragraph')
})

test('Expand Selection selects marker-free inline content and type-over preserves the style', async ({
  page,
}) => {
  expect(await focusText(page, 'bold scope')).toBe(true)
  await page.keyboard.press(EXPAND)
  expect(await selectionText(page)).toBe('bold scope')
  await page.evaluate(() => {
    document
      .querySelector<HTMLElement>('.vditor-ir .vditor-reset')
      ?.focus({ preventScroll: true })
  })
  expect(await selectionText(page)).toBe('bold scope')
  await page.keyboard.type('REPLACED')
  await expect.poll(() => markdown(page)).toContain('alpha **REPLACED** omega')
})

test('repeated Expand Selection widens inline → paragraph → document', async ({
  page,
}) => {
  expect(await focusText(page, 'bold scope')).toBe(true)
  await page.keyboard.press(EXPAND)
  expect(await selectionText(page)).toBe('bold scope')
  await page.keyboard.press(EXPAND)
  expect(await selectionText(page)).toContain('alpha')
  expect(await selectionText(page)).toContain('omega')
  expect((await copySelection(page)).plain).toBe('alpha **bold scope** omega')
  await page.keyboard.press(EXPAND)
  expect(await selectionText(page)).toContain('final paragraph')
})

test('table Expand Selection widens cell → table block → document', async ({
  page,
}) => {
  expect(await focusText(page, 'cell one')).toBe(true)
  await page.keyboard.press(EXPAND)
  expect(await selectionText(page)).toBe('cell one')
  await page.keyboard.press(EXPAND)
  expect(await selectionText(page)).toContain('cell two')
  expect((await copySelection(page)).plain).toContain('| cell one | cell two |')
  await page.keyboard.press(EXPAND)
  expect(await selectionText(page)).toContain('final paragraph')
})

test('Ctrl+A selects the nested list item rather than the outer list', async ({
  page,
}) => {
  expect(await focusText(page, 'nested item')).toBe(true)
  await page.keyboard.press('Control+a')
  const selected = await selectionText(page)
  expect(selected).toContain('nested item')
  expect(selected).not.toContain('first item')
})

test('Ctrl+E no longer selects anything in the editor', async ({ page }) => {
  expect(await focusText(page, 'bold scope')).toBe(true)
  await page.keyboard.press('Control+e')
  expect(await selectionText(page)).toBe('')
  expect(await markdown(page)).toContain('alpha **bold scope** omega')
})

test('Ctrl+A from a caret in the fence source selects the code first', async ({
  page,
}) => {
  expect(await focusFenceSource(page)).toBe(true)
  await page.keyboard.press('Control+a')
  expect((await selectionText(page)).trim()).toBe('const fence = true')
  await page.keyboard.press('Control+a')
  expect((await copySelection(page)).plain).toContain('```ts')
  await page.keyboard.press('Control+a')
  expect(await selectionText(page)).toContain('final paragraph')
})

test('Esc collapses the inline marker, then selects its block; Esc→Tab still exits', async ({
  page,
}) => {
  expect(await focusText(page, 'bold scope')).toBe(true)
  await expect
    .poll(() =>
      page.evaluate(() =>
        (
          window as unknown as { __expandedTypes(): string[] }
        ).__expandedTypes(),
      ),
    )
    .toContain('strong')

  await page.keyboard.press('Escape')
  expect(
    await page.evaluate(() =>
      (window as unknown as { __expandedTypes(): string[] }).__expandedTypes(),
    ),
  ).not.toContain('strong')
  expect(await selectionText(page)).toBe('')

  await page.keyboard.press('Escape')
  expect(await selectionText(page)).toBe('alpha bold scope omega')
  await page.keyboard.press('Tab')
  await expect
    .poll(() =>
      page.evaluate(
        () => document.activeElement?.closest('[role="toolbar"]') !== null,
      ),
    )
    .toBe(true)
})

test('triple-click normalizes a fence to marker-inclusive block copy', async ({
  page,
}) => {
  expect(await focusFenceSource(page)).toBe(true)
  await expect.poll(() => expandedTypes(page)).toContain('code-block')
  await page
    .locator(
      '.vditor-ir [data-type="code-block"] > .vditor-ir__marker--pre > code',
    )
    .click({ clickCount: 3 })
  const copied = await copySelection(page)
  expect(copied.plain).toContain('```ts')
  expect(copied.plain).toContain('const fence = true')
  expect(copied.plain).toContain('```')
})

test('triple-click paragraph type-over leaves no orphan inline markers', async ({
  page,
}) => {
  await page
    .locator('.vditor-ir p')
    .filter({ hasText: 'alpha' })
    .click({ clickCount: 3 })
  await expect.poll(() => selectionText(page)).toBe('alpha bold scope omega')
  await page.evaluate(() => {
    document
      .querySelector<HTMLElement>('.vditor-ir .vditor-reset')
      ?.focus({ preventScroll: true })
  })
  expect(await selectionText(page)).toBe('alpha bold scope omega')
  await page.keyboard.type('WHOLE BLOCK')
  await expect.poll(() => markdown(page)).toContain('WHOLE BLOCK')
  const value = await markdown(page)
  expect(value).not.toContain('bold scope')
  expect(value).not.toContain('**')
})

// Task 613 — Vditor's undo snapshot runs `undoDelay` after an edit and restores the selection
// through the caret authority. A whole-document (or table block) Range has its endpoints on the
// editable root itself; the snapshot must keep that Range, not collapse it to the document start.
const undoDelay = (page: Page) =>
  page.evaluate(
    () =>
      ((window as any).vditor.vditor.options.undoDelay as number | undefined) ??
      800,
  )

const rangeEnds = (page: Page) =>
  page.evaluate(() => {
    const editor = (window as any).vditor.vditor.ir.element as HTMLElement
    const selection = getSelection()
    const range = selection?.rangeCount ? selection.getRangeAt(0) : null
    const describe = (node: Node | undefined) =>
      node === editor
        ? 'root'
        : node instanceof Element
          ? node.tagName
          : (node?.nodeName ?? 'none')
    return {
      start: describe(range?.startContainer),
      startOffset: range?.startOffset ?? -1,
      end: describe(range?.endContainer),
      endOffset: range?.endOffset ?? -1,
      children: editor.childNodes.length,
    }
  })

const tableRange = (page: Page) =>
  page.evaluate(() => {
    const table = document.querySelector('.vditor-ir table')!
    const parent = table.parentNode!
    const index = Array.prototype.indexOf.call(parent.childNodes, table)
    const editor = (window as any).vditor.vditor.ir.element as HTMLElement
    return {
      start: parent === editor ? 'root' : (parent as Element).tagName,
      startOffset: index,
      end: parent === editor ? 'root' : (parent as Element).tagName,
      endOffset: index + 1,
      children: editor.childNodes.length,
    }
  })

test('Select All right after an edit keeps the whole document past the undo snapshot', async ({
  page,
}) => {
  expect(await focusText(page, 'final paragraph')).toBe(true)
  await page.keyboard.type('Z')
  await page.keyboard.press('Control+a')
  await page.keyboard.press('Control+a')
  const whole = await rangeEnds(page)
  expect(whole).toEqual({
    start: 'root',
    startOffset: 0,
    end: 'root',
    endOffset: whole.children,
    children: whole.children,
  })
  await page.waitForTimeout((await undoDelay(page)) + 200) // negative assertion: nothing moves it
  expect(await rangeEnds(page)).toEqual(whole)
})

test('the table block stage survives the undo snapshot of an edit in the table', async ({
  page,
}) => {
  expect(await focusText(page, 'cell one')).toBe(true)
  await page.keyboard.type('X')
  await page.keyboard.press('Control+a')
  const block = await tableRange(page)
  expect(await rangeEnds(page)).toEqual(block)
  await page.waitForTimeout((await undoDelay(page)) + 200) // negative assertion: nothing moves it
  expect(await rangeEnds(page)).toEqual(block)
})

const undoOnce = (page: Page) =>
  page.evaluate(() =>
    (window as unknown as { __undoFindReplace(): void }).__undoFindReplace(),
  )

// Task 613 — Delete and type-over of the whole document after the snapshot has run. The opening
// snapshot settles first, so the typed edit makes the history non-initial, as in the real flow: a
// first keydown on a one-entry history runs Vditor's recordFirstPosition, which still desyncs a
// root selection (the task record's follow-up).
for (const [label, act, expected] of [
  ['Delete', (page: Page) => page.keyboard.press('Delete'), '\n'],
  ['type-over', (page: Page) => page.keyboard.type('X'), 'X\n'],
] as const) {
  test(`${label} of a whole-document selection past the undo snapshot replaces everything and one Undo restores it`, async ({
    page,
  }) => {
    const wait = (await undoDelay(page)) + 200
    await page.waitForTimeout(wait) // Vditor's opening snapshot is debounced by undoDelay too
    expect(await focusText(page, 'final paragraph')).toBe(true)
    await page.keyboard.type('Z')
    await page.keyboard.press('Control+a')
    await page.keyboard.press('Control+a')
    await page.waitForTimeout(wait) // past the typed edit's snapshot, which must keep the Range
    const original = await markdown(page)
    expect(original).toContain('final pZaragraph')
    const whole = await rangeEnds(page)
    expect(whole).toMatchObject({ start: 'root', startOffset: 0, end: 'root' })
    expect(whole.endOffset).toBe(whole.children)

    await act(page)
    await expect.poll(() => markdown(page)).toBe(expected)
    await page.waitForTimeout(wait) // record the replacement as its own Undo step
    await undoOnce(page)
    await expect.poll(() => markdown(page)).toBe(original)
  })
}
