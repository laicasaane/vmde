# Task 685 — Tab stays modified after Undo of an exact action to the saved bytes

**Status:** planned (2026-11-01). Filed at the close of Task 673; waits for a future batch.
**Origin:** Task 673.
**Severity:** low to medium (estimated; the text is correct, only the dirty marker is wrong).
**Tech stack:** `src/writeback/writeback-controller.ts`, `src/writeback/history-coupling.ts`, `src/session/editor-session.ts`, `test/vscode-e2e/exact-action-neutral-bytes.spec.ts`.
**Depends on:** none.

## Problem

Two related gaps around Undo of an exact action (a source transaction such as Source-mode Format Table).

1. **The tab stays modified.** In real VS Code, Source mode opened directly: Format Table, type a character in another paragraph, Undo, Undo. The host text equals the saved bytes again, but the tab still shows as modified. Measured twice:
   - a control without the typing: Format Table, then Undo, host text equals the saved bytes, `isDirty` stays true;
   - eight samples over eight seconds after the second Undo: document version stable (5), `isDirty` true, text equal to the saved bytes, no save events.
   The same setup with plain typing and a single Undo is clean, and so is Undo after a Save that followed the action. The cause is not established (VS Code's saved version is not restored by the Undo of the exact write, or a later own write replaces the undo element; not measured). The behaviour is the same with and without Task 673's change, so it predates it.

2. **Plain-fallback Undo of a neutral exact result.** While an exact write is active (Task 673's `exactWriteSinceBaseline`), the semantic no-op repair is off, so a webview Undo that falls back to a plain write cannot remove a neutral exact result (for example table padding): the document keeps the padding and stays modified. Native history coupling is the normal path and works; the fallback is taken only when the coupling refuses a transition.

## Proposed work

1. Measure why the tab stays modified: log document version, `isDirty` and the undo-stack effect of each own write around the exact write and its Undo (the host-side own writes in `writeback-controller.ts` and `history-coupling.ts`). Decide the smallest change that makes the tab clean once the text equals the saved bytes.
2. Decide how the plain-fallback Undo should remove a neutral exact result, or record why it cannot.
3. Add a real-VS-Code case to `exact-action-neutral-bytes.spec.ts`: Format Table, typing, Undo, Undo ends with the saved bytes and a clean tab.

## Acceptance

- [ ] The cause of the modified tab after Undo of an exact action is measured and recorded.
- [ ] After Format Table, typing, Undo, Undo, the host text equals the saved bytes and the tab is clean.
- [ ] The plain-fallback Undo of a neutral exact result is fixed, or the record states why it cannot be.
- [ ] Focused real-VS-Code spec written and run; the quality stages pass.
