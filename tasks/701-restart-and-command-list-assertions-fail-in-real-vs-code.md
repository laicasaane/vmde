# Task 701 — Restart-state and context-menu command-list assertions fail in real VS Code at `f84a4258`

**Status:** planned (2026-11-02). Filed from the full real-VS-Code gate of queue run 2026-11-01d.
**Origin:** Gate rerun at `f84a4258` (Task 695): the suite failed these cases in chunks and again when each spec file ran alone (`--workers=1 --retries=0`, XTEST, fresh X server per file).
**Severity:** low (estimated; ordering of a command list and restart state; user impact not measured).
**Tech stack:** `test/vscode-e2e/{webview-context-menu,outline-state,wiki-persistent-keys}.spec.ts`; `package.json` menus; Outline and wiki state in `src/`.
**Depends on:** none.

## Problem

These cases fail in the full suite and again alone at `f84a4258`:

- `webview-context-menu.spec.ts:15`: the command list order differs: `vmde.rewrap` and `vmde.rewrapDocument` come before `vmde.promoteHeading` and `vmde.demoteHeading` where the reverse order is expected.
- `outline-state.spec.ts:635`: fourth launch (Preview) shows an empty document where `# Fixture outline-restart-4.md` is expected.
- `wiki-persistent-keys.spec.ts:334`: fourth launch, "pending means unstyled before the update" differs.

The measurement decides whether the test or the product is wrong in each case.

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
