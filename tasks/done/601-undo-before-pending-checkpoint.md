# Task 601 — Undo/Redo pressed before a pending undo checkpoint lands

**Status:** ✅ DONE (2026-10-07) on `dev`.
**Origin:** found during the Task 598 investigation (2026-09-28).
**Recommended implementer effort:** high.
**Tech stack:** `media-src/src/editing/undo-keybind.ts`, `undo-boundaries.ts`, `edit-activity.ts`, Vitest, Chromium, real VS Code with XTEST.
**Dependencies:**

- **Task 598** must land first. The flush relies on a seeded baseline.
- **Task 602** covers the host coupling; run it after this task. Both touch the history transition.
- Related history: Task 488 (undo checkpoint granularity), Task 463 (undo routing).

**Evidence:** `tmp/task596-603-evidence/t598/results3.json` (scenarios `cur-pending-second-W300`, `cur-pending-second-W700`) and `results2.json` (`flush-*`, the rejected unconditional flush), in the main checkout.

## Problem

This defect is measured in real VS Code on the Task 579 build, IR mode.

Steps:

1. Type `X`.
2. Pause 1.5 s, so `X` gets its own checkpoint.
3. Type `W`.
4. Press Ctrl+Z 300 or 700 ms later, while `W`'s checkpoint is still pending (`undoDelay` 800 ms; the IR prose path delays about 250 ms).

Result:

- The **webview removes both `X` and `W`.**
- The **host keeps `X`**, because native undo reverted only `W`.
- `W` can no longer be redone.
- Webview and host disagree until the next edit.

A Ctrl+Z within about 1 s of any edit with no earlier checkpoint is also a no-op, and the edit stays. This is the same pending-checkpoint window.

## Design

Before running Undo or Redo, record any pending checkpoint, but only when input has arrived since the last one.

1. **Hook points:**
   - the history wrapper in `undo-keybind.ts` (near `:63`, before `original(inner)`);
   - a capture click listener on the toolbar Undo/Redo buttons that runs before `toolbar/Undo.ts`'s disabled check. After the flush, the button may become enabled.
2. **The guard.** Flush only when input has arrived since the last checkpoint. Settle `edit-activity.ts`'s prose delay first, so Vditor has processed the pending input.
   - An unconditional flush was emulated. It recorded spurious entries and cleared the redo stack in IR and SV (`flush-*`). The guard is therefore required.
3. **Ordering.** The checkpoint must be recorded and synced to the host before the history transition is posted, so that Task 602's coupling sees consistent before/after text.

## Owner decisions needed

1. Should an Undo pressed during the pending window undo the pending edit (recommended; the editor convention), or be ignored until the checkpoint lands?

## Tests

- **Vitest** (`undo-keybind.test.ts`, `undo-boundaries.test.ts`):
  - a pending edit is flushed exactly once before Undo;
  - no flush happens without input since the last checkpoint;
  - the redo stack is preserved when nothing is pending;
  - the toolbar-button capture path flushes before the disabled check.
- **Chromium:** type `X`, wait 1.5 s, type `W`, then call `__undo()` 300 ms later. The value is `delta.X`. `__redo()` restores `W`.
- **Real VS Code** (XTEST):
  - The same sequence in IR, WYSIWYG and SV, with Ctrl+Z at 300 and 700 ms. After Undo, the host is exactly `delta.X`. After Redo, exactly `delta.XW`.
  - Webview `getValue()` equals the host after every step.
  - Repeat with the toolbar Undo button and `vmde.format.undo`.

## Execution progress

**2026-10-07, HEAD `db29802b`, Claude Opus 5.5.** Authority: `tmp/queue-part1/601-native-handoff.md` §1–§5, rulings §601.

- **Reconciled with the post-580/597/598 source.** Undo/Redo reach the engine through `trigger-toolbar-hotkey` (message-router calls `invalidateCaret()`, then `inner.undo[name]`), the toolbar buttons, and the shared wrapper `installVditorHistoryCoupling`. The 598 seed (`vmdeSeedBaseline`) cancels the active timer of an empty history. The IR prose path skips the spin and runs it at edit-activity's 220 ms settle (`fence-respin`), so its checkpoint lands about 1 s after the key; WYSIWYG delays publication and checkpoint 800 ms; SV publishes at once and delays only the checkpoint. A drained `addToUndoStack` arms a caret-authority request (Tasks 445/487/553), which the 597 restore must win.
- **Behavioral RED on HEAD:**
  - Chromium, source-patched `undo-boundaries` harness with a new `real=1` mode (edit-activity gate, a 250 ms publication sink, the real history wrapper, and a model of native history: one group per published edit). Type `X`, settle, type `W`, Undo at 300/700 ms: all 6 cases (IR, WYSIWYG, SV × 2) failed with the pending precondition met (W in the DOM, stack not grown, under 800 ms). Probe: IR and SV webview `delta.` but host `delta.X`; WYSIWYG host never received `W` and also lost `X`; Redo restored only `X` (W lost) in all three.
  - jsdom: the toolbar Undo click with a pending first checkpoint did nothing (disabled check) in all 3 modes.
- **Implemented (handoff §2):**
  - `patchAfterRenderRecord` (`media-src/esbuild-shared.mjs`) on `ir/process.ts`, `wysiwyg/afterRenderEvent.ts`, `sv/process.ts`, composed last in each file's registry entry: the timer callback becomes a single-use record `vditor.<mode>.vmdeAfterRender` (`options`, `timer`, `run`); natural expiry runs the same `run`; bodies and flags unchanged. The 598 seed patch retires the record it cancels (one line). Checklist rows added.
  - `undo-boundaries.ts`: `preparePendingHistory(inner)` (late-bound to the installed instance): skip during IME composition or for another instance; IR runs the owning deferred re-spin (`flushPendingEditorRespin`); then `drainPendingCheckpoint` runs the record once only when it was armed by an edit (`enableAddUndoStack && enableInput`) and the live HTML differs from the last checkpoint ignoring the caret marker and IR's expand class; a drain is followed by `invalidateCaret()`; a throwing callback is reported and history proceeds; finally the injected `flushHistoryInput`. A window capture `click` listener prepares for this instance's toolbar Undo/Redo before Vditor's disabled check. `cancelPendingAfterRender` retires the record at every VMDE cancellation (`checkpointUndoBoundary`, the boundary's settle); rewrap's `cancelPendingUndoSnapshot` (emoji, math, rewrap) does too.
  - `undo-keybind.ts`: the wrapper takes `prepare` and calls it before reading `before`.
  - `edit-activity.ts`: `flushPendingEditorRespin(inner)`. `edit-sync.ts`: `flushHistoryInput()` posts only a scheduled edit, through the exact-aware `settleExactInput`, never while suppressed. `finish-init.ts`/`vditor-init.ts` wire them.
- **Deviation accepted by orchestrator ruling 1:** the pending authority is the single-use after-render record plus its flags plus the source-neutral check, not the handoff's separate per-mode input-generation counter. The record exists exactly while an edit's callback is pending (cleared on run, drain, replacement and every cancellation); the flags exclude setValue, mode-switch, stream and history renders; the source-neutral check compares HTML without the caret marker and IR's expand class, so any other difference counts as an edit and it can only miss a no-op (then drained as natural expiry would). Evidence that the guard is load-bearing: with the source-neutral check disabled, the Chromium Redo-preservation case failed in all 3 modes. (The composition handling first recorded here was replaced by ruling 2; see the follow-up below.)
- **Verification:**
  - Vitest focused: `undo-boundaries` (141), `undo-keybind`, `edit-activity`, `edit-sync`, `finish-init`, `rewrap-command`, `vditor-source-patches` (296), `module-boundaries`, `harness-registry`: pass. Changed-line coverage: every changed line and branch of `undo-boundaries`, `undo-keybind`, `edit-activity`, `edit-sync`, `finish-init`, `rewrap-command` covered; `vditor-init.ts:402-403` (the dependency closure, like its `markEditorChange` neighbour) is covered only by real VS Code. The guard is load-bearing: disabling the source-neutral check failed the Redo-preservation case in all 3 modes.
  - Chromium `--workers=1 --retries=0`: Task 601 block 16/16 (300/700 ms × 3 modes, IR pre-settle at 60 ms, the WYSIWYG publication gap with edit posted before the transition, toolbar first-edit in 3 modes, rapid double Undo/Redo, Redo kept after caret moves and source-neutral typing in 3 modes, a real edit retiring Redo). Related set once: 194/195; the failure `undo-restore-caret.spec.ts:135` is a pre-existing repeat flake: with `--repeat-each=6` it failed 4/12 on the candidate and 4/12 with `esbuild-shared.mjs` swapped from HEAD (the harness imports no other changed file); alone it passed 14/14.
  - Real VS Code 1.129.0, `VMDE_XTEST=1`, Xvfb + Openbox without key bindings, `--workers=1 --retries=0`, new `test/vscode-e2e/undo-pending-checkpoint.spec.ts` (15 legs: per mode keyboard 300/700 ms, toolbar, `vmde.format.undo`/`redo`; IR pre-settle chord at 43–47 ms with no callback armed and first-edit toolbar Undo while disabled; WYSIWYG publication gap): run a 3/3, run b 3/3. Every leg proved the pending window at entry; host exact `delta.X` after Undo and `delta.XW` after Redo, webview agreeing, no late version/entry/engine call over 1.5 s, caret after the change, OS `Y` landing, disk unchanged until Save, Save writing the final bytes.
  - Real VS Code regression once: `undo-redo-steps`, `undo-boundaries`, `undo-restore-caret`, `undo-first-edit` (cold Mermaid as its Task 623 expected failure), `list-enter-undo-caret`, `held-drag-undo-snapshot`, `shortcut-identity`, `save-flush-routes`, `noop-check-on-save`, `find-replace`: 28/29; `undo-restore-caret` "IR small document" failed in setup (`createXtestInput`: promise garbage collected, as in Task 598 S4) and passed on rerun.
  - Gates: `typecheck` pass; `typecheck:strict` 15 baseline, none in changed files; `typecheck:vscode-e2e` only `preview-task-checkbox:122`; `lint:ci` clean; `depcruise` clean; `knip` 10 baseline; `jscpd` 6.46% (new small test clones only); `test:coverage` 330 files, 5961 passed + 1 expected fail; `check:coverage-modules` OK (11 at 0%, baseline). `check:bundle-size` main.js 938,657 B (+1,885 B vs HEAD product files; budget already exceeded before, 608 KB); `check:startup-cost` 350 eager modules, unchanged vs HEAD (budget 294, pre-existing).
- **Then open (closed by the follow-up below):** real-VS-Code RED on HEAD, large-fixture and Find legs, IME refusal.

**Follow-up (2026-10-07, same HEAD, orchestrator rulings 1–2).**

- **IME (ruling 2, the handoff's rule):** while `isCompositionActive()`, an Undo/Redo is refused: `preparePendingHistory` returns false and logs `[undo-boundaries] Undo/Redo refused during IME composition` through `logToHost`; the history wrapper then makes no engine call and posts nothing (router branch, command and any engine caller); the toolbar capture stops the click before Vditor's handler. Nothing is queued or replayed after compositionend. Unit RED→GREEN: the new refusal cases (wrapper, engine route, toolbar route) failed 4/4 before the change and pass after. Chromium: a real CDP IME composition, Undo refused (value, stacks, posts unchanged), then after the commit Undo removes the committed text; with the refusal disabled this case failed. Real VS Code IME: not added; the handoff (§3 item 4) places IME and Find exclusions in the smallest appropriate layer, so unit and Chromium evidence is used.
- **Real-VS-Code RED on HEAD:** the 9 changed product files swapped from `git show HEAD:<path>`, rebuilt (bundle without the record patch), the new spec run once, files restored (`cmp` identical) and rebuilt. Result 0/4 tests: every small-document pending leg (IR/WYSIWYG/SV × keyboard 300/700, toolbar, command; IR pre-settle) failed after its pending precondition held. IR and WYSIWYG: the host reached `delta.X` but the webview had lost X too; SV: the host itself returned to the opened bytes. The large-fixture pending leg failed the same way (host `…X`, webview without X). Setup-invalid on HEAD: IR first-edit toolbar (entry found a redo entry). The WYSIWYG publication-gap leg passed on HEAD (the stale transition is skipped and the queued post later publishes the undone text), so it guards ordering but does not discriminate. The large Find leg's first HEAD failure was this spec's own oracle (it compared the webview with the opened bytes); it now compares with the webview's rendering of the opened document.
- **New real-VS-Code legs:** IR keyboard-300 now saves and reopens (host exact, clean, webview agreeing); `ir large fixture` test: the pending journey on the 174 KB Find fixture (Task 597 ruling 6 oracle: expectations from the host text after X), and Undo from the Find input after typing a query (document Undo, Task 603 item 2): nothing drained (0 extra `addToUndoStack`), Find typing published nothing, host back to the opened bytes, Redo by command. The Find input keeps its query; focus moves to the editor with the Undo's caret restore (recorded, not asserted; preparation itself drains nothing there). The publication-gap leg now waits for W's checkpoint inside the page (run c missed its window at 1977 ms with test-side polling).
- **Runs (final build):** new spec run 1: 4/4 (17 legs); run 2: 3/4, the SV test failed in setup at `createXtestInput` (promise garbage collected, before any leg; known), its rerun passed (4 legs). Every leg proved its window: pending callback armed, or for IR pre-settle 43–60 ms with the callback not yet armed. Chromium Task 601 block after the IME change: 17/17.
- **Gates (final tree):** `typecheck` pass; `typecheck:strict` 15 baseline; `typecheck:vscode-e2e` only `preview-task-checkbox:122`; `lint:ci`, `depcruise` clean; `knip` 10 baseline; `jscpd` 6.46%; `test:coverage` 330 files, 5965 passed + 1 expected fail; `check:coverage-modules` OK; changed-line coverage of `undo-boundaries.ts` (153 lines) and `undo-keybind.ts` complete. Task 602 owns native grouping; no host divergence was observed.

## Acceptance

- [x] Undo during the pending window removes only the latest edit, in both webview and host, and Redo restores it. (Real VS Code, IR/WYSIWYG/SV, keyboard 300/700 ms, toolbar and command, plus the large fixture; RED on HEAD, GREEN in the final runs.)
- [x] No spurious checkpoints are recorded, and the redo stack is not cleared when nothing is pending. (Units; Chromium Redo-preservation after caret moves and source-neutral typing in 3 modes; real VS Code stability windows and the large-fixture Find leg.)
