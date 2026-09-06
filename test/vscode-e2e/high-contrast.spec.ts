import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import { waitForE2EReadiness, wf } from './webview-helpers'

test('live workbench flip applies the real high-contrast kind, chrome, and diagram palette', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(120_000)
  const docPath = path.join(baseDir, 'high-contrast.md')
  writeFileSync(
    docPath,
    [
      '# High contrast',
      '',
      '> [!NOTE]',
      '> Visible callout.',
      '',
      '| A | B |',
      '| --- | --- |',
      '| one | two |',
      '',
      '```graphviz',
      'digraph { a -> b }',
      '```',
      '',
    ].join('\n'),
  )

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

  await setTheme('Default Dark Modern')
  try {
    await evaluateInVSCode(
      async (vscode: typeof import('vscode'), args: [string]) => {
        await vscode.extensions.getExtension('Laicasaane.vmde')?.activate()
        await vscode.commands.executeCommand(
          'vscode.openWith',
          vscode.Uri.file(args[0]),
          'vmde.editor',
        )
      },
      [docPath] as [string],
    )

    const frame = wf(workbox)
    await frame.locator('.vditor-ir').first().waitFor({ timeout: 60_000 })
    await waitForE2EReadiness(
      frame,
      (state) => state.routerReady && state.editorEpoch > 0,
    )
    await frame
      .locator('.language-graphviz svg')
      .first()
      .waitFor({ timeout: 60_000 })
    await expect(frame.locator('body')).not.toHaveClass(/vscode-high-contrast/)

    await setTheme('Default High Contrast')
    await expect(frame.locator('body')).toHaveClass(
      /(?:^|\s)vscode-high-contrast(?:\s|$)/,
      { timeout: 30_000 },
    )
    await frame.locator('.language-graphviz').first().scrollIntoViewIfNeeded()

    await expect
      .poll(
        async () =>
          frame.locator('body').evaluate(() => {
            const rootStyle = getComputedStyle(document.documentElement)
            const contrast = rootStyle
              .getPropertyValue('--vscode-contrastBorder')
              .trim()
              .slice(0, 7)
              .toLowerCase()
            const probe = document.createElement('span')
            probe.style.color = contrast
            document.body.append(probe)
            const contrastRgb = getComputedStyle(probe).color
            probe.remove()
            const cell = document.querySelector<HTMLElement>(
              '.vditor-ir .vditor-reset td',
            )
            const callout = document.querySelector<HTMLElement>(
              '.vditor-ir .vditor-reset blockquote[data-callout]',
            )
            const control = document.querySelector<HTMLElement>(
              '.language-graphviz .vmde-diagram-controls button',
            )
            control?.focus()
            const strokes = Array.from(
              document.querySelectorAll('.language-graphviz svg [stroke]'),
              (node) => node.getAttribute('stroke')?.toLowerCase(),
            ).filter(Boolean)
            return (
              contrast.length === 7 &&
              cell != null &&
              getComputedStyle(cell).borderColor === contrastRgb &&
              callout != null &&
              getComputedStyle(callout).borderLeftColor === contrastRgb &&
              control != null &&
              getComputedStyle(control).outlineWidth === '3px' &&
              strokes.includes(contrast)
            )
          }),
        { timeout: 30_000, intervals: [250, 500, 1000] },
      )
      .toBe(true)

    const final = await frame.locator('body').evaluate(() => {
      const rootStyle = getComputedStyle(document.documentElement)
      const contrast = rootStyle
        .getPropertyValue('--vscode-contrastBorder')
        .trim()
        .slice(0, 7)
        .toLowerCase()
      const probe = document.createElement('span')
      probe.style.color = contrast
      document.body.append(probe)
      const contrastRgb = getComputedStyle(probe).color
      probe.remove()
      const cell = document.querySelector<HTMLElement>(
        '.vditor-ir .vditor-reset td',
      )!
      const callout = document.querySelector<HTMLElement>(
        '.vditor-ir .vditor-reset blockquote[data-callout]',
      )!
      const strokes = Array.from(
        document.querySelectorAll('.language-graphviz svg [stroke]'),
        (node) => node.getAttribute('stroke')?.toLowerCase(),
      ).filter(Boolean)
      return {
        contrast,
        contrastRgb,
        cellBorder: getComputedStyle(cell).borderColor,
        calloutBorder: getComputedStyle(callout).borderLeftColor,
        strokes,
      }
    })
    expect(final.cellBorder).toBe(final.contrastRgb)
    expect(final.calloutBorder).toBe(final.contrastRgb)
    expect(final.strokes).toContain(final.contrast)
  } finally {
    await setTheme('Default Dark Modern')
  }
})
