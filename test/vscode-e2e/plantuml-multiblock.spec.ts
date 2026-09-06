import { wf } from './webview-helpers'
// PlantUML multi-block engine stickiness (task 347). The vendored TeaVM engine is one shared instance
// whose diagram-TYPE detection state leaks between render() calls, so a doc with several non-class icon
// diagrams (C4/AWS/Azure) used to render most but flake a RANDOM one with "Assumed diagram type:
// sequence". Fix (plantuml-render.ts): on a BATCH render (>1 block in one pass) use a fresh engine per
// block + await each render before the next — proven clean in the type-matrix/multipage probes. This
// asserts all 5 blocks in the repro fixture render a real diagram (correct label, no error card) and
// logs the open cost. Real-VS-Code only. The bug is non-deterministic → this runs under retries and is
// worth re-running a few times.
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'

const FIXTURE = path.join(__dirname, 'fixtures', 'plantuml-multiblock.md')
const LABELS = ['WebOne', 'ServerTwo', 'VmThree', 'ServerFour', 'WebFive']

test('five icon diagrams in one doc all render — no "Assumed diagram type" flake (task 347)', async ({
  workbox,
  evaluateInVSCode,
}) => {
  test.setTimeout(180_000)
  const openedAt = Date.now()
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
  await frame.locator('.vditor-ir').first().waitFor({ timeout: 60_000 })
  // Wait until ALL five blocks have rendered an <svg> (serialised → one at a time).
  await expect
    .poll(
      () => frame.locator('.vditor-ir__preview .language-plantuml svg').count(),
      { timeout: 120_000 },
    )
    .toBeGreaterThanOrEqual(5)
  const renderedMs = Date.now() - openedAt
  await expect
    .poll(
      () =>
        frame.locator('body').evaluate((_body, labels) => {
          const text = Array.from(
            document.querySelectorAll(
              '.vditor-ir__preview .language-plantuml svg text',
            ),
          )
            .map((node) => node.textContent ?? '')
            .join(' ')
          return (labels as string[]).every((label) => text.includes(label))
        }, LABELS),
      { timeout: 30_000 },
    )
    .toBe(true)

  const report = await frame.locator('body').evaluate(() => {
    const blocks = Array.from(
      document.querySelectorAll('.vditor-ir__preview .language-plantuml'),
    )
    return blocks.map((b) => {
      const svg = b.querySelector('svg')
      const text = svg
        ? Array.from(svg.querySelectorAll('text'))
            .map((t) => t.textContent ?? '')
            .join(' ')
        : ''
      return {
        rendered: !!svg,
        // Any PlantUML error render — the 347 flake is "Assumed diagram type"; also catch the generic
        // shapes so a broken block can't pass by echoing its own source into the error SVG.
        errored:
          /Assumed diagram type|Syntax Error|Fatal parsing error|not supported by this release/i.test(
            text,
          ),
        text: text.replace(/\s+/g, ' ').trim().slice(0, 120),
      }
    })
  })
  // eslint-disable-next-line no-console
  console.log(`[347] renderedMs=${renderedMs} blocks=${JSON.stringify(report)}`)

  // All five blocks present…
  expect(report.length).toBe(5)
  // …each rendered a real diagram, none is an error card (the whole point of the fix)…
  for (const b of report) {
    expect(b.rendered).toBe(true)
    expect(b.errored).toBe(false)
  }
  // …and each shows its own distinct label (proof the right diagram rendered in each slot, not a
  // duplicate/mis-detected one).
  const allText = report.map((b) => b.text).join(' | ')
  for (const label of LABELS) expect(allText).toContain(label)
})
