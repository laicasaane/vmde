# Task 686 — Stale Source-anchored exact pair after a Source→IR switch fails the first IR rebase

**Status:** done (2026-11-02). Filed at the close of Task 677.
**Origin:** Task 677 (diagnosis of the intermittent IR long-delay pass in `auto-wrap.spec.ts`).
**Severity:** low (estimated; the failure is closed: no data is lost, only an automatic wrap is skipped).
**Tech stack:** `media-src/src/bridge/edit-sync.ts` (`rebaseUnpublished`, `reanchorAfterModeSwitch`, `snapshotPair`), `test/vscode-e2e/auto-wrap.spec.ts`.
**Depends on:** none.

## Problem

Straight after a Source→IR switch, edit-sync can still hold its exact pair anchored in Source mode. The pair then carries Vditor's Source form of the text, which has one more trailing line break than the host text. The first typed character in IR cannot be mapped onto the host bytes, and the failed result is cached for that rendering.

Measured in real VS Code with an instrumented scratch build under the full `auto-wrap.spec.ts` order, repeating the IR pass at an auto-wrap delay of 1000 ms ten times, each time after a switch to Source or WYSIWYG and back to IR:

- 3 of 10 repetitions declined, all after a Source→IR switch (none of 5 after WYSIWYG→IR).
- In a declining repetition, at the first trusted key: the pair was anchored in Source mode while the editor was in IR (`anchorMode` Source, mode IR); the pair's exact text was 99 characters, the host text (a 98-character fixture) and the remembered rendering were 98; the one-span rebase either found no anchor (start `-1`) or failed its projection proof, and `lastRebase` cached the failure; at the automatic firing the capture's proof returned `unavailable`, the Rewrap declined, and the deferred typing was then published as a plain edit (host text typed, unwrapped).
- In a succeeding repetition the pair was anchored in IR with 98 characters, the rebase was proven, and the wrap was posted exactly.

The auto-wrap fix of Task 677 does not cause this: the decline follows from the failed rebase alone. Task 677 isolates its spec from the state by reseeding from the host before the IR pass.

## Proposed work

Find where the 99-character Source-form pair becomes the exact pair after a Source visit (the Source exact-authority relation of Task 675, `reanchorAfterModeSwitch`, or the Source history-pair recording), and make the first IR rebase succeed or the pair be dropped when its bytes differ from the host text. Keep the Task 606 and 607 proof rules: no proof is relaxed.

## Acceptance

- [x] After a Source→IR switch, the first typed character in IR still allows an automatic wrap (IR pass at a long auto-wrap delay, repeated, with no decline). Proven by `auto-wrap-source-switch.spec.ts` (10 of 10 repetitions; see Part 2 GREEN).
- [x] ~~A Vitest case for the pair state that failed (pair anchored in Source, host one line break shorter, IR rendering).~~ Replaced (Part 1 revision): the probe did not observe that pair state. The measured cause is covered by the `prepare` cases in `auto-wrap.test.ts`; the Source-anchored pair stays an open residual (R2).
- [x] No exact-authority proof is weakened; the Task 675 Source cases still pass. `edit-sync.ts` is unchanged; `edit-sync.test.ts` passes.

## Tests to write

- A Vitest case in `media-src/src/bridge/edit-sync.test.ts` for the rebase after a mode switch from Source.
- Remove the reseed step from the IR 1000 ms pass in `test/vscode-e2e/auto-wrap.spec.ts` and run it repeatedly after the Source pass.

## Part 1 handoff (2026-11-01)

Reasoning only: source, tests, git history and done task records were read; nothing was built or run.

### Problem restated

After the Source pass of `test/vscode-e2e/auto-wrap.spec.ts` (type, automatic wrap, two Undos in Source mode) and a switch to IR, edit-sync can own an exact pair that is still anchored in Source mode. Its exact text and `hostBase` are the same 99-character string, while the host holds the 98-character fixture. The first trusted key in IR moves that pair to `remembered`; `rebaseUnpublished` then maps the typed character onto the 99-character text, and the result either finds no anchor or fails `provesExact`. The failure is cached in `lastRebase`, the auto-wrap proof returns `unavailable`, and the firing declines.

### Root-cause hypothesis (with source evidence)

Two defects combine. H1 is the cause of the wrong bytes; H2 is why nothing notices them.

- **H1 — a Source-mode exact writer stores Vditor's Source form instead of the host form.** In Source mode, document Rewrap captures its text through `captureRewrapSourceRange` (`media-src/src/editing/rewrap-command.ts:486-489`, `getValue()`), via `documentTarget` with `requireExactMarkdown: false` (`rewrap-command.ts:856-866`). That text carries the newline Vditor appends to the Source DOM (Task 677 measured `getValue()` one character longer than `serializeSvForHost`). `syncExactHistory` (`media-src/src/boot/main.ts:384-409`) records it as `beforeExact`, and posts the wrapped result as `afterExact`. A Source Undo replays the record through `vditor-init.ts:647-657` as `postExact(exactHistory.exact, …)`, and `postExact` (`media-src/src/bridge/edit-sync.ts:1543`) sets `exactTransactionMarkdown` and `hostBase` to those bytes. The host can still hold the 98-character text because it consumes such edits through its history coupling (`src/session/editor-session.ts`, `consumeEdit` and the `normalizeContent` comparison). Then the webview's `hostBase` no longer equals the host text, which breaks Task 607 INV-A. The exact writer that leaves the 99-character pair is not proven: the record replay is the leading candidate, and the other writers are `reseed` (`edit-sync.ts:1589`), `receiveExactAuthority` (`edit-sync.ts:1312`) and `flushHistoryInput`'s exact typing post (`edit-sync.ts:1470-1480`). The first Part 2 step names it by measurement.
- **H2 — anchoring in Source mode and the mode-switch re-anchor prove nothing about the new mode.**
  - `currentPairExact` (`edit-sync.ts:690-711`) anchors a pair lazily through `renderedFromExact` (`edit-sync.ts:547`). That function returns `true` when no visual projection exists, which is always the case in Source mode. A Source-form exact text is therefore anchored to the host-form rendering without the Source relation `projectRendered` (`normalizeEol(exact) === rendered`).
  - `reanchorAfterModeSwitch` (`edit-sync.ts:578-592`) returns early when the new mode's rendering equals `exactTransactionRendered`. `anchorMode` then stays `sv` and the pair counts as owned in IR, although `provesExact(exact, rendered)` was never checked in IR. This matches the measured state (`anchorMode` Source, mode IR).

A WYSIWYG→IR switch does not fail, because a WYSIWYG anchor is set only after `renderedFromExact` checks the WYSIWYG projection.

### Shared interfaces and invariants

- `EditSync` (`edit-sync.ts:50-110`): `snapshotPair`, `postExact`, `reseed`, `flushHistoryInput`, `acquireExactAuthority`. No signature change is planned.
- `recordRewrapDocumentHistory` / `takeRewrapDocumentHistoryReplay` (`rewrap-command.ts:81-140`) and `syncExactHistory` (`main.ts:384`).
- Task 607 INV-A: `hostBase` is the text the host holds, or null. Task 607 rule 7: an exact post names `before` and the host writes only while it holds `before`.
- Task 606 / 607 proof rules are never relaxed: `rebaseOneSpan` keeps `provesExact`; `hostDerivesSourceText` (Task 675) stays limited to the host-reply check in Source mode.
- Task 196: a mode switch with nothing typed keeps exact ownership when the bytes still describe the document. After the fix this needs a proof in the new mode.

### Intended solution

1. **Provenance (H1).** At the writer that the probe names, give exact bytes in the host form. Remove only the one newline span Vditor appends to the Source DOM, as `serializeSvForHost` does (`edit-sync.ts:490`), and never trim authored trailing blank lines. If the writer is the Source Rewrap record, record `beforeExact` / `afterExact` and post the result from the host-form text. The Source caret mapping and the Source apply path (`applySvDocumentOrSelection`, `rewrap-command.ts:789`) keep using the DOM text.
2. **Guard (H2).** Before a pair anchored in another mode is used in the active visual mode, require `provesExact(exactTransactionMarkdown, rendered)` in that mode. On success, set `anchorMode` to the active mode. On failure, keep the pair out of ownership: clear the pair and keep it from becoming `remembered`, so no rebase runs on unproven bytes. In Source mode, anchor lazily only when `projectRendered(exact) === rendered`. The guard makes a later stale pair fail closed; H1 makes the measured case succeed.

### Affected paths

- `media-src/src/bridge/edit-sync.ts` (guard; possibly the writer).
- One writer from the probe: `media-src/src/editing/rewrap-command.ts` and/or `media-src/src/boot/main.ts` (Source Rewrap record), or the edit-sync writer the probe names.
- `media-src/src/bridge/edit-sync.test.ts` (new Vitest cases), `media-src/src/editing/rewrap-command.test.ts` if the writer is the Rewrap record.
- `test/vscode-e2e/auto-wrap.spec.ts` (remove the reseed step of the IR 1000 ms pass; repeat the pass after a Source visit).

### Part 2 steps (tier Medium)

1. **Probe (no product change kept).** In the worktree, add a temporary e2e-only log in `edit-sync.ts` behind the existing `__vmdeE2EReadiness` gate. At every assignment of `hostBase` and `exactTransactionMarkdown`, record the writer name, the active mode, the text length and whether the text ends with two line breaks. Keep a temporary copy of `auto-wrap.spec.ts` under `tmp/686/` that removes the reseed step, runs the IR 1000 ms pass 10 times (each after `switchMode('sv')` then `switchMode('ir')`) and dumps the log at each decline. Commands: `node build.mjs`, then `../vmde-wt/vscode-run.sh 686 env -u ELECTRON_RUN_AS_NODE xvfb-run -a npm --prefix test/vscode-e2e test -- <probe spec> --workers=1 --retries=0` (timeout 60 min). Positive control: at least one repetition declines with `anchorMode` `sv`, mode `ir`, and a 99-character pair (as measured in Task 677). Decision: the writer that last set the 99-character `hostBase` before the switch is the H1 target. If no repetition declines in 10, run once more; if it still does not decline, report Blocked with the log rather than guessing. Remove the temporary log before step 2.
2. **RED.** Add the Vitest cases (below) and change `auto-wrap.spec.ts`: remove the reseed step of the IR 1000 ms pass and run that pass 10 times, each after a Source→IR switch. Run the new Vitest cases and record their failure on the unchanged product code. Do not run the real-VS-Code spec in this step; the probe of step 1 is its RED evidence.
3. **GREEN.** Apply the provenance fix and the guard. Run the focused Vitest file, then the build, then `auto-wrap.spec.ts`, `auto-wrap-proof-cost.spec.ts`, `exact-authority-other-actions.spec.ts` and `exact-action-neutral-bytes.spec.ts` in one real-VS-Code invocation.
4. **Closure.** `npm run quality`, coverage of the changed lines, acceptance boxes, final review of the diff.

### Vitest cases to add (`media-src/src/bridge/edit-sync.test.ts`)

- In the Task 196 mode-switch group: a pair posted in Source mode whose text is the host text plus one trailing line break, then a switch to IR with the same rendering. Expected: `snapshotPair().exact` is null or the IR-proven text, never the Source form; after a trusted key the rebase does not run on the Source-form text.
- The same pair posted in host form: after the switch, the pair stays owned and the first trusted key's one-span rebase is proven (`snapshotPair().exact` equals the host text with the typed character).
- Writer case from the probe (for example, a Source Rewrap record replay posts host-form bytes).
- The Task 675 Source cases (`edit-sync.test.ts:2487` onward) stay unchanged and pass.

### Edge cases

- Authored trailing blank lines in Source mode: they are DOM sibling spans and must stay in the exact bytes.
- A document without a final line break, and a CRLF document (`normalizeEol` in the Source projection).
- A front-matter document (Task 670 path in `preserveAutomaticInput`).
- Source→WYSIWYG and WYSIWYG→Source switches: the guard uses the WYSIWYG projection; Source anchoring uses the Source relation.
- A switch with typing pending (`userInputPending`): no re-anchor, as now.
- Redo after a Source Undo of a Rewrap: `afterExact` must also be in the host form.

### Focused checks and expected outcomes

- Vitest `media-src/src/bridge/edit-sync.test.ts` (and `rewrap-command.test.ts` if touched): the new cases fail before the fix and pass after it; the Task 196, 607 and 675 groups pass.
- Real VS Code `auto-wrap.spec.ts`: all 10 Source→IR repetitions of the IR 1000 ms pass post the wrap, and each pair of Undos reaches `TYPED` and then `ORIGINAL`.
- Real VS Code `auto-wrap-proof-cost.spec.ts`, `exact-authority-other-actions.spec.ts` and `exact-action-neutral-bytes.spec.ts`: pass.
- `npm run quality`: passes.

### Tier

Medium. The change touches edit-sync's exact-ownership invariant, which every exact action shares, and the writer must first be named by a real-VS-Code measurement. The expected diff is small (one guard and one writer), so it is not Heavy. A merged RED+fix step is not used, because the probe decides where the fix goes.

### Decisions

- Provisional decision (2026-11-01), reversible — D1, fix direction: fix the writer that stores the Source form (named by the probe) so exact bytes and `hostBase` are in the host form, and add the mode-switch guard that requires the active mode's projection proof before a pair anchored in another mode is owned. Rejected: the guard alone (it drops the pair, so the wrap still declines; probability 0.03), the writer fix alone (a later stale pair would still be owned without proof; 0.02), and an authority request on a failed rebase (it hides the wrong `hostBase`; 0.00). Probability of the selected option 0.89; further investigation before deciding 0.05.
- Provisional decision (2026-11-01), reversible — D2, repetitions in the real-VS-Code spec: 10 Source→IR repetitions of the IR 1000 ms pass in the existing test. At the measured 3-in-10 decline rate, unfixed code passes all 10 with probability about 0.03. Rejected: 5 repetitions (about 0.17 false pass; probability 0.26) and a single pass (0.00). Probability of the selected option 0.69.

## Part 2 P2-1 (2026-11-02): probe

**Result: the Part 1 hypothesis (H1 and H2) is refuted for this reproduction. Stopped; no redesign.**

### Method

- Temporary instrumentation in `media-src/src/bridge/edit-sync.ts`, removed afterwards (`git diff` shows only this record): a log entry (mode, `anchorMode`, lengths of `hostBase`, the exact pair, its rendering and `remembered`, pending-input flag) at every write path: the lazy anchor, the pair revocation, `reanchorAfterModeSwitch`, `recallRemembered`, `notePlainPost`, `receiveExactAuthority`, and before/after each of `markUserInput`, `postExact`, `reseed`, `receiveExactRefusal`, `flushHistoryInput`, `flush`.
- A temporary copy of `auto-wrap.spec.ts` (deleted afterwards) with the reseed step removed. It runs 10 repetitions of: switch to Source, type, wait for the automatic wrap, two Undos, switch to IR, place the caret, type, then wait 8 s for the wrapped host text. Auto-wrap delay 1000 ms, column 12.
- Deviation from the full spec order: the large-document section and the Rewrap loop over the three modes were removed from the copy, because they failed on the unchanged code before the probe loop was reached. The first attempt failed at the large section (`placeCaretAfterText`, a 30 s wait for the paragraph), the second at the three-mode loop (an Undo expected `TYPED` and found `ORIGINAL`).

### Commands and exit codes

| Command | Exit | Result |
| --- | --- | --- |
| `node build.mjs` (with the instrumentation) | 0 | built |
| wrapper run 1 (copy with the large section) | 1 | failed in the large section, before the loop |
| wrapper run 2 (large section removed) | 1 | failed in the three-mode loop, before the loop |
| wrapper run 3 (own loop only) | 0 | 1 passed (2.2 min), 10 repetitions written to the scratch output |
| `node build.mjs` (after removing the instrumentation) | 0 | built from the unchanged source |

All real-VS-Code runs used the wrapper with `--workers=1 --retries=0` and the XTEST form.

### Measured values (run 3)

- 8 of 10 repetitions declined (reps 0, 2 to 8); 2 passed (reps 1 and 9). In every declined repetition the final host text was the typed, unwrapped 99-character text.
- In every repetition, after the Source pass: `hostBase` null, no exact pair, no `remembered`, `anchorMode` `sv`. Cause in the log: the first Source key is a trusted input (`markUserInput`) that revokes the 98-character pair and `notePlainPost` follows; the automatic wrap in Source mode makes no exact post (Source Rewrap stays a plain sync), so nothing owns an exact pair afterwards.
- At the first IR key in the 8 declined repetitions: mode `ir`, `anchorMode` `sv` (left over), `hostBase` null, exact pair null, `remembered` null. The rebase has nothing to map from, so the capture's proof returns `unavailable` and the firing declines. There was no 99-character pair and no Source-form text at any point before the decline.
- In the 2 passing repetitions a background `receiveExactAuthority` ran between the switch and the first key and installed an IR-anchored pair of 98 characters (`hostBase` 98, pair 98, rendering 98); the first key moved it to `remembered`, `postExact` followed, and the wrap was posted.
- The only 99-character `hostBase` and pair in any log came after the decline: a `receiveExactAuthority` reply holding the typed host text (98 characters plus the typed `z`), anchored in IR.

### Hypothesis check

- H1 (a Source-mode exact writer stores Vditor's Source form, giving a 99-character `hostBase` while the host holds 98): refuted here. No exact write occurred in Source mode; no log entry has a Source-form or trailing-double-line-break text.
- H2 (a pair anchored in Source mode stays owned after a switch to IR, without an IR proof): not observed. Before the first IR key there was no pair; only `anchorMode` still read `sv`.
- What the measurement shows instead: after a Source visit whose typing was posted as a plain edit, edit-sync holds no exact authority in IR (`hostBase` null). The first IR key is rebased only if a background exact-authority request has already completed. The race between that request and the first key decides the outcome.
- The Task 677 observation (a 99-character pair anchored in Source mode with `hostBase` equal to it) was not reproduced. The difference is in the sequence: this probe omitted the large-document section and the three-mode loop (including a reopen of the document) that precede the pass in the full spec. So the Task 677 state may need that preceding sequence; this probe cannot say.

### Writer or path named

No writer of a stale pair. The path named is the missing authority: `notePlainPost` (`media-src/src/bridge/edit-sync.ts`) leaves `hostBase` null after the Source typing; IR authority then depends on the background `acquireExactAuthority` / `receiveExactAuthority` reply arriving before the first IR key. Whether to treat this as the task's defect, or to re-measure the Task 677 sequence with the full spec order (by running the probe in the unchanged order with the large section, once that section passes), is a decision for the next planning step. No fix, test or acceptance change was made here.

Scratch outputs: the instrumentation log and run output are in the ignored `tmp/686/` folder of the worktree.

## Part 1 revision (2026-11-02)

This section replaces the Part 2 plan of the Part 1 handoff. The probe (P2-1) did not observe H1 or H2. The decline it measured has another cause, stated below.

### Defect

After a Source→IR switch, the automatic wrap in IR declines when the first IR key comes before edit-sync holds exact authority:

- After the Source pass the typing was posted as a plain edit (`notePlainPost`, `media-src/src/bridge/edit-sync.ts:1020-1031`), so `hostBase` is null and edit-sync owns no exact pair.
- Authority comes back only through a background request: the source index asks for it when a read finds no exact source (`media-src/src/nav/source-block-index.ts:321-327`, wired as a background acquire in `media-src/src/boot/vditor-init.ts:455-458`).
- `receiveExactAuthority` (`edit-sync.ts:1312-1345`) rejects a reply when the rendering or the trusted-input count changed after the request (Task 607 rule 4). A reply that arrives after the first IR key is therefore always rejected.
- At the firing, `runRewrapCommand` (`media-src/src/boot/main.ts:609-613`) captures through `captureProvenSelection` (`media-src/src/editing/rewrap-command.ts:566-580`). `proveSelectionSource` returns `unavailable` when the pair has no exact text (`media-src/src/editing/selection-source-proof.ts:208-217`), and the Rewrap declines.

The Task 677 state (a stale pair whose rebase fails) also ends with no exact text at the firing, so the same remedy covers it.

### Remedy

At the firing, in IR and WYSIWYG only, when edit-sync has no exact text, publish the typing and acquire authority before the Rewrap:

1. Add an optional async `prepare(target)` dependency to the auto-wrap controller (`media-src/src/editing/auto-wrap.ts`). The firing awaits it inside the existing apply chain (`auto-wrap.ts:102-108`), so the pending lease (`applying`) holds while it waits. `apply` runs only when `prepare` resolves `true` and `isTargetCurrent(target)` still holds.
2. In `main.ts`, wire `prepare` as follows:
   - In Source mode, or when `snapshotPair().exact` is not null, resolve `true` at once. No request is made, so the passing path is unchanged.
   - Otherwise await `acquireActionAuthority({ publish: true })` (`main.ts:308-309`, `edit-sync.ts:1247-1279`). It flushes the pending or deferred typing as a plain edit (`pendingEdit.flush` always calls `onFlush`, `media-src/src/bridge/pending-edit.ts:63-66`), then requests the host text. Resolve `true` only when it returns a pair.
3. The reply is adopted only through the unchanged `receiveExactAuthority` checks: same rendering, no trusted input since the request, and `provesExact`. Rewrap then proves its selection against that pair and posts an exact edit with `before` set to the reply.
4. A null reply (timeout, typing during the wait, failed proof) or a stale target declines without a post, as today. The typing is already published, so nothing is lost.

Host history: the typing becomes one plain edit and the wrap one exact edit, so two Undos still reach `TYPED` and then `ORIGINAL`. This matches the existing spec expectation.

Not changed: Task 606/607 proof rules, Task 607 rule 4 reply adoption, the Task 675 Source relation, Source-mode firing, and the recorded-entry deferral of Task 677 (`flushHistoryInput`). After the publish, `hasPendingInputPost()` is false, so that deferral no longer applies.

### Decisions

- Provisional decision (2026-11-02), reversible — R1, remedy: acquire authority with publish at the firing when no exact text is held, through a controller `prepare` hook wired in `main.ts`, then Rewrap. Probability 1.00.
  - Rejected: an eager request on every mode switch with the firing waiting for it (0.00). A reply requested before the key is still rejected by rule 4 once the user types.
  - Rejected: adopting a pre-typing reply as `remembered` (0.00). It changes rule 4 and does not fail closed.
  - Rejected: retrying the declined firing when a reply arrives (0.00). No reply can be adopted after the key.
- Provisional decision (2026-11-02), reversible — R2, H1/H2: keep them as an open residual. They are neither measured nor fixed here. The remedy also covers their measured end state (no exact text at the firing). Re-measure them when the full `auto-wrap.spec.ts` order passes again. Probability 0.71. Rejected: dropping them (0.08) and blocking the task until the full order can run (0.10).
- Provisional decision (2026-11-02), reversible — R3, location of the repeated real-VS-Code case: a new focused spec, `test/vscode-e2e/auto-wrap-source-switch.spec.ts`, holding the probe's loop. In `auto-wrap.spec.ts`, remove the reseed step of the IR 1000 ms pass and its Task 686 comment. Probability 0.97. Rejected: putting the loop inside `auto-wrap.spec.ts` (0.02), because that spec fails earlier on unchanged code.

### Changed acceptance items

- Item 1 (kept, made concrete): in `auto-wrap-source-switch.spec.ts`, 10 repetitions of a Source pass (type, wrap, two Undos) followed by a switch to IR and the IR pass at a 1000 ms delay. Every repetition posts the wrap, and two Undos reach `TYPED` and then `ORIGINAL`.
- Item 2 (replaced): Vitest cases for the firing-time acquire:
  - (a) no exact text: `prepare` acquires with publish, then Rewrap runs;
  - (b) a null reply declines without Rewrap;
  - (c) a target that is no longer current after the wait declines;
  - (d) an exact text already held makes no request;
  - (e) Source mode makes no request.

  The old item (a Vitest case of a pair anchored in Source mode with the host one line break shorter) moves to the residual R2.
- Item 3 (kept): no exact-authority proof is weakened; the Task 675 Source cases and the Task 607 groups in `edit-sync.test.ts` still pass.

### Affected paths

- `media-src/src/editing/auto-wrap.ts` and `media-src/src/editing/auto-wrap.test.ts`: the `prepare` hook and cases (b) and (c) at the controller level.
- `media-src/src/boot/main.ts`: the `prepare` wiring.
- `media-src/e2e/rewrap-harness.ts`: the Chromium harness copies the auto-wrap wiring, so add the same `prepare` there to keep it aligned. No new Chromium test.
- Cases (a), (d) and (e) need the `main.ts` decision as a pure helper. Put it in `media-src/src/editing/auto-wrap.ts` as an exported `prepareAutoWrapSource(deps)` with injected `exactMode()`, `hasExact()` and `acquire()`, so it can be unit-tested without the boot layer. `main.ts` only binds it. No module-map change.
- `test/vscode-e2e/auto-wrap-source-switch.spec.ts` (new) and `test/vscode-e2e/auto-wrap.spec.ts` (reseed step removed).

### Part 2 steps (tier Medium)

1. **RED.** Add the Vitest cases (a)–(e) in `auto-wrap.test.ts`. Write `auto-wrap-source-switch.spec.ts` from the probe loop: no instrumentation, a single test, timeout 900 s, and it asserts the wrap in every repetition. Remove the reseed step in `auto-wrap.spec.ts`.
   - Run the Vitest file. Expected: the new cases fail (no `prepare` hook, no helper).
   - Build, then run the new spec once through the wrapper. Expected: it fails on an early repetition, matching the probe's 8-of-10 decline rate.
2. **GREEN.** Implement the hook, the helper, the `main.ts` wiring and the harness wiring.
   - Run the Vitest files `auto-wrap.test.ts`, `edit-sync.test.ts` and `rewrap-command.test.ts`. Expected: all pass.
   - Build, then run `auto-wrap-source-switch.spec.ts`, `auto-wrap-proof-cost.spec.ts`, `exact-authority-other-actions.spec.ts` and `exact-action-neutral-bytes.spec.ts` in one wrapper call. Expected: all pass, with 10 of 10 repetitions wrapping.
   - `auto-wrap.spec.ts` stays a known pre-existing failure. Record where it fails; it must not fail at the IR 1000 ms pass.
3. **Closure.** Run `npm run quality` (expected to pass), check coverage of the changed lines, tick the acceptance boxes, run the final review of the diff, and record the residual R2.

### Edge cases

- The user types during the wait: the reply is rejected and the firing declines. (Corrected in Part 2 R1: the controller used to ignore typing while an attempt ran, so this did not start a new attempt; it now records the typing and schedules the next attempt when the current one settles.)
- The caret moves or a pointer goes down during the wait: `isTargetCurrent` fails and the firing declines.
- The reply times out (1.5 s): decline, typing already published.
- WYSIWYG: same path (an exact action mode).
- Source mode: no request; firing as after Task 677.
- A large IR document: the publish posts a full serialization once per firing that had no exact text. The proof-cost spec pins serializations only where a pair exists, so it must still pass unchanged.

## Part 2 RED (2026-11-02)

Step 1 of the Part 1 revision. No product change.

### Files

- `media-src/src/editing/auto-wrap.test.ts`: seven new cases (two groups).
- `test/vscode-e2e/auto-wrap-source-switch.spec.ts` (new): 10 repetitions of a Source pass (type, wrap, two Undos), a switch to IR and the IR pass at a 1000 ms delay, with no reseed. Each repetition waits up to 10 s for the wrapped host text, then two Undos must reach `TYPED` and then `ORIGINAL`.
- `test/vscode-e2e/auto-wrap.spec.ts`: the reseed step (and its comment) is removed from the IR 1000 ms pass.

### Commands

| Command | Exit | Result |
| --- | --- | --- |
| `npx vitest run --config test/vitest.config.mts media-src/src/editing/auto-wrap.test.ts` | 1 | 7 failed, 23 passed (all earlier cases pass) |
| `npx biome check` on the three changed files | 0 | no findings |
| `node build.mjs` | 0 | built |
| wrapper run of `auto-wrap-source-switch.spec.ts` (XTEST form, `--workers=1 --retries=0`) | 1 | `Error: repetition 1`; the received host text stays the typed, unwrapped text |

### Cases

| Case | State | Failure line |
| --- | --- | --- |
| Controller: applies only after `prepare` resolves true | RED (behavioural) | `expected "vi.fn()" to be called 1 times, but got 0 times` (`prepare` is never called) |
| Controller: declines when `prepare` resolves false | RED (behavioural) | `expected "vi.fn()" to not be called at all, but actually been called 1 times` |
| Controller: declines when the target is stale after `prepare` | RED (indirect) | `TypeError: release is not a function` (`prepare` is never called, so the case cannot reach its assertion) |
| Helper (a): acquires with publish when no exact text | RED (missing symbol) | `TypeError: prepareAutoWrapSource is not a function` |
| Helper (b): null reply resolves false | RED (missing symbol) | same |
| Helper (d): exact text held, no request | RED (missing symbol) | same |
| Helper (e): Source mode, no request | RED (missing symbol) | same |

The four helper cases and the stale-target controller case fail on a missing symbol or hook because no behavioural assertion can reach the gap: the helper does not exist yet, and a controller without the hook never calls `prepare`. Cases (d) and (e) also pass trivially once the helper exists; they guard against a request being made.

Real VS Code: repetition 0 passed and repetition 1 declined in this run. The probe measured 8 of 10 declines, so one early pass is within that spread.

## Part 2 GREEN (2026-11-02)

### Changes

- `media-src/src/editing/auto-wrap.ts`: optional async `prepare(target)` dependency, awaited in the apply chain; `apply` runs only when it resolves `true` and the target is still current (re-checked only when `prepare` exists, so existing behaviour is unchanged). New exported `prepareAutoWrapSource({ sourceMode, hasExact, acquire })`: no request in Source mode or with an exact text held; otherwise `acquire()` and `true` only for a non-null reply.
- `media-src/src/boot/main.ts`: `prepare` bound to `prepareAutoWrapSource` with `acquireActionAuthority({ publish: true })` and `snapshotPair().exact`.
- `media-src/e2e/rewrap-harness.ts`: the same wiring (`editSync.acquireExactAuthority({ publish: true })`).
- `edit-sync.ts` and every proof module: unchanged. The RED expectations are unchanged.

### Commands

| Command | Exit | Result |
| --- | --- | --- |
| Vitest: `auto-wrap.test.ts`, `edit-sync.test.ts`, `rewrap-command.test.ts` | 0 | 3 files, 222 tests passed (the 7 RED cases now pass) |
| `npx biome check --write` on the four changed source files | 0 | no findings |
| `node build.mjs` | 0 | built |
| One wrapper call: `auto-wrap-source-switch`, `auto-wrap-proof-cost`, `exact-authority-other-actions`, `exact-action-neutral-bytes` (XTEST form, `--workers=1 --retries=0`) | 0 | 9 passed (16.2 min) |
| Wrapper call: `auto-wrap.spec.ts` | 1 | 1 failed (known pre-existing) |

### Repetition outcomes

`auto-wrap-source-switch.spec.ts` passed (1.2 min): all 10 Source→IR repetitions posted the wrap within 10 s, and two Undos reached `TYPED` and then `ORIGINAL` in each. `auto-wrap-proof-cost.spec.ts` passed (three serializations unchanged).

### `auto-wrap.spec.ts` (known pre-existing failure)

It fails at `auto-wrap.spec.ts:491`, in `placeCaretAfterText` (a 30 s wait for the paragraph in the large-document section), long before the IR 1000 ms pass. It does not fail at the IR 1000 ms pass, but that pass was not reached in this run, so it is not proven by this spec.

### Residual risks

- The IR 1000 ms pass of `auto-wrap.spec.ts` (reseed removed) has not run; the new spec covers the same sequence.
- `snapshotPair()` runs once more at the firing when no exact text is held. The proof-cost spec still passes.
- A firing with no exact text now posts the pending typing as a plain edit before the wrap, as the plan states.
- Residual R2 (the stale Source-anchored pair) stays open.

## Part 2 R1 (2026-11-02): review repair

Each finding got failing Vitest cases first (5 RED, run before the change), then the change.

| # | Finding | Change | Test (RED line before the change) |
| --- | --- | --- | --- |
| 1 | MAJOR: a publish-mode `acquire` reuses a pre-key request in flight, whose reply rule 4 rejects | `prepareAutoWrapSource` retries `acquire()` once after a null reply; `true` only for a non-null pair (`auto-wrap.ts`) | "retries once after a null reply and wraps on the second reply" and "declines after two null replies, with exactly two requests": `expected "vi.fn()" to be called 2 times, but got 1 times` |
| 2 | MODERATE: typing while an attempt runs (now a host round trip) was ignored | The controller records an insertText seen during the preparation wait and calls `schedule()` in `.finally`. Input raised by the apply step itself stays suppressed (the earlier "suppresses recursive scheduling" case still passes) | "schedules a new attempt for typing seen while prepare is pending": `expected "vi.fn()" to be called 2 times, but got 1 times` |
| 3 | MODERATE: after `prepare` the attempt could apply although it was cancelled, composing or disabled | After `prepare`, return unless the scheduled generation is current, and not disposed, not composing, config enabled and the target current | "declines when composition starts during prepare" and "declines when auto-wrap is disabled during prepare": `expected "vi.fn()" to not be called at all, but actually been called 1 times` |
| 4 | MINOR: the extra `snapshotPair()` in `hasExact()` | Left as is (residual) | none |

`edit-sync.ts` and `receiveExactAuthority` are unchanged.

### Commands

| Command | Exit | Result |
| --- | --- | --- |
| Vitest `auto-wrap.test.ts` (before the change) | 1 | 5 failed, 30 passed |
| Vitest `auto-wrap.test.ts`, `edit-sync.test.ts`, `rewrap-command.test.ts` | 0 | 3 files, 227 tests passed |
| `npx biome check` on `auto-wrap.ts` and `auto-wrap.test.ts` | 0 | no findings |
| `npm run typecheck` | 0 | clean |
| `node build.mjs` | 0 | built |
| Wrapper call, XTEST form: `auto-wrap-source-switch.spec.ts auto-wrap-proof-cost.spec.ts --repeat-each=2 --workers=1 --retries=0` | 0 | 4 passed (2.6 min) |

The runner repeats the whole call, not one file, so both specs ran twice.

### Repetition outcomes

- `auto-wrap-source-switch.spec.ts`: run 1 passed (52.2 s), run 2 passed (52.5 s). Each run holds the spec's 10 Source→IR repetitions, so 20 of 20 wrapped.
- `auto-wrap-proof-cost.spec.ts`: both runs passed (three serializations unchanged).

### Residuals

- `hasExact()` takes one extra `snapshotPair()` at the firing (finding 4, accepted).
- The retry adds up to one extra authority wait (1.5 s timeout) before a firing declines.
- Residual R2 stays open.

## Closure (2026-11-02)

- Quality stages on the GREEN candidate: brand identifiers, lint, knip, jscpd, depcruise, unit coverage and the coverage-module ratchet pass; the dependency audit fails and is omitted in this run.
- After the review repair: lint and knip exit 0; the full unit suite passes (384 files; 8448 tests passed, 1 expected failure).
- Real VS Code after the repair: `auto-wrap-source-switch.spec.ts` and `auto-wrap-proof-cost.spec.ts`, two runs each, 4 passed; 20 of 20 Source→IR repetitions wrapped. Before the repair, `exact-authority-other-actions` and `exact-action-neutral-bytes` also passed with the change.
- An independent review of the diff found one major issue (a publishing request reused a pre-key request in flight) and two moderate ones (typing during the wait, composition or disabling during the wait); all were fixed with failing tests first (Part 2 R1).
- `auto-wrap.spec.ts` still fails in its large-document section, before the IR 1000 ms pass, as on unchanged code.

### Residuals

- R2: the stale Source-anchored pair from Task 677 was not observed and is not fixed; re-measure when the full `auto-wrap.spec.ts` order passes again.
- The firing takes one extra source snapshot to check for held exact text (per firing, not per keystroke; the proof-cost spec passes).

