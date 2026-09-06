import { wf } from './webview-helpers'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'

// Graphviz (Viz.js) must (1) RENDER in the VS Code webview and (2) be PALETTE-PAIRED with the content
// theme: we inject palette colours as DOT graph/node/edge default statements so Graphviz colours the
// diagram semantically (node fill = surface, borders/edges = line, text = fg, transparent canvas) like
// mermaid — promoted from foreground-monochrome (task 94). themeGraphvizSvg still drops any white bg
// polygon. The fixture forces `vscode-dark-2026` (line/accent #48a0c7, fg #bbbebf, surface #232425) —
// the SVG must reference those, with no baked white background. Verified in the real webview because
// the worker + transparency behaviour does not reproduce in the harness.
const FIXTURE = path.join(__dirname, 'fixtures', 'all-renderers.md')
const OUT = path.join(__dirname, '../../tmp/puml-theme/out')
const LINE = '#48a0c7' // vscode-dark-2026 line/accent (borders + edges)
const FG = '#bbbebf' // vscode-dark-2026 foreground (text)
const SURFACE = '#232425' // derived node fill (mix(bg,fg,0.1))

test('graphviz renders + is palette-paired with the content theme', async ({
  workbox,
  evaluateInVSCode,
}) => {
  await evaluateInVSCode(
    async (vscode, args) => {
      const [uri] = args as [string]
      await vscode.workspace
        .getConfiguration('vmde')
        .update('theme.content', 'vscode-dark-2026', true)
      await vscode.extensions.getExtension('Laicasaane.vmde')?.activate()
      await vscode.commands.executeCommand(
        'vscode.openWith',
        vscode.Uri.file(uri),
        'vmde.editor',
      )
    },
    [FIXTURE] as [string],
  )
  const frame = wf(workbox)
  // (1) It RENDERS an <svg> (the worker fix) — this waitFor is itself the render regression.
  const svgLoc = frame
    .locator('.vditor-ir__preview .language-graphviz svg')
    .first()
  await svgLoc.waitFor({ timeout: 45_000 })

  await svgLoc
    .screenshot({ path: path.join(OUT, 'gv_e2e_vscode-dark.png') })
    .catch(() => {
      /* visual-eval scratch shot (tmp/, gitignored) — not asserted on, so a
         screenshot failure shouldn't fail the render-regression check above */
    })

  const readInfo = () =>
    frame.locator('body').evaluate(
      // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one-pass SVG palette census keeps the sampled DOM internally consistent
      () => {
        const svg = document.querySelector(
          '.vditor-ir__preview .language-graphviz svg',
        ) as SVGSVGElement
        const colours = new Set<string>()
        for (const el of Array.from(svg.querySelectorAll('[fill], [stroke]'))) {
          const f = (el.getAttribute('fill') ?? '').toLowerCase()
          const s = (el.getAttribute('stroke') ?? '').toLowerCase()
          if (f) colours.add(f)
          if (s) colours.add(s)
        }
        const text = svg.querySelector('text')
        return {
          colours: [...colours],
          whiteBg: [...colours].some((c) => c === '#ffffff' || c === 'white'),
          textFill: (text?.getAttribute('fill') ?? 'NO-TEXT').toLowerCase(),
          textComputedFill: text ? getComputedStyle(text).fill : 'NO-TEXT',
        }
      },
    )
  await expect
    .poll(async () => {
      const info = await readInfo()
      return (
        info.colours.includes(LINE) &&
        info.colours.includes(SURFACE) &&
        info.textFill === FG &&
        info.textComputedFill !== 'rgb(0, 0, 0)' &&
        !info.whiteBg
      )
    })
    .toBe(true)
  const info = await readInfo()
  // eslint-disable-next-line no-console
  console.log(`[graphviz] ${JSON.stringify(info)}`)

  // (2a) Borders/edges use the themed line colour, node fills the surface tint → actually PAIRED.
  expect(info.colours).toContain(LINE)
  expect(info.colours).toContain(SURFACE)
  // (2b) Text is the themed foreground (not baked black).
  expect(info.textFill).toBe(FG)
  expect(info.textComputedFill).not.toBe('rgb(0, 0, 0)')
  // (2c) No baked white background survives.
  expect(info.whiteBg).toBe(false)
})
