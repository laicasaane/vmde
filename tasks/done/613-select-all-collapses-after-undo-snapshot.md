# Task 613 — Keep a whole-document selection through the delayed undo snapshot

**Status:** ✅ DONE (2026-10-04) on `dev`, based on HEAD `91befe15`. Three separate defects measured during this task are recorded below as follow-ups; they are outside this root cause and were not fixed.
**Origin:** found during Task 580 CP2-6 (commit `56fa673c`). The real-VS-Code `test/vscode-e2e/structural-selection.spec.ts` waited `undoDelay` after each edit to hide it.
**Severity:** medium. Select All shortly after typing silently became a caret at the document start, so a following Delete or type-over edited the wrong place.
**Tech stack:** Vditor build-time source patch (`media-src/esbuild-shared.mjs`, `patchUndoCaretSplitRestore`), the caret authority (`media-src/src/editing/caret.ts`), Vitest, Chromium, real VS Code 1.129.0.

## Problem

Type in IR, then run Select All (`vmde.selectAll`, Ctrl+A) to the document stage within `undoDelay` (800 ms) of the edit. When Vditor's delayed undo snapshot runs, the whole-document selection collapses to a caret at the start of the document. The caret authority then re-asserts that caret for up to about 5 s. The table block stage (`selectNode(table)`) collapses the same way.

## Root cause

1. `ir/process.ts` `processAfterRender` arms the `undoDelay` timer, which calls `undo.addToUndoStack` → `addCaret(vditor, true)`.
2. The patched capture (`patchUndoCaretSplitRestore`, Task 553) maps each selection endpoint with `vmdeCaretBlockOffset`. A whole-document Range is `(root, 0)–(root, N)`, and the table block stage puts both endpoints on the root too. `host.closest("…, pre, [data-block]")` returns the editable `<pre class="vditor-reset">` root itself, `block === root` returns null, and the whole selection capture becomes null.
3. The restore then falls through to the collapsed captures: the block capture is also null, and the text-offset capture is 0, so `__vmdeRequestCaret({textOffset: 0})` places a caret at the document start.

A second, measured part of the same path: after `addCaret` inserts and removes its `vditor-wbr` marker at `(root, 0)`, Chromium keeps reporting the same DOM Range while its own selection has shrunk. Measured in the Chromium harness: `Selection.toString()` was 90 of 106 characters, and Delete or type-over then kept the document's tail (`final pZaragraph\n` instead of `\n`). Writing the same endpoints again with `setBaseAndExtent` restored 106 characters and a correct Delete. The caret authority skipped that write because the coordinates already matched.

## Fix

- **Patch** (`media-src/esbuild-shared.mjs`): `vmdeCaretSelectionOffsets` maps each endpoint through a new `vmdeCaretSelectionEndpoint`. An endpoint on the editable root becomes the raw `{node: root, offset}` intent. Any other endpoint keeps `vmdeCaretBlockOffset`, so a mixed root/text selection is captured too. The new `VmdeCaretEndpoint` type widens `vmdeCaretSelection`. The anchors and the collapsed captures (Tasks 445/487) are unchanged.
- **Caret authority** (`media-src/src/editing/caret.ts`):
  - A `{node, offset}` intent on an element clamps the offset to the element's current child count, so a root that settled with fewer children still resolves. Text-node offsets stay exact, and a stale one is still a miss (existing contract).
  - A selection intent's first placement in `requestCaret` always writes with `setBaseAndExtent`, even when the coordinates match. This resynchronizes Chromium's selection after the wbr split. Later retry frames keep the skip-if-equal check. A held primary pointer (Task 578) keeps the old behavior, so a native drag is never rewritten.
- The Task 600 blockless refusal is unaffected, because a root Range stays a root Range. The undo snapshot HTML and the number of undo steps are unchanged (the patch changes only the selection capture and restore).

## Acceptance

- [x] IR: Select All to the document stage within `undoDelay` of an edit keeps the Range on `(root, 0)–(root, childNodes.length)` after the snapshot (Chromium and real VS Code).
- [x] IR: the table block stage (`selectNode(table)`) survives the snapshot of an edit in the table (Chromium and real VS Code).
- [x] IR: after the snapshot, Delete gives `\n` and type-over `X` gives `X\n` (whole content replaced, last block removed). One Undo restores the exact pre-replacement source (Chromium and real VS Code).
- [x] The `undoDelay` workaround waits in `test/vscode-e2e/structural-selection.spec.ts` are removed, and the spec passes.
- [x] Collapsed-caret restores (Tasks 445/487), held-drag snapshots (Task 578), the Task 600 refusal and the undo step counts are unchanged in their focused tests.

## RED-before / GREEN-after evidence

| Layer | RED (HEAD sources) | GREEN (fix) |
| --- | --- | --- |
| Chromium `structural-selection.spec.ts` | Document stage after the snapshot: `{start: "#text", startOffset: 0, end: "#text", endOffset: 0}` instead of `root 0–5`. Table stage: a collapsed `#text@11` instead of `root 2–3`. Delete/type-over (root-endpoint fix only, no rewrite): `final pZaragraph\n` / `Xfinal pZaragraph\n`. | 15/15 passed, `--retries=0` |
| Real VS Code `structural-selection.spec.ts` | Task 613 test failed at `:524` (`wholeEditorSelected` false after the snapshot). The CP2-6 test with its waits removed failed at `:267` (document stage after the `REPLACED` edit). | 3/3 passed, `--retries=0` |
| Vitest | The new patch tests need `vmdeCaretSelectionEndpoint`; the new caret tests need the clamp and the forced first write. | 297/297 focused; full suite 5595 passed, 53 expected fail |

The real-VS-Code RED/GREEN runs swapped only `media-src/esbuild-shared.mjs` and `media-src/src/editing/caret.ts` back to `HEAD` and then restored them, with `node build.mjs` before each run.

## Delete/type-over measurements

The Chromium harness had the opening snapshot settled, an edit (`Z`) and Select All. Then Delete, Backspace or `X`, and one Undo:

| Document / mode | Result | Undo |
| --- | --- | --- |
| IR, last block a paragraph, history past the first entry | `\n` / `X\n` | exact |
| IR, last block a table | `\n` / `X\n` | exact |
| IR, last block a fence | `` ```\n `` / `` X\n\n```\n `` (closing fence marker left); `execCommand('delete')` gives the same | exact |
| IR, fresh one-entry history (no edit since open) | `final paragraph\n` / `Xfinal paragraph\n` (last block kept) | exact |
| WYSIWYG (`execCommand('selectAll')`, text-node endpoints) | `\n` / `X\n`, the selection survives the snapshot | exact |
| SV | Delete `\n`. Type-over `X\n\n` with no pending snapshot and `X\n\n\n` across one. The snapshot moves the focus from `SPAN@1` to `#text@12`, one character shorter. | exact |

## Follow-ups (not fixed; outside this root cause)

1. **Prose-settle re-spin collapses a selection made within 220 ms of a keystroke (real VS Code).** `media-src/src/editing/edit-activity.ts` `trySkipFenceSpin` (Tasks 175/180) skips Vditor's spin for a one-code-point prose keystroke. It re-dispatches an `input` event 220 ms later (`QUIET_MS`). Vditor's IR `input()` then runs on the live selection: a whole-document Range has no block, so Vditor inserts a wbr at `(root, 0)` and `setRangeByWbr` collapses it to the document start. Measured in real VS Code: `Z` was typed at 257 ms and Select All landed at 293 ms. At 485 ms, `setSelectionFocus` ← `setRangeByWbr` ← IR `input` ← `edit-activity.ts:115` collapsed the selection, before the undo snapshot at about 1280 ms. The new real-VS-Code test stages Select All 300 ms after the keystroke and asserts that the snapshot is still pending. The Chromium harness does not install `edit-activity`. This needs a direction decision, because it touches the Task 175/180 settle design.
2. **IR fence-last whole-document Delete/type-over leaves the closing fence marker.** The result is the same with or without a pending snapshot, and the same with `execCommand('delete')`.
3. **First keydown on a fresh one-entry history.** Vditor's `recordFirstPosition` runs `addCaret` without a restore, which has the same wbr-at-root desync as above: Delete or type-over keeps the last paragraph. Measured: the DOM Range is unchanged, but `execCommand('delete')` afterwards still keeps `final paragraph`.
4. **SV type-over leaves extra blank lines**, and the snapshot shortens an SV `SPAN` endpoint by one character (see the table above).

## Verification

| Command | Result |
| --- | --- |
| `node build.mjs` | exit 0 (final build is the fixed sources) |
| `npm run typecheck` | exit 0 |
| `npx vitest run --config test/vitest.config.mts media-src/src/editing/caret.test.ts test/backend/vditor-source-patches.test.ts` | 297 passed |
| `npm test` | 327 files; 5595 passed, 53 expected fail |
| `npx biome check` on the 7 changed source/test files | clean (after formatting `caret.test.ts`) |
| `npm run jscpd` | exit 0; no new clone involving the changed code |
| `npm run typecheck:vscode-e2e` | 1 error, pre-existing, in untouched `preview-task-checkbox.spec.ts:122` |
| `xvfb-run -a npx playwright test` (media-src) structural-selection, held-drag-undo-snapshot, undo-boundaries, undo-interop, blockless-caret, keybugs, block-transform, find-replace.spec, html-subscript, list-normalize, caret-link, selection-bubble `--retries=0` | 127 passed |
| Real VS Code `structural-selection.spec.ts --retries=0` | 3 passed |
| Real VS Code `list-enter-undo-caret`, `undo-redo-steps`, `cut-selection`, `blockless-caret` (non-XTEST) `--retries=0` | 1, 1, 3, 1 passed (XTEST legs skipped) |
| Real VS Code, isolated Xvfb + Openbox, `VMDE_XTEST=1`: `held-drag-undo-snapshot` | 2 passed |
| Same XTEST setup: `blockless-caret` T1/T2, `html-subscript-editing:106` | failed on a toolbar-button `locator.click` timeout (button not visible). The failures are identical on a `HEAD`-sources build, so they are pre-existing and unrelated. `html-subscript-editing:267` passed. |

## Execution progress

- [x] Runtime verification of the handoff's static root cause (Chromium: reproduced; real VS Code: reproduced, and the separate prose-settle collapse was found).
- [x] RED tests: Chromium (document stage, table stage, Delete/type-over + Undo) and real VS Code (same, in one boot).
- [x] Patch fix, caret-authority clamp and resync, unit tests.
- [x] Removed the `settleUndoSnapshot` workaround from the real-VS-Code spec.
- [x] Delete/type-over measured in IR, WYSIWYG and SV; follow-ups recorded.
- [x] Orchestrator: review, `tasks/README.md` index, record move, commit.
