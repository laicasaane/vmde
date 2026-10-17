/**
 * Task 641 (S2a fix 2, S2b fix 5) — in the real VS Code webview the host's `init` reaches the editor
 * before the incremental seed, and the first edit after the editor is ready can be undone back to
 * the opened bytes.
 *
 * Contract (tasks/done/641-open-to-ready-one-second.md, "Execution progress — 2026-10-15 (S2a host)"):
 * the host posts `init` without a seed; a later, separate `incremental-seed` message carries the
 * seed for the bytes of that `init`. The history base of the opened document is captured in an idle
 * period, so the first edit after ready (typed by XTEST, never retried) must still Undo to the
 * opened bytes exactly, whether it lands before or after the seed. This is a harness regression in
 * the isolated test profile, not evidence of any open time.
 *
 * Instrumentation (read-only, installed before the webview exists): a document-start script on the
 * workbench page runs in every webview frame and records every host-to-webview message in order and
 * the trusted keydowns, without changing timers, messages, source or selection. Keys are XTEST
 * (`helpers/xtest-input.ts`; needs `VMDE_XTEST=1` and a window manager on the display, see
 * docs/os-keyboard-testing-setup.md). Each Undo records the trusted keydown it produced, so a chord
 * that never reached the webview fails instead of passing vacuously.
 */
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import { createXtestInput } from './helpers/xtest-input'
import { largeMixedMarkdown } from './large-mixed-markdown'
import {
  ExtensionId,
  MarkdownEditorViewType,
  waitForE2EReadiness,
  wf,
} from './webview-helpers'

interface HostMessage {
  command: string
  type: string | null
  contentLength: number | null
  seedOnInit: boolean
  at: number
}

interface Probe {
  messages: HostMessage[]
  keydowns: { key: string; ctrl: boolean; trusted: boolean; at: number }[]
}

// Runs in every frame of the workbench page; only child frames record. The webview's content frame
// starts as `about:blank` and its document is replaced afterwards, which drops listeners, so a 1 ms
// timer (it survives the replacement) installs them again on every new root element.
function probeScript() {
  if (window.top === window) return
  const store: Probe = { messages: [], keydowns: [] }
  ;(window as unknown as { __initSeedProbe: Probe }).__initSeedProbe = store
  const onMessage = (event: MessageEvent) => {
    const data = event.data as {
      command?: string
      type?: string
      content?: string
      incrementalSeed?: unknown
    } | null
    if (!data || typeof data !== 'object' || !data.command) return
    store.messages.push({
      command: data.command,
      type: data.type ?? null,
      contentLength:
        typeof data.content === 'string' ? data.content.length : null,
      seedOnInit: data.incrementalSeed !== undefined,
      at: performance.now(),
    })
  }
  const onKeydown = (event: KeyboardEvent) =>
    store.keydowns.push({
      key: event.key,
      ctrl: event.ctrlKey,
      trusted: event.isTrusted,
      at: performance.now(),
    })
  let installedOn: Element | null = null
  const install = () => {
    const root = document.documentElement
    if (!root || root === installedOn) return
    installedOn = root
    // Identical function references are added once, so repeated installs do not duplicate records.
    window.addEventListener('message', onMessage)
    window.addEventListener('keydown', onKeydown, true)
  }
  install()
  setInterval(install, 1)
}

const readProbe = (frame: ReturnType<typeof wf>) =>
  frame
    .locator('body')
    .evaluate(
      () =>
        (window as unknown as { __initSeedProbe?: Probe }).__initSeedProbe ??
        null,
    )

type EvaluateInVSCode = <R, Arg>(
  fn: (vscode: typeof import('vscode'), arg: Arg) => Promise<R>,
  arg: Arg,
) => Promise<R>

async function openDoc(evaluateInVSCode: EvaluateInVSCode, file: string) {
  await evaluateInVSCode(async (vscode) => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors')
  }, undefined)
  await evaluateInVSCode(
    async (vscode: typeof import('vscode'), args: [string, string, string]) => {
      await vscode.extensions.getExtension(args[1])?.activate()
      await vscode.commands.executeCommand(
        'vscode.openWith',
        vscode.Uri.file(args[0]),
        args[2],
      )
    },
    [file, ExtensionId, MarkdownEditorViewType] as [string, string, string],
  )
}

const hostState = (evaluateInVSCode: EvaluateInVSCode, file: string) =>
  evaluateInVSCode(async (vscode: typeof import('vscode'), fsPath: string) => {
    const document = vscode.workspace.textDocuments.find(
      (item) => item.uri.fsPath === fsPath,
    )
    return { text: document?.getText() ?? null, dirty: !!document?.isDirty }
  }, file)

const LARGE = largeMixedMarkdown()

test('init reaches the webview before the seed, and the first edit after ready undoes to the opened bytes', async ({
  workbox,
  electronApp,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(240_000)
  // The document must take the `ready` then `init` route (above the inline-init size) and be large
  // enough to get a seed (block count, see incremental-seed.spec.ts).
  expect(LARGE.length, 'above the inline init size').toBeGreaterThan(100_000)
  await workbox.addInitScript(probeScript)
  const xtest = await createXtestInput(electronApp, workbox)
  const seedBefore = { order: [] as string[], seedBeforeKey: [] as boolean[] }

  for (const [name, waitForSeed] of [
    ['after-seed.md', true],
    ['at-ready.md', false],
  ] as const) {
    const file = path.join(baseDir, name)
    writeFileSync(file, LARGE)
    await openDoc(evaluateInVSCode, file)
    const frame = wf(workbox)
    await frame.locator('.vditor-ir').first().waitFor({ timeout: 90_000 })
    await waitForE2EReadiness(
      frame,
      (state) =>
        state.routerReady &&
        state.editorEpoch > 0 &&
        state.mode === 'ir' &&
        Object.values(state.pending).every((count) => count === 0),
      { timeout: 90_000, message: `editor ready: ${name}` },
    )
    const opened = await hostState(evaluateInVSCode, file)
    expect(opened.text, `${name}: the host holds the opened bytes`).toBe(LARGE)
    expect(opened.dirty).toBe(false)

    if (waitForSeed) {
      await expect
        .poll(
          async () =>
            (await readProbe(frame))?.messages.some(
              (message) => message.command === 'incremental-seed',
            ),
          {
            timeout: 60_000,
            message: 'the incremental-seed reached the webview',
          },
        )
        .toBe(true)
    }
    const target = frame.locator('.vditor-ir p').filter({
      hasText: 'Paragraph 12 alpha',
    })
    await target.first().click()
    const keyMark = (await readProbe(frame))?.messages.length ?? 0
    await xtest.type('X')
    await expect
      .poll(
        async () => (await hostState(evaluateInVSCode, file)).text?.length,
        { timeout: 30_000, message: `${name}: the typed X reached the host` },
      )
      .toBe(LARGE.length + 1)
    const edited = await hostState(evaluateInVSCode, file)
    expect(edited.dirty, `${name}: dirty after the edit`).toBe(true)

    await xtest.key('ctrl+z')
    await expect
      .poll(async () => (await hostState(evaluateInVSCode, file)).text, {
        timeout: 30_000,
        message: `${name}: Undo restores the opened bytes`,
      })
      .toBe(LARGE)
    expect(
      (await hostState(evaluateInVSCode, file)).dirty,
      `${name}: clean after Undo`,
    ).toBe(false)

    const probe = await readProbe(frame)
    expect(probe, 'the probe was installed in the webview').not.toBeNull()
    const messages = probe?.messages ?? []
    expect(
      (probe?.keydowns ?? []).filter(
        (key) => key.ctrl && key.key === 'z' && key.trusted,
      ),
      `${name}: the OS-level Ctrl+Z reached the webview`,
    ).toHaveLength(1)
    const initIndex = messages.findIndex(
      (message) => message.command === 'update' && message.type === 'init',
    )
    const seedIndex = messages.findIndex(
      (message) => message.command === 'incremental-seed',
    )
    seedBefore.order.push(
      `${name}: ${messages.map((m) => `${m.command}/${m.type ?? '-'}@${Math.round(m.at)}`).join(' ')}`,
    )
    seedBefore.seedBeforeKey.push(seedIndex >= 0 && seedIndex < keyMark)
    expect(
      initIndex,
      `${name}: an init reached the webview`,
    ).toBeGreaterThanOrEqual(0)
    expect(
      messages[initIndex].seedOnInit,
      `${name}: the init carries no seed`,
    ).toBe(false)
    expect(
      messages[initIndex].contentLength,
      `${name}: the init carries the document`,
    ).toBe(LARGE.length)
    if (seedIndex >= 0) {
      expect(
        seedIndex,
        `${name}: the seed message comes after the init`,
      ).toBeGreaterThan(initIndex)
      expect(
        messages[seedIndex].contentLength,
        `${name}: the seed is for the init bytes`,
      ).toBe(messages[initIndex].contentLength)
    }
    if (waitForSeed)
      expect(seedIndex, `${name}: a seed message was sent`).toBeGreaterThan(
        initIndex,
      )
  }
  // Recorded, not asserted: whether the second document's seed beat its first key depends on timing.
  // eslint-disable-next-line no-console
  console.log(`[init-before-seed] ${JSON.stringify(seedBefore)}`)
})
