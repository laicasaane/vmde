import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import { wf } from './webview-helpers'

const SOURCE = [
  '# Contextual panel fixture',
  '',
  '> plain quote body and more words',
  '',
  Array.from({ length: 60 }, (_, i) => `filler paragraph ${i}`).join('\n\n'),
  '',
  '> [!NOTE]',
  '> body text of the note',
  '',
  'following paragraph',
  '',
  '| A | B |',
  '| --- | --- |',
  '| alpha cell | beta cell |',
  '',
].join('\n')

test('quote panels clear text in a narrow, scrolled real VS Code webview', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(180_000)
  const file = path.join(baseDir, 'contextual-panel-clearance.md')
  writeFileSync(file, SOURCE)
  await evaluateInVSCode(
    async (vscode: typeof import('vscode'), args: [string]) => {
      await vscode.extensions.getExtension('Laicasaane.vmde')?.activate()
      await vscode.commands.executeCommand(
        'vscode.openWith',
        vscode.Uri.file(args[0]),
        'vmde.editor',
      )
    },
    [file] as [string],
  )
  const frame = wf(workbox)
  await frame.locator('.vditor-ir').waitFor({ timeout: 90_000 })
  await workbox.setViewportSize({ width: 760, height: 800 })

  const hostText = () =>
    evaluateInVSCode(
      async (vscode: typeof import('vscode'), args: [string]) =>
        vscode.workspace.textDocuments
          .find((document) => document.uri.fsPath === args[0])
          ?.getText() ?? '',
      [file] as [string],
    ) as Promise<string>

  async function switchMode(mode: 'ir' | 'wysiwyg') {
    await frame.locator('body').evaluate((_body, next) => {
      const inner = (window as any).vditor.vditor
      if (inner.currentMode === next) return
      inner.toolbar.elements['edit-mode']?.children[0]?.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true }),
      )
      document
        .querySelector(`button[data-mode="${next}"]`)
        ?.dispatchEvent(
          new MouseEvent('click', { bubbles: true, cancelable: true }),
        )
    }, mode)
    await expect
      .poll(() =>
        frame
          .locator('body')
          .evaluate(() => (window as any).vditor.vditor.currentMode),
      )
      .toBe(mode)
  }

  async function measure(mode: 'ir' | 'wysiwyg', index: number) {
    const quote = frame.locator(`.vditor-${mode} blockquote`).nth(index)
    await quote.evaluate((element) =>
      element.scrollIntoView({ block: 'center' }),
    )
    if (mode === 'ir' && index === 1) await quote.click({ force: true })
    else await quote.locator(':scope > p').first().click({ force: true })
    await quote.evaluate((element, which) => {
      const p = element.querySelector(':scope > p')!
      ;(element.closest('.vditor-reset') as HTMLElement).focus({
        preventScroll: true,
      })
      const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT)
      let text: Text | null = null
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const host = node.parentElement
        if (
          (node.textContent ?? '').trim() &&
          !host?.closest('.vmde-callout__marker,[contenteditable="false"]') &&
          getComputedStyle(host!).display !== 'none'
        ) {
          text = node as Text
          break
        }
      }
      if (!text) throw new Error('editable quote text not found')
      const range = document.createRange()
      range.setStart(
        text,
        Math.min(which === 0 ? 5 : text.length - 2, text.length),
      )
      range.collapse(true)
      const selection = window.getSelection()!
      selection.removeAllRanges()
      selection.addRange(range)
      ;(window as any).__vmdeRequestCaret?.({
        node: range.startContainer,
        offset: range.startOffset,
      })
      document.dispatchEvent(new Event('selectionchange'))
    }, index)
    const panel =
      mode === 'ir'
        ? frame.locator('.vmde-callout-context-panel')
        : frame.locator('.vditor-wysiwyg > .vditor-panel.vmde-element-panel')
    await expect(panel).toBeVisible()
    const geometry = () =>
      frame.locator('body').evaluate(
        (_body, args) => {
          const R = (element: Element | Range | null) => {
            if (!element) return null
            const rect = element.getBoundingClientRect()
            return {
              left: rect.left,
              right: rect.right,
              top: rect.top,
              bottom: rect.bottom,
            }
          }
          const inner = (window as any).vditor.vditor
          const editor = inner[args.mode].element as HTMLElement
          const quote = editor.querySelectorAll('blockquote')[args.index]
          const panel =
            args.mode === 'ir'
              ? document.querySelector('.vmde-callout-context-panel')
              : inner.wysiwyg.popover
          const selection = window.getSelection()
          const scroller = editor.closest('.vditor-content')
          return {
            quote: R(quote),
            panel: R(panel),
            caret: selection?.rangeCount ? R(selection.getRangeAt(0)) : null,
            scroller: R(scroller),
            toolbar: R(document.querySelector('.vditor-toolbar')),
            viewport: { width: innerWidth, height: innerHeight },
            scrollTop: editor.scrollTop,
          }
        },
        { mode, index },
      )
    await expect
      .poll(
        async () => {
          const g = await geometry()
          if (!g.quote || !g.panel || !g.caret || !g.scroller || !g.toolbar)
            return false
          return (
            g.panel.left >= 8 &&
            g.panel.right <= g.viewport.width - 8 &&
            g.panel.top >= Math.max(g.toolbar.bottom, g.scroller.top) + 8 &&
            g.panel.bottom <= g.scroller.bottom - 8 &&
            (g.panel.bottom <= g.quote.top - 7 ||
              g.panel.top >= g.quote.bottom + 7) &&
            (g.panel.bottom <= g.caret.top || g.panel.top >= g.caret.bottom)
          )
        },
        { message: `${mode} quote ${index} panel clears its owner` },
      )
      .toBe(true)
    return geometry()
  }

  const irPlain = await measure('ir', 0)
  expect(irPlain.viewport.width).toBeLessThanOrEqual(760)
  const irCallout = await measure('ir', 1)
  expect(irCallout.scrollTop).toBeGreaterThan(0)
  const opened = await frame
    .locator('body')
    .evaluate(() => (window as any).__vmdeOpenContextualCalloutControls?.())
  expect(opened).toBe(true)
  const typeControl = frame.locator('.vmde-callout-context-panel select')
  await expect(typeControl).toBeFocused()
  await typeControl.press('Escape')
  await expect(frame.locator('.vditor-ir .vditor-reset')).toBeFocused()
  await switchMode('wysiwyg')
  await measure('wysiwyg', 0)
  const wysCallout = await measure('wysiwyg', 1)
  expect(wysCallout.scrollTop).toBeGreaterThan(0)
  for (const mode of ['ir', 'wysiwyg'] as const) {
    await switchMode(mode)
    const cell = frame.locator(`.vditor-${mode} table td`).first()
    await cell.evaluate((element) =>
      element.scrollIntoView({ block: 'center' }),
    )
    await cell.click()
    const panel =
      mode === 'ir'
        ? frame.locator('#fix-table-ir-wrapper .vditor-panel')
        : frame.locator('.vditor-wysiwyg > .vditor-panel.vmde-element-panel')
    await expect(panel).toBeVisible()
    await expect
      .poll(
        async () => {
          const g = await frame.locator('body').evaluate((_body, next) => {
            const activeCell = document
              .querySelector(`.vditor-${next} table td`)!
              .getBoundingClientRect()
            const control = (
              next === 'ir'
                ? document.querySelector('#fix-table-ir-wrapper .vditor-panel')!
                : (window as any).vditor.vditor.wysiwyg.popover
            ).getBoundingClientRect()
            const toolbar = document
              .querySelector('.vditor-toolbar')!
              .getBoundingClientRect()
            return {
              cell: { top: activeCell.top, bottom: activeCell.bottom },
              panel: {
                left: control.left,
                right: control.right,
                top: control.top,
                bottom: control.bottom,
              },
              toolbarBottom: toolbar.bottom,
              width: innerWidth,
            }
          }, mode)
          return (
            g.panel.left >= 8 &&
            g.panel.right <= g.width - 8 &&
            g.panel.top >= g.toolbarBottom + 8 &&
            (g.panel.bottom <= g.cell.top || g.panel.top >= g.cell.bottom)
          )
        },
        { message: `${mode} table panel leaves its active cell clear` },
      )
      .toBe(true)
  }
  await expect.poll(hostText).toBe(SOURCE)
  await evaluateInVSCode(async (vscode: typeof import('vscode')) => {
    await vscode.commands.executeCommand('workbench.action.files.save')
  })
  expect(readFileSync(file, 'utf8')).toBe(SOURCE)
})
