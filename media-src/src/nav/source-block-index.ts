import { withoutOwnHintRecords } from '../util/wrap-hint-mark'
import type { MovableKind } from '../../../src/shared/block-move'

// Task 574: one per-revision source block index shared by the block handle, the Details button
// and the selection bubble. It was extracted from the Task 573 block-handle presentation cache.
// Runtime dependencies are injected, so this module never imports `block-handle.ts` (which
// creates a default index) or `editing/` (the boundary test forbids `nav -> editing`). Consumers
// attach derived data through `memo()`.

// Task 576 feedback-path pass: moved here from block-handle.ts (which now re-exports it) to break
// a dependency-cruiser `no-circular` finding — block-handle.ts only ever consumed this as a type
// (`import type`), but a real value import ran the other way (this module -> block-handle.ts via
// createSourceBlockIndex), so the extraction resolver still saw a two-file cycle.
export interface BlockHandleUnit {
  element: HTMLElement
  start: number
  end: number
  kind: MovableKind
  movable: boolean
  /** Complete source enclosures can span several rendered sibling blocks. */
  members: HTMLElement[]
}

export interface SourceBlockIndexKey {
  root: HTMLElement
  owner: object
  mode: 'ir' | 'wysiwyg'
  revision: object
  domRevision: number
}

export interface SourceBlockIndex {
  key: SourceBlockIndexKey
  exact: string
  rendered: string
  /** `null` means the resolver rejected this key; the rejection is cached too. */
  units: BlockHandleUnit[] | null
  /** Build a consumer's derived value once per entry, keyed by the consumer's own slot. */
  memo<T>(slot: symbol, build: (entry: SourceBlockIndex) => T): T
}

export interface SourceBlockIndexDeps {
  getActiveRoot(): HTMLElement | null
  projection(): { owner: object; mode: 'ir' | 'wysiwyg' } | null
  /** `exact` is `null` when EditSync owns no exact source (Task 607): no units, fail closed. */
  snapshotPair(): { exact: string | null; rendered: string } | null
  snapshotRevision(): object | undefined
  /** Task 607: start one background exact-authority request; success advances the revision.
   * A returned promise settles with the reply (`null` when it was not adopted). */
  acquireExactAuthority?(): Promise<unknown> | undefined
  resolveUnits(
    root: HTMLElement,
    exact: string,
    rendered: string,
  ): BlockHandleUnit[] | null
}

type SourceBlockIndexInvalidation = 'dom' | 'revision' | 'authority'

export interface SourceBlockIndexHandle {
  /** Drains pending DOM records and returns the current key; never serializes Markdown. */
  currentKey(): SourceBlockIndexKey | null
  /** The cached entry for `currentKey()`; never builds. */
  peek(): SourceBlockIndex | null
  /** `peek()`, or build once for `currentKey()`. `null` when there is no cacheable key. */
  read(): SourceBlockIndex | null
  /** Task 577: defers `readWhenReady` builds until every hold is released (the selection bubble
   * holds them until its first visible frame has painted). The release is idempotent. */
  holdBuilds(): () => void
  /** `read()` now, or, while a hold is active, once after the last hold is released; one build
   * then serves every waiter. Returns a cancel function. Callbacks re-validate their own state. */
  readWhenReady(callback: (entry: SourceBlockIndex | null) => void): () => void
  /** `'dom'` passes the root whose DOM changed (or the root just unbound); the others pass
   * the previously bound root. */
  onInvalidate(
    listener: (
      reason: SourceBlockIndexInvalidation,
      root: HTMLElement | null,
    ) => void,
  ): () => void
  /** Task 610: run a caller-owned DOM write that the caller proves cannot change the source. The
   * index first processes any record queued before the scope (a pending real edit still
   * invalidates), then runs `run`, then takes the scope's records. They are discarded, keeping the
   * entry and `domRevision`, only when `run` returned normally and every `accept` passes;
   * otherwise they take the normal invalidation path. Scopes nest: the outermost one owns every
   * record, including those of a `currentKey()` call inside it. The index knows nothing about the
   * writer; `accept` is the caller's proof over the scope's records. */
  sourceNeutral<T>(
    run: () => T,
    accept?: (records: MutationRecord[]) => boolean,
  ): T
  dispose(): void
}

export function sameSourceBlockIndexKey(
  left: SourceBlockIndexKey | null,
  right: SourceBlockIndexKey | null,
): boolean {
  return Boolean(
    left &&
      right &&
      left.root === right.root &&
      left.owner === right.owner &&
      left.mode === right.mode &&
      left.revision === right.revision &&
      left.domRevision === right.domRevision,
  )
}

// Section-fold and section-indent markers control gutter affordances and margins only; block/source
// matching does not read them.
function relevantMutations(records: MutationRecord[]): boolean {
  return records.some(
    (record) =>
      record.type !== 'attributes' ||
      (![
        'class',
        'style',
        'data-vmde-foldable',
        'data-vmde-list-foldable',
        'data-vmde-indent',
        'data-vmde-indent-root',
      ].includes(record.attributeName ?? '') &&
        !record.attributeName?.startsWith('aria-')),
  )
}

// The real-VS-Code and Chromium performance specs install this opt-in object to count builds.
function countIndexBuild(): void {
  const metrics = (
    window as unknown as {
      __vmdeBlockHandleCacheMetrics?: { indexBuilds?: number }
    }
  ).__vmdeBlockHandleCacheMetrics
  if (metrics) metrics.indexBuilds = (metrics.indexBuilds ?? 0) + 1
}

const noop = (): void => undefined

function createEntry(
  key: SourceBlockIndexKey,
  exact: string,
  rendered: string,
  units: BlockHandleUnit[] | null,
): SourceBlockIndex {
  const memos = new Map<symbol, unknown>()
  const entry: SourceBlockIndex = {
    key,
    exact,
    rendered,
    units,
    memo: <T>(slot: symbol, build: (value: SourceBlockIndex) => T): T => {
      if (!memos.has(slot)) memos.set(slot, build(entry))
      return memos.get(slot) as T
    },
  }
  return entry
}

export function createSourceBlockIndex(
  deps: SourceBlockIndexDeps,
): SourceBlockIndexHandle {
  const listeners = new Set<
    (reason: SourceBlockIndexInvalidation, root: HTMLElement | null) => void
  >()
  let entry: SourceBlockIndex | null = null
  let lastKey: SourceBlockIndexKey | null = null
  let observedRoot: HTMLElement | null = null
  let observedOwner: object | null = null
  let observedMode: SourceBlockIndexKey['mode'] | null = null
  let domRevision = 0
  let observer: MutationObserver | undefined
  let disposed = false
  let holds = 0
  const waiters = new Set<(entry: SourceBlockIndex | null) => void>()
  // Task 610 source-neutral scope state; the outermost scope owns the observer's queue.
  let scopeDepth = 0
  let scopeAccepts: Array<(records: MutationRecord[]) => boolean> = []
  let scopeFailed = false

  const emit = (
    reason: SourceBlockIndexInvalidation,
    root: HTMLElement | null,
  ): void => {
    for (const listener of Array.from(listeners)) listener(reason, root)
  }
  const invalidateForMutations = (records: MutationRecord[]): void => {
    // Task 640: the wrap-hint engine's own writes are view state, not source (S1 probe 2 item 1).
    if (!relevantMutations(withoutOwnHintRecords(records))) return
    domRevision++
    entry = null
    emit('dom', observedRoot)
  }
  const flushPendingMutations = (): void => {
    // Inside a source-neutral scope the queued records belong to the scope, which decides them.
    if (scopeDepth > 0) return
    const records = observer?.takeRecords() ?? []
    if (records.length) invalidateForMutations(records)
  }
  const observeRoot = (
    root: HTMLElement | null,
    projection: { owner: object; mode: SourceBlockIndexKey['mode'] } | null,
  ): void => {
    const nextOwner = projection?.owner ?? null
    const nextMode = projection?.mode ?? null
    if (
      observedRoot === root &&
      observedOwner === nextOwner &&
      observedMode === nextMode
    )
      return
    observer?.disconnect()
    const previousRoot = observedRoot
    observedRoot = root
    observedOwner = nextOwner
    observedMode = nextMode
    entry = null
    domRevision++
    // The unbound root's DOM authority ends here; the block handle drops its proof for it.
    if (previousRoot && previousRoot !== root) emit('dom', previousRoot)
    if (root?.isConnected) {
      observer ??= new MutationObserver(invalidateForMutations)
      observer.observe(root, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
      })
    }
  }
  const currentKey = (): SourceBlockIndexKey | null => {
    if (disposed) return null
    // Drain before rebinding so a just-detached old root cannot leave a reusable entry behind.
    flushPendingMutations()
    const root = deps.getActiveRoot()
    const projection = deps.projection()
    observeRoot(root, projection)
    flushPendingMutations()
    const revision = deps.snapshotRevision()
    const key =
      root?.isConnected &&
      root.getAttribute('contenteditable') !== 'false' &&
      projection &&
      revision
        ? {
            root,
            owner: projection.owner,
            mode: projection.mode,
            revision,
            domRevision,
          }
        : null
    const previous = lastKey
    lastKey = key
    const authorityChanged =
      previous &&
      (!key ||
        previous.root !== key.root ||
        previous.owner !== key.owner ||
        previous.mode !== key.mode)
    const revisionChanged =
      previous && key && previous.revision !== key.revision
    if (authorityChanged || revisionChanged) {
      entry = null
      // A revision change can keep the same rendered block attached; action-time proof decides
      // whether that candidate still identifies one current source group.
      emit(authorityChanged ? 'authority' : 'revision', previous.root)
    }
    return key
  }
  const peek = (): SourceBlockIndex | null => {
    const key = currentKey()
    return key && entry && sameSourceBlockIndexKey(entry.key, key)
      ? entry
      : null
  }
  const acceptedByScope = (
    accepts: Array<(records: MutationRecord[]) => boolean>,
    records: MutationRecord[],
  ): boolean => {
    try {
      return accepts.every((accept) => accept(records))
    } catch {
      return false
    }
  }
  const sourceNeutral = <T>(
    run: () => T,
    accept?: (records: MutationRecord[]) => boolean,
  ): T => {
    // A record queued before the scope is not the scope's to discard.
    if (scopeDepth === 0) flushPendingMutations()
    scopeDepth++
    if (accept) scopeAccepts.push(accept)
    try {
      return run()
    } catch (error) {
      scopeFailed = true
      throw error
    } finally {
      scopeDepth--
      if (scopeDepth === 0) {
        const accepts = scopeAccepts
        const failed = scopeFailed
        scopeAccepts = []
        scopeFailed = false
        const records = observer?.takeRecords() ?? []
        if (records.length && (failed || !acceptedByScope(accepts, records)))
          invalidateForMutations(records)
      }
    }
  }
  const resolvePairUnits = (
    root: HTMLElement,
    pair: { exact: string | null; rendered: string } | null,
  ): BlockHandleUnit[] | null => {
    if (!pair) return null
    if (pair.exact !== null)
      return deps.resolveUnits(root, pair.exact, pair.rendered)
    // The entry caches this rejection for its key, so one key asks once.
    const acquired = deps.acquireExactAuthority?.()
    // An adopted reply advances the revision. Announce it at once, so a consumer that showed
    // nothing for this key (a resting hover, an open Find) refreshes without waiting for an event.
    void acquired?.then((reply) => {
      if (reply && !disposed) currentKey()
    }, noop)
    return null
  }
  const read = (): SourceBlockIndex | null => {
    const key = currentKey()
    if (!key) return null
    if (entry && sameSourceBlockIndexKey(entry.key, key)) return entry
    countIndexBuild()
    const pair = deps.snapshotPair()
    const units = resolvePairUnits(key.root, pair)
    // Snapshotting can revoke exact ownership, so cache under the post-snapshot key.
    const afterSnapshotKey = currentKey()
    const built = createEntry(
      afterSnapshotKey ?? key,
      pair?.exact ?? '',
      pair?.rendered ?? '',
      units,
    )
    if (afterSnapshotKey) entry = built
    return built
  }
  const flushWaiters = (): void => {
    if (disposed || holds || !waiters.size) return
    const pending = Array.from(waiters)
    waiters.clear()
    const built = read()
    for (const callback of pending) callback(built)
  }
  const holdBuilds = (): (() => void) => {
    if (disposed) return noop
    holds++
    let released = false
    return () => {
      if (released) return
      released = true
      holds--
      flushWaiters()
    }
  }
  const readWhenReady = (
    callback: (entry: SourceBlockIndex | null) => void,
  ): (() => void) => {
    if (disposed) return noop
    if (!holds) {
      callback(read())
      return noop
    }
    // A wrapper keeps each request cancelable even when a caller reuses one callback.
    const waiter = (entry: SourceBlockIndex | null) => callback(entry)
    waiters.add(waiter)
    return () => {
      waiters.delete(waiter)
    }
  }
  observeRoot(deps.getActiveRoot(), deps.projection())
  return {
    currentKey,
    peek,
    read,
    holdBuilds,
    readWhenReady,
    onInvalidate: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    sourceNeutral,
    dispose: () => {
      disposed = true
      observer?.disconnect()
      observer = undefined
      entry = null
      lastKey = null
      observedRoot = null
      observedOwner = null
      observedMode = null
      listeners.clear()
      holds = 0
      waiters.clear()
      // A scope still running when the index is disposed unwinds its own depth.
      scopeAccepts = []
      scopeFailed = false
    },
  }
}
