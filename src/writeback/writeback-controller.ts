import * as vscode from 'vscode'
import { reserializeMarkdown } from '../lute/lute-host'
import type { MarkdownExtensionOptions } from '../shared/protocol'
import {
  applyExplicitBlock,
  isSemanticNoop,
  minimalDiffWriteback,
  splitBlocks,
} from '../markdown/minimal-diff-writeback'

const normalize = (content: string) => content.replace(/\r\n/g, '\n')

// The EditorSession state the write-back needs to read/mutate. Injected so the controller
// owns the task-61 baseline concern without reaching back into EditorSession: the three
// echo-suppression flags stay EditorSession fields (its change listener + postUpdate read
// them directly) and are written here through the setters. getDocument/getActiveUri are
// getters because activeUri follows a rename.
interface WritebackDeps {
  extensionPath: string
  getMarkdownExtensions: () => MarkdownExtensionOptions
  getDocument: () => vscode.TextDocument
  getActiveUri: () => vscode.Uri
  setApplyingWebviewEdit: (value: boolean) => void
  setPendingWebviewContent: (value: string | undefined) => void
  setLastSyncedContent: (value: string) => void
  showError: (message: string) => void
  debug: (...args: unknown[]) => void
  recordPerf?: (
    id: string | undefined,
    values: Record<string, number | string | boolean>,
  ) => void
  setActivePerf?: (id: string | undefined) => void
}

// Task 61 v2 minimal-diff write-back, extracted from EditorSession. Owns the CLEAN
// baseline + the per-block reserialize cache; EditorSession delegates syncToEditor +
// setCleanBaseline to it.
export class WritebackController {
  // Task 61 — minimal-diff write-back. Keep the ORIGINAL source bytes for every block
  // the user didn't actually change; only changed blocks take Vditor's reserialized
  // form. Best-effort + gated by size (large docs reflow negligibly — see task 49/61
  // benches — and aren't worth the per-block reserialize cost) and falls back to the
  // editor's full output on any issue. `reserializeMarkdown` is memoized per source
  // block (block bytes are stable across edits), so only the first edit pays the cost.
  private static MINDIFF_CAP = 100_000

  // Task 434 — how long to wait, after the LAST edit-sync tick, before running the expensive
  // whole-doc isSemanticNoop check (see armDeferredNoopCheck's own comment for why this exists).
  // Measured (task 412/434 pickup, 2026-07-30): warm reserializeMarkdown costs ~74ms@10KB /
  // ~222ms@32KB / ~1036ms@100KB in a quiet vitest/jsdom+extension-host Lute context, and up to
  // ~2s@100KB reported under real concurrent CI load — either way, real cost, worth not paying on
  // every debounced tick (edit-sync.ts's 250ms trailing debounce already means "once per pause",
  // not the "~4x/s while typing" this task was originally filed under). 1200ms leaves comfortable
  // margin under undo-dirty-probe.spec.ts's existing 2000ms post-undo settle wait (it does not need
  // to change) while still meaningfully coalescing a bursty typing session's short pauses.
  private static NOOP_CHECK_IDLE_MS = 1200

  // Task 61 v2 — the CLEAN baseline: the document bytes the last time it matched disk
  // (set on open + after save). The minimal-diff write-back minimizes against THIS, not
  // the current (possibly already-reflowed) document, so undoing back to the original
  // returns the file to disk exactly and the tab goes clean. `cleanBaselineCanonical`
  // memoizes its whole-doc reserialization (baseline is stable between saves).
  //
  // Task 434 (confirmed defect #3) — `undefined`, NOT `''`, is "never set yet". A brand-new,
  // empty-at-open, never-saved document legitimately has an EMPTY STRING baseline (`setCleanBaseline`
  // is called with `document.getText()` at open — see editor-session.ts — which for a blank file
  // IS `''`). Using `''` as BOTH the sentinel and a legitimate value meant every `this.cleanBaseline
  // || document.getText()` / `if (!baseline)` read below silently treated a real empty baseline as
  // "not set" and fell back to the CURRENT (post-edit, constantly moving) document text instead —
  // degrading the whole clean-baseline mechanism to a no-op for exactly the class of file where the
  // "undo back to disk" guarantee (task 61 v2) matters at the very START of a document's life.
  private cleanBaseline: string | undefined = undefined
  private cleanBaselineCanonical: string | undefined
  // An explicit source transaction deliberately changes authored bytes even when Lute renders it
  // equivalently (for example, table padding). Save-time semantic-noop repair must not undo it.
  private exactTransactionContent: string | undefined
  private reserializeCache = new Map<string, string>()
  private markdownExtensionSignature: string | undefined
  // Task 434 — the deferred whole-doc no-op check armed by syncToEditor's own tick; see
  // armDeferredNoopCheck/resolveNoopCheck.
  private noopCheckTimer: ReturnType<typeof setTimeout> | undefined
  private baselinePrewarmTimer: ReturnType<typeof setTimeout> | undefined
  private baselinePrewarmGeneration = 0
  private baselinePrewarmBlocks = 0
  private baselinePrewarmMs = 0

  // Task 477 — applyToDocument is shared by two independent writers: the debounced tick
  // (syncToEditor) and the deferred no-op correction (resolveNoopCheck, armed
  // NOOP_CHECK_IDLE_MS after the last tick). Nothing used to stop a tick from firing its own
  // `vscode.workspace.applyEdit` while the deferred correction's own applyEdit was still in
  // flight — two of OUR OWN writes racing the same document, and whichever VS Code resolved
  // second saw a stale version and got `applied: false`, surfacing a scary "document changed
  // underneath" error for a collision we caused, not an external edit. `applyChain` makes the
  // actual write (applyOnce) queue behind whatever this controller already has in flight, so
  // two of our own applyEdit calls are never simultaneously outstanding — see applyToDocument.
  private applyChain: Promise<void> = Promise.resolve()

  // Task 477 (instrumentation) — a DEPTH counter, not a boolean: two independent windows
  // can legitimately overlap (applyOnce's own applyEdit and checkNoopOnWillSave's
  // save-time correction, which applies via `event.waitUntil`, NOT
  // `vscode.workspace.applyEdit`, so it never enters applyChain — see hypothesis 2 in the
  // task file), and a boolean toggled by both would let one window's completion clobber
  // the other's still-open state. Incremented when a window opens, decremented when it
  // closes; applyOnce's failure-path debug() call reads `> 0` (captured BEFORE its own
  // increment) as `anotherApplyInFlight` — see that comment for what a `true` there
  // would mean.
  private applyEditInFlightDepth = 0

  constructor(private readonly deps: WritebackDeps) {}

  /** Narrow exact transaction entrypoint. Unlike routine writeback it refuses a stale model
   * instead of minimizing/rebasing, so structural moves cannot overwrite intervening typing. */
  async applyExactGuarded(
    content: string,
    expectedVersion: number,
    expectedBefore: string,
  ): Promise<'applied' | 'stale' | 'noop' | 'error'> {
    const turn = this.applyChain.then(async () => {
      const document = this.deps.getDocument()
      if (
        document.version !== expectedVersion ||
        document.getText() !== expectedBefore
      )
        return 'stale' as const
      if (content === expectedBefore) return 'noop' as const
      const edit = new vscode.WorkspaceEdit()
      edit.replace(
        this.deps.getActiveUri(),
        this.documentRange(document),
        content,
      )
      this.deps.setApplyingWebviewEdit(true)
      this.deps.setPendingWebviewContent(content)
      try {
        return (await vscode.workspace.applyEdit(edit))
          ? ('applied' as const)
          : ('stale' as const)
      } catch (error) {
        this.deps.debug('outline exact apply failed', error)
        return 'error' as const
      } finally {
        this.deps.setApplyingWebviewEdit(false)
        this.deps.setPendingWebviewContent(undefined)
      }
    })
    this.applyChain = turn.then(
      () => undefined,
      () => undefined,
    )
    return turn
  }

  private documentRange(document: vscode.TextDocument) {
    const lastLine = document.lineAt(Math.max(document.lineCount - 1, 0))
    return new vscode.Range(
      0,
      0,
      lastLine.range.end.line,
      lastLine.range.end.character,
    )
  }

  // Record a clean baseline (document == disk) and drop the memoized canonical form so
  // it's recomputed lazily on the next write against the new baseline. A pending deferred
  // no-op check (task 434) was comparing against the OLD baseline — that comparison is now
  // moot (a fresh baseline already means "clean"), so drop it too.
  setCleanBaseline(text: string) {
    this.cleanBaseline = text
    this.cleanBaselineCanonical = undefined
    this.exactTransactionContent = undefined
    this.cancelDeferredNoopCheck()
    this.scheduleBaselinePrewarm(text)
  }

  private cancelBaselinePrewarm(): void {
    this.baselinePrewarmGeneration++
    if (this.baselinePrewarmTimer !== undefined) {
      clearTimeout(this.baselinePrewarmTimer)
      this.baselinePrewarmTimer = undefined
    }
  }

  // Task 538: the first edit on a structured sub-100 KB document used to synchronously
  // canonicalize hundreds of clean source blocks. Warm that immutable baseline in short host
  // turns after open/save; an early edit safely consumes the partial cache and fills any misses.
  private scheduleBaselinePrewarm(text: string): void {
    this.cancelBaselinePrewarm()
    this.baselinePrewarmBlocks = 0
    this.baselinePrewarmMs = 0
    if (text.length < 20_000 || text.length > WritebackController.MINDIFF_CAP)
      return
    const blocks = splitBlocks(text)
    if (blocks.length < 350) return
    const extensions = this.markdownExtensions()
    const generation = this.baselinePrewarmGeneration
    let index = 0
    const step = () => {
      this.baselinePrewarmTimer = undefined
      if (generation !== this.baselinePrewarmGeneration) return
      const turnStarted = performance.now()
      do {
        const block = blocks[index++]
        if (!this.reserializeCache.has(block)) {
          const luteStarted = performance.now()
          const canonical = reserializeMarkdown(
            this.deps.extensionPath,
            block,
            extensions,
          )
          this.baselinePrewarmMs += performance.now() - luteStarted
          if (canonical === undefined) {
            this.cancelBaselinePrewarm()
            return
          }
          this.reserializeCache.set(block, canonical)
        }
        this.baselinePrewarmBlocks++
      } while (index < blocks.length && performance.now() - turnStarted < 8)
      if (index < blocks.length) this.baselinePrewarmTimer = setTimeout(step, 0)
    }
    this.baselinePrewarmTimer = setTimeout(step, 0)
  }

  // Whole-document IR reserialize (== the webview's getValue for IR mode), gated by
  // size. Returns undefined when Lute isn't warm or the doc is too large — callers
  // treat undefined as "can't decide" and fall back safely.
  private reserializeWhole(
    md: string,
    extensions = this.markdownExtensions(),
  ): string | undefined {
    if (md.length > WritebackController.MINDIFF_CAP) return undefined
    return reserializeMarkdown(this.deps.extensionPath, md, extensions)
  }

  /** Compare live Vditor Markdown with the current source model without changing either side. */
  isSemanticallyEquivalentToDocument(content: string): boolean {
    const current = this.deps.getDocument().getText()
    if (normalize(current) === normalize(content)) return true
    const extensions = this.markdownExtensions()
    return isSemanticNoop(current, content, (markdown) =>
      this.reserializeWhole(markdown, extensions),
    )
  }

  private markdownExtensions(): MarkdownExtensionOptions {
    const options = this.deps.getMarkdownExtensions()
    const signature = `${Number(options.toc)}${Number(options.mark)}${Number(options.supSub)}`
    if (
      this.markdownExtensionSignature !== undefined &&
      signature !== this.markdownExtensionSignature
    ) {
      this.reserializeCache.clear()
      this.cleanBaselineCanonical = undefined
      this.cancelBaselinePrewarm()
    }
    this.markdownExtensionSignature = signature
    return options
  }

  private minimizeWriteback(
    original: string,
    next: string,
    perfId?: string,
  ): string {
    if (original.length > WritebackController.MINDIFF_CAP) return next
    let cacheHits = 0
    let cacheMisses = 0
    let luteMs = 0
    try {
      // Observe the live signature BEFORE consulting the block cache. Otherwise a changed parser
      // setting can hit a stale entry and never call markdownExtensions(), so the cache would not
      // learn that it needs invalidating.
      const extensions = this.markdownExtensions()
      return minimalDiffWriteback(original, next, (block) => {
        const hit = this.reserializeCache.get(block)
        if (hit !== undefined) {
          cacheHits++
          return hit
        }
        cacheMisses++
        const luteStarted = performance.now()
        const r = reserializeMarkdown(
          this.deps.extensionPath,
          block,
          extensions,
        )
        luteMs += performance.now() - luteStarted
        if (r !== undefined) this.reserializeCache.set(block, r) // don't cache cold-Lute misses
        return r
      })
    } catch {
      return next
    } finally {
      this.deps.recordPerf?.(perfId, { cacheHits, cacheMisses, luteMs })
    }
  }

  async syncToEditor(
    content: string,
    explicitBlock?: string,
    exact = false,
    perfId?: string,
  ) {
    if (!exact) this.exactTransactionContent = undefined
    const syncStarted = performance.now()
    this.deps.recordPerf?.(perfId, {
      prewarmBlocks: this.baselinePrewarmBlocks,
      prewarmMs: this.baselinePrewarmMs,
      prewarmPending: this.baselinePrewarmTimer !== undefined,
    })
    const document = this.deps.getDocument()
    const getTextStarted = performance.now()
    const currentText = document.getText()
    this.deps.recordPerf?.(perfId, {
      initialGetTextMs: performance.now() - getTextStarted,
    })
    const equalityStarted = performance.now()
    if (normalize(content) === normalize(currentText)) {
      this.deps.setLastSyncedContent(currentText)
      this.deps.recordPerf?.(perfId, {
        equalityMs: performance.now() - equalityStarted,
        noWrite: true,
        syncTotalMs: performance.now() - syncStarted,
      })
      return
    }
    this.deps.recordPerf?.(perfId, {
      equalityMs: performance.now() - equalityStarted,
    })
    // Minimize against the CLEAN baseline (disk bytes at open / last save), not the
    // current — possibly already-reflowed — document. That's what lets an undo-to-start
    // return the file to disk exactly so the tab goes clean (task 61 v2).
    //
    // `??`, not `||` (task 434 defect #3): a brand-new, never-saved document's baseline is
    // legitimately `''`, which `||` would treat as unset and silently replace with the
    // (moving) current document text — see cleanBaseline's own field comment.
    const baseline = this.cleanBaseline ?? currentText
    // Task 434 — the whole-doc isSemanticNoop check used to run HERE, synchronously, on every
    // debounced tick (measured cost: real, see NOOP_CHECK_IDLE_MS's comment). It no longer does:
    // minimizeWriteback below still runs on EVERY tick exactly as before — typed content reaches
    // disk with NO added latency — but the (expensive, and on any given tick almost always
    // negative) no-op check is instead armed as a DEFERRED, separate idle timer. If the document
    // settles (no further tick for NOOP_CHECK_IDLE_MS) and turns out to have been a no-op all
    // along, resolveNoopCheck retroactively restores the baseline bytes. Sound, not a skip: this
    // changes WHEN the check runs, never WHETHER a genuine no-op is eventually caught — and
    // checkNoopOnWillSave (called from EditorSession's onWillSaveTextDocument) is the correctness
    // backstop that guarantees every SAVE (any trigger) reflects the final decision even if this
    // timer hasn't fired yet, applied atomically with the save itself.
    const minimizeStarted = performance.now()
    const minimized = exact
      ? content
      : this.minimizeWriteback(baseline, content, perfId)
    this.deps.recordPerf?.(perfId, {
      minimizeMs: performance.now() - minimizeStarted,
      exact,
    })
    // Task 390: an EXPLICIT markup action (the link button making `[url](url)` out of a selected
    // URL) can be semantically identical to what is on disk — GFM autolinks the bare URL — so
    // layer 1 and the block matcher would both, correctly, keep the original bytes and the button
    // would appear to do nothing. The webview names the one block it changed; force just that
    // block's bytes and leave the rest of the minimization exactly as it is.
    const explicitStarted = performance.now()
    const toWrite =
      !exact && explicitBlock
        ? applyExplicitBlock(minimized, explicitBlock, (block) =>
            this.reserializeWhole(block),
          )
        : minimized
    this.deps.recordPerf?.(perfId, {
      explicitBlockMs: performance.now() - explicitStarted,
    })
    // Task 434 defect #2 — arm AFTER the write lands, not before. armDeferredNoopCheck's
    // timer reads the document FRESH when it fires (resolveNoopCheck), so if it were armed
    // before this await and applyToDocument took longer than NOOP_CHECK_IDLE_MS (slow
    // applyEdit, VS Code busy), the timer would fire against the STILL-PRE-write document,
    // find it "not a no-op yet" (because this tick's edit hasn't landed), and bail — and
    // because nothing re-arms it once the real write does land, the eventual no-op would
    // never be caught by the deferred path (checkNoopOnWillSave remains the correctness
    // backstop regardless, but the fast path silently degrading isn't the intent). Arming
    // after the await means the timer's baseline is only ever raced against a document that
    // has already incorporated this tick's write.
    await this.applyToDocument(
      toWrite,
      document,
      'syncToEditor',
      'VMDE: could not write your edit (the document changed underneath). Your change is still in the editor — save again.',
      perfId,
    )
    this.deps.recordPerf?.(perfId, {
      syncTotalMs: performance.now() - syncStarted,
    })
    if (exact && document.getText() === content) {
      this.exactTransactionContent = content
      this.cancelDeferredNoopCheck()
    } else {
      this.armDeferredNoopCheck(baseline)
    }
  }

  // Shared apply-edit plumbing for both the routine write (syncToEditor) and the deferred
  // no-op correction (resolveNoopCheck) — identical echo-suppression/failure-recovery discipline
  // either way (task 151 item 2: a failed applyEdit must never advance lastSyncedContent, which
  // would mark webview+disk reconciled while disk still holds the old text).
  //
  // Task 477 — chained onto `applyChain` so this call's actual applyOnce only starts once
  // every earlier one from this controller has settled (landed OR failed). That means two of
  // our own writers can never have overlapping in-flight `vscode.workspace.applyEdit` calls
  // against the same document, which is what let the loser see a stale document version and
  // surface an error for a race we caused ourselves. A failure still surfaces normally (it may
  // be a genuine external edit — hypothesis 3, which this queue does nothing to and should
  // not silence) but does not block whatever is queued behind it.
  private async applyToDocument(
    toWrite: string,
    document: vscode.TextDocument,
    debugLabel: string,
    errorMessage: string,
    perfId?: string,
  ): Promise<void> {
    const queuedAt = performance.now()
    const turn = this.applyChain.then(() =>
      this.applyOnce(
        toWrite,
        document,
        debugLabel,
        errorMessage,
        perfId,
        queuedAt,
      ),
    )
    // Swallow so a failed turn doesn't break the chain for whatever runs after it —
    // applyOnce itself already reports the failure via showError/debug.
    this.applyChain = turn.then(
      () => undefined,
      () => undefined,
    )
    return turn
  }

  private async applyOnce(
    toWrite: string,
    document: vscode.TextDocument,
    debugLabel: string,
    errorMessage: string,
    perfId?: string,
    queuedAt = performance.now(),
  ): Promise<void> {
    this.deps.recordPerf?.(perfId, {
      applyQueueMs: performance.now() - queuedAt,
    })
    // Re-check now that it's actually this write's turn: an earlier queued write (e.g. the
    // deferred correction this tick raced against) may have already landed this exact
    // content, or made it a no-op, while this call was waiting in line.
    if (normalize(toWrite) === normalize(document.getText())) {
      this.deps.setLastSyncedContent(document.getText())
      return
    }
    // Task 477 (instrumentation) — snapshot BEFORE the await, since these are only
    // meaningful as "what was true when this write started," not after this call's own
    // applyEdit has itself moved things. Two field reads + one Date.now() — cheap on
    // every write (this runs on the success path too); only the failure branch below
    // turns them into a debug() log.
    const documentVersionAtConstruction = document.version
    const anotherApplyInFlight = this.applyEditInFlightDepth > 0
    const startedAt = Date.now()
    this.applyEditInFlightDepth += 1
    this.deps.setApplyingWebviewEdit(true)
    this.deps.setPendingWebviewContent(toWrite)
    try {
      const constructionStarted = performance.now()
      const edit = new vscode.WorkspaceEdit()
      edit.replace(
        this.deps.getActiveUri(),
        this.documentRange(document),
        toWrite,
      )
      this.deps.recordPerf?.(perfId, {
        applyConstructionMs: performance.now() - constructionStarted,
        documentVersionBefore: document.version,
      })
      // applyEdit RESOLVES `false` (it does not throw) when the doc changed under
      // us — advancing lastSyncedContent on a failed write would mark the webview
      // and disk as reconciled while disk still holds the old text, and the
      // change listener would never re-push (data-loss class, task 151 item 2).
      this.deps.setActivePerf?.(perfId)
      const applyStarted = performance.now()
      const applied = await vscode.workspace.applyEdit(edit)
      this.deps.recordPerf?.(perfId, {
        applyEditMs: performance.now() - applyStarted,
        applied,
        documentVersionAfter: document.version,
      })
      if (!applied) {
        this.deps.setPendingWebviewContent(undefined)
        // Task 477 — widened from a bare uri (see the task file's "Instrument before
        // theorising"). Hypothesis 1 (our own two writers racing) is fixed by
        // applyChain's serialization above, so a failure reaching here can no longer
        // come from THIS controller's own syncToEditor-vs-resolveNoopCheck race — but
        // hypotheses 2 (checkNoopOnWillSave's save-time correction, which applies via
        // `event.waitUntil` and never enters applyChain), 3 (a genuine external edit —
        // format-on-save, git, another extension, the same file open elsewhere) and 4
        // (a stale range) were only deprioritised, never killed. Each field below is
        // chosen to discriminate them if this ever fires again:
        //  - documentVersionAtConstruction / documentVersionAtFailure: VS Code bumps
        //    `version` on every edit to the document, by anyone. A gap bigger than what
        //    this write's own (failed) edit could account for is direct evidence of WHO
        //    else changed it — a genuinely external editor bumping several versions
        //    while we were mid-await points hard at hypothesis 3.
        //  - debugLabel: which of the two call sites (syncToEditor vs resolveNoopCheck)
        //    lost — i.e. which of the two failure messages the user actually saw.
        //  - elapsedMs: how long this write's own applyEdit was in flight. A short
        //    elapsed time next to a version jump points at a fast external writer, not
        //    a slow VS Code; a long elapsed time with no version jump points elsewhere
        //    (VS Code itself under load, not a racing writer).
        //  - anotherApplyInFlight: true only if ANOTHER write from this controller
        //    (this same document's own checkNoopOnWillSave correction — see
        //    applyEditInFlightDepth's field comment) was already outstanding when THIS
        //    write started. Since applyChain now serializes every applyOnce call, this
        //    can no longer be true because of syncToEditor racing resolveNoopCheck
        //    (hypothesis 1, fixed) — if it is ever observed true, the collision came
        //    from outside applyChain's serialization domain, which is exactly the
        //    hypothesis-2/3 signal left to chase.
        this.deps.debug(
          `${debugLabel}: applyEdit returned false — write not applied`,
          {
            uri: this.deps.getActiveUri().toString(),
            debugLabel,
            documentVersionAtConstruction,
            documentVersionAtFailure: document.version,
            elapsedMs: Date.now() - startedAt,
            anotherApplyInFlight,
          },
        )
        this.deps.showError(errorMessage)
        return
      }
      this.deps.setLastSyncedContent(document.getText())
    } finally {
      this.deps.setActivePerf?.(undefined)
      this.deps.setApplyingWebviewEdit(false)
      this.applyEditInFlightDepth -= 1
    }
  }

  // Task 434 — arm (or re-arm) the deferred no-op check against `baseline`. A NEW tick always
  // cancels the PREVIOUS timer first (classic debounce), so only the LAST tick in a burst ever
  // gets to fire — exactly mirroring how often isSemanticNoop used to run per genuine pause,
  // just moved later so it doesn't block the tick's own (unconditional) write.
  private armDeferredNoopCheck(baseline: string): void {
    this.cancelDeferredNoopCheck()
    this.noopCheckTimer = setTimeout(() => {
      this.noopCheckTimer = undefined
      void this.resolveNoopCheck(baseline)
    }, WritebackController.NOOP_CHECK_IDLE_MS)
  }

  private cancelDeferredNoopCheck(): void {
    if (this.noopCheckTimer !== undefined) {
      clearTimeout(this.noopCheckTimer)
      this.noopCheckTimer = undefined
    }
  }

  // Cancel any pending deferred check — called from the panel's onDidDispose teardown (mirrors
  // DocSyncController.disposeTimer's own pattern), so a closed tab's controller can't fire a
  // stray applyEdit against a document that's gone.
  disposeNoopCheck(): void {
    this.cancelDeferredNoopCheck()
    this.cancelBaselinePrewarm()
  }

  // Fires NOOP_CHECK_IDLE_MS after the tick that armed it, IF no later tick re-armed (cancelled)
  // it first. Re-reads the document FRESH (not whatever `content` was at arm time) — it's the
  // LATEST settled state that matters, not a stale snapshot.
  //
  // Documented accepted risk (task 434 pickup) — a concurrent-applyEdit ordering race: this
  // reads `document.getText()` and, if it decides to restore, calls applyToDocument, which
  // AWAITS `vscode.workspace.applyEdit`. If the user resumes typing during that await (webview
  // posts a fresh edit → docSync → a NEW syncToEditor call) before this restore's applyEdit
  // resolves, both edits are in flight against the same document with ranges computed at two
  // different moments; whichever lands second applies its Range against whatever the document
  // has become in the meantime, not what it read. This class of race is inherent to firing two
  // independent WorkspaceEdits against the same document without a version token — VS Code's
  // API does not expose one to `applyEdit`, so "re-check after the await" can't be made
  // airtight from here (there's no atomic compare-and-swap primitive to re-check against). The
  // trace above is exactly why armDeferredNoopCheck's timer is cancelled by EVERY new tick
  // (see its own comment) and by setCleanBaseline, and why resolveNoopCheck re-validates
  // `armedAgainstBaseline !== this.cleanBaseline` before doing anything — those two guards
  // close the common case (a save or a new baseline landing) but not the narrow window where a
  // fresh keystroke's syncToEditor tick and this restore are BOTH already past their own
  // guard and mid-flight in applyEdit simultaneously. The existing `applied: false` handling in
  // applyToDocument (task 151 item 2) is the actual backstop for that narrow window: VS Code's
  // applyEdit can itself resolve `false` on certain conflicting concurrent edits, and a failed
  // apply here never advances lastSyncedContent or clears the dirty flag, so the failure mode
  // is "one of the two edits doesn't take and the user sees an error / stays dirty," not silent
  // data loss. No test in this repo can force VS Code's real edit-conflict resolution to
  // reproduce this deterministically (it depends on internal scheduling this codebase doesn't
  // control), which is why this is documented rather than covered by a new test.
  private async resolveNoopCheck(armedAgainstBaseline: string): Promise<void> {
    // The baseline moved (a save landed, or setCleanBaseline ran for another reason) since this
    // was armed — the comparison it was set up for no longer applies, and armDeferredNoopCheck
    // was cancelled by setCleanBaseline anyway; this is just belt-and-suspenders against a timer
    // that was already mid-flight when the baseline changed.
    if (armedAgainstBaseline !== this.cleanBaseline) return
    const document = this.deps.getDocument()
    const current = document.getText()
    if (normalize(current) === normalize(armedAgainstBaseline)) return // already byte-identical
    if (!this.isNoop(armedAgainstBaseline, current)) return
    await this.applyToDocument(
      armedAgainstBaseline,
      document,
      'resolveNoopCheck',
      'VMDE: could not restore the clean baseline after an undo (the document changed underneath) — the tab may still show as modified.',
    )
  }

  // Task 434 — the correctness backstop: EVERY save — keybind, command palette, menu, auto-save,
  // close-with-save-prompt — funnels through vscode.workspace.onWillSaveTextDocument (wired in
  // EditorSession), unlike the webview's own Ctrl+S interception (save-flush.ts), which only ever
  // sees the literal keystroke. Called SYNCHRONOUSLY from that listener; the returned edits (if
  // any) are handed to `event.waitUntil` so a correction applies ATOMICALLY with the save itself
  // — never a separate follow-up write, never a race with the save. Cancels the deferred timer
  // first: resolving the decision right now makes it redundant.
  checkNoopOnWillSave(document: vscode.TextDocument): vscode.TextEdit[] {
    this.cancelDeferredNoopCheck()
    if (this.exactTransactionContent === document.getText()) return []
    const baseline = this.cleanBaseline
    // `=== undefined`, not `!baseline` (task 434 defect #3 — same sentinel issue as
    // syncToEditor's baseline read above): a legitimate empty-string baseline must still be
    // eligible for the no-op check, not treated as "not set yet".
    if (baseline === undefined) return []
    const current = document.getText()
    if (normalize(current) === normalize(baseline)) return []
    if (!this.isNoop(baseline, current)) return []
    // Task 434 defect #1 — this correction edit is applied by VS Code via `waitUntil`, which
    // fires the SAME `onDidChangeTextDocument` listener (editor-session.ts) as any other edit.
    // Every other write path here (applyToDocument) marks itself as an echo BEFORE the edit
    // lands so that listener recognizes its own write and skips schedulePostUpdate — this one
    // didn't, so the correction was falling through as if it were an external edit, forcing a
    // full `vditor.setValue()` DOM rebuild in the webview on every save the correction fires
    // for. Mirror applyToDocument's discipline: `setPendingWebviewContent` is the one isEcho()
    // actually compares against (checked FIRST in the listener, self-clearing) —
    // setApplyingWebviewEdit is defense-in-depth for the same window. There's no "edit
    // landed" callback from `waitUntil` to clear the flag precisely, so — same as
    // applyToDocument's finally-clears-on-completion, just without a promise to hang the
    // clear off — bound it to a macrotask; the change listener that must see it fires
    // synchronously with the save, well within that window.
    this.deps.setApplyingWebviewEdit(true)
    this.deps.setPendingWebviewContent(baseline)
    // Task 477 — mark this write outstanding for the SAME window as the field's own
    // comment describes (applyEditInFlightDepth), so a debounced tick's applyOnce
    // landing during this window records `anotherApplyInFlight: true` instead of
    // silently looking like an isolated failure. No "edit landed" callback exists for
    // `waitUntil` (same reason setApplyingWebviewEdit(false) is deferred below), so this
    // is bound to the same macrotask for consistency, not a precise completion signal.
    this.applyEditInFlightDepth += 1
    setTimeout(() => {
      this.deps.setApplyingWebviewEdit(false)
      this.applyEditInFlightDepth -= 1
    }, 0)
    return [vscode.TextEdit.replace(this.documentRange(document), baseline)]
  }

  // Shared by resolveNoopCheck and checkNoopOnWillSave — the same whole-document semantic-no-op
  // comparison syncToEditor used to run inline on every tick (task 61 v2 Layer 1 / task 434).
  private isNoop(baseline: string, current: string): boolean {
    // Same ordering as minimizeWriteback: invalidate a stale whole-document canonical form before
    // checking whether it exists, then use one resource-scoped snapshot for the entire comparison.
    const extensions = this.markdownExtensions()
    if (this.cleanBaselineCanonical === undefined) {
      this.cleanBaselineCanonical = this.reserializeWhole(baseline, extensions)
    }
    const reW = (md: string): string | undefined =>
      md === baseline
        ? this.cleanBaselineCanonical
        : this.reserializeWhole(md, extensions)
    return isSemanticNoop(baseline, current, reW)
  }
}
