import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import { docText, waitForE2EReadiness, wf } from './webview-helpers'

test('real editor exposes semantic structure, labels, diagrams, and live updates', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  const DIR = baseDir
  const DOC = path.join(DIR, 'screen-reader.md')
  mkdirSync(path.join(DIR, 'src', 'app'), { recursive: true })
  writeFileSync(path.join(DIR, 'Home.md'), '# Home\n')
  writeFileSync(path.join(DIR, 'src', 'app', 'extension.ts'), 'export {}\n')
  writeFileSync(
    DOC,
    [
      '# Screen reader fixture',
      '',
      'Wiki [[Home]] and code `src/app/extension.ts:1`.',
      '',
      '> [!NOTE] Accessible callout',
      '> callout body',
      '',
      '| A | B |',
      '| --- | --- |',
      '| one | two |',
      '',
      '```mermaid',
      'graph TD',
      '  A --> B',
      '```',
      '',
      '```vega',
      'not valid json',
      '```',
      '',
    ].join('\n'),
  )

  const previousWikiRoot = (await evaluateInVSCode(
    async (vscode) => {
      const config = vscode.workspace.getConfiguration('vmde')
      const prior = config.inspect<string>('wiki.root')?.globalValue ?? null
      await config.update('wiki.root', '', vscode.ConfigurationTarget.Global)
      return JSON.stringify(prior)
    },
    [] as [],
  )) as string

  try {
    await evaluateInVSCode(
      async (vscode, args: [string]) => {
        await vscode.extensions.getExtension('Laicasaane.vmde')?.activate()
        await vscode.commands.executeCommand(
          'vscode.openWith',
          vscode.Uri.file(args[0]),
          'vmde.editor',
        )
      },
      [DOC] as [string],
    )
    const frame = wf(workbox)
    await frame.locator('.vditor-ir').first().waitFor({ timeout: 60_000 })
    await waitForE2EReadiness(
      frame,
      (state) =>
        state.routerReady && state.editorEpoch > 0 && state.mode === 'ir',
      { message: 'screen-reader fixture readiness' },
    )

    const editor = frame.locator('.vditor-ir').first()
    await expect(editor).toHaveAttribute('role', 'textbox')
    await expect(editor).toHaveAttribute('aria-multiline', 'true')
    await expect(editor).toHaveAttribute(
      'aria-label',
      'Markdown editor for screen-reader.md',
    )
    await expect(frame.locator('#vmde-live-region')).toHaveAttribute(
      'aria-live',
      'polite',
    )
    await expect(frame.locator('.vditor-toolbar').first()).toHaveAttribute(
      'role',
      'toolbar',
    )
    await expect(frame.locator('.vditor-outline ul[role="tree"]')).toHaveCount(
      1,
    )
    await expect(editor.locator('table')).toHaveCount(1)

    const wiki = editor.locator('.wiki-link-chip[data-wiki-target="Home"]')
    await expect(wiki).toHaveAttribute('role', 'link')
    await expect(wiki).toHaveAttribute('aria-label', 'Open wiki page Home')
    const codeRef = editor.locator(
      '[data-code-ref="1"][data-code-ref-path="src/app/extension.ts"]',
    )
    await expect(codeRef).toHaveAttribute('role', 'link', { timeout: 20_000 })
    await expect(codeRef).toHaveAttribute(
      'aria-label',
      'Open code reference src/app/extension.ts, line 1',
    )

    const mermaid = frame.locator(
      '.vditor-ir__preview .language-mermaid[data-processed="true"]',
    )
    await expect(mermaid).toHaveAttribute('role', 'figure', {
      timeout: 30_000,
    })
    await expect(mermaid).toHaveAttribute('aria-label', 'Mermaid diagram')
    await expect(mermaid.locator('svg').first()).toHaveAttribute('role', 'img')
    await expect(mermaid.locator('svg').first()).toHaveAttribute(
      'aria-label',
      'Mermaid diagram: graph TD',
    )
    const controls = mermaid.locator('.vmde-diagram-controls')
    await expect(controls).toHaveAttribute('role', 'toolbar')
    await expect(controls.locator('button:not([aria-label])')).toHaveCount(0)

    await expect(frame.locator('.vmde-diagram-error')).toBeVisible({
      timeout: 30_000,
    })
    await expect(frame.locator('#vmde-live-region')).toContainText(
      'diagram error:',
    )

    await frame.locator('body').evaluate(() => {
      const editor = document.querySelector<HTMLElement>('.vditor-ir')!
      const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT)
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!(node.textContent ?? '').includes('callout body')) continue
        const range = document.createRange()
        range.setStart(node, (node.textContent ?? '').length)
        range.collapse(true)
        const selection = getSelection()!
        selection.removeAllRanges()
        selection.addRange(range)
        editor.focus()
        document.dispatchEvent(new Event('selectionchange'))
        return
      }
      throw new Error('callout body not found')
    })
    await workbox.keyboard.press('Control+Enter')
    const callout = frame.locator('.vmde-callout-context-panel')
    await expect(callout).toBeVisible()
    await expect(callout.locator('select')).toHaveAttribute(
      'aria-label',
      'Callout type',
    )
    await expect(callout.locator('input')).toHaveAttribute(
      'aria-label',
      'Callout title',
    )
    await workbox.keyboard.press('Escape')

    await frame.locator('body').evaluate(() => {
      const inner = (window as any).vditor.vditor
      inner.toolbar.elements['edit-mode']?.children[0]?.dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      )
      document
        .querySelector('button[data-mode="wysiwyg"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await waitForE2EReadiness(frame, (state) => state.mode === 'wysiwyg')
    await expect(frame.locator('#vmde-live-region')).toHaveText(
      'Editing mode: WYSIWYG',
      { timeout: 10_000 },
    )

    await frame.locator('body').evaluate(() =>
      (window as any).vscode.postMessage({
        command: 'copy-code',
        content: 'const copied = true',
      }),
    )
    await expect(frame.locator('#vmde-live-region')).toHaveText('Copied code')

    const beforeSave = await docText(evaluateInVSCode, DOC)
    await frame.locator('.vditor-wysiwyg').press('End')
    await workbox.keyboard.type(' saved')
    await expect.poll(() => docText(evaluateInVSCode, DOC)).not.toBe(beforeSave)
    await evaluateInVSCode(
      async (vscode) => {
        await vscode.commands.executeCommand('workbench.action.files.save')
      },
      [] as [],
    )
    await expect(frame.locator('#vmde-live-region')).toHaveText(
      'Saved screen-reader.md',
      { timeout: 15_000 },
    )
    const saved = readFileSync(DOC, 'utf8')
    expect(saved).toContain('[[Home]]')
    expect(saved).toContain('```mermaid')
    expect(saved).not.toContain('aria-')
    expect(saved).not.toContain('vmde-live-region')
  } finally {
    await evaluateInVSCode(
      async (vscode, args: [string]) => {
        const prior = JSON.parse(args[0]) as string | null
        await vscode.workspace
          .getConfiguration('vmde')
          .update(
            'wiki.root',
            prior ?? undefined,
            vscode.ConfigurationTarget.Global,
          )
      },
      [previousWikiRoot] as [string],
    )
  }
})
