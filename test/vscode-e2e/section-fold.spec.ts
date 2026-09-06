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
})
