# Task 665 — Test load sensitivity and fractional device pixel ratio

**Status:** open.
**Origin:** Project Owner request (follow-up of the Task 652 to 663 test runs).
**Severity:** low (test reliability).
**Tech stack:** Vitest (`media-src/src/boot/finish-init.test.ts`, `test/backend`); real-VS-Code e2e (`test/vscode-e2e/high-contrast.spec.ts`).
**Related:** [Task 659](done/659-toolbar-real-vscode-known-failures.md) (rounding-aware reference for the Emoji ring, where the Owner chose that approach).

## Problem

1. `media-src/src/boot/finish-init.test.ts` times out at 5000 ms on its first dynamic import when the machine is loaded, for example by other Vitest or Chromium runs in parallel. A follow-on `window is not defined` error appears. The test passes when run alone.
2. `test/vscode-e2e/high-contrast.spec.ts` (around line 114) asserts a literal `'3px'` outline. The assertion fails at a fractional device pixel ratio such as 1.25.
3. A `test/backend` run once had one unexplained failure that passed on rerun.

## Requirements

1. These tests are reliable under normal parallel load.
2. The high-contrast outline assertion is reliable at fractional device pixel ratios. Use a rounding-aware reference, as Task 659 did for the Emoji ring.
3. No assertion is weakened to achieve this.

## Open design points

- The cause of the first-import timeout and the `window is not defined` follow-on error.
- The cause of the unexplained `test/backend` failure, if it recurs.

## Scope

- In: reliability of the three tests named in Problem; the rounding-aware reference for the outline assertion.
- Out: product behaviour; assertions outside these tests; any assertion weakening.

## Acceptance

- [ ] `media-src/src/boot/finish-init.test.ts` passes under normal parallel load.
- [ ] The high-contrast outline assertion passes at a fractional device pixel ratio such as 1.25.
- [ ] No assertion is weakened.
- [ ] The `test/backend` failure is either explained and fixed, or recorded as not recurring.

## Tests

- To be specified in Part 1. The real-VS-Code spec is required for the outline assertion.
