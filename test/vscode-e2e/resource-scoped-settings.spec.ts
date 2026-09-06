import { wf } from './webview-helpers'
// Task 295 in the REAL editor: per-FOLDER settings. VS Code only honours a folder-level
// `.vscode/settings.json` override when the property declares `"scope": "resource"` AND the read
// passes the document's URI. Before 295 only 7 properties (css.*/image.*) did both; every theme.*/
// editor.*/outline.*/diagram.* read went through a non-scoped getConfiguration('vmde'), so a user
// could write a valid folder override and have it silently ignored — no error, nothing happens.
//
// A MULTI-ROOT workspace is what makes this test discriminate at all. In a single-folder workspace,
// `.vscode/settings.json` is workspace scope and a NON-scoped read sees it too — the spec would pass
// with the bug still present. With two roots pinning different values, only a URI-aware read can
// answer differently for the two documents. Hence the `.code-workspace` baseDir below.
//
// The two editors are opened one at a time (close, then open) rather than side by side: the
// frameLocator would otherwise match two `iframe.webview` elements, and the point being proven is
// per-document resolution, not simultaneity.
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'

const ROOTS = path.join(__dirname, 'fixtures', 'scoped-roots')

// `baseDir` is passed to VS Code as its final launch argument, so a `.code-workspace` path opens a
// real multi-root workspace instead of a single folder.
test.use({ baseDir: path.join(ROOTS, 'two-roots.code-workspace') })

// EVERY content theme is emitted as a `<link id="ct-…">` and all but the active one carry
// `disabled` (html-builder.ts buildContentThemeLinks) — so the resolved theme is the one link that
// is NOT disabled, not simply the first markdown-themes href. Reading the first href instead makes
// this spec report github-light for every document regardless of settings.
async function activeThemeId(workbox: import('@playwright/test').Page) {
  return wf(workbox)
    .locator('body')
    .evaluate(
      () =>
        [...document.querySelectorAll('link[id^="ct-"]')]
          .filter((l) => !(l as HTMLLinkElement).disabled)
          .map((l) => l.id)
          .join(',') || null,
    )
}

test('two workspace roots resolve their own theme.content for their own documents', async ({
  workbox,
  evaluateInVSCode,
}) => {
  test.setTimeout(120_000)
  // The workspace-level value both roots would inherit WITHOUT a folder override. If a read is not
  // URI-aware it lands here (or on the user setting) for both documents — which is the bug.
  const seen: Record<string, string | null> = {}

  for (const [root, file] of [
    ['docs', 'guide.md'],
    ['notes', 'scratch.md'],
  ]) {
    await evaluateInVSCode(
      async (vscode: typeof import('vscode'), args: string[]) => {
        await vscode.extensions.getExtension('Laicasaane.vmde')?.activate()
        await vscode.commands.executeCommand(
          'vscode.openWith',
          vscode.Uri.file(args[0]),
          'vmde.editor',
        )
      },
      [path.join(ROOTS, root, file)] as [string],
    )
    await wf(workbox).locator('.vditor-ir').first().waitFor({ timeout: 60_000 })
    await expect
      .poll(() => activeThemeId(workbox), { timeout: 30_000 })
      .not.toBeNull()
    seen[root] = await activeThemeId(workbox)
    await evaluateInVSCode(async (vscode: typeof import('vscode')) => {
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor')
    })
    // Wait for the webview element to actually go away. Without this the next iteration's
    // frameLocator resolves against the PREVIOUS editor's iframe (which is still in the DOM for a
    // moment) and silently re-reads the first root's theme — the failure mode that made an early
    // version of this spec report github-light for both roots.
    await expect
      .poll(() => workbox.locator('iframe.webview').count(), {
        timeout: 30_000,
      })
      .toBe(0)
  }

  expect(
    seen.docs,
    'docs/ pins github-light in its own .vscode/settings.json',
  ).toBe('ct-github-light')
  expect(
    seen.notes,
    'notes/ pins material-dark in its own .vscode/settings.json',
  ).toBe('ct-material-dark')
})
