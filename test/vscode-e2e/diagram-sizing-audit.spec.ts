import { wf } from './webview-helpers'
// Task 355 — diagram sizing/font BASELINE AUDIT (measurement, not an assertion gate).
// The sizing rules in main.css grew as one-off per-family patches (plantuml had a `min-width:300px`
// boost — removed in step 2, it is natural-size now; smiles `max-width`, mermaid/graphviz intrinsic, abc/graphviz
// max-height, echarts/markmap/mindmap container-filling) — so "everything looks wrong" cannot be
// judged without seeing every family measured the SAME way, side by side, in the real editor.
// This spec dumps that sheet + screenshots; it asserts only that the render happened, so it never
// fails on a sizing value the user is still deciding. Run:
//   node build.mjs && xvfb-run -a npm --prefix test/vscode-e2e test -- diagram-sizing-audit.spec.ts
// @probe — excluded from the default run; run with `npm --prefix test/vscode-e2e run test:probes`
// (task 449).
import fs from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'

// VMDE_AUDIT_FIXTURE swaps the corpus without touching the spec — used to isolate "is the spec
// wrong or is the fixture too heavy?" when a run produces no sheet.
const FIXTURE = path.join(
  __dirname,
  'fixtures',
  process.env.VMDE_AUDIT_FIXTURE || 'diagram-sizing-audit.md',
)
// Namespaced per fixture so the split runs (a/b/c/d) don't overwrite each other's sheet.
const TAG = path.basename(FIXTURE, '.md')
const OUT = path.join(__dirname, '..', '..', 'tmp', '355-sizing', TAG)

const FAMILIES = [
  'plantuml',
  'mermaid',
  'graphviz',
  'flowchart',
  'd2',
  'nomnoml',
  'wavedrom',
  'vega-lite',
  'abc',
  'smiles',
  'echarts',
  'markmap',
  'mindmap',
]

// The config's 90s default is for single-diagram parity smokes. This one opens 13 renderer
// families at once (PlantUML's cold TeaVM engine alone costs ~2s per block, task 352), so the
// 60s editor wait + the render settle exhausted the budget BEFORE the measurement ran — the first
// attempts produced no sheet at all. Budget the whole audit explicitly instead.
test.setTimeout(300_000)

test('diagram sizing baseline sheet @probe', async ({
  workbox,
  evaluateInVSCode,
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: single-test audit opening all 13 diagram-renderer families and measuring each; pre-existing (task 469 baseline)
}) => {
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
    [FIXTURE] as [string],
  )
  // The suite's teardown stalls (the runner has to be killed externally), and piped stdout is
  // buffered — so console.log output is LOST on kill. Append the trace to a file instead: it
  // survives regardless of whether the process ever exits.
  fs.mkdirSync(OUT, { recursive: true })
  const TRACE = path.join(OUT, 'trace.log')
  fs.writeFileSync(TRACE, '')
  const step = (s: string) => {
    const line = `[audit] ${s} t=${Date.now() - t0}ms`
    fs.appendFileSync(TRACE, `${line}\n`)
    console.log(line)
  }
  step('opened')
  const frame = wf(workbox)
  try {
    // Wait for the ACTIVE mode element, not a set of them. Vditor creates all four mode elements
    // (wysiwyg / sv / ir / preview) and shows one, so `.vditor-ir, .vditor-wysiwyg` + .first()
    // resolves in DOM order to the HIDDEN `.vditor-wysiwyg` — and waitFor's default state is
    // 'visible', so it waits out the timeout on an element that is never shown. It only appeared
    // to work at all because it is a RACE: a run that reaches waitFor before Vditor has created
    // the other mode elements matches `.vditor-ir` and passes.
    await frame.locator('.vditor-ir').first().waitFor({ timeout: 60_000 })
    step('editor ready')
  } catch (e) {
    // The suite's teardown stalls, so a thrown failure never reaches the reporter — log the
    // diagnosis ourselves (console.log flushes immediately) instead of dying silently.
    step(`EDITOR WAIT FAILED: ${(e as Error).message.split('\n')[0]}`)
    const dom = await frame
      .locator('body')
      .evaluate(() => ({
        cls: document.body.className,
        html: document.body.innerHTML.slice(0, 400),
        kids: [...document.body.children]
          .map((c) => `${c.tagName}.${c.className}`)
          .slice(0, 10),
      }))
      .catch((err) => ({ frameError: (err as Error).message.split('\n')[0] }))
    step(`DOM: ${JSON.stringify(dom)}`)
    throw e
  }
  // Measure in WYSIWYG, like diagram-width.spec: in IR the `.language-X` selector also matches the
  // EDITABLE SOURCE node of the dual-node pair (which has no svg), so an IR run reports
  // "no svg/canvas" for nearly everything. WYSIWYG gives one rendered preview per block.
  await frame.locator('body').evaluate(() => {
    const v = (
      window as unknown as {
        vditor: {
          vditor: { toolbar: { elements: Record<string, HTMLElement> } }
        }
      }
    ).vditor.vditor
    v.toolbar.elements['edit-mode']?.children[0]?.dispatchEvent(
      new MouseEvent('click', { bubbles: true }),
    )
    document
      .querySelector('button[data-mode="wysiwyg"]')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  // PlantUML's cold TeaVM engine + the k8s stdlib include is the slowest render here (~2s each,
  // task 352) — give the whole set a generous settle before measuring.
  await frame
    .locator('body')
    .evaluate(() => new Promise((r) => setTimeout(r, 25_000)))

  step('settled')
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: in-page measurement sheet built across every renderer family's DOM shape; pre-existing (task 469 baseline)
  const sheet = await frame.locator('body').evaluate((_b, fams: string[]) => {
    const mode = document.querySelector('.vditor-ir')
      ? 'ir'
      : document.querySelector('.vditor-wysiwyg')
        ? 'wysiwyg'
        : 'unknown'
    const preview = document.querySelector(
      '.vditor-ir__preview, .vditor-wysiwyg__preview, .vditor-preview',
    ) as HTMLElement | null
    const col = preview
      ? Math.round(preview.getBoundingClientRect().width)
      : null
    const proseEl = document.querySelector(
      '.vditor-reset p, .markdown-body p, p',
    ) as HTMLElement | null
    const proseFont = proseEl
      ? Number.parseFloat(getComputedStyle(proseEl).fontSize)
      : null

    // A family can appear more than once (plantuml: vector + sprite) — measure EVERY instance.
    const rows: unknown[] = []
    for (const lang of fams) {
      // Scope to the RENDERED preview containers and keep only hosts that actually produced
      // graphics — an unrendered/source node carries no sizing information to judge.
      const hosts = (
        [
          ...document.querySelectorAll(
            `.vditor-wysiwyg__preview > .language-${lang}, .vditor-wysiwyg__preview > code.language-${lang}, .vditor-ir__preview > .language-${lang}, .vditor-ir__preview > code.language-${lang}, .vditor-preview .language-${lang}`,
          ),
        ] as HTMLElement[]
      ).filter((h) => h.querySelector('svg, canvas'))
      if (!hosts.length) {
        rows.push({ lang, i: 0, rendered: null, note: 'not rendered' })
        continue
      }
      // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: per-host natural/rendered-size measurement across the svg/canvas/missing-graphic branches; pre-existing (task 469 baseline)
      hosts.forEach((host, i) => {
        const gfx = host.querySelector('svg, canvas') as
          | SVGSVGElement
          | HTMLCanvasElement
          | null
        if (!gfx) return
        const r = gfx.getBoundingClientRect()
        // Intrinsic size: viewBox is the truthful one for SVG; fall back to the width/height
        // attributes (abc has no viewBox), then to canvas pixel dims.
        let intrinsic: { w: number; h: number } | null = null
        if (gfx instanceof SVGSVGElement) {
          const vb = gfx.getAttribute('viewBox')
          if (vb) {
            const p = vb.split(/[ ,]+/).map(Number)
            if (p.length === 4) intrinsic = { w: p[2], h: p[3] }
          }
          if (!intrinsic) {
            const w = Number.parseFloat(gfx.getAttribute('width') ?? '')
            const h = Number.parseFloat(gfx.getAttribute('height') ?? '')
            if (Number.isFinite(w) && Number.isFinite(h)) intrinsic = { w, h }
          }
        } else {
          intrinsic = { w: gfx.width, h: gfx.height }
        }
        // Label font sizes: computed on the SVG <text> nodes (what the eye reads), deduped.
        const texts = [...gfx.querySelectorAll('text')] as SVGTextElement[]
        const fonts = [
          ...new Set(
            texts
              .map(
                (t) =>
                  Math.round(
                    Number.parseFloat(getComputedStyle(t).fontSize) * 10,
                  ) / 10,
              )
              .filter((n) => Number.isFinite(n) && n > 0),
          ),
        ].sort((a, b) => a - b)
        rows.push({
          lang,
          i,
          hasSprite: !!gfx.querySelector?.('image'),
          rendered: { w: Math.round(r.width), h: Math.round(r.height) },
          intrinsic: intrinsic
            ? { w: Math.round(intrinsic.w), h: Math.round(intrinsic.h) }
            : null,
          scale: intrinsic?.w
            ? Math.round((r.width / intrinsic.w) * 100) / 100
            : null,
          colFill: null as number | null,
          labelFonts: fonts,
        })
      })
    }
    for (const row of rows as {
      rendered: { w: number } | null
      colFill: number | null
    }[])
      if (row.rendered && col)
        row.colFill = Math.round((row.rendered.w / col) * 100)
    return { mode, col, proseFont, rows }
  }, FAMILIES)

  step('measured')
  fs.mkdirSync(OUT, { recursive: true })
  fs.writeFileSync(
    path.join(OUT, 'baseline.json'),
    JSON.stringify(sheet, null, 2),
  )

  const pad = (s: string, n: number) => s.padEnd(n)
  const lines = [
    `mode=${sheet.mode}  column=${sheet.col}px  prose font=${sheet.proseFont}px`,
    '',
    `${pad('family', 14)}${pad('sprite', 8)}${pad('intrinsic', 14)}${pad('rendered', 14)}${pad('scale', 8)}${pad('col%', 7)}label fonts`,
  ]
  for (const r of sheet.rows as Record<string, never>[]) {
    const row = r as unknown as {
      lang: string
      i: number
      hasSprite?: boolean
      intrinsic: { w: number; h: number } | null
      rendered: { w: number; h: number } | null
      scale: number | null
      colFill: number | null
      labelFonts?: number[]
      note?: string
    }
    const name = row.i > 0 ? `${row.lang}#${row.i + 1}` : row.lang
    lines.push(
      pad(name, 14) +
        pad(row.hasSprite ? 'yes' : '-', 8) +
        pad(row.intrinsic ? `${row.intrinsic.w}x${row.intrinsic.h}` : '-', 14) +
        pad(
          row.rendered
            ? `${row.rendered.w}x${row.rendered.h}`
            : (row.note ?? '-'),
          14,
        ) +
        pad(row.scale != null ? `${row.scale}x` : '-', 8) +
        pad(row.colFill != null ? `${row.colFill}%` : '-', 7) +
        (row.labelFonts?.length ? row.labelFonts.join('/') : '-'),
    )
  }
  const report = lines.join('\n')
  fs.writeFileSync(path.join(OUT, 'baseline.txt'), report)
  console.log(`\n${report}\n`)

  step('sheet written')
  // Screenshots are what the user actually judges — full page plus one per family.
  await workbox.screenshot({
    path: path.join(OUT, 'page.png'),
    fullPage: false,
  })
  // Per-element shots cost ~15s each through the double-nested webview (204s for 13 families on
  // the first working run) — far more than the whole measurement. The page shot plus the sheet
  // carry the baseline; skip the per-family shots unless explicitly asked for.
  if (process.env.VMDE_AUDIT_SHOTS) {
    for (const lang of FAMILIES) {
      const el = frame
        .locator(`.vditor-wysiwyg__preview > .language-${lang}`)
        .first()
      if (await el.count().catch(() => 0)) {
        await el
          .screenshot({ path: path.join(OUT, `${lang}.png`), timeout: 10_000 })
          .catch(() => {
            /* opt-in diagnostic shot (VMDE_AUDIT_SHOTS) — a slow/hidden
               family shouldn't abort the rest of the sweep */
          })
      }
    }
  }

  step('screenshots done')
  // Assert only that we measured SOMETHING — the values are the user's call, not a gate.
  expect(
    (sheet.rows as { rendered: unknown }[]).filter((r) => r.rendered).length,
  ).toBeGreaterThan(5)
})
