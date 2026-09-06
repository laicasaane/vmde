import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import { wf } from './webview-helpers'

const FIXTURE = path.join(__dirname, 'fixtures', 'dagre-3.1-compat.md')

test('Dagre 3.1 preserves compound order and container-bound routing', async ({
  workbox,
  evaluateInVSCode,
}) => {
  await evaluateInVSCode(async (vscode: typeof import('vscode')) => {
    await vscode.workspace
      .getConfiguration('vmde')
      .update('diagram.d2.layout', 'dagre', vscode.ConfigurationTarget.Global)
  })
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
  await expect
    .poll(
      () =>
        frame.locator('body').evaluate(() => {
          const wrapper = [...document.querySelectorAll('.language-d2')].find(
            (candidate) => candidate.querySelector('svg'),
          )
          return {
            engine: wrapper?.getAttribute('data-d2-engine') ?? null,
            error: wrapper?.getAttribute('data-d2-error') ?? null,
          }
        }),
      { timeout: 60_000 },
    )
    .toEqual({ engine: 'dagre', error: null })

  const geometry = await frame.locator('body').evaluate(() => {
    const svg = [...document.querySelectorAll('.language-d2 svg')].at(
      -1,
    ) as SVGSVGElement
    const labels = (text: string) =>
      [...svg.querySelectorAll('text')]
        .find((candidate) => candidate.textContent === text)
        ?.getBoundingClientRect()
    const rects = [...svg.querySelectorAll<SVGRectElement>('rect')]
      .filter((rect) => !rect.closest('defs'))
      .map((rect) => ({
        x: Number(rect.getAttribute('x')),
        y: Number(rect.getAttribute('y')),
        width: Number(rect.getAttribute('width')),
        height: Number(rect.getAttribute('height')),
      }))
      .filter((rect) => Object.values(rect).every(Number.isFinite))
    const rightContainer = rects
      .filter((rect) => rect.width > 100 && rect.height > 100)
      .sort((a, b) => b.x - a.x)[0]
    const endpoints = [
      ...svg.querySelectorAll<SVGPathElement>('path[fill="none"]'),
    ]
      .map((edge) => edge.getAttribute('d')?.match(/-?\d+(?:\.\d+)?/g) ?? [])
      .filter((numbers) => numbers.length >= 2)
      .map((numbers) => ({
        x: Number(numbers.at(-2)),
        y: Number(numbers.at(-1)),
      }))
    const nearRightBoundary = endpoints.some(
      ({ x, y }) =>
        Math.abs(x - rightContainer.x) <= 25 &&
        y >= rightContainer.y - 25 &&
        y <= rightContainer.y + rightContainer.height + 25,
    )
    return {
      finiteRects: rects.length,
      leftOrder: [labels('Left Alpha')?.y, labels('Left Beta')?.y],
      rightOrder: [labels('Right Alpha')?.y, labels('Right Beta')?.y],
      routedEdges: endpoints.length,
      nearRightBoundary,
    }
  })

  expect(geometry.finiteRects).toBeGreaterThanOrEqual(6)
  expect(geometry.leftOrder[0]).toBeLessThan(geometry.leftOrder[1] as number)
  expect(geometry.rightOrder[0]).toBeLessThan(geometry.rightOrder[1] as number)
  expect(geometry.routedEdges).toBeGreaterThanOrEqual(2)
  expect(geometry.nearRightBoundary).toBe(true)
})
