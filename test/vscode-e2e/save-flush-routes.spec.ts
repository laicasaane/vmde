import { execFile } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import type { ElectronApplication, Locator, Page } from '@playwright/test'
import { expect, test } from 'vscode-test-playwright'
import { ProductDisplayName } from '../../src/shared/product-identity'
import {
  applyReplacements,
  CROSS_REGION_TOKEN,
  FIXTURE,
  literalMatches,
  wholeWordMatches,
} from './find-replace-fixture-helpers'
import { createXtestInput, type XtestInput } from './helpers/xtest-input'
import { waitForE2EReadiness } from './webview-helpers'

/**
 * Task 580 CP2-12 — the will-save flush. VMDE no longer watches for a literal Ctrl/Cmd+S in the
 * webview; the host's onWillSaveTextDocument asks the webview to flush pending typing before any
 * save writes the document. Before this, Command Palette "File: Save" in WYSIWYG (and SV when the
 * Return beat the debounced post) and auto-save on focus change (every mode) wrote the text from
 * before the last keystroke and left the document dirty (CP1 P8b, run.vbpIsh).
 *
 * Each cell: a fresh small file, a native seed `k` that reaches the host (dirty, disk unchanged),
 * then a native `x` immediately followed by the save route (VS Code's own Ctrl+S, Palette
 * "File: Save", or a click into another editor with auto-save onFocusChange). The first and only
 * save must write both characters and leave the document clean. A second test keeps CP1 P8d: Task
 * 196 exact bytes after Replace All survive a native Save, because the flush stays the guarded
 * EditSync.flush(). All keys and the focus-change click are OS-level XTEST input (see
 * docs/os-keyboard-testing-setup.md); setup clicks use Playwright.
 */

type Mode = 'ir' | 'wysiwyg' | 'sv'
type Route = 'saveKey' | 'palette' | 'onFocusChange'

const MODES: Mode[] = ['ir', 'wysiwyg', 'sv']
// `saveKey` keeps CP1 P8a: VS Code's own Ctrl+S, which the webview no longer watches.
const ROUTES: Route[] = ['saveKey', 'palette', 'onFocusChange']
// The CP1 P8a fixture. SV is entered from an IR open through the toolbar; its file keeps two final
// newlines, the identity that round-trips through that entry path, so the host stays clean.
const S0: Record<Mode, string> = {
  ir: 'before\n\nalpha bravo delta.\n\nafter\n',
  wysiwyg: 'before\n\nalpha bravo delta.\n\nafter\n',
  sv: 'before\n\nalpha bravo delta.\n\nafter\n\n',
}
const splice = (text: string, insert: string) =>
  text.slice(0, 16) + insert + text.slice(16)
const PARAGRAPH = 'alpha bravo delta.'
const PARAGRAPH_SEEDED = 'alpha brkavo delta.'
const LOCAL_OFFSET = 8 // between the 'r' and the 'a' of 'bravo'
const PALETTE_LABEL = 'File: Save'
// WYSIWYG/SV caret.ts re-asserts the mode-entry caret for about 5 s; typing before that lands at
// the re-asserted caret instead of the prepared slot.
const MODE_SETTLE_MS = 6500
const SEED_QUIET_MS = 2000
// After the first save: the WYSIWYG debounced post (undoDelay 800 + 250 ms) and Task 434's
// deferred check (1200 ms) have both had time to run, so a stale first save would show as a
// dirty document or a second save.
const AFTER_SAVE_MS = 2500

const runFile = promisify(execFile)
const xdotool = async (args: string[]) =>
  (
    await runFile('/usr/bin/xdotool', args, {
      encoding: 'utf8',
      timeout: 5000,
    })
  ).stdout.trim()

type Host = <R, A>(
  fn: (vscode: typeof import('vscode'), args: A) => R | Promise<R>,
  args: A,
) => Promise<R>

interface HostState {
  text: string | null
  dirty: boolean | null
  willSaves: string[]
  didSaves: { text: string; dirty: boolean }[]
}

interface Kit {
  host: Host
  workbox: Page
  electronApp: ElectronApplication
  xtest: XtestInput
  baseDir: string
  frame: () => ReturnType<Page['frameLocator']>
}

// Read-only Command Palette state (CP1 P8b technique): rows are ordered by data-index because the
// list is virtualized; the selected row comes from aria-activedescendant.
function readPalette(target: string) {
  const widget = document.querySelector(
    '.quick-input-widget',
  ) as HTMLElement | null
  const visible =
    !!widget &&
    getComputedStyle(widget).display !== 'none' &&
    widget.getBoundingClientRect().height > 0
  const input = widget?.querySelector(
    '.quick-input-box input',
  ) as HTMLInputElement | null
  const activeId = input?.getAttribute('aria-activedescendant') ?? null
  const active =
    (activeId ? document.getElementById(activeId) : null) ??
    widget?.querySelector('.monaco-list-row.focused') ??
    null
  const label = (row: Element | null) =>
    (row?.querySelector('.label-name')?.textContent ?? '').trim() || null
  const rows = widget
    ? Array.from(widget.querySelectorAll('.monaco-list-row'))
    : []
  const index = (row: Element | null) =>
    row?.getAttribute('data-index') != null
      ? Number(row.getAttribute('data-index'))
      : null
  return {
    visible,
    inputFocused: !!input && document.activeElement === input,
    value: input?.value ?? null,
    activeLabel: label(active),
    activeIndex: index(active),
    targetIndex: index(rows.find((row) => label(row) === target) ?? null),
    rowLabels: rows.map(label).join('|'),
  }
}

// The center of the plain-text editor in the second group, in workbench viewport pixels.
function textEditorPoint() {
  const lines = Array.from(
    document.querySelectorAll(
      '.editor-group-container .monaco-editor .view-lines',
    ),
  ) as HTMLElement[]
  if (lines.length !== 1 || window.devicePixelRatio !== 1) return null
  const rect = lines[0].getBoundingClientRect()
  return {
    x: Math.round(rect.x + rect.width / 2),
    y: Math.round(rect.y + Math.min(rect.height / 2, 120)),
  }
}

// One collapsed Range at the slot inside the paragraph, with the editor focused (in the webview).
function placeCaretInPage(
  _body: Element,
  args: { paragraph: string; offset: number },
) {
  const inner = (window as any).vditor.vditor
  const root = inner[inner.currentMode].element as HTMLElement
  root.focus()
  const blocks = Array.from(root.querySelectorAll('[data-block]')).filter(
    (block) => (block.textContent ?? '').includes(args.paragraph),
  )
  const block = blocks.find(
    (candidate) =>
      !blocks.some((other) => other !== candidate && candidate.contains(other)),
  )
  if (!block) return false
  let target = (block.textContent ?? '').indexOf(args.paragraph) + args.offset
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const length = (node as Text).data.length
    if (target <= length) {
      const range = document.createRange()
      range.setStart(node, target)
      range.collapse(true)
      const selection = getSelection()
      selection?.removeAllRanges()
      selection?.addRange(range)
      return document.activeElement === root
    }
    target -= length
  }
  return false
}

// `value` '' removes the user setting (evaluateInVSCode cannot carry null or undefined).
const setAutoSave = (kit: Kit, value: string) =>
  kit.host(
    async (vscode, [next]: [string]) => {
      await vscode.workspace
        .getConfiguration('files')
        .update(
          'autoSave',
          next || undefined,
          vscode.ConfigurationTarget.Global,
        )
    },
    [value],
  )

// Host observers for one file: each will-save reason and, at each did-save, the saved text.
const observe = (kit: Kit, file: string) =>
  kit.host(
    (vscode, [fsPath]: [string]) => {
      const g = globalThis as any
      for (const sub of g.__cp212Subs ?? []) sub.dispose()
      const state = { willSaves: [] as string[], didSaves: [] as unknown[] }
      g.__cp212 = state
      g.__cp212Subs = [
        vscode.workspace.onWillSaveTextDocument((event) => {
          if (event.document.uri.fsPath === fsPath)
            state.willSaves.push(String(event.reason))
        }),
        vscode.workspace.onDidSaveTextDocument((document) => {
          if (document.uri.fsPath === fsPath)
            state.didSaves.push({
              text: document.getText(),
              dirty: document.isDirty,
            })
        }),
      ]
    },
    [file],
  )

const hostState = (kit: Kit, file: string): Promise<HostState> =>
  kit.host(
    (vscode, [fsPath]: [string]) => {
      const g = globalThis as any
      const document = vscode.workspace.textDocuments.find(
        (candidate) => candidate.uri.fsPath === fsPath,
      )
      return {
        text: document?.getText() ?? null,
        dirty: document?.isDirty ?? null,
        willSaves: g.__cp212?.willSaves ?? [],
        didSaves: g.__cp212?.didSaves ?? [],
      }
    },
    [file],
  )

const placeCaret = (kit: Kit, paragraph: string, offset: number) =>
  kit.frame().locator('body').evaluate(placeCaretInPage, { paragraph, offset })

// Opens the cell's file in IR, enters the mode through the toolbar and lets the caret settle.
async function openCell(kit: Kit, file: string, mode: Mode, id: string) {
  await kit.host(
    async (vscode, [fsPath]: [string]) => {
      await vscode.commands.executeCommand(
        'vscode.openWith',
        vscode.Uri.file(fsPath),
        'vmde.editor',
        { viewColumn: vscode.ViewColumn.One, preserveFocus: false },
      )
    },
    [file],
  )
  await waitForE2EReadiness(
    kit.frame(),
    (state) =>
      state.routerReady && state.editorEpoch > 0 && state.mode === 'ir',
    { timeout: 90_000, message: `${id} IR readiness` },
  )
  if (mode !== 'ir') {
    await kit.frame().locator('.vditor-toolbar [data-type="edit-mode"]').click()
    await kit.frame().locator(`button[data-mode="${mode}"]`).click()
    await waitForE2EReadiness(
      kit.frame(),
      (state) => state.routerReady && state.mode === mode,
      { timeout: 90_000, message: `${id} ${mode} readiness` },
    )
  }
  await kit.workbox.waitForTimeout(MODE_SETTLE_MS)
}

// One native `k` that reaches the host while disk still holds S0; then the caret after it.
async function seedDirty(kit: Kit, file: string, mode: Mode, id: string) {
  const opened = await hostState(kit, file)
  expect(opened.text, `${id}: opened clean at S0`).toBe(S0[mode])
  expect(opened.dirty).toBe(false)
  expect(await placeCaret(kit, PARAGRAPH, LOCAL_OFFSET), `${id}: caret`).toBe(
    true,
  )
  await kit.xtest.activateAndFocus()
  await xdotool(['key', '--clearmodifiers', 'k'])
  await expect
    .poll(async () => (await hostState(kit, file)).text, {
      timeout: 8000,
      message: `${id}: seed reaches the host`,
    })
    .toBe(splice(S0[mode], 'k'))
  await kit.workbox.waitForTimeout(SEED_QUIET_MS)
  const seeded = await hostState(kit, file)
  expect(seeded.dirty, `${id}: seeded document is dirty`).toBe(true)
  expect(seeded.willSaves, `${id}: no save before the route`).toEqual([])
  expect(readFileSync(file, 'utf8')).toBe(S0[mode])
  expect(
    await placeCaret(kit, PARAGRAPH_SEEDED, LOCAL_OFFSET + 1),
    `${id}: typing caret`,
  ).toBe(true)
  await kit.workbox.waitForTimeout(400)
  await kit.xtest.activateAndFocus()
}

const palette = (kit: Kit) => kit.workbox.evaluate(readPalette, PALETTE_LABEL)

// `x` and the Palette chord in one XTEST process, so the save starts while the typed edit is still
// pending in the webview (WYSIWYG posts it about 1 s later); then "File: Save" and Return.
async function saveFromPalette(kit: Kit, id: string): Promise<number> {
  await xdotool([
    'key',
    '--clearmodifiers',
    '--delay',
    '0',
    'x',
    'ctrl+shift+p',
  ])
  await expect
    .poll(
      async () => {
        const state = await palette(kit)
        return state.visible && state.inputFocused
      },
      { timeout: 3000, message: `${id}: Palette opens` },
    )
    .toBe(true)
  await xdotool([
    'type',
    '--clearmodifiers',
    '--delay',
    '8',
    '--',
    PALETTE_LABEL,
  ])
  // A settled list: the same rows on two reads in a row.
  let previous = ''
  let state = await palette(kit)
  await expect
    .poll(
      async () => {
        state = await palette(kit)
        const key = `${state.value}|${state.rowLabels}|${state.activeIndex}`
        const stable = key === previous
        previous = key
        return (
          stable &&
          state.value === `>${PALETTE_LABEL}` &&
          state.targetIndex !== null &&
          state.activeIndex !== null
        )
      },
      { timeout: 3000, intervals: [60], message: `${id}: Palette list` },
    )
    .toBe(true)
  // In a fresh profile "File: Compare Active File with Saved" sorts above "File: Save" (P8b); a
  // recently used command sorts first. Move by the observed row distance.
  const downs = (state.targetIndex as number) - (state.activeIndex as number)
  expect(downs).toBeGreaterThanOrEqual(0)
  expect(downs).toBeLessThanOrEqual(6)
  if (downs > 0)
    await xdotool([
      'key',
      '--clearmodifiers',
      '--delay',
      '20',
      ...Array<string>(downs).fill('Down'),
    ])
  await expect
    .poll(async () => (await palette(kit)).activeLabel, {
      timeout: 2000,
      message: `${id}: Save row selected`,
    })
    .toBe(PALETTE_LABEL)
  await xdotool(['key', '--clearmodifiers', 'Return'])
  return downs
}

// `x`, then a native click into the plain-text editor 50 ms later (auto-save onFocusChange).
async function saveByFocusChange(kit: Kit, id: string) {
  const point = await kit.workbox.evaluate(textEditorPoint)
  expect(point, `${id}: one text editor at DPR 1`).not.toBeNull()
  const native = await kit.electronApp.browserWindow(kit.workbox)
  const bounds = await native.evaluate((window) => window.getContentBounds())
  const screen = {
    x: bounds.x + (point as { x: number }).x,
    y: bounds.y + (point as { y: number }).y,
  }
  // `mousemove --sync` never returns when the pointer already sits on the target (P8b repair 1):
  // move without --sync, then poll the pointer location. The pointer only hovers until the click.
  const pointerAt = async () =>
    (await xdotool(['getmouselocation'])).startsWith(
      `x:${screen.x} y:${screen.y} `,
    )
  if (!(await pointerAt()))
    await xdotool(['mousemove', String(screen.x), String(screen.y)])
  await expect.poll(pointerAt, { timeout: 2000 }).toBe(true)
  await xdotool([
    'key',
    '--clearmodifiers',
    '--delay',
    '0',
    'x',
    'sleep',
    '0.05',
    'click',
    '1',
  ])
}

// Never saves: auto-save is already off; revert and close the VMDE tab (a dirty failed cell would
// otherwise prompt), then close the clean rest.
const closeCell = (kit: Kit, file: string) =>
  kit.host(
    async (vscode, [fsPath]: [string]) => {
      await vscode.commands.executeCommand('workbench.action.closeQuickOpen')
      const tabs = () =>
        vscode.window.tabGroups.all.flatMap((group) => group.tabs)
      const vmde = tabs().find(
        (tab) =>
          tab.input instanceof vscode.TabInputCustom &&
          tab.input.uri.fsPath === fsPath,
      )
      if (vmde) {
        await vscode.commands.executeCommand(
          'vscode.openWith',
          vscode.Uri.file(fsPath),
          'vmde.editor',
          { viewColumn: vmde.group.viewColumn, preserveFocus: false },
        )
        await vscode.commands.executeCommand(
          'workbench.action.revertAndCloseActiveEditor',
        )
      }
      const rest = tabs()
      if (rest.length && !rest.some((tab) => tab.isDirty))
        await vscode.window.tabGroups.close(rest)
    },
    [file],
  )

async function runCell(
  kit: Kit,
  mode: Mode,
  route: Route,
  autoSaveBefore: string,
): Promise<Record<string, unknown>> {
  const id = `${mode}-${route}`
  const file = path.join(kit.baseDir, `cp2-12-${id}.md`)
  const expected = splice(S0[mode], 'kx')
  writeFileSync(file, S0[mode])
  const result: Record<string, unknown> = { id }
  try {
    await observe(kit, file)
    if (route === 'onFocusChange') {
      const other = path.join(kit.baseDir, `cp2-12-${id}-other.txt`)
      writeFileSync(other, 'other editor\n')
      // Turn auto-save on while every document is clean: VS Code saves dirty documents when the
      // setting changes, which would consume the seed.
      await setAutoSave(kit, 'onFocusChange')
      await kit.host(
        async (vscode, [fsPath]: [string]) => {
          const document = await vscode.workspace.openTextDocument(
            vscode.Uri.file(fsPath),
          )
          await vscode.window.showTextDocument(document, {
            viewColumn: vscode.ViewColumn.Two,
            preview: false,
          })
        },
        [other],
      )
    }
    await openCell(kit, file, mode, id)
    await seedDirty(kit, file, mode, id)
    if (route === 'palette')
      result.paletteDowns = await saveFromPalette(kit, id)
    else if (route === 'onFocusChange') await saveByFocusChange(kit, id)
    else
      await xdotool(['key', '--clearmodifiers', '--delay', '0', 'x', 'ctrl+s'])
    await expect
      .poll(async () => (await hostState(kit, file)).didSaves.length, {
        timeout: 10_000,
        message: `${id}: the route saves`,
      })
      .toBeGreaterThan(0)
    await kit.workbox.waitForTimeout(AFTER_SAVE_MS)
    const saved = await hostState(kit, file)
    Object.assign(result, {
      willSaves: saved.willSaves,
      saves: saved.didSaves.length,
      firstSaveHasTyping: saved.didSaves[0]?.text === expected,
      diskHasTyping: readFileSync(file, 'utf8') === expected,
      hostHasTyping: saved.text === expected,
      cleanAfter: saved.dirty === false,
    })
  } catch (error) {
    result.error = String((error as Error)?.message ?? error)
      .split('\n')[0]
      .slice(0, 300)
  } finally {
    if (route === 'onFocusChange') await setAutoSave(kit, autoSaveBefore)
    await closeCell(kit, file)
  }
  return result
}

async function makeKit(
  workbox: unknown,
  electronApp: ElectronApplication,
  evaluateInVSCode: unknown,
  baseDir: string,
): Promise<Kit> {
  const page = workbox as Page
  const xtest = await createXtestInput(electronApp, page)
  expect(xtest.client.visible).toBe(true)
  const kit: Kit = {
    host: evaluateInVSCode as Host,
    workbox: page,
    electronApp,
    xtest,
    baseDir,
    frame: () =>
      page
        .frameLocator('iframe.webview:visible')
        .frameLocator(`iframe[title="${ProductDisplayName}"], #active-frame`),
  }
  await kit.host(async (vscode) => {
    await vscode.extensions.getExtension('Laicasaane.vmde')?.activate()
    await vscode.workspace
      .getConfiguration('vmde')
      .update('editor.defaultMode', 'ir', true)
  }, [])
  return kit
}

// Task 196 / CP1 P8d — Replace All writes host-exact bytes that Vditor's rendered serialization
// would normalize (about 7 K units on this fixture). A save with the Replace input focused must
// keep them: the will-save flush runs the guarded EditSync.flush(), which posts nothing here.
async function replaceAllThenSave(kit: Kit, mode: Mode) {
  const id = `${mode}-replace-all`
  const file = path.join(kit.baseDir, `cp2-12-${id}.md`)
  writeFileSync(file, FIXTURE)
  const result: Record<string, unknown> = { id }
  try {
    await observe(kit, file)
    await openCell(kit, file, mode, id)
    const widget = kit.frame().locator('.vmde-find-replace')
    const findInput = widget.locator('[data-find]')
    const replaceInput = widget.locator('[data-replace]')
    await kit
      .frame()
      .locator(`.vditor-${mode}`)
      .first()
      .click({ position: { x: 8, y: 8 } })
    await kit.xtest.key('ctrl+h')
    await expect(findInput).toBeFocused()
    // The toggles persist across sessions: derive the expected matches from their live state.
    const caseSensitive =
      (await widget
        .locator('[data-action="case"]')
        .getAttribute('aria-checked')) === 'true'
    const wholeWord =
      (await widget
        .locator('[data-action="word"]')
        .getAttribute('aria-checked')) === 'true'
    const matches = (wholeWord ? wholeWordMatches : literalMatches)(
      FIXTURE,
      CROSS_REGION_TOKEN,
      caseSensitive,
    )
    const afterAll = applyReplacements(FIXTURE, matches, 'ZZZZ')
    await typeInput(findInput, kit.xtest, CROSS_REGION_TOKEN)
    await expect(widget.locator('[data-status]')).toHaveText(
      `1 of ${matches.length}`,
    )
    await typeInput(replaceInput, kit.xtest, 'ZZZZ')
    await kit.xtest.key('ctrl+alt+Return')
    await expect
      .poll(async () => (await hostState(kit, file)).text === afterAll, {
        timeout: 30_000,
      })
      .toBe(true)
    // P8d saved about 1.5 s after Replace All returned, after the Find refresh.
    await kit.workbox.waitForTimeout(1500)
    await expect(replaceInput).toBeFocused()
    await kit.xtest.key('ctrl+s')
    await expect
      .poll(async () => (await hostState(kit, file)).didSaves.length, {
        timeout: 10_000,
      })
      .toBeGreaterThan(0)
    await kit.workbox.waitForTimeout(AFTER_SAVE_MS)
    const saved = await hostState(kit, file)
    Object.assign(result, {
      matches: matches.length,
      saves: saved.didSaves.length,
      firstSaveExact: saved.didSaves[0]?.text === afterAll,
      diskExact: readFileSync(file, 'utf8') === afterAll,
      hostExact: saved.text === afterAll,
      cleanAfter: saved.dirty === false,
    })
  } catch (error) {
    result.error = String((error as Error)?.message ?? error)
      .split('\n')[0]
      .slice(0, 300)
  } finally {
    await closeCell(kit, file)
  }
  return result
}

async function typeInput(input: Locator, xtest: XtestInput, value: string) {
  await input.focus()
  await xtest.key('ctrl+a')
  await xtest.type(value, 20)
  await expect(input).toHaveValue(value)
}

test.describe('Task 580 CP2-12 will-save flush through Palette Save and auto-save', () => {
  test.skip(
    process.env.VMDE_XTEST !== '1',
    'requires isolated Xvfb/Openbox XTEST',
  )

  test('the Save key, Palette Save and onFocusChange auto-save include pending typing in IR, WYSIWYG and SV', async ({
    workbox,
    electronApp,
    evaluateInVSCode,
    baseDir,
  }) => {
    test.setTimeout(600_000)
    const kit = await makeKit(workbox, electronApp, evaluateInVSCode, baseDir)
    const autoSaveBefore = await kit.host(
      (vscode) =>
        vscode.workspace.getConfiguration('files').inspect<string>('autoSave')
          ?.globalValue ?? '',
      [],
    )

    const results: Record<string, unknown>[] = []
    try {
      for (const route of ROUTES)
        for (const mode of MODES)
          results.push(await runCell(kit, mode, route, autoSaveBefore))
    } finally {
      await setAutoSave(kit, autoSaveBefore)
      await kit.host(() => {
        const g = globalThis as any
        for (const sub of g.__cp212Subs ?? []) sub.dispose()
        g.__cp212Subs = []
      }, [])
    }

    console.log(`[cp2-12] ${JSON.stringify(results)}`)
    for (const result of results)
      expect(result, `${result.id}`).toMatchObject({
        saves: 1,
        firstSaveHasTyping: true,
        diskHasTyping: true,
        hostHasTyping: true,
        cleanAfter: true,
      })
  })

  test('Replace All exact bytes survive a native Save from the Replace input in IR, WYSIWYG and SV', async ({
    workbox,
    electronApp,
    evaluateInVSCode,
    baseDir,
  }) => {
    test.setTimeout(600_000)
    const kit = await makeKit(workbox, electronApp, evaluateInVSCode, baseDir)
    const results: Record<string, unknown>[] = []
    for (const mode of MODES) results.push(await replaceAllThenSave(kit, mode))
    console.log(`[cp2-12 replace-all] ${JSON.stringify(results)}`)
    for (const result of results)
      expect(result, `${result.id}`).toMatchObject({
        saves: 1,
        firstSaveExact: true,
        diskExact: true,
        hostExact: true,
        cleanAfter: true,
      })
  })
})
