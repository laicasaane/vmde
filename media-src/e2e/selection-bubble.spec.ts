import { expect, test } from './coverage-fixture'

test('hidden-toolbar selection bubble formats locally and stays outside serialized DOM', async ({
  page,
}) => {
  await page.goto('/selection-bubble.html')
  await page.waitForFunction(() => (window as any).__ready === true)
  await expect(page.locator('.vditor-toolbar [data-type="bold"]')).toHaveCount(
    0,
  )
  const p = page.locator('.vditor-ir .vditor-reset > p').first()
  await p.click()
  await p.evaluate((element) => {
    const text = element.firstChild!
    const range = document.createRange()
    range.setStart(text, 0)
    range.setEnd(text, 5)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))
  })
  const bubble = page.locator('.vmde-selection-bubble')
  await expect(bubble).toBeVisible()
  expect(
    await bubble.evaluate((element) =>
      Boolean(element.closest('.vditor-reset')),
    ),
  ).toBe(false)
  await bubble.getByRole('button', { name: 'Bold' }).click()
  await expect
    .poll(() => page.evaluate(() => (window as any).vditor.getValue()))
    .toBe('**alpha**\n\nbeta\n')
  expect(
    await page.evaluate(() => (window as any).__selectionBubbleError),
  ).toBeUndefined()
})

test('Turn Into dropdown reuses source-derived options and one guarded choice', async ({
  page,
}) => {
  await page.goto('/selection-bubble.html')
  await page.waitForFunction(() => (window as any).__ready === true)
  const p = page.locator('.vditor-ir .vditor-reset > p').last()
  await p.click()
  await p.evaluate((element) => {
    const text = element.firstChild!
    const range = document.createRange()
    range.setStart(text, 0)
    range.setEnd(text, 4)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))
  })
  const bubble = page.locator('.vmde-selection-bubble')
  await expect(bubble).toBeVisible()
  await bubble.getByRole('button', { name: 'Turn Into' }).click()
  const menu = bubble.locator('.vmde-selection-bubble-menu')
  await expect(menu).toBeVisible()
  await expect(
    menu.getByRole('menuitemradio', { name: '✓ Paragraph' }),
  ).toHaveAttribute('aria-checked', 'true')
  await expect(
    menu.getByRole('menuitemradio', { name: 'Code Fence' }),
  ).toBeDisabled()
  await menu.getByRole('menuitemradio', { name: 'Heading 2' }).click()
  await expect
    .poll(() => page.evaluate(() => (window as any).vditor.getValue()))
    .toBe('alpha\n\n## beta\n')
  expect(
    await page.evaluate(() => (window as any).__selectionBubbleExact),
  ).toBe('alpha\n\n## beta\n')
})

test('collapsed selection and composition hide the bubble', async ({
  page,
}) => {
  await page.goto('/selection-bubble.html')
  await page.waitForFunction(() => (window as any).__ready === true)
  const p = page.locator('.vditor-ir .vditor-reset > p').first()
  await p.click()
  await p.evaluate((element) => {
    const text = element.firstChild!
    const range = document.createRange()
    range.setStart(text, 0)
    range.setEnd(text, 5)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))
  })
  const bubble = page.locator('.vmde-selection-bubble')
  await expect(bubble).toBeVisible()
  await page.evaluate(() =>
    document.dispatchEvent(
      new CompositionEvent('compositionstart', { bubbles: true }),
    ),
  )
  await expect(bubble).toBeHidden()
  await page.evaluate(() => {
    const selection = window.getSelection()!
    selection.collapseToEnd()
    document.dispatchEvent(new Event('selectionchange'))
  })
  await expect(bubble).toBeHidden()
})
