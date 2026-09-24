import type * as vscode from 'vscode'
import { escapeTableSpanPipes } from '../markdown/table-pipe-escape'
import { SyncState } from './sync-state'
import type { HostMessage, ThemeKind } from '../shared/protocol'

interface DocSyncDeps {
  getDocument: () => vscode.TextDocument
  postMessage: (msg: HostMessage) => void
  getIncrementalSeed?: (
    normalizedContent: string,
  ) => Extract<HostMessage, { command: 'update' }>['incrementalSeed']
}

interface PostUpdateProps {
  type?: 'init' | 'update'
  documentName?: string
  cdn?: string
  options?: any
  theme?: 'dark' | 'light'
  themeKind?: ThemeKind
  wiki?: any
  e2e?: boolean
  foldState?: Extract<HostMessage, { command: 'update' }>['foldState']
  readingPosition?: Extract<
    HostMessage,
    { command: 'update' }
  >['readingPosition']
  emojiRecents?: Extract<HostMessage, { command: 'update' }>['emojiRecents']
  incrementalSeed?: Extract<
    HostMessage,
    { command: 'update' }
  >['incrementalSeed']
  previewTaskCheckboxHistory?: Pick<
    NonNullable<
      Extract<HostMessage, { command: 'update' }>['previewTaskCheckboxHistory']
    >,
    'requestId' | 'before' | 'after'
  >
}

// Task 405 — the document→webview push (`postUpdate`/`schedulePostUpdate`) extracted out
// of EditorSession, now backed by SyncState instead of three loose private fields
// (lastSyncedContent + the debounce timer). One instance per open editor.
export class DocSyncController {
  readonly syncState: SyncState
  private textEditTimer: NodeJS.Timeout | undefined

  constructor(
    private readonly deps: DocSyncDeps,
    initialContent: string,
  ) {
    this.syncState = new SyncState(initialContent)
  }

  async postUpdate(
    props: PostUpdateProps = { options: undefined },
  ): Promise<void> {
    const content = this.deps.getDocument().getText()
    const force = props.type === 'init'
    if (!force && this.syncState.isAlreadySynced(content)) {
      return
    }
    this.syncState.markSynced(content)
    const normalizedContent = escapeTableSpanPipes(content)
    const incrementalSeed =
      props.incrementalSeed ?? this.deps.getIncrementalSeed?.(normalizedContent)
    const { previewTaskCheckboxHistory, ...rest } = props
    // An intervening document edit invalidates the checkbox transaction even when
    // a caller prepared a tag. Never attach provenance to different raw bytes.
    const ownedHistory =
      !force && previewTaskCheckboxHistory?.after === content
        ? previewTaskCheckboxHistory
        : undefined
    this.deps.postMessage({
      command: 'update',
      // Normalize table-cell math/code pipes (#1904) before Vditor parses it. Identity
      // for content without the bug; dedup above still tracks the raw text.
      content: normalizedContent,
      ...rest,
      incrementalSeed,
      ...(ownedHistory
        ? {
            previewTaskCheckboxHistory: {
              ...ownedHistory,
              renderedAfter: normalizedContent,
            },
          }
        : {}),
    })
  }

  schedulePostUpdate(): void {
    if (this.textEditTimer) {
      clearTimeout(this.textEditTimer)
    }
    this.textEditTimer = setTimeout(() => {
      void this.postUpdate()
    }, 75)
  }

  // A guarded host edit takes ownership of the next update; cancel any ordinary
  // 75ms post first so it cannot race the tagged transaction or clear native history.
  cancelScheduledUpdate(): void {
    if (this.textEditTimer) {
      clearTimeout(this.textEditTimer)
      this.textEditTimer = undefined
    }
  }

  // Cancel a pending scheduled post — called from the panel's onDidDispose teardown.
  disposeTimer(): void {
    this.cancelScheduledUpdate()
  }
}
