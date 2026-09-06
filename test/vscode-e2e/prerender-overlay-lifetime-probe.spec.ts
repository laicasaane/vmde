import { wf } from './webview-helpers'
// @probe — measurement only, asserts nothing (task 449 convention).
//
// Task 415 asks whether the prerender teaser and the inline-init payload should be aligned. The
// byte measurement (tmp/measure-415.mjs) answers half of it: the teaser is a FIXED ~79 KB of HTML
// for any document over the 10 KB prefix cap, and the whole document rendered for anything under
// it. What bytes cannot answer is whether that teaser is worth anything for a small document — if
// the inline-init payload boots Vditor synchronously, the overlay may be replaced so fast that
// nobody ever sees it, which would make it pure cost.
//
// So: how long is the overlay actually up, for a small (inline-init fires) vs a large (it does not)
// document? Both in one boot.
import { test } from 'vscode-test-playwright'

test('@probe how long the prerender overlay is actually visible', async ({
  workbox,
  evaluateInVSCode,
}) => {
  test.setTimeout(180_000)

  // Written into the harness temp dir so nothing lands in the repo.
  const sizes = await evaluateInVSCode(
    async (vscode: typeof import('vscode')) => {
      const BLOCK =
        '## Section\n\nSome prose long enough to be representative, with a [link](https://example.com)\nand `inline code`.\n\n- one\n- two\n\n```ts\nconst x: number = 1\n```\n\n'
      const docOf = (n: number) => {
        let s = ''
        while (s.length < n) s += BLOCK
        return s.slice(0, n)
      }
      const dir = vscode.workspace.workspaceFolders?.[0]?.uri
      if (!dir) return []
      const out: Array<{ label: string; path: string }> = []
      for (const [label, n] of [
        ['small-5kb', 5_000],
        ['band-50kb', 50_000],
        ['large-200kb', 200_000],
      ] as Array<[string, number]>) {
        const uri = vscode.Uri.joinPath(dir, `${label}.md`)
        await vscode.workspace.fs.writeFile(uri, Buffer.from(docOf(n), 'utf8'))
        out.push({ label, path: uri.fsPath })
      }
      return out
    },
  )

  const results: Record<string, unknown> = {}
  for (const { label, path: p } of sizes as Array<{
    label: string
    path: string
  }>) {
    await evaluateInVSCode(
      async (vscode: typeof import('vscode'), args: string[]) => {
        await vscode.extensions.getExtension('Laicasaane.vmde')?.activate()
        await vscode.commands.executeCommand(
          'vscode.openWith',
          vscode.Uri.file(args[0]),
          'vmde.editor',
        )
      },
      [p] as [string],
    )
    const frame = wf(workbox)
    // Poll from the earliest moment the frame is reachable: how long until #vmde-prerender is
    // gone, and was it ever seen at all?
    const seen = await frame.locator('body').evaluate(() => {
      const t0 = performance.now()
      return new Promise<{ everSeen: boolean; goneAfterMs: number }>(
        (resolve) => {
          let everSeen = !!document.getElementById('vmde-prerender')
          const tick = () => {
            const el = document.getElementById('vmde-prerender')
            if (el) {
              everSeen = true
              if (performance.now() - t0 < 30_000) {
                requestAnimationFrame(tick)
                return
              }
            }
            resolve({ everSeen, goneAfterMs: performance.now() - t0 })
          }
          requestAnimationFrame(tick)
        },
      )
    })
    results[label] = seen
    await evaluateInVSCode(async (vscode: typeof import('vscode')) => {
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor')
    })
    await workbox.waitForTimeout(500)
  }
  console.log('[415-overlay]', JSON.stringify(results))
})
