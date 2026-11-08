import * as vscode from 'vscode'
import * as NodePath from 'node:path'
import {
  collectWikiMarkdownFiles,
  getWikiKeys,
  isWikiPageExcluded,
  WikiPageGlob,
} from './wiki'
import type { FrontMatterMetadata } from '../shared/front-matter'
import type { WikiAliasHint } from '../shared/protocol'
import {
  normalizeWikiLookupKey,
  stripMarkdownExtension,
} from '../shared/wiki-core'
import {
  readWikiMetadataBatch,
  readWikiPageMetadata,
  WIKI_FRONT_MATTER_HEAD_BYTES,
} from './wiki-front-matter'
import { clearStoredKeys, writeStoredKeys } from './wiki-key-store'

const DEBOUNCE_MS = 50
// Task 638 — trailing debounce for rewriting the persisted page list after watcher events, so a
// burst (a branch switch touching hundreds of files) rewrites the stored value once.
const PERSIST_DEBOUNCE_MS = 2000

// Task 709 — what one page declares in its front matter. Only pages that declare aliases or tags
// have an entry.
interface WikiPageMetadataEntry {
  uri: vscode.Uri
  aliases: string[] // as declared (after the extractor's cleanup)
  aliasKeys: string[] // normalizeWikiLookupKey(alias), same order
  tags: string[]
}

const NoTags: readonly string[] = Object.freeze([])

const sameList = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((item, index) => item === b[index])

export class WikiCache {
  private keyToUris = new Map<string, vscode.Uri[]>()
  private uriToKeys = new Map<string, string[]>()
  private cachedAllKeys: string[] | null = null
  // Task 709 — alias keys, separate from path keys so a path key always wins and Task 202 can tell
  // them apart.
  private aliasKeyToUris = new Map<string, vscode.Uri[]>()
  private uriToMetadata = new Map<string, WikiPageMetadataEntry>()
  private cachedAliasHints: WikiAliasHint[] | null = null
  // fsPath -> sequence number of the newest read in flight; an older read's result is dropped.
  private metadataReads = new Map<string, number>()
  private metadataReadSequence = 0
  private disposed = false
  private watcher: vscode.FileSystemWatcher | undefined
  private debounceTimer: NodeJS.Timeout | undefined
  // Task 638 — set once this cache is the stored one for its root (see startPersisting). Persistence
  // lives here, not in the sessions, so N editors on one root cause one write per change and a
  // build finishing after its editor closed is still stored.
  private persisting = false
  private persistTimer: NodeJS.Timeout | undefined
  // A SET, not a single callback: the cache is a per-root singleton shared by every
  // consumer, and binding only the first caller's onChange silently dropped later
  // consumers' notifications (audit 185/3h).
  private readonly changeListeners = new Set<() => void>()

  private constructor(public readonly root: vscode.Uri) {}

  static async build(
    root: vscode.Uri,
    onChange?: () => void,
    token?: vscode.CancellationToken,
  ): Promise<WikiCache> {
    const cache = new WikiCache(root)
    if (onChange) cache.changeListeners.add(onChange)
    await cache.fullScan(token)
    // A cancelled build is never stored, so it must not leave a watcher behind.
    if (!token?.isCancellationRequested) cache.startWatcher()
    return cache
  }

  /** Subscribe to debounced wiki-content changes. Returns an unsubscriber. */
  addChangeListener(cb: () => void): () => void {
    this.changeListeners.add(cb)
    return () => this.changeListeners.delete(cb)
  }

  has(key: string): boolean {
    return this.keyToUris.has(key) || this.aliasKeyToUris.has(key)
  }

  // A path match wins over an alias (Task 709, Q1): a link that resolved to a page keeps its target
  // when another page later declares the same name as an alias. Aliases alone may be ambiguous; the
  // caller then shows the duplicate-filename picker.
  resolve(key: string): vscode.Uri[] {
    return this.keyToUris.get(key) ?? this.aliasKeyToUris.get(key) ?? []
  }

  /**
   * Path matches only. Task 202 rewrites a link on rename only when this returns exactly the
   * renamed file; an alias-resolved link is never rewritten (the alias still resolves).
   */
  resolvePathKey(key: string): vscode.Uri[] {
    return this.keyToUris.get(key) ?? []
  }

  allPageKeys(): string[] {
    if (!this.cachedAllKeys) {
      const keys = new Set(this.keyToUris.keys())
      for (const key of this.aliasKeyToUris.keys()) keys.add(key)
      this.cachedAllKeys = Array.from(keys).sort()
    }
    return this.cachedAllKeys
  }

  /**
   * One entry per (declared alias, declaring file) whose alias key is not a path key (a shadowed
   * alias is never offered), sorted by alias, then file.
   */
  allAliasHints(): WikiAliasHint[] {
    if (!this.cachedAliasHints) {
      const baseCount = this.baseNameCounts(this.allFiles())
      const hints: WikiAliasHint[] = []
      for (const entry of this.uriToMetadata.values()) {
        const file = this.displayNameOf(entry.uri, baseCount)
        entry.aliases.forEach((alias, index) => {
          if (this.keyToUris.has(entry.aliasKeys[index])) return
          hints.push({ alias, file })
        })
      }
      hints.sort((a, b) =>
        a.alias === b.alias
          ? a.file < b.file
            ? -1
            : Number(a.file > b.file)
          : a.alias < b.alias
            ? -1
            : 1,
      )
      this.cachedAliasHints = hints
    }
    return this.cachedAliasHints
  }

  // Tags are stored and exposed for Task 205's index (not shipped): no protocol field, no UI.
  tagsOf(file: vscode.Uri): readonly string[] {
    return this.uriToMetadata.get(file.fsPath)?.tags ?? NoTags
  }

  /** Files declaring `tag`, case-insensitive, a leading `#` ignored, sorted by path. */
  filesWithTag(tag: string): vscode.Uri[] {
    const wanted = (tag.startsWith('#') ? tag.slice(1) : tag).toLowerCase()
    const files: vscode.Uri[] = []
    for (const entry of this.uriToMetadata.values()) {
      if (entry.tags.some((item) => item.toLowerCase() === wanted))
        files.push(entry.uri)
    }
    return files.sort((a, b) => (a.fsPath < b.fsPath ? -1 : 1))
  }

  /** Distinct tags, first-seen spelling (files in path order), sorted case-insensitively. */
  allTags(): string[] {
    const first = new Map<string, string>()
    const entries = Array.from(this.uriToMetadata.values()).sort((a, b) =>
      a.uri.fsPath < b.uri.fsPath ? -1 : 1,
    )
    for (const entry of entries) {
      for (const tag of entry.tags) {
        const key = tag.toLowerCase()
        if (!first.has(key)) first.set(key, tag)
      }
    }
    return Array.from(first.keys())
      .sort()
      .map((key) => first.get(key) as string)
  }

  // Names offered by the autocomplete. A unique basename is shown bare ("Home");
  // a basename shared by several files is path-qualified ("a/Page", "b/Page") so
  // each entry is distinguishable AND the inserted [[a/Page]] resolves to exactly
  // one file (its relative-path key is unique). Without this, duplicate-basename
  // pages collapse into one ambiguous "Page" entry that can't be told apart.
  allDisplayNames(): string[] {
    const files = this.allFiles()
    const baseCount = this.baseNameCounts(files)
    const names = new Set<string>()
    for (const uri of files) names.add(this.displayNameOf(uri, baseCount))
    return Array.from(names).sort()
  }

  // Count basenames case-insensitively, matching how resolution normalizes.
  private baseNameCounts(files: readonly vscode.Uri[]): Map<string, number> {
    const baseCount = new Map<string, number>()
    for (const uri of files) {
      const base = stripMarkdownExtension(
        NodePath.basename(uri.fsPath),
      ).toLowerCase()
      baseCount.set(base, (baseCount.get(base) ?? 0) + 1)
    }
    return baseCount
  }

  private displayNameOf(
    uri: vscode.Uri,
    baseCount: Map<string, number>,
  ): string {
    const base = stripMarkdownExtension(NodePath.basename(uri.fsPath))
    if ((baseCount.get(base.toLowerCase()) ?? 0) > 1) {
      const rel = NodePath.relative(this.root.fsPath, uri.fsPath).replace(
        /\\/g,
        '/',
      )
      return stripMarkdownExtension(rel)
    }
    return base
  }

  allFiles(): vscode.Uri[] {
    const seen = new Set<string>()
    const result: vscode.Uri[] = []
    for (const uris of this.keyToUris.values()) {
      for (const uri of uris) {
        if (!seen.has(uri.fsPath)) {
          seen.add(uri.fsPath)
          result.push(uri)
        }
      }
    }
    return result.sort((a, b) => a.fsPath.localeCompare(b.fsPath))
  }

  /** Writes the current lists to the persisted store now and again (debounced) after watcher events. */
  startPersisting(): void {
    this.persisting = true
    this.persistNow()
  }

  dispose(): void {
    this.disposed = true
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    if (this.persistTimer) clearTimeout(this.persistTimer)
    this.watcher?.dispose()
    this.changeListeners.clear()
  }

  private persistNow(): void {
    // A disposed or replaced cache (invalidateCache, a newer build) must never write: a pending
    // write could otherwise recreate an entry that invalidation just cleared.
    if (cacheByRoot.get(this.root.fsPath) !== this) return
    writeStoredKeys(this.root, {
      pageKeys: this.allPageKeys(),
      displayNames: this.allDisplayNames(),
    })
  }

  private schedulePersist(): void {
    if (!this.persisting) return
    if (this.persistTimer) clearTimeout(this.persistTimer)
    this.persistTimer = setTimeout(() => this.persistNow(), PERSIST_DEBOUNCE_MS)
  }

  private async fullScan(token?: vscode.CancellationToken): Promise<void> {
    this.keyToUris.clear()
    this.uriToKeys.clear()
    this.aliasKeyToUris.clear()
    this.uriToMetadata.clear()
    this.metadataReads.clear()
    this.clearListCaches()
    const files = await collectWikiMarkdownFiles(this.root, token)
    for (const file of files) {
      this.indexFile(file)
    }
    // Task 709 — one pass: the first delivered key set already holds the alias keys.
    await readWikiMetadataBatch(
      files,
      (file, metadata) => this.applyMetadata(file, metadata),
      token,
    )
  }

  private clearListCaches(): void {
    this.cachedAllKeys = null
    this.cachedAliasHints = null
  }

  /**
   * Replaces the metadata of `file` and its alias keys. Returns true when the declared aliases
   * changed (a tags-only change returns false).
   */
  private applyMetadata(
    file: vscode.Uri,
    metadata: FrontMatterMetadata | null,
  ): boolean {
    return this.replaceMetadata(file.fsPath, file, metadata)
  }

  private replaceMetadata(
    fsPath: string,
    file: vscode.Uri,
    metadata: FrontMatterMetadata | null,
  ): boolean {
    const old = this.uriToMetadata.get(fsPath)
    if (!old && !metadata) return false
    if (old) this.removeAliasKeys(fsPath, old.aliasKeys)
    if (metadata) {
      const aliasKeys = metadata.aliases.map(normalizeWikiLookupKey)
      this.uriToMetadata.set(fsPath, {
        uri: file,
        aliases: metadata.aliases,
        aliasKeys,
        tags: metadata.tags,
      })
      this.addAliasKeys(file, aliasKeys)
    } else {
      this.uriToMetadata.delete(fsPath)
    }
    this.clearListCaches()
    return !sameList(old?.aliases ?? [], metadata?.aliases ?? [])
  }

  private removeAliasKeys(fsPath: string, aliasKeys: readonly string[]): void {
    for (const key of aliasKeys) {
      const remaining = this.aliasKeyToUris
        .get(key)
        ?.filter((u) => u.fsPath !== fsPath)
      if (remaining?.length) this.aliasKeyToUris.set(key, remaining)
      else this.aliasKeyToUris.delete(key)
    }
  }

  private addAliasKeys(file: vscode.Uri, aliasKeys: readonly string[]): void {
    for (const key of aliasKeys) {
      const uris = this.aliasKeyToUris.get(key)
      if (uris) uris.push(file)
      else this.aliasKeyToUris.set(key, [file])
    }
  }

  // Re-reads one page's metadata after a create or change event. A read that finishes after a newer
  // one started, after the page left the cache, or after dispose is dropped.
  private async refreshMetadata(file: vscode.Uri): Promise<void> {
    const sequence = ++this.metadataReadSequence
    this.metadataReads.set(file.fsPath, sequence)
    const metadata = await readWikiPageMetadata(
      file.fsPath,
      Buffer.allocUnsafe(WIKI_FRONT_MATTER_HEAD_BYTES),
    )
    if (
      this.disposed ||
      !this.uriToKeys.has(file.fsPath) ||
      this.metadataReads.get(file.fsPath) !== sequence
    )
      return
    this.metadataReads.delete(file.fsPath)
    if (this.applyMetadata(file, metadata)) this.scheduleUpdate()
  }

  private scheduleUpdate(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    this.debounceTimer = setTimeout(() => {
      for (const listener of this.changeListeners) listener()
    }, DEBOUNCE_MS)
    this.schedulePersist()
  }

  private indexFile(file: vscode.Uri): void {
    const keys = getWikiKeys(this.root, file)
    this.uriToKeys.set(file.fsPath, keys)
    for (const key of keys) {
      const existing = this.keyToUris.get(key)
      if (existing) {
        if (!existing.some((u) => u.fsPath === file.fsPath)) {
          existing.push(file)
        }
      } else {
        this.keyToUris.set(key, [file])
      }
    }
    this.clearListCaches()
  }

  private removeFile(fsPath: string): void {
    const keys = this.uriToKeys.get(fsPath)
    if (!keys) return
    // The page's aliases leave with it; a read still in flight is dropped by its sequence check.
    const declared = this.uriToMetadata.get(fsPath)
    if (declared) this.replaceMetadata(fsPath, declared.uri, null)
    this.metadataReads.delete(fsPath)
    for (const key of keys) {
      const uris = this.keyToUris.get(key)
      if (!uris) continue
      const filtered = uris.filter((u) => u.fsPath !== fsPath)
      if (filtered.length) {
        this.keyToUris.set(key, filtered)
      } else {
        this.keyToUris.delete(key)
      }
    }
    this.uriToKeys.delete(fsPath)
    this.clearListCaches()
  }

  private startWatcher(): void {
    this.watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(this.root, WikiPageGlob),
    )
    this.watcher.onDidCreate((uri) => {
      // Task 637 — the page search skips node_modules and files.exclude; a created file there must
      // not add a key either.
      if (isWikiPageExcluded(this.root, uri)) return
      this.indexFile(uri)
      this.scheduleUpdate()
      void this.refreshMetadata(uri)
    })
    // Task 709 — a saved or externally edited page may add, change or drop its aliases. Only an
    // indexed page is re-read (an excluded or unknown path is ignored); a save that leaves the
    // aliases unchanged posts nothing.
    this.watcher.onDidChange((uri) => {
      if (!this.uriToKeys.has(uri.fsPath)) return
      void this.refreshMetadata(uri)
    })
    this.watcher.onDidDelete((uri) => {
      this.removeFile(uri.fsPath)
      this.scheduleUpdate()
    })
  }
}

export { extractWikiTargets } from '../shared/wiki-core'

// Singleton cache per wiki root, shared across all editors in the same wiki.
const cacheByRoot = new Map<string, WikiCache>()

// A build in flight. The entry in `buildingByRoot` is the root's current generation: a build whose
// entry was removed or replaced (invalidateCache, disposeAllCaches, _resetCacheMap) is stale and its
// result is not stored.
interface PendingBuild {
  readonly cancellation: vscode.CancellationTokenSource
  readonly promise: Promise<WikiCache>
}
const buildingByRoot = new Map<string, PendingBuild>()

/** The already built cache for `root`, or undefined while none is built (a build may be running). */
export function peekBuiltCache(root: vscode.Uri): WikiCache | undefined {
  return cacheByRoot.get(root.fsPath)
}

function startBuild(key: string, root: vscode.Uri): PendingBuild {
  // Invalidating the root cancels the search still running for it, so the editor's file-search
  // service stops working for a result nobody will store.
  const cancellation = new vscode.CancellationTokenSource()
  const build: PendingBuild = {
    cancellation,
    promise: WikiCache.build(root, undefined, cancellation.token).then(
      (cache) => {
        cancellation.dispose()
        if (buildingByRoot.get(key) !== build) {
          // Invalidated while it scanned (a wiki setting changed): this result is stale and is
          // never stored. Waiters must not be handed it — a cancelled search is empty, which
          // would read as "page not found" — so they follow the current build, or a fresh
          // one-off snapshot when none has started yet.
          cache.dispose()
          return followCurrentBuild(key, root)
        }
        cacheByRoot.set(key, cache)
        buildingByRoot.delete(key)
        // Only a non-stale build reaches the store: the stale branch above never gets here.
        cache.startPersisting()
        return cache
      },
      (error: unknown) => {
        cancellation.dispose()
        if (buildingByRoot.get(key) === build) buildingByRoot.delete(key)
        throw error
      },
    ),
  }
  buildingByRoot.set(key, build)
  return build
}

async function followCurrentBuild(
  key: string,
  root: vscode.Uri,
): Promise<WikiCache> {
  const current = cacheByRoot.get(key) ?? buildingByRoot.get(key)?.promise
  if (current) return current
  // Nothing replaced the invalidated build yet: scan once for this waiter without storing the
  // result or leaving a watcher behind (the next getOrBuildCache call builds the stored cache).
  const snapshot = await WikiCache.build(root)
  snapshot.dispose()
  return snapshot
}

function cancelBuild(key: string): void {
  buildingByRoot.get(key)?.cancellation.cancel()
  buildingByRoot.delete(key)
}

export async function getOrBuildCache(
  root: vscode.Uri,
  onChange?: () => void,
): Promise<WikiCache> {
  const key = root.fsPath
  const existing = cacheByRoot.get(key)
  if (existing) {
    // The 185/3h fix: EVERY consumer's onChange subscribes to the shared singleton —
    // previously only the first caller's callback was bound and later ones were dropped.
    if (onChange) existing.addChangeListener(onChange)
    return existing
  }

  const building = buildingByRoot.get(key) ?? startBuild(key, root)
  const cache = await building.promise
  if (onChange) cache.addChangeListener(onChange)
  return cache
}

export function invalidateCache(root: vscode.Uri): void {
  const key = root.fsPath
  const existing = cacheByRoot.get(key)
  if (existing) {
    existing.dispose()
    cacheByRoot.delete(key)
  }
  cancelBuild(key)
  // The stored list goes with the cache (root change, wiki disabled). Not done by disposeAllCaches:
  // the stored list is what survives the restart.
  clearStoredKeys(root)
}

export function disposeAllCaches(): void {
  for (const cache of cacheByRoot.values()) cache.dispose()
  cacheByRoot.clear()
  for (const key of Array.from(buildingByRoot.keys())) cancelBuild(key)
}

// For testing: clear the singleton map without calling dispose.
export function _resetCacheMap(): void {
  cacheByRoot.clear()
  buildingByRoot.clear()
}
