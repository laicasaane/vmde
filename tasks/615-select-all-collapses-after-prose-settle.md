# Task 615 — Keep a selection made within the prose-settle window after a keystroke

**Status:** planned (2026-10-05). The Project Owner approved filing this record on 2026-10-05. The Project Owner decided the approach on 2026-10-08, so the task is unblocked (see Owner decisions). Implementation has not started.
**Origin:** [Task 613](done/613-select-all-collapses-after-undo-snapshot.md) follow-up 1, measured in real VS Code during that task.
**Severity:** medium. Select All shortly after typing silently becomes a caret at the document start, so a following Delete or type-over edits the wrong place.
**Scope:** IR. The deferred prose re-spin of `media-src/src/editing/edit-activity.ts` (Tasks 175/180) and the selection it runs on. Keep Task 613's undo-snapshot fix and the Task 175/180 typing performance contract.

## Problem

Type one character in IR prose, then run Select All (`vmde.selectAll`, Ctrl+A) within about 220 ms. The whole-document selection collapses to a caret at the document start. This happens before Vditor's undo snapshot, so Task 613's fix does not cover it.

## Measured evidence

Real VS Code 1.129.0, Task 613 build (based on HEAD `91befe15`):

- `Z` was typed at 257 ms. Select All landed at 293 ms.
- At 485 ms the selection collapsed. The stack was `setSelectionFocus` ← `setRangeByWbr` ← IR `input` ← `edit-activity.ts:115`.
- Vditor's undo snapshot ran later, at about 1280 ms.

The Chromium harness does not install `edit-activity`, so it does not reproduce this. The real-VS-Code test `test/vscode-e2e/structural-selection.spec.ts` works around the window: it stages Select All 300 ms after the keystroke (`PROSE_SETTLE_MS`, `:510-513`) and asserts that the snapshot is still pending.

## Reproduction

1. Open a multi-paragraph document in IR and place the caret in a prose paragraph.
2. Type one character.
3. Within 220 ms, press Ctrl+A until the whole document is selected.
4. Wait 300 ms. The selection is a caret at the document start.
5. Press Delete. The edit does not remove the document.

## Suspected cause

- `trySkipFenceSpin` (`media-src/src/editing/edit-activity.ts:88`) skips Vditor's spin for a one-code-point prose keystroke (Task 180, `:100-103`).
- It defers a re-spin with `deferUntilSettle` and `QUIET_MS = 220` (`:36`). The re-spin dispatches a synthetic `input` event on `vditor.ir.element` (`:115`).
- Vditor's IR `input()` then runs on the live selection, not the selection of the keystroke. A whole-document Range has no block, so Vditor inserts a `<wbr>` at `(root, 0)`, and `setRangeByWbr` collapses the selection to the document start.
- Any non-collapsed selection made in the window may be affected. Only Select All was measured.

## Candidate approaches

1. Run the pending settle re-spin before a selection command (Select All, Expand Selection) acts, so the command selects the settled DOM.
2. Save the live selection before the deferred `input` and restore it afterwards, as Task 613 did for the undo snapshot.
3. Re-spin against the keystroke's own block instead of the live selection.

## Owner decisions (2026-10-08)

Approved in chat by the Project Owner.

- Approach 3: the deferred prose re-spin targets the block the keystroke edited, then restores the user's current live selection.
- The fix covers Select All, Shift+arrows and pointer drags.
- Keep Task 613's fix and the Task 175/180 typing-performance contract.

Coordinate with [Task 601](done/601-undo-before-pending-checkpoint.md), which also needs to settle the prose delay before Undo.

## Tests

- **Vitest:** the settle path keeps a non-collapsed selection, and still re-spins the edited block.
- **Chromium:** install `edit-activity` in a harness leg (or add a seam), type one character, select the whole document within 220 ms, and check the Range after the settle and after the snapshot.
- **Real VS Code** (build first, `--retries=0`): type, then Select All at about 50 ms and 150 ms after the keystroke. The Range stays whole-document. Delete gives `\n`, and one Undo restores the exact source. Remove the `PROSE_SETTLE_MS` staging from `structural-selection.spec.ts`.

## Acceptance

- [ ] IR: Select All within 220 ms of a prose keystroke keeps the whole-document Range through the settle re-spin and the undo snapshot (real VS Code).
- [ ] Delete and type-over then replace the whole document, and one Undo restores the exact source.
- [ ] Typing performance and the Task 175/180 re-spin behavior are unchanged in their focused tests.
- [ ] The `PROSE_SETTLE_MS` workaround in `test/vscode-e2e/structural-selection.spec.ts` is removed, and the spec passes.
