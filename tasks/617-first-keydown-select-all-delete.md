# Task 617 — Whole-document Delete in IR keeps part of the document

**Status:** planned (2026-10-05). The Project Owner approved filing this record on 2026-10-05. Implementation has not started.
**Origin:** [Task 613](done/613-select-all-collapses-after-undo-snapshot.md) follow-up 3. Related: Task 580 P6 (CP1-3d) and the Task 580 CP4-1 callout finding fixed by `766eb74a`.
**Severity:** medium. Delete or type-over of a whole-document selection silently keeps the last paragraph. One Undo restores the exact source.
**Scope:** IR whole-document Delete and type-over that leaves part of the document. Covers a fresh document (this task, one-entry history with no edit since opening, the live Chromium selection after Vditor's `recordFirstPosition`), the large fixture after Undo (merged from Task 621), and a document ending in a code block that leaves the closing fence (merged from Task 616). Paragraph-last and table-last documents are controls. Keep Task 613's selection capture and restore.

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

## Merged from Task 621 (2026-10-08)

Task 621 ("IR whole-document Delete on the large fixture keeps the last two blocks", filed 2026-10-05, severity medium) is merged here. Origin: Task 580 CP4-1 classification runs (2026-10-05). Pre-existing: identical on the pre-580 build `8c2ec1f0` and on HEAD `0138a286`. One Undo restores the exact source.

### Problem

Open the large synthetic fixture in IR, press Select All twice to select the whole document, and press Delete. The host keeps the last two blocks of the source instead of becoming empty.

### Measured evidence

Real VS Code 1.129.0, Linux X11, Xvfb + Openbox, OS-level XTEST keys, `--retries=0`. Fixture `test/vscode-e2e/fixtures/large-observable-models-synthetic.md` (174,517 characters), IR.

Steps: caret collapsed 2 characters into a word in a paragraph, Ctrl+A, wait 700 ms, Ctrl+A, wait 700 ms, Delete, wait for the host, wait 1,200 ms, Ctrl+Z.

| Variant | First Ctrl+A | Second Ctrl+A | Host after Delete | Editor after Delete | After one Undo |
| --- | --- | --- | --- | --- | --- |
| Fresh document | 429 characters (block stage) | whole document (192,548 rendered characters) | 14,296 characters, a suffix of the source | 2 top-level children, 14,234 text characters | exact, clean |
| After Bold (Ctrl+B) and its Undo | 429 characters | whole document | 429 characters, a suffix of the source | 2 top-level children, 426 text characters | exact, clean |

- The two builds gave the same numbers (logs `cls-pre2.log` on `8c2ec1f0` and `cls-head1.log` on `0138a286`). The key route differs: `8c2ec1f0` handled Ctrl+A in a webview capture listener; HEAD runs `vmde.selectAll` as an editor action.
- The first pre-580 run (`cls-pre1.log`) used an earlier probe without the suffix check and gave different numbers; it is not counted. Rerun both builds before the RED baseline.
- Evidence: session scratch logs from a temporary classification spec (`zz-cls580.spec.ts`) in a scratch worktree. Neither is committed; the numbers above are copied from them.

### Reproduction

1. Open the large synthetic fixture in IR.
2. Optional: select a word, press Ctrl+B, wait 1.2 s, press Ctrl+Z.
3. Place the caret in a paragraph. Press Ctrl+A twice, 0.7 s apart. The whole document is selected.
4. Press Delete. The last two blocks remain.

### Suspected cause

Not traced. Leads:

- The fresh variant matches this task's cause: the first keydowns after opening run Vditor's `recordFirstPosition` → `addCaret` (`media-src/node_modules/vditor/src/ts/undo/index.ts:84-108`), and Chromium's internal selection shrinks while the DOM Range still reports the whole document.
- The after-Undo variant is not a one-entry history with an empty redo stack, so `recordFirstPosition` returns early there. Another `addCaret`-style marker insert (the undo snapshot or Undo's restore) or the Delete path itself may shrink the selection. Compare `Selection.toString()` length with the document text before Delete.
- Check the kind of the last two blocks (a fence would match the Task 616 case below).

## Merged from Task 616 (2026-10-08)

Task 616 ("Delete the whole IR document when its last block is a fence", filed 2026-10-05, severity low) is merged here. Origin: [Task 613](done/613-select-all-collapses-after-undo-snapshot.md) follow-up 2, measured in the Chromium harness during that task. The leftover is visible, and one Undo restores the exact source.

### Problem

Select the whole IR document and press Delete or type over it. When the document ends with a fenced code block, the closing fence marker stays.

### Measured evidence

Chromium harness, Task 613 build (based on HEAD `91befe15`). The opening snapshot had settled, an edit (`Z`) was made, then Select All selected the document stage, then Delete, Backspace or `X`, then one Undo:

| Last block | Delete | Type-over `X` | Undo |
| --- | --- | --- | --- |
| paragraph | `\n` | `X\n` | exact |
| table | `\n` | `X\n` | exact |
| fence | `` ```\n `` | `` X\n\n```\n `` | exact |

- The fence result is the same with and without a pending undo snapshot.
- `document.execCommand('delete')` on the same selection gives the same result, so the Vditor keydown path is not the only cause.
- Real VS Code was not measured for this case.

### Reproduction

1. Open in IR a document whose last block is a fenced code block.
2. Wait past `undoDelay` (800 ms), type one character in a paragraph, and wait again.
3. Press Ctrl+A until the whole document is selected (Range `(root, 0)–(root, N)`).
4. Press Delete. The source is `` ```\n ``, not `\n`.

### Suspected cause

Not traced. Chromium's deletion of a root Range probably leaves part of the fence's IR structure (the closing marker node), and Vditor's IR `input()` re-parses the residue as an empty fence. Check which DOM node survives the native delete, and whether a `contenteditable` or marker element in the fence blocks its removal.

## Tests

- **Vitest:** patch drift guards in `test/backend/vditor-source-patches.test.ts`, composed with `patchUndoCaretSplitRestore` and Task 598's planned patch.
- **Chromium:** a fresh one-entry history leg in `structural-selection.spec.ts`: Delete gives `\n`, type-over gives `X\n`, one Undo is exact. Check `Selection.toString()` length against the document text.
- **Real VS Code** (build first, `--retries=0`, OS-level XTEST): the same legs on a freshly opened document, checking host text.
- Merged from Task 621: **Chromium:** a large-document leg (the same fixture or a privacy-safe generated one), fresh and after Bold+Undo: whole-document Delete gives `\n`; one Undo is exact. Record `Selection.toString()` length before Delete in the RED run. **Real VS Code** (build first, `--retries=0`, OS-level XTEST): the two variants in the table above, checking host length and exactness without printing fixture text.
- Merged from Task 616: **Chromium:** extend `media-src/e2e/structural-selection.spec.ts` with a fence-last document: Delete gives `\n`, type-over gives `X\n`, and one Undo restores the exact source, with and without a pending snapshot. Record the DOM after the native delete in the RED run. **Real VS Code** (build first, `--retries=0`): the same legs with OS-level keys, checking host text. Controls: paragraph-last and table-last documents keep their current results.

## Acceptance

- [ ] IR, fresh one-entry history: whole-document Delete gives `\n` and type-over `X` gives `X\n` (Chromium and real VS Code).
- [ ] One Undo restores the exact source.
- [ ] IR, large fixture, fresh and after an edit and its Undo: Select All to the document stage then Delete leaves an empty document (`\n`) in Chromium and real VS Code; one Undo restores the exact source and the document is clean (from Task 621).
- [ ] IR, fence last: whole-document Delete gives `\n` and type-over `X` gives `X\n`, with and without a pending snapshot (Chromium and real VS Code) (from Task 616).
- [ ] Paragraph-last and table-last results are unchanged.
- [ ] Task 613's small-document results are unchanged.
- [ ] The `766eb74a` caret-snapshot behavior, Task 613's snapshot restore and the undo step counts are unchanged in their focused tests.

## Part 1 handoff (2026-10-08)

Agent `opus-high` (Opus 5.5, requested effort high; runtime metadata unverified). Read-only.

- Fresh one-entry history still reproduces after Task 598: with stacks 1/0 Vditor's `recordFirstPosition` runs `addCaret` on the live selection without a restore, which (inferred, consistent with Tasks 613/598) leaves Chromium's internal selection end one top-level child short. After an edit and its Undo, `recordFirstPosition` is unreachable (redo stack non-empty); the large-fixture tail loss there is attributed (hypothesis) to `content-visibility: auto` on large documents. The fence-last residue is attributed (hypothesis) to the hidden code-block close marker lying outside the canonical selection end.
- Fix S2: a build-time patch `patchUndoFirstPositionResync` in `media-src/esbuild-shared.mjs`, chained after Task 598's seed patch, re-syncs a non-collapsed selection with element endpoints by `setBaseAndExtent` right after `addCaret`. Undo grouping unchanged.
- S1 Chromium RED legs in `structural-selection.spec.ts` with a `?doc=` harness parameter (default, fence-last, table-last, generated large document with and without the large-document class); S2b (fence and large-document residue) is a VMDE-owned whole-document replacement, chosen after S1's target-range evidence; S3 real-VS-Code `whole-document-delete.spec.ts`.
- Orchestrator rulings: fence and large-document residue are in scope (queue merge); resync only non-collapsed selections; generated large document in Chromium.
