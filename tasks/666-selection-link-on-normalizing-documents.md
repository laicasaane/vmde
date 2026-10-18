# Task 666 — Selection-bubble Link on normalizing documents

**Status:** planned (2026-10-18). Filed at the close of Tasks 606 and 630; waits for a future batch.
**Origin:** Task 630, Task 604.
**Severity:** medium (estimated).
**Tech stack:** `media-src/src/editing/selection-link-actions.ts`, `selection-source-proof.ts`, real VS Code with XTEST.
**Depends on:** Task 630, Task 604.

## Problem

On a document whose IR or WYSIWYG DOM does not serialize back to the host bytes (a normalizing document), the selection-bubble Link does nothing. `sourcePlan` in `selection-link-actions.ts` calls `captureRewrapSourceRange(window, owner.range, { authoritativeMarkdown: before })`, which returns null unless the DOM-serialized markdown equals the acquired exact text. The action declines silently and writes nothing (fails closed). Task 630 proves the decline in the real-VS-Code cell `bubble-link-normalizing`.

## Proposed work

Map the live selection onto the acquired exact text with Task 604's proof (`proveSelectionSource`), as Details, Insert Picture, Insert ID and emoji already do. Proof-only: no marker fallback.

Scanner note: `scanMovableBlocks` (`src/shared/block-move`) classifies `* * *` as a list item, so link actions decline on documents that contain it. Fix the scanner or record the limit.

## Acceptance

- A paragraph selection on a normalizing document in IR and WYSIWYG gets the link markup, and only that span changes.
- A stale host is refused.
- `bubble-link-plain` stays green. The `bubble-link-normalizing` decline cell becomes an apply cell.
- Vitest case: normalizing document, paragraph selection applies.
- Task 671 (selection link step of Task 606) depends on this task.
- [ ] Focused real-VS-Code spec written and run; `npm run quality` passes.
