# Task 618 — SV type-over of a whole-document selection leaves extra blank lines

**Status:** planned (2026-10-05). The Project Owner approved filing this record on 2026-10-05. Implementation has not started.
**Origin:** [Task 613](done/613-select-all-collapses-after-undo-snapshot.md) follow-up 4, measured in the Chromium harness during that task.
**Severity:** low. The result has one or two extra newlines. One Undo restores the exact source.
**Scope:** SV (split view source pane). Type-over of a whole-document selection, and the undo snapshot's SV selection capture. Coordinate with [Task 619](619-sv-line-start-delete-joins-previous-line.md), which handles the same SV newline spans.

## Problem

In SV, select the whole document and type a character. The source keeps extra blank lines. Delete of the same selection is correct.

## Measured evidence

Chromium harness, Task 613 build (based on HEAD `91befe15`), opening snapshot settled, an edit, Select All, then the action and one Undo:

| Action | Result | Expected (IR/WYSIWYG result) | Undo |
| --- | --- | --- | --- |
| Delete | `\n` | `\n` | exact |
| Type-over `X`, no pending snapshot | `X\n\n` | `X\n` | exact |
| Type-over `X` across a pending snapshot | `X\n\n\n` | `X\n` | exact |

- The undo snapshot moves the selection focus from `SPAN@1` to `#text@12`, one character shorter.
- Real VS Code was not measured for this case.

## Reproduction

1. Open a multi-paragraph document in SV and wait past `undoDelay` (800 ms).
2. Type one character, then select the whole document (Ctrl+A).
3. Type `X`. The source is `X\n\n`, or `X\n\n\n` if Vditor's snapshot ran between the selection and the key.

## Suspected cause

Not traced. Two parts are likely:

1. **The snapshot shortens the selection.** The patched selection capture (`patchUndoCaretSplitRestore` in `media-src/esbuild-shared.mjs`, endpoint mapping `vmdeCaretSelectionEndpoint` at about `:298`) maps an SV `SPAN` focus endpoint to a text position one character short. The restored selection then misses the last newline.
2. **Native insertText over SV newline spans.** Each SV line ends with `<span data-type="newline"><br><span style="display: none">\n</span></span>` (Task 614). Chromium's insert over a range that spans these spans may keep a newline that Delete removes. Compare the DOM after Delete and after `insertText`.

## Tests

- **Vitest:** the SV endpoint mapping keeps a `SPAN` focus at its full text offset.
- **Chromium:** SV type-over with and without a pending snapshot gives `X\n`, and one Undo is exact.
- **Real VS Code** (build first, `--retries=0`, OS-level XTEST): the same legs, checking host text.

## Acceptance

- [ ] SV: type-over of a whole-document selection gives `X\n`, with and without a pending undo snapshot (Chromium and real VS Code).
- [ ] The undo snapshot keeps an SV selection's focus at the same character.
- [ ] Delete and one Undo keep their exact results.
