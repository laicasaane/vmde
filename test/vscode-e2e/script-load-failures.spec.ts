import { wf } from './webview-helpers'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'

const FIXTURE = path.join(__dirname, 'fixtures', 'script-load-failures.md')
const LANGS = [
  'geojson',
  'topojson',
  'nomnoml',
  'stl',
  'wavedrom',
  'vega',
  'vega-lite',
] as const

test('failed renderer script loads show themed errors instead of blank real-webview previews', async ({
  workbox,
  evaluateInVSCode,
}) => {
  test.setTimeout(120_000)
  await workbox.addInitScript(() => {
    const appendChild = Node.prototype.appendChild
    Node.prototype.appendChild = function <T extends Node>(node: T): T {
      if (
        this === document.head &&
        node instanceof HTMLScriptElement &&
        /\/dist\/js\/(?:leaflet\/leaflet\.js|topojson\/topojson-client\.min\.js|nomnoml\/nomnoml\.min\.js|threejs\/three-stl\.min\.js|wavedrom\/wavedrom\.min\.js|vega\/vega-embed\.min\.js)(?:\?|$)/.test(
          node.src,
        )
      ) {
        node.src = 'https://vmde.invalid/renderer-dependency.js'
      }
      return appendChild.call(this, node) as T
    }
  })

  await evaluateInVSCode(
    async (vscode, args) => {
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
  await frame.locator('.vditor-ir').first().waitFor({ timeout: 60_000 })
  await expect
    .poll(
      async () =>
        frame
          .locator(
            LANGS.map(
              (lang) =>
                `.vditor-ir__preview .language-${lang} .vmde-diagram-error`,
            ).join(', '),
          )
          .count(),
      { timeout: 60_000, intervals: [250, 500, 1000] },
    )
    .toBe(LANGS.length)

  const state = await frame.locator('body').evaluate((_body, langs) => {
    const blocks = langs.map((lang) => {
      const wrapper = document.querySelector<HTMLElement>(
        `.vditor-ir__preview .language-${lang}`,
      )
      return {
        lang,
        hasError: !!wrapper?.querySelector('.vmde-diagram-error'),
        empty: !wrapper?.innerHTML.trim(),
        processed: wrapper?.getAttribute('data-processed') === 'true',
        title:
          wrapper?.querySelector('.vmde-diagram-error__title')?.textContent ??
          '',
      }
    })
    const vditor = (window as unknown as { vditor?: { getValue(): string } })
      .vditor
    return {
      blocks,
      sourceErrorCount: document.querySelectorAll(
        '.vditor-ir__marker--pre .vmde-diagram-error',
      ).length,
      value: vditor?.getValue() ?? '',
    }
  }, LANGS)

  expect(state.blocks.every((block) => block.hasError)).toBe(true)
  expect(state.blocks.every((block) => !block.empty)).toBe(true)
  expect(state.blocks.every((block) => block.processed)).toBe(true)
  expect(state.blocks.map((block) => block.title)).toEqual([
    'GeoJSON',
    'TopoJSON',
    'nomnoml',
    'STL',
    'WaveDrom',
    'Vega',
    'Vega',
  ])
  expect(state.sourceErrorCount).toBe(0)
  for (const lang of LANGS) {
    expect(state.value).toContain(`\`\`\`${lang}`)
  }
})
