// Task 196 rework — the exact source Find searches, and its matches, keyed by source identity.
// IR/WYSIWYG read the shared per-revision source block index (Task 574), so a query keystroke or
// option toggle on an unchanged revision reuses its bytes and never serializes. SV (which has no
// index key) snapshots EditSync's exact bytes once per source revision.
import type {
  SourceBlockIndex,
  SourceBlockIndexHandle,
} from '../nav/source-block-index'
import {
  findMarkdownMatches,
  type MarkdownFindOptions,
  type MarkdownMatch,
} from './find-engine'

type FindMode = 'ir' | 'wysiwyg' | 'sv'

export interface FindSourceDeps {
  index?: SourceBlockIndexHandle
  mode(): string | undefined
  root(): HTMLElement | null
  /** EditSync's exact bytes plus Vditor's rendered serialization (one serializer run). */
  snapshotPair(): { exact: string; rendered: string }
  /** EditSync's source revision; `undefined` means snapshots cannot be reused. */
  snapshotRevision(): object | undefined
}

export interface FindSource {
  /** Identity of these exact bytes: the index entry, or one revision-keyed snapshot. */
  key: object
  exact: string
  mode: FindMode
  root: HTMLElement
  /** The shared index entry (IR/WYSIWYG) that also carries the source-mapped block units. */
  entry: SourceBlockIndex | null
}

export interface FindResult {
  source: FindSource
  query: string
  options: MarkdownFindOptions
  matches: MarkdownMatch[]
}

export interface FindSourceTracker {
  /** The current source; `build` allows one index build or snapshot when nothing is cached. */
  source(build: boolean): FindSource | null
  /** Matches for the current source, reused while the source key, query and options hold. */
  find(query: string, options: MarkdownFindOptions): FindResult | null
  /** True while `result` still describes the current source bytes (never builds). */
  isCurrent(result: FindResult | null): boolean
}

function findMode(mode: string | undefined): FindMode | null {
  return mode === 'ir' || mode === 'wysiwyg' || mode === 'sv' ? mode : null
}

export function createFindSourceTracker(
  deps: FindSourceDeps,
): FindSourceTracker {
  let snapshot: { revision: object; source: FindSource } | null = null
  let last: FindResult | null = null

  const fromIndex = (build: boolean): FindSource | null => {
    const entry = deps.index?.peek() ?? (build ? deps.index?.read() : null)
    if (!entry) return null
    return {
      key: entry,
      exact: entry.exact,
      mode: entry.key.mode,
      root: entry.key.root,
      entry,
    }
  }
  const fromSnapshot = (
    mode: FindMode,
    root: HTMLElement,
    build: boolean,
  ): FindSource | null => {
    const revision = deps.snapshotRevision()
    if (
      snapshot &&
      revision &&
      snapshot.revision === revision &&
      snapshot.source.root === root &&
      snapshot.source.mode === mode
    )
      return snapshot.source
    if (!build) return null
    const { exact } = deps.snapshotPair()
    const source: FindSource = { key: {}, exact, mode, root, entry: null }
    // Snapshotting can revoke exact ownership and advance the revision; key the post-snapshot one.
    const after = deps.snapshotRevision()
    snapshot = after ? { revision: after, source } : null
    return source
  }
  const source = (build: boolean): FindSource | null => {
    const mode = findMode(deps.mode())
    const root = deps.root()
    if (!mode || !root) return null
    if (mode !== 'sv' && deps.index) {
      const indexed = fromIndex(build)
      // No cacheable index key (no projection or revision authority): today's snapshot path.
      if (indexed || deps.index.currentKey()) return indexed
    }
    return fromSnapshot(mode, root, build)
  }
  return {
    source,
    find: (query, options) => {
      const current = source(true)
      if (!current) return null
      if (
        last?.source.key === current.key &&
        last.query === query &&
        last.options.caseSensitive === options.caseSensitive &&
        last.options.wholeWord === options.wholeWord
      )
        return last
      last = {
        source: current,
        query,
        options: { ...options },
        matches: findMarkdownMatches(current.exact, query, options),
      }
      return last
    },
    isCurrent: (result) =>
      Boolean(result && source(false)?.key === result.source.key),
  }
}
