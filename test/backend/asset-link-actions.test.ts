import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AssetLinkActions,
  ensureCanWriteFiles,
  shouldOpenTargetWithVmde,
} from '../../src/session/asset-link-actions'
import { activePanels } from '../../src/platform/active-panels'
import { MarkdownEditorViewType } from '../../src/shared/product-identity'
import { _resetCacheMap } from '../../src/wiki/wiki-cache'
import { FileType, mock, Uri } from './vscode-mock'

// Task 405 — onUpload/onOpenLink/onOpenWikilink + ensureCanWriteFiles extracted out of
// EditorSession into an independently-constructible unit (mirrors editor-session.test.ts's
// "no provider, no real deps" style). The webview-message-level behaviour for these three
// handlers is ALSO exercised end-to-end via image-upload.test.ts / open-link.test.ts /
// wikilink-handler.test.ts (through EditorSession, unmodified) — this file proves the
// class works in isolation, which is the actual decomposition payoff.

function makeActions(
  overrides: Partial<{
    activeUri: Uri
    activeFsPath: string
    workspaceFolder: any
    documentUri: Uri
    // Task 468 — defaults to VMDE, matching production reality: onOpenLink is ONLY ever
    // invoked by an EditorSession's own webview message handler (grep confirms no other
    // caller), so every REAL call already has a VMDE source. Tests that want the "source is
    // some other editor" branch pass this explicitly.
    sourceViewType: string
  }> = {},
) {
  const activeUri = overrides.activeUri ?? Uri.file('/ws/note.md')
  const postMessage = vi.fn()
  const debug = vi.fn()
  const showError = vi.fn()
  const actions = new AssetLinkActions({
    getActiveUri: () => activeUri,
    getActiveFsPath: () => overrides.activeFsPath ?? activeUri.fsPath,
    getWorkspaceFolder: () => overrides.workspaceFolder,
    getDocumentUri: () => overrides.documentUri ?? activeUri,
    postMessage,
    debug,
    showError,
    getSourceViewType: () => overrides.sourceViewType ?? MarkdownEditorViewType,
  })
  return { actions, postMessage, debug, showError }
}

describe('ensureCanWriteFiles', () => {
  beforeEach(() => mock.reset())

  it('true for a trusted, file-scheme workspace', () => {
    mock.setTrusted(true)
    expect(ensureCanWriteFiles(Uri.file('/ws/note.md'))).toBe(true)
  })

  it('false + info message for a non-file scheme (virtual workspace)', () => {
    mock.setTrusted(true)
    expect(ensureCanWriteFiles(Uri.parse('vscode-vfs://x/note.md'))).toBe(false)
    expect(mock.calls.showInformation.length).toBeGreaterThan(0)
  })

  it('false + warning for an untrusted workspace', () => {
    mock.setTrusted(false)
    expect(ensureCanWriteFiles(Uri.file('/ws/note.md'))).toBe(false)
    expect(mock.calls.showWarning.length).toBeGreaterThan(0)
  })
})

describe('AssetLinkActions.onUpload', () => {
  beforeEach(() => {
    mock.reset()
    mock.setWorkspaceFolder('/ws')
    mock.setTrusted(true)
  })

  it('writes each file under the assets folder and replies with relative paths', async () => {
    const { actions, postMessage } = makeActions({
      activeUri: Uri.file('/ws/note.md'),
      activeFsPath: '/ws/note.md',
    })
    await actions.onUpload({
      command: 'upload',
      files: [{ name: 'pic.png', base64: Buffer.from('x').toString('base64') }],
    } as any)
    expect(mock.calls.fsWrites).toHaveLength(1)
    expect(mock.calls.fsWrites[0].uri.fsPath).toBe('/ws/assets/pic.png')
    expect(postMessage).toHaveBeenCalledWith({
      command: 'uploaded',
      files: ['assets/pic.png'],
    })
  })

  it('reduces a name with directory components to its basename before writing', async () => {
    const { actions, postMessage } = makeActions({
      activeUri: Uri.file('/ws/note.md'),
      activeFsPath: '/ws/note.md',
    })
    await actions.onUpload({
      command: 'upload',
      files: [{ name: '../../evil.png', base64: '' }],
    } as any)
    // NodePath.basename strips the traversal components — the write lands INSIDE the
    // assets folder as a plain "evil.png", it is not refused (that's the defense: no
    // raw name ever reaches the join).
    expect(mock.calls.fsWrites).toHaveLength(1)
    expect(mock.calls.fsWrites[0].uri.fsPath).toBe('/ws/assets/evil.png')
    expect(postMessage).toHaveBeenCalledWith({
      command: 'uploaded',
      files: ['assets/evil.png'],
    })
  })

  it('rejects a literal ".." name — the containment check catches what basename cannot', async () => {
    const { actions, postMessage, debug } = makeActions({
      activeUri: Uri.file('/ws/note.md'),
      activeFsPath: '/ws/note.md',
    })
    await actions.onUpload({
      command: 'upload',
      files: [{ name: '..', base64: '' }],
    } as any)
    expect(mock.calls.fsWrites).toHaveLength(0)
    expect(debug).toHaveBeenCalled()
    expect(postMessage).toHaveBeenCalledWith({ command: 'uploaded', files: [] })
  })

  it('does nothing when the workspace is untrusted', async () => {
    mock.setTrusted(false)
    const { actions, postMessage } = makeActions({
      activeUri: Uri.file('/ws/note.md'),
      activeFsPath: '/ws/note.md',
    })
    await actions.onUpload({
      command: 'upload',
      files: [{ name: 'pic.png', base64: '' }],
    } as any)
    expect(mock.calls.fsWrites).toHaveLength(0)
    expect(postMessage).not.toHaveBeenCalled()
  })
})

// Task 468 — pulled out of onOpenLink (task 469's cognitive-complexity gate, and a genuinely
// distinct question from the routing it feeds — lead review). Primary coverage for the
// "follow the source" decision itself; onOpenLink's own tests below additionally prove the
// handler actually USES this predicate's result (the wiring, not just the logic).
describe('shouldOpenTargetWithVmde', () => {
  it('true for a .md target when the source is VMDE', () => {
    expect(
      shouldOpenTargetWithVmde('/ws/sibling.md', MarkdownEditorViewType),
    ).toBe(true)
  })

  it('true for a .markdown target when the source is VMDE', () => {
    expect(
      shouldOpenTargetWithVmde('/ws/sibling.markdown', MarkdownEditorViewType),
    ).toBe(true)
  })

  it('is case-insensitive on the extension', () => {
    expect(
      shouldOpenTargetWithVmde('/ws/SIBLING.MD', MarkdownEditorViewType),
    ).toBe(true)
  })

  it('false when the source is NOT VMDE, even for a .md target', () => {
    expect(shouldOpenTargetWithVmde('/ws/sibling.md', 'default')).toBe(false)
  })

  it('false for a non-markdown target, even when the source IS VMDE', () => {
    expect(
      shouldOpenTargetWithVmde('/ws/image.png', MarkdownEditorViewType),
    ).toBe(false)
  })

  it('false when neither condition holds', () => {
    expect(shouldOpenTargetWithVmde('/ws/image.png', 'default')).toBe(false)
  })

  it('does not false-positive on a filename that merely CONTAINS "md"', () => {
    expect(
      shouldOpenTargetWithVmde('/ws/promd.txt', MarkdownEditorViewType),
    ).toBe(false)
  })
})

describe('AssetLinkActions.onOpenLink', () => {
  beforeEach(() => {
    mock.reset()
    mock.setWorkspaceFolder('/ws')
  })

  it('opens an http(s) URL externally', async () => {
    const { actions } = makeActions({ activeFsPath: '/ws/note.md' })
    await actions.onOpenLink({
      command: 'open-link',
      href: 'https://example.com',
    } as any)
    expect(mock.calls.openExternal).toHaveLength(1)
  })

  it('opens a sibling markdown file WITH VMDE (task 468) when the source is a VMDE webview', async () => {
    const { actions } = makeActions({
      activeUri: Uri.file('/ws/note.md'),
      activeFsPath: '/ws/note.md',
      workspaceFolder: { uri: Uri.file('/ws'), name: 'ws', index: 0 },
    })
    await actions.onOpenLink({
      command: 'open-link',
      href: 'sibling.md',
    } as any)
    // NOT plain vscode.open (task 468) — priority:"option" means that would land in the
    // built-in text editor for a user with no editorAssociations override for .md.
    expect(
      mock.calls.executeCommand.some((c) => c.command === 'vscode.open'),
    ).toBe(false)
    const openWith = mock.calls.executeCommand.find(
      (c) => c.command === 'vscode.openWith',
    )
    expect(openWith?.args[0].fsPath).toBe('/ws/sibling.md')
    expect(openWith?.args[1]).toBe(MarkdownEditorViewType)
  })

  it('opens a sibling file with plain vscode.open (task 468) when the source is NOT a VMDE webview', async () => {
    const { actions } = makeActions({
      activeUri: Uri.file('/ws/note.md'),
      activeFsPath: '/ws/note.md',
      workspaceFolder: { uri: Uri.file('/ws'), name: 'ws', index: 0 },
      sourceViewType: 'default', // VS Code's built-in text editor viewType
    })
    await actions.onOpenLink({
      command: 'open-link',
      href: 'sibling.md',
    } as any)
    expect(
      mock.calls.executeCommand.some((c) => c.command === 'vscode.openWith'),
    ).toBe(false)
    const open = mock.calls.executeCommand.find(
      (c) => c.command === 'vscode.open',
    )
    expect(open?.args[0].fsPath).toBe('/ws/sibling.md')
  })

  it('opens a sibling NON-markdown file with plain vscode.open (task 468) even when the source is VMDE', async () => {
    // VMDE's own customEditor selector (package.json) only matches *.md/*.markdown — forcing
    // openWith on some other filetype would hand it a viewType that doesn't apply to it.
    const { actions } = makeActions({
      activeUri: Uri.file('/ws/note.md'),
      activeFsPath: '/ws/note.md',
      workspaceFolder: { uri: Uri.file('/ws'), name: 'ws', index: 0 },
    })
    await actions.onOpenLink({
      command: 'open-link',
      href: 'image.png',
    } as any)
    expect(
      mock.calls.executeCommand.some((c) => c.command === 'vscode.openWith'),
    ).toBe(false)
    const open = mock.calls.executeCommand.find(
      (c) => c.command === 'vscode.open',
    )
    expect(open?.args[0].fsPath).toBe('/ws/image.png')
  })

  it('refuses a target outside the workspace (task 148 item 2)', async () => {
    const { actions, showError, debug } = makeActions({
      activeUri: Uri.file('/ws/sub/note.md'),
      activeFsPath: '/ws/sub/note.md',
      workspaceFolder: { uri: Uri.file('/ws'), name: 'ws', index: 0 },
    })
    await actions.onOpenLink({
      command: 'open-link',
      href: '../../etc/passwd',
    } as any)
    expect(showError).toHaveBeenCalledTimes(1)
    expect(debug).toHaveBeenCalled()
    expect(
      mock.calls.executeCommand.some((c) => c.command === 'vscode.open'),
    ).toBe(false)
  })

  // Task 359 — the rest of the onOpenLink behaviour (scheme allowlist, Uri.file not
  // Uri.parse, directory/missing-target handling). The classifier itself is pinned
  // exhaustively in link-target.test.ts; these prove onOpenLink wires it up correctly.

  it('passes an allowlisted scheme (mailto:) to vscode.open unparsed, not through fs.stat', async () => {
    const { actions } = makeActions({ activeFsPath: '/ws/note.md' })
    await actions.onOpenLink({
      command: 'open-link',
      href: 'mailto:test@example.com',
    } as any)
    const open = mock.calls.executeCommand.find(
      (c) => c.command === 'vscode.open',
    )
    // Uri.parse('mailto:test@example.com') — the mock's scoped-URI branch, scheme "mailto".
    expect(open?.args[0].scheme).toBe('mailto')
    expect(mock.calls.openExternal).toHaveLength(0)
  })

  it('refuses a command: link — never reaches vscode.open', async () => {
    const { actions, showError } = makeActions({ activeFsPath: '/ws/note.md' })
    await actions.onOpenLink({
      command: 'open-link',
      href: 'command:workbench.action.terminal.new',
    } as any)
    expect(showError).toHaveBeenCalledTimes(1)
    expect(
      mock.calls.executeCommand.some((c) => c.command === 'vscode.open'),
    ).toBe(false)
  })

  it('refuses a file: link — would otherwise bypass the containment check entirely', async () => {
    const { actions, showError } = makeActions({ activeFsPath: '/ws/note.md' })
    await actions.onOpenLink({
      command: 'open-link',
      href: 'file:///etc/passwd',
    } as any)
    expect(showError).toHaveBeenCalledTimes(1)
    expect(
      mock.calls.executeCommand.some((c) => c.command === 'vscode.open'),
    ).toBe(false)
  })

  it('no-ops on a same-document anchor ("#heading") — left to task 243, not an error', async () => {
    const { actions, showError } = makeActions({ activeFsPath: '/ws/note.md' })
    await actions.onOpenLink({ command: 'open-link', href: '#heading' } as any)
    expect(showError).not.toHaveBeenCalled()
    expect(mock.calls.executeCommand).toHaveLength(0)
  })

  it('resolves a percent-encoded space in a relative link to the real filename', async () => {
    const { actions } = makeActions({
      activeUri: Uri.file('/ws/note.md'),
      activeFsPath: '/ws/note.md',
      workspaceFolder: { uri: Uri.file('/ws'), name: 'ws', index: 0 },
    })
    await actions.onOpenLink({
      command: 'open-link',
      href: 'my%20file.md',
    } as any)
    const openWith = mock.calls.executeCommand.find(
      (c) => c.command === 'vscode.openWith',
    )
    expect(openWith?.args[0].fsPath).toBe('/ws/my file.md')
  })

  it('reveals a directory target in the Explorer instead of trying to open it as a file', async () => {
    mock.setFsEntry('/ws/sub', 'directory')
    const { actions } = makeActions({
      activeUri: Uri.file('/ws/note.md'),
      activeFsPath: '/ws/note.md',
      workspaceFolder: { uri: Uri.file('/ws'), name: 'ws', index: 0 },
    })
    await actions.onOpenLink({ command: 'open-link', href: 'sub' } as any)
    const reveal = mock.calls.executeCommand.find(
      (c) => c.command === 'revealInExplorer',
    )
    expect(reveal?.args[0].fsPath).toBe('/ws/sub')
    expect(
      mock.calls.executeCommand.some((c) => c.command === 'vscode.open'),
    ).toBe(false)
  })

  it('shows a readable error naming the resolved path for a missing target, instead of a raw/silent failure', async () => {
    mock.setFsEntry('/ws/does-not-exist.md', 'missing')
    const { actions, showError } = makeActions({
      activeUri: Uri.file('/ws/note.md'),
      activeFsPath: '/ws/note.md',
      workspaceFolder: { uri: Uri.file('/ws'), name: 'ws', index: 0 },
    })
    await actions.onOpenLink({
      command: 'open-link',
      href: 'does-not-exist.md',
    } as any)
    expect(showError).toHaveBeenCalledWith(
      expect.stringContaining('/ws/does-not-exist.md'),
    )
    expect(
      mock.calls.executeCommand.some((c) => c.command === 'vscode.open'),
    ).toBe(false)
  })
})

// Task 243 step 4 — `file.md#frag`: onOpenLink already opens the target (proven above); these
// pin the NEW behaviour layered on top — resolving the fragment and posting `scroll-to-heading`
// to the TARGET's own panel. `activePanels` is the real module-level registry (active-panels.ts)
// AssetLinkActions imports directly (not injected), so tests populate/clear it exactly like
// active-panels.test.ts does for markdown-editor-provider.
describe('AssetLinkActions.onOpenLink — cross-doc fragment (task 243 step 4)', () => {
  beforeEach(() => {
    mock.reset()
    activePanels.clear()
    mock.setWorkspaceFolder('/ws')
  })

  // `postMessage` resolves `true` (delivered) by default — matching the real
  // `vscode.Webview.postMessage` contract the "genuine fallback" logic gates on (see the big
  // comment above `post` in scrollToFragmentAfterOpen for the full history, including a round
  // where the gate was wrongly suspected of dropping messages — it wasn't; the real bug was a
  // DOM-readiness race in the webview, fixed in message-router.ts). Tests that need to simulate
  // a NOT-yet-delivered immediate post (the ready-fallback path) pass their own impl.
  // `onDidReceiveMessage`'s registered callback is captured so a test can simulate the webview's
  // `ready` post by calling `fireReady()` directly — real VS Code invokes it the same way (the
  // panel's `Webview.onDidReceiveMessage` event firing).
  function registerPanel(
    fsPath: string,
    postMessageImpl: (msg: unknown) => Promise<boolean> = () =>
      Promise.resolve(true),
  ) {
    const postMessage = vi.fn(postMessageImpl)
    let messageHandler: ((m: unknown) => void) | undefined
    const onDidReceiveMessage = vi.fn((cb: (m: unknown) => void) => {
      messageHandler = cb
      return { dispose: vi.fn() }
    })
    const uri = Uri.file(fsPath)
    activePanels.add({
      panel: { webview: { postMessage, onDidReceiveMessage } } as any,
      uri,
    })
    return {
      postMessage,
      onDidReceiveMessage,
      fireReady: () => messageHandler?.({ command: 'ready' }),
    }
  }

  it("posts scroll-to-heading with the TARGET file's own heading index, not the source doc's", async () => {
    // The source doc (where the link lives) has a heading with the SAME slug ("shared") at a
    // DIFFERENT index than the target — the exact "silently looks right while being wrong" trap:
    // if resolution ever ran against the wrong document, this index (0) would be posted instead
    // of the target's (1), and a naive assertion on "some index got posted" wouldn't catch it.
    mock.setDocument('/ws/note.md', '# Shared\n')
    mock.setDocument('/ws/sibling.md', '# Intro\n\n## Shared\n')
    const { postMessage } = registerPanel('/ws/sibling.md')
    const { actions } = makeActions({
      activeUri: Uri.file('/ws/note.md'),
      activeFsPath: '/ws/note.md',
      workspaceFolder: { uri: Uri.file('/ws'), name: 'ws', index: 0 },
    })
    await actions.onOpenLink({
      command: 'open-link',
      href: 'sibling.md#shared',
    } as any)
    expect(postMessage).toHaveBeenCalledWith({
      command: 'scroll-to-heading',
      index: 1, // sibling.md's OWN "Shared" is its 2nd heading (index 1), not index 0
    })
  })

  it('strips the fragment before vscode.openWith (the target Uri never carries it)', async () => {
    mock.setDocument('/ws/sibling.md', '# Target\n')
    registerPanel('/ws/sibling.md')
    const { actions } = makeActions({
      activeUri: Uri.file('/ws/note.md'),
      activeFsPath: '/ws/note.md',
      workspaceFolder: { uri: Uri.file('/ws'), name: 'ws', index: 0 },
    })
    await actions.onOpenLink({
      command: 'open-link',
      href: 'sibling.md#target',
    } as any)
    const openWith = mock.calls.executeCommand.find(
      (c) => c.command === 'vscode.openWith',
    )
    expect(openWith?.args[0].fsPath).toBe('/ws/sibling.md')
  })

  it('resolves a {#custom-id} heading in the target file, same priority as the same-doc case', async () => {
    mock.setDocument('/ws/sibling.md', '# Plain\n\n## Aside {#custom-id}\n')
    const { postMessage } = registerPanel('/ws/sibling.md')
    const { actions } = makeActions({
      activeUri: Uri.file('/ws/note.md'),
      activeFsPath: '/ws/note.md',
      workspaceFolder: { uri: Uri.file('/ws'), name: 'ws', index: 0 },
    })
    await actions.onOpenLink({
      command: 'open-link',
      href: 'sibling.md#custom-id',
    } as any)
    expect(postMessage).toHaveBeenCalledWith({
      command: 'scroll-to-heading',
      index: 1,
    })
  })

  it('reveals the first named HTML target when no heading owns the fragment', async () => {
    mock.setDocument('/ws/sibling.md', 'before\n<a name="custom"></a>\nafter\n')
    const { postMessage } = registerPanel('/ws/sibling.md')
    const { actions } = makeActions({
      activeUri: Uri.file('/ws/note.md'),
      activeFsPath: '/ws/note.md',
      workspaceFolder: { uri: Uri.file('/ws'), name: 'ws', index: 0 },
    })
    await actions.onOpenLink({
      command: 'open-link',
      href: 'sibling.md#custom',
    } as any)
    expect(postMessage).toHaveBeenCalledWith({
      command: 'reveal-line',
      line: 1,
      lineText: '<a name="custom"></a>',
    })
  })

  it('posts nothing when the fragment matches no heading in the target', async () => {
    mock.setDocument('/ws/sibling.md', '# Target\n')
    const { postMessage } = registerPanel('/ws/sibling.md')
    const { actions } = makeActions({
      activeUri: Uri.file('/ws/note.md'),
      activeFsPath: '/ws/note.md',
      workspaceFolder: { uri: Uri.file('/ws'), name: 'ws', index: 0 },
    })
    await actions.onOpenLink({
      command: 'open-link',
      href: 'sibling.md#does-not-exist',
    } as any)
    expect(postMessage).not.toHaveBeenCalled()
  })

  it('does nothing (no crash) when no VMDE panel is registered for the target', async () => {
    mock.setDocument('/ws/sibling.md', '# Target\n')
    // no registerPanel() call — activePanels stays empty for this uri
    const { actions } = makeActions({
      activeUri: Uri.file('/ws/note.md'),
      activeFsPath: '/ws/note.md',
      workspaceFolder: { uri: Uri.file('/ws'), name: 'ws', index: 0 },
    })
    await expect(
      actions.onOpenLink({
        command: 'open-link',
        href: 'sibling.md#target',
      } as any),
    ).resolves.not.toThrow()
  })

  it('does not post scroll-to-heading for a plain link with no fragment', async () => {
    mock.setDocument('/ws/sibling.md', '# Target\n')
    const { postMessage } = registerPanel('/ws/sibling.md')
    const { actions } = makeActions({
      activeUri: Uri.file('/ws/note.md'),
      activeFsPath: '/ws/note.md',
      workspaceFolder: { uri: Uri.file('/ws'), name: 'ws', index: 0 },
    })
    await actions.onOpenLink({
      command: 'open-link',
      href: 'sibling.md',
    } as any)
    expect(postMessage).not.toHaveBeenCalled()
  })

  // Task 243 "genuine fallback" fix — found via a real-VS-Code window-array diagnostic: the
  // FIRST version posted immediately AND unconditionally on `ready`, and BOTH landed every
  // time (scroll-to-heading ran twice in the webview, confirmed by the diagnostic log). Gate on
  // `postMessage`'s own returned `Thenable<boolean>` instead of assuming either send succeeds
  // or fails — these pin both orderings the fix has to get right.
  //
  // Task 468 debugging revised the LISTENER'S arming point once more (not this gate): it's now
  // armed BEFORE the immediate post is even attempted, because `postMessage`'s own await can
  // itself take long enough for `ready` to land WHILE it's still pending — measured
  // intermittently in real VS Code, a fallback attached too late never saw it. A separate 468
  // finding (see scrollToFragmentAfterOpen's own comment) briefly suspected THIS gate itself was
  // unsound; it wasn't — the actual bug was a DOM-readiness race in the webview, fixed in
  // message-router.ts, and doesn't change anything pinned here.
  it('immediate delivered (postMessage resolves true): does NOT repost when ready fires later', async () => {
    mock.setDocument('/ws/sibling.md', '# Target\n')
    const { postMessage, onDidReceiveMessage, fireReady } = registerPanel(
      '/ws/sibling.md',
      () => Promise.resolve(true), // delivered on the first (immediate) send
    )
    const { actions } = makeActions({
      activeUri: Uri.file('/ws/note.md'),
      activeFsPath: '/ws/note.md',
      workspaceFolder: { uri: Uri.file('/ws'), name: 'ws', index: 0 },
    })
    await actions.onOpenLink({
      command: 'open-link',
      href: 'sibling.md#target',
    } as any)
    expect(postMessage).toHaveBeenCalledTimes(1)
    // The listener IS armed (before the immediate post is even attempted) — but a LATE
    // `ready` (a stale/unexpected one, or a test bug simulating it anyway), arriving after
    // delivery already succeeded, must not cause a second post.
    expect(onDidReceiveMessage).toHaveBeenCalledTimes(1)
    fireReady()
    expect(postMessage).toHaveBeenCalledTimes(1)
  })

  it('immediate not delivered (postMessage resolves false): reposts once ready fires', async () => {
    mock.setDocument('/ws/sibling.md', '# Target\n')
    let calls = 0
    const { postMessage, onDidReceiveMessage, fireReady } = registerPanel(
      '/ws/sibling.md',
      () => {
        calls++
        // First (immediate) send is NOT delivered yet; every send after that succeeds —
        // mirrors a freshly-opened panel whose page hasn't attached a listener yet.
        return Promise.resolve(calls > 1)
      },
    )
    const { actions } = makeActions({
      activeUri: Uri.file('/ws/note.md'),
      activeFsPath: '/ws/note.md',
      workspaceFolder: { uri: Uri.file('/ws'), name: 'ws', index: 0 },
    })
    await actions.onOpenLink({
      command: 'open-link',
      href: 'sibling.md#target',
    } as any)
    // Immediate post happened and failed to deliver — the fallback IS armed this time.
    expect(postMessage).toHaveBeenCalledTimes(1)
    expect(onDidReceiveMessage).toHaveBeenCalledTimes(1)
    await fireReady()
    expect(postMessage).toHaveBeenCalledTimes(2)
    expect(postMessage).toHaveBeenNthCalledWith(2, {
      command: 'scroll-to-heading',
      index: 0,
    })
  })

  // Task 468 debugging — the exact race that motivated arming the `ready` listener BEFORE
  // attempting the immediate post: `ready` fires WHILE the immediate post's own `postMessage`
  // await is still pending, and the immediate post goes on to resolve `false` (not delivered —
  // a freshly-opened webview's early message getting dropped). If the listener were armed only
  // AFTER the immediate post settles (the previous shape), this `ready` would already be gone
  // by the time anything was listening for it, and the scroll message would never be sent at
  // all — measured intermittently in real VS Code.
  it('ready fires WHILE the immediate post is still pending: still reposts, does not miss it', async () => {
    mock.setDocument('/ws/sibling.md', '# Target\n')
    let resolveImmediate: ((delivered: boolean) => void) | undefined
    let callCount = 0
    const { postMessage, fireReady } = registerPanel('/ws/sibling.md', () => {
      callCount++
      if (callCount === 1) {
        // The immediate send stays pending until the test resolves it below, so `fireReady()`
        // can be called WHILE it's still in flight.
        return new Promise<boolean>((resolve) => {
          resolveImmediate = resolve
        })
      }
      return Promise.resolve(true)
    })
    const { actions } = makeActions({
      activeUri: Uri.file('/ws/note.md'),
      activeFsPath: '/ws/note.md',
      workspaceFolder: { uri: Uri.file('/ws'), name: 'ws', index: 0 },
    })
    const openLinkDone = actions.onOpenLink({
      command: 'open-link',
      href: 'sibling.md#target',
    } as any)
    // Let onOpenLink run up to (and into) the immediate post's pending await — several awaited
    // mocked calls (fs.stat, executeCommand) sit before it, so flush macrotasks (which drain
    // every pending microtask first) rather than guessing a fixed number of microtask ticks.
    for (let i = 0; i < 5 && !resolveImmediate; i++) {
      await new Promise((r) => setTimeout(r, 0))
    }
    expect(resolveImmediate).toBeDefined()
    // `ready` fires while the immediate post is still unresolved.
    fireReady()
    // NOW the immediate post resolves false (not delivered) — the realistic "dropped" case.
    resolveImmediate!(false)
    await openLinkDone
    expect(postMessage).toHaveBeenCalledTimes(2)
    expect(postMessage).toHaveBeenNthCalledWith(2, {
      command: 'scroll-to-heading',
      index: 0,
    })
  })
})

describe('AssetLinkActions.onOpenWikilink', () => {
  beforeEach(() => {
    mock.reset()
    _resetCacheMap()
    mock.setWorkspaceFolder('/ws')
    mock.setConfig({ enabled: true, root: '' })
    mock.setReadDirectory(async (uri: Uri) =>
      uri.fsPath === '/ws' ? [['Home.md', FileType.File]] : [],
    )
  })

  it('opens a uniquely-resolved wiki page', async () => {
    const { actions } = makeActions({ documentUri: Uri.file('/ws/Home.md') })
    await actions.onOpenWikilink({
      command: 'open-wikilink',
      target: 'Home',
    } as any)
    expect(
      mock.calls.executeCommand.some(
        (c) =>
          c.command === 'vscode.openWith' && c.args[0].fsPath === '/ws/Home.md',
      ),
    ).toBe(true)
  })

  it('errors on an empty/whitespace target', async () => {
    const { actions, showError } = makeActions({
      documentUri: Uri.file('/ws/Home.md'),
    })
    await actions.onOpenWikilink({
      command: 'open-wikilink',
      target: '   ',
    } as any)
    expect(showError).toHaveBeenCalled()
  })
})

// Task 229 — resolve/open for clickable code references. Unlike onOpenLink (doc-relative,
// task 148 item 2), these resolve WORKSPACE-relative — the convention code refs in prose
// actually use (`src/foo.ts:42`, not `../../src/foo.ts:42`).
describe('AssetLinkActions.onResolveCodeRefs', () => {
  beforeEach(() => mock.reset())

  it('reports only the paths that resolve to a real FILE under the workspace', async () => {
    mock.setWorkspaceFolder('/ws')
    mock.setFsEntry('/ws/src/foo.ts', 'file')
    mock.setFsEntry('/ws/src/missing.ts', 'missing')
    mock.setFsEntry('/ws/src', 'directory')
    const { actions, postMessage } = makeActions({
      activeFsPath: '/ws/docs/note.md',
      workspaceFolder: { uri: Uri.file('/ws'), name: 'ws', index: 0 },
    })
    await actions.onResolveCodeRefs({
      command: 'resolve-code-refs',
      requestId: 'r1',
      paths: ['src/foo.ts', 'src/missing.ts', 'src', '../../etc/passwd'],
    } as any)
    expect(postMessage).toHaveBeenCalledWith({
      command: 'code-refs-resolved',
      requestId: 'r1',
      existing: ['src/foo.ts'],
    })
  })

  it('resolves against the DOCUMENT directory when there is no workspace folder', async () => {
    mock.setFsEntry('/proj/sub/src/foo.ts', 'file')
    const { actions, postMessage } = makeActions({
      activeFsPath: '/proj/sub/note.md',
      workspaceFolder: undefined,
    })
    await actions.onResolveCodeRefs({
      command: 'resolve-code-refs',
      requestId: 'r2',
      paths: ['src/foo.ts'],
    } as any)
    expect(postMessage).toHaveBeenCalledWith({
      command: 'code-refs-resolved',
      requestId: 'r2',
      existing: ['src/foo.ts'],
    })
  })

  it('echoes back the requestId of the batch it answered, not a stale one', async () => {
    mock.setWorkspaceFolder('/ws')
    const { actions, postMessage } = makeActions({
      activeFsPath: '/ws/note.md',
      workspaceFolder: { uri: Uri.file('/ws'), name: 'ws', index: 0 },
    })
    await actions.onResolveCodeRefs({
      command: 'resolve-code-refs',
      requestId: 'batch-42',
      paths: [],
    } as any)
    expect(postMessage).toHaveBeenCalledWith({
      command: 'code-refs-resolved',
      requestId: 'batch-42',
      existing: [],
    })
  })
})

describe('AssetLinkActions.onOpenCodeRef', () => {
  beforeEach(() => mock.reset())

  it('opens the PLAIN text editor (not vscode.openWith) at the exact 1-based line/col', async () => {
    mock.setWorkspaceFolder('/ws')
    mock.setFsEntry('/ws/src/foo.ts', 'file')
    const { actions } = makeActions({
      activeFsPath: '/ws/docs/note.md',
      workspaceFolder: { uri: Uri.file('/ws'), name: 'ws', index: 0 },
    })
    await actions.onOpenCodeRef({
      command: 'open-code-ref',
      path: 'src/foo.ts',
      line: 42,
      col: 7,
    } as any)
    // Never vscode.openWith/vscode.open — showTextDocument is the only "always plain text
    // editor, regardless of any custom-editor association" API (task 229's explicit
    // requirement: the text editor path, NOT vmde's custom editor).
    expect(
      mock.calls.executeCommand.some(
        (c) => c.command === 'vscode.open' || c.command === 'vscode.openWith',
      ),
    ).toBe(false)
    expect(mock.calls.shownTextEditors).toHaveLength(1)
    const [shown] = mock.calls.shownTextEditors
    expect(shown.document.uri.fsPath).toBe('/ws/src/foo.ts')
    // line 42 (1-based, how people write it) → Position line 41 (0-based)
    expect(shown.options.selection.start).toEqual({ line: 41, character: 6 })
    expect(shown.options.selection.end).toEqual({ line: 41, character: 6 })
  })

  it('defaults to column 1 (start of line) when no column was written', async () => {
    mock.setWorkspaceFolder('/ws')
    mock.setFsEntry('/ws/src/foo.ts', 'file')
    const { actions } = makeActions({
      activeFsPath: '/ws/note.md',
      workspaceFolder: { uri: Uri.file('/ws'), name: 'ws', index: 0 },
    })
    await actions.onOpenCodeRef({
      command: 'open-code-ref',
      path: 'src/foo.ts',
      line: 1,
    } as any)
    const [shown] = mock.calls.shownTextEditors
    expect(shown.options.selection.start).toEqual({ line: 0, character: 0 })
  })

  it('shows a readable "File not found" error naming the resolved path — no silent no-op', async () => {
    mock.setWorkspaceFolder('/ws')
    mock.setFsEntry('/ws/src/missing.ts', 'missing')
    const { actions, showError } = makeActions({
      activeFsPath: '/ws/note.md',
      workspaceFolder: { uri: Uri.file('/ws'), name: 'ws', index: 0 },
    })
    await actions.onOpenCodeRef({
      command: 'open-code-ref',
      path: 'src/missing.ts',
      line: 5,
    } as any)
    expect(mock.calls.shownTextEditors).toHaveLength(0)
    expect(showError).toHaveBeenCalledTimes(1)
    expect(showError.mock.calls[0][0]).toContain('src/missing.ts')
  })

  it('refuses a target outside the workspace (mirrors onOpenLink, task 148 item 2)', async () => {
    mock.setWorkspaceFolder('/ws')
    const { actions, showError } = makeActions({
      activeFsPath: '/ws/note.md',
      workspaceFolder: { uri: Uri.file('/ws'), name: 'ws', index: 0 },
    })
    await actions.onOpenCodeRef({
      command: 'open-code-ref',
      path: '../../etc/passwd',
      line: 1,
    } as any)
    expect(mock.calls.shownTextEditors).toHaveLength(0)
    expect(showError).toHaveBeenCalledTimes(1)
    expect(showError.mock.calls[0][0]).toContain('outside the workspace')
  })
})
