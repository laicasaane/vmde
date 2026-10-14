/**
 * Task 638 — the wiki page list is kept across restarts, in the real VS Code webview.
 *
 * Contract (tasks/638-persistent-wiki-page-cache.md, "Part 1 handoff"): the host stores the page
 * list per wiki root in workspace state. On the first open after a restart `init` already carries
 * the stored keys (acceptance 1, no pending-keys state), the usual background scan revalidates them
 * and posts a `wiki-update` only when the list changed (acceptance 2), pages added, removed and
 * renamed while the editor was closed are corrected by that update with no edit, no dirty state and
 * no Undo entry (acceptance 3), and disabling the wiki clears the stored list (acceptance 4). The
 * bounds and the schema version (acceptance 5) are covered by Vitest.
 *
 * How a "restart" is modelled. The harness's `electronApp` launches VS Code with
 * `--extensionTestsPath`, and VS Code then keeps workspace storage in memory only (its storage
 * service sets `useInMemoryStorage` when an extension-tests location is given; observed: the
 * workspace storage folder never gets a `state.vscdb`, even after a window close), and neither
 * `Restart Extension Host` nor `Reload Window` can stand in for a restart there (the first does
 * nothing, the second ends the application). So this spec does not use the `electronApp` fixture: it
 * launches VS Code itself, without `--extensionTestsPath` and with `--extensionDevelopmentPath`, on
 * the harness's installed VS Code and its user-data directory, four times on the same workspace
 * folder. That is a real restart, with the on-disk workspace state. Without the harness's injected
 * channel there is no `evaluateInVSCode`, so everything goes through the UI, the file system and the
 * webview. The pages on disk and the setting file change between launches, so the changes happen
 * while no VS Code is running.
 *
 * One test case with one launch per state, because every launch builds on the stored list left by
 * the one before and a VS Code launch is the expensive unit. Observation (read-only): a
 * document-start script on the workbench page records, in every webview frame, each host-to-webview
 * message in order (with its key list) and each chip carrying `data-wiki-missing` with the message
 * count at that moment, so styling before the `wiki-update` is caught. Keys are XTEST
 * (`helpers/xtest-input.ts`; needs `VMDE_XTEST=1` and a window manager on the display, see
 * docs/os-keyboard-testing-setup.md). The Ctrl+Z step records the trusted `keydown` it produced, so
 * a chord that never reached the webview fails instead of passing vacuously. Page names are
 * synthetic.
 */
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import {
  type ElectronApplication,
  _electron,
  type Page,
} from '@playwright/test'
import { expect, test as base } from 'vscode-test-playwright'
import { createXtestInput } from './helpers/xtest-input'
import { settle, waitForE2EReadiness, wf } from './webview-helpers'

const DOC_NAME = 'links.md'
const LINKS = [
  'home',
  'kept',
  'removed-page',
  'old-name',
  'added-page',
  'new-name',
  'no-such-page',
]
const DOC = [
  '# Persistent wiki keys',
  '',
  `Pages: ${LINKS.map((link) => `[[${link}]]`).join(' ')}`,
  '',
  'Tail paragraph.',
  '',
].join('\n')

// Pages on disk. The first open sees FIRST_PAGES; the restart after it adds `added-page`, removes
// `removed-page` and renames `old-name` to `new-name` (CHANGED_PAGES).
const FIRST_PAGES = ['home', 'kept', 'removed-page', 'old-name']
const CHANGED_PAGES = ['added-page', 'home', 'kept', 'new-name']
// The document itself is a page of the folder, so its key is always in the list.
const keysOf = (pages: string[]) =>
  [...pages, DOC_NAME.replace('.md', '')].sort()
// Expected `data-wiki-missing` per chip when `pages` exist.
const missingFor = (pages: string[]) =>
  Object.fromEntries(LINKS.map((link) => [link, !pages.includes(link)]))
const UNSTYLED = Object.fromEntries(LINKS.map((link) => [link, false]))

const writePage = (dir: string, name: string) =>
  writeFileSync(path.join(dir, `${name}.md`), `# ${name}\n`)

interface HostMessage {
  command: string
  type: string | null
  // The key list on an `init`'s wiki context or on a `wiki-update`; null when the message has none.
  keys: string[] | null
}

interface Probe {
  messages: HostMessage[]
  // `wiki-update` messages the probe is holding back from the editor (see probeScript).
  held: number
  keydowns: { key: string; ctrl: boolean; trusted: boolean }[]
}

// Runs at document start in every frame of the workbench page; only child frames record. The
// webview's content frame starts as `about:blank` and its document is replaced afterwards, which
// drops the listeners, so a 1 ms timer (it survives the replacement) installs them again on every
// new root element.
//
// With `hold`, a `wiki-update` is recorded and kept back from the editor until the test releases it
// (`__wikiPersistRelease`, which delivers it again as an ordinary message). In the harness the
// revalidating scan finishes within a fraction of a second, usually before the editor has drawn its
// first chip, so the state before the update would otherwise never be observable. Holding changes
// only when the update is handled, not what it carries.
function probeScript(hold: boolean) {
  if (window.top === window) return
  const store: Probe = { messages: [], held: 0, keydowns: [] }
  const heldMessages: unknown[] = []
  let releasing = false
  const w = window as unknown as {
    __wikiPersistProbe: Probe
    __wikiPersistRelease: () => void
  }
  w.__wikiPersistProbe = store
  w.__wikiPersistRelease = () => {
    releasing = true
    for (const data of heldMessages.splice(0))
      window.dispatchEvent(new MessageEvent('message', { data }))
    releasing = false
    store.held = 0
  }
  const onMessage = (event: MessageEvent) => {
    if (releasing) return
    const data = event.data as {
      command?: string
      type?: string
      pageKeys?: unknown
      wiki?: { pageKeys?: unknown }
    } | null
    if (!data || typeof data !== 'object' || !data.command) return
    const keys = data.pageKeys ?? data.wiki?.pageKeys
    store.messages.push({
      command: data.command,
      type: data.type ?? null,
      keys: Array.isArray(keys) ? (keys as string[]) : null,
    })
    if (hold && data.command === 'wiki-update') {
      heldMessages.push(data)
      store.held = heldMessages.length
      event.stopImmediatePropagation()
    }
  }
  const onKeydown = (event: KeyboardEvent) =>
    store.keydowns.push({
      key: event.key,
      ctrl: event.ctrlKey,
      trusted: event.isTrusted,
    })
  let installedOn: Element | null = null
  setInterval(() => {
    const root = document.documentElement
    if (!root || root === installedOn) return
    installedOn = root
    // Capture phase on the window runs before the editor's own bubble-phase listener.
    window.addEventListener('message', onMessage, true)
    window.addEventListener('keydown', onKeydown, true)
  }, 1)
}

const readProbe = (frame: ReturnType<typeof wf>) =>
  frame
    .locator('body')
    .evaluate(
      () =>
        (window as unknown as { __wikiPersistProbe?: Probe })
          .__wikiPersistProbe ?? null,
    )

const readChips = (frame: ReturnType<typeof wf>) =>
  frame
    .locator('body')
    .evaluate(() =>
      Object.fromEntries(
        Array.from(
          document.querySelectorAll('.vditor-ir .wiki-link-chip'),
          (chip) => [
            chip.getAttribute('data-wiki-target') ?? '',
            chip.hasAttribute('data-wiki-missing'),
          ],
        ),
      ),
    )

interface Install {
  installPath: string
  cachePath: string
}

// Launches the installed VS Code like the harness does, except for `--extensionTestsPath` (see the
// header), on the harness's user-data directory so workspace state outlives the process.
async function launchVSCode(
  install: Install,
  extensionDevelopmentPath: string,
  workspaceDir: string,
) {
  const env = { ...process.env }
  // Any VSCODE_* variable of the parent breaks custom webviews (as in the harness's own launch).
  for (const name of Object.keys(env))
    if (/^VSCODE_/i.test(name)) delete env[name]
  return _electron.launch({
    executablePath: install.installPath,
    env,
    args: [
      '--no-sandbox',
      '--disable-gpu-sandbox',
      '--disable-updates',
      '--ozone-platform=x11',
      '--skip-welcome',
      '--skip-release-notes',
      '--disable-workspace-trust',
      `--extensions-dir=${path.join(install.cachePath, 'extensions')}`,
      `--user-data-dir=${path.join(install.cachePath, 'user-data')}`,
      `--extensionDevelopmentPath=${extensionDevelopmentPath}`,
      workspaceDir,
    ],
  })
}

// Opens the document through Quick Open, as a user does after a restart, and waits until the editor
// is ready.
async function openByQuickOpen(workbox: Page) {
  await workbox.locator('.monaco-workbench').waitFor({ timeout: 60_000 })
  await workbox.keyboard.press('Control+P')
  await workbox.keyboard.type(DOC_NAME)
  // Enter before the file list is ready would pick nothing.
  await workbox
    .locator('.quick-input-list .monaco-list-row')
    .filter({ hasText: DOC_NAME })
    .first()
    .waitFor({ timeout: 30_000 })
  await workbox.keyboard.press('Enter')
  const frame = wf(workbox)
  await frame.locator('.vditor-ir').first().waitFor({ timeout: 60_000 })
  await waitForE2EReadiness(
    frame,
    (state) => state.routerReady && state.editorEpoch > 0,
  )
  return frame
}

// The file is byte-identical and no tab shows a dirty marker.
async function expectUntouched(workbox: Page, doc: string) {
  expect(readFileSync(doc, 'utf8')).toBe(DOC)
  await expect(
    workbox.locator('.editor-group-container .tab.dirty'),
  ).toHaveCount(0)
}

// Writes the workspace settings file, the file the settings UI writes.
const writeSettings = (dir: string, wikiEnabled: boolean) =>
  writeFileSync(
    path.join(dir, '.vscode', 'settings.json'),
    `${JSON.stringify(
      {
        'vmde.wiki.enabled': wikiEnabled,
        // Quick Open opens the document in this extension's editor.
        'workbench.editorAssociations': { '*.md': 'vmde.editor' },
      },
      null,
      2,
    )}\n`,
  )

const waitForChips = (
  frame: ReturnType<typeof wf>,
  expected: Record<string, boolean>,
  message: string,
) =>
  expect
    .poll(() => readChips(frame), { timeout: 30_000, message })
    .toEqual(expected)

const initOf = (probe: Probe | null) =>
  (probe?.messages ?? []).find(
    (message) => message.command === 'update' && message.type === 'init',
  )
const wikiUpdatesOf = (probe: Probe | null) =>
  (probe?.messages ?? []).filter((message) => message.command === 'wiki-update')
const releaseHeldUpdate = (frame: ReturnType<typeof wf>) =>
  frame
    .locator('body')
    .evaluate(() =>
      (
        window as unknown as { __wikiPersistRelease: () => void }
      ).__wikiPersistRelease(),
    )

// The folder VS Code opens as the workspace, filled before it opens (settings are read at open).
const test = base.extend({
  baseDir: async ({ _createTempDir }, use) => {
    // The harness's own temp-dir factory removes the folder when the worker ends.
    const dir = await _createTempDir()
    for (const name of FIRST_PAGES) writePage(dir, name)
    writeFileSync(path.join(dir, DOC_NAME), DOC)
    mkdirSync(path.join(dir, '.vscode'), { recursive: true })
    writeSettings(dir, true)
    await use(dir)
  },
})

// One VS Code launch: runs `body` on the first window, then closes the application (which writes
// the workspace state). The init script records host messages in every webview frame of the launch.
async function launch(
  install: Install,
  extensionDevelopmentPath: string,
  dir: string,
  hold: boolean,
  body: (app: ElectronApplication, workbox: Page) => Promise<void>,
) {
  const app = await launchVSCode(install, extensionDevelopmentPath, dir)
  try {
    await app.context().addInitScript(probeScript, hold)
    await body(app, await app.firstWindow())
  } finally {
    await app.close()
  }
}

test('a stored wiki page list is served after a restart and revalidated; disabling the wiki clears it', async ({
  _vscodeInstall,
  extensionDevelopmentPath,
  baseDir,
}) => {
  test.setTimeout(400_000)
  const docPath = path.join(baseDir, DOC_NAME)
  const run = (
    hold: boolean,
    body: (app: ElectronApplication, workbox: Page) => Promise<void>,
  ) =>
    launch(
      _vscodeInstall,
      extensionDevelopmentPath as string,
      baseDir,
      hold,
      body,
    )
  const heldUpdate = (frame: ReturnType<typeof wf>) =>
    expect
      .poll(async () => (await readProbe(frame))?.held, {
        timeout: 30_000,
        message: 'the wiki-update reached the webview and is held',
      })
      .toBe(1)

  await test.step('first launch, no stored list: init has no keys, one wiki-update delivers them and the list is stored', () =>
    run(false, async (_app, workbox) => {
      const frame = await openByQuickOpen(workbox)
      await waitForChips(
        frame,
        missingFor(FIRST_PAGES),
        'chips follow the pages',
      )
      const probe = await readProbe(frame)
      expect(
        initOf(probe)?.keys,
        'no stored list, so no keys in init',
      ).toBeNull()
      const updates = wikiUpdatesOf(probe)
      expect(updates).toHaveLength(1)
      expect(updates[0].keys).toEqual(keysOf(FIRST_PAGES))
    }))

  // The pages change while VS Code is closed.
  writePage(baseDir, 'added-page')
  rmSync(path.join(baseDir, 'removed-page.md'))
  renameSync(
    path.join(baseDir, 'old-name.md'),
    path.join(baseDir, 'new-name.md'),
  )

  await test.step('second launch, pages changed while closed: init carries the stored keys, one wiki-update corrects them (acceptance 1, 2, 3)', () =>
    run(true, async (app, workbox) => {
      const frame = await openByQuickOpen(workbox)
      await heldUpdate(frame)

      // Acceptance 1: the init already carried the list stored by the first launch (not the
      // changed pages), so there was no pending-keys state, and with the update held back the chips
      // are styled from that stored list alone.
      const probe = await readProbe(frame)
      expect(initOf(probe)?.keys, 'init carries the stored keys').toEqual(
        keysOf(FIRST_PAGES),
      )
      expect(
        await readChips(frame),
        'chips styled from the stored list before the update',
      ).toEqual(missingFor(FIRST_PAGES))

      // Acceptance 2: the list changed, so exactly one wiki-update, after the init, with the new
      // list.
      const updates = wikiUpdatesOf(probe)
      expect(updates, 'one wiki-update').toHaveLength(1)
      expect(updates[0].keys).toEqual(keysOf(CHANGED_PAGES))
      expect(probe?.messages.indexOf(updates[0])).toBeGreaterThan(
        probe?.messages.indexOf(initOf(probe) as HostMessage) ??
          Number.MAX_VALUE,
      )

      // Acceptance 3: the update corrects the chips, by attributes only. File bytes are unchanged,
      // no tab is dirty, and an OS-level Ctrl+Z changes nothing (no Undo entry).
      await releaseHeldUpdate(frame)
      await waitForChips(
        frame,
        missingFor(CHANGED_PAGES),
        'chips follow the pages changed while closed',
      )
      await expectUntouched(workbox, docPath)
      const xtest = await createXtestInput(app, workbox)
      await frame.locator('.vditor-ir').getByText('Tail paragraph.').click()
      await xtest.key('ctrl+z')
      // Negative observation: nothing is expected to happen, so there is no condition to poll for.
      await settle(frame, 1000)
      expect(
        (await readProbe(frame))?.keydowns.filter(
          (key) => key.ctrl && key.key === 'z' && key.trusted,
        ),
        'the OS-level Ctrl+Z reached the webview',
      ).toHaveLength(1)
      await expectUntouched(workbox, docPath)
      expect(await readChips(frame)).toEqual(missingFor(CHANGED_PAGES))
    }))

  await test.step('third launch, pages unchanged: init carries the stored keys and no wiki-update follows (acceptance 1, 2); disabling the wiki clears the list (acceptance 4)', () =>
    run(true, async (_app, workbox) => {
      const frame = await openByQuickOpen(workbox)

      await waitForChips(
        frame,
        missingFor(CHANGED_PAGES),
        'chips follow the stored list',
      )
      // Negative observation: leave time for the revalidating scan, which finishes within a
      // fraction of a second of the init in the harness (the launches around it saw it well inside
      // this window).
      await settle(frame, 3000)
      const probe = await readProbe(frame)
      expect(initOf(probe)?.keys).toEqual(keysOf(CHANGED_PAGES))
      expect(
        wikiUpdatesOf(probe),
        'the scan found nothing new, so no wiki-update',
      ).toEqual([])

      // Acceptance 4: disabling the wiki (the settings file, as the settings UI writes it) clears
      // the stored list; the fourth launch proves it.
      writeSettings(baseDir, false)
      await waitForChips(frame, {}, 'a disabled wiki shows no wiki chip')
      await settle(frame, 1000)
    }))

  // The wiki is enabled again while VS Code is closed, so nothing rebuilds the list.
  writeSettings(baseDir, true)

  await test.step('fourth launch, wiki enabled again after the list was cleared: init is pending again (acceptance 4)', () =>
    run(true, async (_app, workbox) => {
      const frame = await openByQuickOpen(workbox)
      await heldUpdate(frame)

      const probe = await readProbe(frame)
      expect(
        initOf(probe)?.keys,
        'the stored list was cleared, so init is pending',
      ).toBeNull()
      expect(
        await readChips(frame),
        'pending means unstyled before the update',
      ).toEqual(UNSTYLED)
      const updates = wikiUpdatesOf(probe)
      expect(updates).toHaveLength(1)
      expect(updates[0].keys).toEqual(keysOf(CHANGED_PAGES))

      await releaseHeldUpdate(frame)
      await waitForChips(
        frame,
        missingFor(CHANGED_PAGES),
        'chips follow the pages',
      )
    }))
})
