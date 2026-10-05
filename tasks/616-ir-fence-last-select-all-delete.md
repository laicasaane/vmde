# Task 616 — Delete the whole IR document when its last block is a fence

**Status:** planned (2026-10-05). The Project Owner approved filing this record on 2026-10-05. Implementation has not started.
**Origin:** [Task 613](done/613-select-all-collapses-after-undo-snapshot.md) follow-up 2, measured in the Chromium harness during that task.
**Severity:** low. The leftover is visible, and one Undo restores the exact source.
**Scope:** IR whole-document Delete and type-over when the last block is a fenced code block. Keep Task 613's selection capture and restore.

## Problem

Select the whole IR document and press Delete or type over it. When the document ends with a fenced code block, the closing fence marker stays.

## Measured evidence

Chromium harness, Task 613 build (based on HEAD `91befe15`). The opening snapshot had settled, an edit (`Z`) was made, then Select All selected the document stage, then Delete, Backspace or `X`, then one Undo:

| Last block | Delete | Type-over `X` | Undo |
| --- | --- | --- | --- |
| paragraph | `\n` | `X\n` | exact |
| table | `\n` | `X\n` | exact |
| fence | `` ```\n `` | `` X\n\n```\n `` | exact |

- The fence result is the same with and without a pending undo snapshot.
- `document.execCommand('delete')` on the same selection gives the same result, so the Vditor keydown path is not the only cause.
- Real VS Code was not measured for this case.

## Reproduction

1. Open in IR a document whose last block is a fenced code block.
2. Wait past `undoDelay` (800 ms), type one character in a paragraph, and wait again.
3. Press Ctrl+A until the whole document is selected (Range `(root, 0)–(root, N)`).
4. Press Delete. The source is `` ```\n ``, not `\n`.

## Suspected cause

Not traced. Chromium's deletion of a root Range probably leaves part of the fence's IR structure (the closing marker node), and Vditor's IR `input()` re-parses the residue as an empty fence. Check which DOM node survives the native delete, and whether a `contenteditable` or marker element in the fence blocks its removal.

## Tests

- **Chromium:** extend `media-src/e2e/structural-selection.spec.ts` with a fence-last document: Delete gives `\n`, type-over gives `X\n`, and one Undo restores the exact source. Record the DOM after the native delete in the RED run.
- **Real VS Code** (build first, `--retries=0`): the same legs with OS-level keys, checking host text.
- Controls: paragraph-last and table-last documents keep their current results.

## Acceptance

- [ ] IR, fence last: whole-document Delete gives `\n` and type-over `X` gives `X\n`, with and without a pending snapshot (Chromium and real VS Code).
- [ ] One Undo restores the exact source.
- [ ] Paragraph-last and table-last results are unchanged.
