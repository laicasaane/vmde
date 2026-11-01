# Task 685 — Tab stays modified after Undo of an exact action to the saved bytes

**Status:** done (2026-11-02). Filed at the close of Task 673.
**Origin:** Task 673.
**Severity:** low to medium (estimated; the text is correct, only the dirty marker is wrong).
**Tech stack:** `src/writeback/writeback-controller.ts`, `src/writeback/history-coupling.ts`, `src/session/editor-session.ts`, `test/vscode-e2e/exact-action-neutral-bytes.spec.ts`.
**Depends on:** none.

## Problem

Two related gaps around Undo of an exact action (a source transaction such as Source-mode Format Table).

1. **The tab stays modified.** In real VS Code, Source mode opened directly: Format Table, type a character in another paragraph, Undo, Undo. The host text equals the saved bytes again, but the tab still shows as modified. Measured twice:
   - a control without the typing: Format Table, then Undo, host text equals the saved bytes, `isDirty` stays true;
   - eight samples over eight seconds after the second Undo: document version stable (5), `isDirty` true, text equal to the saved bytes, no save events.
   The same setup with plain typing and a single Undo is clean, and so is Undo after a Save that followed the action. The cause is not established (VS Code's saved version is not restored by the Undo of the exact write, or a later own write replaces the undo element; not measured). The behaviour is the same with and without Task 673's change, so it predates it.

2. **Plain-fallback Undo of a neutral exact result.** While an exact write is active (Task 673's `exactWriteSinceBaseline`), the semantic no-op repair is off, so a webview Undo that falls back to a plain write cannot remove a neutral exact result (for example table padding): the document keeps the padding and stays modified. Native history coupling is the normal path and works; the fallback is taken only when the coupling refuses a transition.

## Proposed work

1. Measure why the tab stays modified: log document version, `isDirty` and the undo-stack effect of each own write around the exact write and its Undo (the host-side own writes in `writeback-controller.ts` and `history-coupling.ts`). Decide the smallest change that makes the tab clean once the text equals the saved bytes.
2. Decide how the plain-fallback Undo should remove a neutral exact result, or record why it cannot.
3. Add a real-VS-Code case to `exact-action-neutral-bytes.spec.ts`: Format Table, typing, Undo, Undo ends with the saved bytes and a clean tab.

## Acceptance

- [x] The cause of the modified tab after Undo of an exact action is measured and recorded. Evidence: Part 2 P2-0 probe (the Undo of the action is a forward full-range write, `reason` none, no native step).
- [x] After Format Table, typing, Undo, Undo, the host text equals the saved bytes and the tab is clean. Evidence: real VS Code `exact-action-neutral-bytes.spec.ts` test 2 (dirty poll, Redo, Undo) passes.
- [x] The plain-fallback Undo of a neutral exact result is fixed, or the record states why it cannot be. Evidence: not fixed; reason in the Part 1 provisional decision for gap 2; pinned by editor-session case D.
- [x] Focused real-VS-Code spec written and run; the quality stages pass. Evidence: `exact-action-neutral-bytes.spec.ts` test 2 (clean tab after Undo, Undo; Redo restores the padded table); quality stages pass except the dependency audit, which this run omits.

## Part 1 handoff (2026-11-01)

Source reading only; nothing was built or run in this step. The cause below is a hypothesis with source evidence; Part 2 step P2-0 measures it before any code changes.

### Problem restated

1. In real VS Code, Source mode opened directly: Format Table, typing in another paragraph, Undo, Undo leaves the host text equal to the saved bytes while `isDirty` stays true. The control without typing (Format Table, Undo) behaves the same. Plain typing with one Undo is clean.
2. When native history coupling refuses a transition while the exact-write state of Task 673 is active, the webview's next plain edit keeps the neutral exact bytes (table padding), so the document keeps them and stays modified.

### Root-cause hypothesis

Undo of an exact action never reaches VS Code's native Undo. The webview replays it as a new exact write, which VS Code records as a forward edit, so the saved version is never restored.

Evidence chain:

- Source-mode Undo runs Vditor's `renderDiff`, which calls `execAfterRender` (`media-src/node_modules/vditor/src/ts/undo/index.ts:182-186`). In Source mode that is `processSVAfterRender` (`util/fixBrowserBehavior.ts:451-452`), and it calls `options.input` synchronously (`sv/process.ts:116-117`). This happens inside the history wrapper's `original(inner)` call, before the wrapper posts `history-transition` (`media-src/src/editing/undo-keybind.ts:158-163`).
- VMDE's `input()` checks for a recorded exact history pair (`media-src/src/boot/vditor-init.ts:646-650`). Format Table records one (`media-src/src/editing/table-format-command.ts:422`). `takeRewrapDocumentHistoryReplay` matches it after the Undo and returns `{ exact: beforeExact, before: afterExact }` (`media-src/src/editing/rewrap-command.ts:113-140`). `input()` then posts it with `postExact` (`vditor-init.ts:651-658`; `media-src/src/bridge/edit-sync.ts:1543-1575`).
- The host writes this exact edit through `syncToEditor`'s exact path. The host still holds `before` (the padded table), so the content (the saved bytes) is written as a full-range `vscode.workspace.applyEdit` (`src/writeback/writeback-controller.ts:352-355`, `379-380`, `417-437`, `525-541`). The comment at `writeback-controller.ts:429-430` already treats such replays as forward exact writes ("An exact replay that restores the baseline bytes (Undo)").
- The `history-transition` comes next. It finds the host already at the result, with an `exact` or `base` proof (`src/writeback/history-coupling.ts:98-101`), so no native step runs.
- VS Code clears the modified state only when the text model's alternative version returns to the saved one, which only native Undo/Redo does. A forward edit to the same bytes gets a new version. That fits the measurements: version 5 = open, Format Table, typing, native Undo of the typing, then the forward replay. The version stays stable, `isDirty` stays true and no save runs. Plain typing has no recorded pair, so its Undo goes through the native traversal and is clean. After a Save that follows the action, the saved version is the forward write's own version, so that case is clean too.

Other explanations that P2-0 rules out:

- The `history-transition` arrives first and walks native Undo. That would make the tab clean, which contradicts the measurement. It stays possible only if the order differs from the source reading.
- A second own write lands on top of the action in the native stack. The deferred no-op check is cancelled while the exact state is active (`writeback-controller.ts:433-436`, `661`).

### Shared interfaces and invariants

- The proof rules of Tasks 606 and 607 are never relaxed. The exact INV-B guard stays: an exact edit is written only while the host holds `before`, EOL-normalized (`writeback-controller.ts:317-355`). The coupling's proof set (`history-coupling.ts:219-243`) is unchanged. The new native replay accepts a state only on an EOL-normalized byte match with the replay's exact bytes. That is stricter than the coupling's set because it allows no published, base or semantic proof.
- Native steps stay echo-suppressed (`executeWithoutEcho`), bounded (`MAX_NATIVE_STEPS`), and rolled back with a check of each step when the replay result is not reached (`history-coupling.ts:144-217`). A failed or diverging rollback leaves the document as it is.
- The Task 673 exact-write state (`exactWriteSinceBaseline`) follows the host text after a native replay with the same rules as after an exact apply (`writeback-controller.ts:429-447`). It ends on the baseline bytes and is set again on a Redo that reapplies the action's bytes.
- The edit message protocol only gains an optional field. Old messages behave as today.
- Module boundaries do not change. No public command, setting or storage format changes.

### Intended solution

1. Webview: when `input()` takes a history replay, it posts the exact edit with the replay's direction. `takeRewrapDocumentHistoryReplay` already knows it: `side` changes to `before` for Undo and to `after` for Redo. The direction is returned with the replay and passed through `postExact` options as a new optional message field `history: 'undo' | 'redo'`.
2. Host: `EditorSession.queueEdit` sends an exact edit with `history` to a new `HistoryCouplingController.replayExact(kind, before, exact)` first. That method requires the host to hold `before` (EOL-normalized), as INV-B does. It then walks native history in that direction with the existing traversal and accepts only an exact match with `exact`. On success it marks the text synced and records the published pair, and the session calls a new `WritebackController.noteExactReplay(text)` to update the exact-write state. No forward write runs. On failure it rolls its own steps back and falls through to today's `onEdit` forward exact write, which is unchanged behaviour.
3. Gap 2: no product change. The record states why (see the provisional decision below). One controller Vitest case pins the current behaviour.

### Affected paths

- `media-src/src/editing/rewrap-command.ts`: `takeRewrapDocumentHistoryReplay` also returns the direction.
- `media-src/src/boot/vditor-init.ts`: `input()` passes the direction to `postExact`.
- `media-src/src/bridge/edit-sync.ts` and its deps interface in `media-src/src/boot/finish-init.ts`, if that type is shared: a `history` option on `postExact`, posted on the `edit` message.
- `src/shared/protocol.ts`: optional `history?: 'undo' | 'redo'` on the `edit` message.
- `src/writeback/history-coupling.ts`: `replayExact`.
- `src/writeback/writeback-controller.ts`: `noteExactReplay`.
- `src/session/editor-session.ts`: `queueEdit` routes an exact edit with `history`.
- Tests: `test/backend/history-coupling.test.ts`, `test/backend/writeback-controller.test.ts`, `test/backend/editor-session.test.ts` (if the routing is reachable there), `media-src/src/editing/rewrap-command.test.ts`, `media-src/src/boot/vditor-init.test.ts`, and `test/vscode-e2e/exact-action-neutral-bytes.spec.ts`.

### Part 2 steps

- **P2-0 (measurement, no product change).** Write a scratch `@probe` spec, `test/vscode-e2e/exact-action-undo-dirty-probe.spec.ts`, built on `exact-action-neutral-bytes.spec.ts`'s `formatTable` helper. Positive control: plain typing, then `ctrl+z`; expected result: clean. Measured case: Format Table, then `ctrl+z` (and in a second pass: typing, `ctrl+z`, `ctrl+z`). Record in host order, from a temporary debug hook or the output channel's debug lines, for each `edit` and `history-transition` message the host handles: kind, `exact`, version before and after, `isDirty` after, and the coupling's debug line (`reached the transition result` with steps and proof, or `skipped` or `rolled back`). Run it after `node build.mjs` through the wrapper with `VMDE_XTEST=1 VMDE_PROBES=1`. Decision rule: if the measured case shows an exact edit that is written (version +1) before the transition, and the transition accepts with 0 native steps, the hypothesis holds and P2-1 proceeds. If the transition walks native steps before the exact edit, or the exact edit is `unchanged`, stop and return the measurement for a new plan. If the control is dirty, the instrument is invalid. Delete the probe after recording the result, or keep it tagged `@probe` only if the orchestrator wants it.
- **P2-1 (RED).** Tests:
  - Vitest in `history-coupling.test.ts`: `replayExact` walks one native Undo to the exact bytes and accepts; it refuses when the host does not hold `before`; it rolls back when the exact bytes are not reached and only a semantic match exists.
  - Vitest in `writeback-controller.test.ts`: `noteExactReplay` ends the exact state on the baseline and sets it again on a Redo to the action's bytes.
  - Vitest in `rewrap-command.test.ts`: the replay returns `undo` and then `redo`.
  - Vitest in `vditor-init.test.ts`: the posted exact edit carries `history`.
  - Gap 2 pin: a refused transition while the exact state is active, then a plain edit, keeps the preferred bytes.
  - Real VS Code: a new test in `exact-action-neutral-bytes.spec.ts`, "sv: Format Table, typing, Undo, Undo returns to the saved bytes and a clean tab". It asserts `hostState(ctx).dirty === false` after the second Undo and checks that one Redo brings back the padded table.
  - Expected: the new cases fail; the gap 2 pin passes.
- **P2-2 (GREEN).** Implement the intended solution in the affected product files. Checks: the P2-1 Vitest files (all pass); `node build.mjs`; one wrapper invocation running `exact-action-neutral-bytes.spec.ts` (3 tests), `undo-dirty-probe.spec.ts`, `noop-check-on-save.spec.ts` and the `sv:` test of `exact-authority-other-actions.spec.ts`, all passing.
- **P2-3 (closure).** Update this record (acceptance, verification, residuals) and run the quality stages (`npm run quality`). Run a final review of the diff.

### Edge cases

- Redo after the native replay must reach the padded table natively. The exact-write state is set again.
- The replay `before` does not match the host (an external edit or stale pair). `replayExact` refuses without a native step, and the forward exact write then answers `refused` as today (INV-B).
- The native stack top is not the action write: an intervening own write, or the action combined with typing (Task 607 D3). The exact-only walk passes through it or rolls back, then falls back to the forward write. Do not count on 1 step; use the bound.
- The host already holds the replay bytes (the transition arrived first, as in IR timer order). The existing `unchanged` path is used, with no native step.
- IR and WYSIWYG replays use the same message, so they also become native-first. The Task 607 exact cells and `exact-authority-other-actions.spec.ts` are the regression net.
- The document is saved between the action and its Undo. Native Undo then moves away from the saved version, and the tab becomes modified, which is correct.
- Echo: native steps run with the applying flags set, so the change listener does not repost.

### Focused checks and expected outcomes

- P2-0 probe: the control is clean; the measured case shows the forward exact write and a 0-step transition.
- Vitest (the five files above): the new cases fail at P2-1 and pass at P2-2.
- Real VS Code: `exact-action-neutral-bytes.spec.ts` 3 passed, including the clean tab after Undo, Undo; `undo-dirty-probe.spec.ts` and `noop-check-on-save.spec.ts` pass; the `exact-authority-other-actions.spec.ts` `sv:` test passes (`failed=0`).
- `npm run quality` passes.

### Tier

**Medium.** One mechanism, but the change crosses the webview, the protocol and three host modules, with tests at three layers. A measurement step comes first, so the RED and GREEN steps stay separate.

### Provisional decisions

- Provisional decision (2026-11-01), reversible — fix for the modified tab: replay the Undo or Redo of an exact action through native history first, accepting only an exact match with the replay bytes, and fall back to today's forward exact write. Probability 0.97. Alternatives: run VS Code's revert when the written bytes equal the saved bytes (0.01; it would reread the disk and drop native history); record the limitation without a fix (0.00).
- Provisional decision (2026-11-01), reversible — gap 2 (plain-fallback Undo of a neutral exact result): not fixed; the reason is recorded here. After the decision above, an exact action's Undo goes through native history or an exact forward write, never the plain path. The plain fallback is left only when no recorded pair matches (the 50-entry cap, a mode switch, the callers of Task 684) and the coupling also refuses the transition. In that write the host cannot tell which preferred blocks the Undo meant to drop: IR and WYSIWYG render the padded and unpadded tables the same. Dropping the preference for the whole write would revert other neutral exact results (a Task 673 regression). A forward write cannot make the tab clean anyway. Probability 0.99. Alternatives: drop preferred blocks only where the transition's webview text changed (0.01); drop the preference for the whole fallback write (0.00).
- Provisional decision (2026-11-01), reversible — placement and names: `HistoryCouplingController.replayExact(kind, before, exact)`, `WritebackController.noteExactReplay(text)`, optional `edit` message field `history: 'undo' | 'redo'`, routed in `EditorSession.queueEdit`. Probability 0.94. Alternative: do the native walk inside `WritebackController.syncToEditor` through a native-step callback (0.01).

### Open questions

None for the Owner. P2-0 can invalidate the hypothesis; in that case the step returns its measurement for a new plan instead of continuing.

## Part 2 P2-0 (2026-11-02): probe

**Instrument.** Scratch spec `test/vscode-e2e/exact-action-undo-dirty-probe.spec.ts` (tagged `@probe`, untracked, no product change). It subscribes on the host to `onDidChangeTextDocument` and records, for each event, the document version, `isDirty`, `reason` (1 = native Undo, 2 = native Redo, none = a forward write), the content changes and whether the text equals the saved bytes. Source mode is opened directly; Format Table, typing and `ctrl+z` are driven as in `exact-action-neutral-bytes.spec.ts`.

**Commands.**
- `node build.mjs`: exit 0.
- Through the real-VS-Code wrapper, `VMDE_XTEST=1 VMDE_PROBES=1 npm --prefix test/vscode-e2e test -- exact-action-undo-dirty-probe.spec.ts --workers=1 --retries=0`: exit 0, 3 passed.

**Measured values** (302 characters = saved bytes, 321 = formatted table, 322 = formatted table plus one typed character):

| Case | Step | Version | `reason` | Change | Dirty after | Equals saved |
|---|---|---|---|---|---|---|
| Control | typing | 2 | none | full-range, 302 to 303 | true | no |
| Control | `ctrl+z` | 3 | 1 (native Undo) | full-range, 303 to 302 | **false** | yes |
| Format, Undo | Format Table | 2 | none | full-range, 302 to 321 | true | no |
| Format, Undo | `ctrl+z` | 3 | **none (forward write)** | full-range, 321 to 302 | **true** | yes |
| Format, typing, Undo, Undo | Format Table | 2 | none | full-range, 302 to 321 | true | no |
| Format, typing, Undo, Undo | typing | 3 | none | full-range, 321 to 322 | true | no |
| Format, typing, Undo, Undo | first `ctrl+z` | 4 | 1 (native Undo) | full-range, 322 to 321 | true | no |
| Format, typing, Undo, Undo | second `ctrl+z` | 5 | **none (forward write)** | full-range, 321 to 302 | **true** | yes |

After the second `ctrl+z` there is exactly one change event, with no second event and no native step after it. The final state is version 5, `isDirty` true and text equal to the saved bytes, the same as the earlier measurement.

**Result.**
1. Confirmed: Undo of the exact action reaches the document as a forward full-range write (`reason` none, version +1), not as a native Undo. The control and the Undo of plain typing are native (`reason` 1) and make the tab clean.
2. Confirmed: no native step follows the forward write, so the saved version is never restored and the tab stays modified.
3. Confirmed: the dirty marker is the only wrong value; the text equals the saved bytes after the write.
4. Writer: a host `applyEdit` over the whole document range. The host event stream cannot tell the exact replay (`syncToEditor` exact path, `writeback-controller.ts:379-437`) from a plain fallback write, because both are full-range replaces. The Part 1 chain (the recorded Format Table history pair and `input()` posting the replay) explains the write and is consistent with every value above; this probe does not separate those two writers. The first Undo (of the typing, which has no recorded pair) is native, as the chain predicts.
5. The Part 1 hypothesis is not refuted. The Part 2 plan stays as written; P2-1 should pin the writer with a Vitest case on the webview side (the posted `edit` carries `exact: true`) before the host change.

The scratch spec stays untracked; delete it or keep it tagged `@probe` as the orchestrator decides.

## Part 2 P2-1 (2026-11-02): RED

Tests only. The one non-test edit is the optional field `history?: 'undo' | 'redo'` on the `edit` message type in `src/shared/protocol.ts`. The scratch probe spec was moved out of the test tree (it is not committed).

### Cases and results

Vitest, each file run alone with `npx vitest run --config test/vitest.config.mts <file>`:

| File | Case | Result | Failure line |
|---|---|---|---|
| `test/backend/editor-session.test.ts` | A: exact edit with `history: 'undo'` reaches the replay bytes through native undo, no applied edit | RED | `AssertionError: expected [] to deeply equal [ 'undo' ]` (no native step ran) |
| same | B: unreached walk rolls back with `redo`, posts no update message, then one forward write | RED | `AssertionError: expected [] to include 'undo'` |
| same | B2: a diverging rollback leaves the document as it is, no write | RED | `AssertionError: expected [ '\|a\|b\|\n\|-\|-\|\n\ntail\n' ] to deeply equal []` (today's forward write runs) |
| same | C: `before` not held gives `exact-edit-refused`, no native step | pass now | pins the guard |
| same | A2: host already holds the replay bytes, no native step, no write, no refusal | pass now | pins the unchanged path |
| same | `history` ignored on a non-exact edit | pass now | pins the gate |
| same | D (gap 2 pin): after a refused transition during an exact write, the next plain edit still gets the document bytes as `preferred` | pass now | pins the Task 673 behaviour |
| `test/backend/history-coupling.test.ts` | 10 `replayExact` cases (replayed one and several stops, unchanged, `before` not held, EOL-insensitive, declined and rolled back with no `postUpdate`, semantic-only match refused, command failure, diverging rollback, retained echo pair cleared) | RED | `TypeError: m.controller.replayExact is not a function` (missing symbol) |
| `test/backend/writeback-controller.test.ts` | 5 cases: `noteExactReplay` to the baseline clears the state, to other bytes sets it, EOL-insensitive, cancels the deferred check; `settleOwnWrites` waits and cancels | RED | `TypeError: ctrl.noteExactReplay is not a function`, `ctrl.settleOwnWrites is not a function` (missing symbol) |
| `media-src/src/editing/rewrap-command.test.ts` | `takeRewrapDocumentHistoryReplay` names `history` `'undo'` then `'redo'` | RED | `AssertionError: expected { exact: 'before exact\n', …(1) } to match object { exact: 'before exact\n', …(2) }` |
| `media-src/src/boot/vditor-init.test.ts` | `input()` posts the replay with `history: 'undo'` | RED | received `{ before: 'after exact\n', rollback: false }`, expected `ObjectContaining { before, history: 'undo' }` |

Real VS Code, `test/vscode-e2e/exact-action-neutral-bytes.spec.ts`, test 2 extended (poll `dirty === false` after the Undo of the action, one Redo with `ctrl+y` bringing back the padded table and a modified tab, one more Undo; the stale comment about a tab that can stay modified is replaced):
- `node build.mjs`: exit 0.
- Wrapper, `VMDE_XTEST=1`, `--workers=1 --retries=0`: exit 1, 1 failed, 1 passed (test 1 passes).
- Failure line: `Error: the tab is clean after Undo of the action to the saved bytes` with `Expected: false`, `Received: true`. It fails by assertion on the dirty marker, after the text assertion has passed.

`npx biome check` on the seven changed files: clean.

### Corrections for P2-2

1. `replayExact` must not reuse `traverse()` unchanged. On refusal or rollback it posts no `postUpdate` and does not `accept`. Its only proof is EOL-normalized byte equality with `exact`. On success it calls `markSynced(current)` and sets `pending = undefined`. It returns `'replayed' | 'unchanged' | 'declined'`. A host already equal to `exact` gives `'unchanged'` with no native step, checked before the `holdsBefore` test. `history` counts as present only when `exact === true`, `history` is `'undo'` or `'redo'`, and `before` and `content` are strings. A thrown `replayExact` falls through to `onEdit`.
2. Before it reads the host and walks, the session settles the writeback chain and cancels the deferred no-op check (one `WritebackController.settleOwnWrites()` doing `await this.applyChain` and `cancelDeferredNoopCheck()`). `noteExactReplay(text)`: text equal to the clean baseline (EOL-normalized) clears the exact-write state, otherwise sets it; then it cancels the deferred no-op check.
3. The native route in `queueEdit` sits after `refuseStaleEdit` and `consumeEdit`. It still runs `finishEditPerf(perfId, 'complete')` and `recordPublished(...)`.
4. Webview: post `history` conditionally (`...(opts?.history ? { history: opts.history } : {})`) so existing exact-post fixtures stay green. Only `PostExactOptions` (`edit-sync.ts:124`) gains `history`; `finish-init.ts` and `main.ts` need no change. The `takeRewrapDocumentHistoryReplay` result gains `history` (`'undo'` on the Undo branch, `'redo'` on the Redo branch); `takeRewrapDocumentHistorySync` stays unchanged. Add one header-comment line in `webview-message-shape.ts` (near lines 29-31) that `history` is deliberately not in the shape table.

## Part 2 P2-2 (2026-11-02): GREEN

### Changes

- `media-src/src/editing/rewrap-command.ts`: the replay result names `history` (`'undo'` on the Undo branch, `'redo'` on the Redo branch). `takeRewrapDocumentHistorySync` is unchanged.
- `media-src/src/boot/vditor-init.ts`: `input()` passes `history` to `postExact`.
- `media-src/src/bridge/edit-sync.ts`: `PostExactOptions.history`; the `edit` message carries `history` only when given, so existing exact posts are unchanged.
- `src/webview-host/webview-message-shape.ts`: one header-comment line saying `history` is deliberately not in the shape table.
- `src/writeback/history-coupling.ts`: `replayExact(kind, before, exact)` returns `'replayed' | 'unchanged' | 'declined'`. Its own exact-only walk: EOL-normalized equality with `exact` is the only proof, the host must hold `before`, steps are bounded by `MAX_NATIVE_STEPS` and rolled back with checks. It posts no update, does not `accept`, and on success calls `markSynced` and clears `pending`. `traverse` is unchanged.
- `src/writeback/writeback-controller.ts`: `settleOwnWrites()` and `noteExactReplay(text)`, as in the corrections.
- `src/session/editor-session.ts`: `replayExactNatively` runs in `queueEdit` after `refuseStaleEdit` and `consumeEdit`. It requires `exact === true`, `history` `'undo'` or `'redo'`, and string `before` and `content`. On `'replayed'` or `'unchanged'` it calls `noteExactReplay`, finishes the perf record and records the published pair; on `'declined'` or a throw it falls through to `onEdit`.

### Deviation from the corrections

`settleOwnWrites` also waits for `syncToEditor` calls still running, not only `applyChain`: a sync arms the deferred no-op check after its write lands, which is after the chain resolves, and the P2-1 test requires the check to be cancelled. To do this `syncToEditor` is now a thin wrapper around `syncToEditorOnce` (the previous body, unchanged) that counts calls in flight; waiters are allocated only when `settleOwnWrites` runs. No P2-1 expectation was changed.

### Commands and results

- The five P2-1 Vitest files, each alone: `editor-session` 177 passed, `history-coupling` 48 passed, `writeback-controller` 49 passed, `rewrap-command` 31 passed, `vditor-init` 32 passed. Also `media-src/src/bridge` and `module-boundaries`: 9 files, 508 passed.
- `npx biome check` on the 14 changed TypeScript files: exit 0.
- `npx tsc -p . --noEmit`: exit 0. `npm run typecheck` and `npm run typecheck:vscode-e2e`: no output, no errors.
- `node build.mjs`: exit 0.
- Real VS Code, one wrapper invocation (`VMDE_XTEST=1`, `--workers=1 --retries=0`) of `exact-action-neutral-bytes.spec.ts`, `undo-dirty-probe.spec.ts`, `noop-check-on-save.spec.ts` and `exact-authority-other-actions.spec.ts` with a `-g` filter: exit 0, 8 passed (neutral bytes 2, authority ir 26 cells, wysiwyg 20, sv 8 with `failed=0`, no-op check 2, undo-dirty 1). The `-g` filter also let the ir and wysiwyg authority tests run.

### Residual risks

- IR and WYSIWYG replays of exact actions now also take the native-first route; the ir and wysiwyg authority cells passed, but other exact-action specs were not rerun.
- If native history cannot reach the replay bytes, the forward write remains and the tab stays modified (gap 2, unchanged).

## Part 2 R1 (2026-11-02): review repair

| # | Change | Test | RED evidence |
|---|---|---|---|
| 1 (major) | `replayExact` returns a fourth result `'diverged'` when the walk does not reach `exact` and the rollback could not restore `before`; it clears `pending`. `replayExactNatively` then awaits `docSync.postUpdate()` and returns `'resynced'` (no forward write; `queueEdit` records no published pair for it). Doc comment corrected: a decline posts no update only when the rollback restored `before`. | `editor-session.test.ts` B3 (an update with the host text is posted, no write); `history-coupling.test.ts` (`diverged` versus `declined`) | With the change reverted: B3 fails and the `diverged` case fails (`expected 'declined' to be 'diverged'`). |
| 2 (minor) | `settleOwnWrites`: cancel the deferred check, await `applyChain`, wait for syncs in flight, await `applyChain` again, cancel again. | `writeback-controller.test.ts` (the check must not restore the baseline over a write held across the idle window) | With the first cancel removed: the case fails. |
| 3 (minor) | On `'replayed'`, `pending = { webviewContent: exact, hostContent: now }`, like `accept()`. | `history-coupling.test.ts` (a later plain echo of the same content is consumed) | With `pending = undefined`: the case fails. |
| 4 (minor) | `queueEdit` calls a synchronous guard (`startNativeReplay`: `exact === true && history !== undefined`) so a plain keystroke takes no extra async frame; the `typeof` checks stay in `replayExactNatively`. | covered by the existing plain-edit cases | not reachable by a test |

Changed P2-1 expectations, because they asserted the behaviour the findings replace: in `history-coupling.test.ts`, "stops mutating, with no update, when the rollback diverges" now expects `'diverged'` (was `'declined'`), and "clears the retained echo pair on success" became "keeps the echo proof on success" (finding 3). The editor-session B2 expectation (no write, text unchanged) still holds and was not edited.

Commands:
- Vitest alone: `editor-session` 178, `history-coupling` 50, `writeback-controller` 50, `rewrap-command` 31, `vditor-init` 32, all passed.
- `npx biome check` on the 14 changed TypeScript files: exit 0 (a complexity error in `queueEdit` was fixed by the `startNativeReplay` helper). `npx tsc -p . --noEmit` and `npm run typecheck`: no errors. `node build.mjs`: exit 0.
- Real VS Code, one wrapper call (`VMDE_XTEST=1`, `--workers=1 --retries=0`) of `exact-action-neutral-bytes`, `undo-dirty-probe`, `noop-check-on-save`, `undo-host-coupling`, `list-normalize-history`, `turn-into-undo-step`, `undo-redo-steps`: exit 0, 17 passed in 30.5 minutes.

## Closure (2026-11-02)

- Quality stages on the GREEN candidate: brand identifiers, lint, knip, jscpd, depcruise, unit coverage and the coverage-module ratchet pass; the dependency audit fails and is omitted in this run.
- After the review repair: lint and knip exit 0; the full unit suite passes (384 files; 8464 tests passed, 1 expected failure).
- Real VS Code after the repair, one run: `exact-action-neutral-bytes`, `undo-dirty-probe`, `noop-check-on-save`, `undo-host-coupling`, `list-normalize-history`, `turn-into-undo-step`, `undo-redo-steps`: 17 passed. Earlier, `exact-authority-other-actions` IR, WYSIWYG and SV cases passed with no failed cells.
- Two independent reviews of the diff. The first found a rollback result that was dropped and three smaller issues; all were fixed with failing tests first (Part 2 R1). The second accepted the repaired diff.
- Scope note: every exact action whose Undo or Redo is replayed from the recorded history (Format Table, list numbering, Turn Into, link and selection actions) now steps VS Code's own history first and falls back to the forward write when the exact bytes are not reached.

### Residuals (minor, not fixed)

1. The native walk is not serialized against writes outside the edit chain: a save right after Undo, or a deferred no-op check armed after the settle, can land between native steps. The rollback then reports a divergence and the webview is resynced; no text is lost. The same exposure exists in the history-transition walk. Possible fix: run the walk and its rollback inside the writeback chain.
2. When the host already holds the exact bytes, the replay returns without marking the content as synced, while the old exact path did. A stale synced marker can skip the webview flush before save. Possible fix: mark the content synced before returning.
3. Native `undo` and `redo` act on the focused editor. If the user switches tabs while the replay waits for its own writes to settle, the walk may act on another document. Possible fix: check that this editor is still active before each step.

