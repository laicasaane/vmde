import type * as vscode from 'vscode'

// Task 405 — extracted out of MarkdownEditorProvider (was `static activePanels` /
// `static findPanelForUri`) so EditorSession can reference the live-panel registry
// WITHOUT importing MarkdownEditorProvider — MarkdownEditorProvider is the one that
// constructs EditorSession, so the other direction would be a circular import between
// editor-session.ts and markdown-editor-provider.ts. Mirrors host-session-state.ts: a
// plain shared module, not a class. MarkdownEditorProvider keeps `static activePanels`/
// `static findPanelForUri` as aliases onto these same values for backward compatibility
// (test-facing API, commands.ts's injected `findPanelForUri`).
export interface ActivePanelEntry {
  panel: vscode.WebviewPanel
  uri: vscode.Uri
  ready?: boolean
  moveOutlineSection?: (
    source: { start: number; level: number },
    target: { start: number; level: number },
    placement: 'before' | 'after',
  ) => void
}

// Live registry of open VMDE panels (task 16). Commands like revealInSource need the
// focused panel + its document; CustomTextEditorProvider gives us no singleton, so we
// track them here and pick the active one.
export const activePanels = new Set<ActivePanelEntry>()

export function findPanelForUri(uri: vscode.Uri): ActivePanelEntry | undefined {
  const want = uri.toString()
  let newest: ActivePanelEntry | undefined
  for (const entry of activePanels) {
    if (entry.uri.toString() === want) newest = entry
  }
  return newest
}
