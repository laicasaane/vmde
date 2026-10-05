# Task 621 — IR whole-document Delete on the large fixture keeps the last two blocks

**Status:** planned (2026-10-05). The Project Owner approved filing this record on 2026-10-05. Implementation has not started.
**Origin:** Task 580 CP4-1 classification runs (2026-10-05). Pre-existing: identical on the pre-580 build `8c2ec1f0` and on HEAD `0138a286`.
**Severity:** medium. Select All then Delete silently keeps the end of the document. One Undo restores the exact source.
**Scope:** IR whole-document Delete on a large document, on a fresh document and after an edit and its Undo. Coordinate with [Task 617](617-first-keydown-select-all-delete.md) (fresh one-entry history) and [Task 616](616-ir-fence-last-select-all-delete.md) (fence-last residue); this task may share their cause.

## Problem

Open the large synthetic fixture in IR, press Select All twice to select the whole document, and press Delete. The host keeps the last two blocks of the source instead of becoming empty.

## Measured evidence

Real VS Code 1.129.0, Linux X11, Xvfb + Openbox, OS-level XTEST keys, `--retries=0`. Fixture `test/vscode-e2e/fixtures/large-observable-models-synthetic.md` (174,517 characters), IR.

Steps: caret collapsed 2 characters into a word in a paragraph, Ctrl+A, wait 700 ms, Ctrl+A, wait 700 ms, Delete, wait for the host, wait 1,200 ms, Ctrl+Z.

| Variant | First Ctrl+A | Second Ctrl+A | Host after Delete | Editor after Delete | After one Undo |
| --- | --- | --- | --- | --- | --- |
| Fresh document | 429 characters (block stage) | whole document (192,548 rendered characters) | 14,296 characters, a suffix of the source | 2 top-level children, 14,234 text characters | exact, clean |
| After Bold (Ctrl+B) and its Undo | 429 characters | whole document | 429 characters, a suffix of the source | 2 top-level children, 426 text characters | exact, clean |

- The two builds gave the same numbers (logs `cls-pre2.log` on `8c2ec1f0` and `cls-head1.log` on `0138a286`). The key route differs: `8c2ec1f0` handled Ctrl+A in a webview capture listener; HEAD runs `vmde.selectAll` as an editor action.
- The first pre-580 run (`cls-pre1.log`) used an earlier probe without the suffix check and gave different numbers; it is not counted. Rerun both builds before the RED baseline.
- Evidence: session scratch logs from a temporary classification spec (`zz-cls580.spec.ts`) in a scratch worktree. Neither is committed; the numbers above are copied from them.

## Reproduction

1. Open the large synthetic fixture in IR.
2. Optional: select a word, press Ctrl+B, wait 1.2 s, press Ctrl+Z.
3. Place the caret in a paragraph. Press Ctrl+A twice, 0.7 s apart. The whole document is selected.
4. Press Delete. The last two blocks remain.

## Suspected cause

Not traced. Leads:

- The fresh variant matches Task 617: the first keydowns after opening run Vditor's `recordFirstPosition` → `addCaret` (`media-src/node_modules/vditor/src/ts/undo/index.ts:84-108`), and Chromium's internal selection shrinks while the DOM Range still reports the whole document.
- The after-Undo variant is not a one-entry history with an empty redo stack, so `recordFirstPosition` returns early there. Another `addCaret`-style marker insert (the undo snapshot or Undo's restore) or the Delete path itself may shrink the selection. Compare `Selection.toString()` length with the document text before Delete.
- Check the kind of the last two blocks (a fence would match Task 616).

## Tests

- **Chromium:** a large-document leg (the same fixture or a privacy-safe generated one): fresh and after Bold+Undo, whole-document Delete gives `\n`; one Undo is exact. Record `Selection.toString()` length before Delete in the RED run.
- **Real VS Code** (build first, `--retries=0`, OS-level XTEST): the two variants above, checking host length and exactness without printing fixture text.

## Acceptance

- [ ] IR, large fixture, fresh and after an edit and its Undo: Select All to the document stage then Delete leaves an empty document (`\n`) in Chromium and real VS Code.
- [ ] One Undo restores the exact source, and the document is clean.
- [ ] Task 613's small-document results are unchanged.
