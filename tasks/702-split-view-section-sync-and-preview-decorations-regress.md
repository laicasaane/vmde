# Task 702 — Split View section sync and Split-preview bare-URL decorations regress at `f84a4258`

**Status:** planned (2026-11-02). Split from Tasks 697 and 699 (queue run 2026-11-02a) because the causes differ.
**Origin:** Gate rerun at `f84a4258` (Task 695); each spec file failed alone too.
**Severity:** medium (estimated; user-visible Split View position and missing link decorations).
**Tech stack:** `test/vscode-e2e/sv-split.spec.ts`, `test/vscode-e2e/bare-url-autolink.spec.ts`; Split View sync and Preview decoration code in `media-src/src/` (nav, links/bare-url-decorate.ts, editing/preview-render.ts).
**Depends on:** none.

## Problem

These two cases fail in the full suite and again alone at `f84a4258`:

- `sv-split.spec.ts:31` (assertion at `:220`): `previewOffset` is 37.2 where less than 30 is expected. The nearest heading is right ("12. WaveDrom") and `sourceOffset` is 0.19. Split View is not viewport-gated, so the Task 697 cause does not explain it. Last recorded pass: Task 634 (`b13461f6`, 2026-10-14).
- `bare-url-autolink.spec.ts:340`: after the setting returns to on, the Split preview has 8 decorations where at least 10 are expected. Last recorded pass: Task 655 (2026-10-18).

Candidate causes from reading only (not measured): Task 643 (`6dede194`, own Preview renderer, decorating observers wait while a Preview streams) and Task 645 (`88cc673d`, Split pane layout). Whether both cases share one cause is not measured.

## Proposed work

1. Probe both cases at `4e6547d5`, `88cc673d`, `32d6bf84` and `6dede194`; then bisect inside the pair that flips.
2. Measure the mechanism at the first bad commit.
3. Fix each product cause with a failing test first, or fix the test where the test is wrong (state which).

## Acceptance

- [ ] Each case has a first bad commit and a measured cause.
- [ ] Each product cause is fixed with a test that fails before and passes after.
- [ ] Both cases pass in one real-VS-Code run.

## Tests to write

- A test per product cause; the two real-VS-Code cases are the acceptance tests.
