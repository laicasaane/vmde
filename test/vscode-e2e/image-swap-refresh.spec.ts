import fs from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import { wf } from './webview-helpers'

// REGRESSION (task 513) — an image replaced ON DISK under an unchanged path must repaint in the
// open editor. The measurement behind the fix lives in image-swap-refresh-probe.spec.ts: the bytes
// change, but the webview's resource URL is served from Chromium's HTTP cache, so a re-render (or
// even a brand-new <img> with the same src) still paints the OLD image. Only the host telling the
// webview to revalidate that URL fixes it.
//
// naturalWidth is the signal — the two source files have different intrinsic widths, so a stale
// paint and a fresh one are distinguishable without reading image bytes in the webview. Read the
// PNG IHDR values instead of pinning a Marketplace screenshot dimension that changes on recapture.
const WORK = path.join(__dirname, 'tmp', 'image-swap-refresh')
const DOC = path.join(WORK, 'doc.md')
const IMG = path.join(WORK, 'shot.png')
const SMALL = path.join(__dirname, '..', '..', 'media', 'logo.png')
const LARGE = path.join(__dirname, '..', '..', 'media', 'vmde.png')
const pngWidth = (file: string) => fs.readFileSync(file).readUInt32BE(16)
const SMALL_WIDTH = pngWidth(SMALL)
const LARGE_WIDTH = pngWidth(LARGE)

test('a reference image replaced on disk repaints without reopening the editor', async ({
  workbox,
  evaluateInVSCode,
}) => {
  fs.mkdirSync(WORK, { recursive: true })
  fs.copyFileSync(SMALL, IMG)
  fs.writeFileSync(
    DOC,
    '# Image swap\n\n![shot][asset]\n\ntail\n\n[asset]: shot.png "Swap target"\n',
  )

  await evaluateInVSCode(
    async (vscode: typeof import('vscode'), args: string[]) => {
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
  const img = frame.locator('img[src*="shot.png"]').first()
  await img.waitFor({ timeout: 60_000 })

  const width = () => img.evaluate((el: HTMLImageElement) => el.naturalWidth)
  expect(SMALL_WIDTH).not.toBe(LARGE_WIDTH)
  await expect.poll(width, { timeout: 30_000 }).toBe(SMALL_WIDTH)

  // Swap the bytes behind the SAME path — "I replaced the png in place".
  fs.copyFileSync(LARGE, IMG)

  // The host's file watcher fires, the webview revalidates: the rendered image picks the new file
  // up on its own, with no edit, no reopen and no window reload.
  await expect.poll(width, { timeout: 30_000 }).toBe(LARGE_WIDTH)

  // The cache-busting must never reach the document: the src attribute stays exactly what the
  // markdown says, and the file on disk is untouched (no phantom dirty edit).
  const attr = await img.evaluate((el: HTMLImageElement) =>
    el.getAttribute('src'),
  )
  expect(attr).toBe('shot.png')

  const doc = (await evaluateInVSCode(
    async (vscode: typeof import('vscode'), args: string[]) => {
      const d = vscode.workspace.textDocuments.find(
        (t) => t.uri.fsPath === args[0],
      )
      return { isDirty: !!d?.isDirty, text: d?.getText() ?? '' }
    },
    [DOC] as [string],
  )) as { isDirty: boolean; text: string }
  expect(doc.isDirty).toBe(false)
  expect(doc.text).toBe(
    '# Image swap\n\n![shot][asset]\n\ntail\n\n[asset]: shot.png "Swap target"\n',
  )
})
