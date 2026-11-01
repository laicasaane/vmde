# Task 696 — Source Rewrap Document does not apply after a direct open

**Status:** planned (2026-11-02). Filed from Task 684's measurement.
**Origin:** Task 684 (Part 2 step 1, cell `rewrap-document-sv-direct`).
**Severity:** medium (estimated; Rewrap Document in Source mode silently does nothing on a document opened directly in Source).
**Tech stack:** `media-src/src/editing/rewrap-command.ts` (`documentTarget`, the line-based caret mapping), `media-src/src/boot/main.ts` (Rewrap Document wiring), `test/vscode-e2e/exact-authority-other-actions.spec.ts` (`rewrap-document-sv` cells).
**Depends on:** Task 684 (adds the measuring cells).

## Problem

In Task 684's real-VS-Code measurement, Rewrap Document in Source mode applies after a switch from another mode but not after a direct open in Source. The direct-open cell fails before its Undo step: the host keeps the typed state, the result differs from the intended exact text, and the one Undo then removes the typed character instead of a rewrap.

Unmeasured hypothesis: after a direct open, Vditor renumbers the list and appends one line break to the Source text, so the line-based caret mapping in `documentTarget` returns no target and the command fails closed. This is the same family as Task 675's relation defect.

## Proposed work

1. Probe which gate returns no target after a direct open, with the switch case as the positive control.
2. Fix with a failing test first, keeping the Task 606/607 proof rules.
3. Re-enable the `rewrap-document-sv` direct-open cell.

## Acceptance

- [ ] The failing gate is measured and recorded.
- [ ] Rewrap Document applies after a direct open in Source, and one Undo restores the typed state.
- [ ] A Vitest case fails before the fix and passes after it.
- [ ] The `sv:` test of `exact-authority-other-actions.spec.ts` passes with the direct-open rewrap cell enabled.

## Tests to write

- A Vitest case for the caret mapping after the direct-open normalization.
