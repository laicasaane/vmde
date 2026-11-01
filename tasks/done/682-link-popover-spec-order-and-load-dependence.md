# Task 682 — link-popover.spec.ts fails order- and load-dependently

**Status:** done (2026-11-01).
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

- [x] `:110` and `:241` (now `:162` and `:294`) pass in three combined runs of `exact-authority-other-actions.spec.ts link-popover.spec.ts` (one worker, zero retries), and alone. Also pass pinned to one CPU, the load that made `:241` fail 3 of 3 before the change.
- [x] The measured cause is recorded (see "Part 2 result"); no assertion is weakened.
- [x] Test-only: no product file changes (only `test/vscode-e2e/link-popover.spec.ts` and this record changed).

## Part 1 handoff (2026-11-01)

### Measurement on current `dev` (`c0d50848`)

Three combined real-VS-Code calls (one worker, zero retries, through the real-VS-Code wrapper), machine load average 1.4–2.0 on 8 cores:

| Run | `exact-authority-other-actions.spec.ts` | Next | `:110` | `:241` |
| --- | --- | --- | --- | --- |
| 1 | 5 passed | untracked instrumented copy of the first part of both tests | passed | passed |
| 2 | 4 passed, 1 failed at boot (see below) | `link-popover.spec.ts` | passed | passed |
| 3 | 5 passed | `link-popover.spec.ts` | passed | passed |

Run 2's failure is unrelated to this task: the WYSIWYG stale-host test failed in `makeKit` before any action, at `helpers/xtest-input.ts:165` (`electronApplication.browserWindow: Resulting promise was garbage collected.`). It is recorded as a new unattributed intermittent boot failure.

What the previous spec leaves behind (measured by the instrumented copy at the start of each link-popover test, after the long spec):

- The window is 1280 x 900, not maximized, focused. The X11 active and focused window is already the VS Code client, so the keyboard helper's activation is a no-op. The webview has document focus, no selection, and an idle readiness ledger (no pending activity). No focus, selection or pointer event arrives between readiness and the first click.
- The shared kit's `makeKit` sets the user-global `vmde.editor.defaultMode` to `ir` and never restores it. The value persists in the run's shared user-data directory (`settings.json` contains `"vmde.editor.defaultMode": "ir"`), because user data is kept per worker, not per test. It is not the cause: the link-popover tests wait for IR readiness, opened in IR in every measured run, and their failures happen after that point.

Earlier failure context: Task 667's runs paired a candidate and a baseline copy around the same time, and Task 669's `:241` failure came from a batch where `link-popover.spec.ts` followed `large-document-interaction.spec.ts`, not the exact-authority spec. The common factor is machine load, not one preceding spec.

### Cause

1. **Lost typed URL characters (`replaceUrl`, `:77`) — mechanism measured.** In VS Code 1.129.0 the webview host page forwards every keydown inside the webview to the workbench and does not prevent Ctrl+A. The workbench Select All keybinding then calls the webview's `selectAll()`, which posts `execCommand("selectAll")` back to the frame: a delayed second select-all after the native one. The instrumented copy measured the native `select` at +78–80 ms, the echo (a `selectionchange` without a `select` event) at +93/+105 ms, and the first typed key at +122/+130 ms. Under load the echo lands after the first characters are typed, selects them, and the next character replaces them: `https://changed.test/b` became `s://changed.test/b`. This is a race in the test, not a product defect: Edit URL already focuses and selects the whole field (`showEdit` calls `focus()` and `select()`), so the test's Ctrl+A is redundant.
2. **`:110` panel top 0 and `:241` first event `selectionchange` — not reproduced at normal load.** A hidden element has an all-zero bounding rectangle, so panel top 0 means the popover was hidden after `toBeVisible` passed. The product hides the popover on a later selection change that moves the selection (refresh after 32 ms), on window resize and on document scroll; that behaviour is correct. Both failures therefore point to a late selection or focus change after editor readiness under load. Its source is still to be measured (Part 2 step P2-1, under a one-CPU constraint).

No product defect is shown. The fix stays in `link-popover.spec.ts`.

### Decisions

- **Provisional decision (2026-11-01), reversible: `replaceUrl` typing.** Remove the Ctrl+A key from `replaceUrl`. Before typing, poll that the focused URL field's selection covers its whole value (`selectionStart` 0, `selectionEnd` equal to the value length), which Edit URL establishes; then type on the XTEST route and keep `toHaveValue`. Rejected: keeping Ctrl+A and waiting for the echo (no observable signal tells the echo from other selection changes) and retyping on a mismatch (a retry that hides the failure). Selected by a recorded decision check (probability 0.99).
- **Provisional decision (2026-11-01), reversible: `:110` and `:241`.** Measure before fixing. Part 2's RED step reruns the unchanged spec and the instrumented copy alone with the run constrained to one CPU (`taskset -c 0` on the command inside the wrapper, which loads only this run, not other worktrees). The GREEN step then makes both tests wait on the measured observable condition before the pointer trace is installed and the first target is clicked. Rejected: a generic focus/selection-stability wait without a measured source, and recording only. Selected by a recorded decision check (probability 0.97).
- **Provisional decision (2026-11-01), reversible: the kit's leaked `vmde.editor.defaultMode`.** Leave `shortcut-xtest-kit.ts` unchanged and record the leak here as a measured non-cause. Restoring it would change the starting state of every later spec in a batch (from `ir` to `remember`) and widens the scope beyond this task; setting and restoring it inside `link-popover.spec.ts` was the close alternative. Selected by a recorded decision check (probability 0.53; the alternative 0.39). Possible follow-up: restore the setting in the kit together with a check of the specs that run after kit users.

No public names, numbering, compatibility rules or storage formats are involved (test-only).

### Acceptance map

| Acceptance item | Layer | File | Test |
| --- | --- | --- | --- |
| 1. `:110` and `:241` pass in three combined runs and alone | real VS Code | `test/vscode-e2e/link-popover.spec.ts` | `real IR link balloon keeps authored CRLF and table bytes through Copy, Edit, Unlink and history`; `real IR image Edit/Unlink stays exact and link Open keeps modifier and legacy policy` — three calls of `exact-authority-other-actions.spec.ts link-popover.spec.ts` plus one call of `link-popover.spec.ts` alone (closure step) |
| 2. Measured cause recorded; no assertion weakened | record and diff | this record; `git diff` of `link-popover.spec.ts` | every existing `expect` stays; only preconditions are added and the Ctrl+A key is removed |
| 3. Test-only | diff | `git diff --name-only` | only `test/vscode-e2e/link-popover.spec.ts` and this record |

Edge cases (cheapest layer is real VS Code for all of them: the Ctrl+A echo and the window focus path exist only in VS Code's webview pipeline):

1. The select-all echo lands after typing starts: `link-popover.spec.ts` alone with the run constrained to one CPU (both tests type a URL).
2. A late selection or focus change before the first image click (`:241` trace): the same constrained call.
3. The popover hidden by a late selection change before the geometry read (`:110`): the same constrained call.
4. Normal load, spec alone and after the long spec: the closure calls of item 1.

### Part 2 steps

- **P2-1 RED (measurement; owns only untracked files under `tmp/682/`).** Extend the instrumented copy so it records, with timestamps from readiness, every `selectionchange`, `focus`/`blur`, `resize` and `scroll` event, the popover's `hidden` state after the click, and the host window focus. Then `node build.mjs` and, through the real-VS-Code wrapper with `taskset -c 0` before the command: (a) the unchanged `link-popover.spec.ts` alone, `--repeat-each=3` (the failure is intermittent), and (b) the instrumented copy alone, `--repeat-each=3`. Expected: at least one failure of `:110` at `:192`, `:241` at `:278`, or `replaceUrl` at `:77` in (a) (the RED evidence, quoted), and in (b) the source of the late event. If no failure appears, record that and choose the precondition from (b)'s timeline.
- **P2-2 GREEN (owns `test/vscode-e2e/link-popover.spec.ts` only).** Apply the `replaceUrl` decision. Before `installPointerTrace` in both tests, wait on the condition measured in P2-1. Checks: `npm run typecheck:vscode-e2e` exits 0; `npx biome check test/vscode-e2e/link-popover.spec.ts` exits 0; `node build.mjs`; through the wrapper with `taskset -c 0`: `link-popover.spec.ts --repeat-each=3` passes; through the wrapper without the constraint: `link-popover.spec.ts` passes.
- **P2-3 Closure (owns this record).** Through the wrapper: three calls of `exact-authority-other-actions.spec.ts link-popover.spec.ts` (one worker, zero retries) and one call of `link-popover.spec.ts` alone; expected: `:110` and `:241` pass in all four. `git diff --name-only` shows only the spec and this record; `git diff` shows no removed `expect`. Update the acceptance checkboxes and verification.

## Part 2 result (2026-11-01)

### Measured cause

1. **Lost typed URL characters (`replaceUrl`).** Measured mechanism (Part 1): VS Code forwards Ctrl+A from the webview and the workbench posts a delayed second select-all back; under load it lands after the first typed characters. Not reproduced again under one CPU, so this part rests on the mechanism and the recorded failure, not on a new failing run.
2. **`:241` first event `selectionchange` (and the matching exposure of `:110`).** Reproduced: pinned to one CPU, the unchanged `:241` failed 3 of 3 at the first-event assertion. A document-level `selectionchange` with no selection range arrives 34–304 ms after the editor reports ready and idle, before any pointer input. Under one CPU the click's actionability checks take 0.4–1.9 s, so the event falls between installing the pointer trace and the `pointerdown`. At normal load the click follows within milliseconds and the event is missed, so the failure is intermittent. No image load, editor DOM change, focus change, resize or scroll was recorded around the event; its source is not identified. No product defect is shown.
3. **`:110` panel top 0** did not reproduce (0 of 3 pinned, 0 of 3 earlier combined runs). It has the same exposure as `:241` (the trace window before the click, and a popover hidden by a later selection change), so it got the same wait; its original failure is attributed by that mechanism only, not measured.
4. **Not causes (measured).** The shared kit's `makeKit` leaves the user-global `vmde.editor.defaultMode` at `ir` in the run's worker user data; the link-popover tests open in IR either way and fail later. Window size, X focus, webview focus, readiness ledger and pending activity after the long spec were normal. Task 669's `:241` failure came from a batch where the spec followed `large-document-interaction.spec.ts`, so machine load, not one preceding spec, is the common factor.

### Change (`test/vscode-e2e/link-popover.spec.ts` only)

- `replaceUrl` no longer sends Ctrl+A. It polls that the focused URL field's selection covers its whole non-empty value (Edit URL selects it), then types and keeps `toHaveValue`.
- New `waitForSelectionQuiet` (600 ms without a `selectionchange`, fails after 10 s) runs before the pointer trace is installed in both tests. The assertions still require the first event after the trace to be `pointerdown` on the target; a `selectionchange` caused by the click would still fail them. One `expect` was added (the selection poll); none removed or loosened.

### Provisional decisions (2026-11-01), reversible

- `replaceUrl`: drop Ctrl+A and poll the field selection (selected by a recorded decision check, probability 0.99).
- `:110`/`:241`: measure under a one-CPU constraint, then wait on the measured condition; chosen wait is selection quiescence, which keeps the assertion text unchanged (selected by a recorded decision check, probability 0.97).
- The kit's leaked `vmde.editor.defaultMode` stays unchanged and is recorded as a non-cause (selected by a recorded decision check, probability 0.53; the alternative of resetting it inside this spec 0.39). Possible follow-up: restore the setting in the kit and check the specs that run after kit users.

### Verification actually run

All real-VS-Code calls went through the real-VS-Code wrapper, one worker, zero retries, a fresh display per call.

| Call | Result |
| --- | --- |
| `link-popover.spec.ts` alone | 2 passed |
| `link-popover.spec.ts` pinned to one CPU, no repeat | 2 passed (27 s each) |
| `exact-authority-other-actions.spec.ts link-popover.spec.ts`, run 1 | 7 passed; `:162` and `:294` passed |
| same, run 2 | 7 passed; both passed |
| same, run 3 | 7 passed; both passed |

Also: `npm run typecheck:vscode-e2e`, `npx biome check test/vscode-e2e/link-popover.spec.ts`, `npm run check:brand-identifiers` and `npm run jscpd` exit 0. `git diff --name-only` shows only the spec and this record.

### Residuals and follow-ups

- Pinned `--repeat-each=3` in one call: `:110` passed 3 of 3; `:294` (formerly `:241`) passed once and failed twice at the modifier click, `xdotool mousemove --sync` timing out (`helpers/xtest-input.ts`, `clickWithModifier`). Inference, not separately probed: the repeats share one display, the pointer already rests at the target, and `mousemove --sync` never completes. Three separate pinned calls passed 3 of 3. Follow-up for the helper if repeated runs are wanted; out of this task's scope.
- The 600 ms quiet period is a tuned constant (the late event was measured up to 304 ms); a slower machine would fail with a clear timeout, not pass silently.
- The source of the late range-less `selectionchange` is unidentified; a stack capture of selection clears is the next measurement if the wait proves flaky.
- A separate boot failure was seen once in an earlier measurement run, in another spec: the WYSIWYG stale-host test of `exact-authority-other-actions.spec.ts` failed in `makeKit` with `electronApplication.browserWindow: Resulting promise was garbage collected.` (`helpers/xtest-input.ts`). It did not recur in the three closure runs.
