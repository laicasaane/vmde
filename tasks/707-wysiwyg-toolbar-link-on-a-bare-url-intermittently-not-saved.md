# Task 707 — WYSIWYG toolbar Link on a bare URL is intermittently not saved

**Status:** planned (2026-11-08).
**Origin:** Split from [Task 699](done/699-caret-focus-and-edit-surface-state-wrong-after-editing-commands.md) at its closure: after five fixes, `test/vscode-e2e/link-button-url.spec.ts:148` (WYSIWYG) still fails 1 of 6 runs.
**Severity:** medium (estimated). A Link action the user sees in the editor can be missing from the saved file.
**Tech stack:** `media-src/src/editing/undo-boundaries.ts` (boundary publish, `mustPublishBoundary`), `media-src/src/links/link-url.ts` (explicit-edit mark), `media-src/src/bridge/edit-sync.ts` (`flushEdit`, `takeExplicitBlock`), Vditor toolbar Link in WYSIWYG.
**Depends on:** none.

## Problem

Task 699 fixed the immediate flush that dropped the explicit block, and the boundary that judged `[url](url)` equal to the bare URL on disk. In the Task 699 Part 2d run the WYSIWYG case passed 5 of 6; the failing run timed out on the 20 s poll with the host text unchanged. No boundary trace was taken, so it is not known whether the link was never made in the DOM, the explicit mark was missing or expired, or the publish was skipped. Before Task 699 the case also failed about 15 percent of runs at the parent of `3d9855e7`.

## Proposed work

1. Run the Task 699 probe P2b (selection writers, explicit mark, `options.input`, posted edits, undo entries) with the boundary decision (`mustPublishBoundary` inputs and result) added, until at least two failing runs are captured.
2. Attribute each failing run to one cause.
3. Fix with a failing test first.

## Acceptance

- [ ] Each captured failing run has a measured cause.
- [ ] Each product cause is fixed with a test that fails before and passes after.
- [ ] `link-button-url.spec.ts` passes 10 of 10 runs in WYSIWYG and IR with no retry.

## Tests to write

- A Vitest case per cause; `link-button-url.spec.ts` is the acceptance test.
