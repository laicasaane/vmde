/**
 * Task 733 / 036 core C8 (E2, R33.4): a refused replay with typing writes the typing to the untitled
 * "Recovered edits" document, and closing the source keeps that document open and dirty.
 *
 * The case is made deterministic in the webview: the page's `window.vscode` wrapper (read at every post,
 * `boot/vditor-init.ts`) is replaced by one that holds the typed replay operation. While it is held, the
 * host changes the typed paragraph from outside, which ends the epoch. The held operation then reaches
 * the host in the ended epoch, so it is journaled and never applied; the webview cannot reapply it (its
 * unit changed), and `recovery-done` writes it to "Recovered edits".
 *
 * Records hold counts only, no document text.
 */
import { expect, test } from 'vscode-test-playwright'
import { FIXTURE as LARGE } from './find-replace-fixture-helpers'
import { replaceAllByKeys } from './helpers/replace-all-xtest'
import {
  type Ctx,
  type Kit,
  closeAll,
  disposeObservers,
  evalFrame,
  hostText,
  makeKit,
  openDocument,
  restoreKitSettings,
  UNDO_LOCK_MS,
} from './helpers/shortcut-xtest-kit'

const PARAGRAPH = 'Pzwr wfsnnsra tr wumyslsn'
const REPLACE_TOKEN = 'ncjw'
// Compared through `vscode.Uri.parse(...).toString()` in the host: a URI's string form encodes the space
// (`untitled:Recovered%20edits`), so the raw string never matches (the run-1f failure).
const RECOVERED_URI = 'untitled:Recovered edits'

/**
 * In the page: holds the first replay `edit-delta` that is not a reapplication, and from then on every
 * later post too (`recovery-done` included), until released in their original order. Without the
 * later posts held, `recovery-done` can reach the host before the held operation, so the host writes
 * Recovered edits before it journals the key (the run-1 failure: 0 of 1).
 */
function holdReplayPostsInPage() {
  const win = window as any
  const api = win.vscode
  const held: unknown[] = []
  win.__c8Held = held
  win.__c8HeldOps = 0
  // Diagnosis (C11): every post as `[command, replayOp, epoch, recoveryOf op, held, delivered order]`
  // and every received host message as `[command, epoch, replayAfterOp, replayOp or applied]`; no text.
  const posted: unknown[][] = []
  const received: unknown[][] = []
  win.__c8Posted = posted
  win.__c8Received = received
  let delivered = 0
  const deliver = (message: any) => {
    delivered++
    const entry = posted.find((p) => p[6] === message)
    if (entry) entry[5] = delivered
    api.postMessage(message)
  }
  window.addEventListener(
    'message',
    (event) => {
      const d = event.data
      if (typeof d?.command !== 'string') return
      received.push([
        d.command,
        d.epoch ?? null,
        d.replayAfterOp ?? null,
        d.replayOp ?? d.applied ?? null,
      ])
    },
    true,
  )
  win.__c8Release = () => {
    win.vscode = api
    for (const message of held.splice(0)) deliver(message)
  }
  win.vscode = {
    postMessage(message: any) {
      const replayOp =
        message?.command === 'edit-delta' &&
        typeof message.replayOp === 'number' &&
        message.recoveryOf === undefined
      if (replayOp) win.__c8HeldOps++
      const hold = replayOp || held.length > 0
      posted.push([
        message?.command ?? '?',
        message?.replayOp ?? null,
        message?.epoch ?? null,
        message?.recoveryOf?.replayOp ?? null,
        hold,
        null,
        message,
      ])
      if (hold) {
        held.push(message)
        return
      }
      deliver(message)
    },
    getState: () => api.getState(),
    setState: (state: unknown) => api.setState(state),
  }
}

/** In the page: the recorded sequences and the replay counters (names and numbers only). */
function diagnosisInPage() {
  const w = window as any
  const replay = w.__vmdeModelShadowStats?.replay ?? {}
  return {
    posted: ((w.__c8Posted ?? []) as unknown[][]).map((p) => p.slice(0, 6)),
    received: (w.__c8Received ?? []) as unknown[][],
    recovery: replay.recovery ?? null,
    inputFailed: replay.inputFailed ?? null,
    typed: replay.typed ?? null,
    busy: w.__vmdeUnitHistory?.historyBusy?.(w.vditor?.vditor) ?? null,
  }
}
/** The page and host evidence of the case, printed as one `[c8-diag]` line. */
async function diagnosis(kit: Kit, ctx: Ctx) {
  // The webview can be hidden once Recovered edits opens in front of it: read the page with a short bound.
  const page = (await Promise.race([
    evalFrame(kit, diagnosisInPage, 0),
    new Promise((resolve) => setTimeout(() => resolve(null), 3_000)),
  ]).catch(() => null)) as Awaited<ReturnType<typeof diagnosisInPage>> | null
  const host = await kit.host(
    (vscode, [fsPath, uri]: [string, string]) => {
      const source = vscode.workspace.textDocuments.find(
        (candidate) => candidate.uri.fsPath === fsPath,
      )
      const recovered = vscode.workspace.textDocuments.find(
        (candidate) =>
          candidate.uri.toString() === vscode.Uri.parse(uri).toString(),
      )
      const text = source?.getText() ?? ''
      return {
        sourceVersion: source?.version ?? null,
        sourceDirty: source?.isDirty ?? null,
        outsideChangeApplied: text.includes('Outside change'),
        keyInHost: text.includes('Pzwrq'),
        recoveredOpen: recovered !== undefined,
        recoveredLength: recovered?.getText().length ?? null,
        recoveredEntries: (recovered?.getText().match(/^## Edit /gm) ?? [])
          .length,
      }
    },
    [ctx.file, RECOVERED_URI] as [string, string],
  )
  const record = { page, host }
  console.log(`[c8-diag] ${JSON.stringify(record)}`)
  return record
}

const heldCount = (kit: Kit) =>
  evalFrame(kit, () => (window as any).__c8HeldOps as number, 0)
const releaseHeld = (kit: Kit) =>
  evalFrame(kit, () => (window as any).__c8Release(), 0)

/** The "Recovered edits" document: open, dirty, has a tab, and how often `needle` occurs (counts only). */
const recoveredState = (kit: Kit, needle: string) =>
  kit.host(
    (vscode, [uri, text]: [string, string]) => {
      const document = vscode.workspace.textDocuments.find(
        (candidate) =>
          candidate.uri.toString() === vscode.Uri.parse(uri).toString(),
      )
      const tab = vscode.window.tabGroups.all
        .flatMap((group) => group.tabs)
        .some(
          (candidate) =>
            candidate.input instanceof vscode.TabInputText &&
            candidate.input.uri.toString() === vscode.Uri.parse(uri).toString(),
        )
      const body = document?.getText() ?? ''
      return {
        open: document !== undefined && !document.isClosed,
        dirty: document?.isDirty ?? false,
        tab,
        occurrences: body.split(text).length - 1,
      }
    },
    [RECOVERED_URI, needle] as [string, string],
  )

/** Closes the source's VMDE and text tabs (reverting its changes), and no other tab. */
const closeSourceOnly = (kit: Kit, file: string) =>
  kit.host(
    async (vscode, [fsPath]: [string]) => {
      const own = vscode.window.tabGroups.all
        .flatMap((group) => group.tabs)
        .filter(
          (tab) =>
            (tab.input instanceof vscode.TabInputCustom ||
              tab.input instanceof vscode.TabInputText) &&
            tab.input.uri.fsPath === fsPath,
        )
      for (const document of vscode.workspace.textDocuments)
        if (document.isDirty && document.uri.fsPath === fsPath)
          await vscode.commands.executeCommand(
            'workbench.action.files.revert',
            document.uri,
          )
      if (own.length) await vscode.window.tabGroups.close(own)
    },
    [file] as [string],
  )

const closeRecovered = (kit: Kit) =>
  kit.host(
    async (vscode, [uri]: [string]) => {
      const document = vscode.workspace.textDocuments.find(
        (candidate) =>
          candidate.uri.toString() === vscode.Uri.parse(uri).toString(),
      )
      if (!document) return
      await vscode.window.showTextDocument(document)
      await vscode.commands.executeCommand(
        'workbench.action.revertAndCloseActiveEditor',
      )
    },
    [RECOVERED_URI] as [string],
  )

test.describe('036 core C8: a refused replay with typing is kept in Recovered edits', () => {
  test.skip(
    process.env.VMDE_XTEST !== '1',
    'requires isolated Xvfb/Openbox XTEST',
  )
  test.describe.configure({ timeout: 300_000 })

  let kit: Kit | undefined
  const contexts: Ctx[] = []

  test.afterEach(async () => {
    if (kit) {
      await closeRecovered(kit)
      await disposeObservers(kit)
      for (const ctx of contexts.splice(0)) await closeAll(kit, ctx.file)
    }
    kit = undefined
    await restoreKitSettings()
  })

  test('refused replay with typing: Recovered edits holds the key; closing the source keeps it open and dirty', async ({
    workbox,
    electronApp,
    evaluateInVSCode,
    baseDir,
  }) => {
    kit = await makeKit(workbox, electronApp, evaluateInVSCode, baseDir, 'c8')
    const base = Array.from({ length: 4 }, () => LARGE).join('\n')
    const ctx = await openDocument(kit, 'c8-recovered-x4.md', base, 'ir')
    contexts.push(ctx)
    const after = base.replaceAll(REPLACE_TOKEN, 'ZZZZ')
    // The passing kit Find leg's keys (`helpers/replace-all-xtest.ts`), caret after `Pzwr`.
    await replaceAllByKeys(
      ctx,
      { needle: PARAGRAPH, offset: 4 },
      REPLACE_TOKEN,
      'ZZZZ',
      after,
    )
    await kit.workbox.waitForTimeout(UNDO_LOCK_MS)

    await evalFrame(kit, holdReplayPostsInPage, 0)
    await kit.xtest.key('ctrl+z')
    // A key typed during the replay: its replay operation is held in the page.
    await kit.xtest.type('q')
    await expect.poll(() => heldCount(kit as Kit), { timeout: 30_000 }).toBe(1)
    // The host changes the typed paragraph from outside: the epoch ends before the operation arrives.
    await kit.host(
      async (vscode, [fsPath, needle]: [string, string]) => {
        const document = vscode.workspace.textDocuments.find(
          (candidate) => candidate.uri.fsPath === fsPath,
        )
        if (!document) return
        const at = document.getText().indexOf(needle)
        const edit = new vscode.WorkspaceEdit()
        edit.replace(
          document.uri,
          new vscode.Range(
            document.positionAt(at),
            document.positionAt(at + needle.length),
          ),
          'Outside change',
        )
        await vscode.workspace.applyEdit(edit)
      },
      [ctx.file, PARAGRAPH] as [string, string],
    )
    await releaseHeld(kit)
    // Precondition: the replay was refused: the page received a newer-epoch `update` (the resync after the
    // outside change) and its recovery started. Otherwise the case proves nothing about Recovered edits.
    const refused = async () => {
      const { page, host } = await diagnosis(kit as Kit, ctx)
      // A journaled entry in Recovered edits proves the refusal when the page is hidden behind it.
      if (page === null) return host.recoveredEntries > 0
      const updates = page.received.filter((r) => r[0] === 'update').length
      return updates > 0 && Number(page.recovery?.started ?? 0) > 0
    }
    await expect
      .poll(refused, {
        timeout: 30_000,
        message:
          'the replay was refused (an update arrived and recovery started)',
      })
      .toBe(true)
      .catch(async (error: unknown) => {
        await diagnosis(kit as Kit, ctx)
        throw error
      })
    // The key is in "Recovered edits" once, as its own fenced text.
    await expect
      .poll(
        async () =>
          (await recoveredState(kit as Kit, '```text\nq\n```')).occurrences,
        { timeout: 60_000, message: 'the typed key is in Recovered edits' },
      )
      .toBe(1)
      .catch(async (error: unknown) => {
        await diagnosis(kit as Kit, ctx)
        throw error
      })
    expect(await hostText(ctx), 'the host never applied the key').not.toContain(
      `${PARAGRAPH.slice(0, 4)}q`,
    )

    // Closing the source keeps "Recovered edits" open, dirty and in its tab, and writes nothing twice. Only
    // the source's own tabs close: the kit's `closeAll` closes every remaining tab, "Recovered edits" too.
    await closeSourceOnly(kit, ctx.file)
    contexts.splice(0)
    await kit.workbox.waitForTimeout(2000)
    const state = await recoveredState(kit, '```text\nq\n```')
    expect(state).toEqual({
      open: true,
      dirty: true,
      tab: true,
      occurrences: 1,
    })
  })
})
