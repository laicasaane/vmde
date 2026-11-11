// Shared `\r\n`→`\n` normalization for content comparisons across the host↔webview sync
// boundary. Previously defined twice — once here as extension.ts's `normalizeContent`,
// once (identically) as writeback-controller.ts's local `normalize` — single-sourced now
// (task 405).
export function normalizeContent(content: string): string {
  return content.replace(/\r\n/g, '\n')
}

// Encapsulates the three echo-suppression fields that used to be private EditorSession
// fields written from five different call sites (start(), postUpdate(), inlineInitPayload(),
// the onDidChangeTextDocument listener's echo branch, and WritebackController via three
// injected setters) with the SAME normalizeContent(...) compare duplicated inline at each
// of postUpdate() / the change listener / WritebackController's own copy (task 405).
//
// `isEcho` is a PURE predicate: it does not clear `pendingWebviewContent` or advance
// `lastSyncedContent`. The original inline change-listener logic did both as part of the
// same `if` that matched — callers must still do those two writes themselves at the call
// site (mirrors the original byte-for-byte); the point of extracting is a single named
// predicate, not moving the side effects out of the caller's control.
export class SyncState {
  private lastSyncedContent: string
  private pendingWebviewContent: string | undefined
  private applyingWebviewEdit = false
  private applyingHistory = false
  // Task 646: counts changes to the document that VMDE did not make. Each `update` carries it and
  // the webview echoes it on plain edits, so an edit serialized before the webview applied the
  // latest outside change can be told apart from one made on current text.
  private externalRevision = 0
  private postedRevision = 0
  // Task 733: the delta epoch. Each `update` carries it; the webview sends deltas only for the epoch
  // it last applied. `postedEpoch` is the epoch the webview was last told (-1: none yet).
  private epoch = 0
  private postedEpoch = -1

  constructor(initialContent: string) {
    this.lastSyncedContent = initialContent
  }

  getLastSynced(): string {
    return this.lastSyncedContent
  }

  markSynced(content: string): void {
    this.lastSyncedContent = content
  }

  // postUpdate()'s dedup check: true when `content` is already what the webview was last
  // told (so posting an `update` again would be a no-op round-trip).
  isAlreadySynced(content: string): boolean {
    return (
      normalizeContent(content) === normalizeContent(this.lastSyncedContent)
    )
  }

  // Task 646: native Undo/Redo run for the webview's history is VMDE's own change, not an outside
  // one; its document events must neither count as external nor reach the webview.
  setApplyingHistory(value: boolean): void {
    this.applyingHistory = value
  }

  isApplyingHistory(): boolean {
    return this.applyingHistory
  }

  noteExternalChange(): number {
    this.externalRevision += 1
    return this.externalRevision
  }

  getExternalRevision(): number {
    return this.externalRevision
  }

  markPostedRevision(revision: number): void {
    this.postedRevision = revision
  }

  // True when the webview was already told this revision (a repost of the same text is then a
  // no-op round trip).
  hasPostedRevision(): boolean {
    return this.postedRevision === this.externalRevision
  }

  // Task 733: starts a new delta epoch and returns it.
  startEpoch(): number {
    this.epoch += 1
    return this.epoch
  }

  getEpoch(): number {
    return this.epoch
  }

  markPostedEpoch(epoch: number): void {
    this.postedEpoch = epoch
  }

  // True when the webview was already told the current epoch.
  hasPostedEpoch(): boolean {
    return this.postedEpoch === this.epoch
  }

  setApplyingWebviewEdit(value: boolean): void {
    this.applyingWebviewEdit = value
  }

  isApplyingEdit(): boolean {
    return this.applyingWebviewEdit
  }

  setPendingWebviewContent(value: string | undefined): void {
    this.pendingWebviewContent = value
  }

  getPendingWebviewContent(): string | undefined {
    return this.pendingWebviewContent
  }

  // The change-listener's echo check: true when `currentContent` is the edit we just wrote
  // ourselves via WritebackController (VS Code echoing our own applyEdit back through the
  // document-change event).
  isEcho(currentContent: string): boolean {
    return (
      this.pendingWebviewContent !== undefined &&
      normalizeContent(currentContent) ===
        normalizeContent(this.pendingWebviewContent)
    )
  }
}
