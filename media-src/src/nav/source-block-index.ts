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
  snapshotPair(): { exact: string; rendered: string } | null
  snapshotRevision(): object | undefined
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
  /** `'dom'` passes the root whose DOM changed (or the root just unbound); the others pass
   * the previously bound root. */
  onInvalidate(
    listener: (
      reason: SourceBlockIndexInvalidation,
      root: HTMLElement | null,
    ) => void,
  ): () => void
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

// Section-fold markers control gutter affordances only; block/source matching does not read them.
function relevantMutations(records: MutationRecord[]): boolean {
  return records.some(
    (record) =>
      record.type !== 'attributes' ||
      (![
        'class',
        'style',
        'data-vmde-foldable',
        'data-vmde-list-foldable',
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

  const emit = (
    reason: SourceBlockIndexInvalidation,
    root: HTMLElement | null,
  ): void => {
    for (const listener of Array.from(listeners)) listener(reason, root)
  }
  const invalidateForMutations = (records: MutationRecord[]): void => {
    if (!relevantMutations(records)) return
    domRevision++
    entry = null
    emit('dom', observedRoot)
  }
  const flushPendingMutations = (): void => {
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
  const read = (): SourceBlockIndex | null => {
    const key = currentKey()
    if (!key) return null
    if (entry && sameSourceBlockIndexKey(entry.key, key)) return entry
    countIndexBuild()
    const pair = deps.snapshotPair()
    const units = pair
      ? deps.resolveUnits(key.root, pair.exact, pair.rendered)
      : null
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
  observeRoot(deps.getActiveRoot(), deps.projection())
  return {
    currentKey,
    peek,
    read,
    onInvalidate: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
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
    },
  }
}
