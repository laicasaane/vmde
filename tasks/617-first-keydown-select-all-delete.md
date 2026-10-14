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

Not traced. Chromium's deletion of a root Range probably leaves part of the fence's IR structure (the closing marker node), and Vditor's IR `input()` re-parses the leftover text as an empty fence. Check which DOM node survives the native delete, and whether a `contenteditable` or marker element in the fence blocks its removal.

## Tests

- **Vitest:** patch drift guards in `test/backend/vditor-source-patches.test.ts`, composed with `patchUndoCaretSplitRestore` and Task 598's planned patch.
- **Chromium:** a fresh one-entry history test case in `structural-selection.spec.ts`: Delete gives `\n`, type-over gives `X\n`, one Undo is exact. Check `Selection.toString()` length against the document text.
- **Real VS Code** (build first, `--retries=0`, OS-level XTEST): the same test cases on a freshly opened document, checking host text.
- Merged from Task 621: **Chromium:** a large-document test case (the same fixture or a privacy-safe generated one), fresh and after Bold+Undo: whole-document Delete gives `\n`; one Undo is exact. Record `Selection.toString()` length before Delete in the RED run. **Real VS Code** (build first, `--retries=0`, OS-level XTEST): the two variants in the table above, checking host length and exactness without printing fixture text.
- Merged from Task 616: **Chromium:** extend `media-src/e2e/structural-selection.spec.ts` with a fence-last document: Delete gives `\n`, type-over gives `X\n`, and one Undo restores the exact source, with and without a pending snapshot. Record the DOM after the native delete in the RED run. **Real VS Code** (build first, `--retries=0`): the same test cases with OS-level keys, checking host text. Controls: paragraph-last and table-last documents keep their current results.

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

- Fresh one-entry history still reproduces after Task 598: with stacks 1/0 Vditor's `recordFirstPosition` runs `addCaret` on the live selection without a restore, which (inferred, consistent with Tasks 613/598) leaves Chromium's internal selection end one top-level child short. After an edit and its Undo, `recordFirstPosition` is unreachable (redo stack non-empty); the large-fixture tail loss there is attributed (hypothesis) to `content-visibility: auto` on large documents. The fence-last leftover text is attributed (hypothesis) to the hidden code-block close marker lying outside the canonical selection end.
- Fix S2: a build-time patch `patchUndoFirstPositionResync` in `media-src/esbuild-shared.mjs`, chained after Task 598's seed patch, re-syncs a non-collapsed selection with element endpoints by `setBaseAndExtent` right after `addCaret`. Undo grouping unchanged.
- S1 Chromium failing test cases in `structural-selection.spec.ts` with a `?doc=` harness parameter (default, fence-last, table-last, generated large document with and without the large-document class); S2b (fence and large-document leftover text) is a VMDE-owned whole-document replacement, chosen after S1's target-range evidence; S3 real-VS-Code `whole-document-delete.spec.ts`.
- Orchestrator rulings: fence and large-document leftover text are in scope (queue merge); resync only non-collapsed selections; generated large document in Chromium.

## Execution progress — 2026-10-14 (S1)

Part 1 S1 (Chromium failing test cases) is written and run. No product code changed. The re-check was on the current HEAD, which includes the Task 598, 613 and 623 undo patches.

- **Harness.** `media-src/e2e/structural-selection-harness.ts` takes `?doc=`: `default` (unchanged document, paragraph last), `table-last`, `fence-last`, `large` and `large-cv`. The large document is generated (520 sections of prose, a list, a table and a fence, then two closing paragraphs; over 100,000 characters of Markdown, asserted in each large case). `large-cv` adds the `vmde-large-doc` body class that `boot/vditor-init.ts` sets from size alone, which turns on `content-visibility: auto`. An unknown value throws. Specs that load this harness: `structural-selection.spec.ts` (changed), `find-replace.spec.ts` and `find-replace-large.spec.ts`; the default document is byte-identical to before.
- **Test cases** in `media-src/e2e/structural-selection.spec.ts` (titles start with `Task 617`). Each opens the document, waits past `undoDelay`, builds the history, runs Select All twice with the caret in the first paragraph's ` omega` text, then checks (soft) that `Selection.toString()` equals the whole rendered text length (read as `Selection.toString()` over a programmatic root selection before any key), presses Delete (or types `X`), expects `\n` (or `X\n`) from `getValue()`, waits for the snapshot, undoes once and expects the exact original source.
  - Delete, fresh history (stacks 1/0): default (acceptance 1 and 2), fence-last (acceptance 4), large and large-cv (Task 621 edge case, fresh).
  - Delete, after an edit and its Undo: fence-last (acceptance 4: no closing-fence leftover text), large and large-cv (acceptance 3, with and without the class), default and table-last (controls, acceptance 5).
  - Delete, fence-last with a pending (unsnapshotted) edit (acceptance 4, pending snapshot); one Undo restores the pre-edit source.
  - Type-over `X`, fresh history: default and fence-last (acceptance 1 and 4).
- **Results (Chromium, 12 new test cases).** FAIL now (8): default fresh (`final paragraph\n` left), fence-last fresh (`ts` and the fence body left), fence-last after edit and Undo (`` ```\n `` left), fence-last pending snapshot (`ts` and the fence body left), large fresh and large-cv fresh (`closing paragraph two` left), type-over default fresh (`Xfinal paragraph\n`), type-over fence-last fresh (`Xts` and the fence body). PASS now (4): default after edit and Undo, table-last after edit and Undo (controls), large and large-cv after edit and Undo (see below). In every failing case only the Delete or type-over assertion fails; the pre-key selection length equals the whole rendered text and the single Undo restores the exact source.
- **Target-range evidence for S2.**
  - Fresh default: before Delete the Range is `(root, 0)-(root, 5)` over 5 children and `Selection.toString()` is the full 105 characters. After Delete the DOM is `<p>final paragraph</p>` (selection collapsed). So the selection is not short before the key; the loss appears on the Delete keydown itself (the first keydown that reaches `recordFirstPosition` on a one-entry history). Rewriting the same endpoints with `setBaseAndExtent` before Delete does not change the result (still `final paragraph\n`), so S2's resync must run right after `addCaret` inside `recordFirstPosition`, not before the key.
  - Fence-last after edit and Undo (stacks not one-entry): the Range is `(root, 0)-(root, 4)` before Delete. After Delete the DOM is an empty paragraph plus the code-block `div` that still holds `<span data-type="code-block-close-marker">```</span>` while its `pre` source and preview were removed. Source: `` ```\n ``. A resync before Delete does not change it, so this leftover text is a native-delete result, not a one-entry-history effect: S2b must replace the whole document itself.
  - Fence-last fresh: after Delete the DOM keeps a paragraph `ts` and the intact code-block (`const fence = true`), the same short-selection result as the default document.
  - Large document: fresh fails like the default document (last paragraph left) with and without the class. After an edit and its Undo the generated large document empties correctly with and without `content-visibility`. The Task 621 after-Undo tail loss was measured in real VS Code only and does not reproduce in this Chromium harness with the generated document (open for S3 and the real fixture).
- **Checks.** `npx biome check` on the two files: clean. `npm run typecheck`: exit 0. Playwright run of `structural-selection.spec.ts`, `find-replace.spec.ts` and `find-replace-large.spec.ts` (temporary config on a free port because 9123 was held by another worktree; the config was deleted): 36 passed, 9 failed; the 9 failures are the 8 new failing cases above plus the known `find-replace.spec.ts:560` (SV close). `structural-selection.spec.ts:242` passed. The large cases take about 1.5 minutes each.
- **Open.** Real-VS-Code coverage (S3); the Task 621 after-Undo tail loss on the real fixture; Bold plus Undo variant of Task 621 (this S1 used a typed character and its Undo).

## Execution progress — 2026-10-14 (S2)

S2a (fresh one-entry history) and S2b (fence last) are implemented; the Chromium test cases of S1 are green.

- **S2a, build-time patch `patchUndoFirstPositionResync`** (`media-src/esbuild-shared.mjs`, chained after the diagram reset in the Vditor undo entry). Anchor: `recordFirstPosition`'s `const text = this.addCaret(vditor);` followed by the `if (text.replace("<wbr>", "")...` line, count-asserted exactly 1 (the Task 598 seed's own `addCaret` call is followed by other text). Already-applied marker (`vmdeFirstPositionElementEndpoint`) throws. For a non-collapsed selection with an element anchor or focus, the live endpoints are written again with `setBaseAndExtent` right after `addCaret`; a caret and a text-only selection keep the upstream path (upstream warns that restoring the cloned Range breaks the first input on Windows Chrome). The 598 seed already did this on its own path; `recordFirstPosition` is the path with a one-entry history, where the seed returns false. Measured after S2a alone: default fresh Delete and default fresh type-over turn green; every fence-last case still left the closing fence.
- **S2b, layer chosen: a document-level capture `beforeinput` listener** (new `media-src/src/editing/ir-whole-document-edit.ts`, installed in `boot/finish-init.ts` next to the SV edit of Task 619 and in the structural-selection harness; manifest entry added). Source evidence: after S2a the native delete of the root Range removes content only up to the last visible position, so the hidden `code-block-close-marker` span stays in an emptied code-block `div` and Vditor's IR input path re-parses it as an empty fence; Vditor's keydown path does not intervene (Delete and Backspace reach `beforeinput`). The listener owns only: IR mode; one Range from the editor root at offset 0 to the root at its child count (Select All's document stage); a delete input type, or `insertText` with data; not during composition (`isComposing`, Vditor's `composingLock`, VMDE's composition state). It replaces every block with one empty paragraph, puts the caret in it and revokes a host-owned seed through `__vmdeMarkCutInput`. A delete then dispatches one `input` event, so Vditor re-spins the paragraph and takes one Undo snapshot, and the native delete is cancelled. A type-over (`insertText`) does the deletion part only: it does not cancel the event and sends no `input` of its own, so the browser inserts the typed text at the caret in the empty paragraph and Vditor's usual input path records the snapshot. Review finding (measured, fixed): the first version wrote the typed text itself, and a raw ASCII space made Vditor's IR `input()` return early (its leading/trailing-space rule, `ir/input.ts`), so no Undo snapshot was recorded and one Undo could not restore the source; native insertion turns that space into `&nbsp;` and records the step. Not owned: partial selections, a selection inside a code block or table cell, a caret, `insertParagraph`, paste, cut, drop, WYSIWYG, SV.
- **Pending-snapshot shape** (edit made, Select All and Delete before the snapshot) is its own Chromium case; it passes: Delete gives `\n`, one Undo restores the pre-edit source.
- **Tests.** Vitest: `test/backend/vditor-source-patches.test.ts` (new `patchUndoFirstPositionResync` block: anchor once in the shipped source and only in `recordFirstPosition`, second application throws, missing and duplicated anchor throw, registry chain equality, other methods unchanged, runtime behavior with a stub selection: element endpoint rewritten right after `addCaret`, caret and text-only selection not; the two existing registry-equality cases now include the re-sync); new `media-src/src/editing/ir-whole-document-edit.test.ts` (whole-document Delete variants and type-over, partial selection, selection inside a code block, caret, IME composition, other input types, WYSIWYG and SV, event outside the editor, disposer). Chromium (`structural-selection.spec.ts`): fence-last Backspace after an edit and its Undo (edge case); type-over cases through one shared history/selection helper: `X` on the paragraph-last and fence-last documents for a fresh history, a pending snapshot and after an edit and its Undo (acceptance 1, 2 and 4); a typed space and `X ` (an `insertText` whose data ends in a space, from `keyboard.insertText`) on the default document, fresh (acceptance 2, regression found in review: failed before the fix with no Undo step recorded, one Undo left the source empty), each also asserting the stacks are `[1, 1]` after the one Undo; and two caret cases (Delete then `Q` on the fence-last document after an edit and its Undo gives `Q\n`; `X` then `Y` on the default document fresh gives `XY\n`). After a whole-document delete the editor root may hold one empty paragraph; that state is an empty document, not a defect. Row added to `docs/vditor-patch-checklist.md`.
- **Results (Chromium).** All 21 `Task 617` test cases pass (S1 listed 12; S2 added Backspace, six type-over rows for the `X` histories, the space and trailing-space rows, and the two caret cases). `structural-selection.spec.ts`, `find-replace.spec.ts` and `find-replace-large.spec.ts` together: 53 passed, 1 failed (the known `find-replace.spec.ts:560`). `structural-selection.spec.ts:242` passed. Specs that load the changed harness: those three. Other harness that installs `finishInit` (and so the new listener): `scrolljump-harness.ts`; its spec has no Select All or typing over a selection, so it was not rerun.
- **Checks.** `npx vitest run` on `vditor-source-patches`, `patch-mutation`, `module-boundaries`, `ir-whole-document-edit` and `finish-init` tests: pass. `npm run typecheck` exit 0. `npx biome check` on the touched files: clean. `node build.mjs` exit 0.
- **Open (not owned here).** Paste, IME and drop over a whole fence-last document; smart-quote type-over (`insertText` data `‘`, `“` or `《`) records no snapshot because Vditor's IR `input` listener returns early for those characters (`ir/index.ts`, pre-existing); `patchUndoFirstPositionResync` also runs in SV and WYSIWYG (the patched method is mode-independent; untested there). Real-VS-Code coverage (S3), including the Task 621 large fixture tail loss after Undo (not reproduced in Chromium), whole-document cut, and `deleteByCut`/paste over a whole-document fence-last selection (not owned here).
