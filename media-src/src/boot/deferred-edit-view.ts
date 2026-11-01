// Task 643 — a Preview-first open builds no edit view. Vditor's shell is constructed empty, the
// document text waits in `sessionState.deferredEditView`, and Preview renders from it. This module
// owns that state and the one-time build when the user first leaves Preview.
//
// The router (`bridge/`) may not import `boot/`, so it reads and writes `sessionState.deferredEditView`
// directly for host updates; everything that builds the edit view lives here.
import {
  STREAM_MIN_CHARS,
  streamRenderIR,
  streamRenderSV,
} from '../diagrams/stream-render'
import { reportError } from '../util/webview-log'
import {
  type DeferredCheckboxEntry,
  sessionState,
} from './editor-session-state'

/** A preview rule or a remembered Preview opens Preview first, whatever the document size. */
export function shouldOpenPreviewFirst(
  options: { defaultMode?: string } | undefined,
  rememberedPreview: boolean,
): boolean {
  return options?.defaultMode === 'preview' || rememberedPreview
}

// The router replays a toggle through its owned-history path, but it already depends on this layer
// (boot/vditor-init) for types; main.ts, the composition root, hands the function in instead.
let replayCheckbox: ((entry: DeferredCheckboxEntry) => void) | undefined

export function configureDeferredEditView(deps: {
  replay: (entry: DeferredCheckboxEntry) => void
}): void {
  replayCheckbox = deps.replay
}

export function beginDeferredEditView(text: string, mode: string): void {
  sessionState.deferredEditView = { text, mode, history: [] }
}

export function deferredEditViewPending(): boolean {
  return sessionState.deferredEditView !== null
}

export function queueDeferredCheckboxHistory(
  entry: DeferredCheckboxEntry,
): void {
  sessionState.deferredEditView?.history.push(entry)
}

/** An outside change replaces the text; checkbox history made against the old text is void. */
export function updateDeferredEditViewText(text: string): void {
  const view = sessionState.deferredEditView
  if (!view) return
  view.text = text
  view.history = []
}

let inflight: Promise<boolean> | null = null

// Large documents stream into the edit view as a Preview-less open does (task 49 / 188): held
// read-only, edit sync suspended through `sessionState.streaming`, released when the stream ends.
// Resolves true when the document is complete and the view released. On a failed stream it fails
// closed, as vditor-init does: restore the whole document first, and if that fails too keep the
// partial view locked with sync suspended, so a truncated document can never be posted as an edit.
async function streamBuild(text: string, mode: string): Promise<boolean> {
  const pub = window.vditor as any
  const inner = pub?.vditor
  const element: HTMLElement | undefined =
    mode === 'sv' ? inner?.sv?.element : inner?.ir?.element
  sessionState.streaming = true
  element?.setAttribute('contenteditable', 'false')
  element?.classList.add('vmde-streaming')
  const release = () => {
    sessionState.streaming = false
    element?.setAttribute('contenteditable', 'true')
    element?.classList.remove('vmde-streaming')
  }
  try {
    await (mode === 'sv' ? streamRenderSV : streamRenderIR)(pub, text, {
      onDone: release,
    })
    return true
  } catch (error) {
    reportError(error, 'deferred-edit-view-stream')
    try {
      pub.setValue(text)
      release()
      return true
    } catch (restoreError) {
      reportError(restoreError, 'deferred-edit-view-restore')
      return false
    }
  }
}

// An outside change that arrived while the edit view was streaming in was kept, not applied; replay
// it now (as vditor-init's endStream does) so the view does not stay on stale text.
function replayDeferredHostUpdate(): void {
  const deferred = sessionState.deferredHostUpdate
  sessionState.deferredHostUpdate = null
  if (deferred) window.postMessage(deferred, '*')
}

async function build(view: NonNullable<typeof sessionState.deferredEditView>) {
  // Build from the text the first queued toggle started from; replay then walks to the current text.
  const start = view.history[0]?.before ?? view.text
  if (start.length > STREAM_MIN_CHARS) {
    // A locked partial view stays as it is: nothing is replayed, seeded or posted from it.
    const complete = await streamBuild(start, view.mode)
    if (!complete)
      return true
      // The undo history starts fresh, as the small path's setValue(start, true) does.
    ;(window.vditor as any).clearStack?.()
  } else {
    sessionState.applyingExtensionUpdate = true
    try {
      ;(window.vditor as any).setValue(start, true)
    } finally {
      // The edit view's own input events settle on the next task, as for an outside update.
      setTimeout(() => {
        sessionState.applyingExtensionUpdate = false
      }, 0)
    }
  }
  for (const entry of view.history) replayCheckbox?.(entry)
  sessionState.editSync?.invalidate()
  sessionState.editSync?.startIncrementalSeed()
  replayDeferredHostUpdate()
  return true
}

/** Build the edit view once, when the user first leaves Preview. Resolves true when this call built
 *  it, false when it was already built (or never deferred). */
export function ensureEditView(): Promise<boolean> {
  if (inflight !== null) return inflight
  const view = sessionState.deferredEditView
  if (!view) return Promise.resolve(false)
  // Cleared first: from here an outside update takes the ordinary (or streaming-deferred) path.
  sessionState.deferredEditView = null
  inflight = build(view).finally(() => {
    inflight = null
  })
  return inflight
}
