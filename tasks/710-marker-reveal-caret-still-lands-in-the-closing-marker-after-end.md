# Task 710 — marker-reveal: the caret still lands in the closing marker after End

**Status:** planned (2026-11-08).
**Origin:** Split from [Task 708](done/708-undo-snapshot-caret-restore-moves-the-caret-back-into-a-marker-or-to-offset-0.md) at its closure. Task 708 fixed the Undo snapshot restore that moved an element-boundary caret back into the closing marker; `marker-reveal.spec.ts` still fails without that writer.
**Severity:** medium (estimated). After End, the next typed character can land inside a hidden closing marker.
**Tech stack:** the marker-reveal frame in `media-src/src/editing/editor-caret.ts`, caret intents in `media-src/src/editing/caret.ts`, the vendored Vditor IR input path; specs `test/vscode-e2e/marker-reveal.spec.ts`, `test/vscode-e2e/rewrap.spec.ts`, `test/vscode-e2e/github-inline-math.spec.ts`.
**Depends on:** none.

## Problem

After Task 708, `marker-reveal.spec.ts` fails 3 of 6 runs (4 of 6 on the parent `6844f1af`) in `navigateAndType`: after the key, the caret's parent class contains `vditor-ir__marker`. The writer is not known. The Undo snapshot restore is excluded: `undo-snapshot-caret.spec.ts` passes 18 of 18 with the Task 708 fix.

`rewrap.spec.ts:323` failed 2 of 8 runs before Task 708 with caret offset 0 instead of 13 in the first IR iteration after open. It did not reproduce in 8 + 12 + 12 runs since; its mechanism is unmeasured.

Added at the Task 698 closure: `github-inline-math.spec.ts:351` (SV) fails alone at `:374` (typed source differs from the selected-source expectation). Task 698 Part 2a classed it as the Undo snapshot (`addCaret` ← `sourceNeutral`) moving a caret placed after the snapshot was armed. Task 708's fix covers only an Element-container caret; the SV caret sits in a Text node.

## Proposed work

1. Measure first: record every selection write (stack and timestamp) between End and the typed key in a failing `marker-reveal` run, as Task 703 Part 2c did.
2. Write a failing test for the measured writer.
3. Fix the product cause, or the spec if the spec is wrong (state which, with evidence).
4. Rewrap offset 0: keep a probe running alongside; if it reproduces, measure the writer; if it does not reproduce in 24 runs, record that and close the item.

## Acceptance

- [ ] The writer that puts the caret back in the marker is measured.
- [ ] A focused test fails before and passes after the fix.
- [ ] `marker-reveal.spec.ts` passes 6 of 6 runs with no retry.
- [ ] `github-inline-math.spec.ts:351` (SV) passes, or its writer is measured and fixed.
- [ ] The rewrap offset-0 case is measured, or recorded as not reproduced in 24 runs.
- [ ] `npm run quality` passes.
