# Task 670 — Extend the selection source proof to front matter and math blocks

**Status:** planned (2026-10-18). Filed at the close of Tasks 606 and 630; waits for a future batch.
**Origin:** Task 604, Task 606.
**Severity:** high. Owner requirement (2026-10-19, chat): treat as the first task of the next batch.
**Tech stack:** `media-src/src/editing/selection-source-proof.ts` and the block pairing it relies on; `rewrap-command.ts`.
**Depends on:** Task 604, Task 606.

## Owner requirement (2026-10-19, chat)

Front matter must be its own, separate block. It must not affect any other feature in any way: not Rewrap, auto-wrap or heading shift, and not block handles, Move Block, Turn Into, Details, callouts, links, outline, Find or Undo. A document with front matter must behave exactly like the same document without it, with all offsets shifted by the front matter length.

## Suspected cause (read from code, not yet tested)

`scanMovableBlocks` and `pairRenderedSpans` (`media-src/src/nav/block-handle.ts`) have no front matter handling. A leading `---` / `title: x` / `---` is probably scanned as a thematic break plus other blocks, while Lute renders one front matter unit, so the block pairing fails and the whole document is unprovable. The round-trip test (`pair.exact === pair.rendered` in `selection-source-proof.ts`) may also fail for front matter.

## Problem

Task 606 made selection Rewrap, auto-wrap and heading shift proof-only in IR and WYSIWYG. The proof cannot pair a front matter block, so these three actions do nothing on a document that has front matter (a non-round-trip document with a `$$` block is affected too). Known limitation for the preview release. Rewrap Document was left on its line-based caret mapping: its proof-only version was flaky in real VS Code after a document replace or mode switch (the owned exact snapshot differed from the host text by one byte), so it is part of this task.

## Proposed work

Teach the proof to pair front matter and `$$` math blocks. Find why the owned exact snapshot can differ from the host text by one byte after a replace or mode switch, then make Rewrap Document proof-only again (the removed cases are in the 606 history: Vitest, Chromium and real-VS-Code document steps). Pin the front matter limitation tests in `rewrap-non-round-trip.test.ts` the other way.

## Acceptance

- Front matter is a first-class block kind in the scanner, the pairing and the source block index, recognised only at byte zero and closed by the next `---` or `...` line.
- A cross-feature matrix runs on a document with front matter and on the same document without it (IR and WYSIWYG): selection Rewrap, auto-wrap, Rewrap Document, heading shift, block handle, Move Block, Turn Into, Details, callout apply, selection Link, outline move, Find Replace. Each gives the same result with offsets shifted by the front matter length.

- Rewrap Document, selection Rewrap, auto-wrap and heading shift work in IR and WYSIWYG on a document with front matter and a `$$` block.
- The CHANGELOG known-limitation bullet is removed.
- [ ] Focused real-VS-Code spec written and run; `npm run quality` passes.
