import { normalizeContent } from './sync-state'

export interface HistoryTransition {
  kind: 'undo' | 'redo'
  before: string
  after: string
}

interface HistoryCouplingDeps {
  currentContent: () => string
  equivalentToCurrent: (content: string) => boolean
  execute: (kind: 'undo' | 'redo') => Promise<void>
  setApplying: (value: boolean) => void
  markSynced: (content: string) => void
  postUpdate: () => Promise<void>
  debug: (message: string, details: Record<string, unknown>) => void
}

/** Keeps one Vditor history transition aligned with VS Code's native document history. */
export class HistoryCouplingController {
  private pending: { webviewContent: string; hostContent: string } | undefined

  constructor(private readonly deps: HistoryCouplingDeps) {}

  async handle(transition: HistoryTransition): Promise<boolean> {
    if (transition.kind !== 'undo' && transition.kind !== 'redo') {
      this.pending = undefined
      this.deps.debug('history coupling skipped: invalid native command', {
        kind: transition.kind,
      })
      return false
    }
    const current = normalizeContent(this.deps.currentContent())
    const startedByteAligned = current === normalizeContent(transition.before)
    const alreadyAtResult = current === normalizeContent(transition.after)
    // A source-only edit can change authored markers without changing Lute's canonical
    // rendering. If the host is exactly at the transition start, native history must
    // advance even when both sides are semantically equivalent.
    if (
      alreadyAtResult ||
      (!startedByteAligned && this.deps.equivalentToCurrent(transition.after))
    ) {
      this.accept(transition.after)
      return true
    }
    if (!this.deps.equivalentToCurrent(transition.before)) {
      this.pending = undefined
      this.deps.debug(
        'history coupling skipped: host does not match transition start',
        { kind: transition.kind },
      )
      return false
    }

    await this.executeWithoutEcho(transition.kind)
    if (
      startedByteAligned &&
      normalizeContent(this.deps.currentContent()) === current
    ) {
      this.deps.debug(
        'history coupling skipped: native command made no change',
        {
          kind: transition.kind,
        },
      )
      this.pending = undefined
      await this.deps.postUpdate()
      return false
    }
    if (startedByteAligned || this.deps.equivalentToCurrent(transition.after)) {
      this.accept(transition.after)
      return true
    }

    const inverse = transition.kind === 'undo' ? 'redo' : 'undo'
    this.deps.debug('history coupling rolled back: native result diverged', {
      kind: transition.kind,
      inverse,
    })
    await this.executeWithoutEcho(inverse)
    this.pending = undefined
    await this.deps.postUpdate()
    return false
  }

  /** Suppress the normal debounced edit that reports the already-applied Vditor transition. */
  async consumeEdit(content: string): Promise<boolean> {
    const expected = this.pending
    this.pending = undefined
    if (
      expected === undefined ||
      normalizeContent(content) !== normalizeContent(expected.webviewContent) ||
      normalizeContent(this.deps.currentContent()) !==
        normalizeContent(expected.hostContent)
    ) {
      return false
    }
    this.deps.markSynced(this.deps.currentContent())
    return true
  }

  private accept(webviewContent: string): void {
    const hostContent = this.deps.currentContent()
    this.pending = { webviewContent, hostContent }
    this.deps.markSynced(hostContent)
  }

  private async executeWithoutEcho(kind: 'undo' | 'redo'): Promise<void> {
    this.deps.setApplying(true)
    try {
      await this.deps.execute(kind)
    } finally {
      this.deps.setApplying(false)
    }
  }
}
