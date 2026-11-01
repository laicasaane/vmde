# Task 690 — Remaining low review notes on Tasks 673, 674 and 681

**Status:** done (2026-11-02). Filed at the close of Tasks 673, 674 and 681.
**Origin:** Task 673 (review lows L3 to L6), Task 674 (review low b), Task 681 (review low).
**Severity:** low (estimated; each note affects neutral bytes, one history entry on a decline path, or defence in depth only).
**Tech stack:** Part 1: `src/writeback/writeback-controller.ts`, `src/markdown/minimal-diff-writeback.ts`. Part 2: `media-src/src/editing/callouts.ts`. Part 3: `media-src/src/editing/table-format-command.ts` (`snapCaretIntoCell`), `media-src/src/editing/table-operations.ts`.
**Depends on:** none.

For each part, decide fix or record-as-accepted, with a reason. Fix with a failing test first where a test can reach the case. Record the decision in the part's acceptance item.

## Part 1 — Task 673 residuals L3 to L6

### Problem

- L3: the baseline's cursor is not advanced on a match in the preferred source; it affects only which of two equal byte choices is taken.
- L4: repeated identical blocks may drop padding when the sources pair differently; neutral bytes only.
- L5: the flag is set with strict equality of the document and the exact content while other checks normalize line ends (pre-existing comparison).
- L6: two panels on one document keep separate controllers (pre-existing).

### Proposed work

Per note, decide fix or accept. L3 and L4 are reachable at unit level in `minimal-diff-writeback.ts` (build the two sources so they pair differently). L5 and L6 are pre-existing behavior of the controller; accept unless a case with a measurable effect is found.

### Acceptance

- [x] L3: recorded as accepted. Only neutral bytes differ, and no single-cursor rule is better (see the Part 1 handoff).
- [x] L4: recorded as accepted. Neutral bytes, rare trigger, and only an alignment rewrite of the hot minimizer fixes it (measured case in the Part 2 section).
- [x] L5: fixed. The Vitest case failed first (`expected undefined to be '| a | b |\r\n…'`) and passes with the normalized comparison.
- [x] L6: recorded as accepted. Unreachable with the shipped one-editor-per-resource registration; pre-existing; a fix is structural.

## Part 2 — Task 674 review low (b): the callout apply decline path

### Problem

In `media-src/src/editing/callouts.ts`, the decline path of the callout apply restores the document with `outer.setValue(pair.exact)` when the caret marker is missing (`:630`, then `return false`). That `setValue` can arm Vditor's delayed after-render record, and nothing retires it on this path. A caret-only Undo entry may appear later. Task 674 retired the record only on the success path (`checkpointEditorUndo(inner)` at `:632`). Not measured; outside the acceptance of Task 674.

### Proposed work

Measure whether the record is armed and whether a later history entry appears after a declined apply. If it does, retire the record on the decline path without adding a history entry for a declined apply.

### Acceptance

- [x] The decline path is measured: the record stays armed and one extra history call follows after about 800 ms, in IR and WYSIWYG.
- [x] A failing Vitest case first (`expected { options: … } to be undefined`, IR and WYSIWYG), then the fix; the declined apply adds no history entry.
- [x] Not applicable: the entry appears, so the path is fixed.

## Part 3 — Task 681 review low: the table index in `snapCaretIntoCell`

### Problem

`snapCaretIntoCell` in `media-src/src/editing/table-format-command.ts` requires the exact-side cell to have the same row and column as the editor-side cell. It does not compare the table index. If the exact text and the editor text pair two tables differently, a row and column match could belong to another table. No test can reach this case today (defence in depth).

### Proposed work

Decide whether to compare the table index (or the table's start offset against the proven region) or accept the gap. The region proof, `planSvRegionEdit` and the rollback already refuse a write outside the formatted table; confirm that in the decision.

### Acceptance

- [x] Recorded as accepted. The guard is the shared order-keeping alignment plus the table-image equality check before `planSvRegionEdit`.
- [x] Not applicable: accepted, no code change.

## Tests to write

- Vitest per fixed note, in the test file of the changed module (`media-src/src/editing/callouts.test.ts`, `media-src/src/editing/table-format-command.test.ts`, and the minimizer and controller tests for Part 1).
- Real VS Code only if a fix changes webview behavior a user can reach (batch with the other specs of the round); otherwise none.

## Part 1 handoff (2026-11-02)

Source read at `446e7aa0`. Since the reviews, Task 685 added `noteExactReplay` and `settleOwnWrites` to `writeback-controller.ts` (both compare with `normalize`). Task 688 added `seedHistoryOf(inner)` before the callout rewrite, which moved the decline path by 4 lines. Tasks 686, 692 and 696 did not change any file named here. `minimal-diff-writeback.ts`, `table-format-command.ts` and `sv-source-proof.ts` have not changed since Tasks 673 and 681.

### L3 — baseline cursor not advanced on a preferred match

- Location: `src/markdown/minimal-diff-writeback.ts:112-126`. A match in the preferred source sets only that source's cursor (`src.from = found + 1`, `:123`), and the loop stops.
- Reachability: yes, at unit level. A later editor block that matches only in the baseline can take an earlier baseline block with the same meaning but different bytes (for example `_a_` for `*a*`).
- Decision: record as accepted. Every candidate block reserializes to the editor block, so only neutral bytes differ. The other single-cursor policy, which also consumes the baseline match when the preferred source wins, is not better: after an exact reorder (an outline move), it moves the baseline cursor past blocks that later match only in the baseline and drops their bytes. A correct result needs an alignment of each source, which would rewrite a minimizer that runs on every typing tick.
- Provisional decision (2026-11-02), reversible: accept (probability 0.97; consume the baseline match too 0.03; alignment rewrite 0.00).

### L4 — repeated identical blocks drop padding when the sources pair differently

- Location: the same loop, `src/markdown/minimal-diff-writeback.ts:112-126`, with the table merge at `:132-146`.
- Reachability: confirmed at unit level, with a scratch Vitest run that was deleted afterwards and a stub reserializer that removes spaces. Baseline `[Ta, Tb]` unpadded, document `[Ta, Tb]` padded, editor `[Tb, Tb]` (a cell edit makes the first table equal to the second). Result: the first table takes the padded `Tb` through look-ahead, and the second table takes the unpadded baseline `Tb`. One table loses its neutral padding.
- Decision: record as accepted. Neutral bytes only, and only after an edit makes a block equal to a later block. The cause is the greedy look-ahead. A "slot first" variant (try the block at the cursor before scanning) does not change this case, because the slot block (`Ta` padded) does not match. Only an alignment of each source fixes it, the same rewrite as L3.
- Provisional decision (2026-11-02), reversible: accept. The recorded decision check was split (slot-first fix 0.50, accept 0.46, alignment 0.03). It is resolved for accept by the measured case above, in which slot-first changes nothing. If the Owner wants the padding kept in this case, file an alignment task. Do not use the slot-first change.

### L5 — strict equality when the exact-write state is set

- Location: `src/writeback/writeback-controller.ts:481`, `if (exact && document.getText() === content)`. Every other comparison in the controller uses `normalize` (`:395`, `:406`, `:496`, `:559`, `:716`, `:742`, and `noteExactReplay` from Task 685).
- Reachability: the effect is measurable at unit level. VS Code converts inserted line ends to the document's EOL. If an exact write's content has a different EOL from the document, the state stays unset, and the next plain write reverts the neutral bytes (the Task 673 failure). The deferred no-op restore is also armed again. No product path is known to produce such content: the SV Format Table (`restoreLineEndings` in `table-format.ts`) and the callout plan keep the host's EOL bytes.
- Decision: fix. The change is one comparison, it matches the controller's other checks, and a test reaches the case.
- Provisional decision (2026-11-02), reversible: fix (probability 0.99; accept 0.01).
- Failing test first: Vitest, `test/backend/writeback-controller.test.ts`, in describe "WritebackController after an exact write (Task 673)". New case "sets the exact-write state when the document converts the exact content to its own line endings". The document opens with the CRLF baseline. `vscode.workspace.applyEdit` is mocked once to store the content with `\n` converted to `\r\n` (the pattern at `:416`). Run an exact sync with LF content, then one plain sync. Expect `minimalDiffWriteback` argument 4 to equal the CRLF document text. Expected RED: it is `undefined`.
- Change: `normalize(document.getText()) === normalize(content)` at `:481`.
- Checks: `npx vitest run --config test/vitest.config.mts test/backend/writeback-controller.test.ts test/backend/minimal-diff-writeback.test.ts`.

### L6 — two panels on one document keep separate controllers

- Location: `src/session/editor-session.ts:1472` (one `WritebackController` per session). The registration at `src/app/extension.ts:152` does not set `supportsMultipleEditorsPerDocument`.
- Reachability: not with the shipped registration. VS Code allows one custom editor per resource by default, and a second open moves the first editor. Even with two panels, the effect would be neutral bytes reverted by the other panel's plain write.
- Decision: record as accepted. The behaviour is pre-existing and unreachable by default. A fix would need state shared per document across sessions, which is a structural change outside this task.
- Provisional decision (2026-11-02), reversible: accept (probability 0.97; investigate 0.03; shared state 0.00).

### Part 2 (Task 674 b) — callout apply decline path

- Location: `media-src/src/editing/callouts.ts:630-635` (IR and WYSIWYG branch). `outer.setValue(marked)`; when `removeActionCaret` finds no marker, `outer.setValue(pair.exact)` and `return false`. The success path calls `checkpointEditorUndo(inner)` at `:641`. Task 688 added `seedHistoryOf(inner)` before the rewrite (`:597`).
- Measurement: scratch Vitest with the Task 674 harness, deleted afterwards. The mocked `setValue` dropped the caret marker on its first call to force the decline. In both IR and WYSIWYG: the result is `false`, `setValue` is called twice, `vmdeAfterRender` is still armed after the return, and `addToUndoStack` is called once before the timers and 3 times after 1000 ms. The mock does not clear an earlier timer, so it fires twice. Real Vditor clears it and re-arms once, so it fires one extra record. Task 674 measured in real VS Code that such a record adds a caret-only entry, which the first Undo then removes with no text change. No user path that loses the marker in the render is known.
- Decision: fix. Retire the record on the decline path without adding an entry. Do not restore the undo snapshot, because that would also remove the Task 688 seed.
- Provisional decision (2026-11-02), reversible: fix with the cancel only (probability 1.00; cancel and restore the snapshot 0.00; accept 0.00).
- Failing test first: Vitest, `media-src/src/editing/callouts.test.ts`, in describe "callout action exact authority (Task 630)", `it.each(['ir', 'wysiwyg'])` "%s: a declined callout apply retires the after-render record and adds no history entry". Use fake timers. Wrap the harness `setValue` with `mockImplementationOnce`, which strips `/VMDE_CALLOUT_CARET_\d+/u` and then calls the original implementation. Expect `run()` to be `false`, `owner.vmdeAfterRender` undefined, and the `addToUndoStack` call count unchanged after `vi.advanceTimersByTime(1000)`. Expected RED: the record is armed, and the count goes from 1 to 3.
- Change: before `return false` at `:635`, call `cancelPendingUndoSnapshot(inner)`. The function is exported by `rewrap-command.ts:663`, a module that `callouts.ts` already imports from.
- Checks: `npx vitest run --config test/vitest.config.mts media-src/src/editing/callouts.test.ts`. Real VS Code: none, because no user path reaches the decline.

### Part 3 (Task 681) — table index in `snapCaretIntoCell`

- Location: `media-src/src/editing/table-format-command.ts:259-290`. The check `location.row === cell.row && location.column === cell.column` is at `:286`.
- Reachability: not reachable. `proveSvCaretInSpan` proves the snapped exact offset through `alignmentFor(exact, text)` (`sv-source-proof.ts:48`, `:163`), one monotonic alignment of the exact text and the editor text. `runAcquired` formats the exact table that contains that offset. `svRenderedBounds` maps the table back through the same alignment (`sv-source-proof.ts:229`), so its editor image contains the caret. The write then requires that image to be the same table, verbatim or equal after Lute formats both (`table-format-command.ts:385-388`), before `planSvRegionEdit` (`:390`). Any failure in the splice rolls back the editor and the undo stacks. A pairing with another table cannot pass both the shared alignment and the table-image equality check.
- Decision: record as accepted. The guard that makes the case unreachable is the table-image equality check after the shared alignment, before `planSvRegionEdit`.
- Provisional decision (2026-11-02), reversible: accept (probability 0.98; compare the table start too 0.02).

### Part 2 tier and steps

Tier: Light. There are two one-line fixes (L5, Task 674 b), each with one failing Vitest case first, in four files, with no public API and no webview behaviour that a user can reach. Real VS Code is not needed.

- Step 1 (RED then GREEN, one worker). Owned files: `test/backend/writeback-controller.test.ts`, `src/writeback/writeback-controller.ts`, `media-src/src/editing/callouts.test.ts`, `media-src/src/editing/callouts.ts`. Write both cases and run them (both fail as stated above), then make both changes. Checks: `npx vitest run --config test/vitest.config.mts test/backend/writeback-controller.test.ts test/backend/minimal-diff-writeback.test.ts media-src/src/editing/callouts.test.ts` (all pass).
- Step 2 (closure, orchestrator). Owned file: this record, with the acceptance items ticked using the decisions above. Gates once in the closure batch: `npm run lint`, `npm run typecheck`, `npm run knip`, `npm run jscpd`, `npm run depcruise`, `npm run test:coverage`, `npm run check:coverage-modules`.

## Part 2 (2026-11-02)

### Provisional decisions

- Provisional decision (2026-11-02), reversible: L4 stays accepted and no new task is filed. The measured case is kept as a residual: with the document `[Ta, Tb]` padded, the baseline `[Ta, Tb]` unpadded and the editor `[Tb, Tb]`, the second table takes the unpadded baseline bytes.
- Provisional decision (2026-11-02), reversible: Vitest only for the callout decline path. No user path reaches the decline (the render must lose the caret marker), so a real-VS-Code case cannot drive it.

### Result

- L5: `src/writeback/writeback-controller.ts` sets the exact-write state when `normalize(document.getText()) === normalize(content)`, like the controller's other checks. New case in `test/backend/writeback-controller.test.ts`: "sets the exact-write state when the document stores the exact content with its own line endings" (the write is stored with CRLF; the next plain write gets the document text as the preferred source). RED before the change: `expected undefined to be '| a | b |\r\n| - | - |\r\n\r\ntail\r\n'`.
- Task 674 (b): `media-src/src/editing/callouts.ts` calls `cancelPendingUndoSnapshot(inner)` after `outer.setValue(pair.exact)` on the decline path. It does not restore the undo snapshot, so the Task 688 seed stays. New cases in `media-src/src/editing/callouts.test.ts` ("%s: a declined callout apply retires the after-render record and adds no history entry", IR and WYSIWYG). The harness `setValue` now replaces the pending record the way Vditor does. RED before the change: `expected { options: { …(3) }, …(2) } to be undefined`.
- Residual (L4): see the first decision above.
- Task 681 and L3, L6: accepted, no change.

### Verification actually run

- Vitest on `test/backend/writeback-controller.test.ts` and `media-src/src/editing/callouts.test.ts`: 94 passed (3 new cases failed first).
- `npm run typecheck`: exit 0. `npx biome check` on the four files: exit 0.
- `npm run quality`: exit 1 only from the audit stage (11 dependency vulnerabilities, 6 moderate and 5 high; omitted by the Owner's rule). Passing: `check:brand-identifiers`, `lint:ci`, `knip`, `jscpd`, `depcruise`, `test:coverage` (375 files passed, 9 skipped; 8278 tests passed, 228 skipped), `check:coverage-modules` (9 modules at 0%, baseline 9).
- Real VS Code: not run (see the second decision).
