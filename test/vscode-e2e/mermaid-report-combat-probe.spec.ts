import fs from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import { wf } from './webview-helpers'

// Task 705 — @probe: the 75-diagram check over the untracked combat-design material. Acceptance item:
// "special-ball-abilities-data-model shows the overlapping-label warning; the other combat diagrams
// show none (except the reference-also set 9, 10, 12, 13, 14)". Skipped unless VMDE_COMBAT_DIR points
// at the copied folder (nothing from it is committed). Records per diagram: SVG present, error text,
// warning tokens. Expected per the orchestrator decisions: 0 errors, 0 layout-fallback, and
// terminal-labels only on D-programmer-view/05-data-models.md indices 5, 9, 10, 12, 13, 14.
const COMBAT_DIR = process.env.VMDE_COMBAT_DIR
const FLAGGED_FILE = path.join('D-programmer-view', '05-data-models.md')
const FLAGGED_INDICES = [5, 9, 10, 12, 13, 14]

function markdownFiles(dir: string): string[] {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((e) =>
      e.isDirectory()
        ? markdownFiles(path.join(dir, e.name))
        : e.name.endsWith('.md')
          ? [path.join(dir, e.name)]
          : [],
    )
    .sort()
}

test('@probe combat design diagrams: svg, errors and warning tokens per block', async ({
  workbox,
  evaluateInVSCode,
}) => {
  test.skip(
    !COMBAT_DIR || !fs.existsSync(COMBAT_DIR),
    'VMDE_COMBAT_DIR is not set or the folder is absent (the combat material is untracked)',
  )
  test.setTimeout(30 * 60_000)
  const files = markdownFiles(COMBAT_DIR as string)
  const rows: Array<{
    file: string
    index: number
    svg: boolean
    error: string | null
    tokens: string[]
  }> = []

  for (const file of files) {
    const rel = path.relative(COMBAT_DIR as string, file)
    const expected = (
      fs.readFileSync(file, 'utf8').match(/^```mermaid/gm) ?? []
    ).length
    await evaluateInVSCode(
      async (vscode: typeof import('vscode')) => {
        await vscode.commands.executeCommand('workbench.action.closeAllEditors')
      },
      [file] as [string],
    )
    await evaluateInVSCode(
      async (vscode: typeof import('vscode'), args: string[]) => {
        await vscode.extensions.getExtension('Laicasaane.vmde')?.activate()
        await vscode.commands.executeCommand(
          'vscode.openWith',
          vscode.Uri.file(args[0]),
          'vmde.editor',
        )
      },
      [file] as [string],
    )
    const frame = wf(workbox)
    await frame.locator('.vditor-ir').first().waitFor({ timeout: 60_000 })
    // Poll for the blocks' own marker (svg or error box); they are viewport-gated, so scroll them in.
    await expect
      .poll(
        async () =>
          frame.locator('body').evaluate((_el, n) => {
            const els = [
              ...document.querySelectorAll('.vditor-ir .language-mermaid'),
            ].filter(
              (e) =>
                e.tagName !== 'CODE' && !e.closest('.vditor-ir__marker--pre'),
            )
            for (const e of els) e.scrollIntoView({ block: 'center' })
            return (
              els.length >= n &&
              els.every(
                (e) =>
                  e.querySelector('svg') ||
                  e.querySelector('.vmde-diagram-error'),
              )
            )
          }, expected),
        { timeout: 120_000 },
      )
      .toBe(true)
    const info = await frame.locator('body').evaluate(() =>
      [...document.querySelectorAll('.vditor-ir .language-mermaid')]
        .filter(
          (e) => e.tagName !== 'CODE' && !e.closest('.vditor-ir__marker--pre'),
        )
        .map((e) => ({
          svg: !!e.querySelector('svg'),
          error:
            e.querySelector('.vmde-diagram-error__msg')?.textContent ?? null,
          tokens: [...e.querySelectorAll('.vmde-diagram-warning')].flatMap(
            (w) => (w.getAttribute('data-vmde-warning') ?? '').split(' '),
          ),
        })),
    )
    for (const [index, b] of info.entries())
      rows.push({ file: rel, index, ...b })
  }

  console.log(`[combat-probe] ${JSON.stringify(rows)}`)
  expect(rows.length).toBe(75)
  expect(rows.filter((r) => r.error !== null || !r.svg)).toEqual([])
  expect(rows.filter((r) => r.tokens.includes('layout-fallback'))).toEqual([])
  const flagged = rows
    .filter((r) => r.tokens.includes('terminal-labels'))
    .map((r) => `${r.file}#${r.index}`)
  expect(flagged).toEqual(FLAGGED_INDICES.map((i) => `${FLAGGED_FILE}#${i}`))
})
