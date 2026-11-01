# Task 673 — Plain-write baseline keeps exact-action bytes

**Status:** done (2026-11-01).
**Origin:** Task 668 (the D6 probe), Task 630 decision (5).
**Severity:** low to medium (estimated; confirmed only at unit level).
**Tech stack:** `src/writeback/writeback-controller.ts`, `src/markdown/minimal-diff-writeback.ts`, `test/vscode-e2e/exact-action-neutral-bytes-probe.spec.ts`.
**Depends on:** Task 669 (the SV table-format write must work before the live probe can measure anything).

## Problem

A plain write is minimized against the disk baseline (`cleanBaseline`, set only at open and at save). An exact action that leaves semantically neutral bytes (for example table-format padding) therefore has those bytes reverted by the next typing elsewhere in the document: the minimizer keeps the original bytes of every block whose reserialization equals the editor's output.

What Task 668 measured:

- Deterministic unit check (pinned Lute, the probe fixture): the table formatted by Lute's formatter, one character typed in another paragraph, then `minimalDiffWriteback(original, typed, reserialize)`. The result keeps the original table bytes and drops the padding.
- Nothing in `writeback-controller.ts` shields it: `exactTransactionContent` is cleared by every plain sync, and `cleanBaseline` is reset only at open and save.
- The live probe could not measure it. The probe ran once with `VMDE_PROBES=1` and its instrument was invalid (the action never changed the host text): SV `vmde.formatTable` is a no-op on the current base (`table-format.spec.ts:12` fails), which Task 669 owns, and the probe's `endSelectionGesture` presses Shift, whose keydown clears the retained SV selection the command needs.

## Proposed work

1. After Task 669 repairs the SV table-format write, fix the probe instrument (no Shift key press before the command; keep the selection by other means) and run it once. Record the live result.
2. If the revert is confirmed live, decide how the plain-write baseline should treat bytes written by an exact action (for example advancing the baseline after an applied exact write, keeping the undo-to-clean behaviour of Tasks 61 and 434), then fix it with unit tests and a real-VS-Code spec.
3. If it is not confirmed live, record why the unit-level mechanism does not occur in the editor and close.

## Acceptance

- [x] The live probe result is recorded with a valid instrument. Direct Source open and a `selectionchange` event, no Shift key press. Before the fix: Format Table changed the host (302 to 321 characters), one typed character in another paragraph gave exactly the original text plus the character (padding reverted), and it stayed reverted after the deferred no-op check. After the fix: typing keeps the action result (`typingKeptActionResult: true`), also after Save.
- [x] Typing after an exact action never reverts that action's neutral bytes, while the exact result is active. Real VS Code `exact-action-neutral-bytes.spec.ts` test 1 (typing, deleting the typed text past the idle check, typing and Save); Vitest cases for the minimizer (pinned Lute) and the controller.
- [ ] Undo back to the saved state still makes the tab clean — met for Undo to a saved state after a Save that follows the action (test 2: Undo of the typing, Undo of the action to the saved bytes, Save, typing, Undo gives the saved bytes and a clean tab; `undo-dirty-probe.spec.ts` and `noop-check-on-save.spec.ts` pass). Not met: Undo of the exact action itself to the saved bytes leaves the tab modified although the text equals the saved bytes. Measured on unfixed code (control without typing: dirty after Undo) and with the fix (version stable, `isDirty` true, no save events), so it predates this task. Filed as Task 685.
- [x] Focused real-VS-Code spec written and run (`exact-action-neutral-bytes.spec.ts`, 2 tests, plus the repaired probe); the quality stages pass (see Verification).

## Part 1 handoff (2026-11-01)

### Live result (scratch probe, valid instrument)

A scratch copy of the probe ran once in real VS Code (untracked, `tmp/673/probe/`). Instrument: the file is opened straight in Source mode (`vmde.editor.defaultMode` = `sv`, the shape Task 675 adds to the kit as `openDocument(..., { direct: true })`), the caret is placed programmatically and a `selectionchange` event retains it (Task 675's `runSvCommand` pattern), and no Shift key is pressed before the command.

- Format Table reached the host (302 to 321 characters).
- One typed `x` in another paragraph produced exactly the initial text plus `x`: the padding was reverted. It was still reverted 3 s later, after the deferred no-op check. The revert is live.
- Control, plain typing then native Undo: the host returns to the disk bytes and the tab is clean.
- Control, Format Table then native Undo (no typing): the host does not change. Undo of the SV table command itself is a separate, existing failure; Task 675 is changing how SV commands record history. It is outside this task.

### Root cause

`WritebackController.syncToEditor` minimizes every plain write against `cleanBaseline` (set only at open and save). `minimalDiffWriteback` keeps an original block whenever `reserialize(original) === newBlock`, and Lute's canonical form of the unformatted table equals the formatted table, so the baseline's unpadded bytes win. `exactTransactionContent` is cleared by every plain sync and is read only by `checkNoopOnWillSave`. A second path also reverts: after an exact action, typed-then-deleted text is a semantic no-op against `cleanBaseline`, so the deferred check (`resolveNoopCheck`) and the will-save check would restore the baseline bytes.

Undo is coupled to VS Code's native history (Task 602, `history-coupling.ts`); a native Undo to the saved version makes the tab clean without the minimizer. The minimizer and the no-op restore matter on the plain-edit fallback path only.

### Intended solution

- Private field `exactWriteSinceBaseline: boolean` in `WritebackController` replaces `exactTransactionContent`. It is set when an exact write is applied and the host holds its content; `setCleanBaseline` clears it. Plain syncs no longer clear it.
- `minimalDiffWriteback(original, next, reserialize, preferred?)` gets an optional fourth argument, the current host text. Per editor block, in order: (1) a whole-block match in `preferred` keeps the host bytes; (2) otherwise a whole-block match in `original` keeps the baseline bytes; (3) otherwise an edited table merges against the aligned table of `preferred` when given (else of `original`, as today); (4) otherwise the editor block. Each source keeps its own in-order cursor. The trailing-newline shape comes from `preferred ?? original`. Without `preferred` the function behaves exactly as today.
- `syncToEditor` passes the current host text as `preferred` only while `exactWriteSinceBaseline` is set. While it is set, the deferred no-op check is not armed (and `resolveNoopCheck` returns early), and `checkNoopOnWillSave` returns no edits.
- No public API, protocol, setting or storage change. Documents with no exact write since open or save behave as today.

### Provisional decisions

- Provisional decision (2026-11-01), reversible — instrument: direct Source open through the kit's `direct` option from Task 675 plus a `selectionchange` event after the caret placement, no Shift key press. Settled by evidence: the scratch probe with this instrument changed the host and measured the revert.
- Provisional decision (2026-11-01), reversible — the revert is live (measured above), so the task fixes it.
- Provisional decision (2026-11-01), reversible — baseline design: prefer the current host block bytes over the clean baseline while an exact write has been applied since open or save, and skip the semantic no-op restore in that state; selected by a recorded decision check (probability 0.92; storing the exact text as the minimization reference 0.04, the version-invalidated reference 0.01, always preferring host bytes 0.00). The stored reference was rejected because, after a native Undo past the action in IR mode, the next typing would re-insert the undone bytes.
- Provisional decision (2026-11-01), reversible — names: private field `exactWriteSinceBaseline`; optional fourth parameter `preferred` of `minimalDiffWriteback`. No public names, numbering or storage formats change.
- Provisional decision (2026-11-01), reversible — Undo-to-clean is proved by native Undo of plain typing and by Save, typing and Undo after the action. Undo of the SV Format Table itself is out of scope (Task 675).

### Acceptance to tests

1. Live probe with a valid instrument: `test/vscode-e2e/exact-action-neutral-bytes-probe.spec.ts` repaired (direct Source open, `selectionchange`, no Shift) and run once with `VMDE_PROBES=1`; its outcome line is recorded here.
2. Typing never reverts the neutral bytes:
   - real VS Code, new `test/vscode-e2e/exact-action-neutral-bytes.spec.ts`, test "sv: typing after Format Table keeps the table padding, also after typed text is deleted";
   - Vitest `test/backend/minimal-diff-writeback.test.ts`, describe "minimalDiffWriteback preferred host source (Task 673)" with pinned Lute;
   - Vitest `test/backend/writeback-controller.test.ts`, describe "WritebackController after an exact write (Task 673)".
3. Undo back to the saved state makes the tab clean: the new spec's test "sv: after Format Table, Undo of later typing returns to the action result, and Undo to the saved state is clean"; regression runs of `undo-dirty-probe.spec.ts` and `noop-check-on-save.spec.ts`.
4. Focused real-VS-Code spec written and run; quality stages lint, knip, jscpd, depcruise, unit coverage and the coverage-module check pass (audit is not run in this queue).

### Edge cases and cheapest layer

- Typing in another block after the action keeps the padding: Vitest (pinned Lute) and real VS Code.
- Typing then deleting it after the action (deferred no-op check): Vitest controller (fake timers) and real VS Code.
- Save after action and typing: the will-save check returns no edits: Vitest controller.
- Editing a cell of the formatted table: unchanged rows keep the padding (table merge against the host table): Vitest (pinned Lute).
- Native Undo past the action, then typing: the undone padding does not come back (the host holds the unpadded table): Vitest (pinned Lute, host text without padding). Real VS Code cannot reach this state until Task 675 makes the SV command undoable.
- Repeated identical blocks pair in order with two sources: Vitest.
- No exact write since open or save: `preferred` is not passed and the no-op check still arms: Vitest controller.
- Save clears the state (`setCleanBaseline`): Vitest controller.
- Over the 100 KB minimal-diff cap: unchanged full write: existing Vitest.
- Accepted residual risk: if native history coupling refuses an Undo past a neutral exact action in IR mode, the plain fallback leaves the tab dirty, because the no-op restore is skipped in that state.

### Part 2 step plan

- Step 1 (RED; needs Task 675's kit change integrated). Owned files: `test/backend/minimal-diff-writeback.test.ts`, `test/backend/writeback-controller.test.ts`, `test/vscode-e2e/exact-action-neutral-bytes.spec.ts` (new), `test/vscode-e2e/exact-action-neutral-bytes-probe.spec.ts`. Checks: `npx vitest run --config test/vitest.config.mts test/backend/minimal-diff-writeback.test.ts test/backend/writeback-controller.test.ts` (new cases fail on the missing behaviour, existing cases pass); `node build.mjs`; through the wrapper, the new spec (fails on the reverted padding) and the probe with `VMDE_PROBES=1` (records the revert).
- Step 2 (GREEN). Owned files: `src/markdown/minimal-diff-writeback.ts`, `src/writeback/writeback-controller.ts`. Checks: the same Vitest command (all pass); `node build.mjs`; through the wrapper in one invocation, `exact-action-neutral-bytes.spec.ts`, `undo-dirty-probe.spec.ts` and `noop-check-on-save.spec.ts` (pass), then the probe with `VMDE_PROBES=1` (records the kept padding).
- Step 3 (closure). Owned files: this task record, `tmp/673/completion-report.md`. Checks: `npm run lint`, `npm run knip`, `npm run jscpd`, `npm run depcruise`, `npm run test:coverage`, `npm run check:coverage-modules`, `npm run typecheck`.

No overlap with Task 675 (`media-src/src/bridge/edit-sync.ts`, the SV command files, `shortcut-xtest-kit.ts`, `exact-authority-other-actions.spec.ts`) or Task 681 (`table-format-command.ts`); this task reads the kit and does not edit it.

### Result (2026-11-01)

- `WritebackController` keeps a private `exactWriteSinceBaseline` (replacing `exactTransactionContent`). It is set when an exact write is applied and the document holds its content; it ends at `setCleanBaseline` (open, save) and whenever the document text equals the clean baseline again (checked at the start of every `syncToEditor` and after an exact apply, so Undo replays, which never reach `setCleanBaseline`, do not leave it set). While it is set, a plain write gets the document's own text as the preferred source of `minimalDiffWriteback(original, next, reserialize, preferred?)`, the deferred no-op check is not armed, `resolveNoopCheck` returns early and `checkNoopOnWillSave` returns no edits.
- `minimalDiffWriteback` keeps a separate cursor per source. Per editor block: whole-block match in the preferred source, else in the baseline, else table merge against the next table slot of the preferred source, then of the baseline, else the editor block. The trailing-newline shape comes from `preferred ?? original`. Without `preferred` the behaviour is unchanged.
- Review repair (M1): after an exact write, Undo returned the host to the baseline bytes but the flag stayed set, which would have disabled the Task 434 no-op repair until the next save. Two controller cases (exact replay back to the baseline; document set back to the baseline) failed first and pass with the repair.

### Provisional decisions (2026-11-01), reversible

- Baseline design, names and layers: see Part 1 handoff (the document's own bytes preferred while an exact write is active; selected by a recorded decision check, probability 0.92).
- Scope of the review repair: fix only the flag lifetime (M1) and record the rest as residuals; selected by a recorded decision check (probability 0.64; the variant that also changed the original cursor and the flag-set comparison 0.35).
- Test 2 asserts the text, not the dirty marker, after Undo of the action itself, with the evidence above (rule: grounded in the unfixed control and eight debug samples).

### Residuals (no code change)

- M2: a plain-fallback Undo (taken only when native history coupling refuses a transition) cannot remove a neutral exact result while the exact write is active; Task 685.
- L3: the baseline's cursor is not advanced on a match in the preferred source; affects only which of two equal byte choices is taken.
- L4: repeated identical blocks may drop padding when the sources pair differently; neutral bytes only.
- L5: the flag is set with strict equality of the document and the exact content while other checks normalize line ends (pre-existing comparison).
- L6: two panels on one document keep separate controllers (pre-existing).

### Verification actually run

- Vitest (the files importing the two modules: `minimal-diff-writeback`, `writeback-controller`, `editor-session`, `external-change-guard`, `md-scan`, `sync-state`): 6 files, 276 tests passed. New cases failed first (minimizer 3, controller 4, then the two review cases).
- Real VS Code (one invocation): `exact-action-neutral-bytes.spec.ts` (2), `undo-dirty-probe.spec.ts`, `noop-check-on-save.spec.ts` (2): 5 passed. Rerun on the final sources (after the last comment-only edit of `writeback-controller.ts`, with a fresh build): the same 5 passed; Vitest on the six module-importing files 276 passed. Probe with `VMDE_PROBES=1`: reverted before the fix, kept after.
- Quality stages individually, all exit 0: `check:brand-identifiers`, `lint:ci`, `typecheck`, `typecheck:vscode-e2e`, `knip`, `jscpd`, `depcruise`, `test:coverage` (384 files, 8415 tests passed, 1 expected fail; no timeout, no rerun needed), `check:coverage-modules` (9 modules at 0%, baseline 9). Dependency audit not run. Webview bundle `main.js` 1,121,369 bytes (reporting only; no webview source changed).
