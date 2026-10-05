/**
 * Task 580 Checkpoint 4 (CP4-2) — a user's own keybindings rebind VMDE commands in real VS Code.
 *
 * Each test writes a user `keybindings.json` into the test profile (restored afterwards: the
 * profile is shared by every spec of the run) that moves one representative command per mechanism
 * to a key VS Code 1.129.0 leaves free on Linux (`candidateFreeRemapKeys` in
 * test/backend/vscode-default-keybindings-1.129.0.json) and removes the default key where there is
 * one:
 *   - formatting through the toolbar: Bold, off Ctrl+B;
 *   - undo through the toolbar: Undo, off Ctrl+Z;
 *   - fold through its own message: Toggle Fold, off Ctrl+K Ctrl+L;
 *   - an `editor-action` table command: Insert Row Below (unbound by default);
 *   - an `editor-action` Vditor chord command: Heading 2 (unbound by default);
 *   - the caret gesture: Activate Link or Callout at Caret (unbound by default).
 *
 * Every key is OS-level XTEST input (docs/os-keyboard-testing-setup.md; Openbox must run without
 * key bindings) on the small exact-round-trip fixture, in IR, WYSIWYG and SV where the action
 * applies. The new key must act exactly once with exact source, and one press of the remapped Undo
 * key must restore the exact source. The old keys must not trigger the action: Ctrl+B runs VS
 * Code's side bar toggle with no native formatting, Ctrl+K Ctrl+L does nothing, and Ctrl+Z runs VS
 * Code's own Undo, whose effect on the VMDE document is recorded and must leave it uncorrupted.
 * The kit (window, fixture, spy, leg and report helpers) is shared with CP4-1.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import { VMDE_SHORTCUT_WHEN } from '../../src/shared/editor-shortcuts'
import {
  actionsSince,
  type Ctx,
  closeAll,
  disposeObservers,
  endSelectionGesture,
  evalFrame,
  expectHost,
  expectInert,
  folds,
  hostState,
  type Kit,
  leg,
  MODES,
  makeKit,
  nativeFormatting,
  openDocument,
  QUIET_MS,
  report,
  SMALL,
  select,
  sidebarVisible,
  spyMark,
  tabLabels,
  UNDO_LOCK_MS,
  userKeybindingsPath,
  webviewState,
  words,
} from './helpers/shortcut-xtest-kit'

// The remapped keys: Linux keys that no VS Code 1.129.0 default binds.
const BOLD_KEY = 'ctrl+shift+alt+b'
const TABLE_KEY = 'ctrl+shift+alt+d'
const FOLD_KEY = 'ctrl+shift+alt+e'
const UNDO_KEY = 'ctrl+shift+alt+f'
const LINK_KEY = 'ctrl+shift+alt+h'
const HEADING_KEY = 'ctrl+shift+alt+j'

// A remapped default keeps the G1 `when` clause, as VS Code's "Change Keybinding" does; a key
// added to an unbound command has none, as VS Code's "Add Keybinding" writes it.
const USER_KEYBINDINGS = [
  { key: 'ctrl+b', command: '-vmde.format.bold' },
  { key: BOLD_KEY, command: 'vmde.format.bold', when: VMDE_SHORTCUT_WHEN },
  { key: 'ctrl+z', command: '-vmde.format.undo' },
  { key: UNDO_KEY, command: 'vmde.format.undo', when: VMDE_SHORTCUT_WHEN },
  { key: 'ctrl+k ctrl+l', command: '-vmde.toggleSectionFold' },
  {
    key: FOLD_KEY,
    command: 'vmde.toggleSectionFold',
    when: VMDE_SHORTCUT_WHEN,
  },
  { key: TABLE_KEY, command: 'vmde.table.insertRowBelow' },
  { key: HEADING_KEY, command: 'vmde.format.heading2' },
  { key: LINK_KEY, command: 'vmde.activateLinkAtCaret' },
]

// VS Code watches the user keybindings file; this is ample for it to reload the file.
const KEYBINDINGS_RELOAD_MS = 3000

// Task 596 (planned, predates Task 580): a toolbar command clicks Vditor's button, whose disabled
// and current classes Vditor's highlight sets 200 ms (debounced) after a keyup, so a key pressed
// sooner after a programmatic selection can act on the previous context's classes; with the
// default Ctrl+B too (CP4-2 diagnosis: a stale `vditor-menu--disabled` Bold made Bold a no-op).
// A user's own selection gesture settles first, as Task 596's "fresh" control does.
const TOOLBAR_SETTLE_MS = 500

async function settleSelection(ctx: Ctx) {
  await endSelectionGesture(ctx)
  await ctx.kit.workbox.waitForTimeout(TOOLBAR_SETTLE_MS)
}

const LINK_TARGET = 'remap-link-target.txt'
const LINK_DOC = `see [linkword](${LINK_TARGET}) here\n`

const routes = async (kit: Kit, mark: number) =>
  (await actionsSince(kit, mark)).map(
    (message) => `${message.command}:${message.detail}`,
  )

// The rendered Markdown in the webview: the words must match the host's once an action settled.
const webviewValue = (ctx: Ctx) =>
  evalFrame(ctx.kit, () => (window as any).vditor.getValue() as string, 0)

/**
 * Presses `key` on a selection (or a caret) on `token`. It must deliver `route` exactly once and
 * leave exactly `expected` in the host; one press of the remapped Undo key must then restore the
 * opened source exactly.
 */
async function remappedEdit(
  ctx: Ctx,
  key: string,
  token: string,
  collapsed: boolean,
  route: string,
  expected: string,
  offset = 2,
) {
  const { kit } = ctx
  await select(ctx, token, { collapsed, offset })
  await settleSelection(ctx)
  const mark = await spyMark(kit)
  await kit.xtest.key(key)
  await expectHost(ctx, expected, `${key} on ${token} is exact`)
  await kit.workbox.waitForTimeout(400) // negative window: a second (duplicate) action
  expect(await routes(kit, mark), `${key} routes once`).toEqual([route])
  // WYSIWYG's own Bold runs execCommand and leaves a <b> (see CP4-1); the exact host text above
  // already rules out the native default running as well (doubled markers).
  if (ctx.mode !== 'wysiwyg')
    expect(await nativeFormatting(ctx), `${key}: no native formatting`).toBe(0)
  await kit.workbox.waitForTimeout(UNDO_LOCK_MS)
  const undoMark = await spyMark(kit)
  await kit.xtest.key(UNDO_KEY)
  await expectHost(ctx, ctx.initial, `${UNDO_KEY} (Undo) restores exact source`)
  await kit.workbox.waitForTimeout(400) // negative window: a second Undo
  expect(await routes(kit, undoMark), 'the remapped Undo routes once').toEqual([
    'trigger-toolbar-hotkey:undo',
  ])
  return undefined
}

/** A remapped key whose action has nothing to act on in this mode: routed once, no effect. */
async function remappedNoTarget(
  ctx: Ctx,
  key: string,
  token: string,
  route: string,
) {
  const { kit } = ctx
  await select(ctx, token, { collapsed: true, offset: 2 })
  await endSelectionGesture(ctx)
  await kit.workbox.waitForTimeout(QUIET_MS)
  const before = await hostState(ctx)
  const foldsBefore = await folds(ctx)
  const mark = await spyMark(kit)
  await kit.xtest.key(key)
  await kit.workbox.waitForTimeout(QUIET_MS) // negative-observation window
  const after = await hostState(ctx)
  expect(after.text === ctx.initial, `${key}: document unchanged`).toBe(true)
  expect(after.dirty, `${key}: dirty flag unchanged`).toBe(before.dirty)
  expect(await folds(ctx)).toEqual(foldsBefore)
  expect(await routes(kit, mark), `${key} routes once`).toEqual([route])
  return { noTarget: true }
}

// The old Bold key: VS Code's own Ctrl+B (Toggle Primary Side Bar) runs, and VMDE neither formats
// nor receives an action. The old Toggle Fold chord: nothing at all.
async function oldKeysLeg(ctx: Ctx) {
  const { kit } = ctx
  await select(ctx, 'boldword')
  await endSelectionGesture(ctx)
  const sidebar = await sidebarVisible(kit)
  const mark = await spyMark(kit)
  await kit.xtest.key('ctrl+b')
  await expect
    .poll(() => sidebarVisible(kit), { message: 'Ctrl+B toggles the side bar' })
    .toBe(!sidebar)
  await kit.workbox.waitForTimeout(QUIET_MS) // negative-observation window
  const state = await hostState(ctx)
  const ctrlB = {
    documentUnchanged: state.text === ctx.initial,
    dirty: state.dirty,
    nativeFormatting: await nativeFormatting(ctx),
    routes: await routes(kit, mark),
  }
  expect(ctrlB, 'Ctrl+B leaves VMDE alone').toEqual({
    documentUnchanged: true,
    dirty: false,
    nativeFormatting: 0,
    routes: [],
  })
  await kit.host(async (vscode) => {
    await vscode.commands.executeCommand(
      'workbench.action.toggleSidebarVisibility',
    )
  }, [])
  await expect.poll(() => sidebarVisible(kit)).toBe(sidebar)
  await select(ctx, 'Shortcut identity', { collapsed: true, offset: 3 })
  await endSelectionGesture(ctx)
  await expectInert(ctx, 'ctrl+k ctrl+l')
  return undefined
}

async function foldLeg(ctx: Ctx) {
  const { kit } = ctx
  if (ctx.mode === 'sv')
    // Split View has no folds: the command still reaches the webview once and changes nothing.
    return remappedNoTarget(
      ctx,
      FOLD_KEY,
      'Shortcut identity',
      'toggle-section-fold:null',
    )
  await select(ctx, 'Shortcut identity', { collapsed: true, offset: 3 })
  await endSelectionGesture(ctx)
  const mark = await spyMark(kit)
  const folded = async () => (await folds(ctx)).folded
  await kit.xtest.key(FOLD_KEY)
  await expect
    .poll(
      async () => {
        const current = await folded()
        return current.length === 1 && current[0].includes('Shortcut identity')
      },
      { message: 'the remapped Toggle Fold folds' },
    )
    .toBe(true)
  await kit.xtest.key(FOLD_KEY)
  await expect
    .poll(folded, { message: 'the remapped Toggle Fold unfolds' })
    .toEqual([])
  await kit.workbox.waitForTimeout(400) // negative window: a duplicate toggle
  expect(await folded()).toEqual([])
  expect(await routes(kit, mark)).toEqual([
    'toggle-section-fold:null',
    'toggle-section-fold:null',
  ])
  const state = await hostState(ctx)
  expect(state.text === ctx.initial).toBe(true)
  expect(state.dirty).toBe(false)
  return undefined
}

// A table edit makes the host take the edited table as Vditor renders it (columns padded to their
// widest cell), as the table commands do whatever key runs them; the rest of the source stays
// exact. Measured: an empty cell per column below the caret's row.
const TABLE_ROW_BELOW = SMALL.replace(
  '| A | B |\n| --- | --- |\n| cellword | b |',
  '| A        | B |\n| -------- | - |\n| cellword | b |\n|          |   |',
)

async function tableLeg(ctx: Ctx) {
  if (ctx.mode === 'sv')
    // Split View has no table cells (editor-actions.ts `table-cell` scope).
    return remappedNoTarget(
      ctx,
      TABLE_KEY,
      'cellword',
      'editor-action:table-insert-row-below',
    )
  return remappedEdit(
    ctx,
    TABLE_KEY,
    'cellword',
    true,
    'editor-action:table-insert-row-below',
    TABLE_ROW_BELOW,
  )
}

// The old Undo key with Undo remapped: VMDE gets no Undo, and VS Code's own `undo` runs for the
// focused custom editor. Its effect is recorded; the document must stay one of the two states the
// edit history holds (the edit, or the opened source), with the webview showing the same content.
async function oldUndoLeg(ctx: Ctx) {
  const { kit } = ctx
  const italic = ctx.initial.replace('italicword', '*italicword*')
  await select(ctx, 'italicword')
  await settleSelection(ctx)
  await kit.xtest.key('ctrl+i')
  await expectHost(ctx, italic, 'Ctrl+I (still bound) formats exactly')
  await kit.workbox.waitForTimeout(UNDO_LOCK_MS)
  const mark = await spyMark(kit)
  await kit.xtest.key('ctrl+z')
  await kit.workbox.waitForTimeout(QUIET_MS * 2) // VS Code's undo, an edit sync and a re-render
  const state = await hostState(ctx)
  const view = await webviewValue(ctx)
  const observed = {
    hostState:
      state.text === italic
        ? 'edit kept'
        : state.text === ctx.initial
          ? 'source restored'
          : 'other',
    dirty: state.dirty,
    vmdeRoutes: await routes(kit, mark),
    webviewMatchesHost: words(view) === words(state.text),
    nativeFormatting: await nativeFormatting(ctx),
    webview: await webviewState(ctx),
  }
  console.log('[cp4-2 ctrl+z with Undo remapped]', JSON.stringify(observed))
  expect(observed.vmdeRoutes, 'Ctrl+Z delivers no VMDE action').toEqual([])
  expect(observed.hostState, 'the document is not corrupted').not.toBe('other')
  expect(observed.webviewMatchesHost, 'webview and host agree').toBe(true)
  expect(observed.nativeFormatting).toBe(0)
  // The remapped Undo still undoes the edit when VS Code's own Undo left it.
  if (observed.hostState === 'edit kept') {
    await kit.xtest.key(UNDO_KEY)
    await expectHost(ctx, ctx.initial, 'the remapped Undo still restores')
  }
  return { observed, leavesEdit: true }
}

// Activate Link or Callout at Caret on a callout: WYSIWYG focuses the callout popover's type
// control (callout-popover-keys.ts; IR and SV have no such popover). Records how long the popover
// takes to appear after the caret lands and to take focus after the key (CP2-8 open risk).
async function calloutLeg(ctx: Ctx) {
  const { kit } = ctx
  const control = kit.frame().locator('.vditor-panel .vmde-callout__type')
  await select(ctx, 'calloutword', { collapsed: true, offset: 3 })
  await endSelectionGesture(ctx)
  const placed = Date.now()
  await expect(control, 'the callout popover appears').toHaveCount(1, {
    timeout: 15_000,
  })
  const popoverMs = Date.now() - placed
  const mark = await spyMark(kit)
  const pressed = Date.now()
  await kit.xtest.key(LINK_KEY)
  await expect
    .poll(async () => (await webviewState(ctx)).calloutControlFocused, {
      message: 'the remapped key focuses the callout control',
      timeout: 15_000,
    })
    .toBe(true)
  const focusMs = Date.now() - pressed
  await kit.workbox.waitForTimeout(400) // negative window: a duplicate action
  expect(await routes(kit, mark)).toEqual(['activate-link-at-caret:null'])
  const state = await hostState(ctx)
  expect(state.text === ctx.initial, 'document unchanged').toBe(true)
  expect(state.dirty).toBe(false)
  // Give the editing surface its focus back for the legs after this one.
  await kit.xtest.key('Escape')
  return { popoverMs, focusMs }
}

async function smallModeLegs(ctx: Ctx) {
  const S = ctx.initial
  // The edits run after the inert and fold legs, Heading 2 first: WYSIWYG's first Bold after the
  // mode switch on this document does nothing (pre-existing, measured on 8c2ec1f0 for CP4-1).
  await leg(ctx, 'old-keys', () => oldKeysLeg(ctx))
  await leg(ctx, 'remap-toggle-fold', () => foldLeg(ctx))
  await leg(ctx, 'remap-heading-2', () =>
    remappedEdit(
      ctx,
      HEADING_KEY,
      'moveword',
      true,
      'editor-action:heading-2',
      S.replace('moveword paragraph', '## moveword paragraph'),
      // Split View's heading inserts its marker at the caret (Vditor sv/process.ts
      // processHeading; mid-word it splits the line), so there the caret sits at the line start.
      ctx.mode === 'sv' ? 0 : 2,
    ),
  )
  await leg(ctx, 'remap-table-insert-row-below', () => tableLeg(ctx))
  await leg(ctx, 'remap-bold', () =>
    remappedEdit(
      ctx,
      BOLD_KEY,
      'boldword',
      false,
      'trigger-toolbar-hotkey:bold',
      S.replace('boldword', '**boldword**'),
    ),
  )
  if (ctx.mode === 'wysiwyg')
    await leg(ctx, 'remap-activate-callout', () => calloutLeg(ctx))
  await leg(ctx, 'old-undo-key', () => oldUndoLeg(ctx))
}

// Activate Link or Callout at Caret on a relative link opens its target in VS Code.
async function linkLeg(ctx: Ctx) {
  const { kit } = ctx
  await select(ctx, 'linkword', { collapsed: true, offset: 3 })
  await endSelectionGesture(ctx)
  const mark = await spyMark(kit)
  await kit.xtest.key(LINK_KEY)
  await expect
    .poll(async () => (await tabLabels(kit)).includes(LINK_TARGET), {
      message: 'the remapped key opens the link target',
    })
    .toBe(true)
  const state = await hostState(ctx)
  expect(state.text === ctx.initial, 'document unchanged').toBe(true)
  expect(state.dirty).toBe(false)
  // The target's tab hides the VMDE webview, which keeps its context (retainContextWhenHidden):
  // show it again to read the messages it received.
  await kit.host(
    async (vscode, [fsPath]: [string]) => {
      await vscode.commands.executeCommand(
        'vscode.openWith',
        vscode.Uri.file(fsPath),
        'vmde.editor',
      )
    },
    [ctx.file],
  )
  await expect
    .poll(() => routes(kit, mark), { timeout: 30_000 })
    .toEqual(['activate-link-at-caret:null'])
  return {
    tabs: (await tabLabels(kit)).filter((label) => label === LINK_TARGET),
  }
}

test.describe('Task 580 CP4-2 user keybindings rebind VMDE commands (OS-level XTEST)', () => {
  test.skip(
    process.env.VMDE_XTEST !== '1',
    'requires isolated Xvfb/Openbox XTEST',
  )

  for (const mode of MODES)
    test(`${mode}: remapped keys act once with exact source and one remapped Undo; the old keys do not`, async ({
      workbox,
      electronApp,
      evaluateInVSCode,
      baseDir,
    }) => {
      test.setTimeout(600_000)
      const kit = await makeKit(
        workbox,
        electronApp,
        evaluateInVSCode,
        baseDir,
        'cp4-2',
      )
      const keybindings = await userKeybindingsPath(kit)
      const previous = existsSync(keybindings)
        ? readFileSync(keybindings, 'utf8')
        : null
      mkdirSync(path.dirname(keybindings), { recursive: true })
      writeFileSync(keybindings, JSON.stringify(USER_KEYBINDINGS, null, 2))
      await kit.workbox.waitForTimeout(KEYBINDINGS_RELOAD_MS)
      const results: Record<string, unknown>[] = []
      const contexts: Ctx[] = []
      try {
        const ctx = await openDocument(
          kit,
          `shortcut-remap-${mode}.md`,
          SMALL,
          mode,
        )
        contexts.push(ctx)
        await smallModeLegs(ctx)
        if (mode !== 'sv') {
          writeFileSync(path.join(baseDir, LINK_TARGET), 'link target\n')
          const link = await openDocument(
            kit,
            `shortcut-remap-link-${mode}.md`,
            LINK_DOC,
            mode,
          )
          contexts.push(link)
          await leg(link, 'remap-activate-link', () => linkLeg(link))
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
      report(mode, results, 'cp4-2')
    })
})
