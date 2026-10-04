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
