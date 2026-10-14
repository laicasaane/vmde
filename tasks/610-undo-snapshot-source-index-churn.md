# Task 610 — Avoid source-index rebuilds from Undo snapshot markers

**Status:** planned (2026-09-29). The Project Owner decided the owning layer and the budget on 2026-10-08 (see Owner decisions); implementation has not started.
**Origin:** Task 604 checkpoint 2 attribution; preserve [Task 578](done/578-ir-click-source-index-rebuild.md)'s shared index and performance contract.
**Scope:** source-neutral DOM mutations from Vditor's Undo snapshot. Do not suppress invalidation for real source or block-structure changes.

## Problem

Vditor's delayed `addToUndoStack` calls `addCaret`, temporarily inserting and removing `span.vditor-wbr`. The shared index in `media-src/src/nav/source-block-index.ts` treats every non-attribute mutation as relevant, advances `domRevision` and discards a warmed entry even when Markdown is unchanged. A following source-backed request rebuilds the large-fixture index; the observed request can take roughly 1–1.6 seconds. Isolate the build cost from other request work before setting a performance budget.

## Measured evidence

- `tmp/task604-checks/cp2/s6-r7-attribution.md`: controlled real-Vditor/Lute diagnostic passed 4/4. In both IR and WYSIWYG, warming before the opening checkpoint changed `domRevision` 1→2, Undo depth 0→1 and caused one request index build; waiting for the checkpoint first kept the revision and Undo depth stable and caused zero request builds. Exact Markdown stayed identical.
- The checkpoint generated three child-list records, including a split text node, and one character-data record. `source-block-index.ts::relevantMutations` admits all of them. `tmp/task604-checks/cp2/s6-roundtrip-trace/mapped-events.json` attributes a delayed marker writer to Vditor Undo during the Turn Into trace. The controlled diagnostic did not reproduce native VS Code timing; the earlier native failed run lacked a pre-hover index-key sample, so its writer is not retrospectively proved.

## Affected modes

- **IR and WYSIWYG:** causal index invalidation measured in the controlled diagnostic; native timing needs confirmation.
- **SV:** the shared source-block index is scoped to IR/WYSIWYG; check any SV consumer before claiming an effect.

## Candidate approaches

1. Make `relevantMutations` recognize a complete source-neutral Undo-marker insertion/removal, including the text split, while continuing to invalidate on real text and structure edits.
2. Suppress or batch index invalidation around a verified `addCaret` snapshot transaction, with a safe fallback if unrelated mutations occur in the same batch.
3. Prevent the transient snapshot marker from touching the live indexed root, if an anchored Vditor patch can preserve Undo and caret behavior.

## Owner decisions (2026-10-08)

Approved in chat by the Project Owner.

- The Vditor integration owns source-neutral detection: the undo-snapshot wrapper marks its own marker mutations as source-neutral. The shared index stays generic.
- Target on the large fixture: after a snapshot, the next warm action does 0 index rebuilds and completes within 100 ms.

## Tests

- Unit/DOM tests with actual `addCaret` mutations: unchanged Markdown retains the warmed index; a mixed batch with a real edit or block replacement invalidates it. Cover IR and WYSIWYG.
- Chromium performance regression for a warmed request before and after the delayed snapshot, with `domRevision`, index builds, exact-source identity and elapsed work recorded.
- Build first, then focused real-VS-Code XTEST coverage with an opening-checkpoint control and a later request on the privacy-safe large fixture. Recheck Task 578's warm click/hover and source-index invalidation gates.

## Acceptance

- [ ] Source-neutral Undo snapshots cause zero avoidable index builds on the warmed IR/WYSIWYG paths.
- [ ] Actual Markdown or block-structure mutations still invalidate the index and return source-correct options.
- [ ] Focused native and Chromium measurements meet the Owner-approved budget (0 rebuilds, within 100 ms on the large fixture) without changing Undo, caret placement or host bytes.

## Part 1 handoff (2026-10-14)

Read-only review of the source and the earlier recorded diagnostic; no builds or tests were run.

- **Cause and entry points.** Vditor `undo/index.ts` `addCaret` inserts `span.vditor-wbr` on the live root (splitting the caret's Text node), clones the root, removes the span and restores the caret; the two Text halves stay adjacent. Callers: `addToUndoStack` (timer, `setValue`, VMDE checkpoints) and `recordFirstPosition` (first keydown, possibly a non-editing key). `media-src/src/nav/source-block-index.ts` `relevantMutations` admits every non-attribute record, advances `domRevision`, drops the entry and rebuilds on the next read. The earlier controlled real-Undo/Lute diagnostic (4/4 in IR and WYSIWYG) showed `domRevision` 1→2 and one build on the next request (native snapshot revision stability unverified). Wiring (`boot/finish-init.ts`): the history coupling is installed before the index exists; the index is created later and disposed with the block-handle layer; `undo-keybind.ts` already wraps `addToUndoStack` once per Undo object.
- **Contract.** (1) The index stays generic: one handle method, e.g. `sourceNeutral<T>(run, accept?)`, that flushes pending records through the normal path first, runs `run`, takes the scope's records and discards them only when `run` returned normally and `accept` passes (otherwise processes them normally); nest-safe (an inner `currentKey()` must not invalidate on scope records); no mention of Vditor or `wbr`. (2) The Vditor integration owns detection (Owner rule): wrap the Undo instance's `addCaret` (both callers; excludes the diff, the stack push and the VMDE `reportEntry`/`flushHistoryInput` callbacks), in `editing/` (the boundary forbids `nav → editing`), fail loud if `addCaret` is missing, idempotent per Undo object, index bound late through a registration set after the index is created and cleared in the block-handle disposer. (3) `accept` verifies the marking (Task 578: an inserted-then-removed pair is ignorable only if the proof covers it): every added/removed childList node is a `span.vditor-wbr` or a Text node; no Text node removed; every added Text node is connected with a Text `previousSibling`; characterData records target Text nodes only; anything else invalidates. (4) A Text split serializes to identical `innerHTML`, replaces no element and keeps `exact`, `rendered` and `units` valid — Part 2 still asserts serializer parity before and after on IR and WYSIWYG.
- **Edge cases.** Stale memo (verified hazard): `media-src/src/editing/find-map.ts` caches per-character `{node, offset}` boundaries in `entry.memo(BLOCK_MAPS)`; after a split, `blockMapOffset` returns null in the new tail node and `selection-source-proof.ts` fails for that block (Find itself falls back safely) — rebuild that one unit's map on a lookup miss for a connected Text node inside the unit; do not normalize the split. Selection outside the root or a `wbr` already present (only a removal — neutral); element-anchored or non-collapsed ranges (no split); synchronous handlers inside the scope (`__vmdeRequestCaret`; a DOM-writing listener is rejected by `accept`; probe); asynchronous follow-up observers writing non-attribute DOM after a snapshot still invalidate (S1 records two frames); SV (no index; no-throw check); Undo/Redo `renderDiff` replaces `innerHTML` outside the scope and must still invalidate.
- **Part 2.** S1: promote the diagnostic to a tracked probe; split request time into build (`getValue`, two Lute serializations, `resolveUnits`) versus the rest on the large fixture; record native snapshot revision stability and follow-up records over two frames. S2: `source-block-index.ts` scope API; a new `media-src/src/editing/undo-snapshot-neutral.ts` (or `undo-keybind.ts`) wrapper and `accept`; `finish-init.ts` wiring; `find-map.ts` miss rebuild; manifest entry for a new module. Units: `source-block-index.test.ts` (neutral scope keeps the entry and `domRevision`; a pre-scope pending edit still invalidates; a mixed scope invalidates; a throw invalidates; nesting; `accept` false invalidates); real patched Undo + real Lute on the large fixture, IR and WYSIWYG (a snapshot keeps the warmed entry, 0 builds, identical serialization; split, element anchor and `recordFirstPosition` neutral; a real edit or block replace in the same task invalidates); find-map (proof in the split tail succeeds after the rebuild). S3: Chromium `media-src/e2e/undo-snapshot-index.spec.ts` (warm the index, wait for the delayed snapshot, next request: `domRevision`, index builds, exact-source hash, elapsed time). S4: real-VS-Code `test/vscode-e2e/undo-snapshot-index.spec.ts` (opening-checkpoint control and a later request on the large fixture) and the Task 578 gates (`ir-click-index`, `selection-performance`, `find-replace-large`, `block-handle`, `details-toolbar`, `selection-bubble`, `large-document-interaction`) plus `undo-restore-caret`, `undo-first-edit`, `undo-boundaries`, `held-drag-undo-snapshot`. S5: closure. Target (Owner): 0 index rebuilds after a snapshot; next warm action ≤ 100 ms; Undo depth, caret and host bytes unchanged.
- **Decisions (provisional, reversible; within the Owner rule "the undo-snapshot integration marks its marker mutations source-neutral, index stays generic").** (1) Wrap `addCaret` (covers `recordFirstPosition` too) — adopted. (2) Keep entries whose memos hold Text-node references, with `find-map` self-healing per unit on a miss (merging the split back would change Vditor's Undo and caret behaviour) — adopted. (3) The 100 ms budget is measured as the request's handler-to-options time, excluding paint — adopted provisionally, settled with S1 data.
- **Risks.** Native revision stability and asynchronous follow-up writers are unverified (S1).
