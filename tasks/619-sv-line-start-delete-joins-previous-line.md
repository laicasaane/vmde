# Task 619 — SV deletion of a selection at a line start or whole-document type-over corrupts newlines

**Status:** planned (2026-10-05). The Project Owner approved filing this record on 2026-10-05. Implementation has not started.
**Origin:** [Task 614](done/614-sv-collapsed-cut-deletes-document.md) follow-up 1, measured in real VS Code and the Chromium harness during that task.
**Severity:** high. A common edit (Delete, Backspace, type-over or cut of a selection) removes a newline outside the selection, so two source lines merge.
**Scope:** SV (split view source pane), both endpoints of a non-collapsed selection: the selection start (a deletion that starts at a line start joins the previous line) and the selection end (whole-document type-over leaves extra blank lines, merged from Task 618, including the undo snapshot's SV selection capture). Keep Task 614's collapsed copy/cut line behavior unchanged.

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

## Merged from Task 618 (2026-10-08)

Task 618 ("SV type-over of a whole-document selection leaves extra blank lines", filed 2026-10-05, severity low) is merged here: both defects come from the SV newline spans, one at the selection start and one at the selection end. Origin: [Task 613](done/613-select-all-collapses-after-undo-snapshot.md) follow-up 4, measured in the Chromium harness during that task. The result has one or two extra newlines; one Undo restores the exact source.

### Problem

In SV, select the whole document and type a character. The source keeps extra blank lines. Delete of the same selection is correct.

### Measured evidence

Chromium harness, Task 613 build (based on HEAD `91befe15`), opening snapshot settled, an edit, Select All, then the action and one Undo:

| Action | Result | Expected (IR/WYSIWYG result) | Undo |
| --- | --- | --- | --- |
| Delete | `\n` | `\n` | exact |
| Type-over `X`, no pending snapshot | `X\n\n` | `X\n` | exact |
| Type-over `X` across a pending snapshot | `X\n\n\n` | `X\n` | exact |

- The undo snapshot moves the selection focus from `SPAN@1` to `#text@12`, one character shorter.
- Real VS Code was not measured for this case.

### Reproduction

1. Open a multi-paragraph document in SV and wait past `undoDelay` (800 ms).
2. Type one character, then select the whole document (Ctrl+A).
3. Type `X`. The source is `X\n\n`, or `X\n\n\n` if Vditor's snapshot ran between the selection and the key.

### Suspected cause

Not traced. Two parts are likely:

1. **The snapshot shortens the selection.** The patched selection capture (`patchUndoCaretSplitRestore` in `media-src/esbuild-shared.mjs`, endpoint mapping `vmdeCaretSelectionEndpoint` at about `:298`) maps an SV `SPAN` focus endpoint to a text position one character short. The restored selection then misses the last newline.
2. **Native insertText over SV newline spans.** Each SV line ends with `<span data-type="newline"><br><span style="display: none">\n</span></span>` (Task 614). Chromium's insert over a range that spans these spans may keep a newline that Delete removes. Compare the DOM after Delete and after `insertText`.

## Tests

- **Vitest:** the start normalization for a line start, the first line, a line after a blank line and a range across re-spun blocks; a selection not at a line start is untouched.
- **Chromium:** in `media-src/e2e/copy-cut.spec.ts` or a new SV spec, Delete, Backspace, type-over and real-selection cut of `Bravo` and of `Bravo line` give the expected sources above; one Undo is exact.
- **Real VS Code** (build first, `--retries=0`, OS-level XTEST): the same legs, checking host text and the clipboard for the cut.
- Merged from Task 618: **Vitest:** the SV endpoint mapping keeps a `SPAN` focus at its full text offset. **Chromium:** SV type-over of a whole-document selection, with and without a pending snapshot, gives `X\n`, and one Undo is exact. **Real VS Code** (build first, `--retries=0`, OS-level XTEST): the same legs, checking host text.

## Acceptance

- [ ] SV: Delete, Backspace, type-over and cut of a selection that starts at a line start remove only the selected characters (Chromium and real VS Code).
- [ ] One Undo restores the exact source.
- [ ] Task 614's collapsed copy/cut results and the IR/WYSIWYG clipboard tests are unchanged.
- [ ] SV: type-over of a whole-document selection gives `X\n`, with and without a pending undo snapshot (Chromium and real VS Code).
- [ ] The undo snapshot keeps an SV selection's focus at the same character.
- [ ] Whole-document Delete and one Undo keep their exact results.

## Part 1 handoff (2026-10-08)

Agent `opus-high` (Opus 5.5, requested effort high; runtime metadata unverified). Read-only; one scratch Node script ran Lute `SpinVditorSVDOM` on sample sources.

- Start endpoint: every SV line ends with a newline span (`<br>` plus a hidden `\n`). Chromium's editing delete widens a selection that starts at a line start back to just after the previous `<br>`, so the hidden `\n` is deleted and the lines join. Routes: native Delete, Backspace, type-over, and the SV cut (`execCommand("delete")` in `patchCutDeleteSync`). Vditor's SV Backspace keydown branch for a block-start selection joins the same way. Range shifting cannot fix content-only selections; `Range.deleteContents()` is DOM-exact.
- End endpoint (Task 618): SV Select All leaves the focus at `(lastNewlineSpan, 1)`; the Task 613 snapshot capture (`vmdeCaretSelectionEndpoint`) maps it to a text offset that restores before the `<br>`, so the selected line break leaves the selection on type-over with a pending snapshot.
- Reader: Vditor's SV `getValue` adds one `\n` to the host text; acceptance uses the host reader (`serializeSvForHost`). The record's 618 values came from `getValue` and must be remeasured with both readers.
- Design: a VMDE-owned DOM-exact edit, used only when a non-collapsed SV edit starts at the start of a source line other than the first (`start > 0 && text[start-1] === '\n'`). It deletes the exact range, inserts typed text, merges blocks, places the caret in the start block, marks user input and dispatches an `input` event so Vditor's own SV input path re-spins and takes one Undo snapshot (Undo grouping unchanged). Whole-document, mid-line and Task 614 line-cut routes stay native. For 618 the snapshot capture keeps an SV newline-span endpoint as a raw `{node, offset}`.
- Steps: S1 helper `media-src/src/editing/sv-selection-edit.ts` (new module id in `scripts/module-manifest.mjs`) with Vitest; S1b snapshot endpoint mapping in `media-src/esbuild-shared.mjs` with patch tests; S3a Chromium RED legs before wiring; S2 wiring (Backspace keydown, `beforeinput`, cut bridge); S3b Chromium GREEN; S4 real-VS-Code XTEST and command-cut legs.
- Orchestrator rulings: accepted D1–D8 (gated ownership, new module, synthetic input event, Backspace pre-emption for owned selections only, paste only on a measured RED, raw endpoint capture, host reader for acceptance, synchronous owned cut with real VS Code as the authority). Pre-existing Vditor SV issues seen while reading (Enter over a selection, the Backspace `start === 1` branch, IME over a line-start selection, `insertHTML` paste sub-paths, a collapsed caret at `(nl,1)`) are out of scope and go to the Owner at queue end.
