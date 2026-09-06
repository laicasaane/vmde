import { wf } from './webview-helpers'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'

// SPIKE (diagnostic) — can a real Web Worker run inside the VS Code custom-editor webview?
// This is the gate for moving heavy NON-DOM diagram layout (d2 / ELK, graphviz/viz WASM) OFF
// the main thread → no 280–365 ms render freeze → responsive live updates. The CSP already
// allows it (`worker-src ${cspSource} blob:`, src/html-builder.ts); the only prior failure was
// elkjs's own blob worker (cross-origin importScripts), NOT a blanket ban. Tests a
// self-contained blob worker round-trip + a CPU-bound off-thread task (does the main thread stay
// free while the worker computes?).
const FIXTURE = path.join(__dirname, 'fixtures', 'undo-dirty.md')

test('SPIKE: does a Web Worker run in the VS Code webview?', async ({
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

  const result = (await frame.locator('body').evaluate(async () => {
    const out: Record<string, unknown> = {}
    // 1) self-contained blob worker — echo round-trip
    try {
      const src =
        'self.onmessage=(e)=>{' +
        // burn ~250ms of CPU IN THE WORKER, then reply — proves it computes off-thread
        'const t=Date.now();let x=0;while(Date.now()-t<250){x+=Math.sqrt(x+1)}' +
        'self.postMessage({echo:e.data,burned:Date.now()-t})}'
      const blob = new Blob([src], { type: 'application/javascript' })
      const url = URL.createObjectURL(blob)
      const w = new Worker(url)
      // while the worker burns CPU, check the main thread stays responsive (rAF keeps ticking)
      let rafTicks = 0
      let raf = 0
      const tick = () => {
        rafTicks++
        raf = requestAnimationFrame(tick)
      }
      raf = requestAnimationFrame(tick)
      const t0 = performance.now()
      const msg = await new Promise<unknown>((resolve, reject) => {
        const to = setTimeout(
          () => reject(new Error('worker timeout 4s')),
          4000,
        )
        w.onmessage = (e) => {
          clearTimeout(to)
          resolve(e.data)
        }
        w.onerror = (e) =>
          reject(new Error(`worker error: ${e.message || 'unknown'}`))
        w.postMessage(21)
      })
      const elapsed = Math.round(performance.now() - t0)
      cancelAnimationFrame(raf)
      w.terminate()
      URL.revokeObjectURL(url)
      out.blobWorker = {
        ok: true,
        reply: msg,
        roundTripMs: elapsed,
        // ~15 ticks in 250ms ≈ 60fps → main thread was FREE while the worker burned CPU
        mainThreadRafTicks: rafTicks,
      }
    } catch (e) {
      out.blobWorker = { ok: false, error: String(e) }
    }
    return out
  })) as { blobWorker: Record<string, unknown> }

  // eslint-disable-next-line no-console
  console.log(
    `[worker-feasibility-spike] ${JSON.stringify(result.blobWorker, null, 2)}`,
  )
  expect(result).toBeTruthy()
})
