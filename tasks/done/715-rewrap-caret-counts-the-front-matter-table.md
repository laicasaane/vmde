# Task 715 — Rewrap caret lands at the wrong place when the document has front matter

**Status:** done (2026-11-09). Fix `8e3e55a8`. Split out of Task 700 (decision D15).
**Origin:** Task 700 full real-VS-Code run.
**Severity:** medium (estimated). After Rewrap in IR or WYSIWYG, the caret is not where the user left it.
**Tech stack:** the Rewrap command and its caret re-assert, the injected front-matter properties table (Task 207).
**Depends on:** none.

## Problem

`test/vscode-e2e/rewrap.spec.ts:116` fails at line 423 ("document rewrap caret in ir", and the same in WYSIWYG). It already fails on `dev` before Task 700. First bad commit: `53a45de3` (Task 207).

Measured cause, from Task 700: the caret re-assert after Rewrap uses a character offset that counts the text of the injected front-matter table. The table is not part of the editable body text, so the offset lands too far.

## Proposed work

1. Confirm the cause in real VS Code (offset before and after Rewrap, with and without front matter).
2. Make the caret re-assert ignore the injected front-matter table, with a failing unit test first.

## Decisions

- D1 (provisional, 2026-11-09, orchestrator, R3): option 2-A from Task 700 Part 1h. The document-scope frame re-assert in `rewrap-command.ts` uses the caret marker's Text node and offset while that node is connected, and falls back to the flat text offset otherwise. Options 2-B (skip non-editable subtrees in every flat-offset count) and 2-C (drop the frame re-assert) rejected.

## Progress

- 2026-11-09 Part 2 (sonnet-medium, session `d7c36698`, settings seen claude-sonnet-5-5 / medium): fix and two unit tests in `rewrap-command.test.ts` (RED before the fix: the caret landed in the first paragraph). Vitest editing 104 files / 2964 tests, typecheck, lint:ci, build exit 0.

- 2026-11-09 orchestrator: diff reviewed (only `rewrap-command.ts` and its test). Real VS Code, one call: `rewrap.spec.ts`, `rewrap-non-round-trip.spec.ts`, `front-matter-table.spec.ts` 9 of 9 passed, including `rewrap.spec.ts:116` (IR, WYSIWYG and SV loop). `npm run quality` exit 0. Full-suite run of `rewrap.spec.ts:116` moves to the next full gate (provisional).

## Acceptance

- [x] `rewrap.spec.ts:116` passes in IR, WYSIWYG and SV alone (9 of 9 with its guard specs). Full suite: at the next full gate (provisional).
- [x] A unit test covers the caret offset with a front-matter table present.
- [x] `npm run quality` passes.
