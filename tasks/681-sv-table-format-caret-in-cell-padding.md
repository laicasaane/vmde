# Task 681 — SV Format Table declines silently with the caret in cell padding

**Status:** planned (2026-11-01). Filed at the close of Task 669; waits for a future batch.
**Origin:** Task 669 (review finding F2, accepted limit).
**Severity:** low (estimated; the command fails closed, nothing is lost).
**Tech stack:** `media-src/src/editing/sv-source-proof.ts` (`proveSvOffsets`), `media-src/src/editing/table-format-command.ts`, `test/vscode-e2e/table-format.spec.ts`.
**Depends on:** Task 675 for the cases that follow a mode switch; the direct-open case does not need it.

## Problem

In Source mode, Lute pads table cells. A caret placed inside that padding (spaces with no image in the exact text) is unprovable, so `proveSvOffsets` declines and Format Table does nothing and shows nothing. Task 669 recorded it as F2: "a caret inside table cell padding ... is unprovable, so the table command declines silently. This follows the contract (no write from an unproven position)." The Vitest case "an endpoint inside a normalized-only region (for example table padding): declines with no write" pins the current behavior. A user who clicks at the end of a padded cell gets no feedback and no format.

## Proposed work

When a caret endpoint is unprovable but lies inside the same table cell as a provable offset, snap it to the nearest proven offset in that cell (the cell text edge nearest to the caret) and continue. A non-collapsed selection, an endpoint outside any cell, or a cell with no provable offset keeps declining with no write. Never snap across a cell boundary or a row.

## Acceptance

- [ ] A caret in cell padding (left, right, and an empty cell) formats the table; host bytes outside the table span stay equal to the exact text.
- [ ] A caret that cannot be snapped inside its own cell still declines with no write, no DOM change, no history entry.
- [ ] Vitest: snapped offset per padding position; refusal across cells; CRLF exact text against LF editor text.
- [ ] Focused real-VS-Code spec written and run; quality stages pass.

## Tests to write

- Vitest in `sv-source-proof.test.ts` and `table-format-command.test.ts`.
- Real VS Code: a Source-mode table with a caret placed in padding, Format Table, one Undo, Save.
