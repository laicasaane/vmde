# Task 678 — Parallel-run timeouts in the edit-sync and toolbar-overflow unit tests

**Status:** planned (2026-11-01). Filed at the close of Task 665; test-only.
**Origin:** Task 665 (finding F6).
**Severity:** low (estimated; test reliability only, no product effect).
**Tech stack:** Vitest (`media-src/src/bridge/edit-sync.test.ts`, `media-src/src/chrome/toolbar-overflow.test.ts`).
**Depends on:** none.

## Problem

Under a parallel Vitest run of the whole `media-src` suite, six tests fail with `Test timed out in 5000ms` (measured in the Task 665 parallel load run: 2 files failed, 6 tests failed, 5310 passed). The same tests pass when run alone.

- `edit-sync.test.ts` (2): "admits and atomically seeds a nested sub-700 IR document after mount" (`:732`) and "retries an equivalent delayed setValue mutation but cancels on genuine user input" (`:803`).
- `toolbar-overflow.test.ts` (4): "never starts or ends a row with a rule, and never doubles one" for the edge-case widths `130-249`, `256-382`, `389-508` and `515-634` (the table at `:263`). The logged durations are 5.4 to 8.8 s, so these tests run past the default 5000 ms limit under load.

Task 665 left these out of scope; the causes are not measured (slow setup or test body under CPU load, or a real wait inside the test).

## Proposed work

Measure where the time goes in each test under load (setup, the test body, or a real timer wait), then make the tests reliable under normal parallel load without weakening an assertion (for example by cutting the per-test work or by an explicit, justified test timeout on the heavy cases). Do not raise the global timeout.

## Acceptance

- [ ] The six tests pass in a full parallel `media-src` Vitest run, three times in a row.
- [ ] No assertion is weakened; no global timeout changes.
- [ ] The cause of each slow test is recorded in this task.

## Tests to write

- None new: this is a test-only task. The existing tests are the subject.
