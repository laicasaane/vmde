# Task 673 — Plain-write baseline keeps exact-action bytes

**Status:** planned (2026-11-01). Filed at the close of Task 668; waits for a future batch.
**Origin:** Task 668 (the D6 probe), Task 630 decision (5).
**Severity:** low to medium (estimated; confirmed only at unit level).
**Tech stack:** `src/writeback/writeback-controller.ts`, `src/markdown/minimal-diff-writeback.ts`, `test/vscode-e2e/exact-action-neutral-bytes-probe.spec.ts`.
**Depends on:** Task 669 (the SV table-format write must work before the live probe can measure anything).

## Problem

A plain write is minimized against the disk baseline (`cleanBaseline`, set only at open and at save). An exact action that leaves semantically neutral bytes (for example table-format padding) therefore has those bytes reverted by the next typing elsewhere in the document: the minimizer keeps the original bytes of every block whose reserialization equals the editor's output.

What Task 668 measured:

- Deterministic unit check (pinned Lute, the probe fixture): the table formatted by Lute's formatter, one character typed in another paragraph, then `minimalDiffWriteback(original, typed, reserialize)`. The result keeps the original table bytes and drops the padding.
- Nothing in `writeback-controller.ts` shields it: `exactTransactionContent` is cleared by every plain sync, and `cleanBaseline` is reset only at open and save.
- The live probe could not measure it. The probe ran once with `VMDE_PROBES=1` and its instrument was invalid (the action never changed the host text): SV `vmde.formatTable` is a no-op on the current base (`table-format.spec.ts:12` fails), which Task 669 owns, and the probe's `endSelectionGesture` presses Shift, whose keydown clears the retained SV selection the command needs.

## Proposed work

1. After Task 669 repairs the SV table-format write, fix the probe instrument (no Shift key press before the command; keep the selection by other means) and run it once. Record the live result.
2. If the revert is confirmed live, decide how the plain-write baseline should treat bytes written by an exact action (for example advancing the baseline after an applied exact write, keeping the undo-to-clean behaviour of Tasks 61 and 434), then fix it with unit tests and a real-VS-Code spec.
3. If it is not confirmed live, record why the unit-level mechanism does not occur in the editor and close.

## Acceptance

- The live probe result is recorded with a valid instrument.
- Typing after an exact action never reverts that action's neutral bytes, or the record states why it cannot.
- Undo back to the saved state still makes the tab clean.
- [ ] Focused real-VS-Code spec written and run; the quality stages pass.
