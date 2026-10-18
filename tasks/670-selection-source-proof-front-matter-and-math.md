# Task 670 — Extend the selection source proof to front matter and math blocks

**Status:** planned (2026-10-18). Filed at the close of Tasks 606 and 630; waits for a future batch.
**Origin:** Task 604, Task 606.
**Severity:** medium (estimated).
**Tech stack:** `media-src/src/editing/selection-source-proof.ts` and the block pairing it relies on; `rewrap-command.ts`.
**Depends on:** Task 604, Task 606.

## Problem

Task 606 made selection Rewrap, auto-wrap and heading shift proof-only in IR and WYSIWYG. The proof cannot pair a front matter block, so these three actions do nothing on a document that has front matter (a non-round-trip document with a `$$` block is affected too). Known limitation for the preview release. Rewrap Document was left on its line-based caret mapping: its proof-only version was flaky in real VS Code after a document replace or mode switch (the owned exact snapshot differed from the host text by one byte), so it is part of this task.

## Proposed work

Teach the proof to pair front matter and `$$` math blocks. Find why the owned exact snapshot can differ from the host text by one byte after a replace or mode switch, then make Rewrap Document proof-only again (the removed cases are in the 606 history: Vitest, Chromium and real-VS-Code document steps). Pin the front matter limitation tests in `rewrap-non-round-trip.test.ts` the other way.

## Acceptance

- Rewrap Document, selection Rewrap, auto-wrap and heading shift work in IR and WYSIWYG on a document with front matter and a `$$` block.
- The CHANGELOG known-limitation bullet is removed.
- [ ] Focused real-VS-Code spec written and run; `npm run quality` passes.
