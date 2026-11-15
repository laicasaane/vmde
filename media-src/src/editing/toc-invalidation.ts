import {
  classifyAndRecordEditorSurfaceMutations,
  forEachChangeScope,
  onLiveChange,
  recordHelperMutationPass,
  recordsOutsideFeed,
  type EditorMutationImpact,
} from '../util/mutation-impact'
import type { UnitsChange } from '../util/unit-changes'
import { reportError } from '../util/webview-log'

const HEADING_OR_TOC_SELECTOR =
  'h1, h2, h3, h4, h5, h6, [data-type="toc-block"]'

type RenderTocRequest = {
  vditor: unknown
  renderToc: (vditor: unknown) => void
}

type DeferUntilSettle = (key: string, callback: () => void) => void

interface TocInvalidationStats {
  requests: number
  invalidations: number
  skippedImpacts: number
  refreshes: number
  failures: number
}

type TocInvalidationWindow = Window & {
  __vmdeE2EReadiness?: unknown
  __vmdeTocInvalidationStats?: TocInvalidationStats
}

function e2eStats(): TocInvalidationStats | null {
  const win = window as TocInvalidationWindow
  if (!win.__vmdeE2EReadiness) return null
  win.__vmdeTocInvalidationStats ??= {
    requests: 0,
    invalidations: 0,
    skippedImpacts: 0,
    refreshes: 0,
    failures: 0,
  }
  return win.__vmdeTocInvalidationStats
}

function outsideEditorPanelMutation(record: MutationRecord): boolean {
  const target =
    record.target.nodeType === Node.ELEMENT_NODE
      ? (record.target as Element)
      : record.target.parentElement
  return Boolean(target?.closest('.vditor-panel'))
}

function insideRenderedTocMutation(record: MutationRecord): boolean {
  const target =
    record.target.nodeType === Node.ELEMENT_NODE
      ? (record.target as Element)
      : record.target.parentElement
  return Boolean(target?.closest('[data-type="toc-block"]'))
}

function classifyTocMutationRecords(
  records: MutationRecord[],
): EditorMutationImpact | null {
  const contentRecords = records.filter(
    (record) =>
      !outsideEditorPanelMutation(record) && !insideRenderedTocMutation(record),
  )
  if (contentRecords.length === 0) {
    recordHelperMutationPass('toc-invalidation', records, 'skipped')
    return null
  }
  return (
    classifyAndRecordEditorSurfaceMutations('toc-invalidation', contentRecords)
      ?.impact ?? null
  )
}

function hasTocConsumer(vditor: unknown): boolean {
  if (!vditor || typeof vditor !== 'object') return true
  const state = vditor as {
    currentMode?: string
    options?: { outline?: { enable?: boolean } }
    [mode: string]: unknown
  }
  // Incomplete test doubles are ambiguous and retain stock behavior. Real Vditor options carry an
  // explicit false when the native outline is disabled.
  if (state.options?.outline?.enable !== false) return true
  const modeState = state.currentMode
    ? (state[state.currentMode] as { element?: HTMLElement } | undefined)
    : undefined
  return Boolean(modeState?.element?.querySelector('[data-type="toc-block"]'))
}

export function tocImpactRequiresRefresh(
  impact: EditorMutationImpact,
): boolean {
  if (impact.full || impact.modeRebuild || impact.topLevelChanged) return true
  return [...impact.blocks].some(
    (block) =>
      block.matches(HEADING_OR_TOC_SELECTOR) ||
      block.querySelector(HEADING_OR_TOC_SELECTOR) !== null,
  )
}

function touchesHeadingOrToc(element: Element): boolean {
  return (
    element.matches(HEADING_OR_TOC_SELECTOR) ||
    element.closest('[data-type="toc-block"]') !== null ||
    element.querySelector(HEADING_OR_TOC_SELECTOR) !== null
  )
}

/** Task 733 (D-13 B-11): a feed change decides from its scope elements and structural tops (heading
 * or not); it never reads the root. A whole change always refreshes. */
function changeRequiresRefresh(change: UnitsChange): boolean {
  if (change.whole) return true
  for (const top of change.structural) if (touchesHeadingOrToc(top)) return true
  let found = false
  forEachChangeScope(change, (element) => {
    if (!found && touchesHeadingOrToc(element)) found = true
  })
  return found
}

type TocMutationDecision =
  | 'refresh'
  | 'irrelevant'
  | 'unbound'
  | 'no-consumer'
  | 'already-attempted'

function decideTocMutation(
  requiresRefresh: boolean,
  request: RenderTocRequest | undefined,
  requestRevision: number,
  attemptedRevision: number,
): TocMutationDecision {
  if (!requiresRefresh) return 'irrelevant'
  if (!request) return 'unbound'
  if (!hasTocConsumer(request.vditor)) return 'no-consumer'
  if (requestRevision <= attemptedRevision) return 'already-attempted'
  return 'refresh'
}

/** Keep Vditor's patched input hook as the coalescing boundary, but arm it only after the delivered
 * mutation batch proves that heading ids, outline rows, or an embedded ToC can change. */
export function installTocInvalidation(
  root: HTMLElement,
  defer: DeferUntilSettle,
): {
  request: (vditor: unknown, renderToc: (vditor: unknown) => void) => void
  didRender: (vditor: unknown, refreshed?: boolean) => void
  dispose: () => void
} {
  let invalid = false
  let latestRequest: RenderTocRequest | undefined
  let requestRevision = 0
  let attemptedRevision = 0
  let composing = false
  const stats = e2eStats()

  const schedule = (): void => {
    if (
      composing ||
      !invalid ||
      !latestRequest ||
      requestRevision <= attemptedRevision
    )
      return
    defer('renderToc', () => {
      if (!invalid || !latestRequest || requestRevision <= attemptedRevision)
        return
      attemptedRevision = requestRevision
      try {
        latestRequest.renderToc(latestRequest.vditor)
        invalid = false
        observer.takeRecords()
      } catch (error) {
        if (stats) stats.failures++
        invalid = true
        reportError(error, 'toc-invalidation: renderToc')
        throw error
      }
    })
  }

  const decide = (requiresRefresh: boolean): void => {
    const decision = decideTocMutation(
      requiresRefresh,
      latestRequest,
      requestRevision,
      attemptedRevision,
    )
    // The observer is installed after Vditor's initial render, before the first input hook has
    // supplied renderToc. Async open-time preview/chrome work can still fail closed as `full`; do
    // not carry that unrenderable lifecycle noise into the first ordinary edit. A real user input
    // registers its request synchronously before its mutation batch, while later mode/external
    // changes retain the last known callback.
    if (decision === 'no-consumer') {
      if (stats) stats.skippedImpacts++
      attemptedRevision = requestRevision
      invalid = false
      observer.takeRecords()
      return
    }
    if (decision !== 'refresh') {
      if (stats) stats.skippedImpacts++
      return
    }
    if (stats) stats.invalidations++
    invalid = true
    schedule()
  }

  // Task 733 (D-13 binding rule 6): while a live feed describes this root, its changes carry the
  // edits inside the feed root; the observer keeps only the records outside it (panels, Preview).
  const observer = new MutationObserver((batch) => {
    const records = recordsOutsideFeed(root, batch)
    if (records.length === 0) return
    // WYSIWYG rebuilds its contextual button panel alongside ordinary content. That panel is Vditor
    // chrome outside every reset surface; its rows cannot affect heading ids or either ToC consumer.
    const impact = classifyTocMutationRecords(records)
    if (!impact) return
    decide(tocImpactRequiresRefresh(impact))
  })
  const offFeed = onLiveChange(root, (change) =>
    decide(changeRequiresRefresh(change)),
  )
  observer.observe(root, {
    characterData: true,
    childList: true,
    subtree: true,
  })
  const ownerDocument = root.ownerDocument
  const onCompositionStart = (): void => {
    composing = true
  }
  const onCompositionEnd = (): void => {
    composing = false
    schedule()
  }
  ownerDocument.addEventListener('compositionstart', onCompositionStart, true)
  ownerDocument.addEventListener('compositionend', onCompositionEnd, true)

  return {
    request: (vditor, renderToc) => {
      if (stats) stats.requests++
      requestRevision++
      latestRequest = { vditor, renderToc }
      if (!composing) schedule()
    },
    didRender: (_vditor, refreshed = true) => {
      if (stats && refreshed) stats.refreshes++
      attemptedRevision = requestRevision
      invalid = false
      observer.takeRecords()
    },
    dispose: () => {
      observer.disconnect()
      offFeed()
      ownerDocument.removeEventListener(
        'compositionstart',
        onCompositionStart,
        true,
      )
      ownerDocument.removeEventListener(
        'compositionend',
        onCompositionEnd,
        true,
      )
      latestRequest = undefined
      requestRevision = 0
      attemptedRevision = 0
      invalid = false
      composing = false
    },
  }
}
