# Task 670 — Extend the selection source proof to front matter and math blocks

**Status:** planned (2026-10-18). Filed at the close of Tasks 606 and 630; waits for a future batch.
**Origin:** Task 604, Task 606.
**Severity:** medium (estimated).
**Tech stack:** `media-src/src/editing/selection-source-proof.ts` and the block pairing it relies on; `rewrap-command.ts`.
**Depends on:** Task 604, Task 606.

## Problem

Task 606 made Rewrap Document, selection Rewrap and auto-wrap proof-only in IR and WYSIWYG. The proof cannot pair a front matter block or a `$$` math block, so every caret in such a document is unprovable and Rewrap Document declines there. Known limitation for the preview release.

## Proposed work

Teach the proof to pair front matter and `$$` math blocks. Restore the front matter and math block to the `DOCUMENT` constant of `rewrap.spec.ts` (real VS Code).

## Acceptance

- Rewrap Document, selection Rewrap and auto-wrap work in IR and WYSIWYG on a document with front matter and a `$$` block.
- The CHANGELOG known-limitation bullet is removed.
- [ ] Focused real-VS-Code spec written and run; `npm run quality` passes.
