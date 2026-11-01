# Task 690 — Remaining low review notes on Tasks 673, 674 and 681

**Status:** planned (2026-11-01). Filed at the close of Tasks 673, 674 and 681.
**Origin:** Task 673 (review lows L3 to L6), Task 674 (review low b), Task 681 (review low).
**Severity:** low (estimated; each note affects neutral bytes, one history entry on a decline path, or defence in depth only).
**Tech stack:** Part 1: `src/writeback/writeback-controller.ts`, `src/markdown/minimal-diff-writeback.ts`. Part 2: `media-src/src/editing/callouts.ts`. Part 3: `media-src/src/editing/table-format-command.ts` (`snapCaretIntoCell`), `media-src/src/editing/table-operations.ts`.
**Depends on:** none.

For each part, decide fix or record-as-accepted, with a reason. Fix with a failing test first where a test can reach the case. Record the decision in the part's acceptance item.

## Part 1 — Task 673 residuals L3 to L6

### Problem

- L3: the baseline's cursor is not advanced on a match in the preferred source; it affects only which of two equal byte choices is taken.
- L4: repeated identical blocks may drop padding when the sources pair differently; neutral bytes only.
- L5: the flag is set with strict equality of the document and the exact content while other checks normalize line ends (pre-existing comparison).
- L6: two panels on one document keep separate controllers (pre-existing).

### Proposed work

Per note, decide fix or accept. L3 and L4 are reachable at unit level in `minimal-diff-writeback.ts` (build the two sources so they pair differently). L5 and L6 are pre-existing behavior of the controller; accept unless a case with a measurable effect is found.

### Acceptance

- [ ] L3: fixed with a failing test first, or recorded as accepted with a reason.
- [ ] L4: fixed with a failing test first, or recorded as accepted with a reason.
- [ ] L5: fixed with a failing test first, or recorded as accepted with a reason.
- [ ] L6: fixed with a failing test first, or recorded as accepted with a reason.

## Part 2 — Task 674 review low (b): the callout apply decline path

### Problem

In `media-src/src/editing/callouts.ts`, the decline path of the callout apply restores the document with `outer.setValue(pair.exact)` when the caret marker is missing (`:630`, then `return false`). That `setValue` can arm Vditor's delayed after-render record, and nothing retires it on this path. A caret-only Undo entry may appear later. Task 674 retired the record only on the success path (`checkpointEditorUndo(inner)` at `:632`). Not measured; outside the acceptance of Task 674.

### Proposed work

Measure whether the record is armed and whether a later history entry appears after a declined apply. If it does, retire the record on the decline path without adding a history entry for a declined apply.

### Acceptance

- [ ] The decline path is measured (record armed or not; extra history entry or not).
- [ ] If an extra entry appears: a failing Vitest case first (the mocked `setValue` arms the record the way Task 674's harness does), then the fix; a declined apply adds no history entry.
- [ ] If not: recorded as accepted with the measurement.

## Part 3 — Task 681 review low: the table index in `snapCaretIntoCell`

### Problem

`snapCaretIntoCell` in `media-src/src/editing/table-format-command.ts` requires the exact-side cell to have the same row and column as the editor-side cell. It does not compare the table index. If the exact text and the editor text pair two tables differently, a row and column match could belong to another table. No test can reach this case today (defence in depth).

### Proposed work

Decide whether to compare the table index (or the table's start offset against the proven region) or accept the gap. The region proof, `planSvRegionEdit` and the rollback already refuse a write outside the formatted table; confirm that in the decision.

### Acceptance

- [ ] Fixed, or recorded as accepted with a reason that names the guard that makes it unreachable.
- [ ] If fixed: a Vitest case in `media-src/src/editing/table-format-command.test.ts` that reaches it, failing first; the Task 681 padding cases still pass.

## Tests to write

- Vitest per fixed note, in the test file of the changed module (`media-src/src/editing/callouts.test.ts`, `media-src/src/editing/table-format-command.test.ts`, and the minimizer and controller tests for Part 1).
- Real VS Code only if a fix changes webview behavior a user can reach (batch with the other specs of the round); otherwise none.
