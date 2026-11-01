# Task 687 — The link-popover refresh timer outlives the `finish-init.test.ts` jsdom environment

**Status:** planned (2026-11-01). Filed at the close of Task 678 (finding F6).
**Origin:** Task 678 (finding F6; first seen as Task 665 finding F6).
**Severity:** low (estimated; no product behavior is affected, but a full Vitest run exits 1 with every test passing, which hides real failures in CI-style runs).
**Tech stack:** `media-src/src/editing/link-popover.ts` (`selectedOwner`, the `refresh` timer), `media-src/src/boot/finish-init.test.ts`, `media-src/src/editing/link-popover.test.ts`.
**Depends on:** none.

## Problem

A full Vitest run reports one unhandled `ReferenceError: window is not defined` at `media-src/src/editing/link-popover.ts:762` (`selectedOwner`, called from a `refresh` timer). The timer fires after the jsdom environment of `finish-init.test.ts` is torn down, so `window` no longer exists. Every test passes, yet the run exits 1. Task 678 saw it in a load run and again in a later run, and left it out of its scope.

Not measured: which `finish-init.test.ts` step installs the popover, whether the timer is a debounce or a repeating timer, and whether the same leftover timer can fire in other test files.

## Proposed work

Reproduce first: run `finish-init.test.ts` alone and then the full run, and record whether the error appears in each. Then pick the smallest fix in Part 1 and record the choice and the reason:

- the popover cancels its refresh timer on dispose or teardown (preferred if the popover already has a dispose path or can get one without a new API surface), or
- the timer callback guards against a missing `window`, or
- the test disposes what it installs.

Do not change what the popover does while a document is open.

## Acceptance

- [ ] The unhandled error is reproduced and its cause (which test installs the timer, and why it is not cancelled) is recorded.
- [ ] A full Vitest run (`npx vitest run --config test/vitest.config.mts`) reports no unhandled error from this timer and does not exit 1 for that reason.
- [ ] A regression test fails before the fix and passes after it.
- [ ] The popover behavior in the open editor is unchanged (the existing `link-popover.test.ts` cases pass).

## Tests to write

- Vitest: after the popover is disposed (or the environment is torn down), advancing the timers runs no callback that reads `window`.
- No real-VS-Code case: the change touches no webview behavior in an open editor. If the fix changes the popover dispose path, run `link-popover.spec.ts` once.
