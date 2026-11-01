# Task 682 — link-popover.spec.ts fails order- and load-dependently

**Status:** planned (2026-11-01). Filed at the close of Task 669; test-only.
**Origin:** Task 667 (attribution), Task 669 (step B2).
**Severity:** low (estimated; the failures are in the test run, no product defect is shown).
**Tech stack:** `test/vscode-e2e/link-popover.spec.ts`, `test/vscode-e2e/exact-authority-other-actions.spec.ts`.
**Depends on:** none.

## Problem

Two tests of `link-popover.spec.ts` fail intermittently when they run after the long `exact-authority-other-actions.spec.ts` in one real-VS-Code call (one worker, zero retries), and pass when run alone. Task 667's attribution table found the same failures on unchanged `dev`:

- `:110` (panel geometry): baseline run failed at `:192`, `expect(geometry.panel.top).toBeGreaterThanOrEqual(geometry.toolbarBottom)`, received 0, expected 61.375 (Task 667 baseline run).
- `:241` (first image click): failed at `:278` because the first recorded event was `selectionchange`, not `pointerdown` on `img` (Task 667 and Task 669 triage runs); an earlier run failed in `replaceUrl` (`:77`) with the first four typed URL characters lost (`s://changed.test/b`; a Task 667 run).

Both look like OS-level input timing or a not-yet-settled layout after the long spec. The cause is not measured.

## Proposed work

Measure what state the previous spec leaves behind (focus, window size, pending selection, panel layout not yet laid out) and make the two tests wait on an observable condition instead of timing: panel geometry measured after layout settles, typing started after the URL field has focus, the first image click after the editor is idle. Do not weaken an assertion or add fixed sleeps.

## Acceptance

- [ ] `:110` and `:241` pass in three combined runs of `exact-authority-other-actions.spec.ts link-popover.spec.ts` (one worker, zero retries), and alone.
- [ ] The measured cause is recorded; no assertion is weakened.
- [ ] Test-only: no product file changes.
