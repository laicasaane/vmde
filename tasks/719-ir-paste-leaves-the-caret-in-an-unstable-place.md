# Task 719 — IR paste leaves the caret in an unstable place

**Status:** in progress (2026-11-09). Part 1 (measurement and cause) running.
**Origin:** Owner report, 2026-11-09.
**Severity:** high (estimated). Every paste in IR can leave the caret away from the end of the pasted text, so the next key goes to the wrong place.
**Tech stack:** Vditor IR paste (`fixBrowserBehavior.ts` `paste`, IR `input`), VMDE paste listener in `media-src/src/editing/undo-boundaries.ts`, Vditor source patches in `esbuild-shared.mjs`, VMDE selection writers (`util/selection-write.ts`, caret re-asserts).
**Depends on:** none.

## Problem

Owner report: after a paste in IR mode the caret does not land at the correct position, and where it lands changes from one paste to the next (not deterministic). The Owner reproduced it with the caret inside an inline code span inside a table cell.

Not yet known: which writer moves the caret (Vditor's paste insert, a VMDE re-assert, the Undo snapshot, or a re-render), whether timing or load decides the landing place, and which other constructs are affected.

## Proposed work

1. Part 1: a `@probe` real-VS-Code spec measures the caret after a real Ctrl+V in IR, repeated, with the table-cell inline-code case first and a wider matrix after it; a selection-write tracer names the code that moves the caret.
2. Decide the fix from the measured mechanism (ask the Owner if it changes paste behavior).
3. Fix with a failing test first, and a focused real-VS-Code spec.

## Acceptance

- [ ] The landing place is measured for the table-cell inline-code case and the wider matrix, with the moving writer named.
- [ ] After a paste in IR the caret is at the end of the pasted text in every measured case, on every repeat.
- [ ] The next typed key lands at that place.
- [ ] The focused real-VS-Code spec and the existing paste specs pass.
- [ ] `npm run quality` passes.
