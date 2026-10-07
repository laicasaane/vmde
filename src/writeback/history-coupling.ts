import { normalizeContent } from './sync-state'

export interface HistoryTransition {
  kind: 'undo' | 'redo'
  before: string
  after: string
}

interface HistoryCouplingDeps {
  currentContent: () => string
  equivalentToCurrent: (content: string) => boolean
  equivalent: (source: string, content: string) => boolean
  execute: (kind: 'undo' | 'redo') => Promise<void>
  setApplying: (value: boolean) => void
  markSynced: (content: string) => void
  postUpdate: () => Promise<void>
  debug: (message: string, details: Record<string, unknown>) => void
}

// Task 602: the most native steps one webview transition may take. One Vditor entry can span
// many host writes (edit-sync publishes every 250 ms; 12 writes in one entry were measured), and
// each write is its own native stop. A bound of 8 refused measured sustained typing; the Owner set
// 64. Past it the transition is refused and rolled back.
export const MAX_NATIVE_STEPS = 64
// Published webview contents remembered with the host text VMDE wrote for them.
export const PUBLISHED_LIMIT = 64

type HostProof = 'exact' | 'published' | 'retained' | 'base' | 'semantic'
type TraversalStop = 'bound' | 'no-progress' | 'repeated' | 'command-failed'

/** Keeps one Vditor history transition aligned with VS Code's native document history.
 *
 * Task 602: one webview history step can span several host writes, so one native Undo can stop
 * short of the webview's result. The controller walks native history in the transition's
 * direction, one step at a time, until the host text provably corresponds to the webview's
 * result, and stops there. Accepting a result needs a proof against the host text at that moment:
 * an EOL-insensitive exact match, a published pair (VMDE wrote this host text for that webview
 * content), the retained Undo pair, a history base (the host text when the webview's history for a
 * mode began), or a semantic no-op. Without a proof it undoes its own verified steps and refuses;
 * the webview's next plain edit then rewrites the host (the resync fallback). */
export class HistoryCouplingController {
  private pending: { webviewContent: string; hostContent: string } | undefined
  // Normalized webview content -> the host texts VMDE wrote for it, least recently used first.
  private readonly published = new Map<string, string[]>()
  // Webview mode -> its history base: the webview text of the mode's first history entry and
  // the host text at that moment.
  private readonly bases = new Map<
    string,
    { webviewContent: string; hostContent: string }
  >()

  constructor(private readonly deps: HistoryCouplingDeps) {}

  /** Remember that VMDE wrote `hostContent` for the webview's published `webviewContent`. */
  recordPublished(webviewContent: string, hostContent: string): void {
    const key = normalizeContent(webviewContent)
    const hosts = this.published.get(key) ?? []
    if (!hosts.includes(hostContent)) hosts.push(hostContent)
    this.published.delete(key)
    this.published.set(key, hosts)
    for (const oldest of this.published.keys()) {
      if (this.published.size <= PUBLISHED_LIMIT) break
      this.published.delete(oldest)
    }
  }

  /** Record the base of a webview mode's history, or forget it when the host text could not be
   * tied to it (`hostContent` undefined: the host held a change the webview had not received). */
  recordBase(
    mode: string,
    webviewContent: string,
    hostContent: string | undefined,
  ): void {
    if (hostContent === undefined) this.bases.delete(mode)
    else this.bases.set(mode, { webviewContent, hostContent })
  }

  /** A change VMDE did not make: forget every published pair and history base. */
  forgetHostMappings(): void {
    this.published.clear()
    this.bases.clear()
  }

  async handle(transition: HistoryTransition): Promise<boolean> {
    if (transition.kind !== 'undo' && transition.kind !== 'redo') {
      this.pending = undefined
      this.deps.debug('history coupling skipped: invalid native command', {
        kind: transition.kind,
      })
      return false
    }
    const start = this.deps.currentContent()
    const startedByteAligned =
      normalizeContent(start) === normalizeContent(transition.before)
    // A source-only edit can change authored markers without changing Lute's canonical
    // rendering. If the host is exactly at the transition start, native history must
    // advance even when both sides are semantically equivalent.
    const alreadyAtResult = this.prove(transition.after, !startedByteAligned)
    if (alreadyAtResult) {
      this.accept(transition.after)
      return true
    }
    if (!this.prove(transition.before, true)) {
      this.pending = undefined
      this.deps.debug(
        'history coupling skipped: host does not match transition start',
        { kind: transition.kind },
      )
      return false
    }
    // When the start already renders like the result (a source-only change), a semantic match
    // cannot tell native states apart; only byte-level proofs may stop the walk. Decided on first
    // need, so a walk that ends on a byte-level proof never reserializes the document.
    let semantic: boolean | undefined
    const semanticAllowed = () =>
      (semantic ??=
        !startedByteAligned || !this.deps.equivalent(start, transition.after))
    return this.traverse(transition, start, semanticAllowed)
  }

  /** Suppress plain echoes while the host still owns the accepted history result. */
  async consumeEdit(content: string, plain: boolean): Promise<boolean> {
    const expected = this.pending
    if (
      !plain ||
      expected === undefined ||
      normalizeContent(content) !== normalizeContent(expected.webviewContent) ||
      normalizeContent(this.deps.currentContent()) !==
        normalizeContent(expected.hostContent)
    ) {
      this.pending = undefined
      return false
    }
    // A pre-history EditSync timer and Vditor's delayed after-render callback can both report
    // the same canonical result. Consuming only the first lets the second rewrite exact host
    // bytes and clear native Redo. Retain this proof until a different or explicit edit arrives;
    // handle() replaces or clears it at the next history transition.
    this.deps.markSynced(this.deps.currentContent())
    return true
  }

  // Walk native history one step at a time until the host provably reaches the result. Each
  // step's previous host text is kept, so a refusal can verify every inverse step.
  private async traverse(
    transition: HistoryTransition,
    start: string,
    semantic: () => boolean,
  ): Promise<boolean> {
    const visited = new Set([start])
    const previousTexts: string[] = []
    let stop: TraversalStop = 'bound'
    while (previousTexts.length < MAX_NATIVE_STEPS) {
      const previous = this.deps.currentContent()
      try {
        await this.executeWithoutEcho(transition.kind)
      } catch (error) {
        stop = 'command-failed'
        this.deps.debug('history coupling: native command failed', {
          kind: transition.kind,
          error: String(error),
        })
        break
      }
      const now = this.deps.currentContent()
      if (now === previous) {
        stop = 'no-progress'
        break
      }
      previousTexts.push(previous)
      const proof = this.prove(transition.after, semantic)
      if (proof) {
        this.accept(transition.after)
        this.deps.debug('history coupling reached the transition result', {
          kind: transition.kind,
          steps: previousTexts.length,
          proof,
        })
        return true
      }
      if (visited.has(now)) {
        stop = 'repeated'
        break
      }
      visited.add(now)
    }
    const rollback = await this.rollBack(transition.kind, previousTexts)
    this.deps.debug(
      'history coupling rolled back: transition result not reached',
      {
        kind: transition.kind,
        steps: previousTexts.length,
        stop,
        rollback,
      },
    )
    this.pending = undefined
    await this.deps.postUpdate()
    return false
  }

  // Undo this attempt's own native steps, newest first, checking each restored text. A failed or
  // diverging inverse stops further mutation: the document is left as it is, never overwritten.
  private async rollBack(
    kind: 'undo' | 'redo',
    previousTexts: string[],
  ): Promise<'restored' | 'command-failed' | 'diverged'> {
    const inverse = kind === 'undo' ? 'redo' : 'undo'
    for (let index = previousTexts.length - 1; index >= 0; index--) {
      try {
        await this.executeWithoutEcho(inverse)
      } catch {
        return 'command-failed'
      }
      if (this.deps.currentContent() !== previousTexts[index]) return 'diverged'
    }
    return 'restored'
  }

  // Which proof, if any, shows that the current host text corresponds to the webview `content`.
  private prove(
    content: string,
    semantic: boolean | (() => boolean),
  ): HostProof | undefined {
    const host = this.deps.currentContent()
    const key = normalizeContent(content)
    if (normalizeContent(host) === key) return 'exact'
    if (this.published.get(key)?.includes(host)) return 'published'
    if (
      this.pending &&
      normalizeContent(this.pending.webviewContent) === key &&
      this.pending.hostContent === host
    )
      return 'retained'
    for (const base of this.bases.values())
      if (
        normalizeContent(base.webviewContent) === key &&
        base.hostContent === host
      )
        return 'base'
    const allowed = typeof semantic === 'function' ? semantic() : semantic
    if (allowed && this.deps.equivalentToCurrent(content)) return 'semantic'
    return undefined
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
