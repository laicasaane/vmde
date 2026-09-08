// Typed accessor for the Vditor INTERNAL instance (window.vditor.vditor — Vditor's
// own IVditor, which the published `vditor` types don't expose). main.ts reached it
// ~11× via `(window.vditor as any).vditor.<x>`; this centralises those casts behind
// one documented surface (task 152 item 2) covering only the internals we touch, so a
// Vditor shape change surfaces here instead of at every call site.
export interface InnerVditor {
  // Active edit surface. Read by readiness reporting after finish-init so tests can distinguish
  // rendered DOM from a fully wired editor lifecycle.
  currentMode?: string
  ir?: {
    element?: HTMLElement
    processTimeoutId?: number
    composingLock?: boolean
  }
  // `popover` is the floating block-popover panel (∧ ∨ 🗑 + our appended callout type/title
  // controls, callouts.ts's `calloutWysiwygToolbar`) — a SIBLING of `element`, not a descendant, so
  // it sits outside the Tab-trapped contenteditable surface. Task 459 needs it to focus the
  // callout's popover controls from a caret-triggered keyboard chord (Tab can't reach it — same
  // trap task 456/457 already document).
  wysiwyg?: {
    element?: HTMLElement
    popover?: HTMLElement
    afterRenderTimeoutId?: number
  }
  sv?: { element?: HTMLElement; processTimeoutId?: number }
  // `element` (the overlay container, whose inline `display` flips block/none when the full
  // Preview is toggled) is read by outline.ts's `scrollToHeadingIndex` to tell whether headings
  // should be looked up in `previewElement` or the active IR/WYSIWYG element — task 458.
  preview?: {
    element?: HTMLElement
    previewElement?: HTMLElement
    render?: (vditor: InnerVditor) => void
  }
  outline?: { element?: HTMLElement }
  // `element` is the toolbar's own container div (`.vditor-toolbar`) — task 456 needs it to set
  // role="toolbar" + roving tabindex and to scope its Arrow-key traversal. Read via this typed
  // accessor rather than `document.querySelector('.vditor-toolbar')`: the instant-paint prerender
  // overlay (prerender-overlay.ts) clones the toolbar into `#vmde-prerender .vditor-toolbar` for
  // the Lute-wait teaser, so a bare selector can hit a dead clone instead of the live toolbar.
  toolbar?: { element?: HTMLElement; elements?: Record<string, HTMLElement> }
  options?: { undoDelay?: number; cdn?: string }
  // Vditor's undo engine (undo/index.ts) — `undo(vditor)`/`redo(vditor)` take the SAME inner
  // instance they're called on (editing/undo-keybind.ts's `runVditorHistory` and Phase 4's
  // `handleTriggerToolbarHotkey`, message-router.ts, both call it this way). Exposed here rather
  // than clicking the toolbar Undo/Redo button: that button's disabled state only reflects the
  // undo stack after Vditor's own `undoDelay` debounce (Options.ts, 800ms) settles, so a click can
  // be a stale no-op right after an edit — the direct engine call is what the keyboard shortcut
  // already does and has no such lag.
  undo?: {
    undo?: (vditor: unknown) => void
    redo?: (vditor: unknown) => void
    addToUndoStack?: (vditor: unknown) => void
  }
  lute?: {
    VditorIRDOM2Md(html: string): string
    VditorDOM2Md(html: string): string
    FormatStr?(origin: string, markdown: string): string
  }
}

/** The Vditor internal instance, or null before the first init. */
export function innerVditor(): InnerVditor | null {
  return (
    (window.vditor as unknown as { vditor?: InnerVditor } | null)?.vditor ??
    null
  )
}
