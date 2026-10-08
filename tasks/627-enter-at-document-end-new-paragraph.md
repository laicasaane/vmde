# Task 627 — Enter at the end of the document does not open a new paragraph to type in

**Status:** planned (2026-10-08).
**Origin:** Project Owner report (2026-10-08).
**Severity:** medium (estimated). A basic authoring action needs a workaround.
**Tech stack:** webview Enter handling (`media-src/src/editing/`, Vditor IR/WYSIWYG/SV Enter paths), real VS Code with XTEST.

## Problem

The Owner reports: pressing Enter at the last position in the file should insert a new paragraph block to write in. Today the Owner has to type a character first, then place the caret before that character and press Enter to get a new paragraph block.

So with the caret at the very end of the document, Enter does not give a new empty paragraph the user can type into. The workaround shows that Enter works when the caret is not at the document end. The report does not say which mode or which kind of last block was involved, so the investigation has to measure that.

## Related

- [Task 625](625-ir-enter-next-char-wrong-block.md): in IR, after Enter at the end of the last paragraph, the first typed character lands at the end of the previous paragraph (measured as `lima.Y`). This is likely the same cause or an overlapping one.
- [Task 608](608-remaining-blockless-caret-routes.md) and [Task 600](done/600-no-blockless-caret-in-ir.md): IR carets that sit at the document root, outside any block.
- [Task 486](done/486-repeated-enter-after-callout-code-caret-snapback.md) and [Task 428](done/428-list-editing-usability-vs-real-editors.md): earlier Enter and list-Enter work. Check them, and the double-Enter list-exit fix in the CHANGELOG 1.4.0 Fixed section, for rules that must keep working.

## First steps

1. Reproduce in real VS Code with OS-level keys (XTEST) in IR, WYSIWYG and SV. Cover these last-block kinds: paragraph, heading, list item, blockquote, code block, table, callout or details, horizontal rule, and an empty document. Test each with and without a trailing newline in the file.
2. For each case, record the DOM after Enter (is there a new block, and where is the caret?), what the next typed character does, the host bytes, and the Undo steps.
3. Compare with Enter at the end of a middle block.
4. Use Task 625's evidence to decide whether the two tasks should be merged.

## Acceptance

- [ ] Enter at the end of the document opens a new empty paragraph after the last block. For a list item or blockquote, Vditor's normal continue and exit rules apply. Inside a fenced code block, Enter stays a newline in the code.
- [ ] The caret is inside the new paragraph, and the next typed character lands there.
- [ ] The saved markdown is the expected text: one paragraph appended, exact bytes elsewhere.
- [ ] One Undo removes the new paragraph.
- [ ] A real-VS-Code XTEST spec covers the measured cases in each mode.
- [ ] Task 602's Undo specs and the list-Enter undo specs stay green.

## Tests

- Real VS Code with XTEST: Enter at the document end, then one character, in IR, WYSIWYG and SV for the last-block kinds above.
- Chromium harness or Vitest for any Enter or caret helper that changes.
