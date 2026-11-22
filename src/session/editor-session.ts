import {
  blockActionPreparePayload,
  planBlockAction,
} from '../shared/block-move'
import * as vscode from 'vscode'
import * as NodePath from 'node:path'
import { createDiffScheduler, makeDiffComputer } from '../writeback/git-diff'
import { escapeTableCodePipes } from '../shared/table-code-pipes'
import { isWikiFile } from '../wiki/wiki'
import { serializeInitPayload } from '../webview-host/html-builder'
import type {
  ReadingPositionState,
  RendererEditPerf,
  ReplayOpStatus,
  SectionFoldState,
  WebviewMessage,
} from '../shared/protocol'
import type { DiagramCache } from '../webview-host/diagram-cache-host'
import { WritebackController } from '../writeback/writeback-controller'
import {
  moveMarkdownSection,
  scanSourceHeadings,
  sourceHeadingLabel,
} from '../shared/section-move'
import { HistoryCouplingController } from '../writeback/history-coupling'
import {
  BLOCK_LABELS,
  BLOCK_TYPES,
  BLOCK_TRANSFORM_LOSSES,
  type BlockType,
  type BlockTransformLoss,
} from '../shared/block-types'
import {
  canEditPreviewTaskCheckboxes,
  collectConfigOptions,
  currentThemeKind,
  effectiveThemeKind,
  getWebviewOptions,
  markdownExtensionOptions,
  sanitizeVditorOptions,
} from '../platform/editor-config'
import { opensInRememberedPreview } from '../platform/default-mode'
import { appendRawLine, debug, showError } from '../platform/host-log'
import { lastWriteWinsFor } from '../platform/last-write-wins'
import {
  docLargeMode,
  refreshOutline,
  refreshStatusBarMarker,
  webviewEditorMode,
} from '../platform/host-session-state'
import { DocSyncController } from '../writeback/doc-sync'
import { type DeltaOutcome, DeltaWriter } from '../writeback/delta-writer'
import { normalizeContent } from '../writeback/sync-state'
import { AssetLinkActions } from './asset-link-actions'
import {
  keysOf,
  listWikiPages,
  WikiSession,
  type WikiKeys,
} from '../wiki/wiki-session'
import { PanelConfigController } from '../webview-host/panel-config'
import { ImageAssetWatcher } from './image-asset-watcher'
import { revealCaretInSource } from './reveal-caret'
import { updateEditorContexts } from '../platform/tab-targeting'
import { activePanels, type ActivePanelEntry } from '../platform/active-panels'
import {
  KeyEmojiRecents,
  KeyOutlineOpen,
  KeyOutlineWidth,
  KeyToolbarCollapsed,
  readToolbarCollapsed,
  KeyVditorOptions,
  KeyPreviewOn,
  readOutlineOpen,
  readPreviewOn,
} from '../platform/state-keys'
import {
  normalizeEmojiRecentState,
  pinnedEmojiSequences,
  promoteEmojiRecent,
} from './emoji-recents-store'
import {
  firstWebviewMessageShapeViolation,
  validReplayChanges,
} from '../webview-host/webview-message-shape'
import { EXACT_HISTORY_PAIRS } from '../shared/protocol'
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
import { planPreviewTaskCheckboxEdit } from './preview-task-checkbox-edit'
import {
  formatRecoveredEdits,
  insertRecoveredEdits,
  presentRecoveredEdits,
} from './recovered-edits'
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

// Task 580 CP2-12 — how long a will-save listener waits for the webview to flush pending typing and
// for the host to apply the resulting edit. Real VS Code 1.129 (P8c, 174 KB fixture) measured about
// 200 ms in IR and 330 ms in WYSIWYG from request to applied edit; SV can sit behind a typing backlog
// of about 650 ms, so a limit below about 500 ms would fail SV. VS Code drops a listener after a
// 1500 ms timeout (and ignores it after repeated errors), and its main thread aborts all
// extension-host participants together after 1750 ms; 1000 ms stays under both and leaves room for
// Task 434's own will-save check, which runs after this one.
const SAVE_FLUSH_TIMEOUT_MS = 1000

// All VMDE editors in one extension host share a profile store. Serialize promotions here so two
// webviews that select near-simultaneously cannot each read the same old list and lose one entry.
let emojiRecentWrite = Promise.resolve()

// Task 724: an untitled document keeps its front-matter fold for this extension-host session only.
// The URI of an untitled document is reused by later sessions (`Untitled-1`), so the field never
// reaches workspaceState for it; this map holds it, keyed like the stored fold state.
const sessionFrontMatterFolds = new Map<string, boolean>()

// Task 650: a stored/received Outline width is usable only as a positive finite number.
function isUsableOutlineWidth(width: unknown): width is number {
  return typeof width === 'number' && Number.isFinite(width) && width > 0
}

function blockTransformWarningText(
  target: BlockType,
  losses: readonly BlockTransformLoss[],
): string {
  const names: Record<BlockTransformLoss, string> = {
    'markdown-becomes-literal': 'Markdown will become literal code',
    'fence-language-removed': 'The code fence language will be removed',
    'callout-type/title/fold-marker-removed':
      'The callout type, title, and fold marker will be removed',
  }
  const details = BLOCK_TRANSFORM_LOSSES.flatMap((loss) => {
    const count = losses.filter((entry) => entry === loss).length
    return count
      ? [`${names[loss]}${count > 1 ? ` in ${count} blocks` : ''}`]
      : []
  })
  return `Turn Into ${BLOCK_LABELS[target]}? ${details.length ? details.join('. ') : 'Markdown structure will change'}.`
}

// Task 712: the webview's number for a plain edit (unchecked input; anything but a number is none).
function plainEditSequence(
  message: Extract<WebviewMessage, { command: 'edit' }>,
): number | undefined {
  return !message.exact && typeof message.sequence === 'number'
    ? message.sequence
    : undefined
}

// Task 733: the webview's number for a whole-text edit that asks for a `rebind` (unchecked input).
function rebindSequence(
  message: Extract<WebviewMessage, { command: 'edit' }>,
): number | undefined {
  return typeof message.sequence === 'number' ? message.sequence : undefined
}

// Task 733 / 036: a replay sequence is a positive safe integer.
const validExactSequence = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) > 0

// Task 733 / 036 (review point 6): an error is logged by a fixed category, never its message (a thrown
// replay or handler error can carry document text).
const errorCategory = (error: unknown): string =>
  error instanceof Error ? error.name : typeof error

// Task 733 / 036 (B0): a replay operation number (and an epoch) is a non-negative safe integer; an
// operation number is positive.
const validEpoch = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0

// Task 733 / 036 (B0, 3.3): a reserved Undo or Redo gives up after this long without its content.
const RESERVATION_TIMEOUT_MS = 5000
// Task 733 / 036 (B0, review point 2): how many ended epochs keep their replay outcome for
// `replay-status`; an older epoch answers `ended` with zero watermarks.
const ENDED_REPLAY_EPOCHS = 256

type DeltaPost = Extract<
  WebviewMessage,
  { command: 'edit-delta' | 'history-delta' }
>
type HistoryDeltaPost = Extract<WebviewMessage, { command: 'history-delta' }>

// Task 733 / 036 (B0, 3.3): the outcome of the run step of one replay operation. `stopped`: the epoch
// moved during the run, or the operation decided nothing itself (the writer's own refusal limit).
type ReplayRun = 'proven' | 'refused' | 'stopped'

/** Task 733 / 036 (B0): the replay operations of the current epoch (3.1, 3.3). */
interface ReplayEpochState {
  epoch: number
  /** The highest operation of the contiguous applied prefix. */
  applied: number
  /** Received or reserved operations above `applied` whose turn has not finished. */
  ops: Map<number, 'queued' | 'running' | 'reserved'>
  /** The latest history move received (a late `replay-abandon` of an older one is ignored). */
  lastHistoryOp: number
  /** The operation whose refusal ended the epoch. */
  refused?: number
  /** The epoch received at least one replay operation (its `update` then carries `replayAfterOp`). */
  carried: boolean
}

/** Task 733 / 036 (B0, 3.6): a received replay operation kept until it applies; once its epoch ends
 * unapplied it is a recovery entry. The changes and content are the received references, not copies. */
interface RecoveryEntry {
  epoch: number
  replayOp: number
  changes?: unknown[]
  content?: string
  written: boolean
  /** 036 core C7 (R33.4): an insertion of this entry is in flight; a concurrent write skips it. */
  writing?: boolean
}

/** 036 core C7 (R33.4): the wait before the one retry of a Recovered-edits insertion or presentation. */
const RECOVERED_EDITS_RETRY_MS = 500
const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

const replayKey = (epoch: number, replayOp: number): string =>
  `${epoch}:${replayOp}`

// Task 733 / 036 (B0): the `recoveryOf` of an unchecked message, or undefined.
const recoveryOfMessage = (
  value: unknown,
): { epoch: number; replayOp: number } | undefined => {
  if (typeof value !== 'object' || value === null) return undefined
  const { epoch, replayOp } = value as Record<string, unknown>
  return validEpoch(epoch) && validExactSequence(replayOp)
    ? { epoch, replayOp }
    : undefined
}

// Task 733 (SR-5): a safe integer of an unchecked message, or null.
const loggableInteger = (value: unknown): number | null =>
  Number.isSafeInteger(value) ? (value as number) : null

// Task 733 (SR-5): a delta carries document text, so its trace line holds counts only. Task 733 / 036
// (Q6): `edit` and `history-exact` log allowlisted fields only (kinds, flags, numbers, the content
// length). The dispatcher logs before the payload is validated, so any field may be malformed or
// missing, and the message itself may be no object.
// Task 733 / 036 (Q6, review point 6): history messages log kinds, numbers and lengths only.
function loggableHistory(raw: Record<string, unknown>): unknown {
  const kind = raw.kind === 'undo' || raw.kind === 'redo' ? raw.kind : null
  const sequence = loggableInteger(raw.sequence)
  if (raw.command === 'history-exact')
    return {
      command: 'history-exact',
      kind,
      requestId: typeof raw.requestId === 'string',
      sequence,
      epoch: loggableInteger(raw.epoch),
      replayOp: loggableInteger(raw.replayOp),
    }
  // A held transition carries both endpoints; their lengths only.
  return {
    command: 'history-transition',
    kind,
    sequence,
    beforeLength: typeof raw.before === 'string' ? raw.before.length : null,
    afterLength: typeof raw.after === 'string' ? raw.after.length : null,
  }
}

function loggableMessage(message: WebviewMessage): unknown {
  if (typeof message !== 'object' || message === null)
    return { type: message === null ? 'null' : typeof message }
  const raw = message as unknown as Record<string, unknown>
  switch (raw.command) {
    case 'edit-delta':
    case 'history-delta':
      return {
        command: raw.command,
        epoch: loggableInteger(raw.epoch),
        sequence: loggableInteger(raw.sequence),
        changeCount: Array.isArray(raw.changes) ? raw.changes.length : null,
        replayOp: loggableInteger(raw.replayOp),
        recoveryOf: raw.recoveryOf !== undefined,
      }
    case 'edit':
      return {
        command: 'edit',
        exact: raw.exact === true,
        rebind: raw.rebind === true,
        sequence: loggableInteger(raw.sequence),
        history:
          raw.history === 'undo' || raw.history === 'redo' ? raw.history : null,
        requestId: typeof raw.requestId === 'string',
        contentLength:
          typeof raw.content === 'string' ? raw.content.length : null,
        epoch: loggableInteger(raw.epoch),
        replayOp: loggableInteger(raw.replayOp),
      }
    case 'history-exact':
    case 'history-transition':
      return loggableHistory(raw)
    // Task 733 / 036 (B0, 3.8): the replay commands log their numbers only.
    case 'replay-reserve':
    case 'replay-query':
    case 'replay-abandon':
    case 'recovery-done':
      return {
        command: raw.command,
        epoch: loggableInteger(raw.epoch),
        replayOp: loggableInteger(raw.replayOp),
        kind: raw.kind === 'undo' || raw.kind === 'redo' ? raw.kind : null,
      }
    case 'host-state-query':
      return {
        command: 'host-state-query',
        requestId: typeof raw.requestId === 'string',
      }
    default:
      return message
  }
}

// The map type guarantees each entry matches its command; bridge the runtime-string index the same way
// the webview dispatcher does. Task 733 / 036: own keys only.
function webviewHandler(
  handlers: object,
  command: unknown,
): ((message: WebviewMessage) => unknown) | undefined {
  if (typeof command !== 'string') return undefined
  // An own property only: an inherited name (`toString`) is no handler.
  const value: unknown = Object.getOwnPropertyDescriptor(
    handlers,
    command,
  )?.value
  return typeof value === 'function'
    ? (value as (message: WebviewMessage) => unknown)
    : undefined
}

// Task 733 / 036 (review point 6): the review line of a received message; an unknown command logs a
// fixed category instead of its fields.
function reviewEntry(message: WebviewMessage, handled: boolean): unknown {
  return handled || typeof message !== 'object' || message === null
    ? loggableMessage(message)
    : { command: 'unknown' }
}

// Task 733: what started the current epoch. A dropped or refused delta warns only after an external
// change or a refusal; after the host's own write the webview publishes that typing again.
type EpochStart = 'external' | 'refusal' | 'own'

const STALE_EDIT_WARNING =
  'VMDE: The file changed before your last edit reached it. The editor now shows the current text; your last edit was not applied.'

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
  private findWidgetVisible = false
  private suppressCloseDispose = false
  // Task 405 — document sync/write-back's surrounding state (was 3 loose fields +
  // a debounce timer) now lives behind DocSyncController + its SyncState.
  private docSync!: DocSyncController
  // Task 61 v2 minimal-diff write-back (CLEAN baseline + per-block reserialize cache)
  // lives in WritebackController; created in start().
  private writeback!: WritebackController
  private deltaWriter!: DeltaWriter
  private historyCoupling!: HistoryCouplingController
  private currentWatcher: vscode.Disposable | undefined
  // Task 513 — watches the local images this document references, so a file replaced on disk under
  // an unchanged path can be refreshed in the webview (its URL is cached; see image-asset-watcher).
  private imageWatcher: ImageAssetWatcher | undefined
  private wiki!: WikiSession
  private assetLinks!: AssetLinkActions
  private panelConfig!: PanelConfigController
  private editMessageChain: Promise<void> = Promise.resolve()
  // Task 580 CP2-12 — will-save flushes still waiting for the webview's `flush-for-save-done`,
  // keyed by request id. An entry leaves the map when its save stops waiting, so a late reply
  // finds nothing and is ignored.
  private saveFlushSeq = 0
  private readonly saveFlushes = new Map<
    string,
    { replied: () => void; finish: () => void }
  >()
  private pendingPreviewTaskCheckboxEdit:
    | {
        version: number
        after: string
      }
    | undefined
  private workspaceFolder: vscode.WorkspaceFolder | undefined
  private vditorBaseUri!: string
  private panelEntry!: ActivePanelEntry
  private incrementalSeedContent: string | undefined
  private incrementalSeedPayload: IncrementalSeedPayload | undefined
  private blockOptionsEpoch = 0
  private blockActions = new Map<
    string,
    {
      uri: string
      version: number
      before: string
      after: string
      timeout: ReturnType<typeof setTimeout>
    }
  >()
  private outlineMoves = new Map<
    string,
    { uri: string; version: number; before: string; after: string }
  >()

  private emojiRecents() {
    const known = pinnedEmojiSequences(this.context.extensionPath)
    if (!known) return undefined
    return normalizeEmojiRecentState(
      this.stateWrites.get(KeyEmojiRecents),
      known,
    )
  }

  // Task 657: writes and reads of the remembered-state keys. Reads go through the same helper so a
  // read inside a stale storage window returns the last local write. Resolved lazily because the
  // memento can be replaced after construction (tests), and shared per memento so every editor uses
  // one sequence.
  private get stateWrites() {
    return lastWriteWinsFor(this.context.globalState)
  }

  private async recordEmojiRecent(sequence: string): Promise<void> {
    const write = emojiRecentWrite.then(async () => {
      const known = pinnedEmojiSequences(this.context.extensionPath)
      if (!known) return
      const state = promoteEmojiRecent(
        this.stateWrites.get(KeyEmojiRecents),
        sequence,
        known,
      )
      if (!state) return
      await this.stateWrites.write(KeyEmojiRecents, state)
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
    const stored = this.context.workspaceState.get<SectionFoldState>(
      this.foldStateKey(),
    )
    const sessionFold = sessionFrontMatterFolds.get(this.foldStateKey())
    if (sessionFold === undefined) return stored
    return {
      headings: stored?.headings ?? [],
      lists: stored?.lists ?? [],
      frontMatterFolded: sessionFold,
    }
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
    this.findWidgetVisible = false
    if (this.webviewPanel.active) {
      void vscode.commands.executeCommand(
        'setContext',
        'vmde.findWidgetVisible',
        false,
      )
    }
    // Task 636 — `init` does not wait for the wiki page scan: keys ride in `init` only when the
    // shared cache is already built; otherwise the scan runs in the background and `wiki-update`
    // follows the `init` post.
    const wikiPlan = this.planWikiKeys()
    const options = this.buildInitOptions()
    // Task 733 (E7): a `ready` after the first one means the webview reloaded and lost its model.
    if (this.readySeen) this.startEpoch('own')
    this.readySeen = true
    await this.docSync.postUpdate({
      type: 'init',
      documentName: NodePath.basename(this.activeFsPath),
      cdn: this.vditorBaseUri,
      options,
      theme: effectiveThemeKind(this.document.uri),
      themeKind: currentThemeKind(),
      wiki: wikiPlan.payload,
      e2e: !!process.env.VMDE_E2E,
      ...(process.env.VMDE_E2E &&
      process.env.VMDE_E2E_HISTORY_ENGINE === 'vditor'
        ? { historyEngine: 'vditor' as const }
        : {}),
      foldState: this.foldState(),
      readingPosition: this.readingPosition(),
      emojiRecents: this.emojiRecents(),
      toolbarCollapsed: readToolbarCollapsed(this.stateWrites),
      // Task 641: the full-document seed follows `init` in its own message instead of delaying it.
      deferIncrementalSeed: true,
    })
    this.panelEntry.ready = true
    // The webview can receive diff-info only after the ready/init update handshake. Priming any
    // earlier races its message listener; priming here also lets the existing debounce/dedup path
    // collapse an edit or save that lands during startup (task 515).
    scheduleDiffInfo(this.document.getText())
    // Init is already posted (postUpdate posts synchronously), so the keys always follow it.
    this.deliverWikiPlan(wikiPlan)
  }

  // The wiki init plan with the watcher callback (file create/delete under the root pushes the
  // updated keys to the webview). Shared by `onReady` and the wiki-setting-change refresh.
  private planWikiKeys() {
    return this.wiki.planInit(this.document.uri, (cache) =>
      this.postWikiUpdate(keysOf(cache)),
    )
  }

  private postWikiUpdate(keys: WikiKeys): void {
    this.webviewPanel.webview.postMessage({ command: 'wiki-update', ...keys })
  }

  // Posts a pending scan's keys once it resolves (dropped when the session or plan went stale).
  private deliverWikiPlan(plan: ReturnType<EditorSession['planWikiKeys']>) {
    this.wiki
      .deliverPending(plan, (keys) => this.postWikiUpdate(keys))
      .catch((error: unknown) => debug('wiki page scan failed', error))
  }

  // Task 637 — after a wiki setting changed the effective root, re-plan the keys for the new
  // context and deliver them as `wiki-update` (at once when the cache is built, after the scan
  // otherwise). Nothing is posted before the init, or when the wiki is now disabled.
  private refreshWikiKeys(): void {
    if (!this.panelEntry.ready) return
    const plan = this.planWikiKeys()
    const { pageKeys, displayNames, aliases } = plan.payload
    if (pageKeys && displayNames)
      this.postWikiUpdate({
        pageKeys,
        displayNames,
        ...(aliases ? { aliases } : {}),
      })
    this.deliverWikiPlan(plan)
  }

  // The Vditor init options blob: config-derived options + saved per-user Vditor options + the
  // drag-resized outline width override. Shared by onReady() (postMessage init) and
  // inlineInitPayload() (task 38 inline init) so the two paths can't drift.
  private buildInitOptions() {
    const config = collectConfigOptions(this.document.uri)
    const storedWidth = this.stateWrites.get(KeyOutlineWidth)
    const storedOutlineOpen = readOutlineOpen(this.stateWrites)
    return {
      ...config,
      // globalState.get is untyped (unknown) → cast so the saved options spread (sanitize is identity-typed).
      ...(sanitizeVditorOptions(
        this.stateWrites.get(KeyVditorOptions),
      ) as Record<string, unknown>),
      // Drag-resized outline width overrides the setting default.
      // Only a positive finite number counts; a stale string/zero/negative value is ignored.
      ...(isUsableOutlineWidth(storedWidth)
        ? { outlineWidth: storedWidth }
        : {}),
      // Task 650: the remembered Outline open state (strict boolean only).
      ...(storedOutlineOpen === undefined
        ? {}
        : { outlineOpen: storedOutlineOpen }),
      // Task 651: the remembered Preview toggle, last so a saved option cannot shadow it. Applies only
      // when no explicit mode (setting or path rule) resolved; omitted otherwise.
      ...(opensInRememberedPreview(
        config.defaultMode,
        readPreviewOn(this.stateWrites),
      )
        ? { openInPreview: true }
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
    this.docSync.syncState.markPostedEpoch(this.docSync.syncState.getEpoch())
    const options = this.buildInitOptions()
    return serializeInitPayload({
      type: 'init',
      content: escapeTableCodePipes(content),
      ...(escapeTableCodePipes(content) === content ? {} : { raw: content }),
      revision: this.docSync.syncState.getExternalRevision(),
      epoch: this.docSync.syncState.getEpoch(),
      documentName: NodePath.basename(this.activeFsPath),
      cdn: this.vditorBaseUri,
      options,
      theme: effectiveThemeKind(this.document.uri),
      themeKind: currentThemeKind(),
      wiki: this.wiki.context,
      e2e: !!process.env.VMDE_E2E,
      ...(process.env.VMDE_E2E &&
      process.env.VMDE_E2E_HISTORY_ENGINE === 'vditor'
        ? { historyEngine: 'vditor' as const }
        : {}),
      foldState: this.foldState(),
      readingPosition: this.readingPosition(),
      emojiRecents: this.emojiRecents(),
      toolbarCollapsed: readToolbarCollapsed(this.stateWrites),
      // Task 641: no seed here. It would run the full-document host Lute pass (and a first Lute
      // load) inside the editor resolve; the `init` echo after `ready` sends it later instead.
    })
  }

  private async onSaveOptions(
    message: Extract<WebviewMessage, { command: 'save-options' }>,
  ) {
    await this.stateWrites.write(
      KeyVditorOptions,
      sanitizeVditorOptions(message.options),
    )
  }

  // Task 651: store the Preview toggle. Read at editor open only; nothing is posted or broadcast, so
  // other open editors keep their own state until reopened.
  private async onSavePreviewState(
    message: Extract<WebviewMessage, { command: 'save-preview-state' }>,
  ) {
    await this.stateWrites.write(KeyPreviewOn, message.on === true)
  }

  // Task 631 F2: store the one shared toolbar state, and tell every other ready editor (the sender
  // already shows it). `update` sets the value `get` returns at once; its promise only settles when
  // VS Code has written it, so the other editors are told without waiting for that acknowledgement.
  private async onSaveToolbarCollapsed(
    message: Extract<WebviewMessage, { command: 'save-toolbar-collapsed' }>,
  ) {
    const collapsed = message.collapsed === true
    const written = this.stateWrites.write(KeyToolbarCollapsed, collapsed)
    for (const entry of activePanels) {
      if (entry === this.panelEntry || !entry.ready) continue
      // A registry entry whose webview is already disposed throws on post; it must not stop the
      // editors after it from following.
      try {
        Promise.resolve(
          entry.panel.webview.postMessage({
            command: 'toolbar-collapsed',
            collapsed,
          }),
        ).catch((error: unknown) => debug('toolbar state not delivered', error))
      } catch (error) {
        debug('toolbar state not delivered', error)
      }
    }
    await written
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
    // Task 724: the front-matter fold is optional; a value that is not a boolean is dropped.
    const { frontMatterFolded, ...sections } = message.state
    const key = this.foldStateKey()
    if (typeof frontMatterFolded !== 'boolean') {
      await this.context.workspaceState.update(key, sections)
      return
    }
    if (this.document.uri.scheme === 'untitled') {
      sessionFrontMatterFolds.set(key, frontMatterFolded)
      await this.context.workspaceState.update(key, sections)
      return
    }
    await this.context.workspaceState.update(key, {
      ...sections,
      frontMatterFolded,
    })
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
      {
        command:
          | 'copy-html'
          | 'copy-markdown'
          | 'copy-code'
          | 'copy-property'
          | 'copy-link-url'
      }
    >,
    label: string,
  ) {
    try {
      const content =
        message.command === 'copy-link-url' ? message.href : message.content
      await vscode.env.clipboard.writeText(String(content ?? ''))
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
    let outcome: 'written' | 'unchanged' | 'refused'
    try {
      // Task 607: `before` and `requestId` arrive from the webview unchecked; anything but a string
      // counts as missing, so a malformed exact edit is refused rather than written.
      const before =
        typeof message.before === 'string' ? message.before : undefined
      const requestId =
        typeof message.requestId === 'string' ? message.requestId : undefined
      this.admittedPair = undefined
      outcome = this.replayableCandidate(message, before, requestId)
        ? await this.writeReplayable(
            message.content,
            before as string,
            requestId as string,
            perfId,
          )
        : await this.writeback.syncToEditor(
            message.content,
            message.explicitBlock,
            message.exact,
            perfId,
            before,
          )
      // Task 607 INV-B: tell the webview its exact edit was not written, with the host text, so
      // it can roll the action back.
      if (outcome === 'refused')
        await this.webviewPanel.webview.postMessage({
          command: 'exact-edit-refused',
          ...(requestId === undefined ? {} : { requestId }),
          content: this.document.getText(),
        })
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
    return outcome
  }

  // Task 733 / 036: Find's exact post that asks for a replay pair (shape checked here; unchecked input).
  private replayableCandidate(
    message: Extract<WebviewMessage, { command: 'edit' }>,
    before: string | undefined,
    requestId: string | undefined,
  ): boolean {
    return (
      message.exact === true &&
      message.rebind === true &&
      message.replayable === true &&
      typeof message.content === 'string' &&
      before !== undefined &&
      requestId !== undefined &&
      requestId.length > 0 &&
      requestId.length <= 64
    )
  }

  // Task 733 / 036 (F6 admission): write through the guarded path that reports `applyEdit`'s own result.
  // A pair is admitted only on an actual apply whose re-read bytes equal the content and with no outside
  // change during the write; `before` is proven held by the guard.
  private async writeReplayable(
    content: string,
    before: string,
    requestId: string,
    perfId: string | undefined,
  ): Promise<'written' | 'unchanged' | 'refused'> {
    const revision = this.docSync.syncState.getExternalRevision()
    const { result, heldBefore } = await this.writeback.syncExactHeld(
      content,
      before,
      perfId,
    )
    if (result === 'unchanged' || result === 'refused') return result
    // Task 733 / 036 (B0, 3.4): the pair admits the raw text the guard held, not the message's `before`
    // (equal only up to line endings), so the raw proof of the Undo compares like with like.
    if (
      result === 'applied' &&
      heldBefore !== undefined &&
      revision === this.docSync.syncState.getExternalRevision()
    )
      this.admitPair({
        requestId,
        before: heldBefore,
        after: this.document.getText(),
        version: this.document.version,
      })
    // A failed apply answers as today's `syncToEditor` does (written; the error was shown).
    return 'written'
  }

  // Task 733 / 036: the host's replay pairs, oldest first; a FIFO of `EXACT_HISTORY_PAIRS`.
  private exactPairs: Array<{
    requestId: string
    before: string
    after: string
    version: number
  }> = []
  // The pair the current edit admitted (and the one it evicted), for that edit's `rebind`.
  private admittedPair:
    | { exactRequestId: string; exactEvicted?: string }
    | undefined
  // `history-exact` turns queued or running on the edit chain (Save waits for them).
  private exactTurns = 0

  private admitPair(pair: {
    requestId: string
    before: string
    after: string
    version: number
  }): void {
    this.exactPairs = this.exactPairs.filter(
      (kept) => kept.requestId !== pair.requestId,
    )
    this.exactPairs.push(pair)
    const evicted =
      this.exactPairs.length > EXACT_HISTORY_PAIRS
        ? this.exactPairs.shift()?.requestId
        : undefined
    this.admittedPair =
      evicted === undefined
        ? { exactRequestId: pair.requestId }
        : { exactRequestId: pair.requestId, exactEvicted: evicted }
  }

  // Task 733 / 036 (B0): the replay operations of the current epoch; ended epochs keep their outcome
  // (review point 2); received operations journaled until they apply (3.6); reserved turns (3.3).
  private replay: ReplayEpochState = {
    epoch: 0,
    applied: 0,
    ops: new Map(),
    lastHistoryOp: 0,
    carried: false,
  }
  private readonly endedReplays = new Map<
    number,
    { applied: number; acceptedSequence: number; refused?: number }
  >()
  // The watermarks of the epoch the current one ended, for `host-state`.
  private endedForHostState: {
    afterSequence?: number
    replayAfterOp?: number
  } = {}
  private readonly recoveryJournal = new Map<string, RecoveryEntry>()
  private readonly reservations = new Map<
    string,
    (payload: HistoryDeltaPost | undefined) => void
  >()
  // Replay turns queued, running or reserved on the edit chain (Save waits for them).
  private replayTurns = 0
  private panelDisposed = false
  // 036 core C7 (R34.4, R33.4): numbers only, never document text.
  private replayRejected = 0
  private recoveredEditsLost = 0

  /** Task 733 / 036 (B0): the replay state of the current epoch (follows the delta writer's epoch). */
  private replayState(): ReplayEpochState {
    const epoch = this.deltaWriter.epoch
    if (this.replay.epoch !== epoch)
      this.replay = {
        epoch,
        applied: 0,
        ops: new Map(),
        lastHistoryOp: 0,
        carried: false,
      }
    return this.replay
  }

  /** Task 733 / 036 (B0): the current epoch ends: keep its outcome, give its reservations up, and return
   * its replay watermark for the `update` (undefined when it carried no replay operation). */
  private endReplayEpoch(): number | undefined {
    const state = this.replayState()
    this.endedReplays.set(state.epoch, {
      applied: state.applied,
      acceptedSequence: this.deltaWriter.acceptedSequence,
      ...(state.refused === undefined ? {} : { refused: state.refused }),
    })
    if (this.endedReplays.size > ENDED_REPLAY_EPOCHS)
      this.endedReplays.delete(this.endedReplays.keys().next().value as number)
    const replayAfterOp = state.carried ? state.applied : undefined
    this.endedForHostState = {
      afterSequence: this.deltaWriter.acceptedSequence,
      ...(replayAfterOp === undefined ? {} : { replayAfterOp }),
    }
    for (const [key, release] of [...this.reservations])
      if (key.startsWith(`${state.epoch}:`)) release(undefined)
    return replayAfterOp
  }

  /** Task 733 / 036 (B0, review point 4): at receipt, before queuing. A current-epoch operation is
   * marked queued; one that carries text is journaled once, unless an applied prefix already covers it
   * or it reapplies another operation (the original entry stays the only one). */
  private noteReplayReceived(
    epoch: number,
    replayOp: number,
    data: { changes?: unknown[]; content?: string } | undefined,
    options: { history?: boolean; recoveryOf?: unknown } = {},
  ): void {
    const state = this.replayState()
    if (epoch === state.epoch) {
      state.carried = true
      if (replayOp > state.applied && !state.ops.has(replayOp))
        state.ops.set(replayOp, 'queued')
      if (options.history && replayOp > state.lastHistoryOp)
        state.lastHistoryOp = replayOp
    }
    if (!data || options.recoveryOf !== undefined || epoch > state.epoch) return
    const key = replayKey(epoch, replayOp)
    if (this.recoveryJournal.has(key)) return
    const applied =
      epoch === state.epoch
        ? state.applied
        : (this.endedReplays.get(epoch)?.applied ?? 0)
    if (replayOp <= applied) return
    this.recoveryJournal.set(key, { epoch, replayOp, ...data, written: false })
  }

  private postReplayAck(): void {
    if (this.panelDisposed) return
    const state = this.replayState()
    void this.webviewPanel.webview.postMessage({
      command: 'replay-ack',
      epoch: state.epoch,
      replayOp: state.applied,
      acceptedSequence: this.deltaWriter.acceptedSequence,
    })
  }

  /** Task 733 / 036 (B0): a refusal ends the epoch; its `update` carries `replayAfterOp`. After the panel
   * closed the epoch still ends (the operation stays a recovery entry) but nothing is posted. */
  private async refuseReplay(replayOp: number): Promise<void> {
    this.replayState().refused = replayOp
    if (this.panelDisposed) {
      this.startEpoch('refusal')
      return
    }
    await this.resync()
  }

  /** Task 733 / 036 (B0, 3.3): one replay operation's chain turn: epoch, duplicate and gap checks
   * before `run` mutates anything; then the proof decides the acknowledgement. `wait` is a
   * reservation's content (false: it gave up). */
  private queueReplayTurn(
    epoch: number,
    replayOp: number,
    run: () => Promise<ReplayRun>,
    options: { wait?: Promise<boolean>; recoveryOf?: unknown } = {},
  ): Promise<void> {
    this.replayTurns++
    const turn = this.editMessageChain
      .catch(() => undefined)
      .then(async () => {
        try {
          if (options.wait && !(await options.wait)) {
            this.replayState().ops.delete(replayOp)
            if (!this.panelDisposed && this.deltaWriter.epoch === epoch)
              await this.refuseReplay(replayOp)
            return
          }
          await this.runReplayOp(epoch, replayOp, run, options.recoveryOf)
        } finally {
          this.replayTurns--
        }
      })
    this.editMessageChain = turn
    return turn
  }

  private async runReplayOp(
    epoch: number,
    replayOp: number,
    run: () => Promise<ReplayRun>,
    recoveryOf: unknown,
  ): Promise<void> {
    const state = this.replayState()
    // 1. A stale epoch: nothing is written and nothing is acknowledged (the journal keeps it).
    if (epoch !== state.epoch) return
    // 2. An applied duplicate is acknowledged again and not run.
    if (replayOp <= state.applied) {
      this.postReplayAck()
      return
    }
    // 3. A gap is refused before any mutation.
    if (replayOp > state.applied + 1) {
      state.ops.delete(replayOp)
      await this.refuseReplay(replayOp)
      return
    }
    state.ops.set(replayOp, 'running')
    const outcome = await run()
    // 4. The epoch moved during the run: no acknowledgement; the operation stays a recovery entry.
    if (this.deltaWriter.epoch !== epoch || this.replay !== state) return
    state.ops.delete(replayOp)
    if (outcome === 'proven') {
      state.applied = replayOp
      this.recoveryJournal.delete(replayKey(epoch, replayOp))
      const original = recoveryOfMessage(recoveryOf)
      if (original)
        this.recoveryJournal.delete(
          replayKey(original.epoch, original.replayOp),
        )
      this.postReplayAck()
    } else if (outcome === 'refused') await this.refuseReplay(replayOp)
  }

  // Task 733 / 036: replay an admitted pair natively, or write its target bytes through the guarded
  // writer. B0: replay operation `replayOp`, answered by `replay-ack` after the raw proof, or one `update`.
  private queueHistoryExact(
    message: Extract<WebviewMessage, { command: 'history-exact' }>,
  ) {
    const { epoch, replayOp } = message
    this.noteReplayReceived(epoch, replayOp, undefined, { history: true })
    this.exactTurns++
    const turn = this.queueReplayTurn(epoch, replayOp, async () => {
      this.sequencedTransition = true
      try {
        return await this.runHistoryExact(message, epoch)
      } catch (error) {
        debug('history-exact replay failed', errorCategory(error))
        return 'refused'
      } finally {
        this.sequencedTransition = false
      }
    })
    const counted = turn.finally(() => {
      this.exactTurns--
    })
    return counted
  }

  private async runHistoryExact(
    message: Extract<WebviewMessage, { command: 'history-exact' }>,
    epoch: number,
  ): Promise<ReplayRun> {
    const kind = message.kind
    const pair = this.exactPairs.find((p) => p.requestId === message.requestId)
    if ((kind !== 'undo' && kind !== 'redo') || !pair) return 'refused'
    const start = kind === 'undo' ? pair.after : pair.before
    const exact = kind === 'undo' ? pair.before : pair.after
    const revision = this.docSync.syncState.getExternalRevision()
    const current = () => this.deltaWriter.epoch === epoch
    await this.writeback.settleOwnWrites()
    if (!current()) return 'stopped'
    const outcome = await this.historyCoupling.replayExact(
      kind,
      start,
      exact,
      current,
    )
    if (!current() || outcome === 'interrupted') return 'stopped'
    if (outcome === 'diverged') return 'refused'
    if (outcome === 'replayed')
      this.writeback.noteExactReplay(this.document.getText())
    if (outcome === 'declined') {
      // This path posts no `exact-edit-refused`: a refusal ends in exactly one `update`.
      await this.writeback.syncToEditor(
        exact,
        undefined,
        true,
        undefined,
        start,
      )
      if (!current()) return 'stopped'
    }
    // 3.4: acknowledged only when the document holds the pair's raw target; an outside change during
    // the replay is a refusal.
    return this.document.getText() === exact &&
      revision === this.docSync.syncState.getExternalRevision()
      ? 'proven'
      : 'refused'
  }

  // Task 733 / 036: pre-checked before the shape table, which checks primitive types only. A bad sequence
  // or replay number is dropped; a valid one with a bad direction or request ID gets one `update`.
  private receiveHistoryExact(message: unknown): Promise<void> | undefined {
    const raw = message as Record<string, unknown>
    if (
      !validExactSequence(raw.sequence) ||
      !validEpoch(raw.epoch) ||
      !validExactSequence(raw.replayOp)
    )
      return undefined
    const requestId = raw.requestId
    if (
      (raw.kind !== 'undo' && raw.kind !== 'redo') ||
      typeof requestId !== 'string' ||
      requestId.length === 0 ||
      requestId.length > 64
    ) {
      const epoch = raw.epoch
      const replayOp = raw.replayOp
      this.noteReplayReceived(epoch, replayOp, undefined, { history: true })
      return this.queueReplayTurn(epoch, replayOp, async () => 'refused')
    }
    return this.queueHistoryExact(
      message as Extract<WebviewMessage, { command: 'history-exact' }>,
    )
  }

  // Task 733 / 036 (B0, 3.3, review point 1): an untagged Undo or Redo keeps its place on the chain. Its
  // `history-delta` goes straight to the waiting turn; a duplicate reserve is ignored.
  private receiveReplayReserve(
    message: Extract<WebviewMessage, { command: 'replay-reserve' }>,
  ): undefined {
    const { epoch, replayOp } = message
    if (
      !validEpoch(epoch) ||
      !validExactSequence(replayOp) ||
      (message.kind !== 'undo' && message.kind !== 'redo')
    )
      return undefined
    const state = this.replayState()
    if (
      epoch !== state.epoch ||
      replayOp <= state.applied ||
      state.ops.has(replayOp)
    )
      return undefined
    state.carried = true
    state.ops.set(replayOp, 'reserved')
    if (replayOp > state.lastHistoryOp) state.lastHistoryOp = replayOp
    const key = replayKey(epoch, replayOp)
    let payload: HistoryDeltaPost | undefined
    const wait = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => release(undefined), RESERVATION_TIMEOUT_MS)
      const release = (content: HistoryDeltaPost | undefined) => {
        clearTimeout(timer)
        this.reservations.delete(key)
        payload = content
        if (content && state.ops.get(replayOp) === 'reserved')
          state.ops.set(replayOp, 'queued')
        resolve(content !== undefined)
      }
      this.reservations.set(key, release)
    })
    // The turn waits for the payload; the receipt itself is not held by it.
    void this.queueReplayTurn(
      epoch,
      replayOp,
      () => this.runDeltaOp(payload as HistoryDeltaPost),
      { wait },
    )
    return undefined
  }

  // Task 733 / 036 (B0, 3.2): answered at once with the state of the requested operation of the named
  // epoch; an ended epoch answers with its own watermarks (review point 2).
  private answerReplayQuery(
    message: Extract<WebviewMessage, { command: 'replay-query' }>,
  ): void {
    const { epoch, replayOp } = message
    if (!validEpoch(epoch) || !validExactSequence(replayOp)) return
    const state = this.replayState()
    let status: ReplayOpStatus = 'unknown'
    let applied = 0
    let acceptedSequence = 0
    if (epoch === state.epoch) {
      applied = state.applied
      acceptedSequence = this.deltaWriter.acceptedSequence
      status =
        replayOp <= state.applied
          ? 'applied'
          : (state.ops.get(replayOp) ?? 'unknown')
    } else if (epoch < state.epoch) {
      const ended = this.endedReplays.get(epoch)
      applied = ended?.applied ?? 0
      acceptedSequence = ended?.acceptedSequence ?? 0
      status =
        replayOp <= applied
          ? 'applied'
          : ended?.refused === replayOp
            ? 'refused'
            : 'ended'
    }
    if (this.panelDisposed) return
    void this.webviewPanel.webview.postMessage({
      command: 'replay-status',
      epoch,
      replayOp,
      state: status,
      applied,
      acceptedSequence,
    })
  }

  // Task 733 / 036 (B0): the current host state, at once; starts no epoch.
  private answerHostStateQuery(
    message: Extract<WebviewMessage, { command: 'host-state-query' }>,
  ): void {
    if (this.panelDisposed) return
    this.docSync.postHostState(message.requestId, this.endedForHostState)
  }

  // Task 733 / 036 (B0, review point 2): one resync for the active history move of the current epoch,
  // queued after the operations already received; an abandon older than the latest move is ignored.
  private queueReplayAbandon(
    message: Extract<WebviewMessage, { command: 'replay-abandon' }>,
  ): Promise<void> | undefined {
    const { epoch, replayOp } = message
    if (!validEpoch(epoch) || !validExactSequence(replayOp)) return undefined
    const active = () => {
      const state = this.replayState()
      return state.epoch === epoch && replayOp >= state.lastHistoryOp
    }
    if (!active()) return undefined
    const turn = this.editMessageChain
      .catch(() => undefined)
      .then(async () => {
        if (active()) await this.resync()
      })
    this.editMessageChain = turn
    return turn
  }

  // Task 733 / 036 (B0, 3.6): recovery of `epoch` is finished; once every reapplication before it was
  // processed, the still unresolved entries of that epoch and older ones are written, each once.
  private queueRecoveryDone(
    message: Extract<WebviewMessage, { command: 'recovery-done' }>,
  ): Promise<void> | undefined {
    if (!validEpoch(message.epoch)) return undefined
    const turn = this.editMessageChain
      .catch(() => undefined)
      .then(() =>
        this.writeRecoveredEdits(
          (entry) =>
            entry.epoch <= message.epoch &&
            entry.epoch !== this.deltaWriter.epoch,
        ),
      )
    this.editMessageChain = turn
    return turn
  }

  // Task 733 / 036 (B0, 3.6): writes the unwritten recovery entries `select` names into one untitled
  // document that stays open after the source closes. The document text goes nowhere else.
  // 036 core C7 (R33.4): the entries are marked written right after the insertion succeeds; a failed
  // insertion is retried once after 500 ms and leaves them unwritten; a presentation failure is retried
  // once, presentation only. Two insertion failures during the final disposal lose the entries: one
  // count-only notification and `recoveredEditsLost` (Q-252).
  private async writeRecoveredEdits(
    select: (entry: RecoveryEntry) => boolean,
  ): Promise<void> {
    const entries: RecoveryEntry[] = []
    for (const entry of this.recoveryJournal.values())
      if (!entry.written && !entry.writing && select(entry)) entries.push(entry)
    if (entries.length === 0) return
    for (const entry of entries) entry.writing = true
    const text = formatRecoveredEdits(
      NodePath.basename(this.activeFsPath),
      entries,
    )
    const inserted = await this.retryOnce(() => insertRecoveredEdits(text))
    for (const entry of entries) {
      entry.writing = false
      if (inserted) entry.written = true
    }
    if (!inserted) {
      if (this.panelDisposed) {
        this.recoveredEditsLost += entries.length
        debug('recovered edits lost', this.recoveredEditsLost)
        void vscode.window.showErrorMessage(
          `VMDE could not save ${entries.length} recovered edits`,
        )
      }
      return
    }
    await this.retryOnce(() => presentRecoveredEdits())
  }

  /** 036 core C7 (R33.4): runs `step`, and once more after 500 ms when it fails; true when one run succeeded. */
  private async retryOnce(step: () => Promise<void>): Promise<boolean> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await step()
        return true
      } catch (error) {
        debug('recovered edits step failed', errorCategory(error))
        if (attempt === 0) await delay(RECOVERED_EDITS_RETRY_MS)
      }
    }
    return false
  }

  // Task 733 / 036 (B0, review point 4): on panel disposal, reservations give up, the operations already
  // received settle on the chain, and then every unresolved entry is written once.
  private disposeReplay(): Promise<void> {
    this.panelDisposed = true
    for (const release of [...this.reservations.values()]) release(undefined)
    return this.editMessageChain
      .catch(() => undefined)
      .then(() => this.writeRecoveredEdits(() => true))
  }

  private async postRewrapDocument() {
    await this.webviewPanel.webview.postMessage({
      command: 'rewrap-document',
      content: this.document.getText(),
    })
  }

  // Task 646: counts an outside change, also one that lands while VMDE's own write is in flight
  // (the echo check did not match it). Only a dirty-state event carries no text change and is
  // skipped during an own write.
  private skipDuringOwnWrite(event: vscode.TextDocumentChangeEvent): boolean {
    if (this.docSync.syncState.isApplyingHistory()) return true
    const changed = event.contentChanges.length > 0
    if (changed) {
      this.docSync.syncState.noteExternalChange()
      // Task 733 (E1): every change that is not an echo of a VMDE write starts a new epoch, so no
      // delta addressed to the old text applies. The Preview checkbox toggle is VMDE's own write.
      this.startEpoch(this.pendingPreviewTaskCheckboxEdit ? 'own' : 'external')
    }
    return !changed && this.docSync.syncState.isApplyingEdit()
  }

  // Task 646: the revision of the last outside change a warning was shown for.
  private warnedStaleRevision = -1

  // Task 646: a plain edit made from text older than the host's latest outside change is not
  // written. The current host text is posted again and the user is told once per revision.
  private refuseStaleEdit(
    message: Extract<WebviewMessage, { command: 'edit' }>,
  ): boolean {
    const revision = this.docSync.syncState.getExternalRevision()
    if (
      message.exact ||
      typeof message.revision !== 'number' ||
      message.revision === revision
    )
      return false
    void this.docSync.postUpdate()
    if (this.warnedStaleRevision !== revision) {
      this.warnedStaleRevision = revision
      void vscode.window.showWarningMessage(STALE_EDIT_WARNING)
    }
    return true
  }

  // Task 733: the delta epoch machinery. `startEpoch` is the only way a session starts an epoch: it
  // tells the next `update` how many deltas the ended epoch accepted, then starts the new one.
  private epochStart: EpochStart = 'own'
  private readySeen = false
  private warnedDeltaEpoch = -1
  // Task 733: set while a `history-transition` that carries `sequence` runs, so its rollback post is
  // the single `update` with a new epoch.
  private sequencedTransition = false
  // Task 733: the will-save correction is in flight; its change event is answered by `rebind`.
  private correctionRebind = false

  // Task 733: starts an own epoch whose announcement rides on the outcome message of the write.
  private startOwnEpochForOutcome(): { epoch: number; afterSequence?: number } {
    this.startEpoch('own')
    return this.docSync.announceEpoch()
  }

  // Task 733 (E5): the will-save correction is answered by `rebind` once its change event arrived.
  private answerCorrection(): void {
    if (!this.correctionRebind) return
    this.correctionRebind = false
    this.postRebind()
  }

  private startEpoch(kind: EpochStart): number {
    this.docSync.noteEpochEnded(
      this.deltaWriter.acceptedSequence,
      this.endReplayEpoch(),
    )
    this.epochStart = kind
    return this.deltaWriter.startEpoch()
  }

  // Starts a new epoch (a refusal) and posts the host text as the one `update` that ends the old one.
  private resync(): Promise<void> {
    this.startEpoch('refusal')
    return this.docSync.postUpdate()
  }

  // Task 733: a whole-text edit with `rebind: true` is answered exactly once, whatever path it took.
  private answerRebind(
    message: Extract<WebviewMessage, { command: 'edit' }>,
  ): void {
    const admitted = this.admittedPair
    this.admittedPair = undefined
    if (message.rebind === true)
      this.postRebind(rebindSequence(message), admitted)
  }

  // Q-11: while the delta writer refuses everything, the first refused delta of each epoch is answered
  // by a new epoch and one `update`; later ones in that epoch get nothing.
  private limitAnsweredEpoch = -1

  private async answerLimit(): Promise<void> {
    if (this.limitAnsweredEpoch === this.deltaWriter.epoch) return
    await this.resync()
    this.limitAnsweredEpoch = this.deltaWriter.epoch
  }

  private postRebind(
    editSequence?: number,
    exact?: { exactRequestId: string; exactEvicted?: string },
  ): void {
    this.docSync.postRebind(
      this.deltaWriter.acceptedSequence,
      editSequence,
      exact,
    )
  }

  // Task 733: a dropped or refused delta that carried text is not applied. Warn once per epoch, and
  // only when an external change or a refusal started the epoch (after the host's own correction,
  // block action or reload the webview publishes that typing again).
  private warnDroppedDelta(
    message: Extract<
      WebviewMessage,
      { command: 'edit-delta' | 'history-delta' }
    >,
    hostEpochBefore: number,
  ): void {
    if (!Array.isArray(message.changes) || message.changes.length === 0) return
    if (this.epochStart === 'own') return
    const key = Number.isSafeInteger(message.epoch)
      ? message.epoch
      : hostEpochBefore
    if (this.warnedDeltaEpoch === key) return
    this.warnedDeltaEpoch = key
    void vscode.window.showWarningMessage(STALE_EDIT_WARNING)
  }

  // Task 733: a ranged edit on the same chain as whole-text edits. `refuseStaleEdit` and
  // `consumeEdit` do not apply: deltas carry an epoch, and the writer compares `oldText`.
  private queueDelta(
    message: Extract<WebviewMessage, { command: 'edit-delta' }>,
  ) {
    return this.queueDeltaMessage(message, message.perf, (m) =>
      this.deltaWriter.apply(m),
    )
  }

  // Task 733 (task 004): an Undo or Redo as ranged changes, on the same chain as every other edit.
  private queueHistoryDelta(
    message: Extract<WebviewMessage, { command: 'history-delta' }>,
  ) {
    return this.queueDeltaMessage(message, undefined, (m) =>
      this.deltaWriter.applyHistory(m, this.historyCoupling),
    )
  }

  private queueDeltaMessage<M extends DeltaPost>(
    message: M,
    perf: RendererEditPerf | undefined,
    write: (message: M) => Promise<DeltaOutcome>,
  ) {
    // Task 733 / 036 (B0): a delta with `replayOp` is a replay operation (3.3); a history delta for a
    // waiting reservation goes straight to that turn (review point 1).
    const replayOp = (message as { replayOp?: unknown }).replayOp
    if (replayOp !== undefined) {
      if (!validEpoch(message.epoch) || !validExactSequence(replayOp))
        return undefined
      const recoveryOf = (message as { recoveryOf?: unknown }).recoveryOf
      // 036 core C7 (R34.4): a malformed change list is rejected before use and journaling, and answered
      // as a refusal (a waiting reservation gives up; otherwise the operation's turn refuses it).
      if (!validReplayChanges(message.changes)) {
        this.replayRejected++
        debug('replay rejected', this.replayRejected)
        const reserved = this.reservations.get(
          replayKey(message.epoch, replayOp),
        )
        if (reserved) {
          reserved(undefined)
          return undefined
        }
        return this.queueReplayTurn(
          message.epoch,
          replayOp,
          async () => 'refused',
          { recoveryOf },
        )
      }
      this.noteReplayReceived(
        message.epoch,
        replayOp,
        Array.isArray(message.changes) ? { changes: message.changes } : {},
        { history: message.command === 'history-delta', recoveryOf },
      )
      const reserved = this.reservations.get(replayKey(message.epoch, replayOp))
      if (reserved && message.command === 'history-delta') {
        reserved(message as HistoryDeltaPost)
        return undefined
      }
      return this.queueReplayTurn(
        message.epoch,
        replayOp,
        () => this.runDeltaOp(message, perf, write),
        { recoveryOf },
      )
    }
    const turn = this.editMessageChain
      .catch(() => undefined)
      .then(async () => {
        await this.writeDeltaTurn(message, perf, write)
      })
    this.editMessageChain = turn
    return turn
  }

  // Task 733 / 036 (B0): the run step of a delta replay operation; the writer's checks are its proof.
  // An empty history delta is a reserved Undo whose restore changed no text: it consumes its sequence.
  private async runDeltaOp<M extends DeltaPost>(
    message: M,
    perf?: RendererEditPerf,
    write?: (message: M) => Promise<DeltaOutcome>,
  ): Promise<ReplayRun> {
    const writer =
      write ??
      ((m: M) =>
        this.deltaWriter.applyHistory(
          m as HistoryDeltaPost,
          this.historyCoupling,
        ))
    const outcome = await this.writeDeltaTurn(message, perf, (m) =>
      m.command === 'history-delta' &&
      Array.isArray(m.changes) &&
      m.changes.length === 0
        ? Promise.resolve(this.deltaWriter.consumeEmpty(m))
        : writer(m),
    )
    if (outcome.kind === 'applied') return 'proven'
    return outcome.kind === 'resync' ? 'refused' : 'stopped'
  }

  // One delta write with its bookkeeping. A replay operation's refusal is answered by its turn
  // (`replay` true), so the resync is not made here.
  private async writeDeltaTurn<M extends DeltaPost>(
    message: M,
    perf: RendererEditPerf | undefined,
    write: (message: M) => Promise<DeltaOutcome>,
  ): Promise<DeltaOutcome> {
    const perfId = beginEditPerf(perf)
    const replay = (message as { replayOp?: unknown }).replayOp !== undefined
    // A plain edit older than this delta must not be named by `exact-authority`.
    this.lastEditSequence = undefined
    // A deferred no-op restore armed before this delta would read the pre-delta text.
    const cancelledNoop = this.writeback.cancelNoopCheckForDelta()
    const hostEpochBefore = this.deltaWriter.epoch
    const outcome = await write(message)
    if (outcome.kind === 'applied') {
      // When the epoch moved during the write, E1 already scheduled the `update`.
      if (this.deltaWriter.epoch === message.epoch) {
        const text = this.document.getText()
        this.docSync.syncState.markSynced(text)
        this.writeback.armNoopCheckAfterDelta(text)
      }
    } else {
      if (outcome.kind === 'resync' && !replay) await this.resync()
      else if (outcome.kind === 'dropped' && outcome.why === 'refusal-limit')
        await this.answerLimit()
      this.warnDroppedDelta(message, hostEpochBefore)
      // The delta changed nothing: the restore it cancelled still applies.
      if (cancelledNoop !== undefined)
        this.writeback.rearmNoopCheck(cancelledNoop)
    }
    finishEditPerf(perfId, 'complete')
    return outcome
  }

  // Task 712: the `sequence` of the plain edit this host processed last, for `exact-authority`.
  private lastEditSequence: number | undefined

  private queueEdit(message: Extract<WebviewMessage, { command: 'edit' }>) {
    // Task 733 / 036 (B0): the evicted exact edit and the whole post of the logical text carry both
    // replay numbers; such an edit is a replay operation (3.3) proven by the written bytes (3.4). Only
    // line endings are normalized: the webview's record of an evicted pair holds `\n` text while the
    // host admitted the raw CRLF bytes.
    const { epoch, replayOp } = message
    if (epoch !== undefined || replayOp !== undefined) {
      if (!validEpoch(epoch) || !validExactSequence(replayOp)) return undefined
      this.noteReplayReceived(
        epoch,
        replayOp,
        typeof message.content === 'string' ? { content: message.content } : {},
        { history: message.history !== undefined },
      )
      return this.queueReplayTurn(epoch, replayOp, async () => {
        const perfId = beginEditPerf(message.perf)
        try {
          await this.processEdit(message, perfId)
        } catch (error) {
          debug('replay edit failed', errorCategory(error))
          return 'refused'
        }
        return normalizeContent(this.document.getText()) ===
          normalizeContent(message.content)
          ? 'proven'
          : 'refused'
      })
    }
    const perfId = beginEditPerf(message.perf)
    const turn = this.editMessageChain
      .catch(() => undefined)
      .then(async () => {
        try {
          await this.processEdit(message, perfId)
        } catch (error) {
          // The webview waits for an answer to a `rebind: true` edit: show it the host text.
          if (message.rebind === true) await this.resync()
          throw error
        }
      })
    this.editMessageChain = turn
    return turn
  }

  private async processEdit(
    message: Extract<WebviewMessage, { command: 'edit' }>,
    perfId: string | undefined,
  ): Promise<void> {
    // Cleared first, so a refused, failed or non-plain edit never leaves an older echo behind.
    this.lastEditSequence = undefined
    const sequence = plainEditSequence(message)
    if (this.refuseStaleEdit(message)) {
      finishEditPerf(perfId, 'complete')
      return
    }
    // Exact, explicit-block and rewrap requests are authored actions, even if their bytes
    // match a history echo. Only an ordinary debounced edit may reuse that suppression.
    const plain =
      !message.exact && !message.explicitBlock && !message.rewrapDocument
    if (await this.historyCoupling.consumeEdit(message.content, plain)) {
      // The host already holds the text this post returns to.
      this.lastEditSequence = sequence
      finishEditPerf(perfId, 'complete')
      this.answerRebind(message)
      return
    }
    const versionBefore = this.document.version
    const replaying = this.startNativeReplay(message)
    const native = replaying && (await replaying)
    if (native) {
      finishEditPerf(perfId, 'complete')
      // A resync pairs no webview content with the host text; a replay does.
      if (native === 'replayed')
        this.historyCoupling.recordPublished(
          message.content,
          this.document.getText(),
        )
      if (native === 'replayed') this.answerRebind(message)
      return
    }
    await this.writeEdit(message, perfId, sequence, versionBefore)
  }

  // The write path of a whole-text edit: write, remember the pair for history proofs, answer.
  private async writeEdit(
    message: Extract<WebviewMessage, { command: 'edit' }>,
    perfId: string | undefined,
    sequence: number | undefined,
    versionBefore: number,
  ): Promise<void> {
    const outcome = await this.onEdit(message, perfId)
    this.lastEditSequence = sequence
    // Task 602: the host text VMDE wrote (or already held) for this webview content proves a
    // later history transition that returns to it.
    const hostContent = this.document.getText()
    if (
      this.document.version !== versionBefore ||
      normalizeContent(hostContent) === normalizeContent(message.content)
    )
      this.historyCoupling.recordPublished(message.content, hostContent)
    // A refused exact edit keeps `exact-edit-refused` and gets no `rebind`.
    if (outcome !== 'refused') this.answerRebind(message)
  }

  // Task 685: the webview replays Undo/Redo of an exact action as an exact edit that names its
  // direction. Reach those bytes through native history first, so VS Code restores its saved
  // version and the tab goes clean; any other outcome falls through to the forward exact write.
  // The guard is synchronous, so a plain keystroke takes no extra async frame.
  private startNativeReplay(
    message: Extract<WebviewMessage, { command: 'edit' }>,
  ): Promise<'replayed' | 'resynced' | false> | false {
    return message.exact === true && message.history !== undefined
      ? this.replayExactNatively(message)
      : false
  }

  private async replayExactNatively(
    message: Extract<WebviewMessage, { command: 'edit' }>,
  ): Promise<'replayed' | 'resynced' | false> {
    const { history, before, content } = message
    if (
      message.exact !== true ||
      (history !== 'undo' && history !== 'redo') ||
      typeof before !== 'string' ||
      typeof content !== 'string'
    )
      return false
    try {
      await this.writeback.settleOwnWrites()
      const outcome = await this.historyCoupling.replayExact(
        history,
        before,
        content,
      )
      if (outcome === 'declined') return false
      if (outcome === 'diverged') {
        // The rollback left an intermediate host text, so the forward write would be refused:
        // show the webview the host text instead (as a refused history transition does).
        await this.resync()
        return 'resynced'
      }
      this.writeback.noteExactReplay(this.document.getText())
      return 'replayed'
    } catch (error) {
      debug('native exact replay failed', errorCategory(error))
      return false
    }
  }

  // Task 602: queued with edits, so the host text paired with the base includes every edit the
  // webview posted before it. A host change the webview has not received yet cannot be paired.
  private queueHistoryBase(
    message: Extract<WebviewMessage, { command: 'history-base' }>,
  ) {
    const turn = this.editMessageChain
      .catch(() => undefined)
      .then(() => {
        // Task 700: a base from a view older than the host's latest outside change is refused,
        // like a stale plain edit; one without a numeric revision fails closed. It carries no
        // text, so the host pairs the ID with its own.
        if (
          typeof message.revision !== 'number' ||
          message.revision !== this.docSync.syncState.getExternalRevision()
        )
          return
        const hostContent = this.document.getText()
        this.historyCoupling.recordBaseId(
          message.mode,
          message.baseId,
          this.docSync.syncState.isAlreadySynced(hostContent)
            ? hostContent
            : undefined,
        )
      })
    this.editMessageChain = turn
    return turn
  }

  private queueHistoryTransition(
    message: Extract<WebviewMessage, { command: 'history-transition' }>,
  ) {
    const turn = this.editMessageChain
      .catch(() => undefined)
      .then(async () => {
        const sequence = message.sequence
        if (typeof sequence !== 'number') {
          await this.historyCoupling.handle(message)
          return
        }
        // Task 733: answered exactly once. Accepted: `rebind` with the host text. Declined, diverged
        // or refused: a new epoch and one `update` (the rollback post, or the one made here).
        this.sequencedTransition = true
        const epoch = this.deltaWriter.epoch
        try {
          if (await this.historyCoupling.handle(message)) {
            this.postRebind(sequence)
          } else if (this.deltaWriter.epoch === epoch) {
            await this.resync()
          }
        } catch (error) {
          // Answered exactly once also when the handler throws: show the webview the host text.
          if (this.deltaWriter.epoch === epoch) await this.resync()
          throw error
        } finally {
          this.sequencedTransition = false
        }
      })
    this.editMessageChain = turn
    return turn
  }

  // Task 580 CP2-12 — ask the webview to flush pending typing before a save writes the document.
  // Returns a promise for `event.waitUntil` that resolves (never rejects) once the edit the flush
  // posted has been applied, or after SAVE_FLUSH_TIMEOUT_MS. It resolves at once when the webview
  // is not live, and when the document holds a change the webview has not received yet: an edit
  // flushed from that stale DOM would overwrite the newer text (for example, typing in a text editor
  // inside the 75 ms update debounce).
  private flushWebviewForSave(document: vscode.TextDocument): Promise<void> {
    // Task 733 / 036: a queued replay is checked first; mid-replay the document holds an intermediate
    // native step that the webview never received, which is no reason to stop waiting.
    // Task 733 / 036 (B0): any replay turn (queued, running or reserved) counts as a queued replay.
    if (
      this.exactTurns === 0 &&
      this.replayTurns === 0 &&
      !this.docSync.syncState.isAlreadySynced(document.getText())
    )
      return Promise.resolve()
    this.saveFlushSeq += 1
    const requestId = `save-flush-${this.saveFlushSeq}`
    return new Promise<void>((resolve) => {
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.saveFlushes.delete(requestId)
        resolve()
      }
      // The webview posts its flush `edit` before this reply, and the message listener queues that
      // edit synchronously, so the chain already holds it when the reply arrives.
      const replied = () => {
        this.saveFlushes.delete(requestId)
        this.editMessageChain.then(finish, finish)
      }
      this.saveFlushes.set(requestId, { replied, finish })
      // Task 733 / 036 (Q-220): while a replay is queued the save waits for the chain; VS Code's shared
      // will-save budget (1.5 s) bounds the wait, so no private timer cuts the replay short. B0 (3.9):
      // the guarantee ends at that deadline; VS Code then saves the document as it is, and nothing here
      // promises a second save or a dirty state afterwards.
      const timer = setTimeout(() => {
        if (this.exactTurns > 0 || this.replayTurns > 0)
          this.editMessageChain.then(finish, finish)
        else finish()
      }, SAVE_FLUSH_TIMEOUT_MS)
      Promise.resolve(
        this.webviewPanel.webview.postMessage({
          command: 'flush-for-save',
          requestId,
        }),
      ).then((delivered) => {
        if (!delivered) finish()
      }, finish)
    })
  }

  // Task 607 rule 5: queued behind every earlier edit, so the reply is the text those edits left.
  private queueExactAuthority(
    message: Extract<WebviewMessage, { command: 'request-exact-authority' }>,
  ) {
    const turn = this.editMessageChain
      .catch(() => undefined)
      .then(() =>
        this.webviewPanel.webview.postMessage({
          command: 'exact-authority',
          requestId: message.requestId,
          content: this.document.getText(),
          ...(this.lastEditSequence === undefined
            ? {}
            : { editSequence: this.lastEditSequence }),
        }),
      )
      .then(() => undefined)
    this.editMessageChain = turn
    return turn
  }

  private postRewrapDocumentAfterEdits() {
    return this.editMessageChain.then(() => this.postRewrapDocument())
  }

  private async prepareBlockAction(
    message: Extract<WebviewMessage, { command: 'request-block-action' }>,
  ): Promise<void> {
    await this.editMessageChain
    const before = this.document.getText()
    const action = message.action
    const valid =
      action &&
      (action.kind === 'move' ||
        action.kind === 'delete' ||
        action.kind === 'duplicate') &&
      Number.isSafeInteger(action.sourceStart) &&
      (action.kind !== 'move' ||
        (Number.isSafeInteger(action.targetStart) &&
          (action.placement === 'before' || action.placement === 'after')))
    const plan =
      valid && message.before === before
        ? planBlockAction(before, action)
        : { status: 'rejected' as const }
    if (plan.status !== 'ok') {
      void this.webviewPanel.webview.postMessage({
        command: 'block-action-outcome',
        requestId: message.requestId,
        status: plan.status === 'noop' ? 'noop' : 'stale',
        content: before,
      })
      return
    }
    const previous = this.blockActions.get(message.requestId)
    if (previous) clearTimeout(previous.timeout)
    const binding = {
      uri: this.document.uri.toString(),
      version: this.document.version,
      before,
      after: plan.markdown,
      timeout: setTimeout(
        () => this.blockActions.delete(message.requestId),
        30_000,
      ),
    }
    this.blockActions.set(message.requestId, binding)
    void this.webviewPanel.webview.postMessage(
      blockActionPreparePayload(message.requestId, binding, plan.caretOffset),
    )
  }

  private cancelBlockAction(requestId: string): void {
    const binding = this.blockActions.get(requestId)
    if (binding) clearTimeout(binding.timeout)
    this.blockActions.delete(requestId)
  }

  private queueBlockAction(
    message: Extract<WebviewMessage, { command: 'apply-block-action' }>,
  ) {
    const turn = this.editMessageChain
      .catch(() => undefined)
      .then(async () => {
        const binding = this.blockActions.get(message.requestId)
        this.blockActions.delete(message.requestId)
        if (binding) clearTimeout(binding.timeout)
        const valid =
          binding &&
          binding.uri === message.uri &&
          binding.version === message.version &&
          binding.before === message.before &&
          binding.after === message.after
        const status = valid
          ? await this.writeback.applyExactGuarded(
              binding.after,
              binding.version,
              binding.before,
            )
          : 'stale'
        // Task 733: the write is VMDE's own, not a delta, so it starts a new epoch. The outcome
        // announces it: an `update` here would be applied as a host change and re-seed the webview's
        // Undo history, which this write must keep.
        const epoch = status === 'applied' ? this.startOwnEpochForOutcome() : {}
        await this.webviewPanel.webview.postMessage({
          command: 'block-action-outcome',
          requestId: message.requestId,
          status,
          content: this.document.getText(),
          ...epoch,
        })
      })
    this.editMessageChain = turn
    return turn
  }

  // Task 630: the webview declined the prepared move (stale owned text). Nothing was written, and
  // the binding must not outlive the request.
  private cancelOutlineSectionMove(requestId: string): void {
    this.outlineMoves.delete(requestId)
  }

  private async prepareOutlineSectionMove(
    message: Extract<
      WebviewMessage,
      { command: 'request-outline-section-move' }
    >,
  ) {
    await this.editMessageChain
    const document = this.document
    const before = document.getText()
    const headings = scanSourceHeadings(before)
    if (
      headings.length !== message.rowLabels.length ||
      headings.some(
        (heading, index) =>
          sourceHeadingLabel(before, heading) !== message.rowLabels[index],
      )
    ) {
      void this.webviewPanel.webview.postMessage({
        command: 'outline-section-move-outcome',
        requestId: message.requestId,
        status: 'stale',
        content: before,
      })
      return
    }
    const source = headings[message.sourceIndex]
    const target = headings[message.targetIndex]
    const plan =
      source && target
        ? moveMarkdownSection(before, source, target, message.placement)
        : { status: 'rejected' as const }
    if (plan.status !== 'ok') {
      void this.webviewPanel.webview.postMessage({
        command: 'outline-section-move-outcome',
        requestId: message.requestId,
        status: plan.status === 'noop' ? 'noop' : 'stale',
        content: before,
      })
      return
    }
    const binding = {
      uri: document.uri.toString(),
      version: document.version,
      before,
      after: plan.markdown,
    }
    this.outlineMoves.set(message.requestId, binding)
    void this.webviewPanel.webview.postMessage({
      command: 'prepare-outline-section-move',
      requestId: message.requestId,
      ...binding,
    })
  }

  private isPendingPreviewTaskCheckboxChange(
    document: vscode.TextDocument,
    currentContent: string,
  ): boolean {
    const pending = this.pendingPreviewTaskCheckboxEdit
    if (!pending) return false
    if (
      document.version === pending.version + 1 &&
      currentContent === pending.after
    )
      return true
    this.pendingPreviewTaskCheckboxEdit = undefined
    return false
  }

  private queuePreviewTaskCheckboxToggle(
    message: Extract<
      WebviewMessage,
      { command: 'toggle-preview-task-checkbox' }
    >,
  ) {
    const turn = this.editMessageChain
      .catch(() => undefined)
      .then(async () => {
        const result = await this.applyPreviewTaskCheckboxToggle(message)
        await this.webviewPanel.webview.postMessage({
          command: 'preview-task-checkbox-outcome',
          requestId: message.requestId,
          status: result.status,
          source: result.source,
        })
      })
    this.editMessageChain = turn.then(
      () => undefined,
      () => undefined,
    )
    return turn
  }

  private async applyPreviewTaskCheckboxToggle(
    message: Extract<
      WebviewMessage,
      { command: 'toggle-preview-task-checkbox' }
    >,
  ): Promise<{
    status: 'applied' | 'stale' | 'disabled' | 'error'
    source: string
  }> {
    const document = this.document
    if (document.isClosed || !canEditPreviewTaskCheckboxes(document.uri))
      return { status: 'disabled', source: document.getText() }

    const version = document.version
    const before = document.getText()
    const plan = planPreviewTaskCheckboxEdit(before, message)
    if (plan.status !== 'planned') return { status: 'stale', source: before }

    const edit = new vscode.WorkspaceEdit()
    edit.replace(
      document.uri,
      new vscode.Range(
        document.positionAt(plan.startOffset),
        document.positionAt(plan.endOffset),
      ),
      plan.replacement,
    )
    // WorkspaceEdit has no document-version field. Recheck the version and full before-bytes
    // after range construction and immediately before applyEdit.
    if (document.version !== version || document.getText() !== before)
      return { status: 'stale', source: document.getText() }

    // A previous external-change debounce may still be armed. This guarded edit
    // owns the next host update; cancel that ordinary timer before applyEdit can
    // synchronously emit onDidChangeTextDocument.
    this.docSync.cancelScheduledUpdate()
    this.pendingPreviewTaskCheckboxEdit = {
      version,
      after: plan.after,
    }
    let status: 'applied' | 'stale' | 'disabled' | 'error'
    try {
      status = await this.applyTaskCheckboxWorkspaceEdit(
        edit,
        document,
        version,
        before,
        plan.after,
      )
    } finally {
      this.pendingPreviewTaskCheckboxEdit = undefined
    }
    if (status === 'applied') {
      // The raw before/after pair, not Vditor's normalized text, identifies the
      // sole update eligible to keep its native Undo/Redo stack.
      await this.docSync.postUpdate({
        previewTaskCheckboxHistory: {
          requestId: message.requestId,
          before,
          after: plan.after,
        },
      })
    } else {
      // Replacing the timer above must not strand a concurrent or failed edit.
      await this.docSync.postUpdate()
    }
    return { status, source: document.getText() }
  }

  private async applyTaskCheckboxWorkspaceEdit(
    edit: vscode.WorkspaceEdit,
    document: vscode.TextDocument,
    version: number,
    before: string,
    expectedAfter: string,
  ): Promise<'applied' | 'stale' | 'disabled' | 'error'> {
    try {
      const applied = await vscode.workspace.applyEdit(edit)
      const after = document.getText()
      const afterVersion = document.version
      if (applied && after === expectedAfter && afterVersion === version + 1)
        return 'applied'
      if (!applied && after === before && afterVersion === version)
        return 'disabled'
      return 'stale'
    } catch (error) {
      debug('Preview task-checkbox edit failed', error)
      return 'error'
    }
  }

  private queueOutlineSectionMove(
    message: Extract<WebviewMessage, { command: 'apply-outline-section-move' }>,
  ) {
    const turn = this.editMessageChain
      .catch(() => undefined)
      .then(async () => {
        const binding = this.outlineMoves.get(message.requestId)
        this.outlineMoves.delete(message.requestId)
        const valid =
          binding &&
          binding.uri === message.uri &&
          binding.version === message.version &&
          binding.before === message.before &&
          binding.after === message.after
        const status = valid
          ? await this.writeback.applyExactGuarded(
              binding.after,
              binding.version,
              binding.before,
            )
          : 'stale'
        const epoch = status === 'applied' ? this.startOwnEpochForOutcome() : {}
        await this.webviewPanel.webview.postMessage({
          command: 'outline-section-move-outcome',
          requestId: message.requestId,
          status,
          content: this.document.getText(),
          ...epoch,
        })
      })
    this.editMessageChain = turn
    return turn
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
    // Task 733: the write runs on the edit chain like every other writer, and the own epoch starts
    // before it, so a delta of the old epoch queued behind it is dropped instead of landing on the
    // saved text. The webview is told the new epoch by one `update`. `document.save()` stays off the
    // chain: the will-save flush waits for the chain.
    const turn = this.editMessageChain
      .catch(() => undefined)
      .then(async () => {
        this.startEpoch('own')
        await this.writeback.syncToEditor(message.content)
        await this.docSync.postUpdate()
      })
    this.editMessageChain = turn
    await turn
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

  private async cancelBlockTransformChoice(token: number): Promise<void> {
    await this.webviewPanel.webview.postMessage({
      command: 'cancel-block-transform-choice',
      token,
    })
  }

  private validBlockTransformConsent(
    message: Extract<WebviewMessage, { command: 'block-transform-consent' }>,
  ): boolean {
    const { target, status, losses } = message
    return Boolean(
      this.webviewPanel.active &&
        target &&
        BLOCK_TYPES.includes(target.type) &&
        (status === 'changed' ||
          status === 'confirm-required' ||
          status === 'edit-language') &&
        (status !== 'edit-language' || target.type === 'fence') &&
        Array.isArray(losses) &&
        losses.every((loss) => BLOCK_TRANSFORM_LOSSES.includes(loss)),
    )
  }

  private async onBlockTransformConsent(
    message: Extract<WebviewMessage, { command: 'block-transform-consent' }>,
  ): Promise<void> {
    const { token, target, status, losses } = message
    if (!Number.isSafeInteger(token) || token <= 0) return
    if (!this.validBlockTransformConsent(message)) {
      await this.cancelBlockTransformChoice(token)
      return
    }
    const epoch = ++this.blockOptionsEpoch
    const uri = this.activeUri.toString()
    const version = this.document.version
    let consent = true
    let chosenTarget = target
    if (status === 'edit-language') {
      const language = await vscode.window.showInputBox({
        title: 'Code Fence Language',
        prompt: 'Enter a language identifier, or leave blank for plain code',
        value: target.language ?? '',
        validateInput: (value) =>
          /^[^\s`~]*$/u.test(value)
            ? undefined
            : 'Use one language identifier without spaces or fence markers',
      })
      if (
        language === undefined ||
        !/^[^\s`~]*$/u.test(language) ||
        language === (target.language ?? '')
      )
        consent = false
      else chosenTarget = { type: 'fence', language }
    } else if (status === 'confirm-required') {
      consent =
        (await vscode.window.showWarningMessage(
          blockTransformWarningText(target.type, losses),
          'Turn Into',
        )) === 'Turn Into'
    }
    if (
      !consent ||
      epoch !== this.blockOptionsEpoch ||
      this.activeUri.toString() !== uri ||
      this.document.version !== version ||
      !this.webviewPanel.active
    ) {
      await this.cancelBlockTransformChoice(token)
      return
    }
    await this.webviewPanel.webview.postMessage({
      command: 'apply-block-transform-choice',
      token,
      target: chosenTarget,
      confirmed: status === 'confirm-required',
    })
  }

  private async onBlockTransformOptions(
    message: Extract<WebviewMessage, { command: 'block-transform-options' }>,
  ): Promise<void> {
    if (!Number.isSafeInteger(message.token) || message.token <= 0) return
    if (
      !this.webviewPanel.active ||
      !Array.isArray(message.targets) ||
      (message.currentType !== 'mixed' &&
        !BLOCK_TYPES.includes(message.currentType))
    ) {
      await this.cancelBlockTransformChoice(message.token)
      return
    }
    const options = message.targets.filter(
      (target) =>
        target !== null &&
        typeof target === 'object' &&
        BLOCK_TYPES.includes(target.type) &&
        (target.status === 'changed' ||
          target.status === 'noop' ||
          target.status === 'confirm-required') &&
        Array.isArray(target.losses) &&
        target.losses.every((loss) => BLOCK_TRANSFORM_LOSSES.includes(loss)),
    )
    if (!options.length) {
      await this.cancelBlockTransformChoice(message.token)
      return
    }
    const epoch = ++this.blockOptionsEpoch
    const uri = this.activeUri.toString()
    const version = this.document.version
    const picked = await vscode.window.showQuickPick(
      options.map((option) => ({
        label: `${option.type === message.currentType ? '$(check) ' : ''}${option.status === 'confirm-required' ? '$(warning) ' : ''}${BLOCK_LABELS[option.type]}`,
        description:
          option.status === 'noop'
            ? option.type === 'fence' &&
              message.currentType === 'fence' &&
              typeof message.fenceLanguage === 'string'
              ? 'Edit code fence language…'
              : 'Current block type'
            : option.status === 'confirm-required'
              ? 'Confirmation required'
              : undefined,
        type: option.type,
      })),
      {
        title: 'Turn Into',
        placeHolder: `Current: ${message.currentType === 'mixed' ? 'Mixed' : BLOCK_LABELS[message.currentType]}`,
      },
    )
    const chosen = options.find((option) => option.type === picked?.type)
    const editLanguage =
      chosen?.type === 'fence' &&
      chosen.status === 'noop' &&
      message.currentType === 'fence' &&
      typeof message.fenceLanguage === 'string'
    if (
      !chosen ||
      (chosen.status !== 'changed' &&
        chosen.status !== 'confirm-required' &&
        !editLanguage) ||
      epoch !== this.blockOptionsEpoch ||
      this.activeUri.toString() !== uri ||
      this.document.version !== version ||
      !this.webviewPanel.active
    ) {
      await this.cancelBlockTransformChoice(message.token)
      return
    }
    await this.onBlockTransformConsent({
      command: 'block-transform-consent',
      token: message.token,
      target: {
        type: chosen.type,
        language: editLanguage ? message.fenceLanguage : undefined,
      },
      status: editLanguage
        ? 'edit-language'
        : chosen.status === 'confirm-required'
          ? 'confirm-required'
          : 'changed',
      losses: chosen.losses,
    })
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
    // Task 636 — releases the cache change subscription with the panel.
    this.disposables.push(this.wiki)
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
      deltasAccepted: () => this.deltaWriter.acceptedSequence > 0,
      postRestoreBaseline: (content) =>
        this.docSync.postRestoreBaseline(
          this.deltaWriter.acceptedSequence,
          content,
        ),
      // Task 733 (E6): a restore the host writes itself is a write the webview did not predict.
      beforeHostWrite: () => {
        this.startEpoch('own')
      },
      afterHostWrite: () => this.postRebind(),
    })
    this.deltaWriter = new DeltaWriter({
      document,
      syncState: this.docSync.syncState,
      runOnApplyChain: (fn) => this.writeback.runOnApplyChain(fn),
      applyEdit: (edit) => vscode.workspace.applyEdit(edit),
      getUri: () => this.activeUri,
      now: () => Date.now(),
      log: (message, details) => debug(message, details),
    })
    this.writeback.setCleanBaseline(document.getText()) // open: document == disk
    this.historyCoupling = new HistoryCouplingController({
      currentContent: () => this.document.getText(),
      equivalentToCurrent: (content) =>
        this.writeback.isSemanticallyEquivalentToDocument(content),
      equivalent: (source, content) =>
        this.writeback.isSemanticallyEquivalent(source, content),
      execute: async (kind) => {
        await vscode.commands.executeCommand(kind)
      },
      setApplying: (value) => {
        this.docSync.syncState.setApplyingWebviewEdit(value)
        this.docSync.syncState.setApplyingHistory(value)
      },
      markSynced: (content) => this.docSync.syncState.markSynced(content),
      postUpdate: () =>
        this.sequencedTransition ? this.resync() : this.docSync.postUpdate(),
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
      moveOutlineSection: (source, target, placement) => {
        void webviewPanel.webview.postMessage({
          command: 'move-outline-section',
          source,
          target,
          placement,
        })
      },
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
      'find-widget-state': (message) => {
        this.findWidgetVisible = message.visible
        if (this.webviewPanel.active) {
          return vscode.commands.executeCommand(
            'setContext',
            'vmde.findWidgetVisible',
            message.visible,
          )
        }
      },
      'request-rewrap-document': () => this.postRewrapDocumentAfterEdits(),
      'request-exact-authority': (message) => this.queueExactAuthority(message),
      'block-transform-options': (message) =>
        this.onBlockTransformOptions(message),
      'block-transform-consent': (message) =>
        this.onBlockTransformConsent(message),
      'request-block-action': (message) => this.prepareBlockAction(message),
      'apply-block-action': (message) => this.queueBlockAction(message),
      'cancel-block-action': (message) =>
        this.cancelBlockAction(message.requestId),
      'request-outline-section-move': (message) =>
        this.prepareOutlineSectionMove(message),
      'apply-outline-section-move': (message) =>
        this.queueOutlineSectionMove(message),
      'cancel-outline-section-move': (message) =>
        this.cancelOutlineSectionMove(message.requestId),
      'toggle-preview-task-checkbox': (message) =>
        this.queuePreviewTaskCheckboxToggle(message),
      'save-options': (message) => this.onSaveOptions(message),
      'save-fold-state': (message) => this.onSaveFoldState(message),
      'save-reading-position': (message) => this.onSaveReadingPosition(message),
      'record-emoji-recent': (message) =>
        this.recordEmojiRecent(message.sequence),
      info: (message) => this.onInfo(message),
      error: (message) => this.onError(message),
      edit: (message) => this.queueEdit(message),
      'edit-delta': (message) => this.queueDelta(message),
      'history-delta': (message) => this.queueHistoryDelta(message),
      'history-transition': (message) => this.queueHistoryTransition(message),
      // Task 733 / 036: pre-checked in the dispatcher (`receiveHistoryExact`); never reached by shape.
      'history-exact': (message) => this.receiveHistoryExact(message),
      // Task 733 / 036 (B0): the replay contract of the fix design, section 3.2.
      'replay-reserve': (message) => this.receiveReplayReserve(message),
      'replay-query': (message) => this.answerReplayQuery(message),
      'host-state-query': (message) => this.answerHostStateQuery(message),
      'replay-abandon': (message) => this.queueReplayAbandon(message),
      'recovery-done': (message) => this.queueRecoveryDone(message),
      'history-base': (message) => this.queueHistoryBase(message),
      'edit-perf-renderer': (message) =>
        rendererPostPerf(message.id, message.postMessageMs, message.state),
      save: (message) => this.onSave(message),
      'flush-for-save-done': (message) =>
        this.saveFlushes.get(message.requestId)?.replied(),
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
      'save-outline-width': (message) => {
        // Over the wire NaN/Infinity arrive as null (dropped by the shape check); the guard also
        // refuses zero and negative widths so a bad value can never reach the next editor's init.
        if (isUsableOutlineWidth(message.width)) {
          return this.stateWrites.write(KeyOutlineWidth, message.width)
        }
      },
      // Task 650: store only; nothing is posted or broadcast (read at the next editor open).
      'save-outline-open': (message) =>
        this.stateWrites.write(KeyOutlineOpen, message.open),
      'save-toolbar-collapsed': (message) =>
        this.onSaveToolbarCollapsed(message),
      'save-preview-state': (message) => this.onSavePreviewState(message),
      upload: (message) => this.onUpload(message),
      'open-link': (message) => this.onOpenLink(message),
      'open-wikilink': (message) => this.onOpenWikilink(message),
      'resolve-code-refs': (message) => this.onResolveCodeRefs(message),
      'open-code-ref': (message) => this.onOpenCodeRef(message),
      'copy-html': (message) => this.onCopyToClipboard(message, 'HTML'),
      'copy-markdown': (message) => this.onCopyToClipboard(message, 'Markdown'),
      'copy-code': (message) => this.onCopyToClipboard(message, 'code'),
      'copy-property': (message) => this.onCopyToClipboard(message, 'property'),
      'copy-link-url': (message) => this.onCopyToClipboard(message, 'URL'),
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
        // Wiki config changed (enabled/root) → recompute the context; a changed effective root
        // invalidates the old cache. The keys for the new root follow `config-changed` (task 637).
        let wikiRootChanged = false
        if (
          affectsVmde &&
          e.affectsConfiguration(`${ConfigurationRoot}.wiki`)
        ) {
          wikiRootChanged = this.wiki.onConfigChanged(this.document.uri)
          void updateEditorContexts()
        }
        // Task 650: a changed outline default invalidates the remembered open choice so the new
        // setting wins. No uri: matches any scope. Idempotent across several sessions. Accepted
        // limit: with no open editor affected by the change, nothing clears.
        if (
          e.affectsConfiguration(`${ConfigurationRoot}.outline.defaultOpen`)
        ) {
          this.stateWrites
            .write(KeyOutlineOpen, undefined)
            .catch((error: unknown) =>
              debug('outline open flag not cleared', error),
            )
        }
        this.panelConfig.postLiveConfig()
        if (wikiRootChanged) this.refreshWikiKeys()
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
          this.answerCorrection()
          return
        }
        if (this.skipDuringOwnWrite(event)) return
        // Task 602: pairs recorded before a change VMDE did not make no longer prove history. A
        // dirty-state event (after a save or a revert to the saved text) changes no text.
        if (event.contentChanges.length) {
          this.historyCoupling.forgetHostMappings()
          // Task 733 / 036: an outside change also invalidates every replay pair.
          this.exactPairs = []
        }
        // applyPreviewTaskCheckboxToggle posts the verified tagged update before
        // the outcome. An ordinary debounce for that one event would clear history.
        if (
          this.isPendingPreviewTaskCheckboxChange(
            event.document,
            currentContent,
          )
        )
          return
        // An external change that left the document clean (revert, reload from disk):
        // adopt it as the new baseline so a later undo-to-here can return to disk.
        if (!event.document.isDirty) {
          this.writeback.setCleanBaseline(currentContent)
          this.docSync.postBaseline(this.deltaWriter.acceptedSequence)
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
        this.docSync.postBaseline(this.deltaWriter.acceptedSequence)
        this.webviewPanel.webview.postMessage({
          command: 'announce',
          message: `Saved ${NodePath.basename(this.activeFsPath)}`,
        })
        scheduleDiffInfo(savedDocument.getText())
        this.docSync.schedulePostUpdate()
      }),
      // Task 580 CP2-12 — every save route (Save key, Command Palette, menu, auto-save, the
      // close-with-Save prompt) first flushes the webview's pending typing into the document, so the
      // save writes it. Registered BEFORE Task 434's listener below: VS Code runs will-save
      // listeners in registration order and hands each the current document, so the no-op check
      // sees the flushed text. Kept as a separate listener so that a slow flush is charged to this
      // listener alone and VS Code's timeout/error penalty can never disable Task 434's correction.
      // The promise carries no edits; the flushed edit is applied through the normal edit queue.
      vscode.workspace.onWillSaveTextDocument((event) => {
        if (event.document.uri.toString() !== this.activeUri.toString()) {
          return
        }
        event.waitUntil(this.flushWebviewForSave(event.document))
      }),
      // Task 434 — the isSemanticNoop whole-doc check is DEFERRED off the 250ms edit-sync tick
      // (see WritebackController.syncToEditor's own comment), so this is the correctness backstop
      // that guarantees a SAVE — via any trigger (Save key, command palette, File menu, auto-save,
      // the close-with-"Save"-prompt flow) — always reflects the final no-op decision, applied
      // atomically with the save via `waitUntil` (never a separate follow-up write).
      vscode.workspace.onWillSaveTextDocument((event) => {
        if (event.document.uri.toString() !== this.activeUri.toString()) {
          return
        }
        const edits = this.writeback.checkNoopOnWillSave(event.document)
        if (edits.length) {
          // Task 733 (E5): a host-originated write, not an external change.
          this.startEpoch('own')
          this.correctionRebind = true
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
        if (webviewPanel.active) {
          void vscode.commands.executeCommand(
            'setContext',
            'vmde.findWidgetVisible',
            this.findWidgetVisible,
          )
        }
      }),
      webviewPanel.webview.onDidReceiveMessage(
        async (message: WebviewMessage) => {
          const command = (message as { command?: unknown } | null)?.command
          const handler = webviewHandler(messageHandlers, command)
          // Task 733 / 036 (review point 6): an unknown command logs a fixed category, not its fields.
          debug(
            'msg from webview review',
            reviewEntry(message, handler !== undefined),
            webviewPanel.active,
          )
          if (!handler) {
            debug('unhandled webview message')
            return
          }
          // Task 733 / 036: `history-exact` is pre-checked before the shape check (enum, ID, sequence).
          if (command === 'history-exact') {
            await handler(message)
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
            debug(
              'webview message handler failed',
              message?.command,
              errorCategory(error),
            )
            showError(
              `VMDE: handling "${message?.command}" failed — ${
                error instanceof Error ? error.message : String(error)
              }`,
            )
          }
        },
      ),
      webviewPanel.onDidDispose(() => {
        if (webviewPanel.active) {
          void vscode.commands.executeCommand(
            'setContext',
            'vmde.findWidgetVisible',
            false,
          )
        }
        this.docSync.syncState.setPendingWebviewContent(undefined)
        for (const binding of this.blockActions.values())
          clearTimeout(binding.timeout)
        this.blockActions.clear()
        this.outlineMoves.clear()
        // A closed webview never answers; release any save still waiting for its flush.
        for (const flush of [...this.saveFlushes.values()]) flush.finish()
        // Task 733 / 036 (B0, 3.6): reservations give up; unresolved recovery entries are written.
        void this.disposeReplay()
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
