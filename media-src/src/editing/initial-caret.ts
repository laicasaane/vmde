// Task 439 — place the caret when a genuinely EMPTY document opens, instead of leaving it
// wherever Vditor's init happened to land (nowhere, per the probe below).
//
// MEASURED (real VS Code, IR mode, empty AND with-text fixtures — identical, see
// test/vscode-e2e/caret-on-open-probe.spec.ts): document.activeElement === BODY (editor never
// focused) and getSelection().rangeCount === 0 (no Range exists ANYWHERE), stable across
// T0/+500ms/+2.5s. So this function CREATES a selection — there is nothing to relocate.
//
// SCOPE (revised): the user only wants this for an empty file — the "ready to type" case. A
// document with any content must be left exactly at that measured baseline: no selection, no
// focus. This also means there is never anything to scroll (an empty document has no scroll
// range), so this module has no scroll-correction logic at all.
//
// The first cut of this SHIPPED BROKEN — the caret was placed but never painted: it anchored the
// Range on an empty container (no first block existed yet), and three DOM-only probes called it
// healthy because they never measured whether a caret could be DRAWN. ADR-0007 / task 446 closed
// the defect class structurally instead of patching this one site: gap-paragraph.ts's leading-
// block invariant now guarantees a first block always exists (this module no longer creates one
// itself — that was the caret code "reasoning about document shape" the ADR calls out), and the
// actual Range write + re-assert-until-painted loop lives in caret.ts's 'document-start' intent.
import { requestCaret } from './caret'
import { activeModeElement } from '../util/source-map'

// One-shot per webview instance. `config-changed` re-inits Vditor and re-runs runFinishInit
// (finish-init.ts), which calls placeInitialCaret again — a live re-init must PRESERVE the
// user's current caret mid-edit, not jump them back to the document start, so every call after
// the first is a no-op.
let placed = false

/**
 * For a genuinely empty document only: collapse the selection to offset 0 of the editable's
 * first block, and focus the editor (when the webview already has focus). A document with any
 * content is left untouched — no selection, no focus. Runs once per webview instance; every
 * later call is a no-op. Returns true if it placed the caret, false otherwise (already decided,
 * no editable element, the document has content, or an existing in-editor caret was left alone).
 */
export function placeInitialCaret(
  vditor: unknown,
  initialMarkdown?: string,
): boolean {
  if (placed) return false
  // Whichever mode the document opened in (IR is the must-fix; WYSIWYG/sv get it for free —
  // activeModeElement already resolves the current mode's editable, see source-map.ts).
  const editor = activeModeElement(vditor)
  if (!editor) return false

  // The host-provided initial bytes already answer the common nonempty case without Lute's
  // full-document serializer. Keep the live fallback below for empty/unknown input, where a user
  // may have typed before this initialization step runs.
  if (initialMarkdown !== undefined && /\S/u.test(initialMarkdown)) {
    placed = true
    return false
  }

  // Emptiness is a CONTENT question, not a DOM-shape guess: Lute always serialises a trailing
  // newline, so a truly empty file's value is '\n', not '' — trim before comparing so a
  // whitespace-only file counts as empty too. Anything else is a real document: leave it at the
  // measured baseline (no selection, no focus) and consume the one-shot without acting.
  const value =
    (vditor as { getValue?: () => string } | null)?.getValue?.() ?? ''
  if (value.trim() !== '') {
    placed = true
    return false
  }

  // Defensive guard: never yank a caret that already exists inside the editable — some other
  // init step (or a fast user click before this runs) may have placed one first. This function
  // only ever CREATES a selection where none exists (per the measured rangeCount === 0 above).
  const existing = window.getSelection()
  if (
    existing &&
    existing.rangeCount > 0 &&
    existing.isCollapsed &&
    editor.contains(existing.getRangeAt(0).startContainer)
  ) {
    placed = true
    return false
  }

  placed = true

  // The actual Range write — and the "keep retrying until it's actually PAINTABLE" loop that 439
  // was missing (see the file header) — now lives in caret.ts's 'document-start' intent
  // (ADR-0007 / task 446). gap-paragraph.ts's leading-block invariant (task 446 Part 1, wired
  // before this call in finish-init.ts) guarantees a first block already exists, so this function
  // no longer creates one itself — that was exactly the "caret code reasoning about document
  // shape" the ADR moved out.
  const wasPlaced = requestCaret('document-start')

  // Focus only when the webview itself currently has focus. If it does not (a restored-but-
  // inactive tab reopened in the background), leave focus alone: focus-restore.ts's window-focus
  // handler bails today (focus-restore.ts:65, "NOTHING to restore") precisely because no Range
  // exists yet for it to restore — now that this sets one, the moment the webview regains focus
  // it will focus this editable for us, so there is no need to steal focus here. Because this
  // path only runs for an empty document, taking focus here is unambiguously "the user opened a
  // blank file to type into it" — never a real document the user might not want touched.
  if (wasPlaced && document.hasFocus()) {
    editor.focus({ preventScroll: true })
  }

  return wasPlaced
}

// Test-only seam: vitest needs each test to start from the pre-open state, unlike the real
// webview where the one-shot gate must persist across a config-changed re-init.
export function resetInitialCaretForTests(): void {
  placed = false
}
