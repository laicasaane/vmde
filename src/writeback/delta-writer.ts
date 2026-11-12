import * as vscode from 'vscode'
import {
  type DeltaRefusal,
  type ValidDeltaChange,
  validateDelta,
} from './delta-validate'
import { normalizeContent, type SyncState } from './sync-state'

// Task 733 — applies one `edit-delta` as one ranged WorkspaceEdit. The webview sends ranges against
// the pre-edit text; the host validates, checks the epoch and sequence, compares `oldText` with the
// document, registers the predicted text as pending content (so the change event of this write is
// recognised as an echo, not an external change) and writes through the apply chain.
//
// It is not connected to the session here: the caller turns a `resync` into `startEpoch()` plus one
// `update`, and decides about the stale-edit warning.

export type DeltaOutcome =
  | { kind: 'applied' }
  | { kind: 'dropped'; why: 'epoch' | 'refusal-limit' }
  | {
      kind: 'resync'
      why: DeltaRefusal | 'sequence' | 'old-text' | 'apply-failed'
    }

interface DeltaWriterDocument {
  readonly lineCount: number
  readonly eol: vscode.EndOfLine
  offsetAt(position: vscode.Position): number
  lineAt(line: number): { text: string }
  getText(range?: vscode.Range): string
}

export interface DeltaWriterDeps {
  document: DeltaWriterDocument
  syncState: Pick<
    SyncState,
    | 'setApplyingWebviewEdit'
    | 'setPendingWebviewContent'
    | 'getEpoch'
    | 'startEpoch'
  >
  /** Runs `fn` as one turn of the host's apply chain. */
  runOnApplyChain<T>(fn: () => Promise<T>): Promise<T>
  applyEdit(edit: vscode.WorkspaceEdit): Thenable<boolean>
  /** The URI to write to; follows a file rename. Defaults to the document's own URI. */
  getUri?(): vscode.Uri
  now(): number
  /** Details carry counts and lengths only, never a text (SR-5). */
  log(message: string, details: Record<string, unknown>): void
}

export interface DeltaMessage {
  epoch: unknown
  sequence: unknown
  changes: unknown[]
  /** Set by a history delta only. */
  kind?: unknown
  steps?: unknown
}

/** What `applyHistory` needs of `HistoryCouplingController`. */
export interface HistoryWalker {
  walkToPredicted(
    kind: 'undo' | 'redo',
    steps: number,
    predicted: string,
  ): Promise<'proven' | 'declined' | 'diverged'>
}

const REFUSAL_LIMIT = 5
const REFUSAL_WINDOW_MS = 10_000

const safeInt = (value: unknown): number | null =>
  Number.isSafeInteger(value) ? (value as number) : null

// The text with the ascending, non-overlapping changes spliced in. Positions are line/character, so
// they do not depend on the line endings; `text` is the document text with `\n` line breaks.
function spliceAscending(text: string, changes: ValidDeltaChange[]): string {
  const parts: string[] = []
  let cursor = 0
  let line = 0
  let lineStart = 0
  const offsetOf = (p: { line: number; character: number }): number => {
    while (line < p.line) {
      lineStart = text.indexOf('\n', lineStart) + 1
      line += 1
    }
    return lineStart + p.character
  }
  for (const c of changes) {
    const start = offsetOf(c.start)
    const end = offsetOf(c.end)
    parts.push(text.slice(cursor, start), c.text)
    cursor = end
  }
  parts.push(text.slice(cursor))
  return parts.join('')
}

export class DeltaWriter {
  private accepted = 0
  // Timestamps of counted refusals (`resync` outcomes). They survive `startEpoch()` (Q-11): a
  // misbehaving webview must not escape the limit by being resynchronized.
  private refusals: number[] = []
  private latchedUntil: number | undefined

  constructor(private readonly deps: DeltaWriterDeps) {}

  get epoch(): number {
    return this.deps.syncState.getEpoch()
  }

  get acceptedSequence(): number {
    return this.accepted
  }

  /** Starts a new epoch: no delta of the old one applies any more. */
  startEpoch(): number {
    const epoch = this.deps.syncState.startEpoch()
    this.accepted = 0
    return epoch
  }

  async apply(message: DeltaMessage): Promise<DeltaOutcome> {
    return this.run(message, undefined)
  }

  /** Task 733 (task 004): one Undo or Redo as a history delta (shared rules 3.6). The native history
   * is walked to the predicted text first; when that cannot be proven the changes are written
   * forward. Shares the epoch, the accepted sequence and the refusal window with `apply`. */
  async applyHistory(
    message: DeltaMessage,
    walker: HistoryWalker,
  ): Promise<DeltaOutcome> {
    return this.run(message, walker)
  }

  private async run(
    message: DeltaMessage,
    walker: HistoryWalker | undefined,
  ): Promise<DeltaOutcome> {
    let lengths: { oldLength: number; textLength: number } | undefined
    const outcome = await this.decide(
      message,
      (l) => {
        lengths = l
      },
      walker,
    )
    if (outcome.kind === 'resync') this.countRefusal()
    this.logOutcome(message, outcome, lengths, walker !== undefined)
    return outcome
  }

  private async decide(
    message: DeltaMessage,
    noteLengths: (l: { oldLength: number; textLength: number }) => void,
    walker: HistoryWalker | undefined,
  ): Promise<DeltaOutcome> {
    const { document, syncState } = this.deps
    if (this.isLatched()) return { kind: 'dropped', why: 'refusal-limit' }
    if (message.epoch !== syncState.getEpoch()) {
      return { kind: 'dropped', why: 'epoch' }
    }
    const checked = validateDelta(
      message,
      {
        lineCount: document.lineCount,
        lineText: (line) => document.lineAt(line).text,
      },
      walker !== undefined,
    )
    if (!checked.ok) return { kind: 'resync', why: checked.refusal }
    const { changes } = checked
    noteLengths({
      oldLength: changes.reduce((n, c) => n + c.oldText.length, 0),
      textLength: changes.reduce((n, c) => n + c.text.length, 0),
    })
    if (message.sequence !== this.accepted + 1) {
      return { kind: 'resync', why: 'sequence' }
    }
    if (!this.oldTextMatches(changes))
      return { kind: 'resync', why: 'old-text' }
    if (walker === undefined) {
      return this.deps.runOnApplyChain(() => this.write(changes, message))
    }
    return this.walkThenWrite(changes, message, walker)
  }

  // Steps 4 to 7 of shared rules 3.6. The walk is native history, not a write of ours.
  private async walkThenWrite(
    changes: ValidDeltaChange[],
    message: DeltaMessage,
    walker: HistoryWalker,
  ): Promise<DeltaOutcome> {
    const { document, syncState } = this.deps
    const predicted = spliceAscending(
      normalizeContent(document.getText()),
      changes,
    )
    const walk = await walker.walkToPredicted(
      message.kind as 'undo' | 'redo',
      message.steps as number,
      predicted,
    )
    // Provisional (Q-45): `DeltaOutcome` has no `diverged` reason, so a diverged walk is reported as
    // `apply-failed`. Either way the webview is resynchronized from the host text.
    if (walk === 'diverged') return { kind: 'resync', why: 'apply-failed' }
    // After the walk, re-read the state it ran against.
    if (message.epoch !== syncState.getEpoch()) {
      return { kind: 'dropped', why: 'epoch' }
    }
    if (walk === 'proven') {
      this.accepted = message.sequence as number
      return { kind: 'applied' }
    }
    return this.deps.runOnApplyChain(() => this.write(changes, message))
  }

  // The normalized range text must equal `oldText`. Its length is known from offsets alone, so a
  // range that cannot match is refused without reading its text (SR-6).
  private oldTextMatches(changes: ValidDeltaChange[]): boolean {
    const { document } = this.deps
    const crlf = document.eol === vscode.EndOfLine.CRLF
    for (const c of changes) {
      const start = new vscode.Position(c.start.line, c.start.character)
      const end = new vscode.Position(c.end.line, c.end.character)
      const lineBreaks = c.end.line - c.start.line
      const length =
        document.offsetAt(end) -
        document.offsetAt(start) -
        (crlf ? lineBreaks : 0)
      if (length !== c.oldText.length) return false
      if (
        normalizeContent(document.getText(new vscode.Range(start, end))) !==
        c.oldText
      ) {
        return false
      }
    }
    return true
  }

  private async write(
    changes: ValidDeltaChange[],
    message: DeltaMessage,
  ): Promise<DeltaOutcome> {
    const { document, syncState } = this.deps
    // Earlier turns of the chain may have moved the epoch or the text since the checks above.
    if (message.epoch !== syncState.getEpoch()) {
      return { kind: 'dropped', why: 'epoch' }
    }
    if (!this.oldTextMatches(changes))
      return { kind: 'resync', why: 'old-text' }
    const sequence = message.sequence as number
    const predicted = spliceAscending(
      normalizeContent(document.getText()),
      changes,
    )
    const epoch = syncState.getEpoch()
    syncState.setApplyingWebviewEdit(true)
    syncState.setPendingWebviewContent(predicted)
    try {
      const edit = new vscode.WorkspaceEdit()
      const uri =
        this.deps.getUri?.() ?? (document as unknown as vscode.TextDocument).uri
      for (const c of changes) {
        edit.replace(
          uri,
          new vscode.Range(
            c.start.line,
            c.start.character,
            c.end.line,
            c.end.character,
          ),
          c.text,
        )
      }
      // A rejected write is a refused write.
      const written = await Promise.resolve(this.deps.applyEdit(edit)).then(
        (ok) => ok,
        () => false,
      )
      if (!written) {
        syncState.setPendingWebviewContent(undefined)
        return { kind: 'resync', why: 'apply-failed' }
      }
      // A foreign change during the write moved the epoch: keep the sequence, the caller resyncs.
      if (syncState.getEpoch() === epoch) this.accepted = sequence
      return { kind: 'applied' }
    } finally {
      syncState.setApplyingWebviewEdit(false)
    }
  }

  // Q-11: the 5th counted refusal within 10 s latches the writer for 10 s; every delta is then
  // `dropped` `refusal-limit`. When the latch ends the count starts again.
  private isLatched(): boolean {
    if (this.latchedUntil === undefined) return false
    if (this.deps.now() < this.latchedUntil) return true
    this.latchedUntil = undefined
    this.refusals = []
    return false
  }

  private countRefusal(): void {
    const now = this.deps.now()
    this.refusals = this.refusals.filter((t) => now - t < REFUSAL_WINDOW_MS)
    this.refusals.push(now)
    if (this.refusals.length >= REFUSAL_LIMIT) {
      this.latchedUntil = now + REFUSAL_WINDOW_MS
    }
  }

  private logOutcome(
    message: DeltaMessage,
    outcome: DeltaOutcome,
    lengths: { oldLength: number; textLength: number } | undefined,
    history: boolean,
  ): void {
    this.deps.log(history ? 'history-delta' : 'edit-delta', {
      ...(history
        ? {
            kind:
              message.kind === 'redo'
                ? 'redo'
                : message.kind === 'undo'
                  ? 'undo'
                  : null,
            steps: safeInt(message.steps),
          }
        : {}),
      outcome: outcome.kind,
      ...(outcome.kind === 'applied' ? {} : { why: outcome.why }),
      hostEpoch: this.deps.syncState.getEpoch(),
      epoch: safeInt(message.epoch),
      sequence: safeInt(message.sequence),
      acceptedSequence: this.accepted,
      ...(Array.isArray(message.changes)
        ? { changeCount: message.changes.length }
        : {}),
      ...(lengths ?? {}),
    })
  }
}
