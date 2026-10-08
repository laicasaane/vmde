# Task 629 — Pre-existing SV selection and caret issues found during Task 619

**Status:** planned (2026-10-08). The Project Owner approved filing this record on 2026-10-08. Implementation has not started.
**Origin:** Task 619 Part 1 source reading. None of these has been measured.
**Severity:** medium (estimated).
**Tech stack:** webview SV mode (Vditor `sv/processKeydown`, paste and composition paths, Task 613 snapshot capture), Chromium e2e, real VS Code with XTEST.

## Problem

While reading source for [Task 619](619-sv-line-start-delete-joins-previous-line.md), several other SV selection and caret problems were suspected. All are unverified.

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

First step: measure each item in Chromium and in real VS Code before any fix. Then add a RED leg per confirmed item (Chromium e2e plus a focused real-VS-Code spec), and fix only the confirmed ones.

## Acceptance

- [ ] Each of (a) to (e) measured in Chromium and real VS Code, with the result recorded here.
- [ ] Each confirmed item has a RED test, a fix and a GREEN test; unconfirmed items are closed as not reproducible.
- [ ] Focused real-VS-Code specs written and run; `npm run quality` passes.

Related: [Task 619](619-sv-line-start-delete-joins-previous-line.md), [Task 614](done/614-sv-collapsed-cut-deletes-document.md), [Task 613](done/613-select-all-collapses-after-undo-snapshot.md).
