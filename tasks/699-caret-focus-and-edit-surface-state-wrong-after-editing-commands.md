# Task 699 — Caret, focus and edit-surface state or command results are wrong after editing commands at `f84a4258`

**Status:** planned (2026-11-02). Filed from the full real-VS-Code gate of queue run 2026-11-01d.
**Origin:** Gate rerun at `f84a4258` (Task 695): the suite failed these cases in chunks and again when each spec file ran alone (`--workers=1 --retries=0`, XTEST, fresh X server per file).
**Severity:** medium (estimated; deterministic assertion failures in editing commands, extent of user impact not measured).
**Tech stack:** `test/vscode-e2e/{id-insertion-mode-fidelity,link-button-url,table-operations,rewrap,marker-reveal,callout-edit,callout-arrow-nav,section-fold,bare-url-autolink}.spec.ts`; editing code in `media-src/src/editing/`.
**Depends on:** none.

## Problem

These cases fail in the full suite and again alone at `f84a4258`:

- `id-insertion-mode-fidelity.spec.ts:140` (WYSIWYG): the host text holds `before <a id="mode-wysiwyg"></a>selected prose after` where `before selected prose after` is expected at the failing comparison.
- `link-button-url.spec.ts:148` (WYSIWYG): a selected URL stays plain text, with no `[url](url)` link.
- `table-operations.spec.ts:48`: a table row is padded (`| r0a  | r0b  |`) where `| r0a | r0b |` is expected; `:242`: the WYSIWYG range transaction never becomes ready.
- `rewrap.spec.ts:116`: scroll position is not kept (`scrollKept` false).
- `marker-reveal.spec.ts:172`: the parent keeps class `vditor-ir__marker` after the caret leaves.
- `callout-edit.spec.ts:41`: click on `after paragraph` times out.
- `callout-arrow-nav.spec.ts:71`: ArrowDown does not put the caret in the callout body text.
- `section-fold.spec.ts:495`: `.vmde-block-handle` stays visible where hidden is expected.
- `bare-url-autolink.spec.ts:340`: 8 decorations where at least 10 are expected after the setting is restored.

Task 696 (rewrap) is filed separately and is not the cause of `rewrap.spec.ts:116` unless the measurement shows it. Whether the cases share one cause is not measured.

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
