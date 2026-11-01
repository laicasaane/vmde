# Task 679 — Details stale-host case may run on a resynced editor

**Status:** planned (2026-11-01). Filed at the close of Task 666; test-only.
**Origin:** Task 666 (Part 1 amendment and residuals), Task 630.
**Severity:** low (estimated; the refusal may be vacuous, no product defect is known).
**Tech stack:** `test/vscode-e2e/exact-authority-other-actions.spec.ts` (`STALE_DRIVERS`, `staleHostCell`).
**Depends on:** none.

## Problem

The stale-host test arms an outside edit and then triggers an action; the expected result for a stale editor is a refusal. Task 666 found that the editor can resync with the outside edit before the click, which makes a refusal check vacuous. It added a staleness probe for the bubble Link driver only: `probeStale: true` at `exact-authority-other-actions.spec.ts:836`, the `evalFrame` read of `window.vditor.getValue()` at `:828-832`, and the classification at `:897-905` (stale: `after === external`; resynced: only the action span may change). In IR and WYSIWYG the probe reported `webviewStale: false`, so the editor had resynced.

The Task 630 Details driver (`stale-host-details`, `:818-824`) has no probe. Its selection is lost when the editor re-renders, so its refusal may be vacuous for the same reason (Task 666 residual, "pre-existing test, not changed").

## Proposed work

Add a `probeStale` read to the Details driver, taken right before the Details click and reading whether the editor already shows the outside edit, and record `webviewStale` and the outcome in the result. Assert as for the bubble driver: a stale editor must refuse; a resynced one may change only its own span. If the editor is always resynced, record that the case proves "outside edit kept, only the span changed" and name the Vitest guard that proves the refusal.

## Acceptance

- [ ] The Details stale case reports `webviewStale` in both modes, and its assertion follows the measured value.
- [ ] A vacuous refusal can no longer pass unnoticed (the probe must run, as for the bubble case).
- [ ] Test-only: no product file changes; the spec runs in real VS Code with one worker and zero retries.
