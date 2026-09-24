import { expect, test } from './coverage-fixture'

async function openEditor(page: import('@playwright/test').Page) {
  await page.goto('/block-transform.html')
  await page.waitForFunction(() => (window as any).__ready === true)
}

async function chooseCaret(
  page: import('@playwright/test').Page,
  mode: 'ir' | 'wysiwyg' | 'sv',
  needle: string,
) {
  await page.locator('body').evaluate(
    (_body, args) => {
      const [currentMode, text] = args as [string, string]
      const root = (window as any).vditor.vditor[currentMode]
        .element as HTMLElement
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      for (
        let node = walker.nextNode() as Text | null;
        node;
        node = walker.nextNode() as Text | null
      ) {
        const index = node.data.indexOf(text)
        if (index < 0) continue
        const range = document.createRange()
        range.setStart(node, index + 2)
        range.collapse(true)
        const selection = getSelection()!
        selection.removeAllRanges()
        selection.addRange(range)
        root.focus()
        document.dispatchEvent(new Event('selectionchange'))
        return
      }
      throw new Error(`missing ${text} in ${currentMode}`)
    },
    [mode, needle],
  )
}

function getValue(page: import('@playwright/test').Page): Promise<string> {
  return page.evaluate(() => (window as any).vditor.getValue())
}

test('IR source-derived choice converts one block, posts exact once, and uses one undo step', async ({
  page,
}) => {
  await openEditor(page)
  await chooseCaret(page, 'ir', 'beta')
  const options = await page.evaluate(() => (window as any).__blockOptions())
  expect(options.currentType).toBe('paragraph')
  expect(
    options.targets.find((target: any) => target.type === 'h2')?.status,
  ).toBe('changed')
  const before = await getValue(page)
  expect(
    await page.evaluate(
      (token) => (window as any).__blockApply(token, { type: 'h2' }),
      options.token,
    ),
  ).toBe(true)
  await expect.poll(() => getValue(page)).toContain('## alpha **beta**')
  expect(
    await page.evaluate(() => (window as any).__postedBlockSource),
  ).toContain('## alpha **beta**')
  await page.evaluate(() => {
    const inner = (window as any).vditor.vditor
    inner.undo.undo(inner)
  })
  await expect.poll(() => getValue(page)).toBe(before)
})

test('a stale token and confirm-required target never mutate source or history', async ({
  page,
}) => {
  await openEditor(page)
  await chooseCaret(page, 'ir', 'beta')
  const options = await page.evaluate(() => (window as any).__blockOptions())
  const before = await getValue(page)
  expect(
    await page.evaluate(
      (token) => (window as any).__blockApply(token, { type: 'fence' }),
      options.token,
    ),
  ).toBe(false)
  expect(await getValue(page)).toBe(before)
  expect(
    await page.evaluate(() => (window as any).__postedBlockSource),
  ).toBeUndefined()

  const stale = await page.evaluate(() => (window as any).__blockOptions())
  await page.evaluate(() => (window as any).vditor.setValue('external edit\n'))
  expect(
    await page.evaluate(
      (token) => (window as any).__blockApply(token, { type: 'quote' }),
      stale.token,
    ),
  ).toBe(false)
  expect(await getValue(page)).toContain('external edit')
})

test('WYSIWYG and SV use the same source-derived paragraph transformation', async ({
  page,
}) => {
  await openEditor(page)
  await page.evaluate(() => {
    const toolbar = (window as any).vditor.vditor.toolbar
    toolbar.elements['edit-mode']?.children[0]?.dispatchEvent(
      new MouseEvent('click', { bubbles: true }),
    )
    document
      .querySelector<HTMLButtonElement>('button[data-mode="wysiwyg"]')
      ?.click()
  })
  await expect(page.locator('.vditor-wysiwyg')).toBeVisible()
  await chooseCaret(page, 'wysiwyg', 'beta')
  const wys = await page.evaluate(() => (window as any).__blockOptions())
  expect(wys?.currentType).toBe('paragraph')
  expect(
    await page.evaluate(
      (token) => (window as any).__blockApply(token, { type: 'quote' }),
      wys.token,
    ),
  ).toBe(true)
  await expect.poll(() => getValue(page)).toContain('> alpha **beta**')

  await page.evaluate(() => {
    const toolbar = (window as any).vditor.vditor.toolbar
    toolbar.elements['edit-mode']?.children[0]?.dispatchEvent(
      new MouseEvent('click', { bubbles: true }),
    )
    document.querySelector<HTMLButtonElement>('button[data-mode="sv"]')?.click()
    ;(window as any).vditor.setValue('before\n\nalpha **beta**\n\nafter\n')
  })
  await expect(page.locator('.vditor-sv')).toBeVisible()
  await chooseCaret(page, 'sv', 'beta')
  const sv = await page.evaluate(() => (window as any).__blockOptions())
  expect(sv?.currentType).toBe('paragraph')
  expect(
    await page.evaluate(
      (token) => (window as any).__blockApply(token, { type: 'bullet' }),
      sv.token,
    ),
  ).toBe(true)
  await expect.poll(() => getValue(page)).toContain('- alpha **beta**')
})

test('palette focus sentinel preserves the prior source-verified caret', async ({
  page,
}) => {
  await openEditor(page)
  await chooseCaret(page, 'ir', 'beta')
  await page.evaluate(() => {
    const root = (window as any).vditor.vditor.ir.element as HTMLElement
    const range = document.createRange()
    range.setStart(root, 0)
    range.collapse(true)
    const selection = getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))
  })
  const options = await page.evaluate(() => (window as any).__blockOptions())
  expect(options?.currentType).toBe('paragraph')
  expect(
    await page.evaluate(
      (token) => (window as any).__blockApply(token, { type: 'h2' }),
      options.token,
    ),
  ).toBe(true)
  await expect.poll(() => getValue(page)).toContain('## alpha **beta**')
})

test('paragraph to callout composes Task 527 source marker with one undo', async ({
  page,
}) => {
  await openEditor(page)
  await chooseCaret(page, 'ir', 'beta')
  const before = await getValue(page)
  const options = await page.evaluate(() => (window as any).__blockOptions())
  expect(
    options?.targets.find((item: any) => item.type === 'callout')?.status,
  ).toBe('changed')
  expect(
    await page.evaluate(
      (token) => (window as any).__blockApply(token, { type: 'callout' }),
      options.token,
    ),
  ).toBe(true)
  await expect
    .poll(() => getValue(page))
    .toContain('> [!NOTE]\n> alpha **beta**')
  expect(
    await page.evaluate(() => (window as any).__postedBlockSource),
  ).toContain('> [!NOTE]\n> alpha **beta**')
  await page.evaluate(() => {
    const inner = (window as any).vditor.vditor
    inner.undo.undo(inner)
  })
  await expect.poll(() => getValue(page)).toBe(before)
})
