import { wf } from './webview-helpers'
// Task 433 — STANDING NET (not a throwaway probe — do not delete it as scratch): is the 2000 ms
// diagram-cache-reply fallback ever actually reached?
//
// `reserveAndRequest` blocks every cacheable block (`data-processed`) until `resolveRequest` fires; a
// dropped host reply is unblocked ONLY by that timer, i.e. up to 2 s of inert diagrams. The host side is
// synchronous in-memory Map lookups (src/editor-session.ts onDiagramCacheGet), so it should never be
// reached — this spec turns "should" into a measured `timeout === 0`, on the heaviest fixture there is
// (all-renderers.md: 13 d2 + mermaid + plantuml + vega + wavedrom + …, i.e. the biggest reserve batch).
//
// If this ever goes non-zero, the finding is real and the timeout/retry needs revisiting — do not
// "harden" it while this stays at zero. That is why the counters and this spec survive a task that
// closed as "checked and fine": they are what keeps "the timer never fires" a MEASURED claim.
//
// Full suite only, per the tier policy in playwright.config.ts (perf probes are not routine-tier).
//   node build.mjs && xvfb-run -a npm --prefix test/vscode-e2e test -- diagram-cache-reply-source.spec.ts
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'

const ALL = path.join(__dirname, 'fixtures', 'all-renderers.md')

test('every diagram-cache request resolves from a real host reply, never the 2 s fallback (task 433)', async ({
  workbox,
  evaluateInVSCode,
}) => {
  test.setTimeout(240_000)
  await evaluateInVSCode(
    async (vscode: typeof import('vscode'), args: string[]) => {
      await vscode.extensions.getExtension('Laicasaane.vmde')?.activate()
      await vscode.commands.executeCommand(
        'vscode.openWith',
        vscode.Uri.file(args[0]),
        'vmde.editor',
      )
    },
    [ALL] as [string],
  )
  const frame = wf(workbox)
  await frame.locator('.vditor-ir').first().waitFor({ timeout: 60_000 })
  // Well past the 2000 ms fallback: if any request were going to time out, it already has.
  // task 512: retain — the assertion is specifically that a delayed fallback never fires. Polling
  // `timeout === 0` would resolve on the initial state before the 2s failure path could run.
  await frame
    .locator('body')
    .evaluate(() => new Promise((r) => setTimeout(r, 8000)))

  const stats = (await frame.locator('body').evaluate(
    () =>
      (
        window as unknown as {
          __vmdeCacheResolveStats?: { reply: number; timeout: number }
        }
      ).__vmdeCacheResolveStats ?? null,
  )) as { reply: number; timeout: number } | null

  console.log(`[task 433] cache resolve: ${JSON.stringify(stats)}`)
  expect(stats, 'the counters are installed').not.toBeNull()
  expect(
    (stats as { reply: number }).reply,
    'sanity: at least one cache request was actually made and answered — otherwise a zero timeout count proves nothing',
  ).toBeGreaterThan(0)
  expect(
    (stats as { timeout: number }).timeout,
    'the 2000 ms dropped-reply fallback must never be reached on a normal open (task 433)',
  ).toBe(0)
})
