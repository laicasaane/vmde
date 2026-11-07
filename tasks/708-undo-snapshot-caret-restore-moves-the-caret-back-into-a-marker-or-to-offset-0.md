# Task 708 — Undo-snapshot caret restore moves the caret back into a marker or to offset 0

**Status:** planned (2026-11-08).
**Origin:** Split from [Task 703](done/703-older-real-vs-code-failures-in-table-marker-rewrap-callout-and-fold-specs.md) at its closure. Joins the open follow-up "Harden the Undo `addCaret` patch so a root-level collapsed selection is not turned into a first-block text offset".
**Severity:** medium (estimated). The caret lands inside a closing marker after End, or at offset 0 after Rewrap, so the next keystroke goes to the wrong place.
**Tech stack:** Vditor undo `addCaret` (vendored, patched), `media-src/src/editing/undo-snapshot-neutral.ts`, `media-src/src/editing/undo-boundaries.ts`, the marker-reveal frame in `media-src/src/editing/editor-caret.ts`; specs `test/vscode-e2e/marker-reveal.spec.ts`, `test/vscode-e2e/rewrap.spec.ts`.
**Depends on:** none.

## Problem

Task 703 Part 2c probe (6 runs of `marker-reveal.spec.ts` `real-end-link`): after `End` the caret lands in the closing marker; the marker-reveal frame moves it out within 20–50 ms; 196–332 ms after `End` a second selection write puts it back into the marker `)` at offset 1, with paragraph `childList` records. The writer's stack is `addCaret` ← `sourceNeutral` (the undo snapshot in `undo-snapshot-neutral.ts` / `undo-boundaries.ts`), consistent with the 800 ms undo timer started by the previous typed sample. `rewrap.spec.ts:323` fails 2 of 8 runs with caret offset 0 instead of 13 in the first IR iteration after open; an undo snapshot overriding the rewrap's caret write is the likely shared cause (not measured).

## Proposed work

1. Measure why the snapshot's caret lands in the marker (element-boundary range normalized into the previous text node?) and whether the `rewrap` offset-0 runs come from the same writer.
2. Fix the snapshot caret handling (a snapshot must not move a caret that was placed after the snapshot was armed), with a failing test first.

## Acceptance

- [ ] The mechanism of both failures is measured.
- [ ] A failing Vitest case per cause passes after the fix.
- [ ] `marker-reveal.spec.ts` and `rewrap.spec.ts` pass 6 of 6 runs with no retry.

## Tests to write

- Vitest for the snapshot caret rule; the two specs are the acceptance tests.
