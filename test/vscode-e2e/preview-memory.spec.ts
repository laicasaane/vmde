import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { _electron, type Page } from '@playwright/test'
import { expect, test } from 'vscode-test-playwright'
import {
  ExtensionId,
  MarkdownEditorViewType,
  type docText,
  settle,
  waitForE2EReadiness,
  type wf,
} from './webview-helpers'

// Task 651: the Preview toggle is remembered across files and VS Code sessions
// (tasks/done/651-remember-preview-toggle-state.md, Acceptance 1 to 7). Preview is Vditor's overlay over
// the edit mode, switched by the toolbar Preview button; the host keeps one user-level boolean and
// ships `openInPreview` with `init` only when no path rule or explicit `defaultMode` value applies.
// Every toggle here is a real click on the toolbar button.

type Frame = ReturnType<typeof wf>
type HostEvaluator = Parameters<typeof docText>[0]
type Mode = 'ir' | 'wysiwyg' | 'sv'

const PARAGRAPHS = Array.from(
  { length: 12 },
  (_, index) => `Paragraph ${index + 1} alpha beta gamma delta.`,
)
const fixtureFor = (name: string) =>
  `# Fixture ${name}\n\n${PARAGRAPHS.join('\n\n')}\n`

const SECTIONS = 1200
// About 620 characters per section: 1200 sections is roughly 744,000 characters, above the 700,000
// streaming threshold. Generated at test time and written to the temporary workspace only.
const largeMarkdown = () => {
  const parts: string[] = ['# Fixture large.md\n\n']
  for (let i = 0; i < SECTIONS; i++)
    parts.push(`## Section ${i}\n\n${'lorem ipsum '.repeat(50)}\n\n`)
  return parts.join('')
}

const visibleFrame = (workbox: Page) =>
  workbox
    .frameLocator('iframe.webview:visible')
    .frameLocator('iframe[title="VMDE"], #active-frame')

const previewButton = (frame: Frame) =>
  frame.locator('.vditor-toolbar [data-type="preview"]')

// The live Vditor instance: the edit mode, the Preview button class and the overlay's visibility.
const previewState = (frame: Frame) =>
  frame.locator('body').evaluate(() => {
    const inner = (
      window as unknown as {
        vditor?: {
          vditor?: {
            currentMode?: string
            toolbar?: { elements?: Record<string, HTMLElement> }
            preview?: { element?: HTMLElement }
            sv?: { element?: HTMLElement }
            ir?: { element?: HTMLElement }
            wysiwyg?: { element?: HTMLElement }
          }
        }
      }
    ).vditor?.vditor
    const button = inner?.toolbar?.elements?.preview?.children[0]
    const overlay = inner?.preview?.element
    // The edit pane Preview hides: the Split source, or the wrapper of the IR or WYSIWYG pane.
    const mode = inner?.currentMode as 'ir' | 'wysiwyg' | 'sv' | undefined
    const editPane =
      mode === 'sv'
        ? inner?.sv?.element
        : inner?.[mode ?? 'ir']?.element?.parentElement
    return {
      editShown: !!editPane && getComputedStyle(editPane).display !== 'none',
      mode: inner?.currentMode ?? null,
      previewOn: !!button?.classList.contains('vditor-menu--current'),
      overlayShown: !!overlay && getComputedStyle(overlay).display !== 'none',
    }
  })

const expectPreview = (frame: Frame, on: boolean, mode: Mode = 'ir') =>
  expect
    .poll(() => previewState(frame), { timeout: 60_000, intervals: [500] })
    .toEqual({
      mode,
      previewOn: on,
      editShown: !on,
      // Split keeps its rendered pane beside the source, so the pane is shown with Preview off too.
      overlayShown: on || mode === 'sv',
    })

// A real click on the toolbar Preview button, then the wait for the overlay to follow and for the
// stored value to settle. Before Task 657 two toggles about 100 ms apart could leave the stored
// value at the earlier one; the host now keeps the last write (Task 657) and the restart test below
// clicks in 100 ms bursts. Single toggles still wait as a user's would: this wait is no longer
// needed for correctness and is kept only to keep these cases unchanged.
const togglePreview = async (frame: Frame, on: boolean, mode: Mode = 'ir') => {
  await previewButton(frame).click()
  await expectPreview(frame, on, mode)
  await settle(frame, 1000)
}

const BURST_SELECTORS = {
  preview: '.vditor-toolbar [data-type="preview"]',
  outline: '.vditor-toolbar [data-type="outline"]',
  toolbar: '.vditor-toolbar [data-type="collapse-toolbar"]',
}

// Task 657: `count` clicks on one real toolbar button, `spacingMs` apart, driven by a script so the
// spacing is exact. The same click listener runs as for a user click. It cannot prove the
// repair path ran: the stale storage echo it guards against cannot be forced from here.
const burst = (frame: Frame, selector: string, count = 3, spacingMs = 100) =>
  frame.locator('body').evaluate(
    async (_body, args) => {
      const button = document.querySelector<HTMLElement>(args.selector)
      if (!button) throw new Error(`no button ${args.selector}`)
      for (let index = 0; index < args.count; index++) {
        button.click()
        if (index < args.count - 1)
          await new Promise((done) => setTimeout(done, args.spacingMs))
      }
    },
    { selector, count, spacingMs },
  )

const expectToolbarCollapsed = (frame: Frame, collapsed: boolean) =>
  expect(
    frame.locator('.vditor-toolbar [data-type="collapse-toolbar"]'),
  ).toHaveAttribute('aria-expanded', String(!collapsed), { timeout: 60_000 })

const expectOutlineOpen = (frame: Frame, open: boolean) =>
  open
    ? expect(frame.locator('.vditor-outline')).toBeVisible({ timeout: 60_000 })
    : expect(frame.locator('.vditor-outline')).toBeHidden({ timeout: 60_000 })

// What Acceptance 6 can hold in the real editor, read in the webview: the value, the edit mode and
// the Undo depth. The DOM selection is not part of it: the existing overlay hides the focused edit
// pane, which already collapses and moves the selection for a programmatic toggle too.
const webviewState = (frame: Frame) =>
  frame.locator('body').evaluate(() => {
    const outer = window as unknown as {
      vditor: {
        getValue(): string
        vditor: {
          currentMode: Mode
          undo: Record<string, { undoStack: unknown[] }>
        }
      }
    }
    const inner = outer.vditor.vditor
    return {
      mode: inner.currentMode,
      value: outer.vditor.getValue(),
      undoDepth: inner.undo[inner.currentMode]?.undoStack.length ?? -1,
    }
  })

const hostState = (evaluateInVSCode: HostEvaluator, file: string) =>
  evaluateInVSCode(
    async (vscode: typeof import('vscode'), args: string[]) => {
      const document = vscode.workspace.textDocuments.find(
        (candidate) => candidate.uri.fsPath === args[0],
      )
      return { text: document?.getText() ?? '', dirty: !!document?.isDirty }
    },
    [file] as [string],
  ) as Promise<{ text: string; dirty: boolean }>

// Lute loads asynchronously: `getValue()` throws until it is ready, which reads as "no value yet".
const webviewValue = (frame: Frame) =>
  frame.locator('body').evaluate(() => {
    try {
      return (
        (
          window as unknown as { vditor?: { getValue(): string } }
        ).vditor?.getValue() ?? ''
      )
    } catch {
      return ''
    }
  })

// Opens a file in the VMDE editor (a new tab, or focuses its tab) and waits until the visible
// webview holds that file's document: a retained hidden tab keeps its own iframe, and each fixture
// carries its own heading, so a read of the previous editor cannot satisfy the wait.
const showFile = async (
  evaluateInVSCode: HostEvaluator,
  workbox: Page,
  file: string,
  { closeOthers = false } = {},
) => {
  if (closeOthers)
    await evaluateInVSCode(
      async (vscode: typeof import('vscode')) => {
        await vscode.commands.executeCommand('workbench.action.closeAllEditors')
      },
      [file] as [string],
    )
  await evaluateInVSCode(
    async (vscode: typeof import('vscode'), args: [string, string, string]) => {
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
  await expect
    .poll(() => webviewValue(frame), { timeout: 60_000, intervals: [500] })
    .toContain(`# Fixture ${path.basename(file)}`)
  await waitForE2EReadiness(
    frame,
    (state) => state.routerReady && state.editorEpoch > 0,
    { message: `preview-memory readiness ${path.basename(file)}` },
  )
  return frame
}

const setConfig = (
  evaluateInVSCode: HostEvaluator,
  key: string,
  value: unknown,
) =>
  evaluateInVSCode(
    async (vscode: typeof import('vscode'), args: [string, string]) => {
      await vscode.workspace
        .getConfiguration('vmde')
        .update(
          args[0],
          args[1] === 'undefined' ? undefined : JSON.parse(args[1]),
          vscode.ConfigurationTarget.Global,
        )
    },
    [key, value === undefined ? 'undefined' : JSON.stringify(value)] as [
      string,
      string,
    ],
  )

const switchMode = async (frame: Frame, mode: Mode) => {
  await frame.locator('.vditor-toolbar [data-type="edit-mode"]').click()
  await frame
    .locator('.vditor-toolbar')
    .locator(`button[data-mode="${mode}"]`)
    .click()
  await waitForE2EReadiness(
    frame,
    (state) => state.routerReady && state.mode === mode,
    { message: `preview-memory ${mode} readiness` },
  )
}

test('the Preview toggle is shared by files, overridden by rules and settings, survives streaming and changes no document state', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(900_000)
  await workbox.setViewportSize({ width: 1400, height: 900 })
  const fileOf = (name: string) => {
    const file = path.join(baseDir, name)
    writeFileSync(file, fixtureFor(name))
    return file
  }
  const show = (file: string, closeOthers = false) =>
    showFile(evaluateInVSCode, workbox, file, { closeOthers })
  let frame: Frame | undefined
  try {
    // (a) Acceptance 1, 4: on in file A; file B opens in Preview; a toggle in B leaves A alone.
    const fileA = fileOf('a.md')
    const fileB = fileOf('b.md')
    const fileC = fileOf('c.md')
    frame = await show(fileA, true)
    await expectPreview(frame, false)
    await togglePreview(frame, true)
    frame = await show(fileB)
    await expectPreview(frame, true)
    // Opening in Preview leaves the document as it was on disk and clean (Acceptance 6).
    expect(await hostState(evaluateInVSCode, fileB)).toEqual({
      text: fixtureFor('b.md'),
      dirty: false,
    })
    frame = await show(fileA)
    await expectPreview(frame, true)
    frame = await show(fileB)
    await togglePreview(frame, false)
    frame = await show(fileA)
    await expectPreview(frame, true)
    // Acceptance 2 (off): the toggle in B stored "off", so the next file opens editable.
    frame = await show(fileC)
    await expectPreview(frame, false)
    await settle(frame, 500)
    await expectPreview(frame, false)

    // (f) Acceptance 6: toggling changes no text, dirty state or Undo history.
    const fileF = fileOf('f.md')
    frame = await show(fileF, true)
    await evaluateInVSCode(
      async (vscode: typeof import('vscode'), args: string[]) => {
        const document = vscode.workspace.textDocuments.find(
          (candidate) => candidate.uri.fsPath === args[0],
        )
        if (!document) throw new Error('document not open')
        const edit = new vscode.WorkspaceEdit()
        edit.insert(
          document.uri,
          document.positionAt(document.getText().length),
          'Edited tail line.\n',
        )
        await vscode.workspace.applyEdit(edit)
      },
      [fileF] as [string],
    )
    await expect
      .poll(() => webviewValue(frame as Frame), { timeout: 30_000 })
      .toContain('Edited tail line.')
    await expect
      .poll(async () => (await hostState(evaluateInVSCode, fileF)).dirty)
      .toBe(true)
    await settle(frame, 1500)
    const before = {
      view: await webviewState(frame),
      host: await hostState(evaluateInVSCode, fileF),
    }
    expect(before.view.undoDepth).toBeGreaterThan(0)
    expect(before.host.dirty).toBe(true)
    await togglePreview(frame, true)
    expect({
      view: await webviewState(frame),
      host: await hostState(evaluateInVSCode, fileF),
    }).toEqual(before)
    await togglePreview(frame, false)
    expect({
      view: await webviewState(frame),
      host: await hostState(evaluateInVSCode, fileF),
    }).toEqual(before)
    // Back on, for the rule cases below.
    await togglePreview(frame, true)

    // (d) Acceptance 3: a `preview` or `ir` path rule and an explicit `defaultMode: "ir"` win
    // whatever the toggle holds, and never clear it. The toggle is on here.
    await setConfig(evaluateInVSCode, 'editor.defaultModeByGlob', {
      '**/ir-*.md': 'ir',
      '**/pv-*.md': 'preview',
    })
    frame = await show(fileOf('ir-on.md'), true)
    await expectPreview(frame, false)
    await settle(frame, 500)
    await expectPreview(frame, false)
    frame = await show(fileOf('pv-on.md'), true)
    await expectPreview(frame, true)
    await setConfig(evaluateInVSCode, 'editor.defaultModeByGlob', undefined)
    await setConfig(evaluateInVSCode, 'editor.defaultMode', 'ir')
    frame = await show(fileOf('explicit-on.md'), true)
    await expectPreview(frame, false)
    await settle(frame, 500)
    await expectPreview(frame, false)
    // The overrides did not clear the toggle: with the setting back to `remember` it still opens.
    await setConfig(evaluateInVSCode, 'editor.defaultMode', undefined)
    frame = await show(fileOf('still-on.md'), true)
    await expectPreview(frame, true)
    // Now off (a user toggle), and the same rules again.
    await togglePreview(frame, false)
    await setConfig(evaluateInVSCode, 'editor.defaultModeByGlob', {
      '**/ir-*.md': 'ir',
      '**/pv-*.md': 'preview',
    })
    frame = await show(fileOf('ir-off.md'), true)
    await expectPreview(frame, false)
    frame = await show(fileOf('pv-off.md'), true)
    await expectPreview(frame, true)
    await setConfig(evaluateInVSCode, 'editor.defaultModeByGlob', undefined)
    await setConfig(evaluateInVSCode, 'editor.defaultMode', 'ir')
    frame = await show(fileOf('explicit-off.md'), true)
    await expectPreview(frame, false)
    await setConfig(evaluateInVSCode, 'editor.defaultMode', undefined)
    // A preview-rule open does not store: the stored value is still off.
    frame = await show(fileOf('after-rules.md'), true)
    await expectPreview(frame, false)

    // (c) Acceptance 2: off opens in the stored edit mode (Split), and toggling Preview off
    // returns to Split.
    await switchMode(frame, 'sv')
    frame = await show(fileOf('split.md'), true)
    await expectPreview(frame, false, 'sv')
    await expect(frame.locator('.vditor-sv').first()).toBeVisible()
    await togglePreview(frame, true, 'sv')
    await togglePreview(frame, false, 'sv')
    await expect(frame.locator('.vditor-sv').first()).toBeVisible()
    await switchMode(frame, 'ir')

    // (e) Acceptance 5: a document over the streaming threshold ends in Preview after streaming.
    await togglePreview(frame, true)
    const large = path.join(baseDir, 'large.md')
    writeFileSync(large, largeMarkdown())
    expect(largeMarkdown().length).toBeGreaterThan(700_000)
    frame = await show(large, true)
    await expect
      .poll(() => frame?.locator('#vmde-stream-spinner').count(), {
        timeout: 240_000,
        intervals: [2_000],
      })
      .toBe(0)
    await expectPreview(frame, true)
    // Preview off returns to the editable IR editor, fully streamed in.
    await togglePreview(frame, false)
    await expect
      .poll(() => frame?.locator('.vditor-ir h2').count(), {
        timeout: 150_000,
        intervals: [2_000],
      })
      .toBe(SECTIONS)
    await expect(
      frame.locator('.vditor-ir .vditor-reset').first(),
    ).toHaveAttribute('contenteditable', 'true')
  } finally {
    // `ConfigurationTarget.Global` persists in the shared user-data directory, so the settings
    // this case wrote must not decide how documents open in later specs of the run.
    await setConfig(evaluateInVSCode, 'editor.defaultMode', undefined)
    await setConfig(evaluateInVSCode, 'editor.defaultModeByGlob', undefined)
    // Leave the stored value at its default for later specs: turn Preview off if it is on.
    try {
      const open = visibleFrame(workbox)
      if ((await previewState(open)).previewOn)
        await previewButton(open).click()
      if ((await previewState(open)).mode !== 'ir') await switchMode(open, 'ir')
    } catch {
      /* no editor to restore */
    }
  }
})

// Acceptance 1 (restart): the value outlives VS Code. The harness's own VS Code keeps workspace
// storage in memory, so this case launches the installed VS Code three times on the same user-data
// directory and workspace folder (the own-launch design of toolbar-collapse.spec.ts, Task 631).
// Files open through Quick Open, as a user does.
// A new file per launch: VS Code restores the previous run's editors, and the newly opened tab is
// the visible one.
const RESTARTS = [
  'preview-restart-1.md',
  'preview-restart-2.md',
  'preview-restart-3.md',
  'preview-restart-4.md',
  // Opened in the first launch, right after the bursts (Task 657).
  'preview-restart-5.md',
]

test('the Preview state is remembered after VS Code restarts, and turning it off restores the default', async ({
  _vscodeInstall,
  extensionDevelopmentPath,
  baseDir,
}) => {
  test.setTimeout(600_000)
  for (const name of RESTARTS)
    writeFileSync(path.join(baseDir, name), fixtureFor(name))
  mkdirSync(path.join(baseDir, '.vscode'), { recursive: true })
  writeFileSync(
    path.join(baseDir, '.vscode', 'settings.json'),
    `${JSON.stringify({ 'workbench.editorAssociations': { '*.md': 'vmde.editor' } }, null, 2)}\n`,
  )
  const launch = async (body: (workbox: Page) => Promise<void>) => {
    const env = { ...process.env }
    // Any VSCODE_* variable of the parent breaks custom webviews (as in the harness's own launch).
    for (const name of Object.keys(env))
      if (/^VSCODE_/i.test(name)) delete env[name]
    const app = await _electron.launch({
      executablePath: _vscodeInstall.installPath,
      env,
      args: [
        '--no-sandbox',
        '--disable-gpu-sandbox',
        '--disable-updates',
        '--ozone-platform=x11',
        '--skip-welcome',
        '--skip-release-notes',
        '--disable-workspace-trust',
        `--extensions-dir=${path.join(_vscodeInstall.cachePath, 'extensions')}`,
        `--user-data-dir=${path.join(_vscodeInstall.cachePath, 'user-data')}`,
        `--extensionDevelopmentPath=${extensionDevelopmentPath as string}`,
        baseDir,
      ],
    })
    try {
      const workbox = await app.firstWindow()
      await workbox.setViewportSize({ width: 1400, height: 900 })
      await body(workbox)
    } finally {
      // Closing the application writes the workspace and profile state.
      await app.close()
    }
  }
  const openByQuickOpen = async (workbox: Page, name: string) => {
    await workbox.locator('.monaco-workbench').waitFor({ timeout: 60_000 })
    await workbox.keyboard.press('Control+P')
    await workbox.keyboard.type(name)
    // Enter before the file list is ready would pick nothing.
    await workbox
      .locator('.quick-input-list .monaco-list-row')
      .filter({ hasText: name })
      .first()
      .waitFor({ timeout: 30_000 })
    await workbox.keyboard.press('Enter')
    const frame = visibleFrame(workbox)
    await expect
      .poll(() => webviewValue(frame), { timeout: 60_000, intervals: [500] })
      .toContain(`# Fixture ${name}`)
    await waitForE2EReadiness(
      frame,
      (state) => state.routerReady && state.editorEpoch > 0,
    )
    return frame
  }

  await test.step('first launch: nothing stored; three quick toggles of Preview, toolbar collapse and Outline end on the last click and the next file reads them', () =>
    launch(async (workbox) => {
      const frame = await openByQuickOpen(workbox, RESTARTS[0])
      await expectPreview(frame, false)
      await settle(frame, 500)
      await expectPreview(frame, false)
      await expectToolbarCollapsed(frame, false)
      await expectOutlineOpen(frame, false)
      // Task 657: on, off, on 100 ms apart (and the same for the other two), no wait between them.
      // The toolbar goes last: once collapsed, the other buttons may be hidden.
      await burst(frame, BURST_SELECTORS.preview)
      await burst(frame, BURST_SELECTORS.outline)
      await burst(frame, BURST_SELECTORS.toolbar)
      await expectPreview(frame, true)
      await expectOutlineOpen(frame, true)
      await expectToolbarCollapsed(frame, true)
      // Acceptance 2: the next file opened in this launch reads the last toggle of each.
      const next = await openByQuickOpen(workbox, RESTARTS[4])
      await expectPreview(next, true)
      await expectOutlineOpen(next, true)
      await expectToolbarCollapsed(next, true)
    }))

  await test.step('second launch: the file opens with all three stored, so does another; restoring the defaults stores those', () =>
    launch(async (workbox) => {
      const frame = await openByQuickOpen(workbox, RESTARTS[1])
      await expectPreview(frame, true)
      await expectOutlineOpen(frame, true)
      await expectToolbarCollapsed(frame, true)
      const other = await openByQuickOpen(workbox, RESTARTS[2])
      await expectPreview(other, true)
      // One toggle each (toolbar first so the others are reachable), with the usual wait.
      await burst(other, BURST_SELECTORS.toolbar, 1)
      await expectToolbarCollapsed(other, false)
      await settle(other, 1000)
      await burst(other, BURST_SELECTORS.outline, 1)
      await expectOutlineOpen(other, false)
      await settle(other, 1000)
      await togglePreview(other, false)
    }))

  await test.step('third launch: the default is restored, the file opens editable', () =>
    launch(async (workbox) => {
      const frame = await openByQuickOpen(workbox, RESTARTS[3])
      await expectPreview(frame, false)
      await settle(frame, 500)
      await expectPreview(frame, false)
      await expectToolbarCollapsed(frame, false)
      await expectOutlineOpen(frame, false)
    }))
})
