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
