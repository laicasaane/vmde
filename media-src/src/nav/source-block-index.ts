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
  /** Task 733: units of the confirmed text model, for a display-only entry. `exact` is the model
   * text. `undefined` means "no model result": the existing build runs. Injected by boot, because
   * `nav` never imports `bridge`. */
  modelUnits?(): { exact: string; units: BlockHandleUnit[] } | undefined
  /** Task 733: the model's units changed (build, rebind) with no DOM record. Returns the
   * unsubscribe function. */
  onModelUnitsChanged?(listener: () => void): () => void
}

type SourceBlockIndexInvalidation = 'dom' | 'revision' | 'authority'

interface SourceBlockIndexReadOptions {
  acquire?: boolean
}

export interface SourceBlockIndexHandle {
  /** Drains pending DOM records and returns the current key; never serializes Markdown. */
  currentKey(): SourceBlockIndexKey | null
  /** The cached entry for `currentKey()`; never builds. */
  peek(opts?: SourceBlockIndexReadOptions): SourceBlockIndex | null
  /** `peek()`, or build once for `currentKey()`. `null` when there is no cacheable key.
   * Task 700: `acquire: false` is a passive display read; it never starts the Task 607
   * background exact-authority acquire (default `true`). A later acquiring read on the same key
   * starts it once, without counting another build. */
  read(opts?: SourceBlockIndexReadOptions): SourceBlockIndex | null
  /** Task 577: defers `readWhenReady` builds until every hold is released (the selection bubble
   * holds them until its first visible frame has painted). The release is idempotent. */
  holdBuilds(): () => void
  /** `read()` now, or, while a hold is active, once after the last hold is released; one build
   * then serves every waiter. Returns a cancel function. Callbacks re-validate their own state. */
  readWhenReady(
    callback: (entry: SourceBlockIndex | null) => void,
    opts?: SourceBlockIndexReadOptions,
  ): () => void
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

// Task 733: a model entry up to this many characters takes its `rendered` text at build. Reading
// it later forces one whole-document serialization (`snapshotPair()`), which the selection
// settle (Details) would pay before the toolbar paints; for a document this small it costs
// well under a millisecond, and the entry then behaves exactly as an existing-path build.
const EAGER_RENDERED_MAX_CHARS = 4096

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
  // Task 700: the waiters that asked for an acquire (the default); a flush acquires if any did.
  const acquiringWaiters = new WeakSet<object>()
  // Task 700: the cached entry whose null-exact rejection skipped the acquire for a passive read.
  let acquireSkippedEntry: SourceBlockIndex | null = null
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
  const peek = (
    opts?: SourceBlockIndexReadOptions,
  ): SourceBlockIndex | null => {
    const key = currentKey()
    if (!(key && entry && sameSourceBlockIndexKey(entry.key, key))) return null
    // Task 700: a peek that needs exact units (block hover, find, selection proof) starts the
    // acquire a passive read skipped, exactly as an acquiring `read()` does.
    if (opts?.acquire !== false) startSkippedAcquire(entry)
    return entry
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
    acquire: boolean,
  ): { units: BlockHandleUnit[] | null; skipped: boolean } => {
    if (!pair) return { units: null, skipped: false }
    if (pair.exact !== null)
      return {
        units: deps.resolveUnits(root, pair.exact, pair.rendered),
        skipped: false,
      }
    // Task 700: a passive display read fails closed on `exact: null` without asking; the first
    // consumer that needs exact units starts the acquire (see `startSkippedAcquire`).
    if (!acquire) return { units: null, skipped: true }
    startAcquire()
    return { units: null, skipped: false }
  }
  const startAcquire = (): void => {
    // The entry caches this rejection for its key, so one key asks once.
    const acquired = deps.acquireExactAuthority?.()
    // An adopted reply advances the revision. Announce it at once, so a consumer that showed
    // nothing for this key (a resting hover, an open Find) refreshes without waiting for an event.
    void acquired?.then((reply) => {
      if (reply && !disposed) currentKey()
    }, noop)
  }
  // Task 700: an acquiring read that hits an entry a passive read cached starts the acquire once.
  // It counts no build: the cached entry already holds this key's pair.
  const startSkippedAcquire = (cached: SourceBlockIndex): void => {
    if (acquireSkippedEntry !== cached) return
    acquireSkippedEntry = null
    startAcquire()
  }
  // Task 733: a model entry shows the model's units at once and takes `exact` and `rendered` from
  // one lazy `snapshotPair()`. The model text is never exact authority (only edit-sync grants it,
  // Task 607): when the pair's exact differs (typing cleared edit-sync's base, CRLF bytes), the
  // entry converts in place to the existing path's content, memos cleared and the key unchanged.
  // Snapshotting can revoke ownership; the cached entry is dropped exactly as a built one is not
  // cached when its post-snapshot key moved.
  const dropWhenKeyMoved = (
    built: SourceBlockIndex,
    key: SourceBlockIndexKey,
  ): void => {
    const after = currentKey()
    if (entry === built && !(after && sameSourceBlockIndexKey(after, key)))
      entry = null
  }
  const createModelEntry = (
    key: SourceBlockIndexKey,
    model: { exact: string; units: BlockHandleUnit[] },
    acquire: boolean,
  ): SourceBlockIndex => {
    const memos = new Map<symbol, unknown>()
    let content: {
      exact: string
      rendered: string
      units: BlockHandleUnit[] | null
    } | null = null
    const settle = () => {
      if (content) return content
      const pair = deps.snapshotPair()
      if (pair && pair.exact === model.exact) {
        content = {
          exact: model.exact,
          rendered: pair.rendered,
          units: model.units,
        }
      } else {
        const { units, skipped } = resolvePairUnits(key.root, pair, acquire)
        content = {
          exact: pair?.exact ?? '',
          rendered: pair?.rendered ?? '',
          units,
        }
        memos.clear()
        if (skipped && entry === built) acquireSkippedEntry = built
      }
      dropWhenKeyMoved(built, key)
      return content
    }
    const built: SourceBlockIndex = {
      key,
      get exact() {
        return settle().exact
      },
      get rendered() {
        return settle().rendered
      },
      get units() {
        return content ? content.units : model.units
      },
      memo: <T>(slot: symbol, build: (value: SourceBlockIndex) => T): T => {
        if (!memos.has(slot)) memos.set(slot, build(built))
        return memos.get(slot) as T
      },
    }
    return built
  }
  // IR only, and only when the first unit's element is live in the bound root (the session never
  // checks the mode, and a removed element leaves its unit behind).
  const readModel = (key: SourceBlockIndexKey) => {
    if (key.mode !== 'ir' || !deps.modelUnits) return undefined
    try {
      const model = deps.modelUnits()
      const first = model?.units[0]?.element
      return model && first?.isConnected && key.root.contains(first)
        ? model
        : undefined
    } catch {
      return undefined
    }
  }
  const cacheEntry = (built: SourceBlockIndex, skipped: boolean): void => {
    entry = built
    acquireSkippedEntry = skipped ? built : null
  }
  const buildModelEntry = (
    key: SourceBlockIndexKey,
    model: { exact: string; units: BlockHandleUnit[] },
    acquire: boolean,
  ): SourceBlockIndex => {
    const built = createModelEntry(key, model, acquire)
    const small = model.exact.length <= EAGER_RENDERED_MAX_CHARS
    // Hover, pointer move and selection make no whole-document read and start no exact-authority
    // acquire: a block action asks for exact authority when it is invoked (nav/block-handle.ts).
    cacheEntry(built, false)
    if (small) void built.rendered
    return built
  }
  const read = (
    opts?: SourceBlockIndexReadOptions,
  ): SourceBlockIndex | null => {
    const acquire = opts?.acquire !== false
    const key = currentKey()
    if (!key) return null
    if (entry && sameSourceBlockIndexKey(entry.key, key)) {
      if (acquire) startSkippedAcquire(entry)
      return entry
    }
    countIndexBuild()
    const model = readModel(key)
    if (model) return buildModelEntry(key, model, acquire)
    const pair = deps.snapshotPair()
    const { units, skipped } = resolvePairUnits(key.root, pair, acquire)
    // Snapshotting can revoke exact ownership, so cache under the post-snapshot key.
    const afterSnapshotKey = currentKey()
    const built = createEntry(
      afterSnapshotKey ?? key,
      pair?.exact ?? '',
      pair?.rendered ?? '',
      units,
    )
    if (afterSnapshotKey) cacheEntry(built, skipped)
    return built
  }
  const flushWaiters = (): void => {
    if (disposed || holds || !waiters.size) return
    const pending = Array.from(waiters)
    waiters.clear()
    const built = read({
      acquire: pending.some((w) => acquiringWaiters.has(w)),
    })
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
    opts?: SourceBlockIndexReadOptions,
  ): (() => void) => {
    if (disposed) return noop
    if (!holds) {
      callback(read(opts))
      return noop
    }
    // A wrapper keeps each request cancelable even when a caller reuses one callback.
    const waiter = (entry: SourceBlockIndex | null) => callback(entry)
    if (opts?.acquire !== false) acquiringWaiters.add(waiter)
    waiters.add(waiter)
    return () => {
      waiters.delete(waiter)
    }
  }
  observeRoot(deps.getActiveRoot(), deps.projection())
  // Task 733: the session notifies from inside edit-sync's post path, so invalidate at once and
  // never throw; the 'revision' event (which may build the index) goes out once per microtask.
  let revisionEmitQueued = false
  const unsubscribeModel = deps.onModelUnitsChanged?.(() => {
    if (disposed) return
    domRevision++
    entry = null
    if (revisionEmitQueued) return
    revisionEmitQueued = true
    queueMicrotask(() => {
      revisionEmitQueued = false
      if (disposed) return
      try {
        emit('revision', observedRoot)
      } catch {
        // A listener failure must not reach the session's notify.
      }
    })
  })
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
      unsubscribeModel?.()
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
