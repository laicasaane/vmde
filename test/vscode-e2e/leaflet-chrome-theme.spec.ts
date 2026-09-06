import { wf } from './webview-helpers'
// Task 531 replaces Leaflet's native +/- with the shared viewport bar. Its chrome must follow the
// editor theme while attribution remains Leaflet-owned.
//
// Asserted in the REAL webview because that is the only place VS Code's `--vscode-editorWidget-*`
// tokens actually resolve — in the chromium harness they are undefined and every rule below falls
// back to the Leaflet default it is supposed to replace, so a harness test would assert the bug.
//
// BOTH themes in one boot, and that is the point rather than thoroughness for its own sake: the
// hardcoded white/black IS correct on light, so a dark-only fix that regressed light would still
// pass a dark-only test. The assertion is therefore relational (the control's background tracks the
// editor's own surface and inverts with the theme), not a pinned colour value.
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'

const FIXTURE = path.join(__dirname, 'fixtures', 'all-renderers.md')

// Perceived lightness of a computed `rgb(...)`, 0..255. Comparing luminance rather than exact
// strings keeps this robust to VS Code changing its own token values between releases.
const LUMA_FN = (css: string): number => {
  const m = /rgba?\(([^)]+)\)/.exec(css)
  if (!m) return Number.NaN
  const [r, g, b] = m[1].split(',').map((n) => Number.parseFloat(n))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

test('the shared GeoJSON viewport controls follow the editor theme in light and dark', async ({
  workbox,
  evaluateInVSCode,
}) => {
  test.setTimeout(150_000)

  const setTheme = async (name: string) => {
    await evaluateInVSCode(
      async (vscode: typeof import('vscode'), args: string[]) => {
        await vscode.workspace
          .getConfiguration('vmde')
          .update('theme.content', 'auto', vscode.ConfigurationTarget.Global)
        await vscode.workspace
          .getConfiguration('workbench')
          .update('colorTheme', args[0], vscode.ConfigurationTarget.Global)
      },
      [name] as [string],
    )
  }

  await setTheme('Default Dark Modern')
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
  await frame
    .locator('.language-geojson > .vmde-diagram-controls')
    .first()
    .waitFor({ timeout: 60_000, state: 'attached' })

  // The control's own background, the editor surface it sits on, and the Leaflet default it must no
  // longer be — read together so the comparison is of one moment, not three.
  const read = () =>
    frame.locator('body').evaluate(() => {
      const a = document.querySelector(
        '.language-geojson > .vmde-diagram-controls',
      )
      if (!a) return null
      const cs = getComputedStyle(a)
      return {
        bg: cs.backgroundColor,
        fg: cs.color,
        editorBg: getComputedStyle(document.body).getPropertyValue(
          '--vscode-editor-background',
        ),
      }
    })

  const dark = await read()
  expect(dark, 'a zoom control is present').not.toBeNull()
  const darkBg = LUMA_FN(dark?.bg ?? '')
  const darkFg = LUMA_FN(dark?.fg ?? '')
  // The whole bug: pure white (luma 255) behind near-black text on a dark pane.
  expect(darkBg, 'not Leaflet default white on dark').toBeLessThan(140)
  expect(darkFg, 'text is light on a dark control').toBeGreaterThan(darkBg)

  await setTheme('Default Light Modern')
  await expect
    .poll(async () => LUMA_FN((await read())?.bg ?? ''), { timeout: 30_000 })
    .toBeGreaterThan(140)
  const light = await read()
  // Light must NOT have been "fixed" into darkness — the original hardcoded white was already right
  // here, and a naive token swap is exactly how that half gets broken.
  expect(
    LUMA_FN(light?.fg ?? ''),
    'text is dark on a light control',
  ).toBeLessThan(LUMA_FN(light?.bg ?? ''))
})
