import path from 'node:path'
import { readFileSync } from 'node:fs'
import { expect, test } from './coverage-fixture'

const SOURCE =
  '| Long heading | Other heading |\n| --- | --- |\n| alpha | beta |\n'
const LARGE_TABLE_FIXTURE = readFileSync(
  path.join(
    __dirname,
    '../../test/vscode-e2e/fixtures/large-observable-models-synthetic.md',
  ),
  'utf8',
)

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

test('large synthetic scroll reads only visible table headers and keeps handles aligned', async ({
  page,
}) => {
  test.setTimeout(90_000)
  await page.goto('/')
  await page.waitForFunction(() => (window as any).__ready === true)
  await page.evaluate(
    (source) => (window as any).vditor.setValue(source),
    LARGE_TABLE_FIXTURE,
  )
  await page.waitForFunction(() => {
    const editor = (window as any).vditor
    return (
      editor?.getCurrentMode() === 'ir' &&
      editor.vditor.ir.element.querySelectorAll('table').length === 11
    )
  })
  const sourceBefore = await page.evaluate(
    () => (window as any).vditor.getValue() as string,
  )

  const scrollInfo = await page.evaluate(() => {
    const root = (window as any).vditor.vditor.ir.element as HTMLElement
    let scroller: HTMLElement | null = root
    while (scroller && scroller !== document.body) {
      const overflowY = getComputedStyle(scroller).overflowY
      if (
        ['auto', 'scroll', 'overlay'].includes(overflowY) &&
        scroller.scrollHeight > scroller.clientHeight + 1
      )
        break
      scroller = scroller.parentElement
    }
    scroller ??= document.scrollingElement as HTMLElement
    ;(window as any).__task573TableResizeRoot = root
    ;(window as any).__task573TableResizeScroller = scroller
    return {
      scrollerTag: scroller.tagName,
      scrollerClass: scroller.className,
      scrollerClientHeight: scroller.clientHeight,
      scrollerScrollHeight: scroller.scrollHeight,
      tableCount: root.querySelectorAll('table').length,
      headerCount: root.querySelectorAll('table th').length,
    }
  })
  const gapTop = await page.evaluate(async () => {
    const root = (window as any).__task573TableResizeRoot as HTMLElement
    const scroller = (window as any).__task573TableResizeScroller as HTMLElement
    const headers = Array.from(root.querySelectorAll<HTMLElement>('table th'))
    const clip = () => {
      if (scroller === document.scrollingElement)
        return { left: 0, right: innerWidth, top: 0, bottom: innerHeight }
      const rect = scroller.getBoundingClientRect()
      const left = rect.left + scroller.clientLeft
      const top = rect.top + scroller.clientTop
      return {
        left,
        right: left + scroller.clientWidth,
        top,
        bottom: top + scroller.clientHeight,
      }
    }
    const frame = () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      )
    const stride = Math.max(80, Math.floor(scroller.clientHeight / 3))
    const maximum = Math.max(0, scroller.scrollHeight - scroller.clientHeight)
    for (let top = stride; top < maximum; top += stride) {
      scroller.scrollTop = top
      await frame()
      const bounds = clip()
      const hasVisibleHeader = headers.some((header) => {
        const rect = header.getBoundingClientRect()
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          rect.bottom > bounds.top &&
          rect.top < bounds.bottom &&
          rect.right > bounds.left &&
          rect.left < bounds.right
        )
      })
      if (!hasVisibleHeader) return top
    }
    return -1
  })
  const offscreenHeaderReads = await page.evaluate(async () => {
    const scroller = (window as any).__task573TableResizeScroller as HTMLElement
    let reads = 0
    const original = HTMLElement.prototype.getBoundingClientRect
    Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
      configurable: true,
      writable: true,
      value: function (this: HTMLElement) {
        if (this.tagName === 'TH' && this.closest('.vditor-reset table'))
          reads++
        return original.call(this)
      },
    })
    scroller.dispatchEvent(new Event('scroll', { bubbles: true }))
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    )
    Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
      configurable: true,
      writable: true,
      value: original,
    })
    return reads
  })
  const visibleHeadersAfter = await page.evaluate(() => {
    const root = (window as any).__task573TableResizeRoot as HTMLElement
    const scroller = (window as any).__task573TableResizeScroller as HTMLElement
    const bounds =
      scroller === document.scrollingElement
        ? { left: 0, right: innerWidth, top: 0, bottom: innerHeight }
        : (() => {
            const rect = scroller.getBoundingClientRect()
            const left = rect.left + scroller.clientLeft
            const top = rect.top + scroller.clientTop
            return {
              left,
              right: left + scroller.clientWidth,
              top,
              bottom: top + scroller.clientHeight,
            }
          })()
    return Array.from(root.querySelectorAll<HTMLElement>('table th')).filter(
      (header) => {
        const rect = header.getBoundingClientRect()
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          rect.bottom > bounds.top &&
          rect.top < bounds.bottom &&
          rect.right > bounds.left &&
          rect.left < bounds.right
        )
      },
    ).length
  })
  await page.evaluate(async () => {
    const scroller = (window as any).__task573TableResizeScroller as HTMLElement
    scroller.scrollTop = 0
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    )
  })
  const sample = {
    ...scrollInfo,
    gapTop,
    offscreenHeaderReads,
    visibleHeadersAfter,
  }

  expect(sample.tableCount).toBe(11)
  expect(sample.headerCount).toBe(27)
  expect(sample.scrollerScrollHeight).toBeGreaterThan(
    sample.scrollerClientHeight,
  )
  expect(sample.gapTop).toBeGreaterThan(0)
  expect(sample.offscreenHeaderReads).toBe(0)
  expect(sample.visibleHeadersAfter).toBe(0)

  const eligibleTableIndices = await page.locator('body').evaluate(() => {
    const root = (window as any).__task573TableResizeRoot as HTMLElement
    const tables = Array.from(root.querySelectorAll<HTMLTableElement>('table'))
    const isEligible = (table: HTMLTableElement): boolean => {
      const row = table.rows[0]
      if (!row?.cells.length) return false
      if (Array.from(row.cells).some((cell) => cell.tagName !== 'TH'))
        return false
      if (table.querySelector('table,[colspan],[rowspan]')) return false
      if (
        table.closest(
          '.vditor-ir__preview, .vditor-wysiwyg__preview, [data-type="html-block"], li, blockquote',
        )
      )
        return false
      return Array.from(table.rows).every(
        (candidate) => candidate.cells.length === row.cells.length,
      )
    }
    return tables.flatMap((table, index) => (isEligible(table) ? [index] : []))
  })
  const header = page.locator('.vditor-ir table th').first()
  const firstHandle = page.locator('.vmde-table-resize-handle:visible').first()
  await expect(firstHandle).toBeVisible()
  const firstGeometryError = await page.evaluate(() => {
    const header = document.querySelector<HTMLElement>('.vditor-ir table th')!
    const handle = Array.from(
      document.querySelectorAll<HTMLElement>('.vmde-table-resize-handle'),
    ).find((element) => getComputedStyle(element).display !== 'none')!
    const headerRect = header.getBoundingClientRect()
    const handleRect = handle.getBoundingClientRect()
    return Math.abs(headerRect.right - (handleRect.left + handleRect.width / 2))
  })
  await expect(header).toBeVisible()
  expect(firstGeometryError).toBeLessThan(3)

  const widthBeforeKeyboard = Number(
    await firstHandle.getAttribute('aria-valuenow'),
  )
  await firstHandle.focus()
  await firstHandle.press('ArrowRight')
  await expect(firstHandle).toHaveAttribute(
    'aria-valuenow',
    String(widthBeforeKeyboard + 10),
  )
  expect(
    (await page.evaluate(() => (window as any).vditor.getValue())) ===
      sourceBefore,
    'keyboard resizing must keep Markdown unchanged',
  ).toBe(true)

  const scroller = page.locator('body')
  await scroller.evaluate((_body, top) => {
    ;(window as any).__task573TableResizeScroller.scrollTop = top
  }, sample.gapTop)
  await expect(page.locator('.vmde-table-resize-handle:visible')).toHaveCount(0)

  const distantIndex = eligibleTableIndices.at(-1)
  expect(distantIndex).toBeDefined()
  const distantTable = page.locator('.vditor-ir table').nth(distantIndex!)
  const distantHeader = distantTable.locator('th').first()
  await distantHeader.scrollIntoViewIfNeeded()
  await expect(distantHeader).toBeVisible()
  await expect(
    page.locator('.vmde-table-resize-handle:visible').first(),
  ).toBeVisible()
  const distantGeometry = await distantTable.evaluate((table) => {
    const right = (
      table.querySelector('th') as HTMLElement
    ).getBoundingClientRect().right
    const handles = Array.from(
      document.querySelectorAll<HTMLElement>('.vmde-table-resize-handle'),
    )
    let handleIndex = -1
    let alignmentError = Number.POSITIVE_INFINITY
    handles.forEach((handle, index) => {
      if (getComputedStyle(handle).display === 'none') return
      const rect = handle.getBoundingClientRect()
      const error = Math.abs(right - (rect.left + rect.width / 2))
      if (error < alignmentError) {
        alignmentError = error
        handleIndex = index
      }
    })
    return { handleIndex, alignmentError }
  })
  expect(distantGeometry.handleIndex).toBeGreaterThanOrEqual(0)
  expect(distantGeometry.alignmentError).toBeLessThan(3)
  const distantHandle = page
    .locator('.vmde-table-resize-handle')
    .nth(distantGeometry.handleIndex)
  const widthBeforeDrag = Number(
    await distantHandle.getAttribute('aria-valuenow'),
  )
  const distantBox = (await distantHandle.boundingBox())!
  const startX = distantBox.x + distantBox.width / 2
  const centerY = distantBox.y + distantBox.height / 2
  await page.mouse.move(startX, centerY)
  await page.mouse.down()
  await page.mouse.move(startX + 60, centerY)
  await page.mouse.up()
  await expect
    .poll(async () => Number(await distantHandle.getAttribute('aria-valuenow')))
    .toBeGreaterThan(widthBeforeDrag + 20)
  const widthAfterDrag = Number(
    await distantHandle.getAttribute('aria-valuenow'),
  )
  await distantHandle.focus()
  await distantHandle.press('ArrowLeft')
  await expect(distantHandle).toHaveAttribute(
    'aria-valuenow',
    String(widthAfterDrag - 10),
  )
  expect(
    (await page.evaluate(() => (window as any).vditor.getValue())) ===
      sourceBefore,
  ).toBe(true)
  await scroller.evaluate((_body, top) => {
    ;(window as any).__task573TableResizeScroller.scrollTop = top
  }, sample.gapTop)
  await expect(page.locator('.vmde-table-resize-handle:visible')).toHaveCount(0)

  await page.locator('body').evaluate(() => {
    ;(window as any).__task573TableResizeScroller.scrollTop = 0
  })
  const preview = page.locator('.vditor-preview').first()
  await page.locator('body').evaluate(() => {
    document
      .querySelector<HTMLButtonElement>('.vditor-toolbar [data-type="preview"]')
      ?.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true }),
      )
  })
  await expect(preview).toBeVisible()
  await expect
    .poll(() => page.locator('.vditor-preview table').count(), {
      timeout: 15_000,
      message: 'large document table appears in Preview',
    })
    .toBeGreaterThan(0)
  const previewState = await page.evaluate(() => ({
    mode: (window as any).vditor.getCurrentMode() as string,
    previewTables: document.querySelectorAll('.vditor-preview table').length,
    previewHandles: document.querySelectorAll(
      '.vditor-preview .vmde-table-resize-handle',
    ).length,
  }))
  expect(previewState.mode).toBe('ir')
  expect(previewState.previewTables).toBeGreaterThan(0)
  expect(previewState.previewHandles).toBe(0)
  expect(
    (await page.evaluate(() => (window as any).vditor.getValue())) ===
      sourceBefore,
    'Preview visibility must keep Markdown unchanged',
  ).toBe(true)
  await page.locator('body').evaluate(() => {
    document
      .querySelector<HTMLButtonElement>('.vditor-toolbar [data-type="preview"]')
      ?.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true }),
      )
  })
  await expect(preview).toBeHidden()
  const returnedHandle = page
    .locator('.vmde-table-resize-handle:visible')
    .first()
  await expect(returnedHandle).toBeVisible()
  expect(
    (await page.evaluate(() => (window as any).vditor.getValue())) ===
      sourceBefore,
  ).toBe(true)

  await page.locator('body').evaluate(() => {
    const toolbar = (window as any).vditor.vditor.toolbar
    toolbar.elements['edit-mode']?.children[0]?.dispatchEvent(
      new MouseEvent('click', { bubbles: true }),
    )
    document
      .querySelector('button[data-mode="sv"]')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await page.waitForFunction(
    () => (window as any).vditor.getCurrentMode() === 'sv',
  )
  await expect(page.locator('.vmde-table-resize-handle')).toHaveCount(0)
  await page.locator('body').evaluate(() => {
    const toolbar = (window as any).vditor.vditor.toolbar
    toolbar.elements['edit-mode']?.children[0]?.dispatchEvent(
      new MouseEvent('click', { bubbles: true }),
    )
    document
      .querySelector('button[data-mode="ir"]')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await page.waitForFunction(
    () => (window as any).vditor.getCurrentMode() === 'ir',
  )
  await expect(
    page.locator('.vmde-table-resize-handle:visible').first(),
  ).toBeVisible()
})
