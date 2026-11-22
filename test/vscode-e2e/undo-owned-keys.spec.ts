/**
 * Task 733 / 036 D-18 (design rev 4.1 R41.5 and R41.6): in the IR editor the Undo/Redo chords of
 * `vmde.editor.undoRedoKeys.undo`/`.redo` are owned at keydown. An owned press makes one local move and
 * stops before VS Code forwards the key, so no `vmde.format.undo`/`redo` command reaches the webview, and
 * a key typed right after the chord is never undone by it.
 *
 * Cases (OS-level XTEST keys into the real VS Code window):
 *   - x1: Ctrl+Z, Ctrl+Y and Ctrl+Shift+Z move the host text with zero VMDE commands;
 *   - x1, x4, x16: Ctrl+Z then `q` with no delay keeps `q` and undoes only the typed key before it;
 *   - x4: Save during an owned sliced replay of Replace All writes the undone bytes to disk, starting
 *     from different disk bytes, with the will-save proven (036 core C8);
 *   - x4: typing during the replay, then Save, close and reopen: disk and editor hold the undone text
 *     plus the key; a second Ctrl+Z supersedes the first replay; two overlapping Saves; the Save case
 *     with ownership off (036 core C8, R31.5);
 *   - a setting chord (`ctrl+alt+u`) undoes in IR, and a `keybindings.json` binding of
 *     `vmde.format.undo` on another key still runs at command time;
 *   - `vmde.editor.undoRedoKeys.inEditor: false`: Ctrl+Z goes through the VMDE command again.
 *
 * Records hold counts, commands and times only, no document text.
 */
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { expect, test } from 'vscode-test-playwright'
import { VMDE_SHORTCUT_WHEN } from '../../src/shared/editor-shortcuts'
import { FIXTURE as LARGE } from './find-replace-fixture-helpers'
import { replaceAllByKeys } from './helpers/replace-all-xtest'
import {
  type Ctx,
  type Kit,
  actionsSince,
  closeAll,
  disposeObservers,
  hostState,
  hostText,
  makeKit,
  openDocument,
  openEditor,
  restoreKitSettings,
  select,
  spyMark,
  UNDO_LOCK_MS,
  userKeybindingsPath,
} from './helpers/shortcut-xtest-kit'

const runFile = promisify(execFile)

const PARAGRAPH = 'Pzwr wfsnnsra tr wumyslsn'
const REPLACE_TOKEN = 'ncjw'
const SETTING_UNDO_KEY = 'ctrl+alt+u'
const BOUND_UNDO_KEY = 'ctrl+shift+alt+f'
// VS Code watches the user keybindings file; this is ample for it to reload the file.
const KEYBINDINGS_RELOAD_MS = 3000
// A negative window: a late command or a second move would show within it.
const NEGATIVE_MS = 1500

const scaled = (factor: number) =>
  Array.from({ length: factor }, () => LARGE).join('\n')

/** The text is `base` with exactly one `key` inserted. */
function oneInserted(text: string | null, base: string, key: string) {
  if (text === null || text.length !== base.length + key.length) return false
  let i = 0
  while (i < base.length && text[i] === base[i]) i++
  return (
    text.slice(i, i + key.length) === key &&
    text.slice(i + key.length) === base.slice(i)
  )
}

/** The VMDE Undo/Redo commands that reached the webview since `mark`. */
const historyCommandsSince = async (kit: Kit, mark: number) =>
  (await actionsSince(kit, mark)).filter(
    (message) =>
      message.command === 'trigger-toolbar-hotkey' &&
      (message.detail === 'undo' || message.detail === 'redo'),
  ).length

/** One xdotool call on the verified, focused VS Code window, for keys with no delay between them. */
async function xdo(kit: Kit, args: string[]) {
  await kit.xtest.activateAndFocus()
  await runFile('xdotool', args, { env: process.env, timeout: 15_000 })
}

// The host bridge (`evaluateInVSCode`) cannot pass `null` or `undefined` as an argument: a string sentinel
// stands for "restore the default" and is mapped to `undefined` inside the host function.
const DEFAULT_SETTING = '__vmde-default__'

/** Sets `vmde.editor.undoRedoKeys.<key>` globally; `null` restores the default. */
const setUndoSetting = (kit: Kit, key: string, value: unknown) =>
  kit.host(
    async (vscode, [name, next, sentinel]: [string, unknown, string]) => {
      await vscode.workspace
        .getConfiguration('vmde')
        .update(
          `editor.undoRedoKeys.${name}`,
          next === sentinel ? undefined : next,
          vscode.ConfigurationTarget.Global,
        )
    },
    [key, value ?? DEFAULT_SETTING, DEFAULT_SETTING] as [
      string,
      unknown,
      string,
    ],
  )

async function resetUndoSettings(kit: Kit) {
  for (const key of ['inEditor', 'undo', 'redo'])
    await setUndoSetting(kit, key, null)
}

/** Types `key` into the first PARAGRAPH and waits until the host holds it, then for the undo lock. */
async function typeOne(ctx: Ctx, base: string, key: string) {
  await select(ctx, PARAGRAPH, { collapsed: true, offset: 4 })
  await ctx.kit.xtest.type(key)
  await expect
    .poll(async () => oneInserted(await hostText(ctx), base, key), {
      timeout: 60_000,
    })
    .toBe(true)
  await ctx.kit.workbox.waitForTimeout(UNDO_LOCK_MS)
}

async function expectHostIs(ctx: Ctx, expected: string, message: string) {
  await expect
    .poll(async () => (await hostText(ctx)) === expected, {
      timeout: 60_000,
      message,
    })
    .toBe(true)
}

test.describe('036 D-18: the IR editor owns its Undo/Redo keys (OS-level XTEST)', () => {
  test.skip(
    process.env.VMDE_XTEST !== '1',
    'requires isolated Xvfb/Openbox XTEST',
  )
  test.describe.configure({ timeout: 300_000 })

  let kit: Kit | undefined
  const contexts: Ctx[] = []

  test.afterEach(async () => {
    if (kit) {
      await resetUndoSettings(kit)
      await disposeObservers(kit)
      for (const ctx of contexts.splice(0)) await closeAll(kit, ctx.file)
    }
    kit = undefined
    await restoreKitSettings()
  })

  async function open(
    fixtures: {
      workbox: unknown
      electronApp: Parameters<typeof makeKit>[1]
      evaluateInVSCode: unknown
      baseDir: string
    },
    name: string,
    content: string,
  ) {
    kit = await makeKit(
      fixtures.workbox,
      fixtures.electronApp,
      fixtures.evaluateInVSCode,
      fixtures.baseDir,
      'd18',
    )
    await resetUndoSettings(kit)
    const ctx = await openDocument(kit, name, content, 'ir')
    contexts.push(ctx)
    return ctx
  }

  test('x1: Ctrl+Z, Ctrl+Y and Ctrl+Shift+Z move the host text with zero VMDE commands', async ({
    workbox,
    electronApp,
    evaluateInVSCode,
    baseDir,
  }) => {
    const base = scaled(1)
    const ctx = await open(
      { workbox, electronApp, evaluateInVSCode, baseDir },
      'd18-owned-x1.md',
      base,
    )
    const typed = base.replace(
      PARAGRAPH,
      `${PARAGRAPH.slice(0, 4)}k${PARAGRAPH.slice(4)}`,
    )
    await typeOne(ctx, base, 'k')
    const mark = await spyMark(ctx.kit)
    await ctx.kit.xtest.key('ctrl+z')
    await expectHostIs(ctx, base, 'owned Ctrl+Z undoes the key')
    for (const redo of ['ctrl+y', 'ctrl+shift+z']) {
      await ctx.kit.xtest.key(redo)
      await expectHostIs(ctx, typed, `owned ${redo} redoes the key`)
      await ctx.kit.workbox.waitForTimeout(UNDO_LOCK_MS)
      await ctx.kit.xtest.key('ctrl+z')
      await expectHostIs(ctx, base, `owned Ctrl+Z after ${redo}`)
    }
    await ctx.kit.workbox.waitForTimeout(NEGATIVE_MS)
    expect(await hostText(ctx)).toBe(base)
    expect(await historyCommandsSince(ctx.kit, mark), 'VMDE commands').toBe(0)
  })

  for (const factor of [1, 4, 16])
    test(`x${factor}: Ctrl+Z then q with no delay keeps q and undoes only the key before it`, async ({
      workbox,
      electronApp,
      evaluateInVSCode,
      baseDir,
    }) => {
      const base = scaled(factor)
      const ctx = await open(
        { workbox, electronApp, evaluateInVSCode, baseDir },
        `d18-owned-q-x${factor}.md`,
        base,
      )
      await typeOne(ctx, base, 'k')
      const mark = await spyMark(ctx.kit)
      await xdo(ctx.kit, ['key', '--delay', '0', 'ctrl+z', 'q'])
      await expect
        .poll(async () => oneInserted(await hostText(ctx), base, 'q'), {
          timeout: 120_000,
          message: 'q kept, k undone',
        })
        .toBe(true)
      await ctx.kit.workbox.waitForTimeout(NEGATIVE_MS)
      expect(oneInserted(await hostText(ctx), base, 'q')).toBe(true)
      expect(await historyCommandsSince(ctx.kit, mark), 'VMDE commands').toBe(0)
    })

  /** Replace All of `from` by `to` through the Find widget, then Escape; the caret goes back to PARAGRAPH. */
  async function replaceAll(ctx: Ctx, from: string, to: string, after: string) {
    // The passing kit Find leg's keys (`helpers/replace-all-xtest.ts`), caret after `Pzwr`.
    await replaceAllByKeys(
      ctx,
      { needle: PARAGRAPH, offset: 4 },
      from,
      to,
      after,
    )
    await ctx.kit.workbox.waitForTimeout(UNDO_LOCK_MS)
  }

  /** Saves the document through VS Code; `times` overlapping saves are started together. */
  const saveDocument = (ctx: Ctx, times = 1) =>
    ctx.kit.host(
      async (vscode, [fsPath, count]: [string, number]) => {
        const document = vscode.workspace.textDocuments.find(
          (candidate) => candidate.uri.fsPath === fsPath,
        )
        if (!document) return
        await Promise.all(Array.from({ length: count }, () => document.save()))
      },
      [ctx.file, times] as [string, number],
    )

  /** The disk holds `expected` (the file's bytes as read from the file system). */
  const expectDisk = (ctx: Ctx, expected: string, message: string) =>
    expect
      .poll(() => readFileSync(ctx.file, 'utf8') === expected, {
        timeout: 60_000,
        message,
      })
      .toBe(true)

  /** Replace All, then a Save: the disk holds the replaced bytes, so a later Save must change them. */
  async function replacedOnDisk(ctx: Ctx, base: string) {
    const after = base.replaceAll(REPLACE_TOKEN, 'ZZZZ')
    await replaceAll(ctx, REPLACE_TOKEN, 'ZZZZ', after)
    await saveDocument(ctx)
    await expectDisk(ctx, after, 'the replaced bytes are on disk first')
    return after
  }

  for (const inEditor of [true, false])
    test(`x4: Save during a sliced replay of Replace All writes the undone bytes over different disk bytes (inEditor ${inEditor})`, async ({
      workbox,
      electronApp,
      evaluateInVSCode,
      baseDir,
    }) => {
      const base = scaled(4)
      const ctx = await open(
        { workbox, electronApp, evaluateInVSCode, baseDir },
        `d18-owned-save-x4-${inEditor ? 'on' : 'off'}.md`,
        base,
      )
      if (!inEditor) await setUndoSetting(ctx.kit, 'inEditor', false)
      await replacedOnDisk(ctx, base)
      const willBefore = (await hostState(ctx)).willSaves.length
      const mark = await spyMark(ctx.kit)
      await ctx.kit.xtest.key('ctrl+z')
      // With ownership off the Undo runs at command time (K8): a Save sent before the command reaches the
      // editor saves the text before the Undo, by design. So the Save waits for the command to arrive;
      // the replay's slices still run then.
      if (!inEditor)
        await expect
          .poll(() => historyCommandsSince(ctx.kit, mark), {
            timeout: 30_000,
            message: 'the Undo command reached the editor',
          })
          .toBe(1)
      // Save at once, while the replay's slices still run: the flush answers after them.
      await saveDocument(ctx)
      await expectHostIs(ctx, base, 'Undo restored Replace All')
      await expectDisk(ctx, base, 'disk bytes are the undone text')
      const state = await hostState(ctx)
      expect(
        state.willSaves.length,
        'the will-save of the Save ran',
      ).toBeGreaterThan(willBefore)
      expect(state.dirty, 'clean at the saved bytes').toBe(false)
      expect(await historyCommandsSince(ctx.kit, mark), 'VMDE commands').toBe(
        inEditor ? 0 : 1,
      )
    })

  test('x4: Replace All, Undo, type at once, Save, close and reopen: disk and editor hold the undone text plus the key', async ({
    workbox,
    electronApp,
    evaluateInVSCode,
    baseDir,
  }) => {
    const base = scaled(4)
    const ctx = await open(
      { workbox, electronApp, evaluateInVSCode, baseDir },
      'd18-owned-reopen-x4.md',
      base,
    )
    await replacedOnDisk(ctx, base)
    await xdo(ctx.kit, ['key', '--delay', '0', 'ctrl+z', 'q'])
    await saveDocument(ctx)
    await expect
      .poll(async () => oneInserted(await hostText(ctx), base, 'q'), {
        timeout: 120_000,
        message: 'the undone text plus q',
      })
      .toBe(true)
    await saveDocument(ctx)
    await expect
      .poll(() => oneInserted(readFileSync(ctx.file, 'utf8'), base, 'q'), {
        timeout: 60_000,
        message: 'disk: the undone text plus q',
      })
      .toBe(true)
    const saved = readFileSync(ctx.file, 'utf8')
    await closeAll(ctx.kit, ctx.file)
    await openEditor(ctx)
    expect(readFileSync(ctx.file, 'utf8') === saved, 'disk after reopen').toBe(
      true,
    )
    await expectHostIs(ctx, saved, 'the reopened editor holds the saved bytes')
  })

  test('x4: a second Ctrl+Z during the replay supersedes it; Save writes the original bytes', async ({
    workbox,
    electronApp,
    evaluateInVSCode,
    baseDir,
  }) => {
    const base = scaled(4)
    const ctx = await open(
      { workbox, electronApp, evaluateInVSCode, baseDir },
      'd18-owned-supersede-x4.md',
      base,
    )
    const once = base.replaceAll(REPLACE_TOKEN, 'ZZZZ')
    await replaceAll(ctx, REPLACE_TOKEN, 'ZZZZ', once)
    await replaceAll(ctx, 'ZZZZ', 'YYYY', once.replaceAll('ZZZZ', 'YYYY'))
    await saveDocument(ctx)
    const mark = await spyMark(ctx.kit)
    await xdo(ctx.kit, ['key', '--delay', '0', 'ctrl+z', 'ctrl+z'])
    await saveDocument(ctx)
    await expectHostIs(ctx, base, 'two Undos restore the original text')
    await saveDocument(ctx)
    await expectDisk(ctx, base, 'disk bytes are the original text')
    expect(await historyCommandsSince(ctx.kit, mark), 'VMDE commands').toBe(0)
  })

  test('x4: two overlapping Saves during the replay both finish, and the disk holds the undone bytes', async ({
    workbox,
    electronApp,
    evaluateInVSCode,
    baseDir,
  }) => {
    const base = scaled(4)
    const ctx = await open(
      { workbox, electronApp, evaluateInVSCode, baseDir },
      'd18-owned-overlap-x4.md',
      base,
    )
    await replacedOnDisk(ctx, base)
    const didBefore = (await hostState(ctx)).didSaves.length
    await ctx.kit.xtest.key('ctrl+z')
    await saveDocument(ctx, 2)
    await expectHostIs(ctx, base, 'Undo restored Replace All')
    await saveDocument(ctx)
    await expectDisk(ctx, base, 'disk bytes are the undone text')
    const state = await hostState(ctx)
    expect(state.didSaves.length).toBeGreaterThan(didBefore)
    expect(state.didSaves.at(-1) === base, 'last saved text').toBe(true)
    expect(state.dirty).toBe(false)
  })

  test('a setting chord undoes in IR; a keybindings.json binding runs at command time', async ({
    workbox,
    electronApp,
    evaluateInVSCode,
    baseDir,
  }) => {
    const base = scaled(1)
    const ctx = await open(
      { workbox, electronApp, evaluateInVSCode, baseDir },
      'd18-owned-setting.md',
      base,
    )
    await setUndoSetting(ctx.kit, 'undo', ['mod+z', SETTING_UNDO_KEY])
    const keybindings = await userKeybindingsPath(ctx.kit)
    const previous = existsSync(keybindings)
      ? readFileSync(keybindings, 'utf8')
      : null
    mkdirSync(path.dirname(keybindings), { recursive: true })
    writeFileSync(
      keybindings,
      JSON.stringify([
        {
          key: BOUND_UNDO_KEY,
          command: 'vmde.format.undo',
          when: VMDE_SHORTCUT_WHEN,
        },
      ]),
    )
    try {
      await ctx.kit.workbox.waitForTimeout(KEYBINDINGS_RELOAD_MS)
      await typeOne(ctx, base, 'k')
      let mark = await spyMark(ctx.kit)
      await ctx.kit.xtest.key(SETTING_UNDO_KEY)
      await expectHostIs(ctx, base, 'the setting chord undoes')
      expect(await historyCommandsSince(ctx.kit, mark), 'setting chord').toBe(0)

      await typeOne(ctx, base, 'k')
      mark = await spyMark(ctx.kit)
      await ctx.kit.xtest.key(BOUND_UNDO_KEY)
      await expectHostIs(ctx, base, 'the keybinding undoes at command time')
      expect(await historyCommandsSince(ctx.kit, mark), 'bound key').toBe(1)
    } finally {
      if (previous === null) writeFileSync(keybindings, '[]')
      else writeFileSync(keybindings, previous)
    }
  })

  test('with inEditor off, Ctrl+Z runs the VMDE command again', async ({
    workbox,
    electronApp,
    evaluateInVSCode,
    baseDir,
  }) => {
    const base = scaled(1)
    const ctx = await open(
      { workbox, electronApp, evaluateInVSCode, baseDir },
      'd18-owned-off.md',
      base,
    )
    await setUndoSetting(ctx.kit, 'inEditor', false)
    await typeOne(ctx, base, 'k')
    const mark = await spyMark(ctx.kit)
    await ctx.kit.xtest.key('ctrl+z')
    await expectHostIs(ctx, base, 'Ctrl+Z through the command')
    expect(await historyCommandsSince(ctx.kit, mark), 'VMDE commands').toBe(1)
  })
})
