import { expect, test } from './coverage-fixture'

const INITIAL = 'alpha\n\n```ts\nconst x = 1\n```\n\nomega\n'
const MOVED = '```ts\nconst x = 1\n```\n\nalpha\n\nomega\n'

async function open(page: import('@playwright/test').Page) {
  await page.goto('/block-handle.html')
  await page.waitForFunction(() => (window as any).__ready === true)
}

function value(page: import('@playwright/test').Page): Promise<string> {
  return page.evaluate(() => (window as any).vditor.getValue())
}

test('handle-originated drag moves a paragraph below a fence with one edit and undo', async ({ page }) => {
  await open(page)
  expect(await value(page)).toBe(INITIAL)
  const alpha = page.locator('.vditor-ir .vditor-reset > p').first()
  await alpha.hover()
  const handle = page.locator('.vmde-block-handle')
  await expect(handle).toBeVisible()
  const geometry = await page.evaluate(() => {
    const block = document.querySelector('.vditor-ir .vditor-reset > p')!
    const handle = document.querySelector('.vmde-block-handle')!
    return {
      blockLeft: block.getBoundingClientRect().left,
      handleRight: handle.getBoundingClientRect().right,
      insideEditable: Boolean(handle.closest('.vditor-reset')),
    }
  })
  expect(geometry.handleRight).toBeLessThanOrEqual(geometry.blockLeft - 38)
  expect(geometry.insideEditable).toBe(false)
  await page.evaluate(() => {
    const handle = document.querySelector('.vmde-block-handle')!
    const fence = document.querySelector('.vditor-ir [data-type="code-block"]')!
    const data = new DataTransfer()
    handle.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: data }))
    const rect = fence.getBoundingClientRect()
    fence.dispatchEvent(new DragEvent('dragover', {
      bubbles: true,
      cancelable: true,
      clientY: rect.bottom - 1,
      dataTransfer: data,
    }))
    if ((document.querySelector('.vmde-block-drop-indicator') as HTMLElement).hidden)
      throw new Error('drop indicator missing')
    fence.dispatchEvent(new DragEvent('drop', {
      bubbles: true,
      cancelable: true,
      clientY: rect.bottom - 1,
      dataTransfer: data,
    }))
  })
  await expect.poll(() => value(page)).toBe(MOVED)
  expect(await page.evaluate(() => (window as any).__blockHandlePosts)).toBe(1)
  await page.locator('.vditor-ir').click({ position: { x: 4, y: 4 } })
  await page.evaluate(() => {
    const inner = (window as any).vditor.vditor
    inner.undo.undo(inner)
  })
  await expect.poll(() => value(page)).toBe(INITIAL)
})

test('Alt+Down uses the same move and text/file drags remain independent', async ({ page }) => {
  await open(page)
  const alpha = page.locator('.vditor-ir .vditor-reset > p').first()
  await alpha.click()
  await alpha.evaluate((element) => {
    const text = element.firstChild!
    const range = document.createRange()
    range.setStart(text, 2)
    range.collapse(true)
    const selection = getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    element.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'ArrowDown', altKey: true, bubbles: true, cancelable: true,
    }))
  })
  await expect.poll(() => value(page)).toBe(MOVED)

  const fileResult = await page.evaluate(() => {
    const fence = document.querySelector('.vditor-ir [data-type="code-block"]')!
    const data = new DataTransfer()
    data.items.add(new File(['x'], 'x.png', { type: 'image/png' }))
    const rect = fence.getBoundingClientRect()
    const over = new DragEvent('dragover', { bubbles: true, cancelable: true, clientY: rect.top + 1, dataTransfer: data })
    fence.dispatchEvent(over)
    const indicator = !(document.querySelector('.vmde-block-drop-indicator') as HTMLElement).hidden
    const drop = new DragEvent('drop', { bubbles: true, cancelable: true, clientY: rect.top + 1, dataTransfer: data })
    fence.dispatchEvent(drop)
    return { overPrevented: over.defaultPrevented, dropPrevented: drop.defaultPrevented, indicator }
  })
  expect(fileResult).toEqual({ overPrevented: false, dropPrevented: true, indicator: true })
  expect(await page.evaluate(() => (window as any).__blockHandlePosts)).toBe(1)
})

test('handle click menu routes Turn Into, Duplicate and Delete by source identity', async ({ page }) => {
  await open(page)
  const alpha = page.locator('.vditor-ir .vditor-reset > p').first()
  await alpha.hover()
  await page.locator('.vmde-block-handle').click()
  await expect(page.locator('.vmde-block-handle-menu')).toBeVisible()
  await page.locator('.vmde-block-handle-menu [data-action="turnInto"]').click()
  expect(await page.evaluate(() => (window as any).__blockHandleTurnInto)).toBe(0)
  expect(await value(page)).toBe(INITIAL)

  await alpha.hover()
  await page.locator('.vmde-block-handle').click()
  await page.locator('.vmde-block-handle-menu [data-action="duplicate"]').click()
  await expect.poll(() => value(page)).toContain('alpha\n\nalpha\n\n```ts')
  expect(await page.evaluate(() => (window as any).__blockHandlePosts)).toBe(1)
})

test('stale internal handle drop is consumed without editor mutation', async ({ page }) => {
  await open(page)
  await page.locator('.vditor-ir .vditor-reset > p').first().hover()
  const outcome = await page.evaluate(() => {
    const handle = document.querySelector('.vmde-block-handle')!
    const data = new DataTransfer()
    handle.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: data }))
    ;(window as any).vditor.setValue('external edit\n')
    const target = document.querySelector('.vditor-ir .vditor-reset > p')!
    const over = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: data })
    target.dispatchEvent(over)
    const drop = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data })
    target.dispatchEvent(drop)
    return { overPrevented: over.defaultPrevented, dropPrevented: drop.defaultPrevented }
  })
  expect(outcome).toEqual({ overPrevented: true, dropPrevented: true })
  expect(await value(page)).toContain('external edit')
  expect(await page.evaluate(() => (window as any).__blockHandlePosts)).toBe(0)
})
