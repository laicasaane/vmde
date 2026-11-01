# Task 687 — The link-popover refresh timer outlives the `finish-init.test.ts` jsdom environment

**Status:** done (2026-11-02). Filed at the close of Task 678 (finding F6).
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

- [x] The unhandled error is reproduced and its cause (which test installs the timer, and why it is not cancelled) is recorded. The error itself did not appear in three single-file runs; the cause is proven by a fake-timer count (Part 2 S1).
- [x] A full Vitest run (`npx vitest run --config test/vitest.config.mts`) reports no unhandled error from this timer and does not exit 1 for that reason. Exit 0; 375 files passed, 9 skipped; no unhandled error (closure, 2026-11-02).
- [x] A regression test fails before the fix and passes after it.
- [x] The popover behavior in the open editor is unchanged (the existing `link-popover.test.ts` cases pass). Product source untouched; 41 of 41 pass.

## Tests to write

- Vitest: after the popover is disposed (or the environment is torn down), advancing the timers runs no callback that reads `window`.
- No real-VS-Code case: the change touches no webview behavior in an open editor. If the fix changes the popover dispose path, run `link-popover.spec.ts` once.

## Part 1 handoff (2026-11-01)

Source-only analysis. No build, Vitest, Chromium or real-VS-Code run was made in Part 1; the reproduction is the first Part 2 step.

### Problem restated

A full Vitest run reports one unhandled `ReferenceError: window is not defined` at `media-src/src/editing/link-popover.ts:762` (`selectedOwner`, reached from the `refresh` timer). Every test passes, but the run exits 1. The timer belongs to a link popover that `finish-init.test.ts` installs and one test never disposes.

### Cause hypothesis (source evidence)

1. `runFinishInit` installs the popover and registers its disposer under the `link-popover` key of the shared `observers` (`media-src/src/boot/finish-init.ts:326-338`). `installLinkPopover` is not mocked in `finish-init.test.ts`, so the real popover adds a document `selectionchange` listener (`link-popover.ts:1085`).
2. `runFinishInit` then runs `void ensureHljsLoaded(cdn).then(() => document.dispatchEvent(new Event('selectionchange')))` (`finish-init.ts:637-640`). The test mocks `ensureHljsLoaded` as `() => Promise.resolve()` (`finish-init.test.ts:128-132`). So one microtask after `runFinishInit` returns, a `selectionchange` reaches the popover.
3. `onSelectionChange` calls `schedule()`, which starts `window.setTimeout(refresh, 32)` (`link-popover.ts:795-805`). This is a 32 ms debounce, not a repeating timer.
4. The popover disposer already clears that timer (`link-popover.ts:1098`). Ten of the eleven tests in `finish-init.test.ts` call `observers.disposeAll()` synchronously, before the microtask, so their listener is gone when the event arrives. The last test, `(j) installs the toolbar flow once, before Find, ...` (`finish-init.test.ts:597-643`), never calls `observers.disposeAll()`. Its popover stays installed, receives the event and starts the 32 ms timer. That test is the last one in the file, so the file's environment is torn down right after it.
5. Why teardown does not cancel the timer: the Vitest jsdom environment sets `global.window = global` and keeps the Node `setTimeout` (it is not in the environment's copied key list), so `window.setTimeout` is a Node timer. Teardown closes the jsdom window and deletes the copied globals, including `window`. Closing the jsdom window does not cancel Node timers. When the timer fires, `refresh` calls `selectedOwner`, which reads `window.vditor` at line 762, and the read throws.
6. The failure is timing-dependent: if the 32 ms timer fires before teardown, `refresh` runs harmlessly. This explains why it appeared only in some runs (Task 678 load run 2 and one later run).

Same class as Task 658 (`render-cache-client.test.ts`) and Task 641 (`section-fold.test.ts`): both were fixed test-only by disposing what the test installs.

Other test files: `link-popover.test.ts` disposes every install in its `afterEach` (`link-popover.test.ts:43-49`), and `finish-init.ts` is the only product caller of `installLinkPopover`. No other file is expected to leave this timer. Part 2 confirms this with the full run.

### Shared interfaces and invariants

- `installLinkPopover(deps): () => void` and its disposer stay unchanged. Popover behavior while a document is open stays unchanged.
- The `Disposables` lifecycle in `finish-init.ts` stays unchanged.
- The source-proof rules of Tasks 606 and 607 (actions and handles act only on source-proven targets; no owned exact source means no snapshot and no units) are not touched and are never relaxed. The change is test-only.

### Intended solution

Test-only. In `media-src/src/boot/finish-init.test.ts`, test `(j)` calls `observers.disposeAll()` at its end, as the other ten tests do. A guard in the same file makes any future leftover timer fail the test that left it (see decision D2). No product source changes.

### Affected paths

- `media-src/src/boot/finish-init.test.ts` (only edited file).
- Read-only references: `media-src/src/editing/link-popover.ts`, `media-src/src/boot/finish-init.ts`, `media-src/src/editing/link-popover.test.ts`.
- Scratch probe files only under `tmp/687/` (not committed).

### Part 2 steps (Light: one merged RED and fix step)

1. **Reproduce and probe (first, on unchanged code).**
   - Run `npx vitest run --config test/vitest.config.mts media-src/src/boot/finish-init.test.ts` three times. Record per run: the exit code and whether the unhandled `ReferenceError` at `link-popover.ts:762` appears.
   - Run the full `npx vitest run --config test/vitest.config.mts` once. Record the exit code and the unhandled-error attribution.
   - Leftover-timer probe: copy `finish-init.test.ts` to a scratch test under `tmp/687/` (or apply the guard below temporarily in place). Add `vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })` in `beforeEach`. Add an `afterEach` that awaits two microtask turns and records `vi.getTimerCount()` with the test name, then calls `vi.useRealTimers()`. Positive control: test `(j)` reports at least 1 pending timer. Decision rule: if every other test reports 0, use the file-wide guard (D2 primary). If any other test reports a timer that is not the popover's, use the per-case form (D2 alternative) and record that timer as a finding without fixing it.
   - If the file-alone runs never show the error, the fake-timer positive control in test `(j)` is the reproduction of record. Record that the original error was not reproduced, as Task 658 did.
2. **RED.** Add the chosen guard while test `(j)` still lacks `observers.disposeAll()`. Run the file alone. Expected: test `(j)` fails on the zero-timer assertion (1 pending timer); the other ten pass.
3. **GREEN.** Add `observers.disposeAll()` at the end of test `(j)`. Run the file alone. Expected: 11 of 11 pass, no unhandled error, exit 0.
4. **Closure checks.** See below. Then update this record's acceptance list honestly.

### Edge cases

- Test `(j)` uses `vi.spyOn(observers, 'set')`. Disposing after the assertions does not change what it asserts.
- Fake timers must cover only `setTimeout` and `clearTimeout`. Do not fake `queueMicrotask` or promises: the hljs promise and the popover rebind use microtasks.
- The `beforeAll` dynamic import (60 s timeout) runs before any `beforeEach`. Faking timers in `beforeEach` does not affect the module load.
- If a later test in the file installs the popover without disposing, the guard fails that test by name instead of letting the error reach teardown.
- A product guard (`typeof window` check in `refresh`) would hide the leak. It is not added.

### Focused checks and expected outcomes

- `npx vitest run --config test/vitest.config.mts media-src/src/boot/finish-init.test.ts`: 11 passed, no unhandled error, exit 0.
- `npx vitest run --config test/vitest.config.mts media-src/src/editing/link-popover.test.ts`: all pass (product code unchanged; acceptance item 4).
- Full `npx vitest run --config test/vitest.config.mts`: no unhandled error from `link-popover.ts`; no exit 1 for that reason. Any other failure is recorded and shown to fail on unchanged `dev` before it is called pre-existing.
- Lint on the edited file, as DEVELOPMENT.md specifies. The quality umbrella follows the queue's closure-batch rule.
- No real-VS-Code spec: the popover dispose path and product source do not change, so the task's condition for running `link-popover.spec.ts` is not met.

### Tier

**Light.** One test file, test-only. The cause is located in source with file and line evidence, and the product disposer already exists. The only open point (guard form) is settled by a short probe with a stated decision rule.

### Decisions

- **D1 — Fix location. Provisional decision (2026-11-01), reversible:** test-only. Test `(j)` disposes what it installs. The product already cancels the timer on dispose, so no new API surface is needed and open-editor behavior cannot change. Alternative: a `typeof window` early return in the product `refresh` callback, alone or in addition. Probability that the alternative is needed: about 0.05. It changes product source and only hides the leak.
- **D2 — Regression test form. Provisional decision (2026-11-01), reversible:** a file-wide leftover-timer guard in `finish-init.test.ts`. `beforeEach` fakes `setTimeout`/`clearTimeout`. `afterEach` flushes microtasks, asserts `vi.getTimerCount() === 0`, then restores real timers. It is adopted only if the step 1 probe shows the other ten tests leave no timer. Alternative: a per-case check only in test `(j)` (fake timers; after the body, flush microtasks, assert at least one pending timer as positive control, dispose, assert zero). Probability that the alternative is chosen: about 0.45, decided by the step 1 probe.

### Open questions

None for the Owner. D2 is settled by the step 1 probe rule.

## Part 2 S1 (2026-11-01): probe, RED, GREEN

Single-file Vitest runs only; the full run moves to closure (acceptance item 2 stays open).

**Probe, unchanged code.**
- `npx vitest run --config test/vitest.config.mts media-src/src/boot/finish-init.test.ts`, three runs: exit 0 each, 11 of 11 passed, no unhandled error. The `window is not defined` error did not reproduce when the file runs alone, because the 32 ms timer fires before teardown. As in Task 658, the cause is proven by the timer count instead.
- Scratch copy of the file with `vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })` in `beforeEach` and a pending-timer count after two microtask turns in `afterEach` (copy removed afterwards). Result: ten tests report 0 pending timers; test `(j)` reports 2. Positive control met (at least 1).
- Decision rule applied: the other ten tests leave no timer, so the file-wide guard (D2 primary) is used.

**RED.** Added to `finish-init.test.ts`: fake `setTimeout`/`clearTimeout` in `beforeEach`; `afterEach` flushes two microtask turns, reads `vi.getTimerCount()`, clears timers, restores real timers, then asserts the count is 0. `(j)` still lacked `observers.disposeAll()`. Same command: exit 1, 1 failed | 10 passed (11), `(j)` failed with `timers left pending; dispose the observers: expected 2 to be +0`.

**GREEN.** Added `observers.disposeAll()` at the end of `(j)`. Same command: exit 0, 11 passed (11), no unhandled error.

**Other checks.**
- `npx vitest run --config test/vitest.config.mts media-src/src/editing/link-popover.test.ts`: exit 0, 41 passed (41).
- `npx biome check media-src/src/boot/finish-init.test.ts`: exit 0, no fixes applied.

**Open for closure.** The full `npx vitest run --config test/vitest.config.mts` run (acceptance item 2) and the closure gates.

## Closure (2026-11-02)

- Full `npx vitest run --config test/vitest.config.mts`: exit 0. Test files 375 passed, 9 skipped (384); tests 8209 passed, 228 skipped. No `Unhandled`, `ReferenceError` or `window is not defined` line in the output. The skipped files are the build-artifact cases that skip loudly without `node build.mjs`; they do not touch this timer.
- Product source unchanged. The fix is test-only: `(j)` disposes its observers, and a file-wide guard fails any test that leaves a timer pending.
- Review: the diff and the evidence were checked against the acceptance items; every claim was confirmed.

