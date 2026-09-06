import { wf } from './webview-helpers'
// Custom diagram renderers: wavedrom, nomnoml, geojson, topojson, stl, d2.
// Real-VS-Code-only — these load via loadScript + the observer, which needs the
// real webview resource URI pipeline (not the Playwright harness). The fixture's
// geojson+topojson+vega+vega-lite blocks share script ids (vditorLeafletScript,
// vditorVegaScript) and render concurrently on open — this is the real-world repro
// for the loader race task 407 fixed (a shared-id script resolving before it executed).
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'

const FIXTURE = path.join(__dirname, 'fixtures', 'all-renderers.md')

test('custom diagrams render in the real VS Code webview', async ({
  workbox,
  evaluateInVSCode,
}) => {
  // Collect errors before opening so lazy-loader/render failures cannot occur before the listener.
  const errors: string[] = []
  workbox.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text())
  })
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
  await expect
    .poll(
      () =>
        frame.locator('body').evaluate(() => {
          const ready = (lang: string) => {
            const targets = document.querySelectorAll(
              `div.language-${lang}[data-code]`,
            ).length
            const processed = document.querySelectorAll(
              `.language-${lang}[data-processed="true"]`,
            ).length
            return targets > 0 && processed === targets
          }
          return (
            [
              'wavedrom',
              'nomnoml',
              'geojson',
              'topojson',
              'vega-lite',
              'stl',
            ].every(ready) &&
            !!document.querySelector('.language-wavedrom svg') &&
            !!document.querySelector('.language-nomnoml svg') &&
            !!document.querySelector('.language-geojson .leaflet-container') &&
            !!document.querySelector('.language-topojson .leaflet-container') &&
            !!document.querySelector('.language-vega-lite svg') &&
            !!document.querySelector('.language-d2 svg') &&
            !!document.querySelector('.language-d2-unsupported')
          )
        }),
      { timeout: 60_000 },
    )
    .toBe(true)

  const info = await frame.locator('body').evaluate(() => {
    const check = (lang: string) => {
      const els = document.querySelectorAll(`.language-${lang}`)
      // The findBlocks render targets — the `div.language-X[data-code]` wrappers the engine
      // fills. The fixture gains variants over time (4 wavedrom fences since the reg/assign/
      // config fixes), so the expectations below compare processed AGAINST this DOM count
      // instead of a hardcoded literal that rots when a fixture block is added.
      const targets = document.querySelectorAll(
        `div.language-${lang}[data-code]`,
      )
      const processed = document.querySelectorAll(
        `.language-${lang}[data-processed="true"]`,
      )
      const hasSvg = !!document.querySelector(`.language-${lang} svg`)
      const hasCanvas = !!document.querySelector(`.language-${lang} canvas`)
      const hasLeaflet = !!document.querySelector(
        `.language-${lang} .leaflet-container`,
      )
      return {
        found: els.length,
        targets: targets.length,
        processed: processed.length,
        hasSvg,
        hasCanvas,
        hasLeaflet,
      }
    }
    const innerHTML = (lang: string) => {
      const el = document.querySelector(
        `.language-${lang}[data-processed="true"]`,
      )
      if (!el) return 'NOT_PROCESSED'
      const parent = el.parentElement?.className ?? 'no-parent'
      const tag = el.tagName
      const children = [...el.children].map((c) => c.tagName).join(',')
      return `[${tag} parent:${parent}] children:${children} html:${el.innerHTML.substring(0, 150)}`
    }
    return {
      wavedrom: check('wavedrom'),
      nomnoml: check('nomnoml'),
      geojson: check('geojson'),
      topojson: check('topojson'),
      'vega-lite': check('vega-lite'),
      stl: check('stl'),
      d2: check('d2'),
      d2unsupported: !!document.querySelector('.language-d2-unsupported'),
      html: {
        geojson: innerHTML('geojson'),
        stl: innerHTML('stl'),
        wavedrom: innerHTML('wavedrom'),
        nomnoml: innerHTML('nomnoml'),
      },
    }
  })

  // eslint-disable-next-line no-console
  console.log(`[custom-diagrams] ${JSON.stringify(info, null, 2)}`)
  // eslint-disable-next-line no-console
  console.log(`[custom-diagrams] errors: ${JSON.stringify(errors)}`)

  // Check debug messages from Output channel
  const dbgMsgs = await frame.locator('body').evaluate(() => {
    return (window as any).__vmdeDbg ?? []
  })
  // eslint-disable-next-line no-console
  console.log(`[custom-diagrams] dbg: ${JSON.stringify(dbgMsgs)}`)

  // Each renderer should find at least 1 block with the language class
  expect(info.wavedrom.found).toBeGreaterThan(0)
  expect(info.nomnoml.found).toBeGreaterThan(0)
  expect(info.geojson.found).toBeGreaterThan(0)
  expect(info.topojson.found).toBeGreaterThan(0)
  expect(info.stl.found).toBeGreaterThan(0)

  // EVERY render target each engine finds in the fixture must end up processed — tied to
  // the DOM target count, not a literal (the old `toBe(1)` rotted when the fixture gained
  // wavedrom variants and silently turned the nightly red).
  for (const lang of [
    'wavedrom',
    'nomnoml',
    'geojson',
    'topojson',
    'vega-lite',
    'stl',
  ] as const) {
    expect(info[lang].targets, `${lang} render targets`).toBeGreaterThan(0)
    expect(info[lang].processed, `${lang} processed == targets`).toBe(
      info[lang].targets,
    )
  }
  expect(info.wavedrom.hasSvg).toBe(true)
  expect(info.nomnoml.hasSvg).toBe(true)
  expect(info.geojson.hasLeaflet).toBe(true)
  expect(info.topojson.hasLeaflet).toBe(true)
  expect(info['vega-lite'].hasSvg).toBe(true)
  // STL renders WebGL — which a GPU-less headless Electron (xvfb without SwiftShader) may not
  // provide at all. When WebGL exists the canvas must appear; when it doesn't, the renderer
  // must fail LOUDLY into the themed error box (task 178) — never a silent blank block.
  const stlState = await frame.locator('body').evaluate(() => {
    const c = document.createElement('canvas')
    const webgl = !!(c.getContext('webgl2') || c.getContext('webgl'))
    return {
      webgl,
      errorBox: !!document.querySelector('.language-stl .vmde-diagram-error'),
    }
  })
  if (stlState.webgl) {
    expect(info.stl.hasCanvas).toBe(true)
  } else {
    expect(stlState.errorBox, 'no WebGL → loud STL error box').toBe(true)
  }

  // D2: a plain diagram compiles (WASM) + lays out (dagre) + renders SVG. The fixture has TWO
  // d2 blocks (a plain one + a sequence_diagram), so assert >=1 processed, not ===1.
  expect(info.d2.found).toBeGreaterThan(0)
  expect(info.d2.processed).toBeGreaterThan(0)
  expect(info.d2.hasSvg).toBe(true)
  // The sequence_diagram block must fall back LOUDLY to raw source (never a wrong picture).
  expect(info.d2unsupported).toBe(true)

  // Deep Leaflet check: geometry paths rendered + visible dimensions
  const leafletDetail = await frame.locator('body').evaluate(() => {
    const geoContainer = document.querySelector(
      '.language-geojson .leaflet-container',
    ) as HTMLElement | null
    const topoContainer = document.querySelector(
      '.language-topojson .leaflet-container',
    ) as HTMLElement | null
    const geoCheck = (c: HTMLElement | null) => {
      if (!c) return { exists: false, w: 0, h: 0, paths: 0, visible: false }
      const r = c.getBoundingClientRect()
      const paths = c.querySelectorAll('path').length
      const cssLink = document.getElementById('vditorLeafletCss')
      return {
        exists: true,
        w: Math.round(r.width),
        h: Math.round(r.height),
        paths,
        visible: r.width > 0 && r.height > 0,
        cssLoaded: !!cssLink,
      }
    }
    return {
      geojson: geoCheck(geoContainer),
      topojson: geoCheck(topoContainer),
    }
  })

  // eslint-disable-next-line no-console
  console.log(`[custom-diagrams] leaflet: ${JSON.stringify(leafletDetail)}`)

  expect(leafletDetail.geojson.visible).toBe(true)
  expect(leafletDetail.geojson.paths).toBeGreaterThan(0)
  expect(leafletDetail.geojson.h).toBeGreaterThanOrEqual(280)
  expect(leafletDetail.topojson.visible).toBe(true)
  expect(leafletDetail.topojson.paths).toBeGreaterThan(0)

  // Theme check: dump unique fill/stroke values from wavedrom + nomnoml SVGs
  const themeCheck = await frame.locator('body').evaluate(() => {
    const collectColors = (sel: string) => {
      const svg = document.querySelector(sel)
      if (!svg) return { fills: [], strokes: [], styles: [] }
      const fills = new Set<string>()
      const strokes = new Set<string>()
      const styles = new Set<string>()
      svg.querySelectorAll('*').forEach((el) => {
        const f = el.getAttribute('fill')
        if (f) fills.add(f)
        const s = el.getAttribute('stroke')
        if (s) strokes.add(s)
        const st = el.getAttribute('style')
        if (st) styles.add(st.substring(0, 60))
      })
      return {
        fills: [...fills],
        strokes: [...strokes],
        styles: [...styles].slice(0, 10),
      }
    }
    return {
      wavedrom: collectColors('.language-wavedrom svg'),
      nomnoml: collectColors('.language-nomnoml svg'),
    }
  })
  // eslint-disable-next-line no-console
  console.log(`[custom-diagrams] theme: ${JSON.stringify(themeCheck, null, 2)}`)
})
