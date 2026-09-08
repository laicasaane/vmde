import * as vscode from 'vscode'
import * as NodePath from 'node:path'
import { createDiffScheduler, makeDiffComputer } from '../writeback/git-diff'
import { escapeTableSpanPipes } from '../markdown/table-pipe-escape'
import { isWikiFile } from '../wiki/wiki'
import { serializeInitPayload } from '../webview-host/html-builder'
import type {
  ReadingPositionState,
  SectionFoldState,
  WebviewMessage,
} from '../shared/protocol'
import type { DiagramCache } from '../webview-host/diagram-cache-host'
import { WritebackController } from '../writeback/writeback-controller'
import { HistoryCouplingController } from '../writeback/history-coupling'
import {
  collectConfigOptions,
  currentThemeKind,
  effectiveThemeKind,
  getWebviewOptions,
  markdownExtensionOptions,
  sanitizeVditorOptions,
} from '../platform/editor-config'
import { appendRawLine, debug, showError } from '../platform/host-log'
import {
  docLargeMode,
  refreshOutline,
  refreshStatusBarMarker,
  webviewEditorMode,
} from '../platform/host-session-state'
import { DocSyncController } from '../writeback/doc-sync'
import { AssetLinkActions } from './asset-link-actions'
import { listWikiPages, WikiSession } from '../wiki/wiki-session'
import { PanelConfigController } from '../webview-host/panel-config'
import { ImageAssetWatcher } from './image-asset-watcher'
import { revealCaretInSource } from './reveal-caret'
import { updateEditorContexts } from '../platform/tab-targeting'
import { activePanels, type ActivePanelEntry } from '../platform/active-panels'
import {
  KeyEmojiRecents,
  KeyOutlineWidth,
  KeyVditorOptions,
} from '../platform/state-keys'
import {
  normalizeEmojiRecentState,
  pinnedEmojiSequences,
  promoteEmojiRecent,
} from './emoji-recents'
import { firstWebviewMessageShapeViolation } from '../webview-host/webview-message-shape'
import { ConfigurationRoot } from '../shared/product-identity'
import {
  activeEditPerf,
  beginEditPerf,
  editPerfReceivedAt,
  finishEditPerf,
  followerEditPerf,
  hostEditPerf,
  rendererPostPerf,
  setActiveEditPerf,
} from '../platform/edit-perf'
import { canonicalizeIrMarkdown } from '../lute/lute-host'
import {
  buildIncrementalSeedPayload,
  type IncrementalSeedPayload,
} from '../shared/incremental-admission'
import {
  isReadingPositionState,
  readReadingPosition,
  ReadingPositionStoreKey,
  type ReadingPositionEntry,
  updateReadingPositionLru,
} from './reading-position-store'

// Task 38: max content length we inline into the HTML to skip the ready→init roundtrip. Above this,
// keep the roundtrip (+ stream-render) — the prerender teaser already embeds the rendered content, so
// inlining the raw source too would ~double the HTML for large docs. ~100 KB covers nearly all docs.
const InlineInitMax = 100_000

// All VMDE editors in one extension host share a profile store. Serialize promotions here so two
// webviews that select near-simultaneously cannot each read the same old list and lose one entry.
let emojiRecentWrite = Promise.resolve()

// One open editor tab. Holds the per-panel state + behaviour that previously lived
// as closures inside MarkdownEditorProvider.resolveCustomTextEditor (SRP step 1:
// god-method -> class). For now the state stays local to start(); later steps
// promote it to fields and split the closures into methods. The HTML builder is
// injected so this class needn't reach back into the provider's private members.
export class EditorSession {
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly document: vscode.TextDocument,
    private readonly webviewPanel: vscode.WebviewPanel,
    // Task 184 — the shared host-memory+disk diagram render cache, owned by the provider
    // (spans the window session, outlives every webview). Injected so a tab close/reopen
    // reuses the same store.
    private readonly diagramCache: DiagramCache,
    private readonly htmlForWebview: (
      webview: vscode.Webview,
      uri: vscode.Uri,
      content?: string,
      theme?: 'dark' | 'light',
      // Task 38: pre-serialized init payload inlined into the HTML (see inlineInitPayload).
      initPayload?: string,
    ) => string,
  ) {}

  // Per-panel state (was closure-local in resolveCustomTextEditor). The `!` fields
  // are assigned at the top of start(); activeUri/activeFsPath are reassigned on
  // rename and read lazily elsewhere, so they must stay fields (not snapshots).
  private disposables!: vscode.Disposable[]
  private activeUri!: vscode.Uri
  private activeFsPath!: string
  private suppressCloseDispose = false
  // Task 405 — document sync/write-back's surrounding state (was 3 loose fields +
  // a debounce timer) now lives behind DocSyncController + its SyncState.
  private docSync!: DocSyncController
  // Task 61 v2 minimal-diff write-back (CLEAN baseline + per-block reserialize cache)
  // lives in WritebackController; created in start().
  private writeback!: WritebackController
  private historyCoupling!: HistoryCouplingController
  private currentWatcher: vscode.Disposable | undefined
  // Task 513 — watches the local images this document references, so a file replaced on disk under
  // an unchanged path can be refreshed in the webview (its URL is cached; see image-asset-watcher).
  private imageWatcher: ImageAssetWatcher | undefined
  private wiki!: WikiSession
  private assetLinks!: AssetLinkActions
  private panelConfig!: PanelConfigController
  private editMessageChain: Promise<void> = Promise.resolve()
  private workspaceFolder: vscode.WorkspaceFolder | undefined
  private vditorBaseUri!: string
  private panelEntry!: ActivePanelEntry
  private incrementalSeedContent: string | undefined
  private incrementalSeedPayload: IncrementalSeedPayload | undefined

  private emojiRecents() {
    const known = pinnedEmojiSequences(this.context.extensionPath)
    if (!known) return undefined
    return normalizeEmojiRecentState(
      this.context.globalState.get(KeyEmojiRecents),
      known,
    )
  }

  private async recordEmojiRecent(sequence: string): Promise<void> {
    const write = emojiRecentWrite.then(async () => {
      const known = pinnedEmojiSequences(this.context.extensionPath)
      if (!known) return
      const state = promoteEmojiRecent(
        this.context.globalState.get(KeyEmojiRecents),
        sequence,
        known,
      )
      if (!state) return
      await this.context.globalState.update(KeyEmojiRecents, state)
      for (const entry of activePanels) {
        if (entry.ready)
          void entry.panel.webview.postMessage({
            command: 'emoji-recents',
            state,
          })
      }
    })
    // Keep later selections live if a profile-store write fails; the picker already performed its
    // document edit and retains its own in-session history before this host acknowledgement.
    emojiRecentWrite = write.catch(() => undefined)
    await write
  }

  // Extracted so it can be disposed + recreated when the file is renamed.
  private setupFileWatcher(uri: vscode.Uri): vscode.Disposable | undefined {
    if (!this.workspaceFolder) {
      return undefined
    }
    const relativePath = NodePath.relative(
      this.workspaceFolder.uri.fsPath,
      uri.fsPath,
    ).replace(/\\/g, '/')
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(this.workspaceFolder, relativePath),
    )
    return vscode.Disposable.from(
      watcher,
      watcher.onDidChange(() => this.docSync.schedulePostUpdate()),
      watcher.onDidCreate(() => this.docSync.schedulePostUpdate()),
    )
  }

  private foldStateKey(): string {
    return `${ConfigurationRoot}.foldState:${this.document.uri.toString()}`
  }

  private foldState(): SectionFoldState | undefined {
    return this.context.workspaceState.get<SectionFoldState>(
      this.foldStateKey(),
    )
  }

  private readingPosition(): ReadingPositionState | undefined {
    return readReadingPosition(
      this.context.workspaceState.get<ReadingPositionEntry[]>(
        ReadingPositionStoreKey,
      ),
      this.activeUri.toString(),
    )
  }

  private incrementalSeed(
    content: string,
    options: object,
  ): IncrementalSeedPayload | undefined {
    const mode = (options as { mode?: unknown }).mode
    if (mode === 'wysiwyg' || mode === 'sv') return undefined
    if (this.incrementalSeedContent === content)
      return this.incrementalSeedPayload
    this.incrementalSeedContent = content
    this.incrementalSeedPayload = buildIncrementalSeedPayload(content, (md) =>
      canonicalizeIrMarkdown(
        this.context.extensionPath,
        md,
        markdownExtensionOptions(this.document.uri),
      ),
    )
    return this.incrementalSeedPayload
  }

  private async onReady(
    scheduleDiffInfo: ReturnType<typeof createDiffScheduler>,
  ) {
    const wikiInit = await this.wiki.buildInitPayload(
      this.document.uri,
      (cache) => {
        // Watcher fired (file create/delete) — push updated keys to webview.
        this.webviewPanel.webview.postMessage({
          command: 'wiki-update',
          pageKeys: cache.allPageKeys(),
          displayNames: cache.allDisplayNames(),
        })
      },
    )
    const options = this.buildInitOptions()
    await this.docSync.postUpdate({
      type: 'init',
      documentName: NodePath.basename(this.activeFsPath),
      cdn: this.vditorBaseUri,
      options,
      theme: effectiveThemeKind(this.document.uri),
      themeKind: currentThemeKind(),
      wiki: wikiInit,
      e2e: !!process.env.VMDE_E2E,
      foldState: this.foldState(),
      readingPosition: this.readingPosition(),
      emojiRecents: this.emojiRecents(),
    })
    this.panelEntry.ready = true
    // The webview can receive diff-info only after the ready/init update handshake. Priming any
    // earlier races its message listener; priming here also lets the existing debounce/dedup path
    // collapse an edit or save that lands during startup (task 515).
    scheduleDiffInfo(this.document.getText())
  }

  // The Vditor init options blob: config-derived options + saved per-user Vditor options + the
  // drag-resized outline width override. Shared by onReady() (postMessage init) and
  // inlineInitPayload() (task 38 inline init) so the two paths can't drift.
  private buildInitOptions() {
    return {
      ...collectConfigOptions(this.document.uri),
      // globalState.get is untyped (unknown) → cast so the saved options spread (sanitize is identity-typed).
      ...(sanitizeVditorOptions(
        this.context.globalState.get(KeyVditorOptions),
      ) as Record<string, unknown>),
      // Drag-resized outline width overrides the setting default.
      ...(this.context.globalState.get<number>(KeyOutlineWidth)
        ? {
            outlineWidth: this.context.globalState.get<number>(KeyOutlineWidth),
          }
        : {}),
    }
  }

  // Task 38: serialize the init payload to inline into the HTML so the webview boots Vditor
  // synchronously on first paint (skip the serial ready→init host roundtrip). Returns undefined to
  // keep the roundtrip for (a) WIKI files — their links need async pageKeys at first render — and
  // (b) LARGE docs — the prerender teaser already embeds the rendered content, so inlining the raw
  // source too would ~double the HTML. Mirrors onReady()'s init payload; onReady still posts the echo
  // (with identical content), which the webview no-ops — see media-src/src/main.ts.
  private inlineInitPayload(content: string | undefined): string | undefined {
    if (
      content === undefined ||
      isWikiFile(this.document.uri) ||
      content.length > InlineInitMax
    ) {
      return undefined
    }
    // Match postUpdate: external-edit diffing compares against the content handed to the webview.
    this.docSync.syncState.markSynced(content)
    const options = this.buildInitOptions()
    return serializeInitPayload({
      type: 'init',
      content: escapeTableSpanPipes(content),
      documentName: NodePath.basename(this.activeFsPath),
      cdn: this.vditorBaseUri,
      options,
      theme: effectiveThemeKind(this.document.uri),
      themeKind: currentThemeKind(),
      wiki: this.wiki.context,
      e2e: !!process.env.VMDE_E2E,
      foldState: this.foldState(),
      readingPosition: this.readingPosition(),
      emojiRecents: this.emojiRecents(),
      incrementalSeed: this.incrementalSeed(
        escapeTableSpanPipes(content),
        options,
      ),
    })
  }

  private async onSaveOptions(
    message: Extract<WebviewMessage, { command: 'save-options' }>,
  ) {
    await this.context.globalState.update(
      KeyVditorOptions,
      sanitizeVditorOptions(message.options),
    )
  }

  private async onSaveFoldState(
    message: Extract<WebviewMessage, { command: 'save-fold-state' }>,
  ) {
    if (
      !message.state ||
      !Array.isArray(message.state.headings) ||
      !Array.isArray(message.state.lists)
    )
      return
    await this.context.workspaceState.update(this.foldStateKey(), message.state)
  }

  private async onSaveReadingPosition(
    message: Extract<WebviewMessage, { command: 'save-reading-position' }>,
  ) {
    const { state } = message
    if (!isReadingPositionState(state)) return
    const current = this.context.workspaceState.get<ReadingPositionEntry[]>(
      ReadingPositionStoreKey,
    )
    await this.context.workspaceState.update(
      ReadingPositionStoreKey,
      updateReadingPositionLru(current, this.activeUri.toString(), state),
    )
  }

  private onInfo(message: Extract<WebviewMessage, { command: 'info' }>) {
    vscode.window.showInformationMessage(message.content)
  }

  private onError(message: Extract<WebviewMessage, { command: 'error' }>) {
    showError(message.content)
  }

  // Copy HTML / Markdown via the host clipboard (task 53 #1). The webview posts the
  // content and we write it with vscode.env.clipboard — rock-solid regardless of
  // iframe focus/permissions, unlike navigator.clipboard inside the webview.
  private async onCopyToClipboard(
    message: Extract<
      WebviewMessage,
      { command: 'copy-html' | 'copy-markdown' | 'copy-code' }
    >,
    label: string,
  ) {
    try {
      await vscode.env.clipboard.writeText(String(message.content ?? ''))
      vscode.window.showInformationMessage(`Copy ${label} successfully!`)
      this.webviewPanel.webview.postMessage({
        command: 'announce',
        message: `Copied ${label}`,
      })
    } catch (error: any) {
      showError(`Copy ${label} failed! ${error?.message ?? error}`)
    }
  }

  private async onEdit(
    message: Extract<WebviewMessage, { command: 'edit' }>,
    perfId?: string,
  ) {
    const started = performance.now()
    const receivedAt = editPerfReceivedAt(perfId)
    if (receivedAt !== undefined)
      hostEditPerf(perfId, { queueMs: started - receivedAt })
    try {
      await this.writeback.syncToEditor(
        message.content,
        message.explicitBlock,
        message.exact,
        perfId,
      )
      if (message.rewrapDocument) {
        await this.postRewrapDocument()
      }
      hostEditPerf(perfId, { hostTotalMs: performance.now() - started })
      finishEditPerf(perfId, 'complete')
    } catch (error) {
      hostEditPerf(perfId, { hostTotalMs: performance.now() - started })
      finishEditPerf(perfId, 'failed')
      throw error
    }
  }

  private async postRewrapDocument() {
    await this.webviewPanel.webview.postMessage({
      command: 'rewrap-document',
      content: this.document.getText(),
    })
  }

  private queueEdit(message: Extract<WebviewMessage, { command: 'edit' }>) {
    const perfId = beginEditPerf(message.perf)
    const turn = this.editMessageChain
      .catch(() => undefined)
      .then(async () => {
        if (await this.historyCoupling.consumeEdit(message.content)) {
          finishEditPerf(perfId, 'complete')
          return
        }
        await this.onEdit(message, perfId)
      })
    this.editMessageChain = turn
    return turn
  }

  private queueHistoryTransition(
    message: Extract<WebviewMessage, { command: 'history-transition' }>,
  ) {
    const turn = this.editMessageChain
      .catch(() => undefined)
      .then(() => this.historyCoupling.handle(message))
      .then(() => undefined)
    this.editMessageChain = turn
    return turn
  }

  private postRewrapDocumentAfterEdits() {
    return this.editMessageChain.then(() => this.postRewrapDocument())
  }

  // Task 184 — the webview asks for cached SVGs of the diagram blocks it found on open.
  // Serve the hits (misses are simply absent); the webview injects each hit via the offscreen
  // render+atomic-swap primitive and skips the engine. `requestId` correlates the reply.
  private onDiagramCacheGet(
    message: Extract<WebviewMessage, { command: 'diagram-cache-get' }>,
  ) {
    const svgByHash: Record<string, string> = {}
    for (const hash of message.hashes) {
      const svg = this.diagramCache.get(hash)
      if (svg !== undefined) svgByHash[hash] = svg
    }
    this.webviewPanel.webview.postMessage({
      command: 'diagram-cache-hits',
      requestId: message.requestId,
      svgByHash,
    })
  }

  // Task 184 — a render landed in the webview; store it under THIS panel's document uri so
  // the per-doc pinned current-set (fairness) tracks the right document. The webview is the
  // authority on the hash it computed.
  private onDiagramRenderCached(
    message: Extract<WebviewMessage, { command: 'diagram-render-cached' }>,
  ) {
    this.diagramCache.put(
      this.activeUri.toString(),
      message.diagramId,
      message.hash,
      message.svg,
    )
  }

  // The webview reports which large-document helpers are active (content-visibility,
  // streaming, incremental serialization). Store per-uri and refresh the status-bar
  // marker, whose tooltip lists the active ones.
  private onDocMode(message: Extract<WebviewMessage, { command: 'docMode' }>) {
    docLargeMode.set(this.activeUri.toString(), {
      blocks: Number(message.blocks) || 0,
      chars: Number(message.chars) || 0,
      contentVisibility: Boolean(message.contentVisibility),
      streaming: Boolean(message.streaming),
      incremental: Boolean(message.incremental),
    })
    refreshStatusBarMarker()
  }

  private async onSave(message: Extract<WebviewMessage, { command: 'save' }>) {
    await this.writeback.syncToEditor(message.content)
    // Guard the save: a failed disk write must surface, not vanish (task 151 item 2).
    try {
      await this.document.save()
    } catch (error) {
      debug('onSave: document.save() failed', error)
      showError(
        `VMDE: save failed — ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  private async onEditInVscode() {
    // Open the source AND jump to the caret's line (task 16). Same column as
    // the visual editor, matching the previous open-in-place behavior.
    await revealCaretInSource(
      this.webviewPanel,
      this.activeUri,
      vscode.ViewColumn.Active,
    )
  }

  private async onNavigateBack() {
    await vscode.commands.executeCommand('workbench.action.navigateBack')
  }

  private async onOpenSettings() {
    await vscode.commands.executeCommand('vmde.openSettings')
  }

  private async onListWikiPages() {
    await listWikiPages(this.document.uri)
  }

  private async onUpload(
    message: Extract<WebviewMessage, { command: 'upload' }>,
  ) {
    await this.assetLinks.onUpload(message)
  }

  private async onOpenLink(
    message: Extract<WebviewMessage, { command: 'open-link' }>,
  ) {
    await this.assetLinks.onOpenLink(message)
  }

  private async onOpenWikilink(
    message: Extract<WebviewMessage, { command: 'open-wikilink' }>,
  ) {
    await this.assetLinks.onOpenWikilink(message)
  }

  private async onResolveCodeRefs(
    message: Extract<WebviewMessage, { command: 'resolve-code-refs' }>,
  ) {
    await this.assetLinks.onResolveCodeRefs(message)
  }

  private async onOpenCodeRef(
    message: Extract<WebviewMessage, { command: 'open-code-ref' }>,
  ) {
    await this.assetLinks.onOpenCodeRef(message)
  }

  start() {
    const document = this.document
    const webviewPanel = this.webviewPanel

    this.disposables = []
    // Mutable file identity — updated by onDidRenameFiles (task 14) so the tab,
    // watcher, edits and asset paths follow a renamed file. (Wiki context below
    // stays init-frozen — cross-folder wiki rename is a known Phase-1 limit.)
    this.activeUri = document.uri
    this.activeFsPath = document.uri.fsPath
    this.suppressCloseDispose = false
    this.wiki = new WikiSession(document.uri)
    this.workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri)
    this.vditorBaseUri = webviewPanel.webview
      .asWebviewUri(
        vscode.Uri.joinPath(this.context.extensionUri, 'media', 'vditor'),
      )
      .toString()
    // Task 405 — document sync/write-back's echo-suppression state (was 3 loose fields)
    // now lives behind DocSyncController + its SyncState; the write-back controller
    // toggles that same state through the setters below (its syncToEditor calls them
    // around applyEdit).
    this.docSync = new DocSyncController(
      {
        getDocument: () => this.document,
        postMessage: (msg) => this.webviewPanel.webview.postMessage(msg),
        getIncrementalSeed: (content) =>
          this.incrementalSeed(content, this.buildInitOptions()),
      },
      document.getText(),
    )
    this.assetLinks = new AssetLinkActions({
      getActiveUri: () => this.activeUri,
      getActiveFsPath: () => this.activeFsPath,
      getWorkspaceFolder: () => this.workspaceFolder,
      getDocumentUri: () => this.document.uri,
      postMessage: (msg) => this.webviewPanel.webview.postMessage(msg),
      debug,
      showError,
      // Task 468 — no new plumbing: `WebviewPanel.viewType` is already on the SAME panel every
      // other dep here closes over (see `postMessage` above).
      getSourceViewType: () => this.webviewPanel.viewType,
    })
    this.panelConfig = new PanelConfigController({
      getActiveUri: () => this.activeUri,
      postMessage: (msg) => this.webviewPanel.webview.postMessage(msg),
    })
    this.writeback = new WritebackController({
      extensionPath: this.context.extensionPath,
      getMarkdownExtensions: () => markdownExtensionOptions(this.activeUri),
      getDocument: () => this.document,
      getActiveUri: () => this.activeUri,
      setApplyingWebviewEdit: (v) => {
        this.docSync.syncState.setApplyingWebviewEdit(v)
      },
      setPendingWebviewContent: (v) => {
        this.docSync.syncState.setPendingWebviewContent(v)
      },
      setLastSyncedContent: (v) => {
        this.docSync.syncState.markSynced(v)
      },
      showError,
      debug,
      recordPerf: hostEditPerf,
      setActivePerf: setActiveEditPerf,
    })
    this.writeback.setCleanBaseline(document.getText()) // open: document == disk
    this.historyCoupling = new HistoryCouplingController({
      currentContent: () => this.document.getText(),
      equivalentToCurrent: (content) =>
        this.writeback.isSemanticallyEquivalentToDocument(content),
      execute: async (kind) => {
        await vscode.commands.executeCommand(kind)
      },
      setApplying: (value) =>
        this.docSync.syncState.setApplyingWebviewEdit(value),
      markSynced: (content) => this.docSync.syncState.markSynced(content),
      postUpdate: () => this.docSync.postUpdate(),
      debug: (message, details) => debug(message, details),
    })
    // Task 184 — mark this doc open so its diagram renders' current-set stays PINNED (never
    // LRU-evicted) while the tab is open. Released in onDidDispose below.
    this.diagramCache.registerDoc(this.activeUri.toString())

    webviewPanel.title = NodePath.basename(this.activeFsPath)
    webviewPanel.iconPath = new vscode.ThemeIcon('markdown')
    // Track this panel so commands (e.g. revealInSource, task 16) can find the
    // focused editor + its document. `uri` is updated on rename below and the
    // entry is removed on dispose.
    this.panelEntry = {
      panel: webviewPanel,
      uri: this.activeUri,
      ready: false,
    }
    activePanels.add(this.panelEntry)
    // Augment, don't replace: keep VS Code's default custom-editor webview options
    // and only override the ones we control (task 27).
    webviewPanel.webview.options = {
      ...webviewPanel.webview.options,
      ...getWebviewOptions(this.context.extensionUri, document.uri),
    }
    // NOTE: webview.html is intentionally set LAST (after onDidReceiveMessage is
    // registered below) — see the assignment at the end of this method. Setting it
    // here loads main.js, which posts `ready` almost immediately; if the host's
    // message listener isn't attached yet, that `ready` is dropped and the editor
    // never gets its `init` payload (blank/"hung" editor — intermittent, races the
    // bundle load). Attaching the listener first closes that race.

    // Git gutters (task 17): debounced HEAD↔current diff pushed to the webview.
    // The computer reads `this.activeFsPath` lazily so it follows a rename. Self-
    // disables (posts []) when there's no git / the file is untracked.
    const scheduleDiffInfo = createDiffScheduler(
      (msg) => webviewPanel.webview.postMessage(msg),
      (content, perfId) =>
        makeDiffComputer(
          this.activeFsPath,
          vscode.extensions,
          debug,
          followerEditPerf,
        )(content, perfId),
      undefined,
      debug,
      followerEditPerf,
    )

    // Extracted so it can be disposed + recreated when the file is renamed.
    this.currentWatcher = this.setupFileWatcher(this.activeUri)
    if (this.currentWatcher) {
      this.disposables.push(this.currentWatcher)
    }

    // Task 513 — the referenced-image watcher. Primed from the document's current text and kept in
    // step with it by the text-change listener below (refresh() is a no-op while the path set is
    // unchanged, so typing costs one string compare).
    this.imageWatcher = new ImageAssetWatcher(
      (paths) =>
        void webviewPanel.webview.postMessage({
          command: 'assets-changed',
          paths,
        }),
      debug,
    )
    this.disposables.push(this.imageWatcher)
    this.imageWatcher.refresh(this.activeFsPath, this.document.getText())

    // Live config reload (tasks 12/26): on settings change push the config-driven
    // body options + CSS to the open editor, and watch external CSS files so
    // edits apply without reopening. No Vditor re-init (cursor/scroll preserved).
    const externalCssWatcher = this.panelConfig.refreshExternalCssWatchers()
    if (externalCssWatcher) {
      this.disposables.push(externalCssWatcher)
    }

    // Wire the document/panel/config/theme listeners + the webview message handler.
    // Done BEFORE webview.html is set below (the ready-race — see the note above).
    this.installListeners(scheduleDiffInfo)

    // Set the HTML LAST — only now that onDidReceiveMessage (above) is attached.
    // This loads main.js, which posts `ready` and triggers the init handshake; with
    // the listener already live, the `ready` can't be dropped, so the editor always
    // gets its content (fixes the intermittent blank/"hung" editor on window reload).
    // Task 38: also inline the init payload so the webview can boot Vditor synchronously
    // (the `ready→init` roundtrip remains as the fallback + the source of the wiki/echo path).
    const initContent = document.getText()
    webviewPanel.webview.html = this.htmlForWebview(
      webviewPanel.webview,
      document.uri,
      initContent,
      effectiveThemeKind(document.uri),
      this.inlineInitPayload(initContent),
    )

    // Populate the Markdown Outline tree for this freshly-opened editor (task 78);
    // onDidChangeViewState may not fire on the initial open.
    refreshOutline()
  }

  // Webview→host message handlers, one per command (replaces a 15-case switch).
  // Each arrow delegates to the session's on<Command> methods. Adding a command
  // means adding an entry, not editing a central switch (Open/Closed).
  // Keyed by the WebviewMessage discriminant so each handler receives its
  // narrowed variant and a renamed command/field is a compile error (task 151).
  private buildMessageHandlers(
    scheduleDiffInfo: ReturnType<typeof createDiffScheduler>,
  ): {
    [K in WebviewMessage['command']]?: (
      message: Extract<WebviewMessage, { command: K }>,
    ) => unknown
  } {
    return {
      ready: () => this.onReady(scheduleDiffInfo),
      'request-rewrap-document': () => this.postRewrapDocumentAfterEdits(),
      'save-options': (message) => this.onSaveOptions(message),
      'save-fold-state': (message) => this.onSaveFoldState(message),
      'save-reading-position': (message) => this.onSaveReadingPosition(message),
      'record-emoji-recent': (message) =>
        this.recordEmojiRecent(message.sequence),
      info: (message) => this.onInfo(message),
      error: (message) => this.onError(message),
      edit: (message) => this.queueEdit(message),
      'history-transition': (message) => this.queueHistoryTransition(message),
      'edit-perf-renderer': (message) =>
        rendererPostPerf(message.id, message.postMessageMs, message.state),
      save: (message) => this.onSave(message),
      docMode: (message) => this.onDocMode(message),
      editorMode: (message) => {
        webviewEditorMode.set(this.activeUri.toString(), message.mode)
        refreshStatusBarMarker()
      },
      log: (message) => appendRawLine(String(message?.text ?? '')),
      'edit-in-vscode': () => this.onEditInVscode(),
      'navigate-back': () => this.onNavigateBack(),
      'open-settings': () => this.onOpenSettings(),
      'list-wiki-pages': () => this.onListWikiPages(),
      'save-outline-width': (message) =>
        this.context.globalState.update(KeyOutlineWidth, message.width),
      upload: (message) => this.onUpload(message),
      'open-link': (message) => this.onOpenLink(message),
      'open-wikilink': (message) => this.onOpenWikilink(message),
      'resolve-code-refs': (message) => this.onResolveCodeRefs(message),
      'open-code-ref': (message) => this.onOpenCodeRef(message),
      'copy-html': (message) => this.onCopyToClipboard(message, 'HTML'),
      'copy-markdown': (message) => this.onCopyToClipboard(message, 'Markdown'),
      'copy-code': (message) => this.onCopyToClipboard(message, 'code'),
      'diagram-cache-get': (message) => this.onDiagramCacheGet(message),
      'diagram-render-cached': (message) => this.onDiagramRenderCached(message),
      // Consumed by revealCaretInSource's one-shot listener (requestId-correlated) — this
      // entry only keeps the reply out of the "unhandled webview message" debug noise.
      'cursor-offset': () => {
        /* handled by revealCaretInSource's one-shot listener — see comment above */
      },
    }
  }

  // Install this session's document/panel/config/theme listeners + the webview
  // message dispatcher. Called from start() BEFORE webview.html is set (ready-race).
  private installListeners(
    scheduleDiffInfo: ReturnType<typeof createDiffScheduler>,
  ) {
    const webviewPanel = this.webviewPanel
    const messageHandlers = this.buildMessageHandlers(scheduleDiffInfo)

    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        // Scope to this document's uri so resource-scoped overrides (task 51 #3)
        // in a folder's .vscode/settings.json trigger a reload — and so an
        // unrelated folder's change doesn't reload editors it doesn't affect.
        const affectsVmde = e.affectsConfiguration(
          ConfigurationRoot,
          this.activeUri,
        )
        const affectsMarkdownPreviewFont = e.affectsConfiguration(
          'markdown.preview.fontFamily',
          this.activeUri,
        )
        if (!affectsVmde && !affectsMarkdownPreviewFont) {
          return
        }
        // Wiki config changed (enabled/root) → invalidate the old cache so the
        // re-init (triggered by postLiveConfig → handleConfigChanged) builds a
        // fresh cache for the potentially-changed root.
        if (
          affectsVmde &&
          e.affectsConfiguration(`${ConfigurationRoot}.wiki`)
        ) {
          this.wiki.onConfigChanged(this.document.uri)
          void updateEditorContexts()
        }
        this.panelConfig.postLiveConfig()
        const watcher = this.panelConfig.refreshExternalCssWatchers()
        if (watcher) {
          this.disposables.push(watcher)
        }
      }),
      // One text-change listener drives both the content sync and the title dirty-
      // marker (was two separate onDidChangeTextDocument registrations). The title
      // update runs UNCONDITIONALLY after the uri guard — the content-sync short-
      // circuits below must not skip it, since it was an independent listener before.
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (event.document.uri.toString() !== this.activeUri.toString()) {
          return
        }
        const perfId = activeEditPerf()
        const followerStarted = performance.now()
        const getTextStarted = performance.now()
        const currentContent = event.document.getText()
        const getTextMs = performance.now() - getTextStarted
        webviewPanel.title = `${event.document.isDirty ? '[edit]' : ''}${NodePath.basename(this.activeFsPath)}`
        // Task 513 — an added/removed/retargeted image changes what has to be watched.
        const imageStarted = performance.now()
        this.imageWatcher?.refresh(this.activeFsPath, currentContent)
        const imageRefreshMs = performance.now() - imageStarted
        // Any content change (webview edit, external edit, typing) shifts the git
        // diff — refresh the gutters even for echoed/own edits.
        const diffStarted = performance.now()
        scheduleDiffInfo(currentContent, perfId)
        const diffScheduleMs = performance.now() - diffStarted
        followerEditPerf(perfId, {
          getTextMs,
          imageRefreshMs,
          diffScheduleMs,
          listenerMs: performance.now() - followerStarted,
          documentVersion: event.document.version,
        })
        if (this.docSync.syncState.isEcho(currentContent)) {
          // Pure predicate — the two writes it implies stay explicit here (task 405),
          // mirroring the original inline check byte-for-byte.
          this.docSync.syncState.setPendingWebviewContent(undefined)
          this.docSync.syncState.markSynced(currentContent)
          return
        }
        if (this.docSync.syncState.isApplyingEdit()) {
          return
        }
        // An external change that left the document clean (revert, reload from disk):
        // adopt it as the new baseline so a later undo-to-here can return to disk.
        if (!event.document.isDirty) {
          this.writeback.setCleanBaseline(currentContent)
        }
        this.docSync.schedulePostUpdate()
      }),
      vscode.workspace.onDidSaveTextDocument((savedDocument) => {
        if (savedDocument.uri.toString() !== this.activeUri.toString()) {
          return
        }
        // After save the on-disk bytes ARE the saved bytes — adopt them as the new
        // clean baseline so a later undo-to-here returns the file to disk exactly.
        this.writeback.setCleanBaseline(savedDocument.getText())
        this.webviewPanel.webview.postMessage({
          command: 'announce',
          message: `Saved ${NodePath.basename(this.activeFsPath)}`,
        })
        scheduleDiffInfo(savedDocument.getText())
        this.docSync.schedulePostUpdate()
      }),
      // Task 434 — the isSemanticNoop whole-doc check is DEFERRED off the 250ms edit-sync tick
      // (see WritebackController.syncToEditor's own comment), so this is the correctness backstop
      // that guarantees a SAVE — via any trigger: the webview's own Ctrl+S interception
      // (save-flush.ts) only ever sees that one literal keystroke, but a command-palette save,
      // File-menu save, auto-save, or the close-with-"Save"-prompt flow all reach the document
      // through THIS event instead — always reflects the final no-op decision, applied atomically
      // with the save via `waitUntil` (never a separate follow-up write).
      vscode.workspace.onWillSaveTextDocument((event) => {
        if (event.document.uri.toString() !== this.activeUri.toString()) {
          return
        }
        const edits = this.writeback.checkNoopOnWillSave(event.document)
        if (edits.length) {
          event.waitUntil(Promise.resolve(edits))
        }
      }),
      vscode.workspace.onDidRenameFiles((e) => {
        // Phase 1: direct file rename only. Re-point identity, tab, watcher and
        // suppress the old-uri close that would otherwise dispose the panel.
        const hit = e.files.find(
          (f) => f.oldUri.toString() === this.activeUri.toString(),
        )
        if (!hit) {
          return
        }
        this.suppressCloseDispose = true
        this.activeUri = hit.newUri
        this.activeFsPath = hit.newUri.fsPath
        this.panelEntry.uri = hit.newUri // keep the active-panel registry in sync
        webviewPanel.title = NodePath.basename(this.activeFsPath)
        this.currentWatcher?.dispose()
        this.currentWatcher = this.setupFileWatcher(this.activeUri)
        if (this.currentWatcher) {
          this.disposables.push(this.currentWatcher)
        }
        // Relative image paths resolve against the document's own folder, so a rename can move
        // every one of them (task 513).
        this.imageWatcher?.refresh(this.activeFsPath, this.document.getText())
        setTimeout(() => {
          this.suppressCloseDispose = false
        }, 0)
      }),
      vscode.window.onDidChangeActiveColorTheme(() => {
        // Live re-theme this editor when the VS Code theme changes (task 25). In
        // auto mode this can change the resolved VMark content stylesheet too, so
        // reuse the full live-config path rather than sending only the two-value mode.
        this.panelConfig.postLiveConfig()
      }),
      vscode.workspace.onDidCloseTextDocument((closedDocument) => {
        if (this.suppressCloseDispose) {
          return
        }
        if (closedDocument.uri.toString() !== this.activeUri.toString()) {
          return
        }
        webviewPanel.dispose()
      }),
      webviewPanel.onDidChangeViewState(() => {
        // Custom editors don't fire onDidChangeActiveTextEditor, so refresh the
        // Markdown Outline tree (task 78) when this panel becomes active/inactive.
        refreshOutline()
      }),
      webviewPanel.webview.onDidReceiveMessage(
        async (message: WebviewMessage) => {
          debug('msg from webview review', message, webviewPanel.active)
          // The map type guarantees each entry matches its command; bridge the
          // runtime-string index the same way the webview dispatcher does.
          const handler = (
            messageHandlers as Record<
              string,
              ((m: WebviewMessage) => unknown) | undefined
            >
          )[message?.command]
          if (!handler) {
            debug('unhandled webview message', message?.command)
            return
          }
          // Task 148 item 3 (payload-shape validation, host half): the webview-side twin of this
          // check already lives in media-src/src/message-router.ts. TypeScript's WebviewMessage
          // union only checks internal callers, not what actually arrives on the wire, so a
          // malformed/drifted message used to reach its handler as-is — sometimes throwing (caught
          // below, but the try/catch can't tell "shape was wrong" from "handler had a real bug"),
          // sometimes NOT throwing and silently doing the wrong thing (e.g. `save-outline-width`
          // writes `message.width` straight into globalState with no coercion — a missing width
          // becomes a silent `update(key, undefined)`, no error, no signal). Routed through the
          // same `debug(...)` the unhandled-command branch above already uses; never throws.
          const badField = firstWebviewMessageShapeViolation(
            message as unknown as Record<string, unknown>,
            message.command,
          )
          if (badField) {
            debug(
              `malformed webview message "${message.command}": missing/invalid field "${badField}" — dropped, not dispatched`,
            )
            return
          }
          // Error boundary (task 151 item 2): a throwing handler used to reject the
          // onDidReceiveMessage promise silently — route it to the Output channel +
          // surface it instead of swallowing it across the seam.
          try {
            await handler(message)
          } catch (error) {
            debug('webview message handler failed', message?.command, error)
            showError(
              `VMDE: handling "${message?.command}" failed — ${
                error instanceof Error ? error.message : String(error)
              }`,
            )
          }
        },
      ),
      webviewPanel.onDidDispose(() => {
        this.docSync.syncState.setPendingWebviewContent(undefined)
        docLargeMode.delete(this.activeUri.toString())
        webviewEditorMode.delete(this.activeUri.toString())
        // Task 184 — tab closed: release this doc's pins. Its renders stay in the host cache
        // (memory + disk) as unpinned LRU entries, so a reopen within the session is still an
        // instant hit — they're only reclaimed later under pressure.
        this.diagramCache.closeDoc(this.activeUri.toString())
        activePanels.delete(this.panelEntry)
        this.docSync.disposeTimer()
        // Task 434 — cancel any pending deferred no-op check (WritebackController) the same way,
        // so it can't fire a stray applyEdit against a document whose panel just closed.
        this.writeback.disposeNoopCheck()
        while (this.disposables.length) {
          this.disposables.pop()?.dispose()
        }
      }),
    )
  }
}
