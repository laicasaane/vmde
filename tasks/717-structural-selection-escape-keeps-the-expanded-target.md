# Task 717 — structural-selection: Escape keeps the expanded target (`structural-selection.spec.ts:198`)

**Status:** planned (2026-11-09). Found during Task 714.
**Origin:** Task 714 guard runs in real VS Code.
**Severity:** medium (estimated). The full real-VS-Code suite stays red on this case, so new regressions in structural selection are harder to see.
**Tech stack:** structural selection (Task 288), `media-src/src/editing/selection-scope.ts` (Escape step-out), Task 580 Expand Selection, Task 710 caret restore.
**Depends on:** none.

## Problem

`test/vscode-e2e/structural-selection.spec.ts:198` ("real IR structural selection stages scopes without stealing format chords") fails at line 310: after Expand Selection on the `REPLACED` text and one Escape, `expandedTarget(frame, 'REPLACED')` stays `true` (expected `false`). Once it failed at line 308 instead.

Measured rates:

- On the base `88dc7f49`, without any Task 714 change: fails 5 of 6 (`--repeat-each=6`).
- With Task 714: fails 4 of 5 (alone and in combined runs).
- The Task 710 record already lists this case as pre-existing (5 of 6).

Not yet known: whether the test or the product is wrong, and the first bad commit.

## Proposed work

1. Measure what happens to the selection and the expansion state between the Escape keydown and the poll: which handler takes the Escape, and whether a later caret restore puts the expanded selection back.
2. Decide whether the test or the product is wrong. For a product defect, find the first bad commit.
3. Fix with a failing test first.

## Acceptance

- [ ] The cause is measured, with the first bad commit if it is a product defect.
- [ ] `structural-selection.spec.ts:198` passes 5 of 5 (`--repeat-each=5`) and in the full suite.
- [ ] `npm run quality` passes.
