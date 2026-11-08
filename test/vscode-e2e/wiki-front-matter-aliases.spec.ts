/**
 * Task 709 — front-matter `aliases:` resolve wiki links in the real VS Code webview.
 *
 * Contract (tasks/709-front-matter-aliases-and-tags-resolution.md, "Part 1 handoff", acceptance
 * items A4, A6, A7): a page that declares `aliases: [Some Alias]` makes `[[Some Alias]]` resolve.
 * - A6 the alias chip carries no `data-wiki-missing`; a chip for a page that does not exist does.
 * - A6 opening the alias chip (the `open-wikilink` route, through the `vmde.activateLinkAtCaret`
 *   command as in `wiki-chip-focus.spec.ts`) makes the declaring file the active tab, with no
 *   picker and no "Create Page" prompt (a prompt would leave the document tab active).
 * - A7 typing `[[Some` lists a hint row `Some Alias → Target Page`; picking it inserts the source
 *   `[[Target Page|Some Alias]]` (Q2 option a) into the host document text.
 * - A4 an alias rewritten on disk resolves after the file watcher update.
 *
 * Keys are XTEST (`helpers/xtest-input.ts`; needs `VMDE_XTEST=1` and a window manager on the
 * display, see docs/os-keyboard-testing-setup.md); type ASCII only.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test as base } from 'vscode-test-playwright'
import { createXtestInput } from './helpers/xtest-input'
import { reopenVmdeFixture, waitForE2EReadiness, wf } from './webview-helpers'

const DOC_NAME = 'links.md'
const TARGET_REL = path.join('notes', 'Target Page.md')
const DOC = [
  '# Front-matter aliases',
  '',
  'Links: [[Some Alias]] [[no-such-page]]',
  '',
  'Tail paragraph.',
  '',
].join('\n')
const targetText = (alias: string) =>
  `---\naliases: [${alias}]\n---\n\n# Target Page\n`

interface Workspace {
  dir: string
  doc: string
  target: string
}

// Each test gets its own workspace, created before VS Code launches (settings are read at open).
const test = base.extend<{ workspace: Workspace }>({
  baseDir: async ({ _createTempDir }, use) => {
    const dir = await _createTempDir()
    mkdirSync(path.join(dir, 'notes'), { recursive: true })
    mkdirSync(path.join(dir, '.vscode'), { recursive: true })
    writeFileSync(path.join(dir, TARGET_REL), targetText('Some Alias'))
    writeFileSync(path.join(dir, DOC_NAME), DOC)
    writeFileSync(
      path.join(dir, '.vscode', 'settings.json'),
      `${JSON.stringify({ 'vmde.wiki.enabled': true }, null, 2)}\n`,
    )
    await use(dir)
  },
  workspace: async ({ baseDir }, use) =>
    use({
      dir: baseDir,
      doc: path.join(baseDir, DOC_NAME),
      target: path.join(baseDir, TARGET_REL),
    }),
})

type EvaluateInVSCode = <R, Arg>(
  fn: (vscode: typeof import('vscode'), arg: Arg) => Promise<R>,
  arg: Arg,
) => Promise<R>

async function openReady(
  evaluateInVSCode: EvaluateInVSCode,
  workbox: import('@playwright/test').Page,
  doc: string,
) {
  await evaluateInVSCode(
    async (vscode: typeof import('vscode'), file: string) => {
      await vscode.extensions.getExtension('Laicasaane.vmde')?.activate()
      await vscode.commands.executeCommand(
        'vscode.openWith',
        vscode.Uri.file(file),
        'vmde.editor',
      )
    },
    doc,
  )
  const frame = wf(workbox)
  await frame.locator('.vditor-ir').first().waitFor({ timeout: 60_000 })
  await waitForE2EReadiness(
    frame,
    (state) => state.routerReady && state.editorEpoch > 0,
  )
  await frame.locator('body').evaluate(async () => {
    for (
      let index = 0;
      index < 300 && !(window as any).vditor?.vditor?.lute;
      index++
    )
      await new Promise((resolve) => setTimeout(resolve, 100))
  })
  return frame
}

const chipMissing = (frame: ReturnType<typeof wf>, target: string) =>
  frame
    .locator('body')
    .evaluate(
      (_body, name) =>
        document
          .querySelector(
            `.vditor-ir .wiki-link-chip[data-wiki-target="${name}"]`,
          )
          ?.hasAttribute('data-wiki-missing') ?? null,
      target,
    )

const hostText = (evaluateInVSCode: EvaluateInVSCode, file: string) =>
  evaluateInVSCode(
    async (vscode: typeof import('vscode'), name: string) =>
      vscode.workspace.textDocuments
        .find((item) => item.uri.fsPath === name)
        ?.getText() ?? '',
    file,
  )

test('alias chip resolves, opens the declaring file, and the hint offers the alias', async ({
  workbox,
  electronApp,
  evaluateInVSCode,
  workspace,
}) => {
  test.setTimeout(150_000)
  const frame = await openReady(evaluateInVSCode, workbox, workspace.doc)

  // A6: after the keys arrive the alias chip is resolved and the missing-page chip is marked.
  await expect
    .poll(() => chipMissing(frame, 'no-such-page'), { timeout: 30_000 })
    .toBe(true)
  expect(await chipMissing(frame, 'Some Alias')).toBe(false)

  // A6: opening the alias chip makes the declaring file the active tab (single match: no picker,
  // no "Create Page" prompt).
  const chip = frame.locator('.wiki-link-chip[data-wiki-target="Some Alias"]')
  await frame
    .locator('.vditor-ir')
    .first()
    .click({ position: { x: 4, y: 4 } })
  await chip.evaluate((el) => {
    const text = el.firstChild
    if (!text) return
    const range = document.createRange()
    range.setStart(text, 1)
    range.collapse(true)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
  })
  await expect
    .poll(
      () => chip.evaluate((el) => el.classList.contains('vmde-caret-inside')),
      { timeout: 15_000 },
    )
    .toBe(true)
  await evaluateInVSCode(async (vscode: typeof import('vscode')) => {
    await vscode.commands.executeCommand('vmde.activateLinkAtCaret')
  })
  await expect
    .poll(
      () =>
        evaluateInVSCode(async (vscode: typeof import('vscode')) => {
          const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input
          return input instanceof vscode.TabInputCustom
            ? input.uri.fsPath
            : null
        }, undefined as never),
      { timeout: 15_000, intervals: [300, 600, 1000] },
    )
    .toBe(workspace.target)

  // Back to the document for the hint. Two webviews exist now (the document and the declaring
  // file), so resolve the visible one through the shared helper instead of `wf()`.
  const docFrame = await reopenVmdeFixture(
    evaluateInVSCode as never,
    workbox,
    workspace.doc,
    30_000,
  )

  // The reopened editor must be ready for keys (router and Lute) before XTEST types into it.
  await waitForE2EReadiness(
    docFrame,
    (state) => state.routerReady && state.editorEpoch > 0,
  )
  await docFrame.locator('body').evaluate(async () => {
    for (
      let index = 0;
      index < 300 && !(window as any).vditor?.vditor?.lute;
      index++
    )
      await new Promise((resolve) => setTimeout(resolve, 100))
  })

  // A7: typing `[[Some` lists the alias row; picking it inserts `[[Target Page|Some Alias]]`.
  const xtest = await createXtestInput(electronApp, workbox)
  await xtest.activateAndFocus()
  await docFrame.locator('body').evaluate(() => {
    const paragraph = Array.from(
      document.querySelectorAll<HTMLElement>('.vditor-ir .vditor-reset > p'),
    ).find((item) => item.textContent?.includes('Tail paragraph.'))
    const text = paragraph?.firstChild
    if (!paragraph || !text) throw new Error('Tail paragraph is unavailable')
    paragraph.closest<HTMLElement>('.vditor-ir')?.focus()
    const range = document.createRange()
    range.setStart(text, text.textContent?.length ?? 0)
    range.collapse(true)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
  })
  await xtest.type(' [[Some')
  const rows = docFrame.locator('.vditor-hint[style*="display: block"] button')
  const aliasRow = rows.filter({ hasText: 'Some Alias → Target Page' })
  await aliasRow.first().waitFor({ state: 'visible', timeout: 15_000 })
  expect((await aliasRow.first().innerText()).trim()).toBe(
    'Some Alias → Target Page',
  )
  await aliasRow.first().click()
  await expect
    .poll(() => hostText(evaluateInVSCode, workspace.doc), { timeout: 15_000 })
    .toContain('[[Target Page|Some Alias]]')
})

test('an alias rewritten on disk resolves after the watcher update', async ({
  workbox,
  evaluateInVSCode,
  workspace,
}) => {
  test.setTimeout(120_000)
  const frame = await openReady(evaluateInVSCode, workbox, workspace.doc)
  await expect
    .poll(() => chipMissing(frame, 'no-such-page'), { timeout: 30_000 })
    .toBe(true)
  expect(await chipMissing(frame, 'Some Alias')).toBe(false)

  // The document links the new alias, then the declaring page changes its alias on disk.
  writeFileSync(workspace.target, targetText('Renamed Alias'))
  await evaluateInVSCode(
    async (vscode: typeof import('vscode'), file: string) => {
      const document = vscode.workspace.textDocuments.find(
        (item) => item.uri.fsPath === file,
      )
      if (!document) throw new Error('document is not open')
      const edit = new vscode.WorkspaceEdit()
      edit.insert(
        document.uri,
        new vscode.Position(document.lineCount, 0),
        '\n[[Renamed Alias]]\n',
      )
      await vscode.workspace.applyEdit(edit)
    },
    workspace.doc,
  )
  await expect
    .poll(() => chipMissing(frame, 'Renamed Alias'), { timeout: 30_000 })
    .toBe(false)
  // The old alias no longer resolves.
  await expect
    .poll(() => chipMissing(frame, 'Some Alias'), { timeout: 30_000 })
    .toBe(true)
})
