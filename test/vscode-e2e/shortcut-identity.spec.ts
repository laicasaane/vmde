/**
 * Task 580 Checkpoint 4 (CP4-1) — real-VS-Code acceptance for the VS Code-identity shortcuts.
 *
 * Every key below is OS-level XTEST input into the verified, focused VS Code window (see
 * docs/os-keyboard-testing-setup.md), so each one goes through VS Code's keybinding service exactly
 * as a user's key does. Setup (opening files, placing a caret or a selection, mode switches) uses
 * Playwright and the host API. The kit (window, fixture, spy, leg and report helpers) is shared
 * with the CP4-2 remap spec: helpers/shortcut-xtest-kit.ts.
 *
 * - The large synthetic fixture, copied into `baseDir`, carries the routing, formatting, undo, fold,
 *   selection and save legs in IR, WYSIWYG and SV. Any trusted edit on it makes the host hold
 *   Vditor's rendered serialization of the whole file (CP1 P8c), so an action's own effect is
 *   checked at its location and exactness is checked where the contract promises it: one native
 *   Undo, Replace One/All (Task 196) and the bytes on disk after Save.
 * - A small exact-round-trip fixture (Owner Q5) carries the exact-source legs and the callout and
 *   task-list former keys.
 *
 * Every leg records its observations and failure instead of stopping the test, so one run returns
 * the whole picture; each test then asserts that every leg passed. Document comparisons are
 * booleans so fixture text stays out of failure output.
 */
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import type { Locator } from '@playwright/test'
import { expect, test } from 'vscode-test-playwright'
import {
  applyReplacements,
  FIXTURE as LARGE,
  PAIR_TOKEN,
  wholeWordMatches,
} from './find-replace-fixture-helpers'
import {
  AFTER_SAVE_MS,
  actionsSince,
  type Ctx,
  closeAll,
  difference,
  disposeObservers,
  endSelectionGesture,
  evalFrame,
  exactHost,
  expectHost,
  expectHostIncludes,
  expectInert,
  expectRestored,
  firstLine,
  folds,
  hostState,
  hostText,
  type Kit,
  leg,
  MODES,
  makeKit,
  nativeFormatting,
  openDocument,
  QUIET_MS,
  rangeDetailInPage,
  report,
  SMALL,
  select,
  selection,
  sidebarVisible,
  spyMark,
  switchMode,
  UNDO_LOCK_MS,
  userKeybindingsPath,
  words,
} from './helpers/shortcut-xtest-kit'

// Large-fixture tokens. Each occurs once (the expand token once case-sensitively) in plain prose,
// a list item, a heading, a table cell or a link text; see the fixture.
const BOLD_WORD = 'ldzwcwrn'
const ITALIC_WORD = 'jrkjllwkkijy'
const UNDERLINE_WORD = 'cwldffwrbk'
const LIST_TOKEN = 'MtkltyLtkw mdksnsdrty'
const EXPAND_TOKEN = 'Tllwmntrlw'
const EXPAND_INLINE = 'Tllwmntrlw wgsbwrlw.'
const FOLD_HEADING = 'Cwldffwrbwb'
const TABLE_CELL = 'Kntnjk'
const LINK_TEXT = 'ldfesrwb'
const SAVE_WORD = 'kwnnywb'

const runFile = promisify(execFile)

// Several keys in one xdotool process with no delay: the second key starts while the first one's
// edit is still pending in the webview (the save-flush gesture).
async function keySequence(kit: Kit, keys: string[]) {
  await kit.xtest.activateAndFocus()
  await runFile(
    '/usr/bin/xdotool',
    ['key', '--clearmodifiers', '--delay', '0', ...keys],
    { encoding: 'utf8', timeout: 5000 },
  )
}

// ---------------------------------------------------------------------------------------------
// Large-fixture legs.

const lineWith = (text: string | null, needle: string) =>
  (text ?? '').split('\n').find((line) => line.includes(needle)) ?? ''
const indentOf = (line: string) => line.length - line.trimStart().length

async function formatLeg(
  ctx: Ctx,
  key: string,
  word: string,
  marker: string,
  toolbarName: string,
  redo: boolean,
) {
  const { kit } = ctx
  await select(ctx, word)
  await endSelectionGesture(ctx)
  const mark = await spyMark(kit)
  await kit.xtest.key(key)
  const formatted = `${marker}${word}${marker}`
  await expectHostIncludes(ctx, formatted, `${key} formats`)
  await kit.workbox.waitForTimeout(400) // negative window: a second (duplicate) action
  const text = (await hostText(ctx)) ?? ''
  expect(text.split(word).length - 1, `${key}: the word once`).toBe(1)
  if (marker === '*')
    expect(text.includes(`**${word}**`), `${key}: italic, not bold`).toBe(false)
  expect(await actionsSince(kit, mark)).toEqual([
    { command: 'trigger-toolbar-hotkey', detail: toolbarName },
  ])
  // Vditor's WYSIWYG Bold/Italic itself runs execCommand, so a <b>/<i> here can be its own. The
  // native default running as well shows as doubled markers (Task 505: `Hello ****world.`).
  expect(
    text.includes(`*${formatted}`) || text.includes(`${formatted}*`),
    `${key}: no doubled markers`,
  ).toBe(false)
  const exact = text === ctx.initial.replace(word, formatted)
  await kit.workbox.waitForTimeout(UNDO_LOCK_MS)
  await kit.xtest.key('ctrl+z')
  await expectRestored(ctx, `${key}: one Undo restores the source`)
  if (!redo) return { exactFormattedSource: exact }
  for (const redoKey of ['ctrl+y', 'ctrl+shift+z']) {
    await kit.xtest.key(redoKey)
    await expectHostIncludes(ctx, formatted, `${redoKey} redoes ${key}`)
    await kit.workbox.waitForTimeout(UNDO_LOCK_MS)
    await kit.xtest.key('ctrl+z')
    await expectRestored(ctx, `Undo after ${redoKey}`)
  }
  return { exactFormattedSource: exact, redo: ['ctrl+y', 'ctrl+shift+z'] }
}

async function indentLeg(ctx: Ctx) {
  const { kit } = ctx
  await select(ctx, LIST_TOKEN, { collapsed: true, offset: 3 })
  await endSelectionGesture(ctx)
  if (ctx.mode === 'sv') {
    // Vditor's Indent/Outdent act on list items in IR and WYSIWYG only.
    const mark = await spyMark(kit)
    await expectInertEdit(ctx, 'ctrl+bracketright')
    await expectInertEdit(ctx, 'ctrl+bracketleft')
    expect(
      (await actionsSince(kit, mark)).map((message) => message.detail),
    ).toEqual(['indent', 'outdent'])
    return { sv: 'no-op' }
  }
  await kit.xtest.key('ctrl+bracketright')
  await expect
    .poll(async () => indentOf(lineWith(await hostText(ctx), LIST_TOKEN)), {
      message: 'Ctrl+] nests the item',
    })
    .toBeGreaterThan(0)
  await kit.workbox.waitForTimeout(UNDO_LOCK_MS)
  await select(ctx, LIST_TOKEN, { collapsed: true, offset: 3 })
  await kit.xtest.key('ctrl+bracketleft')
  await expect
    .poll(async () => indentOf(lineWith(await hostText(ctx), LIST_TOKEN)), {
      message: 'Ctrl+[ lifts the item back',
    })
    .toBe(0)
  await kit.workbox.waitForTimeout(UNDO_LOCK_MS)
  const outdentedExact = (await hostText(ctx)) === ctx.initial
  await kit.xtest.key('ctrl+z')
  await expect
    .poll(async () => indentOf(lineWith(await hostText(ctx), LIST_TOKEN)), {
      message: 'Undo of Outdent nests the item again',
    })
    .toBeGreaterThan(0)
  await kit.workbox.waitForTimeout(UNDO_LOCK_MS)
  await kit.xtest.key('ctrl+z')
  await expectRestored(ctx, 'Undo of Indent restores the source')
  return { outdentedExact }
}

// A key that reaches its VMDE command but has nothing to act on in this mode. Where `exactHost`
// does not hold (SV on the large fixture), the command still makes the host take the SV
// normalization, as it did on 8c2ec1f0; the content must stay the same.
async function expectInertEdit(ctx: Ctx, key: string) {
  const dirtyBefore = (await hostState(ctx)).dirty
  await ctx.kit.xtest.key(key)
  await ctx.kit.workbox.waitForTimeout(QUIET_MS) // negative-observation window
  const state = await hostState(ctx)
  if (!exactHost(ctx)) {
    expect(words(state.text) === words(ctx.initial), `${key}: same words`).toBe(
      true,
    )
    return
  }
  expect(state.text === ctx.initial, `${key}: document unchanged`).toBe(true)
  expect(state.dirty, `${key}: dirty flag unchanged`).toBe(dirtyBefore)
}

async function expandLeg(ctx: Ctx) {
  const { kit } = ctx
  await select(ctx, EXPAND_TOKEN, { collapsed: true, offset: 3 })
  await endSelectionGesture(ctx)
  if (ctx.mode !== 'ir') {
    // Expand Selection has no scopes outside IR.
    await kit.xtest.key('shift+alt+Right')
    await kit.workbox.waitForTimeout(500) // negative-observation window
    expect((await selection(ctx)).collapsed).toBe(true)
    expect((await hostText(ctx)) === ctx.initial).toBe(true)
    return { scopes: 'none' }
  }
  await kit.xtest.key('shift+alt+Right')
  await expect
    .poll(async () => (await selection(ctx)).head, {
      message: 'first Expand selects the bold span',
    })
    .toBe(EXPAND_INLINE)
  // Task 620: from the first keys after opening, Vditor's keydown leaves empty text nodes in the
  // inline node. The ladder compares ranges by the characters they cover (selection-scope.ts
  // rangesEqual), so each further press routes once and widens: block, then document.
  const mark = await spyMark(kit)
  const stages: string[] = []
  for (let press = 1; press <= 2; press++) {
    await kit.xtest.key('shift+alt+Right')
    await expect
      .poll(async () => (await actionsSince(kit, mark)).length)
      .toBe(press)
    await kit.workbox.waitForTimeout(300) // the runner's selection lands after its message
    const current = await selection(ctx)
    expect(current.collapsed, `press ${press + 1} keeps a selection`).toBe(
      false,
    )
    expect(current.inSurface).toBe(true)
    expect(current.whole || current.head.includes(EXPAND_INLINE)).toBe(true)
    stages.push(
      current.whole
        ? 'document'
        : current.length > EXPAND_INLINE.length + 50
          ? 'block'
          : 'inline',
    )
  }
  expect(
    (await actionsSince(kit, mark)).map((message) => message.detail),
  ).toEqual(['expand-selection', 'expand-selection'])
  expect((await hostText(ctx)) === ctx.initial).toBe(true)
  // The range detail explains a ladder that stayed on the inline stage.
  const range =
    stages[0] === 'inline' ? await evalFrame(kit, rangeDetailInPage, 0) : null
  expect(
    stages,
    `Expand widens past the inline stage ${JSON.stringify(range)}`,
  ).toEqual(['block', 'document'])
  return { stagesAfterInline: stages }
}

// Delete on a whole-document selection must leave the empty document in the host. Pre-existing
// (also on 8c2ec1f0): in IR on the large fixture the last blocks survive the Delete, so there the
// host must hold only a short suffix of the source.
async function deleteWholeDocument(ctx: Ctx): Promise<string> {
  const tailMaySurvive = ctx.large && ctx.mode === 'ir'
  // Pre-existing (measured on 8c2ec1f0 and on this build alike): SV spends about 25 s on deleting
  // the whole large fixture, its webview blocked meanwhile, before the host is updated.
  const timeout = ctx.large && ctx.mode === 'sv' ? 90_000 : 30_000
  await ctx.kit.xtest.key('Delete')
  let emptied: string | null = null
  try {
    await expect
      .poll(
        async () => {
          emptied = await hostText(ctx)
          if (emptied === '' || emptied === '\n') return true
          return (
            tailMaySurvive &&
            emptied !== null &&
            emptied.length < ctx.initial.length / 20 &&
            words(ctx.initial).endsWith(words(emptied))
          )
        },
        { timeout, message: 'Delete replaces the whole document' },
      )
      .toBe(true)
  } catch (error) {
    // Evidence for the CP2-6 open item: what the Delete left, in the host and in the surface.
    const left: string = emptied ?? ''
    const surface = await evalFrame(
      ctx.kit,
      () => {
        const inner = (window as any).vditor.vditor
        const root = inner[inner.currentMode].element as HTMLElement
        return {
          children: root.childNodes.length,
          textLength: (root.textContent ?? '').length,
          head: (root.textContent ?? '').slice(0, 80),
        }
      },
      0,
    )
    throw new Error(
      `${firstLine(error)} | left ${JSON.stringify({
        length: left.length,
        head: left.slice(0, 80),
        tail: left.slice(-80),
        headOffsetInSource: ctx.initial.indexOf(left.slice(0, 40)),
        tailIsSourceSuffix: ctx.initial.endsWith(left.slice(-200)),
        surface,
      })}`,
    )
  }
  return JSON.stringify((emptied as string | null)?.slice(0, 40) ?? null)
}

async function selectAllDeleteLeg(ctx: Ctx) {
  const { kit } = ctx
  await select(ctx, BOLD_WORD, { collapsed: true, offset: 2 })
  await endSelectionGesture(ctx)
  await kit.xtest.key('ctrl+a')
  if (ctx.mode === 'ir') {
    // IR's ladder: the Markdown block first, then the document.
    await expect
      .poll(async () => {
        const current = await selection(ctx)
        return current.length > 0 && !current.whole
      })
      .toBe(true)
    await kit.xtest.key('ctrl+a')
  }
  await expect.poll(async () => (await selection(ctx)).whole).toBe(true)
  expect((await hostText(ctx)) === ctx.initial).toBe(true)
  const emptied = await deleteWholeDocument(ctx)
  await kit.workbox.waitForTimeout(UNDO_LOCK_MS)
  await kit.xtest.key('ctrl+z')
  await expectRestored(
    ctx,
    'one Undo restores the whole document',
    ctx.mode === 'sv' ? 90_000 : 30_000,
  )
  return { emptied }
}

// Whether the block handle layer shows a handle for the paragraph holding `token`.
async function blockHandleOnHover(ctx: Ctx, token: string) {
  await ctx.kit
    .frame()
    .locator(`.vditor-${ctx.mode} .vditor-reset > p`)
    .filter({ hasText: token })
    .hover()
  await ctx.kit.workbox.waitForTimeout(500)
  return ctx.kit
    .frame()
    .locator('.vmde-block-handle')
    .evaluate((element: HTMLElement) => !element.hidden)
}

// Move Block acts through the block handle layer's exact host transaction. The layer resolves the
// units of a whole document or of none (block-handle.ts resolveBlockHandleUnits): on this fixture,
// whose rendered Markdown differs from its source, it shows no handle (a limit that predates Task
// 580; see the Task 604 record), so each key must reach its command exactly once and leave the
// document untouched. The exact move runs on the small fixture.
async function moveLeg(ctx: Ctx) {
  const { kit } = ctx
  const handleOnHover =
    ctx.mode === 'sv' ? 'no layer' : await blockHandleOnHover(ctx, BOLD_WORD)
  const routed: (string | null)[] = []
  for (const key of ['alt+Down', 'alt+Up']) {
    await select(ctx, BOLD_WORD, { collapsed: true, offset: 2 })
    await endSelectionGesture(ctx)
    const mark = await spyMark(kit)
    await expectInertEdit(ctx, key)
    routed.push(...(await actionsSince(kit, mark)).map((m) => m.detail))
  }
  expect(routed).toEqual(['move-block-down', 'move-block-up'])
  return { handleOnHover }
}

async function foldLeg(ctx: Ctx) {
  const { kit } = ctx
  await select(ctx, FOLD_HEADING, { collapsed: true, offset: 3 })
  await endSelectionGesture(ctx)
  if (ctx.mode === 'sv') {
    await kit.xtest.key('ctrl+shift+bracketleft')
    await kit.workbox.waitForTimeout(QUIET_MS) // negative-observation window
    expect(await folds(ctx)).toEqual({ folded: [], lists: 0 })
    expect((await hostText(ctx)) === ctx.initial).toBe(true)
    return { sv: 'no folds' }
  }
  const folded = async () => (await folds(ctx)).folded
  const isFolded = async () => {
    const current = await folded()
    return current.length === 1 && current[0].includes(FOLD_HEADING)
  }
  await kit.xtest.key('ctrl+shift+bracketleft')
  await expect.poll(isFolded, { message: 'Fold' }).toBe(true)
  await kit.xtest.key('ctrl+shift+bracketleft')
  await kit.workbox.waitForTimeout(400) // negative window: Fold acts one way only
  expect(await isFolded()).toBe(true)
  await kit.xtest.key('ctrl+shift+bracketright')
  await expect.poll(folded, { message: 'Unfold' }).toEqual([])
  await kit.xtest.key('ctrl+shift+bracketright')
  await kit.workbox.waitForTimeout(400) // negative window: Unfold acts one way only
  expect(await folded()).toEqual([])
  await kit.xtest.key('ctrl+k')
  await kit.xtest.key('ctrl+l')
  await expect.poll(isFolded, { message: 'Toggle Fold folds' }).toBe(true)
  await kit.xtest.key('ctrl+k')
  await kit.xtest.key('ctrl+l')
  await expect.poll(folded, { message: 'Toggle Fold unfolds' }).toEqual([])
  const state = await hostState(ctx)
  expect(state.text === ctx.initial).toBe(true)
  expect(state.dirty).toBe(false)
  return undefined
}

async function typeInto(ctx: Ctx, input: Locator, value: string) {
  await expect(input).toBeFocused()
  await ctx.kit.xtest.key('ctrl+a')
  await ctx.kit.xtest.type(value, 20)
  await expect(input).toHaveValue(value)
}

// A replacement keeps exact bytes (Task 196) as the first edit of a freshly opened small document,
// in every mode. After an earlier edit in the same session the host can take the rendered
// normalization instead (Task 607, also on 8c2ec1f0; seen in every mode), so there, and on the
// large fixture, where the Find leg follows other legs, it is checked word for word.
async function expectReplaced(
  ctx: Ctx,
  expected: string,
  label: string,
  afterEarlierEdit: boolean,
) {
  if (!ctx.large && !afterEarlierEdit)
    return expectHost(ctx, expected, `${label} is exact`)
  const target = words(expected)
  await expect
    .poll(async () => words(await hostText(ctx)) === target, {
      message: `${label} replaces (same words)`,
    })
    .toBe(true)
}

async function findLeg(ctx: Ctx, token: string) {
  const { kit } = ctx
  const frame = kit.frame()
  const widget = frame.locator('.vmde-find-replace')
  const findInput = widget.locator('[data-find]')
  const replaceInput = widget.locator('[data-replace]')
  const replaceRow = widget.locator('#vmde-find-replace-row')
  const status = widget.locator('[data-status]')
  const toggles = {
    'alt+c': widget.locator('[data-action="case"]'),
    'alt+w': widget.locator('[data-action="word"]'),
  }
  const matches = wholeWordMatches(ctx.initial, token, true)
  expect(matches.length).toBe(2)
  await select(ctx, token, { collapsed: true, offset: 1 })
  await endSelectionGesture(ctx)
  const mark = await spyMark(kit)

  await kit.xtest.key('ctrl+f')
  await expect(widget).toBeVisible({ timeout: 10_000 })
  await expect(replaceRow).toBeHidden()
  await typeInto(ctx, findInput, token)
  // The toggles persist across sessions: turn both on, and restore them at the end.
  const initialToggles: Record<string, string | null> = {}
  for (const [key, button] of Object.entries(toggles)) {
    initialToggles[key] = await button.getAttribute('aria-checked')
    await kit.xtest.key(key)
    await expect(button).toHaveAttribute(
      'aria-checked',
      initialToggles[key] === 'true' ? 'false' : 'true',
    )
    if (initialToggles[key] === 'true') {
      await kit.xtest.key(key)
      await expect(button).toHaveAttribute('aria-checked', 'true')
    }
    await expect(findInput).toBeFocused()
  }
  await expect(status).toHaveText(`1 of ${matches.length}`)
  await kit.xtest.key('F3')
  await expect(status).toHaveText(`2 of ${matches.length}`)
  await kit.xtest.key('shift+F3')
  await expect(status).toHaveText(`1 of ${matches.length}`)

  await kit.xtest.key('ctrl+h')
  await expect(replaceRow).toBeVisible()
  await expect(replaceInput).toBeFocused()
  await typeInto(ctx, replaceInput, 'QQ')
  await kit.xtest.key('ctrl+shift+1')
  const afterOne = applyReplacements(ctx.initial, matches.slice(0, 1), 'QQ')
  await expectReplaced(ctx, afterOne, 'Replace One', false)
  await kit.xtest.key('Escape')
  await expect(widget).toBeHidden()
  await kit.workbox.waitForTimeout(UNDO_LOCK_MS)
  await kit.xtest.key('ctrl+z')
  await expectReplaced(ctx, ctx.initial, 'one Undo restores Replace One', false)

  await kit.xtest.key('ctrl+h')
  await expect(widget).toBeVisible()
  await expect(findInput).toBeFocused()
  await expect(findInput).toHaveValue(token)
  await expect(replaceInput).toHaveValue('QQ')
  await kit.xtest.key('ctrl+alt+Return')
  await expectReplaced(
    ctx,
    applyReplacements(ctx.initial, matches, 'QQ'),
    'Replace All',
    true,
  )
  await kit.xtest.key('Escape')
  await expect(widget).toBeHidden()
  await kit.workbox.waitForTimeout(UNDO_LOCK_MS)
  await kit.xtest.key('ctrl+z')
  await expectReplaced(ctx, ctx.initial, 'one Undo restores Replace All', true)

  await kit.xtest.key('ctrl+f')
  await expect(widget).toBeVisible()
  await kit.xtest.key('shift+Escape')
  await expect(widget).toBeHidden()
  // Restore the persisted toggles.
  await kit.xtest.key('ctrl+f')
  await expect(findInput).toBeFocused()
  for (const [key, button] of Object.entries(toggles))
    if (initialToggles[key] !== 'true') {
      await kit.xtest.key(key)
      await expect(button).toHaveAttribute('aria-checked', 'false')
    }
  await kit.xtest.key('Escape')
  await expect(widget).toBeHidden()
  const routed = (await actionsSince(kit, mark)).map(
    (message) => `${message.command}:${message.detail}`,
  )
  for (const expected of [
    'open-find-replace:find',
    'find-widget-action:toggle-case',
    'find-widget-action:toggle-whole-word',
    'find-widget-action:next',
    'find-widget-action:previous',
    'open-find-replace:replace',
    'find-widget-action:replace-one',
    'find-widget-action:replace-all',
  ])
    expect(routed, `Find route ${expected}`).toContain(expected)
  return {
    routed: [...new Set(routed)],
    // Task 607 (see expectReplaced): after Replace All the host may keep the rendered
    // normalization.
    mayNormalize: true,
  }
}

async function formerKeysLeg(ctx: Ctx) {
  const { kit } = ctx
  // Ctrl+Shift+V: VS Code has no binding here and the old VMDE binding is gone. An empty clipboard
  // keeps the browser's own paste-and-match-style from inserting anything, so any change would be
  // a VMDE action.
  await kit.host(async (vscode) => {
    await vscode.env.clipboard.writeText('')
  }, [])
  const otherModeKey = ctx.mode === 'ir' ? 'ctrl+alt+7' : 'ctrl+alt+8'
  const cases: [
    string,
    string,
    { quickInput?: boolean; strictHost?: boolean },
  ][] = [
    // Ctrl+Enter on and off a link, first and with exact host bytes in every mode: the former
    // activation chord, and Enter with a modifier no longer takes the editing-Enter undo boundary
    // that rewrote the host with the rendered normalization (CP4-1 fix in undo-boundaries.ts).
    ['ctrl+Return', LINK_TEXT, { strictHost: true }],
    ['ctrl+Return', BOLD_WORD, { strictHost: true }],
    ['ctrl+d', UNDERLINE_WORD, {}],
    ['ctrl+u', UNDERLINE_WORD, {}],
    ['alt+q', BOLD_WORD, {}],
    ['ctrl+shift+v', BOLD_WORD, {}],
    ['ctrl+alt+e', BOLD_WORD, {}],
    ['ctrl+alt+bracketleft', FOLD_HEADING, {}],
    ['ctrl+shift+l', TABLE_CELL, {}],
    ['ctrl+alt+5', BOLD_WORD, {}],
    [otherModeKey, BOLD_WORD, {}],
    ['ctrl+g', BOLD_WORD, { quickInput: true }],
    ['ctrl+e', BOLD_WORD, { quickInput: true }],
  ]
  const passed: string[] = []
  for (const [key, token, options] of cases) {
    await select(ctx, token, {
      collapsed: key !== 'ctrl+d' && key !== 'ctrl+u',
      offset: 2,
    })
    await endSelectionGesture(ctx)
    await expectInert(ctx, key, options)
    passed.push(key)
  }
  return { inert: passed }
}

async function saveLeg(ctx: Ctx) {
  const { kit } = ctx
  const savesBefore = (await hostState(ctx)).didSaves.length
  // Task 434 (as noop-check-on-save.spec.ts): type, Undo back to the opened source and, once the
  // Undo reached the host as Vditor's rendered text, save at once, inside the 1200 ms idle window
  // of the deferred no-op check: the will-save check must write the exact source.
  await select(ctx, SAVE_WORD, { collapsed: true })
  await endSelectionGesture(ctx)
  await kit.xtest.key('q')
  await expectHostIncludes(ctx, `${SAVE_WORD}q`, 'typing reaches the host')
  await kit.workbox.waitForTimeout(UNDO_LOCK_MS)
  await kit.xtest.key('ctrl+z')
  await expect
    .poll(
      async () => !((await hostText(ctx)) ?? '').includes(`${SAVE_WORD}q`),
      { message: 'the Undo reaches the host' },
    )
    .toBe(true)
  await kit.xtest.key('ctrl+s')
  await expect
    .poll(async () => (await hostState(ctx)).didSaves.length, {
      timeout: 15_000,
      message: 'Undo then Save saves',
    })
    .toBe(savesBefore + 1)
  await kit.workbox.waitForTimeout(AFTER_SAVE_MS)
  let state = await hostState(ctx)
  const disk = readFileSync(ctx.file, 'utf8')
  // Where `exactHost` does not hold (SV on the large fixture), the saved bytes are the SV
  // normalization (also on 8c2ec1f0): the same words, written once and consistently.
  const same = exactHost(ctx)
    ? (text: string | null | undefined) => text === ctx.initial
    : (text: string | null | undefined) =>
        words(text ?? null) === words(ctx.initial)
  const undoneSave = {
    firstSaveRestored: same(state.didSaves[savesBefore]),
    diskRestored: same(disk),
    hostRestored: same(state.text),
    diskEqualsSave: disk === state.didSaves[savesBefore],
    clean: state.dirty === false,
    saves: state.didSaves.length - savesBefore,
  }
  expect(
    undoneSave,
    `Undo then Save writes the opened source ${JSON.stringify(undoneSave)}`,
  ).toEqual({
    firstSaveRestored: true,
    diskRestored: true,
    hostRestored: true,
    diskEqualsSave: true,
    clean: true,
    saves: 1,
  })

  // CP2-12: type, then Save at once; the will-save flush writes the pending typing.
  await select(ctx, SAVE_WORD, { collapsed: true })
  await endSelectionGesture(ctx)
  await keySequence(kit, ['q', 'ctrl+s'])
  await expect
    .poll(async () => (await hostState(ctx)).didSaves.length, {
      timeout: 15_000,
      message: 'typing then Save saves',
    })
    .toBe(savesBefore + 2)
  await kit.workbox.waitForTimeout(AFTER_SAVE_MS)
  state = await hostState(ctx)
  const saved = state.didSaves[savesBefore + 1] ?? ''
  const typedSave = {
    saveHasTyping: saved.includes(`${SAVE_WORD}q`),
    diskEqualsSave: readFileSync(ctx.file, 'utf8') === saved,
    hostEqualsSave: state.text === saved,
    clean: state.dirty === false,
    saves: state.didSaves.length - savesBefore,
  }
  expect(
    typedSave,
    `typing then Save writes the typing ${JSON.stringify(typedSave)}`,
  ).toEqual({
    saveHasTyping: true,
    diskEqualsSave: true,
    hostEqualsSave: true,
    clean: true,
    saves: 2,
  })
  return {
    leavesEdit: true,
    willSaves: state.willSaves,
    typedSaveExactSource:
      saved === ctx.initial.replace(SAVE_WORD, `${SAVE_WORD}q`),
  }
}

async function largeModeLegs(ctx: Ctx) {
  await leg(ctx, 'bold-undo-redo', () =>
    formatLeg(ctx, 'ctrl+b', BOLD_WORD, '**', 'bold', true),
  )
  await leg(ctx, 'italic', () =>
    formatLeg(ctx, 'ctrl+i', ITALIC_WORD, '*', 'italic', false),
  )
  await leg(ctx, 'indent-outdent', () => indentLeg(ctx))
  await leg(ctx, 'expand-selection', () => expandLeg(ctx))
  await leg(ctx, 'select-all-delete', () => selectAllDeleteLeg(ctx))
  await leg(ctx, 'move-block', () => moveLeg(ctx))
  await leg(ctx, 'fold', () => foldLeg(ctx))
  await leg(ctx, 'find-family', () => findLeg(ctx, PAIR_TOKEN))
  await leg(ctx, 'former-keys', () => formerKeysLeg(ctx))
  await leg(ctx, 'save', () => saveLeg(ctx))
}

// ---------------------------------------------------------------------------------------------
// Small exact-round-trip fixture legs.

async function exactAction(
  ctx: Ctx,
  key: string,
  token: string,
  collapsed: boolean,
  expected: string,
) {
  await select(ctx, token, { collapsed, offset: 2 })
  await endSelectionGesture(ctx)
  await ctx.kit.xtest.key(key)
  await expectHost(ctx, expected, `${key} on ${token} is exact`)
  await ctx.kit.workbox.waitForTimeout(UNDO_LOCK_MS)
  await ctx.kit.xtest.key('ctrl+z')
  await expectHost(ctx, ctx.initial, `${key}: one Undo restores exact source`)
}

async function smallModeLegs(ctx: Ctx) {
  const S = ctx.initial
  // Order, for two limits that predate Task 580 (measured on 8c2ec1f0): Move Block runs first on
  // the fresh document, because after an earlier edit and its Undo the block action client
  // answers `stale`; Italic runs before Bold, because WYSIWYG's first Bold after the mode switch
  // on this document does nothing, from the key or from a toolbar click alike.
  if (ctx.mode !== 'sv')
    await leg(ctx, 'exact-move', async () => {
      await exactAction(
        ctx,
        'alt+Down',
        'moveword',
        true,
        S.replace(
          'moveword paragraph\n\nafter paragraph',
          'after paragraph\n\nmoveword paragraph',
        ),
      )
      return undefined
    })
  await leg(ctx, 'exact-italic', async () => {
    await exactAction(
      ctx,
      'ctrl+i',
      'italicword',
      false,
      S.replace('italicword', '*italicword*'),
    )
    return undefined
  })
  await leg(ctx, 'exact-bold', async () => {
    await exactAction(
      ctx,
      'ctrl+b',
      'boldword',
      false,
      S.replace('boldword', '**boldword**'),
    )
    return undefined
  })
  if (ctx.mode !== 'sv') {
    await leg(ctx, 'exact-indent', async () => {
      await exactAction(
        ctx,
        'ctrl+bracketright',
        'child item',
        true,
        S.replace('- child item', '  - child item'),
      )
      return undefined
    })
  }
  await leg(ctx, 'exact-select-all-delete', async () => {
    await select(ctx, 'boldword', { collapsed: true, offset: 2 })
    await endSelectionGesture(ctx)
    await ctx.kit.xtest.key('ctrl+a')
    if (ctx.mode === 'ir') await ctx.kit.xtest.key('ctrl+a')
    await expect.poll(async () => (await selection(ctx)).whole).toBe(true)
    const emptied = await deleteWholeDocument(ctx)
    await ctx.kit.workbox.waitForTimeout(UNDO_LOCK_MS)
    await ctx.kit.xtest.key('ctrl+z')
    await expectHost(ctx, ctx.initial, 'one Undo restores the whole document')
    return { emptied }
  })
  // Former keys on the callout (link/callout activation) and the task item (Toggle Task Checkbox).
  await leg(ctx, 'former-callout-task', async () => {
    await ctx.kit.host(async (vscode) => {
      await vscode.env.clipboard.writeText('')
    }, [])
    const cases: [string, string][] = [
      ['ctrl+shift+j', 'taskword'],
      ['ctrl+shift+l', 'cellword'],
      ['ctrl+alt+5', 'moveword'],
    ]
    // The callout popover that Ctrl+Enter used to focus exists only in WYSIWYG
    // (callout-popover-keys.ts); IR's callout text is not an editable text node for this helper.
    if (ctx.mode !== 'ir') cases.unshift(['ctrl+Return', 'calloutword'])
    for (const [key, token] of cases) {
      await select(ctx, token, { collapsed: true, offset: 2 })
      await endSelectionGesture(ctx)
      await expectInert(ctx, key)
    }
    return undefined
  })
  await leg(ctx, 'exact-save', async () => {
    const expected = S.replace('italicword', '*italicword*')
    await select(ctx, 'italicword')
    await endSelectionGesture(ctx)
    await ctx.kit.xtest.key('ctrl+i')
    await expectHost(ctx, expected, 'Italic before Save')
    await ctx.kit.xtest.key('ctrl+s')
    await expect
      .poll(() => readFileSync(ctx.file, 'utf8') === expected, {
        message: 'disk holds the exact italic source',
      })
      .toBe(true)
    await ctx.kit.workbox.waitForTimeout(AFTER_SAVE_MS)
    const state = await hostState(ctx)
    expect(state.dirty).toBe(false)
    expect(readFileSync(ctx.file, 'utf8') === expected).toBe(true)
    await ctx.kit.xtest.key('ctrl+z')
    await expectHost(ctx, ctx.initial, 'Undo after Save restores exact source')
    // Settled: a late post (WYSIWYG's debounce, Task 434's deferred check) must keep it exact.
    await ctx.kit.workbox.waitForTimeout(AFTER_SAVE_MS)
    await expectHost(ctx, ctx.initial, 'the Undo stays exact once settled')
    await ctx.kit.xtest.key('ctrl+s')
    await expect
      .poll(() => readFileSync(ctx.file, 'utf8') === ctx.initial, {
        message: 'disk holds the exact source again',
      })
      .toBe(true)
    return undefined
  })
}

test.describe('Task 580 CP4-1 VS Code-identity shortcuts (OS-level XTEST)', () => {
  test.skip(
    process.env.VMDE_XTEST !== '1',
    'requires isolated Xvfb/Openbox XTEST',
  )

  for (const mode of MODES)
    test(`large fixture, ${mode}: every default key acts once, former keys are inert, Undo, Find and Save stay exact`, async ({
      workbox,
      electronApp,
      evaluateInVSCode,
      baseDir,
    }) => {
      test.setTimeout(900_000)
      const kit = await makeKit(workbox, electronApp, evaluateInVSCode, baseDir)
      const ctx = await openDocument(
        kit,
        `shortcut-identity-${mode}.md`,
        LARGE,
        mode,
      )
      try {
        await largeModeLegs(ctx)
      } finally {
        await disposeObservers(kit)
        await closeAll(kit, ctx.file)
      }
      report(`large ${mode}`, ctx.results)
    })

  test('small fixture: exact source, callout and task-list former keys, exact disk bytes, in IR, WYSIWYG and SV', async ({
    workbox,
    electronApp,
    evaluateInVSCode,
    baseDir,
  }) => {
    test.setTimeout(600_000)
    const kit = await makeKit(workbox, electronApp, evaluateInVSCode, baseDir)
    const results: Record<string, unknown>[] = []
    try {
      for (const mode of MODES) {
        const ctx = await openDocument(
          kit,
          `shortcut-identity-exact-${mode}.md`,
          SMALL,
          mode,
        )
        try {
          await smallModeLegs(ctx)
        } finally {
          results.push(...ctx.results)
          await closeAll(kit, ctx.file)
        }
        // Find Replace One/All on a freshly opened document of its own: after earlier edits the
        // host can take the rendered normalization (Task 607, also on 8c2ec1f0).
        const find = await openDocument(
          kit,
          `shortcut-identity-exact-find-${mode}.md`,
          SMALL,
          mode,
        )
        try {
          await leg(find, 'exact-find-replace', () => findLeg(find, 'omega'))
        } finally {
          results.push(...find.results)
          await closeAll(kit, find.file)
        }
      }
    } finally {
      await disposeObservers(kit)
    }
    report('small', results)
  })

  test('Ctrl+B/I/U never format natively, also with the Bold binding removed by a user keybinding', async ({
    workbox,
    electronApp,
    evaluateInVSCode,
    baseDir,
  }) => {
    test.setTimeout(600_000)
    const kit = await makeKit(workbox, electronApp, evaluateInVSCode, baseDir)
    const keybindings = await userKeybindingsPath(kit)
    const previous = existsSync(keybindings)
      ? readFileSync(keybindings, 'utf8')
      : null
    mkdirSync(path.dirname(keybindings), { recursive: true })
    writeFileSync(
      keybindings,
      JSON.stringify(
        [{ key: 'ctrl+b', command: '-vmde.format.bold' }],
        null,
        2,
      ),
    )
    const results: Record<string, unknown>[] = []
    const contexts: Ctx[] = []
    try {
      // IR and WYSIWYG on the large fixture; SV on the small one, because on the large fixture the
      // side bar toggle makes SV post its normalization (also on 8c2ec1f0).
      const large = await openDocument(
        kit,
        'shortcut-identity-unbound.md',
        LARGE,
        'ir',
      )
      contexts.push(large)
      for (const mode of MODES) {
        let current = large
        let tokens = {
          bold: BOLD_WORD,
          italic: ITALIC_WORD,
          other: UNDERLINE_WORD,
        }
        if (mode === 'wysiwyg') {
          large.mode = mode
          await switchMode(large, mode)
        } else if (mode === 'sv') {
          current = await openDocument(
            kit,
            'shortcut-identity-unbound-sv.md',
            SMALL,
            'sv',
          )
          contexts.push(current)
          tokens = { bold: 'boldword', italic: 'italicword', other: 'moveword' }
        }
        await leg(current, 'unbound-bold', async () => {
          await select(current, tokens.bold)
          await endSelectionGesture(current)
          const sidebar = await sidebarVisible(kit)
          const mark = await spyMark(kit)
          await kit.xtest.key('ctrl+b')
          // VS Code's own Ctrl+B (Toggle Primary Side Bar) runs: the removal reached the profile.
          await expect
            .poll(() => sidebarVisible(kit), {
              message: 'Ctrl+B toggles the side bar',
            })
            .toBe(!sidebar)
          await kit.workbox.waitForTimeout(QUIET_MS) // negative-observation window
          const state = await hostState(current)
          expect(state.text === current.initial, 'document unchanged').toBe(
            true,
          )
          expect(state.dirty).toBe(false)
          expect(await nativeFormatting(current)).toBe(0)
          expect(await actionsSince(kit, mark)).toEqual([])
          await kit.host(async (vscode) => {
            await vscode.commands.executeCommand(
              'workbench.action.toggleSidebarVisibility',
            )
          }, [])
          await expect.poll(() => sidebarVisible(kit)).toBe(sidebar)
          // Ctrl+U has no binding at all; Ctrl+I keeps its default and formats once.
          await select(current, tokens.other)
          await endSelectionGesture(current)
          await expectInert(current, 'ctrl+u')
          return undefined
        })
        await leg(current, 'italic-still-bound', () =>
          formatLeg(current, 'ctrl+i', tokens.italic, '*', 'italic', false),
        )
      }
    } finally {
      if (previous === null) writeFileSync(keybindings, '[]')
      else writeFileSync(keybindings, previous)
      await disposeObservers(kit)
      for (const ctx of contexts) {
        results.push(...ctx.results)
        await closeAll(kit, ctx.file)
      }
    }
    report('unbound bold', results)
  })

  test('focus outside the VMDE editor: Explorer, Search input and a text editor in another group keep Ctrl+Z, Ctrl+A and Ctrl+B', async ({
    workbox,
    electronApp,
    evaluateInVSCode,
    baseDir,
  }) => {
    test.setTimeout(600_000)
    const kit = await makeKit(workbox, electronApp, evaluateInVSCode, baseDir)
    writeFileSync(path.join(baseDir, 'focus-extra-a.txt'), 'a\n')
    writeFileSync(path.join(baseDir, 'focus-extra-b.txt'), 'b\n')
    const other = path.join(baseDir, 'focus-other.txt')
    writeFileSync(other, 'other editor\n')
    const ctx = await openDocument(
      kit,
      'shortcut-identity-focus.md',
      LARGE,
      'ir',
    )
    const vmdeUnchanged = async (label: string, mark: number) => {
      await kit.workbox.waitForTimeout(QUIET_MS) // negative-observation window
      const state = await hostState(ctx)
      expect(
        state.text === ctx.initial,
        `${label}: VMDE document unchanged`,
      ).toBe(true)
      expect(state.dirty, `${label}: VMDE document clean`).toBe(false)
      expect(await actionsSince(kit, mark), `${label}: no VMDE action`).toEqual(
        [],
      )
    }
    // Ctrl+B is VS Code's Toggle Primary Side Bar wherever G1 does not hold.
    const sidebarToggles = async (label: string) => {
      const before = await sidebarVisible(kit)
      const mark = await spyMark(kit)
      await kit.xtest.key('ctrl+b')
      await expect
        .poll(() => sidebarVisible(kit), {
          message: `${label}: Ctrl+B toggles the side bar`,
        })
        .toBe(!before)
      await vmdeUnchanged(`${label} Ctrl+B`, mark)
      await kit.host(async (vscode) => {
        await vscode.commands.executeCommand(
          'workbench.action.toggleSidebarVisibility',
        )
      }, [])
      await expect.poll(() => sidebarVisible(kit)).toBe(before)
    }
    try {
      // A VMDE selection that a stray Ctrl+B or Delete would visibly act on.
      await select(ctx, BOLD_WORD)

      await leg(ctx, 'explorer', async () => {
        await kit.host(async (vscode) => {
          await vscode.commands.executeCommand('workbench.view.explorer')
          await vscode.commands.executeCommand(
            'workbench.files.action.focusFilesExplorer',
          )
        }, [])
        const explorerFocused = () =>
          kit.workbox.evaluate(
            () => !!document.activeElement?.closest('.explorer-folders-view'),
          )
        await expect.poll(explorerFocused).toBe(true)
        const rows = () =>
          kit.workbox.evaluate(() => {
            const view = document.querySelector('.explorer-folders-view')
            return {
              rows: view?.querySelectorAll('.monaco-list-row').length ?? 0,
              selected:
                view?.querySelectorAll('.monaco-list-row.selected').length ?? 0,
            }
          })
        let mark = await spyMark(kit)
        await kit.xtest.key('ctrl+a')
        await expect
          .poll(
            async () => {
              const current = await rows()
              return current.rows > 1 && current.selected === current.rows
            },
            { message: 'Ctrl+A selects every Explorer row' },
          )
          .toBe(true)
        await vmdeUnchanged('Explorer Ctrl+A', mark)
        mark = await spyMark(kit)
        await kit.xtest.key('ctrl+z')
        await vmdeUnchanged('Explorer Ctrl+Z', mark)
        await expect.poll(explorerFocused).toBe(true)
        await sidebarToggles('Explorer')
        return rows()
      })

      await leg(ctx, 'search-input', async () => {
        await kit.host(async (vscode) => {
          await vscode.commands.executeCommand('workbench.action.findInFiles')
        }, [])
        const input = kit.workbox
          .locator('.search-view .search-widget textarea')
          .first()
        await expect(input).toBeFocused()
        await kit.xtest.key('ctrl+a')
        await kit.xtest.type('alpha beta', 20)
        await expect(input).toHaveValue('alpha beta')
        let mark = await spyMark(kit)
        await input.evaluate((element: HTMLTextAreaElement) =>
          element.setSelectionRange(2, 2),
        )
        await kit.xtest.key('ctrl+a')
        await expect
          .poll(() =>
            input.evaluate((element: HTMLTextAreaElement) => [
              element.selectionStart,
              element.selectionEnd,
            ]),
          )
          .toEqual([0, 'alpha beta'.length])
        await vmdeUnchanged('Search Ctrl+A', mark)
        mark = await spyMark(kit)
        await kit.xtest.key('ctrl+z')
        await expect
          .poll(() => input.inputValue(), {
            message: 'Ctrl+Z undoes the Search input',
          })
          .not.toBe('alpha beta')
        await vmdeUnchanged('Search Ctrl+Z', mark)
        const undone = await input.inputValue()
        await expect(input).toBeFocused()
        await sidebarToggles('Search input')
        return { searchValueAfterUndo: undone }
      })

      await leg(ctx, 'other-group-text-editor', async () => {
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
        const textEditor = () =>
          kit.host(
            (vscode, [fsPath]: [string]) => {
              const editor = vscode.window.activeTextEditor
              if (editor?.document.uri.fsPath !== fsPath) return null
              const { start, end } = editor.selection
              return {
                text: editor.document.getText(),
                selection: [
                  start.line,
                  start.character,
                  end.line,
                  end.character,
                ],
                activeCustomEditor:
                  vscode.window.tabGroups.activeTabGroup.activeTab
                    ?.input instanceof vscode.TabInputCustom,
              }
            },
            [other],
          )
        await expect
          .poll(async () => (await textEditor())?.text)
          .toBe('other editor\n')
        await kit.xtest.key('End')
        await kit.xtest.type('zz', 20)
        await expect
          .poll(async () => (await textEditor())?.text)
          .toBe('other editorzz\n')
        let mark = await spyMark(kit)
        await kit.xtest.key('ctrl+z')
        await expect
          .poll(async () => (await textEditor())?.text, {
            message: 'Ctrl+Z undoes the text editor',
          })
          .toBe('other editor\n')
        await vmdeUnchanged('text editor Ctrl+Z', mark)
        mark = await spyMark(kit)
        await kit.xtest.key('ctrl+a')
        await expect
          .poll(async () => (await textEditor())?.selection, {
            message: 'Ctrl+A selects the text editor',
          })
          .toEqual([0, 0, 1, 0])
        await vmdeUnchanged('text editor Ctrl+A', mark)
        await sidebarToggles('text editor')
        const state = await textEditor()
        expect(state?.activeCustomEditor).toBe(false)
        return undefined
      })
    } finally {
      await disposeObservers(kit)
      await closeAll(kit, ctx.file)
    }
    report('focus', ctx.results)
  })

  test('Linux Ctrl+Shift+U in IR: IME composition evidence, and Escape leaves the document exact', async ({
    workbox,
    electronApp,
    evaluateInVSCode,
    baseDir,
  }) => {
    test.setTimeout(300_000)
    const kit = await makeKit(workbox, electronApp, evaluateInVSCode, baseDir)
    const ctx = await openDocument(kit, 'shortcut-identity-ime.md', LARGE, 'ir')
    const paragraphText = () =>
      evalFrame(
        kit,
        (_body, token: string) => {
          const inner = (window as any).vditor.vditor
          const root = inner[inner.currentMode].element as HTMLElement
          const block = Array.from(
            root.querySelectorAll<HTMLElement>('[data-block]'),
          ).find((element) => (element.textContent ?? '').includes(token))
          return block?.textContent ?? null
        },
        BOLD_WORD,
      )
    const composition = () =>
      evalFrame(kit, () => (window as any).__cp41.composition as unknown[], 0)
    try {
      await leg(ctx, 'ctrl-shift-u', async () => {
        await select(ctx, BOLD_WORD, { collapsed: true })
        await endSelectionGesture(ctx)
        const before = await paragraphText()
        const mark = await spyMark(kit)
        await kit.xtest.key('ctrl+shift+u')
        await kit.workbox.waitForTimeout(800)
        const during = {
          composition: await composition(),
          paragraphChanged: (await paragraphText()) !== before,
          hostExact: (await hostText(ctx)) === ctx.initial,
          actions: await actionsSince(kit, mark),
        }
        await kit.xtest.key('Escape')
        await kit.workbox.waitForTimeout(2000)
        const after = {
          composition: await composition(),
          paragraphRestored: (await paragraphText()) === before,
          host: difference(await hostText(ctx), ctx.initial),
          hostExact: (await hostText(ctx)) === ctx.initial,
          dirty: (await hostState(ctx)).dirty,
        }
        console.log('[cp4-1 ime]', JSON.stringify({ during, after }))
        expect(during.actions).toEqual([])
        expect(after.hostExact, 'document exact after Escape').toBe(true)
        expect(after.dirty).toBe(false)
        return {
          compositionEvents: during.composition.length,
          textDuringComposition: during.paragraphChanged,
          paragraphRestored: after.paragraphRestored,
        }
      })
    } finally {
      await disposeObservers(kit)
      await closeAll(kit, ctx.file)
    }
    report('ime', ctx.results)
  })
})
