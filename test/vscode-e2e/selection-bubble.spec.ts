import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import { docText, waitForE2EReadiness, wf } from './webview-helpers'

const BEFORE = 'alpha\n\nbeta\n'

test('hidden-toolbar selection bubble formats, transforms, and preserves real host history', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(180_000)
  const file = path.join(baseDir, 'selection-bubble.md')
  writeFileSync(file, BEFORE)
  await evaluateInVSCode(
    async (vscode: typeof import('vscode'), args: [string]) => {
      await vscode.workspace
        .getConfiguration('vmde')
        .update('editor.toolbar', false, vscode.ConfigurationTarget.Global)
      await vscode.workspace
        .getConfiguration('vmde')
        .update(
          'editor.selectionToolbar',
          true,
          vscode.ConfigurationTarget.Global,
        )
      await vscode.extensions.getExtension('Laicasaane.vmde')?.activate()
      await vscode.commands.executeCommand(
        'vscode.openWith',
        vscode.Uri.file(args[0]),
        'vmde.editor',
      )
    },
    [file] as [string],
  )
  try {
    const frame = wf(workbox)
    await frame.locator('.vditor-ir').waitFor({ timeout: 90_000 })
    await waitForE2EReadiness(
      frame,
      (state) => state.routerReady && state.mode === 'ir',
      {
        message: 'selection bubble hidden-toolbar readiness',
      },
    )
    await expect(
      frame.locator('.vditor-toolbar [data-type="bold"]'),
    ).toHaveCount(0)
    await expect
      .poll(() =>
        frame
          .locator('body')
          .evaluate(
            () =>
              (window as any).vditor.vditor.undo.ir.undoStack.length as number,
          ),
      )
      .toBeGreaterThan(0)
    const undoBefore = await frame
      .locator('body')
      .evaluate(
        () => (window as any).vditor.vditor.undo.ir.undoStack.length as number,
      )
    await frame
      .locator('.vditor-ir .vditor-reset > p')
      .first()
      .evaluate((element) => {
        const text = element.firstChild!
        const range = document.createRange()
        range.setStart(text, 0)
        range.setEnd(text, 5)
        const selection = window.getSelection()!
        selection.removeAllRanges()
        selection.addRange(range)
        document.dispatchEvent(new Event('selectionchange'))
      })
    const bubble = frame.locator('.vmde-selection-bubble')
    await expect(bubble).toBeVisible()
    const geometry = await bubble.evaluate((element) => {
      const bubble = element.getBoundingClientRect()
      const range = window.getSelection()!.getRangeAt(0).getBoundingClientRect()
      return {
        bubbleBottom: bubble.bottom,
        bubbleTop: bubble.top,
        selectionTop: range.top,
        selectionBottom: range.bottom,
        insideEditor: Boolean(element.closest('.vditor-reset')),
      }
    })
    expect(geometry.insideEditor).toBe(false)
    expect(
      geometry.bubbleBottom <= geometry.selectionTop ||
        geometry.bubbleTop >= geometry.selectionBottom,
    ).toBe(true)
    await bubble.getByRole('button', { name: 'Bold' }).click()
    const bold = '**alpha**\n\nbeta\n'
    await expect.poll(() => docText(evaluateInVSCode, file)).toBe(bold)
    await expect
      .poll(() =>
        frame
          .locator('body')
          .evaluate(
            () =>
              (window as any).vditor.vditor.undo.ir.undoStack.length as number,
          ),
      )
      .toBeGreaterThan(undoBefore)
    await frame
      .locator('.vditor-ir')
      .first()
      .click({ position: { x: 4, y: 4 } })
    await workbox.keyboard.press('Control+z')
    await expect.poll(() => docText(evaluateInVSCode, file)).toBe(BEFORE)
    await workbox.keyboard.press('Control+y')
    await expect.poll(() => docText(evaluateInVSCode, file)).toBe(bold)
    await evaluateInVSCode(async (vscode: typeof import('vscode')) => {
      await vscode.commands.executeCommand('workbench.action.files.save')
    })
    expect(readFileSync(file, 'utf8')).toBe(bold)
    await frame
      .locator('.vditor-ir .vditor-reset > p')
      .last()
      .evaluate((element) => {
        const text = element.firstChild!
        const range = document.createRange()
        range.setStart(text, 0)
        range.setEnd(text, 4)
        const selection = window.getSelection()!
        selection.removeAllRanges()
        selection.addRange(range)
        document.dispatchEvent(new Event('selectionchange'))
      })
    await expect(bubble).toBeVisible()
    await bubble.getByRole('button', { name: 'Turn Into' }).click()
    const menu = bubble.locator('.vmde-selection-bubble-menu')
    await expect(
      menu.getByRole('menuitemradio', { name: '✓ Paragraph' }),
    ).toHaveAttribute('aria-checked', 'true')
    await menu.getByRole('menuitemradio', { name: 'Heading 2' }).click()
    const transformed = '**alpha**\n\n## beta\n'
    await expect.poll(() => docText(evaluateInVSCode, file)).toBe(transformed)
    await evaluateInVSCode(async (vscode: typeof import('vscode')) => {
      await vscode.commands.executeCommand('workbench.action.files.save')
    })
    expect(readFileSync(file, 'utf8')).toBe(transformed)

    const selectHeadingBeta = async () => {
      await frame
        .locator('.vditor-ir .vditor-reset > [data-block]')
        .last()
        .evaluate((element) => {
          const walker = document.createTreeWalker(
            element,
            NodeFilter.SHOW_TEXT,
          )
          let text: Text | null = null
          for (;;) {
            text = walker.nextNode() as Text | null
            if (!text || text.textContent === 'beta') break
          }
          if (!text) throw new Error('heading beta text missing')
          const range = document.createRange()
          range.setStart(text, 0)
          range.setEnd(text, 4)
          const selection = window.getSelection()!
          selection.removeAllRanges()
          selection.addRange(range)
          document.dispatchEvent(new Event('selectionchange'))
        })
      await expect(bubble).toBeVisible()
    }
    await selectHeadingBeta()
    await bubble.getByRole('button', { name: 'Link', exact: true }).click()
    const linked = '**alpha**\n\n## [beta]()\n'
    await expect.poll(() => docText(evaluateInVSCode, file)).toBe(linked)
    await expect
      .poll(() =>
        frame.locator('body').evaluate(() => {
          const selection = window.getSelection()
          const node = selection?.anchorNode
          const element = node instanceof Element ? node : node?.parentElement
          return Boolean(element?.closest('.vditor-ir__marker--link'))
        }),
      )
      .toBe(true)
    await workbox.keyboard.press('Control+z')
    await expect.poll(() => docText(evaluateInVSCode, file)).toBe(transformed)
    await workbox.keyboard.press('Control+y')
    await expect.poll(() => docText(evaluateInVSCode, file)).toBe(linked)
    await evaluateInVSCode(async (vscode: typeof import('vscode')) => {
      await vscode.commands.executeCommand('workbench.action.files.save')
    })
    expect(readFileSync(file, 'utf8')).toBe(linked)

    await workbox.keyboard.press('Control+z')
    await expect.poll(() => docText(evaluateInVSCode, file)).toBe(transformed)
    await selectHeadingBeta()
    await bubble.getByRole('button', { name: 'Wiki Link' }).click()
    const wiki = '**alpha**\n\n## [[beta]]\n'
    await expect.poll(() => docText(evaluateInVSCode, file)).toBe(wiki)
    await workbox.keyboard.press('Control+z')
    await expect.poll(() => docText(evaluateInVSCode, file)).toBe(transformed)
    await workbox.keyboard.press('Control+y')
    await expect.poll(() => docText(evaluateInVSCode, file)).toBe(wiki)
    await evaluateInVSCode(async (vscode: typeof import('vscode')) => {
      await vscode.commands.executeCommand('workbench.action.files.save')
    })
    expect(readFileSync(file, 'utf8')).toBe(wiki)
  } finally {
    await evaluateInVSCode(async (vscode: typeof import('vscode')) => {
      await vscode.workspace
        .getConfiguration('vmde')
        .update('editor.toolbar', undefined, vscode.ConfigurationTarget.Global)
      await vscode.workspace
        .getConfiguration('vmde')
        .update(
          'editor.selectionToolbar',
          undefined,
          vscode.ConfigurationTarget.Global,
        )
    })
  }
})

test('selection bubble stays anchored on a long scrolled document and hides for IME and Preview', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(180_000)
  const file = path.join(baseDir, 'selection-bubble-scroll.md')
  const before = `${Array.from(
    { length: 180 },
    (_, index) =>
      `Paragraph ${index} carries enough ordinary prose to make this document scroll.`,
  ).join('\n\n')}\n\nFinal target text\n`
  writeFileSync(file, before)
  await evaluateInVSCode(
    async (vscode: typeof import('vscode'), args: [string]) => {
      await vscode.workspace
        .getConfiguration('vmde')
        .update('editor.toolbar', true, vscode.ConfigurationTarget.Global)
      await vscode.workspace
        .getConfiguration('vmde')
        .update(
          'editor.selectionToolbar',
          true,
          vscode.ConfigurationTarget.Global,
        )
      await vscode.extensions.getExtension('Laicasaane.vmde')?.activate()
      await vscode.commands.executeCommand(
        'vscode.openWith',
        vscode.Uri.file(args[0]),
        'vmde.editor',
      )
    },
    [file] as [string],
  )
  try {
    const frame = wf(workbox)
    await frame.locator('.vditor-ir').waitFor({ timeout: 90_000 })
    await waitForE2EReadiness(
      frame,
      (state) => state.routerReady && state.mode === 'ir',
      { message: 'scrolled selection bubble readiness' },
    )
    const target = frame.locator('.vditor-ir .vditor-reset > p').last()
    await target.evaluate((element) => {
      element.scrollIntoView({ block: 'center' })
      const text = element.firstChild!
      const range = document.createRange()
      range.setStart(text, 6)
      range.setEnd(text, 12)
      const selection = window.getSelection()!
      selection.removeAllRanges()
      selection.addRange(range)
      document.dispatchEvent(new Event('selectionchange'))
    })
    const bubble = frame.locator('.vmde-selection-bubble')
    await expect(bubble).toBeVisible()
    const beforeGeometry = await bubble.evaluate((element) => {
      const editor = document.querySelector<HTMLElement>(
        '.vditor-ir .vditor-reset',
      )!
      let scroller: HTMLElement = editor
      while (
        scroller !== document.body &&
        scroller.scrollHeight <= scroller.clientHeight + 1
      )
        scroller = scroller.parentElement!
      const rect = element.getBoundingClientRect()
      const selected = window
        .getSelection()!
        .getRangeAt(0)
        .getBoundingClientRect()
      return {
        scrollTop: scroller.scrollTop,
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
        selectionTop: selected.top,
        selectionBottom: selected.bottom,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
      }
    })
    expect(beforeGeometry.scrollTop).toBeGreaterThan(0)
    expect(beforeGeometry.left).toBeGreaterThanOrEqual(0)
    expect(beforeGeometry.right).toBeLessThanOrEqual(
      beforeGeometry.viewportWidth,
    )
    expect(beforeGeometry.top).toBeGreaterThanOrEqual(0)
    expect(beforeGeometry.bottom).toBeLessThanOrEqual(
      beforeGeometry.viewportHeight,
    )
    expect(
      beforeGeometry.bottom <= beforeGeometry.selectionTop ||
        beforeGeometry.top >= beforeGeometry.selectionBottom,
    ).toBe(true)
    await bubble.getByRole('button', { name: 'Bold' }).click()
    await expect
      .poll(() => docText(evaluateInVSCode, file))
      .toBe(before.replace('target', '**target**'))
    const afterScroll = await target.evaluate((element) => {
      let scroller = element.parentElement as HTMLElement
      while (
        scroller !== document.body &&
        scroller.scrollHeight <= scroller.clientHeight + 1
      )
        scroller = scroller.parentElement!
      return scroller.scrollTop
    })
    expect(Math.abs(afterScroll - beforeGeometry.scrollTop)).toBeLessThan(5)

    await frame
      .locator('.vditor-ir .vditor-reset > p')
      .nth(178)
      .evaluate((element) => {
        element.scrollIntoView({ block: 'center' })
        const text = element.firstChild!
        const range = document.createRange()
        range.setStart(text, 0)
        range.setEnd(text, 9)
        const selection = window.getSelection()!
        selection.removeAllRanges()
        selection.addRange(range)
        document.dispatchEvent(new Event('selectionchange'))
      })
    await expect(bubble).toBeVisible()
    await frame
      .locator('body')
      .evaluate(() =>
        document.dispatchEvent(
          new CompositionEvent('compositionstart', { bubbles: true }),
        ),
      )
    await expect(bubble).toBeHidden()
    await frame.locator('body').evaluate(() => {
      document.dispatchEvent(
        new CompositionEvent('compositionend', { bubbles: true }),
      )
      document.dispatchEvent(new Event('selectionchange'))
    })
    await expect(bubble).toBeVisible()
    await frame.locator('.vditor-toolbar [data-type="preview"]').click()
    await expect(frame.locator('.vditor-preview')).toBeVisible()
    await expect(bubble).toBeHidden()
  } finally {
    await evaluateInVSCode(async (vscode: typeof import('vscode')) => {
      await vscode.workspace
        .getConfiguration('vmde')
        .update('editor.toolbar', undefined, vscode.ConfigurationTarget.Global)
      await vscode.workspace
        .getConfiguration('vmde')
        .update(
          'editor.selectionToolbar',
          undefined,
          vscode.ConfigurationTarget.Global,
        )
    })
  }
})

test('selection bubble setting off keeps visual selections unadorned', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  const file = path.join(baseDir, 'selection-bubble-off.md')
  const before = 'alpha\n\nbeta\n'
  writeFileSync(file, before)
  await evaluateInVSCode(
    async (vscode: typeof import('vscode'), args: [string]) => {
      await vscode.workspace
        .getConfiguration('vmde')
        .update(
          'editor.selectionToolbar',
          false,
          vscode.ConfigurationTarget.Global,
        )
      await vscode.extensions.getExtension('Laicasaane.vmde')?.activate()
      await vscode.commands.executeCommand(
        'vscode.openWith',
        vscode.Uri.file(args[0]),
        'vmde.editor',
      )
    },
    [file] as [string],
  )
  try {
    const frame = wf(workbox)
    await frame.locator('.vditor-ir').waitFor({ timeout: 90_000 })
    await waitForE2EReadiness(
      frame,
      (state) => state.routerReady && state.mode === 'ir',
      { message: 'selection bubble setting off readiness' },
    )
    await frame
      .locator('.vditor-ir .vditor-reset > p')
      .first()
      .evaluate((element) => {
        const range = document.createRange()
        range.setStart(element.firstChild!, 0)
        range.setEnd(element.firstChild!, 5)
        const selection = window.getSelection()!
        selection.removeAllRanges()
        selection.addRange(range)
        document.dispatchEvent(new Event('selectionchange'))
      })
    await expect(frame.locator('.vmde-selection-bubble')).toBeHidden()
    expect(await docText(evaluateInVSCode, file)).toBe(before)
  } finally {
    await evaluateInVSCode(async (vscode: typeof import('vscode')) => {
      await vscode.workspace
        .getConfiguration('vmde')
        .update(
          'editor.selectionToolbar',
          undefined,
          vscode.ConfigurationTarget.Global,
        )
    })
  }
})

test('hidden-toolbar WYSIWYG bubble formats and links through exact host history', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(180_000)
  const file = path.join(baseDir, 'selection-bubble-wysiwyg.md')
  const before = 'alpha\n\nbeta\n'
  writeFileSync(file, before)
  await evaluateInVSCode(
    async (vscode: typeof import('vscode'), args: [string]) => {
      const config = vscode.workspace.getConfiguration('vmde')
      await config.update(
        'editor.defaultMode',
        'wysiwyg',
        vscode.ConfigurationTarget.Global,
      )
      await config.update(
        'editor.toolbar',
        false,
        vscode.ConfigurationTarget.Global,
      )
      await config.update(
        'editor.selectionToolbar',
        true,
        vscode.ConfigurationTarget.Global,
      )
      await vscode.extensions.getExtension('Laicasaane.vmde')?.activate()
      await vscode.commands.executeCommand(
        'vscode.openWith',
        vscode.Uri.file(args[0]),
        'vmde.editor',
      )
    },
    [file] as [string],
  )
  try {
    const frame = wf(workbox)
    await frame.locator('.vditor-wysiwyg').waitFor({ timeout: 90_000 })
    await waitForE2EReadiness(
      frame,
      (state) => state.routerReady && state.mode === 'wysiwyg',
      { message: 'hidden-toolbar WYSIWYG bubble readiness' },
    )
    await expect(
      frame.locator('.vditor-toolbar [data-type="italic"]'),
    ).toHaveCount(0)
    const selectParagraph = async (
      index: number,
      length: number,
      expected: string,
    ) => {
      const paragraph = frame
        .locator('.vditor-wysiwyg .vditor-reset > p')
        .nth(index)
      await paragraph.click()
      await paragraph.evaluate((element, selectedLength) => {
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
        let text: Text | null = null
        for (;;) {
          text = walker.nextNode() as Text | null
          if (!text || text.data.length >= selectedLength) break
        }
        if (!text) throw new Error('WYSIWYG selection text missing')
        const range = document.createRange()
        range.setStart(text, 0)
        range.setEnd(text, selectedLength)
        const selection = window.getSelection()!
        selection.removeAllRanges()
        selection.addRange(range)
        document.dispatchEvent(new Event('selectionchange'))
      }, length)
      await expect
        .poll(() =>
          frame
            .locator('body')
            .evaluate(() => window.getSelection()?.toString()),
        )
        .toBe(expected)
    }
    const bubble = frame.locator('.vmde-selection-bubble')
    await selectParagraph(0, 5, 'alpha')
    await expect(bubble).toBeVisible()
    await bubble.getByRole('button', { name: 'Italic' }).click()
    const italic = '*alpha*\n\nbeta\n'
    await expect.poll(() => docText(evaluateInVSCode, file)).toBe(italic)
    await selectParagraph(1, 4, 'beta')
    await expect(bubble).toBeVisible()
    await bubble.getByRole('button', { name: 'Link', exact: true }).click()
    const linked = '*alpha*\n\n[beta]()\n'
    await expect.poll(() => docText(evaluateInVSCode, file)).toBe(linked)
    await frame.locator('.vditor-wysiwyg').click({ position: { x: 4, y: 4 } })
    await workbox.keyboard.press('Control+z')
    await expect.poll(() => docText(evaluateInVSCode, file)).toBe(italic)
    await workbox.keyboard.press('Control+y')
    await expect.poll(() => docText(evaluateInVSCode, file)).toBe(linked)
    await evaluateInVSCode(async (vscode: typeof import('vscode')) => {
      await vscode.commands.executeCommand('workbench.action.files.save')
    })
    expect(readFileSync(file, 'utf8')).toBe(linked)
  } finally {
    await evaluateInVSCode(async (vscode: typeof import('vscode')) => {
      const config = vscode.workspace.getConfiguration('vmde')
      await config.update(
        'editor.defaultMode',
        undefined,
        vscode.ConfigurationTarget.Global,
      )
      await config.update(
        'editor.toolbar',
        undefined,
        vscode.ConfigurationTarget.Global,
      )
      await config.update(
        'editor.selectionToolbar',
        undefined,
        vscode.ConfigurationTarget.Global,
      )
    })
  }
})
