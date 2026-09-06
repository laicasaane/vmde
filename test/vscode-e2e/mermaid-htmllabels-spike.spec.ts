import { wf } from './webview-helpers'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'

// SPIKE (diagnostic) — does `flowchart.htmlLabels:false` meaningfully cut mermaid RENDER time?
// That's the cheap, on-thread lever for the "diagram appears slowly after typing" latency
// (= QUIET_MS 220ms + render). If htmlLabels:false roughly halves the render, it's a ship-able
// win without a worker. If it barely moves, the render is dagre/SVG-gen-bound and only off-thread
// (shim worker) + eager render helps. Calls window.mermaid.render() directly (true vs false),
// min of 5, off the editor pipeline, on the heavy fixture diagram.
const FIXTURE = path.join(__dirname, 'fixtures', 'render-cost-spike.md')

test('SPIKE: mermaid htmlLabels true vs false render time', async ({
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
  await frame
    .locator('.language-mermaid svg')
    .first()
    .waitFor({ timeout: 60_000 })
  await frame
    .locator('body')
    .evaluate(() => new Promise((r) => setTimeout(r, 3000)))

  const result = (await frame.locator('body').evaluate(async () => {
    const m = (window as unknown as { mermaid?: any }).mermaid
    if (!m || typeof m.render !== 'function')
      return { error: 'no window.mermaid' }
    // the editable mermaid SOURCE (not the rendered svg)
    const srcCode = document.querySelector(
      '.vditor-ir__marker--pre code.language-mermaid',
    )
    const text = (srcCode?.textContent ?? '').trim()
    if (!text) return { error: 'no mermaid source text' }

    const measure = async (htmlLabels: boolean) => {
      m.initialize({
        startOnLoad: false,
        securityLevel: 'loose',
        flowchart: { htmlLabels },
      })
      try {
        await m.render(`spike-warm-${htmlLabels}`, text) // warm-up (first render pays init)
      } catch (e) {
        return { error: `render threw: ${String(e)}` }
      }
      const times: number[] = []
      let svg = ''
      for (let i = 0; i < 5; i++) {
        const t = performance.now()
        const r = await m.render(`spike-${htmlLabels}-${i}`, text)
        times.push(performance.now() - t)
        svg = r.svg
      }
      times.sort((a, b) => a - b)
      return {
        minMs: Math.round(times[0]),
        medMs: Math.round(times[2]),
        maxMs: Math.round(times[4]),
        hasForeignObject: /foreignObject/.test(svg),
        hasText: /<text/.test(svg),
        svgLen: svg.length,
      }
    }

    const on = await measure(true)
    const off = await measure(false)
    return { edges: (text.match(/-->/g) ?? []).length, on, off }
  })) as {
    error?: string
    edges?: number
    on?: {
      minMs: number
      medMs: number
      hasForeignObject: boolean
      hasText: boolean
    }
    off?: {
      minMs: number
      medMs: number
      hasForeignObject: boolean
      hasText: boolean
    }
  }

  // eslint-disable-next-line no-console
  console.log(`[mermaid-htmllabels-spike] ${JSON.stringify(result, null, 2)}`)
  expect(result).toBeTruthy()
})
