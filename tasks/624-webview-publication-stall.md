# Task 624 — The webview sometimes stops publishing edits for about 4 s while typing

**Status:** planned (2026-10-07).
**Origin:** found by Task 602 S1e measurement (`tmp/task602-checks/`, see `comparison.md`). The Owner chose on 2026-10-07 to track it outside Task 602.
**Severity:** medium. During the stall the host does not receive the user's typing. Task 602's checkpoint flush and resync fallback limit the Undo damage, but the cause is unknown.
**Tech stack:** TypeScript webview (`media-src/src/bridge/edit-sync.ts`, `media-src/src/editing/edit-activity.ts`, `media-src/src/boot/finish-init.ts`), real VS Code with XTEST.

## Problem

In 1 of 8 twelve-key typing runs in IR on real VS Code 1.129.0, the webview posted no `edit` message to the host for about 4 s while keys were arriving. Vditor still recorded its history entries, so one webview Undo step covered text the host never received. No native VS Code undo step can restore such a step.

## Evidence

- Measured during Task 602 S1e with the post wrapper capturing webview messages; the probe and logs are under `tmp/task602-checks/s1e/` (ignored, local).
- No stall occurred while the experimental checkpoint flush ("F") was enabled, so whether F hides or prevents it is unproven.
- The cause is open. Candidates to check first: the edit-sync debounce and its reset on each input, the IR settle re-spin in `edit-activity.ts`, and main-thread work after key events on larger documents.

## Acceptance

- [ ] A real-VS-Code probe reproduces the stall or proves a bound on publication delay during continuous typing in IR, WYSIWYG and SV.
- [ ] The cause is identified with evidence.
- [ ] Publication delay during typing stays within the edit-sync debounce plus one frame, or the reason it cannot is recorded.
- [ ] Task 602's Undo behavior and its focused specs stay green.

## Tests

- Real VS Code with XTEST: long typing runs that record every webview post time and host edit event.
- Vitest for any debounce or scheduling change.

## Part 1 handoff (2026-10-14)

Read-only analysis of the recorded Task 602 artifacts and the source; the cause is strongly supported by the data but not yet confirmed by a probe.

- **Cause.** During the stall journey the webview's timers were throttled to a ~1 s grid, and two things kept resetting the edit-sync debounce timer: every key, and Vditor's checkpoint `input()` callback, which also fired on that grid. Main-thread work and the settle re-spin cost are ruled out: key `input()` callbacks arrived on time (~every 440 ms), while every timer-driven event (edit posts, Vditor entries, post-Undo echoes) fell on one ~300 + n·1000 ms grid. Normal journeys post 250–260 ms after each key. The same 1 s signature appears in other recorded runs. A replay with aligned timers reproduces the measured post and entry times from three parts: the 250 ms trailing debounce reset on every key; the 220 ms settle re-spin re-arming Vditor's 800 ms checkpoint; the checkpoint calling `options.input()`, which schedules again. Why Chromium throttled a webview receiving input (visibility/occlusion) is unverified — nothing recorded `visibilityState` or focus.
- **Entry points.** `media-src/src/bridge/pending-edit.ts` (pure trailing `schedule()`, no overdue or max-wait guard); `media-src/src/bridge/edit-sync.ts` (`wait: 250`, `onIdle`, schedule call); `media-src/src/editing/edit-activity.ts` (prose fast path calls `options.input()` per key; settle re-spin dispatches an untrusted input); Vditor `ir/process.ts` (checkpoint timer calls `input()` then `addToUndoStack`). The checkpoint flush now in HEAD (`boot/finish-init.ts`, `undo-keybind.ts`) removes the checkpoint resets but not the key resets.
- **Contract.** (1) Overdue rule in `pendingEdit.schedule()`: if a timer is pending and `now - lastScheduleAt >= wait`, the timer is late — cancel it and run `onIdle` now through the same path (`isSuppressed`, perf, `postEdit`), without re-arming. With normal timers this branch never triggers, so fast typing, Task 602 write counts and Undo granularity are unchanged; with throttled timers a key's state is published by the next schedule at the latest. (2) Injectable clock (`opts.now`, default `performance.now`) for unit tests. (3) Acceptance refinement: "debounce plus one frame" holds where `input()` fires per key (IR prose fast path, SV); IR non-fast-path keys and WYSIWYG publish from the checkpoint at `undoDelay` + 250 ms by design, and under throttling the trailing post after the last key waits for the next timer wake (≤ ~1 s) — recorded as the reason the bound cannot hold there.
- **Part 2.** S1: `@probe` real-VS-Code spec (derived from the Task 602 S1e probe): ≥ 8 runs each of 12–24-key XTEST bursts at 180, 300, 440 and 600 ms gaps in IR prose, IR punctuation, SV and WYSIWYG, recording key, `input()`, post and entry times, host edit events, `document.visibilityState` and `hasFocus()` in the webview and workbench frames, a 100 ms `setTimeout` lateness sampler (lateness and phase mod 1000), and the previous journey's steps; expected: stalls only in runs whose sampler shows ~1 s alignment. S2: attribute (throttling + reset, or another cause) and what triggers the throttling. S3: overdue rule and clock in `pending-edit.ts`, wired in `edit-sync.ts`; RED/GREEN in `media-src/src/bridge/pending-edit.test.ts` (schedule at 0, advance the clock to 300 without running timers, schedule again → `onIdle` exactly once and no timer armed; normal-timer control; `flush`/`cancel` after an overdue post) and `edit-sync.test.ts` (overdue post respects `isSuppressed`, the exact-seed and mode-switch early returns, perf `callbackKind: 'idle'`). S4: rerun `undo-host-coupling`, `undo-pending-checkpoint`, `undo-redo-steps`, `undo-first-edit`, `prose-fast-edit` and `perf-prose-typing` (write counts unchanged with normal timers). S5: closure with the per-mode bound.
- **Edge cases.** A large non-IR `onIdle` awaits the next paint (rAF pauses in hidden documents — consider a synchronous post when overdue); re-entrancy when the overdue post comes from inside Vditor's `input()`, the checkpoint callback or emoji/rewrap `scheduleSync` (check `userInputPending`); IME composition (`composingLock`); suppressed extension updates and streaming; large WYSIWYG `undoDelay` 2000 unchanged; Task 615 overlap (no shared lines expected).
- **Owner questions (provisional choices, reversible).** (1) Per-mode acceptance refinement (contract 3) — adopted. (2) No max-wait for IR non-fast-path and WYSIWYG (extra host writes per entry would pressure Task 602's 64-step traversal and cost full serializes on large WYSIWYG documents) — adopted; trackable separately. (3) Ship the overdue rule even if S1 shows throttling only under the headless harness (cheap; inert with normal timers) — adopted.
- **Risk.** The probe may not reproduce the throttling on demand (seen in 1 of 8 runs).
