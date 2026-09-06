import { expect, test } from './coverage-fixture'

test.beforeEach(async ({ page }) => {
  await page.goto('/section-fold.html')
  await page.waitForFunction(() => (window as any).__ready === true)
  await page.waitForTimeout(200)
})

const view = (page: import('@playwright/test').Page) =>
  page.evaluate(() => (window as any).__foldView())
const value = (page: import('@playwright/test').Page) =>
  page.evaluate(() => (window as any).__getValue() as string)

const heading = (page: import('@playwright/test').Page, needle: string) =>
  page
    .locator(
      '.vditor-ir:visible .vditor-reset > :is(h1,h2,h3,h4,h5,h6), .vditor-wysiwyg:visible .vditor-reset > :is(h1,h2,h3,h4,h5,h6)',
    )
    .filter({ hasText: needle })
    .first()

const foldIconCenter = (
  target: import('@playwright/test').Locator,
): Promise<{ x: number; y: number }> =>
  target.evaluate((element) => {
    const box = element.getBoundingClientRect()
    const icon = getComputedStyle(element, '::after')
    return {
      x:
        box.left +
        Number.parseFloat(icon.left) +
        Number.parseFloat(icon.width) / 2,
      y:
        box.top +
        Number.parseFloat(icon.top) +
        Number.parseFloat(icon.height) / 2,
    }
  })

const foldIconBox = (target: import('@playwright/test').Locator) =>
  target.evaluate((element) => {
    const box = element.getBoundingClientRect()
    const icon = getComputedStyle(element, '::after')
    const left = box.left + Number.parseFloat(icon.left)
    const top = box.top + Number.parseFloat(icon.top)
    const width = Number.parseFloat(icon.width)
    const height = Number.parseFloat(icon.height)
    return {
      left,
      top,
      right: left + width,
      bottom: top + height,
      width,
      height,
      opacity: icon.opacity,
      fontSize: icon.fontSize,
      lineHeight: icon.lineHeight,
      display: icon.display,
      alignItems: icon.alignItems,
    }
  })

const headingTextStart = (
  target: import('@playwright/test').Locator,
): Promise<{ x: number; y: number }> =>
  target.evaluate((element) => {
    const text = Array.from(element.childNodes).find(
      (node) => node.nodeType === Node.TEXT_NODE && node.nodeValue?.trim(),
    )!
    const first = text.nodeValue!.search(/\S/)
    const range = document.createRange()
    range.setStart(text, first)
    range.setEnd(text, first + 1)
    const box = range.getBoundingClientRect()
    return { x: box.left - 1, y: box.top + box.height / 2 }
  })

test('gutter fold hides the heading subtree without changing Markdown', async ({
  page,
}) => {
  const before = await value(page)
  const target = heading(page, 'One')
  const center = await foldIconCenter(target)
  await page.mouse.click(center.x, center.y)
  await expect
    .poll(() => view(page))
    .toMatchObject({
      foldedHeadings: [{ text: expect.stringContaining('One'), count: '3' }],
    })
  const folded = await view(page)
  expect(folded.hiddenTexts).toEqual(
    expect.arrayContaining([
      'one body',
      expect.stringContaining('Child'),
      'child body',
    ]),
  )
  expect(await value(page)).toBe(before)
})

test('real heading pointer targets only the visible fold icon in IR and WYSIWYG', async ({
  page,
}) => {
  const before = await value(page)

  for (const mode of ['ir', 'wysiwyg'] as const) {
    if (mode === 'wysiwyg') {
      await page.evaluate(() => (window as any).__switchMode('wysiwyg'))
      await expect.poll(() => view(page)).toMatchObject({ mode })
    }
    const target = heading(page, 'One')
    await page.mouse.move(0, 0)
    await expect(target).toHaveCSS('position', 'relative')
    expect(await foldIconBox(target)).toMatchObject({
      width: 36,
      height: 24,
      opacity: '1',
      fontSize: '12px',
      lineHeight: '0px',
      display: 'flex',
      alignItems: 'flex-start',
    })
    expect(
      await target.evaluate((el) => getComputedStyle(el, '::after').content),
    ).toBe('"▼"')

    const textStart = await headingTextStart(target)
    await page.mouse.click(textStart.x, textStart.y)
    await expect.poll(() => view(page)).toMatchObject({ foldedHeadings: [] })
    expect(
      await target.evaluate((element) => {
        const selection = getSelection()
        return Boolean(
          selection?.isCollapsed &&
            selection.anchorNode &&
            element.contains(selection.anchorNode),
        )
      }),
    ).toBe(true)

    const markerCenter = await target.evaluate((element) => {
      const box = element.getBoundingClientRect()
      const marker = getComputedStyle(element, '::before')
      return {
        x:
          box.left +
          Number.parseFloat(marker.marginLeft) +
          (Number.parseFloat(marker.width) +
            Number.parseFloat(marker.paddingRight)) /
            2,
        y:
          box.top +
          Number.parseFloat(marker.top) +
          Number.parseFloat(marker.height) / 2,
      }
    })
    await page.mouse.click(markerCenter.x, markerCenter.y)
    await expect.poll(() => view(page)).toMatchObject({ foldedHeadings: [] })

    let icon = await foldIconBox(target)
    await page.mouse.click(icon.left + 2, icon.top + icon.height / 2)
    await expect
      .poll(() => view(page))
      .toMatchObject({
        foldedHeadings: [expect.objectContaining({ count: '3' })],
      })
    expect(
      await target.evaluate((el) => getComputedStyle(el, '::after').content),
    ).toBe('"▶"')
    await page.mouse.move(0, 0)
    expect(await foldIconBox(target)).toMatchObject({ opacity: '1' })

    icon = await foldIconBox(target)
    await page.mouse.click(icon.right + 0.5, icon.top + icon.height / 2)
    await expect
      .poll(() => view(page))
      .toMatchObject({
        foldedHeadings: [expect.objectContaining({ count: '3' })],
      })
    await page.mouse.click(icon.left + icon.width / 2, icon.top + 2)
    await expect.poll(() => view(page)).toMatchObject({ foldedHeadings: [] })
    expect(
      await target.evaluate((el) => getComputedStyle(el, '::after').content),
    ).toBe('"▼"')
  }

  expect(await value(page)).toBe(before)
})

test('all heading levels keep marker and fold-icon geometry separate without text drift', async ({
  page,
}) => {
  for (const mode of ['ir', 'wysiwyg'] as const) {
    if (mode === 'wysiwyg') {
      await page.evaluate(() => (window as any).__switchMode('wysiwyg'))
      await expect.poll(() => view(page)).toMatchObject({ mode })
    }
    const rows = await page
      .locator(
        `.vditor-${mode}:visible .vditor-reset > :is(h1,h2,h3,h4,h5,h6)[data-vmde-foldable]`,
      )
      .evaluateAll((headings) =>
        headings
          .filter((element) => element.textContent?.includes('Geometry H'))
          .map((element) => {
            const heading = element as HTMLElement
            const box = heading.getBoundingClientRect()
            const marker = getComputedStyle(heading, '::before')
            const icon = getComputedStyle(heading, '::after')
            const px = (value: string) => {
              const parsed = Number.parseFloat(value)
              return Number.isFinite(parsed) ? parsed : 0
            }
            const markerBox = {
              left: box.left + px(marker.marginLeft),
              top: box.top + px(marker.top),
              right:
                box.left +
                px(marker.marginLeft) +
                px(marker.width) +
                px(marker.paddingRight),
              bottom: box.top + px(marker.top) + px(marker.height),
            }
            const iconBox = {
              left: box.left + Number.parseFloat(icon.left),
              top: box.top + Number.parseFloat(icon.top),
              right:
                box.left +
                Number.parseFloat(icon.left) +
                Number.parseFloat(icon.width),
              bottom:
                box.top +
                Number.parseFloat(icon.top) +
                Number.parseFloat(icon.height),
              width: Number.parseFloat(icon.width),
              height: Number.parseFloat(icon.height),
            }
            const text = Array.from(heading.childNodes).find(
              (node) =>
                node.nodeType === Node.TEXT_NODE && node.nodeValue?.trim(),
            )!
            const first = text.nodeValue!.search(/\S/)
            const range = document.createRange()
            range.setStart(text, first)
            range.setEnd(text, first + 1)
            const nextText = heading.nextElementSibling?.firstChild
            const nextRange = nextText?.nodeValue?.trim()
              ? document.createRange()
              : undefined
            if (nextRange && nextText) {
              const nextFirst = nextText.nodeValue!.search(/\S/)
              nextRange.setStart(nextText, nextFirst)
              nextRange.setEnd(nextText, nextFirst + 1)
            }
            return {
              level: heading.tagName,
              markerBox,
              iconBox,
              textLeft: range.getBoundingClientRect().left,
              textTop: range.getBoundingClientRect().top,
              nextContentBox: nextRange
                ? {
                    left: nextRange.getBoundingClientRect().left,
                    top: nextRange.getBoundingClientRect().top,
                    right: nextRange.getBoundingClientRect().right,
                    bottom: nextRange.getBoundingClientRect().bottom,
                  }
                : undefined,
            }
          }),
      )
    expect(rows.map((row) => row.level)).toEqual([
      'H1',
      'H2',
      'H3',
      'H4',
      'H5',
      'H6',
    ])
    for (const row of rows) {
      expect(row.iconBox.width, `${mode} ${row.level} icon width`).toBe(36)
      expect(row.iconBox.height, `${mode} ${row.level} icon height`).toBe(24)
      expect(
        row.iconBox.top,
        `${mode} ${row.level} icon below marker`,
      ).toBeGreaterThan(row.markerBox.bottom)
      const intersects =
        row.iconBox.left < row.markerBox.right &&
        row.iconBox.right > row.markerBox.left &&
        row.iconBox.top < row.markerBox.bottom &&
        row.iconBox.bottom > row.markerBox.top
      expect(intersects, `${mode} ${row.level} marker/icon overlap`).toBe(false)
      expect(
        row.iconBox.right,
        `${mode} ${row.level} icon before text`,
      ).toBeLessThan(row.textLeft)
      const overlapsNextContent = row.nextContentBox
        ? row.iconBox.left < row.nextContentBox.right &&
          row.iconBox.right > row.nextContentBox.left &&
          row.iconBox.top < row.nextContentBox.bottom &&
          row.iconBox.bottom > row.nextContentBox.top
        : false
      expect(
        overlapsNextContent,
        `${mode} ${row.level} next-block content overlap`,
      ).toBe(false)

      const target = heading(page, row.level.replace('H', 'Geometry H'))
      const center = await foldIconCenter(target)
      await page.mouse.click(center.x, center.y)
      const foldedTextLeft = await target.evaluate((element) => {
        const text = Array.from(element.childNodes).find(
          (node) => node.nodeType === Node.TEXT_NODE && node.nodeValue?.trim(),
        )!
        const first = text.nodeValue!.search(/\S/)
        const range = document.createRange()
        range.setStart(text, first)
        range.setEnd(text, first + 1)
        return range.getBoundingClientRect().left
      })
      expect(foldedTextLeft, `${mode} ${row.level} text origin`).toBeCloseTo(
        row.textLeft,
        4,
      )
      const foldedCenter = await foldIconCenter(target)
      await page.mouse.click(foldedCenter.x, foldedCenter.y)
    }
  }
})

test('navigation and a retained selection auto-unfold hidden section content', async ({
  page,
}) => {
  await page.evaluate(() => (window as any).__toggleAt('One'))
  expect(
    await page.evaluate(() => (window as any).__ensureText('child body')),
  ).toBe(true)
  await expect.poll(() => view(page)).toMatchObject({ foldedHeadings: [] })

  await page.evaluate(() => (window as any).__toggleAt('One'))
  await page.evaluate(() => {
    const hidden = document.querySelector<HTMLElement>(
      '[data-vmde-fold-hidden]',
    )!
    const range = document.createRange()
    range.selectNodeContents(hidden)
    range.collapse(true)
    const selection = getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))
  })
  await expect.poll(() => view(page)).toMatchObject({ foldedHeadings: [] })
})

test('fold state reapplies across WYSIWYG mode switch and a Vditor respin', async ({
  page,
}) => {
  const before = await value(page)
  await page.evaluate(() => (window as any).__toggleAt('One'))
  await page.evaluate(() => (window as any).__switchMode('wysiwyg'))
  await expect
    .poll(() => view(page))
    .toMatchObject({
      mode: 'wysiwyg',
      foldedHeadings: [expect.objectContaining({ count: '3' })],
    })
  await page.evaluate(() => (window as any).__respin())
  await expect
    .poll(() => view(page))
    .toMatchObject({
      foldedHeadings: [expect.objectContaining({ count: '3' })],
    })
  expect(await value(page)).toBe(before)
})

test('nested list folding persists across list DOM replacement', async ({
  page,
}) => {
  const before = await value(page)
  await page.evaluate(() => (window as any).__toggleAt('parent'))
  await expect.poll(() => view(page)).toMatchObject({ foldedLists: 1 })
  expect((await view(page)).hiddenTexts.join(' ')).toContain('nested a')
  await page.evaluate(() => (window as any).__respin())
  await expect.poll(() => view(page)).toMatchObject({ foldedLists: 1 })
  expect(await value(page)).toBe(before)
})
