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
  await page.addInitScript(() => {
    ;(window as any).__postedBlockConsent = []
    ;(window as any).acquireVsCodeApi = () => ({
      postMessage: (message: unknown) => {
        ;(window as any).__postedBlockConsent.push(message)
      },
      getState: () => ({}),
      setState: () => undefined,
    })
  })
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
    menu.getByRole('menuitemradio', { name: '⚠ Code Fence' }),
  ).toBeEnabled()
  await menu.getByRole('menuitemradio', { name: 'Heading 2' }).click()
  const choice = await page.evaluate(() =>
    (window as any).__postedBlockConsent.at(-1),
  )
  expect(choice).toMatchObject({
    command: 'block-transform-consent',
    target: { type: 'h2' },
    status: 'changed',
    losses: [],
  })
  expect(await page.evaluate(() => (window as any).vditor.getValue())).toBe(
    'alpha\n\nbeta\n',
  )
  expect(
    await page.evaluate(
      (request) => (window as any).__applyBubbleChoice(request),
      choice,
    ),
  ).toBe(true)
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

test('scroll, drag and Preview suppress a visible bubble without editing', async ({
  page,
}) => {
  await page.goto('/selection-bubble.html')
  await page.waitForFunction(() => (window as any).__ready === true)
  const select = async () =>
    page
      .locator('.vditor-ir .vditor-reset > p')
      .first()
      .evaluate((element) => {
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
        let text: Text | null = null
        for (;;) {
          text = walker.nextNode() as Text | null
          if (!text || text.data.includes('alpha')) break
        }
        if (!text) throw new Error('alpha text missing')
        const range = document.createRange()
        range.setStart(text, 0)
        range.setEnd(text, 5)
        const selection = window.getSelection()!
        selection.removeAllRanges()
        selection.addRange(range)
        document.dispatchEvent(new Event('selectionchange'))
      })
  const bubble = page.locator('.vmde-selection-bubble')
  await select()
  await expect(bubble).toBeVisible()
  await page.evaluate(() =>
    document.dispatchEvent(new Event('dragstart', { bubbles: true })),
  )
  await expect(bubble).toBeHidden()
  await select()
  await expect(bubble).toBeVisible()
  await page
    .locator('.vditor-ir .vditor-reset')
    .evaluate((element) =>
      element.dispatchEvent(new Event('scroll', { bubbles: true })),
    )
  await expect(bubble).toBeHidden()
  await select()
  await expect(bubble).toBeVisible()
  await page.evaluate(() => {
    ;(window as any).vditor.vditor.preview.element.style.display = 'block'
    ;(window as any).vditor.vditor.preview.previewElement.append(
      document.createElement('span'),
    )
  })
  await expect(bubble).toBeHidden()
  expect(await page.evaluate(() => (window as any).vditor.getValue())).toBe(
    'alpha\n\nbeta\n',
  )
})

test('a changed live Range cannot commit from a stale same-text bubble bookmark', async ({
  page,
}) => {
  await page.goto('/selection-bubble.html')
  await page.waitForFunction(() => (window as any).__ready === true)
  await page.evaluate(() => (window as any).vditor.setValue('alpha\n\nalpha\n'))
  await page
    .locator('.vditor-ir .vditor-reset > p')
    .first()
    .evaluate((element) => {
      const text = element.firstChild!
      const range = document.createRange()
      range.setStart(text, 0)
      range.setEnd(text, 5)
      const selection = window.getSelection()!
      selection.removeAllRanges()
      selection.addRange(range)
      document.dispatchEvent(new Event('selectionchange'))
    })
  await expect(page.locator('.vmde-selection-bubble')).toBeVisible()
  const attempted = await page
    .locator('.vditor-ir .vditor-reset > p')
    .last()
    .evaluate((element) => {
      const original = document.execCommand.bind(document)
      let insertions = 0
      document.execCommand = (command, showUi, value) => {
        if (command === 'insertText') insertions++
        return original(command, showUi, value)
      }
      const text = element.firstChild!
      const range = document.createRange()
      range.setStart(text, 0)
      range.setEnd(text, 5)
      const selection = window.getSelection()!
      selection.removeAllRanges()
      selection.addRange(range)
      document.dispatchEvent(new Event('selectionchange'))
      document
        .querySelector<HTMLButtonElement>(
          '.vmde-selection-bubble button[data-action="link"]',
        )!
        .click()
      document.execCommand = original
      return insertions
    })
  expect(attempted).toBe(0)
  expect(await page.evaluate(() => (window as any).vditor.getValue())).toBe(
    'alpha\n\nalpha\n',
  )
})

test('formatting cannot reuse a stale bubble bookmark after selection moves', async ({
  page,
}) => {
  await page.goto('/selection-bubble.html')
  await page.waitForFunction(() => (window as any).__ready === true)
  await page
    .locator('.vditor-ir .vditor-reset > p')
    .first()
    .evaluate((element) => {
      const range = document.createRange()
      range.setStart(element.firstChild!, 0)
      range.setEnd(element.firstChild!, 5)
      const selection = window.getSelection()!
      selection.removeAllRanges()
      selection.addRange(range)
      document.dispatchEvent(new Event('selectionchange'))
    })
  await expect(page.locator('.vmde-selection-bubble')).toBeVisible()
  await page
    .locator('.vditor-ir .vditor-reset > p')
    .last()
    .evaluate((element) => {
      const range = document.createRange()
      range.setStart(element.firstChild!, 0)
      range.setEnd(element.firstChild!, 4)
      const selection = window.getSelection()!
      selection.removeAllRanges()
      selection.addRange(range)
      document.dispatchEvent(new Event('selectionchange'))
      document
        .querySelector<HTMLButtonElement>(
          '.vmde-selection-bubble button[data-action="bold"]',
        )!
        .click()
    })
  expect(await page.evaluate(() => (window as any).vditor.getValue())).toBe(
    'alpha\n\nbeta\n',
  )
})

test('bubble follows selection growth without changing document bytes', async ({
  page,
}) => {
  await page.goto('/selection-bubble.html')
  await page.waitForFunction(() => (window as any).__ready === true)
  const source = `${'x'.repeat(50)}abcdefghijklmnopqrstuvwxyz\n`
  await page.evaluate(
    (markdown) => (window as any).vditor.setValue(markdown),
    source,
  )
  await page
    .locator('.vditor-ir .vditor-reset > p')
    .first()
    .evaluate((element) => {
      const text = element.firstChild!
      const selection = window.getSelection()!
      selection.setBaseAndExtent(text, 50, text, 53)
      document.dispatchEvent(new Event('selectionchange'))
    })
  const bubble = page.locator('.vmde-selection-bubble')
  await expect(bubble).toBeVisible()
  const firstLeft = await bubble.evaluate(
    (element) => element.getBoundingClientRect().left,
  )
  await page
    .locator('.vditor-ir .vditor-reset > p')
    .first()
    .evaluate((element) => {
      const point = (offset: number) => {
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
        let remaining = offset
        for (
          let node = walker.nextNode() as Text | null;
          node;
          node = walker.nextNode() as Text | null
        ) {
          if (remaining <= node.data.length) return { node, offset: remaining }
          remaining -= node.data.length
        }
        throw new Error('selection offset outside paragraph')
      }
      const anchor = point(50)
      const focus = point(65)
      const selection = window.getSelection()!
      selection.setBaseAndExtent(
        anchor.node,
        anchor.offset,
        focus.node,
        focus.offset,
      )
      document.dispatchEvent(new Event('selectionchange'))
    })
  await expect
    .poll(() =>
      bubble.evaluate((element) => element.getBoundingClientRect().left),
    )
    .toBeGreaterThan(firstLeft + 4)
  expect(await page.evaluate(() => (window as any).vditor.getValue())).toBe(
    source,
  )
})

test('current fence bubble row requests a guarded language edit', async ({
  page,
}) => {
  await page.addInitScript(() => {
    ;(window as any).__postedBlockConsent = []
    ;(window as any).acquireVsCodeApi = () => ({
      postMessage: (message: unknown) => {
        ;(window as any).__postedBlockConsent.push(message)
      },
      getState: () => ({}),
      setState: () => undefined,
    })
  })
  await page.goto('/selection-bubble.html')
  await page.waitForFunction(() => (window as any).__ready === true)
  await page.evaluate(() =>
    (window as any).vditor.setValue('```js\nalpha\n```\n'),
  )
  await page
    .locator('.vditor-ir [data-type="code-block"]')
    .evaluate((block) => {
      const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT)
      let text: Text | null = null
      for (
        let node = walker.nextNode() as Text | null;
        node;
        node = walker.nextNode() as Text | null
      ) {
        if (node.data.includes('alpha')) {
          text = node
          break
        }
      }
      if (!text) throw new Error('code body text missing')
      const range = document.createRange()
      const start = text.data.indexOf('alpha')
      range.setStart(text, start)
      range.setEnd(text, start + 5)
      const selection = getSelection()!
      selection.removeAllRanges()
      selection.addRange(range)
      document.dispatchEvent(new Event('selectionchange'))
    })
  const bubble = page.locator('.vmde-selection-bubble')
  await expect(bubble).toBeVisible()
  await bubble.getByRole('button', { name: 'Turn Into' }).click()
  await bubble
    .getByRole('menuitemradio', { name: '✓ Code Fence · Edit Language…' })
    .click()
  const choice = await page.evaluate(() =>
    (window as any).__postedBlockConsent.at(-1),
  )
  expect(choice).toMatchObject({
    command: 'block-transform-consent',
    target: { type: 'fence', language: 'js' },
    status: 'edit-language',
  })
  expect(await page.evaluate(() => (window as any).vditor.getValue())).toBe(
    '```js\nalpha\n```\n',
  )
  expect(
    await page.evaluate(
      (request) =>
        (window as any).__applyBubbleChoice({
          ...request,
          target: { type: 'fence', language: 'ts' },
        }),
      choice,
    ),
  ).toBe(true)
  await expect
    .poll(() => page.evaluate(() => (window as any).vditor.getValue()))
    .toBe('```ts\nalpha\n```\n')
})
