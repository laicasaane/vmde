# Task 628 — Undo after Enter and a key in a list item or table cell leaves the host dirty

**Status:** done (2026-10-14).
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

The host history walk from [Task 602](602-undo-step-spanning-host-edits.md) does not find the view's text in native history, because the view holds an empty list item or cell state that the host never wrote. Needs measuring before any fix.

## Tests

- Real-VS-Code XTEST test cases that reuse the probe test cases: IR and WYSIWYG list, IR and WYSIWYG table last cell.
- Each test case: open, Enter, type a key, Ctrl+Z twice, then assert host text equals the opened bytes and the host is clean. Then Redo twice and assert symmetry.
- Keep the paragraph, heading, blockquote and code cases as regression controls.

## Acceptance

- [x] Root cause measured and recorded here. Evidence: Part 1 handoff, S1 measurement and S3b cause section: the boundary state of an Enter was published with the key (one host write for two Vditor entries), and later a state that renders like the host text was written and reverted.
- [x] After Enter, a key and two Undos, the host equals the opened bytes and is clean, in IR and WYSIWYG for list and table. Evidence: Real-VS-Code `list-table-enter-undo.spec.ts` (29 test cases, passed in S3b Phase 2): IR and WYSIWYG list and table last cell at 100 and 1,000 ms gaps and both Undo cadences end with the host equal to the opened bytes and clean.
- [x] Redo is symmetric in the same cases. Evidence: Same spec: after two Redos the host equals the typed text in every case (S3 table, S3b Phase 2).
- [x] SV list undo behavior recorded (and fixed if it is also wrong). Evidence: SV list recorded in S1 (two writes, one native step per Undo, exact) and asserted in the spec; no fix needed.
- [x] Control cases (paragraph, heading, blockquote, code) still undo normally. Evidence: Spec controls for paragraph, heading, blockquote and code; `enter-new-paragraph.spec.ts` 6 passed with the Task 627 expectations unchanged (S3b Phase 2).
- [x] Focused real-VS-Code spec written and run; `npm run quality` passes. Evidence: `list-table-enter-undo.spec.ts` written and run (1 passed, 9.6 min); `npm run quality` is met by the closure gate list below, audit omitted by Owner instruction.

Related: [Task 602](602-undo-step-spanning-host-edits.md), [Task 625](625-ir-enter-next-char-wrong-block.md), [Task 627](627-enter-at-document-end-new-paragraph.md).

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

## Execution progress — 2026-10-14 (S2)

S2a + S2b merged. Change: `boundary()` in `media-src/src/editing/undo-boundaries.ts` now calls `options.input(getValue())` before `checkpointUndoBoundary` in its settle pass (R1). The entry's flush (`onEntryRecorded` → `flushHistoryInput`) then sees the scheduled edit and posts the boundary's state at entry time. The skip condition for the checkpoint, the cancel of Vditor's pending after-render, the forced pre-checkpoint and the host walk are unchanged (R2, R3). The collapse-toggle early return and the Turn Into coalesce were not touched.

Tests written first and shown failing (13 failing cases in `undo-boundaries.test.ts` before the change; 20 failing Chromium cases with the change temporarily reverted):

| Layer | File | Proves |
|---|---|---|
| Vitest | `undo-boundaries.test.ts` (new describe) | Enter, Shift+Enter, paste, toolbar action, editor action and IR syntax promotion: `input`, then entry, then one post, in IR, WYSIWYG and SV (acceptance 2-3, R1). A skipped entry still publishes once through `input()`. Two fast Enters: the first publishes at its entry, the second through `input()`. IME-composing Enter takes no boundary. No entry, no flush. |
| Vitest | `undo-boundaries.test.ts` (6 existing order assertions) | Updated from `add, getValue, input` to `getValue, input, add` (the intended contract change). |
| Vitest | `test/backend/history-coupling.test.ts` (2 new, both pass before and after: the walk is unchanged) | Control: two webview entries over one host write → Undo refused, one native Redo rolls back, host keeps the typed text (pins the S1 shape). R3: with each entry published, the same walk takes one native step per entry with a published proof. |
| Chromium | `media-src/e2e/undo-boundaries.spec.ts` (new describe, IR and WYSIWYG) | List item and table last cell: Enter, 100 ms, key → one host stop at 100 ms after Enter (before the 250 ms debounce), two after the key, host equals the live value (acceptance 2-3). Edge cases: Enter mid-item (split), ordered list (renumber), nested list, non-last table cell, table header cell, blockquote, empty item then list exit, two fast Enters. Controls (R2, acceptance 5): paragraph and heading add no host stop at Enter and one after the key; code block at document end adds none. |

Harness: `undo-boundaries-harness.ts` gained the docs the cases need and a `flush=1` parameter that wires `onEntryRecorded` to the sink flush as `boot/finish-init.ts` does (default off, so existing real-mode cases are unchanged), and `__hostStops()`.

Finding that changes S3: in IR and WYSIWYG a blockquote Enter serializes a new `>` line, so a blockquote is an R1 case (its Enter state is now published at entry time, one extra native stop), not an R2 control. The R2 controls here are paragraph, heading and code block.

Checks (exit 0 each): `vitest run` of `undo-boundaries.test.ts`, `finish-init.test.ts`, `undo-keybind.test.ts`, `history-coupling.test.ts` (229 passed; the two touched files 209 passed after formatting); `npm run typecheck`; `biome check` on the five touched files; `node build.mjs`; Chromium (`undo-boundaries.spec.ts`, `undo-pending-diagram.spec.ts`, `paste-pipeline.spec.ts`, `toolbar-selection.spec.ts`: 117 passed, the last two exercise `boundary()` through the shared harness; own server port because the default one was busy, temporary config deleted).

Open: S3 (real VS Code): IR and WYSIWYG list and table, 100 and 1,000 ms gaps, both Undo cadences, end state host equals the opened bytes and clean, Redo symmetric; rerun the specs listed in Part 1.

## Execution progress — 2026-10-14 (S3)

Real VS Code 1.129.0, OS-level (XTEST) keys, on the S2 build (R1 in place). New spec `test/vscode-e2e/list-table-enter-undo.spec.ts` (one `test()` block: every state shares one boot and runs on a fresh document; 29 test cases; values are lengths and booleans). Not committed. **Result: 28 of 29 test cases pass; one product failure (WYSIWYG blockquote) and two regressions in an older spec (blockquote and empty document) are open, see below.**

### What the spec asserts, and the result

| Acceptance | Test cases | Assertions | Result |
|---|---|---|---|
| 2 (host equals the opened bytes and is clean after two Undos) | IR and WYSIWYG x list item and table last cell x gap 100 / 1,000 ms x Undo cadence fast (next press 500 ms after the host is quiet) / resynced (at least 1.5 s and 700 ms quiet) = 16 | Enter then `Y` makes exactly two host writes; Undo 1 and Undo 2 are each one native step with no native Redo; after Undo 1 the host holds the earlier entry state, not the typed text; after Undo 2 (+3 s) the host equals the opened bytes and `isDirty` is false | 16 of 16 pass |
| 3 (Redo symmetric) | the same 16 | after two Redos the host equals the text the key left (list: the new item holding `Y`) | 16 of 16 pass |
| 4 (SV list recorded) | SV list, 100 ms | the same assertion set | passes |
| 5 (controls) | IR and WYSIWYG x paragraph, heading, blockquote, code | paragraph and heading: one host write; blockquote: two host writes (published shape); all: Undo x2 returns the opened bytes, clean; Redo x2 returns the typed text | 7 of 8 pass; **`wysiwyg-quote-enter-100-fast` fails** |
| paste / Bold | IR and WYSIWYG x paste, toolbar Bold, then `Y` 100 ms later | Undo x2 returns the opened bytes, clean; Redo x2 returns the typed text | 4 of 4 pass |

The two-writes-at-100-ms and one-native-step-per-Undo assertions fail on the pre-R1 build by the S1 measurement (one write, native Undo then Redo rollback) and pass now. Two runs of the final spec: both 28 of 29, the same single failing case.

### Product failure: WYSIWYG blockquote (Enter, 100 ms, `Y`)

After two Undos the host text equals the opened bytes but the document is dirty (run 1: 2 writes then 4 plain writes in the Undo presses; run 2: 3 writes from Enter to the key). Trace-level log of the same case: Undo 1 is `reached the transition result` (exact, 1 step) and the host sits at the Enter state; the webview then writes plain texts that alternate between the opened-equivalent text and the Enter state (lengths 58, 60, 58); Undo 2 ends on the opened text via a plain write, so the document is dirty. IR blockquote at the same cadence ends clean; at the older spec's cadence (Undo held until 1.2 s after the key) it also ends dirty and alternates 60/58/60. Cause (inferred from the log): a blockquote Enter state (`> ...` plus an empty `>` line) is byte-different from the opened text but renders back to it, so after a history render the webview serializes the opened-equivalent text again and the host and the webview trade plain writes; the walk treats the semantically equal state as "already there" and leaves the host on the byte-different Enter state.
Pre-R1 comparison (R1 reverted, rebuilt, same cases): blockquote at 100 ms is one write, Undo 1 jumps to the opened bytes (semantic proof), Undo 2 does nothing, clean.

### Rerun list (each once, `--workers=1 --retries=0`)

| Spec | Result |
|---|---|
| `undo-host-coupling.spec.ts` | 8 passed (26.3 min) |
| `list-enter-undo-caret.spec.ts` | 1 passed |
| `list-enter-start.spec.ts` | 1 passed |
| `undo-boundaries.spec.ts` | 1 passed |
| `undo-pending-checkpoint.spec.ts` | 4 passed (6.6 min) |
| `find-replace.spec.ts` | 3 passed |
| `save-flush-routes.spec.ts` | 2 passed |
| `edit-propagation.spec.ts` | 2 passed |
| `enter-new-paragraph.spec.ts` | 2 failed, 4 passed; passes 6 of 6 on the pre-R1 build |

`enter-new-paragraph.spec.ts` (Task 627) failing cases, all with Enter, `Y` 100 ms, Undo x2 and Undo pressed 1.2 s after the key:
- IR and WYSIWYG blockquote: "Undo 1 reaches the opened bytes" and "the host is clean" fail. Expected consequence of R1 (the `>` line state is now its own host state), with the dirty end state above.
- IR and WYSIWYG empty document: Undo 1 and Undo 2 leave the host at one newline (opened text is empty) and dirty. The Enter state of an empty document (one newline) is published at entry time; the walk treats it as equal to the opened empty text and never returns the host to the empty bytes. Deterministic in two runs (full spec and the WYSIWYG test alone).
- WYSIWYG paragraph without a trailing line feed and heading: "Undo 1: the host is clean" failed in the full run and passed in the single-test rerun; the trace of the same cadence (Undo 1 native, host clean 100 ms later, `isDirty` true only inside the change event) shows a read race, not a regression. Classified intermittent, unproven.

### Open design question (for the orchestrator)

R1 publishes every Enter state, including states that are byte-different from the host but equal to it after rendering (blockquote empty line, empty-document newline). The history walk accepts such a state as "already at the result", so the host stays on it and ends dirty. Candidate fix, not applied: when the boundary state is semantically equivalent to the current host text (the same equivalence the walk uses), do not write it (R2 extended from byte-equal to equivalent). Needs a decision before closure.

Checks: `npm run typecheck:vscode-e2e` exit 0; `biome check` of the new spec clean (two documented complexity suppressions as in the other long real-VS-Code specs). Scratch specs used for traces were deleted; the temporary pre-R1 build was restored and rebuilt (source identical to the S2 commit).

## Execution progress — 2026-10-14 (S3b)

### Phase 1 (Vitest and Chromium; no real VS Code)

**Cause of the S3 failures, from the source.** The host skips a semantic no-op only on a deferred idle timer (`resolveNoopCheck`): it writes a posted edit first, then restores the clean baseline bytes when the whole document turns out to render like the baseline (Lute IR round trip, trailing newlines ignored). R1 now publishes the blockquote Enter state (an empty `>` line) and the empty document's Enter newline at entry time. Both are byte-different from the host text but render like it, so the host wrote them and then wrote the baseline back, and the native Undo history could not follow: the plain-write alternation and the dirty end state seen in S3.

**Change (R2 extended from byte-equal to equivalent after rendering).** `installUndoBoundaries` gets an optional `equivalentToHost(markdown)`. In the settle pass `boundary()` reads the live Markdown once (`getValue()`, as R1 already did) and still records the entry, but it does not call `input()` when the state is equivalent, so nothing is scheduled or flushed (no host write, no extra native stop). `edit-sync` provides `equivalentToHost(rendered)`:
- Reference text: `hostBase` while the host bytes are known exactly (open, a host update, an exact post); after a plain post the host minimizes against its own bytes, so the reference is that post's content (`hostReference`, cleared where `hostBase` is cleared).
- Equivalence: both texts through Lute's IR round trip (`Md2VditorIRDOM`, then `VditorIRDOM2Md`) and equal up to trailing newlines. This is the host's own test (`isSemanticNoop` over `canonicalIrMarkdown`), run through the IR round trip whatever mode is active, because the WYSIWYG round trip drops a table cell's trailing `<br />` and would wrongly call the Enter state of a table cell equivalent (a unit case fails otherwise).
- Cost: one extra round trip of the live text per boundary (Enter, paste, toolbar action; not per keystroke) after the `getValue()` R1 already pays; the reference's projection is cached per text and mode. The check declines (false, so the boundary publishes) past 100,000 characters (the host's own size cap), without a reference, or without Lute.
Wiring: `vditor-init.ts` and `finish-init.ts` pass `equivalentToHost` to `installUndoBoundaries` like `flushHistoryInput`.

**Tests, written first and shown failing.** Before the change: 14 failing Vitest cases (10 in `edit-sync.test.ts`, 4 in `undo-boundaries.test.ts`) and 4 failing Chromium cases; the other 24 Task 628 Chromium cases passed.

| Layer | File | Proves |
|---|---|---|
| Vitest (real Lute) | `edit-sync.test.ts`, "equivalentToHost (Task 628)" | IR and WYSIWYG: a blockquote's empty quote line, the empty document's newline, the opened text and a trailing-newline difference are equivalent; a new list item, a table cell break and typed text are not; after a plain post the reference is that post; no reference, a text past the cap or no Lute decides nothing |
| Vitest | `undo-boundaries.test.ts` | an equivalent state (Enter, paste, toolbar action) records its entry and calls neither `input()` nor the flush; a different state still publishes at entry time |
| Chromium | `undo-boundaries.spec.ts` Task 628 describe (harness `flush=1` now models the host holding the opened bytes and wires the same check) | IR and WYSIWYG blockquote and empty document: Enter adds no host stop and the host text is unchanged at 100 ms; the key then makes exactly one stop and the host equals the live value. List item, table last cell, split, ordered, nested, non-last cell, header, empty-item exit, two fast Enters and the paragraph, heading and code controls are unchanged |

**Results (exit 0 unless noted).** Vitest `edit-sync`, `undo-boundaries`, `finish-init`, `vditor-init` tests: 337 passed. `npm run typecheck`, `biome check` of the eight touched files, `node build.mjs`. Chromium (temporary config on a free port, deleted): Task 628 describe 28 passed; `undo-boundaries.spec.ts` whole plus `incremental-md.spec.ts`, `auto-wrap.spec.ts`, `table-format.spec.ts` (the last three drive harnesses that import `edit-sync`): 104 passed, 1 failed (the known `auto-wrap` SV case).

**Open for Phase 2 (real VS Code, needs the token).** Rerun `list-table-enter-undo.spec.ts` with the blockquote control updated to the new shape (one host write from Enter to the key, not two) and `enter-new-paragraph.spec.ts` (6 of 6 with its Task 627 expectations unchanged, or explain a change against that contract). Risks to watch there: a table cell whose Enter state the host's round trip also treats as equivalent; a plain-post reference that no longer matches the host after an external edit.

### Phase 2 (real VS Code 1.129.0, OS-level keys, on the Phase 1 build)

| Spec | Result |
|---|---|
| `list-table-enter-undo.spec.ts` (29 test cases) | 1 passed (9.6 min), every case with no failed check |
| `enter-new-paragraph.spec.ts` | 6 passed (7.2 min), the Task 627 expectations unchanged |
| `undo-host-coupling.spec.ts` | 8 passed (28.3 min) |

New spec: the blockquote control now asserts the new shape. In IR and WYSIWYG a blockquote Enter followed by `Y` at 100 ms is one host write (the key; Enter publishes nothing), and after two Undos the host equals the opened bytes and the document is clean; Redo x2 returns the typed text. Paragraph and heading are also one write; list item, table last cell, SV list, paste and Bold keep their two-write, one-native-step-per-Undo assertions at both gaps and both Undo cadences. The code control still records its write count (two) and asserts only the undo contract.

Against the S3 failures: the WYSIWYG blockquote case is clean, and the Task 627 blockquote and empty-document cases (IR and WYSIWYG) pass with their original expectations (Undo 1 reaches the opened bytes, the host is clean, the empty document returns to empty text). The two intermittent dirty reads seen in S3 (WYSIWYG paragraph without trailing line feed, heading) did not recur.

`npm run typecheck:vscode-e2e` exit 0; `biome check` of the spec clean.

## Closure — 2026-10-14

- **Commits.** `3d9855e7` (publish the boundary state before recording its undo entry), `cafd59bb` (skip publishing a boundary state that renders like the host text), `3d78dc6b` (real-VS-Code spec); records `ad612400`, `37d55b73`, `b04ee912`.
- **Gates.** Closure batch run on the combined HEAD (`a0fde54f`): `lint:ci`, `typecheck`, `typecheck:vscode-e2e`, `knip`, `jscpd`, `depcruise`, `test:coverage` (337 test files passed, 6 skipped; 6,605 tests passed, 213 skipped), `check:coverage-modules` (11 modules at 0%, baseline 11) and `check:brand-identifiers` all exit 0. The audit stage was omitted by Owner instruction, so `npm run quality` was not run; acceptance items that ask for it are met by this gate list.
- **Bundle.** 1,008,312 B for `media/dist/main.js` (+1,670 B against the batch-2 close, 1,006,642 B). Eager modules 377 (budget 294, reporting only; the same count as the batch-2 close).
- **Real-VS-Code reruns (S3b Phase 2).** `list-table-enter-undo.spec.ts` 1 passed, `enter-new-paragraph.spec.ts` 6 passed, `undo-host-coupling.spec.ts` 8 passed.
- **Residuals and open items.** The IR end-state failure described in the Problem section did not reproduce in S1 (n = 1 per row); the earlier signal, the Undo 1 divergence, is asserted instead. The plain-post reference used by `equivalentToHost` can differ from the host bytes after an external edit (untested). The equivalence check declines (the state is published) past 100,000 characters. The check uses Lute's IR round trip and the extension's Lute settings are not covered. On a refusal the host still waits for the webview's echo (follow-up R4, offered to the Owner, not done). Every Enter or toolbar boundary that changes the text is its own native stop in the text editor's undo history (accepted).
