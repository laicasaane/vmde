/**
 * Task 673 — typing after an exact action keeps the action's neutral bytes.
 *
 * Source Format Table pads a table to the same Markdown that Lute would produce for the unpadded
 * one. The plain write-back minimizes against the bytes on disk, so it used to put the unpadded
 * table back as soon as the user typed in another paragraph (the write-back kept the baseline's
 * bytes for every block that reserializes the same), and the deferred no-op check did the same
 * after typed text was deleted again.
 *
 * Source mode is opened directly (no Shift key before the command: its keydown would clear the
 * retained Source caret) and a `selectionchange` event retains the caret, as a pointer gesture does.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import {
  AFTER_SAVE_MS,
  type Ctx,
  closeAll,
  disposeObservers,
  evalFrame,
  expectHost,
  hostState,
  hostText,
  type Kit,
  makeKit,
  openDocument,
  QUIET_MS,
  select,
  UNDO_LOCK_MS,
} from './helpers/shortcut-xtest-kit'

const NORMALIZING = readFileSync(
  path.join(__dirname, 'fixtures', 'exact-actions-normalizing.md'),
  'utf8',
)

// The caret placed by `select` becomes the retained Source selection the palette command reads.
const retainCaret = (ctx: Ctx) =>
  evalFrame(
    ctx.kit,
    () => {
      document.dispatchEvent(new Event('selectionchange'))
    },
    0,
  )

const insertAt = (text: string, token: string, offset: number, add: string) => {
  const at = text.indexOf(token) + offset
  return `${text.slice(0, at)}${add}${text.slice(at)}`
}

const saveDocument = (kit: Kit, file: string) =>
  kit.host(
    async (vscode, [fsPath]: [string]) => {
      const document = vscode.workspace.textDocuments.find(
        (candidate) => candidate.uri.fsPath === fsPath,
      )
      await document?.save()
    },
    [file],
  )

// Opens the normalizing fixture in Source mode, runs Format Table in its table and returns the
// host bytes the action wrote.
async function formatTable(kit: Kit, name: string) {
  const ctx = await openDocument(kit, name, NORMALIZING, 'sv', { direct: true })
  await select(ctx, 'cellone', { collapsed: true, offset: 3 })
  await retainCaret(ctx)
  await kit.workbox.waitForTimeout(500)
  await kit.host(async (vscode) => {
    await vscode.commands.executeCommand('vmde.formatTable')
  }, [])
  await expect
    .poll(async () => (await hostText(ctx)) !== NORMALIZING, {
      timeout: 15_000,
      message: 'Format Table changed the host text',
    })
    .toBe(true)
  await kit.workbox.waitForTimeout(QUIET_MS)
  const formatted = (await hostText(ctx)) ?? ''
  expect(formatted, 'the action only pads the table').not.toBe(NORMALIZING)
  return { ctx, formatted }
}

async function typeInEditParagraph(ctx: Ctx, text: string) {
  await select(ctx, 'editword', { collapsed: true, offset: 2 })
  await retainCaret(ctx)
  await ctx.kit.xtest.type(text, 20)
  await ctx.kit.workbox.waitForTimeout(UNDO_LOCK_MS)
}

test.describe('Task 673 neutral bytes of an exact action (OS-level XTEST)', () => {
  test.skip(
    process.env.VMDE_XTEST !== '1',
    'requires isolated Xvfb/Openbox XTEST',
  )

  test('sv: typing after Format Table keeps the table padding, also after the typed text is deleted', async ({
    workbox,
    electronApp,
    evaluateInVSCode,
    baseDir,
  }) => {
    test.setTimeout(300_000)
    const kit = await makeKit(
      workbox,
      electronApp,
      evaluateInVSCode,
      baseDir,
      '673-keep',
    )
    try {
      const { ctx, formatted } = await formatTable(kit, '673-keep-sv.md')
      await typeInEditParagraph(ctx, 'x')
      await expectHost(
        ctx,
        insertAt(formatted, 'editword', 2, 'x'),
        'typing keeps the padded table',
      )

      // The typed character is deleted again: the document is the action result once more, which
      // the deferred no-op check must not turn into the disk bytes (it waits 1.2 s of idle).
      await kit.xtest.key('BackSpace')
      await expectHost(
        ctx,
        formatted,
        'deleting the typed text keeps the action result',
      )
      await kit.workbox.waitForTimeout(QUIET_MS + 1500)
      expect(
        await hostText(ctx),
        'the deferred no-op check leaves the padding',
      ).toBe(formatted)

      // Typing again and Save write the padded table to disk.
      await typeInEditParagraph(ctx, 'y')
      await saveDocument(kit, ctx.file)
      await kit.workbox.waitForTimeout(AFTER_SAVE_MS)
      const saved = await hostState(ctx)
      expect(saved.text, 'Save keeps the padded table').toBe(
        insertAt(formatted, 'editword', 2, 'y'),
      )
      expect(saved.dirty).toBe(false)
    } finally {
      await disposeObservers(kit)
      await closeAll(kit, path.join(kit.baseDir, '673-keep-sv.md'))
    }
  })

  test('sv: Undo of the typing returns to the action result, Undo of the action to the saved bytes, and Undo to a saved state makes the tab clean', async ({
    workbox,
    electronApp,
    evaluateInVSCode,
    baseDir,
  }) => {
    test.setTimeout(300_000)
    const kit = await makeKit(
      workbox,
      electronApp,
      evaluateInVSCode,
      baseDir,
      '673-undo',
    )
    try {
      const { ctx, formatted } = await formatTable(kit, '673-undo-sv.md')
      await typeInEditParagraph(ctx, 'x')
      await expectHost(
        ctx,
        insertAt(formatted, 'editword', 2, 'x'),
        'typing keeps the padded table',
      )

      await kit.xtest.key('ctrl+z')
      await expectHost(
        ctx,
        formatted,
        'Undo of the typing returns to the action result',
      )

      // Task 675 records the Source command in the editor history, so a second Undo reverts the
      // padding. The tab can stay marked modified after Undo of an exact action even though its
      // text equals the saved bytes (VS Code's saved version is not restored by that Undo); that
      // is the same with and without this task's change, so only the text is asserted here.
      await kit.xtest.key('ctrl+z')
      await expectHost(
        ctx,
        NORMALIZING,
        'Undo of the action returns to the saved bytes',
      )

      // Save makes those bytes the clean baseline again. Typing and then Undo must return to them
      // and make the tab clean (Tasks 61, 434): the exact-write state must not outlive the save.
      await saveDocument(kit, ctx.file)
      await kit.workbox.waitForTimeout(AFTER_SAVE_MS)
      await typeInEditParagraph(ctx, 'y')
      await expectHost(
        ctx,
        insertAt(NORMALIZING, 'editword', 2, 'y'),
        'typing after the save writes only the typed character',
      )
      await kit.xtest.key('ctrl+z')
      await expectHost(ctx, NORMALIZING, 'Undo returns to the saved bytes')
      await expect
        .poll(async () => (await hostState(ctx)).dirty, {
          timeout: 15_000,
          message: 'the tab is clean after Undo to the saved state',
        })
        .toBe(false)
    } finally {
      await disposeObservers(kit)
      await closeAll(kit, path.join(kit.baseDir, '673-undo-sv.md'))
    }
  })
})
