# Task 665 — Test load sensitivity and fractional device pixel ratio

**Status:** complete (2026-11-01).
**Origin:** Project Owner request (follow-up of the Task 652 to 663 test runs).
**Severity:** low (test reliability).
**Tech stack:** Vitest (`media-src/src/boot/finish-init.test.ts`, `test/backend`); real-VS-Code e2e (`test/vscode-e2e/high-contrast.spec.ts`).
**Related:** [Task 659](659-toolbar-real-vscode-known-failures.md) (rounding-aware reference for the Emoji ring, where the Owner chose that approach).

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

- [x] `media-src/src/boot/finish-init.test.ts` passes under normal parallel load.
- [x] The high-contrast outline assertion passes at a fractional device pixel ratio such as 1.25.
- [x] No assertion is weakened.
- [x] The `test/backend` failure is either explained and fixed, or recorded as not recurring.

## Tests

- Specified in the Part 1 handoff below (acceptance-to-test map). The real-VS-Code spec is required for the outline assertion.

## Part 1 handoff (2026-11-01)

Measured on `6649efe4` (machine with 8 cores). Scratch probes lived under `tmp/665/` (untracked).

### Findings

- **F1 — first-import timeout (cause measured).** Run alone, the first test in `finish-init.test.ts` takes about 2.3 s: its `await import('./finish-init')` (line 201) loads `finish-init.ts` and the part of its graph that is not mocked (three `importOriginal` mocks and every real module beneath them). The other ten tests take 17–37 ms because the module is then cached. The default Vitest `testTimeout` is 5000 ms. When a full Vitest run executes in parallel (load average about 20), the first test failed 3 of 3 runs with `Test timed out in 5000ms`. The cost of loading the module lands on whichever test runs first.
- **F2 — follow-on failures (cause measured).** Vitest does not cancel a timed-out test. Its import finishes later and its `runFinishInit` call runs while the next tests are running, so the next test also times out and the third one fails with `expected "vi.fn()" to be called once, but got 2 times`. The `window is not defined` error in the original report has the same cause: when the late call outlives the file, it runs after the jsdom environment has been torn down. That variant was not reproduced; it follows from the same leak.
- **F3 — a static import is not available.** About twenty `vi.mock` factories read top-level `const` mocks. A static `import { runFinishInit } from './finish-init'` fails at collection with `Cannot access 'innerVditorMock' before initialization`, because `vi.mock` is hoisted above those constants (scratch probe).
- **F4 — fix probe.** A scratch copy that imports the module once in `beforeAll(..., 60_000)` and drops the eleven per-test imports passed 3 of 3 under the same load (first test 238–710 ms). The unchanged copy failed 3 of 3 in the same runs.
- **F5 — outline width at a fractional device pixel ratio.** A plain `xvfb-run -a` launch (no Openbox, no `VMDE_XTEST`) gives a device pixel ratio of 1.25 (Task 659 S1). Under that launch the unchanged `high-contrast.spec.ts` fails (`expect(received).toBe(expected)`, received `false`). Under the standard Openbox and `VMDE_XTEST=1` launch (ratio 1) it passes. Line 114 compares `outlineWidth` with the literal `'3px'`; Chromium rounds a 3 px outline to 2.4 px at ratio 1.25 (Task 659 F4.3). The poll's single boolean does not show which conjunct failed, so Part 2 makes the poll return named fields (see the step plan).
- **F6 — `test/backend`.** No record names the earlier failing test. Two runs under load showed no `test/backend` failure: the full Vitest suite with three `finish-init` runs in parallel (372 files, 8025 passed, 228 skipped), and `test/backend` alone with the whole `media-src` suite in parallel (113 files, 2936 passed, 1 expected failure). The parallel `media-src` run had six load-related failures outside this task's scope: `edit-sync.test.ts` (2) and `toolbar-overflow.test.ts` (4 edge-case widths, including 3 timeouts).

### Decisions

- Provisional decision (2026-11-01), reversible — D1 finish-init timeout: import `./finish-init` once in a `beforeAll` hook with an explicit 60 000 ms hook timeout and bind `runFinishInit` at module level; remove the eleven per-test dynamic imports. No assertion changes. Rejected: a per-test timeout on the first test only (keeps the dependence on test order), `vi.hoisted` plus a static import (rewrites about twenty mock factories), raising the global timeout (changes every test). Evidence F1–F4. Selected by a recorded decision check (probability 1.00).
- Provisional decision (2026-11-01), reversible — D2 helper location: move `referenceOutlineWidth(frame, width)` unchanged (name, signature and comment) from `toolbar-overflow.spec.ts` into `test/vscode-e2e/webview-helpers.ts` as an export, and import it in both specs. It extends Task 659 D7 (test-local while it had one user). Rejected: a new file under `helpers/` (that folder holds keyboard and XTEST kits), a copy (jscpd duplication). Selected by a recorded decision check (probability 1.00).
- Provisional decision (2026-11-01), reversible — D3 how the outline spec runs at ratio 1.25: use the plain `xvfb-run -a` launch, which gives ratio 1.25 on this machine (Task 659 S1; F5), with no new launch arguments. Also run it under the standard Openbox launch (ratio 1). Settled by measurement; no `--force-device-scale-factor` change is needed.
- Provisional decision (2026-11-01), reversible — D4 `test/backend`: record the failure as not recurring, with the F6 runs as evidence, and change no code. No dedicated repeat run is added (the local policy allows repeats only after an intermittent failure). The closure's routine unit tier covers `test/backend` again, and any recurrence reopens the item with the failing test's name. Selected by a recorded decision check (probability 0.73). The check also noted that a further dedicated rerun would conflict with the no-repeat policy, so none is planned.
- No public names, numbering or storage formats are involved; the only shared name is the exported test helper `referenceOutlineWidth` (unchanged).

### Acceptance-to-test map

| Acceptance item | Proof | Layer |
| --- | --- | --- |
| 1. `finish-init.test.ts` passes under normal parallel load | `media-src/src/boot/finish-init.test.ts`, all 11 tests: run once alone, then three times while a full `media-src` Vitest run executes in parallel. Before the fix this load run fails 3 of 3 (F1); after it, all three runs must pass. | Vitest |
| 2. Outline assertion passes at ratio 1.25 | `test/vscode-e2e/high-contrast.spec.ts` › "live workbench flip applies the real high-contrast kind, chrome, and diagram palette", run under plain `xvfb-run -a` (ratio 1.25) and under the standard Openbox launch (ratio 1). The Task 659 test in `toolbar-overflow.spec.ts` › "Emoji picker keeps transparent fallback tiles through live light, dark, and high-contrast themes" runs once under the standard launch, because its helper moves. | real VS Code |
| 3. No assertion weakened | Diff review: every `expect` and every poll conjunct stays; the literal `'3px'` becomes `referenceOutlineWidth(frame, '3px')`, which equals `'3px'` at ratio 1. | review |
| 4. `test/backend` | Recorded as not recurring (D4, F6). | record |

Edge cases and their cheapest layer:

- A single test selected with `-t` still imports the module (the `beforeAll` hook runs for any selected test). Vitest, covered by the load run.
- The second test re-imports `../util/inner-vditor` dynamically (line 277); that module is mocked and cheap, so it stays unchanged. Vitest.
- The outline reference is created inside the webview document, so it gets the same rounding as the control. Real VS Code at ratios 1 and 1.25.
- The reference value must be read after the high-contrast flip and in the same frame. It does not depend on the theme because it uses an inline width; Part 2 reads it once, before the poll.

### Step plan for Part 2 (one RED+fix step, Light)

**Step S1 — RED and fix.** Owned files: `media-src/src/boot/finish-init.test.ts`, `test/vscode-e2e/high-contrast.spec.ts`, `test/vscode-e2e/webview-helpers.ts`, `test/vscode-e2e/toolbar-overflow.spec.ts` (helper removal and import only), and this task record.

1. RED (Vitest): start `npx vitest run --config test/vitest.config.mts media-src/src` in the background and record its PID. While it runs, run `npx vitest run --config test/vitest.config.mts media-src/src/boot/finish-init.test.ts` three times. Then wait on the PID. Expected: the first test fails with `Test timed out in 5000ms`.
2. RED (real VS Code): change the poll in `high-contrast.spec.ts` so it returns named fields instead of one boolean (the contrast length check, `cellBorder`/`contrastRgb`, `calloutBorder`, `controlOutlineWidth`, the stroke inclusion), and compare them with `toEqual`/`toMatchObject`, keeping every condition and the literal `'3px'` for now. Run `node build.mjs`, then run the spec under plain xvfb (through the run's real-VS-Code wrapper): `env -u ELECTRON_RUN_AS_NODE xvfb-run -a sh -c 'npm --prefix test/vscode-e2e test -- high-contrast.spec.ts --workers=1 --retries=0'`. Expected: fails, with the received outline width shown as `2.4px`.
3. Fix: move `referenceOutlineWidth` to `webview-helpers.ts` (export, unchanged body and comment); import it in `toolbar-overflow.spec.ts` and `high-contrast.spec.ts`. In `high-contrast.spec.ts`, read `const expectedOutline = await referenceOutlineWidth(frame, '3px')` after the high-contrast class is present, and compare the control's outline width with it, with a comment that cites the Task 659 rounding. In `finish-init.test.ts`, apply D1.
4. GREEN checks:
   - `npx vitest run --config test/vitest.config.mts media-src/src/boot/finish-init.test.ts`: expected 11 passed.
   - The load run from item 1 again: expected 3 of 3 pass.
   - `node build.mjs`, then the plain-xvfb command from item 2: expected 1 passed.
   - The standard Openbox and `VMDE_XTEST=1` command for `high-contrast.spec.ts toolbar-overflow.spec.ts -g "high-contrast"`: expected both high-contrast tests pass (the filter selects only the two high-contrast tests, so the known `toolbar-overflow.spec.ts` failures do not run).
   - `npm run lint`, `npm run typecheck`, `npm run typecheck:vscode-e2e`, `npm run jscpd`: expected exit 0 (record any finding that already exists on the base).
5. Write `tmp/665/step-S1-report.md`, update this record's progress, and leave the acceptance checkboxes for the closure step.

## Implementation and verification (2026-11-01)

Changes (tests only):

- `media-src/src/boot/finish-init.test.ts`: `./finish-init` is imported once in `beforeAll(..., 60_000)` and `runFinishInit` is a module-level binding; the eleven per-test dynamic imports are gone. No assertion changed.
- `test/vscode-e2e/webview-helpers.ts`: `referenceOutlineWidth(frame, width)` moved here unchanged (now exported) from `toolbar-overflow.spec.ts`, which imports it.
- `test/vscode-e2e/high-contrast.spec.ts`: the control's outline width is compared with `referenceOutlineWidth(frame, '3px')` instead of the literal `'3px'`. All other poll conditions and the final `expect` calls are unchanged. At device pixel ratio 1 the reference equals `3px`, so the check is no looser there; at 1.25 it equals the browser's rounded value.

Evidence:

- RED (reused from Part 1; the tree was unchanged apart from this record): `finish-init.test.ts` under a parallel full Vitest run failed 3 of 3 (`Test timed out in 5000ms`, then `called 2 times`); `high-contrast.spec.ts` under plain `xvfb-run -a` (ratio 1.25) failed (`Expected: true Received: false`) and passed under the Openbox launch (ratio 1).
- GREEN, acceptance 1: `finish-init.test.ts` alone, 11 passed; three runs while the whole `media-src` Vitest suite ran in parallel (load average 4.6–8.4, lower than the Part 1 load of about 20), 11 passed each, first test 274–801 ms; the parallel suite itself had 268 files and 5316 tests passed. The Part 1 scratch copy with the same change passed 3 of 3 at the higher load.
- GREEN, acceptance 2: `high-contrast.spec.ts` passed under plain `xvfb-run -a` (ratio 1.25) and under the Openbox and `VMDE_XTEST=1` launch (ratio 1); the Emoji picker high-contrast test in `toolbar-overflow.spec.ts` (the helper's other user) passed under the second launch.
- Acceptance 3: diff review; no `expect`, poll conjunct or timeout was removed or loosened.
- Acceptance 4 (D4): recorded as not recurring. The earlier failure was never attributed to a test. Two Part 1 runs under load had no `test/backend` failure (full suite: 372 files, 8025 passed, 228 skipped; `test/backend` alone with the `media-src` suite in parallel: 113 files, 2936 passed, 1 expected failure). Any recurrence reopens this item with the failing test's name.
- Gates: `npm run typecheck` 0; `npm run typecheck:vscode-e2e` 0; `biome check` on the four changed files 0; `npm run jscpd` 0.

Provisional decisions: D1–D4 in the Part 1 handoff stand unchanged (D1 and D2 selected by a recorded decision check, probability 1.00; D3 settled by measurement; D4 probability 0.73).
