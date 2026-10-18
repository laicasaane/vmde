# Task 658 — Remove leftover timers and slow cases from unit tests

**Status:** done.
**Origin:** Project Owner request (known issue from Tasks 641 and 642).
**Severity:** low (test reliability).
**Tech stack:** Vitest unit tests in `media-src/src` (webview helpers).
**Related:** [Task 641](641-open-to-ready-one-second.md) (open to ready in one second), [Task 642](642-toolbar-layout-follow-ups.md) (toolbar layout follow-ups).

## Problem

Batch gate runs of Tasks 641 and 642 showed three intermittent unit test problems:

1. An unhandled `ReferenceError: window is not defined` at `media-src/src/diagrams/render-cache-client.ts:731`, raised by a timer in `render-cache-client.test.ts` after teardown.
2. The case "never starts or ends a row with a rule, and never doubles one" in `media-src/src/chrome/toolbar-overflow.test.ts` took about 6 s under load and hit the 5 s timeout twice. It passes when run alone.
3. A timing assertion in `markmap-security.test.ts` failed once.

## Requirements

1. `npm run test:coverage` exits 0 reliably under normal parallel load.
2. Leftover timers are cleared or awaited so that no timer fires after teardown.
3. Slow cases are made fast or bounded without weakening their assertions.

## Open design points

- To be settled in Part 1.

## Scope

- In: the three problems above, in the named test files and the named source line.
- Out: changes to assertions that reduce what the tests prove.

## Acceptance

- [x] `npm run test:coverage` exits 0 across repeated runs under normal parallel load. (three runs on the closure build, each exit 0)
- [x] No unhandled `ReferenceError` from a timer appears after `render-cache-client.test.ts` teardown.
- [x] The toolbar-overflow case no longer approaches the 5 s timeout under load.
- [x] The `markmap-security.test.ts` timing assertion passes reliably, with its assertion unchanged in strength.

## Tests

- Unit tests in the named files (Vitest). Exact commands are to be specified in Part 1.

## Part 1 handoff (2026-10-18)

Task 658 — Remove leftover timers and slow cases from unit tests. Classification Light,  read-only. branch `dev`, HEAD `1985ceb2`. Nothing in the repository was edited, built or run. Measurements below come from scratch Node probes in `a scratch folder outside the repository (idle machine, 8 cores). No vitest run was done, so no test-duration figure for the toolbar case is claimed.

### Verified facts

Problem 1 — `window is not defined` from `render-cache-client.ts:731`

1. `media-src/src/diagrams/render-cache-client.ts:635-641`: `sendRequest` arms `window.setTimeout(..., 2000)`, the host-reply fallback. The timer calls `resolveRequest`, whose first lines are `pending.get`, `pending.delete`, then `window.clearTimeout(entry.timer)` at line 731. `pending` is module state (`:554`), so entries and timers outlive each test case.
2. A timer is armed only when a request has at least one reserved block (`reserveAndRequest` returns before `sendRequest` when `blocks` is empty, `:612`; `rethemeCacheFirst` likewise, `:704-708`). Nearly every case in `media-src/src/diagrams/render-cache-client.test.ts` that calls `installRenderCache` with a block (about 35 call sites, lines 188-1079) passes a `post` that never replies, so the 2000 ms timer is never cleared.
3. The test file has no timer cleanup. It has exactly one `afterEach` (`:894`, `vi.unstubAllGlobals()`, only in the `reportRenders` describe). Most cases drop the disposer returned by `installRenderCache` (only `:920` keeps it).
4. Why the callback sees no `window`. The file runs in jsdom (`// @vitest-environment jsdom`, `:1`). Vitest 4.1.11 builds that environment in `node_modules/vitest/dist/chunks/index.DC7d2Pf8.js`: `populateGlobal` sets `global.window = global` (`:274`) and the teardown (`:532-535`) calls `dom.window.close()` and then deletes every populated key, `window` included. Its key lists (`:1-232`) contain `requestAnimationFrame` and `cancelAnimationFrame` but no `setTimeout`, `clearTimeout` or `setInterval` (grep over those lines found no `Timeout`/`Interval`). So `window.setTimeout` is Node's own `setTimeout`. `dom.window.close()` therefore does not cancel it, whereas it does cancel jsdom's `requestAnimationFrame` frames. A 2000 ms timer still pending at teardown fires on the bare Node global, `window` is gone, and `resolveRequest` throws `ReferenceError: window is not defined` at line 731 (`window.clearTimeout`; the callback at `:635-641` reaches it after `logToHost`, which was not read further). Vitest reports it as an unhandled error and `npm run test:coverage` exits 1. The same mechanism is the documented cause of the Task 641 error (`requestAnimationFrame is not defined` from a leftover glyph timer) that `0d491d40` repaired.
5. Intermittency follows from the timing: the error needs a timer armed within the last 2000 ms of the file and the worker still alive when it expires, so it appears when teardown or reporting is slow (load). It was not reproduced here (hypothesis consistent with items 1-4; no run done).
6. Second effect of the same leak: in a file that runs longer than 2 s, the fallback timers of early cases fire mid-file, call `resolveRequest` on stale blocks (`logToHost`, `cacheResolveStats.timeout++`, `document.createComment('vmde-cache-miss')` appended, `renderNativeJobs`/`plantumlRender` called) while later cases run. That can disturb `renderNativeJobs` call assertions (`:247`, `:352-353` clear the mock per case, so a stray call lands in a later case).
7. Only this test file leaks. The other files that import `render-cache-client` all `vi.mock` it (`diagram-retheme.test.ts:64`, `diagram-runtime-order.test.ts:17`, `message-router.test.ts:91`, `finish-init.test.ts:140`, `vditor-init.test.ts:79`; `diagram-config-delta.test.ts` imports only non-timer helpers, not verified further).
8. The source is not defective in production: the webview always has `window`. The disposer returned by `installRenderCache` (returned at the end of `installRenderCache`, `:~896-901`) deliberately does not settle pending requests, because the 2000 ms timer is what unblocks reserved blocks after a re-init. Making the disposer clear pending timers would change that guarantee, so the fix is test-only.
9. Precedent `0d491d40` (`test(641): dispose fold controllers after each case`): wraps the factory (`createSectionFoldController`) so every created controller is pushed to a list and disposed in `afterEach`. It touched only `media-src/src/nav/section-fold.test.ts`.

Problem 2 — `toolbar-overflow.test.ts` case "never starts or ends a row with a rule, and never doubles one (edge case)"

10. `media-src/src/chrome/toolbar-overflow.test.ts:208-227`: `for (let width = 130; width <= 640; width += 7)` runs 73 widths (130, 137, ..., 634). Each iteration builds a fresh toolbar (`buildToolbar`, `:33-164`: about 25 elements, three `vi.stubGlobal` calls, `ensureToolbarRows`), calls `installToolbarOverflow` (`toolbar-overflow.ts:495-627`), reads `layout()`, runs the rule and `expectEveryControlOnce` assertions, then disposes and removes the host. Default vitest `testTimeout` is 5000 ms (no override in `test/vitest.config.mts`, which sets `environment: 'node'`, no `pool`/`testTimeout`, per-file `// @vitest-environment jsdom`). Default pool in 4.1.11 is forks, parallel files.
11. Work per iteration is dominated by jsdom style resolution (not measured): `installToolbarOverflow` runs `controller.apply()` once synchronously (`toolbar-overflow.ts:522-523`) and `schedule()` runs it again because the test stubs `requestAnimationFrame` to call back synchronously (`toolbar-overflow.test.ts:140-143`). Each pass calls `getComputedStyle` on the toolbar (`:266`, `:302`), on every flow item (`:276`) and, on the first pass, on a divider (`:287`). `applyToolbarTips` also runs per iteration (`:513`). The case also issues several `expect` calls with a message per token. Which of these dominates is unverified; Part 2 S2 measures it first.
12. The recorded symptom is about 6 s under load (Task 642 record line 424; Task 658 record) while it passes alone, so it runs close to the 5 s limit even without load plus v8 coverage instrumentation (`npm run test:coverage` runs `vitest run --coverage`, `package.json:1743`).
13. Existing helper: `buildToolbar(...).resize(width)` sets the container width and calls the captured `ResizeObserver` callback (`:151-154`). It is used by other cases (`:262`). Reusing one toolbar across widths would change what the case proves (incremental versus fresh layout at each width), so it is rejected below.

Problem 3 — `test/backend/markmap-security.test.ts` timing assertion

14. The file is under `test/backend/` (Node environment), not `media-src/src`. `:68-77`: the case "keeps long mailto linkification bounded" calls `measureEmailLocalPart(4_000)` and `measureEmailLocalPart(8_000)`. Each call (`:35-45`) spawns a fresh Node child (`spawnSync`, boots JSDOM and `media-src/vendor/markmap/markmap.min.js`), warms one transform, then times ONE `transform` of `mailto:` + N `a` + `@example.invalid` and returns `elapsed` measured inside the child. Assertions: `eightThousand < 1_000` and `eightThousand / Math.max(fourThousand, 0.1) < 3.5`. Timeouts were already raised for CI by `896063a2` (30 s child, 90 s test).
15. Measured (scratch probe `probe.cjs`, idle, same bundle, same input, 7 transforms per size in one child):

| size | samples in ms |
|---|---|
| 4000, run 1 | 4.76, 1.22, 1.04, 1.01, 0.92, 0.79, 0.71 |
| 8000, run 1 | 1.02, 1.07, 1.04, 0.74, 0.71, 0.51, 1.18 |
| 32000, run 1 | 1.12, 0.96, 0.9, 0.95, 0.91, 1.1, 0.97 |
| 4000, run 3 | 8.06, 2.21, 0.81, 4.28, 1.34, 0.79, 0.51 |
| 8000, run 3 | 5.06, 1.43, 1.01, 3.38, 0.7, 0.63, 0.88 |

   The bounded transform costs about 0.5-1.2 ms at every size, and the first (cold) sample costs 4-8 ms with random 2-7 ms spikes even on an idle machine. The test takes exactly that first cold sample from two separate children. Ratio = (cold or spiked 8000 sample) / (warm 4000 sample) can exceed 3.5 with no regression in the code, e.g. 5 ms / 1 ms. Under load the spikes are larger. This is the cause of the single recorded failure ("failed once on a timing assertion", Task 641 record line 392). The absolute ceiling (1000 ms) has about three orders of magnitude of margin and is not the failure source.
16. Interleaved best-of-N in one child (scratch `probe2.cjs`, 12 children each, 10 busy-loop processes running in parallel on 8 cores): single cold sample ratio maximum 1.36, best-of-15 ratio maximum 1.59, zero values at or above 3.5 for either. This does not reproduce the original separate-children one-shot form (that load run did not complete: the first attempt was cut off by the tool and a retry was refused by the sandbox), so the failure rate of the current form under load remains an inference from item 15, not a measurement.
17. Residual finding about test strength, outside this task: both pre-fix vendored bundles (`git show dfbd952a:media-src/vendor/markmap/markmap.min.js` and `474c7f28^:...`) contain the vulnerable `src_email_name` string that `:62-66` forbids, yet with this input they ran as fast as the fixed bundle (4000: 7.95, 1.29, 4.94 ms; 8000: 1.2, 0.92, 5.75 ms, 3 samples, idle). So the timing case as written has no demonstrated RED against the vulnerable bundle; the string assertion at `:62` is the real guard. This is recorded, not changed here ("assertion unchanged in strength").

Other

18. `block-transform-non-round-trip.test.ts` also hit the 5 s limit in the Task 641 batch runs (Task 641 record line 392; README line 106). It is not named in Task 658, and no filed task (657, 659-663 checked) covers it.
19. `.agents/rules/ts.md` apply to `media-src/**/*.ts`: every workaround needs a what/why/how comment. The two test files in `media-src/src` need that comment; `test/backend` follows the file's existing comment style.
20. DEVELOPMENT.md (`:322-345`) documents `npm test`, `npm run test:coverage` and config `test/vitest.config.mts`. `npm run quality` runs `test:coverage` and `check:coverage-modules` (`scripts/quality.mjs:28-31`).

### Decisions

D1. All three fixes are test-only. No product file changes (item 8 explains why the source stays).
D2. Problem 1 fix, in `media-src/src/diagrams/render-cache-client.test.ts` only:
   - Track every timer of 1000 ms or more armed during a case and clear it in a file-level `afterEach`. Mechanism: a file-level `beforeEach` installs `vi.spyOn(globalThis, 'setTimeout')` whose implementation calls the original and records the returned handle when `delay >= 1000`; a file-level `afterEach` clears each recorded handle with `clearTimeout`, empties the set and calls `mockRestore()` on that spy only (not `vi.restoreAllMocks()`, which would reset the `renderNativeJobs`/`plantumlRender` mocks' state).
   - Also wrap `installRenderCache` the way `0d491d40` wraps its factory: keep the disposer in a list and call all of them in the same `afterEach`. This removes the `document` `HOIST_SCOPE_CHANGE_EVENT` listener (`render-cache-client.ts:871`), the `MutationObserver` and the rAF each case adds; today they accumulate across cases.
   - Rejected: fake timers for the file (several cases `await flush()` on a real `setTimeout`, `:433`, `:884`, and the rAF stub at `:889-892` also uses `setTimeout(…, 0)`); making the disposer settle `pending` (changes the unblock guarantee, item 8); replacing `window.setTimeout` with bare `setTimeout` in the source (does not prevent the failure: the callback also uses `document`/`logToHost` after teardown); a `vitest` `dangerouslyIgnoreUnhandledErrors` setting (hides real failures).
   - The 1000 ms threshold is a named constant with a comment saying it covers the 2000 ms fallback (`render-cache-client.ts:641`) and nothing shorter, so the file's own short `setTimeout` waits stay untouched.
D3. Problem 2 fix, in `media-src/src/chrome/toolbar-overflow.test.ts` only: keep the same 73 widths, the same fresh toolbar per width and the same assertions, but split the sweep into four contiguous width ranges, each its own `it`, so each case has a fresh 5 s budget and about a quarter of the work. Implementation shape: a `RULE_SWEEP_WIDTHS` array (`Array.from({ length: 73 }, (_, i) => 130 + 7 * i)`, same set as the loop, last value 634), a helper `expectRuleDiscipline(width)` holding the body of the current iteration, and `describe.each`/`it.each` over four slices of the array (19, 18, 18, 18 widths) labelled with their first and last width. A small guard case (or a `describe`-level assertion) states that the slices concatenate back to `RULE_SWEEP_WIDTHS`, so no width is lost. No timeout override and no `resize` reuse. The slice count is a starting value: S2 keeps it only if the measured worst slice stays at or below 1.5 s under coverage; otherwise it splits further.
   - Rejected: reusing one toolbar and calling `resize(width)` per width (changes the property under test: fresh layout versus layout reached incrementally); widening the step from 7 to a larger value (drops coverage between breakpoints); a per-case `{ timeout: 20_000 }` as the primary fix (hides growth; allowed only as a fallback, with a comment, if S2 shows a single width alone is slow); changing `toolbar-overflow.ts` (no product defect shown).
D4. Problem 3 fix, in `test/backend/markmap-security.test.ts` only: one child process instead of two, which measures both sizes interleaved for N rounds after the warm-up and returns the minimum elapsed time per size; the test keeps both assertions with the same numbers (`eightThousand < 1_000`, `eightThousand / Math.max(fourThousand, 0.1) < 3.5`) applied to those minima. Constants: `SAMPLE_ROUNDS = 15`. A comment states why: a one-shot, cold, millisecond-scale sample is dominated by JIT warm-up and scheduler noise (item 15), while a genuine super-linear regression slows every sample of the larger size and so still raises its minimum. The child keeps the existing `PROBE_PROCESS_TIMEOUT_MS` and the test keeps `PROBE_TEST_TIMEOUT_MS`. The `measureEmailLocalPart` helper becomes `measureEmailLocalParts(sizes)` returning a record; the two `expect(result.error…)`/`expect(result.status…)` lines stay.
   - Rejected: loosening 3.5 or 1000 (weakens the assertion); adding retries (hides the noise); raising the sizes (the fixed bundle does not scale with size, items 15-16, so larger inputs add cost without signal).
D5. No real-VS-Code spec and no Chromium spec: nothing in the webview or renderer behaviour changes. The AGENTS.md rule that requires a real-VS-Code spec covers webview or renderer behaviour; this task changes only unit-test hygiene, so proportionate validation is the focused Vitest files plus the coverage gate.
D6. Evidence form for "repeated runs": three consecutive `npm run test:coverage` runs at closure (acceptance 1), not a repeat harness in CI. Memory rules: only tests that prove acceptance items, no family reruns.

### State / DOM / messages

None. No product state, DOM, protocol message or setting changes.

### Part 2 steps

Run order: S1, S2, S3 are independent and touch disjoint files; they may run in parallel (one  each, as routed) because none needs the real VS Code token. S4 is the main thread.

All commands run from the repository root. Vitest unit commands need no `xvfb-run` and no `node build.mjs` for these three files (they import source directly; the markmap test reads the vendored bundle that is checked in). Do not leave probe code in the files.

**S1 — `media-src/src/diagrams/render-cache-client.test.ts` (owned file; nothing else)**

1. RED measurement before editing: add a temporary `afterAll` that logs how many 2000 ms timers are still pending, using a temporary copy of the tracking spy from D2 without the clearing step (count handles armed with `delay >= 1000` that have not fired or been cleared), run the file once, record the number (expected greater than 0). Then remove the temporary code.
2. Implement D2: `FALLBACK_TIMER_MIN_MS = 1000` constant with a what/why/how comment; `armedFallbackTimers` set; `beforeEach` spy; `installRenderCache` wrapper recording disposers; one file-level `afterEach` that disposes, clears timers, empties both collections and restores the spy. Keep the existing `:894` `afterEach` as is. Verify hook order: inner `afterEach` (unstub) runs before the file-level one; disposing after the `requestAnimationFrame` stub is removed must not throw (`cancelAnimationFrame` receives a Node timer handle in the `reportRenders` describe; if jsdom's `cancelAnimationFrame` throws on it, guard by disposing in that describe's own `afterEach` before `unstubAllGlobals`).
3. Checks, in this order:
   - `npx vitest run --config test/vitest.config.mts media-src/src/diagrams/render-cache-client.test.ts` passes, no "Unhandled" text in the output.
   - Temporary log of the number of handles cleared in `afterEach` summed over the file (expected the same count as step 1 plus any other long timers), then remove it.
   - Same command with `--coverage` once (`npx vitest run --coverage --config test/vitest.config.mts media-src/src/diagrams/render-cache-client.test.ts`), no "Unhandled" text.
   - Optional, best-effort: shorten the `2000` at `render-cache-client.ts:641` to a small value only in a temporary local edit, run the file against the pre-fix test (git stash is not allowed; use the RED run order of step 1) to see whether the unhandled error appears, then restore the edit by hand and confirm `git diff -- media-src/src/diagrams/render-cache-client.ts` is empty. Skip and say so if it does not reproduce.
   - `npx biome check media-src/src/diagrams/render-cache-client.test.ts` (or the repository lint script named in `package.json`) clean.

**S2 — `media-src/src/chrome/toolbar-overflow.test.ts` (owned file; nothing else)**

1. RED measurement before editing: `npx vitest run --config test/vitest.config.mts media-src/src/chrome/toolbar-overflow.test.ts --reporter=json --outputFile=a scratch folder outside the repository, once without and once with `--coverage`; record the duration of the "never starts or ends a row with a rule" case from the JSON (`testResults[].assertionResults[].duration`). If idle duration is already above 2 s, set the slice count so the worst slice is at most 1.5 s under coverage (compute `ceil(coverageDuration / 1.5)`, capped at 8).
2. Implement D3: `RULE_SWEEP_WIDTHS`, `expectRuleDiscipline(width)`, sliced cases with width-range labels, the concatenation guard. Keep the assertion messages (`width ${width}`) and `expectEveryControlOnce`.
3. Checks:
   - Same JSON command after the change, with and without `--coverage`: every slice case passes and the worst slice duration is at most 1.5 s under coverage (report the numbers).
   - Full file run passes (all existing cases unchanged).
   - To show the sweep still detects a defect: an optional one-time local mutation, never committed. Disable the rule-trimming in `toolbar-overflow.ts` (find it by reading `createFlowController`/`arrange`), run the file, expect at least one slice case to fail with a `width N` message, then revert the same edit by hand and confirm `git diff -- media-src/src/chrome/toolbar-overflow.ts` is empty. If a clean mutation is not found quickly, omit it and say it was not run.
   - Lint clean on the file.

**S3 — `test/backend/markmap-security.test.ts` (owned file; nothing else)**

1. Implement D4 (single child, interleaved rounds, minimum per size, same assertions and constants, comment explaining the sampling).
2. Checks:
   - `npx vitest run --config test/vitest.config.mts test/backend/markmap-security.test.ts` passes; record the test duration (expected lower than before because one child boots instead of two).
   - Run the same file 5 times in a row locally with one shell loop (a local check, not a CI repeat); all pass. 
   - Optional strength check, never committed: temporarily make the child's timed region quadratic in `count` (for example a nested loop doing `count * count / 1000` trivial operations) and confirm the ratio assertion fails (a quadratic cost gives a ratio near 4, above 3.5). Restore the file by hand afterwards and confirm only the intended diff remains. If it cannot be made to fail quickly, record that and rely on "assertions unchanged".
   - Lint clean on the file.

**S4 — closure (main thread)**

1. Update `tasks/658-unit-test-leftover-timers.md`: settle "Open design points" with D1-D6, check the acceptance items with the evidence below, list changed files. Update `tasks/README.md` only when the task is fully complete. Update the `LOCAL_AGENT_TASK.md` §1 table row 24 and §7.24.4 Progress in the same edit as the task record change.
2. Gates once for the batch: `npm run test:coverage` three times in a row, all exit 0, each with no "Unhandled error" text; then `npm run check:coverage-modules` once; `npm run quality` once at task end (implementation work per AGENTS.md; it includes lint, knip, jscpd, dependency-cruiser, coverage).
3. Inspect `git diff --stat`: only the three test files plus the task record and tracker.

### Tests mapped to the record's Acceptance items

| Acceptance item | Cheapest layer | Proof |
|---|---|---|
| 1. `npm run test:coverage` exits 0 across repeated runs | Vitest, full unit suite | S4 step 2: three consecutive runs, exit 0, no "Unhandled" text. Depends on Owner question 1 if `block-transform-non-round-trip.test.ts` fails in those runs. |
| 2. No unhandled `ReferenceError` after `render-cache-client.test.ts` teardown | Vitest (the file itself) | S1: temporary pending-timer count before (greater than 0) and cleared-count after, file run plain and with `--coverage`, output free of "Unhandled". Edge cases covered by the wrapper: cases that dispose themselves (`:920`), the `reportRenders` describe with a stubbed `requestAnimationFrame`, cases that never reply, cases whose rethemeCacheFirst request is pending. |
| 3. Toolbar case no longer approaches 5 s | Vitest | S2: per-slice durations from JSON reporter, worst slice at most 1.5 s with `--coverage`; concatenation guard keeps all 73 widths; mutation check shows the sweep still fails on a rule at a row edge. |
| 4. `markmap-security.test.ts` timing assertion reliable, strength unchanged | Vitest (Node) | S3: same numeric assertions; 5 local back-to-back runs pass; lower duration (one child); sampling comment. |

Real-VS-Code and Chromium layers: not applicable (D5).

### Owner questions

1. Scope: `block-transform-non-round-trip.test.ts` also times out at 5 s in batch runs (Task 641 record line 392) and no filed task covers it, yet acceptance item 1 needs `npm run test:coverage` to exit 0 reliably.
   - Option A (recommended): do not touch it now; if any of the three closure runs fails on it, file a separate known-issue task with the failing run evidence and record acceptance item 1 as blocked on it.
   - Option B: add it to Task 658 as step S5 (same slicing or a justified per-case timeout), after measuring it with the S2 method.
   - Option C: leave it unrecorded (not recommended: acceptance 1 could then fail without an owner).

### Residual risks

- Items 4-6 (why the `window` error is intermittent) are inferred from source and Vitest's environment code; the error was not reproduced. S1 step 1 and its best-effort timer-shortening attempt reduce this, but a clean repeat is statistical, not a proof.
- Item 11: the cost split of the toolbar case (style resolution versus builds versus assertions) is a hypothesis. The slicing fix does not depend on it, but the chosen slice count does (S2 step 1 decides it from a measurement).
- The `vi.spyOn(globalThis, 'setTimeout')` approach assumes `window === globalThis` and Node's `setTimeout` in Vitest 4.1.11 jsdom (verified in the environment source, item 4). A Vitest upgrade that changes `populateGlobal` could make the spy miss the timer; the S1 measurement would show a nonzero pending count then.
- Sampling change in D4 reduces noise in the measured time, not its relevance: item 17 shows the timing case does not discriminate the vulnerable bundles with this input, so it protects little regardless of the fix. The string assertion at `:62` carries the security guard. Strengthening that input is a separate decision, outside "assertion unchanged in strength".
- Under heavy load a best-of-15 minimum could still exceed noise for the ratio, with probability not measured in the original form (see item 16 note). If a failure ever recurs, widen the rounds before touching 3.5.
- A four-way split lowers the risk of the 5 s limit but a very loaded machine plus coverage could still approach it; S2 sets the worst-slice limit at 1.5 s so there is about 3x headroom.
- Other long unit cases (for example `block-transform-non-round-trip.test.ts`) are outside this task (Owner question 1).

## Open questions / blockers

- Owner question 1 above (the `block-transform-non-round-trip.test.ts` 5 s timeout: scope).
- No blocker for Part 2 S1-S3.
- Not verified: no vitest run was done in Part 1, so the toolbar case duration and the failure rate of the original markmap form under load are unmeasured; the busy-loop load probe was cut off and a retry was refused by a sandbox check on a `sh -c` loop, so the load numbers in item 16 are for the interleaved form only.

**Owner answer (2026-10-18, chat):** Q1 option B — include `block-transform-non-round-trip.test.ts` as an extra step (measure first with the S2 method, then fix).

## Execution progress — 2026-10-18 (Part 2)

Test-only changes in four files; no product file changed. Not committed yet. Closure gates (acceptance item 1 tick, `check:coverage-modules`, `npm run quality`, tracker and README updates) are left to closure.

- S1 `media-src/src/diagrams/render-cache-client.test.ts`: file-level spy records every timer of 1000 ms or more, an `installRenderCache` wrapper records disposers, and one `afterEach` disposes and clears them. Before: 24 long timers armed in the file (temporary counter, removed). After: file passes plain and with coverage, no "Unhandled" text. The intermittent `window is not defined` failure was not reproduced, including with the source timer shortened temporarily (reverted, source diff empty). Proves acceptance item 2 by removing the cause; the failure itself is statistical.
- S2 `media-src/src/chrome/toolbar-overflow.test.ts`: the 73-width sweep is split into four contiguous slices (same widths, fresh toolbar per width, same assertions) plus a guard case that the slices concatenate to the full width list. Before: the single case took 1.43 s plain and 3.0 s with coverage. After: worst slice 0.46 s plain and 1.12 s with coverage. Mutation check (temporary change that lets a row start with a rule): three slice cases failed with a `width N` message; mutation reverted, product diff empty. Proves acceptance item 3.
- S3 `test/backend/markmap-security.test.ts`: one child process measures both sizes interleaved for 15 rounds and reports the minimum per size; assertions and numbers unchanged. Test duration 1.31 s to 0.72 s for the file. Five back-to-back runs passed. Mutation check (temporary quadratic cost in the timed region): the ratio assertion failed (3.84 against 3.5); mutation reverted. Proves acceptance item 4 (original one-shot form was not reproduced failing; evidence is the noise measurements in the Part 1 handoff).
- S5 (Owner answer, Q1 option B) `media-src/src/editing/block-transform-non-round-trip.test.ts`: measured first. Every heavy case already carries a 60 s timeout; the only default-timeout heavy case was "P0 fixes the fixture, normalization and exact-source paragraph oracles" (0.84 s plain, 1.95 s with coverage). It is now a fixture case plus one case per mode with identical assertions; worst new case 0.50 s plain, 1.42 s with coverage.
- Checks: `npm run typecheck` and `npx tsc --noEmit -p ./` exit 0; biome clean on the four files; `npm run test:coverage` run three times in a row, each exit 0 with no "Unhandled" text (344 files passed, 6928 tests passed, 219 skipped each time).

## Closure — 2026-10-18 (batch 3)

Gate run on HEAD `dbb3c104` (one run serves batches 3 and 4).

| Command | Exit | Result |
| --- | --- | --- |
| `node build.mjs` | 0 | built |
| `npm run lint:ci` | 0 | 1,226 files checked, no fixes |
| `npm run typecheck` | 0 | clean |
| `npx tsc --noEmit -p ./` | 0 | clean |
| `npm run knip` | 0 | clean |
| `npm run jscpd` | 0 | clean |
| `npm run depcruise` (host and webview) | 0 | clean |
| `npm run test:coverage` (gate run, then two more) | 0, 0, 0 | 358 files, 7,256 passed, 1 expected fail, in each of the three runs; no timeout, no unhandled error; statements 80.19%, branches 73.59%, functions 83.51%, lines 82.44% (gate run) |
| `npm run check:coverage-modules` | 0 | ratchet OK, 10 modules at 0% (baseline 10), no prune notice |
| `npm run check:brand-identifiers` | 0 | clean |
| `npm run check:bundle-size` | 1 | reporting only: `media/dist/main.js` 1,037,005 B (1,013 KB) against the 608 KB budget (inherited miss); lazy bundles within budget |
| `npm run check:startup-cost` | 1 | reporting only: 384 eager modules against 294 (inherited miss); largest module 30 KB of 34 KB |

`npm run quality` and `npm run audit` were not run (audit omitted by Owner instruction). No new failure; no real VS Code or Chromium run in the closure. Bundle: 1,037,005 B, +2,959 B against batch 2 (1,034,046 B); eager modules 384, +3 against batch 2 (381). The new webview modules since batch 2 are `toolbar-flow-install` (Task 661) and `preview-raw-headings` (Task 660), plus the changed section-indent and table code; the split was not measured.

Task commits: 47de7fb7 (test cleanup); filed in 1985ceb2 and 20c08750.

Acceptance: Item 1 ticked: `npm run test:coverage` exited 0 three times in total (the gate run and two more, 358 files and 7,256 passed each time, no timeout, no unhandled error). Items 2 to 4 ticked earlier. Closure gates passed.

Residual risks: The intermittent `window is not defined` failure was not reproduced, so item 2 is proven by removing the cause; the original one-shot `markmap-security` failure was not reproduced either. A timeout in `block-transform-non-round-trip.test.ts` may still appear once under heavier load.

Owner rulings already recorded: Owner answer Q1 option B: split the one default-timeout heavy case of `block-transform-non-round-trip.test.ts`.
