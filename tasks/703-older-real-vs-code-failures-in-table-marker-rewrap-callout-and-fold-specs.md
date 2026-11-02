# Task 703 — Older real-VS-Code failures in table-operations, marker-reveal, rewrap, callout-edit and section-fold

**Status:** planned (2026-11-02). Split from Task 699 (queue run 2026-11-02a): these cases failed before 2026-10-20 and each has its own cause.
**Origin:** Gate rerun at `f84a4258` (Task 695); each spec file failed alone too.
**Severity:** low (estimated; mostly test defects, one possible product layout defect).
**Tech stack:** `test/vscode-e2e/{table-operations,marker-reveal,rewrap,callout-edit,section-fold}.spec.ts`; `media-src/src/nav/block-handle.ts`, callout context panel.
**Depends on:** none.

## Problem

Each case below has its own cause; each is listed separately:

- `table-operations.spec.ts:48` (WYSIWYG rectangle copy): the spec expects the padded row `| r0a  | r0b  |` and receives `| r0a | r0b |`, which equals the fixture source and the IR expectation (the Task 699 record listed it the wrong way round). Failing since the spec moved to XTEST keys (Task 578, 2026-09-27).
- `table-operations.spec.ts:242`: mode stays `ir`, so the WYSIWYG range transaction never becomes ready; the spec clicks the mode menu with no readiness wait.
- `marker-reveal.spec.ts:172` (fails at `:165`): the parent keeps class `vditor-ir__marker` after Home/End; the check reads the caret once, possibly before the frame that moves it.
- `rewrap.spec.ts:116` (fails at `:423`, sometimes `:308`): `scrollKept` false; recorded as a known failure since Task 606 (2026-10-14).
- `callout-edit.spec.ts:41` (fails at `:126`): the click on `after paragraph` is intercepted by `.vmde-callout-controls` in `.vmde-callout-context-panel`; failing since at least 2026-10-19.
- `section-fold.spec.ts:495` (fails at `:1000`): `.vmde-block-handle` stays visible after the post-normalization decline; failing since at least Task 641 (2026-10-15); candidate `bb4cbf18` (Task 607).

## Proposed work

1. Probe each case on current `dev` with one change at a time (poll instead of one-shot read; readiness wait; log values; read panel and paragraph rects); bisect `section-fold` at `bb4cbf18^` vs `bb4cbf18`.
2. Decide test defect or product defect per case from the measurement.
3. Fix with a failing test first.

## Acceptance

- [ ] Each case has a measured cause and a test-or-product call.
- [ ] Each product cause is fixed with a test that fails before and passes after.
- [ ] The listed cases pass in one real-VS-Code run.

## Tests to write

- The fixed specs; a test per product cause.
