import * as vscode from 'vscode'
import * as NodePath from 'node:path'
import { cfgFor, getUploadTarget } from '../platform/editor-config'
import { classifyHref } from '../shared/link-target'
import {
  parseHeadingsFromMarkdown,
  resolveFragment,
} from '../shared/heading-slug'
import {
  findNamedAnchor,
  parseNamedAnchorsFromMarkdown,
} from '../shared/named-anchor'
import { findPanelForUri } from '../platform/active-panels'
import { MarkdownEditorViewType } from '../shared/product-identity'
import {
  createWikiPage,
  getWikiRoot,
  normalizeWikiLookupKey,
} from '../wiki/wiki'
import { getOrBuildCache } from '../wiki/wiki-cache'
import type { HostMessage, WebviewMessage } from '../shared/protocol'

// Gate filesystem-writing actions (image upload, wiki page creation) on the
// declared capabilities (see package.json `capabilities`): not in virtual
// workspaces (non-file scheme), and not in an untrusted workspace.
export function ensureCanWriteFiles(uri: vscode.Uri): boolean {
  if (uri.scheme !== 'file') {
    vscode.window.showInformationMessage(
      `[VMDE] Image upload and wiki page creation are unavailable in virtual workspaces.`,
    )
    return false
  }
  if (!vscode.workspace.isTrusted) {
    vscode.window.showWarningMessage(
      `[VMDE] Trust this workspace to upload images and create wiki pages.`,
    )
    return false
  }
  return true
}

// Task 468 — "follow a link the way you were reading" (the user's own product decision,
// option (b) of the task's four; reproduced first in a fresh profile — see the task file):
// vmde's customEditor `priority` is `"option"`, not `"default"` (package.json), so plain
// `vscode.open` is not guaranteed to land in VMDE at all for a user who has never explicitly
// picked it for `.md` — measured, it silently opens the built-in text editor instead. Answers
// "should onOpenLink force `vscode.openWith(…, 'vmde.editor')` for this target?" — true ONLY
// when BOTH: (a) the SOURCE panel — the one this click came from — is itself a VMDE webview
// (never true from any other caller; onOpenLink is only ever invoked by an EditorSession's own
// webview message handler, so `sourceViewType` is effectively "was this link clicked inside
// VMDE", exactly what "follow the way you were reading" means), and (b) the TARGET is itself
// a markdown file — vmde's own customEditor selector (package.json) only matches
// `*.md`/`*.markdown`, so forcing `openWith` on some other filetype would try to open it with a
// viewType that doesn't apply to it. Neither condition makes this unconditional like option (a)
// (rejected — overrides a user who deliberately prefers the text editor for markdown) or as
// broad as option (c) (rejected — raising `priority` to `"default"` would change every `.md`
// open in the workspace, not just link-following). Pulled out to its own named predicate
// (task 469's cognitive-complexity gate, not just for the sake of it) — independently
// unit-testable, and it's a genuinely distinct question from the routing it feeds.
export function shouldOpenTargetWithVmde(
  targetPath: string,
  sourceViewType: string,
): boolean {
  return (
    /\.(md|markdown)$/i.test(targetPath) &&
    sourceViewType === MarkdownEditorViewType
  )
}

interface AssetLinkDeps {
  getActiveUri: () => vscode.Uri
  getActiveFsPath: () => string
  getWorkspaceFolder: () => vscode.WorkspaceFolder | undefined
  getDocumentUri: () => vscode.Uri
  postMessage: (msg: HostMessage) => void
  debug: (...args: unknown[]) => void
  showError: (msg: string) => void
  // Task 468 — the SOURCE panel's own `WebviewPanel.viewType` (data every EditorSession already
  // holds, not a new subscription/message/round-trip: mirrors the existing `postMessage` dep's
  // `this.webviewPanel.webview.postMessage(...)` closure). onOpenLink reads this to decide
  // whether a cross-file link "follows the way you were reading" — vscode.openWith(…,
  // 'vmde.editor') when the click came from inside a VMDE webview, plain vscode.open
  // otherwise (never overriding a user who deliberately opened the SOURCE with something else).
  getSourceViewType: () => string
}

// Task 405 — the three webview→host actions that write to disk or navigate outside the
// editor (onUpload, onOpenLink, onOpenWikilink), extracted out of EditorSession. Also the
// two containment checks [task 148](148-webview-security-hardening.md) items 1+2 cover
// (asset-folder write + link-open), now in one independently-testable unit.
export class AssetLinkActions {
  constructor(private readonly deps: AssetLinkDeps) {}

  async onUpload(
    message: Extract<WebviewMessage, { command: 'upload' }>,
  ): Promise<void> {
    if (!ensureCanWriteFiles(this.deps.getActiveUri())) {
      return
    }
    // Defense in depth (task 191 P1-18): never trust the webview-supplied name. Reduce it
    // to a bare basename (strips any `dir/` components) before it reaches either destination
    // resolver. Unsafe names are skipped, not written.
    const targets = message.files
      .map((file: any) => {
        const safeName = NodePath.basename(String(file.name))
        if (!safeName || safeName === '..') {
          this.deps.debug('upload: rejected unsafe file name', file.name)
          return null
        }
        return {
          file,
          target: getUploadTarget(this.deps.getActiveUri(), safeName),
        }
      })
      .filter((entry): entry is { file: any; target: string } => entry !== null)
    const folders = new Set(
      targets.map(({ target }) => NodePath.dirname(target)),
    )
    try {
      await Promise.all(
        [...folders].map((folder) =>
          vscode.workspace.fs.createDirectory(vscode.Uri.file(folder)),
        ),
      )
    } catch (error) {
      this.deps.debug('upload: createDirectory failed', error)
      this.deps.showError(`Invalid image folder: ${[...folders][0] ?? ''}`)
      return
    }
    const written = await Promise.all(
      targets.map(async ({ file, target }) => {
        await vscode.workspace.fs.writeFile(
          vscode.Uri.file(target),
          Buffer.from(file.base64, 'base64'),
        )
        return NodePath.relative(
          NodePath.dirname(this.deps.getActiveFsPath()),
          target,
        ).replace(/\\/g, '/')
      }),
    )
    this.deps.postMessage({
      command: 'uploaded',
      files: written,
    })
  }

  async onOpenLink(
    message: Extract<WebviewMessage, { command: 'open-link' }>,
  ): Promise<void> {
    const href = String(message.href)
    const classified = classifyHref(href)

    if (classified.kind === 'external') {
      // External URL → the OS default browser. env.openExternal is the canonical
      // API for this; vscode.open routes http inconsistently (Simple Browser).
      await vscode.env.openExternal(vscode.Uri.parse(classified.href))
      return
    }
    if (classified.kind === 'refused') {
      this.deps.debug('open-link: refused', href, classified.reason)
      this.deps.showError(`Can't open this link: ${classified.reason}`)
      return
    }
    if (classified.kind === 'scheme') {
      // A real URI (mailto:, tel:), allowlisted in link-target.ts. Uri.parse is
      // the correct constructor here — unlike the filesystem-path branch below, this is
      // genuinely a URI string, not an fsPath that happens to contain a colon (task 359 #1).
      await vscode.commands.executeCommand(
        'vscode.open',
        vscode.Uri.parse(classified.href),
      )
      return
    }
    if (classified.kind === 'same-doc-anchor') {
      // Fragment/heading navigation is task 243's job. No-op rather than resolving `#heading`
      // against the doc dir and failing to open a file literally named "#heading" (the
      // pre-fix behaviour — see tasks/359's probe measurements).
      this.deps.debug(
        'open-link: same-document anchor, not yet supported (task 243)',
        href,
      )
      return
    }

    // classified.kind === 'local' — a filesystem target (relative or absolute). Defense in
    // depth (task 148 item 2): contain the resolved target to the workspace folder (if the
    // doc belongs to one) or its own directory otherwise — mirrors onUpload's containment
    // above. Without this, `[x](/etc/passwd)` or `[x](../../../secret)` opened any file on
    // disk on click. classified.path is already percent-decoded and fragment-stripped.
    const activeFsPath = this.deps.getActiveFsPath()
    const local = NodePath.resolve(
      NodePath.dirname(activeFsPath),
      classified.path,
    )
    const workspaceFolder = this.deps.getWorkspaceFolder()
    const root = workspaceFolder?.uri.fsPath ?? NodePath.dirname(activeFsPath)
    const rel = NodePath.relative(root, local)
    if (rel.startsWith('..') || NodePath.isAbsolute(rel)) {
      this.deps.debug('open-link: refused out-of-scope target', href)
      this.deps.showError(
        `Can't open a link outside the ${workspaceFolder ? 'workspace' : 'document folder'}: ${href}`,
      )
      return
    }

    // Uri.file, not Uri.parse (task 359 #1) — `local` is a filesystem path, and Uri.parse
    // reads it as a URI string: on Windows a drive letter parses as scheme "c", and a POSIX
    // path containing "#"/"?"/"%" gets split into fragment/query/percent-decoded. Uri.file
    // takes it as the literal fsPath, which is what a resolved local target always is.
    const targetUri = vscode.Uri.file(local)
    let stat: vscode.FileStat | undefined
    try {
      stat = await vscode.workspace.fs.stat(targetUri)
    } catch {
      stat = undefined
    }
    if (!stat) {
      // Readable message naming the resolved path, instead of the raw VS Code "file not
      // found" dialog / silent failure this used to fall through to.
      this.deps.showError(`File not found: ${local}`)
      return
    }
    if ((stat.type & vscode.FileType.Directory) !== 0) {
      await vscode.commands.executeCommand('revealInExplorer', targetUri)
      return
    }
    // Task 468 — "follow a link the way you were reading"; see shouldOpenTargetWithVmde's
    // own comment for the full reasoning and the three rejected alternatives.
    if (shouldOpenTargetWithVmde(local, this.deps.getSourceViewType())) {
      await vscode.commands.executeCommand(
        'vscode.openWith',
        targetUri,
        MarkdownEditorViewType,
      )
    } else {
      await vscode.commands.executeCommand('vscode.open', targetUri)
    }
    // Task 243 step 4 — `file.md#frag`: classifyHref already split the fragment off
    // `classified.path` above, so `targetUri` never carried it into vscode.open (the task's
    // "strip the fragment before vscode.open"). Now that the target is open, resolve the
    // fragment against ITS headings and scroll to it.
    if (classified.fragment) {
      await this.scrollToFragmentAfterOpen(targetUri, classified.fragment)
    }
  }

  // Reuses the SAME `scroll-to-heading` message src/commands.ts's `vmde.outlineReveal`
  // command already posts (by heading INDEX, resolved via the shared src/heading-slug.ts —
  // one resolver, one scroll mechanism, matching the webview's same-doc-anchor path in
  // media-src/src/same-doc-anchor.ts). Posted to the TARGET file's panel, which is a
  // different webview than the one `onOpenLink`'s `postMessage` dep talks to — so this goes
  // straight to `entry.panel.webview`, found via the active-panels registry.
  private async scrollToFragmentAfterOpen(
    targetUri: vscode.Uri,
    fragment: string,
  ): Promise<void> {
    // Task 243 debugging (lead review, real-VS-Code L3 got past the editor-type gap and now
    // fails silently at the flash assertion) — instrument every branch this method can bail out
    // of, at `debug` (Output channel "VMDE", trace level; house style, not console.log), so a
    // failed scroll shows WHICH step didn't happen instead of just "nothing flashed".
    this.deps.debug(
      'scrollToFragmentAfterOpen: start',
      targetUri.toString(),
      fragment,
    )
    let decoded = fragment
    try {
      // Mirrors classifyHref's own percent-decode of `local.path` (link-target.ts) — a
      // fragment can carry the same `%20`/unicode escaping a markdown link generator emits.
      decoded = decodeURIComponent(fragment)
    } catch {
      // leave `decoded` as the raw fragment, same fallback classifyHref uses for `path`
    }
    // Prefer the LIVE (possibly unsaved) buffer over disk — the target may already be open
    // and edited. Falls back to reading the file for the common "not open yet" case.
    const openDoc = vscode.workspace.textDocuments.find(
      (d) => d.uri.toString() === targetUri.toString(),
    )
    let text: string
    try {
      text = openDoc
        ? openDoc.getText()
        : Buffer.from(await vscode.workspace.fs.readFile(targetUri)).toString(
            'utf8',
          )
    } catch (e) {
      this.deps.debug('scrollToFragmentAfterOpen: target unreadable', e)
      return // target unreadable — nothing to resolve/scroll to
    }
    const slugifyMode =
      cfgFor(targetUri).get<string>('editor.slugifyMode') === 'gitlab'
        ? 'gitlab'
        : 'github'
    const index = resolveFragment(
      parseHeadingsFromMarkdown(text),
      decoded,
      slugifyMode,
    )
    this.deps.debug('scrollToFragmentAfterOpen: resolved index', index)
    // An explicit heading id (and then the normal heading slug) wins over a same-name HTML
    // target. That preserves Task 243's established navigation contract while allowing this
    // task's non-outline targets to share the same open/panel-ready lifecycle.
    const anchor =
      index === undefined
        ? findNamedAnchor(parseNamedAnchorsFromMarkdown(text), fragment)
        : undefined
    if (index === undefined && !anchor) return
    const targetMessage: HostMessage =
      index === undefined
        ? {
            command: 'reveal-line',
            line: anchor!.line,
            lineText: text.split(/\r\n|\n|\r/u)[anchor!.line] ?? '',
          }
        : { command: 'scroll-to-heading', index }

    // Task 468 — `vscode.openWith` (the local branch above, when the source is VMDE) is not
    // guaranteed to have already registered the panel in `active-panels.ts` by the time its
    // own awaited command resolves — `resolveCustomTextEditor`'s `activePanels.add(...)` can
    // still be in flight. Poll briefly rather than giving up on the first miss: a genuinely
    // absent panel (opened as something other than VMDE) still resolves to `undefined` once
    // the budget is spent, same as before.
    let entry = findPanelForUri(targetUri)
    let waitedMs = 0
    while (!entry && waitedMs < 2000) {
      await new Promise((resolve) => setTimeout(resolve, 50))
      waitedMs += 50
      entry = findPanelForUri(targetUri)
    }
    this.deps.debug('scrollToFragmentAfterOpen: found panel?', !!entry, {
      waitedMs,
    })
    if (!entry) return // opened in something other than a VMDE webview — nothing to post to

    // Task 243 double-fire fix (window-array diagnostic, lead review): the first version posted
    // immediately AND unconditionally reposted on `ready` — BOTH landed, every time
    // (scroll-to-heading ran twice, flash restarted). Gate the `ready` repost on
    // `webview.postMessage`'s own returned `Thenable<boolean>` ("delivered"): only arm/use the
    // fallback if the immediate send did NOT already deliver.
    //
    // Task 468 debugging initially suspected this gate was UNSOUND: a fresh-panel run logged the
    // immediate post resolving `ok: true` while the scroll never happened in the webview. Turned
    // out NOT to indict the gate — the actual root cause (see message-router.ts's
    // `scrollToHeadingWithRetry`) is that the message CAN arrive and get handled correctly before
    // Vditor has finished rendering the target document's headings into the DOM, so
    // `scrollToHeadingIndex` legitimately (and silently) returns `false` even though delivery
    // itself was genuine. Once the webview side retries across that DOM-readiness window, this
    // gate's original premise — `postMessage`'s boolean reflects real delivery — held up; no
    // evidence survives that it doesn't. Restored, unchanged from the original design. The
    // `ready` listener is still armed BEFORE the immediate attempt is even made (a separate,
    // still-valid fix — a `ready` landing while that attempt's own await is still pending must
    // not be missed), so double-delivery in that specific overlap is still possible and
    // acceptable, just no longer the common case it was before the gate existed.
    let delivered = false
    const post = async (via: 'immediate' | 'ready') => {
      if (delivered) return
      this.deps.debug('scrollToFragmentAfterOpen: posting fragment target', {
        via,
        targetMessage,
      })
      const ok = await entry.panel.webview.postMessage(targetMessage)
      if (ok) {
        delivered = true
        sub.dispose()
        clearTimeout(timeout)
      }
    }
    const sub = entry.panel.webview.onDidReceiveMessage((m: unknown) => {
      this.deps.debug(
        'scrollToFragmentAfterOpen: panel message received',
        (m as { command?: string } | undefined)?.command,
      )
      if ((m as { command?: string } | undefined)?.command === 'ready') {
        void post('ready')
      }
    })
    const timeout = setTimeout(() => {
      this.deps.debug(
        'scrollToFragmentAfterOpen: ready never arrived within 15s, giving up',
      )
      sub.dispose()
    }, 15_000)
    // Never keep the extension host process alive on this alone (matters for tests too — an
    // un-ref'd timer doesn't block a test runner's process exit while it waits out the 15s).
    ;(timeout as unknown as { unref?: () => void }).unref?.()

    await post('immediate')
  }

  async onOpenWikilink(
    message: Extract<WebviewMessage, { command: 'open-wikilink' }>,
  ): Promise<void> {
    const documentUri = this.deps.getDocumentUri()
    const root = getWikiRoot(documentUri)
    if (!root) {
      this.deps.showError(
        'Wiki links are only enabled for Markdown files inside a wiki folder.',
      )
      return
    }
    const rawTarget = String(message.target)
    const [targetPart] = rawTarget.split('|', 1)
    const key = normalizeWikiLookupKey(targetPart.trim())
    if (!key) {
      this.deps.showError('Invalid wiki link target.')
      return
    }
    const cache = await getOrBuildCache(root)
    const matches = cache.resolve(key)

    if (matches.length === 0) {
      const createChoice = await vscode.window.showWarningMessage(
        `Wiki page "${rawTarget}" was not found under "${vscode.workspace.asRelativePath(root, false)}".`,
        'Create Page',
      )
      if (createChoice === 'Create Page') {
        if (!ensureCanWriteFiles(documentUri)) return
        const newFileUri = await createWikiPage(root, key)
        await vscode.commands.executeCommand(
          'vscode.openWith',
          newFileUri,
          MarkdownEditorViewType,
        )
      }
      return
    }
    if (matches.length > 1) {
      const picked = await vscode.window.showQuickPick(
        matches.map((candidate) => ({
          label: NodePath.basename(candidate.fsPath),
          description: vscode.workspace.asRelativePath(candidate, false),
          uri: candidate,
        })),
        {
          title: `Select wiki page for "${rawTarget}"`,
          placeHolder: 'Multiple wiki pages match this link.',
        },
      )
      if (picked?.uri) {
        await vscode.commands.executeCommand(
          'vscode.openWith',
          picked.uri,
          MarkdownEditorViewType,
        )
      }
      return
    }
    await vscode.commands.executeCommand(
      'vscode.openWith',
      matches[0],
      MarkdownEditorViewType,
    )
  }

  // Task 229 — resolve a workspace-relative path (`src/foo.ts`, NOT doc-relative like onOpenLink's
  // markdown-link targets: code references in prose are conventionally written relative to the repo
  // root). Same containment defense as onOpenLink (task 148 item 2) — a `../../etc/passwd:1`-shaped
  // ref can't escape the workspace folder. Returns null for an escaping or unresolvable path; the
  // caller decides what "null" means (silently excluded from a resolve batch vs. a shown error).
  private resolveWorkspaceRelativeCodeRefPath(path: string): vscode.Uri | null {
    const workspaceFolder = this.deps.getWorkspaceFolder()
    const root =
      workspaceFolder?.uri.fsPath ??
      NodePath.dirname(this.deps.getActiveFsPath())
    const local = NodePath.resolve(root, path)
    const rel = NodePath.relative(root, local)
    if (rel.startsWith('..') || NodePath.isAbsolute(rel)) return null
    return vscode.Uri.file(local)
  }

  // Task 229 — batched existence check for candidate code-ref paths the decorator found in the
  // document (mirrors `diagram-cache-get`'s shape). A path that doesn't resolve to a real FILE
  // (escapes the workspace, doesn't exist, or is a directory) is simply absent from `existing` —
  // the decorator's contract is "unresolved paths stay plain", not an error per miss.
  async onResolveCodeRefs(
    message: Extract<WebviewMessage, { command: 'resolve-code-refs' }>,
  ): Promise<void> {
    const existing = (
      await Promise.all(
        message.paths.map(async (path) => {
          const uri = this.resolveWorkspaceRelativeCodeRefPath(String(path))
          if (!uri) return null
          try {
            const stat = await vscode.workspace.fs.stat(uri)
            return (stat.type & vscode.FileType.Directory) === 0 ? path : null
          } catch {
            return null // doesn't exist — not an error, just unresolved
          }
        }),
      )
    ).filter((p): p is string => p !== null)
    this.deps.postMessage({
      command: 'code-refs-resolved',
      requestId: message.requestId,
      existing,
    })
  }

  // Task 229 — click on a resolved code-ref chip: open the PLAIN TEXT editor at the exact
  // line/col (never the custom vmde editor — that's task 52's reveal-line direction, a
  // different feature). `showTextDocument` is the correct API for "plain text editor,
  // unconditionally" — unlike `vscode.open`/`vscode.openWith`, it never routes through a
  // registered custom editor regardless of `editorAssociations` or file type.
  async onOpenCodeRef(
    message: Extract<WebviewMessage, { command: 'open-code-ref' }>,
  ): Promise<void> {
    const path = String(message.path)
    const uri = this.resolveWorkspaceRelativeCodeRefPath(path)
    // Mirrors onOpenLink's containment-refusal message (task 148 item 2) — same phrasing so a
    // user sees one consistent "can't open this" family of errors across every link kind.
    if (!uri) {
      this.deps.showError(`Can't open a link outside the workspace: ${path}`)
      return
    }
    let document: vscode.TextDocument
    try {
      document = await vscode.workspace.openTextDocument(uri)
    } catch {
      // Readable message naming the resolved path — matches onOpenLink's "File not found"
      // shape (local-link-open.spec.ts asserts the target path appears in the message). A race
      // (file existed at decoration-time, deleted before the click landed) is the only way this
      // path is reached in practice — the decorator already filters on `resolve-code-refs`.
      this.deps.showError(`File not found: ${uri.fsPath}`)
      return
    }
    // Ref lines/cols are 1-based (how people write `file.ts:42`); vscode.Position is 0-based.
    // Math.max guards a malformed `:0` from producing a negative line/character.
    const line = Math.max(0, message.line - 1)
    const character = Math.max(0, (message.col ?? 1) - 1)
    const position = new vscode.Position(line, character)
    await vscode.window.showTextDocument(document, {
      selection: new vscode.Range(position, position),
    })
  }
}
