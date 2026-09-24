import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import { waitForE2EReadiness } from './webview-helpers'

const CONTENT = [
  '# One',
  '',
  'one body',
  '',
  '## Child',
  '',
  'child body',
  '',
  '# Two',
  '',
  '- parent',
  '  - nested a',
  '  - nested b',
  '',
  'tail paragraph',
].join('\n')

function wf(workbox: import('@playwright/test').Page) {
  return workbox
    .frameLocator('iframe.webview:visible')
    .frameLocator('iframe[title="VMDE"], #active-frame')
}

type VmdeFrame = ReturnType<typeof wf>

const getValue = (frame: VmdeFrame) =>
  frame
    .locator('body')
    .evaluate(() =>
      (
        window as unknown as { vditor: { getValue(): string } }
      ).vditor.getValue(),
    )

const foldView = (frame: VmdeFrame) =>
  frame.locator('body').evaluate(() => {
    const inner = (window as any).vditor.vditor
    const root = inner[inner.currentMode].element as HTMLElement
    return {
      mode: inner.currentMode,
      headings: Array.from(
        root.querySelectorAll<HTMLElement>('[data-vmde-folded]'),
      ).map((heading) => ({
        text: heading.textContent?.trim() ?? '',
        count: heading.dataset.vmdeFoldCount,
      })),
      lists: root.querySelectorAll('[data-vmde-list-folded]').length,
      hidden: Array.from(
        root.querySelectorAll<HTMLElement>('[data-vmde-fold-hidden]'),
      ).map((element) => element.textContent?.trim() ?? ''),
    }
  })

const headingPoint = (frame: VmdeFrame) =>
  frame
    .locator('.vditor-ir:visible .vditor-reset > h1', { hasText: 'One' })
    .first()
    .evaluate((element) => {
      const text = Array.from(element.childNodes).find(
        (node) => node.nodeType === Node.TEXT_NODE && node.nodeValue?.trim(),
      )!
      const first = text.nodeValue!.search(/\S/)
      const range = document.createRange()
      range.setStart(text, first)
      range.setEnd(text, first + 1)
      const textBox = range.getBoundingClientRect()
      return { x: textBox.left - 1, y: textBox.top + textBox.height / 2 }
    })

const headingIconBox = (target: import('@playwright/test').Locator) =>
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
      width,
      height,
      boxSizing: icon.boxSizing,
      paddingTop: Number.parseFloat(icon.paddingTop),
      opacity: icon.opacity,
      fontSize: icon.fontSize,
      lineHeight: icon.lineHeight,
      display: icon.display,
      alignItems: icon.alignItems,
      content: icon.content,
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
    const targetBox = {
      left: heading.left + px(arrow.left),
      top: heading.top + px(arrow.top),
      right: heading.left + px(arrow.left) + px(arrow.width),
      bottom: heading.top + px(arrow.top) + px(arrow.height),
    }
    const arrowAnchorTop =
      heading.top + px(arrow.getPropertyValue('--vmde-heading-fold-arrow-top'))
    const paintedArrow = {
      left: targetBox.left,
      top: arrowAnchorTop,
      right: targetBox.right,
      bottom: arrowAnchorTop + 24,
    }
    return {
      marker: markerBox,
      paintedArrow,
      target: targetBox,
      union: {
        left: Math.min(markerBox.left, targetBox.left),
        top: Math.min(markerBox.top, targetBox.top),
        right: Math.max(markerBox.right, targetBox.right),
        bottom: Math.max(markerBox.bottom, targetBox.bottom),
      },
      glyphOffset:
        heading.top + px(arrow.top) + px(arrow.paddingTop) - arrowAnchorTop,
    }
  })

const listGutterBox = (target: import('@playwright/test').Locator) =>
  target.evaluate(
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one frame-consistent geometry read captures marker, arrow, text, and checkbox rectangles.
    (item) => {
      const px = (value: string) => Number.parseFloat(value)
      const rect = item.getBoundingClientRect()
      const arrowStyle = getComputedStyle(item, '::after')
      const arrow = {
        left: rect.left + px(arrowStyle.left),
        top: rect.top + px(arrowStyle.top),
        right: rect.left + px(arrowStyle.left) + px(arrowStyle.width),
        bottom: rect.top + px(arrowStyle.top) + px(arrowStyle.height),
        width: px(arrowStyle.width),
        height: px(arrowStyle.height),
        content: arrowStyle.content,
        paddingTop: px(arrowStyle.paddingTop),
      }
      const markerStyle = getComputedStyle(item, '::marker')
      const markerWidth = px(markerStyle.width)
      const markerLineHeight = px(markerStyle.lineHeight)
      const markerLabel = item.getAttribute('data-marker')?.trim() ?? ''
      const markerContext = document.createElement('canvas').getContext('2d')
      if (markerContext) {
        const base = getComputedStyle(item)
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
            }
          : null
      const box = {
        left: marker ? Math.min(marker.left, arrow.left) : arrow.left,
        top: marker ? Math.min(marker.top, arrow.top) : arrow.top,
        right: marker ? Math.max(marker.right, arrow.right) : arrow.right,
        bottom: marker ? Math.max(marker.bottom, arrow.bottom) : arrow.bottom,
      }
      const walker = document.createTreeWalker(item, NodeFilter.SHOW_TEXT)
      let firstTextRect: DOMRect | null = null
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (
          !node.nodeValue?.trim() ||
          node.parentElement?.closest('li') !== item
        )
          continue
        const range = document.createRange()
        range.selectNodeContents(node)
        firstTextRect = range.getClientRects()[0] ?? null
        if (firstTextRect) break
      }
      const checkbox = item.querySelector<HTMLInputElement>(
        'input[type="checkbox"]',
      )
      const checkboxRect = checkbox?.getBoundingClientRect()
      const glyphStyle = getComputedStyle(item, '::before')
      // The shipped font paints ▶ 2px left of its CSS box center. The visual
      // goldens verify that ink shift, so compare painted centers here.
      const glyphCenterX =
        rect.left +
        px(glyphStyle.left) +
        px(glyphStyle.width) / 2 -
        (glyphStyle.content === '"▶"' ? 2 : 0)
      const symbolCenterX =
        checkboxRect && checkboxRect.width > 0
          ? (checkboxRect.left + checkboxRect.right) / 2
          : marker
            ? item.parentElement?.tagName === 'OL' &&
              markerLabel &&
              markerAdvance !== null
              ? rect.left -
                marker.width +
                Math.min(marker.width, markerAdvance) / 2
              : rect.left - (marker.lineHeight + marker.width) / 2
            : null
      return {
        rect: {
          left: rect.left,
          top: rect.top,
          right: rect.right,
          bottom: rect.bottom,
        },
        arrow,
        glyph: {
          centerX: glyphCenterX,
          content: glyphStyle.content,
          fontSize: glyphStyle.fontSize,
        },
        symbolCenterX,
        marker,
        box,
        firstText: firstTextRect
          ? {
              left: firstTextRect.left,
              top: firstTextRect.top,
              right: firstTextRect.right,
              bottom: firstTextRect.bottom,
            }
          : null,
        checkbox:
          checkboxRect && checkboxRect.width > 0 && checkboxRect.height > 0
            ? {
                left: checkboxRect.left,
                top: checkboxRect.top,
                right: checkboxRect.right,
                bottom: checkboxRect.bottom,
              }
            : null,
      }
    },
  )

const rectanglesOverlap = (
  a: { left: number; top: number; right: number; bottom: number },
  b: { left: number; top: number; right: number; bottom: number },
) =>
  a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top

const listItems = (frame: VmdeFrame) =>
  frame.locator(
    '.vditor-ir:visible li[data-vmde-list-foldable], .vditor-wysiwyg:visible li[data-vmde-list-foldable]',
  )

const listItem = (frame: VmdeFrame, needle: string, deepest = false) => {
  const matches = listItems(frame).filter({ hasText: needle })
  return deepest ? matches.last() : matches.first()
}

const placeText = (frame: VmdeFrame, needle: string) =>
  frame.locator('body').evaluate((_body, target) => {
    const inner = (window as any).vditor.vditor
    const root = inner[inner.currentMode].element as HTMLElement
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const index = (node.nodeValue ?? '').indexOf(target as string)
      if (index < 0 || node.parentElement?.closest('[data-render]')) continue
      root.focus({ preventScroll: true })
      const range = document.createRange()
      range.setStart(node, index)
      range.collapse(true)
      const selection = getSelection()!
      selection.removeAllRanges()
      selection.addRange(range)
      document.dispatchEvent(new Event('selectionchange'))
      return true
    }
    return false
  }, needle)

type ListGeometry = Awaited<ReturnType<typeof listGutterBox>>

const listArrowCenter = (geometry: ListGeometry) => ({
  x: (geometry.arrow.left + geometry.arrow.right) / 2,
  y: (geometry.arrow.top + geometry.arrow.bottom) / 2,
})

const listMarkerCenter = (geometry: ListGeometry) => ({
  x: (geometry.marker!.left + geometry.marker!.right) / 2,
  y: (geometry.marker!.top + geometry.marker!.bottom) / 2,
})

async function clickTrustedListPoint(
  frame: VmdeFrame,
  point: { x: number; y: number },
): Promise<void> {
  await frame.locator('body').click({ position: point })
  expect(
    await frame
      .locator('body')
      .evaluate(() => (window as any).__lastListFoldClickTrusted),
  ).toBe(true)
}

async function exerciseListPointerMode(
  frame: VmdeFrame,
  nextMode: 'ir' | 'wysiwyg',
): Promise<void> {
  if ((await foldView(frame)).mode !== nextMode) {
    const foldsBeforeModeSwitch = (await foldView(frame)).lists
    await frame.locator('.vditor-toolbar [data-type="edit-mode"]').click()
    await frame
      .locator(
        nextMode === 'ir'
          ? 'button[data-mode="ir"]'
          : 'button[data-mode="wysiwyg"]',
      )
      .click()
    await expect
      .poll(() => foldView(frame))
      .toMatchObject({ mode: nextMode, lists: foldsBeforeModeSwitch })
  }
  const parent = listItem(frame, 'pointer parent')
  await parent.scrollIntoViewIfNeeded()
  let geometry = await listGutterBox(parent)
  expect(['"▼"', '"▶"']).toContain(geometry.glyph.content)
  expect(
    Math.abs(geometry.glyph.centerX - geometry.symbolCenterX!),
  ).toBeLessThanOrEqual(1)
  const metrics = await parent.evaluate((item) => ({
    center: item.style.getPropertyValue('--vmde-list-fold-glyph-center-x'),
    top: item.style.getPropertyValue('--vmde-list-fold-arrow-top'),
  }))
  expect(metrics.center).not.toBe('')
  expect(metrics.top).not.toBe('')
  if (await parent.getAttribute('data-vmde-list-folded')) {
    await clickTrustedListPoint(frame, listArrowCenter(geometry))
    await expect.poll(() => foldView(frame)).toMatchObject({ lists: 0 })
    geometry = await listGutterBox(parent)
  }
  expect(geometry.glyph.content).toBe('"▼"')

  const backgroundPoint = {
    x: geometry.box.right + 1,
    y: geometry.marker!.top + geometry.marker!.lineHeight / 2,
  }
  await clickTrustedListPoint(frame, backgroundPoint)
  await expect.poll(() => foldView(frame)).toMatchObject({ lists: 0 })
  geometry = await listGutterBox(parent)
  const firstText = geometry.firstText!
  await clickTrustedListPoint(frame, {
    x: firstText.left + 1,
    y: (firstText.top + firstText.bottom) / 2,
  })
  await expect.poll(() => foldView(frame)).toMatchObject({ lists: 0 })
  const task = listItem(frame, 'task pointer')
  const checkbox = task.locator(':scope > input[type="checkbox"]')
  const taskGeometry = await listGutterBox(task)
  expect(rectanglesOverlap(taskGeometry.box, taskGeometry.checkbox!)).toBe(
    false,
  )
  expect(taskGeometry.box.right).toBeLessThan(taskGeometry.firstText!.left)
  const checkboxPoint = {
    x: (taskGeometry.checkbox!.left + taskGeometry.checkbox!.right) / 2,
    y: (taskGeometry.checkbox!.top + taskGeometry.checkbox!.bottom) / 2,
  }
  await clickTrustedListPoint(frame, checkboxPoint)
  await expect(checkbox).toBeChecked()
  await expect.poll(() => foldView(frame)).toMatchObject({ lists: 0 })
  await clickTrustedListPoint(frame, checkboxPoint)
  await expect(checkbox).not.toBeChecked()
  await expect.poll(() => foldView(frame)).toMatchObject({ lists: 0 })

  geometry = await listGutterBox(parent)
  const sourceBeforeFold = await getValue(frame)
  await clickTrustedListPoint(frame, listMarkerCenter(geometry))
  await expect.poll(() => foldView(frame)).toMatchObject({ lists: 1 })
  expect((await listGutterBox(parent)).glyph.content).toBe('"▶"')
  expect((await foldView(frame)).hidden.join(' ')).toContain('pointer nested')
  expect((await foldView(frame)).hidden.join(' ')).toContain('pointer leaf')
  expect((await foldView(frame)).hidden.join(' ')).not.toContain(
    'pointer sibling',
  )
  expect(await getValue(frame)).toBe(sourceBeforeFold)

  geometry = await listGutterBox(parent)
  await clickTrustedListPoint(frame, {
    x: (geometry.box.left + geometry.box.right) / 2,
    y: geometry.arrow.top + 1,
  })
  await expect.poll(() => foldView(frame)).toMatchObject({ lists: 0 })
  expect((await listGutterBox(parent)).glyph.content).toBe('"▼"')
  expect(await getValue(frame)).toBe(sourceBeforeFold)

  geometry = await listGutterBox(parent)
  await clickTrustedListPoint(frame, listArrowCenter(geometry))
  await expect.poll(() => foldView(frame)).toMatchObject({ lists: 1 })
  expect((await listGutterBox(parent)).glyph.content).toBe('"▶"')
  await clickTrustedListPoint(
    frame,
    listArrowCenter(await listGutterBox(parent)),
  )
  await expect.poll(() => foldView(frame)).toMatchObject({ lists: 0 })
  expect(await getValue(frame)).toBe(sourceBeforeFold)

  await clickTrustedListPoint(
    frame,
    listArrowCenter(await listGutterBox(parent)),
  )
  await expect.poll(() => foldView(frame)).toMatchObject({ lists: 1 })
  await clickTrustedListPoint(
    frame,
    listArrowCenter(await listGutterBox(parent)),
  )
  await expect.poll(() => foldView(frame)).toMatchObject({ lists: 0 })
  expect(await getValue(frame)).toBe(sourceBeforeFold)

  await clickTrustedListPoint(
    frame,
    listMarkerCenter(await listGutterBox(parent)),
  )
  await expect.poll(() => foldView(frame)).toMatchObject({ lists: 1 })
  expect(await getValue(frame)).toBe(sourceBeforeFold)
}

async function openVmde(
  evaluateInVSCode: (fn: unknown, args: [string]) => Promise<unknown>,
  docPath: string,
) {
  await evaluateInVSCode(
    async (vscode, args: [string]) => {
      await vscode.extensions.getExtension('Laicasaane.vmde')?.activate()
      await vscode.commands.executeCommand(
        'vscode.openWith',
        vscode.Uri.file(args[0]),
        'vmde.editor',
      )
    },
    [docPath] as [string],
  )
}

test('real section/list folds persist, survive mode switch, and auto-unfold for source reveal', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(180_000)
  const docPath = path.join(baseDir, 'section-fold.md')
  writeFileSync(docPath, CONTENT)
  await openVmde(evaluateInVSCode, docPath)
  let frame = wf(workbox)
  await frame
    .locator('.vditor-ir:visible, .vditor-wysiwyg:visible')
    .first()
    .waitFor({ timeout: 60_000 })
  await waitForE2EReadiness(
    frame,
    (state) =>
      state.routerReady && state.editorEpoch > 0 && state.mode === 'ir',
    { message: 'section-fold fixture readiness' },
  )
  await frame
    .locator('.vditor-ir')
    .first()
    .click({ position: { x: 5, y: 5 } })
  const baseline = await getValue(frame)

  const firstHeading = frame
    .locator('.vditor-ir:visible .vditor-reset > h1', { hasText: 'One' })
    .first()
  expect(await headingIconBox(firstHeading)).toMatchObject({
    width: 36,
    height: 61,
    boxSizing: 'border-box',
    paddingTop: 40,
    opacity: '1',
    fontSize: '12px',
    lineHeight: '0px',
    display: 'flex',
    alignItems: 'flex-start',
    content: '"▼"',
  })
  const point = await headingPoint(frame)
  await frame.locator('body').click({ position: point })
  await expect.poll(() => foldView(frame)).toMatchObject({ headings: [] })
  expect(
    await firstHeading.evaluate((element) => {
      const selection = getSelection()
      return Boolean(
        selection?.isCollapsed &&
          selection.anchorNode &&
          element.contains(selection.anchorNode),
      )
    }),
  ).toBe(true)

  await firstHeading.scrollIntoViewIfNeeded()
  let gutter = await headingGutterBox(firstHeading)
  expect(gutter.target).toEqual(gutter.union)
  expect(gutter.glyphOffset).toBe(3)
  await frame.locator('body').click({
    position: {
      x: (gutter.marker.left + gutter.marker.right) / 2,
      y: (gutter.marker.top + gutter.marker.bottom) / 2,
    },
  })
  await expect
    .poll(() => foldView(frame))
    .toMatchObject({
      headings: [expect.objectContaining({ count: '3' })],
    })
  expect(await headingIconBox(firstHeading)).toMatchObject({
    opacity: '1',
    content: '"▶"',
  })
  gutter = await headingGutterBox(firstHeading)
  await frame.locator('body').click({
    position: {
      x: (gutter.target.left + gutter.target.right) / 2,
      y: gutter.target.bottom - 12,
    },
  })
  await expect.poll(() => foldView(frame)).toMatchObject({ headings: [] })
  gutter = await headingGutterBox(firstHeading)
  await frame.locator('body').click({
    position: {
      x: (gutter.target.left + gutter.target.right) / 2,
      y: (gutter.marker.bottom + gutter.paintedArrow.top) / 2,
    },
  })
  await expect
    .poll(() => foldView(frame))
    .toMatchObject({
      headings: [expect.objectContaining({ count: '3' })],
    })
  gutter = await headingGutterBox(firstHeading)
  await frame.locator('body').click({
    position: {
      x: (gutter.target.left + gutter.target.right) / 2,
      y: gutter.target.bottom - 12,
    },
  })
  await expect.poll(() => foldView(frame)).toMatchObject({ headings: [] })
  expect(
    await firstHeading.evaluate(
      (element) => getComputedStyle(element, '::after').content,
    ),
  ).toBe('"▼"')
  expect(await getValue(frame)).toBe(baseline)

  expect(await placeText(frame, 'One')).toBe(true)
  await workbox.keyboard.press('Control+Alt+[')
  await expect
    .poll(() => foldView(frame))
    .toMatchObject({
      headings: [expect.objectContaining({ count: '3' })],
    })
  expect((await foldView(frame)).hidden.join(' ')).toContain('child body')
  expect(await getValue(frame)).toBe(baseline)

  await frame.locator('.vditor-toolbar [data-type="edit-mode"]').click()
  await frame.locator('button[data-mode="wysiwyg"]').click()
  await expect
    .poll(() => foldView(frame))
    .toMatchObject({
      mode: 'wysiwyg',
      headings: [expect.objectContaining({ count: '3' })],
    })
  const wysiwygHeading = frame
    .locator('.vditor-wysiwyg:visible .vditor-reset > h1', { hasText: 'One' })
    .first()
  expect(await headingIconBox(wysiwygHeading)).toMatchObject({
    width: 36,
    height: 61,
    boxSizing: 'border-box',
    paddingTop: 40,
    opacity: '1',
    fontSize: '12px',
    lineHeight: '0px',
    display: 'flex',
    alignItems: 'flex-start',
    content: '"▶"',
  })
  await wysiwygHeading.scrollIntoViewIfNeeded()
  gutter = await headingGutterBox(wysiwygHeading)
  expect(gutter.target).toEqual(gutter.union)
  expect(gutter.glyphOffset).toBe(3)
  await frame.locator('body').click({
    position: {
      x: (gutter.marker.left + gutter.marker.right) / 2,
      y: (gutter.marker.top + gutter.marker.bottom) / 2,
    },
  })
  await expect.poll(() => foldView(frame)).toMatchObject({ headings: [] })
  gutter = await headingGutterBox(wysiwygHeading)
  await frame.locator('body').click({
    position: {
      x: (gutter.target.left + gutter.target.right) / 2,
      y: (gutter.marker.bottom + gutter.paintedArrow.top) / 2,
    },
  })
  await expect
    .poll(() => foldView(frame))
    .toMatchObject({
      headings: [expect.objectContaining({ count: '3' })],
    })
  gutter = await headingGutterBox(wysiwygHeading)
  await frame.locator('body').click({
    position: {
      x: (gutter.paintedArrow.left + gutter.paintedArrow.right) / 2,
      y: (gutter.paintedArrow.top + gutter.paintedArrow.bottom) / 2,
    },
  })
  await expect.poll(() => foldView(frame)).toMatchObject({ headings: [] })

  gutter = await headingGutterBox(wysiwygHeading)
  const formerMarker = gutter.marker
  const originalHeadingMarkers = await evaluateInVSCode(
    async (vscode) => {
      const config = vscode.workspace.getConfiguration('vmde')
      const original = config.inspect<boolean>(
        'editor.headingMarkers',
      )?.workspaceValue
      await config.update(
        'editor.headingMarkers',
        false,
        vscode.ConfigurationTarget.Workspace,
      )
      return original === undefined ? 'unset' : original ? 'true' : 'false'
    },
    [docPath] as [string],
  )
  try {
    await expect
      .poll(() =>
        frame
          .locator('body')
          .evaluate(() => document.body.dataset.headingMarkers),
      )
      .toBe('0')
    const markerOffArrow = await headingIconBox(wysiwygHeading)
    expect(markerOffArrow).toMatchObject({ height: 24, paddingTop: 3 })
    expect(
      await wysiwygHeading.evaluate(
        (element) => getComputedStyle(element, '::before').display,
      ),
    ).toBe('none')
    await frame.locator('body').click({
      position: {
        x: (formerMarker.left + formerMarker.right) / 2,
        y: (formerMarker.top + formerMarker.bottom) / 2,
      },
    })
    await expect.poll(() => foldView(frame)).toMatchObject({ headings: [] })
    await frame.locator('body').click({
      position: {
        x: markerOffArrow.left + markerOffArrow.width / 2,
        y: markerOffArrow.top + markerOffArrow.height / 2,
      },
    })
    await expect
      .poll(() => foldView(frame))
      .toMatchObject({
        headings: [expect.objectContaining({ count: '3' })],
      })
  } finally {
    await evaluateInVSCode(
      async (vscode, [original]) => {
        await vscode.workspace
          .getConfiguration('vmde')
          .update(
            'editor.headingMarkers',
            original === 'unset' ? undefined : original === 'true',
            vscode.ConfigurationTarget.Workspace,
          )
      },
      [originalHeadingMarkers as string] as [string],
    )
  }
  await expect
    .poll(() =>
      frame
        .locator('body')
        .evaluate(() => document.body.dataset.headingMarkers),
    )
    .toBe(originalHeadingMarkers === 'false' ? '0' : '1')
  expect(await getValue(frame)).toBe(baseline)

  await frame
    .locator('body')
    .evaluate(() => new Promise((resolve) => setTimeout(resolve, 400)))
  await evaluateInVSCode(
    async (vscode) => {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors')
    },
    [docPath] as [string],
  )
  await openVmde(evaluateInVSCode, docPath)
  frame = wf(workbox)
  await frame
    .locator('.vditor-ir:visible, .vditor-wysiwyg:visible')
    .first()
    .waitFor({ timeout: 60_000 })
  await expect
    .poll(() => foldView(frame))
    .toMatchObject({
      headings: [expect.objectContaining({ count: '3' })],
    })

  const childLine = CONTENT.split('\n').indexOf('child body')
  await evaluateInVSCode(
    async (vscode, args: [string, number]) => {
      const [file, line] = args
      const uri = vscode.Uri.file(file)
      await vscode.commands.executeCommand('vscode.open', uri, {
        preview: false,
        selection: new vscode.Range(line, 0, line, 0),
      })
      await vscode.commands.executeCommand('vmde.openEditor')
    },
    [docPath, childLine] as [string, number],
  )
  frame = wf(workbox)
  await waitForE2EReadiness(
    frame,
    (state) => state.routerReady && state.editorEpoch > 0,
    { message: 'section-fold source-reveal readiness' },
  )
  await expect.poll(() => foldView(frame)).toMatchObject({ headings: [] })

  await expect
    .poll(() =>
      frame.locator('body').evaluate(() => {
        const inner = (window as any).vditor.vditor
        const root = inner[inner.currentMode].element as HTMLElement
        return Boolean(
          (window as any).__vmdeEnsureFoldTargetVisible &&
            root.querySelector('[data-vmde-list-foldable]'),
        )
      }),
    )
    .toBe(true)
  // The physical chord is covered by the heading fold above. Dispatch locally after the source
  // reveal path so selection and key handling remain in the same webview task for this persistence leg.
  expect(
    await frame.locator('body').evaluate(() => {
      const inner = (window as any).vditor.vditor
      const root = inner[inner.currentMode].element as HTMLElement
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      let parent: Node | null = null
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if ((node.nodeValue ?? '').includes('parent')) {
          parent = node
          break
        }
      }
      if (!parent) return false
      root.focus({ preventScroll: true })
      const range = document.createRange()
      range.setStart(parent, 0)
      range.collapse(true)
      const selection = getSelection()!
      selection.removeAllRanges()
      selection.addRange(range)
      document.dispatchEvent(new Event('selectionchange'))
      document.dispatchEvent(
        new KeyboardEvent('keydown', {
          altKey: true,
          bubbles: true,
          cancelable: true,
          code: 'BracketLeft',
          ctrlKey: true,
        }),
      )
      return true
    }),
  ).toBe(true)
  await expect.poll(() => foldView(frame)).toMatchObject({ lists: 1 })
  expect(await placeText(frame, 'tail paragraph')).toBe(true)
  await expect.poll(() => foldView(frame)).toMatchObject({ lists: 1 })
  expect(await getValue(frame)).toBe(baseline)
  await frame
    .locator('body')
    .evaluate(() => new Promise((resolve) => setTimeout(resolve, 400)))
  await evaluateInVSCode(
    async (vscode) => {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors')
    },
    [docPath] as [string],
  )
  await openVmde(evaluateInVSCode, docPath)
  frame = wf(workbox)
  await frame
    .locator('.vditor-ir:visible, .vditor-wysiwyg:visible')
    .first()
    .waitFor({ timeout: 60_000 })
  await expect.poll(() => foldView(frame)).toMatchObject({ lists: 1 })
  expect(readFileSync(docPath, 'utf8')).toBe(CONTENT)
  expect(await getValue(frame)).toBe(baseline)

  const pointerDocPath = path.join(baseDir, 'section-fold-pointer.md')
  const pointerContent = [
    '- pointer parent',
    '  - pointer nested',
    '    - pointer leaf',
    '  - pointer peer',
    '- pointer sibling',
    '',
    '- [ ] task pointer',
    '    - task child',
  ]
    .join(String.fromCharCode(10))
    .concat('\n')
  await evaluateInVSCode(
    async (vscode) => {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors')
    },
    [docPath] as [string],
  )
  writeFileSync(pointerDocPath, pointerContent)
  await openVmde(evaluateInVSCode, pointerDocPath)
  frame = wf(workbox)
  await frame
    .locator('.vditor-ir:visible, .vditor-wysiwyg:visible')
    .first()
    .waitFor({ timeout: 60_000 })
  await waitForE2EReadiness(
    frame,
    (state) => state.routerReady && state.editorEpoch > 0,
    { message: 'list-fold pointer fixture readiness' },
  )
  await expect.poll(() => listItems(frame).count()).toBe(3)
  // The authored task child has its CommonMark content-column indent. Vditor
  // projects that child at two spaces; host/disk bytes remain the authored source.
  const renderedPointer = await getValue(frame)
  expect(renderedPointer).toBe(
    pointerContent.replace('    - task child', '  - task child'),
  )
  const freshParent = listItem(frame, 'pointer parent')
  const cssSourceParity = await freshParent.evaluate((item) => {
    const editor = (window as any).vditor
    const before = editor.getValue()
    const center = item.style.getPropertyValue(
      '--vmde-list-fold-glyph-center-x',
    )
    const top = item.style.getPropertyValue('--vmde-list-fold-arrow-top')
    item.style.removeProperty('--vmde-list-fold-glyph-center-x')
    item.style.removeProperty('--vmde-list-fold-arrow-top')
    const withoutVariables = editor.getValue()
    item.style.setProperty('--vmde-list-fold-glyph-center-x', center)
    item.style.setProperty('--vmde-list-fold-arrow-top', top)
    return {
      before,
      withoutVariables,
      restored: editor.getValue(),
      center,
      top,
    }
  })
  expect(cssSourceParity.center).not.toBe('')
  expect(cssSourceParity.top).not.toBe('')
  expect(cssSourceParity.before).toBe(renderedPointer)
  expect(cssSourceParity.withoutVariables).toBe(renderedPointer)
  expect(cssSourceParity.restored).toBe(renderedPointer)
  const hostBeforePointer = await evaluateInVSCode(
    async (vscode, args: [string]) =>
      (
        await vscode.workspace.openTextDocument(vscode.Uri.file(args[0]))
      ).getText(),
    [pointerDocPath] as [string],
  )
  expect(hostBeforePointer).toBe(pointerContent)
  const freshNested = listItem(frame, 'pointer nested', true)
  await freshNested.hover()
  const freshHandle = frame.locator('.vmde-block-handle')
  await expect(freshHandle).toBeVisible()
  const [freshParentGeometry, freshNestedGeometry, freshHandleRect] =
    await Promise.all([
      listGutterBox(freshParent),
      listGutterBox(freshNested),
      freshHandle.evaluate((element) => {
        const rect = element.getBoundingClientRect()
        return {
          left: rect.left,
          top: rect.top,
          right: rect.right,
          bottom: rect.bottom,
        }
      }),
    ])
  expect(freshParentGeometry.arrow.content).toBe('""')
  expect(freshParentGeometry.glyph.content).toBe('"▼"')
  expect(freshParentGeometry.glyph.fontSize).toBe('12px')
  expect(
    Math.abs(
      freshParentGeometry.glyph.centerX - freshParentGeometry.symbolCenterX!,
    ),
  ).toBeLessThanOrEqual(1)
  expect(rectanglesOverlap(freshParentGeometry.box, freshHandleRect)).toBe(
    false,
  )
  expect(rectanglesOverlap(freshNestedGeometry.box, freshHandleRect)).toBe(
    false,
  )
  expect(freshParentGeometry.box.left - freshHandleRect.right).toBe(2)
  await freshHandle.click()
  const freshMenu = frame.locator('.vmde-block-handle-menu')
  await expect(freshMenu).toBeVisible()
  expect(await foldView(frame)).toMatchObject({ lists: 0 })
  await freshHandle.click()
  await expect(freshMenu).toBeHidden()
  expect(await getValue(frame)).toBe(renderedPointer)
  await frame.locator('body').evaluate(() => {
    document.addEventListener(
      'click',
      (event) => {
        ;(window as any).__lastListFoldClickTrusted = event.isTrusted
      },
      true,
    )
  })
  await exerciseListPointerMode(frame, 'ir')
  const postNativeClickValue = await getValue(frame)
  if (postNativeClickValue !== renderedPointer) {
    // The nested item may be folded by the preceding pointer sequence; hover
    // the visible source-group owner to check the post-normalization decline.
    await listItem(frame, 'pointer parent').hover()
    await expect(freshHandle).toBeHidden()
  }
  await exerciseListPointerMode(frame, 'wysiwyg')
  await expect.poll(() => foldView(frame)).toMatchObject({ lists: 1 })
  await evaluateInVSCode(
    async (vscode) => {
      await vscode.commands.executeCommand('workbench.action.files.save')
    },
    [pointerDocPath] as [string],
  )
  expect(readFileSync(pointerDocPath, 'utf8')).toBe(pointerContent)
  const hostText = await evaluateInVSCode(
    async (vscode, args: [string]) =>
      (
        await vscode.workspace.openTextDocument(vscode.Uri.file(args[0]))
      ).getText(),
    [pointerDocPath] as [string],
  )
  expect(hostText).toBe(pointerContent)
})
