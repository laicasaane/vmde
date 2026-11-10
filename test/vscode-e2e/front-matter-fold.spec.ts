// Task 724 — the front-matter block folds to one "Properties (N)" line from a fold control, in IR,
// WYSIWYG, the Split View preview and Preview, with one shared state per document. The state lives
// in the per-document section fold store, so each file reopens with its own state; the setting
// `vmde.editor.frontMatterFolded` decides only for a file with no stored state. Folding never
// changes the saved Markdown. Real VS Code webview, real configuration and workspace state.
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import { docState, setConfig } from './preview-mode-helpers'
import {
  ExtensionId,
  MarkdownEditorViewType,
  settle,
  waitForE2EReadiness,
  wf,
} from './webview-helpers'

const DOC = `---
title: Fold me
tags: [a, b]
author:
  name: Ann
---

# Heading

Paragraph below.
`
const SUMMARY = 'Properties (3)'

type Evaluate = (fn: unknown, args: string[]) => Promise<unknown>
type Frame = ReturnType<typeof wf>
type Page = import('@playwright/test').Page
type Mode = 'ir' | 'wysiwyg' | 'sv' | 'preview'

const SCOPE: Record<Mode, string> = {
  ir: '.vditor-ir',
  wysiwyg: '.vditor-wysiwyg',
  sv: '.vditor-preview',
  preview: '.vditor-preview',
}
const PARAGRAPH: Record<Mode, string> = {
  ir: '.vditor-ir p',
  wysiwyg: '.vditor-wysiwyg p',
  sv: '.vditor-preview p',
  preview: '.vditor-preview p',
}

test.afterEach(async ({ evaluateInVSCode }) => {
  await setConfig(
    evaluateInVSCode as Evaluate,
    'editor.frontMatterFolded',
    undefined,
  )
  await setConfig(evaluateInVSCode as Evaluate, 'editor.defaultMode', undefined)
})

async function open(evaluateInVSCode: Evaluate, workbox: Page, file: string) {
  await evaluateInVSCode(
    async (vscode: typeof import('vscode'), args: string[]) => {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors')
      await vscode.extensions.getExtension(args[1])?.activate()
      await vscode.commands.executeCommand(
        'vscode.openWith',
        vscode.Uri.file(args[0]),
        args[2],
      )
    },
    [file, ExtensionId, MarkdownEditorViewType],
  )
  const frame = wf(workbox)
  await frame.locator('.vditor-ir').first().waitFor({ timeout: 60_000 })
  await waitForE2EReadiness(
    frame,
    (state) =>
      state.routerReady && state.editorEpoch > 0 && state.mode === 'ir',
    { message: 'Task 724 IR readiness' },
  )
  await expect(
    frame.locator('.vditor-ir .vmde-front-matter').first(),
  ).toBeAttached({ timeout: 30_000 })
  return frame
}

/** What the user sees of the front-matter block on one surface. */
const foldView = (frame: Frame, mode: Mode) =>
  frame.locator('body').evaluate((_body, scope) => {
    const root = document.querySelector<HTMLElement>(
      `${scope} .vmde-front-matter`,
    )
    const button = root?.querySelector<HTMLElement>('.vmde-front-matter__fold')
    const table = root?.querySelector<HTMLElement>('.vmde-front-matter__table')
    const summary = root?.querySelector<HTMLElement>(
      '.vmde-front-matter__summary',
    )
    const shown = (el: HTMLElement | null | undefined) =>
      !!el && el.getBoundingClientRect().height > 0
    return {
      tableShown: shown(table),
      summaryShown: shown(summary),
      summary: shown(summary) ? summary?.textContent : null,
      expanded: button?.getAttribute('aria-expanded') ?? null,
      buttonShown: shown(button),
    }
  }, SCOPE[mode])

const FOLDED = {
  tableShown: false,
  summaryShown: true,
  summary: SUMMARY,
  expanded: 'false',
  buttonShown: true,
}
const EXPANDED = {
  tableShown: true,
  summaryShown: false,
  summary: null,
  expanded: 'true',
  buttonShown: true,
}

const editMode = async (frame: Frame, mode: 'ir' | 'wysiwyg' | 'sv') => {
  await frame.locator('.vditor-toolbar [data-type="edit-mode"]').click()
  await frame.locator(`button[data-mode="${mode}"]`).click()
  await waitForE2EReadiness(frame, (state) => state.mode === mode)
}

/** Switch surfaces through the toolbar. Preview is entered and left over IR only. */
async function switchMode(frame: Frame, to: Mode, from: Mode) {
  if (to !== from) {
    if (from === 'preview')
      await frame.locator('.vditor-toolbar [data-type="preview"]').click()
    if (to === 'preview') {
      if (from !== 'ir') await editMode(frame, 'ir')
      await frame.locator('.vditor-toolbar [data-type="preview"]').click()
    } else if (!(from === 'preview' && to === 'ir')) await editMode(frame, to)
  }
  if (to === 'ir' || to === 'wysiwyg') {
    // Caret outside the block, so the rendered table (not the YAML source) shows.
    await frame
      .locator(PARAGRAPH[to])
      .filter({ hasText: 'Paragraph below.' })
      .click()
    await settle(frame, 600) // caret-leave re-render settles; there is no marker to poll
  }
  await expect(
    frame.locator(`${SCOPE[to]} .vmde-front-matter__fold`).first(),
  ).toBeVisible({ timeout: 30_000 })
}

const foldButton = (frame: Frame, mode: Mode) =>
  frame.locator(`${SCOPE[mode]} .vmde-front-matter__fold`).first()

/** The block's YAML source is not shown: a fold click never puts the caret into the block. */
const sourceHidden = (frame: Frame, mode: Mode) =>
  frame.locator('body').evaluate((_body, scope) => {
    const block = document.querySelector<HTMLElement>(
      `${scope} [data-type="yaml-front-matter"]`,
    )
    return !!block && !block.hasAttribute('data-vmde-front-matter-editing')
  }, SCOPE[mode])

/** The open document is clean with the original text, and every file on disk keeps its bytes. */
async function expectBytesUnchanged(
  evaluate: Evaluate,
  open: string,
  ...closed: string[]
) {
  expect(await docState(evaluate, open)).toMatchObject({
    text: DOC,
    dirty: false,
  })
  for (const file of [open, ...closed])
    expect(readFileSync(file, 'utf8')).toBe(DOC)
}

test('the control folds and unfolds in every mode with one shared state; saved bytes unchanged', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(300_000)
  const evaluate = evaluateInVSCode as Evaluate
  await setConfig(evaluate, 'editor.defaultMode', 'ir')
  const file = path.join(baseDir, 'fm-fold-modes.md')
  writeFileSync(file, DOC)
  const frame = await open(evaluate, workbox, file)

  // IR, no stored state, default setting: expanded. A click folds it to the summary line.
  await switchMode(frame, 'ir', 'ir')
  await expect.poll(() => foldView(frame, 'ir')).toEqual(EXPANDED)
  await foldButton(frame, 'ir').click()
  await expect.poll(() => foldView(frame, 'ir')).toEqual(FOLDED)
  expect(await sourceHidden(frame, 'ir')).toBe(true)

  // WYSIWYG shows the same state; unfold there.
  await switchMode(frame, 'wysiwyg', 'ir')
  await expect.poll(() => foldView(frame, 'wysiwyg')).toEqual(FOLDED)
  await foldButton(frame, 'wysiwyg').click()
  await expect.poll(() => foldView(frame, 'wysiwyg')).toEqual(EXPANDED)
  expect(await sourceHidden(frame, 'wysiwyg')).toBe(true)

  // Split View preview: the same state; fold there.
  await switchMode(frame, 'sv', 'wysiwyg')
  await expect.poll(() => foldView(frame, 'sv')).toEqual(EXPANDED)
  await foldButton(frame, 'sv').click()
  await expect.poll(() => foldView(frame, 'sv')).toEqual(FOLDED)

  // Preview: the same state; unfold, then fold again from the keyboard (Enter, then Space).
  await switchMode(frame, 'preview', 'sv')
  await expect.poll(() => foldView(frame, 'preview')).toEqual(FOLDED)
  await foldButton(frame, 'preview').click()
  await expect.poll(() => foldView(frame, 'preview')).toEqual(EXPANDED)
  await foldButton(frame, 'preview').focus()
  await foldButton(frame, 'preview').press('Enter')
  await expect.poll(() => foldView(frame, 'preview')).toEqual(FOLDED)
  await foldButton(frame, 'preview').press(' ')
  await expect.poll(() => foldView(frame, 'preview')).toEqual(EXPANDED)
  await foldButton(frame, 'preview').press('Enter')
  await expect.poll(() => foldView(frame, 'preview')).toEqual(FOLDED)

  // Back in IR: still folded.
  await switchMode(frame, 'ir', 'preview')
  await expect.poll(() => foldView(frame, 'ir')).toEqual(FOLDED)

  await expectBytesUnchanged(evaluate, file)
})

test('each file reopens with its own stored state', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(300_000)
  const evaluate = evaluateInVSCode as Evaluate
  await setConfig(evaluate, 'editor.defaultMode', 'ir')
  const folded = path.join(baseDir, 'fm-fold-reopen-a.md')
  const other = path.join(baseDir, 'fm-fold-reopen-b.md')
  writeFileSync(folded, DOC)
  writeFileSync(other, DOC)

  let frame = await open(evaluate, workbox, folded)
  await switchMode(frame, 'ir', 'ir')
  await foldButton(frame, 'ir').click()
  await expect.poll(() => foldView(frame, 'ir')).toEqual(FOLDED)

  // Another file has its own state: no stored state, so the default (expanded).
  frame = await open(evaluate, workbox, other)
  await switchMode(frame, 'ir', 'ir')
  await expect.poll(() => foldView(frame, 'ir')).toEqual(EXPANDED)

  // The folded file reopens folded.
  frame = await open(evaluate, workbox, folded)
  await switchMode(frame, 'ir', 'ir')
  await expect.poll(() => foldView(frame, 'ir')).toEqual(FOLDED)

  // Unfold and reopen: the stored expanded state comes back.
  await foldButton(frame, 'ir').click()
  await expect.poll(() => foldView(frame, 'ir')).toEqual(EXPANDED)
  frame = await open(evaluate, workbox, folded)
  await switchMode(frame, 'ir', 'ir')
  await expect.poll(() => foldView(frame, 'ir')).toEqual(EXPANDED)

  await expectBytesUnchanged(evaluate, folded, other)
})

test('the setting folds a file with no stored state and leaves a stored state as stored', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(300_000)
  const evaluate = evaluateInVSCode as Evaluate
  await setConfig(evaluate, 'editor.defaultMode', 'ir')
  const stored = path.join(baseDir, 'fm-fold-default-stored.md')
  const fresh = path.join(baseDir, 'fm-fold-default-fresh.md')
  writeFileSync(stored, DOC)
  writeFileSync(fresh, DOC)

  // Store "expanded" for one file: fold, then unfold.
  let frame = await open(evaluate, workbox, stored)
  await switchMode(frame, 'ir', 'ir')
  await foldButton(frame, 'ir').click()
  await expect.poll(() => foldView(frame, 'ir')).toEqual(FOLDED)
  await foldButton(frame, 'ir').click()
  await expect.poll(() => foldView(frame, 'ir')).toEqual(EXPANDED)

  // A live change to the default leaves the stored state as it is.
  await setConfig(evaluate, 'editor.frontMatterFolded', true)
  await settle(frame, 1000) // negative-assertion wait: nothing may change after the config push
  expect(await foldView(frame, 'ir')).toEqual(EXPANDED)

  // A file with no stored state opens folded.
  frame = await open(evaluate, workbox, fresh)
  await switchMode(frame, 'ir', 'ir')
  await expect.poll(() => foldView(frame, 'ir')).toEqual(FOLDED)

  // A live change applies to it, because it has no stored state.
  await setConfig(evaluate, 'editor.frontMatterFolded', false)
  await expect.poll(() => foldView(frame, 'ir')).toEqual(EXPANDED)
  await setConfig(evaluate, 'editor.frontMatterFolded', true)
  await expect.poll(() => foldView(frame, 'ir')).toEqual(FOLDED)

  // The file with the stored state reopens as stored, not as the setting says.
  frame = await open(evaluate, workbox, stored)
  await switchMode(frame, 'ir', 'ir')
  await expect.poll(() => foldView(frame, 'ir')).toEqual(EXPANDED)

  await expectBytesUnchanged(evaluate, stored, fresh)
})
