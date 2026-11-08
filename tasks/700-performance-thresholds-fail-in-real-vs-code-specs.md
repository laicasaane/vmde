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

### Bisect of causes (b) and (c)

- (b) `incremental-seed.spec.ts` line 245: first bad commit `83984892` (Task 602); its parent `ecaf1fa7` passes 3/3. The earlier note that (b) does not come from Task 602 is wrong.
- (c) `selection-performance.spec.ts:471` line 1006: first bad commit `1d8e37a9` (Task 607); its parent `5db51f21` makes no full `getValue` call during the drag. `readDetailsSelectionState` returns `'wrap'` at both commits, so the Details fallback is reached by another path, not yet traced.
- Separate: line 1014 of the same spec fails at `5db51f21` and later; line 998 failed once in three runs at `34456d4e`.
