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
      boxSizing: icon.boxSizing,
      paddingTop: Number.parseFloat(icon.paddingTop),
    }
  })

const headingGutterBox = (target: import('@playwright/test').Locator) =>
  target.evaluate((element) => {
    const px = (value: string) => Number.parseFloat(value)
    const heading = element.getBoundingClientRect()
    const headingStyle = getComputedStyle(element)
    const marker = getComputedStyle(element, '::before')
    const arrow = getComputedStyle(element, '::after')
    const contentLeft =
      heading.left +
      px(headingStyle.borderLeftWidth) +
      px(headingStyle.paddingLeft)
    const contentTop =
      heading.top +
      px(headingStyle.borderTopWidth) +
      px(headingStyle.paddingTop)
    const markerTop =
      contentTop +
      px(marker.marginTop) +
      (marker.position === 'relative' ? px(marker.top) || 0 : 0)
    const markerBox = {
      left: contentLeft + px(marker.marginLeft),
      top: markerTop,
      right:
        contentLeft +
        px(marker.marginLeft) +
        px(marker.width) +
        px(marker.paddingLeft) +
        px(marker.paddingRight) +
        px(marker.borderLeftWidth) +
        px(marker.borderRightWidth),
      bottom:
        markerTop +
        px(marker.height) +
        px(marker.paddingTop) +
        px(marker.paddingBottom) +
        px(marker.borderTopWidth) +
        px(marker.borderBottomWidth),
    }
    const arrowBox = {
      left: heading.left + px(arrow.left),
      top: heading.top + px(arrow.top),
      right: heading.left + px(arrow.left) + px(arrow.width),
      bottom: heading.top + px(arrow.top) + px(arrow.height),
    }
    const paintedArrow = {
      left: arrowBox.left,
      top:
        heading.top +
        px(arrow.getPropertyValue('--vmde-heading-fold-arrow-top')),
      right: arrowBox.right,
      bottom:
        heading.top +
        px(arrow.getPropertyValue('--vmde-heading-fold-arrow-top')) +
        24,
    }
    return {
      paintedArrow,
      marker: markerBox,
      target: arrowBox,
      glyphOffset:
        heading.top +
        px(arrow.top) +
        px(arrow.paddingTop) -
        (heading.top +
          px(
            getComputedStyle(element).getPropertyValue(
              '--vmde-heading-fold-arrow-top',
            ),
          )),
      union: {
        left: Math.min(markerBox.left, arrowBox.left),
        top: Math.min(markerBox.top, paintedArrow.top),
        right: Math.max(markerBox.right, arrowBox.right),
        bottom: Math.max(markerBox.bottom, paintedArrow.bottom),
      },
    }
  })

const persistCount = (page: import('@playwright/test').Page) =>
  page.evaluate(() => (window as any).__foldPersistCount())

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

test('real heading marker, gap, and arrow form one trusted target in IR and WYSIWYG', async ({
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
      opacity: '1',
      fontSize: '12px',
      lineHeight: '0px',
      display: 'flex',
      alignItems: 'flex-start',
      boxSizing: 'border-box',
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

    let gutter = await headingGutterBox(target)
    expect(gutter.target).toEqual(gutter.union)
    expect(gutter.glyphOffset).toBe(3)
    let persistBefore = await persistCount(page)
    await page.mouse.click(
      (gutter.marker.left + gutter.marker.right) / 2,
      (gutter.marker.top + gutter.marker.bottom) / 2,
    )
    await expect
      .poll(() => view(page))
      .toMatchObject({
        foldedHeadings: [expect.objectContaining({ count: '3' })],
      })
    expect(await persistCount(page)).toBe(persistBefore + 1)
    expect(
      await target.evaluate((el) => getComputedStyle(el, '::after').content),
    ).toBe('"▶"')

    gutter = await headingGutterBox(target)
    await page.mouse.click(
      (gutter.paintedArrow.left + gutter.paintedArrow.right) / 2,
      (gutter.paintedArrow.top + gutter.paintedArrow.bottom) / 2,
    )
    await expect.poll(() => view(page)).toMatchObject({ foldedHeadings: [] })

    gutter = await headingGutterBox(target)
    expect(gutter.paintedArrow.top).toBeGreaterThan(gutter.marker.bottom)
    persistBefore = await persistCount(page)
    await page.mouse.click(
      (gutter.paintedArrow.left + gutter.paintedArrow.right) / 2,
      (gutter.marker.bottom + gutter.paintedArrow.top) / 2,
    )
    await expect
      .poll(() => view(page))
      .toMatchObject({
        foldedHeadings: [expect.objectContaining({ count: '3' })],
      })
    expect(await persistCount(page)).toBe(persistBefore + 1)

    gutter = await headingGutterBox(target)
    await page.mouse.click(
      (gutter.paintedArrow.left + gutter.paintedArrow.right) / 2,
      (gutter.paintedArrow.top + gutter.paintedArrow.bottom) / 2,
    )
    await expect.poll(() => view(page)).toMatchObject({ foldedHeadings: [] })

    await page.evaluate(() => {
      ;(window as any).__outsideGutterClicks = []
      if (!(window as any).__outsideGutterListener) {
        ;(window as any).__outsideGutterListener = true
        document.body.addEventListener('click', (event) => {
          ;(window as any).__outsideGutterClicks.push({
            defaultPrevented: event.defaultPrevented,
          })
        })
      }
    })
    gutter = await headingGutterBox(target)
    for (const point of [
      {
        x: gutter.union.left - 0.5,
        y: (gutter.union.top + gutter.union.bottom) / 2,
      },
      {
        x: gutter.union.right + 0.5,
        y: (gutter.union.top + gutter.union.bottom) / 2,
      },
      {
        x: (gutter.union.left + gutter.union.right) / 2,
        y: gutter.union.top - 0.5,
      },
      {
        x: (gutter.union.left + gutter.union.right) / 2,
        y: gutter.union.bottom + 0.5,
      },
    ]) {
      await page.mouse.click(point.x, point.y)
      await expect.poll(() => view(page)).toMatchObject({ foldedHeadings: [] })
    }
    expect(
      await page.evaluate(() => (window as any).__outsideGutterClicks),
    ).toEqual([
      { defaultPrevented: false },
      { defaultPrevented: false },
      { defaultPrevented: false },
      { defaultPrevented: false },
    ])

    const visibleMarker = gutter.marker
    await page.evaluate(() => {
      document.body.dataset.headingMarkers = '0'
    })
    const markerOffArrow = await foldIconBox(target)
    expect(markerOffArrow).toMatchObject({
      height: 24,
      paddingTop: 3,
    })
    expect(
      await target.evaluate(
        (element) => getComputedStyle(element, '::before').display,
      ),
    ).toBe('none')
    persistBefore = await persistCount(page)
    await page.mouse.click(
      (visibleMarker.left + visibleMarker.right) / 2,
      (visibleMarker.top + visibleMarker.bottom) / 2,
    )
    await expect.poll(() => view(page)).toMatchObject({ foldedHeadings: [] })
    expect(await persistCount(page)).toBe(persistBefore)
    await page.mouse.click(
      markerOffArrow.left + markerOffArrow.width / 2,
      markerOffArrow.top + markerOffArrow.height / 2,
    )
    await expect
      .poll(() => view(page))
      .toMatchObject({
        foldedHeadings: [expect.objectContaining({ count: '3' })],
      })
    expect(await persistCount(page)).toBe(persistBefore + 1)
    const collapsedMarkerOffArrow = await foldIconBox(target)
    await page.mouse.click(
      collapsedMarkerOffArrow.left + collapsedMarkerOffArrow.width / 2,
      collapsedMarkerOffArrow.top + collapsedMarkerOffArrow.height / 2,
    )
    await expect.poll(() => view(page)).toMatchObject({ foldedHeadings: [] })
    await page.evaluate(() => {
      document.body.dataset.headingMarkers = '1'
    })
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
            const arrowAnchorTop =
              box.top +
              px(icon.getPropertyValue('--vmde-heading-fold-arrow-top'))
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
            const arrowBox = {
              left: box.left + Number.parseFloat(icon.left),
              top: arrowAnchorTop,
              right:
                box.left +
                Number.parseFloat(icon.left) +
                Number.parseFloat(icon.width),
              bottom: arrowAnchorTop + 24,
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
              arrowBox,
              glyphOffset:
                box.top +
                Number.parseFloat(icon.top) +
                Number.parseFloat(icon.paddingTop) -
                arrowAnchorTop,
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
      expect(
        row.iconBox.top,
        `${mode} ${row.level} target reaches marker`,
      ).toBeLessThanOrEqual(row.markerBox.top)
      expect(
        row.iconBox.bottom,
        `${mode} ${row.level} target keeps arrow bottom`,
      ).toBe(row.arrowBox.bottom)
      expect(
        row.iconBox.left <= row.markerBox.left &&
          row.iconBox.right >= row.markerBox.right,
        `${mode} ${row.level} target contains marker`,
      ).toBe(true)
      expect(
        row.iconBox.left <= row.arrowBox.left &&
          row.iconBox.right >= row.arrowBox.right,
        `${mode} ${row.level} target contains arrow`,
      ).toBe(true)
      expect(row.glyphOffset, `${mode} ${row.level} glyph offset`).toBe(3)
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
