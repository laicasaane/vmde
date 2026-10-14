import type * as vscode from 'vscode'

// Task 638 — the persisted wiki page list (stale-while-revalidate). The list is a HINT for the
// first `init` after a restart: it mirrors the last state of the live per-root cache, and the
// background build always revalidates it. Correctness comes from that revalidation; the bounds and
// the schema check below only keep a bad or huge value from ever reaching the webview or the
// workspace-state database (the whole memento is loaded into the extension host at activation).
//
// This module is configured once from `activate` with the extension's workspace state and logger
// (it cannot import the host log itself: platform already imports wiki). Unconfigured, every
// function is a no-op, so code that builds a cache or session without a store keeps its behaviour.

const KeyPrefix = 'vmde.wikiPages:'
const SchemaVersion = 1
// Provisional bounds (Task 638 Part 1, decision 3): reversible, re-measured on a real workspace.
const MaxEntriesPerArray = 20_000
const MaxBytesPerList = 512 * 1024
const MaxStoredRoots = 4

// Same shape as WikiKeys in wiki-session (which imports this module, so it cannot be imported back).
interface StoredKeys {
  pageKeys: string[]
  displayNames: string[]
}

type Memento = {
  get(key: string): unknown
  update(key: string, value: unknown): PromiseLike<void> | void
  // Optional: older or minimal contexts may lack it, which only skips the root-cap pruning.
  keys?(): readonly string[]
}

interface StoredEntry {
  version: number
  root: string
  savedAt: number
  pageKeys: string[]
  displayNames: string[]
}

let store: Memento | undefined
let log: ((message: string) => void) | undefined
// Storage key -> savedAt of every entry stored for this workspace, loaded from `keys()` on the
// first write after configuration and kept current by this module's writes and clears.
let knownEntries: Map<string, number> | undefined

export function configureWikiKeyStore(
  memento: Memento | undefined,
  logger?: (message: string) => void,
): void {
  store = memento
  log = logger
  knownEntries = undefined
}

const storageKey = (root: vscode.Uri) => `${KeyPrefix}${root.toString()}`

// Counts entries and UTF-8 bytes of both arrays against the bounds. Run on write AND on read, so a
// hand-edited value cannot claim to be small.
function withinBounds(pageKeys: string[], displayNames: string[]): boolean {
  if (
    pageKeys.length > MaxEntriesPerArray ||
    displayNames.length > MaxEntriesPerArray
  )
    return false
  let bytes = 0
  for (const list of [pageKeys, displayNames])
    for (const text of list) {
      bytes += Buffer.byteLength(text, 'utf8')
      if (bytes > MaxBytesPerList) return false
    }
  return true
}

const isNonEmptyStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) &&
  value.every((item) => typeof item === 'string' && item.length > 0)

function parseEntry(value: unknown, root: string): StoredEntry | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return undefined
  const entry = value as Record<string, unknown>
  if (
    entry.version !== SchemaVersion ||
    entry.root !== root ||
    typeof entry.savedAt !== 'number' ||
    !Number.isFinite(entry.savedAt) ||
    !isNonEmptyStringArray(entry.pageKeys) ||
    !isNonEmptyStringArray(entry.displayNames) ||
    entry.pageKeys.length === 0 ||
    !withinBounds(entry.pageKeys, entry.displayNames)
  )
    return undefined
  return entry as unknown as StoredEntry
}

/** The stored list for `root`, or undefined when absent, unreadable, old-schema, foreign or oversize. Never throws. */
export function readStoredKeys(root: vscode.Uri): StoredKeys | undefined {
  if (!store) return undefined
  try {
    const entry = parseEntry(store.get(storageKey(root)), root.toString())
    return (
      entry && {
        pageKeys: entry.pageKeys.slice(),
        displayNames: entry.displayNames.slice(),
      }
    )
  } catch {
    return undefined
  }
}

// Fire-and-forget: a failed write leaves the previous entry in place and logs one generic line
// (never a root, key, page name or error text, which could carry file names).
function put(key: string, value: StoredEntry | undefined): void {
  const failed = () => log?.('wiki page list could not be stored')
  try {
    Promise.resolve(store?.update(key, value)).catch(failed)
  } catch {
    failed()
  }
}

function loadKnownEntries(memento: Memento): Map<string, number> | undefined {
  if (!memento.keys) return undefined
  const known = new Map<string, number>()
  try {
    for (const key of memento.keys()) {
      if (!key.startsWith(KeyPrefix)) continue
      const value = memento.get(key) as { savedAt?: unknown } | undefined
      // An unreadable entry counts towards the cap with the oldest possible age, so it goes first.
      known.set(
        key,
        typeof value?.savedAt === 'number' && Number.isFinite(value.savedAt)
          ? value.savedAt
          : 0,
      )
    }
  } catch {
    return undefined
  }
  return known
}

// Keeps at most MaxStoredRoots entries for the workspace: deletes the oldest other than `keep`.
function pruneOldest(keep: string): void {
  if (!knownEntries) return
  while (knownEntries.size > MaxStoredRoots) {
    let oldest: string | undefined
    for (const [key, savedAt] of knownEntries)
      if (
        key !== keep &&
        (oldest === undefined || savedAt < (knownEntries.get(oldest) ?? 0))
      )
        oldest = key
    if (oldest === undefined) return
    knownEntries.delete(oldest)
    put(oldest, undefined)
  }
}

/** Stores `keys` for `root`. An empty or over-bound list is not stored and deletes the entry instead. */
export function writeStoredKeys(root: vscode.Uri, keys: StoredKeys): void {
  if (!store) return
  if (
    keys.pageKeys.length === 0 ||
    !withinBounds(keys.pageKeys, keys.displayNames)
  ) {
    clearStoredKeys(root)
    return
  }
  const key = storageKey(root)
  // The key set is read once per extension-host lifetime; later writes keep it current.
  knownEntries ??= loadKnownEntries(store)
  const savedAt = Date.now()
  put(key, {
    version: SchemaVersion,
    root: root.toString(),
    savedAt,
    pageKeys: keys.pageKeys,
    displayNames: keys.displayNames,
  })
  knownEntries?.set(key, savedAt)
  pruneOldest(key)
}

/** Deletes the stored list for `root` (a root change, a disabled wiki, or an unusable list). */
export function clearStoredKeys(root: vscode.Uri): void {
  if (!store) return
  const key = storageKey(root)
  knownEntries?.delete(key)
  put(key, undefined)
}
