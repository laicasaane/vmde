# Task 683 — Blockless range restore may disagree with a live caret intent

**Status:** planned (2026-11-01). Filed at the close of Task 664; measure first.
**Origin:** Task 664 (review note and residual).
**Severity:** low (estimated; unmeasured, may not exist).
**Tech stack:** `media-src/src/editing/undo-boundaries.ts` (`keepBlocklessRange`), `media-src/src/editing/selection-writes.ts`, `media-src/src/editing/caret.ts`.
**Depends on:** none.

## Problem

`keepBlocklessRange` (`undo-boundaries.ts:288`, used at `:520` and `:546`) saves a blockless range, lets Vditor's snapshot move it, and writes the saved range back. Task 664 classified this write as transparent: it keeps the live caret intent. The residual reads: "`keepBlocklessRange` writes back its range with the intent kept; this is the unchanged earlier behaviour (pre-existing)" (`tasks/done/664-foreign-selection-retires-stale-caret-intent.md`, Residuals). The review note raised a possible mismatch: the restored blockless range could be overridden by a stale caret intent that points elsewhere, so a later caret read would follow the intent and not the range. This has not been measured.

## Proposed work

Measure first. Write a scratch probe (not committed) that arms a caret intent, leaves a blockless range, runs the undo boundary that calls `keepBlocklessRange`, and compares the live selection with the intent afterwards. If no mismatch shows in the existing undo and Headings or Link cases, close this task as not reproduced and record the probe's output. Only if a mismatch shows, mark the write as deliberate (`writeSelectionKeepingIntent` versus a retiring write) following the Task 664 rules and add a Vitest case.

## Acceptance

- [ ] The probe result is recorded (mismatch or none).
- [ ] If none: the task is closed as not reproduced with the measured output.
- [ ] If a mismatch: it is fixed without weakening the Task 664 rules, with a Vitest case for the boundary.
- [ ] If a fix changes webview behaviour: focused real-VS-Code spec written and run; quality stages pass.
