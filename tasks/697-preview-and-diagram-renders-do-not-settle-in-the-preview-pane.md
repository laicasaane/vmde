# Task 697 — Preview and diagram renders do not settle, or measure wrong, in the Preview pane at `f84a4258`

**Status:** planned (2026-11-02). Filed from the full real-VS-Code gate of queue run 2026-11-01d.
**Origin:** Gate rerun at `f84a4258` (Task 695): the suite failed these cases in chunks and again when each spec file ran alone (`--workers=1 --retries=0`, XTEST, fresh X server per file).
**Severity:** medium (estimated; Preview shows missing or unfinished diagrams, or wrong geometry, in a full-suite run and alone).
**Tech stack:** `test/vscode-e2e/{diagram-render-sweep,diagram-sizing,mode-switch-render-reuse,preview-rehighlight,wavedrom-theme,parity,wysiwyg-parity,preview-spacing,sv-split}.spec.ts`; Preview render pipeline in `media-src/src/`.
**Depends on:** none.

## Problem

These cases fail in the full suite and again alone at `f84a4258`:

- `diagram-render-sweep.spec.ts:1221`: `.vditor-preview .language-markmap svg` is not visible after 30 s.
- `diagram-sizing.spec.ts:14`: the sizing poll stays false for 30 s.
- `mode-switch-render-reuse.spec.ts:210` and `:359`: "Preview pane finished rendering every engine after the switch" is false.
- `preview-rehighlight.spec.ts:90`: "Preview settled on visit 1 (highlighted + d2 swapped)" is false.
- `wavedrom-theme.spec.ts:173`: the Preview-pane background poll stays false for 30 s.
- `parity.spec.ts:51`: IR and Preview code-block heights differ (for example ir 110 against pv 22).
- `wysiwyg-parity.spec.ts:158`: 5 diagram pairs compared where more than 10 are expected.
- `preview-spacing.spec.ts:87`: the edit-surface lookup `edit.found` is false.
- `sv-split.spec.ts:31`: `previewOffset` is 37.2 where less than 30 is expected (section sync).

Typing is not involved, so the X keymap limit is not a cause. Whether the render-not-settled cases share one cause with the geometry cases is not measured.

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
