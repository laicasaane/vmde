# Task 711 — IR: a cancelled composition reformats the document

**Status:** planned (2026-11-08).
**Origin:** Split from [Task 698](done/698-key-and-chord-results-differ-in-xtest-specs.md) at its closure (Part 2c, `shortcut-identity.spec.ts:1247`).
**Severity:** medium (estimated). With an input method such as IBus, pressing Ctrl+Shift+U and then Escape in IR marks the document dirty and rewrites it in Lute's form.
**Tech stack:** vendored Vditor IR `compositionend` handler (`media-src/node_modules/vditor/src/ts/ir/index.ts:112-117`), VMDE's SV cancelled-composition guard (Task 629), the IR input path and host write-back.
**Depends on:** none.

## Problem

Measured in Task 698 Part 2c under `XMODIFIERS=@im=ibus`: Ctrl+Shift+U starts IBus Unicode entry. On Escape the input method sends an empty composition update, an input event and `compositionend` with empty data. Vditor's IR `compositionend` handler calls `input()` even when the composition was cancelled. The block is rebuilt, the space after the word becomes `&nbsp;`, and the host receives the whole-document serialization: 174517 characters grow to 181855, first difference at offset 66, document dirty. VMDE guards a cancelled composition only in SV (Task 629), not in IR (and WYSIWYG is unchecked).

Repro: in IR with IBus running, put the caret after a word in a file that does not round-trip byte for byte, press Ctrl+Shift+U, then Escape.

## Proposed work

1. Write a failing test first: a cancelled composition in IR (and WYSIWYG, if affected) leaves the host text unchanged and the document clean.
2. Guard the cancelled composition in IR (and WYSIWYG if affected) like the SV guard, without patching unrelated Vditor input paths.
3. Real-VS-Code test: drive the composition events (the XTEST environment no longer runs an input method after Task 698, so dispatch the composition sequence in the webview, or start an IBus session explicitly in a `@probe` spec).

## Acceptance

- [ ] A test fails before and passes after the fix for IR (and WYSIWYG if affected).
- [ ] A real-VS-Code spec shows a cancelled composition leaves the file unchanged and clean.
- [ ] `npm run quality` passes.
