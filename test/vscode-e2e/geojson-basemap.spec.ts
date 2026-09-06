import { wf } from './webview-helpers'
// The `vmde.diagram.geo.basemap` setting picks the basemap UNDER geojson/topojson maps. Default `auto`
// is themed monochrome CARTO (covered by geojson-tiles.spec.ts); here we verify the override values
// load the right tile source: `osm` → OpenStreetMap, `voyager` → CARTO Voyager (colored), `none` →
// no basemap even with remote images allowed. All gated by image.allowRemoteImages (CSP). Real VS Code
// only (Leaflet tiles + the custom-editor CSP pipeline).
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'

const FIXTURE = path.join(__dirname, 'fixtures', 'all-renderers.md')

// Reset the globally-written settings after each test so this spec doesn't pollute others sharing the
// VS Code instance (geojson-tiles.spec.ts relies on the DEFAULT geoBasemap — leaking `none` here would
// break its ON case). `update(key, undefined, true)` drops the global override → back to the default.
async function reset(
  evaluateInVSCode: (fn: unknown, args: unknown) => Promise<unknown>,
) {
  await evaluateInVSCode(async (vscode: typeof import('vscode')) => {
    const cfg = vscode.workspace.getConfiguration('vmde')
    await cfg.update('diagram.geo.basemap', undefined, true)
    await cfg.update('image.allowRemote', undefined, true)
  }, [])
}

async function open(
  evaluateInVSCode: (fn: unknown, args: unknown) => Promise<unknown>,
  basemap: string,
) {
  await evaluateInVSCode(
    async (vscode: typeof import('vscode'), args: [string, string]) => {
      const [uri, geoBasemap] = args
      await vscode.commands.executeCommand('workbench.action.closeAllEditors')
      const cfg = vscode.workspace.getConfiguration('vmde')
      await cfg.update('image.allowRemote', true, true)
      await cfg.update('diagram.geo.basemap', geoBasemap, true)
      await vscode.extensions.getExtension('Laicasaane.vmde')?.activate()
      await vscode.commands.executeCommand(
        'vscode.openWith',
        vscode.Uri.file(uri),
        'vmde.editor',
      )
    },
    [FIXTURE, basemap] as [string, string],
  )
}

function tileInfo(frame: ReturnType<typeof wf>) {
  return frame.locator('body').evaluate(() => {
    const tiles = [
      ...document.querySelectorAll('.language-geojson img.leaflet-tile'),
    ] as HTMLImageElement[]
    return {
      tileCount: tiles.length,
      anyOsm: tiles.some((t) => t.src.includes('tile.openstreetmap.org')),
      anyVoyager: tiles.some((t) =>
        t.src.includes('cartocdn.com/rastertiles/voyager'),
      ),
      anyMono: tiles.some(
        (t) =>
          t.src.includes('cartocdn.com/light_all') ||
          t.src.includes('cartocdn.com/dark_all'),
      ),
    }
  })
}

async function waitForMap(frame: ReturnType<typeof wf>) {
  await frame
    .locator('.language-geojson .leaflet-container')
    .first()
    .waitFor({ timeout: 60_000 })
  // task 512: retain — shared call covers positive tile variants and the negative no-tile variant
  await frame
    .locator('body')
    .evaluate(() => new Promise((r) => setTimeout(r, 2500)))
}

test('geoBasemap variants load only their selected tile source', async ({
  workbox,
  evaluateInVSCode,
}) => {
  const frame = wf(workbox)
  test.setTimeout(180_000)
  try {
    for (const variant of [
      { basemap: 'osm', tile: 'OpenStreetMap', visible: true },
      { basemap: 'voyager', tile: 'CARTO Voyager', visible: true },
      { basemap: 'none', tile: 'none', visible: false },
    ] as const) {
      await open(evaluateInVSCode, variant.basemap)
      await waitForMap(frame)
      const info = await tileInfo(frame)
      console.log(
        `[geojson-basemap ${variant.basemap}] ${JSON.stringify(info)}`,
      )
      if (variant.visible) {
        expect
          .soft(info.tileCount, `${variant.basemap}: has tiles`)
          .toBeGreaterThan(0)
        expect
          .soft(info.anyMono, `${variant.basemap}: not mono CARTO`)
          .toBe(false)
      } else {
        expect.soft(info.tileCount, `${variant.basemap}: no tiles`).toBe(0)
      }
      expect
        .soft(info.anyOsm, `${variant.basemap}: OSM`)
        .toBe(variant.basemap === 'osm')
      expect
        .soft(info.anyVoyager, `${variant.basemap}: Voyager`)
        .toBe(variant.basemap === 'voyager')
    }
  } finally {
    await reset(evaluateInVSCode)
  }
})
