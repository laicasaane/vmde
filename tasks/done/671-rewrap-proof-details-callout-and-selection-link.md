# Task 671 — Task 606 follow-up: Details and callout regression tests, selection link step

**Status:** done (2026-11-01), with one open follow-up: callout apply native Undo is a no-op in real VS Code ([Task 674](../674-callout-apply-native-undo.md)). Filed 2026-10-18 at the close of Tasks 606 and 630.
**Origin:** Task 606, Task 666.
**Severity:** low (estimated).
**Tech stack:** `media-src/src/editing`, `media-src/e2e`, `test/vscode-e2e`.
**Depends on:** Task 606, Task 666.

## Problem

Task 606 closed as partial by design. Left out: regression tests for Details and callout apply over the proof path, and the selection-link step (the selection link still refuses on the Rewrap path).

Also left out: a real-VS-Code auto-wrap case on a normalizing document (a first version typed its character at the previous caret because the synthetic caret was reset; place the caret with a real click), and real-VS-Code and Chromium cases for Rewrap Document on a normalizing document (they return with Task 670).

## Proposed work

After Task 666 lands, add the regression tests and implement the selection-link step on the proof path.

## Acceptance

- [x] Details and callout apply have regression tests on the proof path (Vitest with real Lute and a bound proof source; real VS Code cases `callout-apply`, `details-duplicate-line`, `callout-duplicate-line` in `exact-authority-other-actions.spec.ts`). Open: the callout cases' native Undo, tracked by Task 674 (flagged as an expected failure; the check still runs).
- [x] The selection link step is implemented and tested. Delivered by Task 666 (`proveNormalizingBody`; `bubble-link-normalizing` is an apply case, `stale-host-bubble-link` refuses). This task adds no link code and proves it by running those cases on this tree (4 real-VS-Code tests pass).
- [x] Focused real-VS-Code spec written and run. The quality stages were run individually (lint, typecheck, knip, jscpd, depcruise, brand identifiers, unit coverage and ratchet); the aggregate `npm run quality` and the dependency audits were not run (omitted by Owner instruction).

## Part 1 handoff (2026-11-01)

Reasoning and planning only. No product code or tracked test changed. Scratch probes are under `tmp/671/` (untracked). Part 2 starts after Tasks 666 and 664 are integrated and this worktree is fast-forwarded. The plan targets that tree.

### What remains after Tasks 670 and 666

- Task 670 delivered proof-only Rewrap Document, auto-wrap on a normalizing document and the front matter matrix (`test/vscode-e2e/front-matter-matrix.spec.ts`). That matrix covers Details and callout apply only where the front matter separator is the sole normalization. This task does not redo that work.
- Task 666 delivers the selection-link step: `sourcePlan` (`selection-link-actions.ts`) maps the selection through the selection proof on a normalizing body (`proveNormalizingBody`). Its real-VS-Code cell `bubble-link-normalizing` becomes an apply cell. Acceptance item 2 is therefore delivered by Task 666 (see the decisions below).
- Still open: Details and callout apply on a normalizing body. Neither uses the selection proof today.

### Problem and measured cause

- Record correction: the Part 1 inventory said the callout capture "tries the proof first". It does not. `captureCalloutActionTarget` (`callouts.ts` ~:437-475) calls `captureRewrapSourceSelection(win)` without `proofOnly`. That is the legacy marker capture against the rendered text (`captureLegacySelection`). The proof-first capture (`captureProvenSelection`, `rewrap-command.ts` ~:497-552) serves only Rewrap and heading shift.
- Callout apply (`runCalloutAction`, `callouts.ts` ~:497-622) acquires the host-exact text (Task 630), then maps the rendered offsets onto it with `mapOffsetToExact`. This is `mapCaretOffsetByLine`, which picks the n-th line with the same text, plus a same-line context check. Details (`runDetailsToggle`, `details-toggle.ts` ~:148-249) does the same with `mapRangeToExact`: two `mapCaretOffsetByLine` calls plus a slice equality check.
- Measured defect (scratch probe `tmp/671/probe/capture.test.ts`, real Lute, IR and WYSIWYG, log `tmp/671/probe.log`). On a normalizing document where Lute strips the first of two otherwise identical lines (leading indentation `   Same text`, or trailing spaces), the n-th-line mapping picks the second occurrence. The context check passes. Details wraps the second paragraph and callout apply converts the second paragraph, not the selected first one. The guarded exact post would be accepted, so the wrong span is written. `# Same #` followed by `# Same` gives the same Details defect. The planned fixture (below) shows it in both modes for both actions.
- On the same documents the selection proof maps every selection correctly. This also holds on a Range cloned before the marker capture ran on the same DOM. The proof also proves multi-unit selections on normalizing bodies (1-2 unit spans measured). On 14 other documents (table padding, blank-line runs, `***`, setext, emphasis, list markers, escapes) today's path and the proof agree.
- Conclusion: same mechanism as Task 606 (marker capture without exact proof). The Owner decision of 2026-10-08 assigns this to a repair step with its own tests, not to tests only.

**Tier: Medium.** Product change in three webview modules (`rewrap-command.ts`, `callouts.ts`, `details-toggle.ts`) plus tests. Task 666 does not deliver the Details and callout repair. It delivers only the selection-link capture.

### Scope

In scope: Details action and callout apply in IR and WYSIWYG on a normalizing body; the matching Vitest and real-VS-Code regression tests; proof of the selection-link item on the post-666 tree with Task 666's tests. Out of scope: SV (unchanged); passive Details state (index-based, unchanged); Insert ID, emoji, math, subscript and link popover captures; any change to the selection-link code.

### Shared interfaces (settled)

- `CaptureRewrapSourceSelectionOptions` (`rewrap-command.ts`) gains one optional field `proofMayCrossUnits?: boolean`. It is read only together with Task 666's `proveNormalizingBody`. It lifts the single-unit rule for a non-round-trip proof. Default callers, including selection Link, are unchanged. No numbering or storage format is involved.
- `CalloutActionTarget` (`callouts.ts`, internal interface returned by the exported `captureCalloutActionTarget`) gains `range?: Range`. It holds a clone of the live Range, taken before the marker capture in IR and WYSIWYG. SV leaves it unset.
- `runDetailsToggle` (internal) takes the clone of the live Range taken with the action target (`liveEditorRange()` returns the live selection Range, so it must be cloned). The pointerdown capture keeps that clone next to `pending`.

### Source-fidelity invariants

1. "Normalizing" means `!sameRenderedText(pair.exact, pair.rendered)` for the acquired pair. That is the existing helper that ignores line endings and trailing breaks. There, Details and callout apply map the target only through the selection proof of the retained Range: `captureRewrapSourceRange(win, range, { authoritativeMarkdown: pair.exact, proveNormalizingBody: true, proofMayCrossUnits: true })`. The proof runs after acquisition, so the owned exact text equals the acquired text.
2. On a normalizing body there is no line-mapping fallback. A missing, detached or unproven Range declines with no DOM change and no post. A retained previous toggle result without a live Range also declines.
3. A round-trip document keeps today's path byte for byte: marker capture plus identity mapping. It gets no extra proof or serialization.
4. Callout plans on the proven exact offsets. Details resolves its block range on the exact text from the proven offsets, then requires the exact plan's status (wrap or unwrap) to equal the rendered plan's status.
5. The existing guards stay: liveness and rendered-text checks after acquisition, guarded `postExact` with rollback, and one native Undo step.

### Intended solution

- `rewrap-command.ts`: in Task 666's `captureNormalizingBodyRange`, skip the `proof.start.unit !== proof.end.unit` rejection when `proofMayCrossUnits` is set.
- `callouts.ts`: `captureCalloutActionTarget` clones the live Range before `captureRewrapSourceSelection` (IR/WYSIWYG). In `runCalloutAction`, outside SV, when the acquired pair is normalizing, take the start and end offsets from the proven range. Otherwise keep `mapOffsetToExact`.
- `details-toggle.ts`: keep the Range clone with the pointerdown target and pass it to `runDetailsToggle`. When the pair is normalizing, prove it, then call `resolveDetailsBlockRange(pair.exact, proven.startOffset, proven.endOffset)` and apply the status guard. Otherwise keep `mapRangeToExact`. Comments follow `.agents/rules/ts.md`.
- Contingency (verify in Part 2, real VS Code): the callout toolbar panel captures its target when it opens and applies later. If the IR callout rendering replaces editor nodes in between, the clone is detached and the action declines (fail closed). If the real-VS-Code cell shows that, also store the proof taken at capture time. At run time, accept it only when its exact and rendered text equal the acquired pair.

### Provisional decisions

- **Provisional decision (2026-11-01), reversible — Details and callout need a product change.** On a normalizing body, prove the retained Range after acquisition, decline when unproven, and keep round-trip documents unchanged. Tests only, or a line-ambiguity guard, would leave the measured wrong-span edit or stay off the proof path. Evidence: the duplicate-line probe above and the Owner decision of 2026-10-08. Selected by a recorded decision check (probability 0.99 against 0.01 for tests only and 0 for a line guard).
- **Provisional decision (2026-11-01), reversible — public name.** Add the optional field `proofMayCrossUnits?: boolean` next to Task 666's `proveNormalizingBody` rather than a new export (duplicated proof-to-range code) or the single-unit rule (multi-block Details would decline). Compatibility: optional field, default behavior unchanged. Selected by a recorded decision check (probability 0.81 against 0.08 for single unit and 0.01 for a new export).
- **Provisional decision (2026-11-01), reversible — selection-link item.** Record it as delivered by Task 666. This task adds no link code or link tests. It proves the item on the post-666 tree by running Task 666's Vitest cases and its bubble-link cells inside this task's focused real-VS-Code run. Selected by a recorded decision check (probability 0.91 against 0.03 for new link tests).
- **Provisional decision (2026-11-01), reversible — real-VS-Code placement.** Add three cells to `test/vscode-e2e/exact-authority-other-actions.spec.ts`. Put the duplicate-line cases on a new fixture `test/vscode-e2e/fixtures/exact-authority-duplicate-lines.md`. The shared fixtures stay unchanged. Selected by a recorded decision check (probability 0.98 against 0.01 for editing the shared fixture and 0 for a new spec file).
- **Provisional decision (2026-11-01), reversible — retained Details target.** On a normalizing body, a retained previous result without a live Range declines. Round-trip documents keep using it. Selected by a recorded decision check (probability 0.98 against 0.02 for proving the collapsed caret).

### Acceptance to test map

| Acceptance item | Layer | File | Test title |
| --- | --- | --- | --- |
| 1. Details apply on the proof path | Vitest (real Lute, bound source) | `media-src/src/editing/details-toggle-controls.test.ts` | `Task 671: Details on a normalizing body wraps the selected one of two duplicate-text paragraphs` |
| 1. | Vitest | same | `Task 671: Details wraps a multi-block selection on a normalizing body through the proof` |
| 1. | Real VS Code | `test/vscode-e2e/exact-authority-other-actions.spec.ts` | `${mode}: each action after a typed character changes only its span, Undo restores the typed state and Save writes the result`, new cell `details-duplicate-line` (document `duplicate`), plus the existing `details-toggle` cell |
| 1. Callout apply on the proof path | Vitest (real Lute, bound source) | `media-src/src/editing/rewrap-non-round-trip.test.ts` | `%s: Task 671 callout apply on a normalizing body converts the selected one of two duplicate-text paragraphs` |
| 1. | Real VS Code | same spec, same test | new cells `callout-apply` (document `normalizing`, the `detailsword` paragraph) and `callout-duplicate-line` (document `duplicate`) |
| 1. Front matter documents now use the proof path (regression) | Real VS Code | `test/vscode-e2e/front-matter-matrix.spec.ts` | `${mode}: front matter preserves every body action and shifts exact offsets` (Details and callout apply comparisons) |
| 2. Selection link step (delivered by Task 666) | Vitest | `media-src/src/editing/rewrap-non-round-trip.test.ts`, `media-src/src/editing/selection-link-actions.test.ts` | Task 666's `%s: Task 666 selection Link capture proves a paragraph on a normalizing body and plans only that span` and `passes the proof-only normalizing option to the range capture and applies on a normalizing document` |
| 2. | Real VS Code | `exact-authority-other-actions.spec.ts` | cells `bubble-link-normalizing` (apply) and `bubble-link-plain` in the actions test; `stale-host-bubble-link` in `${mode}: an outside edit the webview never saw is not overwritten by a following action` |
| 3. Focused real-VS-Code spec written and run; quality stages pass | Real VS Code, gates | the two specs above in one wrapper run; individual quality stages (aggregate `npm run quality` and audits are not run in this queue) | — |

Planned fixture `exact-authority-duplicate-lines.md`, verbatim: `# Duplicate lines`, blank, `editword paragraph before the duplicates`, blank, `   dupword paragraph shown twice` (three leading spaces), blank, `dupword paragraph shown twice`, blank, `closing paragraph`, final LF. No trailing whitespace, so `git diff --check` stays clean. Expected results, taken from the product planners in the probe (`tmp/671/probe/planner.test.ts`):
- Details: replace the first line with `<details>\n<summary>Details</summary>\n\n   dupword paragraph shown twice\n\n</details>`.
- Callout (type note, title `Proof`): replace the first line with `> [!NOTE] Proof\n>    dupword paragraph shown twice`.
- Span: the first occurrence's line. The second occurrence and all later bytes stay unchanged.

### Edge cases and cheapest layer

| Edge case | Layer | Test title |
| --- | --- | --- |
| Indentation and trailing-space duplicates; `# Same #` then `# Same` (Details) | Vitest (real Lute) | inside the two duplicate-paragraph cases (a document loop) |
| Unprovable endpoint (element offset) on a normalizing body declines, no `setValue`, no post | Vitest | `%s: Task 671 callout apply declines an unprovable selection on a normalizing body without the line mapping`; `Task 671: Details declines an unprovable selection on a normalizing body` |
| Range detached between capture and apply declines | Vitest | `%s: Task 671 callout apply declines when the retained range no longer belongs to the editor` |
| Retained Details result without a live Range on a normalizing body declines | Vitest | `Task 671: a retained Details result without a live range declines on a normalizing body` |
| Owned exact text differs from the acquired text: proof refuses | Vitest | covered by Task 666's `%s: Task 666 selection Link capture declines when the owned exact text is not the acquired text` (same helper) |
| Round-trip document keeps today's path | Vitest (existing) | existing `callouts.test.ts`, `details-toggle-controls.test.ts` and `details-toggle.test.ts` round-trip cases stay green |
| Front matter prefix plus a normalizing body | Vitest | prefix loop inside the callout duplicate case |
| CRLF host text on a normalizing body | Vitest | `%s: Task 671 callout apply keeps CRLF bytes outside the converted paragraph` |
| Typing just before the action (acquisition publishes it) | Real VS Code | every new cell types first |
| SV unchanged | Vitest (existing) | existing SV cases in `details-toggle-controls.test.ts` (`mountSv`) and `callouts.test.ts` |
| Table cell or list item target (callout declines today) | Recorded limit | none (fails closed, unchanged) |

### Part 2 step plan

**P2-S1 (RED, tests only).** Owned files: `media-src/src/editing/rewrap-non-round-trip.test.ts`, `media-src/src/editing/details-toggle-controls.test.ts`, `media-src/src/editing/callouts.test.ts`, `test/vscode-e2e/exact-authority-other-actions.spec.ts`, new `test/vscode-e2e/fixtures/exact-authority-duplicate-lines.md`.
- Add the Vitest cases above.
- Existing mocked-DOM Task 630 cases that apply on a normalizing pair cannot be proven after GREEN: `callout action exact authority (Task 630)` in `callouts.test.ts`, and the `exactHost` Details cases in `details-toggle-controls.test.ts`. Move them onto real Lute with a bound proof source (`bindRewrapSource` with the existing index and an exact snapshot set to the host text). Keep their assertions: one acquisition, the exact plan, stale-host refusal and the acquisition-failure decline.
- In the spec: add `DOCUMENTS.duplicate`, a callout driver (toolbar `callout` control, panel type `note`, title `Proof`, apply; reuse the panel steps of `front-matter-matrix.spec.ts`) and the three cells.
- Checks: `npx vitest run --config test/vitest.config.mts media-src/src/editing/rewrap-non-round-trip.test.ts media-src/src/editing/details-toggle-controls.test.ts media-src/src/editing/callouts.test.ts` exits 1. Expected failures: the two duplicate-paragraph cases, the two unprovable-decline cases, the detached-range case and the retained-target case. These fail because today's line mapping applies, or applies to the wrong paragraph. The multi-block, CRLF and moved Task 630 cases pass at RED.
- `npm run typecheck:vscode-e2e` exits 0. `npm run typecheck` may report the unknown `proofMayCrossUnits` field in a test until P2-S2; record it.
- Real VS Code RED: `timeout 900 node build.mjs`, then `the local real-VS-Code wrapper env -u ELECTRON_RUN_AS_NODE xvfb-run -a sh -c 'openbox & OB=$!; VMDE_XTEST=1 npm --prefix test/vscode-e2e test -- exact-authority-other-actions.spec.ts --workers=1 --retries=0; R=$?; kill $OB; exit $R'`. Expected: exit 1. `details-duplicate-line` and `callout-duplicate-line` fail with "bytes outside the action span changed" or "host differs from the intended exact result". The other cells pass.

**P2-S2 (GREEN).** Owned files: `media-src/src/editing/rewrap-command.ts`, `media-src/src/editing/callouts.ts`, `media-src/src/editing/details-toggle.ts`.
- Implement the intended solution.
- Checks: the same Vitest command exits 0. Consumer regression: `npx vitest run --config test/vitest.config.mts media-src/src/editing/details-toggle.test.ts media-src/src/editing/details-selection-state.test.ts media-src/src/editing/selection-link-actions.test.ts media-src/src/editing/callout-popover-keys.test.ts` exits 0.
- `timeout 900 node build.mjs`, `npm run typecheck` and `npm run lint:ci` exit 0.
- Real VS Code, one wrapper call: `the local real-VS-Code wrapper env -u ELECTRON_RUN_AS_NODE xvfb-run -a sh -c 'openbox & OB=$!; VMDE_XTEST=1 npm --prefix test/vscode-e2e test -- exact-authority-other-actions.spec.ts front-matter-matrix.spec.ts --workers=1 --retries=0; R=$?; kill $OB; exit $R'`. Expected: all tests pass. The new cells apply in both modes. `bubble-link-*` apply and both stale cells are `refused`. The matrix gives 12 comparisons per mode.

**P2-S3 (closure).** No product files. Run `npm run lint:ci`, `npm run typecheck`, `npm run typecheck:vscode-e2e`, `npm run knip`, `npm run jscpd`, `npm run depcruise`, `npm run check:brand-identifiers`, `npx vitest run --coverage --config test/vitest.config.mts --testTimeout=60000 --maxWorkers=2 --coverage.reportOnFailure`, `npm run check:coverage-modules` and `git diff --check`. Update this record (status, acceptance checkboxes, verification actually run) and write the completion report.

### Baseline (unchanged code)

- `npx vitest run --config test/vitest.config.mts media-src/src/editing/callouts.test.ts media-src/src/editing/details-toggle-controls.test.ts media-src/src/editing/details-toggle.test.ts media-src/src/editing/rewrap-non-round-trip.test.ts`: exit 0, 4 files, 159 tests pass.
- Real VS Code was not run in Part 1.

## Part 1 reconciliation (2026-11-01)

The handoff was checked against the tree after Tasks 666, 668 and 664 were integrated. Product code and tests were not changed. Result: the handoff stands. No decision changed. The step plan gets the amendments below.

### Claims checked against the integrated tree

- Task 666 landed with the names the handoff uses. In `rewrap-command.ts`, `proveNormalizingBody?: boolean` is at ~:398 and `captureNormalizingBodyRange` at ~:416. Its single-unit rejection is ~:430, the line the new `proofMayCrossUnits` field lifts. `captureFrontMatterRange` is at ~:448. In `captureRewrapSourceRange` (~:471), the normalizing branch runs first (~:486) and its `null` is final, with no marker fallback. A call with `authoritativeMarkdown: pair.exact` on a pair where `!sameRenderedText(pair.exact, pair.rendered)` always reaches the proof branch, because the rendering differs from the authoritative text. Front matter documents therefore also take the proof branch before the front matter branch, as the handoff expects.
- Task 666 covers none of the Details or callout work. Its scope excluded them, and `callouts.ts` is unchanged by all three integrated tasks. It does deliver acceptance item 2. The Vitest cases `%s: Task 666 selection Link capture proves a paragraph on a normalizing body and plans only that span` (`rewrap-non-round-trip.test.ts`) and `passes the proof-only normalizing option to the range capture and applies on a normalizing document` (`selection-link-actions.test.ts`) exist. In `exact-authority-other-actions.spec.ts`, `bubble-link-normalizing` (~:504) is now an apply case, and the stale-host test loops over `STALE_DRIVERS` (~:715 `stale-host-details`, ~:724 `stale-host-bubble-link`).
- Task 664 changed only the Details selection write. `runDetailsToggle` (~:148) now calls `invalidateCaret()` and then `writeSelection(range)` (~:224). The mapping path is unchanged: `mapRangeToExact` ~:87, the pointerdown capture ~:572-577, the `runDetailsToggle` call ~:588, `liveEditorRange` ~:456 (it still returns the live selection Range, so the clone is still needed). The guard test `test/backend/selection-writes.test.ts` rejects raw selection writes in product sources only; test files are exempt. The planned product change adds no selection write; `Range.cloneRange()` is not one.
- `callouts.ts` lines are unchanged: `CalloutActionTarget` ~:114, `captureCalloutActionTarget` ~:437 with the legacy `captureRewrapSourceSelection(win)` at ~:465, `runCalloutAction` ~:495 with `mapOffsetToExact` at ~:522 and ~:527.
- The defect is still present on the integrated tree. The scratch probe was rerun (`tmp/671/probe-head.log`): 41 cases pass, and the duplicate-line cases (`dupFixture`, `trailDup`, `indentDup`, plus `hashDup` for Details) still edit the wrong paragraph in both modes. The proof maps every proven case correctly. The thematic-break scanner change from Task 666 did not change any probe result.
- Baseline on the integrated tree: `callouts.test.ts`, `details-toggle-controls.test.ts`, `details-toggle.test.ts`, `rewrap-non-round-trip.test.ts`, `selection-link-actions.test.ts` and `test/backend/selection-writes.test.ts` all pass (exit 0, 6 files, 174 tests).

### Decisions

All five provisional decisions of the handoff are confirmed unchanged. The integrated names equal the planned ones, and the evidence is the same. No new decision was needed.

### Step plan amendments

- P2-S1, spec: the `Scenario.document` union (~:440, `'normalizing' | 'plain'`) gains `'duplicate'`. `DOCUMENTS` (~:559) gains `duplicate: { name: 'duplicate-lines', content: fixture('exact-authority-duplicate-lines.md') }`. The new cases go into the `SCENARIOS` table next to `details-toggle` (~:463). The stale-host test stays as integrated; no callout stale driver is added, because Details already has `stale-host-details` and the stale guard is shared. The callout driver must click through `clickToolbarControl` or the panel steps without raw selection writes in product code. Selection writes in the spec run in the page and are not covered by the guard test.
- P2-S1, Vitest: in `rewrap-non-round-trip.test.ts`, add the callout cases after Task 666's selection Link cases. They reuse its `mount`, `point` and `select` helpers. In `details-toggle-controls.test.ts`, the `exactHost` cases move onto the bound proof source. Add `bindRewrapSource({ index, snapshotPair })` in `mount` with the exact snapshot set to `HOST_EXACT`, and unbind it in teardown.
- P2-S2 consumer regression adds `test/backend/selection-writes.test.ts`. The full command is `npx vitest run --config test/vitest.config.mts media-src/src/editing/details-toggle.test.ts media-src/src/editing/details-selection-state.test.ts media-src/src/editing/selection-link-actions.test.ts media-src/src/editing/callout-popover-keys.test.ts test/backend/selection-writes.test.ts`, which exits 0.
- P2-S2 implementation: the new `proofMayCrossUnits` check sits inside `captureNormalizingBodyRange` at the single-unit rejection. The test is `!proof.roundTrip && proof.start.unit !== proof.end.unit && !options.proofMayCrossUnits`. This means passing the options (or that one flag) into the helper. No other signature changes.
- Owned files, checks and expected outcomes are otherwise unchanged from the handoff.

## Callout apply Undo (2026-11-01)

**Finding.** In real VS Code, after callout apply on a normalizing document, the host text, disk and Save are exactly right. A native Ctrl+Z then leaves the host unchanged (the Undo host text equals the action result), and Redo leaves it unchanged too. This holds for `callout-apply` (a unique paragraph) and `callout-duplicate-line` (`exact-authority-other-actions.spec.ts`) in IR and WYSIWYG. It held before this task's product change (the RED run on unchanged product code) and still holds after it.

Details toggle on the same fixture passes the same check. It uses the same action dependencies (`boot/main.ts`: authority acquisition, guarded exact post, applying flag) and the same native Undo checkpoints. Candidate differences, not tested yet: the callout apply places its caret through a deferred `requestCaret` (an armed caret intent) rather than retiring the intent and writing the selection; the callout dual-node observer re-renders the block quote after `setValue`; and the action runs from the callout toolbar panel. No earlier real-VS-Code Undo test for callout apply exists. The cause is outside this task's proof-path mapping.

**Provisional decision (2026-11-01), reversible — split the callout Undo failure.** File it as Task 674 ("Callout apply: native Undo is a no-op in real VS Code"), as the Owner decision of 2026-10-08 requires for a failure with a different mechanism. Keep the Undo check in the two callout cases, behind a reasoned known-failure flag that names Task 674. The check still runs and its result is recorded. An Undo failure is reported as expected-failing, not as a contract violation. An unexpected pass fails the case, so the flag must be removed when Task 674 lands. Selected by a recorded decision check (probability 1.0 against 0 for investigating further inside this task and 0 for removing the check).

**Next step (P2-S2b, test and record only).**
- Owned files: `test/vscode-e2e/exact-authority-other-actions.spec.ts`, a new `tasks/674-callout-apply-native-undo.md`, and this record.
- Spec: add an optional `knownUndoFailure?: string` field to `Scenario`, set to `'Task 674'` on `callout-apply` and `callout-duplicate-line`. In `actionAfterTyping`, when the field is set:
  - An Undo that does not restore the typed state is recorded as `expectedFailure: 'Task 674: …'` and is not added to the violations.
  - An Undo that does restore it adds the violation `known Undo failure (Task 674) no longer fails: remove the flag`.
  - The Redo check runs only when the Undo succeeded, as before.
  - Leave a comment at the flag naming Task 674 and the reason.
- Record 674: problem, the evidence above, the candidate causes, acceptance (one native Undo restores the typed state and Redo reapplies, in IR and WYSIWYG; remove the flag), and "Depends on: Task 671".
- Checks:
  - `npm run typecheck:vscode-e2e` exits 0.
  - `npx biome check test/vscode-e2e/exact-authority-other-actions.spec.ts` exits 0.
  - `timeout 900 node build.mjs` exits 0.
  - One wrapper run: `the local real-VS-Code wrapper env -u ELECTRON_RUN_AS_NODE xvfb-run -a sh -c 'openbox & OB=$!; VMDE_XTEST=1 npm --prefix test/vscode-e2e test -- exact-authority-other-actions.spec.ts --workers=1 --retries=0; R=$?; kill $OB; exit $R'`. Expected: exit 0, 4 tests pass, and the two callout cases show `expectedFailure` in both modes.
- P2-S3 (closure) then follows as planned. Record Task 674 in the completion report, and in the tasks index only if the index rules allow open records.


## Part 2 implementation and closure (2026-11-01)

### Implemented

- `rewrap-command.ts`: optional `proofMayCrossUnits` next to Task 666's `proveNormalizingBody`; it lifts the single-unit rule only when set. Selection Link does not set it.
- `callouts.ts`: the action target keeps a copy of the live Range (IR and WYSIWYG). On a normalizing pair (`!sameRenderedText(exact, rendered)`), callout apply maps offsets only through the selection proof of that Range and declines when it is missing or unproven; round-trip documents and SV keep the line mapping. The IR block quote panel captures its target when it renders (review repair), so Apply works after focus has moved into the panel.
- `details-toggle.ts`: the same proof-only mapping for the Details action, with a plan-status check against the rendered plan; a retained earlier result has no remembered Range and declines on a normalizing body. `exactDetailsRange` is exported for its unit test.
- Tests: new cases in `rewrap-non-round-trip.test.ts`, `details-toggle-controls.test.ts` and `callouts.test.ts` (the three Task 630 callout cases moved onto real Lute with the proof source bound); three new real-VS-Code cases and the fixture `exact-authority-duplicate-lines.md`.

### Verification actually run

| Command | Exit | Result |
| --- | --- | --- |
| Focused Vitest: rewrap-non-round-trip, details-toggle-controls, callouts, details-toggle, details-selection-state, selection-link-actions, callout-popover-keys, `test/backend/selection-writes.test.ts` | 1 (RED), then 0 | RED: 6+3 cases failed for the intended reasons; final: 8 files, 209 tests pass |
| Real VS Code, `exact-authority-other-actions.spec.ts`, one worker, no retries | 1 (RED), 1 (GREEN with Undo), 0 | Final: 4 passed in 12.0 min; callout Undo reported as expected failure (Task 674) |
| `npm run lint:ci`, `typecheck`, `typecheck:vscode-e2e`, `check:brand-identifiers`, `depcruise`, `jscpd` | 0 | `jscpd` reports 1939 clones across the repository; `depcruise` keeps its compiler-version warning |
| `npm run knip` | 0 | one tag hint (existing `@knipignore` in `callouts.ts`) |
| `npx vitest run --coverage --config test/vitest.config.mts --testTimeout=60000 --maxWorkers=2 --coverage.reportOnFailure` | 0 | 382 files, 8312 passed, 1 expected failure; 82.26% statements |
| `npm run check:coverage-modules` | 0 | 9 modules at 0%, baseline 9 |
| `git diff --check` | 0 | |
| Reporting only | | `media/dist/main.js` 1,116,089 bytes; eager modules 407 of budget 294 (already over before this task; no module was added) |

### Provisional decisions

All of the Part 1 decisions stand. Added: the callout Undo split (Task 674), selected by a recorded decision check (probability 1.0).

### Known limits and residuals

- A collapsed caret at offset 0 of a paragraph whose leading indentation Lute stripped declines on a normalizing body (the proof's caret-bias alignment). It fails closed; no code change.
- The IR block quote panel's target is captured when the panel renders. A caret move within the same block quote keeps that target, and the apply step still checks that the rendering has not changed.
- Task 674 (callout apply native Undo). Evidence: the Undo failure appears on unchanged product code too.
- The review mentioned a finding 4 that this record has no text for.
