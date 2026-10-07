# Task 617 — Keep the whole-document selection through the first keydown after opening

**Status:** planned (2026-10-05). The Project Owner approved filing this record on 2026-10-05. Implementation has not started.
**Origin:** [Task 613](done/613-select-all-collapses-after-undo-snapshot.md) follow-up 3. Related: Task 580 P6 (CP1-3d) and the Task 580 CP4-1 callout finding fixed by `766eb74a`.
**Severity:** medium. Delete or type-over of a whole-document selection silently keeps the last paragraph. One Undo restores the exact source.
**Scope:** IR on a fresh one-entry history (no edit since the document opened). The live Chromium selection after Vditor's `recordFirstPosition`. See [Task 621](621-ir-select-all-delete-large-keeps-tail.md) for the large-fixture result that may share this cause.

## Problem

Open a document in IR, select the whole document, and press Delete or type over it before any other edit. The last paragraph stays.

## Measured evidence

Chromium harness, Task 613 build (based on HEAD `91befe15`), opening snapshot settled, no edit, Select All to the document stage:

| History | Delete | Type-over `X` | Undo |
| --- | --- | --- | --- |
| fresh, one entry | `final paragraph\n` | `Xfinal paragraph\n` | exact |
| past the first entry (after an edit) | `\n` | `X\n` | exact |

- The DOM Range stays `(root, 0)–(root, N)`, but `document.execCommand('delete')` afterwards still keeps `final paragraph`.
- Task 613 measured the same desync after the undo snapshot's `addCaret`: `Selection.toString()` was 90 of 106 characters. Writing the same endpoints again with `setBaseAndExtent` restored all 106 characters. Task 613 fixed that path only.
- `media-src/e2e/structural-selection.spec.ts:323-326` makes an edit first to avoid this path.

## Related findings

- **Task 580 P6 (CP1-3d):** first actions make raw node/offset selection snapshots stale.
- **`766eb74a` (Task 580 CP4-1 callout finding):** `media-src/src/editing/format-hotkey-guard.ts:188-217` now stores a text-less Range across Vditor's first-keydown text-node split as a caret, so Activate Link at Caret finds its caret. That fix covers the command selection snapshot only. The live Chromium selection is still desynchronized.
- **[Task 598](done/598-first-edit-undo-baseline.md)** plans `vmdeSeedBaseline` inside `recordFirstPosition`, which also calls `addCaret` without a restore. A fix here must cover both paths, and the two tasks patch the same Vditor file.

## Reproduction

1. Open a multi-paragraph document in IR and wait past `undoDelay` (800 ms). Do not edit.
2. Place the caret in a paragraph and press Ctrl+A until the whole document is selected.
3. Press Delete. The last paragraph stays.

## Suspected cause

- Vditor's `recordFirstPosition` (`media-src/node_modules/vditor/src/ts/undo/index.ts:84-108`) runs on keydown while the mode's undo stack has exactly one entry and no redo.
- It calls `addCaret(vditor)` (`:100`, defined at `:227`), which inserts a `vditor-wbr` span at the range start and removes it, with no restore.
- After that insert and removal at `(root, 0)`, Chromium keeps reporting the same DOM Range while its internal selection has shrunk (the Task 613 measurement). The Delete keydown, or the Ctrl+A keydown before it, is such a first keydown.

## Candidate approaches

1. Patch `recordFirstPosition` (build-time patch in `media-src/esbuild-shared.mjs`) to rewrite the saved selection with `setBaseAndExtent` after `addCaret`, as Task 613 does for the snapshot.
2. Route the first-keydown rewrite through the caret authority's forced first write (`media-src/src/editing/caret.ts`).

## Tests

- **Vitest:** patch drift guards in `test/backend/vditor-source-patches.test.ts`, composed with `patchUndoCaretSplitRestore` and Task 598's planned patch.
- **Chromium:** a fresh one-entry history leg in `structural-selection.spec.ts`: Delete gives `\n`, type-over gives `X\n`, one Undo is exact. Check `Selection.toString()` length against the document text.
- **Real VS Code** (build first, `--retries=0`, OS-level XTEST): the same legs on a freshly opened document, checking host text.

## Acceptance

- [ ] IR, fresh one-entry history: whole-document Delete gives `\n` and type-over `X` gives `X\n` (Chromium and real VS Code).
- [ ] One Undo restores the exact source.
- [ ] The `766eb74a` caret-snapshot behavior, Task 613's snapshot restore and the undo step counts are unchanged in their focused tests.
