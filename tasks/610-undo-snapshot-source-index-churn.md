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

## Execution progress — 2026-10-14 (S2)

Scope: the source-neutral scope on the index, the Undo-snapshot integration, the Find map rebuild, and unit and real-Lute tests. Per the Owner test-scope rule the S1 probe is not run on its own and no Chromium or real-VS-Code spec is part of this step: elapsed time, `domRevision` and the native timing are S3/S4 work. The Acceptance items stay open.

**Changed**

- `media-src/src/nav/source-block-index.ts`: `sourceNeutral<T>(run, accept?)` on the handle. It processes records queued before the scope through the normal path, runs `run`, then takes the scope's records and discards them (entry and `domRevision` kept, no `dom` event) only when `run` returned normally and every `accept` passed; a throw, a rejecting or throwing `accept`, or a failed nested scope invalidates through the normal path. The outermost scope owns the observer queue, so a `currentKey()` inside it does not invalidate. The index names no Vditor type and no marker class.
- `media-src/src/editing/undo-snapshot-neutral.ts` (new, in `editing/` because `nav -> editing` is forbidden): `bindUndoSnapshotNeutral(win, index)` wraps the Undo instance's `addCaret` once per Undo object (covers `addToUndoStack`, `setValue`, checkpoints and `recordFirstPosition`; the diff, the stack push and the history-coupling callbacks stay outside the scope), registers the index in a per-instance set, and returns the unbind. A missing `addCaret` throws; a missing Undo object is a no-op, like `installVditorHistoryCoupling`. `isUndoSnapshotMarkerMutation` is the `accept` proof: every added or removed node is a childless `span.vditor-wbr` that is no longer connected, or an added Text node; no Text node is removed; every added Text node is connected, follows a Text node whose data was truncated (a `characterData` record on a Text target), and every truncated Text node is followed by an added one; no `attributes` record. Anything else invalidates.
- `media-src/src/boot/finish-init.ts`: one `bindUndoSnapshotNeutral(window, sourceIndex)` call after the index exists, and its unbind in the `block-handle` disposer. `scripts/module-manifest.mjs`: one manifest entry.
- `media-src/src/editing/find-map.ts`: a block map keeps its unit and rendered slice. When `blockMapOffset` misses for a connected Text node inside the unit, or a mapped Find range fails, and the map is stale (a recorded boundary no longer fits its node, or a serializable Text node of the unit is unknown to it), that one unit's map is rebuilt in place (Find and the selection proof share the object). The split is not merged back. The Find range retry is the same rebuild applied to the second consumer of the map; without it a match that ends in a split tail could not be mapped.
- `media-src/src/editing/find-widget.test.ts`: the typed fake index handle gained `sourceNeutral: (run) => run()` (one line; the handle method is required).

**Failing first.** Before the implementation, `source-block-index.test.ts` had 6 failing cases (`index.sourceNeutral is not a function`) and the new `find-map.test.ts` cases failed on the split tail (`expected null to be 6`). With the wrapper deactivated, 6 cases of the real-Undo file failed, among them the large-fixture snapshot case in both modes, which shows the defect on the real patched Undo.

**Test map**

- Contract 1 (`source-block-index.test.ts`): neutral scope keeps entry, key, `domRevision`, build count and emits no event; a pending edit before the scope and one after it invalidate; a mixed scope rejected by `accept` invalidates; a throw invalidates and rethrows; nesting (inner scope and key read inside the outer scope keep the entry, a rejecting or failed inner scope invalidates); a throwing `accept` counts as a rejection.
- Contracts 2-4 (`undo-snapshot-neutral.test.ts`, real patched Undo bundled with the repository's own Vditor patch registry, real Lute, the large fixture, IR and WYSIWYG): split, element-anchored and `recordFirstPosition` snapshots keep the warmed entry, `domRevision` and the build count (1) with identical `innerHTML` and identical serialization before and after; an independent observer asserts the marker was written and removed in each step. A real text edit, and a block replacement, in the same task as a snapshot invalidate and rebuild.
- Edge cases (small document, IR and WYSIWYG): non-collapsed selection in one Text node and across two Text nodes, selection outside the root (no write), a `wbr` already in the root with a stale marker (removal only) all keep the entry; a DOM-writing step inside the scope (an element append, a text edit) is rejected by `accept`; Undo and Redo (`renderDiff`) still invalidate; SV does not throw; wrapper contract (fail loud without `addCaret`, once per Undo object, `this`/arguments/result kept, late registration of several indexes, unbind, pass-through when none remain); `accept` accepts empty, marker pair and marker plus split records and rejects a connected marker, another element, a removed non-marker, a marker with children, a normalize merge, a Text node added without a split or after an element, a plain text edit, a Comment edit and an attribute write.
- Edge case, find-map (`find-map.test.ts`, IR and WYSIWYG): a Text node split under a kept entry; the tail node maps to the same serialized offsets after the rebuild, the block map object is the same, and Find's range for a match ending in the tail is found.

**Checks (all run in this worktree)**

- Vitest: the touched files plus every Vitest file importing `source-block-index` or `find-map` (`block-handle`, `source-block-index`, `selection-source-proof`, `details-turn-into-pending`, `link-popover`, `find-source`, `details-selection-state`, `find-map`, `find-widget`, `block-transform-non-round-trip`, `undo-snapshot-neutral`, `selection-bubble`, `details-toggle-controls`), `finish-init.test.ts` (wired file) and `test/backend/module-boundaries.test.ts`: 15 files, 366 tests passed. After the last edit `undo-snapshot-neutral`, `find-widget`, `source-block-index`, `find-map` and the boundary test were rerun: 165 passed.
- `npm run typecheck`: no errors. Biome on the changed files: clean. `npm run depcruise:webview`: no dependency violations (the tool also prints its usual missing-TypeScript-transpiler notice). `npx knip`: no findings.

**Open**

- Acceptance items stay unchecked: the 0-rebuild, 100 ms measurement and native timing are S3 (Chromium) and S4 (real VS Code). Asynchronous follow-up writers after a snapshot still invalidate by design and are unmeasured.
- The Chromium engine's `splitText` must queue the `characterData` record that `accept` pairs with the added tail node (the specification says it does; jsdom does). If it did not, the scope would reject the snapshot, which costs only the saved rebuild; S3 shows it.

## Execution progress — 2026-10-14 (S3)

Scope: the Chromium measurement of acceptance items 1 and 3 and the real-edit control (item 2) on the large fixture, IR and WYSIWYG. No source change in this step. Native timing and the real-VS-Code spec are S4.

**Changed**

- `media-src/e2e/undo-snapshot-index.spec.ts` (new): one test case per mode on the large synthetic fixture.
- `media-src/e2e/turn-into-exact-harness.ts`: the harness binds the index with `bindUndoSnapshotNeutral` as `boot/finish-init.ts` does, and exposes `__indexRevision`, `__undoDepth` and `__scheduleUndoSnapshot`. The last toggles a class on the first block (the index ignores class attributes) and calls Vditor's own after-render scheduling, so the delayed Undo snapshot records a new history entry without a source edit.

**What the case does.** It loads the fixture with the caret in a paragraph, waits until the opening checkpoint has run and the index revision has been unchanged for 20 consecutive frames (polling only: the first attempt warmed in the same task as `setValue` and showed code highlighting, about 1,000 added nodes, invalidating the index after the load, which is a different writer from the Undo snapshot), warms the index (1 build), runs one baseline request, schedules the delayed snapshot and polls the Undo depth. It then asserts: the marker was inserted and removed once, split one Text node, and the engine queued the `characterData` record that pairs with the tail (1 paired split, no other node added); 0 builds, the same entry and the same `domRevision` after the snapshot; the first `index.read()` after it is warm; the next Turn Into request returns correct options (paragraph, Heading 2 changed, exact span and text) with 0 builds and the same revision; the exact-source hash equals the fixture hash before and after. Control: a trusted keystroke invalidates (revision advances), the next request does exactly 1 build and returns the edited paragraph's span with exactly the typed character added.

**Chromium emits the `characterData` pairing** (IR and WYSIWYG): one `characterData` record on the head Text node and one added tail Text node, adjacent around the marker; the scope accepted it.

**Fail without the fix.** With `bindUndoSnapshotNeutral` made inert locally (reverted afterwards), both cases failed: the snapshot caused a second index build, `domRevision` moved from 38 to 40, the entry did not survive, and the first read after the snapshot took 452 ms (IR) and 357 ms (WYSIWYG).

**Timing (one run per case, shared machine).** The warm index lookup after the snapshot: 0.1 ms in both modes (budget 100 ms, asserted). The whole Turn Into request (handler to options) is logged, not asserted: 91 ms (IR) and 137 ms (WYSIWYG) after the snapshot, and 169 ms and 189 ms for the same request before any snapshot; with a rebuild (control) 245 ms and 292 ms. The request serializes the document once outside the index, so its time is not what the snapshot costs and varies around the 100 ms budget with no snapshot at all. Open question for the Owner or coordinator: Decision 3 defines the budget as handler-to-options for the request; on this path that figure does not fit 100 ms even without a snapshot. The assertion was placed on the index step (the warm lookup) and the full request time is only recorded.

**Checks**

- `node build.mjs`: exit 0. `npx playwright test undo-snapshot-index.spec.ts` (temporary config on port 9610, deleted afterwards, because another worktree held port 9123): 2 passed. With the binding inert: 2 failed, as above.
- `turn-into-non-round-trip.spec.ts` (the one existing spec that loads the changed harness): 10 passed.
- Biome on the two changed e2e files: clean. `npm run typecheck`: clean.

- **Owner decision (2026-10-14, chat).** The ≤ 100 ms budget applies to the index lookup after the delayed snapshot (measured 0.1 ms in S3). The Turn Into request's own whole-document serialization (91–189 ms on the large fixture, with or without a snapshot) is outside this task and is offered as a follow-up.
