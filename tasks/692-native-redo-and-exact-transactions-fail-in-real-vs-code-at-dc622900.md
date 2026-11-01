# Task 692 — Native Redo and exact-transaction cases fail in real VS Code at `dc622900`

**Status:** planned (2026-11-02). Filed from the full real-VS-Code gate of queue run 2026-11-01d.
**Origin:** Gate suite on `dc622900` (2026-11-01), confirmed by a rerun of the spec files alone (2026-11-02).
**Severity:** high (estimated; the failures are deterministic document-text differences on Redo and on exact actions, so user edits may not round-trip).
**Tech stack:** `test/vscode-e2e/block-transform.spec.ts`, `test/vscode-e2e/callout-authoring.spec.ts`, `test/vscode-e2e/toolbar-overflow.spec.ts`; host history coupling (`src/writeback/history-coupling.ts`), the exact-edit path (`media-src/src/bridge/edit-sync.ts`) and the native Undo/Redo keybindings.
**Depends on:** none.

## Problem

These cases fail in the full suite and again when their spec files run alone at `dc622900` (`--workers=1 --retries=0`, XTEST):

- `block-transform.spec.ts:47` (Turn Into QuickPick): after Undo, `Control+y` does not restore the heading; the document stays `alpha **beta**` instead of `## alpha **beta**` (`:114`).
- `block-transform.spec.ts:239` (multi-block Turn Into): the same Redo failure over two blocks.
- `block-transform.spec.ts:437` (Code Fence menu): the language edit leaves ```` ```js ```` where ```` ```ts ```` is expected.
- `callout-authoring.spec.ts:6`: the callout title field shows `Created` where `IR title` is expected.
- `toolbar-overflow.spec.ts:702` (Emoji 17 pointer selection) and `:1019` (Emoji picker in SV): the second emoji insertion is missing (`🫪` instead of `🫪🫪`).

Whether these are one cause or several is not measured. No earlier full-suite baseline exists, so the commit that introduced each failure is unknown.

## Proposed work

1. Find the last good commit for each failing case: run the spec alone on earlier `dev` revisions (bisect over the commits since the last recorded pass of each spec).
2. Group the cases by first bad commit and measure the cause of each group.
3. Fix each cause with a failing test first, or fix the test where the test, not the product, is wrong (state which).

## Acceptance

- [ ] Each failing case has a first bad commit (or is shown to be a test defect) and a measured cause.
- [ ] Each product cause is fixed with a test that fails before and passes after.
- [ ] The six cases pass in one real-VS-Code run.
- [ ] Specs sharing the changed code pass.

## Tests to write

- A Vitest case per product cause.
- The six real-VS-Code cases above are the acceptance tests; add a case only if a cause is not covered.
