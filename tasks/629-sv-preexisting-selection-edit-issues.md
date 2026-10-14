# Task 629 — Pre-existing SV selection and caret issues found during Task 619

**Status:** planned (2026-10-08). The Project Owner approved filing this record on 2026-10-08. Implementation has not started.
**Origin:** Task 619 Part 1 source reading. None of these has been measured.
**Severity:** medium (estimated).
**Tech stack:** webview SV mode (Vditor `sv/processKeydown`, paste and composition paths, Task 613 snapshot capture), Chromium e2e, real VS Code with XTEST.

## Problem

While reading source for [Task 619](done/619-sv-line-start-delete-joins-previous-line.md), several other SV selection and caret problems were suspected. All are unverified.

## Evidence

Source reading only, all unverified:

- (a) Enter over a non-collapsed SV selection inserts `\n` without deleting the selection. The Vditor `sv/processKeydown` Enter branch uses `insertNode` on a non-collapsed range.
- (b) Backspace with a selection starting at column 1 also deletes column 0 (the `start === 1` branch).
- (c) IME composition over a line-start selection cannot be canceled and may join lines the way Task 619 did.
- (d) The paste-into-code and paste-as-code sub-paths use `execCommand("insertHTML")` and may join lines like Task 619.
- (e) A collapsed caret at `(newlineSpan, 1)` may restore before the `<br>` through the [Task 613](done/613-select-all-collapses-after-undo-snapshot.md) snapshot capture.

## Suspected cause

See each item above. These are inferences from reading code, not measurements.

## Tests

First step: measure each item in Chromium and in real VS Code before any fix. Then add a RED test case per confirmed item (Chromium e2e plus a focused real-VS-Code spec), and fix only the confirmed ones.

## Acceptance

- [x] Each of (a) to (e) measured in Chromium and real VS Code, with the result recorded here (S1). Exception: (c) is not measurable with OS-level keys in real VS Code; the Chromium result stands.
- [ ] Each confirmed item has a RED test, a fix and a GREEN test; unconfirmed items are closed as not reproducible.
- [ ] Focused real-VS-Code specs written and run; `npm run quality` passes.

Related: [Task 619](done/619-sv-line-start-delete-joins-previous-line.md), [Task 614](done/614-sv-collapsed-cut-deletes-document.md), [Task 613](done/613-select-all-collapses-after-undo-snapshot.md).

## Execution progress — 2026-10-14 (S1)

Measurement only; no product edit. Build: `node build.mjs`. Source used throughout: `Alpha line\nBravo line\nCharlie line\n` (call it ORIGINAL), plus a blank-line-separated variant and a fenced-code variant where named. Chromium: the mouse-operations SV harness (the one Task 619's Chromium spec uses), Playwright keys and a synthetic `ClipboardEvent` for paste, CDP `Input.imeSetComposition` for IME. Real VS Code: OS-level XTEST keys in an isolated display with a key-binding-free window manager, host text read from the `TextDocument`, paste through the real clipboard. "Undo steps" is the number of Undo presses needed to get the opened source back (at most 3 tried). Every case below restored the opened source in exactly one Undo, so Undo count is 1 unless stated. Both scratch specs were deleted afterwards.

### (a) Enter over a non-collapsed selection

| Case (selection, Enter) | Chromium source after | Real VS Code host text after | Reproduces |
| --- | --- | --- | --- |
| `ravo` (mid-line) | `Alpha line\nB\nravo line\nCharlie line\n` | identical; dirty true | yes |
| `Bravo` (line start) | `Alpha line\n\nBravo line\nCharlie line\n` | identical | yes |
| `ravo line\nChar` (across lines) | `Alpha line\nB\nravo line\nCharlie line\n` | identical | yes |
| control: collapsed caret after `B` | `Alpha line\nB\nravo line\nCharlie line\n` (correct) | identical (correct) | no |

Expected from the contract (selection replaced by one newline): `Alpha line\nB\n line\nCharlie line\n` for `ravo`, `Alpha line\n\n line\nCharlie line\n` for `Bravo`, `Alpha line\nB\nlie line\n` for the cross-line case. Observed: a newline is inserted at the selection start and the selected text is not deleted (leftover text stays; the caret ends after the leftover text). No line join. One Undo is exact in both layers (real VS Code: clean afterwards).
Classification: **confirmed** (selected text is not replaced).

### (b) Backspace with a selection starting at column 1

| Case (selection, Backspace) | Chromium source after | Real VS Code host text after | Reproduces |
| --- | --- | --- | --- |
| `ravo` (starts after `B`) | `Alpha line\n line\nCharlie line\n` | identical | yes |
| `ravo line\nChar` (across lines) | `Alpha line\nlie line\n` | identical | yes |
| `ravo` in the second block of `Alpha line\n\nBravo line\n\nCharlie line\n` | `Alpha line\n\n line\n\nCharlie line\n` | not measured (Chromium only) | yes |
| control: collapsed caret after `B` | `Alpha line\nravo line\nCharlie line\n` (correct, deletes `B`) | not measured | no |
| control: `avo` (starts at column 2) | `Alpha line\nBr line\nCharlie line\n` (correct) | identical (correct) | no |

Expected: `Alpha line\nB line\nCharlie line\n` (column 0 kept) and `Alpha line\nBlie line\n`. Observed: the `B` at column 0 is deleted together with the selection (consistent with Vditor's `start === 1` branch, which moves the range start to the span start; not isolated further). No line join. One Undo is exact.
Classification: **confirmed** (one extra character deleted).

### (c) IME composition over a line-start selection

| Case | Chromium | Real VS Code | Reproduces |
| --- | --- | --- | --- |
| `Bravo` selected, compose `日`/`日本`, commit | during composition `Alpha line\n日 line\nCharlie line\n`; after commit `Alpha line\n日本 line\nCharlie line\n` (exact, no join) | not measurable with XTEST | no (commit) |
| `Bravo` selected, compose, then cancel (empty composition) | during composition as above; after cancel `Alpha line line\nCharlie line\n` (the line break after `Alpha line` is lost, `Bravo` is gone, lines join) | not measurable with XTEST | yes (cancel) |
| control: `ravo` selected, commit | `Alpha line\nB日本 line\nCharlie line\n` (exact) | not measurable | no |
| control: `ravo` selected, cancel | `Alpha line\nB line\nCharlie line\n` (selection text gone, no join) | not measurable | no join |

Real VS Code: the XTEST helper only offers `key` and `type`; there is no input-method session in the isolated display, so composition cannot be driven there. The Chromium result stands. The selected text is removed when composition starts and is not restored by cancel in any case (native behaviour); only the line-start cancel also joins the lines. One Undo restores the opened source in all four cases.
Classification: **confirmed for cancel at a line start** (lines join); commit is exact; real VS Code unmeasured.

### (d) Paste into a code block, and paste-as-code, over a line-start selection

| Case | Chromium source after | Real VS Code host text after | Reproduces |
| --- | --- | --- | --- |
| `second` (line start inside a ```` ```js ```` block), paste `Z` | ```` Alpha\n\n```js\nfirst\nZ\n```\n\nOmega\n ```` (exact) | identical | no |
| same, paste `P\nQ` | ```` ...first\nP\nQ\n```... ```` (exact) | identical | no |
| control: `econd` (mid-line in the block), paste `Z` | exact | not measured | no |
| `Bravo` (line start), paste-as-code (HTML `<pre>` + plain `code1\ncode2`) | ```` Alpha line\n\n```\ncode1\ncode2\n``` line\nCharlie line\n```\n ```` | identical (HTML clipboard written through the webview, then Ctrl+V) | no join (see note) |
| `ravo` (starts at column 1), paste-as-code | ```` Alpha line\nB```\ncode1\ncode2\n\n```\nCharlie line\n```\n ```` | identical | no join (see note) |
| control: `Bravo`, plain paste `Z` | `Alpha line\nZ line\nCharlie line\n` (exact) | not measured | no |

Findings: the "paste into code" sub-path (`hasClosestByAttribute(target, "data-type", "code-block")`) is unreachable in this SV DOM: the serialized SV has zero elements with `data-type="code-block"` (code lines are `data-type="text"` spans inside the fenced block, in both layers). Paste inside the block goes through the ordinary path and is exact. Paste-as-code removes the selection exactly and keeps `Alpha line` and its line break; no line join and no wrong deletion. The fenced text is inserted in the middle of the line (the remaining ` line` follows the closing fence, and the unterminated fence then runs to the document end), the same for a mid-line start, so it is a property of pasting fenced code mid-line and not of a line-start selection. A collapsed-caret mid-line paste-as-code was not measured. One Undo is exact in the measured cases.
Classification: **not reproducible** as a Task 619-style join or wrong deletion. Possible separate follow-up (not filed, outside this record's scope): fenced paste-as-code inserted mid-line leaves an unterminated fence.

### (e) Collapsed caret at (newline span, 1) through an undo snapshot and restore

| Case | Chromium | Real VS Code | Reproduces |
| --- | --- | --- | --- |
| Caret at (first newline span, 1) (source offset 10), type `Z`, wait past the undo delay, Undo | edit gives `Alpha line\nZBravo line\nCharlie line\n`; after Undo the caret is again `(newline span, 1)`, offset 10; source restored | identical (host source restored, caret `(newline span, 1)`, offset 10) | no |
| Same, explicit snapshot (`undo.addToUndoStack`) with the caret there, then a text edit, Undo | caret restored to `(newline span, 1)`, offset 10 | not measured | no |
| Caret at (the blank line's newline span, 1) in `Alpha line\n\nBravo line\n\nCharlie line\n` (offset 11), type `Z` / explicit snapshot, Undo | caret restored to `(newline span, 1)`, offset 11 in both variants | not measured | no |

The restored position equals the captured one; it does not move before the `<br>` or to another line. Undo count 1.
Classification: **not reproducible**.

### Summary

| Item | Chromium | Real VS Code | Classification |
| --- | --- | --- | --- |
| (a) Enter over a selection | reproduces | reproduces | confirmed |
| (b) Backspace, selection from column 1 | reproduces | reproduces | confirmed |
| (c) IME over a line-start selection | cancel joins lines; commit exact | not measurable with OS keys | confirmed for cancel (Chromium only) |
| (d) paste into code, paste-as-code | exact, no join | exact, no join | not reproducible |
| (e) caret at (newline span, 1) | restored exactly | restored exactly | not reproducible |

Next step per this record: RED test, fix and GREEN test for (a), (b) and (c)-cancel only; close (d) and (e) as not reproducible. Acceptance boxes 2 and 3 stay open.

## Part 1 handoff (2026-10-14)

Read-only source reading; no probes, builds or tests ran. V = verified by reading; I = inference that Part 2 must confirm. Vditor paths are under `media-src/node_modules/vditor/src/ts/`.

### Causes and entry points

- (a) V: `sv/processKeydown.ts:126-154`, the plain-Enter branch (no Ctrl, Alt or Shift), calls `range.insertNode("\n" + processPreviousMarkers(span))` at `:145` and `range.collapse(false)` at `:146` and never deletes a non-collapsed range. It then runs `inputEvent` or `processAfterRender` (`:147-151`) and calls `preventDefault`, so the selected text stays as leftover text after the new line break. Vditor's listener is on the editor element (`util/editorCommonEvent.ts:115`), and `hint.select` runs first (`:121`).
- (b) V: `sv/processKeydown.ts:157-172`, the plain-Backspace branch, fires when the range start is at offset 1 of a span whose previous sibling is a newline span (`:158-161`). This is the first span of a line that follows a newline span in the same block; S1 also reproduced it on the first text line of a block after a blank line, so such blocks begin with a newline span (I). The branch then calls `range.setStart(span, 0)` (`:163`) and `extractContents()` (`:164`) without checking `range.collapsed`. For a collapsed caret this deletes the character at column 0 (intended). For a selection it widens the start back to column 0. V: the Task 619 owned route does not take it (`media-src/src/editing/sv-selection-edit.ts:14-23` owns only starts with `text[start - 1] === '\n'`; `sv-selection-edit-dom.ts:236-256` pre-empts Backspace only for owned selections). I: the branch also fires at column 1 of a marker span (heading, list or blockquote marker that starts the line) and on fenced code lines (their spans are `data-type="text"`, per S1 (d)).
- (c) V: `sv/index.ts:74-83` only sets `composingLock` at `compositionstart`, and runs `inputEvent(vditor, event)` at `compositionend` (`:80`). This re-spins the block from the DOM as it is. V: the Task 619 module stays out of composition (`sv-selection-edit-dom.ts:87`, `:214`, `:240`). I: Chromium's own deletion of the selection when composition starts (or its removal of the empty composition on cancel) widens over the previous line's hidden `\n`, as in Task 619. Commit is exact (S1), so the loss shows only on cancel. Where the `\n` goes is unmeasured (probe P-c1).

### Contract

Common to all three items: one Undo step restores the opened source exactly. The host gets the edit as a normal user edit (dirty after the edit, clean after the Undo). The caret is collapsed. The ORIGINAL source is the S1 source. Undo boundaries are unchanged: Task 580's Enter boundary is a `window` capture listener (`media-src/src/editing/undo-boundaries.ts:483`, `:586`), so it runs before the `document` capture listeners below.

- (a) Owner: the Task 619 module (`sv-selection-edit-dom.ts`), a new plain-Enter case in its `document` capture `keydown`. When the key is plain Enter, the selection is non-collapsed and inside the SV editable, no composition is active and the Vditor hint is not shown, the module does the DOM-exact delete. This is the existing `applyOwnedEdit` delete-and-merge part, split out without its `input` event, and it calls the same `__vmdeMarkCutInput` hook. The module leaves the caret at the selection start and does not call `preventDefault` or `stopPropagation`. Vditor's Enter branch then runs on a collapsed caret, so its list and blockquote continuation and its single re-spin and Undo snapshot are kept. Expected results: `ravo` gives `Alpha line\nB\n line\nCharlie line\n` (caret 13), `Bravo` gives `Alpha line\n\n line\nCharlie line\n` (caret 12), and `ravo line\nChar` gives `Alpha line\nB\nlie line\n` (caret 13). In a list item, the continuation markers are those Vditor gives for a collapsed caret at the selection start. These stay native or Vditor's: collapsed Enter, Ctrl, Alt or Meta with Enter, Shift+Enter (measure it as a control in S2a; if it is wrong, it is an Owner question, not a fix here), Enter while the hint is shown, and composition.
- (b) Owner: the Task 619 module. Add a new pure predicate `ownsSvColumnOneBackspace(text, start, end)` in `sv-selection-edit.ts`: the range is non-collapsed and valid, `start >= 2`, `text[start - 2] === '\n'` and `text[start - 1] !== '\n'`. The `keydown` Backspace route takes it in the same way as the owned line-start case: owned edit, `input` type `deleteContent`, `preventDefault` and `stopPropagation`. Expected results: `ravo` gives `Alpha line\nB line\nCharlie line\n` (caret 12), and `ravo line\nChar` gives `Alpha line\nBlie line\n` (caret 12). These stay native or Vditor's: a collapsed caret at column 1 (deletes column 0), selections that start at column 0 or column 2 and later, line 1 of the document (Vditor's branch does not fire there; I), and Backspace with modifiers (native word or line delete; the Task 619 `beforeinput` route already covers line starts).
- (c) Owner: the Task 619 module, a new composition case. At `compositionstart` (`document` capture), when the selection is owned by `ownsSvSelectionEdit` (it starts at a line start other than the first), record the text model and do the DOM-exact delete with no `input` event. The composition then starts on a collapsed caret, and Vditor's `compositionend` `inputEvent` takes the one Undo snapshot. Expected results: commit `日本` over `Bravo` gives `Alpha line\n日本 line\nCharlie line\n` (unchanged, caret 13). Cancel gives `Alpha line\n line\nCharlie line\n` (caret 11): the selected text stays removed, as in native editing (provisional decision D3), and the lines do not join. The mid-line commit and cancel controls stay native. This depends on probe P-c2. Fallback if a DOM change inside `compositionstart` disturbs the IME: at `compositionend`, compare the text with the recorded model (selection replaced by `event.data`) and restore the lost `\n` before Vditor re-spins.

### Edge cases (cheapest layer named)

- (a) Backward selection (Vitest DOM, Chromium). Whole-document selection (`start === 0`): the start block may be removed, so if no `data-block` holds the caret afterwards, leave the key to Vditor and record the result. The expected host text is `\n`; measure it in S2a. Other cases: a selection to the document end, a blank line, a whole line including its newline (`Bravo line\n` gives `Alpha line\n\nCharlie line\n`), and a list item with `two` selected in `- one\n- two\n` (the expected value is Vditor's own result for a collapsed caret at the selection start, measured as a control in the same spec). For these use Chromium, plus Vitest for the route decision.
- (b) A one-character line (in `a\nx\nfoo`, select from after `x` to after `f`; expected `a\nxoo`), a heading or list marker at column 0, a fenced code line, a block after a blank line (S1 case), and line 1 of the document (control). Use Chromium, plus Vitest for the predicate.
- (c) Cancel and commit at a line start, a cross-line selection from a line start, an update followed by a commit, a selection after a blank line, line 1 of the document (not owned; record it), and the mid-line controls. Use Chromium only.
- All items: CRLF does not apply to the DOM (the SV text is LF-only, Task 619 S2). The pure predicate cases include no `\r`. Multi-cursor does not apply (one DOM selection).

### Part 2 plan

- S2a, item (a): RED first. New Chromium spec `media-src/e2e/sv-selection-enter-backspace.spec.ts` (mouse-operations SV harness) with the three S1 cells and the edge cases above, each with its exact source, caret and one exact Undo. Controls: collapsed Enter and Shift+Enter. Add Vitest cases in `sv-selection-edit-dom.test.ts` for the Enter route: non-collapsed delete without `preventDefault`, and no action for hint shown, composition, modifiers, collapsed caret or another mode. Then the fix in `sv-selection-edit-dom.ts` (split the delete out of `applyOwnedEdit`).
- S2b, item (b): RED first. Add `ownsSvColumnOneBackspace` cases to `sv-selection-edit.test.ts` and DOM route cases, and add the (b) cells and controls to the same Chromium spec. Then the predicate and the `keydown` route.
- S2c, item (c): first run probe P-c1 (dump the SV DOM around the previous newline span during composition and after cancel) and probe P-c2 (whether an owned delete at `compositionstart` keeps commit and cancel exact under CDP `Input.imeSetComposition`). Then RED cells in the Chromium spec, the fix (or the `compositionend` fallback), and DOM Vitest cases for the composition route.
- S3: build first, then one new real-VS-Code spec, `test/vscode-e2e/sv-selection-enter-backspace.spec.ts`, with one `test()`. It uses OS-level XTEST keys and checks host text, dirty state and one OS Undo for the (a) and (b) S1 cells plus the collapsed Enter and column-2 Backspace controls. Item (c) is Chromium only: XTEST has no input-method session (S1).
- S4: closure. Run the gates, rerun the specs that import or exercise the changed files (`sv-line-start-edit.spec.ts` in Chromium and real VS Code, and `undo-boundaries.spec.ts`), and update the record.
- No new module id: both files are existing Task 619 modules, so `scripts/module-manifest.mjs` is unchanged. Overlap with Task 605: no shared files (Task 605 works in `block-transform-command.ts`, `rewrap-command.ts`, `details-toggle.ts` and the Turn Into specs). Both tasks rely on the LF-only SV text model and on Vditor's SV re-spin, so a change to either needs a cross-check.

### Items closed as not reproducible

- (d) In both layers, paste inside a fenced block and paste-as-code over a line-start selection gave exact sources with no line join. The "paste into code" sub-path cannot be reached, because the SV DOM has no `data-type="code-block"` element (S1). Closed. A fenced paste inserted mid-line leaves an unterminated fence; this is a possible separate follow-up and is not filed.
- (e) The caret at (newline span, 1) was restored to the same position and offset after a typed edit (Chromium and real VS Code) and after an explicit snapshot (Chromium), in S1. Closed.

### Provisional decisions (reversible)

- D1: reuse the Task 619 module for all three items. No new module, so no manifest change.
- D2: for (a), delete first and then let Vditor's Enter run, which keeps list continuation. A fully owned Enter would lose the continuation markers.
- D3: for (c), cancel leaves the selection deleted, as in native editing and the mid-line control.
- D4: for (b), own only the cases where Vditor's branch fires (column 1 of a line after a `\n`). Line 1 stays native.
- Owner question: the `keydown` pre-emption for (b) hides Backspace from later keydown handlers for those selections. Task 619 already records this as a residual. Recommendation: accept it.
- Risk: another task may be editing SV editing files at the same time. Check the working tree of `sv-selection-edit-dom.ts` before S2a.

## Execution progress — 2026-10-14 (S2)

S2a (a, Enter) and S2b (b, Backspace from column 1) are implemented with failing tests first. Items (c), the real-VS-Code spec (S3) and closure (S4) are not done; acceptance boxes 2 and 3 stay open.

### What changed

- `media-src/src/editing/sv-selection-edit.ts`: two pure predicates. `ownsSvEnterOverSelection(text, start, end)`: a valid non-collapsed range, wherever it starts. `ownsSvColumnOneBackspace(text, start, end)`: valid, non-collapsed, `start >= 2`, `text[start - 2] === '\n'` and `text[start - 1] !== '\n'`.
- `media-src/src/editing/sv-selection-edit-dom.ts`: the `keydown` route handles plain Enter and Backspace.
  - Enter: when the selection is non-collapsed, inside the SV editable, no composition is active, the Vditor hint list is not shown and the selection starts inside a `data-block`, the module does the DOM-exact delete and the same `__vmdeMarkCutInput` hook. It sends no `input` event, leaves the caret collapsed at the selection start, and calls neither `preventDefault` nor `stopPropagation`; Vditor's own Enter branch then runs on the collapsed caret (list continuation, its one re-spin and Undo snapshot).
  - Backspace: owns the Task 619 selections and, now, `ownsSvColumnOneBackspace` selections (owned edit, input type `deleteContent`, `preventDefault` and `stopPropagation`).
  - `applyOwnedEdit` was split into `readOwnedSelection`, `mergeBlocks` and the edit itself (the split removed a lint complexity failure). `OwnedEdit` gained `owns` and a nullable `inputType`.
  - Residual accepted by the Project Owner: for owned Backspace selections the keydown pre-emption hides Backspace from later keydown handlers, the same residual as Task 619.
- Tests: `sv-selection-edit.test.ts` (predicate cases), `sv-selection-edit-dom.test.ts` (Enter and Backspace route cases), new Chromium spec `media-src/e2e/sv-selection-enter-backspace.spec.ts`.
- Test support: the helpers of the Task 619 Chromium spec (`hostSource`, `open`, `undoIsExact`, `selectOffsets`, `caretOffset`, `redo`, `ORIGINAL`) moved unchanged into `media-src/e2e/sv-selection-helpers.ts`, used by both specs (the duplicate-code check includes `media-src/e2e`). One existing Vitest case changed: "leaves a selection it does not own to Vditor" selected `ravo`, which `ownsSvColumnOneBackspace` now owns by contract; it selects `avo` (column 2) instead.

### RED, then GREEN

- RED, Chromium, before any product edit: the new spec gave 16 failed and 4 passed. The 4 passes are the controls that are already correct (collapsed Enter after `B`, Backspace over `avo`, Backspace over `lph` on line 1, collapsed Backspace at column 1). All Enter cells, the backward, line 1, one-character line and list continuation cases, the whole-document case, and every Backspace column-1 cell failed on the expected source.
- RED, Vitest, before the DOM edit: 10 DOM cases failed (3 Backspace column-1 cases, 7 Enter cases). The two pure predicate files were written together with the predicates, so those cases have no separate failing run.
- GREEN, Chromium, after the fix: the new spec has 20 of 20 passed; with the Task 619 spec 38 of 38 passed.

### Measured results (Chromium; each cell: exact source, collapsed caret, the posted host edit equals the source plus the SV trailing newline, one Undo restores the opened source)

| Case | Source after | Caret |
| --- | --- | --- |
| Enter over `ravo` | `Alpha line\nB\n line\nCharlie line\n` | 13 |
| Enter over `Bravo` | `Alpha line\n\n line\nCharlie line\n` | 12 |
| Enter over `ravo line\nChar` | `Alpha line\nB\nlie line\n` | 13 |
| Enter over `Bravo line\n` (whole line) | `Alpha line\n\nCharlie line\n` | 12 |
| Enter over `Bravo` to the document end | `Alpha line\n\n\n` | 12 |
| Enter over `ravo`, backward selection | same as `ravo` | 13 |
| Enter over `Alpha` (line 1) | `\n line\nBravo line\nCharlie line\n` | 1 |
| Enter over `x` in `a\nx\nfoo\n` | `a\n\n\nfoo\n` | 3 |
| Enter over `two` in `- one\n- two\n` | equals Delete of `two`, then Enter on the collapsed caret (list continuation kept) | equal to the control |
| Enter over the whole document | `\n\n` | one Undo exact |
| Backspace over `ravo` | `Alpha line\nB line\nCharlie line\n` | 12 |
| Backspace over `ravo line\nChar` | `Alpha line\nBlie line\n` | 12 |
| Backspace over `ravo` in the block after a blank line | `Alpha line\n\nB line\n\nCharlie line\n` | 13 |
| Backspace over `# Head` from column 1 of `## Heading` | `Intro\n\n#ing\n` | 8 |
| Backspace over `irst` from column 1 of the first fenced code line | `Alpha\n\n```js\nf\nsecond\n```\n` | 14 |
| Backspace from after `x` to after `f` in `a\nx\nfoo\n` | `a\nxoo\n` | 3 |

Controls unchanged: collapsed Enter after `B`; Backspace over `avo` (column 2); Backspace over `lph` (line 1, column 1); collapsed Backspace at column 1 (deletes column 0).

### Measurements that differ from, or add to, the Part 1 handoff

- Whole-document Enter: the handoff guessed `\n`; the measured result with the fix is `\n\n`. This is consistent with the contract: a whole-document Delete leaves one newline (Task 619), and Enter adds one line break. The start of that selection is inside a `data-block`, so the owned delete is safe there. Before the fix the result was the unchanged document with a leading line break.
- Fenced code: the body of a fenced block is one `data-type="text"` span (`first\nsecond`, with a plain `\n` inside), not one span per line. Vditor's Backspace branch therefore fires only at column 1 of the first body line (after the info line's newline span). Later body lines are mid-span: a selection `econd` already gave the right result natively, and `ownsSvColumnOneBackspace` owns it too with the same result.
- Marker lines: column 1 of a heading marker line (`#` kept) reproduces the extra delete and is fixed. A list marker line was not measured separately.
- Controls reported, not fixed (per the brief):
  - Shift+Enter over a mid-line selection (`ravo`) deletes it and inserts no line break: `Alpha line\nB line\nCharlie line\n`, caret 12.
  - Shift+Enter over a line-start selection (`Bravo`) joins the lines: `Alpha line line\nCharlie line\n`, caret 10. This is the Task 619 defect class for a key that is neither Backspace nor Delete. Owner decision needed; not filed.
  - Enter over a whole-document selection was wrong before the fix and is fixed by the same change.
- Not tested: a hint list shown with a real Vditor hint (Vitest covers the check with a fake list element), composition for the Enter route (Vitest: `composingLock` and `isComposing`), a blank-line selection for Enter, and a list-marker line for Backspace.
- Vitest in this directory outside the touched files was not rerun as a set; six unrelated files in `media-src/src/editing` fail to load with `VDITOR_VERSION is not defined` when run from the repository root with the root config (not caused by this change; unverified on the base commit).

### Checks

- `npx vitest run media-src/src/editing/sv-selection-edit test/backend/vditor-source-patches.test.ts test/backend/module-boundaries.test.ts`: 4 files, 443 tests passed.
- `npm run typecheck`: exit 0. `npx biome check media-src/src/editing media-src/e2e`: clean. `npx knip`: exit 0. Duplicate-code check: 7.24 percent, under the 8.8 threshold.
- `node build.mjs`: exit 0.
- Chromium (own display): the new spec, `sv-line-start-edit.spec.ts`, `copy-cut.spec.ts`, `copy-cut-probes.spec.ts`, `paste-pipeline.spec.ts`, `toolbar-selection.spec.ts`: 77 passed and 3 failed in the run with those six; the 3 failures are the known `copy-cut.spec.ts:226` case in all three modes. The new spec and the Task 619 spec passed 38 of 38 in a final run.
- No real-VS-Code run (not part of S2; S3 owns it).

### Remaining

- S2c (IME cancel), probes P-c1 and P-c2, S3 (real-VS-Code spec with XTEST keys), S4 (closure, gates, rerun of the real-VS-Code and Chromium Task 619 specs and `undo-boundaries.spec.ts`).
- Open Owner question: Shift+Enter over a selection (see above).

## Execution progress — 2026-10-15 (S2c)

S2c (c, IME cancel over a line-start selection) is implemented, with failing tests first. The chosen route is the `compositionend` repair, not the `compositionstart` delete, because probe P-c2 showed the `compositionstart` delete does not keep a cancel exact. The real-VS-Code spec (S3) and closure (S4) are not done; acceptance boxes 2 and 3 stay open.

### Probes (Chromium, mouseops SV harness, CDP `Input.imeSetComposition`; lengths and booleans only)

Source ORIGINAL, `Bravo` selected (offsets 11 to 16), composition updates `日` then `日本`. The composition lifecycle authority was added to the harness first so the listener order matches the product (it runs before the module's `document` capture listeners).

- P-c1 (no fix; DOM around the previous newline span, one `div[data-block]` with text and newline spans):
  - At the first `compositionupdate` the selection is still there (`Bravo line` text node, length 10). Chromium replaces the selected text inside that text node: lengths 6, then 7 (`日本 line`). The previous newline span keeps its length-1 hidden `\n`. During the composition the host text is `Alpha line\n日本 line\nCharlie line\n` (exact).
  - Commit (`Input.insertText`): `compositionend` data length 2, the text is unchanged and exact.
  - Cancel (an empty composition update): the last `insertCompositionText` input removes the hidden `\n` of the previous newline span (its text length goes from 1 to 0, the `<br>` stays) and trims the text node to ` line` (length 5). This happens before `compositionend` (data length 0). Vditor's `compositionend` re-spin then merges the text nodes: `Alpha line line\n...`.
  - So the loss is Chromium's own removal of the composition text at the line start, not Vditor's re-spin and not the selection delete.
- P-c2 (a listener at `compositionstart` in the capture phase does the DOM-exact delete, merge and collapsed caret, as the contract (c) described):
  - The delete took effect: at `compositionstart` the text node is ` line` (length 5) and the host text is `Alpha line\n line\nCharlie line\n`.
  - Commit: exact, `Alpha line\n日本 line\nCharlie line\n`.
  - Cancel: still joined, `Alpha line line\nCharlie line\n`. The empty composition update again removes the hidden `\n` of the previous newline span (length 1 to 0), because the composition text sits at the line start again.
  - Result: negative for cancel. The `compositionstart` contract does not hold; the fallback applies.
- Extra probe (outside the owned cases): a collapsed caret at the same line start, one composition update, then cancel, gives `Alpha lineBravo line\nCharlie line\n` (lines join). Not fixed here; see the open question below.

### Decision and fix

The `compositionend` fallback from the Part 1 handoff. At `compositionstart` (`document` capture) `sv-selection-edit-dom.ts` records the text model when the selection is owned by `ownsSvSelectionEdit` (the composition authority already reports the start at that point, so the module does not use its composition guard here). At `compositionend` (`document` capture, before Vditor's listener re-spins) it checks the new pure predicate `restoresSvLostLineBreak(before, start, end, data, after)` in `sv-selection-edit.ts`: the text must equal the expected text (the selection replaced by the event data) with exactly the character at `start - 1` removed. Only then it puts the hidden `\n` back into the empty newline span that ends at `start - 1` (re-creating the `<br>` or the hidden span if Chromium removed them). Anything it cannot account for is left to Vditor, and a failed repair never throws. The selected text stays deleted after a cancel (decision D3). Mid-line selections, collapsed carets, line 1 and a commit take no repair.

Files: `media-src/src/editing/sv-selection-edit.ts` (predicate), `media-src/src/editing/sv-selection-edit-dom.ts` (listeners and repair), tests in `sv-selection-edit.test.ts`, `sv-selection-edit-dom.test.ts` and the (c) block of `media-src/e2e/sv-selection-enter-backspace.spec.ts`. Test support: `media-src/e2e/mouseops-harness.ts` now calls `installCompositionState()` first, as `main.ts` does (it only changes behaviour during a composition, and no other mouseops spec composes).

### RED, then GREEN

- RED, Chromium, before any product edit (the seven (c) cases): 3 failed, 4 passed. Failed: cancel over `Bravo` (received `Alpha line line\n...`), cancel after a blank line, cancel over a cross-line selection from a line start (received `Alpha linelie line\n`). Passed (controls that must stay exact): commit, update-then-commit, mid-line cancel, line 1 cancel.
- RED, Vitest: with the two composition listeners disabled, 3 DOM cases failed (the cancel repair, the repair while the composition authority is active, the cross-line repair) and the other cases passed. The pure predicate was written with its cases.
- GREEN, Chromium: the seven (c) cases pass.

### Contract cases (Chromium; expected values from the contract and decision D3)

| Case | Source after | Caret |
| --- | --- | --- |
| cancel over `Bravo` (line start) | `Alpha line\n line\nCharlie line\n` | 11 |
| commit `日本` over `Bravo` | `Alpha line\n日本 line\nCharlie line\n` | 13 |
| update `日`, commit `日本語` over `Bravo` | `Alpha line\n日本語 line\nCharlie line\n` | 14 |
| cancel over `Bravo` after a blank line | `Alpha line\n\n line\n\nCharlie line\n` | 12 |
| cancel over `Bravo line\nChar` (cross-line, line start) | `Alpha line\nlie line\n` | 11 |
| control: cancel over `ravo` (mid-line) | `Alpha line\nB line\nCharlie line\n` | 12 |
| edge: cancel over `Alpha` (line 1, not owned) | ` line\nBravo line\nCharlie line\n` | 0 |

Each case also asserts one Undo restoring the opened source exactly; the first case also asserts the posted host edit equals the source plus the SV trailing newline.

### Checks

- `npx vitest run media-src/src/editing/sv-selection-edit test/backend/module-boundaries.test.ts`: 3 files, 120 tests passed.
- `npm run typecheck`: exit 0. `npx biome check media-src/src/editing media-src/e2e`: clean. `node build.mjs`: exit 0.
- Chromium (own display, one worker): `sv-selection-enter-backspace.spec.ts` (27 cases, 7 of them (c)), `sv-line-start-edit.spec.ts` (18) and `ime-composition.spec.ts` (1): 46 passed, 0 failed. No other spec composes on the mouseops harness or imports the changed modules.
- Real VS Code was not run: no input-method session under OS-level keys, and no real-VS-Code token for this step.

### Remaining and open

- S3 (real-VS-Code spec for (a) and (b)), S4 (closure, gates, reruns).
- Open question: a collapsed caret at a line start, composition then cancel, joins the lines too (probe above, not part of this record's owned cases). The same repair would cover it with a collapsed model; it needs an Owner decision on scope.
- Unmeasured: composition in the product webview of real VS Code (no method), and Firefox (Vditor skips the `compositionend` re-spin there; the repair still runs on the DOM).

## Execution progress — 2026-10-15 (S3)

S3 (real-VS-Code verification of items (a) and (b)) is written and run. Items (c) in real VS Code, and closure (S4), are not done; acceptance boxes 2 and 3 stay open until S4 runs the gates.

### What was added

- New spec `test/vscode-e2e/sv-selection-enter-backspace.spec.ts`, one `test()`, OS-level XTEST keys (isolated display, key-binding-free window manager). Source: ORIGINAL (`Alpha line\nBravo line\nCharlie line\n`). Selections are placed by source offset with VMDE's caret authority and ended with an OS gesture; every edit key is an OS key. For every case the spec checks the host text read from the VS Code document, the dirty state, the collapsed caret's source offset in the SV surface, and that one OS Ctrl+Z restores the opened bytes exactly with a clean document.
- No product file changed. The record is the only other file touched.

| Case (selection, key) | Host text after | Caret | Proves |
| --- | --- | --- | --- |
| Enter over `ravo` | `Alpha line\nB\n line\nCharlie line\n` | 13 | (a) contract |
| Enter over `Bravo` (line start) | `Alpha line\n\n line\nCharlie line\n` | 12 | (a) contract |
| Enter over `ravo line\nChar` (cross-line) | `Alpha line\nB\nlie line\n` | 13 | (a) contract |
| control: collapsed Enter after `B` | `Alpha line\nB\nravo line\nCharlie line\n` | 13 | (a) collapsed Enter unchanged |
| Backspace over `ravo` (starts at column 1) | `Alpha line\nB line\nCharlie line\n` | 12 | (b) contract |
| Backspace over `ravo line\nChar` | `Alpha line\nBlie line\n` | 12 | (b) contract |
| control: Backspace over `avo` (column 2) | `Alpha line\nBr line\nCharlie line\n` | 13 | (b) column 2 unchanged |

The expected values come from the contract in the Part 1 handoff (the selection removed, one line break for Enter, column 0 kept for Backspace), not from the code under test. No failing run against the unfixed build was made in real VS Code (a rebuild of the old product is outside the budget); the failing results before the fix are the S1 measurements of the same cells (the unfixed build left the selected text after the new line break for Enter, and deleted column 0 for Backspace) and the S2 Chromium RED run.

### Item (c) in real VS Code

Not covered. The XTEST helper offers `key` and `type` only; the isolated display has no input-method session, so a composition cannot be driven there (S1). The Chromium cases of S2c stand.

### Open items from the earlier sections that this step does not cover

- Shift+Enter over a selection (S2 control, Owner question): not asserted here, because no contract exists yet.
- Hint list shown with a real Vditor hint, blank-line Enter, list-marker Backspace: Chromium or Vitest scope; not repeated here.

### Checks

- `node build.mjs`: exit 0.
- `npm run typecheck:vscode-e2e`: exit 0. `npx biome check test/vscode-e2e/sv-selection-enter-backspace.spec.ts`: clean after format.
- Real VS Code, one run each, `--workers=1 --retries=0`: `sv-selection-enter-backspace.spec.ts` 1 passed; `sv-line-start-edit.spec.ts` (Task 619) 4 passed; `undo-boundaries.spec.ts` 1 passed.
