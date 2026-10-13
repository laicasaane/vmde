import * as vscode from 'vscode'
import * as NodePath from 'node:path'
import {
  getWikiDocumentContext,
  getWikiRoot,
  type WikiDocumentContext,
} from './wiki'
import {
  getOrBuildCache,
  invalidateCache,
  peekBuiltCache,
  type WikiCache,
} from './wiki-cache'
import { MarkdownEditorViewType } from '../shared/product-identity'

interface WikiKeys {
  pageKeys: string[]
  displayNames: string[]
}

type WikiInitPayload = WikiDocumentContext & Partial<WikiKeys>

// What an `init` carries for the wiki: the payload to post now, and — only when the keys are not
// built yet — the build to deliver later through `deliverPending`.
interface WikiInitPlan {
  payload: WikiInitPayload
  pending?: Promise<WikiCache>
  // Internal to WikiSession: the generation this plan belongs to and the watcher callback to
  // subscribe once the pending build resolves.
  readonly generation: number
  readonly onCacheChanged?: (cache: WikiCache) => void
}

const keysOf = (cache: WikiCache): WikiKeys => ({
  pageKeys: cache.allPageKeys(),
  displayNames: cache.allDisplayNames(),
})

// Task 405 — the per-EditorSession wiki state (`this.wiki` + `this.lastWikiRoot`) and the
// init-payload/config-change logic that read/write it, extracted out of EditorSession.
// Cross-folder RENAME does NOT refresh the context — a documented Phase-1 limit — so
// there is deliberately no rename hook here, only onConfigChanged.
export class WikiSession implements vscode.Disposable {
  private wiki: WikiDocumentContext
  private lastWikiRoot: vscode.Uri | undefined
  // Task 636 — bumped by every init plan and config change, and by dispose: a delivery that finds
  // a newer value belongs to an older init or root and is dropped.
  private generation = 0
  private disposed = false
  // The watcher change subscription (cache file create/delete). One at a time, released on dispose
  // so it does not outlive the panel.
  private unsubscribeChanges: (() => void) | undefined

  constructor(documentUri: vscode.Uri) {
    this.wiki = getWikiDocumentContext(documentUri)
  }

  get context(): WikiDocumentContext {
    return this.wiki
  }

  // A wiki CONFIG change (enabled/root) invalidates the old per-root cache (so the
  // re-init that follows builds a fresh one for the potentially-changed root) and
  // recomputes the context.
  onConfigChanged(documentUri: vscode.Uri): void {
    this.generation++
    this.releaseChangeSubscription()
    if (this.lastWikiRoot) {
      invalidateCache(this.lastWikiRoot)
      this.lastWikiRoot = undefined
    }
    this.wiki = getWikiDocumentContext(documentUri)
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
    if (!wikiRoot) return { payload: this.wiki, generation }
    const built = peekBuiltCache(wikiRoot)
    if (built) {
      this.subscribeChanges(built, onCacheChanged)
      return { payload: { ...this.wiki, ...keysOf(built) }, generation }
    }
    return {
      payload: this.wiki,
      pending: getOrBuildCache(wikiRoot),
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
    if (plan.onCacheChanged) this.subscribeChanges(cache, plan.onCacheChanged)
    post(keysOf(cache))
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
