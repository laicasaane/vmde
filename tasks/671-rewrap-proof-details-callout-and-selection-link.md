# Task 671 — Task 606 follow-up: Details and callout regression tests, selection link step

**Status:** planned (2026-10-18). Filed at the close of Tasks 606 and 630; waits for a future batch.
**Origin:** Task 606, Task 666.
**Severity:** low (estimated).
**Tech stack:** `media-src/src/editing`, `media-src/e2e`, `test/vscode-e2e`.
**Depends on:** Task 606, Task 666.

## Problem

Task 606 closed as partial by design. Left out: regression tests for Details and callout apply over the proof path, and the selection-link step (the selection link still refuses on the Rewrap path).

Also left out: a real-VS-Code auto-wrap case on a normalizing document (a first version typed its character at the previous caret because the synthetic caret was reset; place the caret with a real click), and real-VS-Code and Chromium cases for Rewrap Document on a normalizing document (they return with Task 670).

## Proposed work

After Task 666 lands, add the regression tests and implement the selection-link step on the proof path.

## Acceptance

- Details and callout apply have regression tests on the proof path.
- The selection link step is implemented and tested.
- [ ] Focused real-VS-Code spec written and run; `npm run quality` passes.
