import { wf } from './webview-helpers'
// PlantUML loading placeholder (task 139). The first PlantUML render in a webview session waits
// ~0.9–1.15s for the ~7MB TeaVM engine to lazy-load + warm up (measured). During that window the block
// must show a "Rendering PlantUML…" placeholder instead of sitting empty, then swap cleanly to the SVG.
// Real-VS-Code only: the lazy-load + resource pipeline don't reproduce in the Playwright harness. This
// asserts (1) the placeholder appears during the cold load and (2) it's removed with no leftover once
// the SVG lands. The placeholder DOM itself is unit-tested in media-src/src/diagram-loading.test.ts.
//
// Catch mechanism: an IN-PAGE MutationObserver installed as soon as the frame body exists — it records
// whether `.vmde-diagram-loading` EVER appears (the placeholder is brief), with no CDP round-trip per
// sample. A Node-side poll loop was too slow (frame re-resolution latency missed the ~1s window).
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'

const FIXTURE = path.join(__dirname, 'fixtures', 'plantuml-loading.md')

test('plantuml shows a loading placeholder on cold first render, then swaps to the SVG', async ({
  workbox,
  evaluateInVSCode,
}) => {
  test.setTimeout(120_000)
  await evaluateInVSCode(
    async (vscode, args) => {
      const [uri] = args as [string]
      await vscode.commands.executeCommand('workbench.action.closeAllEditors')
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

  // Install the observer the moment the frame body is reachable — well before the engine finishes its
  // ~1s cold load, so the brief placeholder can't slip past between CDP polls.
  await frame.locator('body').waitFor({ timeout: 60_000 })
  await frame.locator('body').evaluate(() => {
    const w = window as unknown as {
      __pumlLoad?: { saw: boolean; spinner: boolean; label: string }
      __pumlLoadObs?: MutationObserver
    }
    w.__pumlLoad = { saw: false, spinner: false, label: '' }
    const check = () => {
      // Scope to the PREVIEW half: in IR mode the block is a dual-node (editable source
      // `.vditor-ir__marker--pre .language-plantuml` + render `.vditor-ir__preview .language-plantuml`);
      // the placeholder + SVG go in the preview one (the source block is skipped by plantumlRender).
      const load = document.querySelector(
        '.vditor-ir__preview .language-plantuml .vmde-diagram-loading',
      )
      if (load && w.__pumlLoad && !w.__pumlLoad.saw) {
        w.__pumlLoad.saw = true
        w.__pumlLoad.spinner = !!load.querySelector(
          '.vmde-diagram-loading__spinner',
        )
        w.__pumlLoad.label =
          load.querySelector('.vmde-diagram-loading__label')?.textContent ?? ''
      }
    }
    check()
    const obs = new MutationObserver(check)
    obs.observe(document.documentElement, { childList: true, subtree: true })
    w.__pumlLoadObs = obs
  })

  // Wait for the real SVG to land, then settle so the placeholder-removal has definitely run.
  await frame
    .locator('.vditor-ir__preview .language-plantuml svg')
    .first()
    .waitFor({ timeout: 45_000 })
  await frame
    .locator('body')
    .evaluate(() => new Promise((r) => setTimeout(r, 800)))

  const res = await frame.locator('body').evaluate(() => {
    const w = window as unknown as {
      __pumlLoad?: { saw: boolean; spinner: boolean; label: string }
      __pumlLoadObs?: MutationObserver
    }
    w.__pumlLoadObs?.disconnect()
    const block = document.querySelector(
      '.vditor-ir__preview .language-plantuml',
    )
    return {
      saw: w.__pumlLoad?.saw ?? false,
      spinner: w.__pumlLoad?.spinner ?? false,
      label: w.__pumlLoad?.label ?? '',
      hasSvg: !!block?.querySelector('svg'),
      leftover: block?.querySelectorAll('.vmde-diagram-loading').length ?? -1,
    }
  })
  // eslint-disable-next-line no-console
  console.log(`[puml-loading] ${JSON.stringify(res)}`)

  // (1) the placeholder was shown during the cold load, with its spinner + engine-named label…
  expect(res.saw, 'the loading placeholder appeared during cold load').toBe(
    true,
  )
  expect(res.spinner, 'the placeholder had its spinner').toBe(true)
  expect(res.label).toContain('Rendering PlantUML')
  // (2) …and it was cleanly removed once the SVG landed (no leftover placeholder in the block).
  expect(res.hasSvg).toBe(true)
  expect(res.leftover).toBe(0)
})
