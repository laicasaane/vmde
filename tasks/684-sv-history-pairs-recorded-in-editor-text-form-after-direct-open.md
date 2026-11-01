# Task 684 — Source-mode history pairs recorded in editor-text form after a direct Source open

**Status:** planned (2026-11-01). Filed at the close of Task 675 (review finding L5).
**Origin:** Task 675 (decision D7).
**Severity:** low (estimated; unverified, and the replay fails closed: a mismatch posts the Undo as a plain edit).
**Tech stack:** `media-src/src/editing/rewrap-command.ts` (`takeRewrapDocumentHistoryReplay`), `media-src/src/boot/vditor-init.ts` (`input()`), and the callers of `recordRewrapDocumentHistory` that can run in Source mode.
**Depends on:** Task 675.

## Problem

Task 675 found that after a direct Source open Vditor's `getValue()` differs from the Source editor's `textContent` (the text ends in a zero-width space and `getValue()` adds one line break). The native Undo and Redo replay compares `window.vditor.getValue()` with the recorded `beforeRendered` or `afterRendered` (`takeRewrapDocumentHistoryReplay`), so a history pair recorded from the editor text never matches, the exact replay is skipped and the Undo is posted as a plain edit. Task 675 fixed this for the two Source commands (Format table, Fix list numbering) by recording `getValue()` in those commands.

Other callers of `recordRewrapDocumentHistory` may still record editor-text forms. Lines to verify (current as of `cfd33bbf` plus Task 675):

- `media-src/src/editing/block-transform-command.ts:1154` (`beforeRendered: bookmark.rendered`, `afterRendered`)
- `media-src/src/editing/table-actions.ts:279` (`renderedBefore`, `afterRendered`)
- `media-src/src/editing/selection-scope.ts:889` (`beforeRendered`, `afterRendered`)
- `media-src/src/editing/link-popover.ts:605` (`prepared.renderedBefore`, `afterRendered`)
- `media-src/src/editing/selection-link-actions.ts:207` (`renderedBefore`, `afterRendered`)
- `media-src/src/editing/block-action-client.ts:343` (`record.renderedBefore`, `record.renderedAfter`)

`media-src/src/boot/main.ts:341` and `:385` and `media-src/src/bridge/message-router.ts:271` already record `afterRendered` from `getValue()`; their `beforeRendered` sources need checking too. Whether each caller can run in Source mode, and whether its recorded form differs from `getValue()` after a direct open, is not measured.

## Proposed work

Measure first: for each caller that can run in Source mode, open a document directly in Source mode, run the action after typing, press Undo once and check whether the exact replay is taken (host restored) or skipped (plain edit, host unchanged). Fix only the callers that fail, in the same way as Task 675 (record the pair in `getValue()` form), or normalize once in the replay if the evidence shows the shared function is the better place.

## Acceptance

- [ ] Each Source-capable caller is listed with a measured result (replay taken or skipped after a direct Source open).
- [ ] Every caller whose replay is skipped has a failing test first and is fixed; one Undo restores the typed state after a direct Source open in real VS Code.

## Tests to write

- Vitest per fixed caller (the recorded pair equals the `getValue()` form when the editor text differs).
- Real VS Code: the affected action in Source mode opened directly (the kit switch `openDocument(..., { direct: true })` from Task 675).
