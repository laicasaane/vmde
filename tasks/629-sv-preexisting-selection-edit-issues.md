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
