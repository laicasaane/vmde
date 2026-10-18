import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { expect, test } from 'vscode-test-playwright'
import {
  ExtensionId,
  MarkdownEditorViewType,
  reopenVmdeFixture,
  type docText,
  settle,
  waitForE2EReadiness,
  type wf,
} from './webview-helpers'

// Task 653: a toolbar Outline click or Enter keypress is a view toggle. It must add no Undo step
// that holds only decoration (section-fold markers, a caret marker) and no Markdown change, so the
// next Ctrl+Z undoes the previous real edit (tasks/done/653-outline-toggle-undo-step.md, Acceptance 1 to
// 3). Every toggle is a real click or key press with VS Code focus; the Undo depth is the length of
// the active mode's `undoStack`; the host text is read from the open document.

type Frame = ReturnType<typeof wf>
type HostEvaluator = Parameters<typeof docText>[0]
type Mode = 'ir' | 'wysiwyg'

const FIXTURE = `# Fixture outline-toggle-undo.md

## Section one

First paragraph alpha beta gamma.

Second paragraph delta epsilon zeta.

## Section two

Third paragraph eta theta iota.
`

const visibleFrame = (workbox: Page) =>
  workbox
    .frameLocator('iframe.webview:visible')
    .frameLocator('iframe[title="VMDE"], #active-frame')

const outlineButton = (frame: Frame) =>
  frame.locator('.vditor-toolbar [data-type="outline"]')

interface View {
  mode: string
  value: string
  undoDepth: number
  shown: boolean
}

const view = (frame: Frame) =>
  frame.locator('body').evaluate((): View => {
    const outer = window as unknown as {
      vditor: {
        getValue(): string
        vditor: {
          currentMode: string
          undo: Record<string, { undoStack: unknown[] }>
        }
      }
    }
    const inner = outer.vditor.vditor
    const panel = document.querySelector<HTMLElement>('.vditor-outline')
    const rect = panel?.getBoundingClientRect()
    return {
      mode: inner.currentMode,
      value: outer.vditor.getValue(),
      undoDepth: inner.undo[inner.currentMode]?.undoStack.length ?? -1,
      shown:
        !!panel &&
        getComputedStyle(panel).display !== 'none' &&
        (rect?.width ?? 0) > 0,
    }
  })

const hostText = (evaluateInVSCode: HostEvaluator, file: string) =>
  evaluateInVSCode(
    async (vscode: typeof import('vscode'), args: string[]) =>
      vscode.workspace.textDocuments
        .find((candidate) => candidate.uri.fsPath === args[0])
        ?.getText() ?? '',
    [file] as [string],
  ) as Promise<string>

const expectShown = (frame: Frame, open: boolean) =>
  expect
    .poll(async () => (await view(frame)).shown, {
      timeout: 60_000,
      intervals: [500],
    })
    .toBe(open)

const switchMode = async (frame: Frame, mode: Mode) => {
  await frame.locator('.vditor-toolbar [data-type="edit-mode"]').click()
  await frame
    .locator('.vditor-toolbar')
    .locator(`button[data-mode="${mode}"]`)
    .click()
  await waitForE2EReadiness(
    frame,
    (state) => state.routerReady && state.mode === mode,
    { message: `outline-toggle-undo ${mode} readiness` },
  )
}

// A word typed at the end of a real-clicked paragraph, then the wait past `undoDelay` so the edit
// owns its Undo entry before the Outline is touched.
const typeWord = async (
  workbox: Page,
  frame: Frame,
  mode: Mode,
  word: string,
) => {
  await frame
    .locator(mode === 'ir' ? '.vditor-ir p' : '.vditor-wysiwyg p')
    .filter({ hasText: 'First paragraph' })
    .first()
    .click()
  await workbox.keyboard.press('End')
  await workbox.keyboard.type(` ${word}`)
  await expect
    .poll(async () => (await view(frame)).value, { timeout: 30_000 })
    .toContain(word)
  await settle(frame, 1500)
}

const caretAway = async (workbox: Page) => {
  await workbox.keyboard.press('ArrowLeft')
  await workbox.keyboard.press('ArrowLeft')
}

test('a toolbar Outline click or Enter adds no Undo step, so Ctrl+Z undoes the previous edit', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(600_000)
  await workbox.setViewportSize({ width: 1400, height: 900 })
  const file = path.join(baseDir, 'outline-toggle-undo.md')
  writeFileSync(file, FIXTURE)
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
    [file, ExtensionId, MarkdownEditorViewType] as [string, string, string],
  )
  const frame = visibleFrame(workbox)
  await waitForE2EReadiness(
    frame,
    (state) => state.routerReady && state.editorEpoch > 0,
    { message: 'outline-toggle-undo readiness' },
  )
  await expectShown(frame, false)

  try {
    // IR, real click: typed word, Outline open, Ctrl+Z.
    await typeWord(workbox, frame, 'ir', 'zzirword')
    const typed = await view(frame)
    expect(typed.mode).toBe('ir')
    expect(typed.undoDepth).toBeGreaterThan(0)
    await expect
      .poll(() => hostText(evaluateInVSCode, file))
      .toContain('zzirword')
    const typedHost = await hostText(evaluateInVSCode, file)

    // The caret moves off the position of the last entry, as a click elsewhere would: a snapshot
    // taken now differs from the last entry in the caret marker alone.
    await caretAway(workbox)
    await outlineButton(frame).click()
    await expectShown(frame, true)
    await settle(frame, 1000)
    const opened = await view(frame)
    expect(opened.undoDepth, 'IR click adds no Undo step').toBe(typed.undoDepth)
    expect(opened.value).toBe(typed.value)
    expect(await hostText(evaluateInVSCode, file)).toBe(typedHost)

    await workbox.keyboard.press('Control+z')
    await expect
      .poll(async () => (await view(frame)).value, { timeout: 30_000 })
      .not.toContain('zzirword')
    await expect
      .poll(() => hostText(evaluateInVSCode, file), { timeout: 30_000 })
      .not.toContain('zzirword')
    expect((await view(frame)).shown).toBe(true)

    // Closed again: the clicks never changed the host bytes beyond the undone word.
    const afterUndo = await hostText(evaluateInVSCode, file)
    const undoneDepth = (await view(frame)).undoDepth
    await outlineButton(frame).click()
    await expectShown(frame, false)
    await settle(frame, 1000)
    expect((await view(frame)).undoDepth).toBe(undoneDepth)
    expect(await hostText(evaluateInVSCode, file)).toBe(afterUndo)

    // IR, keyboard: Enter on the focused Outline button.
    await typeWord(workbox, frame, 'ir', 'zzkeyword')
    const keyTyped = await view(frame)
    await caretAway(workbox)
    await outlineButton(frame).focus()
    await workbox.keyboard.press('Enter')
    await expectShown(frame, true)
    await settle(frame, 1000)
    const keyOpened = await view(frame)
    expect(keyOpened.undoDepth, 'IR Enter adds no Undo step').toBe(
      keyTyped.undoDepth,
    )
    expect(keyOpened.value).toBe(keyTyped.value)
    await outlineButton(frame).click()
    await expectShown(frame, false)
    await settle(frame, 1000)

    // WYSIWYG: a caret-only difference from the last entry, then the click and Ctrl+Z.
    await switchMode(frame, 'wysiwyg')
    await typeWord(workbox, frame, 'wysiwyg', 'zzwysiwygword')
    const wTyped = await view(frame)
    expect(wTyped.mode).toBe('wysiwyg')
    await caretAway(workbox)
    await outlineButton(frame).click()
    await expectShown(frame, true)
    await settle(frame, 1000)
    const wOpened = await view(frame)
    expect(wOpened.undoDepth, 'WYSIWYG click adds no Undo step').toBe(
      wTyped.undoDepth,
    )
    await workbox.keyboard.press('Control+z')
    await expect
      .poll(async () => (await view(frame)).value, { timeout: 30_000 })
      .not.toContain('zzwysiwygword')
  } finally {
    // Later specs expect the Outline closed and the IR mode.
    try {
      if ((await view(frame)).shown) await outlineButton(frame).click()
      await expectShown(frame, false)
      if ((await view(frame)).mode !== 'ir') await switchMode(frame, 'ir')
    } catch {
      /* no editor to restore */
    }
  }
})

// Task 653 (scope extension): every other toolbar control that edits nothing is a view toggle too.
// A real click on each one, with the caret off the position of the last Undo entry, must leave the
// Undo depth, the value and the host text as they were. `both` is SV-only, so no real click can
// reach it in this IR session (Vitest covers it).
test('view-only toolbar controls add no Undo step', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(900_000)
  await workbox.setViewportSize({ width: 1400, height: 900 })
  const dir = path.join(baseDir, 'task653-view-only')
  mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'task653-view-only-home.md')
  writeFileSync(file, `${FIXTURE}\nSee [[Other Page]].\n`)
  writeFileSync(path.join(dir, 'Other Page.md'), '# Other\n')
  const setWiki = (enabled: boolean) =>
    evaluateInVSCode(
      async (vscode: typeof import('vscode'), args: [string, string]) => {
        const documentUri = vscode.Uri.file(args[0])
        if (!vscode.workspace.getWorkspaceFolder(documentUri))
          vscode.workspace.updateWorkspaceFolders(
            vscode.workspace.workspaceFolders?.length ?? 0,
            0,
            { uri: vscode.Uri.file(args[1]), name: 'Task653Wiki' },
          )
        const config = vscode.workspace.getConfiguration('vmde', documentUri)
        await config.update(
          'wiki.enabled',
          args[1] !== '',
          vscode.ConfigurationTarget.WorkspaceFolder,
        )
        await config.update(
          'wiki.root',
          '',
          vscode.ConfigurationTarget.WorkspaceFolder,
        )
      },
      [file, enabled ? dir : ''] as [string, string],
    )
  await setWiki(true)
  try {
    const frame = await reopenVmdeFixture(evaluateInVSCode, workbox, file)
    await expect(frame.locator('#vmde-prerender')).toHaveCount(0, {
      timeout: 60_000,
    })
    const toolbar = frame.locator('#app .vditor-toolbar')
    await expect(toolbar).toBeVisible({ timeout: 60_000 })
    const control = (type: string) =>
      toolbar.locator(`[data-type="${type}"]`).first()
    await waitForE2EReadiness(
      frame,
      (state) => state.routerReady && state.editorEpoch > 0,
      { message: 'view-only controls readiness' },
    )

    await typeWord(workbox, frame, 'ir', 'zzviewonly')
    const typed = await view(frame)
    expect(typed.undoDepth).toBeGreaterThan(0)
    const typedHost = await hostText(evaluateInVSCode, file)
    expect(typedHost).toContain('zzviewonly')

    // Back in the editor with the caret off the last entry: a click that sets no caret of its own.
    const caretOffEntry = async () => {
      await frame
        .locator('.vditor-ir p')
        .filter({ hasText: 'Second paragraph' })
        .first()
        .click()
      await caretAway(workbox)
    }
    const expectUnchanged = async (label: string) => {
      await settle(frame, 1000)
      const now = await view(frame)
      expect(now.undoDepth, `${label} adds no Undo step`).toBe(typed.undoDepth)
      expect(now.value, `${label} leaves the value`).toBe(typed.value)
      expect(await hostText(evaluateInVSCode, file), label).toBe(typedHost)
    }
    // Closes the tabs that are not the VMDE custom editor (the text editor or the Settings editor
    // that the control opened), so the dirty document stays open in its VMDE tab.
    const closeOtherTabs = () =>
      evaluateInVSCode(
        async (vscode: typeof import('vscode'), args: string[]) => {
          const others = vscode.window.tabGroups.all
            .flatMap((group) => group.tabs)
            .filter(
              (tab) =>
                !(
                  tab.input instanceof vscode.TabInputCustom &&
                  tab.input.viewType === args[0]
                ),
            )
          await vscode.window.tabGroups.close(others)
        },
        [MarkdownEditorViewType] as [string],
      )

    // Panel triggers and the More trigger: open, check, close.
    for (const type of ['more', 'emoji', 'math']) {
      await caretOffEntry()
      await control(type).click()
      await expectUnchanged(`${type} open`)
      await control(type).click()
      await expectUnchanged(`${type} close`)
    }

    // A More panel row that only shows a dialog.
    await caretOffEntry()
    await control('more').click()
    await control('about').click()
    await expectUnchanged('About VMDE')
    await workbox.keyboard.press('Escape')

    // Wiki Pages opens the host's quick pick; Back posts a host message.
    await caretOffEntry()
    await control('wiki-pages').click()
    const quickPick = workbox.locator('.quick-input-widget')
    await expect(quickPick).toBeVisible({ timeout: 20_000 })
    await workbox.keyboard.press('Escape')
    await expect(quickPick).toBeHidden()
    await expectUnchanged('Wiki Pages')
    await caretOffEntry()
    await control('navigate-back').click()
    await expectUnchanged('Navigate back')

    // Edit in VS Code and Settings each open an editor tab, which hides the webview and, on the way
    // back, recreates it with a fresh history (measured), so the depth cannot be compared after the
    // return. The click runs in the page instead and counts `addToUndoStack` and `input` calls
    // for a moment after it, before the host opens the tab.
    const clickCounting = (type: string) =>
      control(type).evaluate(async (element, name: string) => {
        const outer = window as unknown as {
          vditor: {
            vditor: {
              currentMode: string
              options: { input?: (markdown: string) => void }
              undo: { addToUndoStack: (inner: unknown) => void }
            }
          }
        }
        const inner = outer.vditor.vditor
        const calls = { undo: 0, input: 0 }
        const addToUndoStack = inner.undo.addToUndoStack
        inner.undo.addToUndoStack = function (this: unknown, ...rest) {
          calls.undo++
          return (addToUndoStack as (...a: unknown[]) => void).apply(this, [
            ...rest,
          ])
        }
        const input = inner.options.input
        inner.options.input = (markdown: string) => {
          calls.input++
          input?.(markdown)
        }
        ;(element as HTMLElement).click()
        await new Promise((resolve) => setTimeout(resolve, 150))
        inner.undo.addToUndoStack = addToUndoStack
        inner.options.input = input
        return { name, ...calls }
      }, type)

    await caretOffEntry()
    const editCalls = await clickCounting('edit-in-vscode')
    expect(editCalls, 'Edit in VS Code takes no boundary').toMatchObject({
      undo: 0,
      input: 0,
    })
    await expect
      .poll(
        () =>
          evaluateInVSCode(
            async (vscode: typeof import('vscode')) =>
              vscode.window.tabGroups.all.flatMap((group) => group.tabs).length,
            [file] as [string],
          ),
        { timeout: 30_000 },
      )
      .toBeGreaterThan(1)
    // The text editor opens in the active column; its own close reverts the unsaved edit, so the
    // host text is read before it and the settings case starts from a fresh editor.
    expect(await hostText(evaluateInVSCode, file)).toBe(typedHost)
    const frameAgain = await reopenVmdeFixture(evaluateInVSCode, workbox, file)
    await expect(frameAgain.locator('#vmde-prerender')).toHaveCount(0, {
      timeout: 60_000,
    })
    await waitForE2EReadiness(
      frameAgain,
      (state) => state.routerReady && state.editorEpoch > 0,
      { message: 'view-only controls readiness after the tab' },
    )
    await typeWord(workbox, frameAgain, 'ir', 'zzsettings')
    await frameAgain
      .locator('.vditor-ir p')
      .filter({ hasText: 'Second paragraph' })
      .first()
      .click()
    await caretAway(workbox)
    // Settings is a toolbar control (never inside More), so it is clicked where it sits.
    const settingsCalls = await frameAgain
      .locator('#app .vditor-toolbar [data-type="settings"]')
      .first()
      .evaluate(async (element) => {
        const outer = window as unknown as {
          vditor: {
            vditor: {
              options: { input?: (markdown: string) => void }
              undo: { addToUndoStack: (inner: unknown) => void }
            }
          }
        }
        const inner = outer.vditor.vditor
        const calls = { undo: 0, input: 0 }
        const addToUndoStack = inner.undo.addToUndoStack
        inner.undo.addToUndoStack = function (this: unknown, ...rest) {
          calls.undo++
          return (addToUndoStack as (...a: unknown[]) => void).apply(this, [
            ...rest,
          ])
        }
        const input = inner.options.input
        inner.options.input = (markdown: string) => {
          calls.input++
          input?.(markdown)
        }
        ;(element as HTMLElement).click()
        await new Promise((resolve) => setTimeout(resolve, 150))
        inner.undo.addToUndoStack = addToUndoStack
        inner.options.input = input
        return calls
      })
    expect(settingsCalls, 'Settings takes no boundary').toEqual({
      undo: 0,
      input: 0,
    })
    await closeOtherTabs()
  } finally {
    await setWiki(false)
  }
})
