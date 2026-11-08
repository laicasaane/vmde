# Task 700 — Three performance and timing assertions fail in real VS Code at `f84a4258`

**Status:** planned (2026-11-02). Filed from the full real-VS-Code gate of queue run 2026-11-01d.
**Origin:** Gate rerun at `f84a4258` (Task 695): the suite failed these cases in chunks and again when each spec file ran alone (`--workers=1 --retries=0`, XTEST, fresh X server per file).
**Severity:** low (estimated; threshold or instrumentation assertions, no wrong output reported).
**Tech stack:** `test/vscode-e2e/{incremental-seed,selection-performance,large-document-interaction}.spec.ts`; IR seed and block-handle code in `media-src/src/`.
**Depends on:** none.

## Problem

These cases fail in the full suite and again alone at `f84a4258`:

- `incremental-seed.spec.ts:64`: the longest seed batch takes 190 ms where at most 50 ms is expected.
- `selection-performance.spec.ts:471`: 2 passive source reads where at most 1 is expected.
- `large-document-interaction.spec.ts:416`: the `blockTransformCaptureCalls` counter is 0 where more than 0 is expected, so the warmed block-handle path measured nothing.

Task 691 left `preview-mode-timing.spec.ts` marginal on unchanged `dev`; these cases may be load-sensitive on this machine. Run each alone several times on `dev` before treating a threshold as a product defect.

No earlier full-suite baseline exists, so the commit that introduced each failure is unknown, and whether the cases in this group share one cause is not measured.

## Proposed work

1. Find the last good commit for each failing case: run the spec alone on earlier `dev` revisions.
2. Group the cases by first bad commit and measure the cause of each group.
3. Fix each cause with a failing test first, or fix the test where the test, not the product, is wrong (state which).

## Acceptance

- [ ] Each failing case has a first bad commit (or is shown to be a test defect) and a measured cause.
- [ ] Each product cause is fixed with a test that fails before and passes after.
- [ ] The listed cases pass in one real-VS-Code run, alone and in the full suite.

## Tests to write

- A test per product cause; the listed real-VS-Code cases are the acceptance tests.

## Progress

- 2026-11-08: quiet-machine rerun on `34456d4e` (fresh boot, load under 1, each case alone, 5 repeats). `incremental-seed.spec.ts:64` failed 5 of 5 at line 138 (`maxLongTaskMs` 221, limit 50). `large-document-interaction.spec.ts:416` failed 5 of 5 (`getValueCalls` 1, expected 0, at line 168 or 542). Both are deterministic, not load-dependent. `selection-performance.spec.ts:471` (XTEST, 5 repeats) failed 5 of 5 at line 1006 (`drag.fullGetValueCalls` 2, limit 1). Cases 2 and 3 share the extra full `getValue` signature.
- Part 2a (first bad commit): bisect from `87ac345f`, the last change to the three spec files.
- Part 2a result: cases 1 and 2 have the first bad commit `83984892` (fix(602), native Undo walk to a proved host state). The parent `ecaf1fa7` passes (case 1 3 of 3, case 2 5 of 5); `83984892` fails (0 of 3, 0 of 5) with the same signatures. Case 3 was not bisected. Lead, not yet measured: the Task 602 history-base hook serializes the whole document with `getValue()` on the first entry of an empty Undo stack. Logs in `tmp/700/p2a/`.
- Part 1: measure the cause of each case and propose a fix contract.
- Part 1 result (measured with temporary call-site instrumentation, logs under the worktree `tmp/700/p1/`):
  - (a) Task 602 history base: the first Undo entry defers a full `getValue()` to an idle callback, which lands in the IR seed window (case 1, line 138: 255 ms) and in the warm hover window (case 2: 1 counted call). With the idle read removed, case 2 passes.
  - (b) Hidden behind case 1 line 138: line 245 counts 28 whole-document Lute calls in the first-edit window (`provesExact` projections and block-handle `projectionMatches`). Not from Task 602; first bad commit not yet known.
  - (c) Case 3: a drag reaches the Details exact fallback, which serializes twice (`captureCalloutActionTarget` and `snapshotMarkdown`). Not from the history base.
  - Removing the history base breaks Task 602 Undo (`selection-performance.spec.ts:405`), so it is required; no case is a test defect.
- Decisions (provisional, the Owner may reverse them): D1 (b) and (c) stay in this task, since the acceptance names these cases. D2 (fix for (a)): pending a second opinion. Part 1 proposes a text-free base marker; the Vditor Undo stack drops its oldest entry past `stackSize`, so a stack-length flag cannot identify the base on its own.
- D2 (provisional, from a read-only second opinion): replace the history-base text with an opaque base ID bound to the original Undo entry object. `history-base` becomes `{mode, baseId, revision}`, and transitions carry optional `beforeBaseId`/`afterBaseId`. The host proves a base endpoint only when the ID matches the registered one for that mode and the host text equals the recorded host text. A stack-length flag is rejected: a probe showed that after 51 entries and 49 Undo steps the last entry is not the original base. Guards: no base for a first entry whose checkpoint flush did not publish (G1), and none during Preview-first checkbox reconstruction (G2). No cached webview text is provably equal to the rendered base on every open path.
- Part 2c: RED tests for D2 first, then the fix.
- Part 2c RED: 14 new Vitest tests fail for the expected reasons (no base ID, a base text read, missing host method); the 259 existing tests in those files pass. GREEN next.
- Part 2c GREEN returned (not yet verified by the orchestrator): ID-based base, idle read removed, G1 and G2 guards; the worker reports all unit, typecheck, lint and build checks exit 0.
- Orchestrator check of the GREEN candidate (2026-11-08): the diff holds only the 18 owned files; Vitest on the touched files and `media-src/src/boot`, typecheck, lint and build all exit 0. Independent review: three Chromium e2e specs still use the removed base API and message shape (`exact-actions-after-edit`, `open-deferred-work`, `preview-mode`; the webview typecheck does not cover `media-src/e2e`); a skipped first-entry base leaves the old tag; a base without a numeric revision is accepted. Provisional decision D2a: reject a base whose revision is not a number. A content check on `afterBaseId` is declined for now (no current writer breaks the invariant; residual risk). Host resyncs that do not advance the revision exist before this change (recorded only).
- Real VS Code with the GREEN build (XTEST, one run, 15 passed, 3 failed): `large-document-interaction.spec.ts:416` passes. `incremental-seed.spec.ts:64` still fails at line 138 (66 ms, limit 50; was 221). Two regressions: `selection-performance.spec.ts:471` now fails at line 403 (Undo in `editThenUndo` does not restore the host) and `undo-host-coupling.spec.ts:1345` (large WYSIWYG Undo leaves the host dirty and longer). The other Task 602 Undo specs (`undo-host-coupling` other cases, `undo-first-edit`, `init-before-seed`) pass. Diagnosis of the regressions next, then one repair round.
- Decision D3 (provisional): `selection-performance.spec.ts` line 1014 (`coldOpen.fullGetValueCalls`) stays in this task, because the acceptance needs the whole case at line 471 to pass. Line 998 is treated as flaky until it fails again.
- Part 1d (diagnosis of the two regressions, real-VS-Code traces): one shared cause. The candidate sends the base endpoint only when the tagged base entry object is on top of the stack after the move. Vditor pushes later entries above the base with the same Markdown but different HTML: in WYSIWYG, an after-render entry that differs only by the inline table style that responsive tables add; in IR after a WYSIWYG visit, an entry with a different list structure. The host then has no base proof and rolls back. G1 and G2 are not involved. Proposed repair: alias view-state-only entries to the base, and accept an endpoint whose text equals the saved base rendering; a gap remains for a first-visit structural entry. Escalated (hard design issue) to a second read-only consultation.
- Part 1c (trace of (c) and line 1014, real-VS-Code traces):
  - Line 1014 (`coldOpen`): cause (a), first bad `83984892`; the extra call is the history-base text read. The cause (a) candidate removes it (1 call in both runs). No separate fix.
  - Cause (c), line 1006: the drag settle receives an index entry without units (the fixture is noncanonical: exact source differs from the rendering, and since `1d8e37a9` the exact key is no longer the rendering, so the projection check rejects it). The Details state is then `'unknown'` and the exact fallback serializes twice and inserts 4 live markers (line 1007, hidden). The earlier bisect note that the state is `'wrap'` counted every call in the test, not the drag's own settle call.
  - Hidden line 1015 (`coldAfterEdit`): 5 full reads, from the Task 607 exact-authority path (index build, acquire, request, receive, unitless-hover rebuild).
  - Line 998: 0 failures in 3 runs that reached it.
- Decision D4 (provisional): fix (c) with advisory units resolved on the rendered text for the passive Details state only, without a projection proof (multi-member blocks keep the exact fallback); the Details action still captures exact source. Decision D5 (provisional): line 1015 stays in this task as cause (d), by the same reasoning as D3. Part 2d (RED then GREEN for (c)) dispatched.
- Second consultation on the base repair: the aliasing repair is unsafe. Its text normalization can hide an authored change (two counterexamples where the normalized HTML is equal but the Markdown differs). Decision D6 (provisional): keep registration text-free and recognize a base endpoint by value only during Undo/Redo. Accept the endpoint when its rendering equals a trusted cached base rendering (same mode slot and generation, original base entry still present). Otherwise serialize the base snapshot once at Undo/Redo time (outside the first-edit window) and cache it per base. Never set the cache from an unproved entry. Apply the same lifecycle checks to the start endpoint. Repair round next, together with the review findings.

### Bisect of causes (b) and (c)

- (b) `incremental-seed.spec.ts` line 245: first bad commit `83984892` (Task 602); its parent `ecaf1fa7` passes 3/3. The earlier note that (b) does not come from Task 602 is wrong.
- (c) `selection-performance.spec.ts:471` line 1006: first bad commit `1d8e37a9` (Task 607); its parent `5db51f21` makes no full `getValue` call during the drag. `readDetailsSelectionState` returns `'wrap'` at both commits, so the Details fallback is reached by another path, not yet traced.
- Separate: line 1014 of the same spec fails at `5db51f21` and later; line 998 failed once in three runs at `34456d4e`.
