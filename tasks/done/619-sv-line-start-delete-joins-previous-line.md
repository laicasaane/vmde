# Task 619 — SV deletion of a selection at a line start or whole-document type-over corrupts newlines

**Status:** done (2026-10-14).
**Origin:** [Task 614](614-sv-collapsed-cut-deletes-document.md) follow-up 1, measured in real VS Code and the Chromium harness during that task.
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

Task 618 ("SV type-over of a whole-document selection leaves extra blank lines", filed 2026-10-05, severity low) is merged here: both defects come from the SV newline spans, one at the selection start and one at the selection end. Origin: [Task 613](613-select-all-collapses-after-undo-snapshot.md) follow-up 4, measured in the Chromium harness during that task. The result has one or two extra newlines; one Undo restores the exact source.

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

- [x] SV: Delete, Backspace, type-over and cut of a selection that starts at a line start remove only the selected characters (Chromium and real VS Code).
- [x] One Undo restores the exact source.
- [x] Task 614's collapsed copy/cut results and the IR/WYSIWYG clipboard tests are unchanged.
- [x] SV: type-over of a whole-document selection gives `X\n`, with and without a pending undo snapshot (Chromium and real VS Code).
- [x] The undo snapshot keeps an SV selection's focus at the same character.
- [x] Whole-document Delete and one Undo keep their exact results.

## Part 1 handoff (2026-10-08)

Agent `opus-high` (Opus 5.5, requested effort high; runtime metadata unverified). Read-only; one scratch Node script ran Lute `SpinVditorSVDOM` on sample sources.

- Start endpoint: every SV line ends with a newline span (`<br>` plus a hidden `\n`). Chromium's editing delete widens a selection that starts at a line start back to just after the previous `<br>`, so the hidden `\n` is deleted and the lines join. Routes: native Delete, Backspace, type-over, and the SV cut (`execCommand("delete")` in `patchCutDeleteSync`). Vditor's SV Backspace keydown branch for a block-start selection joins the same way. Range shifting cannot fix content-only selections; `Range.deleteContents()` is DOM-exact.
- End endpoint (Task 618): SV Select All leaves the focus at `(lastNewlineSpan, 1)`; the Task 613 snapshot capture (`vmdeCaretSelectionEndpoint`) maps it to a text offset that restores before the `<br>`, so the selected line break leaves the selection on type-over with a pending snapshot.
- Reader: Vditor's SV `getValue` adds one `\n` to the host text; acceptance uses the host reader (`serializeSvForHost`). The record's 618 values came from `getValue` and must be remeasured with both readers.
- Design: a VMDE-owned DOM-exact edit, used only when a non-collapsed SV edit starts at the start of a source line other than the first (`start > 0 && text[start-1] === '\n'`). It deletes the exact range, inserts typed text, merges blocks, places the caret in the start block, marks user input and dispatches an `input` event so Vditor's own SV input path re-spins and takes one Undo snapshot (Undo grouping unchanged). Whole-document, mid-line and Task 614 line-cut routes stay native. For 618 the snapshot capture keeps an SV newline-span endpoint as a raw `{node, offset}`.
- Steps: S1 helper `media-src/src/editing/sv-selection-edit.ts` (new module id in `scripts/module-manifest.mjs`) with Vitest; S1b snapshot endpoint mapping in `media-src/esbuild-shared.mjs` with patch tests; S3a Chromium RED legs before wiring; S2 wiring (Backspace keydown, `beforeinput`, cut bridge); S3b Chromium GREEN; S4 real-VS-Code XTEST and command-cut legs.
- Orchestrator rulings: accepted D1–D8 (gated ownership, new module, synthetic input event, Backspace pre-emption for owned selections only, paste only on a measured RED, raw endpoint capture, host reader for acceptance, synchronous owned cut with real VS Code as the authority). Pre-existing Vditor SV issues seen while reading (Enter over a selection, the Backspace `start === 1` branch, IME over a line-start selection, `insertHTML` paste sub-paths, a collapsed caret at `(nl,1)`) are out of scope and go to the Owner at queue end.

## Execution progress — 2026-10-14 (S1)

Step S1 (pure ownership helper) done. No wiring, no DOM edits, no patch changes.

- Files: new `media-src/src/editing/sv-selection-edit.ts` (exports `ownsSvSelectionEdit(text, start, end)` and `applySvSelectionEdit(text, start, end, insert)`), new `media-src/src/editing/sv-selection-edit.test.ts` (14 cases), `scripts/module-manifest.mjs` (id `sv-selection-edit` in the `editing` module).
- Ownership: non-collapsed, valid integer range inside the text, `start > 0` and `text[start - 1] === '\n'`. First line, whole-document, mid-line, collapsed and invalid ranges are not owned. `apply` returns `text.slice(0, start) + insert + text.slice(end)` and caret `start + insert.length`.
- Cases (source `Alpha line\nBravo line\nCharlie line\n`): delete `Bravo`, delete `Bravo line`, delete `Bravo line\n` and type-over `Bravo` with `X` give the contract sources; plus first line, a line after a blank line, multi-line, selection to the document end, mid-line, collapsed, whole-document and invalid ranges.
- The helper does not assume LF-only text; the source was not checked for CR handling in the SV text, so S2 should confirm it.
- Commands: the new Vitest file 14/14 pass; `test/backend/module-boundaries.test.ts` 7/7 pass; `npm run typecheck` exit 0; `npx biome check` on the three files clean (after `biome format`); `npm run knip` exit 0 with no report. With a deliberately wrong stub (range starts at `start - 1`, predicate always true) the file failed 9 of 14, then passed 14/14 after restoring the implementation.

## Execution progress — 2026-10-14 (S1b)

Step S1b (snapshot endpoint mapping for the merged Task 618 end endpoint) done. No wiring and no change to the SV edit helper.

- Patch (`media-src/esbuild-shared.mjs`, `patchUndoCaretSplitRestore`): `vmdeCaretSelectionEndpoint` keeps an endpoint that sits on a `span[data-type="newline"]` inside the SV editable root as a raw `{node, offset}`. The block-relative text offset cannot name it: the hidden `\n` follows the `<br>`, so `(span, 1)` mapped to the end of the line text, one character short. Any other node maps as before; IR and WYSIWYG roots, which lack the `vditor-sv` class, are unchanged. The four undo anchors and the restore branch are untouched.
- Vitest (`test/backend/vditor-source-patches.test.ts`): an SV `SPAN` focus keeps its node and offset (fails without the change); the same span under an IR or WYSIWYG root maps to its block path and text offset as before; each undo anchor appears exactly once in the shipped source and the patched capture defines the endpoint function once. The existing drift-guard tests are unchanged and pass.
- Chromium (`media-src/e2e/undo-boundaries.spec.ts`, harness `undo-boundaries.html?mode=sv&doc=two`): SV, settle past `undoDelay`, type `Z`, Select All (Playwright keyboard), type `X`, read the host-style source (trailing editable newline span removed). Leg without a snapshot between (the edit's snapshot ran before Select All) and leg across one (the snapshot is pending at Select All and runs on the whole-document selection). Both give `X\n`; one Undo restores the exact pre-type-over source. Without the patch the across leg fails with an extra `\n`; the without leg passes (nothing alters the selection), so it is a control.
- The Task 618 record measured the "without" leg as `X\n\n`; that value came from `getValue`, which appends one newline in SV. With the host reader the unpatched result is `X\n`, as above.
- Real VS Code was not run (S4).

## Execution progress — 2026-10-14 (S2)

Step S2 (wiring of the VMDE-owned SV selection edit) done. Real VS Code was not run (S4).

- New module `media-src/src/editing/sv-selection-edit-dom.ts` (module id `sv-selection-edit-dom` in `scripts/module-manifest.mjs`), installed from `boot/finish-init.ts` (`observers.set('sv-selection-edit', installSvSelectionEdit(window))`) and, for the Chromium harness, from `media-src/e2e/mouseops-harness.ts`. `main.ts` is unchanged.
- Routes, all gated by `ownsSvSelectionEdit` on the selection's text offsets (the editor's `textContent`, hidden newline included): document-capture `beforeinput` for `deleteContentBackward`, `deleteContentForward`, `deleteByCut` and `insertText` with data; document-capture `keydown` for a plain Backspace (preventDefault plus stopPropagation, so Vditor's SV Backspace branch does not run); `window.__vmdeSvOwnedDelete`, which the patched SV cut handler (`patchCutDeleteSync` in `media-src/esbuild-shared.mjs`) calls instead of `execCommand("delete")` when the collapsed line cut did not move the selection (`__vmdeSelectSvLineDelete` returned false). Everything else keeps its previous path: collapsed carets, the Task 614 line cut, whole-document and first-line selections, mid-line starts, paste, IME composition, events from outside the SV editable, other modes.
- Edit: records the start and end blocks and a live caret range, marks user input through the existing `__vmdeMarkCutInput` hook, runs `Range.deleteContents()`, appends the end block's remainder to the start block and removes the end block, inserts the typed text, selects the caret, and dispatches an `input` event on the editor so Vditor's SV input path re-spins and takes its one Undo snapshot. The event type is `deleteContent` (not `deleteContentBackward`) for Delete and Backspace: for the backward type Vditor's SV input path skips its re-spin when the caret is left at a line start, which this edit always does. Cut keeps `deleteByCut`; type-over keeps `insertText`.
- LF finding: the SV DOM text is LF-only. A document set with CRLF line endings reads back with LF in the editor's `textContent` (measured in the Chromium harness), so the mapping needs no `\r` handling; the DOM-exact delete would not remove a `\r` outside the range in any case.
- The pinned patch test in `test/backend/vditor-source-patches.test.ts` that matched the old SV cut branch text now matches the new branch, and a new case pins the order (line-cut hook first, owned delete second, `execCommand` otherwise).
- Chromium: `media-src/e2e/sv-line-start-edit.spec.ts` 10/10 pass (5 defect cells, type-over and 4 controls), each defect cell with its exact single Undo. With the harness install line commented out (the one toggle) the same spec fails the 5 defect cells (Delete, Backspace, Delete over content, Delete over the whole line, Ctrl+X) and passes type-over and the 4 controls; restoring the line gives 10/10. Type-over passed natively before the wiring, so it is a control for the owned route, not a RED cell. Also green with the wiring: `copy-cut.spec.ts` (except the pre-existing failure below), `copy-cut-probes.spec.ts`, `undo-boundaries.spec.ts` including the S1b legs, `split-scroll.spec.ts` (90 passed, 3 failed in one run), plus 43/43 for the other specs that use the same harness (`paste-pipeline`, `mouse-selection`, `dragdrop`, `toolbar-selection`, `checkbox-click`, `reduced-motion`, `screen-reader`, `paste-upload`).
- Pre-existing failure, not caused by this step: `copy-cut.spec.ts` "collapsed line copy and cut through the before-events" fails in IR, WYSIWYG and SV with `alpha not found` at the second caret placement. It fails identically with the install line commented out and on an unmodified checkout of HEAD (the `media-src`, `src` and `scripts` trees exported from HEAD and run against the same built assets).
- Extra measurements (scratch spec, deleted): with blocks separated by blank lines, Delete, Backspace and type-over from the start of the middle block, across blocks, and to the document end give the exact sources, with Undo and Redo exact. The owned cut ran zero `execCommand("delete")` calls and gave `Alpha line\n line\nCharlie line\n` in the editor text. After a type-over the caret sits after the typed text and further typing and Delete act there. Deleting from a heading-following or list-following line start gives the same Lute-normalised layout as the equivalent mid-line deletion (a blank line after the heading), so that normalisation is Vditor's own, not this edit's. A Backspace over a selection that starts one character into a line (`plain` minus its first letter) still removes the first letter too: that is the out-of-scope Vditor `start === 1` branch from the Part 1 notes, not changed here.
- Vitest: new `media-src/src/editing/sv-selection-edit-dom.test.ts` (29 cases: every route and its event type, block merge, element-boundary start, type-over, the non-owned list, IME, foreign event target, other mode, modifier keys, the cut hook with the mark-before-edit order, disposer). `test/backend/vditor-source-patches.test.ts`, `test/backend/module-boundaries.test.ts`, the S1 helper tests, `clipboard-line.test.ts` and `finish-init.test.ts` pass (406 tests with the config `test/vitest.config.mts`). `npm run typecheck` exit 0, `npx biome check` on the touched files clean, `npm run knip` exit 0.
- Acceptance boxes stay unchecked: they name real VS Code (S4) and the Task 618 end-endpoint legs also need the S4 pass.

### S2 repair round 1 (2026-10-14)

- Re-init: `Disposables.set` installs the new instance before it runs the previous disposer, so the old disposer used to clear `window.__vmdeSvOwnedDelete` and the patched SV cut fell back to `execCommand("delete")`. The disposer now clears the hook only if it is still that instance's own function.
- Failure after the DOM changed: `applyOwnedEdit` now sets a `mutated` flag right before `Range.deleteContents()`, sends the `input` event from a `finally`, and never throws; once the DOM changed it returns true even if the block merge, the text insert or the selection step failed, so the caller still cancels the native edit (Backspace keydown, `beforeinput`) or skips `execCommand` (cut).
- Owned delete input types now also include `deleteWordBackward`, `deleteWordForward`, `deleteSoftLineBackward`, `deleteSoftLineForward`, `deleteHardLineBackward` and `deleteHardLineForward`; over a selection they delete exactly it. They reach Vditor as `deleteContent`.
- Caret: at the start of a list item the Vditor re-spin put its caret at the end of the previous line (source offset 5 instead of 6 for `- one\n- two\n- three\n` minus `- two\n`). When the re-spun text equals the edit's text model, the module now puts the caret at the model offset (selection start plus inserted length) in a visible text node; when Lute reformatted the text it leaves Vditor's caret.
- Chromium (`media-src/e2e/sv-line-start-edit.spec.ts`, now 18 cells): blank-line-separated blocks (Delete over `Bravo` at the middle block start, Delete, Backspace and type-over `X` across blocks, Delete to the document end), a whole list item line with its marker, and a heading line start, each with the exact source, the caret at the selection start plus the inserted length, one exact Undo and one exact Redo; and a re-init leg (install a second instance, dispose the first, Ctrl+X over `Bravo` gives `Alpha line\n line\nCharlie line\n` with zero `execCommand("delete")` calls and one exact Undo). The harness exposes the installer and the current disposer for it.
- Vditor behaviour kept, not changed: deleting a list item's text together with its marker but leaving its newline (`- two`, newline kept) leaves a blank line inside the list, and Lute's re-spin turns that blank line into an empty item (`- one\n- \n- three\n`), exactly as the equivalent mid-line deletion does. The list cell therefore selects the whole item line including its newline.
- Vitest (`sv-selection-edit-dom.test.ts`, now 42 cases): the six word and line delete types and their non-owned case, a re-init sequence (install twice, dispose the first, the second hook survives and works), a forced `addRange` failure for `beforeinput`, Backspace and the cut hook (native edit cancelled, one `input` event, hook true), and the caret restore both when the text equals the model and when a re-spin reformats it. Checks that the new cases fail without the fixes: the re-init case and the three failure cases fail with the old disposer and the old catch.
- Results: red spec and the other four spec files 98 passed, 3 failed (the same pre-existing `copy-cut.spec.ts` "collapsed line copy and cut through the before-events" cases); Vitest 6 files, 419 tests passed; `npm run typecheck`, `npx biome check`, `npm run lint:ci` (`biome ci`) and `npm run knip` clean. Real VS Code is still S4.

## Execution progress — 2026-10-14 (S4)

Step S4 (real VS Code, OS-level XTEST keys) done. New spec `test/vscode-e2e/sv-line-start-edit.spec.ts`; no product change. Every key is an X11 XTEST key (`xtest-input.ts`) into the verified VS Code window under Xvfb with a key-binding-free window manager; the host text is read from the VS Code document, the clipboard from `vscode.env.clipboard`. The selection is placed by source offset through the caret authority (the shape of a drag from a line start); the edit key is always OS-level. Each edit waits past `undoDelay`, then one OS Ctrl+Z must restore the exact opened bytes with a clean document (dirty after the edit, clean after the Undo).

- Test 1, source `Alpha line\nBravo line\nCharlie line\n` (11 legs, all exact): Delete, Backspace, type-over `X` and Ctrl+X (clipboard `Bravo`, a sentinel written first) over `Bravo`; Delete over the content `Bravo line`; Delete over the whole line `Bravo line\n`; Ctrl+Backspace over `Bravo`. Controls: mid-line `ravo` Delete, line-1 `Alpha` Delete, the Task 614 collapsed Ctrl+X line cut (`Alpha line\nCharlie line\n`, clipboard `Bravo line\n`), and whole-document Ctrl+A plus Delete. Expected texts are the original minus the selection (plus the typed text).
- Test 2, Task 618, `Alpha bravo charlie\n\nDelta echo foxtrot\n`: type `Z` at the end, Ctrl+A, type `X` gives `X\n` with the typed edit's snapshot taken before Select All and with it still pending at Select All; one Undo restores the text with `Z`. A read-only wrapper around the engine's snapshot call proves the window of each leg (0 or 1 snapshots between Select All and `X`); a leg that misses its window fails as a setup error.
- Test 3, re-init: with the default mode set to SV, `vmde.editor.codeLineNumbers` changes (editor epoch 1 to 2, mode SV), then Ctrl+X over `Bravo` gives `Alpha line\n line\nCharlie line\n`, clipboard `Bravo`, one exact Undo.
- Test 4, probe: a space typed over `Bravo line\n\nCharlie` in `Alpha line\n\nBravo line\n\nCharlie line\n` gives `Alpha line\n\n  line\n` (the pure string result), the caret collapsed in the surface at source offset 13 with a painted position; one exact Undo.
- Reader finding: the whole-document Delete leaves the host document empty (`""`), while the webview's rendered value is `\n`. The `\n` of the record's table is the rendered value (Vditor's SV `getValue` appends one newline); the host reader gives `""`. The spec asserts both. The same host result occurs with the owned-edit registration removed (the selection starts at offset 0, so it was never owned), so the result is unchanged by this task.
- Negative check: with the `installSvSelectionEdit` registration commented out in `boot/finish-init.ts` and rebuilt, test 1 fails 6 legs (Delete, Backspace, cut, Delete over the content, Delete over the whole line, Ctrl+Backspace) with the defect (`Alpha line line\nCharlie line\n`, `Alpha line\nCharlie line\n`, `Alpha lineCharlie line\n`) and passes type-over (native, as in Chromium) and the controls except the whole-document Delete, which fails only on the old `\n` expectation (host `""`). The registration was restored and rebuilt; `git diff --exit-code media-src/src/boot/finish-init.ts` exits 0.
- Results on the final build: the new spec 4 passed (2.3 min, `--retries=0`, `--workers=1`). Reruns: `clipboard-collapsed.spec.ts` 11 passed, `cut-selection-sv.spec.ts` 1 passed, `sv-split.spec.ts` 1 passed, `undo-host-coupling.spec.ts` 7 of 8 in a combined run of 21 tests (20 passed). The failed one, "ir: twelve-key burst, step limit, ..." (IR typing, outside the changed code), failed once at fixture setup (`browserWindow: Resulting promise was garbage collected`), once on its step-limit journey (19 undo entries instead of 1, a typing-gap timing result), and passed on its third run on this build; it also passes in a tree exported from the commit before Task 619. It is recorded as intermittent, not attributed to this task.
- Typecheck `npm run typecheck:vscode-e2e` exit 0; `npx biome check` on the spec clean.
- Acceptance boxes are ticked on this evidence: Chromium results from S1b and S2, real-VS-Code results here. The whole-document Delete box rests on "unchanged by this task" (host `""`, rendered `\n`).

## Closure — 2026-10-14

- **Outcome.** In SV, Delete, Backspace, type-over, word and line deletes and cut of a non-collapsed selection that starts at a line start (other than the first line) now remove only the selected characters. A VMDE-owned DOM-exact edit does this and sends one `input` event, so Vditor's own SV input path re-spins and takes one Undo snapshot. The merged Task 618 end endpoint is fixed in the undo snapshot: an SV newline-span endpoint is kept as a raw node and offset. Task 614's collapsed line cut, whole-document, first-line and mid-line selections, paste and IME composition keep their previous paths.
- **Acceptance evidence.**
  - Delete, Backspace, type-over and cut at a line start: Chromium `media-src/e2e/sv-line-start-edit.spec.ts` (18 cells, with their exact Undo and Redo); real VS Code `test/vscode-e2e/sv-line-start-edit.spec.ts` test 1 (11 legs, OS-level keys).
  - One Undo restores the exact source: the same two specs; real VS Code checks the dirty state before and after.
  - Task 614's collapsed results and the IR/WYSIWYG clipboard tests unchanged: the collapsed Ctrl+X control leg in real VS Code test 1; `clipboard-collapsed.spec.ts` 11 passed, `cut-selection-sv.spec.ts` and `sv-split.spec.ts` passed in S4; Chromium `copy-cut.spec.ts` unchanged except its pre-existing failure.
  - Whole-document type-over gives `X\n`, with and without a pending snapshot: Chromium `media-src/e2e/undo-boundaries.spec.ts` (S1b legs); real VS Code spec test 2 (snapshot window proved by a read-only wrapper).
  - The snapshot keeps an SV selection focus at the same character: `test/backend/vditor-source-patches.test.ts` (SV `SPAN` focus kept raw; IR and WYSIWYG mapping unchanged) and the two type-over legs above.
  - Whole-document Delete and one Undo: real VS Code spec test 1 control leg and the Chromium control.
- **Whole-document Delete reader finding.** The host document is `""` after the Delete; the webview's rendered `getValue` is `\n` (Vditor's SV `getValue` appends one newline). The record's `\n` table value was the rendered value. The host result is the same with the owned-edit registration removed (the selection starts at offset 0, so it is never owned), so the result is unchanged by this task.
- **Commits.** Records: `16b0be6f`, `b9f213fe`, `d1566d20`, `ed3ddffd`, `28c2a5f7`. Helper `6e106f71`. Snapshot endpoint `68f13e9b`. RED `dbe01d59`. Wiring `290f9881`. Real-VS-Code spec `4317eebc`.
- **Gates on HEAD `a95c3b35` (exit 0 unless noted).** `npm run lint:ci`; `npm run typecheck`; `npm run knip`; `npm run jscpd`; `npm run depcruise`; `npm run test:coverage` (336 files, 6,264 passed, 1 expected fail on the final run; one earlier run of the same command reported 1 failed test, not identified, and the next run passed); `npm run check:coverage-modules` (11 modules at 0%, baseline 11); `npm run check:brand-identifiers`; `npm run typecheck:vscode-e2e`. `npm run quality` as one command was not run, and its audit stage was omitted by Owner instruction.
- **Bundle.** `media/dist/main.js` is 950,951 B (928.7 KiB), +3,441 B against the Task 636 close (947,510 B). `npm run check:startup-cost` reports 356 eager modules (Task 636 close: 354) and exits non-zero against its budget of 294; the budget miss was already present before this task and is reported, not changed here.
- **`undo-host-coupling` comparison.** The real-VS-Code test "ir: twelve-key burst, step limit, ..." was run alternately three times on HEAD and three times on an export of the commit before this task (`9eb1947a`), one run at a time with no retries, under the isolated X11 setup. HEAD: pass, pass, fail. Before: pass, fail, pass. Both failing runs ended with the same assertion (`every special journey passed`, a journey result differing by 2 lines). Earlier S4 runs on HEAD also failed twice (fixture setup error; 19 undo entries instead of 1). The test is a pre-existing intermittent, comparable on both builds, and the failures sit in IR typing outside the changed code. It is not attributed to this task.
- **Residuals.**
  - The Backspace pre-emption hides the key from other keydown handlers for owned selections.
  - A typed space over a multi-block selection keeps stale spans until the next re-spin (the pure string result is exact; real VS Code probe).
  - The Vditor Backspace `start === 1` branch and the other suspected SV issues belong to [Task 629](629-sv-preexisting-selection-edit-issues.md).
  - `copy-cut.spec.ts:226` ("collapsed line copy and cut through the before-events") fails in Chromium in all modes on an unmodified HEAD export; it is pre-existing.
