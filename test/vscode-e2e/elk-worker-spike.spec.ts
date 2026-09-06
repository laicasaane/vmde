import { wf } from './webview-helpers'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'

// SPIKE (diagnostic) — confirm the d2 off-thread path end-to-end: a self-contained blob
// Web Worker that runs the REAL elkjs layout engine + OffscreenCanvas.measureText, inside
// the actual VS Code webview. This is the decisive de-risk: the historical "elk worker
// rejects" was elkjs's own blob worker (cross-origin importScripts); here elkjs is bundled
// self-contained (no importScripts) and run inside our own blob worker.
const FIXTURE = path.join(__dirname, 'fixtures', 'undo-dirty.md')
const BUNDLE = readFileSync(
  path.join(__dirname, '..', '..', 'tmp', 'elk-spike', 'worker.bundle.js'),
  'utf8',
)

test('SPIKE: elkjs layout + OffscreenCanvas measure in a webview worker', async ({
  workbox,
  evaluateInVSCode,
}) => {
  await evaluateInVSCode(
    async (vscode: typeof import('vscode'), args: string[]) => {
      await vscode.extensions.getExtension('Laicasaane.vmde')?.activate()
      await vscode.commands.executeCommand(
        'vscode.openWith',
        vscode.Uri.file(args[0]),
        'vmde.editor',
      )
    },
    [FIXTURE] as [string],
  )
  const frame = wf(workbox)
  await frame.locator('.vditor-ir').first().waitFor({ timeout: 60_000 })

  const result = (await frame.locator('body').evaluate(async (_b, src) => {
    try {
      const blob = new Blob([src as string], {
        type: 'application/javascript',
      })
      const url = URL.createObjectURL(blob)
      const w = new Worker(url)
      // count main-thread rAF ticks while the worker lays out → proves it's off-thread
      let ticks = 0
      let raf = requestAnimationFrame(function tick() {
        ticks++
        raf = requestAnimationFrame(tick)
      })
      const t0 = performance.now()
      const data = await new Promise<unknown>((resolve, reject) => {
        const to = setTimeout(() => reject(new Error('timeout 10s')), 10_000)
        w.onmessage = (e) => {
          clearTimeout(to)
          resolve(e.data)
        }
        w.onerror = (e) => {
          clearTimeout(to)
          reject(new Error(`worker error: ${e.message || 'unknown'}`))
        }
        w.postMessage('go')
      })
      const roundTripMs = Math.round(performance.now() - t0)
      cancelAnimationFrame(raf)
      w.terminate()
      URL.revokeObjectURL(url)
      return { ok: true, roundTripMs, mainThreadTicks: ticks, data }
    } catch (e) {
      return { ok: false, error: String(e) }
    }
  }, BUNDLE)) as {
    ok: boolean
    error?: string
    roundTripMs?: number
    mainThreadTicks?: number
    data?: unknown
  }

  // eslint-disable-next-line no-console
  console.log(`[elk-worker-spike] ${JSON.stringify(result, null, 2)}`)
  expect(result).toBeTruthy()
})
