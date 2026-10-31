import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as vscode from 'vscode'
import { EditorSession } from '../../src/app/extension'
import { WritebackController } from '../../src/writeback/writeback-controller'
import { HistoryCouplingController } from '../../src/writeback/history-coupling'
import { lastWriteWinsFor } from '../../src/platform/last-write-wins'
import { mock } from './vscode-mock'

// Task 646 (host side): a change to the document that VMDE did not make must reach the webview,
// and a plain webview edit serialized before the webview applied that change must not overwrite
// it. Each `update` carries the host's external-change `revision`; a plain `edit` carries the
// revision of the last update the webview applied (decision D1 in the task record).

const usedStores = new Set<object>()
afterEach(() => {
  for (const store of usedStores) lastWriteWinsFor(store as never).dispose()
  usedStores.clear()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const SOURCE = '# Hi\n\nbody\n'
const EXTERNAL = '# Hi\n\nEXTERNAL change on disk\n'
const TYPED = '# Hi\n\nbody K\n'

function makeSession(text = SOURCE) {
  mock.setWorkspaceFolder('/ws')
  const context = {
    ...mock.createExtensionContext(),
    extensionPath: process.cwd(),
    extensionUri: vscode.Uri.file(process.cwd()),
  }
  usedStores.add(context.globalState)
  const document = mock.createTextDocument('/ws/guard.md', text)
  const panel = mock.createWebviewPanel()
  const html = (_w: unknown, _u: unknown, content?: string) =>
    `<div id="app"></div>${content ?? ''}`
  const diagramCache = {
    registerDoc() {
      /* no-op stub */
    },
    closeDoc() {
      /* no-op stub */
    },
    get() {
      return undefined
    },
    put() {
      /* no-op stub */
    },
  }
  const session = new EditorSession(
    context as any,
    document as any,
    panel as any,
    diagramCache as any,
    html as any,
  )
  return { session, panel, document }
}

const updates = () =>
  mock.calls.postMessage.filter((m: any) => m.command === 'update') as any[]

// A change from outside VMDE that leaves the document clean (a reload from disk).
async function externalChange(
  document: ReturnType<typeof makeSession>['document'],
  text: string,
) {
  document.__setText(text)
  await document.save()
  mock.fireDidChangeTextDocument(document)
}

describe('external change guard (host)', () => {
  beforeEach(() => {
    mock.reset()
    vi.useFakeTimers()
  })

  it('(c) init and later updates carry an increasing external-change revision', async () => {
    const { session, panel, document } = makeSession()
    session.start()
    await panel._receiveMessage({ command: 'ready' })
    const init = updates().find((m) => m.type === 'init')
    expect(init?.revision).toEqual(expect.any(Number))

    await externalChange(document, EXTERNAL)
    await vi.advanceTimersByTimeAsync(200)
    const posted = updates().filter((m) => m.content.includes('EXTERNAL'))
    expect(posted).toHaveLength(1)
    expect(posted[0].revision).toEqual(expect.any(Number))
    expect(posted[0].revision).toBeGreaterThan(init.revision)
  })

  it('(a) refuses plain edits made from an older revision, re-posts the host text and warns once', async () => {
    const { session, panel, document } = makeSession()
    session.start()
    await panel._receiveMessage({ command: 'ready' })
    const baseline = updates().find((m) => m.type === 'init')
    // The default mocked applyEdit writes to the document, so an unguarded edit would land.
    const applied = vi.spyOn(vscode.workspace, 'applyEdit')
    mock.calls.postMessage.length = 0

    // The host text changed; the webview has not applied it yet and posts two edits made from
    // the older revision (an idle post, then a flush).
    await externalChange(document, EXTERNAL)
    for (const content of [TYPED, `${TYPED}K`])
      await panel._receiveMessage({
        command: 'edit',
        content,
        revision: baseline.revision,
      })
    await (session as any).editMessageChain
    await vi.advanceTimersByTimeAsync(200)

    expect(document.getText()).toBe(EXTERNAL)
    expect(applied).not.toHaveBeenCalled()
    const reposted = updates()
    expect(reposted).toHaveLength(1)
    expect(reposted[0].content).toBe(EXTERNAL)
    expect(reposted[0].revision).toBeGreaterThan(baseline.revision)
    expect(mock.calls.showWarning).toHaveLength(1)
    expect(mock.calls.showWarning[0].message).toMatch(/changed/i)
  })

  it('(b) a change that lands during VMDE’s own write is external: baseline adopted, update posted', async () => {
    const { session, panel, document } = makeSession()
    session.start()
    await panel._receiveMessage({ command: 'ready' })
    const baseline = updates().find((m) => m.type === 'init')
    const adopt = vi.spyOn(WritebackController.prototype, 'setCleanBaseline')
    vi.spyOn(vscode.workspace, 'applyEdit').mockImplementationOnce(
      async (edit: any) => {
        // VMDE's own write lands and echoes ...
        for (const replacement of edit.replacements)
          document.__setText(replacement.content)
        mock.fireDidChangeTextDocument(document)
        // ... and a reload from disk lands before applyEdit resolves.
        await externalChange(document, EXTERNAL)
        return true
      },
    )
    mock.calls.postMessage.length = 0

    await panel._receiveMessage({
      command: 'edit',
      content: TYPED,
      revision: baseline.revision,
    })
    await (session as any).editMessageChain
    await vi.advanceTimersByTimeAsync(200)

    expect(document.getText()).toBe(EXTERNAL)
    expect(adopt).toHaveBeenCalledWith(EXTERNAL)
    const posted = updates().filter((m) => m.content === EXTERNAL)
    expect(posted).toHaveLength(1)
    expect(posted[0].revision).toBeGreaterThan(baseline.revision)
  })

  it('(d) an edit without a revision is written as before', async () => {
    const { session, panel, document } = makeSession()
    session.start()
    await panel._receiveMessage({ command: 'ready' })
    mock.calls.postMessage.length = 0

    await panel._receiveMessage({ command: 'edit', content: TYPED })
    await (session as any).editMessageChain

    expect(document.getText()).toBe(TYPED)
    expect(mock.calls.showWarning).toHaveLength(0)
  })

  it('(d) an edit made from the current revision is written', async () => {
    const { session, panel, document } = makeSession()
    session.start()
    await panel._receiveMessage({ command: 'ready' })
    const current = updates().find((m) => m.type === 'init')

    await panel._receiveMessage({
      command: 'edit',
      content: TYPED,
      revision: current.revision,
    })
    await (session as any).editMessageChain

    expect(document.getText()).toBe(TYPED)
    expect(mock.calls.showWarning).toHaveLength(0)
  })

  it('(e) a native Undo run for the webview history is not an outside change', async () => {
    const { session, panel, document } = makeSession(TYPED)
    mock.setExecuteCommandResponse((command) => {
      if (command !== 'undo') return
      document.__setText(SOURCE)
      mock.fireDidChangeTextDocument(document)
    })
    session.start()
    await panel._receiveMessage({ command: 'ready' })
    const init = updates().find((m) => m.type === 'init')
    const forget = vi.spyOn(
      HistoryCouplingController.prototype,
      'forgetHostMappings',
    )
    const syncState = (session as any).docSync.syncState
    const adopt = vi.spyOn(WritebackController.prototype, 'setCleanBaseline')
    mock.calls.postMessage.length = 0

    await panel._receiveMessage({
      command: 'history-transition',
      kind: 'undo',
      before: TYPED,
      after: SOURCE,
    })
    await (session as any).editMessageChain
    await vi.advanceTimersByTimeAsync(200)
    // Redo from the same webview revision is still accepted.
    await panel._receiveMessage({
      command: 'edit',
      content: `${TYPED}K\n`,
      revision: init.revision,
    })
    await (session as any).editMessageChain

    // Native history traversal is VMDE's own change: no revision bump, no history-mapping reset
    // (the published and base proofs stay), no baseline adoption, no update, no warning.
    expect(syncState.getExternalRevision()).toBe(init.revision)
    expect(forget).not.toHaveBeenCalled()
    expect(adopt).not.toHaveBeenCalled()
    expect(updates()).toHaveLength(0)
    expect(document.getText()).toBe(`${TYPED}K\n`)
    expect(mock.calls.showWarning).toHaveLength(0)
  })

  it('(f) the inlined init payload carries the current revision', async () => {
    const { session, panel, document } = makeSession()
    mock.setConfig({ enabled: false }) // a wiki file keeps the ready/init round trip instead
    session.start()
    await externalChange(document, EXTERNAL)
    const payload = JSON.parse(
      (session as any).inlineInitPayload(EXTERNAL) as string,
    )
    expect(payload.revision).toBe(
      (session as any).docSync.syncState.getExternalRevision(),
    )
    expect(payload.revision).toBeGreaterThan(0)
    expect(panel).toBeDefined()
  })
})
