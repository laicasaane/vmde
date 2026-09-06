import { wf } from './webview-helpers'
// STL 3D-model material colour — real-VS-Code regression guard for the "all-black cube on a light
// theme" bug. The model used to take its three.js material colour from the wrapper's computed
// foreground (currentColor); three.js lighting MULTIPLIES the base, so a near-black foreground (every
// light content theme, e.g. github-light) rendered a formless black blob. The fix is a fixed neutral
// mid-grey (STL_MATERIAL_COLOR in custom-diagrams.ts).
//
// This spec deliberately does NOT assert the WebGL RENDER (no pixel read-back), only the recorded
// material colour — but it IS host-capability dependent, so it branches on WebGL availability:
//   - WebGL present (a real user's editor)  → assert data-stl-material == the fixed neutral grey.
//   - No WebGL (headless xvfb here)         → the renderer throws and the task-178 error path replaces
//     the wrapper, taking the canvas (and the attribute) with it; assert the themed WebGL error box.
// An earlier version asserted the attribute unconditionally, on the premise that it is written before
// the WebGLRenderer is constructed and so survives a GPU-less host. That premise held when written and
// the error box later broke it — which is why this spec failed deterministically under xvfb.
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'

const FIXTURE = path.join(__dirname, 'fixtures', 'all-renderers.md')

test('STL model uses the fixed neutral material, not the theme foreground', async ({
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

  // Can THIS host create a WebGL context? Decides which of the two outcomes below is the correct one.
  const hasWebGL = await frame.locator('body').evaluate(() => {
    try {
      const c = document.createElement('canvas')
      return !!(
        c.getContext('webgl2') ??
        c.getContext('webgl') ??
        c.getContext('experimental-webgl')
      )
    } catch {
      return false
    }
  })

  // Wait for the STL block to reach a terminal state: either the viewer canvas or the themed error box.
  await frame
    .locator('.language-stl canvas, .language-stl .vmde-diagram-error')
    .first()
    .waitFor({ timeout: 60_000 })

  const state = await frame.locator('body').evaluate(() => {
    const canvas = document.querySelector(
      '.language-stl canvas',
    ) as HTMLElement | null
    const err = document.querySelector('.language-stl .vmde-diagram-error')
    return {
      material: canvas?.dataset.stlMaterial ?? '',
      error: (err?.textContent ?? '').replace(/\s+/g, ' ').slice(0, 120),
    }
  })
  // eslint-disable-next-line no-console
  console.log(
    `[stl-material] hasWebGL=${hasWebGL} data-stl-material=${JSON.stringify(state.material)} error=${JSON.stringify(state.error)}`,
  )

  if (hasWebGL) {
    // The neutral mid-grey from STL_MATERIAL_COLOR — and emphatically NOT a near-black theme foreground.
    expect(state.material).toBe('#9aa0a6')
    return
  }

  // NO WebGL (headless xvfb): three.js throws "Error creating WebGL context." inside initStlViewer, and
  // the task-178 error path REPLACES the wrapper — which destroys the canvas that carried
  // data-stl-material. The colour therefore cannot be observed here at all; asserting it would only test
  // the host's GPU. (This spec's original header claimed the attribute survives a WebGL-less host — that
  // was true when written, and the error box later invalidated it. That stale premise, not a product
  // regression, is why this spec failed deterministically.) What IS verifiable: the STL pipeline ran end
  // to end — script loaded, geometry parsed, material built — and failed ONLY at the GPU boundary, with
  // the themed error box rather than raw source (the task-360 guarantee).
  // The exact colour value is guarded by the unit test in media-src/src/stl-material.test.ts.
  expect(
    state.error,
    'without WebGL the STL block must show the themed error box',
  ).toContain('WebGL')
})
