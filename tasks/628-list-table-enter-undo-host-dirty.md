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
