# Task 602 — One webview undo step spans several host edits and leaves the host out of step

**Status:** ✅ DONE (2026-10-07) on `dev`. Design A1 (bounded native-history traversal with proved target and verified rollback) plus the checkpoint flush F, Owner-approved 2026-10-07. Commits: `77850819`, `25233e44`, `ecaf1fa7` (records), `83984892` (A1 and F product), `ff4ebd97` (real-VS-Code spec), `b6b23416` (S3 fix: `flushEdit` re-evaluates the undo delay), `092b59e0` (spec extension).
**Origin:** found during the Task 598 investigation (2026-09-28).
**Severity:** high. The saved document can differ from what the editor shows until the next save.
**Recommended implementer effort:** xhigh. The fix changes the undo coupling between webview and host.
**Tech stack:** extension host (`src/writeback/history-coupling.ts`, `src/session/editor-session.ts`), webview (`media-src/src/bridge/edit-sync.ts`, `media-src/src/editing/undo-keybind.ts`), Vitest, real VS Code with XTEST.
**Dependencies:**

- Run after **Tasks 598 and 601**. Both change when checkpoints are recorded and when a history transition is posted.
- Read Task 463 (undo routing) and Task 488 (checkpoint granularity) first.

**Evidence:** `tmp/task596-603-evidence/t598/results4.json` and `results5.json` in the main checkout. Real VS Code 1.129.0, `VMDE_XTEST=1`, Task 579 build.

## Task 579 overlap (Owner decision 2026-09-28)

Task 579 CP2 N9 owns the narrower duplicate Undo-echo repair: retain the accepted history result
while matching **plain** edit echoes arrive and the host remains at its exact result; clear that
expectation on a different/non-plain edit or a history transition. This prevents a second
normalized Undo echo from creating a host edit that clears native Redo. The owner accepted the
pre-existing attribution with medium confidence and approved fixing it inside Task 579. Exact,
explicit-block and rewrap actions bypass suppression. See
[Task 579's N9 record](579-split-find-and-find-replace.md).

This overlap does not close Task 602: its general case of one webview history step spanning several
real host edits, and the A/B/C design decision below, remain planned.

## Problem

Steps (measured):

1. Type `X`.
2. Pause 500–600 ms.
3. Type `Q`.
4. Wait 2.5 s.
5. Press Ctrl+Z.

What happens:

- The webview syncs to the host every 250 ms (`edit-sync.ts:758`), so the host receives **two** edits.
- Vditor records **one** undo entry covering both.
- On Ctrl+Z, the webview shows `delta.`, but native undo on the host reverts only the last edit, leaving `delta.X`.
- `HistoryCouplingController` accepts the native result whenever the host started at the transition's "before" text (`history-coupling.ts:55-73`). It then absorbs the webview's next edit message (`:87-100`).
- Result: the editor shows `delta.` while the document holds `delta.X`.
- Ctrl+S reconciles: disk becomes `delta.` and the document is clean.

With a 50 ms gap between keys, the host receives one edit, and Undo is correct.

This affects every undo step today. Once Task 598 lands, it also affects the first step.

## Design space (the implementer measures and chooses; the owner approves)

- **A. Verify after native undo.** After native undo, the host compares its text with the transition's `after` text. If they differ, it applies a corrective edit that replaces the difference, grouped into the same undo stop where possible. Alternatively, it repeats native undo until the host reaches `after`, if that can be done safely.
- **B. Align host undo stops with Vditor checkpoints.** The webview marks checkpoint boundaries, and the host merges the intermediate edits into one undo stop (for example with `undoStopBefore/After` on the `WorkspaceEdit` path).
- **C. Webview-authoritative Undo.** The host applies the transition's `after` text as one edit instead of running native undo. This changes the Task 463 design and needs an explicit owner decision.

Criteria for choosing:

- exact host bytes after Undo and Redo;
- the dirty flag returns to clean at the saved state;
- VS Code's native undo from the text editor still behaves;
- no feedback loop;
- exact behaviour with CRLF documents.

## Owner decisions (2026-10-07)

After the S1a baseline showed that Undo then Save writes the wrong text to disk on current `dev`:

- Priority: finish Task 602 first (remaining S1 measurements, design choice, implementation). No interim stop-gap; Tasks 596 and 603 wait.
- Scope: 602 acceptance also covers the SV case (text ends matching, but the document stays dirty and VS Code's undo history is rewritten) and the large-document case (native Redo after a wrong Undo is skipped and repaired only 1 to 2.5 s later).

## Owner design decisions (2026-10-07, after S1b–S1e)

- **Design A1 approved.** On Undo/Redo the host walks VS Code's native undo history step by step until the host text provably equals the target (exact, ledger, retained N9 pair, history base, or semantic no-op), with verified rollback. The step limit is 64, or the host counts its writes per webview step. SV history messages use the same text form as SV edits.
- **Fallback: flush plus resync.** A checkpoint flush ("F") publishes a pending edit when Vditor records an entry, so every webview step reaches the host before history. When A1 still cannot prove the target, it resyncs the text: the text is correct, but the document stays dirty and native history is rewritten.
- **Publication stall:** the occasional ~4 s period in which the webview posts nothing during typing is a separate task ([Task 624](../624-webview-publication-stall.md)), not part of 602.
- **Large and CRLF documents:** after Undo, the host returning to the exact original file bytes counts as correct, even where the webview shows its rendering of them (the known large-fixture normalization, Tasks 597 and 607).

## Owner decisions answered

1. **Design:** A1 (see "Owner design decisions" above), with the checkpoint flush F as the fallback support.
2. **Redo:** covered with the same guarantee (answered yes, 2026-10-07).

## Tests

- **Vitest** (`test/backend/history-coupling.test.ts`, host side; 36 cases on a linear native-history model): the walk, every proof, the step limit, published-pair eviction, external-change clearing, resync, rollback failure and divergence, repeated text, CRLF. Session, message-shape, edit-sync, undo-keybind and finish-init units cover the wiring. S3 added unit cases for `flushEdit` re-evaluating the undo delay on every flush route.
- **Real VS Code** (XTEST, `test/vscode-e2e/undo-host-coupling.spec.ts`, 8 tests after S3):
  - IR, SV and WYSIWYG at gaps of 50, 300, 600 and 1200 ms, LF and CRLF, each with Undo, Save, reopen and native text-editor history;
  - Redo chains;
  - large IR, SV and WYSIWYG fixtures, including the primed 2,000 ms WYSIWYG case;
  - one IR special-journeys test: twelve keys, the 64-step limit resync, mode switch to SV and WYSIWYG, an outside change between edits, the checkpoint flush timed from Enter, and an F-Undo journey.

## Execution progress

**S1a, natural baseline (2026-10-07, HEAD `d4db2abb`, Claude Opus 5.5, measurement only).**
Authority: `tmp/queue-part1/602-native-handoff.md` §1–§3. Artifacts: `tmp/task602-checks/s1a/`
(`final-report.md`, `@probe` spec, isolated config, two run directories). Real VS Code 1.129.0,
`VMDE_XTEST=1`, Xvfb + Openbox without bindings, `--workers=1 --retries=0`. Run A: IR, 1 passed.
Run B: IR, WYSIWYG, SV, large IR, large WYSIWYG, 5 passed. No product change.

- **Reproduced on HEAD, IR.** One Vditor entry spans two host writes (X published at +265 ms, XQ at
  Q + about 258 ms; checkpoint at Q + about 1,025 ms). Undo leaves the host at `delta.X` while the webview shows
  `delta.`, dirty, stable for 2.6 s. Seen at 331 and 633 ms and with CRLF (CRLF preserved), in 6/6
  journeys with that shape. The large fixture behaves the same: the host keeps the canonicalized
  document with X. Controls: 25 ms (one host write) and 1,232 ms (two entries) are exact. In run A, 2
  of the 633 ms journeys published X only with Q (one write), so Undo was exact there. Whether the
  defect appears depends on X being published before Q.
- **Save no longer reconciles.** Undo, then Save, writes `delta.X` to disk and marks the document
  clean while the editor shows `delta.`. The N9 retained pair absorbs the will-save flush; this is
  inferred from the host events. This contradicts "Ctrl+S reconciles" above.
- **Redo after a divergent IR or large Undo** skips native Redo; a plain write about 1.1–2.5 s later
  restores the text. The end state agrees, but native Redo is lost and the stability window is
  broken.
- **SV**, same shape, 5/5: the text agrees after Undo, but through native Undo, a rollback Redo and a
  plain write. The document is dirty at the saved bytes and native history is rewritten.
  `getValue()`'s trailing newline makes the start unaligned.
- **WYSIWYG small**, 0/5: it publishes inside the after-render timer, so host writes align with
  checkpoints and the defect shape cannot form. Large WYSIWYG 636 ms: Undo is exact, Redo is skipped
  and repaired by a late plain write. The first edit on an opened large WYSIWYG document uses
  `undoDelay` 800 ms, not 2,000 ms.
- **Contracts.** The handoff's source facts still hold (`history-coupling.ts` unchanged; one
  whole-document `applyEdit` per write, one native stop each). 598 makes these first edits undoable,
  so the defect reaches the first step. 601 drained nothing in 27/27 settled Undos and does not affect
  this case. B (grouping already-applied writes) and A (verify after native history, retiring N9)
  both remain applicable. S1b, S1c, S1d and S1e all remain necessary; small WYSIWYG cells are
  controls only.
- **Open for the Owner:** the higher severity (wrong bytes saved, document shown clean), and whether
  the SV dirty/history defect and the large-document Redo skip belong to this task's acceptance.

**S1b–S1e, design comparison (2026-10-07, HEAD `77850819`, Claude Opus 5.5, measurement only).**
Authority: handoff §2, §3, §5 and §6. Report: `tmp/task602-checks/comparison.md`. Per-cell coverage,
including every unrun cell: `tmp/task602-checks/matrix-coverage.txt`. The throwaway prototype was
built and run, then restored. The product files are byte-identical to HEAD and the rebuilt HEAD hashes
match S1a.

- **S1b. B is infeasible on the supported route.** `workspace.applyEdit` has no undo-stop option, and
  the extension host sends no undo group. Each write is its own closed native stop: 12 writes gave 12
  stops. Holding writes until the checkpoint, a hidden text editor, or undo-and-reapply are different
  designs, and none was run.
- **Baseline gap fill (HEAD).**
  - Webview posts are now captured (S1a's wrapper failed silently on the frozen API object). They
    confirm that the N9 pair absorbs the after-render echo.
  - The defect also reproduces on the large CRLF fixture.
  - Large SV is never coupled natively: the SV echo rewrites the authored bytes.
  - Primed large WYSIWYG (`undoDelay` 2,000 ms) publishes once per entry.
  - Native text-editor Redo after an SV Undo reaches the rewritten `T0`.
- **S1c. A1 (bounded native traversal, proved target, verified rollback).**
  - Unit model: 21/21.
  - Real VS Code: 20/20 one-entry/multi-write IR journeys exact in both directions (2, 6 and 12 native
    steps; 19–139 ms).
  - SV 8/8, CRLF and large IR/WYSIWYG/SV: clean at the saved state, native Redo kept, stable for 2.6 s.
  - Undo→Save→reopen is exact.
  - Requirements: a value-based history-base proof, the retained pair as the Redo start proof, and SV
    transitions in host form.
  - Bound 8 refused 3/3 entries of 12 writes. Bound 32 passed.
  - A publication stall (1 of 8 twelve-key journeys) left a webview entry state unpublished, so no
    native stop could reach it. A1 refused there.
- **S1d. A2 (corrective edit).** Bytes are right and Undo→Save→reopen is correct. It failed the
  decisive criteria: dirty at the saved bytes after Undo (2/2), native Redo lost (plain write at
  +1.1 s), and native text-editor history rewritten. Broader A2 runs were stopped.
- **S1e.** The recommendation is A1 with the checkpoint flush F for unpublished entries. F is unproven
  at runtime. Confidence is medium-high on the measured cells and medium overall: 32/48 A1 cells are
  unrun, and the cause of the stall is open. The Owner design decision is pending.

**S2, implementation of A1 + F (2026-10-07, base HEAD `ecaf1fa7`, Claude Opus 5.5).** Authority: the
Owner design decisions above and handoff §4–§5. Starting point: the S1c prototype, productionized
(no candidate switch, no probe hooks, A1 and F only).

- **Host (`src/writeback/history-coupling.ts`).** On a transition the controller walks native
  history one step at a time in the transition's direction (at most `MAX_NATIVE_STEPS` = 64) and
  stops at the first host text that provably corresponds to the webview result. Proofs, each checked
  against the host text at that moment: exact (EOL-insensitive), published pair (a 64-entry
  least-recently-used map from each published webview text to the host texts VMDE wrote for it),
  the retained Task 579 N9 pair, a history base, or the semantic no-op. Without a proof it stops
  (no progress, a repeated text, a failed command or the limit), undoes its own verified steps in
  reverse order (a failed or diverging inverse stops further mutation), clears the retained pair and
  posts an update; the webview's next plain edit then rewrites the host (the resync fallback). A start
  already at the result, or not provable, makes no native call (as before). When the host starts at
  the exact `before` bytes and already renders like the result (a source-only change), the semantic
  proof is disabled for that walk, so it cannot stop on a semantically equal intermediate stop. That
  check runs only when a step needs the semantic proof (`WritebackController.isSemanticallyEquivalent`,
  new two-text form of the existing check), so a walk that ends on a byte-level proof never
  reserializes the document. The
  retained pair is set only after a proof and names the final host text, so it no longer absorbs a
  save flush after a wrong Undo.
- **History base, changed from the prototype.** The prototype's host reset its base text at every
  ordinary `update` post and mode switch. A same-content update does not clear Vditor's stacks, and a
  first visit to a mode after edits starts that mode's history at the edited text, so the base could
  prove a wrong host text. Instead the webview posts `history-base` (new message, mode plus text) when
  a mode's empty stack gets its first entry (open, a host update's `setValue`, a first visit, the Task
  598 seed), after the checkpoint flush. The host pairs it with its own text on the edit queue, only
  when it holds no change the webview has not received (`isAlreadySynced`).
- **External changes.** A content change VMDE did not make clears the published pairs and bases. A
  dirty-state event (no content changes; fired after a save or a revert) does not: the first S2
  regression run showed Save clearing the base, so a later large-document Undo to the opened bytes
  was refused (`find-replace.spec.ts` :282 and :689 failed; both pass after the fix).
- **Webview.** SV transitions and bases use edit-sync's SV text form (`EditSync.historyText()`, the
  same serialization as SV edit posts). `undo-keybind.ts` wraps `addToUndoStack` and the Task 598
  seed to report each recorded entry and the first entry of an empty stack; `finish-init.ts` turns the
  entry report into the checkpoint flush F (`flushHistoryInput`, so a pending edit is published at the
  entry boundary) and the base report into `history-base`.
- **Contracts kept.** Task 463: one engine call per press, native undo never double-fires (only the
  host walks native history). Task 579 N9: duplicate plain echoes of an accepted result are absorbed;
  exact, explicit-block and rewrap edits and different edits clear the pair. Tasks 597/598/601: no
  change to restore, seed, drain or IME refusal (F reuses Task 601's flush). Task 434 and the CP2-12
  will-save flush: unchanged. Exact-source ownership: F and SV forms go through edit-sync's existing
  exact settle. The writeback cap: unchanged.
- **Tests.** Vitest `test/backend/history-coupling.test.ts` (rewritten on a linear native-history
  model: 36 cases, porting the prototype's A1 cases and the still-valid HEAD contracts; the HEAD case
  that accepted an unproved one-step result is replaced by a published-pair proof case and a refusal
  case; new cases for the limit, published-pair eviction, external-change clearing, base forgetting,
  resync, rollback failure and divergence, repeated text, CRLF). Session, message-shape, edit-sync,
  undo-keybind and finish-init units cover the wiring. Real VS Code XTEST
  `test/vscode-e2e/undo-host-coupling.spec.ts`, 5 tests / 20 journeys at the end of S2 (superseded by S3: 8 tests): IR gaps 50/300/600/1200, CRLF
  300/600, Undo→Save→reopen, native text-editor history; a twelve-key IR entry (12 host writes, 12
  native steps); SV 300/600/CRLF 600/1200, Undo→Save→reopen, native history; WYSIWYG 600/1200/CRLF;
  large fixture IR LF/CRLF, WYSIWYG, SV at 600 ms. Each step asserts exact host and webview texts,
  dirty (clean at the saved state), native-only host changes (no later plain write) and 2.6 s
  stability.
- **RED on HEAD.** Units: 22 of the 36 new cases fail against HEAD's module. Real VS Code (HEAD build
  `877f3fef…`/`08c1bd42…`, identical to S1a's): 4 of 5 tests fail (IR 300: host one write behind,
  dirty; twelve keys: host 11 characters behind; SV 300: dirty with a plain write; large IR: host
  keeps the normalized text). WYSIWYG passes on HEAD (it publishes once per entry). Product files were
  restored (`cmp` clean) and rebuilt.
- **Verification (final build `edcc2349…`/`cbe3befa…`).** Real VS Code 1.129.0, XTEST, Xvfb +
  Openbox without bindings, `--workers=1 --retries=0`, scratch logs under the session scratchpad
  (`t602/run-*`). `undo-host-coupling.spec.ts`: 5/5 (three full runs on the last three builds; the
  last after the final product edit). Regression set: `undo-redo-steps`, `undo-boundaries`,
  `undo-restore-caret`, `undo-first-edit` (cold-Mermaid leg fails as Task 623's expected failure),
  `undo-pending-checkpoint`, `list-enter-undo-caret`, `held-drag-undo-snapshot` 24 passed;
  `noop-check-on-save`, `save-flush-routes`, `save-fidelity`, `writeback-save-window-collision`,
  `edit-propagation`, `shortcut-identity` 15 passed; `find-replace` 3 passed; after the final edit
  (lazy semantic gate), `undo-host-coupling`, `find-replace`, `undo-first-edit`, `undo-redo-steps`,
  `noop-check-on-save`, `save-flush-routes` 19 passed. Two findings on the way: (1) `find-replace`
  :282 and :689 failed on the first S2 build because a save's dirty-state event cleared the history
  base (fixed above, then 3/3); (2) `undo-pending-checkpoint` "ir large fixture" failed once as
  "pending window missed: null" (no engine call recorded for that Ctrl+Z) and passed on the rerun and
  in both later full runs of the same suite; not reproduced, recorded as an intermittent.
- **Gates.** `npm run lint:ci` 0; `npm run typecheck` 0; host `tsc` 0; `typecheck:strict` 15
  (baseline); `typecheck:vscode-e2e` 1 (baseline `preview-task-checkbox:122`); `knip` 10 (baseline);
  `jscpd` 0; `depcruise` 0 violations; `node scripts/module-manifest.mjs` 0; `test:coverage` 330
  files / 5,995 passed + 1 expected fail; `check:coverage-modules` OK (11 at 0 %, baseline 11).
  Changed-line statement coverage (focused run): 186/190; uncovered: the edit-queue `.catch`
  callback in `queueHistoryBase` and the two `vditor-init.ts` wiring lines (covered by the real VS
  Code spec). Reporting only: `media/dist/main.js` 917.5 kB (HEAD 916.8 kB, +0.7 kB;
  `check:bundle-size` still over its 608 KB budget as before), eager modules 350 (no new module).
- **Test-isolation fix.** `test/backend/editor-session.test.ts` "posts the initial update before
  priming one non-empty git diff" read the global post log, which sessions from earlier tests also
  write to (their real-timer diff callbacks); with this change it failed by order and timing (10
  foreign `diff-info` posts, its own panel posted 1). It now reads its own panel's posts.
  `vscode-mock.ts`'s change event carries one content change by default (`contentChanges: []` for a
  dirty-state event).
- **Not covered here (at the end of S2; S3 closed most of this).** The 48-cell matrix is not exercised cell by cell: the spec covers 20
  journeys (IR LF 50/300/600/1200 and CRLF 300/600; SV LF 300/600/1200 and CRLF 600; WYSIWYG LF
  600/1200 and CRLF 600; large IR LF/CRLF, WYSIWYG LF and SV LF at 600 ms). Unrun: large at
  50/300/1200 ms, large WYSIWYG/SV CRLF, small CRLF at 50/1200 ms in every mode, WYSIWYG/SV CRLF 300.
  A publication stall (Task 624) was not reproduced, so F's effect on it is unproven at runtime (F is
  unit-tested; S3d later showed F is load-bearing for the Enter and Undo journeys). A refused walk's fallback (resync by the next plain edit) is unit-level only, and
  a mode switch after edits is not tested.

**S3, review, regression fix and closure verification (2026-10-07, base HEAD `ecaf1fa7`, finished at `092b59e0`).** Routing: orchestrator Opus 5.5 medium; spec review `opus-medium`; S3a, S3b, S3d and S3e Sonnet 5.5 high; S3c Sonnet 5.5 xhigh; S3f, S3g and S4 Sonnet 5.5 medium (efforts from the agent definitions). Scratch logs are in the session scratchpad and are not retained.

- **S3a, spec review and completion.** The spec was reviewed and finished: 8 tests. IR, SV and WYSIWYG on the small document and on the large fixture, each at gaps 50, 300, 600 and 1200 ms in LF and CRLF (all 48 mode × size × line-ending × gap cells), with Save, reopen and native history on the small ones; Redo chains; large IR, SV and WYSIWYG including a primed 2,000 ms case; one IR special-journeys test with twelve keys, the 64-step limit resync (Undo 1,148 ms; 64 undo steps, 64 rollback steps and 1 plain write; longest gap 21 ms), a mode switch to SV and WYSIWYG, an outside change (text editor, external) between edits, a checkpoint flush timed from Enter, and an F-Undo journey.
- **S3b, comparison with the pre-602 product.**
  - **A 602 regression was found.** On a large WYSIWYG document with a primed history, `undoDelay` stayed 800 ms (2 entries) on HEAD, against 2,000 ms (1 entry) before 602. Cause: F's `flushEdit` cancels the 250 ms idle post and never calls `syncUndoDelay`, so the delay is not re-evaluated.
  - `undo-pending-checkpoint` "ir large" "pending window missed" is pre-existing: pre-602 5/6, HEAD 5/6, then 6/6.
  - An IR caret defect after Enter is pre-existing (16/16 identical cells on both products); it is filed as [Task 625](../625-ir-enter-next-char-wrong-block.md), not fixed here.
- **S3c, fix `b6b23416`.** `flushEdit` now calls `syncUndoDelay`. Unit RED: 4 flush routes gave 800 instead of 2000. After the fix, vitest (`edit-sync`, `finish-init`, `undo-keybind`, `--config test/vitest.config.mts`) 87 passed; the primed test 11/11 journeys with 2,000 ms and 1 entry; `undo-pending-checkpoint` 4/4; `undo-boundaries` 1/1.
- **S3d, F is load-bearing.** With F temporarily disabled, both F journeys failed (X written 287 ms after Enter; X never got its own host write). With F on, both passed (23 ms; 8 ms, and Undo went to X natively). The product file was restored and `cmp` was clean.
- **S3e, final verification.** Final build `media/dist/main.js` `05e48da8…`, `dist/extension.js` `edcc2349…`. `undo-host-coupling` 8/8 twice (25.2 and 25.9 min). Regression set (a) `undo-redo-steps`, `undo-boundaries`, `undo-restore-caret`, `undo-first-edit`, `undo-pending-checkpoint`, `list-enter-undo-caret`, `held-drag-undo-snapshot`: 18 passed, the Task 623 expected failure, and one intermittent failure (`undo-first-edit` "paste, clipboard Cut and drag/drop first", paste:ir "race window missed"; it passed alone and the whole file passed 6/6). Set (b) `noop-check-on-save`, `save-flush-routes`, `save-fidelity`, `writeback-save-window-collision`, `edit-propagation`, `shortcut-identity`: 15/15. Set (c) `find-replace`: 3/3. The SV and large legs are clean at the saved state with native Redo kept.
- **S3f, the intermittent.** `undo-first-edit` paste:ir failed 0/6 on HEAD and 0/6 on the pre-602 product: not reproduced and not attributable to 602. The message comes from the spec's own precondition.
- **S3g, gates at `092b59e0`.** `lint:ci` 0; `typecheck` 0; host `tsc` 0; `typecheck:strict` 15 (baseline); `typecheck:vscode-e2e` 1 (baseline `preview-task-checkbox:122`); `knip` 10 (baseline); `jscpd` 0; `depcruise` 0; module manifest OK; `test:coverage` 330 files, 6,002 passed and 1 expected fail; `check:coverage-modules` 11 at 0 % (baseline 11). Changed-line coverage 113/115; the uncovered lines are the `vditor-init.ts:405` wiring and the `editor-session.ts:538` `.catch`, both exercised by real VS Code. Reporting only: `media/dist/main.js` 939,525 B (917.5 kB, +0.7 kB against `ecaf1fa7`), eager modules 350; the legacy budgets stay exceeded as before. Dependency audits were omitted by Project Owner instruction.

### Residual risks

- The 48-cell mode × size × line-ending × gap matrix (IR, SV, WYSIWYG; small and large fixture; LF and CRLF; gaps 50, 300, 600 and 1,200 ms) is fully covered by the final spec and passed in both S3e runs: no gap cell is unrun. Only those gaps and the listed journeys were measured; other typing rhythms, documents and key counts (beyond the twelve-key and 64-step journeys) were not.
- The publication stall ([Task 624](../624-webview-publication-stall.md)) was not reproduced, so whether F hides or prevents it is unproven at runtime. An entry state the host never received still falls back to the resync (text correct, document dirty, native history rewritten).
- Beyond 64 host writes in one webview step, the walk refuses and the resync fallback applies (exercised by the 64-step journey).
- A refused walk's rollback and a mode switch after edits are covered at unit level or by the single special-journeys test only.
- The `undo-first-edit` paste:ir "race window missed" intermittent is unreproduced (0/6 on both products).
- The IR caret defect after Enter is pre-existing and tracked in Task 625.

## Acceptance

- [x] After any Undo or Redo, host text equals webview text exactly, whatever the typing rhythm
  (measured rhythms above; SV compares the SV edit form; large and CRLF documents return to the exact
  original bytes per the Owner decision). Beyond 64 host writes in one webview step, or for an
  unpublished entry state, the walk refuses and the resync fallback applies.
- [x] The dirty flag and disk bytes after save and reopen are exact.
- [x] Redo has the same guarantee as Undo (Owner decision): real-VS-Code Redo chains plus each gap journey, with native Redo kept (S3a, S3e: 8/8 twice).
- [x] SV: after Undo the document is clean at the saved state and native text-editor history is not rewritten (SV gaps and large SV legs, S3a and S3e).
- [x] Large documents: Undo returns the host to the exact original bytes and native Redo is not skipped (large IR, WYSIWYG and SV legs, including primed WYSIWYG at 2,000 ms after the S3c fix).
- [x] Focused gates and regression sets pass or match the recorded baselines (S3e, S3g); the one intermittent is recorded and unreproduced.
- [ ] Not claimed: F's effect on the Task 624 publication stall, which was not reproduced (see Residual risks).
