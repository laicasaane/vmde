# Task 727 — IR paste of a table or fenced code block lands in the wrong place

**Status:** planned (2026-11-10).
**Origin:** found by the Task 719 paste measurement, 2026-11-10 (filed separately under 719 D3, provisional).
**Severity:** medium (estimated). Deterministic, on every multi-block paste.
**Tech stack:** Vditor IR paste of multi-block HTML (`fixBrowserBehavior.ts` `insertHTML`, `setRangeByWbr`), the VMDE caret authority (`caret.ts`).
**Depends on:** Task 719 (stale caret intent fix) should land first.

## Problem

Measured in real VS Code (48 of 48 runs each):
- Pasting a table: the table is inserted after the current block, not at the caret, and the caret stays on the editable root before the table; the next typed key becomes a new paragraph before the table.
- Pasting a fenced code block: the fence is inserted after the current block, and the caret goes to a new empty paragraph after it.

## Proposed work

1. Decide the expected landing (split the current block at the caret, or insert after it) and the caret position after the pasted block, consistent with the edit modes' other block inserts.
2. Failing real-VS-Code spec first, then the fix.

## Acceptance

- [ ] Pasted tables and fenced code blocks are inserted at the agreed position, and the caret lands at the end of the pasted content.
- [ ] Focused real-VS-Code spec and `npm run quality` pass.
