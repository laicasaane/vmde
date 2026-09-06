import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import { wf } from './webview-helpers'

const FIXTURE = path.join(__dirname, 'fixtures', 'remaining-vendor-upgrades.md')
const SVG_LANGS = [
  'mermaid',
  'd2',
  'abc',
  'smiles',
  'wavedrom',
  'flowchart',
  'plantuml',
  'graphviz',
]

test('remaining vendor families render together, offline and without engine errors', async ({
  workbox,
  evaluateInVSCode,
}) => {
  const remoteRequests: string[] = []
  const pageErrors: string[] = []
  workbox.on('request', (request) => {
    const url = request.url()
    if (
      /^https?:\/\//.test(url) &&
      !url.startsWith('https://file+.vscode-resource.vscode-cdn.net/') &&
      /unpkg\.com|cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com|plantuml\.com|vega\.github\.io|wavedrom|abcjs|smiles-drawer|viz-js/i.test(
        url,
      )
    ) {
      remoteRequests.push(url)
    }
  })
  workbox.on('pageerror', (error) => pageErrors.push(String(error)))

  await evaluateInVSCode(
    async (vscode, args) => {
      const [uri] = args as [string]
      await vscode.commands.executeCommand('workbench.action.closeAllEditors')
      await vscode.workspace
        .getConfiguration('vmde')
        .update('diagram.mermaid.layout', 'elk', true)
      await vscode.workspace
        .getConfiguration('vmde')
        .update('diagram.d2.layout', 'vmde', true)
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
        frame.locator('body').evaluate((_body, languages) => {
          const svgReady = (language: string) =>
            !!document.querySelector(`.language-${language} svg`)
          return (
            (languages as string[]).every(svgReady) &&
            !!document.querySelector(
              '.language-vega svg, .language-vega canvas',
            ) &&
            !!document.querySelector(
              '.language-vega-lite svg, .language-vega-lite canvas',
            ) &&
            !!document.querySelector(
              '.language-stl canvas, .language-stl .vmde-diagram-error',
            )
          )
        }, SVG_LANGS),
      { timeout: 90_000 },
    )
    .toBe(true)

  const state = await frame.locator('body').evaluate((_body, languages) => {
    const stl = document.querySelector('.language-stl[data-code]')
    const errors = Array.from(
      document.querySelectorAll<HTMLElement>('.vmde-diagram-error'),
    ).map((element) => ({
      language:
        element.closest<HTMLElement>('[class*="language-"]')?.className ?? '',
      text: element.textContent ?? '',
    }))
    return {
      missing: (languages as string[]).filter(
        (language) => !document.querySelector(`.language-${language} svg`),
      ),
      vega: !!document.querySelector(
        '.language-vega svg, .language-vega canvas',
      ),
      vegaLite: !!document.querySelector(
        '.language-vega-lite svg, .language-vega-lite canvas',
      ),
      stlCanvas: !!stl?.querySelector('canvas'),
      stlError: stl?.querySelector('.vmde-diagram-error')?.textContent ?? '',
      errors,
      mermaidElk: (window as any).__vmdeMermaidElkRegistered === true,
      d2Engine:
        document
          .querySelector('.language-d2[data-d2-engine]')
          ?.getAttribute('data-d2-engine') ?? '',
    }
  }, SVG_LANGS)

  expect(state.missing).toEqual([])
  expect(state.vega).toBe(true)
  expect(state.vegaLite).toBe(true)
  expect(state.mermaidElk).toBe(true)
  expect(state.d2Engine).toBe('vmde')
  // The CI/WSL Electron build may expose no WebGL context. That platform limitation is already
  // pinned by stl-material.spec.ts; every WebGL-capable run must produce the upgraded Three canvas.
  if (!state.stlCanvas) expect(state.stlError).toMatch(/WebGL context/i)
  expect(
    state.errors.filter((error) => !/language-stl/.test(error.language)),
  ).toEqual([])
  expect(remoteRequests).toEqual([])
  expect(pageErrors).toEqual([])
})
