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

const listGutterBox = (target: import('@playwright/test').Locator) =>
  target.evaluate(
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one frame-consistent read captures the marker, arrow, text, checkbox, and child geometry.
    (element) => {
      const px = (value: string) => Number.parseFloat(value)
      const rect = element.getBoundingClientRect()
      const arrowStyle = getComputedStyle(element, '::after')
      const arrow = {
        left: rect.left + px(arrowStyle.left),
        top: rect.top + px(arrowStyle.top),
        right: rect.left + px(arrowStyle.left) + px(arrowStyle.width),
        bottom: rect.top + px(arrowStyle.top) + px(arrowStyle.height),
        width: px(arrowStyle.width),
        height: px(arrowStyle.height),
        content: arrowStyle.content,
        opacity: arrowStyle.opacity,
        fontSize: arrowStyle.fontSize,
        cursor: arrowStyle.cursor,
        pointerEvents: arrowStyle.pointerEvents,
        boxSizing: arrowStyle.boxSizing,
        paddingTop: px(arrowStyle.paddingTop),
      }
      const markerStyle = getComputedStyle(element, '::marker')
      const markerWidth = px(markerStyle.width)
      const markerLineHeight = px(markerStyle.lineHeight)
      const markerLabel = element.getAttribute('data-marker')?.trim() ?? ''
      const markerCanvas = document.createElement('canvas')
      const markerContext = markerCanvas.getContext('2d')
      if (markerContext) {
        const base = getComputedStyle(element)
        markerContext.font = `${markerStyle.fontStyle || base.fontStyle} ${markerStyle.fontWeight || base.fontWeight} ${markerStyle.fontSize || base.fontSize} ${markerStyle.fontFamily || base.fontFamily}`
      }
      const markerAdvance =
        markerLabel && markerContext
          ? markerContext.measureText(markerLabel).width
          : null
      const markerRight = Math.min(rect.left - 2, arrow.right)
      const marker =
        markerStyle.listStyleType !== 'none' &&
        Number.isFinite(markerWidth) &&
        markerWidth > 0 &&
        Number.isFinite(markerLineHeight) &&
        markerLineHeight > 0
          ? {
              left: markerRight - markerWidth,
              top: rect.top,
              right: markerRight,
              bottom: rect.top + markerLineHeight,
              width: markerWidth,
              lineHeight: markerLineHeight,
              listStyleType: markerStyle.listStyleType,
            }
          : null
      const box = {
        left: marker ? Math.min(marker.left, arrow.left) : arrow.left,
        top: marker ? Math.min(marker.top, arrow.top) : arrow.top,
        right: marker ? Math.max(marker.right, arrow.right) : arrow.right,
        bottom: marker ? Math.max(marker.bottom, arrow.bottom) : arrow.bottom,
      }
      const textRectsFor = (item: Element) => {
        const rects: Array<{
          left: number
          top: number
          right: number
          bottom: number
        }> = []
        const walker = document.createTreeWalker(item, NodeFilter.SHOW_TEXT)
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          if (
            !node.nodeValue?.trim() ||
            node.parentElement?.closest('li') !== item
          )
            continue
          const range = document.createRange()
          range.selectNodeContents(node)
          rects.push(
            ...Array.from(range.getClientRects()).map((line) => ({
              left: line.left,
              top: line.top,
              right: line.right,
              bottom: line.bottom,
            })),
          )
        }
        return rects
      }
      const textRects = textRectsFor(element)
      const checkbox = element.querySelector<HTMLInputElement>(
        'input[type="checkbox"]',
      )
      const checkboxRect = checkbox?.getBoundingClientRect()
      const currentGlyphStyle = getComputedStyle(element, '::before')
      const glyphCenterX =
        rect.left + px(currentGlyphStyle.left) + px(currentGlyphStyle.width) / 2
      const symbol = checkboxRect
        ? {
            kind: 'checkbox',
            centerX: (checkboxRect.left + checkboxRect.right) / 2,
          }
        : marker
          ? {
              kind:
                element.parentElement?.tagName === 'OL' ? 'ordered' : 'bullet',
              centerX:
                element.parentElement?.tagName === 'OL' &&
                markerLabel &&
                markerAdvance !== null
                  ? rect.left -
                    marker.width +
                    Math.min(marker.width, markerAdvance) / 2
                  : rect.left - (marker.lineHeight + marker.width) / 2,
            }
          : null
      const childList = Array.from(element.children).find(
        (child) => child.tagName === 'UL' || child.tagName === 'OL',
      )
      const childItem = childList?.querySelector(':scope > li')
      let childMarker = null
      let childTextRects: ReturnType<typeof textRectsFor> = []
      if (childItem) {
        const childRect = childItem.getBoundingClientRect()
        const childMarkerStyle = getComputedStyle(childItem, '::marker')
        const childWidth = px(childMarkerStyle.width)
        const childLineHeight = px(childMarkerStyle.lineHeight)
        if (
          childMarkerStyle.listStyleType !== 'none' &&
          Number.isFinite(childWidth) &&
          childWidth > 0 &&
          Number.isFinite(childLineHeight) &&
          childLineHeight > 0
        ) {
          childMarker = {
            left: childRect.left - childWidth,
            top: childRect.top,
            right: childRect.left,
            bottom: childRect.top + childLineHeight,
          }
        }
        childTextRects = textRectsFor(childItem)
      }
      return {
        text: element.textContent?.trim().replace(/\s+/g, ' ') ?? '',
        markerLabel: element.getAttribute('data-marker'),
        rect: {
          left: rect.left,
          top: rect.top,
          right: rect.right,
          bottom: rect.bottom,
          width: rect.width,
          height: rect.height,
        },
        listStylePosition: getComputedStyle(element.parentElement!)
          .listStylePosition,
        arrow,
        glyph: {
          centerX: glyphCenterX,
          width: px(currentGlyphStyle.width),
          fontSize: currentGlyphStyle.fontSize,
          content: currentGlyphStyle.content,
        },
        symbol,
        markerMetrics: {
          label: markerLabel,
          advance: markerAdvance,
          font: markerStyle.font,
          textAlign: markerStyle.textAlign,
          marginInlineEnd: markerStyle.marginInlineEnd,
          width: markerStyle.width,
          content: markerStyle.content,
        },
        marker,
        box,
        textRects,
        checkbox:
          checkboxRect && checkboxRect.width > 0 && checkboxRect.height > 0
            ? {
                left: checkboxRect.left,
                top: checkboxRect.top,
                right: checkboxRect.right,
                bottom: checkboxRect.bottom,
              }
            : null,
        childMarker,
        childTextRects,
      }
    },
  )

const rectsOverlap = (
  left: { left: number; top: number; right: number; bottom: number },
  right: { left: number; top: number; right: number; bottom: number },
) =>
  left.left < right.right &&
  left.right > right.left &&
  left.top < right.bottom &&
  left.bottom > right.top

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

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: this focused geometry scenario keeps viewport, mode, pointer, source, and handle evidence together.
async function verifyListFoldGutters(page: import('@playwright/test').Page) {
  const markdown = [
    '8. single-digit parent',
    '   1. nested single child',
    '',
    '9. nine plain',
    '10. multi-digit parent with wrapped text that continues on a second line in the narrow pane',
    '    1. nested ordered child',
    '',
    '- bullet parent with wrapped text that continues across a narrow pane',
    '  - nested bullet parent',
    '    - nested bullet child',
    '  - nested bullet peer',
    '- bullet sibling',
    '',
    '- [ ] task parent',
    '  - task child',
    '',
    '- loose parent with a wrapped first paragraph',
    '',
    '  continuation paragraph for the same list item',
    '',
    '  - loose child',
  ].join('\n')
  await page.setViewportSize({ width: 560, height: 900 })
  await page.evaluate(
    (value) => (window as any).vditor.setValue(value),
    markdown,
  )
  const foldItems = () =>
    page.locator(
      '.vditor-ir:visible li[data-vmde-list-foldable], .vditor-wysiwyg:visible li[data-vmde-list-foldable]',
    )
  await expect.poll(() => foldItems().count()).toBe(6)

  const findItem = (needle: string, deepest = false) => {
    const matches = foldItems().filter({ hasText: needle })
    return deepest ? matches.last() : matches.first()
  }
  const mode = () =>
    page.evaluate(() => (window as any).vditor.vditor.currentMode as string)
  const modes = ['ir', 'wysiwyg'] as const
  for (const editorMode of modes) {
    if ((await mode()) !== editorMode) {
      await page.evaluate(
        (next) => (window as any).__switchMode(next),
        editorMode,
      )
      await expect.poll(mode).toBe(editorMode)
    }
    for (const width of [560, 1000]) {
      await page.setViewportSize({ width, height: 900 })
      // Compare only after the viewport and mode reflow settle; a transient layout plateau can pass early.
      await page.waitForTimeout(250)
      await expect.poll(() => foldItems().count()).toBe(6)
      const labels = [
        'single-digit parent',
        'multi-digit parent',
        'bullet parent',
        'nested bullet parent',
        'task parent',
        'loose parent',
      ]
      const geometries = []
      for (const label of labels) {
        const item = findItem(label, label === 'nested bullet parent')
        await expect(item).toHaveCount(1)
        const geometry = await listGutterBox(item)
        geometries.push(geometry)
        expect(geometry.listStylePosition).toBe('outside')
        expect(geometry.arrow.width).toBe(36)
        expect(geometry.arrow.height).toBe(24)
        expect(geometry.arrow.boxSizing).toBe('border-box')
        expect(geometry.arrow.opacity).toBe('1')
        expect(geometry.arrow.content).toBe('""')
        expect(geometry.glyph.fontSize).toBe('12px')
        expect(geometry.arrow.cursor).toBe('pointer')
        expect(geometry.arrow.paddingTop).toBe(3)
        expect(geometry.arrow.pointerEvents).toBe('auto')
        expect(geometry.glyph.content).toBe('"▼"')
        expect(geometry.glyph.width).toBe(12)
        expect(
          geometry.symbol,
          `${editorMode} ${width}px ${label} symbol`,
        ).not.toBeNull()
        if (geometry.symbol) {
          expect
            .soft(
              Math.abs(geometry.glyph.centerX - geometry.symbol.centerX),
              `${editorMode} ${width}px ${label} painted glyph center; symbol=${JSON.stringify(geometry.symbol)} marker=${JSON.stringify(geometry.markerMetrics)}`,
            )
            .toBeLessThanOrEqual(1)
        }
        expect(geometry.textRects.length).toBeGreaterThan(0)
        const textLeft = Math.min(
          ...geometry.textRects.map((rect) => rect.left),
        )
        expect(textLeft - geometry.box.right).toBeGreaterThanOrEqual(2)
        expect(
          geometry.textRects.some((rect) => rectsOverlap(geometry.box, rect)),
        ).toBe(false)
        if (geometry.marker) {
          expect(geometry.box.left).toBeLessThanOrEqual(geometry.marker.left)
          expect(geometry.box.top).toBeLessThanOrEqual(geometry.marker.top)
          expect(geometry.box.bottom).toBeGreaterThanOrEqual(
            geometry.marker.bottom,
          )
        }
        expect(
          geometry.childMarker
            ? rectsOverlap(geometry.box, geometry.childMarker)
            : false,
        ).toBe(false)
        expect(
          geometry.childTextRects.some((rect) =>
            rectsOverlap(geometry.box, rect),
          ),
        ).toBe(false)
        if (geometry.checkbox) {
          expect(
            rectsOverlap(geometry.box, geometry.checkbox),
            'task fold target overlaps its native checkbox',
          ).toBe(false)
        }
      }
      const singleDigit = geometries[0]
      const multiDigit = geometries[1]
      const parentBullet = geometries[2]
      const nestedBullet = geometries[3]
      const task = geometries[4]
      const loose = geometries[5]
      expect(singleDigit.marker?.width).toBeGreaterThan(0)
      expect(multiDigit.marker?.width).toBeGreaterThan(
        singleDigit.marker?.width ?? 0,
      )
      expect(parentBullet.marker?.width).toBeGreaterThan(0)
      expect(task.marker).toBeNull()
      expect(task.checkbox).not.toBeNull()
      expect(task.arrow.left - task.rect.left).toBe(-44)
      expect(task.arrow.top).toBeCloseTo(task.checkbox!.bottom, 1)
      expect(nestedBullet.rect.left - parentBullet.rect.left).toBe(28)
      expect(nestedBullet.arrow.left - parentBullet.arrow.left).toBe(28)
      expect(loose.textRects.length).toBeGreaterThanOrEqual(2)
      if (width === 560) {
        expect(multiDigit.textRects.length).toBeGreaterThan(1)
      }
    }
  }

  await page.setViewportSize({ width: 560, height: 900 })
  const trustedClicks: Array<{ trusted: boolean; tag: string }> = []
  await page.evaluate((trace) => {
    ;(window as any).__trustedFoldClicks = trace
    document.addEventListener(
      'click',
      (event) => {
        trace.push({
          trusted: event.isTrusted,
          tag: (event.target as HTMLElement).tagName,
        })
      },
      true,
    )
  }, trustedClicks)
  const click = async (point: { x: number; y: number }) => {
    await page.mouse.click(point.x, point.y)
    const trace = await page.evaluate(
      () => (window as any).__trustedFoldClicks as Array<{ trusted: boolean }>,
    )
    expect(trace.at(-1)?.trusted).toBe(true)
  }
  const foldPoint = (geometry: Awaited<ReturnType<typeof listGutterBox>>) => ({
    x: geometry.box.left + (geometry.box.right - geometry.box.left) / 2,
    y: geometry.arrow.top + geometry.arrow.paddingTop + 6,
  })

  for (const editorMode of modes) {
    if ((await mode()) !== editorMode) {
      await page.evaluate(
        (next) => (window as any).__switchMode(next),
        editorMode,
      )
      await expect.poll(mode).toBe(editorMode)
      await page.waitForTimeout(250)
    }
    const bullet = findItem('bullet parent')
    await bullet.scrollIntoViewIfNeeded()
    let geometry = await listGutterBox(bullet)
    const markerPoint = {
      x: geometry.marker!.left + geometry.marker!.width / 2,
      y: geometry.marker!.top + geometry.marker!.lineHeight / 2,
    }
    // Keep the UL-background click native, then compare the fold against Vditor's immediate value baseline.
    const backgroundPoint = {
      x: geometry.box.right + 1,
      y: markerPoint.y,
    }
    const backgroundPersist = await persistCount(page)
    await click(backgroundPoint)
    expect(await view(page)).toMatchObject({ foldedLists: 0 })
    expect(await persistCount(page)).toBe(backgroundPersist)
    const sourceBeforeFold = await value(page)
    const startingPersist = await persistCount(page)
    await click(markerPoint)
    await expect.poll(() => view(page)).toMatchObject({ foldedLists: 1 })
    expect(await persistCount(page)).toBe(startingPersist + 1)
    expect((await listGutterBox(bullet)).glyph.content).toBe('"▶"')
    expect((await view(page)).hiddenTexts.join(' ')).toContain(
      'nested bullet parent',
    )
    expect((await view(page)).hiddenTexts.join(' ')).toContain(
      'nested bullet child',
    )
    expect((await view(page)).hiddenTexts.join(' ')).not.toContain(
      'bullet sibling',
    )
    expect(await value(page)).toBe(sourceBeforeFold)
    const foldedGeometry = await listGutterBox(bullet)
    expect(foldedGeometry.rect.left).toBeCloseTo(geometry.rect.left, 4)
    expect(foldedGeometry.textRects[0].left).toBeCloseTo(
      geometry.textRects[0].left,
      4,
    )

    let persist = await persistCount(page)
    await click({
      x: (geometry.box.left + geometry.box.right) / 2,
      y: geometry.arrow.top + 1,
    })
    await expect.poll(() => view(page)).toMatchObject({ foldedLists: 0 })
    expect(await persistCount(page)).toBe(persist + 1)
    expect((await listGutterBox(bullet)).glyph.content).toBe('"▼"')

    geometry = await listGutterBox(bullet)
    persist = await persistCount(page)
    await click(foldPoint(geometry))
    await expect.poll(() => view(page)).toMatchObject({ foldedLists: 1 })
    expect(await persistCount(page)).toBe(persist + 1)
    expect((await listGutterBox(bullet)).glyph.content).toBe('"▶"')

    geometry = await listGutterBox(bullet)
    persist = await persistCount(page)
    await click(foldPoint(geometry))
    await expect.poll(() => view(page)).toMatchObject({ foldedLists: 0 })
    expect(await persistCount(page)).toBe(persist + 1)
    expect((await listGutterBox(bullet)).glyph.content).toBe('"▼"')
    expect(await value(page)).toBe(sourceBeforeFold)

    geometry = await listGutterBox(bullet)
    persist = await persistCount(page)
    const outside = [
      {
        x: geometry.box.left - 1,
        y: (geometry.box.top + geometry.box.bottom) / 2,
      },
      {
        x: geometry.box.right + 1,
        y: (geometry.box.top + geometry.box.bottom) / 2,
      },
      {
        x: (geometry.box.left + geometry.box.right) / 2,
        y: geometry.box.top - 1,
      },
      {
        x: (geometry.box.left + geometry.box.right) / 2,
        y: geometry.box.bottom + 1,
      },
    ]
    for (const point of outside) await click(point)
    await expect.poll(() => view(page)).toMatchObject({ foldedLists: 0 })
    expect(await persistCount(page)).toBe(persist)
    const firstText = geometry.textRects[0]
    await click({
      x: firstText.left + 1,
      y: firstText.top + (firstText.bottom - firstText.top) / 2,
    })
    expect(await view(page)).toMatchObject({ foldedLists: 0 })
    expect(await persistCount(page)).toBe(persist)

    const nested = findItem('nested bullet parent', true)
    await nested.scrollIntoViewIfNeeded()
    const nestedGeometry = await listGutterBox(nested)
    await click(foldPoint(nestedGeometry))
    await expect.poll(() => view(page)).toMatchObject({ foldedLists: 1 })
    expect((await listGutterBox(nested)).glyph.content).toBe('"▶"')
    const nestedPersist = await persistCount(page)
    await click(foldPoint(await listGutterBox(nested)))
    await expect.poll(() => view(page)).toMatchObject({ foldedLists: 0 })
    expect(await persistCount(page)).toBe(nestedPersist + 1)

    const task = findItem('task parent')
    await task.scrollIntoViewIfNeeded()
    const taskGeometry = await listGutterBox(task)
    const checkbox = task.locator(':scope > input[type="checkbox"]')
    const checkboxPoint = {
      x: (taskGeometry.checkbox!.left + taskGeometry.checkbox!.right) / 2,
      y: (taskGeometry.checkbox!.top + taskGeometry.checkbox!.bottom) / 2,
    }
    const taskPersist = await persistCount(page)
    await click(checkboxPoint)
    await expect(checkbox).toBeChecked()
    expect(await view(page)).toMatchObject({ foldedLists: 0 })
    expect(await persistCount(page)).toBe(taskPersist)
    await click(checkboxPoint)
    await expect(checkbox).not.toBeChecked()
    expect(await view(page)).toMatchObject({ foldedLists: 0 })
    expect(await persistCount(page)).toBe(taskPersist)
  }

  const handleMarkdown = [
    '- handle parent',
    '  - handle child',
    '    - handle grandchild',
    '- handle sibling',
  ].join('\n')
  await page.evaluate(
    (value) => (window as any).vditor.setValue(value),
    handleMarkdown,
  )
  await expect.poll(() => foldItems().count()).toBe(2)
  const parent = findItem('handle parent')
  const child = findItem('handle child', true)
  await child.hover()
  const handle = page.locator('.vmde-block-handle')
  await expect(handle).toBeVisible()
  const [parentGeometry, childGeometry, handleRect] = await Promise.all([
    listGutterBox(parent),
    listGutterBox(child),
    handle.evaluate((element) => {
      const rect = element.getBoundingClientRect()
      return {
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
      }
    }),
  ])
  expect(rectsOverlap(parentGeometry.box, handleRect)).toBe(false)
  expect(rectsOverlap(childGeometry.box, handleRect)).toBe(false)
  // Task 259 maps a nested-child hover to its owning list-item source group.
  expect(parentGeometry.box.left - handleRect.right).toBe(2)
  expect(childGeometry.box.left - handleRect.right).toBeGreaterThan(2)
  await handle.click()
  const menu = page.locator('.vmde-block-handle-menu')
  await expect(menu).toBeVisible()
  expect(await view(page)).toMatchObject({ foldedLists: 0 })
  expect((await listGutterBox(parent)).glyph.content).toBe('"▼"')
  await handle.click()
  await expect(menu).toBeHidden()
  const parentArrowGeometry = await listGutterBox(parent)
  const parentArrowPoint = foldPoint(parentArrowGeometry)
  await click(parentArrowPoint)
  await expect.poll(() => view(page)).toMatchObject({ foldedLists: 1 })
  await expect(menu).toBeHidden()
  await click(foldPoint(await listGutterBox(parent)))
  await expect.poll(() => view(page)).toMatchObject({ foldedLists: 0 })
}

test('list fold gutters use bounded trusted targets in both editor modes', async ({
  page,
}) => {
  test.setTimeout(90_000)
  await verifyListFoldGutters(page)
})

test('list glyph metrics follow font and pane resize without changing source bytes', async ({
  page,
}) => {
  const source = '8. measured parent\n   - child\n'
  await page.evaluate(
    (markdown) => (window as any).vditor.setValue(markdown),
    source,
  )
  const item = page
    .locator('.vditor-ir:visible li[data-vmde-list-foldable]')
    .first()
  await expect(item).toBeVisible()
  const before = await value(page)
  const persistsBefore = await persistCount(page)
  const first = await listGutterBox(item)
  expect(first.symbol).not.toBeNull()
  expect(
    Math.abs(first.glyph.centerX - first.symbol!.centerX),
  ).toBeLessThanOrEqual(1)
  const sourceParity = await item.evaluate((element) => {
    const editor = (window as any).vditor
    const before = editor.getValue()
    const center = element.style.getPropertyValue(
      '--vmde-list-fold-glyph-center-x',
    )
    const top = element.style.getPropertyValue('--vmde-list-fold-arrow-top')
    element.style.removeProperty('--vmde-list-fold-glyph-center-x')
    element.style.removeProperty('--vmde-list-fold-arrow-top')
    const withoutVariables = editor.getValue()
    element.style.setProperty('--vmde-list-fold-glyph-center-x', center)
    element.style.setProperty('--vmde-list-fold-arrow-top', top)
    return {
      before,
      withoutVariables,
      restored: editor.getValue(),
      center,
      top,
    }
  })
  expect(sourceParity.center).not.toBe('')
  expect(sourceParity.top).not.toBe('')
  expect(sourceParity.withoutVariables).toBe(sourceParity.before)
  expect(sourceParity.restored).toBe(sourceParity.before)

  await page.addStyleTag({
    content: '.vditor-ir .vditor-reset li { font-size: 22px !important; }',
  })
  await page.setViewportSize({ width: 560, height: 900 })
  await expect
    .poll(() => item.evaluate((element) => getComputedStyle(element).fontSize))
    .toBe('22px')
  await expect
    .poll(async () => {
      const geometry = await listGutterBox(item)
      return Math.abs(geometry.glyph.centerX - geometry.symbol!.centerX)
    })
    .toBeLessThanOrEqual(1)
  expect(await value(page)).toBe(before)
  await page.evaluate(() => (window as any).__switchMode('wysiwyg'))
  await expect
    .poll(() => page.evaluate(() => (window as any).vditor.vditor.currentMode))
    .toBe('wysiwyg')
  const wysItem = page
    .locator('.vditor-wysiwyg:visible li[data-vmde-list-foldable]')
    .first()
  await expect(wysItem).toBeVisible()
  const wysGeometry = await listGutterBox(wysItem)
  expect(
    Math.abs(wysGeometry.glyph.centerX - wysGeometry.symbol!.centerX),
  ).toBeLessThanOrEqual(1)
  const wysParity = await wysItem.evaluate((element) => {
    const editor = (window as any).vditor
    const before = editor.getValue()
    const center = element.style.getPropertyValue(
      '--vmde-list-fold-glyph-center-x',
    )
    const top = element.style.getPropertyValue('--vmde-list-fold-arrow-top')
    element.style.removeProperty('--vmde-list-fold-glyph-center-x')
    element.style.removeProperty('--vmde-list-fold-arrow-top')
    const withoutVariables = editor.getValue()
    element.style.setProperty('--vmde-list-fold-glyph-center-x', center)
    element.style.setProperty('--vmde-list-fold-arrow-top', top)
    return {
      before,
      withoutVariables,
      restored: editor.getValue(),
      center,
      top,
    }
  })
  expect(wysParity.center).not.toBe('')
  expect(wysParity.top).not.toBe('')
  expect(wysParity.withoutVariables).toBe(wysParity.before)
  expect(wysParity.restored).toBe(wysParity.before)
  expect(wysParity.before).toBe(before)
  expect(await persistCount(page)).toBe(persistsBefore)
})
