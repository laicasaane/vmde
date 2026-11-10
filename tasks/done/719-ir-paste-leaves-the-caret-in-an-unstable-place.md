# Task 719 — IR paste leaves the caret in an unstable place

**Status:** done (2026-11-10).
**Origin:** Owner report, 2026-11-09.
**Severity:** high (estimated). Every paste in IR can leave the caret away from the end of the pasted text, so the next key goes to the wrong place.
**Tech stack:** Vditor IR paste (`fixBrowserBehavior.ts` `paste`, IR `input`), VMDE paste listener in `media-src/src/editing/undo-boundaries.ts`, Vditor source patches in `esbuild-shared.mjs`, VMDE selection writers (`util/selection-write.ts`, caret re-asserts).
**Depends on:** none.

## Problem

Owner report: after a paste in IR mode the caret does not land at the correct position, and where it lands changes from one paste to the next (not deterministic). The Owner reproduced it with the caret inside an inline code span inside a table cell.

Not yet known: which writer moves the caret (Vditor's paste insert, a VMDE re-assert, the Undo snapshot, or a re-render), whether timing or load decides the landing place, and which other constructs are affected.

## Decisions

- D1 (provisional, orchestrator, 2026-11-10): fix option 1 from the Part 1b measurement. The pre-paste checkpoint in `boundary()` (`undo-boundaries.ts:572`) arms a caret intent at the pre-paste caret; when the first frame runs before the post-paste checkpoint timer, the caret authority writes that stale position back (confirmed: 56 of 57 frame-first runs wrong, 0 of 63 timer-first runs wrong; 410 runs without a pre-paste intent never wrong). The fix retires the intent right after that checkpoint (`invalidateCaret()`), following the Task 597 precedent at `undo-boundaries.ts:706`. Option 2 (paste as an invalidating gesture in `caret.ts`) was not chosen because it depends on listener order.
- D2 (provisional, orchestrator, 2026-11-10): the Vditor `TypeError` at `fixBrowserBehavior.ts:1519` on every paste into inline code is fixed in this task (null-safe lookup through a source patch), as a second step after Task 720 Part 2a lands, because both change `media-src/esbuild-shared.mjs`.
- D3 (provisional, orchestrator, 2026-11-10): the unescaped `|` and the backtick split in table-cell code, and the deterministic multi-block landings (caret after a pasted table or fence, block inserted after the current block), are not the reported race; they are filed as separate tasks outside this queue.

## Proposed work

1. Part 1: a `@probe` real-VS-Code spec measures the caret after a real Ctrl+V in IR, repeated, with the table-cell inline-code case first and a wider matrix after it; a selection-write tracer names the code that moves the caret.
2. Decide the fix from the measured mechanism (ask the Owner if it changes paste behavior).
3. Fix with a failing test first, and a focused real-VS-Code spec.

## Acceptance

- [x] The landing place is measured for the table-cell inline-code case and the wider matrix, with the moving writer named. The pre-paste undo checkpoint armed a stale caret intent, and the first frame after the paste restored it (`ir-paste-caret-probe.spec.ts`).
- [x] After a paste in IR the caret is at the end of the pasted text in every measured case, on every repeat.
- [x] The next typed key lands at that place.
- [x] The focused real-VS-Code spec and the existing paste specs pass.
- [x] `npm run quality` passes.

## Verification (2026-11-10)

- Fix 1 (D1): `invalidateCaret()` after the pre-paste checkpoint (`undo-boundaries.ts`). `ir-paste-caret.spec.ts` failed 2 of 8 repeats per case before the fix and passes 8 of 8 after it.
- Fix 2 (D2): the Vditor patch `patchPasteInlineCodePreview` makes paste into inline code null-safe. Before it, every such paste threw `TypeError: Cannot read properties of null (reading 'classList')` and skipped the rest of `paste()`. After it, the pasted text and the next typed key land in place in a paragraph and in a table cell, and the saved Markdown is correct.
- `node build.mjs`: pass. Real VS Code: `ir-paste-caret`, `paste-over-selection`, `paste-plain-chord`, `paste-real`, `paste-table`, `paste-url-link`, `undo-boundaries`: 15 passed. `npm run quality`: all stages pass.

## Owner approval

- 2026-11-10 (Owner, chat): "I approve to close 719–725 as they are now." Every provisional decision in this record is accepted as final.
