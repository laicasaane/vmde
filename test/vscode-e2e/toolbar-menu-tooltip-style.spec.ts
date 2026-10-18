import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import { reopenVmdeFixture } from './webview-helpers'

// More menu rows line up (icon column, label 8px after the icon) and the Split View row is named
// Split View; toolbar tooltips and More row hovers use VS Code's UI font size, not Vditor's 11px.

test('More rows line up in Split View and the Split View row is named Split View', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(180_000)
  const file = path.join(baseDir, 'more-row-alignment.md')
  writeFileSync(file, '# More rows\n\nDisposable menu fixture.\n')
  const frame = await reopenVmdeFixture(evaluateInVSCode, workbox, file)
  const toolbar = frame.locator('.vditor-toolbar')
  await expect(toolbar).toBeVisible({ timeout: 60_000 })
  // Split View shows the `both` row, which Vditor hides in the other modes.
  await toolbar.locator('[data-type="edit-mode"]').click()
  await toolbar.locator('button[data-mode="sv"]').click()
  await expect(frame.locator('.vditor-sv')).toBeVisible({ timeout: 20_000 })

  await toolbar.locator('.vmde-toolbar-more > [data-type="more"]').click()
  const panel = toolbar.locator('.vmde-toolbar-more > .vditor-hint')
  await expect(panel).toBeVisible()
  const rows = await panel.locator(':scope > *').evaluateAll((items) =>
    items
      .map((item) =>
        item.matches('[data-type]')
          ? (item as HTMLElement)
          : (item.querySelector(':scope > [data-type]') as HTMLElement | null),
      )
      .filter(
        (button): button is HTMLElement =>
          button !== null && button.getClientRects().length > 0,
      )
      .map((button) => {
        const icon = button.querySelector('svg')?.getBoundingClientRect()
        const label = button.querySelector('.vmde-menu-label')
        return {
          name: button.getAttribute('data-type'),
          display: getComputedStyle(button).display,
          iconLeft: icon ? Math.round(icon.left) : null,
          labelText: label?.textContent?.trim() ?? null,
          labelGap:
            label && icon
              ? Math.round(label.getBoundingClientRect().left - icon.right)
              : null,
        }
      }),
  )
  const names = rows.map((row) => row.name)
  expect(names).toContain('both')
  expect(rows.find((row) => row.name === 'both')?.labelText).toBe('Split View')
  const iconColumn = rows[0].iconLeft
  for (const row of rows) {
    expect(row.display, `${row.name} display`).toBe('flex')
    expect(row.iconLeft, `${row.name} icon column`).toBe(iconColumn)
    if (row.labelText !== null)
      expect(row.labelGap, `${row.name} label gap`).toBe(8)
  }
})

test('toolbar tooltips and More row hovers share one look and follow the tooltip font size', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(180_000)
  const file = path.join(baseDir, 'tooltip-size.md')
  writeFileSync(file, '# Tooltip\n\nDisposable tooltip fixture.\n')
  const frame = await reopenVmdeFixture(evaluateInVSCode, workbox, file)
  const toolbar = frame.locator('.vditor-toolbar')
  await expect(toolbar).toBeVisible({ timeout: 60_000 })
  const undo = toolbar.locator('[data-type="undo"]')
  await undo.hover()
  await expect
    .poll(() =>
      undo.evaluate((button) => getComputedStyle(button, '::after').content),
    )
    .toBe('"Undo the last change"')
  const uiSize = await frame
    .locator('html')
    .evaluate((root) =>
      getComputedStyle(root).getPropertyValue('--vscode-font-size').trim(),
    )
  // Every metric the two tooltips must share (the Owner keeps the toolbar tooltip's look and only
  // lets its font size change).
  const METRICS = [
    'fontSize',
    'fontFamily',
    'lineHeight',
    'paddingTop',
    'paddingRight',
    'paddingBottom',
    'paddingLeft',
    'borderTopLeftRadius',
    'backgroundColor',
    'color',
  ] as const
  const controlStyle = () =>
    undo.evaluate((button, names) => {
      const style = getComputedStyle(button, '::after')
      return Object.fromEntries(
        names.map((name) => [name, style[name as 'fontSize']]),
      )
    }, METRICS)

  // VS Code sets --vscode-font-size on the webview (13px by default); the tooltip follows it.
  const control = await controlStyle()
  expect(uiSize).toMatch(/px$/)
  expect(control.fontSize).toBe(uiSize)
  expect(Number.parseFloat(control.fontSize)).toBeGreaterThanOrEqual(12)

  // A More row (Settings is always there) shows the VMDE hover box with the same look.
  await toolbar.locator('.vmde-toolbar-more > [data-type="more"]').click()
  const row = toolbar.locator(
    '.vmde-toolbar-more > .vditor-hint [data-type="settings"]',
  )
  await expect(row).toBeVisible()
  const hover = frame.locator('body > .vmde-row-hover')
  const rowHoverStyle = async () => {
    await row.hover()
    await expect(hover).toBeVisible()
    return hover.evaluate((box, names) => {
      const style = getComputedStyle(box)
      return Object.fromEntries(
        names.map((name) => [name, style[name as 'fontSize']]),
      )
    }, METRICS)
  }
  await undo.hover()
  expect(await controlStyle()).toEqual(control)
  expect(await rowHoverStyle()).toEqual(control)

  // vmde.editor.tooltipFontSize sets a fixed size live for both; clearing it follows VS Code again.
  const setSize = (value: number | undefined) =>
    evaluateInVSCode(
      async (vscode: typeof import('vscode'), next: number | undefined) => {
        await vscode.workspace
          .getConfiguration('vmde.editor')
          .update('tooltipFontSize', next, vscode.ConfigurationTarget.Global)
      },
      value,
    )
  const sizes = async () => {
    await undo.hover()
    const controlSize = (await controlStyle()).fontSize
    return { control: controlSize, row: (await rowHoverStyle()).fontSize }
  }
  try {
    await setSize(18)
    await expect
      .poll(sizes, { timeout: 30_000 })
      .toEqual({ control: '18px', row: '18px' })
  } finally {
    await setSize(undefined)
  }
  await expect
    .poll(sizes, { timeout: 30_000 })
    .toEqual({ control: uiSize, row: uiSize })
})
