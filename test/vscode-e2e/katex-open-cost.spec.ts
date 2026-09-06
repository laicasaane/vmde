import { wf } from './webview-helpers'
// MEASUREMENT (not a gate) — task: is KaTeX worth putting in the render cache?
//
// `math` is the one renderer deliberately OUTSIDE the task-184 cache (engine-registry.ts:
// `cacheable: false`, and it is in neither NATIVE_CACHE_LANGS nor NATIVE_RESERVE_LANGS), on the
// argument that KaTeX is synchronous and cheap. This spec puts a number on that instead of
// repeating the argument:
//
//  1. open→painted wall clock for a math-heavy document, against a math-FREE control of the same
//     size (same block count, formulas swapped for inline code) — the delta is what math costs;
//  2. the raw synchronous KaTeX cost in-page (`katex.renderToString` over every formula in the
//     document) — that is the ceiling on what a cache could ever give back;
//  3. the same for a smaller document, so the per-formula cost is a slope and not one data point.
//
// Prints everything; assertions are trivial so it can never block CI.
// @probe — excluded from the default run; run with `npm --prefix test/vscode-e2e run test:probes`
// (task 449).
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'

const TMP = path.join(__dirname, '..', '..', 'tmp', 'katex-cost')

// A spread of real-ish formulas — a document of 400 copies of `a+b` would measure the parser's best
// case, not the editor's. Mixes inline and display, short and structural.
const FORMULAS = [
  'E = mc^2',
  '\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}',
  '\\int_0^\\infty e^{-x^2}\\,dx = \\frac{\\sqrt{\\pi}}{2}',
  '\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}',
  '\\frac{\\partial u}{\\partial t} = \\alpha \\nabla^2 u',
  '\\lim_{x \\to 0} \\frac{\\sin x}{x} = 1',
]

function mathDoc(n: number): string {
  const out = ['# math cost fixture', '']
  for (let i = 0; i < n; i++) {
    const f = FORMULAS[i % FORMULAS.length]
    out.push(
      i % 3 === 0
        ? `Blok ${i}:\n\n$$\n${f}\n$$\n`
        : `Akapit ${i} z wzorem $${f}$ w środku zdania.\n`,
    )
  }
  return out.join('\n')
}

// The control: same structure and text length with the formulas as PLAIN TEXT — the cheapest content
// of that size, so the delta against the math document is KaTeX plus whatever the math nodes cost in
// layout. (A first attempt used code fences here; that was worse than useless — highlight.js made the
// control SLOWER than the math document, so it measured hljs, not math.)
function controlDoc(n: number): string {
  const out = ['# math cost fixture (control, no math)', '']
  for (let i = 0; i < n; i++) {
    const f = FORMULAS[i % FORMULAS.length]
    out.push(
      i % 3 === 0
        ? `Blok ${i}:\n\n${f}\n`
        : `Akapit ${i} z wzorem ${f} w środku zdania.\n`,
    )
  }
  return out.join('\n')
}

// The exact formula list a document of `n` blocks contains — passed into the page so the raw KaTeX
// timing does not depend on digging the TeX back out of rendered DOM (the first attempt did, and
// found 0 sources: Vditor's KaTeX output carries no MathML annotation to read them from).
function formulaList(n: number): string[] {
  return Array.from({ length: n }, (_, i) => FORMULAS[i % FORMULAS.length])
}

test('katex open cost: math-heavy vs math-free, plus the raw KaTeX time @probe', async ({
  workbox,
  evaluateInVSCode,
}) => {
  test.setTimeout(300_000)
  mkdirSync(TMP, { recursive: true })
  const docs = [
    { name: 'math-400.md', body: mathDoc(400), n: 400, math: true },
    { name: 'control-400.md', body: controlDoc(400), n: 400, math: false },
    { name: 'math-100.md', body: mathDoc(100), n: 100, math: true },
  ]
  for (const d of docs) writeFileSync(path.join(TMP, d.name), d.body)

  const results: Record<string, unknown>[] = []
  for (const d of docs) {
    await evaluateInVSCode(async (vscode) => {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors')
    }, [])
    const t0 = Date.now()
    await evaluateInVSCode(
      async (vscode, args) => {
        const [uri] = args as [string]
        await vscode.extensions.getExtension('Laicasaane.vmde')?.activate()
        await vscode.commands.executeCommand(
          'vscode.openWith',
          vscode.Uri.file(uri),
          'vmde.editor',
        )
      },
      [path.join(TMP, d.name)] as [string],
    )
    const frame = wf(workbox)
    await frame.locator('.vditor-ir').first().waitFor({ timeout: 120_000 })
    const irReady = Date.now() - t0

    // Painted = the last expected node is in the DOM. For math that is a rendered .katex; for the
    // control, the code blocks. Poll on the same cadence for both so the numbers are comparable.
    let painted = -1
    let firstPaint = -1
    const timeline: Array<[number, number]> = []
    for (let i = 0; i < 400; i++) {
      const done = await frame.locator('body').evaluate((_b, isMath) => {
        return isMath
          ? document.querySelectorAll('.katex').length
          : // The control is plain text: its "paint" is the paragraph count.
            document.querySelectorAll('.vditor-ir p').length
      }, d.math)
      timeline.push([Date.now() - t0, done])
      if (done > 0 && firstPaint < 0) firstPaint = Date.now() - t0
      if (done >= (d.math ? d.n : Math.floor(d.n / 2))) {
        painted = Date.now() - t0
        break
      }
      await new Promise((r) => setTimeout(r, 100))
    }

    // The raw synchronous cost: re-render every formula in the document with KaTeX itself. This is
    // the absolute ceiling on what a cache could return, independent of Vditor/DOM.
    const katexCost = await frame
      .locator('body')
      .evaluate((_b, sources: string[]) => {
        const k = (window as { katex?: { renderToString(s: string): string } })
          .katex
        if (!k) return null
        const run = () => {
          const t = performance.now()
          for (const s of sources) {
            try {
              k.renderToString(s)
            } catch {
              // A malformed formula must not abort the timing loop — only
              // wall-clock render cost is measured here, not correctness.
            }
          }
          return +(performance.now() - t).toFixed(1)
        }
        run() // warm-up: first call pays font-metric setup, which a real open pays once too
        return { formulas: sources.length, ms: run(), coldMs: run() }
      }, formulaList(d.n))

    const rendered = await frame
      .locator('body')
      .evaluate(() => document.querySelectorAll('.katex').length)
    results.push({
      doc: d.name,
      blocks: d.n,
      irReadyMs: irReady,
      firstPaintMs: firstPaint,
      paintedMs: painted,
      timeline: timeline.filter(
        (_, i) => i % 3 === 0 || i === timeline.length - 1,
      ),
      katexNodes: rendered,
      katexRerender: katexCost,
    })
    // eslint-disable-next-line no-console
    console.log(`[katex-cost] ${JSON.stringify(results[results.length - 1])}`)
  }

  writeFileSync(
    path.join(TMP, 'results.json'),
    JSON.stringify(results, null, 2),
  )
  expect(results.length).toBe(3)
})
