// Task 643 — the document text the webview holds. A Preview-first open builds no edit view, so
// `vditor.getValue()` is empty until the user first leaves Preview; the exact source then comes from
// the Preview snapshot hook (installed by editing/preview-state.ts), which serves the held text.
export function liveDocumentText(vditor: { getValue?: () => string }): string {
  const live = vditor.getValue?.() ?? ''
  // An empty edit view reads as a bare newline, not as ''.
  if (live.trim() !== '') return live
  const snapshot = (
    window as unknown as { __vmdePreviewSnapshot?: () => string }
  ).__vmdePreviewSnapshot
  return snapshot?.() ?? live
}
