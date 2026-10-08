# Task 606 — Rewrap and marker-capture actions on non-round-tripping documents

**Status:** planned (2026-09-29). The Project Owner left Rewrap outside Task 604 and ruled on the related-action scope on 2026-10-08 (see Owner decisions); implementation has not started.
**Origin:** [Task 604](done/604-turn-into-non-round-tripping-documents.md), Owner decision 4 and Checkpoint 1 N3.
**Scope:** Rewrap's source range and document caret proof. Investigate Details' passive fallback, callout actions, heading shift and link actions as other users of the same marker capture; their scope follows the 2026-10-08 Owner decisions. Keep Task 604's Turn Into behavior unchanged.
**Dependency:** Task 604's `selection-source-proof` and shared exact/rendered source index.

## Problem and evidence

`captureRewrapSourceRange` in `media-src/src/editing/rewrap-command.ts` serializes through live markers and rejects a mapped range unless the whole rendered document equals the authoritative source. Task 604 N3 measured `strictMappingReturned:false` on the canonical normalizing fixture even though the selected paragraph can be source-proven. Document-scope caret mapping uses `mapCaretOffsetByLine`, which is a heuristic and cannot authorize an exact edit. Marker insertion/removal also invalidates the shared source index.

The same capture is called by Details' fallback via `captureCalloutActionTarget` (`media-src/src/editing/details-toggle.ts` and `callouts.ts`), callout actions, and heading shift (`rewrap-command.ts`). `selection-link-actions.ts` and other consumers should be inventoried before choosing the boundary. Evidence: Task 604 Checkpoint 1 N3 and `tmp/queue-part1/604-cp2-4-handoff.md` §7; Task 578's index attribution is retained in its completed record.

## Investigation and design boundary

1. Reproduce Rewrap's selection and document-scope decline on a privacy-safe normalizing fixture. Attribute marker writes and compare exact, rendered, host, history and index keys without printing fixture text.
2. Replace heuristic authorization with Task 604's exact-source proof for both endpoints and the document-scope caret. Support multi-unit selections only when every boundary and span is proven; otherwise decline without a partial edit.
3. Inventory Details, callout, heading-shift and other marker-capture users. Measure which fail on the same document and apply the 2026-10-08 Owner decisions to each. Preserve explicit actions and passive performance limits.
4. Keep live source markers out of passive paths where possible; verify any unavoidable markers do not leave a stale warm index or move the selection.

## Owner decisions (2026-10-08)

Approved in chat by the Project Owner.

- A related marker-capture action (Details, callouts, heading promote/demote, links) that fails on the measured document for the same mechanism (marker capture without exact proof) is repaired in this task, one step per action with its own tests.
- An action that fails for a different reason gets a new task record.

## Verification

- Real-Lute/unit alignment and decline cases for IR/WYSIWYG, CRLF, list/table boundaries, multi-block selections and document reflow.
- Chromium and focused real-VS-Code tests for exact target-only Rewrap, caret/focus, one Undo, host/disk/save/reopen and unchanged Find/Turn Into controls.
- Re-run Task 573/574/578 warm-index and passive-selection gates, recording baseline limits separately.

## Acceptance

- [ ] Rewrap accepts only source-proven selections and document carets on normalizing documents; uncertain mappings decline.
- [ ] Exact bytes outside the approved edit remain unchanged through apply, Undo and save/reopen.
- [ ] Each related marker-capture action that fails for the same mechanism is repaired in its own step with its own tests; any action failing for a different reason has a new task record.
- [ ] Passive selection and shared-index performance gates remain intact.
