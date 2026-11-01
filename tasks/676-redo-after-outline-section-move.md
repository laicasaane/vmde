# Task 676 — Redo after an outline section move does not reapply the move

**Status:** planned (2026-11-01). Filed at the close of Task 669; waits for a future batch.
**Origin:** Task 669 (step B2).
**Severity:** medium (estimated; Undo works, Redo leaves the original order).
**Tech stack:** `media-src/src/nav/outline-move-routes.ts`, `media-src/src/boot/main.ts` (outline wiring), `src/session/editor-session.ts`, `test/vscode-e2e/outline-reorder.spec.ts`.
**Depends on:** none.

## Problem

In IR, after a webview outline drag or an outline-tree move of a section, one Undo restores the original order, but Redo (VS Code's redo key) leaves the host text in the original order. `outline-reorder.spec.ts:15` fails at `:108` and `outline-reorder.spec.ts:187` at `:276` (OS keys). Measured on unchanged `dev` before Task 668 integrated (`90611a6b`) and again after Tasks 667 and 669 (`5aaf5d16`), with the same message: the expected `# B` section first is not restored.

## Proposed work

Find where Redo loses the exact-history transition that the outline routes record (the host-planned handshake of Task 630, the native Undo record committed by the webview route), and make Redo reapply the move exactly once, with the host, the editor text and the saved bytes agreeing. Keep the stale-drop protections of Task 668.

## Tests to write

- Vitest for the history transition of the outline route (record, undo, redo) in the route's testable state machine.
- Real VS Code: keep `outline-reorder.spec.ts:15` and `:187`, which must pass.
