# Task 615 — Keep a selection made within the prose-settle window after a keystroke

**Status:** done (2026-10-15).
**Origin:** [Task 613](613-select-all-collapses-after-undo-snapshot.md) follow-up 1, measured in real VS Code during that task.
**Severity:** medium. Select All shortly after typing silently becomes a caret at the document start, so a following Delete or type-over edits the wrong place.
**Scope:** IR. The deferred prose re-spin of `media-src/src/editing/edit-activity.ts` (Tasks 175/180) and the selection it runs on. Keep Task 613's undo-snapshot fix and the Task 175/180 typing performance contract.

## Problem

Type one character in IR prose, then run Select All (`vmde.selectAll`, Ctrl+A) within about 220 ms. The whole-document selection collapses to a caret at the document start. This happens before Vditor's undo snapshot, so Task 613's fix does not cover it.

## Measured evidence

Real VS Code 1.129.0, Task 613 build (based on HEAD `91befe15`):

- `Z` was typed at 257 ms. Select All landed at 293 ms.
- At 485 ms the selection collapsed. The stack was `setSelectionFocus` ← `setRangeByWbr` ← IR `input` ← `edit-activity.ts:115`.
- Vditor's undo snapshot ran later, at about 1280 ms.

The Chromium harness does not install `edit-activity`, so it does not reproduce this. The real-VS-Code test `test/vscode-e2e/structural-selection.spec.ts` works around the window: it stages Select All 300 ms after the keystroke (`PROSE_SETTLE_MS`, `:510-513`) and asserts that the snapshot is still pending.

## Reproduction

1. Open a multi-paragraph document in IR and place the caret in a prose paragraph.
2. Type one character.
3. Within 220 ms, press Ctrl+A until the whole document is selected.
4. Wait 300 ms. The selection is a caret at the document start.
5. Press Delete. The edit does not remove the document.

## Suspected cause

- `trySkipFenceSpin` (`media-src/src/editing/edit-activity.ts:88`) skips Vditor's spin for a one-code-point prose keystroke (Task 180, `:100-103`).
- It defers a re-spin with `deferUntilSettle` and `QUIET_MS = 220` (`:36`). The re-spin dispatches a synthetic `input` event on `vditor.ir.element` (`:115`).
- Vditor's IR `input()` then runs on the live selection, not the selection of the keystroke. A whole-document Range has no block, so Vditor inserts a `<wbr>` at `(root, 0)`, and `setRangeByWbr` collapses the selection to the document start.
- Any non-collapsed selection made in the window may be affected. Only Select All was measured.

## Candidate approaches

1. Run the pending settle re-spin before a selection command (Select All, Expand Selection) acts, so the command selects the settled DOM.
2. Save the live selection before the deferred `input` and restore it afterwards, as Task 613 did for the undo snapshot.
3. Re-spin against the keystroke's own block instead of the live selection.

## Owner decisions (2026-10-08)

Approved in chat by the Project Owner.

- Approach 3: the deferred prose re-spin targets the block the keystroke edited, then restores the user's current live selection.
- The fix covers Select All, Shift+arrows and pointer drags.
- Keep Task 613's fix and the Task 175/180 typing-performance contract.

Coordinate with [Task 601](601-undo-before-pending-checkpoint.md), which also needs to settle the prose delay before Undo.

## Tests

- **Vitest:** the settle path keeps a non-collapsed selection, and still re-spins the edited block.
- **Chromium:** install `edit-activity` in a harness test case (or add a seam), type one character, select the whole document within 220 ms, and check the Range after the settle and after the snapshot.
- **Real VS Code** (build first, `--retries=0`): type, then Select All at about 50 ms and 150 ms after the keystroke. The Range stays whole-document. Delete gives `\n`, and one Undo restores the exact source. Remove the `PROSE_SETTLE_MS` staging from `structural-selection.spec.ts`.

## Acceptance

- [x] IR: Select All within 220 ms of a prose keystroke keeps the whole-document Range through the settle re-spin and the undo snapshot (real VS Code). Evidence: real VS Code `structural-selection.spec.ts` keyboard case: whole-document Range reached before the re-spin, still whole after the re-spin and the snapshot, short and long wait, plus the table block stage (4 of 4 passed, XTEST); Chromium 4 new cases.
- [x] Delete and type-over then replace the whole document, and one Undo restores the exact source. Evidence: same spec: Delete gives `\n`, type-over gives `X\n`, one Ctrl+Z restores the exact source before each act; Chromium Delete and type-over cases.
- [x] Typing performance and the Task 175/180 re-spin behavior are unchanged in their focused tests. Evidence: `prose-fast-edit`, `undo-pending-checkpoint`, `held-drag-undo-snapshot`, `undo-redo-steps` real VS Code 12 of 12 passed with the spec; Chromium specs loading `edit-activity` 117 of 118 (the known `auto-wrap` SV failure); Vitest `edit-activity.test.ts` 19 cases.
- [x] The `PROSE_SETTLE_MS` workaround in `test/vscode-e2e/structural-selection.spec.ts` is removed, and the spec passes. Evidence: `PROSE_SETTLE_MS` removed in `test/vscode-e2e/structural-selection.spec.ts` (S3); the spec passes 4 of 4.

## Part 1 handoff (2026-10-14)

Read-only review of the source (the runtime collapse was measured in Task 613); nothing was run.

- **Cause (verified by reading).** `media-src/src/editing/edit-activity.ts` `trySkipFenceSpin`: a skipped keystroke arms `deferUntilSettle('fence-respin')`; at settle the callback dispatches a synthetic `input` and keeps no record of where the keystroke was. Vditor's IR input listener (`ir/index.ts`) reads the live selection (`getSelection().getRangeAt(0)`); in `ir/input.ts` a root Range has no closest block, so the whole editor is re-spun, a `wbr` goes at the Range start and `setRangeByWbr` collapses the selection. The esbuild hook `patchIrFenceSpinSkip` (`media-src/esbuild-shared.mjs`) only returns a boolean. Inference: any live selection outside the edited block respins the wrong block; a whole-document Range also costs a full-document spin.
- **Contract (Owner approach 3).**
  1. Per skipped keystroke also store only `respinTarget = {node, offset, owner}` (O(1)); `QUIET_MS`, the `fence-respin` key with latest-wins, the `fenceRespinning` guard, the input nudge and the Task 601 flush stay unchanged.
  2. At settle, a disconnected target node skips the respin.
  3. Fast path: a collapsed live selection inside the target's block dispatches exactly as today (Task 180 behaviour byte-identical).
  4. Otherwise: capture the live selection as anchor and focus (direction kept), each with a node reference and a fallback (`{blockPath, offsetInBlock}` inside the affected region, or a root offset shifted by the spin's child-count delta for root endpoints such as Select All or a selected table); place a collapsed caret at the target (offset clamped); dispatch; restore through `requestCaret({anchor, focus})` (its first write uses `setBaseAndExtent`, which carries Task 613's resync and the held-pointer semantics).
  5. While the primary pointer is held, re-defer `fence-respin` until release (no DOM rebuild under a native drag); the flush still forces it (small exported `isPrimaryPointerHeld()` from `media-src/src/editing/caret.ts`).
  6. If focus was outside the editor (Find widget, toolbar input), restore it with `focus({preventScroll: true})` after the selection write (probe first).
  7. Endpoints in re-rendered list siblings, link-reference or footnote blocks are covered by "node still connected, else fallback".
  8. Unchanged: Task 613's patch and clamp/resync, the Task 175 fence skip, the undo snapshot count.
- **Part 2.** S1: an `installEditActivity` test case in `media-src/e2e/structural-selection-harness.ts` (pattern: `undo-boundaries-harness.ts`, `mutation-local-harness.ts`) and Chromium test cases in `media-src/e2e/structural-selection.spec.ts`: type, Select All at about 50 and 150 ms, assert after the settle and after the snapshot (RED: collapsed caret at the document start). S2a: RED Vitest in `media-src/src/editing/edit-activity.test.ts`: a root selection survives the settle while the target block is re-spun; a backward selection inside the target keeps its direction; a selection in another block is restored and the target still re-spun; a disconnected target skips; a held pointer re-defers; a flush runs once. S2b: `edit-activity.ts` (+ the `caret.ts` export); no esbuild patch change (fallback if the swap proves fragile: range substitution in `patchIrFenceSpinSkip`). S3: `test/vscode-e2e/structural-selection.spec.ts`: remove `PROSE_SETTLE_MS`, add the 50/150 ms test cases (document and table stages), Delete gives `\n` and type-over `X` gives `X\n` with one exact Undo each, plus a drag test case and a Shift+arrow test case; rerun `prose-fast-edit.spec.ts` (Task 180 contract), `held-drag-undo-snapshot`, `undo-redo-steps`.
- **Edge cases.** Shorter but connected target node (clamp); selection partly in the target block; typing in block A then B within the window (only B re-spun — today's behaviour); swallowed synthetic input (today's behaviour); IME composition at settle (skip the swap); editor rebuilt or mode changed (owner/connectivity checks).
- **Owner questions (provisional choices, reversible; within the Owner's approach 3).** (1) A detached target skips the respin instead of falling back to the live selection — adopted (the fallback is the bug). (2) The respin waits while a primary pointer is held, until release — adopted (drags stay covered without rebuilding the DOM under the drag). (3) Several blocks typed in one burst: keep latest-wins, recorded as a known limitation — adopted.
- **Risks.** Native drag continuation after a programmatic selection write (avoided by 5); focus side effect (probe).

## Execution progress — 2026-10-14 (S2)

Scope: S1 (failing Chromium cases), S2a (failing Vitest cases) and S2b (the repair) merged. Per the Owner test-scope rule no real-VS-Code spec ran in this step; the real-VS-Code acceptance items (1, 2 at that layer, 4) and the Task 175/180 real-VS-Code specs stay with S3. The Acceptance checkboxes stay open.

**Changed**

- `media-src/src/editing/edit-activity.ts`: each skipped keystroke stores its own target in the settle closure (`{node, offset, block}`, O(1)); `QUIET_MS`, the `fence-respin` key with latest-wins, the `fenceRespinning` guard, the input nudge and the Task 601 flush are unchanged. At settle:
  - a held primary pointer re-defers the same callback (`isPrimaryPointerHeld()`); `flushPendingEditorRespin` sets a flag so the flush still forces it;
  - a target whose node and block are both gone skips the re-spin (contract 2);
  - a collapsed live caret in the target's block, no live selection, or an IME composition dispatches exactly as before (contract 3);
  - otherwise the anchor and focus are captured (node reference plus a block address `{blockPath, offsetInBlock, affinity}` with the same rule as the Undo snapshot capture, or the root offset), a collapsed caret is placed at the target (offset clamped), the synthetic `input` is dispatched, and the selection is restored through `requestCaret({anchor, focus})`. A surviving node is used as it is; a replaced node follows its block address; a root endpoint follows the child-count delta; top-level indices follow the replaced region (the keystroke's block, its adjacent lists, or the whole editor for a link-reference block). Direction is kept (contract 4);
  - focus in a control outside the editor is put back with `focus({preventScroll: true})` after the dispatch (contract 6).
- `media-src/src/editing/caret.ts`: the exported `isPrimaryPointerHeld()` and nothing else.
- `media-src/e2e/structural-selection-harness.ts`: `?activity=1` installs `edit-activity` (the `?doc=` parameter of Task 617 is kept; the default page is unchanged).
- `media-src/e2e/structural-selection.spec.ts`: four Chromium cases (acceptance 1 at 50 and 150 ms; acceptance 2 Delete and type-over).
- `media-src/src/editing/edit-activity.test.ts`: 19 Vitest cases (contracts 2 to 7 and the edge cases).

**Probe (contract 6), Chromium.** With focus in an input outside the editor the document selection was a caret in `body`. Writing a selection into the editor moved focus into the editable. Focusing the input again collapsed the document selection to a caret in `body`. So a selection kept in the editor does not coexist with focus outside it; the re-spin therefore keeps no editor selection in that case and only puts focus back.

**Contract 2 refinement (found by the Task 175 case in `auto-wrap.spec.ts`).** In the first version a disconnected keystroke node skipped the re-spin. For a fenced body the browser replaces the text node itself while the block stays (measured: the node was not in the editor 100 ms after the keystroke), so the fence lost its settle re-spin and `auto-wrap.spec.ts` "Unicode prose and fenced input defer to one settle spin" failed (spins 0, expected 1). The target now also keeps its block: the re-spin is skipped only when both are gone; with a live block it runs, with the caret placed at the block start when the node is gone. A Vitest case covers it.

**Failing first.** Chromium: all four new cases failed before the repair; the whole-document Range was selected before the settle (the precondition) and was a collapsed `#text` position at offset 0 afterwards (expected the root, 0 to 5). Vitest: with the module as on `HEAD` 15 of the first 46 cases failed (contracts 2, 4, 5, 6, 7 and the two edge cases that need the target); the controls (collapsed caret in the target block for prose and fenced body, IME composition) passed on both.

**Test timing note.** The type-over case waits `undoDelay` plus the 220 ms settle after the replacement before its Undo, because the typed letter is itself a skipped keystroke and its snapshot runs after its re-spin.

**Verification (this step)**

- Vitest: the changed module files and the files that import them (`edit-activity`, `finish-init`, `engine-registry`, `spin-skip-fence`, `caret`, `editor-caret`, `initial-caret`, `undo-restore-caret`) and the module boundary test: 308 of 308 passed. `npm run typecheck` and `biome check` on the changed files: clean. `node build.mjs`: built. `depcruise:webview`: no violations.
- Chromium (own temporary config on a free port, the default port was held by another worktree; removed afterwards): `structural-selection.spec.ts` in full, and every spec that loads a harness installing `edit-activity` (`mutation-local`, `toc-invalidation`, `undo-boundaries`, `undo-pending-diagram`, `auto-wrap`, `table-format`): 117 of 118 passed; the one failure is the known `auto-wrap.spec.ts` SV case.
- Not run: real VS Code (`prose-fast-edit.spec.ts`, `undo-pending-checkpoint.spec.ts`, `held-drag-undo-snapshot`, `undo-redo-steps`, `structural-selection.spec.ts` including the `PROSE_SETTLE_MS` removal) belongs to S3.

**Known limits / open**

- Several blocks typed in one burst: latest-wins, as before (recorded in Part 1).
- When the spin merges adjacent lists into one list, an endpoint inside a merged sibling is restored by block address: it lands in the item with the same index inside the merged list, with the character offset kept in that item (not in the item it was in). A root-level endpoint (Select All) follows the new child count exactly (Vitest case).
- Native drag continuation after a programmatic write is avoided by the held-pointer wait; the drag case is not measured in real VS Code yet (S3).

- **Contract 2 refinement (orchestrator, 2026-10-14).** Approved: the re-spin is skipped only when both the keystroke node and its block are gone; a replaced node in a live block (Chromium fenced body) still re-spins with the caret at the block start, so the Task 175 fenced settle re-spin (contract 8) is kept.

## Execution progress — 2026-10-15 (S3)

Scope: the real-VS-Code step of the plan. No product file changed; the fix from S2 is on the branch as committed. The Acceptance checkboxes above stay as they were: closing them belongs to the closure batch (the evidence is below).

**Changed**

- `test/vscode-e2e/structural-selection.spec.ts`:
  - The `PROSE_SETTLE_MS` staging is removed. The Task 613 test case is replaced by one that makes every selection inside the 220 ms settle window with OS-level (XTEST) keys. The extension ID and the editor view type come from the shared `ExtensionId` and `MarkdownEditorViewType` constants (the two older test cases of the file now pass `ExtensionId` too).
  - A page-side recorder (listeners only) logs the keystroke (trusted `input`), the settle re-spin (untrusted empty `insertText` input), every `selectionchange` with the selection's shape (`whole`, `table`, `collapsed`, `range`), and pointer down and up, all with `performance.now()`.
  - Test case 3 (keyboard): Select All after one prose keystroke, document stage with a short and a long wait, and the table block stage; Delete and type-over after a document selection made in the window; a Shift+Arrow selection.
  - Test case 4 (pointer): a held backward drag across two blocks that crosses the settle deadline.
  - The helper `selectAllInsideSettleWindow` waits for the settle re-spin and the undo snapshot and checks the Range after each. The wait before the first Select All key is shortened by the measured cost of one XTEST key (measured with an inert modifier press), so the last key lands near the target time.

**Assertions mapped to the record**

| Assertion | Item |
| --- | --- |
| Whole-document Range reached before the re-spin (page timestamps), still whole after the re-spin, undo stack count unchanged until the snapshot, plus one entry after it, still whole 200 ms later; short and long wait | Acceptance 1 |
| Same for the table block stage (`selectNode(table)`) | Acceptance 1 (root-endpoint edge) |
| Delete gives `\n`, type-over `X` gives `X\n`, and one Ctrl+Z restores the exact source before each act | Acceptance 2 |
| Shift+Left twice after the keystroke keeps its text and its backward direction through the re-spin and the snapshot; a third Shift+Left extends from the same anchor | Contract 4 (direction kept), Owner decision "Shift+arrows" |
| Pointer down inside the window, hold crosses the deadline with no re-spin, the re-spin comes after the release, and the backward two-block selection keeps its text and direction through the re-spin and the snapshot | Contract 5, Owner decision "pointer drags", the open drag item of S2 |
| `PROSE_SETTLE_MS` removed and the whole spec passes | Acceptance 4 |
| `prose-fast-edit`, `undo-pending-checkpoint`, `held-drag-undo-snapshot`, `undo-redo-steps` pass | Acceptance 3 (Task 175/180, Task 601, Task 578 contracts) |

**Measured landing times** (milliseconds after the keystroke's `input` event; one run of the final spec; the settle re-spin ran at 221 in every case): document stage short wait: first Select All effect 71, whole document 139; long wait: 115 and 173; table block stage: 64; before Delete: 56 and 137; before type-over: 55 and 126. One XTEST key cost about 45 ms. A document selection needs two Select All presses, so its whole-document Range lands after about 130 to 175 ms rather than at exactly 50 or 150 ms. Both waits land inside the window; the spec asserts the ordering from the timestamps, not from the waits.

**Verification (this step)**

- `node build.mjs`: built.
- `npm run typecheck:vscode-e2e`: clean. `biome check` on the spec: clean.
- Real VS Code 1.129.0 under Xvfb and a key-binding-free window manager with XTEST (`--workers=1 --retries=0`), one invocation of five specs: `structural-selection.spec.ts` (4 test cases), `prose-fast-edit.spec.ts` (1), `undo-pending-checkpoint.spec.ts` (4), `held-drag-undo-snapshot.spec.ts` (2), `undo-redo-steps.spec.ts` (1): 12 of 12 passed. After a last edit of the spec (the held-drag selection is read before the release; comments), `structural-selection.spec.ts` alone was run again: 4 of 4 passed. The four other specs did not import the spec and were not rerun.
- Before that, a first run of the new keyboard test case failed because the long wait plus two key presses landed after the re-spin (a staging error, not a product failure). The wait was then shortened by the measured key cost and the assertion that the selection precedes the re-spin was derived from the page timestamps.

**Open**

- Not measured: the new real-VS-Code test cases without the repair (no rebuild of the previous module). The failing-first proof stays the S2 Chromium and Vitest runs.
- Known limits from S2 are unchanged (several blocks typed in one burst: latest-wins; merged adjacent lists restore an endpoint by item index).

## Closure — 2026-10-15

- **Commits.** `4a67f16d` (selection kept through the settle re-spin), `5d22f238` (real-VS-Code spec); records `d2f26f28`, `851196a6`.
- **Gates.** Closure batch run on the combined HEAD (`97198ddd`): `lint:ci`, `typecheck`, `typecheck:vscode-e2e`, `knip`, `jscpd`, `depcruise`, `test:coverage` (337 test files passed, 6 skipped; 6,627 tests passed, 213 skipped), `check:coverage-modules` (11 modules at 0%, baseline 11) and `check:brand-identifiers` all exit 0. The audit stage was omitted by Owner instruction, so `npm run quality` was not run; acceptance items that ask for it are met by this gate list.
- **Bundle.** 1,010,100 B for `media/dist/main.js` (unchanged against the batch-4 close, 1,010,100 B). Eager modules 377 (budget 294, reporting only; the same count as the batch-3 close). Known gate state: `selection-bubble.spec.ts` Link cases fail since Task 607 `1d8e37a9` (Owner decision pending; not part of this task).
- **Residuals and open items.** Several blocks typed in one burst: latest-wins, as before. When the re-spin merges adjacent lists, an endpoint inside a merged sibling is restored by item index, with the character offset kept in that item. The real-VS-Code test cases were not run without the repair (no rebuild of the previous module); the failing-first proof is the Chromium and Vitest runs of S2.
