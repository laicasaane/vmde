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

test('Link and Wiki Link replace only the retained selected text with exact Markdown', async ({
  page,
}) => {
  for (const [action, expected] of [
    ['Link', 'alpha\n\n[beta]()\n'],
    ['Wiki Link', 'alpha\n\n[[beta]]\n'],
  ] as const) {
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
    await bubble.getByRole('button', { name: action, exact: true }).click()
    await expect
      .poll(() => page.evaluate(() => (window as any).vditor.getValue()))
      .toBe(expected)
    expect(
      await page.evaluate(() => (window as any).__selectionBubbleExact),
    ).toBe(expected)
    if (action === 'Link')
      expect(
        await page.evaluate(() => {
          const selection = window.getSelection()
          const node = selection?.anchorNode
          const element = node instanceof Element ? node : node?.parentElement
          return Boolean(element?.closest('.vditor-ir__marker--link'))
        }),
      ).toBe(true)
    expect(
      await page.evaluate(() => (window as any).__selectionBubbleError),
    ).toBeUndefined()
  }
})

test('hidden-toolbar WYSIWYG bubble formats and SV source mode hides it', async ({
  page,
}) => {
  await page.goto('/selection-bubble.html')
  await page.waitForFunction(() => (window as any).__ready === true)
  await page.evaluate(() => (window as any).__setSelectionBubbleMode('wysiwyg'))
  const p = page.locator('.vditor-wysiwyg .vditor-reset > p').last()
  await expect(p).toBeVisible()
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
  await bubble.getByRole('button', { name: 'Italic' }).click()
  await expect
    .poll(() => page.evaluate(() => (window as any).vditor.getValue()))
    .toBe('alpha\n\n*beta*\n')
  await page.evaluate(() => (window as any).__setSelectionBubbleMode('sv'))
  await page.evaluate(() =>
    document.dispatchEvent(new Event('selectionchange')),
  )
  await expect(bubble).toBeHidden()
})

test('WYSIWYG Link keeps the shipped selected-link insertion behavior and exact source', async ({
  page,
}) => {
  await page.goto('/selection-bubble.html')
  await page.waitForFunction(() => (window as any).__ready === true)
  await page.evaluate(() => (window as any).__setSelectionBubbleMode('wysiwyg'))
  await page
    .locator('.vditor-wysiwyg .vditor-reset > p')
    .last()
    .evaluate((p) => {
      const text = p.firstChild!
      const range = document.createRange()
      range.setStart(text, 0)
      range.setEnd(text, 4)
      const selection = window.getSelection()!
      selection.removeAllRanges()
      selection.addRange(range)
      document.dispatchEvent(new Event('selectionchange'))
    })
  await page
    .locator('.vmde-selection-bubble')
    .getByRole('button', { name: 'Link', exact: true })
    .click()
  await expect
    .poll(() => page.evaluate(() => (window as any).__selectionBubbleExact))
    .toBe('alpha\n\n[beta]()\n')
  await expect(page.locator('.vditor-wysiwyg__popover input')).toHaveCount(0)
  await expect(
    page.locator('.vditor-wysiwyg .vditor-reset > p').last(),
  ).toContainText('beta')
})

test('IR Link URL caret accepts typing after selected-text insertion', async ({
  page,
}) => {
  await page.goto('/selection-bubble.html')
  await page.waitForFunction(() => (window as any).__ready === true)
  await page
    .locator('.vditor-ir .vditor-reset > p')
    .last()
    .evaluate((p) => {
      const range = document.createRange()
      range.setStart(p.firstChild!, 0)
      range.setEnd(p.firstChild!, 4)
      const selection = window.getSelection()!
      selection.removeAllRanges()
      selection.addRange(range)
      document.dispatchEvent(new Event('selectionchange'))
    })
  await page
    .locator('.vmde-selection-bubble')
    .getByRole('button', { name: 'Link', exact: true })
    .click()
  await page.keyboard.type('https://example.test')
  await expect
    .poll(() => page.evaluate(() => (window as any).vditor.getValue()))
    .toBe('alpha\n\n[beta](https://example.test)\n')
})

test('formatted text can become a Link, while existing link labels decline', async ({
  page,
}) => {
  for (const [source, expected] of [
    ['**alpha**\n\nbeta\n', '**[alpha]()**\n\nbeta\n'],
    ['[alpha](url)\n\nbeta\n', '[alpha](url)\n\nbeta\n'],
  ] as const) {
    await page.goto('/selection-bubble.html')
    await page.waitForFunction(() => (window as any).__ready === true)
    await page.evaluate(
      (markdown) => (window as any).vditor.setValue(markdown),
      source,
    )
    await page
      .locator('.vditor-ir .vditor-reset > p')
      .first()
      .evaluate((p) => {
        const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT)
        let text: Text | null = null
        for (;;) {
          text = walker.nextNode() as Text | null
          if (!text || text.textContent === 'alpha') break
        }
        if (!text) throw new Error('visible alpha text missing')
        const range = document.createRange()
        range.setStart(text, 0)
        range.setEnd(text, 5)
        const selection = window.getSelection()!
        selection.removeAllRanges()
        selection.addRange(range)
        document.dispatchEvent(new Event('selectionchange'))
      })
    await page
      .locator('.vmde-selection-bubble')
      .getByRole('button', { name: 'Link', exact: true })
      .click()
    await expect
      .poll(() => page.evaluate(() => (window as any).vditor.getValue()))
      .toBe(expected)
  }
})

test('selected heading text Link uses exact source ownership', async ({
  page,
}) => {
  await page.goto('/selection-bubble.html')
  await page.waitForFunction(() => (window as any).__ready === true)
  await page.evaluate(() =>
    (window as any).vditor.setValue('**alpha**\n\n## beta\n'),
  )
  await page
    .locator('.vditor-ir .vditor-reset > [data-block]')
    .last()
    .evaluate((element) => {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
      let text: Text | null = null
      for (;;) {
        text = walker.nextNode() as Text | null
        if (!text || text.textContent === 'beta') break
      }
      if (!text) throw new Error('beta missing')
      const range = document.createRange()
      range.setStart(text, 0)
      range.setEnd(text, 4)
      const selection = window.getSelection()!
      selection.removeAllRanges()
      selection.addRange(range)
      document.dispatchEvent(new Event('selectionchange'))
    })
  await page
    .locator('.vmde-selection-bubble')
    .getByRole('button', { name: 'Link', exact: true })
    .click()
  await expect
    .poll(() => page.evaluate(() => (window as any).__selectionBubbleExact))
    .toBe('**alpha**\n\n## [beta]()\n')
})
