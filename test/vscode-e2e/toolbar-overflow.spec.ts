import path from 'node:path'
import { writeFileSync } from 'node:fs'
import { expect, test } from 'vscode-test-playwright'
import { reopenVmdeFixture, wf } from './webview-helpers'

const FIXTURE = path.join(__dirname, 'fixtures', 'sample.md')

test('responsive two-row toolbar restores overflow by keyboard', async ({
  workbox,
  evaluateInVSCode,
}) => {
  await evaluateInVSCode(async (vscode, uri) => {
    await vscode.extensions.getExtension('Laicasaane.vmde')?.activate()
    await vscode.commands.executeCommand(
      'vscode.openWith',
      vscode.Uri.file(uri),
      'vmde.editor',
    )
  }, FIXTURE)

  const frame = wf(workbox)
  const toolbar = frame.locator('.vditor-toolbar')
  await expect(toolbar).toBeVisible({ timeout: 45_000 })
  // The sidebar + activity bar eat a fixed slice of the window, so without closing the sidebar a
  // 360px window leaves the webview at width 0 — measured — and the overflow correctly refuses to
  // decide there (the hidden-tab guard). Close it so the window width maps to a real webview width:
  // 700px window ≈ 350px webview, 1400px ≈ 1050px.
  await evaluateInVSCode(async (vscode) => {
    await vscode.commands.executeCommand('workbench.action.closeSidebar')
    await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar')
  })
  await workbox.setViewportSize({ width: 700, height: 800 })
  await expect(
    toolbar.locator(
      '.vmde-toolbar-more > .vditor-hint > .vditor-toolbar__item[data-vmde-overflow="true"]',
    ),
  ).not.toHaveCount(0, { timeout: 10_000 })
  const geometry = await toolbar.evaluate((el) => {
    const toolbarRect = el.getBoundingClientRect()
    const rect = (node: Element) => {
      const box = (node as HTMLElement).getBoundingClientRect()
      return {
        left: box.left,
        top: box.top,
        right: box.right,
        bottom: box.bottom,
      }
    }
    const rows = Array.from(
      el.querySelectorAll<HTMLElement>(':scope > .vmde-toolbar-row'),
    ).map((row) => ({
      row: rect(row),
      controls: Array.from(
        row.querySelectorAll<HTMLElement>(
          ':scope > .vditor-toolbar__item > [data-type]',
        ),
      )
        .filter((button) => getComputedStyle(button).display !== 'none')
        .map((button) => ({ name: button.dataset.type, rect: rect(button) })),
    }))
    const more = el.querySelector<HTMLElement>(
      '.vmde-toolbar-more > [data-type="more"]',
    )
    return {
      toolbar: rect(el),
      pageScrollWidth: document.documentElement.scrollWidth,
      pageClientWidth: document.documentElement.clientWidth,
      rows,
      more: more ? rect(more) : null,
      toolbarRect,
    }
  })
  expect(geometry.rows).toHaveLength(2)
  expect(geometry.pageScrollWidth).toBeLessThanOrEqual(geometry.pageClientWidth)
  expect(geometry.more).not.toBeNull()
  expect(geometry.more!.left).toBeGreaterThanOrEqual(geometry.toolbar.left)
  expect(geometry.more!.right).toBeLessThanOrEqual(geometry.toolbar.right)
  // Measure buttons, not the old union of buttons and decorative dividers. A visible control may
  // touch its neighbour, but their painted hit areas must never intersect in either toolbar row.
  for (const { controls } of geometry.rows) {
    for (let index = 1; index < controls.length; index++) {
      expect(controls[index - 1].rect.right).toBeLessThanOrEqual(
        controls[index].rect.left,
      )
    }
  }
  const narrow = await toolbar.evaluate((toolbarEl) => {
    const more = toolbarEl.querySelector(
      '.vmde-toolbar-more > .vditor-hint',
    ) as HTMLElement
    const moreItem = toolbarEl.querySelector(
      '.vmde-toolbar-more',
    ) as HTMLElement
    return {
      rowCount: toolbarEl.querySelectorAll(':scope > .vmde-toolbar-row').length,
      hasOverflow: Boolean(more.querySelector('[data-vmde-overflow="true"]')),
      primary: ['emoji', 'undo', 'redo'].map((name) => ({
        name,
        direct: Boolean(
          toolbarEl.querySelector(
            `:scope > .vmde-toolbar-row > .vditor-toolbar__item > [data-type="${name}"]`,
          ),
        ),
        inMore: Boolean(more.querySelector(`[data-type="${name}"]`)),
      })),
      overflowTabbable: [...more.querySelectorAll('button')].some(
        (button) => button.tabIndex === 0,
      ),
      moreHasPopup: moreItem
        .querySelector(':scope > [data-type]')
        ?.getAttribute('aria-haspopup'),
      // Vditor's own ≤520px rule bumps every item to `padding: 0 12px` exactly when space runs out
      // (index.css:492-494). This asserts our override wins INSIDE the real webview iframe, where
      // the media query resolves against the iframe width rather than the VS Code window.
      moreItemPadding: getComputedStyle(moreItem).paddingLeft,
      // Vditor kills tooltips at the same breakpoint (index.css:249-253); we re-enable them.
      tooltipContent: getComputedStyle(
        toolbarEl.querySelector(
          ':scope > .vmde-toolbar-row > .vditor-toolbar__item > .vditor-tooltipped',
        ) as HTMLElement,
        '::after',
      ).content,
    }
  })
  expect(narrow.rowCount).toBe(2)
  expect(narrow.hasOverflow).toBe(true)
  expect(narrow.primary).toEqual([
    { name: 'emoji', direct: true, inMore: false },
    { name: 'undo', direct: true, inMore: false },
    { name: 'redo', direct: true, inMore: false },
  ])
  expect(narrow.overflowTabbable).toBe(true)
  expect(narrow.moreHasPopup).toBe('menu')
  expect(narrow.moreItemPadding).toBe('0px')
  expect(narrow.tooltipContent).not.toBe('none')
  await toolbar.locator('[data-type="more"]').click()
  await expect(
    toolbar.locator(
      '.vmde-toolbar-more [data-vmde-overflow="true"] [data-type] svg > path',
    ),
  ).not.toHaveCount(0)

  await workbox.setViewportSize({ width: 1400, height: 800 })
  await expect(
    toolbar.locator(
      '.vditor-hint > .vditor-toolbar__item[data-vmde-overflow="true"]',
    ),
  ).toHaveCount(0, { timeout: 10_000 })
  const order = await toolbar
    .locator(':scope > .vmde-toolbar-row > .vditor-toolbar__item')
    .evaluateAll((items) =>
      items
        .map((item) =>
          item.querySelector(':scope > [data-type]')?.getAttribute('data-type'),
        )
        .filter(Boolean),
    )
  expect(order.indexOf('headings')).toBeLessThan(order.indexOf('bold'))
  expect(order.indexOf('bold')).toBeLessThan(order.indexOf('emoji'))

  await expect(toolbar.locator('[data-type="line"]')).toHaveAttribute(
    'aria-label',
    /Horizontal Rule/,
  )
  await expect(toolbar.locator('[data-type="ordered-list"]')).toHaveAttribute(
    'aria-label',
    /Numbered List/,
  )
  await expect(toolbar.locator('[data-type="redo"]')).toHaveAttribute(
    'aria-label',
    /Shift\+Ctrl\/Cmd\+Z/,
  )
  await expect(toolbar.locator('[data-type="edit-in-vscode"] svg')).toHaveCSS(
    'width',
    '16px',
  )
  await expect(toolbar.locator('[data-type="edit-in-vscode"] svg')).toHaveCSS(
    'height',
    '16px',
  )
  await toolbar.locator('[data-type="more"]').click()
  const morePanel = toolbar.locator('.vmde-toolbar-more > .vditor-hint')
  await expect(morePanel).toBeVisible()
  await expect(morePanel.locator('[data-type="settings"]')).toHaveText(
    'Settings',
  )
  await expect(morePanel.locator('[data-type="info"]')).toHaveText(
    'About Vditor',
  )
  await expect(morePanel.locator('[data-type="about"]')).toHaveText(
    'About VMDE',
  )
})

test('two toolbar rows survive edit-mode and Preview transitions without losing the visible anchor', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(120_000)
  const docPath = path.join(baseDir, 'two-row-toolbar-modes.md')
  writeFileSync(
    docPath,
    Array.from(
      { length: 180 },
      (_, index) => `Paragraph ${index + 1} — toolbar viewport anchor`,
    ).join('\n\n'),
  )
  await evaluateInVSCode(async (vscode, uri) => {
    await vscode.extensions.getExtension('Laicasaane.vmde')?.activate()
    await vscode.commands.executeCommand(
      'vscode.openWith',
      vscode.Uri.file(uri),
      'vmde.editor',
    )
    await vscode.commands.executeCommand('workbench.action.closeSidebar')
    await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar')
  }, docPath)

  const frame = wf(workbox)
  const toolbar = frame.locator('.vditor-toolbar')
  await expect(toolbar).toBeVisible({ timeout: 45_000 })
  await workbox.setViewportSize({ width: 1400, height: 800 })

  const rowState = () =>
    toolbar.evaluate((element) => {
      const rows = Array.from(
        element.querySelectorAll<HTMLElement>(':scope > .vmde-toolbar-row'),
      ).map((row) => row.getBoundingClientRect())
      return {
        rows: rows.length,
        separated: rows.length === 2 && rows[0].bottom <= rows[1].top,
      }
    })
  const expectTwoRows = async () => {
    await expect.poll(rowState).toEqual({ rows: 2, separated: true })
  }
  await expectTwoRows()

  const irAnchor = await frame.locator('body').evaluate(() => {
    const pane = document.querySelector('.vditor-ir') as HTMLElement
    let scroller = pane.querySelector('pre.vditor-reset') as HTMLElement
    while (scroller.parentElement) {
      const overflowY = getComputedStyle(scroller).overflowY
      if (
        (overflowY === 'auto' ||
          overflowY === 'scroll' ||
          overflowY === 'overlay') &&
        scroller.scrollHeight > scroller.clientHeight + 1
      )
        break
      scroller = scroller.parentElement
    }
    scroller.scrollTop = 1200
    if (scroller.scrollTop === 0) throw new Error('IR scroller did not move')
    scroller.dispatchEvent(new Event('scroll'))
    const paneRect = pane.getBoundingClientRect()
    return Array.from(pane.querySelectorAll('p')).find((paragraph) => {
      const rect = paragraph.getBoundingClientRect()
      return rect.bottom > paneRect.top && rect.top < paneRect.bottom
    })?.textContent
  })
  expect(irAnchor).toContain('toolbar viewport anchor')
  await frame
    .locator('body')
    .evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)))

  const liveAnchor = await frame
    .locator('body')
    .evaluate((_body, anchor: string) => {
      const inner = (window as any).vditor?.vditor
      const editor = inner?.[inner?.currentMode]?.element as
        | HTMLElement
        | undefined
      if (!editor || inner?.currentMode !== 'ir') return false
      let scroller = editor
      while (scroller.parentElement) {
        const overflowY = getComputedStyle(scroller).overflowY
        if (
          (overflowY === 'auto' ||
            overflowY === 'scroll' ||
            overflowY === 'overlay') &&
          scroller.scrollHeight > scroller.clientHeight + 1
        )
          break
        scroller = scroller.parentElement
      }
      const viewport = scroller.getBoundingClientRect()
      return Array.from(editor.querySelectorAll('p')).some((paragraph) => {
        const rect = paragraph.getBoundingClientRect()
        return (
          paragraph.textContent === anchor &&
          rect.bottom > viewport.top &&
          rect.top < viewport.bottom
        )
      })
    }, irAnchor!)
  expect(liveAnchor).toBe(true)

  // Use the live toolbar gesture rather than calling Vditor's mode setter so this covers the
  // menu ownership and row wiring that users exercise.
  await toolbar.locator('[data-type="edit-mode"]').click()
  await expect(toolbar.locator('button[data-mode="wysiwyg"]')).toBeVisible()
  const irAnchorAfterMenu = await frame
    .locator('body')
    .evaluate((_body, anchor: string) => {
      const pane = document.querySelector('.vditor-ir') as HTMLElement
      const paneRect = pane.getBoundingClientRect()
      return Array.from(pane.querySelectorAll('p')).some((paragraph) => {
        const rect = paragraph.getBoundingClientRect()
        return (
          paragraph.textContent === anchor &&
          rect.bottom > paneRect.top &&
          rect.top < paneRect.bottom
        )
      })
    }, irAnchor!)
  expect(irAnchorAfterMenu).toBe(true)
  await toolbar.locator('button[data-mode="wysiwyg"]').click()
  await expect(frame.locator('.vditor-wysiwyg')).toBeVisible()
  await expectTwoRows()
  const wysiwygAnchor = () =>
    frame.locator('body').evaluate((_body, anchor: string) => {
      const pane = document.querySelector('.vditor-wysiwyg') as HTMLElement
      const paneRect = pane.getBoundingClientRect()
      const blocks = Array.from(
        pane.querySelectorAll<HTMLElement>('[data-block], p'),
      )
      const visible = blocks.filter((block) => {
        const rect = block.getBoundingClientRect()
        return rect.bottom > paneRect.top && rect.top < paneRect.bottom
      })
      let scroller: HTMLElement = pane
      while (
        scroller.parentElement &&
        scroller.scrollHeight <= scroller.clientHeight
      )
        scroller = scroller.parentElement
      return {
        visible: visible.some((block) => block.textContent?.trim() === anchor),
        firstVisible: visible[0]?.textContent?.trim(),
        scrollTop: scroller.scrollTop,
        scrollHeight: scroller.scrollHeight,
        clientHeight: scroller.clientHeight,
      }
    }, irAnchor!)
  await frame
    .locator('body')
    .evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)))
  expect((await wysiwygAnchor()).visible).toBe(true)
  await expect.poll(wysiwygAnchor).toMatchObject({ visible: true })

  // Use Vditor's real mode shortcut here as well: this covers the capture-phase selection path
  // for a keyboard action after the pointer-driven IR→WYSIWYG menu journey above.
  await workbox.keyboard.press('Alt+Control+9')
  await expect(frame.locator('.vditor-sv')).toBeVisible()
  await expect(frame.locator('.vditor-preview')).toBeVisible()
  await expectTwoRows()
  const svSeparatorState = await toolbar.evaluate((element) => {
    const rows = Array.from(
      element.querySelectorAll<HTMLElement>(':scope > .vmde-toolbar-row'),
    )
    const isVisibleAction = (child: Element) => {
      const item = child as HTMLElement
      const name = item
        .querySelector(':scope > [data-type]')
        ?.getAttribute('data-type')
      return (
        item.classList.contains('vditor-toolbar__item') &&
        name !== 'more' &&
        getComputedStyle(item).display !== 'none'
      )
    }
    return {
      hidden: [
        'outdent',
        'indent',
        'outline',
        'insert-before',
        'insert-after',
      ].every(
        (name) =>
          getComputedStyle(
            element.querySelector(`[data-type="${name}"]`)
              ?.parentElement as HTMLElement,
          ).display === 'none',
      ),
      dangling: rows.some((row) => {
        const children = Array.from(row.children)
        return children.some((child, index) => {
          if (!child.classList.contains('vditor-toolbar__divider')) return false
          if (getComputedStyle(child).display === 'none') return false
          return (
            !children.slice(0, index).some(isVisibleAction) ||
            !children.slice(index + 1).some(isVisibleAction)
          )
        })
      }),
    }
  })
  expect(svSeparatorState.hidden).toBe(true)
  expect(svSeparatorState.dangling).toBe(false)

  await toolbar.locator('[data-type="preview"]').click()
  await expect(frame.locator('.vditor-preview')).toBeVisible()
  await expectTwoRows()
  await expect(toolbar.locator('[data-type="bold"]')).toHaveClass(
    /vditor-menu--disabled/,
  )
  await toolbar.locator('[data-type="preview"]').click()
  await expect(frame.locator('.vditor-sv')).toBeVisible()
  await expectTwoRows()

  const liveToolbarHeight = await toolbar.evaluate(
    (element) => element.getBoundingClientRect().height,
  )
  await evaluateInVSCode(async (vscode) => {
    await vscode.workspace
      .getConfiguration('vmde')
      .update('editor.toolbar', false, vscode.ConfigurationTarget.Global)
  })
  await expect
    .poll(() => toolbar.evaluate((element) => element.childElementCount))
    .toBe(0)
  await evaluateInVSCode(async (vscode) => {
    await vscode.workspace
      .getConfiguration('vmde')
      .update('editor.toolbar', true, vscode.ConfigurationTarget.Global)
  })
  await expectTwoRows()
  expect(
    await toolbar.evaluate((element) => element.getBoundingClientRect().height),
  ).toBeGreaterThanOrEqual(liveToolbarHeight)
})

test('direct Undo and Redo keep their complete tooltips and apply host-document history steps', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(120_000)
  const docPath = path.join(baseDir, 'undo-toolbar-overflow.md')
  const marker = 'UNDO-TOOLBAR-MARKER'
  writeFileSync(docPath, 'Undo toolbar anchor\n')
  await evaluateInVSCode(async (vscode, uri) => {
    await vscode.extensions.getExtension('Laicasaane.vmde')?.activate()
    await vscode.commands.executeCommand(
      'vscode.openWith',
      vscode.Uri.file(uri),
      'vmde.editor',
    )
  }, docPath)

  const frame = wf(workbox)
  const toolbar = frame.locator('.vditor-toolbar')
  await expect(toolbar).toBeVisible({ timeout: 45_000 })
  await expect(frame.locator('.vditor-ir').first()).toContainText(
    'Undo toolbar anchor',
  )
  const docText = () =>
    evaluateInVSCode(
      async (vscode: typeof import('vscode'), args: [string]) =>
        vscode.workspace.textDocuments
          .find((document) => document.uri.fsPath === args[0])
          ?.getText() ?? '',
      [docPath] as [string],
    ) as Promise<string>

  // Vditor records its opening snapshot on the same debounce as a typed edit. Wait for that
  // observable stack entry before typing, so the next entry and toolbar click belong to this
  // test's marker rather than initialisation.
  const undoStackLength = () =>
    frame.locator('body').evaluate(() => {
      const inner = (window as unknown as { vditor: { vditor: any } }).vditor
        .vditor
      return inner.undo[inner.currentMode].undoStack.length
    })
  await expect.poll(undoStackLength).toBeGreaterThan(0)
  const initialUndoStackLength = await undoStackLength()
  await frame
    .locator('.vditor-ir')
    .first()
    .click({ position: { x: 4, y: 4 } })
  await frame.locator('body').evaluate(() => {
    const paragraph = document.querySelector('.vditor-ir p')
    const text = paragraph?.lastChild
    if (!(text instanceof Text))
      throw new Error('Undo toolbar anchor not found')
    const range = document.createRange()
    range.setStart(text, text.data.length)
    range.collapse(true)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    ;(paragraph as HTMLElement).focus()
  })
  await workbox.keyboard.type(marker)
  await expect.poll(docText, { timeout: 20_000 }).toContain(marker)
  await expect.poll(undoStackLength).toBeGreaterThan(initialUndoStackLength)

  await evaluateInVSCode(async (vscode) => {
    await vscode.commands.executeCommand('workbench.action.closeSidebar')
  })
  await workbox.setViewportSize({ width: 500, height: 800 })
  const undo = toolbar.locator(
    ':scope > .vmde-toolbar-row > .vditor-toolbar__item > [data-type="undo"]',
  )
  const redo = toolbar.locator(
    ':scope > .vmde-toolbar-row > .vditor-toolbar__item > [data-type="redo"]',
  )
  await expect(
    toolbar.locator(
      '.vmde-toolbar-more [data-type="undo"], .vmde-toolbar-more [data-type="redo"]',
    ),
  ).toHaveCount(0)
  await expect(undo).toHaveAttribute('aria-label', 'Undo (Ctrl+Z)')
  await expect(redo).toHaveAttribute('aria-label', 'Redo (Shift+Ctrl/Cmd+Z)')
  await undo.hover()
  await expect
    .poll(() =>
      undo.evaluate((element) => getComputedStyle(element, '::after').content),
    )
    .toBe('"Undo (Ctrl+Z)"')
  await undo.click()
  await expect.poll(docText, { timeout: 20_000 }).not.toContain(marker)
  await redo.hover()
  await expect
    .poll(() =>
      redo.evaluate((element) => getComputedStyle(element, '::after').content),
    )
    .toBe('"Redo (Shift+Ctrl/Cmd+Z)"')
  await redo.click()
  await expect.poll(docText, { timeout: 20_000 }).toContain(marker)
})

test('direct Emoji stays usable in an actual narrow editor-group split', async ({
  workbox,
  evaluateInVSCode,
}) => {
  await evaluateInVSCode(async (vscode, uri) => {
    await vscode.extensions.getExtension('Laicasaane.vmde')?.activate()
    await vscode.commands.executeCommand(
      'vscode.openWith',
      vscode.Uri.file(uri),
      'vmde.editor',
    )
  }, FIXTURE)

  const frame = wf(workbox)
  const toolbar = frame.locator('.vditor-toolbar')
  await expect(toolbar).toBeVisible({ timeout: 45_000 })
  await evaluateInVSCode(async (vscode) => {
    await vscode.commands.executeCommand('workbench.action.closeSidebar')
    await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar')
    await vscode.commands.executeCommand('workbench.action.splitEditorRight')
  })
  // Splitting keeps both custom-editor webviews mounted. The newly active right-hand editor is the
  // last webview iframe, so scope the rest of this interaction to that concrete editor group.
  const splitFrame = workbox
    .locator('iframe.webview')
    .last()
    .contentFrame()
    .frameLocator('iframe[title="VMDE"], #active-frame')
  const splitToolbar = splitFrame.locator('.vditor-toolbar')
  await expect(splitToolbar).toBeVisible({ timeout: 10_000 })
  await workbox.setViewportSize({ width: 500, height: 800 })
  const emoji = splitToolbar.locator(
    ':scope > .vmde-toolbar-row > .vditor-toolbar__item > [data-type="emoji"]',
  )
  await expect(
    splitToolbar.locator('.vmde-toolbar-more [data-type="emoji"]'),
  ).toHaveCount(0)
  await emoji.click()
  const emojiPanel = emoji.locator('..').locator('.vditor-panel')
  await expect(emojiPanel).toBeVisible()
  const box = await emojiPanel.boundingBox()
  expect(box).not.toBeNull()
  const viewport = workbox.viewportSize()
  expect(box!.x).toBeGreaterThanOrEqual(0)
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport!.width)
})

// Task 492 Phase 5: aria-haspopup/aria-expanded + menu semantics for the toolbar's other three
// submenu triggers, and `upload` as a real button. Kept in its OWN test() rather than appended to
// the one above: that test already opens/closes `more` mid-run, and this phase's verification must
// not be coupled to an unrelated pre-existing flake in that interaction (see the task file's Phase 5
// section — reproduces identically with every Phase 5 file reverted, so it predates this phase). The
// chromium harness (media-src/e2e/toolbar-overflow.spec.ts) covers open/close + keyboard-nav in
// depth; this is the mandatory real-webview smoke check, in the real CSP/custom-editor pipeline.
test('emoji/headings/edit-mode advertise their popup and menu semantics; upload is a real button', async ({
  workbox,
  evaluateInVSCode,
}) => {
  await evaluateInVSCode(async (vscode, uri) => {
    await vscode.extensions.getExtension('Laicasaane.vmde')?.activate()
    await vscode.commands.executeCommand(
      'vscode.openWith',
      vscode.Uri.file(uri),
      'vmde.editor',
    )
  }, FIXTURE)

  const frame = wf(workbox)
  const toolbar = frame.locator('.vditor-toolbar')
  await expect(toolbar).toBeVisible({ timeout: 45_000 })
  await evaluateInVSCode(async (vscode) => {
    await vscode.commands.executeCommand('workbench.action.closeSidebar')
  })
  await workbox.setViewportSize({ width: 1400, height: 800 })

  for (const name of ['headings', 'edit-mode']) {
    const button = toolbar.locator(`[data-type="${name}"]`)
    await expect(button).toHaveAttribute('aria-haspopup', 'menu')
    await expect(button).toHaveAttribute('aria-expanded', 'false')
  }
  const emojiButton = toolbar.locator('[data-type="emoji"]')
  await expect(emojiButton).toHaveAttribute('aria-haspopup', 'dialog')
  await expect(emojiButton).toHaveAttribute('aria-expanded', 'false')
  await frame.locator('body').evaluate(() => {
    const panel = document.querySelector('.vmde-emoji-picker') as HTMLElement
    const entries: string[] = []
    ;(window as any).__vmdeEmojiStyleTrace = entries
    new MutationObserver(() => entries.push(panel.style.display)).observe(
      panel,
      {
        attributes: true,
        attributeFilter: ['style'],
      },
    )
  })
  await emojiButton.focus()
  // workbox.keyboard targets the focused Electron window, exercising the real VS Code input path
  // rather than a synthetic DOM click inside the webview iframe.
  await workbox.keyboard.press('Space')
  const emojiPanel = toolbar.locator('.vmde-emoji-picker')
  await expect(emojiPanel.locator('input[type="search"]')).toBeFocused()
  await expect(emojiPanel.locator('.vmde-emoji-picker__tile')).not.toHaveCount(
    0,
  )
  await expect(emojiButton).toHaveAttribute('aria-expanded', 'true')
  const trace = await frame
    .locator('body')
    .evaluate(() => (window as any).__vmdeEmojiStyleTrace as string[])
  expect(trace).toEqual(['block'])
  await emojiPanel.locator('input[type="search"]').press('Escape')
  await expect(emojiButton).toHaveAttribute('aria-expanded', 'false')
  await toolbar.locator('[data-type="headings"]').click()
  const headingsPanel = toolbar.locator(
    '.vditor-toolbar__item:has(> [data-type="headings"]) > .vditor-hint',
  )
  await expect(headingsPanel).toBeVisible()
  await expect(headingsPanel).toHaveAttribute('role', 'menu')
  await expect(headingsPanel.locator('[data-tag="h1"]')).toHaveAttribute(
    'role',
    'menuitem',
  )

  // `upload` is a real <button> (esbuild-shared.mjs's patchUploadTagName/patchUploadHiddenInput —
  // MenuItem.ts's div exception dropped, the file input moved to a hidden sibling instead of nested
  // inside it), verified here in the real webview's CSP/custom-editor pipeline, including that it
  // still opens a real OS file picker.
  const uploadButton = toolbar.locator('[data-type="upload"]')
  await expect(uploadButton).toHaveJSProperty('tagName', 'BUTTON')
  await expect(uploadButton.locator('input[type="file"]')).toHaveCount(0)
  const hiddenUploadInput = toolbar.locator(
    '.vditor-toolbar__item:has(> [data-type="upload"]) > input[type="file"]',
  )
  await expect(hiddenUploadInput).toHaveCount(1)
  await expect(hiddenUploadInput).toBeHidden()

  const chooserPromise = workbox.waitForEvent('filechooser')
  await uploadButton.click()
  const chooser = await chooserPromise
  expect(chooser).toBeTruthy()
})

test('Emoji 17 pointer selection saves, reopens, and has one undo/redo step', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  const file = path.join(baseDir, 'emoji-17-transaction.md')
  writeFileSync(file, 'replace this\n')
  const text = () =>
    evaluateInVSCode(
      async (vscode, uri) =>
        (
          await vscode.workspace.openTextDocument(vscode.Uri.file(uri))
        ).getText(),
      file,
    )
  const frame = await reopenVmdeFixture(evaluateInVSCode, workbox, file)
  const toolbar = frame.locator('.vditor-toolbar')
  await expect(toolbar).toBeVisible({ timeout: 45_000 })
  await expect
    .poll(() =>
      frame
        .locator('body')
        .evaluate(() => Boolean((window as any).vditor?.vditor?.lute)),
    )
    .toBe(true)
  await expect
    .poll(() =>
      frame.locator('body').evaluate(() => (window as any).vditor.getValue()),
    )
    .toBe('replace this\n')
  await frame.locator('body').evaluate(() => {
    const inner = (window as any).vditor.vditor
    const editor = inner[inner.currentMode].element as HTMLElement
    const range = document.createRange()
    range.selectNodeContents(editor)
    const selection = getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))
  })
  await toolbar.locator('[data-type="emoji"]').click()
  const picker = toolbar.locator('.vmde-emoji-picker')
  await expect(picker).toBeVisible()
  await expect(picker.locator('.vmde-emoji-picker__tile')).not.toHaveCount(0)
  await expect(picker.locator('input[type="search"]')).toBeFocused()
  await picker.locator('input[type="search"]').fill('distorted face')
  await expect(picker.locator('input[type="search"]')).toHaveValue(
    'distorted face',
  )
  await expect(picker.locator('.vmde-emoji-picker__tile')).toHaveCount(1)
  await picker.locator('.vmde-emoji-picker__tile').click()
  await expect
    .poll(() =>
      frame.locator('body').evaluate(() => (window as any).vditor.getValue()),
    )
    .toBe('🫪\n')
  await expect.poll(text).toBe('🫪\n')
  await expect(toolbar.locator('[data-type="undo"]')).not.toHaveClass(
    /vditor-menu--disabled/,
  )
  await toolbar.locator('[data-type="undo"]').click()
  await expect.poll(text).toBe('replace this\n')
  await toolbar.locator('[data-type="redo"]').click()
  await expect.poll(text).toBe('🫪\n')
  await evaluateInVSCode(async (vscode) => {
    await vscode.commands.executeCommand('workbench.action.files.save')
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor')
  })
  await evaluateInVSCode(
    async (vscode, uri) =>
      vscode.commands.executeCommand(
        'vscode.openWith',
        vscode.Uri.file(uri),
        'vmde.editor',
      ),
    file,
  )
  await expect.poll(text).toBe('🫪\n')
  await expect(toolbar).toBeVisible({ timeout: 45_000 })
  await frame.locator('body').evaluate(() => {
    const inner = (window as any).vditor.vditor
    const editor = inner[inner.currentMode].element as HTMLElement
    const range = document.createRange()
    range.selectNodeContents(editor)
    range.collapse(false)
    const selection = getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))
  })
  const emojiButton = toolbar.locator('[data-type="emoji"]')
  await emojiButton.focus()
  await workbox.keyboard.press('Space')
  await expect(picker.locator('input[type="search"]')).toBeFocused()
  const recent = picker.locator(
    '[data-emoji-grid="recent"] .vmde-emoji-picker__tile',
  )
  await expect(recent).toHaveCount(1)
  await workbox.keyboard.press('ArrowDown')
  await expect(recent).toBeFocused()
  await workbox.keyboard.press('Space')
  // The collapsed source caret remains in the current paragraph; picker insertion is literal and
  // must not synthesize a new Markdown block or trailing newline.
  await expect.poll(text).toBe('🫪🫪\n')
  await toolbar.locator('[data-type="undo"]').click()
  await expect.poll(text).toBe('🫪\n')
  await toolbar.locator('[data-type="redo"]').click()
  await expect.poll(text).toBe('🫪🫪\n')
})

test('Emoji picker keeps transparent fallback tiles through live light, dark, and high-contrast themes', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(120_000)
  const file = path.join(baseDir, 'emoji-picker-visual.md')
  writeFileSync(file, 'Emoji 17 fallback: 🫪\n')
  const setTheme = (name: string) =>
    evaluateInVSCode(
      async (vscode: typeof import('vscode'), args: [string]) => {
        await vscode.workspace
          .getConfiguration('vmde')
          .update('theme.content', 'auto', vscode.ConfigurationTarget.Global)
        await vscode.workspace
          .getConfiguration('workbench')
          .update('colorTheme', args[0], vscode.ConfigurationTarget.Global)
      },
      [name] as [string],
    )

  await setTheme('Default Light Modern')
  try {
    const frame = await reopenVmdeFixture(evaluateInVSCode, workbox, file)
    const toolbar = frame.locator('.vditor-toolbar')
    await expect(toolbar).toBeVisible({ timeout: 45_000 })
    await toolbar.locator('[data-type="emoji"]').click()
    const picker = toolbar.locator('.vmde-emoji-picker')
    const search = picker.locator('input[type="search"]')
    await expect(search).toBeFocused()
    await search.fill('distorted face')
    const tile = picker.getByRole('button', { name: 'distorted face' })
    await expect(tile).toBeVisible()

    const triggerAndPanel = await toolbar
      .locator('[data-type="emoji"]')
      .evaluate((trigger) => {
        const panel = document.querySelector('.vmde-emoji-picker')!
        const triggerBox = trigger.getBoundingClientRect()
        const panelBox = panel.getBoundingClientRect()
        return {
          intersects:
            triggerBox.left < panelBox.right &&
            triggerBox.right > panelBox.left &&
            triggerBox.top < panelBox.bottom &&
            triggerBox.bottom > panelBox.top,
          after: getComputedStyle(trigger, '::after').display,
          before: getComputedStyle(trigger, '::before').display,
        }
      })
    expect(triggerAndPanel).toEqual({
      intersects: false,
      after: 'none',
      before: 'none',
    })

    const searchLayout = await picker
      .locator('.vmde-emoji-picker__search')
      .evaluate((header) => {
        const input = header.querySelector('input')!.getBoundingClientRect()
        const clear = header.querySelector('button')!.getBoundingClientRect()
        const inputStyle = getComputedStyle(header.querySelector('input')!)
        return {
          sameRow: Math.abs(input.top - clear.top) < 1,
          clearAfterInput: clear.left >= input.right,
          inputOpacity: inputStyle.opacity,
          inputPosition: inputStyle.position,
          usableInputWidth: input.width > 100,
        }
      })
    expect(searchLayout).toEqual({
      sameRow: true,
      clearAfterInput: true,
      inputOpacity: '1',
      inputPosition: 'static',
      usableInputWidth: true,
    })

    const inspect = () =>
      tile.evaluate((button) => {
        const style = getComputedStyle(button)
        return {
          background: style.backgroundColor,
          font: style.fontFamily,
          outlineStyle: style.outlineStyle,
          outlineWidth: style.outlineWidth,
        }
      })
    expect((await inspect()).background).toBe('rgba(0, 0, 0, 0)')
    expect((await inspect()).font).toContain('VMDE Emoji 17')
    await picker.screenshot({ path: '/tmp/vmde-emoji-picker-light.png' })

    await setTheme('Default Dark Modern')
    await expect(frame.locator('body')).toHaveClass(/vscode-dark/, {
      timeout: 30_000,
    })
    await expect(search).toBeFocused()
    expect((await inspect()).background).toBe('rgba(0, 0, 0, 0)')
    await picker.screenshot({ path: '/tmp/vmde-emoji-picker-dark.png' })

    await setTheme('Default High Contrast')
    await expect(frame.locator('body')).toHaveClass(/vscode-high-contrast/, {
      timeout: 30_000,
    })
    await tile.focus()
    await expect.poll(inspect, { timeout: 30_000 }).toMatchObject({
      background: 'rgba(0, 0, 0, 0)',
      outlineStyle: 'solid',
      // VS Code's high-contrast stylesheet deliberately promotes the picker rule's 2px
      // focus outline to its 3px accessibility minimum; assert the real effective surface.
      outlineWidth: '3px',
    })
    await picker.screenshot({
      path: '/tmp/vmde-emoji-picker-high-contrast.png',
    })
  } finally {
    await setTheme('Default Dark Modern')
  }
})

test('Emoji selection replaces a plain-JavaScript WYSIWYG code source range', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(120_000)
  const file = path.join(baseDir, 'emoji-wysiwyg-code-source.md')
  const original = 'before\n\n```js\nreplace\n```\n\nafter\n'
  writeFileSync(file, original)
  const frame = await reopenVmdeFixture(evaluateInVSCode, workbox, file)
  const toolbar = frame.locator('.vditor-toolbar')
  await expect(toolbar).toBeVisible({ timeout: 45_000 })
  await expect
    .poll(() =>
      frame
        .locator('body')
        .evaluate(() => Boolean((window as any).vditor?.vditor?.lute)),
    )
    .toBe(true)
  await expect
    .poll(() =>
      frame.locator('body').evaluate(() => (window as any).vditor.getValue()),
    )
    .toBe(original)

  // Switch through Vditor's real edit-mode control, then enter the editable code source rather
  // than selecting the identical data-render preview subtree.
  await frame.locator('body').evaluate(() => {
    const inner = (window as any).vditor.vditor
    inner.toolbar.elements['edit-mode']?.children[0]?.dispatchEvent(
      new MouseEvent('click', { bubbles: true }),
    )
    document
      .querySelector<HTMLButtonElement>('button[data-mode="wysiwyg"]')
      ?.click()
  })
  await expect
    .poll(() =>
      frame
        .locator('body')
        .evaluate(() => (window as any).vditor.getCurrentMode()),
    )
    .toBe('wysiwyg')
  await frame.locator('.vditor-wysiwyg__preview code.language-js').click()
  const source = frame.locator('pre.vditor-wysiwyg__pre > code.language-js')
  await expect(source).toBeVisible()
  const sourceRange = await source.evaluate((code) => {
    const text = Array.from(code.childNodes).find(
      (node): node is Text =>
        node.nodeType === Node.TEXT_NODE &&
        node.textContent?.includes('replace') === true,
    )
    if (!text) throw new Error('WYSIWYG code source text was not available')
    const start = text.data.indexOf('replace')
    const range = document.createRange()
    range.setStart(text, start)
    range.setEnd(text, start + 'replace'.length)
    const selection = getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))
    return {
      text: range.toString(),
      sourceOwner: code.contains(range.startContainer),
    }
  })
  expect(sourceRange).toEqual({ text: 'replace', sourceOwner: true })

  await toolbar.locator('[data-type="emoji"]').click()
  const picker = toolbar.locator('.vmde-emoji-picker')
  await expect(picker).toBeVisible()
  await expect(picker.locator('.vmde-emoji-picker__tile')).not.toHaveCount(0)
  await picker.getByRole('button', { name: 'distorted face' }).click()
  await expect
    .poll(() =>
      frame.locator('body').evaluate(() => (window as any).vditor.getValue()),
    )
    .toBe('before\n\n```js\n🫪\n```\n\nafter\n')
})

for (const [mode, targets] of [
  ['ir', ['prose-ir', 'inline-ir', 'code-ir']],
  ['wysiwyg', ['prose-wys', 'inline-wys', 'code-wys']],
  ['sv', ['prose-sv', 'inline-sv', 'code-sv']],
] as const) {
  test(`Emoji picker preserves exact prose, inline-code, and code-block transactions in ${mode}`, async ({
    workbox,
    evaluateInVSCode,
    baseDir,
  }) => {
    test.setTimeout(180_000)
    const file = path.join(baseDir, 'emoji-all-mode-source-matrix.md')
    const original =
      'IR-PROSE prose-ir\n\nIR inline `inline-ir`\n\n```js\ncode-ir\n```\n\nWYS-PROSE prose-wys\n\nWYS inline `inline-wys`\n\n```js\ncode-wys\n```\n\nSV-PROSE prose-sv\n\nSV inline `inline-sv`\n\n```js\ncode-sv\n```\n'
    writeFileSync(file, original)
    const text = () =>
      evaluateInVSCode(
        async (vscode, uri) =>
          (
            await vscode.workspace.openTextDocument(vscode.Uri.file(uri))
          ).getText(),
        file,
      )
    const frame = await reopenVmdeFixture(evaluateInVSCode, workbox, file)
    const toolbar = frame.locator('.vditor-toolbar')
    await expect(toolbar).toBeVisible({ timeout: 45_000 })
    await expect
      .poll(() =>
        frame
          .locator('body')
          .evaluate(() => Boolean((window as any).vditor?.vditor?.lute)),
      )
      .toBe(true)

    const switchMode = async (mode: 'ir' | 'wysiwyg' | 'sv') => {
      const current = await frame
        .locator('body')
        .evaluate(() => (window as any).vditor.getCurrentMode())
      if (current === mode) return
      await expect
        .poll(() =>
          frame
            .locator('body')
            .evaluate(() => (window as any).vditor.getValue()),
        )
        .toBe(original)
      // Vditor can lose the first edit-mode click after initial render even when the controls are
      // present; this is the documented pre-click settle from block-fidelity, not a picker delay.
      await frame
        .locator('body')
        .evaluate(() => new Promise((resolve) => setTimeout(resolve, 1500)))
      await toolbar.locator('[data-type="edit-mode"]').click()
      await frame.locator(`button[data-mode="${mode}"]`).click()
      await expect
        .poll(() =>
          frame
            .locator('body')
            .evaluate(() => (window as any).vditor.getCurrentMode()),
        )
        .toBe(mode)
    }

    const selectExactSource = async (
      mode: 'ir' | 'wysiwyg' | 'sv',
      needle: string,
      codeBlock: boolean,
    ) => {
      if (codeBlock && mode === 'wysiwyg') {
        const preview = frame
          .locator('.vditor-wysiwyg__preview code')
          .filter({ hasText: needle })
        await preview.click()
        await expect(
          frame
            .locator('pre.vditor-wysiwyg__pre > code')
            .filter({ hasText: needle }),
        ).toBeVisible()
      }
      const selected = await frame.locator('body').evaluate(
        // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one in-webview mapper distinguishes the three Vditor source DOM shapes without duplicating a mode-specific helper.
        (_body, { currentMode, text, useCodeSource }) => {
          const outer = (window as any).vditor
          const editor = outer.vditor[currentMode].element as HTMLElement
          const codeSelector =
            currentMode === 'wysiwyg'
              ? 'pre.vditor-wysiwyg__pre > code'
              : 'pre.vditor-ir__marker--pre > code'
          const source = useCodeSource
            ? (Array.from(
                editor.querySelectorAll<HTMLElement>(codeSelector),
              ).find((code) => code.textContent?.includes(text)) ??
              (currentMode === 'sv' ? editor : null))
            : editor
          if (!source) return null
          editor.focus({ preventScroll: true })
          const walker = document.createTreeWalker(source, NodeFilter.SHOW_TEXT)
          let node = walker.nextNode() as Text | null
          while (node) {
            const start = node.data.indexOf(text)
            if (start >= 0) {
              const range = document.createRange()
              range.setStart(node, start)
              range.setEnd(node, start + text.length)
              const selection = getSelection()
              selection?.removeAllRanges()
              selection?.addRange(range)
              outer.vditor[currentMode].range = range.cloneRange()
              document.dispatchEvent(new Event('selectionchange'))
              return {
                text: range.toString(),
                source: source.contains(range.startContainer),
              }
            }
            node = walker.nextNode() as Text | null
          }
          return null
        },
        { currentMode: mode, text: needle, useCodeSource: codeBlock },
      )
      expect(selected).toEqual({ text: needle, source: true })
    }

    let expected = original
    await switchMode(mode)
    for (const [index, target] of targets.entries()) {
      await selectExactSource(mode, target, index === 2)
      const before = expected
      expected = before.replace(target, '🫪')
      await toolbar.locator('[data-type="emoji"]').click()
      const picker = toolbar.locator('.vmde-emoji-picker')
      await expect(picker).toBeVisible()
      await picker
        .locator('[data-emoji-grid="catalog"]')
        .getByRole('button', { name: 'distorted face' })
        .click()
      await expect
        .poll(() =>
          frame
            .locator('body')
            .evaluate(
              () =>
                (
                  (window as any).__vmdeE2EExactMarkdown as
                    | (() => string)
                    | undefined
                )?.() ?? (window as any).vditor.getValue(),
            ),
        )
        .toBe(expected)
      await expect.poll(text).toBe(expected)
      await toolbar.locator('[data-type="undo"]').click()
      await expect.poll(text).toBe(before)
      await toolbar.locator('[data-type="redo"]').click()
      await expect.poll(text).toBe(expected)
    }
    await evaluateInVSCode(async (vscode) => {
      await vscode.commands.executeCommand('workbench.action.files.save')
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor')
    })
    await evaluateInVSCode(
      async (vscode, uri) =>
        vscode.commands.executeCommand(
          'vscode.openWith',
          vscode.Uri.file(uri),
          'vmde.editor',
        ),
      file,
    )
    await expect.poll(text).toBe(expected)
    await expect
      .poll(() =>
        frame
          .locator('body')
          .evaluate(() => Boolean((window as any).vditor?.vditor?.lute)),
      )
      .toBe(true)
    await expect
      .poll(() =>
        frame
          .locator('body')
          .evaluate(
            () =>
              (
                (window as any).__vmdeE2EExactMarkdown as
                  | (() => string)
                  | undefined
              )?.() ?? (window as any).vditor.getValue(),
          ),
      )
      .toBe(expected)
  })
}
