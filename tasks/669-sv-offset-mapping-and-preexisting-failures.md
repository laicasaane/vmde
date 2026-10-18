# Task 669 — SV offset mapping and failures that also occur on dev

**Status:** planned (2026-10-18). Filed at the close of Tasks 606 and 630; waits for a future batch.
**Origin:** Task 630, Task 606.
**Severity:** low (estimated).
**Tech stack:** `media-src/src/editing/list-normalize-source-command.ts`, `table-format-command.ts`, `rewrap-command.ts` (`mapCaretOffsetByLine`), `test/vscode-e2e`, `media-src/e2e`.
**Depends on:** Task 630, Task 606.

## Problem

(1) `mapCaretOffsetByLine` still authorizes SV table-format and list-normalize writes. (2) The SV list-normalize cell of Task 630 (`vmde.fixListNumbering` after typing) did not change the host and was dropped from the spec. (3) These specs fail on `dev` as well: `shortcut-negative.spec.ts:509` (IR, WYSIWYG), `callout-ir.spec.ts:597`, `link-popover.spec.ts:241`, `list-normalize.spec.ts:77`, `outline-reorder.spec.ts:15` and `:187`, `auto-wrap.spec.ts:31` (`Paragraph 401 ... not found in IR`), `rewrap.spec.ts` (`scrollKept: false`, line ~430), `ir-click-index.spec.ts:641` (test recorder admission predicate drift), `large-document-interaction.spec.ts:416` (`getValueCalls` 1, expected 0) and `selection-performance.spec.ts:471` (selection direction assertion, line ~985) in real VS Code.

## Proposed work

Replace `mapCaretOffsetByLine` for the SV writes with a proof-based mapping, restore the SV list-normalize cell, and triage each listed failure (fix, or move the expectation).

## Acceptance

- No SV write is authorized by line mapping alone.
- The SV list-normalize cell exists and passes.
- Each listed failure is fixed or recorded with a reason.
- [ ] Focused real-VS-Code spec written and run; `npm run quality` passes.
