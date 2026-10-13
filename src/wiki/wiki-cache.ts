import * as vscode from 'vscode'
import * as NodePath from 'node:path'
import { collectWikiMarkdownFiles, getWikiKeys } from './wiki'
import { stripMarkdownExtension } from '../shared/wiki-core'

const WIKI_GLOB = '**/*.{md,markdown}'
const DEBOUNCE_MS = 50

export class WikiCache {
  private keyToUris = new Map<string, vscode.Uri[]>()
  private uriToKeys = new Map<string, string[]>()
  private cachedAllKeys: string[] | null = null
  private watcher: vscode.FileSystemWatcher | undefined
  private debounceTimer: NodeJS.Timeout | undefined
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
    return this.keyToUris.has(key)
  }

  resolve(key: string): vscode.Uri[] {
    return this.keyToUris.get(key) ?? []
  }

  allPageKeys(): string[] {
    if (!this.cachedAllKeys) {
      this.cachedAllKeys = Array.from(this.keyToUris.keys()).sort()
    }
    return this.cachedAllKeys
  }

  // Names offered by the autocomplete. A unique basename is shown bare ("Home");
  // a basename shared by several files is path-qualified ("a/Page", "b/Page") so
  // each entry is distinguishable AND the inserted [[a/Page]] resolves to exactly
  // one file (its relative-path key is unique). Without this, duplicate-basename
  // pages collapse into one ambiguous "Page" entry that can't be told apart.
  allDisplayNames(): string[] {
    const files = this.allFiles()
    // Count basenames case-insensitively, matching how resolution normalizes.
    const baseCount = new Map<string, number>()
    for (const uri of files) {
      const base = stripMarkdownExtension(
        NodePath.basename(uri.fsPath),
      ).toLowerCase()
      baseCount.set(base, (baseCount.get(base) ?? 0) + 1)
    }
    const names = new Set<string>()
    for (const uri of files) {
      const base = stripMarkdownExtension(NodePath.basename(uri.fsPath))
      if ((baseCount.get(base.toLowerCase()) ?? 0) > 1) {
        const rel = NodePath.relative(this.root.fsPath, uri.fsPath).replace(
          /\\/g,
          '/',
        )
        names.add(stripMarkdownExtension(rel))
      } else {
        names.add(base)
      }
    }
    return Array.from(names).sort()
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

  dispose(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    this.watcher?.dispose()
    this.changeListeners.clear()
  }

  private async fullScan(token?: vscode.CancellationToken): Promise<void> {
    this.keyToUris.clear()
    this.uriToKeys.clear()
    this.cachedAllKeys = null
    const files = await collectWikiMarkdownFiles(this.root, token)
    for (const file of files) {
      this.indexFile(file)
    }
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
    this.cachedAllKeys = null
  }

  private removeFile(fsPath: string): void {
    const keys = this.uriToKeys.get(fsPath)
    if (!keys) return
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
    this.cachedAllKeys = null
  }

  private startWatcher(): void {
    this.watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(this.root, WIKI_GLOB),
    )
    const scheduleUpdate = () => {
      if (this.debounceTimer) clearTimeout(this.debounceTimer)
      this.debounceTimer = setTimeout(() => {
        for (const listener of this.changeListeners) listener()
      }, DEBOUNCE_MS)
    }
    this.watcher.onDidCreate((uri) => {
      this.indexFile(uri)
      scheduleUpdate()
    })
    this.watcher.onDidDelete((uri) => {
      this.removeFile(uri.fsPath)
      scheduleUpdate()
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
