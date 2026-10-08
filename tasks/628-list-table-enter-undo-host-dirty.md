# Task 628 — Undo after Enter and a key in a list item or table cell leaves the host dirty

**Status:** planned (2026-10-08). The Project Owner approved filing this record on 2026-10-08. Implementation has not started.
**Origin:** Task 625/627 probe (commit 630bd01b, `test/vscode-e2e/enter-new-paragraph-probe.spec.ts`), real VS Code with XTEST.
**Severity:** high (estimated). Host and view diverge after Undo, and the host stays dirty.
**Tech stack:** extension host undo/history walk (`src/session/`), webview Enter handling, real VS Code with XTEST.

## Problem

In IR and WYSIWYG, pressing Enter and then a key inside a list item or the last table cell, then pressing Ctrl+Z twice, leaves the document in the wrong state. The host keeps the typed key while the view loses it, and the host stays dirty.

## Evidence

From the probe spec, measured in real VS Code with XTEST:

- IR and WYSIWYG list (`- echo\n- foxtrot`): Enter then Y gives `- Y`. The first Ctrl+Z runs a native host Undo and then Redo. The host keeps the typed key while the view loses it. The second Ctrl+Z restores the view to the opened text but does not change the host, so the host stays dirty with the typed key.
- IR and WYSIWYG table last cell: Enter gives a `<br>`, and Y lands in the cell (`hotelY`). The undo behavior is the same as for the list.
- Paragraph, heading, blockquote and code cases undo normally: two host steps back to the opened bytes, and the host is clean.
- SV list: the first Undo leaves the host at `- foxtrot\n- \n`, and the second returns it to the opened bytes.

## Suspected cause (unverified)

The host history walk from [Task 602](done/602-undo-step-spanning-host-edits.md) does not find the view's text in native history, because the view holds an empty list item or cell state that the host never wrote. Needs measuring before any fix.

## Tests

- Real-VS-Code XTEST legs that reuse the probe cells: IR and WYSIWYG list, IR and WYSIWYG table last cell.
- Each leg: open, Enter, type a key, Ctrl+Z twice, then assert host text equals the opened bytes and the host is clean. Then Redo twice and assert symmetry.
- Keep the paragraph, heading, blockquote and code cases as regression controls.

## Acceptance

- [ ] Root cause measured and recorded here.
- [ ] After Enter, a key and two Undos, the host equals the opened bytes and is clean, in IR and WYSIWYG for list and table.
- [ ] Redo is symmetric in the same cases.
- [ ] SV list undo behavior recorded (and fixed if it is also wrong).
- [ ] Control cases (paragraph, heading, blockquote, code) still undo normally.
- [ ] Focused real-VS-Code spec written and run; `npm run quality` passes.

Related: [Task 602](done/602-undo-step-spanning-host-edits.md), [Task 625](625-ir-enter-next-char-wrong-block.md), [Task 627](627-enter-at-document-end-new-paragraph.md).
