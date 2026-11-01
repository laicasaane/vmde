export interface AutoWrapConfig {
  enabled: boolean
  delayMs: number
  column: number
}

export interface AutoWrapInput {
  inputType: string
  isComposing: boolean
}

export interface AutoWrapController {
  updateConfig(config: AutoWrapConfig): void
  cancel(): void
  dispose(): void
  handleInput(event: AutoWrapInput): void
  handleCompositionStart(): void
  handleCompositionEnd(): void
}

interface AutoWrapControllerDeps<Target> {
  captureTarget(): Target | null
  isTargetCurrent(target: Target): boolean
  /** Task 686: runs before `apply`; resolving `false` declines the attempt. The target must still
   * be current afterwards. Used to publish typing and acquire exact authority first. */
  prepare?(target: Target): Promise<boolean>
  apply(target: Target, config: AutoWrapConfig): void | Promise<void>
  onError(error: unknown): void
  /** Keep a typing post from retiring exact source while an automatic attempt is pending. */
  pendingChanged?(pending: boolean): void
}

const DEFAULT_CONFIG: AutoWrapConfig = {
  enabled: false,
  delayMs: 500,
  column: 80,
}

function normalizedConfig(config: AutoWrapConfig): AutoWrapConfig {
  return {
    enabled: config.enabled === true,
    delayMs: Math.min(5000, Math.max(100, Math.round(config.delayMs || 500))),
    column:
      Number.isFinite(config.column) && config.column > 0
        ? Math.floor(config.column)
        : 80,
  }
}

/** Task 686: right after a Source pass the first IR key can come before edit-sync holds exact
 * authority (the Source typing was published as a plain edit), and the Rewrap proof then finds
 * nothing to prove against. Without an exact text in a visual mode, publish the typing and pull the
 * host text first; the reply is adopted only by edit-sync's own checks. Source mode proves nothing
 * and makes no request. */
export async function prepareAutoWrapSource(deps: {
  sourceMode(): boolean
  hasExact(): boolean
  acquire(): Promise<unknown>
}): Promise<boolean> {
  if (deps.sourceMode() || deps.hasExact()) return true
  if ((await deps.acquire()) != null) return true
  // A publish-mode call reuses a request already in flight, whose reply edit-sync rejects because
  // the typing came after it. That request has settled by now, so one more call publishes and asks
  // afresh.
  return (await deps.acquire()) != null
}

export function createAutoWrapController<Target>(
  deps: AutoWrapControllerDeps<Target>,
): AutoWrapController {
  let config = DEFAULT_CONFIG
  let timer: ReturnType<typeof setTimeout> | undefined
  let disposed = false
  let composing = false
  let composedInput = false
  let applying = false
  // Typing seen while an attempt runs (now a host round trip) schedules the next one afterwards.
  let inputWhileApplying = false
  let generation = 0
  let announcedPending = false
  const announcePending = () => {
    const pending = timer !== undefined || applying
    if (pending === announcedPending) return
    announcedPending = pending
    deps.pendingChanged?.(pending)
  }

  // Only typing during the preparation wait counts: an input raised by the apply step itself (the
  // re-render of the wrapped text) must not start a new attempt.
  let preparing = false
  const noteInputWhilePreparing = (event: AutoWrapInput) => {
    if (
      preparing &&
      !composing &&
      !event.isComposing &&
      event.inputType === 'insertText'
    )
      inputWhileApplying = true
  }

  const clearTimer = () => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
  }

  const cancel = () => {
    generation++
    clearTimer()
    announcePending()
  }

  const schedule = () => {
    if (disposed || applying || composing || !config.enabled) return
    // Input owns only this monotonic token + timer reset. Capturing the live target is deliberately
    // inside the timer so a large IR document performs no DOM/Markdown acquisition while typing.
    const scheduledGeneration = ++generation
    clearTimer()
    timer = setTimeout(() => {
      // A queued stale callback must not retire the newer timer's publication lease.
      if (scheduledGeneration !== generation) return
      timer = undefined
      if (disposed || applying || !config.enabled) {
        announcePending()
        return
      }
      let target: Target | null
      try {
        target = deps.captureTarget()
        if (target == null || !deps.isTargetCurrent(target)) {
          announcePending()
          return
        }
      } catch (error) {
        // A failed capture must release the typing publication lease as well as report the error.
        announcePending()
        deps.onError(error)
        return
      }
      applying = true
      inputWhileApplying = false
      Promise.resolve()
        .then(async () => {
          if (deps.prepare) {
            preparing = true
            const ready = await deps.prepare(target).finally(() => {
              preparing = false
            })
            if (!ready) return
            // The wait may have outlived this attempt: a cancel (keydown, pointer, config) bumps
            // the generation, and composition or a disabled config also end it.
            if (
              scheduledGeneration !== generation ||
              disposed ||
              composing ||
              !config.enabled ||
              !deps.isTargetCurrent(target)
            )
              return
          }
          await deps.apply(target, config)
        })
        .catch((error: unknown) => deps.onError(error))
        .finally(() => {
          applying = false
          announcePending()
          if (inputWhileApplying) {
            inputWhileApplying = false
            schedule()
          }
        })
    }, config.delayMs)
    announcePending()
  }

  return {
    updateConfig(nextConfig) {
      const next = normalizedConfig(nextConfig)
      if (
        config.enabled !== next.enabled ||
        config.delayMs !== next.delayMs ||
        config.column !== next.column
      ) {
        cancel()
      }
      config = next
    },
    cancel,
    dispose() {
      disposed = true
      cancel()
    },
    handleInput(event) {
      if (disposed || !config.enabled) return
      if (applying) {
        noteInputWhilePreparing(event)
        return
      }
      if (composing || event.isComposing) {
        if (event.inputType === 'insertText') composedInput = true
        return
      }
      if (event.inputType !== 'insertText') {
        cancel()
        return
      }
      schedule()
    },
    handleCompositionStart() {
      composing = true
      composedInput = false
      cancel()
    },
    handleCompositionEnd() {
      composing = false
      if (!composedInput) return
      composedInput = false
      schedule()
    },
  }
}
