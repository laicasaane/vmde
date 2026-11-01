# Task 674 — Callout apply: native Undo is a no-op in real VS Code

**Status:** done (2026-11-01).
**Origin:** Task 671 (decision of 2026-11-01), Owner decision of 2026-10-08 (a failure with a different mechanism gets its own record).
**Severity:** medium (estimated; measured in real VS Code, IR and WYSIWYG).
**Tech stack:** `media-src/src/editing/callouts.ts`, `test/vscode-e2e/exact-authority-other-actions.spec.ts`.
**Depends on:** Task 671.

## Problem

After a callout apply on a document, the host text, the saved file and Save are exactly right. A native Ctrl+Z then leaves the host text unchanged (it still equals the action result), and Redo leaves it unchanged too. One native Undo should restore the typed state and Redo should reapply the callout.

Measured in the `callout-apply` case (a unique paragraph on the normalizing fixture) and the `callout-duplicate-line` case of `exact-authority-other-actions.spec.ts`, in IR and WYSIWYG. It fails the same way on the product code from before Task 671's proof-path change and after it, so that change is not the cause.

The Details toggle on the same fixture passes the same Undo check. It uses the same action dependencies (exact-authority acquisition, guarded exact post, applying flag in `boot/main.ts`) and the same Undo checkpoints (`addToUndoStack` before `setValue` and after the marker is removed).

## Candidate causes (not tested)

- The callout apply places its caret through a deferred `requestCaret` (an armed caret intent). The Details toggle retires the intent and writes the selection directly.
- The callout dual-node observer re-renders the block quote after `setValue`, which may move the native Undo state.
- The action runs from the callout toolbar panel, and focus returns to the editor afterwards.

## Proposed work

Find the cause with a focused real-VS-Code probe that compares the callout apply with the Details toggle (native Undo state after the action, caret intent, dual-node re-render), then fix it in the callout apply path.

## Acceptance

- One native Undo restores the typed state and Redo reapplies the callout, in IR and WYSIWYG, for `callout-apply` and `callout-duplicate-line`.
- Remove the `knownUndoFailure: 'Task 674'` flag from both cases in `exact-authority-other-actions.spec.ts`. The flag makes an unexpectedly passing Undo fail the case, so it must be removed with the fix.
- [x] One native Undo restores the typed state and Redo reapplies the callout, in IR and WYSIWYG, for `callout-apply` and `callout-duplicate-line` (real-VS-Code run below).
- [x] The `knownUndoFailure: 'Task 674'` flags are removed from both cases, together with the known-failure mechanism.
- [x] Focused real-VS-Code spec written and run; quality stages pass (audit omitted; bundle size reported below).

## Part 1 handoff (2026-11-01)

**Tier: Heavy.** One product line in `callouts.ts`, a Vitest case in two modes and the spec flag removal.

### Measured cause

A scratch real-VS-Code probe (untracked, `tmp/674/probe/undo.probe.ts`, three runs on `9c0259f7`, IR and WYSIWYG, normalizing fixture) wrapped Vditor's `addToUndoStack`, `undo` and `redo` and the webview's history posts. It also tracked the active mode's after-render record (`vmdeAfterRender`) and which `clearTimeout` retires it.

- Callout apply records its two checkpoints (`callouts.ts:595` before `setValue`, `:632` after the marker is removed). `outer.setValue` also arms Vditor's delayed after-render record (`enableAddUndoStack` on, `enableInput` off). About 800 ms later that record calls `addToUndoStack` and pushes a third entry. The entry has the same source and a different caret: after it, the last history text equals the live editor HTML once caret markers are removed (IR: stack 4 to 5; WYSIWYG: 5 to 6).
- The first native Undo pops that caret-only entry. The text does not change, so the webview posts no `history-transition` and the host keeps the action result. A second Undo restores the typed state in both modes. This is the measured failure.
- Details toggle passes only because of how it is started. Its real toolbar click runs the undo-boundaries click boundary (`onClick`, `isToolbarAction`). That boundary's `setTimeout(0)` calls `cancelPendingAfterRender` (`undo-boundaries.ts:530`) right after the synchronous Details transaction. The probe saw the record cleared at the same moment it was armed (stack: `undo-boundaries.ts:134` from `:530`). The callout Apply is a button in the callout panel, not a toolbar action, so no boundary retires the record.
- Candidates from the record: the deferred `requestCaret` is not the cause. It only moves the caret, and the leftover record turns that caret move into an entry. With the record retired, the deferred caret causes no entry. The dual-node re-render and the panel focus change add no history entry (no other `addToUndoStack` calls were observed).
- Emulated fix in the same probe: retire the pending record just before the `:632` checkpoint. Then one Undo restores the typed state and Redo reapplies the callout, in IR and WYSIWYG.

### Shared interfaces and invariants

- `checkpointEditorUndo(inner)` (`rewrap-command.ts`) restores any suppressed delayed snapshots, cancels the active mode's pending after-render record (`cancelPendingUndoSnapshot`: clears `ir.processTimeoutId`, `wysiwyg.afterRenderTimeoutId` or `sv.processTimeoutId` and retires `vmdeAfterRender`), then records one checkpoint. Outline `applyLocal` (`boot/main.ts`), table format, Insert ID, HTML subscript and block transform already use it after `setValue`.
- Unchanged: the pre-`setValue` checkpoint (`:595`), the SV branch, the deferred `requestCaret`, the guarded exact post with rollback, the applying flag window, and every caret primitive (`caret.ts`, `util/selection-write.ts`) and `undo-boundaries.ts`. Task 683 shares those caret primitives and `undo-boundaries.ts`; this task touches none of them.
- Source fidelity: the posted exact text and the rendered result do not change; only the history entries change.

### Decisions

- **Provisional decision (2026-11-01), reversible — fix shape.** In `runCalloutAction` (IR and WYSIWYG branch), replace the after-`setValue` checkpoint `inner.undo?.addToUndoStack?.(inner)` (`callouts.ts:632`) with `checkpointEditorUndo(inner)`, imported from `./rewrap-command` (already imported there), with a comment that names the caret-only entry and Task 674. Other options were rejected. Disarming only the entry is not the pattern other actions use after `setValue`. A Details-like direct selection write would still leave the record armed. A boundary on the panel Apply click would change shared undo-boundaries behaviour. Evidence: the probe above. Selected by a recorded decision check (probability 1.0 against 0 for disarming the entry, 0 for a direct selection write and 0 for a panel boundary).
- **Provisional decision (2026-11-01), reversible — spec flag.** Remove the two `knownUndoFailure: 'Task 674'` flags and the whole known-failure mechanism: the `Scenario` field and its comment, the flag branch in `actionAfterTyping` (back to `check(undoRestores, 'one Undo does not restore the typed state')`) and the `expectedFailure` spread in the returned evidence. No other scenario, including Task 675's Source scenarios, uses it. Selected by a recorded decision check (probability 0.98 against 0.02 for removing only the flags).
- **Provisional decision (2026-11-01), reversible — Vitest location.** `media-src/src/editing/callouts.test.ts`, describe `callout action exact authority (Task 630)`. Its `harness` gains an optional mode parameter (default `'ir'`), and its mocked `setValue` arms a Vditor-like after-render record. A new case loops over IR and WYSIWYG. Selected by a recorded decision check (probability 0.78 against 0.16 for `rewrap-non-round-trip.test.ts` and 0.04 for IR only).
- Public names, numbering and storage formats: none are added or changed.

### Acceptance map

| Acceptance item | Layer | File | Test |
|---|---|---|---|
| One native Undo restores the typed state and Redo reapplies, IR and WYSIWYG, `callout-apply` and `callout-duplicate-line` | Real VS Code | `test/vscode-e2e/exact-authority-other-actions.spec.ts` | `${mode}: each action after a typed character changes only its span, Undo restores the typed state and Save writes the result` (cases `callout-apply`, `callout-duplicate-line`; IR and WYSIWYG tests) |
| Same item, unit level (the record is retired, no caret-only entry) | Vitest | `media-src/src/editing/callouts.test.ts` | `%s: Task 674 callout apply retires the after-render history entry its setValue armed` |
| Remove the `knownUndoFailure` flag from both cases | Real VS Code (same run) | same spec | the two cases pass with the plain Undo check; `rg -n "knownUndoFailure\|Task 674" test/vscode-e2e/exact-authority-other-actions.spec.ts` prints nothing |
| Focused real-VS-Code spec written and run; quality stages pass | Gates | — | the wrapper run below; quality stages except audit (see the common rules) |

### Edge cases

| Edge case | Cheapest layer | Test |
|---|---|---|
| WYSIWYG timer field (`afterRenderTimeoutId`) | Vitest | the `%s` loop above (wysiwyg) |
| Redo after the fixed Undo reapplies the callout | Real VS Code | the spec's Redo check (it already runs; with the fix it is no longer trivially true) |
| Rollback on a stale host still restores the Undo stacks | Vitest (existing) | `refuses a stale host: no write, the rollback runs and the DOM shows the host text` |
| Declined apply (no `setValue`) records no checkpoint | Vitest (existing) | `declines without a write or a DOM change when acquisition fails` |
| SV callout apply unchanged | Vitest (existing) | existing SV cases in `callouts.test.ts` stay green |
| Details toggle unchanged | Real VS Code (same run) | `details-toggle`, `details-duplicate-line` cases |

### Part 2 steps

**P2-S1 (RED).** Owned files: `media-src/src/editing/callouts.test.ts`, `test/vscode-e2e/exact-authority-other-actions.spec.ts`.

- Vitest: add `mode: 'ir' | 'wysiwyg' = 'ir'` to `harness`. Use `createRealLute(mode)`, set the root class to `vditor-${mode}`, and place the owner under `vditor[mode]`. In the mocked `setValue`, after rendering, arm a record the way the patched Vditor does: `owner.vmdeAfterRender = { options: { enableAddUndoStack: true, enableHint: false, enableInput: false }, timer, run }`, with `timer = setTimeout(run, 800)` stored in `ir.processTimeoutId` or `wysiwyg.afterRenderTimeoutId`, and `run` calling `addToUndoStack`. Add `it.each(['ir', 'wysiwyg'])('%s: Task 674 callout apply retires the after-render history entry its setValue armed', ...)`. Under fake timers it runs the apply, advances 1000 ms, and expects `addToUndoStack` called exactly twice and `owner.vmdeAfterRender` undefined. If the WYSIWYG harness needs more than a mode switch, report Partial and keep IR.
- Spec: remove the mechanism as decided (two flags, the field and its comment, the flag branch, the `expectedFailure` spread). Apply on the tree after Task 675 is integrated; Task 675 does not touch these lines.
- Checks: `npx vitest run --config test/vitest.config.mts media-src/src/editing/callouts.test.ts` exits 1. The two new cases fail (three `addToUndoStack` calls, or the record still set); the other 37 pass. Real VS Code is not run at RED (the spec failure is already measured: `one Undo does not restore the typed state`).

**P2-S2 (GREEN).** Owned file: `media-src/src/editing/callouts.ts`.

- Replace `inner.undo?.addToUndoStack?.(inner)` at `:632` with `checkpointEditorUndo(inner)` and add the import to the existing `./rewrap-command` import. The comment says what it fixes (Vditor's `setValue` arms a delayed after-render record that would add a caret-only entry once the deferred caret moves, so the first native Undo did nothing), why (the panel Apply has no undo boundary to retire it), and how. Use `grep -a`: the file contains a NUL byte.
- Checks: the same Vitest command exits 0 (39 tests). Then `timeout 900 node build.mjs`, then one wrapper run: `env -u ELECTRON_RUN_AS_NODE xvfb-run -a sh -c 'openbox & OB=$!; VMDE_XTEST=1 npm --prefix test/vscode-e2e test -- exact-authority-other-actions.spec.ts --workers=1 --retries=0; R=$?; kill $OB; exit $R'`. Expected: exit 0; every case of the IR and WYSIWYG action tests passes with `undo.equalsReference: true` and `redo.equalsActionResult: true` for both callout cases. Task 675's Source test and the stale-host tests also pass.

**P2-S3 (closure).** Quality stages except audit: `npm run lint`, knip, jscpd, dependency-cruiser, unit coverage and the zero-coverage ratchet, as DEVELOPMENT.md lists them. Then the task record, the completion report and one decision gate on the final diff.

### Residuals

- Not measured: Details toggle started from a host command or keybinding (no toolbar click) may leave the same record armed. Its pass in the spec depends on the toolbar click boundary. This is outside this task's scope; it is a candidate follow-up.
- The SV branch of callout apply is unchanged and not measured (SV has no callout case in the acceptance).

## Verification (2026-11-01)

Product change: `runCalloutAction` (IR and WYSIWYG branch) records its after-rewrite checkpoint with `checkpointEditorUndo(inner)`, which first cancels the delayed after-render record that `setValue` armed. Tests: two Vitest cases in `callouts.test.ts` (IR and WYSIWYG, `Task 674 callout apply retires the after-render history entry its setValue armed`; RED before the fix with the armed record still set, GREEN after); the spec no longer has the `knownUndoFailure` mechanism.

| Check | Result |
|---|---|
| `npx vitest run --config test/vitest.config.mts media-src/src/editing/callouts.test.ts` | RED: 2 failed, 37 passed. GREEN: 39 passed |
| Real VS Code, `exact-authority-other-actions.spec.ts -g "each action after a typed character"` (IR, WYSIWYG, Source) | exit 0, 3 passed; IR 26, WYSIWYG 20, Source 8 cases, 0 failed; the four callout cases have `undo.equalsReference` and `redo.equalsActionResult` true |
| `check:brand-identifiers`, `lint:ci`, `typecheck`, `typecheck:vscode-e2e`, `knip`, `jscpd`, `depcruise` | all exit 0 |
| `test:coverage` | exit 0; 384 files, 8399 tests passed, 1 expected fail |
| `check:coverage-modules` | exit 0; ratchet OK, 9 modules at 0% (baseline 9) |
| `check:bundle-size` (reporting only) | `media/dist/main.js` 1095 KB against a 608 KB budget: over budget; this change adds one import and a comment, and the unchanged tree was not re-measured; not addressed here |
| dependency audit | omitted by the queue rules |

## Residuals

- Details toggle started from a host command or keybinding (no toolbar click) may leave the same armed record; not measured, outside this task.
- Callout apply in Source mode is unchanged and not measured.
