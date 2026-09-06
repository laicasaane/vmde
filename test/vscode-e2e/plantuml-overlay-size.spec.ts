import { wf } from './webview-helpers'
// PlantUML keep-last overlay must match the LIVE diagram size (no shrink-then-jump while editing) —
// real-VS-Code only.
//
// Bug: while typing, edit-activity.ts shows the cached render in a `.vmde-stale-overlay` div (task
// 161). The live plantuml svg used to carry `min-width:300px` (main.css) so small diagrams stretched to
// 300px, but the overlay svg only got `max-width:100%; height:auto` — so a small plantuml shrank under
// the overlay and JUMPED back to 300px when the real render swapped in. The `data-lang` bridge fixed
// that (NOT a `.language-X` class — observers key on that and must not re-process the overlay).
//
// Task 355: the 300px CSS boost is GONE — with `height:auto` it scaled the whole drawing and blew the
// labels up to ~2.8x (user: "za duże czcionki"). The settled render (step 4) is a UNIFORM 14 layout
// font at scale 1: the intermediate "lay out small, scale up" pairs (9/1.5, 7/1.7) shipped labels
// that OVERFLOWED their shapes in the user's editor — a ~14px minimum-font-size floor there draws any
// smaller font at ~14 while the engine's layout assumed the small one. Hence the invariants asserted
// here: (a) the labels sit at prose size on screen AND (b) the drawing is at its natural size, which
// together are what "the layout font is what actually gets drawn" looks like from outside; plus (c)
// the overlay matches the live diagram, which keeps the edit-time swap jump-free. Measured in the
// real webview, where plantuml's TeaVM render + the real layout actually run.
//
// NOTE what this no longer covers: with the boost gone the three widths are identical (104/104/104),
// so the `data-lang` BRIDGE itself is not exercised here anymore — plantuml needs no per-engine
// overlay rule. The bridge still carries smiles/abc/graphviz; if it ever regresses, this spec will
// not be the one that says so.
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'

const FIXTURE = path.join(__dirname, 'fixtures', 'plantuml-resize.md')

test('plantuml keep-last overlay matches the live diagram width (no shrink/jump)', async ({
  workbox,
  evaluateInVSCode,
}) => {
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

  const frame = wf(workbox)
  await frame.locator('.vditor-ir').first().waitFor({ timeout: 60_000 })
  await frame
    .locator('.language-plantuml svg')
    .first()
    .waitFor({ timeout: 60_000 })
  await frame
    .locator('body')
    .evaluate(() => new Promise((r) => setTimeout(r, 1000)))

  const info = await frame.locator('body').evaluate(() => {
    // `.language-plantuml` matches the editable SOURCE code first (no svg) — pick the RENDERED one by
    // finding the svg, then walking up to its wrapper + preview pane.
    const live = (document.querySelector(
      '.vditor-ir__preview .language-plantuml > svg',
    ) ?? document.querySelector('.language-plantuml svg')) as SVGElement | null
    const wrap = live?.closest('.language-plantuml') as HTMLElement | null
    const preview =
      (wrap?.closest('.vditor-ir__preview') as HTMLElement) ??
      (wrap?.parentElement as HTMLElement)
    if (!live || !preview) return { error: 'no rendered plantuml svg' }
    const liveW = live.getBoundingClientRect().width
    const vb = (live.getAttribute('viewBox') ?? '').split(/[ ,]+/).map(Number)
    const naturalW = vb.length === 4 ? vb[2] : 0
    // On-screen label size = the font in USER units times the viewBox->pixel scale.
    const px = live.getBoundingClientRect().width / (naturalW || 1)
    const fonts = Array.from(live.querySelectorAll('text'))
      // Skip the class/interface TYPE ICON — a single monospace letter inside its own circle, which
      // PlantUML sizes independently of the root font (17 units, unaffected by our FontSize). It is
      // part of the drawing, not a label, so it scales with the drawing by design.
      .filter((t) => (t.textContent ?? '').trim().length > 1)
      .map((t) => Number.parseFloat(getComputedStyle(t).fontSize) * px)
    // Replicate restoreOverlay's DOM exactly (visualSnapshot caches the live svg outerHTML) and measure
    // the overlay svg width with vs without the data-lang bridge.
    const html = live.outerHTML
    const measure = (withLang: boolean): number => {
      const o = document.createElement('div')
      o.className = 'vmde-stale-overlay'
      o.setAttribute('data-render', '1')
      if (withLang) o.setAttribute('data-lang', 'plantuml')
      o.innerHTML = html
      preview.appendChild(o)
      const w = (o.querySelector('svg') as SVGElement).getBoundingClientRect()
        .width
      o.remove()
      return w
    }
    const prose = Number.parseFloat(
      getComputedStyle(document.querySelector('.vditor-reset') ?? document.body)
        .fontSize,
    )
    return {
      liveW,
      naturalW,
      prose,
      maxFontPx: fonts.length ? Math.max(...fonts) : 0,
      scale: px,
      withLang: measure(true),
      without: measure(false),
    }
  })
  // eslint-disable-next-line no-console
  console.log(`[plantuml-overlay-size] ${JSON.stringify(info)}`)

  expect(info.error).toBeUndefined()
  // fixture sanity: the diagram is narrow enough that nothing clamps it to the column, so the scale
  // measured below is the one the render chose (if it ever became column-wide this asserts nothing).
  expect(info.naturalW ?? 0).toBeGreaterThan(0)
  const scale = (info.liveW ?? 0) / (info.naturalW ?? 1)
  expect(
    scale,
    `plantuml rendered at ${scale.toFixed(2)}x its natural width — the settled render applies no scale`,
  ).toBeLessThanOrEqual(1.02)
  // THE GUARD (task 355): the labels land at prose size — never the ~40px the old CSS boost produced.
  // Allow prose + 2px: the layout font is 14 units at scale 1, against 14px prose.
  expect(
    info.maxFontPx ?? 0,
    `plantuml labels render at ${(info.maxFontPx ?? 0).toFixed(1)}px against ${info.prose}px prose (scale ${(info.scale ?? 0).toFixed(2)}x) — the layout FontSize and the SVG scale must change together`,
  ).toBeLessThanOrEqual((info.prose ?? 14) + 2)
  // the overlay renders at the SAME width as the live diagram (no shrink-then-jump on swap)
  expect(Math.abs((info.withLang ?? 0) - (info.liveW ?? 0))).toBeLessThan(2)
})
