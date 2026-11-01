# Task 688 — Other first-checkpoint actions may share the outline move's missing undo starting point

**Status:** planned (2026-11-01). Filed at the close of Task 676 (residual).
**Origin:** Task 676 (Problem and Residuals).
**Severity:** low to medium (estimated; unmeasured for every action other than the outline move, where Redo was a no-op).
**Tech stack:** `media-src/src/editing/rewrap-command.ts` (`checkpointEditorUndo`), `media-src/src/editing/undo-keybind.ts` (`addToUndoStack` and `vmdeSeedBaseline` wrappers), `media-src/src/nav/outline-move-routes.ts` (`seedHistory`), `media-src/src/boot/main.ts` (`seedHistory` wiring), and the callers of `checkpointEditorUndo` and `addToUndoStack` in `media-src/src/editing/`, `media-src/src/bridge/message-router.ts`, `media-src/src/boot/main.ts` and `media-src/src/nav/section-hoist.ts`.
**Depends on:** none.

## Problem

In Task 676 the outline move created the first entry of an empty Vditor history. The host then read a false history base (the moved text paired with the original host text), and Redo was a no-op. Task 676 fixed only the outline route, by seeding an empty history first (`seedHistory`) and leaving the shared checkpoint helper unchanged.

Other actions whose first checkpoint creates the first entry of an empty history may share the same false base. This is not measured. Callers to inventory (lines as of `dc622900`):

- `media-src/src/editing/list-normalize-source-command.ts:411` and `:418`
- `media-src/src/editing/html-subscript-command.ts:677` and `:709`
- `media-src/src/editing/id-insertion.ts:320` and `:331`
- `media-src/src/editing/table-actions.ts:269`
- `media-src/src/editing/rewrap-command.ts:979`, `:1105` and `:1121`
- `media-src/src/editing/block-action-client.ts:286` and `:288`
- `media-src/src/editing/callouts.ts:632`
- `media-src/src/bridge/message-router.ts:252` and `:268`
- `media-src/src/boot/main.ts:335` and `:337`
- `media-src/src/nav/section-hoist.ts:252`

## Proposed work

1. Inventory every action that records a checkpoint on a possibly empty history (grep `checkpointEditorUndo` and `addToUndoStack` callers; confirm which are reachable as the first action after open).
2. For each, measure Undo and then Redo as the first action after open. Record the result per action: correct, or false base (Redo no-op or wrong text).
3. Fix only the failing actions, each with a failing test first, the same way as Task 676 (seed the empty history before the action's first write). If more than one action fails, decide whether one shared seed in the checkpoint helper is smaller, and record the reason.

## Acceptance

- [ ] An inventory lists each action with a measured result for Undo then Redo as the first action after open.
- [ ] Each failing action has a failing test first and is fixed; Undo restores the typed state and Redo reapplies the action exactly once, with the host text, the editor text and the saved bytes agreeing.
- [ ] If no action fails, the inventory is recorded as the result and no product code changes.
- [ ] Real VS Code: a focused case for each fixed action (Undo then Redo as the first action after open) written and run.
- [ ] The outline move cases of Task 676 still pass.

## Tests to write

- Vitest per fixed action (the history is seeded before the first write on an empty history; a non-empty history is not reseeded).
- Real VS Code: one case per fixed action, opening the document and running the action before any typing (batch with the other real-VS-Code specs of the round).
