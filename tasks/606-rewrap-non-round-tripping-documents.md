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

## Part 1 handoff (2026-10-14)

Read-only review of the source; nothing was run. V = verified in source; I = inferred, S1 measures it.

- **Cause and entry points.**
  - V: `captureRewrapSourceRange` (`media-src/src/editing/rewrap-command.ts`) inserts live text markers, serializes the whole editor and accepts only `mapped.markdown === authoritative`; without `authoritativeMarkdown` the authority is `vditor.getValue()` (rendered).
  - V: selection Rewrap (`boot/main.ts`, router `rewrap-selection`) and auto-wrap capture against rendered bytes and sync with a non-exact edit that host minimal-diff writeback reduces. I: on a normalizing document this probably applies rendered bytes inside the block and revokes exact authority rather than declining (the record's "declines" came from Task 604's measurement against exact authority on the Turn Into capture, not the Rewrap route).
  - V: document Rewrap captures with markers at prepare time, maps the caret with the `mapCaretOffsetByLine` line heuristic onto host text, rewraps exact bytes and syncs through exact history. I: the caret only places the marker; written bytes should not depend on it (untested).
  - V: heading shift uses the same rendered-authority capture and non-exact sync as selection Rewrap.
  - V: callout actions (`callouts.ts`) transform rendered `getValue()` bytes and post them as exact (the host writes exact payloads verbatim, `src/writeback/writeback-controller.ts`). I: on a normalizing document this writes normalized bytes outside the target as exact — forbidden by Task 604.
  - V: Details action and passive fallback (`details-toggle.ts`) use exact text only when rendered equals exact; otherwise rendered `snapshotMarkdown`, and the action posts that as exact. I: same silent normalization; the passive fallback inserts markers that invalidate the index (Task 604 N3).
  - V: selection link actions (`selection-link-actions.ts`) compare a marker capture against exact and decline on normalizing documents (except the unique-ATX-heading fallback); the link popover binds through the index group (Task 578). I: probably works.
  - V: other users of the same capture outside the Owner list: `html-subscript-command.ts`, `named-anchor-insertion.ts`, `emoji-insertion.ts`, `math-insertion.ts`; `mapCaretOffsetByLine` also authorizes SV table-format and list-normalize.
- **Contract.** (1) In IR/WYSIWYG with a bound index, prove both endpoints with `proveSelectionSource` (`selection-source-proof.ts`), binding an `{index, snapshotPair}` source as `bindBlockTransformSource` does (`boot/finish-init.ts`); compute on `proof.exact` and the proven exact offsets only. (2) A proven non-round-trip selection may span several units only if both endpoints are proven and every unit between them has a paired exact span (a small exported span check in `selection-source-proof.ts`); otherwise decline with no edit. (3) Legacy marker capture only when the proof is `unprovable` and `roundTrip` is true (as in `block-transform-command.ts`), and then compared against `snapshotExactMarkdown()`, never `getValue()`; `unavailable` declines. (4) Document caret: proof at prepare time on the collapsed range (caret bias), no markers; at run time decline unless host content equals `proof.exact` and the index key is unchanged; `mapCaretOffsetByLine` removed from Rewrap; an unprovable caret declines the whole document Rewrap (record acceptance). (5) Selection scope applies through the exact sync path with `recordRewrapDocumentHistory`, so Undo restores exact bytes in one step; keep the `hasRewrapDocumentHistoryTransition` guard. (6) Passive Details state inserts no live markers when a warm proof exists; explicit actions keep one capture.
- **Part 2.** S1: privacy-safe probe (lengths and booleans only) on `test/vscode-e2e/fixtures/large-observable-models-synthetic.md` and a small normalizing control, IR and WYSIWYG: selection Rewrap, auto-wrap, document Rewrap, heading shift, callout apply, Details action and passive state, selection link, link popover, plus the subscript, anchor, emoji and math users — applied or declined, payload equals the exact plan, outside bytes unchanged, marker count, index builds, key changes. S2a: RED Vitest in `media-src/src/editing/rewrap-command.test.ts` and a new real-Lute `rewrap-non-round-trip.test.ts` (proven single- and multi-unit selections, unprovable decline, proven and unprovable caret, CRLF, list/table boundaries, caret-independence of `rewrapMarkdownDocument` bytes). S2b: `rewrap-command.ts`, `boot/main.ts`, `boot/finish-init.ts`, possibly `selection-source-proof.ts` (exact-plan payload assertion required). S3: one step each for heading shift, callouts, Details (action and passive) and selection links — only for actions S1 shows failing by the same mechanism. S4: Chromium `media-src/e2e/rewrap.spec.ts` plus a non-round-trip case; real VS Code `test/vscode-e2e/rewrap.spec.ts` plus a new `rewrap-non-round-trip.spec.ts` (exact target-only bytes, caret/focus, one OS Undo, host/disk/save/reopen, Turn Into and Find unchanged), and the per-action specs (`heading-level-shift`, `callout-*`, `details-toolbar`, `link-popover`). S5: rerun `selection-performance`, `ir-click-index`, `block-handle`, `details-toolbar`, `find-replace-large`, `large-document-interaction` (Tasks 573/574/578 gates).
- **Edge cases.** Backward selections; a caret at a CRLF or surrogate boundary (the proof rejects it); a caret in a table, code block or front matter; an endpoint in a nested list; a rewrap unit extending past the proven span; prepare/run racing a trusted edit; a mode switch between prepare and run; Undo inside the undo-delay window; cold index (decline); SV.
- **Decisions (orchestrator, 2026-10-14, applying the Owner rule of 2026-10-08).** (1) The Owner list (Details, callouts, heading shift, links) is the repair scope; the subscript, anchor, emoji and math users are measured in S1 and a failure there gets a new record. (2) SV Rewrap and heading shift stay unchanged here (Task 605's mechanism). (3) An unprovable document caret declines the whole document Rewrap (record acceptance). (4) Callouts and Details are repaired in S3 if S1 shows the same mechanism (marker capture without exact proof), else a new record. (5) The `mapCaretOffsetByLine` authorization in SV table-format and list-normalize is offered to the Owner as a new record.
- **Risk.** If S1 shows today's selection Rewrap applies (rendered bytes) rather than declines, moving it to proof-only is a visible behaviour change on normalizing documents — report it to the Owner before S2b. S2b shares `boot/finish-init.ts` and `scripts/module-manifest.mjs` with other steps — sequence it after their commits.
