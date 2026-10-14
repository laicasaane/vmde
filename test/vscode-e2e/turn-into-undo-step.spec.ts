/**
 * Task 611 — a successful Turn Into adds exactly one Undo step, in the real VS Code webview with
 * OS-level XTEST input (docs/os-keyboard-testing-setup.md).
 *
 * Before the fix the pre-transform checkpoint pushed a history entry that differed from the
 * previous one only in the caret, so a Turn Into after a settled edit and a caret move gave two
 * entries: the first Ctrl+Z restored the text, the second moved the caret and changed no text.
 * Contract (Owner decisions 2026-10-08 and 2026-10-14): one Ctrl+Z restores the exact
 * pre-Turn-Into document with the caret where it was before the transform; one Ctrl+Y reapplies
 * it with the caret at the content position the planner mapped; the next Ctrl+Z undoes the prior
 * edit, with no caret-only step between.
 *
 * IR and WYSIWYG run the same journey on a small exact-round-trip document:
 *   1. Type one character with OS keys, wait out Vditor's undo delay (the settled edit).
 *   2. Move the caret into the target paragraph (the only difference from the last history
 *      entry is now the caret).
 *   3. Run Turn Into -> Heading 2 through the native QuickPick with OS keys. While the QuickPick is
 *      open the webview has lost focus: that state is probed and recorded (log line `probe`).
 *   4. Assert the Undo depth grew by exactly one, then Ctrl+Z once (exact host text, exact disk
 *      text after Save, caret at the pre-Turn-Into position, focus in the editor), Ctrl+Y once
 *      (transformed host and disk text, caret at the mapped content position), Ctrl+Z twice
 *      (the second removes the typed character, so no caret-only step sits between them),
 *      Ctrl+Y twice, Save, close and reopen (the bytes outside the block survive).
 *
 * Every Ctrl+Z and Ctrl+Y is counted at the engine through a read-only wrapper (it changes no
 * timer, history or selection) so a key that never reached the webview cannot make a "nothing
 * changed" assertion pass vacuously. Expected texts are spliced from the authored document, never
 * read from the product. Host comparisons are exact strings in a document small enough to print.
 */
import { readFileSync } from 'node:fs'
import { expect, test } from 'vscode-test-playwright'
import {
  AFTER_SAVE_MS,
  type Ctx,
  closeAll,
  evalFrame,
  expectHost,
  hostState,
  type Kit,
  makeKit,
  openDocument,
  openEditor,
  select,
  UNDO_LOCK_MS,
} from './helpers/shortcut-xtest-kit'
import { ExtensionId, waitForInitialUndoSnapshot } from './webview-helpers'

const LABEL = 'Task 611 Turn Into undo step'

// Round-trips exactly through the visual modes' serializers. Tokens are unique so `select` finds
// one text node.
const DOC = [
  '# Turn Into history',
  '',
  'typed alphaword here.',
  '',
  'target gammaword delta',
  '',
  '- parent item',
  '- child item',
  '',
  '> [!NOTE]',
  '> callout body',
  '',
  '```js',
  'const kept = 1',
  '```',
  '',
  'last paragraph.',
  '',
].join('\n')
// One character typed at the end of `alphaword`.
const TYPED = DOC.replace('alphaword', 'alphawordX')
// Turn Into Heading 2 on the target paragraph, applied after the typed character.
const TRANSFORMED = TYPED.replace(
  'target gammaword delta',
  '## target gammaword delta',
)
// The caret goes inside `gammaword` (`gam|maword`); the planner maps it by content offset, so after
// Turn Into and Redo it is at the same content position inside the heading.
const TYPING_TOKEN = 'alphaword'
const CARET_TOKEN = 'gammaword'
const CARET_OFFSET = 3
const CARET_CONTEXT = 'target gam'
// Negative-observation window: longer than the 800 ms undo delay, IR's 220 ms settle, the 250 ms
// edit sync and a host round trip.
const STABLE_MS = 1500

// --- In-page probes (each runs inside the webview and must stay self-contained) ---

// Counts the engine's Undo and Redo calls. Installed once per document, outside VMDE's history
// wrapper, so it only observes.
function installWatch(): boolean {
  const w = window as any
  const inner = w.vditor?.vditor
  if (!inner?.undo) return false
  if (w.__t611) return true
  const watch = { undos: 0, redos: 0 }
  const undo = inner.undo.undo
  const redo = inner.undo.redo
  inner.undo.undo = function (vditor: unknown) {
    watch.undos++
    return undo.call(this, vditor)
  }
  inner.undo.redo = function (vditor: unknown) {
    watch.redos++
    return redo.call(this, vditor)
  }
  w.__t611 = watch
  return true
}

function readState() {
  const w = window as any
  const inner = w.vditor.vditor
  const mode = inner.currentMode as string
  const slot = inner.undo[mode]
  const root = inner[mode].element as HTMLElement
  const selection = getSelection()
  let caret: string | null = null
  let sentinel = false
  let collapsed: boolean | null = null
  if (
    selection?.rangeCount &&
    selection.anchorNode &&
    root.contains(selection.anchorNode)
  ) {
    collapsed = selection.isCollapsed
    sentinel = selection.anchorNode === root
    const range = document.createRange()
    if (!sentinel) {
      let start: Node = selection.anchorNode
      while (start.parentNode && start.parentNode !== root)
        start = start.parentNode
      range.setStart(start, 0)
      range.setEnd(selection.anchorNode, selection.anchorOffset)
      // The text from the start of the caret's block up to the caret, without a leading Markdown
      // heading marker (IR shows it as text) or zero-width marks.
      caret = range
        .toString()
        .replace(/\u200B/g, '')
        .replace(/^#{1,6} /, '')
    }
  }
  return {
    undo: slot.undoStack.length as number,
    redo: slot.redoStack.length as number,
    caret,
    sentinel,
    collapsed,
    // Focus the user can type in: the document has OS focus and the editing surface holds it.
    focused: document.hasFocus() && root.contains(document.activeElement),
    documentFocus: document.hasFocus(),
    engineUndos: (w.__t611?.undos ?? 0) as number,
    engineRedos: (w.__t611?.redos ?? 0) as number,
  }
}

// --- Test-side helpers ---

const webview = (ctx: Ctx) => evalFrame(ctx.kit, readState, 0)

const picker = (kit: Kit) =>
  kit.workbox.locator('.quick-input-widget input').first()

async function runCommand(kit: Kit, command: string) {
  await kit.host(
    async (vscode, [id]: [string]) => {
      await vscode.commands.executeCommand(id)
    },
    [command],
  )
}

async function saveAndExpectDisk(ctx: Ctx, expected: string, what: string) {
  await runCommand(ctx.kit, 'workbench.action.files.save')
  await expect
    .poll(() => readFileSync(ctx.file, 'utf8') === expected, {
      timeout: 15_000,
      message: `${ctx.mode}: ${what}`,
    })
    .toBe(true)
  await ctx.kit.workbox.waitForTimeout(AFTER_SAVE_MS) // deferred no-op check of the save
  expect(
    {
      disk: readFileSync(ctx.file, 'utf8') === expected,
      dirty: (await hostState(ctx)).dirty,
    },
    `${ctx.mode}: ${what} stays and the document is clean`,
  ).toEqual({ disk: true, dirty: false })
}

async function expectEditorFocus(ctx: Ctx, what: string) {
  await expect
    .poll(async () => (await webview(ctx)).focused, {
      timeout: 10_000,
      message: `${ctx.mode}: ${what}: focus is in the editor`,
    })
    .toBe(true)
}

// One OS key proven to have reached the engine (one more call than before).
async function pressHistoryKey(
  ctx: Ctx,
  key: 'ctrl+z' | 'ctrl+y',
  what: string,
) {
  const field = key === 'ctrl+z' ? 'engineUndos' : 'engineRedos'
  await expectEditorFocus(ctx, `before ${what}`)
  const before = (await webview(ctx))[field]
  await ctx.kit.xtest.key(key)
  await expect
    .poll(async () => (await webview(ctx))[field], {
      timeout: 5_000,
      message: `${ctx.mode}: ${what} reaches the engine`,
    })
    .toBe(before + 1)
}

// Turn Into -> Heading 2 through the native QuickPick with OS keys. Returns the webview state
// observed while the QuickPick is open (the probe of the focus-left-the-editor case).
async function turnIntoHeading2(ctx: Ctx) {
  const { kit } = ctx
  await runCommand(kit, 'vmde.turnInto')
  await expect(picker(kit)).toBeVisible({ timeout: 20_000 })
  await expect(
    kit.workbox.getByRole('option', { name: /Heading 2/u }).first(),
  ).toBeVisible({ timeout: 20_000 })
  const open = await webview(ctx)
  console.log(
    `[${LABEL}] probe ${ctx.mode} QuickPick open:`,
    JSON.stringify(open),
  )
  await picker(kit).focus()
  await expect(picker(kit)).toBeFocused()
  await kit.xtest.key('ctrl+a')
  await kit.xtest.type('Heading 2', 20)
  await expect
    .poll(async () => (await picker(kit).inputValue()) === 'Heading 2')
    .toBe(true)
  await kit.xtest.key('Return')
  await picker(kit).waitFor({ state: 'hidden' })
  return open
}

test.describe('Task 611 Turn Into adds one Undo step', () => {
  test.skip(
    process.env.VMDE_XTEST !== '1',
    'requires isolated Xvfb/Openbox XTEST',
  )

  test.afterEach(async ({ evaluateInVSCode }) => {
    await evaluateInVSCode(async (vscode) => {
      await vscode.workspace
        .getConfiguration('vmde')
        .update('editor.defaultMode', undefined, true)
    })
  })

  // SV is not covered: Turn Into declines there before it opens the QuickPick (Task 605 is the
  // planned SV design; Task 604 scoped its exact-source proof to IR and WYSIWYG), so it never
  // reaches a history checkpoint. Measured on this journey: no QuickPick opened within 24 s.
  for (const mode of ['ir', 'wysiwyg'] as const) {
    test(`${mode}: one Ctrl+Z reverses Turn Into, one Ctrl+Y reapplies it, the next Ctrl+Z undoes the edit before it`, async ({
      workbox,
      electronApp,
      evaluateInVSCode,
      baseDir,
    }) => {
      test.setTimeout(600_000)
      await evaluateInVSCode(
        async (vscode: typeof import('vscode'), [id]: [string]) => {
          await vscode.extensions.getExtension(id)?.activate()
        },
        [ExtensionId] as [string],
      )
      const kit = await makeKit(
        workbox,
        electronApp,
        evaluateInVSCode,
        baseDir,
        LABEL,
      )
      const ctx = await openDocument(
        kit,
        `turn-into-undo-${mode}.md`,
        DOC,
        mode,
      )
      await waitForInitialUndoSnapshot(kit.frame())
      expect(await evalFrame(kit, installWatch, 0), 'watch installed').toBe(
        true,
      )
      const opened = await webview(ctx)

      // 1. A settled, trusted edit: one typed character.
      await select(ctx, TYPING_TOKEN, {
        collapsed: true,
        offset: TYPING_TOKEN.length,
      })
      await kit.xtest.type('X')
      await expectHost(ctx, TYPED, 'the typed character reaches the host')
      await kit.workbox.waitForTimeout(UNDO_LOCK_MS)
      const typed = await webview(ctx)
      expect(typed.undo, `${mode}: the typed edit has its own entry`).toBe(
        opened.undo + 1,
      )

      // 2. The caret moves into the target paragraph: a caret-only difference from the last entry.
      await select(ctx, CARET_TOKEN, { collapsed: true, offset: CARET_OFFSET })
      const before = await webview(ctx)
      expect(
        { caret: before.caret, undo: before.undo, redo: before.redo },
        `${mode}: caret placed in the target, no entry added by the move`,
      ).toEqual({ caret: CARET_CONTEXT, undo: typed.undo, redo: 0 })

      // 3. Turn Into -> Heading 2 through the QuickPick.
      const open = await turnIntoHeading2(ctx)
      await expectHost(ctx, TRANSFORMED, 'Turn Into reaches the host')
      await expectEditorFocus(ctx, 'after Turn Into')
      await kit.workbox.waitForTimeout(UNDO_LOCK_MS) // the delayed Vditor record has run
      const applied = await webview(ctx)
      console.log(
        `[${LABEL}] probe ${mode} after Turn Into:`,
        JSON.stringify({ open, before, applied }),
      )
      // Acceptance 1: exactly one entry for the transform, no caret-only entry below it.
      expect(
        { undo: applied.undo, redo: applied.redo, caret: applied.caret },
        `${mode}: Turn Into adds exactly one Undo entry (observed ${JSON.stringify(applied)})`,
      ).toEqual({ undo: before.undo + 1, redo: 0, caret: CARET_CONTEXT })

      // 4a. Ctrl+Z x1: the exact pre-Turn-Into document, caret back where it was, focus kept.
      await pressHistoryKey(ctx, 'ctrl+z', 'the first Ctrl+Z')
      await expectHost(ctx, TYPED, 'one Ctrl+Z restores the exact host text')
      await kit.workbox.waitForTimeout(STABLE_MS) // negative-observation window
      await expectHost(ctx, TYPED, 'the restored host text stays exact')
      const undone = await webview(ctx)
      expect(
        {
          undo: undone.undo,
          redo: undone.redo,
          caret: undone.caret,
          collapsed: undone.collapsed,
          focused: undone.focused,
        },
        `${mode}: one Ctrl+Z (observed ${JSON.stringify(undone)})`,
      ).toEqual({
        undo: before.undo,
        redo: 1,
        caret: CARET_CONTEXT,
        collapsed: true,
        focused: true,
      })
      await saveAndExpectDisk(
        ctx,
        TYPED,
        'disk holds the exact pre-Turn-Into text',
      )

      // 4b. Ctrl+Y x1: transformed again, caret at the mapped content position.
      await pressHistoryKey(ctx, 'ctrl+y', 'the Ctrl+Y')
      await expectHost(ctx, TRANSFORMED, 'one Ctrl+Y reapplies the transform')
      await kit.workbox.waitForTimeout(STABLE_MS) // negative-observation window
      await expectHost(ctx, TRANSFORMED, 'the redone host text stays exact')
      const redone = await webview(ctx)
      expect(
        {
          undo: redone.undo,
          redo: redone.redo,
          caret: redone.caret,
          collapsed: redone.collapsed,
          focused: redone.focused,
        },
        `${mode}: one Ctrl+Y (observed ${JSON.stringify(redone)})`,
      ).toEqual({
        undo: applied.undo,
        redo: 0,
        caret: CARET_CONTEXT,
        collapsed: true,
        focused: true,
      })
      await saveAndExpectDisk(
        ctx,
        TRANSFORMED,
        'disk holds the exact transformed text',
      )

      // 4c. Ctrl+Z x2: the first reverses the transform, the second removes the typed character.
      await pressHistoryKey(ctx, 'ctrl+z', 'the Ctrl+Z after the Redo')
      await expectHost(
        ctx,
        TYPED,
        'the first of two Ctrl+Z restores the typed text',
      )
      await pressHistoryKey(ctx, 'ctrl+z', 'the second Ctrl+Z')
      await expectHost(ctx, DOC, 'the second Ctrl+Z undoes the typed character')
      await kit.workbox.waitForTimeout(STABLE_MS) // negative-observation window
      await expectHost(ctx, DOC, 'the opened text stays exact')
      const twice = await webview(ctx)
      expect(
        { undo: twice.undo, redo: twice.redo, focused: twice.focused },
        `${mode}: two Ctrl+Z reach the opened document (observed ${JSON.stringify(twice)})`,
      ).toEqual({ undo: opened.undo, redo: 2, focused: true })

      // 4d. Ctrl+Y x2, Save, close, reopen: the bytes outside the block survive.
      await pressHistoryKey(ctx, 'ctrl+y', 'the first of two Ctrl+Y')
      await expectHost(
        ctx,
        TYPED,
        'the first of two Ctrl+Y reapplies the typed character',
      )
      await pressHistoryKey(ctx, 'ctrl+y', 'the second Ctrl+Y')
      await expectHost(
        ctx,
        TRANSFORMED,
        'the second Ctrl+Y reapplies the transform',
      )
      await saveAndExpectDisk(
        ctx,
        TRANSFORMED,
        'disk holds the transformed text before closing',
      )
      await closeAll(kit, ctx.file)
      await openEditor(ctx)
      const reopened = await hostState(ctx)
      expect(
        {
          host: reopened.text === TRANSFORMED,
          disk: readFileSync(ctx.file, 'utf8') === TRANSFORMED,
          dirty: reopened.dirty,
        },
        `${mode}: save and reopen keep the exact bytes`,
      ).toEqual({ host: true, disk: true, dirty: false })
    })
  }
})
