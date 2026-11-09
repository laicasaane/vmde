# Task 715 — Rewrap caret lands at the wrong place when the document has front matter

**Status:** planned (2026-11-09). Split out of Task 700 (decision D15).
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

## Acceptance

- [ ] `rewrap.spec.ts:116` passes in IR, WYSIWYG and SV, alone and in the full suite.
- [ ] A unit test covers the caret offset with a front-matter table present.
- [ ] `npm run quality` passes.
