import { expect, test } from './coverage-fixture'

const SOURCE =
  '| Long heading | Other heading |\n| --- | --- |\n| alpha | beta |\n'

test('header-border drag changes a column width without changing Markdown', async ({
  page,
}) => {
  await page.goto('/')
  await page.waitForFunction(() => (window as any).__ready === true)
  await page.evaluate(
    (source) => (window as any).vditor.setValue(source),
    SOURCE,
  )
  const table = page.locator('.vditor-ir table').first()
  const before = await page.evaluate(() => (window as any).vditor.getValue())
  const first = table.locator('th').first()
  const initialWidth = (await first.boundingBox())!.width
  const handle = page.locator('.vmde-table-resize-handle').first()
  await expect(handle).toBeVisible()
  const box = (await handle.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 + 80, box.y + box.height / 2)
  await page.mouse.up()

  await expect
    .poll(async () => (await first.boundingBox())!.width)
    .toBeGreaterThan(initialWidth + 40)
  expect(await page.evaluate(() => (window as any).vditor.getValue())).toBe(
    before,
  )
  await page.locator('.vditor-ir td').first().click()
  await expect(
    page.locator('#fix-table-ir-wrapper .vditor-panel'),
  ).toBeVisible()
})

test('a narrow table clamps its drag and double-click auto-fits without source edits', async ({
  page,
}) => {
  await page.setViewportSize({ width: 420, height: 480 })
  await page.goto('/')
  await page.waitForFunction(() => (window as any).__ready === true)
  await page.evaluate(
    (source) => (window as any).vditor.setValue(source),
    SOURCE,
  )
  const before = await page.evaluate(() => (window as any).vditor.getValue())
  const handle = page.locator('.vmde-table-resize-handle').first()
  const box = (await handle.boundingBox())!
  await page.mouse.move(box.x + 4, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x - 300, box.y + box.height / 2)
  await page.mouse.up()
  await expect(handle).toHaveAttribute('aria-valuenow', '48')

  await handle.dblclick()
  await expect
    .poll(async () => Number(await handle.getAttribute('aria-valuenow')))
    .toBeGreaterThan(48)
  const expanded = (await handle.boundingBox())!
  await page.mouse.move(expanded.x + 4, expanded.y + expanded.height / 2)
  await page.mouse.down()
  await page.mouse.move(expanded.x + 304, expanded.y + expanded.height / 2)
  await page.mouse.up()
  const table = page.locator('.vditor-ir table').first()
  const overflow = await table.evaluate((element) => {
    const parent = element.parentElement!
    return {
      excess: parent.scrollWidth - parent.clientWidth,
      overflowX: getComputedStyle(parent).overflowX,
    }
  })
  expect(overflow.overflowX).toBe('auto')
  expect(overflow.excess).toBeGreaterThan(100)
  expect(await page.evaluate(() => (window as any).vditor.getValue())).toBe(
    before,
  )
})

test('WYSIWYG header resizing leaves Markdown and the native table panel usable', async ({
  page,
}) => {
  await page.goto('/')
  await page.waitForFunction(() => (window as any).__ready === true)
  await page.evaluate(
    (source) => (window as any).vditor.setValue(source),
    SOURCE,
  )
  await page.evaluate(() => {
    const toolbar = (window as any).vditor.vditor.toolbar
    toolbar.elements['edit-mode']?.children[0]?.dispatchEvent(
      new MouseEvent('click', { bubbles: true }),
    )
    document
      .querySelector('button[data-mode="wysiwyg"]')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  const header = page.locator('.vditor-wysiwyg table th').first()
  await expect(header).toBeVisible()
  const before = await page.evaluate(() => (window as any).vditor.getValue())
  const initialWidth = (await header.boundingBox())!.width
  const handle = page.locator('.vmde-table-resize-handle').first()
  await expect(handle).toBeVisible()
  const box = (await handle.boundingBox())!
  await page.mouse.move(box.x + 4, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + 124, box.y + box.height / 2)
  await page.mouse.up()
  await expect
    .poll(async () => (await header.boundingBox())!.width)
    .toBeGreaterThan(initialWidth + 40)
  expect(await page.evaluate(() => (window as any).vditor.getValue())).toBe(
    before,
  )
  await page.locator('.vditor-wysiwyg td').first().click()
  await expect(
    page.locator(
      '.vditor-wysiwyg > .vditor-panel:has(button[data-type="insertColumn"])',
    ),
  ).toBeVisible()
})

test('raw HTML tables do not expose editable column handles', async ({
  page,
}) => {
  await page.goto('/')
  await page.waitForFunction(() => (window as any).__ready === true)
  await page.evaluate(() =>
    (window as any).vditor.setValue(
      '<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>one</td><td>two</td></tr></tbody></table>\n',
    ),
  )
  await expect(page.locator('.vmde-table-resize-handle')).toHaveCount(0)
  await page.evaluate(() => {
    const toolbar = (window as any).vditor.vditor.toolbar
    toolbar.elements['edit-mode']?.children[0]?.dispatchEvent(
      new MouseEvent('click', { bubbles: true }),
    )
    document
      .querySelector('button[data-mode="wysiwyg"]')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await expect(page.locator('.vmde-table-resize-handle')).toHaveCount(0)
})

test('IR table panel remains reachable beside the active cell at the narrow left edge', async ({
  page,
}) => {
  await page.setViewportSize({ width: 520, height: 800 })
  await page.goto('/')
  await page.waitForFunction(() => (window as any).__ready === true)
  const before = await page.evaluate(() => (window as any).vditor.getValue())
  await page.locator('.vditor-ir table td').first().click()
  const panel = page.locator('#fix-table-ir-wrapper .vditor-panel')
  await expect(panel).toBeVisible()
  const geometry = await page.evaluate(() => {
    const panel = document
      .querySelector('#fix-table-ir-wrapper .vditor-panel')!
      .getBoundingClientRect()
    const cell = document
      .querySelector('.vditor-ir table td')!
      .getBoundingClientRect()
    const toolbar = document
      .querySelector('.vditor-toolbar')!
      .getBoundingClientRect()
    return {
      panel: {
        left: panel.left,
        right: panel.right,
        top: panel.top,
        bottom: panel.bottom,
      },
      cell: { top: cell.top, bottom: cell.bottom },
      toolbarBottom: toolbar.bottom,
      width: innerWidth,
    }
  })
  expect(geometry.panel.left).toBeGreaterThanOrEqual(8)
  expect(geometry.panel.right).toBeLessThanOrEqual(geometry.width - 8)
  expect(geometry.panel.top).toBeGreaterThanOrEqual(geometry.toolbarBottom + 8)
  expect(
    geometry.panel.bottom <= geometry.cell.top ||
      geometry.panel.top >= geometry.cell.bottom,
  ).toBe(true)
  expect(await page.evaluate(() => (window as any).vditor.getValue())).toBe(
    before,
  )
})
