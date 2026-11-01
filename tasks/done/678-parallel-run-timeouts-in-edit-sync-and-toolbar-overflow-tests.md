# Task 678 — Parallel-run timeouts in the edit-sync and toolbar-overflow unit tests

**Status:** done (2026-11-01).
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

- [x] The six tests pass in a full parallel `media-src` Vitest run, three times in a row. (After D1 the four toolbar cases are ten slices, so twelve tests: the two edit-sync tests and ten rule slices. The target files passed three times in a row in the foreground while the `media-src` suite and the full suite ran in parallel; see Verification.)
- [x] No assertion is weakened; no global timeout changes.
- [x] The cause of each slow test is recorded in this task.

## Tests to write

- None new: this is a test-only task. The existing tests are the subject.

## Part 1 handoff (2026-11-01)

Measured on `9c0259f7` (machine with 8 cores). Scratch probes lived under `tmp/678/` (untracked): instrumented copies of both test files, run through a scratch Vitest config, timing each phase with a real clock captured before fake timers are installed.

### Findings

- **F1 — edit-sync cost (cause measured).** Alone, "admits and atomically seeds a nested sub-700 IR document after mount" takes 360–460 ms and "retries an equivalent delayed setValue mutation but cancels on genuine user input" takes 400–470 ms. The time is CPU-bound jsdom work spread over every phase: building the 585-block nested IR document and the edit sync (`boot`, 96–153 ms per document; the second test boots two documents), starting the seed (76–116 ms) and draining the seed chunks with `vi.runAllTimersAsync()` (107–131 ms). There is no dynamic import (`createEditSync` is a static import) and no real timer wait (fake timers). The 585-block nested size is the scenario under test (a sub-700 IR document admitted by its source signature), so it cannot shrink without changing what the test proves.
- **F2 — toolbar rule-slice cost (cause measured).** Alone, each of the four slices (18–19 widths, a fresh toolbar per width) takes 337–840 ms; the first slice carries a warm-up cost. Per width, `installToolbarOverflow` takes about 77–80 % of the time, `buildToolbar` 10–13 % and the layout read about 2 %. CPU-bound jsdom work again; no import and no real wait.
- **F3 — slowdown under load.** Task 665's failing run showed 5.2–8.8 s, about 12–20 times the alone durations. Two Part 1 load runs did not reproduce a timeout: the `media-src` suite with `test/backend` in parallel (load average 12; all six passed, worst 2.6 s) and the `media-src` suite with the full suite in parallel (load average 18.7; all six passed, worst 3.7 s, the first rule slice). The slowdown scales with machine load; any further load, such as other worktrees' Chromium or VS Code runs, pushes the same tests past 5000 ms.
- **F4 — fix probes under the same load.** Ten slices of 7–8 widths: 122–206 ms alone; at most 936 ms (load 12) and 1286 ms (load 18.7). Eight slices of 9–10 widths: at most 1291 ms and 1713 ms. The four-slice original in the same runs: up to 4021 ms and 3639 ms.
- **F5 — scaled-budget reproduction.** Running the six tests alone with `--testTimeout=250` (the 5000 ms budget divided by the worst observed slowdown) fails all six with `Test timed out in 250ms` on unchanged code. With `--testTimeout=400` only three of six failed, so 400 ms is too noisy for evidence.
- **F6 — separate failure, outside this task.** In load run 2 the full suite reported one unhandled `ReferenceError: window is not defined` at `media-src/src/editing/link-popover.ts:762` (`selectedOwner`, called from a `refresh` timer), attributed to `finish-init.test.ts`: a link-popover refresh timer outlives that file's jsdom environment. All tests passed; the run exited 1. Not in scope; reported for a separate follow-up.

### Decisions

- Provisional decision (2026-11-01), reversible — D1 toolbar rule slices: raise `RULE_SWEEP_SLICE_COUNT` from 4 to 10 (7–8 widths per slice) and update the Task 658 comment above it with the Task 678 measurement. The 73 widths, the fresh toolbar per width, every assertion and the guard case stay unchanged; the slice labels and therefore the test titles change (ten tests replace the four). Rejected: eight slices (worst 1713 ms under load), a timeout override (the file's Task 658 comment rejects it because it hides growth), a shared toolbar resized per width (drops the fresh toolbar per width). Evidence F2–F4. Selected by a recorded decision check (probability 0.80).
- Provisional decision (2026-11-01), reversible — D2 edit-sync tests: give the two named tests an explicit per-test timeout of 20 000 ms through a local constant `NESTED_SEED_TIMEOUT_MS = 20_000` declared directly above the first test, with a comment that states the 585-block seed cost and the measured slowdown under parallel load; the second test reuses the constant. Only those two `it` calls change, so later additions to the file do not collide. It follows the file's existing justified timeout on the Lute parity `describe`. Rejected: 60 000 ms (more margin than the evidence needs), a cached document fixture (changes the shared `boot` helper), a smaller document (changes the scenario). The Task 665 template (import once in `beforeAll`) does not apply because there is no import cost (F1). Evidence F1, F3. Selected by a recorded decision check (probability 0.65).
- Provisional decision (2026-11-01), reversible — D3 RED evidence: because the real load did not reproduce the timeout twice (F3), the RED is the scaled-budget run of F5 on unchanged code (all six fail), together with the Task 665 failing run as the real-load evidence. GREEN is the default-timeout run alone plus one parallel load run in which the target tests pass three times in a row. Selected by a recorded decision check (probability 0.96).
- No public names, numbering, compatibility rules or storage formats are involved. The only new name is the test-local constant `NESTED_SEED_TIMEOUT_MS`. No global timeout changes; no product file changes.

### Acceptance-to-test map

| Acceptance item | Proof | Layer |
| --- | --- | --- |
| 1. The six tests pass in a full parallel `media-src` run, three times in a row | `media-src/src/bridge/edit-sync.test.ts` › "admits and atomically seeds a nested sub-700 IR document after mount" and › "retries an equivalent delayed setValue mutation but cancels on genuine user input"; `media-src/src/chrome/toolbar-overflow.test.ts` › "never starts or ends a row with a rule, and never doubles one, widths $label (edge case)" (ten slices after D1, replacing the four). Run three times in a row while the `media-src` suite and the full suite run in parallel; all must pass, and the parallel `media-src` run must show no timeout in these tests. Also run once alone with the default timeout. | Vitest |
| 2. No assertion weakened; no global timeout change | Diff review: every `expect` and the slice guard case stay; `test/vitest.config.mts` is untouched; the only timeout is the per-test `NESTED_SEED_TIMEOUT_MS` on the two edit-sync tests. | review |
| 3. Cause of each slow test recorded | Findings F1–F3 above. | record |

Edge cases and their cheapest layer:

- The ten slices still cover every width from 130 to 634 in steps of 7: the existing guard case "sweeps every width from 130 to 634 in steps of 7 across the rule slices (edge case)". Vitest.
- The per-test timeout must override a CLI `--testTimeout`: the GREEN scaled-budget check (below) shows the two edit-sync tests pass with `--testTimeout=250`. Vitest.
- The first slice carries a warm-up cost; its ten-slice duration is recorded in the load run. Vitest.
- The sibling test "cancels stale ownership and atomically reseeds after an external DOM rebuild" has the same 585-block shape but did not fail; it stays unchanged (outside the six named tests) and is a residual risk.

### Step plan for Part 2 (one RED+fix step, Light)

Step S1 (RED+fix). Owned files: `media-src/src/bridge/edit-sync.test.ts` (two `it` calls near lines 732 and 803, plus the constant and comment directly above line 732), `media-src/src/chrome/toolbar-overflow.test.ts` (the comment at lines 213–219 and the constant at line 221), and this task record. No other file.

1. RED on unchanged code: `npx vitest run --config test/vitest.config.mts media-src/src/bridge/edit-sync.test.ts media-src/src/chrome/toolbar-overflow.test.ts -t "admits and atomically seeds|retries an equivalent delayed setValue|never starts or ends a row with a rule" --testTimeout=250`. Expected: exit 1, `Tests 6 failed`, `Test timed out in 250ms` (Part 1 result: exactly this).
2. Fix: apply D1 and D2. Comments follow the TypeScript commenting rules (what, why, how).
3. Checks:
   - The two files alone with the default timeout: `npx vitest run --config test/vitest.config.mts media-src/src/bridge/edit-sync.test.ts media-src/src/chrome/toolbar-overflow.test.ts`. Expected: exit 0, no failures; the ten slice titles listed.
   - The RED command again: expected the two edit-sync tests pass (their explicit timeout overrides `--testTimeout`); the toolbar slices are recorded for information only (a cold first slice may exceed 250 ms).
   - One parallel load run: start `npx vitest run --config test/vitest.config.mts media-src/src` and `npx vitest run --config test/vitest.config.mts` in the background, and run the two files three times in a row in the foreground with the default timeout. Expected: three passing runs; no timeout in these tests in the background `media-src` run. Record the load average and the slowest slice.
   - `npx biome check media-src/src/bridge/edit-sync.test.ts media-src/src/chrome/toolbar-overflow.test.ts` and `npm run typecheck`. Expected: exit 0.

## Implementation and verification (2026-11-01)

### Changes

- `media-src/src/chrome/toolbar-overflow.test.ts`: `RULE_SWEEP_SLICE_COUNT` 4 → 10 (D1); the Task 658 comment now records the Task 678 measurement. The 73 widths, the fresh toolbar per width, every assertion and the slice guard case are unchanged; ten slice titles (`widths '130-172'` … `'592-634'`) replace the four.
- `media-src/src/bridge/edit-sync.test.ts`: `NESTED_SEED_TIMEOUT_MS = 20_000` with a what/why/how comment, passed as the per-test `{ timeout }` option to the two named tests only (D2). The formatter keeps the test bodies at their old indentation, so the diff is 16 lines. No product file, helper, configuration or global timeout changed.

### Verification actually run

- RED (unchanged code): `npx vitest run --config test/vitest.config.mts media-src/src/bridge/edit-sync.test.ts media-src/src/chrome/toolbar-overflow.test.ts -t "admits and atomically seeds|retries an equivalent delayed setValue|never starts or ends a row with a rule" --testTimeout=250` — exit 1, `Tests 6 failed | 200 skipped`, `Error: Test timed out in 250ms.` (scaled budget; D3). The Task 665 load run is the real-load failure.
- Both files alone, default timeout: exit 0, `Tests 212 passed (212)`; slice durations 135–290 ms, edit-sync tests 332 and 382 ms; the slice guard case passes.
- Same filter with `--testTimeout=250` after the fix: exit 1 with 2 failed, 10 passed. The two edit-sync tests pass (the explicit timeout overrides the command-line value). The two failures are the first two rule slices at 501 and 317 ms; they carry only a 250 ms budget there and are informational (a cold first slice), not part of the acceptance.
- Parallel load run (`media-src` suite and full suite in the background; the two target files three times in the foreground, default timeout): the three foreground runs each exit 0 with `Tests 212 passed (212)`, load averages 21.4 and 24.2 at passes 2 and 3; slowest target test per pass 2564 ms (`retries…`), 1738 ms, 1482 ms. The background `media-src` run exited 0 (269 files, 5406 passed); its slowest target tests were 2021 ms (slice `130-172`), 1603 ms (`retries…`) and 1154 ms (`admits…`), none near 5000 ms.
- Lint and typecheck: `npx biome check` on the two files — exit 0; `npm run typecheck` — exit 0.
- Real VS Code: not run (test-only unit change; no webview or renderer behavior changed).

### Residuals

- **F6 (out of scope, follow-up).** The full suite still reports one unhandled `ReferenceError: window is not defined` at `media-src/src/editing/link-popover.ts:762` (a refresh timer that outlives `finish-init.test.ts`'s jsdom environment), so the full run exits 1 with all tests passing. Reproduced again in the load run above.
- **F7 (out of scope, new).** In the same load run (load average 24) the full-suite run reported `toolbar-overflow.test.ts` › "keeps Insert ID before Insert Picture in More, widths '190-100' (A3)" timing out at 5324 ms. The `media-src` run in parallel showed the neighbouring A3 slices at 1.7–4.0 s (`'285-195'` 4001 ms). These eight A3 slices (11 widths each) are the same kind of sweep and are close to the limit under heavy load; they were not among the six named tests and are unchanged. A follow-up can slice them further.
- The sibling edit-sync test "cancels stale ownership and atomically reseeds after an external DOM rebuild" has the same 585-block shape and no timeout; it did not fail in any run (1.2–1.8 s under load).

### Provisional decisions

D1, D2 and D3 in the Part 1 handoff stand unchanged (D1 selected by a recorded decision check, probability 0.80; D2 0.65; D3 0.96).
