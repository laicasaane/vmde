# Task 674 — Callout apply: native Undo is a no-op in real VS Code

**Status:** planned (2026-11-01). Filed at the close of Task 671; waits for a future batch.
**Origin:** Task 671 (decision of 2026-11-01), Owner decision of 2026-10-08 (a failure with a different mechanism gets its own record).
**Severity:** medium (estimated; measured in real VS Code, IR and WYSIWYG).
**Tech stack:** `media-src/src/editing/callouts.ts`, `test/vscode-e2e/exact-authority-other-actions.spec.ts`.
**Depends on:** Task 671.

## Problem

After a callout apply on a document, the host text, the saved file and Save are exactly right. A native Ctrl+Z then leaves the host text unchanged (it still equals the action result), and Redo leaves it unchanged too. One native Undo should restore the typed state and Redo should reapply the callout.

Measured in the `callout-apply` case (a unique paragraph on the normalizing fixture) and the `callout-duplicate-line` case of `exact-authority-other-actions.spec.ts`, in IR and WYSIWYG. It fails the same way on the product code from before Task 671's proof-path change and after it, so that change is not the cause.

The Details toggle on the same fixture passes the same Undo check. It uses the same action dependencies (exact-authority acquisition, guarded exact post, applying flag in `boot/main.ts`) and the same Undo checkpoints (`addToUndoStack` before `setValue` and after the marker is removed).

## Candidate causes (not tested)

- The callout apply places its caret through a deferred `requestCaret` (an armed caret intent). The Details toggle retires the intent and writes the selection directly.
- The callout dual-node observer re-renders the block quote after `setValue`, which may move the native Undo state.
- The action runs from the callout toolbar panel, and focus returns to the editor afterwards.

## Proposed work

Find the cause with a focused real-VS-Code probe that compares the callout apply with the Details toggle (native Undo state after the action, caret intent, dual-node re-render), then fix it in the callout apply path.

## Acceptance

- One native Undo restores the typed state and Redo reapplies the callout, in IR and WYSIWYG, for `callout-apply` and `callout-duplicate-line`.
- Remove the `knownUndoFailure: 'Task 674'` flag from both cases in `exact-authority-other-actions.spec.ts`. The flag makes an unexpectedly passing Undo fail the case, so it must be removed with the fix.
- [ ] Focused real-VS-Code spec written and run; quality stages pass.
