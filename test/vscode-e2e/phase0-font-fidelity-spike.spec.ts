import { wf } from './webview-helpers'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'

// PHASE 0.2 (task 183 de-risk) — Does OffscreenCanvas.measureText in a WORKER match the main-thread
// document-canvas measure used by d2's `canvasMeasure` (d2-render.ts), so worker-side ELK layout is
// byte-faithful to the main-thread render? The risk: a worker's OffscreenCanvas has NO access to the
// document's @font-face fonts, so unless the bundled Source Sans 3 woff2 is loaded into the worker's
// own FontFaceSet (FontFace + self.fonts.add + await self.fonts.ready) BEFORE the first measure, node
// sizes drift and the layout diverges. This is a FIDELITY risk, not just perf.
//
// Method: on the main thread, force-load "Source Sans 3" and measure a set of labels with the exact
// d2 font string (`16px <D2_FONT_STACK>`). In a worker, measure the same strings (a) NAIVE (no font
// loaded — shows the drift if we skip the FontFace step) and (b) LOADED (after FontFace+fonts.ready).
// Report per-string deltas + the max delta for each. LOADED≈main proves the mitigation works; a
// meaningful NAIVE delta proves the FontFace step is mandatory.
const FIXTURE = path.join(__dirname, 'fixtures', 'render-cost-spike.md')
const D2_FONT_STACK = '"Source Sans 3","Source Sans Pro",system-ui,sans-serif'
const FONT = `16px ${D2_FONT_STACK}` // FONT_SIZE=16, matches d2-render.ts canvasMeasure

test('SPIKE 0.2: worker OffscreenCanvas measureText matches main-thread with the bundled font', async ({
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
  await frame.locator('.language-d2 svg').first().waitFor({ timeout: 60_000 })

  const result = await frame.locator('body').evaluate(
    async (_b, ctx) => {
      const { strings, font } = ctx as { strings: string[]; font: string }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const out: any = {}
      try {
        // resolve the bundled woff2 URL. Primary: the actual loaded resource (the font already
        // loaded because d2 rendered with it) via Resource Timing. Fallback: relative to main.css.
        const fromPerf = performance
          .getEntriesByType('resource')
          .map((e) => e.name)
          .find((n) => n.includes('SourceSans3') && n.includes('.woff2'))
        const cssHref =
          Array.from(document.querySelectorAll('link[rel="stylesheet"]'))
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            .map((l: any) => l.href as string)
            .find((h) => h?.includes('main.css')) || ''
        out.cssHref = cssHref
        out.fromPerf = fromPerf || null
        const woff2Url =
          fromPerf ||
          (cssHref
            ? new URL('../fonts/SourceSans3-Regular.woff2', cssHref).href
            : '')
        out.woff2Url = woff2Url

        // MAIN-thread measure (force the font in first)
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          await (document as any).fonts.load('16px "Source Sans 3"')
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          await (document as any).fonts.ready
        } catch (e) {
          out.mainFontErr = String(e)
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        out.mainFontAvailable = (document as any).fonts.check(
          '16px "Source Sans 3"',
        )
        const mc = document.createElement('canvas').getContext('2d')!
        mc.font = font
        out.main = strings.map(
          (s) => Math.round(mc.measureText(s).width * 100) / 100,
        )

        // fetch the woff2 BYTES on the main thread (the @font-face already loaded it, so the
        // cspSource fetch is allowed here) and TRANSFER to the worker → FontFace(buffer) needs no
        // in-worker network fetch (which we just proved hangs).
        let fontBuf: ArrayBuffer | null = null
        try {
          if (woff2Url) fontBuf = await (await fetch(woff2Url)).arrayBuffer()
          out.fontBytes = fontBuf ? fontBuf.byteLength : 0
        } catch (e) {
          out.fontFetchErr = String(e)
        }

        // WORKER measure: naive (no font) + PATH A FontFace-from-URL + PATH B FontFace-from-bytes
        const workerLogic = `
self.onmessage = async (e) => {
  const { woff2Url, fontBuf, strings, font } = e.data;
  const o = { hasOffscreen: typeof OffscreenCanvas!=='undefined', hasFonts: typeof self.fonts!=='undefined', woff2Url: woff2Url, gotFontBuf: !!fontBuf };
  const measure = (f) => { const c = new OffscreenCanvas(256,64).getContext('2d'); c.font=f; return strings.map(x=>Math.round(c.measureText(x).width*100)/100); };
  try {
    o.naive = measure(font);
    if (self.fonts && woff2Url) {
      try {
        const ff = new FontFace('Source Sans 3', 'url('+woff2Url+')');
        const r = await Promise.race([
          ff.load().then(()=> 'loaded').catch(err=> 'load-error:'+String(err)),
          new Promise(res=>setTimeout(()=>res('url-load-timeout-6s'), 6000))
        ]);
        o.urlLoadResult = r;
        if (r === 'loaded') self.fonts.add(ff);
      } catch (err) { o.urlFontErr = String(err); }
    }
    o.loadedFromUrl = measure(font);
    if (self.fonts && fontBuf) {
      try {
        const ff2 = new FontFace('Source Sans 3', fontBuf);
        const r2 = await Promise.race([
          ff2.load().then(()=> 'loaded').catch(err=> 'load-error:'+String(err)),
          new Promise(res=>setTimeout(()=>res('buf-load-timeout-6s'), 6000))
        ]);
        o.bufLoadResult = r2;
        o.bufFontStatus = ff2.status;
        if (r2 === 'loaded') self.fonts.add(ff2);
      } catch (err) { o.bufFontErr = String(err); }
    }
    o.loadedFromBuf = measure(font);
    // give the FontFaceSet a tick to activate, then measure again (rules out a registration race)
    await new Promise(res=>setTimeout(res,120));
    o.fontsCheck = (self.fonts && self.fonts.check) ? self.fonts.check(font) : null;
    o.loadedFromBufDelayed = measure(font);
    o.ok = true;
  } catch (err) { o.ok=false; o.error=String(err); }
  self.postMessage(o);
};
`
        const blob = new Blob([workerLogic], { type: 'application/javascript' })
        const url = URL.createObjectURL(blob)
        const w = new Worker(url)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const wout: any = await new Promise((resolve, reject) => {
          const to = setTimeout(
            () => reject(new Error('worker timeout 25s')),
            25_000,
          )
          w.onmessage = (ev) => {
            clearTimeout(to)
            resolve(ev.data)
          }
          w.onerror = (ev) => {
            clearTimeout(to)
            reject(new Error(`worker error: ${ev.message || 'unknown'}`))
          }
          const transfer = fontBuf ? [fontBuf] : []
          w.postMessage({ woff2Url, fontBuf, strings, font }, transfer)
        })
        w.terminate()
        URL.revokeObjectURL(url)
        out.worker = wout

        const maxDelta = (arr?: number[]) =>
          arr ? Math.max(...arr.map((v, i) => Math.abs(v - out.main[i]))) : null
        const round2 = (v: number | null) =>
          v != null ? Math.round(v * 100) / 100 : null
        out.maxNaiveDelta = round2(maxDelta(wout.naive))
        out.maxUrlDelta = round2(maxDelta(wout.loadedFromUrl))
        out.maxBufDelta = round2(maxDelta(wout.loadedFromBuf))
        out.maxBufDelayedDelta = round2(maxDelta(wout.loadedFromBufDelayed))
        out.fontsCheck = wout.fontsCheck
        out.ok = wout.ok === true
      } catch (err) {
        out.ok = false
        out.error = String(err)
      }
      return out
    },
    {
      strings: [
        'Web Server',
        'Database',
        'Redis Cache',
        'Client',
        'request',
        'response',
        'iiiiiiiiii',
        'WWWWWWWWWW',
      ],
      font: FONT,
    },
  )

  // eslint-disable-next-line no-console
  console.log(`[phase0.2-font-fidelity] ${JSON.stringify(result, null, 2)}`)
  // eslint-disable-next-line no-console
  console.log(
    `[phase0.2-VERDICT] maxNaiveDelta=${result.maxNaiveDelta}px (no font) | maxUrlDelta=${result.maxUrlDelta}px (URL: ${result.worker?.urlLoadResult}) | ` +
      `maxBufDelta=${result.maxBufDelta}px (BYTES: ${result.worker?.bufLoadResult}) | maxBufDelayedDelta=${result.maxBufDelayedDelta}px (BYTES+120ms, fonts.check=${result.fontsCheck}) ⇒ ` +
      `${result.maxBufDelayedDelta != null && result.maxBufDelayedDelta <= 0.6 ? 'WORKER MEASURE FAITHFUL via font bytes (Tier 0/1 measure-in-worker OK)' : 'WORKER MEASURE UNFAITHFUL even with loaded font → MEASURE ON MAIN, pass size map into worker'}`,
  )
  expect(result).toBeTruthy()
})
