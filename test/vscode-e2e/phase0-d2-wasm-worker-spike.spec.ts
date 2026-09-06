import { wf } from './webview-helpers'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'

// PHASE 0.1 (task 183 de-risk) — Can the d2-compile TinyGo WASM BOOT + COMPILE inside a webview
// Web Worker under the REAL custom-editor CSP? `script-src` has `'unsafe-eval'` but NOT
// `'wasm-unsafe-eval'` (src/html-builder.ts buildCspMeta). This is the ONE unproven platform fact;
// it decides Tier 0 (full d2 pipeline off-thread) vs Tier 1 (compile-on-main + ELK/toSVG off-thread).
//
// Method that avoids the known confounders:
//  - NO runtime `importScripts` of a webview resource (that is exactly why elkjs's real blob worker
//    is rejected — cross-origin importScripts). Instead INLINE TinyGo's wasm_exec.js into the blob
//    worker source (esbuild would do this in the real diagram-worker.js).
//  - NO `fetch` inside the worker. Fetch the .wasm bytes ON THE MAIN THREAD (connect-src allows the
//    cspSource URL) and TRANSFER the ArrayBuffer into the worker. Then new Go() + WebAssembly
//    .instantiate + go.run + poll for self.d2compile + compile a tiny diagram.
//  - Count main-thread rAF ticks during the boot to confirm it really ran off-thread.
const FIXTURE = path.join(__dirname, 'fixtures', 'render-cost-spike.md')
const WASM_EXEC = readFileSync(
  path.join(
    __dirname,
    '..',
    '..',
    'media',
    'vditor',
    'dist',
    'js',
    'd2',
    'wasm_exec.js',
  ),
  'utf8',
)

test('SPIKE 0.1: d2 TinyGo WASM boots + compiles in a webview worker under CSP', async ({
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
  // wait for d2 to render on the MAIN thread → the wasm_exec loader script tag + the wasm URL exist
  await frame.locator('.language-d2 svg').first().waitFor({ timeout: 60_000 })

  const result = await frame
    .locator('body')
    .evaluate(async (_b, wasmExecSrc: string) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const out: any = { stage: 'init' }
      try {
        // derive the wasm URL from the booted d2 loader script tag (id set by loadScript in d2-wasm.ts)
        const execTag = document.getElementById(
          'vditorD2WasmExec',
        ) as HTMLScriptElement | null
        const wasmExecUrl = execTag?.src || ''
        let wasmUrl = ''
        if (wasmExecUrl) {
          wasmUrl = wasmExecUrl.replace(/wasm_exec\.js.*$/, 'd2-compile.wasm')
        } else {
          const anyRes = Array.from(
            document.querySelectorAll('script[src],link[href]'),
          )
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            .map((e: any) => e.src || e.href)
            .find((u: string) => u?.includes('/vditor/dist/'))
          const cdn = anyRes ? anyRes.slice(0, anyRes.indexOf('/dist/')) : ''
          wasmUrl = `${cdn}/dist/js/d2/d2-compile.wasm`
        }
        out.wasmUrl = wasmUrl
        out.stage = 'fetch-wasm'
        const wasmBuf = await (await fetch(wasmUrl)).arrayBuffer()
        out.wasmBytes = wasmBuf.byteLength

        // worker source = TinyGo shim + inlined wasm_exec.js (defines Go) + boot/compile logic.
        const shim = 'self.window = self; self.global = self;\n'
        const workerLogic = `
self.onmessage = async (e) => {
  const o = { stage:'worker-init', hasWASM: typeof WebAssembly!=='undefined',
              hasDocument: typeof document!=='undefined',
              hasOffscreen: typeof OffscreenCanvas!=='undefined' };
  try {
    const GoClass = self.Go || (self.window && self.window.Go) || (self.global && self.global.Go);
    o.hasGo = typeof GoClass === 'function';
    if (!GoClass) { o.ok=false; o.error='Go class not defined by wasm_exec'; self.postMessage(o); return; }
    const go = new GoClass();
    o.stage='instantiate';
    let instance;
    const t0 = performance.now();
    try {
      const r = await WebAssembly.instantiate(e.data.wasmBuf, go.importObject);
      instance = r.instance;
      o.instantiateMs = Math.round(performance.now()-t0);
    } catch (err) {
      o.ok=false; o.stage='instantiate-failed'; o.error=String(err);
      o.errName = err && err.name ? err.name : null; self.postMessage(o); return;
    }
    o.stage='run';
    go.run(instance); // do not await — TinyGo blocks on select{} and runs forever
    let tries=0;
    while (typeof self.d2compile!=='function' && tries<400) { await new Promise(r=>setTimeout(r,10)); tries++; }
    o.bootPollMs = tries*10;
    o.hasD2compile = typeof self.d2compile==='function';
    if (o.hasD2compile) {
      const tc = performance.now();
      const res = self.d2compile(e.data.source);
      o.compileMs = Math.round(performance.now()-tc);
      o.compileError = (res && res.error) || null;
      o.graphLen = (res && res.graph) ? res.graph.length : 0;
      o.ok = !(res && res.error);
    } else { o.ok=false; o.error='d2compile never registered (waited '+(tries*10)+'ms)'; }
    o.stage='done';
  } catch (err) { o.ok=false; o.error=String(err); o.errorStack = (err && err.stack) ? String(err.stack) : null; }
  self.postMessage(o);
};
`
        const workerSource = `${shim}${wasmExecSrc}\n;\n${workerLogic}`
        const blob = new Blob([workerSource], {
          type: 'application/javascript',
        })
        const url = URL.createObjectURL(blob)
        out.stage = 'spawn-worker'
        let ticks = 0
        let raf = requestAnimationFrame(function tick() {
          ticks++
          raf = requestAnimationFrame(tick)
        })
        const w = new Worker(url)
        const t0 = performance.now()
        const workerOut = await new Promise((resolve, reject) => {
          const to = setTimeout(
            () => reject(new Error('worker timeout 40s')),
            40_000,
          )
          w.onmessage = (ev) => {
            clearTimeout(to)
            resolve(ev.data)
          }
          w.onerror = (ev) => {
            clearTimeout(to)
            reject(
              new Error(
                `worker error: ${ev.message || 'unknown'} @${ev.filename || ''}:${ev.lineno || ''}`,
              ),
            )
          }
          w.postMessage(
            {
              wasmBuf,
              source:
                'server: Web Server\nclient: Client\nclient -> server: request',
            },
            [wasmBuf],
          )
        })
        out.totalMs = Math.round(performance.now() - t0)
        cancelAnimationFrame(raf)
        out.mainThreadTicks = ticks
        w.terminate()
        URL.revokeObjectURL(url)
        out.worker = workerOut
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        out.ok = (workerOut as any)?.ok === true
      } catch (err) {
        out.ok = false
        out.error = String(err)
      }
      return out
    }, WASM_EXEC)

  // eslint-disable-next-line no-console
  console.log(`[phase0.1-d2-wasm-worker] ${JSON.stringify(result, null, 2)}`)
  // eslint-disable-next-line no-console
  console.log(
    `[phase0.1-VERDICT] ok=${result.ok} → ${
      result.ok
        ? 'TIER 0 VIABLE (WASM boots+compiles in worker under CSP)'
        : 'TIER 0 BLOCKED → use TIER 1 (compile on main) / add wasm-unsafe-eval'
    } | stage=${result.worker?.stage ?? result.stage} bootPoll=${result.worker?.bootPollMs}ms compile=${result.worker?.compileMs}ms mainTicks=${result.mainThreadTicks}`,
  )
  expect(result).toBeTruthy()
})
