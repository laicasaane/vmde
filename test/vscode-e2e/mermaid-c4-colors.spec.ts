import { wf } from './webview-helpers'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'

// Mermaid's C4 renderer bypasses themeVariables: relationship labels/lines/boundaries are emitted
// #444444 and EVERY in-box label #FFFFFF (2.0:1 on mermaid's own light-blue `component` fill). The
// post-render hook repaints box labels against their own box and the rest against the page.
// Real-webview net — the hook runs off Vditor's patched mermaidRender, not the harness path.
const FIXTURE = path.join(__dirname, 'fixtures', 'mermaid-c4-colors.md')

function normalizeCssColor(value: string | null): string | null {
  if (!value) return null
  const rgb = value.match(/^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/i)
  if (!rgb) return value.toLowerCase()
  return `#${rgb
    .slice(1)
    .map((channel) => Number(channel).toString(16).padStart(2, '0'))
    .join('')}`
}

test('C4 boxes, labels and relationships are readable on a dark palette', async ({
  workbox,
  evaluateInVSCode,
}) => {
  await evaluateInVSCode(
    async (vscode, args) => {
      const [uri] = args as [string]
      await vscode.commands.executeCommand('workbench.action.closeAllEditors')
      await vscode.workspace
        .getConfiguration('vmde')
        .update('diagram.mermaid.theme', 'vscode-dark-2026', true)
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
  const c4 = frame.locator('.language-mermaid svg[aria-roledescription="c4"]')
  await c4.waitFor({ timeout: 60_000 })

  const colors = await frame.locator('body').evaluate(() => {
    const svg = document.querySelector(
      '.language-mermaid svg[aria-roledescription="c4"]',
    ) as SVGElement
    const label = (txt: string) => {
      const text = [...svg.querySelectorAll('text')].find(
        (candidate) => candidate.textContent === txt,
      ) as SVGElement | undefined
      return text
        ? text.style.getPropertyValue('fill') || text.getAttribute('fill')
        : null
    }
    return {
      boxes: [...svg.querySelectorAll<SVGElement>('g > rect, g > path')]
        .map(
          (el) => el.style.getPropertyValue('fill') || el.getAttribute('fill'),
        )
        .filter((fill) => fill && fill !== 'none')
        .sort(),
      userInk: label('User'),
      dbInk: label('DB'),
      relation: label('Uses'),
      boundary: label('Boundary'),
      line: (() => {
        const line = svg.querySelector('line') as SVGElement | null
        return line
          ? line.style.getPropertyValue('stroke') || line.getAttribute('stroke')
          : null
      })(),
      arrow: (() => {
        const arrow = svg.querySelector('marker path') as SVGElement | null
        return arrow
          ? arrow.style.getPropertyValue('fill') || arrow.getAttribute('fill')
          : null
      })(),
      // Anything mermaid drew and the hook missed still carries its hard-coded default —
      // this is what caught the curved (BiRel) relationship paths.
      leftovers: [...svg.querySelectorAll('*')].filter((el) =>
        ['#444444', '#444'].includes(
          (
            (el as SVGElement).style?.getPropertyValue('stroke') ||
            el.getAttribute('stroke') ||
            ''
          ).toLowerCase(),
        ),
      ).length,
    }
  })

  expect({
    ...colors,
    boxes: colors.boxes
      .map(normalizeCssColor)
      .filter((fill): fill is string => fill !== null)
      .sort(),
    userInk: normalizeCssColor(colors.userInk),
    dbInk: normalizeCssColor(colors.dbInk),
    relation: normalizeCssColor(colors.relation),
    boundary: normalizeCssColor(colors.boundary),
    line: normalizeCssColor(colors.line),
    arrow: normalizeCssColor(colors.arrow),
  }).toEqual({
    boxes: ['#062b50', '#083e70', '#0d537f', '#176a96', '#33383b'],
    userInk: '#ffffff',
    dbInk: '#ffffff',
    relation: '#bbbebf',
    boundary: '#bbbebf',
    line: '#48a0c7',
    arrow: '#48a0c7',
    leftovers: 0,
  })
})
