/**
 * Task 637 — an open editor gets the new wiki page keys after a wiki setting changes, in the real
 * VS Code webview.
 *
 * Contract (tasks/done/637-wiki-keys-after-wiki-setting-change.md, "Part 1 handoff"):
 * - C1 a changed effective root re-plans the keys for the new root; they arrive as a `wiki-update`
 *   after the `config-changed` message, and the `[[` completion lists the new root's pages.
 * - C2 the `wiki-update` always follows `config-changed`.
 * - C3 a disabled wiki posts no update and leaves no missing styling; re-enabling delivers keys.
 * - C5 a re-init caused by an enabled flip does not reuse the keys of the previous root: chips are
 *   not marked until the host's `wiki-update` arrives.
 * - C6 a root change keeps the old styling until the new keys arrive.
 * - C7 the restyle is by attributes only: host text and file bytes unchanged, no dirty state, no
 *   Undo entry.
 * - C8 the real file watcher engine delivers create events for a lower-case page and an upper-case
 *   `.MD` page (the page glob uses `[mM][dD]` classes), and a created page under `node_modules` or a
 *   `files.exclude` glob adds no key.
 *
 * Settings are changed through the configuration API, as the settings UI does. Observation: a
 * document-start script on the workbench page records, in every webview frame, each host message and
 * each chip carrying `data-wiki-missing` (with the message count at that moment). Keys are XTEST
 * (`helpers/xtest-input.ts`; needs `VMDE_XTEST=1` and a window manager on the display, see
 * docs/os-keyboard-testing-setup.md). Chip states are the oracle for the keys; the host messages
 * order the events.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test as base } from 'vscode-test-playwright'
import { createXtestInput } from './helpers/xtest-input'
import {
  ExtensionId,
  settle,
  waitForE2EReadiness,
  waitForInitialUndoSnapshot,
  wf,
} from './webview-helpers'

const DOC_NAME = 'links.md'
const BASE_LINKS = ['home', 'alpha', 'gamma', 'no-such-page']
// Pages created on disk by the watcher test: two that must become keys, two that must not.
const WATCHED_LINKS = ['fresh', 'shouty', 'in-modules', 'in-skipped']

const docWith = (links: string[]) =>
  [
    '# Wiki keys after a setting change',
    '',
    `Pages: ${links.map((link) => `[[${link}]]`).join(' ')}`,
    '',
    'Tail paragraph.',
    '',
  ].join('\n')

interface Workspace {
  dir: string
  doc: string
  text: string
}

// Folders: top-level `home`, `alpha` (alpha, notes), `gamma` (gamma, an upper-case `.MD` page, extra).
// The key of `alpha/alpha.md` is `alpha`, so the `alpha` and `gamma` links are keys only under their
// own root (or under the workspace root).
function makeWorkspace(
  dir: string,
  settings: Record<string, unknown>,
  links: string[],
): Workspace {
  const page = (relative: string, title: string) => {
    mkdirSync(path.dirname(path.join(dir, relative)), { recursive: true })
    writeFileSync(path.join(dir, relative), `# ${title}\n`)
  }
  page('home.md', 'Home')
  page('alpha/alpha.md', 'Alpha')
  page('alpha/notes.md', 'Notes')
  page('gamma/gamma.md', 'Gamma')
  page('gamma/Loud.MD', 'Loud')
  page('gamma/extra.md', 'Extra')
  // Empty folders for the watcher test: created before launch so the watcher sees only the files.
  mkdirSync(path.join(dir, 'gamma/node_modules'), { recursive: true })
  mkdirSync(path.join(dir, 'gamma/skipped'), { recursive: true })
  mkdirSync(path.join(dir, '.vscode'), { recursive: true })
  writeFileSync(
    path.join(dir, '.vscode', 'settings.json'),
    `${JSON.stringify(settings, null, 2)}\n`,
  )
  const text = docWith(links)
  const doc = path.join(dir, DOC_NAME)
  writeFileSync(doc, text)
  return { dir, doc, text }
}

// Each test gets its own workspace, created before VS Code opens it (the harness's own temp-dir
// factory removes the folder when the worker ends).
const workspaceTest = (settings: Record<string, unknown>, links: string[]) =>
  base.extend<{ workspace: Workspace }>({
    baseDir: async ({ _createTempDir }, use) => {
      const dir = await _createTempDir()
      makeWorkspace(dir, settings, links)
      await use(dir)
    },
    workspace: async ({ baseDir }, use) =>
      use({
        dir: baseDir,
        doc: path.join(baseDir, DOC_NAME),
        text: docWith(links),
      }),
  })

const rootsTest = workspaceTest(
  { 'vmde.wiki.enabled': true, 'vmde.wiki.root': 'alpha' },
  BASE_LINKS,
)
const togglesTest = workspaceTest(
  { 'vmde.wiki.enabled': false, 'vmde.wiki.root': 'alpha' },
  BASE_LINKS,
)
const watcherTest = workspaceTest(
  {
    'vmde.wiki.enabled': true,
    'vmde.wiki.root': 'alpha',
    'files.exclude': { 'gamma/skipped/**': true },
  },
  [...BASE_LINKS, ...WATCHED_LINKS],
)

// Expected `data-wiki-missing` state per chip target, per effective root. `alpha` and `gamma` are
// keys only under their own root or the workspace root; `home` only at the workspace root.
const missingStates = (present: string[], links = BASE_LINKS) =>
  Object.fromEntries(links.map((link) => [link, !present.includes(link)]))
const UNDER_ALPHA = missingStates(['alpha'])
const UNDER_WORKSPACE = missingStates(['home', 'alpha', 'gamma'])
const UNDER_MISSING_ROOT = missingStates([])
const UNDER_GAMMA = missingStates(['gamma'])

interface HostMessage {
  command: string
  type: string | null
}

interface Probe {
  messages: HostMessage[]
  marks: { target: string | null; messagesSeen: number }[]
  keydowns: { key: string; ctrl: boolean; trusted: boolean }[]
}

// Runs at document start in every frame of the workbench page; only child frames record. The
// webview's content frame starts as `about:blank` and its document is replaced afterwards, which
// drops the listeners and the observer, so a 1 ms timer (it survives the replacement) installs them
// again on every new root element.
function probeScript() {
  if (window.top === window) return
  const store: Probe = { messages: [], marks: [], keydowns: [] }
  ;(window as unknown as { __wikiKeysProbe: Probe }).__wikiKeysProbe = store
  const onMessage = (event: MessageEvent) => {
    const data = event.data as { command?: string; type?: string } | null
    if (data && typeof data === 'object' && data.command)
      store.messages.push({ command: data.command, type: data.type ?? null })
  }
  const onKeydown = (event: KeyboardEvent) =>
    store.keydowns.push({
      key: event.key,
      ctrl: event.ctrlKey,
      trusted: event.isTrusted,
    })
  const noteMarked = (node: Node) => {
    if (!(node instanceof Element)) return
    const chips = node.matches('.wiki-link-chip')
      ? [node, ...node.querySelectorAll('.wiki-link-chip')]
      : Array.from(node.querySelectorAll('.wiki-link-chip'))
    for (const chip of chips)
      if (chip.hasAttribute('data-wiki-missing'))
        store.marks.push({
          target: chip.getAttribute('data-wiki-target'),
          messagesSeen: store.messages.length,
        })
  }
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      noteMarked(record.target)
      for (const added of record.addedNodes) noteMarked(added)
    }
  })
  let installedOn: Element | null = null
  setInterval(() => {
    const root = document.documentElement
    if (!root || root === installedOn) return
    installedOn = root
    window.addEventListener('message', onMessage)
    window.addEventListener('keydown', onKeydown, true)
    observer.observe(document, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['data-wiki-missing'],
    })
  }, 1)
}

const readProbe = (frame: ReturnType<typeof wf>) =>
  frame
    .locator('body')
    .evaluate(
      () =>
        (window as unknown as { __wikiKeysProbe?: Probe }).__wikiKeysProbe ??
        null,
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

type EvaluateInVSCode = <R, Arg>(
  fn: (vscode: typeof import('vscode'), arg: Arg) => Promise<R>,
  arg: Arg,
) => Promise<R>

async function openDoc(evaluateInVSCode: EvaluateInVSCode, doc: string) {
  await evaluateInVSCode(
    async (vscode: typeof import('vscode'), args: [string, string]) => {
      await vscode.extensions.getExtension(args[1])?.activate()
      await vscode.commands.executeCommand(
        'vscode.openWith',
        vscode.Uri.file(args[0]),
        'vmde.editor',
      )
    },
    [doc, ExtensionId] as [string, string],
  )
}

// Changes one wiki setting through the configuration API, the route the settings UI takes.
const setWikiSetting = (
  evaluateInVSCode: EvaluateInVSCode,
  key: 'enabled' | 'root',
  value: boolean | string,
) =>
  evaluateInVSCode(
    async (
      vscode: typeof import('vscode'),
      args: ['enabled' | 'root', boolean | string],
    ) =>
      vscode.workspace
        .getConfiguration('vmde.wiki')
        .update(args[0], args[1], vscode.ConfigurationTarget.Workspace),
    [key, value] as ['enabled' | 'root', boolean | string],
  )

const hostState = (evaluateInVSCode: EvaluateInVSCode, doc: string) =>
  evaluateInVSCode(async (vscode: typeof import('vscode'), file: string) => {
    const document = vscode.workspace.textDocuments.find(
      (item) => item.uri.fsPath === file,
    )
    return { text: document?.getText() ?? null, dirty: !!document?.isDirty }
  }, doc)

// C7: the restyle changed no host text, no file byte and no dirty state.
async function expectUntouched(
  evaluateInVSCode: EvaluateInVSCode,
  workspace: Workspace,
  step: string,
) {
  expect(
    await hostState(evaluateInVSCode, workspace.doc),
    `host document after ${step}`,
  ).toEqual({ text: workspace.text, dirty: false })
  expect(readFileSync(workspace.doc, 'utf8'), `file bytes after ${step}`).toBe(
    workspace.text,
  )
}

async function openReady(
  evaluateInVSCode: EvaluateInVSCode,
  workbox: Parameters<typeof wf>[0],
  workspace: Workspace,
) {
  await workbox.addInitScript(probeScript)
  await openDoc(evaluateInVSCode, workspace.doc)
  const frame = wf(workbox)
  await frame.locator('.vditor-ir').first().waitFor({ timeout: 60_000 })
  await waitForE2EReadiness(
    frame,
    (state) => state.routerReady && state.editorEpoch > 0,
  )
  return frame
}

const waitForChips = (
  frame: ReturnType<typeof wf>,
  expected: Record<string, boolean>,
  message: string,
) =>
  expect
    .poll(() => readChips(frame), { timeout: 30_000, message })
    .toEqual(expected)

const wikiUpdatesSince = (probe: Probe | null, from: number) =>
  (probe?.messages ?? [])
    .slice(from)
    .filter((message) => message.command === 'wiki-update').length

rootsTest(
  'root alpha, workspace root, missing root, gamma: chips and [[ completion follow each root',
  async ({ workbox, evaluateInVSCode, electronApp, workspace }) => {
    rootsTest.setTimeout(180_000)
    const frame = await openReady(evaluateInVSCode, workbox, workspace)
    await waitForChips(
      frame,
      UNDER_ALPHA,
      'chips follow the opening root alpha',
    )
    await expectUntouched(evaluateInVSCode, workspace, 'open')

    // Each step: C1 the keys of the new root arrive (chip states), C2 as one `wiki-update` that
    // follows `config-changed`, C7 host text, file bytes and dirty state unchanged.
    const steps: [string, Record<string, boolean>][] = [
      ['', UNDER_WORKSPACE],
      ['gam', UNDER_MISSING_ROOT],
      ['gamma', UNDER_GAMMA],
    ]
    for (const [root, expected] of steps) {
      const before = (await readProbe(frame))?.messages.length ?? 0
      await setWikiSetting(evaluateInVSCode, 'root', root)
      await waitForChips(frame, expected, `chips follow root "${root}"`)
      const probe = await readProbe(frame)
      const after = probe?.messages.slice(before) ?? []
      const configIndex = after.findIndex(
        (message) => message.command === 'config-changed',
      )
      const updateIndex = after.findIndex(
        (message) => message.command === 'wiki-update',
      )
      expect(
        configIndex,
        `config-changed after root "${root}"`,
      ).toBeGreaterThanOrEqual(0)
      expect(
        updateIndex,
        `wiki-update follows config-changed for root "${root}"`,
      ).toBeGreaterThan(configIndex)
      expect(
        wikiUpdatesSince(probe, before),
        `one wiki-update for root "${root}"`,
      ).toBe(1)
      await expectUntouched(evaluateInVSCode, workspace, `root "${root}"`)
    }

    // Ctrl+Z (XTEST) after the changes changes nothing: the restyles left no Undo entry. The
    // recorded trusted `keydown` shows the chord reached the webview.
    await waitForInitialUndoSnapshot(frame)
    const xtest = await createXtestInput(electronApp, workbox)
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
    await expectUntouched(evaluateInVSCode, workspace, 'Ctrl+Z')
    expect(await readChips(frame)).toEqual(UNDER_GAMMA)

    // C1: `[[` completion lists the gamma root's pages (including the upper-case `.MD` one) and
    // none of the alpha or workspace-root pages.
    await frame.locator('body').evaluate(() => {
      const paragraph = Array.from(
        document.querySelectorAll<HTMLElement>('.vditor-ir .vditor-reset > p'),
      ).find((item) => item.textContent?.includes('Tail paragraph.'))
      const text = paragraph?.firstChild
      if (!paragraph || !text) throw new Error('Tail paragraph is unavailable')
      const range = document.createRange()
      range.setStart(text, text.textContent?.length ?? 0)
      range.collapse(true)
      const selection = window.getSelection()
      selection?.removeAllRanges()
      selection?.addRange(range)
    })
    await xtest.type(' [[')
    const rows = frame.locator('.vditor-hint[style*="display: block"] button')
    await expect
      .poll(async () => (await rows.allInnerTexts()).length, {
        timeout: 15_000,
      })
      .toBeGreaterThan(0)
    const names = (await rows.allInnerTexts()).map((name) => name.trim())
    // eslint-disable-next-line no-console
    console.log(`[wiki-keys-after-setting] hint=${JSON.stringify(names)}`)
    const lower = names.map((name) => name.toLowerCase())
    expect(lower, 'pages of the new root are listed').toEqual(
      expect.arrayContaining(['gamma', 'loud', 'extra']),
    )
    for (const stale of ['notes', 'home', 'links'])
      expect(lower, `${stale} is not a page of the gamma root`).not.toContain(
        stale,
      )
    expect(names.join('\n')).not.toMatch(/Loading pages/)
  },
)

togglesTest(
  'wiki disabled, enabled, disabled, re-enabled: no stale keys, pending until wiki-update',
  async ({ workbox, evaluateInVSCode, workspace }) => {
    togglesTest.setTimeout(180_000)
    const frame = await openReady(evaluateInVSCode, workbox, workspace)
    // Negative observation: leave time for a scan that would run if the wiki were enabled.
    await settle(frame, 3000)
    let probe = await readProbe(frame)
    expect(wikiUpdatesSince(probe, 0), 'disabled at open: no wiki-update').toBe(
      0,
    )
    expect(
      Object.values(await readChips(frame)).filter(Boolean),
      'disabled at open: no chip marked missing',
    ).toEqual([])

    // Enable under root alpha (C3 re-enable delivers; C5 the re-init builds no keys). The chips are
    // unmarked until the host's `wiki-update`: nothing is marked while keys are pending.
    const enableAndExpect = async (
      expected: Record<string, boolean>,
      step: string,
    ) => {
      const before = (await readProbe(frame))?.messages.length ?? 0
      const marksBefore = (await readProbe(frame))?.marks.length ?? 0
      await setWikiSetting(evaluateInVSCode, 'enabled', true)
      await waitForChips(frame, expected, `chips after ${step}`)
      probe = await readProbe(frame)
      const after = probe?.messages.slice(before) ?? []
      const configIndex = after.findIndex(
        (message) => message.command === 'config-changed',
      )
      const updateIndex = after.findIndex(
        (message) => message.command === 'wiki-update',
      )
      expect(
        configIndex,
        `config-changed after ${step}`,
      ).toBeGreaterThanOrEqual(0)
      expect(
        updateIndex,
        `wiki-update follows config-changed after ${step}`,
      ).toBeGreaterThan(configIndex)
      expect(
        wikiUpdatesSince(probe, before),
        `one wiki-update after ${step}`,
      ).toBe(1)
      // Marks recorded before the update was counted would be styled from stale or absent keys.
      expect(
        (probe?.marks ?? [])
          .slice(marksBefore)
          .filter((mark) => mark.messagesSeen <= before + updateIndex),
        `no chip marked before the wiki-update after ${step}`,
      ).toEqual([])
      await expectUntouched(evaluateInVSCode, workspace, step)
    }
    const disableAndExpect = async (step: string) => {
      const before = (await readProbe(frame))?.messages.length ?? 0
      await setWikiSetting(evaluateInVSCode, 'enabled', false)
      await expect
        .poll(
          async () =>
            Object.values(await readChips(frame)).filter(Boolean).length,
          { timeout: 30_000, message: `no missing styling after ${step}` },
        )
        .toBe(0)
      // Negative observation: leave time for an update that must not be posted.
      await settle(frame, 2000)
      expect(
        wikiUpdatesSince(await readProbe(frame), before),
        `no wiki-update after ${step}`,
      ).toBe(0)
      await expectUntouched(evaluateInVSCode, workspace, step)
    }

    await enableAndExpect(UNDER_ALPHA, 'enable under alpha')
    await disableAndExpect('disable')
    // While disabled the root moves to gamma; the previous (alpha) keys must not come back.
    await setWikiSetting(evaluateInVSCode, 'root', 'gamma')
    await settle(frame, 1000)
    await enableAndExpect(UNDER_GAMMA, 're-enable under gamma')
    await disableAndExpect('second disable')
    await enableAndExpect(UNDER_GAMMA, 'second re-enable')
  },
)

watcherTest(
  'after a root change the watcher delivers new pages, an upper-case .MD page, and skips excluded folders',
  async ({ workbox, evaluateInVSCode, workspace }) => {
    watcherTest.setTimeout(180_000)
    const links = [...BASE_LINKS, ...WATCHED_LINKS]
    const frame = await openReady(evaluateInVSCode, workbox, workspace)
    await waitForChips(
      frame,
      missingStates(['alpha'], links),
      'chips follow the opening root alpha',
    )
    // The root change re-subscribes the watcher for the new root.
    await setWikiSetting(evaluateInVSCode, 'root', 'gamma')
    const underGamma = missingStates(['gamma'], links)
    await waitForChips(frame, underGamma, 'chips follow root gamma')

    const create = (relative: string, title: string) =>
      writeFileSync(path.join(workspace.dir, relative), `# ${title}\n`)
    // Excluded pages first: their watcher events are handled before the pages that must arrive.
    create('gamma/node_modules/in-modules.md', 'In modules')
    create('gamma/skipped/in-skipped.md', 'In skipped')
    await settle(frame, 1500)
    create('gamma/fresh.md', 'Fresh')
    create('gamma/Shouty.MD', 'Shouty')
    // C8: the lower-case page and the upper-case extension page arrive; the excluded pages add none.
    await waitForChips(
      frame,
      { ...underGamma, fresh: false, shouty: false },
      'created pages become keys, excluded pages do not',
    )
    // Negative observation: leave time for a late update that would carry an excluded page.
    await settle(frame, 1500)
    expect(await readChips(frame)).toEqual({
      ...underGamma,
      fresh: false,
      shouty: false,
    })
    await expectUntouched(evaluateInVSCode, workspace, 'watcher updates')
  },
)
