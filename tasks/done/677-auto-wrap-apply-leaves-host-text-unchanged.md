# Task 677 — Auto-wrap apply leaves the host text unchanged

**Status:** done (2026-11-01).
**Origin:** Task 669 (step B2), Task 672.
**Severity:** medium (estimated; manual Rewrap works).
**Tech stack:** `media-src/src/boot/main.ts` (`captureAutoWrapTarget`, `autoWrapController`), `media-src/src/editing/rewrap-command.ts` (`runRewrapCommand`), `test/vscode-e2e/auto-wrap.spec.ts`, `test/vscode-e2e/auto-wrap-proof-cost.spec.ts`.
**Depends on:** none.

## Problem

In real VS Code the auto-wrap firing does not change the host text in the Source-mode pass of `auto-wrap.spec.ts:31` (it fails at `:603`: the paragraph stays `alpha beta gammaz delta epsilon`; the IR and WYSIWYG passes pass). Task 672 measured the same on the large IR fixture: the firing runs its proof (two whole-document serializations), but the wrapped text never reaches the host, while a manual Rewrap on the same state applies it. The Chromium harness applies the wrap. Measured on `90611a6b` and again on `5aaf5d16`. It does not use the Source-mode table and list commands changed by Task 669.

## Proposed work

Measure where the firing declines between `captureAutoWrapTarget` and the host post (target capture, the target-current check after the delay, the proof, or the post), then fix the decline without weakening the Task 606 proof rules.

## Tests to write

- Make `auto-wrap.spec.ts:31` pass (Source mode included), and let the large-fixture case in `auto-wrap-proof-cost.spec.ts` assert that the host text changed (it only prints it today).
- A Vitest case for the decline point once it is known.

## Part 1 handoff (2026-11-01)

Measured on `03a20622` with scratch real-VS-Code probes (an untracked copy of the two specs that records, in the webview, the auto-wrap timer callback, `addToUndoStack`, `setValue`, whole-document `VditorIRDOM2Md` calls and every message posted to and received from the host). Chromium and the unchanged acceptance specs were also run as a baseline.

### Root causes (two, independent)

The Source-mode failure and the large-IR failure have different causes and need different fixes.

1. **Source mode: the capture declines on the auto-wrap's own snapshot.** `captureAutoWrapTarget` (`media-src/src/boot/main.ts:563`) stores `sessionState.editSync?.snapshotMarkdown()` as `target.markdown`, and the firing passes it to `runRewrapCommand` as the authoritative text. In Source mode that snapshot is `serializeSvForHost`, which removes the newline span Vditor appends. `rewrapTarget` then takes the legacy capture, and `captureRewrapSourceRange` returns `null` unless the marker mapping (built from the editor's `textContent`) equals the authoritative text. Measured at the firing: snapshot 99 characters ending `" beta\n"`, `textContent` and `getValue()` 100 characters ending `"beta\n\n"`. The firing makes no undo checkpoint, no `setValue` and no post, so the host keeps `alpha beta gammaz delta epsilon`. A manual Rewrap on the same state passes no authoritative text, uses `getValue()`, and applies (measured). In IR and WYSIWYG `rewrapTarget` ignores `target.markdown` (Task 606: the proof decides), so Source mode is its only consumer. The Chromium harness copies the same wiring (`media-src/e2e/rewrap-harness.ts:295-308`), and its Source-mode case `media-src/e2e/auto-wrap.spec.ts:118` fails the same way (`syncs` stays 0; recorded earlier as `auto-wrap:112`).
2. **IR: Vditor's delayed undo entry publishes the typing as a plain edit before the firing.** Vditor's IR `undoDelay` is 800 ms (`DEFAULT_UNDO_DELAY`), so with an auto-wrap delay of 800 ms or more Vditor's own `addToUndoStack` runs first. Its recorded entry calls `flushHistoryInput()` (via `onEntryRecorded` in `boot/finish-init.ts:244`). With auto-wrap pending in IR (`deferTypingPost()` true) but no proven rebase yet (`lastRebase` null), `flushHistoryInput` falls through to `settleExactInput()` and posts the typing as a plain edit, which ends exact ownership. On the non-round-trip large fixture the firing then finds no exact source: the source index sends `request-exact-authority` in the background, the proof returns `unavailable`, and the firing declines without a message. The authority reply arrives about 700 ms later and nothing retries. Measured with the spec's own flow (delay 800): the typing went out as a plain edit about 400 ms before the firing, and the host text was still unchanged 8 s later. With delay 777 (firing 23 ms before Vditor's entry) the same flow applies the wrap. The firing proves the typing, the entry flush posts it exactly from `lastRebase`, and the exact wrap post follows. The IR and WYSIWYG passes of `auto-wrap.spec.ts` use 500 ms, which is why they pass. The cause does not depend on document size: on the small fixture in IR with a delay of 1000 ms the firing declines the same way (plain typing post at Vditor's entry, then `request-exact-authority`; the reply arrived 15 ms after the firing gave up), while a manual Rewrap on that state applies. At 500 ms the small IR firing applies, and two Undos return the host to the typed text and then to the original.

The two whole-document serializations that Task 672 counted on the declining firing were not the proof pair. One was the plain typing flush at Vditor's entry, and the other was the source-index read after the firing. With the wrap applied, a firing costs three: the edit-sync rebase proof, the source-index read, and the `getValue()` in `syncExactHistory` (main.ts) for the Rewrap history record.

### Shared interfaces and invariants

- `EditSync.flushHistoryInput` (`bridge/edit-sync.ts:51`, `:1451`): Undo and Save callers (`undo-boundaries.ts:642`, `flush`) must keep publishing pending typing at once (Tasks 601 and 602; unit test `edit-sync.test.ts:153`). `undo-boundaries` prepares in a window capture `keydown` listener, which runs before the document capture `keydown` in main.ts that cancels auto-wrap. The Undo path therefore still sees `deferTypingPost()` true and must not be gated.
- The idle typing post already defers while auto-wrap is pending in IR (`onIdle`, `deferredPlainPost`), and `resumeDeferredInput` publishes it when the attempt ends. The fix extends that rule only to the recorded-entry flush.
- Task 606 and 607 proof rules stay unchanged: the proof still decides in IR and WYSIWYG, exact posts keep `before`, and no proof is relaxed. Source mode keeps its plain sync.
- Auto-wrap still does no target or full-document acquisition before its delay. Removing `target.markdown` removes one serialization per firing (a full `getValue()` in WYSIWYG).
- Overlap: Lane A (Task 675) changes `bridge/edit-sync.ts` near `provesExact` (about `:620`) and in `receiveExactAuthority` (about `:1311`), and appends cases to `edit-sync.test.ts`. This task changes `flushHistoryInput` (about `:1451`) and the `EditSync` interface (about `:51`). The hunks differ, but both tasks add tests to `edit-sync.test.ts`, so integrate after Task 675 or merge that file by hand. Task 680 (`rewrap-command.ts:419-432`) is not touched by this task.

### Decisions

- Provisional decision (2026-11-01), reversible — D1, Source-mode fix: remove the `markdown` field from the auto-wrap target in `main.ts` and call `runRewrapCommand` without an authoritative text, exactly as manual Rewrap does. Mirror the change in the Chromium rewrap harness. Rejected: reading `getValue()` only in Source mode (keeps two paths), and accepting the extra newline in `captureRewrapSourceRange` (edits `rewrap-command.ts`, which Task 680 follows). Selected by a recorded decision check (probability 0.95).
- Provisional decision (2026-11-01), reversible — D2, IR fix: `EditSync.flushHistoryInput` takes an optional `{ recordedEntry?: boolean }`, and only `onEntryRecorded` in `finish-init.ts` passes `{ recordedEntry: true }`. When `recordedEntry` is set, auto-wrap is pending (`deferTypingPost()`), and no live proven rebase exists, the typing stays deferred: set `deferredPlainPost`, cancel nothing, and return `false`. The firing's own entry then posts the typing exactly, or `resumeDeferredInput` publishes it when the attempt ends. Undo, Save and other callers do not change. Rejected: awaiting authority and retrying in the firing (adds a host round trip), and proving the rebase at the entry (adds a whole-document proof and changes the Undo path). Selected by a recorded decision check (probability 0.96).
- Provisional decision (2026-11-01), reversible — D3, cost pin: `auto-wrap-proof-cost.spec.ts` polls the host text until it equals the expected wrap (`rewrapMarkdownRange` on the typed text, as `auto-wrap.spec.ts` computes it). It then asserts three whole-document serializations, with a comment naming the two proof serializations and the history-record `getValue()`, and corrects the Task 672 comment. Rejected: counting only up to the wrap post (needs a message hook), and dropping the count. Selected by a recorded decision check (probability 0.96). If the GREEN run measures a different count, the step records the measured value and its sources instead of forcing three.
- Public names: the option name is `recordedEntry`; no enum, storage format or message changes.
- The two failures do not share one fix.

### Acceptance map

| Acceptance item | Test (layer, file, title) |
| --- | --- |
| Source-mode firing changes the host text | Real VS Code, `test/vscode-e2e/auto-wrap.spec.ts:31` "auto-wrap preserves bytes and interaction state in SV, IR, and WYSIWYG" (Source pass at `:603`) |
| Large-fixture firing changes the host text | Real VS Code, `test/vscode-e2e/auto-wrap-proof-cost.spec.ts:32` "proof-only auto-wrap on a large IR document …" (retitled to say the wrap reaches the host), asserting host text equals the expected wrap |
| Vitest case for the decline point | Vitest, `media-src/src/bridge/edit-sync.test.ts`: "a recorded history entry keeps auto-wrap's deferred typing until the attempt settles" (D2). Source mode: `media-src/src/editing/rewrap-command.test.ts`: "Source-mode Rewrap declines on a snapshot without Vditor's appended newline and applies without an authoritative text" (pins the measured decline point and the path D1 moves to) |
| Task 606 proof rules not weakened | Existing proof tests unchanged and passing: `rewrap-command.test.ts`, `selection-source-proof` tests; no edit to `rewrap-command.ts` or `selection-source-proof.ts` |
| Focused real-VS-Code run | The two specs above through the wrapper after `node build.mjs` |
| Quality stages | lint, typecheck, knip, jscpd, depcruise, `test:coverage`, `check:coverage-modules` (the audit stage is excluded by queue rule) |

### Edge cases and cheapest layer

- Undo and Save while auto-wrap is pending in IR still publish the typing at once: Vitest, the existing `edit-sync.test.ts:153` case, plus a `recordedEntry` variant that must not defer when no auto-wrap is pending.
- A recorded entry after a live proven rebase still posts the typing exactly (the existing `automatic` branch): Vitest, `edit-sync.test.ts`.
- The firing declines for another reason after a deferred entry: the typing is published by `resumeDeferredInput` exactly once: Vitest, `edit-sync.test.ts`.
- Source-mode case in the Chromium harness: `media-src/e2e/auto-wrap.spec.ts:118` (sv), which should pass once the harness mirrors D1.
- An IR firing whose delay is longer than Vditor's 800 ms `undoDelay`, on a small document, followed by two Undos (typed text, then the original): real VS Code. Add one IR pass with `editor.autoWrapDelay` 1000 to the mode loop of `test/vscode-e2e/auto-wrap.spec.ts:31`, reusing the loop's existing assertions. It fails today (measured: host unchanged) and is added in step R1.
- `finish-init` wiring passes `{ recordedEntry: true }` only from `onEntryRecorded`: Vitest, `media-src/src/boot/finish-init.test.ts` ("wires the history text, the checkpoint flush and the history base post").

### Part 2 step plan

Medium tier: one RED step, then one GREEN step, for each cause. Run Vitest with `npx vitest run --config test/vitest.config.mts <files>`. Before real VS Code, run `node build.mjs`, then use the wrapper.

1. **R1 (RED, IR decline point).** Files: `media-src/src/bridge/edit-sync.test.ts`, `media-src/src/boot/finish-init.test.ts`, `test/vscode-e2e/auto-wrap-proof-cost.spec.ts`, `test/vscode-e2e/auto-wrap.spec.ts` (one more IR pass at a 1000 ms delay in the mode loop). Add the D2 Vitest cases: `flushHistoryInput({ recordedEntry: true })` with `deferTypingPost` true and pending typing posts nothing and returns `false`, and a later `resumeDeferredInput` posts the typing once. Add the no-pending variant, which still posts. In finish-init, `onEntryRecorded` calls `flushHistoryInput` with `{ recordedEntry: true }`. In the proof-cost spec, poll the host text to the expected wrap and pin the count per D3. Checks: `npx vitest run --config test/vitest.config.mts media-src/src/bridge/edit-sync.test.ts media-src/src/boot/finish-init.test.ts`, where the new cases fail (an edit is posted, or the call has no argument) and every other case passes. Then `node build.mjs` and the wrapper on `auto-wrap-proof-cost.spec.ts auto-wrap.spec.ts`. The proof-cost case fails because the host text stays unwrapped; `auto-wrap.spec.ts:31` fails at its IR 1000 ms pass (or, if the loop runs Source mode first, at `:603`).
2. **G1 (GREEN, IR).** Files: `media-src/src/bridge/edit-sync.ts` (the interface and `flushHistoryInput`), `media-src/src/boot/finish-init.ts` (dependency type and `onEntryRecorded`), `media-src/src/boot/vditor-init.ts` (forward the option in the `flushHistoryInput` dependency). Checks: the same Vitest command, all passing; `npm run lint`; `npm run typecheck`; `node build.mjs`, then the wrapper on `auto-wrap-proof-cost.spec.ts auto-wrap.spec.ts`. The proof-cost case passes (host text wrapped, count as pinned), and `auto-wrap.spec.ts:31` gets past its IR passes and still fails at the Source pass (`:603`).
3. **R2 (RED, Source mode).** Files: `media-src/src/editing/rewrap-command.test.ts`. Add the Source-mode decline-point case. It pins current `runRewrapCommand` behaviour and passes; the decline point is in the caller. The failing test that proves the Source-mode failure is the existing `auto-wrap.spec.ts:31` Source pass at `:603` (baseline run in Part 1) and the Chromium `media-src/e2e/auto-wrap.spec.ts:118` sv case (`syncs` 0, baseline run in Part 1). Checks: Vitest on `rewrap-command.test.ts`; `node build.mjs`; the wrapper on `auto-wrap.spec.ts`, which still fails at `:603`.
4. **G2 (GREEN, Source mode).** Files: `media-src/src/boot/main.ts` (`LiveAutoWrapTarget`, `captureAutoWrapTarget`, the firing's `apply`), `media-src/e2e/rewrap-harness.ts` (mirror). Checks: `node build.mjs`; Chromium `media-src/e2e/auto-wrap.spec.ts` on a private port (all six cases pass, including Source mode); the wrapper on `auto-wrap.spec.ts auto-wrap-proof-cost.spec.ts` (both pass).
5. **C (closure).** Files: this task record and the step reports. Run the quality stages one by one (lint, typecheck, knip, jscpd, depcruise, `test:coverage`, `check:coverage-modules`). Write the completion report.

### Attribution of `auto-wrap.spec.ts:895` (2026-11-01)

After the Source-mode fix, `auto-wrap.spec.ts:31` fails at `:895`, in the IR protected-fence case. The spec expects `> ```\n>> alpha beta gammax delta\n> ```\n>\n`, but the host text lacks the final marker-only `>` line.

The failure is pre-existing and does not depend on test order. A scratch copy of the step ran in real VS Code on a baseline tree (the unchanged `03a20622` sources, built separately) and on the task tree, in two variants each: the protected-fence step alone, and after the IR quote and nested-quote steps that come before it in the spec. All four runs gave the same result:

- The manual Rewrap declines, as the spec expects.
- The webview posts two plain edits containing `> ```\n>> alpha beta gammax delta\n> ```\n`.
- The webview's own `getValue()` is that same text, and the host ends with it.

The current Lute rendering does not add the marker-only line that the case's comment describes, so the expectation is stale. The spec's final reopen assertion (`finalText.replace(/\n>\n$/, '\n')`) makes the same assumption. The earlier failure at `:603` masked it. The measured result still meets the case's stated intent: the protected bytes change only by the typed character.

- Provisional decision (2026-11-01), reversible — D4, scope of `:895`: fix it in this task as a test-only change. Update the protected-fence expectation (about `:880-899`) and the final reopen assertion in `test/vscode-e2e/auto-wrap.spec.ts` to the measured bytes, with a comment recording the measurement. No product code changes. Rejected: a follow-up task (leaves the `:31` acceptance item unmet) and first tracing which Lute change removed the line. Selected by a recorded decision check (probability 0.82).

### Part 2 progress: IR fix and spec updates (2026-11-01)

- Source mode (D1) and IR (D2) fixes are in. `EditSync.flushHistoryInput(options?: { recordedEntry?: boolean })`: only the recorded-entry flush in `boot/finish-init.ts` passes it, `boot/vditor-init.ts` forwards it, and `bridge/edit-sync.ts` keeps the typing deferred (`deferredPlainPost`) when an automatic attempt is pending and nothing is proven yet. Undo, Redo and Save still publish at once.
- New Vitest cases (`edit-sync.test.ts`, `finish-init.test.ts`) failed before the change for the missing behaviour and pass now. `edit-sync.test.ts`, `finish-init.test.ts` and `rewrap-command.test.ts` pass (203 tests).
- Spec changes (test-only): `auto-wrap-proof-cost.spec.ts` waits for the host text to equal the formatter's wrap and pins three whole-document serializations (D3, measured as three). `auto-wrap.spec.ts` gains an IR pass at a 1000 ms delay with two Undos, takes the measured protected-fence bytes (D4). (An interim expectation that the large section's first burst reaches the host together with its wrap was reverted after the independent review: see the trusted-input decision below.)
- Real VS Code: `auto-wrap-proof-cost.spec.ts` passes in every run. `auto-wrap.spec.ts:31` passed in one combined run and failed in others at places unrelated to a decline of the wrap: once at its IR 1000 ms pass (host held the typed, unwrapped text), once at the reopen step after the large section (`replaceDocument` did not land before the reopen). Both are intermittent; the cause of the first is not established.

### Diagnosis of the intermittent IR long-delay pass (2026-11-01)

Measured with an instrumented scratch build of the task tree under the full `auto-wrap.spec.ts` order in real VS Code. The IR 1000 ms pass was repeated ten times, each repetition preceded by a switch to Source mode or WYSIWYG and back to IR. Three repetitions declined, all right after a Source→IR switch (none after a WYSIWYG→IR switch). The pass in the spec runs right after the Source-mode pass.

- **Declining repetitions.** At the first typed key, edit-sync's exact pair was still anchored in Source mode. It held 99 bytes, Vditor's Source form with its appended line break, while the host holds the 98-byte fixture; edit-sync's host base equals that 99-byte pair. The one-span rebase of the typed character therefore failed, and the failure was cached for that rendering. At the firing the proof returned `unavailable` and the Rewrap declined. The deferred typing was then published as a plain edit, so the host held the typed, unwrapped text.
- **Succeeding repetitions.** The pair was anchored in IR with the 98 host bytes; the rebase was proven, the wrap was posted exactly, and two Undos reached the typed and then the original text.
- **D2 does not take part.** The same decline happens whenever the rebase fails. The failure is closed (no data loss, only the wrap is skipped). Its cause, a stale exact pair after a Source visit, is an edit-sync ownership state outside this task's measured causes. It appeared after Task 675's Source relation was integrated, but the provenance of the 99-byte pair was not traced further.
- **`:586`** (`replaceDocument(ORIGINAL)` not landing after the reopen): it did not reproduce in two further executions, one on the unchanged base `2a66d831` and one on the task tree. It stays an unattributed intermittent failure, seen once in six runs with the change.

- Provisional decision (2026-11-01), reversible — D5, scope of the long-delay decline: make the spec deterministic as a test-only change and record the stale pair as a follow-up. In `auto-wrap.spec.ts`, after `switchMode('ir')` and before the typed key of the IR 1000 ms pass, replace the host text with a different text and then with `ORIGINAL`, and wait for the editor value to equal `ORIGINAL`. This reseeds edit-sync's exact pair from the host in IR. File a follow-up for the stale Source-anchored exact pair (99-byte pair versus the 98-byte host after a Source visit, which makes the first IR rebase fail). Rejected: an authority retry inside the firing and an edit-sync pair fix (both change product code outside this task's measured causes), and accepting the pass as flaky. Selected by a recorded decision check (probability 0.98).

Next step (one implementation turn): apply D5 in `test/vscode-e2e/auto-wrap.spec.ts` only. Build, then run `auto-wrap.spec.ts` and `auto-wrap-proof-cost.spec.ts` through the wrapper twice. Both runs must pass the IR 1000 ms pass; record any `:465` or `:586` failure as the known intermittent ones and rerun once. Draft the follow-up task text for the stale Source-anchored pair with the evidence above in the step report. Then continue to the closure step.

### Repair step R3 (2026-11-01)

- D5 applied (test-only): in `auto-wrap.spec.ts` the IR 1000 ms pass reseeds edit-sync from the host (a different text, then `ORIGINAL`) after `switchMode('ir')`. The stale Source-anchored pair is filed as Task 686.
- Independent review decision applied: in `boot/main.ts` the document `input` listener calls `autoWrapController.handleInput` only for trusted events (`markUserInput` unchanged), and `media-src/e2e/rewrap-harness.ts` mirrors it. A programmatic input (a config change's re-render) no longer schedules a new attempt after the config change cancelled the pending one. The large-section expectation in `auto-wrap.spec.ts` is back to "the typing reaches the host unwrapped". Selected by a recorded decision check (probability 0.72). New Chromium case "an untrusted input event does not schedule auto-wrap" failed before the change (`captures` 1, expected 0) and passes after.
- Residuals from the review (lows): the D1 unit test in `rewrap-command.test.ts` does not guard the `main.ts` wiring (that is covered by the Chromium and real-VS-Code auto-wrap specs); with D2 the unpublished-typing window can last up to the auto-wrap delay (the idle post already deferred the same way), and `dispose` drops the deferred post.
- Spec robustness (test-only): with the typing reaching the host sooner, `placeCaretAfterText` in `auto-wrap.spec.ts` failed 5 of 5 runs with `Paragraph 401 … not found in IR`. A scratch probe showed the text node present before the caret placement and missing after the click, which makes the editor rebuild blocks. The helper now waits for the text and retries the caret placement until it succeeds. After that, two consecutive runs of `auto-wrap.spec.ts` and `auto-wrap-proof-cost.spec.ts` passed.

## Verification and closure (2026-11-01)

Base `a9285afc` (Tasks 683, 680, 673, 681, 679 integrated; none touch this task's files).

Acceptance:

- [x] Source-mode firing changes the host text: the Source pass of `auto-wrap.spec.ts:31` passes in real VS Code; Chromium `media-src/e2e/auto-wrap.spec.ts` Source case passes (it failed before).
- [x] `auto-wrap.spec.ts:31` passes including the Source-mode pass, the IR pass at a 1000 ms delay and the large section: two consecutive passes together with `auto-wrap-proof-cost.spec.ts` after the last test change (the latest two runs; earlier runs were intermittent, see the diagnosis and repair sections).
- [x] `auto-wrap-proof-cost.spec.ts` asserts that the host text equals the formatter's wrap and pins three whole-document serializations (passed in every run).
- [x] Vitest cases for the decline points: the recorded-entry deferral (`edit-sync.test.ts`, `finish-init.test.ts`) and the Source-mode authoritative text (`rewrap-command.test.ts`); each failed before its change where it tests new behaviour.
- [x] Task 606 proof rules not weakened: `rewrap-command.ts` and `selection-source-proof.ts` are unchanged.
- [~] Quality stages: `lint:ci`, `typecheck`, `typecheck:vscode-e2e`, `knip`, `jscpd`, `depcruise`, `test:coverage` (384 files, 8436 tests, 1 expected fail; no load timeout, so no rerun was needed), `check:coverage-modules` (9 at 0%, baseline 9) and `check:brand-identifiers` exit 0. `check:bundle-size` fails (`main.js` 1096 KB against 608 KB) identically on the unchanged base (1122354 bytes there against 1122373 with this change); reporting only. The audit stage is omitted by queue rule.

Decisions (all provisional, reversible): D1 remove the auto-wrap snapshot authority (probability 0.95); D2 `recordedEntry` deferral in `flushHistoryInput` (0.96); D3 the proof-cost spec pins three serializations (0.96); D4 update the stale protected-fence expectation (0.82); D5 isolate the IR long-delay pass from the stale Source pair and file Task 686 (0.98); trusted-input rule for auto-wrap scheduling (0.72).

Residuals: Task 686 (stale Source-anchored exact pair); the D1 unit test does not guard the `main.ts` wiring (Chromium and real VS Code cover it); the unpublished-typing window can last up to the auto-wrap delay and `dispose` drops the deferred post; the final completion-gate review escalated with low confidence on a summarized diff and flagged that `handleCompositionEnd` schedules without the trusted check (composition events are dispatched by the browser; the trusted rule covers `input` events only).
