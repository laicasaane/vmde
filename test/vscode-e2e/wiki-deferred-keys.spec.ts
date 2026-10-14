/**
 * Task 636 — the wiki page keys arrive after the document opens, in the real VS Code webview.
 *
 * The host posts `init` without waiting for the workspace's wiki page scan; the keys follow in a
 * `wiki-update`. Contract (tasks/636-slow-open-real-profile.md, "Part 1 handoff"): `init` first,
 * `wiki-update` after it; while keys are pending no chip is marked missing; after the update a
 * chip whose page is not a key is marked missing and one whose page is a key is not, by
 * attributes only (no edit, no dirty state, no Undo entry); excluded pages (`files.exclude`, any
 * `node_modules`) are not keys; wiki links disabled means no scan and no update.
 *
 * This is the harness regression for the fix. It runs in the isolated test profile, so it is NOT
 * evidence of the real-profile open time.
 *
 * Instrumentation (read-only, installed before the webview exists): a document-start script on the
 * workbench page runs in every webview frame, records every host-to-webview message in order, and
 * runs a MutationObserver over every `data-wiki-missing` attribute and chip insertion from the first
 * node on, so a chip that is marked missing for one frame is caught. The observers never change
 * timers, messages, source or selection. Keys are XTEST (`helpers/xtest-input.ts`; needs
 * `VMDE_XTEST=1` and a window manager on the display, see docs/os-keyboard-testing-setup.md). The
 * Ctrl+Z test records the trusted `keydown` it produced, so a chord that never reached the webview
 * fails instead of passing vacuously. A measured key is never retried.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test as base } from 'vscode-test-playwright'
import { createXtestInput } from './helpers/xtest-input'
import { settle, waitForE2EReadiness, wf } from './webview-helpers'

const DOC_NAME = 'links.md'
const DOC = [
  '# Deferred wiki keys',
  '',
  'Pages: [[home]] [[Guide]] [[Hidden]] [[Draft]] [[Scratch]] [[no-such-page]]',
  '',
  'Tail paragraph.',
  '',
].join('\n')
// Existing pages (keys) and the pages that must not be keys.
const PRESENT = ['home', 'Guide']
const ABSENT = ['no-such-page', 'Hidden', 'Draft', 'Scratch']
// A tree of 30 x 10 x 10 empty directories (3,330 in all) under one top folder: the old serial walk
// paid one round trip for each of them. Generated, so no fixture tree is committed.
const DEEP_TOP = 30
const DEEP_MID = 10
const DEEP_LEAF = 10

interface WorkspaceSettings {
  'files.exclude': Record<string, boolean>
  'vmde.wiki.enabled': boolean
}

interface Workspace {
  dir: string
  doc: string
}

function makeWorkspace(
  dir: string,
  wikiEnabled: boolean,
  withExcludes: boolean,
): Workspace {
  const page = (relative: string, title: string) => {
    mkdirSync(path.dirname(path.join(dir, relative)), { recursive: true })
    writeFileSync(path.join(dir, relative), `# ${title}\n`)
  }
  page('home.md', 'Home')
  // Upper-case extension: the page set is case-insensitive about it.
  page('notes/Guide.MD', 'Guide')
  page('node_modules/pkg/Hidden.md', 'Hidden')
  page('drafts/Draft.md', 'Draft')
  page('scratch-a/Scratch.md', 'Scratch')
  for (let top = 0; top < DEEP_TOP; top++)
    for (let mid = 0; mid < DEEP_MID; mid++)
      for (let leaf = 0; leaf < DEEP_LEAF; leaf++)
        mkdirSync(path.join(dir, 'deep', `d${top}`, `s${mid}`, `l${leaf}`), {
          recursive: true,
        })
  const settings: WorkspaceSettings = {
    // A plain key and a brace-valued key; the page under node_modules needs no key.
    'files.exclude': withExcludes
      ? { 'drafts/**': true, '**/scratch-{a,b}/**': true }
      : {},
    'vmde.wiki.enabled': wikiEnabled,
  }
  mkdirSync(path.join(dir, '.vscode'), { recursive: true })
  writeFileSync(
    path.join(dir, '.vscode', 'settings.json'),
    `${JSON.stringify(settings, null, 2)}\n`,
  )
  const doc = path.join(dir, DOC_NAME)
  writeFileSync(doc, DOC)
  return { dir, doc }
}

// Each test gets its own workspace, created before VS Code launches (settings are read at open).
// `baseDir` is the folder the harness opens as the workspace.
const workspaceTest = (wikiEnabled: boolean) =>
  base.extend<{ workspace: Workspace }>({
    // Replaces the harness's `baseDir` option: the same folder, but filled before VS Code opens it.
    baseDir: async ({ _createTempDir }, use) => {
      // The harness's own temp-dir factory removes the folder when the worker ends.
      const dir = await _createTempDir()
      makeWorkspace(dir, wikiEnabled, wikiEnabled)
      await use(dir)
    },
    workspace: async ({ baseDir }, use) =>
      use({ dir: baseDir, doc: path.join(baseDir, DOC_NAME) }),
  })

const enabledTest = workspaceTest(true)
const disabledTest = workspaceTest(false)

interface HostMessage {
  command: string | null
  type: string | null
  at: number
  // Key counts: on `wiki-update` (top level) or on an `init`'s wiki context.
  keys: number | null
}

interface ChipMark {
  target: string | null
  at: number
}

interface Probe {
  messages: HostMessage[]
  // A chip seen carrying `data-wiki-missing` (insertion or attribute change), with the message count
  // at that moment.
  marks: (ChipMark & { messagesSeen: number })[]
  // First `.vditor-ir` / first chip inside it: the host prerender teaser appears long before the
  // real editor is ready.
  editorAt: number | null
  chipsAt: number | null
  // First moment the real editor reported ready (readiness epoch above zero).
  readyAt: number | null
  keydowns: { key: string; ctrl: boolean; trusted: boolean }[]
  installs: number
}

// Runs at document start in every frame of the workbench page; only child frames record. The
// webview's content frame starts as `about:blank` and its document is replaced afterwards, which
// drops the listeners and the observer, so a 1 ms timer (it survives the replacement) installs them
// again on every new root element. The init message comes much later than the first tick.
function probeScript() {
  if (window.top === window) return
  const store: Probe = {
    messages: [],
    marks: [],
    editorAt: null,
    chipsAt: null,
    readyAt: null,
    keydowns: [],
    installs: 0,
  }
  ;(window as unknown as { __wikiProbe: Probe }).__wikiProbe = store
  const onMessage = (event: MessageEvent) => {
    const data = event.data as {
      command?: string
      type?: string
      pageKeys?: unknown[]
      wiki?: { pageKeys?: unknown[] }
    } | null
    if (!data || typeof data !== 'object' || !data.command) return
    const keys = data.pageKeys ?? data.wiki?.pageKeys
    store.messages.push({
      command: data.command,
      type: data.type ?? null,
      at: performance.now(),
      keys: Array.isArray(keys) ? keys.length : null,
    })
  }
  const onKeydown = (event: KeyboardEvent) =>
    store.keydowns.push({
      key: event.key,
      ctrl: event.ctrlKey,
      trusted: event.isTrusted,
    })
  const noteChip = (chip: Element) => {
    if (!chip.hasAttribute('data-wiki-missing')) return
    store.marks.push({
      target: chip.getAttribute('data-wiki-target'),
      at: performance.now(),
      messagesSeen: store.messages.length,
    })
  }
  const scan = (node: Node) => {
    if (!(node instanceof Element)) return
    if (node.matches('.wiki-link-chip')) noteChip(node)
    for (const chip of node.querySelectorAll('.wiki-link-chip')) noteChip(chip)
  }
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === 'attributes' && record.target instanceof Element)
        noteChip(record.target)
      for (const added of record.addedNodes) scan(added)
    }
    if (store.editorAt === null && document.querySelector('.vditor-ir'))
      store.editorAt = performance.now()
    if (
      store.chipsAt === null &&
      document.querySelector('.vditor-ir .wiki-link-chip')
    )
      store.chipsAt = performance.now()
  })
  // The root element changes whenever the document is replaced, so it marks "install again".
  let installedOn: Element | null = null
  const install = () => {
    const root = document.documentElement
    if (!root || root === installedOn) return
    installedOn = root
    store.installs++
    // Identical function references are added once, so repeated installs do not duplicate records.
    window.addEventListener('message', onMessage)
    window.addEventListener('keydown', onKeydown, true)
    observer.observe(document, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['data-wiki-missing'],
    })
  }
  install()
  setInterval(() => {
    install()
    const readiness = (
      window as unknown as { __vmdeE2EReadiness?: { editorEpoch: number } }
    ).__vmdeE2EReadiness
    if (store.readyAt === null && (readiness?.editorEpoch ?? 0) > 0)
      store.readyAt = performance.now()
  }, 1)
}

const readProbe = (frame: ReturnType<typeof wf>) =>
  frame
    .locator('body')
    .evaluate(
      () => (window as unknown as { __wikiProbe?: Probe }).__wikiProbe ?? null,
    )

interface ChipState {
  target: string
  missing: boolean
  title: string | null
}

const readChips = (frame: ReturnType<typeof wf>) =>
  frame.locator('body').evaluate(
    () =>
      Array.from(
        document.querySelectorAll('.vditor-ir .wiki-link-chip'),
        (chip) => ({
          target: chip.getAttribute('data-wiki-target') ?? '',
          missing: chip.hasAttribute('data-wiki-missing'),
          title: chip.getAttribute('title'),
        }),
      ) as ChipState[],
  )

const chipMap = (chips: ChipState[]) =>
  Object.fromEntries(chips.map((chip) => [chip.target, chip.missing]))

type EvaluateInVSCode = <R, Arg>(
  fn: (vscode: typeof import('vscode'), arg: Arg) => Promise<R>,
  arg: Arg,
) => Promise<R>

async function openDoc(evaluateInVSCode: EvaluateInVSCode, doc: string) {
  await evaluateInVSCode(
    async (vscode: typeof import('vscode'), file: string) => {
      await vscode.extensions.getExtension('Laicasaane.vmde')?.activate()
      await vscode.commands.executeCommand(
        'vscode.openWith',
        vscode.Uri.file(file),
        'vmde.editor',
      )
    },
    doc,
  )
}

const hostState = (evaluateInVSCode: EvaluateInVSCode, doc: string) =>
  evaluateInVSCode(async (vscode: typeof import('vscode'), file: string) => {
    const document = vscode.workspace.textDocuments.find(
      (item) => item.uri.fsPath === file,
    )
    return { text: document?.getText() ?? null, dirty: !!document?.isDirty }
  }, doc)

// The expected chip state once the keys are known: a page that is a key is not missing.
const ALL_STATES: Record<string, boolean> = {
  ...Object.fromEntries(PRESENT.map((target) => [target, false])),
  ...Object.fromEntries(ABSENT.map((target) => [target, true])),
}

enabledTest(
  'deferred wiki keys: init first, no missing flash, restyle by attributes only, completion lists pages',
  async ({ workbox, evaluateInVSCode, electronApp, workspace }) => {
    enabledTest.setTimeout(120_000)
    await workbox.addInitScript(probeScript)
    await openDoc(evaluateInVSCode, workspace.doc)
    const frame = wf(workbox)
    await frame.locator('.vditor-ir').first().waitFor({ timeout: 60_000 })
    await waitForE2EReadiness(
      frame,
      (state) => state.routerReady && state.editorEpoch > 0,
    )
    await expect
      .poll(
        async () =>
          (await readProbe(frame))?.messages.some(
            (message) => message.command === 'wiki-update',
          ),
        { timeout: 30_000, message: 'the wiki-update reached the webview' },
      )
      .toBe(true)
    // The restyle runs as the update is handled; wait for the contract state, not a fixed delay.
    await expect
      .poll(async () => chipMap(await readChips(frame)), { timeout: 15_000 })
      .toEqual(ALL_STATES)

    const probe = await readProbe(frame)
    expect(probe, 'the probe was installed in the webview').not.toBeNull()
    const messages = probe?.messages ?? []
    const initIndex = messages.findIndex(
      (message) => message.command === 'update' && message.type === 'init',
    )
    const updateIndex = messages.findIndex(
      (message) => message.command === 'wiki-update',
    )
    // Recorded, not asserted: whether the keys beat the real editor depends on how fast the
    // harness's search runs. The contract (below) holds either way.
    const readyBeforeKeys =
      probe?.readyAt != null && probe.readyAt < messages[updateIndex].at
    // eslint-disable-next-line no-console
    console.log(
      `[wiki-deferred-keys] ${JSON.stringify({
        order: messages.map(
          (message) =>
            `${message.command}/${message.type ?? '-'}@${Math.round(message.at)}`,
        ),
        keysInInit: messages[initIndex]?.keys ?? null,
        keysInUpdate: messages[updateIndex]?.keys ?? null,
        firstEditorAt: probe?.editorAt && Math.round(probe.editorAt),
        firstChipAt: probe?.chipsAt && Math.round(probe.chipsAt),
        readyAt: probe?.readyAt && Math.round(probe.readyAt),
        editorReadyBeforeKeys: readyBeforeKeys,
        marks: probe?.marks.length,
      })}`,
    )
    expect(initIndex, 'an init reached the webview').toBeGreaterThanOrEqual(0)
    expect(updateIndex, 'the wiki-update came after the init').toBeGreaterThan(
      initIndex,
    )
    expect(
      messages[initIndex].keys,
      'the init carried no keys (the cache was not built yet)',
    ).toBeNull()
    expect(
      messages.filter((message) => message.command === 'wiki-update'),
      'one wiki-update in all',
    ).toHaveLength(1)
    // An existing page's chip never carried the attribute, at any moment from the first node.
    expect(
      (probe?.marks ?? []).filter((mark) =>
        PRESENT.includes(mark.target ?? ''),
      ),
      'existing-page chips never marked missing',
    ).toEqual([])
    // Nothing was marked missing before the keys were known.
    expect(
      (probe?.marks ?? []).filter((mark) => mark.messagesSeen <= updateIndex),
      'no chip marked missing before the wiki-update',
    ).toEqual([])
    const chips = await readChips(frame)
    expect(chips.find((chip) => chip.target === 'no-such-page')?.title).toMatch(
      /Missing wiki page/,
    )
    expect(chips.find((chip) => chip.target === 'home')?.title).toMatch(
      /Open wiki page/,
    )

    // Restyle by attributes only: the host document is clean and byte-identical.
    expect(await hostState(evaluateInVSCode, workspace.doc)).toEqual({
      text: DOC,
      dirty: false,
    })
    expect(readFileSync(workspace.doc, 'utf8')).toBe(DOC)

    // Ctrl+Z (XTEST) after the update changes nothing: the restyle left no Undo entry.
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
    expect(await hostState(evaluateInVSCode, workspace.doc)).toEqual({
      text: DOC,
      dirty: false,
    })
    expect(chipMap(await readChips(frame))).toEqual(ALL_STATES)

    // `[[` completion after the update. The pending window (keys not yet known) closes within a
    // fraction of a second here, long before the editor accepts a key, so it cannot be hit
    // deterministically in the harness: the list after the update is asserted instead. Its
    // pending-state behaviour (one non-insertable loading row) is covered by the Chromium spec.
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
    console.log(`[wiki-deferred-keys] hint=${JSON.stringify(names)}`)
    const lower = names.map((name) => name.toLowerCase())
    expect(lower, 'pages from the root and a subfolder are listed').toEqual(
      expect.arrayContaining(['home', 'guide']),
    )
    for (const excluded of ['hidden', 'draft', 'scratch'])
      expect(lower, `${excluded} is not a page`).not.toContain(excluded)
    expect(names.join('\n')).not.toMatch(/Loading pages/)
  },
)

disabledTest(
  'wiki links disabled: no wiki-update and no chip marked missing',
  async ({ workbox, evaluateInVSCode, workspace }) => {
    disabledTest.setTimeout(120_000)
    await workbox.addInitScript(probeScript)
    await openDoc(evaluateInVSCode, workspace.doc)
    const frame = wf(workbox)
    await frame.locator('.vditor-ir').first().waitFor({ timeout: 60_000 })
    await waitForE2EReadiness(
      frame,
      (state) => state.routerReady && state.editorEpoch > 0,
    )
    // Negative observation: leave time for the scan that would run if wiki links were enabled
    // (it finished within about 0.3 s after the init in the enabled test).
    await settle(frame, 3000)
    const probe = await readProbe(frame)
    const messages = probe?.messages ?? []
    expect(
      messages.some(
        (message) => message.command === 'update' && message.type === 'init',
      ),
      'an init reached the webview',
    ).toBe(true)
    expect(
      messages.filter((message) => message.command === 'wiki-update'),
    ).toEqual([])
    expect(probe?.marks).toEqual([])
    expect((await readChips(frame)).filter((chip) => chip.missing)).toEqual([])
  },
)
