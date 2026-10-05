# Task 619 — SV delete of a selection that starts at a line start joins the previous line

**Status:** planned (2026-10-05). The Project Owner approved filing this record on 2026-10-05. Implementation has not started.
**Origin:** [Task 614](done/614-sv-collapsed-cut-deletes-document.md) follow-up 1, measured in real VS Code and the Chromium harness during that task.
**Severity:** high. A common edit (Delete, Backspace, type-over or cut of a selection) removes a newline outside the selection, so two source lines merge.
**Scope:** SV (split view source pane), every deletion of a non-collapsed selection that starts at a line start. Keep Task 614's collapsed copy/cut line behavior unchanged.

## Problem

In SV, select text that starts at the beginning of a line and delete it. Chromium also deletes the newline that ends the previous line, so the previous line joins the rest of the current one.

## Measured evidence

Task 614 build (based on HEAD `9253dd61`), source `Alpha line\nBravo line\nCharlie line\n`:

| Layer | Selection and action | Result | Expected |
| --- | --- | --- | --- |
| Real VS Code 1.129.0 | `Bravo` at the start of `Bravo line` (via `Selection.modify`), Ctrl+X | `Alpha line line\nCharlie line\n` | `Alpha line\n line\nCharlie line\n` |
| Chromium harness | content `Bravo line`, Delete or `execCommand("delete")` | `Alpha line\nCharlie line` | `Alpha line\n\nCharlie line\n` |
| Chromium harness | the whole line `Bravo line\n`, any boundary shape, Delete or `execCommand("delete")` | `Alpha lineCharlie line` | `Alpha line\nCharlie line\n` |

- A range that starts at the end of the previous line's content, before its newline span, deletes exactly its text (Task 614).
- Task 614 fixed only the collapsed Ctrl+X line cut, which now selects a safe range before its delete. A user selection of the same line still hits the defect. Its `remove` range in `svLine` (`media-src/src/clipboard/clipboard-line.ts:153`) and the SV branch of `patchCutDeleteSync` (`media-src/esbuild-shared.mjs:1084`, hook `__vmdeSelectSvLineDelete` at `:1117`) do not run for a real selection.
- Delete, Backspace and type-over were not measured one by one in real VS Code. They probably share the cause, because `execCommand("delete")` reproduces it.

## Reproduction

1. Open `Alpha line\nBravo line\nCharlie line\n` in SV.
2. Select `Bravo` from the start of the second line.
3. Press Ctrl+X (or Delete). The first and second lines merge.

## Suspected cause

- Each SV source line ends with `<span data-type="newline"><br><span style="display: none">\n</span></span>` (Lute `SpinVditorSVDOM`; Task 614 checked it in Node).
- A selection that starts at a line start begins just after the previous newline span. Chromium's delete of that range also removes the hidden `\n` text inside the previous newline span. The `<br>` stays, so the view looks right until the re-spin.
- The SV source is the editor's text, so the lost `\n` joins the lines.

## Candidate approaches

1. Before a native delete (`beforeinput` for `deleteContent*`, `insertText`, `insertFromPaste`, and the cut handler), move a start that sits just after a newline span to an equivalent position that Chromium deletes exactly, as Task 614's `remove` range does. A content-only selection needs the newline kept, so the shifted range must remove the same characters.
2. Handle SV deletions of a non-collapsed selection as a source edit, and re-render, instead of relying on Chromium's DOM delete.

## Tests

- **Vitest:** the start normalization for a line start, the first line, a line after a blank line and a range across re-spun blocks; a selection not at a line start is untouched.
- **Chromium:** in `media-src/e2e/copy-cut.spec.ts` or a new SV spec, Delete, Backspace, type-over and real-selection cut of `Bravo` and of `Bravo line` give the expected sources above; one Undo is exact.
- **Real VS Code** (build first, `--retries=0`, OS-level XTEST): the same legs, checking host text and the clipboard for the cut.

## Acceptance

- [ ] SV: Delete, Backspace, type-over and cut of a selection that starts at a line start remove only the selected characters (Chromium and real VS Code).
- [ ] One Undo restores the exact source.
- [ ] Task 614's collapsed copy/cut results and the IR/WYSIWYG clipboard tests are unchanged.
