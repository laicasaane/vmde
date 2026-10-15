import * as vscode from 'vscode'
import * as NodePath from 'node:path'
import {
  getWikiDocumentContext,
  getWikiRoot,
  type WikiDocumentContext,
  wikiExcludeSignature,
} from './wiki'
import {
  getOrBuildCache,
  invalidateCache,
  peekBuiltCache,
  type WikiCache,
} from './wiki-cache'
import { readStoredKeys } from './wiki-key-store'
import { MarkdownEditorViewType } from '../shared/product-identity'

export interface WikiKeys {
  pageKeys: string[]
  displayNames: string[]
}

type WikiInitPayload = WikiDocumentContext & Partial<WikiKeys>

// What an `init` carries for the wiki: the payload to post now, and — only when the keys are not
// built yet — the build to deliver later through `deliverPending`.
interface WikiInitPlan {
  payload: WikiInitPayload
  pending?: Promise<WikiCache>
  // Task 638 — the stored list `payload` carried; `deliverPending` posts the scanned keys only when
  // they differ from it. Absent when the payload carries no keys or the built cache's keys.
  readonly served?: WikiKeys
  // Internal to WikiSession: the generation this plan belongs to and the watcher callback to
  // subscribe once the pending build resolves.
  readonly generation: number
  readonly onCacheChanged?: (cache: WikiCache) => void
}

export const keysOf = (cache: WikiCache): WikiKeys => ({
  pageKeys: cache.allPageKeys(),
  displayNames: cache.allDisplayNames(),
})

// Both arrays count: two pages with the same basename change the display names without changing the
// keys.
const sameList = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((item, index) => item === b[index])
const sameKeys = (a: WikiKeys, b: WikiKeys) =>
  sameList(a.pageKeys, b.pageKeys) && sameList(a.displayNames, b.displayNames)

// Task 405 — the per-EditorSession wiki state (`this.wiki` + `this.lastWikiRoot`) and the
// init-payload/config-change logic that read/write it, extracted out of EditorSession.
// Cross-folder RENAME does NOT refresh the context — a documented Phase-1 limit — so
// there is deliberately no rename hook here, only onConfigChanged.
export class WikiSession implements vscode.Disposable {
  private wiki: WikiDocumentContext
  private lastWikiRoot: vscode.Uri | undefined
  // Task 638 — the exclude set (vmde.wiki.exclude, files.exclude) the last init plan was made with.
  private lastExcludeSignature: string | undefined
  // Task 636 — bumped by every init plan and config change, and by dispose: a delivery that finds
  // a newer value belongs to an older init or root and is dropped.
  private generation = 0
  private disposed = false
  // A planned scan whose keys have not been handed to `post` yet.
  private deliveryPending = false
  // The watcher change subscription (cache file create/delete). One at a time, released on dispose
  // so it does not outlive the panel.
  private unsubscribeChanges: (() => void) | undefined

  constructor(documentUri: vscode.Uri) {
    this.wiki = getWikiDocumentContext(documentUri)
  }

  get context(): WikiDocumentContext {
    return this.wiki
  }

  // A wiki CONFIG change (enabled/root/exclude) recomputes the context and supersedes any pending
  // delivery. Only when the EFFECTIVE root, the enabled state or (task 638) the exclude set changed
  // does it invalidate the old per-root cache and drop the watcher subscription (task 637 C4): an
  // unchanged root keeps its cache and subscription, so one editor's change cannot kill another
  // editor's fresh build on the same root.
  // Returns whether the caller must re-plan the keys: the root or exclude set changed, or a delivery
  // that was still pending was just superseded (its scan is shared, so the re-plan starts no new one).
  onConfigChanged(documentUri: vscode.Uri): boolean {
    const nextRoot = getWikiRoot(documentUri)
    const rootChanged = nextRoot?.fsPath !== this.lastWikiRoot?.fsPath
    // A changed exclude set changes which pages exist under the same root: it acts like a root change.
    const changed =
      rootChanged ||
      (nextRoot !== undefined &&
        wikiExcludeSignature(nextRoot) !== this.lastExcludeSignature)
    const supersededPending = this.deliveryPending
    this.generation++
    if (changed) {
      this.releaseChangeSubscription()
      if (this.lastWikiRoot) invalidateCache(this.lastWikiRoot)
      this.lastWikiRoot = undefined
      this.lastExcludeSignature = undefined
    }
    this.deliveryPending = false
    this.wiki = getWikiDocumentContext(documentUri)
    return changed || supersededPending
  }

  dispose(): void {
    this.disposed = true
    this.generation++
    this.releaseChangeSubscription()
  }

  // Build the init payload's `wiki` field WITHOUT waiting for the page scan (task 636): the
  // context, plus the page-key/display-name set only when the shared per-root cache is already
  // built — so the missing-link check and the autocomplete hint agree from the first render. When
  // it is not built, the scan runs in the background and `pending` resolves with the cache; the
  // caller posts the init first, then hands `pending` to `deliverPending`. `onCacheChanged` is the
  // watcher callback (file create/delete under the root); the caller wires it to push updated keys
  // to the webview.
  planInit(
    documentUri: vscode.Uri,
    onCacheChanged: (cache: WikiCache) => void,
  ): WikiInitPlan {
    const generation = ++this.generation
    this.releaseChangeSubscription()
    const wikiRoot = this.wiki.enabled ? getWikiRoot(documentUri) : undefined
    this.lastWikiRoot = wikiRoot
    this.lastExcludeSignature = wikiRoot && wikiExcludeSignature(wikiRoot)
    this.deliveryPending = false
    if (!wikiRoot) return { payload: this.wiki, generation }
    const built = peekBuiltCache(wikiRoot)
    if (built) {
      this.subscribeChanges(built, onCacheChanged)
      return { payload: { ...this.wiki, ...keysOf(built) }, generation }
    }
    // Task 638 — a valid stored list from an earlier run is served at once as a hint; the scan below
    // revalidates it.
    const served = readStoredKeys(wikiRoot)
    this.deliveryPending = true
    return {
      payload: served ? { ...this.wiki, ...served } : this.wiki,
      pending: getOrBuildCache(wikiRoot),
      served,
      generation,
      onCacheChanged,
    }
  }

  // Resolves once the pending build finished and was handed to `post` — or was dropped because the
  // session was disposed, the root or config changed, or a newer init replaced this plan. Call it
  // after the init was posted so the keys always follow it. The watcher subscription starts here,
  // so a session disposed first never listens.
  async deliverPending(
    plan: WikiInitPlan,
    post: (keys: WikiKeys) => void,
  ): Promise<void> {
    if (!plan.pending) return
    const cache = await plan.pending
    if (this.disposed || plan.generation !== this.generation) return
    this.deliveryPending = false
    if (plan.onCacheChanged) this.subscribeChanges(cache, plan.onCacheChanged)
    const keys = keysOf(cache)
    if (plan.served && sameKeys(plan.served, keys)) return
    post(keys)
  }

  private subscribeChanges(
    cache: WikiCache,
    onCacheChanged: (cache: WikiCache) => void,
  ): void {
    this.releaseChangeSubscription()
    this.unsubscribeChanges = cache.addChangeListener(() => {
      if (!this.disposed) onCacheChanged(cache)
    })
  }

  private releaseChangeSubscription(): void {
    this.unsubscribeChanges?.()
    this.unsubscribeChanges = undefined
  }
}

// The `list-wiki-pages` command's QuickPick — showing every page under the doc's wiki
// root and opening the one the user picks. A free function (no session state needed
// beyond the document uri) rather than a WikiSession method.
export async function listWikiPages(documentUri: vscode.Uri): Promise<void> {
  const wikiRoot = getWikiRoot(documentUri)
  if (!wikiRoot) {
    return
  }
  const cache = await getOrBuildCache(wikiRoot)
  const allPages = cache.allFiles()
  const picked = await vscode.window.showQuickPick(
    allPages.map((page) => ({
      label: NodePath.basename(page.fsPath, NodePath.extname(page.fsPath)),
      description: vscode.workspace.asRelativePath(page, false),
      uri: page,
    })),
    {
      title: 'Wiki Pages',
      placeHolder: 'Select a wiki page to open',
    },
  )
  if (picked?.uri) {
    await vscode.commands.executeCommand(
      'vscode.openWith',
      picked.uri,
      MarkdownEditorViewType,
    )
  }
}
