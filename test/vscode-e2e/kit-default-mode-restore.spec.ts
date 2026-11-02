/**
 * Task 689 — the XTEST kit puts the user-global `vmde.editor.defaultMode` back.
 *
 * `makeKit` sets the setting to `ir`. The user data directory is shared by every test of a worker, so
 * the value must not outlive the test that set it. The three tests run in file order on one worker:
 *
 * 1. A kit test that opens a document straight in `sv` (the direct-open helper sets and restores the
 *    setting on its own): after the open the setting is the kit's `ir` again.
 * 2. The next test starts with the setting unset, in the host and in the user `settings.json`, which
 *    proves test 1's kit restored the value (`afterEach(restoreKitSettings)`).
 * 3. `disposeKit` puts back a value that was set before `makeKit`.
 *
 * Keys come from the kit's XTEST input, so the spec needs `VMDE_XTEST=1` like the other kit users.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import {
  disposeKit,
  type Kit,
  makeKit,
  openDocument,
  restoreKitSettings,
} from './helpers/shortcut-xtest-kit'

const LABEL = 'kit-default-mode'
const DOC = 'Heading\n\nA paragraph of text.\n'

const globalDefaultMode = (kit: Pick<Kit, 'host'>) =>
  kit.host(async (vscode) => {
    const inspected = vscode.workspace
      .getConfiguration('vmde')
      .inspect<string>('editor.defaultMode')
    return inspected?.globalValue ?? null
  }, [])

// The raw text of the worker's user `settings.json` (empty when the file does not exist).
const userSettingsText = async (kit: Pick<Kit, 'electronApp'>) => {
  const userData = await kit.electronApp.evaluate(({ app }) =>
    app.getPath('userData'),
  )
  try {
    return readFileSync(path.join(userData, 'User', 'settings.json'), 'utf8')
  } catch {
    return ''
  }
}

test.describe('Task 689 the kit restores the global default mode (OS-level XTEST)', () => {
  test.skip(
    process.env.VMDE_XTEST !== '1',
    'requires isolated Xvfb/Openbox XTEST',
  )

  test.afterEach(restoreKitSettings)

  test('1: a kit test with a direct-open document ends with the kit value, so the direct-open helper restored its own', async ({
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
      LABEL,
    )
    expect(await globalDefaultMode(kit)).toBe('ir')
    await openDocument(kit, 'direct-sv.md', DOC, 'sv', { direct: true })
    expect(await globalDefaultMode(kit)).toBe('ir')
  })

  test('2: the next test starts with the setting unset, in the host and in settings.json', async ({
    electronApp,
    evaluateInVSCode,
  }) => {
    const probe = { host: evaluateInVSCode } as Pick<Kit, 'host'>
    expect(await globalDefaultMode(probe)).toBeNull()
    expect(await userSettingsText({ electronApp })).not.toContain(
      'vmde.editor.defaultMode',
    )
  })

  test('3: disposeKit puts back a value that was set before makeKit', async ({
    workbox,
    electronApp,
    evaluateInVSCode,
    baseDir,
  }) => {
    test.setTimeout(300_000)
    await evaluateInVSCode(async (vscode) => {
      await vscode.workspace
        .getConfiguration('vmde')
        .update('editor.defaultMode', 'wysiwyg', true)
    })
    try {
      const kit = await makeKit(
        workbox,
        electronApp,
        evaluateInVSCode,
        baseDir,
        LABEL,
      )
      expect(await globalDefaultMode(kit)).toBe('ir')
      await disposeKit(kit)
      expect(await globalDefaultMode(kit)).toBe('wysiwyg')
    } finally {
      await evaluateInVSCode(async (vscode) => {
        await vscode.workspace
          .getConfiguration('vmde')
          .update('editor.defaultMode', undefined, true)
      })
    }
  })
})
