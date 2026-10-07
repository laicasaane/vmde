# Task 625 — In IR, the first character typed after Enter at a paragraph end lands in a neighbouring block

**Status:** planned (2026-10-07).
**Origin:** found by the Task 602 S3b probe (real VS Code 1.129.0, XTEST). It is identical on the pre-602 product and on `dev` at `092b59e0`, so Task 602 did not cause it and does not fix it.
**Severity:** looks high, because typed text appears in the wrong block. It is measured only under XTEST input, so the first step is to confirm it with a normal key route.
**Tech stack:** IR mode caret handling in the webview (`media-src/src/editing/`), real VS Code with XTEST.

## Problem

In IR mode, press Enter at the end of a paragraph. The caret is in the new empty `<p>` at offset 0, but the next typed character does not go there:

- when another block follows, the character lands at the start of that following block (for example `YEcho ...`);
- when the paragraph was the last block, it lands at the end of the previous paragraph (for example `lima.Y`, or `lima.XY` after an earlier `X`).

## Evidence

- Task 602 S3b probe, 16 cells on the pre-602 product and 16 on `dev`, identical in every cell.
- Deterministic and independent of timing and of earlier typing: the same result with pauses of 100 ms and 1,000 ms, with and without a preceding `X`.
- The probe logs were kept in the Task 602 session scratchpad only and are not retained. The result has to be re-measured.

## First step

Confirm the defect with a normal key route (not only XTEST), and check how it relates to [Task 600](done/600-no-blockless-caret-in-ir.md) and [Task 608](608-remaining-blockless-caret-routes.md), which deal with IR carets that sit outside their block.

## Acceptance

- [ ] A real-VS-Code spec reproduces the misplacement on `dev` and shows it is removed by the fix, for an Enter at the end of a middle paragraph and at the end of the last paragraph, at 100 ms and 1,000 ms pauses.
- [ ] The cause is identified with evidence, and its relation to Tasks 600 and 608 is recorded.
- [ ] The first typed character after Enter lands in the new paragraph, and the markdown round-trip is unchanged.
- [ ] Task 602's Undo specs and the list-Enter undo specs stay green.

## Tests

- Real VS Code with XTEST: Enter at a paragraph end, then one character, in IR with and without a following block.
- Chromium harness or Vitest for any caret helper that changes.
