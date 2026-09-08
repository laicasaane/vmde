import { expect, test } from './coverage-fixture'

const EDITOR = '{"webviewSection":"editor"}'

async function open(page: import('@playwright/test').Page) {
  await page.goto('/context-menu.html')
  await page.waitForFunction(() => (window as any).__contextMenu != null)
  await expect(
    page.locator('.wiki-link-chip[data-wiki-target="Home"]'),
  ).toBeVisible()
  await expect(page.locator('.vditor-ir img')).toBeVisible()
  await expect(
    page.locator('.vditor-ir__preview .language-mermaid'),
  ).toBeVisible()
}

test('stamps exact native-menu contexts across rendered editor regions without cancelling contextmenu', async ({
  page,
}) => {
  await open(page)
  const prose = page.locator('.vditor-ir .vditor-reset > p').first()
  const code = page.locator('.vditor-ir [data-type="code-block"] pre').first()
  const diagram = page.locator('.vditor-ir__preview .language-mermaid').first()
  const image = page.locator('.vditor-ir img').first()
  const wiki = page.locator('.wiki-link-chip[data-wiki-target="Home"]')

  await expect(page.locator('#app')).toHaveAttribute(
    'data-vscode-context',
    EDITOR,
  )
  await expect(prose).not.toHaveAttribute('data-vscode-context')
  await expect(code).toHaveAttribute(
    'data-vscode-context',
    '{"webviewSection":"code"}',
  )
  await expect(diagram).toHaveAttribute(
    'data-vscode-context',
    '{"webviewSection":"diagram","lang":"mermaid"}',
  )
  await expect(image).toHaveAttribute(
    'data-vscode-context',
    '{"webviewSection":"image"}',
  )
  await expect(wiki).toHaveAttribute(
    'data-vscode-context',
    '{"webviewSection":"wiki"}',
  )
  expect(
    await diagram.evaluate(async (element) => {
      const tile = document.createElement('img')
      tile.className = 'leaflet-tile'
      element.append(tile)
      await new Promise<void>((resolve) => queueMicrotask(() => resolve()))
      return tile.getAttribute('data-vscode-context')
    }),
  ).toBe('{"webviewSection":"diagram","lang":"mermaid"}')
  expect(
    await page.locator('body').evaluate(() => {
      const target = document.querySelector('.language-mermaid')!
      const event = new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
      })
      target.dispatchEvent(event)
      return event.defaultPrevented
    }),
  ).toBe(false)
})

test('restamps rebuilt Vditor DOM without changing source bytes', async ({
  page,
}) => {
  await open(page)
  const before = await page.evaluate(() =>
    (window as any).__contextMenu.editor.getValue(),
  )
  await page.evaluate(() => (window as any).__contextMenu.rebuild())
  await expect(
    page.locator('.vditor-ir__preview .language-mermaid'),
  ).toHaveAttribute(
    'data-vscode-context',
    '{"webviewSection":"diagram","lang":"mermaid"}',
  )
  expect(
    await page.evaluate(() => (window as any).__contextMenu.editor.getValue()),
  ).toBe(before)
})

test('keeps region contexts through IR, WYSIWYG, SV and Preview mode cycles without source changes', async ({
  page,
}) => {
  await open(page)
  const before = await page.evaluate(() =>
    (window as any).__contextMenu.editor.getValue(),
  )
  for (const mode of ['wysiwyg', 'sv', 'ir'] as const) {
    await page.evaluate(
      (next) => (window as any).__contextMenu.switchMode(next),
      mode,
    )
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as any).__contextMenu.editor.vditor.currentMode,
        ),
      )
      .toBe(mode)
    await expect(page.locator('#app')).toHaveAttribute(
      'data-vscode-context',
      EDITOR,
    )
  }
  await page.locator('[data-type="preview"]').click()
  await expect(page.locator('.vditor-preview')).toBeVisible()
  await expect(page.locator('#app')).toHaveAttribute(
    'data-vscode-context',
    EDITOR,
  )
  await expect(
    page.locator('.vditor-preview .language-mermaid'),
  ).toHaveAttribute(
    'data-vscode-context',
    '{"webviewSection":"diagram","lang":"mermaid"}',
  )
  expect(
    await page.evaluate(() => (window as any).__contextMenu.editor.getValue()),
  ).toBe(before)
})
