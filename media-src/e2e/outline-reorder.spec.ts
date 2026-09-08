import { expect, test } from './coverage-fixture'
import type { Page } from '@playwright/test'

async function gotoOutline(page: Page): Promise<void> {
  await page.goto('/outline.html')
  await page.waitForFunction(() => (window as any).__ready === true)
}

test('outline heading drag moves a rebuilt row after its same-level target', async ({
  page,
}) => {
  await gotoOutline(page)
  const before = await page.evaluate(() => (window as any).vditor.getValue())

  // Vditor replaces its outline rows on every edit. The new rows must stay draggable.
  await page.evaluate(() => {
    const editor = (window as any).vditor
    editor.setValue(`${editor.getValue()}\n\n## Rebuilt heading\n`)
  })
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document.querySelectorAll(
            '.vditor-outline li > span[data-target-id][draggable="true"]',
          ).length,
      ),
    )
    .toBeGreaterThan(0)

  const marker = await page.evaluate(() => {
    const rows = Array.from(
      document.querySelectorAll<HTMLElement>(
        '.vditor-outline li > span[data-target-id]',
      ),
    )
    const source = rows.find((row) =>
      row.textContent?.includes('Second heading'),
    )!
    const target = rows.find((row) =>
      row.textContent?.includes('Fourth heading'),
    )!
    const data = new DataTransfer()
    source.dispatchEvent(
      new DragEvent('dragstart', { bubbles: true, dataTransfer: data }),
    )
    const rect = target.getBoundingClientRect()
    target.dispatchEvent(
      new DragEvent('dragover', {
        bubbles: true,
        cancelable: true,
        clientY: rect.bottom - 1,
        dataTransfer: data,
      }),
    )
    ;(window as any).__outlineDragData = data
    return {
      marker: target.dataset.vmdeOutlineDrop,
      types: Array.from(data.types),
      sourceIndex: data.getData('application/x-vmde-outline'),
    }
  })
  expect(marker).toMatchObject({
    marker: 'after',
    types: ['application/x-vmde-outline'],
    sourceIndex: '1',
  })
  await page.evaluate(() => {
    const target = Array.from(
      document.querySelectorAll<HTMLElement>(
        '.vditor-outline li > span[data-target-id]',
      ),
    ).find((row) => row.textContent?.includes('Fourth heading'))!
    const data = (window as any).__outlineDragData as DataTransfer
    const rect = target.getBoundingClientRect()
    target.dispatchEvent(
      new DragEvent('drop', {
        bubbles: true,
        cancelable: true,
        clientY: rect.bottom - 1,
        dataTransfer: data,
      }),
    )
  })

  await expect
    .poll(() => page.evaluate(() => (window as any).__outlineReorderCount))
    .toBe(1)
  const after = await page.evaluate(() => (window as any).vditor.getValue())
  expect(after.indexOf('## Fourth heading')).toBeLessThan(
    after.indexOf('## Second heading'),
  )
  expect(after).not.toBe(before)
})
