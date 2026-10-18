import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
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

// Task 650: the Outline open state and width are remembered across files and VS Code sessions
// (tasks/done/650-remember-outline-open-state-and-width.md, Acceptance 1 to 6). The host keeps one
// user-level boolean (`vmde.outlineOpen`, profile-local) beside the synced width and ships both with
// `init`; other open editors keep their state until reopened; `vmde.outline.defaultOpen` decides
// until the first toggle and decides again after the setting changes. Every toggle here is a real
// click on the toolbar Outline button; every resize is a real key press or mouse drag on the
// separator. Widths are measured (content width of `.vditor-outline`), never judged by eye.

type Frame = ReturnType<typeof wf>
type HostEvaluator = Parameters<typeof docText>[0]
type Mode = 'ir' | 'wysiwyg' | 'sv'

const PARAGRAPHS = Array.from(
  { length: 60 },
  (_, index) => `Paragraph ${index + 1} alpha beta gamma delta epsilon zeta.`,
)
const fixtureFor = (name: string) =>
  `# Fixture ${name}\n\n## Section one\n\n${PARAGRAPHS.slice(0, 30).join('\n\n')}\n\n## Section two\n\n${PARAGRAPHS.slice(30).join('\n\n')}\n`

const visibleFrame = (workbox: Page) =>
  workbox
    .frameLocator('iframe.webview:visible')
    .frameLocator('iframe[title="VMDE"], #active-frame')

const outlineButton = (frame: Frame) =>
  frame.locator('.vditor-toolbar [data-type="outline"]')

interface OutlineView {
  mode: string | null
  // `vditor.options.outline.enable`: what the toolbar button flips.
  enable: boolean
  // The panel is laid out and visible.
  shown: boolean
  // Content width of the shown panel in CSS pixels (0 when not shown).
  width: number
  // The `--me-outline-width` variable on the body, in pixels (null when unset).
  varPx: number | null
}

const outlineView = (frame: Frame) =>
  frame.locator('body').evaluate((): OutlineView => {
    const inner = (
      window as unknown as {
        vditor?: {
          vditor?: {
            currentMode?: string
            options?: { outline?: { enable?: boolean } }
          }
        }
      }
    ).vditor?.vditor
    const panel = document.querySelector<HTMLElement>('.vditor-outline')
    const style = panel ? getComputedStyle(panel) : null
    const rect = panel?.getBoundingClientRect()
    const shown = !!panel && style?.display !== 'none' && (rect?.width ?? 0) > 0
    const raw = parseFloat(
      document.body.style.getPropertyValue('--me-outline-width'),
    )
    return {
      mode: inner?.currentMode ?? null,
      enable: !!inner?.options?.outline?.enable,
      shown,
      width: shown && style ? parseFloat(style.width) : 0,
      varPx: Number.isFinite(raw) ? raw : null,
    }
  })

const expectOutline = (frame: Frame, open: boolean) =>
  expect
    .poll(async () => (await outlineView(frame)).shown, {
      timeout: 60_000,
      intervals: [500],
    })
    .toBe(open)

// A real click on the toolbar Outline button, then the wait for the panel to follow and for the
// stored value to settle. Two host writes about 100 ms apart used to be able to leave the stored
// value at the earlier one; Task 657 fixed that on the host (the sibling Preview spec bursts it), so
// this wait is kept only to leave these cases unchanged.
const toggleOutline = async (frame: Frame, open: boolean) => {
  await outlineButton(frame).click()
  await expectOutline(frame, open)
  await settle(frame, 1000)
}

// Which key grows the panel: ArrowLeft for a right-side panel (the default), ArrowRight for a left
// one. Read from the geometry: the separator sits on the content side of the panel.
const growKey = (frame: Frame) =>
  frame.locator('body').evaluate(() => {
    const panel = document.querySelector('.vditor-outline')
    const handle = document.querySelector('.outline-resize-handle')
    if (!panel || !handle) return 'ArrowLeft'
    return handle.getBoundingClientRect().left <
      panel.getBoundingClientRect().left
      ? 'ArrowLeft'
      : 'ArrowRight'
  })

// A keyboard resize: Home sets the minimum (100 px), then `steps` presses of the growing key add
// 10 px each. Every press stores the width on the host. Returns the shown width.
const resizeByKeys = async (
  workbox: Page,
  frame: Frame,
  steps: number,
): Promise<number> => {
  const key = await growKey(frame)
  await frame.locator('.outline-resize-handle').focus()
  await workbox.keyboard.press('Home')
  for (let i = 0; i < steps; i++) await workbox.keyboard.press(key)
  const expected = 100 + steps * 10
  await expect
    .poll(async () => (await outlineView(frame)).width, { timeout: 10_000 })
    .toBe(expected)
  await settle(frame, 1000)
  return expected
}

// A real mouse drag on the separator by `delta` pixels in the growing direction.
const dragResize = async (workbox: Page, frame: Frame, delta: number) => {
  const key = await growKey(frame)
  const box = await frame.locator('.outline-resize-handle').boundingBox()
  if (!box) throw new Error('separator has no box')
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  await workbox.mouse.move(x, y)
  await workbox.mouse.down()
  await workbox.mouse.move(x + (key === 'ArrowLeft' ? -delta : delta), y, {
    steps: 8,
  })
  await workbox.mouse.up()
  await settle(frame, 1000)
}

// What Acceptance 6 can hold: value, Undo depth, caret and scroll in the webview.
interface WebviewState {
  mode: Mode
  value: string
  undoDepth: number
  caret: { block: string; offset: number } | null
  scroll: number[]
}

const webviewState = (frame: Frame) =>
  frame.locator('body').evaluate((): WebviewState => {
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
    const selection = window.getSelection()
    const scrollers = Array.from(
      document.querySelectorAll<HTMLElement>(
        '.vditor-content, .vditor-ir, .vditor-ir .vditor-reset',
      ),
    )
    return {
      mode: inner.currentMode,
      value: outer.vditor.getValue(),
      undoDepth: inner.undo[inner.currentMode]?.undoStack.length ?? -1,
      // The caret as a character offset inside its block: the text node holding it may be split
      // or merged by a re-render without the caret moving.
      caret: (() => {
        const anchor = selection?.anchorNode
        const block = (
          anchor instanceof Element ? anchor : anchor?.parentElement
        )?.closest('p, h1, h2, h3, li')
        if (!anchor || !block || !selection) return null
        const range = document.createRange()
        range.setStart(block, 0)
        range.setEnd(anchor, selection.anchorOffset)
        return {
          block: block.textContent ?? '',
          offset: range.toString().length,
        }
      })(),
      scroll: [
        document.documentElement.scrollTop,
        ...scrollers.map((element) => element.scrollTop),
      ],
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
// webview holds that file's document: each fixture carries its own heading, so a read of the
// previous editor cannot satisfy the wait.
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
    { message: `outline-state readiness ${path.basename(file)}` },
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
    { message: `outline-state ${mode} readiness` },
  )
}

const previewOn = (frame: Frame) =>
  frame
    .locator('body')
    .evaluate(
      () =>
        !!document
          .querySelector('.vditor-toolbar [data-type="preview"]')
          ?.classList.contains('vditor-menu--current'),
    )

// Restores what later specs of the run expect: panel closed, width 200 (the CSS fallback), the
// IR mode and Preview off.
const restoreDefaults = async (workbox: Page, frame: Frame) => {
  if (await previewOn(frame)) {
    await frame.locator('.vditor-toolbar [data-type="preview"]').click()
    await expect.poll(() => previewOn(frame)).toBe(false)
  }
  if ((await outlineView(frame)).mode !== 'ir') await switchMode(frame, 'ir')
  if (!(await outlineView(frame)).shown) await toggleOutline(frame, true)
  await resizeByKeys(workbox, frame, 10)
  await toggleOutline(frame, false)
}

test('the Outline state is shared by files, followed by no open editor, ruled by defaultOpen and changes no document state', async ({
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
    // (a) Acceptance 1, 3: open in file A; file B opens open; a toggle and a resize in B leave the
    // still-open editor A alone, and files opened afterwards follow B.
    const fileA = fileOf('a.md')
    const fileB = fileOf('b.md')
    const fileC = fileOf('c.md')
    const fileD = fileOf('d.md')
    frame = await show(fileA, true)
    await expectOutline(frame, false)
    await toggleOutline(frame, true)
    const widthA = (await outlineView(frame)).width
    frame = await show(fileB)
    await expectOutline(frame, true)
    expect((await outlineView(frame)).width).toBe(widthA)
    // Opening with the panel leaves the document as it was on disk and clean.
    expect(await hostState(evaluateInVSCode, fileB)).toEqual({
      text: fixtureFor('b.md'),
      dirty: false,
    })
    // Toggle closed and resize in B (the panel is shown again to resize, then closed).
    const widthB = await resizeByKeys(workbox, frame, 8)
    expect(widthB).toBe(180)
    await toggleOutline(frame, false)
    // The still-open editor A keeps its open panel and its width.
    frame = await show(fileA)
    await expectOutline(frame, true)
    expect((await outlineView(frame)).width).toBe(widthA)
    // A new file follows the stored value: closed (the last toggle), at B's width once opened.
    frame = await show(fileC)
    await expectOutline(frame, false)
    await settle(frame, 500)
    await expectOutline(frame, false)
    expect((await outlineView(frame)).varPx).toBe(widthB)
    await toggleOutline(frame, true)
    expect((await outlineView(frame)).width).toBe(widthB)
    // Reopening A (all editors closed, then A) now shows the stored state: open at B's width.
    frame = await show(fileA, true)
    await expectOutline(frame, true)
    expect((await outlineView(frame)).width).toBe(widthB)

    // (e) Task 656, Acceptance 1 to 3: a drag stores the CONTENT width. Editor A is open and shown
    // at 180. The drag moves by whole pixels from that basis, so the panel and the variable must
    // both read exactly 220 (the old border-box read made it 221).
    await dragResize(workbox, frame, 40)
    let afterDrag = await outlineView(frame)
    expect(afterDrag.width).toBe(220)
    expect(afterDrag.varPx).toBe(220)
    // Another file opens at the stored width: the host round trip kept the content width.
    frame = await show(fileD)
    await expectOutline(frame, true)
    afterDrag = await outlineView(frame)
    expect(afterDrag.width).toBe(220)
    expect(afterDrag.varPx).toBe(220)
    // Ten real press-and-release cycles on the separator with no movement store nothing. A fresh
    // editor (all editors closed) then still opens at 220.
    for (let cycle = 0; cycle < 10; cycle++) {
      const box = await frame.locator('.outline-resize-handle').boundingBox()
      if (!box) throw new Error('separator has no box')
      await workbox.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
      await workbox.mouse.down()
      await workbox.mouse.up()
    }
    await settle(frame, 1000)
    frame = await show(fileC, true)
    await expectOutline(frame, true)
    afterDrag = await outlineView(frame)
    expect(afterDrag.width).toBe(220)
    expect(afterDrag.varPx).toBe(220)

    // (d) Acceptance 6: toggling and resizing change no text, dirty state, Undo history, caret or
    // scroll. The document is edited first, so the Undo stack and the dirty flag are non-trivial.
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
    // The stored state is open from (a), so the panel is shown. A real click puts the caret in a
    // paragraph, then the editor is scrolled down.
    await expectOutline(frame, true)
    await frame
      .locator('.vditor-ir p')
      .filter({ hasText: 'Paragraph 12 ' })
      .first()
      .click()
    await frame.locator('body').evaluate(() => {
      const scrollers = Array.from(
        document.querySelectorAll<HTMLElement>(
          '.vditor-content, .vditor-ir, .vditor-ir .vditor-reset',
        ),
      ).filter((element) => element.scrollHeight > element.clientHeight + 1)
      const target = scrollers[0] ?? document.documentElement
      target.scrollTop = 300
    })
    await settle(frame, 1500)
    const before = {
      view: await webviewState(frame),
      host: await hostState(evaluateInVSCode, fileF),
    }
    expect(before.view.undoDepth).toBeGreaterThan(0)
    expect(before.view.caret?.block).toContain('Paragraph 12 ')
    expect(Math.max(...before.view.scroll), 'scrolled').toBeGreaterThan(0)
    expect(before.host.dirty).toBe(true)
    // Task 653: a toolbar Outline click takes no Undo boundary, so the depth is exactly the one
    // from before (the Undo behavior itself is owned by outline-toggle-undo.spec.ts). The
    // resizes never touched the history.
    const unchanged = async () => {
      const now = {
        view: await webviewState(frame as Frame),
        host: await hostState(evaluateInVSCode, fileF),
      }
      expect(now).toEqual(before)
    }
    await toggleOutline(frame, false)
    await unchanged()
    await toggleOutline(frame, true)
    await unchanged()
    await resizeByKeys(workbox, frame, 12)
    await unchanged()
    await dragResize(workbox, frame, 40)
    await unchanged()
    // Back to a known state for the rule cases below.
    await toggleOutline(frame, false)

    // (c) Acceptance 4: with the setting on and the panel toggled closed, the next file stays
    // closed; changing the setting makes the setting decide again.
    await setConfig(evaluateInVSCode, 'outline.defaultOpen', true)
    frame = await show(fileOf('rule-1.md'), true)
    // A setting change clears the remembered value, so the setting decides: open.
    await expectOutline(frame, true)
    await toggleOutline(frame, false)
    frame = await show(fileOf('rule-2.md'), true)
    await expectOutline(frame, false)
    await settle(frame, 500)
    await expectOutline(frame, false)
    // An editor stays open while the setting changes (the host clears the stored value for the
    // open editors it serves): false first, then true again. The stored "closed" must not win.
    await setConfig(evaluateInVSCode, 'outline.defaultOpen', false)
    await settle(frame, 1500)
    await setConfig(evaluateInVSCode, 'outline.defaultOpen', true)
    await settle(frame, 1500)
    frame = await show(fileOf('rule-3.md'), true)
    await expectOutline(frame, true)
    await settle(frame, 500)
    await expectOutline(frame, true)
    // The setting off again: a user toggle stores, and the setting stays off for the next file.
    await setConfig(evaluateInVSCode, 'outline.defaultOpen', undefined)
    await settle(frame, 1500)
    frame = await show(fileOf('rule-4.md'), true)
    await expectOutline(frame, false)
    await toggleOutline(frame, true)
    frame = await show(fileD, true)
    await expectOutline(frame, true)
    await toggleOutline(frame, false)
  } finally {
    // `ConfigurationTarget.Global` persists in the shared user-data directory, so the setting
    // this case wrote must not decide how editors open in later specs of the run.
    await setConfig(evaluateInVSCode, 'outline.defaultOpen', undefined)
    try {
      await restoreDefaults(workbox, visibleFrame(workbox))
    } catch {
      /* no editor to restore */
    }
  }
})

// Acceptance 1, 2 (restart): both values outlive VS Code, and the panel has the stored width in
// the first frame it exists, in IR, WYSIWYG and Preview. The harness's own VS Code keeps workspace
// storage in memory, so this case launches the installed VS Code four times on the same user-data
// directory and workspace folder (the own-launch design of toolbar-collapse.spec.ts, Task 631).
// Files open through Quick Open, as a user does. A new file per launch: VS Code restores the
// previous run's editors, and the newly opened tab is the visible one.
const RESTARTS = [
  'outline-restart-1.md',
  'outline-restart-2.md',
  'outline-restart-3.md',
  'outline-restart-4.md',
]
const STORED_WIDTH = 170

interface PanelProbe {
  // Painted frames sampled, frames in which the panel element existed, and frames in which it was
  // visible.
  frames: number
  existing: number
  visible: number
  // The distinct "content width|variable" pairs seen on visible frames, in order of first sight.
  seen: string[]
  // `outlineOpen` and `outlineWidth` of the inlined init payload and of every init message.
  inits: Array<{ open: unknown; width: unknown }>
}

// Runs at document start in every frame of the workbench page; only child frames (the webviews)
// record. A webview's content frame starts as `about:blank` and its document is replaced, so a 1 ms
// timer (it survives the replacement) arms a frame sampler on every new root element.
function panelProbeScript() {
  if (window.top === window) return
  const store: PanelProbe = {
    frames: 0,
    existing: 0,
    visible: 0,
    seen: [],
    inits: [],
  }
  ;(window as unknown as { __panelProbe: PanelProbe }).__panelProbe = store
  let armedOn: Element | null = null
  const sample = (root: Element) => {
    if (root !== document.documentElement) return
    const panel = document.querySelector<HTMLElement>('.vditor-outline')
    store.frames++
    if (panel) {
      store.existing++
      const style = getComputedStyle(panel)
      if (style.display !== 'none') {
        store.visible++
        const pair = `${parseFloat(style.width)}|${document.body.style.getPropertyValue('--me-outline-width')}`
        if (!store.seen.includes(pair)) store.seen.push(pair)
      }
    }
    requestAnimationFrame(() => sample(root))
  }
  // The inline init payload is a script element near the end of the parsed HTML: at the first tick
  // on a new root it may not exist yet, or its text may be half parsed. Reading it once missed the
  // init (measured in the WYSIWYG launch), so every tick retries until it parses, for 30 s at most.
  let inlineRoot: Element | null = null
  let inlineUntil = 0
  const readInline = () => {
    const inline = document.getElementById('vmark-init')?.textContent
    if (!inline) return false
    try {
      const options = JSON.parse(inline).options
      store.inits.push({
        open: options?.outlineOpen,
        width: options?.outlineWidth,
      })
      return true
    } catch {
      return false /* half parsed */
    }
  }
  setInterval(() => {
    const root = document.documentElement
    if (!root) return
    if (root === inlineRoot && Date.now() < inlineUntil) {
      if (readInline()) inlineUntil = 0
    }
    if (root === armedOn) return
    armedOn = root
    inlineRoot = root
    inlineUntil = Date.now() + 30_000
    window.addEventListener(
      'message',
      (event) => {
        const data = event.data as {
          command?: string
          type?: string
          options?: { outlineOpen?: unknown; outlineWidth?: unknown }
        } | null
        if (data?.command === 'update' && data.type === 'init')
          store.inits.push({
            open: data.options?.outlineOpen,
            width: data.options?.outlineWidth,
          })
      },
      true,
    )
    if (readInline()) inlineUntil = 0
    requestAnimationFrame(() => sample(root))
  }, 1)
}

const readPanelProbe = (frame: Frame) =>
  frame
    .locator('body')
    .evaluate(
      () =>
        (window as unknown as { __panelProbe?: PanelProbe }).__panelProbe ??
        null,
    )

test('the Outline state is remembered after VS Code restarts, at the stored width from its first frame', async ({
  _vscodeInstall,
  extensionDevelopmentPath,
  baseDir,
}) => {
  test.setTimeout(900_000)
  for (const name of RESTARTS)
    writeFileSync(path.join(baseDir, name), fixtureFor(name))
  mkdirSync(path.join(baseDir, '.vscode'), { recursive: true })
  writeFileSync(
    path.join(baseDir, '.vscode', 'settings.json'),
    `${JSON.stringify({ 'workbench.editorAssociations': { '*.md': 'vmde.editor' } }, null, 2)}\n`,
  )
  // A profile of its own, recreated at the start and kept across the launches: the test cache's
  // shared user-data also holds what other specs left (Preview on, collapsed toolbar, Outline width
  // and open state, settings), which leaked into this case and failed it in checkouts with an old
  // cache. The extensions dir stays the shared one.
  const userDataDir = path.join(baseDir, 'restart-user-data')
  rmSync(userDataDir, { recursive: true, force: true })
  mkdirSync(userDataDir, { recursive: true })
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
        `--user-data-dir=${userDataDir}`,
        `--extensionDevelopmentPath=${extensionDevelopmentPath as string}`,
        baseDir,
      ],
    })
    try {
      await app.context().addInitScript(panelProbeScript)
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
  // The panel was visible on at least one sampled frame, and on every such frame it had the stored
  // width, both as laid out and as the variable the host's value became.
  const expectStoredFromFirstFrame = async (frame: Frame) => {
    const probe = await readPanelProbe(frame)
    expect(probe?.frames, 'painted frames sampled').toBeGreaterThan(0)
    expect(probe?.visible, 'frames with the panel visible').toBeGreaterThan(0)
    expect(probe?.seen).toEqual([`${STORED_WIDTH}|${STORED_WIDTH}px`])
    expect(probe?.inits).toContainEqual({ open: true, width: STORED_WIDTH })
  }

  await test.step('first launch: toggle the panel open and resize it', () =>
    launch(async (workbox) => {
      const frame = await openByQuickOpen(workbox, RESTARTS[0])
      await expectOutline(frame, false)
      await toggleOutline(frame, true)
      expect(await resizeByKeys(workbox, frame, 7)).toBe(STORED_WIDTH)
    }))

  await test.step('second launch (IR): open at the stored width from the first frame; WYSIWYG next', () =>
    launch(async (workbox) => {
      const frame = await openByQuickOpen(workbox, RESTARTS[1])
      await expectOutline(frame, true)
      expect(await outlineView(frame)).toMatchObject({
        mode: 'ir',
        width: STORED_WIDTH,
      })
      await expectStoredFromFirstFrame(frame)
      await switchMode(frame, 'wysiwyg')
      await expectOutline(frame, true)
      expect((await outlineView(frame)).width).toBe(STORED_WIDTH)
    }))

  await test.step('third launch (WYSIWYG): open at the stored width from the first frame; Preview next', () =>
    launch(async (workbox) => {
      const frame = await openByQuickOpen(workbox, RESTARTS[2])
      await expectOutline(frame, true)
      expect(await outlineView(frame)).toMatchObject({
        mode: 'wysiwyg',
        width: STORED_WIDTH,
      })
      await expectStoredFromFirstFrame(frame)
      await frame.locator('.vditor-toolbar [data-type="preview"]').click()
      await expect.poll(() => previewOn(frame)).toBe(true)
      await settle(frame, 1000)
    }))

  await test.step('fourth launch (Preview): open at the stored width from the first frame; Split shows no panel and the width applies on return; defaults restored', () =>
    launch(async (workbox) => {
      const frame = await openByQuickOpen(workbox, RESTARTS[3])
      await expect.poll(() => previewOn(frame)).toBe(true)
      await expectOutline(frame, true)
      expect((await outlineView(frame)).width).toBe(STORED_WIDTH)
      await expectStoredFromFirstFrame(frame)
      await frame.locator('.vditor-toolbar [data-type="preview"]').click()
      await expect.poll(() => previewOn(frame)).toBe(false)
      await switchMode(frame, 'sv')
      await expectOutline(frame, false)
      expect(await outlineView(frame)).toMatchObject({
        mode: 'sv',
        enable: true,
        varPx: STORED_WIDTH,
      })
      await switchMode(frame, 'ir')
      await expectOutline(frame, true)
      expect((await outlineView(frame)).width).toBe(STORED_WIDTH)
      // Leave the stored values at their defaults for later specs.
      await restoreDefaults(workbox, frame)
    }))
})
