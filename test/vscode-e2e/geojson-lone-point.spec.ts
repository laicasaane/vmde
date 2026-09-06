import { wf } from './webview-helpers'
// Task 479 — a lone-point geojson/topojson map has ZERO-AREA bounds. Leaflet's fitBounds() on a
// zero-area box computes zoom = Infinity (confirmed against the vendored leaflet.js) and RETURNS it
// rather than throwing, so the existing try/catch in initLeafletMap never saw it — the map silently
// rendered at infinite zoom. Fix: detect the degenerate case and use setView(center, fixed zoom)
// instead. Real VS Code only (Leaflet + the custom-editor CSP/webview pipeline).
//
// This is a SEPARATE fixture from diagram-zoom-keys.md on purpose — that fixture was deliberately
// changed (task 459) from a Point to a ~10°-square Polygon so its keyboard-zoom assertions aren't
// masked by this degenerate-bounds bug. Conflating the two specs is exactly how the bug got missed
// the first time; see task 479's task file.
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'

const FIXTURE = path.join(__dirname, 'fixtures', 'geojson-lone-point.md')

test('a lone-point geojson/topojson map gets a finite, sensible zoom (not Infinity)', async ({
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
    .locator('.language-geojson .leaflet-container')
    .first()
    .waitFor({ timeout: 30_000 })
  await frame
    .locator('.language-topojson .leaflet-container')
    .first()
    .waitFor({ timeout: 30_000 })

  const readInfo = () =>
    frame.locator('body').evaluate(() => {
      function mapInfo(selector: string) {
        const container = document.querySelector(
          `${selector} .leaflet-container`,
        ) as HTMLElement
        const wrap = container?.closest(selector) as HTMLElement & {
          __vmdeMap?: {
            getZoom: () => number
            getCenter: () => { lat: number; lng: number }
          }
        }
        const map = wrap?.__vmdeMap
        return {
          hasContainer: !!container,
          hasStash: !!map,
          zoom: map?.getZoom(),
          center: map?.getCenter(),
          // A rendered pane (tiles aside) reports a non-zero client size once laid out — this is the
          // "usable map" check the task asks for, distinct from the zoom-finiteness check.
          width: container?.clientWidth,
          height: container?.clientHeight,
        }
      }
      return {
        geojson: mapInfo('.language-geojson'),
        topojson: mapInfo('.language-topojson'),
      }
    })
  await expect
    .poll(async () => {
      const info = await readInfo()
      return Object.values(info).every(
        (map) =>
          map.hasContainer &&
          map.hasStash &&
          Number.isFinite(map.zoom) &&
          (map.width ?? 0) > 0 &&
          (map.height ?? 0) > 0,
      )
    })
    .toBe(true)
  const info = await readInfo()
  // eslint-disable-next-line no-console
  console.log(`[geojson-lone-point] ${JSON.stringify(info)}`)

  for (const [label, m] of Object.entries(info)) {
    expect(m.hasContainer, `${label} container`).toBe(true)
    expect(m.hasStash, `${label} map stash`).toBe(true)
    expect(Number.isFinite(m.zoom), `${label} zoom finite`).toBe(true)
    // The fallback zoom (see DEGENERATE_POINT_ZOOM in geojson-topojson.ts) is a fixed "city" level —
    // sanity-bound it well clear of both 0 (whole world, what an unclamped Infinity would visually
    // collapse toward) and the basemap's maxZoom (19).
    expect(m.zoom, `${label} zoom in range`).toBeGreaterThan(2)
    expect(m.zoom, `${label} zoom in range`).toBeLessThan(19)
    expect(m.center?.lat, `${label} center lat`).toBeCloseTo(51.5072, 2)
    expect(m.center?.lng, `${label} center lng`).toBeCloseTo(-0.1276, 2)
    expect(m.width, `${label} usable width`).toBeGreaterThan(0)
    expect(m.height, `${label} usable height`).toBeGreaterThan(0)
  }
})
