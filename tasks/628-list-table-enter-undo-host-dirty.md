# Task 628 — Undo after Enter and a key in a list item or table cell leaves the host dirty

**Status:** planned (2026-10-08). The Project Owner approved filing this record on 2026-10-08. Implementation has not started.
**Origin:** Task 625/627 probe (commit 630bd01b, `test/vscode-e2e/enter-new-paragraph-probe.spec.ts`), real VS Code with XTEST.
**Severity:** high (estimated). Host and view diverge after Undo, and the host stays dirty.
**Tech stack:** extension host undo/history walk (`src/session/`), webview Enter handling, real VS Code with XTEST.

## Problem

In IR and WYSIWYG, pressing Enter and then a key inside a list item or the last table cell, then pressing Ctrl+Z twice, leaves the document in the wrong state. The host keeps the typed key while the view loses it, and the host stays dirty.

## Evidence

From the probe spec, measured in real VS Code with XTEST:

- IR and WYSIWYG list (`- echo\n- foxtrot`): Enter then Y gives `- Y`. The first Ctrl+Z runs a native host Undo and then Redo. The host keeps the typed key while the view loses it. The second Ctrl+Z restores the view to the opened text but does not change the host, so the host stays dirty with the typed key.
- IR and WYSIWYG table last cell: Enter gives a `<br>`, and Y lands in the cell (`hotelY`). The undo behavior is the same as for the list.
- Paragraph, heading, blockquote and code cases undo normally: two host steps back to the opened bytes, and the host is clean.
- SV list: the first Undo leaves the host at `- foxtrot\n- \n`, and the second returns it to the opened bytes.

## Suspected cause (unverified)

The host history walk from [Task 602](done/602-undo-step-spanning-host-edits.md) does not find the view's text in native history, because the view holds an empty list item or cell state that the host never wrote. Needs measuring before any fix.

## Tests

- Real-VS-Code XTEST test cases that reuse the probe test cases: IR and WYSIWYG list, IR and WYSIWYG table last cell.
- Each test case: open, Enter, type a key, Ctrl+Z twice, then assert host text equals the opened bytes and the host is clean. Then Redo twice and assert symmetry.
- Keep the paragraph, heading, blockquote and code cases as regression controls.

## Acceptance

- [ ] Root cause measured and recorded here.
- [ ] After Enter, a key and two Undos, the host equals the opened bytes and is clean, in IR and WYSIWYG for list and table.
- [ ] Redo is symmetric in the same cases.
- [ ] SV list undo behavior recorded (and fixed if it is also wrong).
- [ ] Control cases (paragraph, heading, blockquote, code) still undo normally.
- [ ] Focused real-VS-Code spec written and run; `npm run quality` passes.

Related: [Task 602](done/602-undo-step-spanning-host-edits.md), [Task 625](done/625-ir-enter-next-char-wrong-block.md), [Task 627](done/627-enter-at-document-end-new-paragraph.md).

## Part 1 handoff (2026-10-14)

Read-only review of the source plus scratch Lute and minimal-diff simulations; real VS Code not measured (S1 tests the prediction).

- **Cause (inferred).** (1) `media-src/src/editing/undo-boundaries.ts` `boundary()`: on Enter the keydown listener arms a zero-delay timer that first calls `checkpointUndoBoundary` (Vditor records the post-Enter entry) and only then calls `options.input()` (schedules edit-sync's 250 ms debounce). (2) The checkpoint flush (`boot/finish-init.ts` `onEntryRecorded` → `bridge/edit-sync.ts` `flushHistoryInput`) runs at that checkpoint while no edit is pending yet, so it publishes nothing; when a key follows within 250 ms, the Enter state and the key leave in one host write while Vditor holds two entries. (3) Only list and table fail because their Enter state serializes to new text (`- foxtrot\n-\n`; a table cell `<br />` plus padding and a blank line), whereas an empty new paragraph, heading or blockquote block does not serialize, so the proofs succeed there. (4) Host walk (`src/writeback/history-coupling.ts`): Undo 1's target is the Enter state the host never held; one native Undo reaches the opened bytes where no proof holds, the next step makes no progress, so it rolls back one Redo (the measured "native Undo then Redo") and `postUpdate` does nothing (`isAlreadySynced`); Undo 2 matches neither side, so the host stays at the typed text, dirty. (5) Second hole (inferred): the Task 602 fallback "the next plain edit resyncs" relies on the history render's after-render input about undoDelay + 250 ms later; an Undo pressed sooner replaces that record, so the divergence survives until the next typing.
- **Contract.** R1: every Vditor entry made by `boundary()` publishes its state at entry time — call `options.input()` before `checkpointUndoBoundary` so the flush sees a pending edit (or call `flushHistoryInput` explicitly after `input()`); covers Enter, Shift+Enter, paste, toolbar actions, syntax promotion and editor actions. R2: no host write when the boundary state equals the host text (already true via the writeback no-write path, so paragraph cases gain no native stop). R3: the host walk is unchanged; the R1 publish gives a published-pair proof (exact for the list).
- **Part 2.** S1 (real VS Code, XTEST): IR and WYSIWYG list item and table cell, per press: host writes, native steps, proofs (host `history coupling` debug lines), host text, dirty, and a 3 s settle after Undo 2. Falsifiable prediction: a 100 ms gap shows one host write for Enter+key and fails; a 1,000 ms gap shows two writes and passes — if 1,000 ms also fails, this cause is wrong. Also paste or toolbar Bold followed by a key within 250 ms (same shape predicted), and an SV list as a control. S2a RED: `undo-boundaries.test.ts` (input is scheduled before the checkpoint so the flush sees a pending edit); `history-coupling.test.ts` (two entries over one write → refusal and rollback, pinning the walk); Chromium list and table Enter+key at 100 ms produce two edit posts. S2b: the `boundary()` ordering (R1). S3: new real-VS-Code `list-table-enter-undo.spec.ts` (IR and WYSIWYG list and table at 100 and 1,000 ms gaps: after two Undos the host equals the opened bytes and is clean; Redo ×2 symmetric; SV list and paragraph, heading, blockquote, code controls); rerun `undo-host-coupling` (route counts in its flush journey may change), `enter-new-paragraph`, `list-enter-undo-caret`, `list-enter-start`, `undo-boundaries`, `undo-pending-checkpoint`, `find-replace`, `save-flush-routes`, `edit-propagation`. S4: closure.
- **Edge cases.** Enter mid-item (split), on an empty item (list exit), nested and ordered lists (renumber); table Enter in a non-last cell and the header row; two fast Enters; CRLF; large WYSIWYG (R1 serializes synchronously at each boundary); exact ownership after Find or Rewrap (`settleExactInput` must still cancel when no user input is pending); IME (boundary refused).
- **Decisions (orchestrator, 2026-10-14; reversible).** (1) R4 — on a refusal, write the target text to the host at once instead of waiting for the webview's echo — changes the Task 602-approved fallback timing; not in this task; offered to the Owner as a follow-up. (2) Every Enter or toolbar boundary becomes its own native stop in the text editor's undo history; accepted (it matches the stated intent of the Task 602 checkpoint flush). (3) Routing: with the cause localized to the `boundary()` ordering, S2b no longer needs a separate implementation session for a shared history layer (no hidden coupling remains after Part 1; the host walk is unchanged); reconsider if S1 falsifies the cause.
- **Risk.** The cause rests on source reading and simulation, not a run (S1 decides).

## Execution progress — 2026-10-14 (S1)

Measurement only (no product edits). Real VS Code 1.129.0 with OS-level (XTEST) keys, one scratch spec (deleted after the run, never committed). Every value was read through the page (`evaluate`), the host (`onDidChangeTextDocument`, document text and dirty state) or the host log at trace level (`history coupling` lines); no screenshots, no document text recorded. Fixture: a heading, one paragraph and then `- echo\n- foxtrot` (opened text 54 characters) or a 2x2 table (87 characters); the caret sits at the end of the last list item or the last table cell. Keys: Enter, then `Y` after the gap, 1.5 s settle, then Ctrl+Z, Ctrl+Z, Ctrl+Y, Ctrl+Y. Two Undo cadences: "probe" (the next press 500 ms after the host is quiet, the cadence of the Task 625 probe) and "slow" (at least 1.5 s and 700 ms quiet). A 3 s settle follows Undo 2. One run per row (n = 1); 17 rows in the main run, plus 2 WYSIWYG slow-cadence rows in a short follow-up run on the same build.

Legend. "Writes" = host document changes (count, text lengths); N = native Undo/Redo steps (change reason 1/2); P = plain write (reason 0, the webview's echo or resync); rollback = `history coupling rolled back ... no-progress`; exact/base/published = proof kind of `history coupling reached the transition result`; "=open" = host text equals the opened bytes; dirty = `isDirty`.

### Enter + key, probe cadence

| Case | Gap | Writes Enter..settle | Vditor entries | Undo 1 | Undo 2 (+3 s) | Redo 1 | Redo 2 |
|---|---|---|---|---|---|---|---|
| IR list | 100 ms | 1 write (58) | 2 | N undo + N redo (rollback, 1 step); host keeps the typed text, view at the Enter state (56); dirty | P(56), N, N, exact; =open, clean | 2 N, exact; 56, dirty | 0 N, P(58), rollback; host = typed, dirty |
| IR list | 1000 ms | 2 writes (56, 58) | 2 | 1 N, exact | 1 N, exact; =open, clean | 1 N, exact | 1 N, exact; host = typed |
| IR table | 100 ms | 1 write (94) | 2 | N undo + N redo (rollback); host keeps typed (94); dirty | P(93), N, N, base; =open, clean | 2 N, published | 0 N, P(94), rollback |
| IR table | 1000 ms | 2 writes (93, 94) | 2 | 1 N, published | 1 N, base; =open, clean | 1 N, published | 1 N, published |
| WYSIWYG list | 100 ms | 1 write (58) | 2 | N undo + N redo (rollback); host keeps typed (58); dirty | 0 writes at quiet; log `skipped: host does not match transition start`; 3 s later P(54): =open but dirty (not clean) | 0 writes, rollback; host 54, view 56 | P(58), `skipped`; host = typed |
| WYSIWYG list | 1000 ms | 2 writes (56, 58) | 2 | 1 N, exact | 1 N, exact; =open, clean | 1 N, exact | 1 N, exact |
| WYSIWYG table | 100 ms | 1 write (88) | 2 | N undo + N redo (rollback); host keeps typed (88); dirty | 0 writes at quiet, `skipped`; 3 s later P(87): =open but dirty | 0 writes, rollback | P(93), P(88), rollback; host = typed |
| WYSIWYG table | 1000 ms | 2 writes (93, 88) | 2 | 1 N, published | 1 N, base; =open, clean | 1 N, published | 1 N, published |
| SV list | 100 ms | 2 writes (57, 58); the first at about 110 ms | 2 | 1 N, exact | 1 N, exact; =open, clean | 1 N, exact | 1 N, exact |
| SV list | 1000 ms | 2 writes (57, 58) | 2 | 1 N, exact | 1 N, exact; =open, clean | 1 N, exact | 1 N, exact |

Vditor entries: the Enter entry arrives 44-195 ms after Enter, the key entry about 1.0-2.2 s after Enter (after Vditor's undo delay). In the 100 ms Enter, paste and Bold rows (SV excluded) the single host write arrives 314-697 ms after the action, after the key; none of those 8 rows wrote before the key. In the 1000 ms IR and WYSIWYG rows the first write arrives 323-480 ms after Enter, before the key, in all 4 rows.

### Slow cadence (Undo pressed after the echo write had arrived)

| Case | Gap | Undo 1 | Undo 2 (+3 s) | Redo 2 |
|---|---|---|---|---|
| IR list | 100 ms | N undo + N redo (rollback), then P(56); host 56, view 56 | 2 N, exact; =open, clean | 0 N, P(58), rollback |
| IR list | 1000 ms | 1 N, exact | 1 N, exact; =open, clean | 1 N, exact |
| IR table | 100 ms | rollback, then P(93) | 2 N, base; =open, clean | 0 N, P(94), rollback |
| WYSIWYG list | 100 ms | rollback, then P(56) | 2 N, exact; =open, clean | 0 N, P(58), rollback |
| WYSIWYG table | 100 ms | rollback, then P(93) | 2 N, base; =open, clean | 0 N, P(88), rollback |

### Paste and toolbar Bold followed by `Y` at 100 ms (list item, probe cadence)

| Case | Writes | Undo 1 | Undo 2 (+3 s) | Redo 2 |
|---|---|---|---|---|
| IR paste | 1 write (57) | N undo + N redo (rollback); host keeps typed | P(56), N, N, exact; =open, clean | 0 N, P(57), rollback |
| WYSIWYG paste | 1 write (57) | same | same | same |
| IR Bold | 1 write (59) | same | P(58), N, N, exact; =open, clean | 0 N, P(59), rollback |
| WYSIWYG Bold | 1 write (55) | 1 N, exact; =open, clean (no rollback) | 0 writes (no history line) | 1 N, exact |

### Verdict

- **The mechanism is confirmed.** With a 100 ms gap every Enter case (IR and WYSIWYG, list and table) and the paste and IR Bold cases publish Enter (or the action) and the key as one host write while Vditor holds two entries. Undo 1 then fails the walk: one native Undo reaches the opened bytes, no proof holds, the next step makes no progress, one native Redo rolls back (`stop: no-progress`, `rollback: restored`), and the host stays at the typed text while the view shows the Enter state. With a 1,000 ms gap every case writes twice (the Enter state about 250-500 ms after Enter, before the key) and every Undo and Redo passes with one native step and an exact, base or published proof. The SV list writes the Enter state at once even at 100 ms and passes. So the 100 ms / 1,000 ms prediction holds for the write count, for the refusal and rollback at Undo 1, and for the 1,000 ms pass.
- **The final state after Undo 2 is narrower than the Problem section says.** At 100 ms the end state after Undo 2 and a 3 s settle differs by mode: WYSIWYG list and table end with the host text equal to the opened bytes but dirty (Undo 2 arrives before the webview's resync write, the walk logs `skipped: host does not match transition start`, and the later plain write is a new edit, not a native Undo, so the document stays dirty); IR list and table end equal to the opened bytes and clean, because the resync write (P) reaches the host before Undo 2 is handled and the walk then takes 2 native steps. In this run the IR failure the Problem section describes (host keeps the typed key, stays dirty after Undo 2) did not reproduce (n = 1 per row, both cadences), and the typed key was never left in the host after Undo 2 in any row.
- **Inferred cause (5) is confirmed for WYSIWYG.** The same 100 ms WYSIWYG cases pass at the slow cadence (the resync write lands before Undo 2: 2 native steps, `=open`, clean), and fail (dirty) at the probe cadence, so the divergence after Undo 1 survives until the resync write, and an Undo pressed before it lands ends dirty.
- **Redo.** At 100 ms Redo 2 takes no native step in the Enter, paste and IR Bold rows (rollback, then a plain write of the typed text), so the host reaches the typed text but through a plain edit; at 1,000 ms Redo 2 is a native step. Text symmetry holds in all rows (final host = typed text); step symmetry does not at 100 ms.
- **Bold in WYSIWYG** is a different shape: the Bold boundary state serializes to the same text as the host, so there is no refusal (this matches contract R2); Undo 1 reaches the opened bytes and Undo 2 does nothing.
- Prediction status: holds for the write count and Undo 1 refusal in all modes; the dirty end state holds in WYSIWYG only. Nothing falsified. The inferred cause stands. S2a RED tests (input scheduled before the checkpoint; two entries over one write pinning the walk) match the measured shapes.

### Open

- The IR failure of the Problem section was not reproduced (n = 1 per row); whether it depends on the echo-versus-Undo race at a different cadence is unmeasured. Part 2 acceptance should assert the end state (host equals the opened bytes and is clean) at a 100 ms gap in both IR and WYSIWYG, and Undo 1 (no host/view divergence) as the earlier signal.
- Acceptance item 1 (root cause measured and recorded): done by this section. Items 2-6 remain open for S2/S3.
