import { expect, test } from './coverage-fixture'

type Mode = 'ir' | 'wysiwyg' | 'sv'

async function open(
  page: import('@playwright/test').Page,
  mode: Mode,
  enabled: boolean,
) {
  await page.goto(
    `/github-color-literals.html?mode=${mode}&enabled=${enabled ? '1' : '0'}`,
  )
  await page.waitForFunction(() => (window as any).__ready === true)
}

async function source(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const editor = (window as any).vditor
    return {
      current: editor.getValue() as string,
      expected: (window as any).__source as string,
    }
  })
}

for (const mode of ['ir', 'wysiwyg', 'sv'] as const) {
  test(`${mode}: renders swatches on inline code without changing Markdown`, async ({
    page,
  }) => {
    await open(page, mode, true)

    if (mode === 'sv') {
      const sourceEditor = page.locator('.vditor-sv')
      const preview = page.locator('.vditor-preview .vditor-reset')
      await expect(
        sourceEditor.locator('.vmde-github-color-literal'),
      ).toHaveCount(0)
      await expect(sourceEditor).toContainText('`#0969DA`')
      await expect(
        preview.locator('code.vmde-github-color-literal'),
      ).toHaveCount(4)
      await expect(
        preview.locator(
          'pre:not(.vditor-reset) code.vmde-github-color-literal',
        ),
      ).toHaveCount(0)
    } else {
      const editor = page.locator(`.vditor-${mode}`)
      const inline = editor.locator('code.vmde-github-color-literal')
      await expect(inline).toHaveCount(3)
      await expect(
        editor.locator('pre:not(.vditor-reset) code.vmde-github-color-literal'),
      ).toHaveCount(0)
      const swatch = await inline
        .first()
        .evaluate((code) => getComputedStyle(code, '::before').backgroundColor)
      expect(swatch).toBe('rgb(9, 105, 218)')

      if (mode === 'ir') {
        await page
          .locator('.vditor-toolbar button[data-type="preview"]')
          .click()
        const preview = page.locator('.vditor-preview .vditor-reset')
        await expect(
          preview.locator('code.vmde-github-color-literal'),
        ).toHaveCount(4)
        await expect(
          preview.locator(
            'pre:not(.vditor-reset) code.vmde-github-color-literal',
          ),
        ).toHaveCount(0)
      }
    }

    const value = await source(page)
    expect(value.current.replace(/[\r\n]+$/u, '')).toBe(
      value.expected.replace(/[\r\n]+$/u, ''),
    )
  })
}

test('default-off baseline and live toggles preserve exact source text', async ({
  page,
}) => {
  await open(page, 'ir', false)
  const editor = page.locator('.vditor-ir')
  const code = editor.locator('code')
  await expect(editor.locator('.vmde-github-color-literal')).toHaveCount(0)

  await page.evaluate(() =>
    (window as any).__liveConfig.applyBodyOptions({
      githubColorLiterals: true,
    }),
  )
  await expect(editor.locator('code.vmde-github-color-literal')).toHaveCount(3)

  await page.evaluate(() =>
    (window as any).__liveConfig.applyBodyOptions({
      githubColorLiterals: false,
    }),
  )
  await expect(editor.locator('.vmde-github-color-literal')).toHaveCount(0)
  await expect(code.first()).toHaveText('#0969DA')

  const value = await source(page)
  expect(value.current.replace(/[\r\n]+$/u, '')).toBe(
    value.expected.replace(/[\r\n]+$/u, ''),
  )
})
