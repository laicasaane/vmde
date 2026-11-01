# Task 693 — `caret-tab-return.spec.ts` loses the anchor line in IR, WYSIWYG and SV

**Status:** planned (2026-11-02). Filed from the full real-VS-Code gate of queue run 2026-11-01d.
**Origin:** Gate suite on `dc622900` (2026-11-01), confirmed by a rerun of the spec file alone (2026-11-02).
**Severity:** medium (estimated; the caret-after-tab-return behavior or its fixture setup is broken in all three modes).
**Tech stack:** `test/vscode-e2e/caret-tab-return.spec.ts` (`:181`, `:241`), the caret restore on webview focus return (`media-src/src/editing/caret-preserve.ts`, `media-src/src/editing/focus-restore.ts`).
**Depends on:** none.

## Problem

All three cases fail alone and in the suite with the same assertion: the expected substring `Anchor line BRAVOα` is not in the received text, which starts with `# Torture document`. The cases are `:181` (IR) and `:241` (WYSIWYG and SV). Whether the anchor text is never inserted, inserted elsewhere, or read from the wrong place is not measured. The first bad commit is unknown.

## Proposed work

1. Read the failing assertion and the received text in full; decide whether the caret or the fixture setup fails.
2. Find the first bad commit by running the spec alone on earlier `dev` revisions.
3. Fix the cause with a failing test first, or fix the test if it is wrong (state which).

## Acceptance

- [ ] The cause and the first bad commit (or test defect) are recorded.
- [ ] The three cases pass in real VS Code.
- [ ] Any product fix has a regression test that fails before the fix.

## Tests to write

- The three existing cases are the acceptance tests; a Vitest case for any product cause.
