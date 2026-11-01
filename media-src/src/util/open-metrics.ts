// Task 643 — open timings for the real-VS-Code timing spec. `window.__vmdeOpenMetrics` is read by
// tests only; the product never reads it back except to notice that a render has completed
// (nav/reading-position.ts). Times are `performance.now()` of the webview document.
export interface OpenMetrics {
  /** The `init` message reached the webview. */
  initReceivedMs?: number
  /** Which surface the document opened in. */
  surface?: string
  /** Content is in the DOM and visible. */
  contentVisibleMs?: number
  /** The open's rendering work has finished. */
  completeMs?: number
  /** Preview: time to plan the chunks, and to render the first one. */
  renderStartMs?: number
  planMs?: number
  firstUnitMs?: number
  previewChunks?: number
  previewMaxChunkMs?: number
}

type MetricsWindow = Window & { __vmdeOpenMetrics?: OpenMetrics }

export const openClock = (): number =>
  typeof performance !== 'undefined' ? performance.now() : Date.now()

/** Add fields to the current open's metrics. */
export function recordOpenMetrics(fields: OpenMetrics): void {
  const target = window as MetricsWindow
  target.__vmdeOpenMetrics = { ...target.__vmdeOpenMetrics, ...fields }
}

/** Start the metrics of a new open (an `init`), dropping the previous open's. */
export function resetOpenMetrics(fields: OpenMetrics): void {
  ;(window as MetricsWindow).__vmdeOpenMetrics = { ...fields }
}

/** Record `field` as the time of the second animation frame from now: the first frame has run its
 *  style and layout work for the DOM written so far, so the time means "painted", not "in the DOM".
 *  Every surface uses it, so open times compare like with like. */
export function recordAfterPaint(field: 'contentVisibleMs' | 'completeMs') {
  requestAnimationFrame(() =>
    requestAnimationFrame(() => recordOpenMetrics({ [field]: openClock() })),
  )
}
