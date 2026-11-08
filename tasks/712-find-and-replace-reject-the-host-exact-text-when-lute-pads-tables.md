# Task 712 — Find and Replace reject the host's exact text when Lute pads tables

**Status:** planned (2026-11-08).
**Origin:** Split from [Task 698](done/698-key-and-chord-results-differ-in-xtest-specs.md) at its closure (Part 2c, `shortcut-identity.spec.ts:877` and `:900`).
**Severity:** high (estimated). In a document with an unpadded table, after one edit and Undo, Find shows "No results" for text that exists (SV) and Replace All changes nothing (WYSIWYG).
**Tech stack:** `media-src/src/editing/find-source.ts:128-135`, `media-src/src/bridge/edit-sync.ts:1322-1338` and `:625-633`, `media-src/src/bridge/sv-source-relation.ts:249`; Task 607 exact ownership.
**Depends on:** none.

## Problem

Bisected in Task 698 Part 2c: first bad commit `1d8e37a9` (fix(607): keep exact ownership through trusted edits and guard exact host writes); last good `374df74c`. When the editor no longer holds an exact copy of the source, Find returns no results and asks the host for its exact text. That reply is used only if the host text maps exactly to what the editor shows.

- Large SV, measured: the host reply had 174517 characters; the SV text had 181846 (Lute table padding from offset 74). Find stayed at "No results". Which check inside the comparison rejects the reply is not measured.
- Small WYSIWYG, measured: after Replace One and Undo, Replace All sent the request. The reply had 224 characters against 234 in `getValue()` (table padding at offset 187); nothing was replaced.

Repro: in SV, open a file with an unpadded table, make and undo one edit, then press Ctrl+F for a word in the file.

## Proposed work

1. Measure which check rejects the reply (SV and WYSIWYG).
2. Write a failing test first (Vitest at the relation or edit-sync level).
3. Fix so a host reply that differs only by Lute's normalization (for example table padding) is still usable for Find and Replace, without weakening the Task 607 exact-write guard. Decide with evidence which side maps to which.

## Acceptance

- [ ] The rejecting check is measured for SV and WYSIWYG.
- [ ] A test fails before and passes after the fix.
- [ ] `shortcut-identity.spec.ts:877` and `:900` pass in real VS Code.
- [ ] `npm run quality` passes.
