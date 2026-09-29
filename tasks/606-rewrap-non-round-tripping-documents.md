# Task 606 — Rewrap and marker-capture actions on non-round-tripping documents

**Status:** planned (2026-09-29). The Project Owner left Rewrap outside Task 604; the related action scope needs a measured decision before implementation.
**Origin:** [Task 604](done/604-turn-into-non-round-tripping-documents.md), Owner decision 4 and Checkpoint 1 N3.
**Scope:** Rewrap's source range and document caret proof. Investigate Details' passive fallback, callout actions and heading shift as other users of the same marker capture; decide their implementation scope after attribution. Keep Task 604's Turn Into behavior unchanged.
**Dependency:** Task 604's `selection-source-proof` and shared exact/rendered source index.

## Problem and evidence

`captureRewrapSourceRange` in `media-src/src/editing/rewrap-command.ts` serializes through live markers and rejects a mapped range unless the whole rendered document equals the authoritative source. Task 604 N3 measured `strictMappingReturned:false` on the canonical normalizing fixture even though the selected paragraph can be source-proven. Document-scope caret mapping uses `mapCaretOffsetByLine`, which is a heuristic and cannot authorize an exact edit. Marker insertion/removal also invalidates the shared source index.

The same capture is called by Details' fallback via `captureCalloutActionTarget` (`media-src/src/editing/details-toggle.ts` and `callouts.ts`), callout actions, and heading shift (`rewrap-command.ts`). `selection-link-actions.ts` and other consumers should be inventoried before choosing the boundary. Evidence: Task 604 Checkpoint 1 N3 and `tmp/queue-part1/604-cp2-4-handoff.md` §7; Task 578's index attribution is retained in its completed record.

## Investigation and design boundary

1. Reproduce Rewrap's selection and document-scope decline on a privacy-safe normalizing fixture. Attribute marker writes and compare exact, rendered, host, history and index keys without printing fixture text.
2. Replace heuristic authorization with Task 604's exact-source proof for both endpoints and the document-scope caret. Support multi-unit selections only when every boundary and span is proven; otherwise decline without a partial edit.
3. Inventory Details, callout, heading-shift and other marker-capture users. Measure which fail on the same document and return a bounded scope decision to the Project Owner before changing those actions. Preserve explicit actions and passive performance limits.
4. Keep live source markers out of passive paths where possible; verify any unavoidable markers do not leave a stale warm index or move the selection.

## Verification

- Real-Lute/unit alignment and decline cases for IR/WYSIWYG, CRLF, list/table boundaries, multi-block selections and document reflow.
- Chromium and focused real-VS-Code tests for exact target-only Rewrap, caret/focus, one Undo, host/disk/save/reopen and unchanged Find/Turn Into controls.
- Re-run Task 573/574/578 warm-index and passive-selection gates, recording baseline limits separately.

## Acceptance

- [ ] Rewrap accepts only source-proven selections and document carets on normalizing documents; uncertain mappings decline.
- [ ] Exact bytes outside the approved edit remain unchanged through apply, Undo and save/reopen.
- [ ] The Owner has chosen the scope of related Details, callout and heading-shift repairs from measured evidence.
- [ ] Passive selection and shared-index performance gates remain intact.
