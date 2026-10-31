# Task 624 — The webview sometimes stops publishing edits for about 4 s while typing

**Status:** implemented and verified (2026-11-01); ready to close.
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

- [x] A real-VS-Code probe reproduces the stall or proves a bound on publication delay during continuous typing in IR, WYSIWYG and SV. (S1 and S6: per-mode delays measured; the throttled-grid signature reproduced once.)
- [x] The cause is identified with evidence. (S2, 2026-11-01: per-mode attribution from the S1 probe; the 1 s-grid timer signature of Task 602 S1e appeared once in S6, its trigger is still unknown.)
- [x] Publication delay during typing stays within the edit-sync debounce plus one frame, or the reason it cannot is recorded. (S7: per-mode bounds and reasons below.)
- [x] Task 602's Undo behavior and its focused specs stay green. (S6: 40 passed.)

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

## Part 1 reconciliation (2026-11-01)

Read-only re-check of the 2026-10-14 handoff against HEAD `1db03714` (Task 646 merged). No product code changed; no acceptance validation run.

### Entry points re-verified at HEAD

- `media-src/src/bridge/pending-edit.ts`: unchanged since the handoff. `schedule()` is still a pure trailing debounce (clear, re-arm `setTimeout(onIdle, wait)`), no overdue or max-wait guard; `flush()` always calls `onFlush`; `pending` is `timer !== undefined`.
- `media-src/src/bridge/edit-sync.ts`: `createPendingEdit({ wait: 250, ... })` (line ~1079). `onIdle` returns early into `deferredPlainPost` when `deps.deferTypingPost()` holds (auto-wrap), else `postIdleEdit()`; `postIdleEdit()` checks `isSuppressed()` once, and for a large non-IR document sets the busy cursor and awaits `nextPaint()` (requestAnimationFrame) before `postEdit()`. `postEdit()` keeps the exact-seed and mode-switch early returns and now posts `revision: deps.hostRevision?.()` (Task 646; the three post sites are `postEdit` and the two posts in `flushEdit`). `sync.schedule()` calls `scheduleRendererPerf()` then `pendingEdit.schedule()`. `flushHistoryInput()` (Task 601/646) returns false unless `hasPendingInputPost()` (`pendingEdit.pending || deferredPlainPost`).
- Callers of `editSync.schedule()`: `boot/vditor-init.ts` Vditor `input()` callback (suppressed while `applyingExtensionUpdate` or `streaming`), and `boot/main.ts` `scheduleSync` for rewrap, emoji and related commands (lines 404, 451, 504, 766). `markUserInput()` is called from `main.ts`'s document-level bubble `input` listener (line ~619).
- `media-src/src/editing/edit-activity.ts`: the prose/fence fast path still calls `vditor.options.input()` per key (line ~450) and the settle re-spin still uses the 220 ms quiet window (`QUIET_MS`).
- Task 646 changes: `message-router.ts` `applyHostUpdate()` calls `editSync.flushHistoryInput()` before `setValue` only when the update's revision differs from `sessionState.hostRevision`, then adopts the new revision; an `update` arriving while streaming is kept in `sessionState.deferredHostUpdate` and replayed through `window.postMessage` when the stream ends. Host side: `SyncState` counts external changes (`noteExternalChange`), `EditorSession.refuseStaleEdit()` refuses a plain edit whose `revision` is a number different from the current one and re-posts the host text; `setApplying` now also sets `applyingHistory`, so native Undo/Redo events are neither external nor echoed.
- Test files named by the plan exist: `media-src/src/bridge/pending-edit.test.ts` (fake timers), `media-src/src/bridge/edit-sync.test.ts`, and the real-VS-Code specs `undo-host-coupling`, `undo-pending-checkpoint`, `undo-redo-steps`, `undo-first-edit`, `prose-fast-edit`, `perf-prose-typing`, `external-disk-change`. Fixtures `perf-prose.md` (54.6 KB) and `perf-prose-small.md` exist. The Task 602 S1e probe it derives from is ignored local material in the main checkout (`tmp/task602-checks/s1e/s1e-probe.spec.ts`); it depends on a candidate-selection global and a large fixture under `tmp/`, neither of which exists in a worktree.

The handoff's entry points and the timing analysis still hold. The perf union `callbackKind: 'idle' | 'flush'` in `src/shared/protocol.ts` is unchanged.

### Overdue rule against Task 646

- **Revision.** The overdue post runs synchronously inside `schedule()`, which runs inside an input handler. No host `update` can be applied in between, so the post carries the revision of the DOM it serialized. Fits; the host refuses it only in the same cases as a timer post.
- **Flush before update.** The rule shortens the time typing stays unposted, so `applyHostUpdate()` finds less to flush. With a timer still armed, `flushHistoryInput()` flushes as before.
- **Await gap (new finding).** A timer-path post for a large non-IR document awaits `nextPaint()` after the timer has cleared. During that await `hasPendingInputPost()` is false, so a host update with a new revision skips the flush, replaces the DOM, and the awaited `postEdit()` then serializes the host's text: the typing is dropped silently. This gap exists with normal timers and predates Task 624; it is recorded as a risk for a separate task, not fixed here. The overdue path must not add another such gap, so it posts synchronously (Q4).
- **Call order (new finding).** Vditor's element-level input handler (fast path → `options.input()` → `editSync.schedule()`) runs before `main.ts`'s document-level `markUserInput()`. An overdue post therefore runs before the current key sets `userInputPending`. The serialized DOM already contains the key, but (a) when the pending timer was armed by an untrusted settling input while an exact seed owns the DOM, `postEdit()` returns early and, without a new timer, nothing publishes the key until the next schedule; (b) in the normal case `userInputPending` is set again after the post with no timer pending. Re-arming the trailing timer after the overdue post closes both (Q5). The handoff's "without re-arming" is replaced.
- **Suppression and streaming.** `isSuppressed()` still gates the overdue path inside `postIdleEdit()`; Vditor's `input()` is already suppressed while streaming. The deferred host update replay is unaffected.
- **Auto-wrap deferral.** `onIdle` sets `deferredPlainPost` when `deferTypingPost()` holds, on either path; `resumeDeferredInput()` schedules with no timer pending, so the overdue branch cannot fire there.
- **Host.** Under throttled timers the webview posts more often (at most one overdue post plus one trailing post per key). Each goes through the host's edit chain with the revision check; with normal timers the post count is unchanged.

### Decisions re-settled

- Q1 (per-mode bound), Q2 (no max-wait for IR non-fast-path and WYSIWYG), Q3 (ship even if throttling is harness-only): unchanged by Task 646, kept as recorded on 2026-10-14. Q2 also means the overdue test uses the time since the current timer was armed, not since the first unposted key: with key gaps below 250 ms the trailing debounce posts only after the pause, by design.
- **Q4 — Provisional decision (2026-11-01), reversible.** The overdue post skips the busy cursor and the `nextPaint()` await and posts synchronously. `pending-edit` passes a reason to `onIdle`; `postIdleEdit()` skips the paint wait when the reason is `'overdue'`, keeping every early return and perf `callbackKind: 'idle'`. The timer path is unchanged. Evidence: requestAnimationFrame stops in hidden or occluded documents and may be throttled with timers; an await would recreate the gap above. Alternatives: the same `onIdle` path unchanged (fails "no paint dependency"), a separate `onOverdue` callback (a second post path). Selected by a recorded decision check (probability 0.96).
- **Q5 — Provisional decision (2026-11-01), reversible.** After the overdue post, `schedule()` arms a fresh trailing timer exactly as a normal schedule. Evidence: the call order above. Alternatives: no re-arm (loses the key in case (a)), moving the overdue post into `markUserInput()` (couples the pure module to edit-sync order). Selected by a recorded decision check (probability 0.90).

### Settled contract for Part 2 (replaces handoff contract item 1)

- `pending-edit.ts`: `export type PendingIdleReason = 'timer' | 'overdue'`; `PendingEditOptions.onIdle: (reason: PendingIdleReason) => void | Promise<void>`; new `PendingEditOptions.now?: () => number`, default `() => performance.now()`. `schedule()`: `t = now()`; if a timer is pending and `t - armedAt >= wait`, clear it and call `void opts.onIdle('overdue')`; then (both branches) `armedAt = t` and arm `setTimeout(() => { timer = undefined; void opts.onIdle('timer') }, wait)`. `flush()`, `cancel()` and `pending` keep their behavior. The module stays free of Vditor and VS Code references.
- `edit-sync.ts`: new `EditSyncDeps.now?: () => number` passed to `createPendingEdit` (test seam). `onIdle(reason)` forwards the reason to `postIdleEdit(reason)`; with `'overdue'`, the large non-IR branch calls `postEdit(perf)` without `setBusyCursor` and `nextPaint()`. Perf stays `takeRendererPerf('idle')`. No protocol change.
- With normal timers the overdue branch never runs: post counts, Undo granularity and Task 602 write counts are unchanged.

### Part 2 step plan (numbered; replaces the handoff's S1–S5)

Real-VS-Code commands run only through the wrapper `vscode-run.sh 624 env -u ELECTRON_RUN_AS_NODE xvfb-run -a sh -c 'openbox & OB=$!; VMDE_XTEST=1 <npm command> --workers=1 --retries=0; R=$?; kill $OB; exit $R'`, after `node build.mjs`. Record `uptime` before and after every timing run.

1. **S1 — Probe (real-VS-Code, non-asserting).** Result: the measured publication delay per mode, with timer-lateness evidence. Owned: new `test/vscode-e2e/publication-delay-probe.spec.ts` (title tag `@probe`, derived from the Task 602 S1e probe without its candidate global); results under `tmp/624/s1/` (ignored); a results summary in this task record. Matrix: IR prose, IR punctuation, SV and WYSIWYG; key gaps 180, 300, 440 and 600 ms; 8 runs each; 12 keys (24 at 180 ms); large document built in the run folder from `fixtures/perf-prose.md` repeated three times, plus a control of 4 runs at 440 ms on `fixtures/perf-prose-small.md`. Per run record: key send times, webview `input` event times, every webview `edit` post time and size, host `onDidChangeTextDocument` times, Vditor undo-stack entry times, `document.visibilityState` and `document.hasFocus()` in the webview and workbench frames, a 100 ms `setTimeout` lateness sampler (lateness and phase mod 1000), and the previous run's steps. Environment variable `VMDE_624_SET` selects `ir` or `sv-wysiwyg` so each invocation stays under 60 min. Acceptance item 1. Checks: `npm run typecheck:vscode-e2e` exit 0; `npx biome check test/vscode-e2e/publication-delay-probe.spec.ts` exit 0; `node build.mjs` exit 0; wrapper with `npm --prefix test/vscode-e2e run test:probes -- publication-delay-probe.spec.ts` once per set, exit 0, `tmp/624/s1/results-*.json` newer than the run start. Expected: delay ≤ 250 ms + one frame for gaps ≥ 300 ms in IR prose and SV in runs whose sampler shows normal lateness; any stall coincides with ~1 s sampler alignment. Step type: real-VS-Code probe.
2. **S2 — Attribution (read-only reasoning).** Result: the cause recorded with evidence (throttled timers plus debounce resets, or another cause), and what triggers the throttling (visibility, focus or neither). Owned: this task record only. Acceptance item 2. Checks: every claim cites a `tmp/624/s1/` run and field; the record states whether S3–S5 proceed as designed. If S1 shows another cause, stop and record a design question. If S1 does not reproduce the stall, proceed under Q3. Step type: reasoning.
3. **S3 — Vitest RED.** Result: failing unit tests for the settled contract. Owned: `media-src/src/bridge/pending-edit.test.ts`, `media-src/src/bridge/edit-sync.test.ts`. Cases in `pending-edit.test.ts` (injected `now`, fake timers): schedule at 0, clock 300 without running timers, schedule → `onIdle('overdue')` once synchronously and `pending` true; then advance 250 → `onIdle('timer')` once; normal control (schedule at 0, clock 100, schedule, advance 250 → one `onIdle('timer')`, no `'overdue'`); `flush()` after an overdue post → `onFlush` once, `pending` false, no later `onIdle`; `cancel()` after an overdue post → no later `onIdle`. Cases in `edit-sync.test.ts` (via `deps.now`): overdue schedule posts one `edit` synchronously with the current `revision`; suppressed → no post and perf cancelled; exact-seed early return at the overdue post, then `markUserInput()` → the re-armed timer posts the key; mode-switch early return; large non-IR document overdue post is synchronous (no busy cursor, no paint wait); perf `callbackKind: 'idle'`. Acceptance item 3 (unit part). Check: `npx vitest run --config test/vitest.config.mts media-src/src/bridge/pending-edit.test.ts media-src/src/bridge/edit-sync.test.ts` → the new cases fail on the missing behavior (record the exact failing names), all existing cases pass. Step type: RED.
4. **S4 — Real-VS-Code RED spec.** Result: an asserting spec that fails on HEAD under simulated throttling. Owned: new `test/vscode-e2e/publication-delay-throttled.spec.ts`. Method: before typing, wrap the webview frame's `setTimeout` so every timer with delay ≥ 100 ms fires at the next 1000 ms boundary of `performance.now()`; type 12 keys by XTEST at 440 ms gaps in IR prose (`fixtures/perf-prose-small.md`) and in SV. Assert: each key except the last is contained in a posted `edit` no later than one frame (≤ 50 ms) after the next key's `input` event; the last key is posted within 1050 ms. WYSIWYG and IR non-fast-path keys are exempt (Q1). Acceptance item 3. Checks: `npm run typecheck:vscode-e2e` exit 0; biome on the file exit 0; `node build.mjs` exit 0; wrapper with `npm --prefix test/vscode-e2e test -- publication-delay-throttled.spec.ts` → fails on the publication assertion (not on setup) in both modes. Step type: real-VS-Code RED.
5. **S5 — GREEN.** Result: the settled contract implemented. Owned: `media-src/src/bridge/pending-edit.ts`, `media-src/src/bridge/edit-sync.ts`. Acceptance item 3. Checks: the S3 Vitest command → all pass; `npm run typecheck` exit 0; `npx biome check media-src/src/bridge/pending-edit.ts media-src/src/bridge/edit-sync.ts` exit 0; `node build.mjs` exit 0. Step type: GREEN.
6. **S6 — Real-VS-Code verification round.** Result: real-VS-Code evidence for items 3 and 4. Owned: this task record (results only). One wrapper invocation: `npm --prefix test/vscode-e2e test -- publication-delay-throttled.spec.ts undo-host-coupling.spec.ts undo-pending-checkpoint.spec.ts undo-redo-steps.spec.ts undo-first-edit.spec.ts prose-fast-edit.spec.ts perf-prose-typing.spec.ts external-disk-change.spec.ts` → all pass except the known intermittent `undo-host-coupling` twelve-key burst (record it if it fails; rerun that case once alone); `perf-prose-typing` write counts equal the pre-change figures. Second invocation: the S1 probe, `VMDE_624_SET=ir`, 440 and 600 ms gaps only → delay bound as in S1 expectation. Step type: real-VS-Code.
7. **S7 — Closure.** Result: completion report. Owned: this task record, `tmp/624/completion-report.md`. Checks: `node build.mjs`, `npm run typecheck`, `npm run lint`, the S3 Vitest command, `npm run quality` (record each stage), checklists ticked only where proven, final diff gate. All acceptance items. Step type: closure.

### Edge cases carried forward

IME composition (`composingLock`): whether `input()` reaches `schedule()` during a composition is not verified (only the settle re-spin checks `composing()`); an overdue post mid-composition would serialize the uncommitted text, as a flush does today. No probe or spec types IME; recorded as a risk. Re-entrancy from the checkpoint `input()` and from `scheduleSync` (rewrap, emoji): the overdue post runs the same synchronous `postEdit()` a flush already runs from those callers. Large WYSIWYG `undoDelay` 2000 ms is unchanged. Task 615 overlap: none in the owned files.

### Risks

- The await gap above (pre-existing, normal timers, large non-IR documents) remains; propose a separate task.
- The probe may not reproduce real throttling; S4's simulated throttling then carries acceptance item 3, and S2 records that the trigger stays unverified.

### Progress checkpoint (2026-11-01)

Part 1 reconciliation done. No product or test file changed. Next action: S1.

## Part 2 progress

### S1 — publication-delay probe (2026-11-01)

New non-asserting spec `test/vscode-e2e/publication-delay-probe.spec.ts` (`@probe`; sets chosen with `VMDE_624_SET` = `ir`, `sv`, `wysiwyg`, `control` or `all`). Per run it records the OS key times (webview trusted `keydown`), `input` events, Vditor `options.input()` calls, every webview `edit` post (time and size), Vditor undo-stack entries, the host's text-document change events, `visibilityState` and `hasFocus()` in the webview (sampled every 100 ms) and the workbench (before and after each run), and a 100 ms `setTimeout` lateness sampler (lateness and phase modulo 1000 ms). The recorders are pass-through wrappers; no editor behavior is changed. Raw results are in `tmp/624/s1/results-*.json` (ignored, local); the per-run console lines are in `tmp/624/s1-run-*.log`.

Matrix as planned: IR prose, IR punctuation, Split View and WYSIWYG on a document of about 160 KB (the anchor paragraph followed by the prose fixture three times); gaps of 180 (24 keys), 300, 440 and 600 ms (12 keys each); 8 runs per gap; plus a control of 4 runs at 440 ms on the small document. Real-VS-Code runs went through the wrapper at 04:15:17 (control), 04:17:07 (IR) and 04:26:19 (Split View and WYSIWYG), all exit 0, 1 + 2 + 2 tests passed. Machine load average (1 min) read 0.9–1.3 at each start and between 1.2 and 4.8 during the runs (other task sessions ran in parallel). In every run the webview was `visible` with focus, the workbench had focus, and every typed key was seen (`keysSeen` equals the keys typed; in the punctuation runs Shift key presses add 3 events per 12 characters and are counted as keys, so their delays are measured from the Shift press).

"Bound" below is 250 ms plus one frame, with an allowance for the typing and polling overhead (317 ms). Delay = time from a key to the first webview `edit` post made after it.

| Case | Gap (ms) | Key delay (max per run, range over runs) | Posts per run | Timer sampler: worst lateness |
|---|---|---|---|---|
| IR prose, large | 300 / 440 / 600 | 280–346 / 278–290 / 283–313 ms (4 of 288 keys over the bound, all at 300) | 13 | 114 / 118 / 82 ms |
| IR prose, large | 180 | 2.5–5.3 s: 1–4 posts, the first after the burst ended; last key 314 ms at most | 2–4 | 196 ms |
| IR prose, small control | 440 | 254–261 ms | 13 | 13 ms |
| IR punctuation, large | 180 | 282–384 ms | 13 | 138 ms |
| IR punctuation, large | 300 / 440 / 600 | 899–948 / 911–1070 / 914–946 ms; posts about every 960 ms (7 per run for 12 characters); all 8 runs over the bound | 7 | 118 / 253 / 125 ms |
| Split View, large | 180 | 6.3–7.9 s: one post per run after the burst; last key 621 ms at most | 1 | 6.1–7.7 s |
| Split View, large | 300 | 4.2–4.6 s: one post per run; last key 644 ms at most | 1 | 0.5–2.8 s |
| Split View, large | 440 | 0.8–5.9 s | 1–9 | 0.4–1.4 s |
| Split View, large | 600 | 529–1184 ms (96 of 96 keys over the bound) | 11–12 | 0.33–0.52 s |
| WYSIWYG, large | 180 / 300 / 440 / 600 | 5.9–7.1 / 5.8–5.9 / 7.3–7.5 / 9.1 s: one post per run after the burst; last key 2.08–2.09 s | 1 | 175 ms at most |

Observations recorded without attribution (S2 attributes):
- No run showed the stall that Task 602 S1e recorded (about 4 s without a post while keys at about 440 ms gaps were arriving, with timer events on a 1 s grid). In IR prose at gaps of 300 ms or more, every key was published within 346 ms; the timer sampler never showed a 1 s grid.
- Where the timer sampler showed large lateness (Split View on the large document: 0.3–7.7 s), the late timers did not repeat on one phase modulo 1000 ms (for example 541, 871, 202, 551, 886, 239…), and keys were still delivered on time. In the other cases the sampler stayed under 260 ms.
- IR prose with 180 ms gaps (shorter than the 250 ms debounce) posted once after the burst ended, so the first key waited for the whole burst (about 5 s for 24 keys). With 300 ms or longer gaps the debounce fired between keys.
- IR punctuation published on a cadence of about 960 ms, not 250 ms, at gaps of 300 ms or more; the undo-stack entry counts were 1 per run at 300 and 440 ms and 5–6 at 600 ms.
- WYSIWYG published once per run, 2.08–2.09 s after the last key, for every gap up to 600 ms.
- Control: on the small document, IR prose posts 252–261 ms after every key.

Acceptance item 1 is not yet ticked: the probe measured the delay in all three modes and did not reproduce the recorded stall, but the 250 ms + one frame bound did not hold in Split View, WYSIWYG, IR punctuation and IR prose below 250 ms gaps. S2 decides which of these are by design (Q1) and which need the overdue rule or another change.

### S2 — attribution (2026-11-01)

Read-only analysis of `tmp/624/s1/results-*.json` (per-run fields named below) and the source. No new runs.

**How the causes were separated.** Three signals tell them apart: the timer sampler (a 100 ms `setTimeout` chain: lateness, sample count and phase), the spacing of trusted `keydown` handler times against the requested gap (`meanActualGap`; the XTEST loop adds about 35 ms, so a free main thread shows 214 / 339 / 478 / 640 ms for 180 / 300 / 440 / 600 ms), and which keys call Vditor's `options.input()` (`optInputCalls`) and so reach `editSync.schedule()`.
- Timer throttling shows as sampler lateness on one repeating phase modulo 1000 ms while key handlers stay on time.
- Main-thread work shows as one late sample per key at the key's time, with no repeating phase, and at short gaps as key handlers spaced wider than requested.
- A debounce reset shows as a normal sampler, keys on time, and no post until the keys pause.

**Attribution per case.**
1. **IR prose, gaps of 300 ms or more: works as designed.** Keys on time (339 / 478 / 640 ms), sampler at most 118 ms late, one `options.input()` per key, one post per key 252–346 ms after it. The four keys over 317 ms (all at 300 ms gaps, at most 346 ms) match the sampler jitter under load; no mechanism.
2. **IR prose, 180 ms gaps: debounce reset on every key.** Keys on time (214–215 ms), sampler normal (at most 196 ms, one late sample in 8 runs), `options.input()` per key, so each key re-arms the 250 ms trailing timer before it fires; the only post comes 250–314 ms after the last key. This is the trailing debounce of Q2, not a stall.
3. **IR punctuation, gaps of 300 ms or more: non-fast-path keys do not schedule.** `optInputCalls` is 7 for 12 characters at 300 and 440 ms: the 6 letters take the prose fast path (`edit-activity.ts` calls `options.input()`), the 6 punctuation keys go through Vditor's normal IR input, which (with the fixIrInputSerialize patch) does not call `options.input()`. Delays alternate about 290 ms (letters) and gap + 290 ms (punctuation, published with the next letter's post); the "about 960 ms cadence" is two keys per post, not a timer grid (sampler normal, at most 253 ms). A punctuation key with no later letter waits for Vditor's 800 ms checkpoint plus 250 ms. Measured maximum 1070 ms. This is the IR non-fast-path case of Q1.
4. **WYSIWYG: publication only from the checkpoint.** `optInputCalls` is 1 per run: no key calls `options.input()`; Vditor's checkpoint does once the keys pause. Every key of a burst waits for the burst plus the checkpoint: the last key 2.08–2.09 s (large-document `undoDelay` 2000 ms), the first up to 9.1 s for a 12-key burst at 600 ms gaps. Sampler normal (at most 175 ms). This is the WYSIWYG case of Q1; Q2 (no max-wait) keeps it.
5. **Split View on the large document: per-key main-thread work starves the debounce.** At 600 ms gaps the sampler is late once per key (12–13 late samples per 12-key run, 330–520 ms), the late samples are spaced like the keys (about 630 ms), and their phases do not repeat modulo 1000 ms: each key costs one long task of roughly 0.3–0.5 s. At 180 ms gaps the key handlers ran 253–318 ms apart instead of 214 (keys queue behind that work) and the sampler chain made only 8–14 samples in about 10 s, one of them 6.1–7.7 s late. At 300 and 440 ms gaps keys arrived on time but the quiet time between one key's work and the next key is under 250 ms, so the trailing timer is re-armed before it can fire: one post per run, the first key published 4.2–5.9 s after it was typed. What the per-key work is (the Split View source spin, the preview render or another observer) is not measured; it is outside Task 624.
6. **The Task 602 S1e stall was not reproduced.** 132 runs, the webview `visible` and focused and the workbench focused throughout, and no run showed sampler lateness on a repeating 1 s phase. The throttling trigger recorded in Task 602 (timers on a ~1 s grid while key `input()` calls stayed on time) stays unverified; Q3 keeps the overdue rule.

**Effect of the settled overdue rule per case** (inference from the contract, verified in S6):
- Cases 1, 3 (letters), 4: inert. Timers fire normally, so the overdue branch never runs.
- Case 2: inert. Each key re-arms before 250 ms passes, so `now - armedAt < wait` at every schedule; Q2 keeps the trailing behavior.
- Case 3 (punctuation): unchanged. Those keys never call `schedule()`.
- Case 5: active. At the next key's `schedule()` the timer was armed 250 ms or more earlier, so the key's state is posted then: at most one post per key, each a full serialize of the Split View document (synchronous under Q4).
- Case 6: the mechanism the rule was designed for.

**Provisional decision Q6 (2026-11-01), reversible.** The overdue rule stays mode-independent, including Split View on large documents; the per-key Split View main-thread work is recorded as a separate task, and S6 measures the Split View delay and key spacing with the rule in place. Evidence: case 5 above; the alternatives (skip the overdue post for large non-IR documents; one overdue post per 1000 ms at most for them) either leave multi-second delays or add a new parameter. Whether the rule bounds the Split View delay is not proven until S6. Selected by a recorded decision check (probability 0.86; "gather more evidence" 0.09).

**Acceptance item 3, per-mode bound and recorded reasons** (final figures after S6):
- IR prose fast path and Split View on small documents, key gaps of at least 250 ms plus the key's own work: 250 ms plus one frame.
- Any mode with gaps under 250 ms: 250 ms after the last key of the burst (trailing debounce, Q2).
- IR keys outside the prose fast path (punctuation and other structural input): published with the next fast-path key, or by the 800 ms checkpoint plus 250 ms (Q1, Q2).
- WYSIWYG: the checkpoint after the burst (`undoDelay` 800 ms, 2000 ms on large documents) (Q1, Q2).
- Split View on large documents: bounded by the next key with the overdue rule (S6 records the figure); the per-key main-thread cost is outside this task.
- Throttled timers (Task 602 S1e): the overdue rule publishes at the next key; the last key waits for the next timer wake.

**Plan amendments (S3–S7).**
- S3, S4, S5: unchanged. S4's simulated throttling stays the proof for case 6 (IR prose and Split View, small document).
- S6, second invocation: the probe has no gap selector, so "440 and 600 ms gaps only" cannot be run as written. Run `VMDE_624_SET=ir,sv` with the full gap matrix (about 14 min, `uptime` before and after). Expected against S1: IR prose and IR punctuation unchanged (case 1 at most about 350 ms; case 2 and 3 figures unchanged); Split View on the large document at 300 and 440 ms gaps shows about one post per key and a first-key delay no longer than the S1 key spacing plus one key's work (record the figure); key-handler spacing at 300 ms gaps no worse than S1 (mean at most 345 ms) and sampler lateness per key not above S1 by more than the measured serialize time. If Split View typing degrades beyond that, record it and stop as a design question instead of tuning.
- S7: the closure records the per-mode bound above with the S6 figures, and proposes the separate task for the per-key Split View main-thread work (case 5) and the pre-existing await gap.

### S3 — Vitest RED (2026-11-01)

New cases, none of the implementation:
- `media-src/src/bridge/pending-edit.test.ts`, `describe('createPendingEdit overdue rule (Task 624)')`, injected `now`, fake timers (7 cases): a late timer runs `onIdle('overdue')` once synchronously, keeps `pending` true, and the re-armed timer then runs `onIdle('timer')`; the boundary (249 ms normal, 250 ms overdue); control (keys inside the wait only debounce, `onIdle('timer')` once); no overdue when the previous timer already fired; the next overdue check counts from the re-armed timer; `flush()` and `cancel()` after an overdue post leave no timer.
- `media-src/src/bridge/edit-sync.test.ts`, `describe('overdue publication (Task 624)')`, `now` and `hostRevision` added to the `boot()` options (8 cases): the overdue post is synchronous and carries the current revision; the re-armed timer publishes the key marked after it; control (keys inside the wait post once after the pause); suppressed (no post); mode-switch early return (no post, rebaseline read once); exact-seed early return followed by the re-armed timer's post; a large WYSIWYG document posts without the busy cursor or a paint wait, with the timer-path control still waiting for a paint; the renderer perf record reports `callbackKind: 'idle'`.

Check: `npx vitest run --config test/vitest.config.mts media-src/src/bridge/pending-edit.test.ts media-src/src/bridge/edit-sync.test.ts` fails 12 of 167 cases, all for the missing overdue rule:
- `pending-edit.test.ts`: 7 of 7 new cases (no overdue call; `onIdle` receives no reason).
- `edit-sync.test.ts`: posts synchronously with the revision; arms a fresh trailing timer; mode-switch early return; large non-IR synchronous post; perf record (no post at the overdue schedule).
- The other 155 cases pass, among them the existing suites and four new guard cases that hold before and after the change (control, suppressed, exact-seed early return, large non-IR timer-path control).
`npm run typecheck` fails on exactly the two new test options (`now` in `EditSyncDeps` and in `PendingEditOptions`) until S5 adds them.

### S4 — real-VS-Code RED spec (2026-11-01)

New spec `test/vscode-e2e/publication-delay-throttled.spec.ts` (two tests, IR prose and Split View, small document, 12 XTEST keys at 440 ms gaps). It simulates throttled timers: every webview `setTimeout` of 100 ms or more is moved to the first 1,000 ms boundary of `performance.now()` at or after its requested time (never early). Recorders (pass-through) take trusted `keydown` times, `input` event times and every `edit` post with its content. Setup assertions come first (timers throttled, 12 keys delivered, 12 input events); then each key must be contained in a posted `edit` by 50 ms after the next key's `input` event, and the last key within 1,300 ms of its keydown.

Deviation from the plan text, recorded: the plan said the last key within 1,050 ms. A throttled trailing timer fires at the first grid point at or after its 250 ms, which is 250 to 1,250 ms after the key, so 1,050 ms would fail on phase alone; the spec uses 250 + 1,000 + 50 = 1,300 ms. The rule cannot publish the last key earlier because nothing follows it.

Run: `node build.mjs`, then the wrapper with `npm --prefix test/vscode-e2e test -- publication-delay-throttled.spec.ts --workers=1 --retries=0` at 04:53:47 (the token wait took about 9.5 min; machine load average 1.4 at the end), exit 1, 2 failed, 0 passed. Both failures are on the publication assertion, after the setup assertions passed:
- IR prose: keys 1–5, 7, 9 and 11 were published 224 ms to 2,122 ms past their limit (keys 6, 8, 10 and 12 were published by a timer that happened to fire on a grid point between keys).
- Split View: key 2 379 ms and keys 4–11 between 1,114 ms and 4,436 ms past their limit.
Log: `tmp/624/s4-run.log` (local, ignored).

### S5 — overdue rule implemented (2026-11-01)

- `media-src/src/bridge/pending-edit.ts`: exported `PendingIdleReason = 'timer' | 'overdue'`; `onIdle(reason)`; optional `now` (default `performance.now`); `schedule()` computes `overdue = timer pending && now - armedAt >= wait`, clears and re-arms the timer (`armedAt = now`), and only then runs `onIdle('overdue')`, so a re-entrant `schedule()` or a `cancel()` from `onIdle` sees a consistent state. Normal path cost per key: one clock read and one comparison; no allocation.
- `media-src/src/bridge/edit-sync.ts`: `EditSyncDeps.now?`, passed to `createPendingEdit`; `onIdle(reason)` forwards the reason to `postIdleEdit(reason)`, which skips the busy cursor and the paint wait for `'overdue'` (Q4). Every early return, the `isSuppressed()` check, the auto-wrap deferral and perf `callbackKind: 'idle'` are unchanged.
- Checks: `npx vitest run --config test/vitest.config.mts media-src/src/bridge/pending-edit.test.ts media-src/src/bridge/edit-sync.test.ts` passes 167 of 167 (the 12 RED cases included, no test changed); `npm run typecheck` exit 0; `npx biome check` on both source files exit 0. The exact-seed guard case now shows the early return is exercised (no post at the overdue schedule while the key is not yet marked).
- Real VS Code (wrapper, `node build.mjs` first, `--workers=1 --retries=0`): `publication-delay-throttled.spec.ts` passes 2 of 2 (IR prose and Split View) at 05:01:16, exit 0; machine load average 2.0 at the end.

### S6 — real-VS-Code verification round (2026-11-01)

All runs: `node build.mjs` first, the real-VS-Code wrapper, `--workers=1 --retries=0`, the build with the overdue rule (S5).

**Invocation 1** (started 05:03:00, load average 3.75 at start and 0.52 at the end, exit 0, 40 passed in 41.1 min): `publication-delay-throttled` (2), `undo-host-coupling` (8, including the twelve-key burst, no flake), `undo-pending-checkpoint` (4), `undo-redo-steps` (1), `undo-first-edit` (6), `prose-fast-edit` (1), `external-disk-change` (18). Acceptance item 4 is proven for these specs.

**Invocation 2** (started 05:44:23, exit 0, 5 passed in 14.5 min; probes need the probe switch): `perf-prose-typing` (small and large document) and `publication-delay-probe` for `ir` (prose, punctuation) and `sv`, results in a separate folder from S1's. `perf-prose-typing` is a timing breakdown without a post counter: 30 characters in 721 ms (small) and 1,125 ms (large), main-thread blocking 12 ms and 261 ms, worst single freeze 22 ms and 34 ms. Machine load was high for the first half of the IR runs (load average 5–11 from other sessions), so the IR prose figures of that invocation are confounded (key delays 388–444 ms at 300–440 ms gaps, sampler lateness up to 293 ms).

**Invocation 3** (started 06:01:28, load average 1.4 → 0.5, exit 0, IR prose and punctuation again, 9.2 min), at calm load:

| Case | Gap (ms) | S1 key delay (max per run) | With the rule | Posts / host edits per run |
|---|---|---|---|---|
| IR prose, large | 300 / 440 / 600 | 280–346 / 278–290 / 283–313 ms | 278–354 / 280–313 / 279–288 ms | 13 / 12 in both (unchanged) |
| IR prose, large | 180 | 2.5–5.3 s, 2–4 posts | 2.6–5.2 s, 2–5 posts | same |
| Split View, large | 300 | 4.2–4.6 s, 1 post | 530–547 ms, 12 posts, last key 237 ms | 12 / 11 |
| Split View, large | 440 | 0.8–5.9 s, 1–9 posts | 800–926 ms, 12 posts, last key 321 ms | 12 / 9–11 |
| Split View, large | 600 | 529–1184 ms | 486–616 ms | 12 / 12 |
| Split View, large | 180 | 6.3–7.9 s, 1 post | 0.69–1.63 s, 10–24 posts, last key 500 ms | 10–24 |

Large-document Split View typing is not worse than in S1: key-handler spacing is equal (342, 481 and 641 ms for 300, 440 and 600 ms gaps, as in S1), and the timer sampler's worst lateness is lower or equal in every gap (1,306 vs 2,835 ms; 857 vs 1,440; 392 vs 521; 7,737 vs 7,740 at 180 ms). The overdue posts there add one full serialize per key and the keys still arrive on time; the remaining 0.5–0.9 s delay is the per-key main-thread work of 0.3–0.5 s recorded in S2 (outside this task), so the 250 ms + one frame bound does not hold in large Split View.

**Throttled timers reproduced once.** In the IR punctuation test of invocation 3 (a fresh VS Code instance, the second test of the run), all 32 runs showed the Task 602 signature: the 100 ms timer sampler was late on one repeating phase (625 ms modulo 1,000 ms, five to ten times per run, lateness 900 or 1,900 ms), while the webview was `visible` with focus and the workbench focused, and keys arrived on time. The other four test instances of invocations 2 and 3 (IR prose twice, IR punctuation once, Split View) did not show it, and neither did any S1 instance. What starts it is still unknown: nothing recorded differs between affected and unaffected instances. In the affected instance, IR punctuation keys (which never call `schedule()`) were published 0.68–1.78 s after the key (S1: 0.9–1.07 s); at 600 ms gaps the posts rose to 8–10 per run and undo-stack entries to 2–4 per run (S1: 7 and 5–6). The overdue rule cannot act on those keys; the letters between them did get their posts.

**Acceptance.** Item 1 is proven: the probe measured the publication delay in IR, Split View and WYSIWYG, and reproduced the throttled-grid signature once. Item 4 is proven by invocation 1. Item 3 gets its per-mode bounds at closure (S7).

### S5 note added at closure

After an overdue post the re-armed timer posts again even when nothing changed (Q5 accepts one overdue post plus one trailing post). The host answers identical content without writing. The edit-sync case "the re-armed timer posts the same content again when nothing changed after the overdue post" pins this.

### S7 — closure (2026-11-01)

**Review tests added before the gates** (test-only, no product change): `edit-sync.test.ts` pins the trailing post above; `pending-edit.test.ts` gains a case where `onIdle('overdue')` calls `schedule()` (no second overdue, one timer left, `pending` true) and one where it calls `cancel()` (no later `onIdle`). Focused Vitest files: 170 of 170 pass.

**Gates** (all in the worktree, after `node build.mjs`): `npm run typecheck` exit 0; `npm run typecheck:vscode-e2e` exit 0; `npm run lint` exit 0 (3 existing infos); the two focused Vitest files 170 of 170. `npm run quality` stages: brand identifiers PASS, `lint:ci` PASS, knip PASS, jscpd PASS, dependency-cruiser PASS, **audit FAIL** (advisories reported for packages in the shared dependency tree: a high one in an Azure identity dependency, moderate ones in the test runner mocker, `qs`, `undici` and `launch-editor`; no dependency was changed by this task, so it is recorded, not fixed), unit coverage PASS (373 files, 7,996 tests, 1 expected fail), zero-coverage-module ratchet PASS (10 modules, baseline 10). Real VS Code was not rerun at closure because no product code changed after S6.

**Publication delay per mode, and the reason where the bound cannot hold** (key to first `edit` post; "bound" = 250 ms debounce + one frame):
- **IR, prose fast path, gaps of 250 ms or more:** within the bound (278–354 ms measured, 13 posts and 12 host edits per 12 keys, unchanged by the rule).
- **Any mode, gaps below 250 ms:** the trailing debounce posts 250–315 ms after the last key of the burst (Q2, by design; a burst of 24 keys at 180 ms gaps is published once, about 5 s after its first key).
- **IR keys outside the prose fast path (punctuation and other structural input):** not within the bound. They never call `schedule()`; they are published with the next fast-path key or by the checkpoint (800 ms + 250 ms): 0.9–1.1 s measured, 0.7–1.8 s in the one instance whose timers ran on a 1 s grid (Q1, Q2).
- **WYSIWYG:** not within the bound. Publication comes only from the checkpoint after the burst: the last key about 2.08 s later on a large document (`undoDelay` 2,000 ms), the first key of a 12-key burst up to 9 s (Q1, Q2). The rule does not act here and WYSIWYG was not rerun at closure.
- **Split View, small document:** within the bound (the throttled spec passes).
- **Split View, large document (about 160 KB):** not within the bound, reason recorded: each key costs a 0.3–0.5 s main-thread task, so a post follows each key by 0.5–0.9 s. The rule improved it from 4.2–5.9 s (debounce starved) to 0.5–0.9 s at 300 and 440 ms gaps without making typing slower.
- **Throttled timers (1 s grid):** every key except the last is published by 50 ms after the next key's input (spec passes in IR prose and Split View, small document); the last key waits for the next timer wake, 250 to 1,250 ms after it (spec limit 1,300 ms).

**Proposed follow-up tasks** (outside this task's scope, not started):
1. Large Split View per-key main-thread work: find which per-key step costs 0.3–0.5 s on a 160 KB document (source spin, preview render or an observer) and reduce it; the publication delay there is bounded by it.
2. A large non-IR timer post that is waiting for a paint is invisible to `flushHistoryInput()` (the pending flag is already clear), so a host update with a new revision can replace the DOM and drop that typing silently. Pre-existing with normal timers; Task 646 added the flush-before-update path that misses it.
Optional third item for Task 602/646 owners: IR keys outside the prose fast path under throttled timers wait up to about 1.8 s; a max-wait was declined (Q2) and can be revisited if the throttling reproduces more often.

### Progress checkpoint (2026-11-01)

S1–S7 done; all four acceptance items proven. Ready to close.
