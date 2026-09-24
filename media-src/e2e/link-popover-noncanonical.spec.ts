import { expect, test } from './coverage-fixture'

test('characterize exact host Markdown versus Vditor IR serialization around links', async ({
  page,
}) => {
  await page.addInitScript(() => {
    ;(window as any).acquireVsCodeApi = () => ({
      postMessage: () => undefined,
      getState: () => undefined,
      setState: () => undefined,
    })
  })
  await page.goto('/link.html?mode=ir&policy=modifier')
  await page.waitForFunction(() => (window as any).__ready === true)
  const exact = `${[
    '# Heading',
    '',
    'Before [A long label](https://example.com/a "kept title") after.',
    '',
    '|  left  | right |',
    '| :--- | ---: |',
    '| x | y |',
    '',
    '```js',
    'const x = 1',
    '```',
  ].join('\r\n')}\r\n`
  await page.evaluate(
    (markdown) => (window as any).vditor.setValue(markdown),
    exact,
  )
  await expect(page.locator('.vditor-ir [data-type="a"]')).toHaveCount(1)
  const rendered = await page.evaluate(() => (window as any).vditor.getValue())
  const mapped = await page.evaluate(
    ({ exact, rendered }) => {
      const marker = document.querySelector<HTMLElement>(
        '.vditor-ir [data-type="a"] > .vditor-ir__marker--link',
      )!
      const range = document.createRange()
      range.selectNodeContents(marker)
      return {
        exact: (window as any).__captureRewrapSourceRange(range, exact),
        rendered: (window as any).__captureRewrapSourceRange(range, rendered),
      }
    },
    { exact, rendered },
  )
  expect(rendered).not.toBe(exact)
  expect(mapped.exact).toBeNull()
  expect(mapped.rendered).toMatchObject({ markdown: rendered })
  await page.evaluate((source) => {
    ;(window as any).__linkExactSource = source
  }, exact)
  await page.locator('.vditor-ir [data-type="a"] .vditor-ir__link').click()
  const popover = page.locator('.vmde-link-popover')
  await expect(popover).toBeVisible()
  await expect(popover.getByRole('button', { name: 'Edit URL' })).toBeEnabled()
  await expect(popover.getByRole('button', { name: 'Unlink' })).toBeEnabled()
  expect(await page.evaluate(() => (window as any).vditor.getValue())).toBe(
    rendered,
  )
  await popover.getByRole('button', { name: 'Edit URL' }).click()
  await popover
    .getByRole('textbox', { name: 'URL' })
    .fill('https://changed.example/path')
  await popover.getByRole('button', { name: 'Save' }).click()
  const expectedExact = exact.replace(
    'https://example.com/a',
    'https://changed.example/path',
  )
  const expectedRendered = rendered.replace(
    'https://example.com/a',
    'https://changed.example/path',
  )
  expect(await page.evaluate(() => (window as any).__postedLinkExact)).toBe(
    expectedExact,
  )
  await expect
    .poll(() => page.evaluate(() => (window as any).vditor.getValue()))
    .toBe(expectedRendered)
  await page.evaluate(() => {
    const inner = (window as any).vditor.vditor
    inner.undo.undo(inner)
  })
  await expect
    .poll(() => page.evaluate(() => (window as any).vditor.getValue()))
    .toBe(rendered)
  await page.evaluate(() => {
    const inner = (window as any).vditor.vditor
    inner.undo.redo(inner)
  })
  await expect
    .poll(() => page.evaluate(() => (window as any).vditor.getValue()))
    .toBe(expectedRendered)
  await page.locator('.vditor-ir [data-type="a"] .vditor-ir__link').click()
  await expect(popover).toBeVisible()
  await popover.getByRole('button', { name: 'Unlink' }).click()
  const unlinkedExact = exact.replace(
    '[A long label](https://example.com/a "kept title")',
    'A long label',
  )
  const unlinkedRendered = rendered.replace(
    '[A long label](https://example.com/a "kept title")',
    'A long label',
  )
  expect(await page.evaluate(() => (window as any).__postedLinkExact)).toBe(
    unlinkedExact,
  )
  await expect
    .poll(() => page.evaluate(() => (window as any).vditor.getValue()))
    .toBe(unlinkedRendered)
  await page.evaluate(() => {
    const inner = (window as any).vditor.vditor
    inner.undo.undo(inner)
  })
  await expect
    .poll(() => page.evaluate(() => (window as any).vditor.getValue()))
    .toBe(expectedRendered)
})
