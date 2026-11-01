# Task 669 — SV offset mapping and failures that also occur on dev

**Status:** done with item 2 partially met (2026-11-01). Filed at the close of Tasks 606 and 630. The SV table-format and list-normalize writes now prove their positions; the SV case of the exact-authority matrix moved to Task 675.
**Origin:** Task 630, Task 606.
**Severity:** low (estimated).
**Tech stack:** `media-src/src/editing/list-normalize-source-command.ts`, `table-format-command.ts`, `rewrap-command.ts` (`mapCaretOffsetByLine`), `test/vscode-e2e`, `media-src/e2e`.
**Depends on:** Task 630, Task 606.

## Problem

(1) `mapCaretOffsetByLine` still authorizes SV table-format and list-normalize writes. (2) The SV list-normalize cell of Task 630 (`vmde.fixListNumbering` after typing) did not change the host and was dropped from the spec. (3) These specs fail on `dev` as well: `shortcut-negative.spec.ts:509` (IR, WYSIWYG, a Chromium spec in `media-src/e2e`), `callout-ir.spec.ts:597` (Chromium), `link-popover.spec.ts:241`, `list-normalize.spec.ts:77`, `outline-reorder.spec.ts:15` and `:187`, `auto-wrap.spec.ts:31` (`Paragraph 401 ... not found in IR`), `rewrap.spec.ts` (`scrollKept: false`, line ~430), `ir-click-index.spec.ts:641` (test recorder admission predicate drift), `large-document-interaction.spec.ts:416` (`getValueCalls` 1, expected 0) and `selection-performance.spec.ts:471` (selection direction assertion, line ~985) in real VS Code.

## Proposed work

Replace `mapCaretOffsetByLine` for the SV writes with a proof-based mapping, restore the SV list-normalize cell, and triage each listed failure (fix, or move the expectation).

## Acceptance

- [x] No SV write is authorized by line mapping alone. `table-format-command.ts` and `list-normalize-source-command.ts` no longer use `mapCaretOffsetByLine`; they prove the retained offsets and the changed region against the acquired exact text (`sv-source-proof.ts`). A static test and 26 Vitest cases cover it; `table-format.spec.ts:12` proves the CRLF table through Undo, Redo, Save and reopen in real VS Code.
- [~] The SV list-normalize case exists and passes — partially met. The SV list write is proved by the SV part of `list-normalize.spec.ts` (real VS Code: command, Undo, Redo, Renormalize all, Save, reopen) and the Vitest cases. The case in `exact-authority-other-actions.spec.ts` (after typing) is blocked by the Source-mode acquisition relation in `bridge/edit-sync.ts`, which fails after a mode switch and on a direct Source open (Vditor renumbers ordered lists in its own text). Moved to [Task 675](../675-sv-exact-authority-relation-after-mode-switch.md).
- [x] Each listed failure is fixed or recorded with a reason (table in "Closure" below).
- [x] Focused real-VS-Code specs written and run; the quality stages were run one by one (the dependency audit is omitted by Owner instruction; the aggregate `npm run quality` was not run).

## Part 1 handoff (2026-11-01)

Base: `dev` at `90611a6b` (Tasks 665, 666 and 668 integrated). Part 2 starts after Tasks 664, 671 and 667 are integrated. Tier: Heavy for the SV mapping lane (source fidelity), Medium for the failure triage lane.

### Corrections to the problem statement

- `shortcut-negative.spec.ts:509` (IR, WYSIWYG) and `callout-ir.spec.ts:597` are Chromium specs (`media-src/e2e`), not real VS Code. Both are already in the known pre-existing Chromium failure list.
- `rewrap.spec.ts` and `auto-wrap.spec.ts` now fail at different points than the problem statement records (see the baseline table).
- `table-format.spec.ts:12` (SV Format Table is a no-op) is added to this task. It fails on `dev` for the same reason as the SV list-normalize case.

### Root cause of the SV no-op (measured)

A scratch probe in real VS Code on `dev` opened a CRLF table fixture, switched IR to SV and compared the texts (lengths and booleans only):

- SV editor text (`textContent`): 68 characters, ending in `"\nafter\n\n"`.
- Edit-sync SV snapshot (`serializeSvForHost`, the `rendered` half of the acquired pair): 67 characters. It removes the newline span that Vditor always appends to SV.
- Host exact text: 55 characters, with carriage returns. After an IR to SV switch, the SV text is the Lute serialization: the table is already padded.
- `LF(exact) === editor text`: false. `LF(rendered) === editor text`: false. `LF(exact) === rendered`: false.

Both SV commands (`table-format-command.ts` `runAcquired`, `list-normalize-source-command.ts` `runAcquired`) require `lineEndings(pair.exact) === editor text` and `lineEndings(pair.rendered) === editor text` before they map offsets with `mapCaretOffsetByLine`. The second check can never hold, because the editor text keeps the appended newline span and the snapshot drops it. So both commands decline silently on every SV document. The first check also fails on any normalizing document after a mode switch. This is why `table-format.spec.ts:12` and the SV part of `list-normalize.spec.ts:77` (at `:258`-`:260`, where the fixture text is typed raw and does not normalize) fail on `dev`, and why the Task 630 SV list-normalize case did not change the host. Before Task 630 the table command applied editor offsets directly to the exact text and replaced the whole SV text with the LF exact text. Task 630 added the equality checks, which made the command a no-op.

### Scope

- In scope: SV `vmde.formatTable` (`table-format-command.ts`) and SV `vmde.fixListNumbering` / `vmde.renormalizeAllLists` (`list-normalize-source-command.ts`), with the shared proof helpers in `sv-source-proof.ts`.
- Out of scope, with reasons:
  - `details-toggle.ts` `mapRangeToExact`: it already pairs the line mapping with a slice-equality proof, and Task 671 changes this function. No change here.
  - `rewrap-command.ts` `documentTarget` (SV Rewrap Document caret) and `mapOffsetToExact`: the Rewrap Document proof belongs to Task 670, and Task 671 changes `rewrap-command.ts`. `mapCaretOffsetByLine` stays exported for those callers.
  - `table-format.ts` and `list-normalize-source.ts` (the planners) are not changed.

### Intended solution (mapping lane)

The Task 605 SV proof (`sv-source-proof.ts`, already used by SV Turn Into) is the shared interface. The editor text `T = svText(editor)` only locates positions. The acquired `pair.exact` is the only text the commands plan on.

1. Capture stays as it is: retained editor identity, `T` and editor-text offsets.
2. After the acquisition: check liveness as today (`textContent` still equals the retained text). Remove both whole-text equality checks.
3. Prove both retained endpoints against `pair.exact` through the bounded alignment, using the new export `proveSvOffsets(exact, text, startAt, endAt)` (same rules as `proveSvSelection`; `proveSvSelection` delegates to it). An unprovable endpoint declines with no write and no DOM change.
4. Plan on `pair.exact` with the proven exact offsets (`formatTableAtSelection`, `normalizeOrderedListsSource`). The table command drops `mapRenderedTableSelectionToSource` from this path, because the proven offsets are already exact.
5. Find the exact span the plan changed (the common prefix and suffix of `pair.exact` and `result.markdown`), widened to the planned block (the table range, or the list roots). Map its bounds to `T` with the new export `svRenderedBounds(exact, text, span)`. Each bound must be proven through the alignment (adjacent character equal, exact text boundary). The rendered region must also be the same block: either verbatim (`LF(exact slice) === T slice`), or equal after the shipped Lute formatter (`FormatStr`) on both LF texts. Otherwise decline.
6. Plan the editor change with the new export `planSvRegionEdit(exact, result, span, rendered)`. Bytes outside the span must be unchanged, the replacement is `LF(result slice)`, and the carets are mapped linearly inside the region, counting removed carriage returns. Splice only that region with `spliceSvRenderedSpan`. The editor text outside the region stays as it is. Undo history: `recordRewrapDocumentHistory` with the whole `T` before and after, and the exact text before and after.
7. Post `postExact(result.markdown, { rollback })` with the default `before`, as today.

Source-fidelity invariants: (a) no SV write is authorized by line mapping alone; `mapCaretOffsetByLine` is no longer imported by either command. (b) Host bytes outside the planned span equal `pair.exact`. (c) Editor text outside the rendered region is unchanged. (d) Every failed proof declines with no write, no DOM change and no history entry. (e) CRLF documents keep CRLF in the host; the editor gets LF.

Settled names: `proveSvOffsets`, `svRenderedBounds` and `planSvRegionEdit` are new exports of `media-src/src/editing/sv-source-proof.ts`. No new module, so `scripts/module-manifest.mjs` does not change. No enum, storage format or setting changes. The retained selection format (editor-text offsets) does not change.

### Baseline on `dev` `90611a6b` (2026-11-01, one run each, `--retries=0`)

| Failure | Layer | Result on `dev` | Provisional class |
|---|---|---|---|
| `table-format.spec.ts:12` | real VS Code | fails at `:115` (host keeps the raw table) | product defect in scope (mapping lane) |
| `list-normalize.spec.ts:77` | real VS Code | fails at `:260`, the SV part (`9. nested stale` not renumbered) | product defect in scope (mapping lane) |
| `outline-reorder.spec.ts:15` | real VS Code | fails at `:108`: Undo works, Redo leaves the original order | product defect, cause not measured |
| `outline-reorder.spec.ts:187` | real VS Code | fails at `:276`: same Redo failure | product defect, cause not measured |
| `auto-wrap.spec.ts:31` | real VS Code | fails in the SV iteration at `:603` (the paragraph is never wrapped); IR and WYSIWYG pass | product defect, cause not measured (it may share the SV rendered-form mismatch) |
| `rewrap.spec.ts:116` | real VS Code | fails in the WYSIWYG iteration at `:308` (selection Rewrap does not change the host) | product defect, cause not measured (Task 671 changes this path) |
| `ir-click-index.spec.ts:641` | real VS Code | fails at `:185` "test recorder admission predicate drift" | test defect: `ir-click-mutation-recorder.ts` lacks `data-vmde-indent` and `data-vmde-indent-root`, which `source-block-index.ts` gained in Task 649 |
| `large-document-interaction.spec.ts:416` | real VS Code | passed | load-dependent; recorded, no change |
| `selection-performance.spec.ts:471` | real VS Code | fails at `:1006` (`fullGetValueCalls` 2, limit 1) | load-dependent or performance; measure once more in Part 2 |
| `link-popover.spec.ts:241` | real VS Code | passed (as in Task 667) | recorded, no change |
| `shortcut-negative.spec.ts:509` (IR, WYSIWYG) | Chromium | fails (`moveRequests` is `[]`) | known Chromium failure; recorded, no change |
| `callout-ir.spec.ts:597` | Chromium | fails (context panel hidden) | known Chromium failure; recorded, no change |

### Decisions

- **Provisional decision (2026-11-01), reversible: SV proof mechanism.** The SV commands reuse the SV alignment proof (`sv-source-proof.ts`) and splice only the proven rendered region, as described above. Rejected: a whole-document equality proof that declines every normalized SV document (it cannot pass `table-format.spec.ts` after a mode switch), and line mapping plus a slice check (still a line-mapping authorization). Evidence: the measured texts above and the Task 605 machinery. Selected by a recorded decision check (probability 1.0).
- **Provisional decision (2026-11-01), reversible: triage policy.** Part 2 measures the failures with no measured cause again on the integrated `dev` (after Tasks 664, 671 and 667), with a scratch probe for each. A failure is fixed here only when its cause is the SV rendered-form mismatch that the mapping lane fixes, or a test-only defect. Otherwise this record gets the measured cause, and a follow-up task is proposed. Selected by a recorded decision check (probability 0.86).
- **Provisional decision (2026-11-01), reversible: Details toggle scope.** `details-toggle.ts` is out of scope. Its mapping already has a slice-equality proof, and Task 671 changes it. Settled by the source and the Task 671 handoff; no decision check was needed.
- **Provisional decision (2026-11-01), reversible: `ir-click-index.spec.ts:641`.** This is a test defect. The fix updates the copied predicate in `test/vscode-e2e/ir-click-mutation-recorder.ts` to match `source-block-index.ts`. Settled by the drift assertion output.

### Acceptance to test map

| Acceptance item | Layer | File | Test |
|---|---|---|---|
| 1. No SV write authorized by line mapping alone | Vitest | `media-src/src/editing/sv-source-proof.test.ts` (new) | `Task 669: proveSvOffsets ...`, `svRenderedBounds ...`, `planSvRegionEdit ...` cases (below) |
| 1. | Vitest | `media-src/src/editing/table-format-command.test.ts` | new `Task 669:` cases: trailing newline span applies; normalized SV table applies with outside text unchanged; duplicate tables choose the proven one; unprovable endpoint declines |
| 1. | Vitest | `media-src/src/editing/list-normalize-source-command.test.ts` | new `Task 669:` cases with the same shape for lists |
| 1. | static check | `grep -n mapCaretOffsetByLine media-src/src/editing/table-format-command.ts media-src/src/editing/list-normalize-source-command.ts` | no matches |
| 1. | real VS Code | `test/vscode-e2e/table-format.spec.ts` | `:12` "Format table command keeps exact CRLF source through undo, redo, save, and reopen in SV" (passes, unchanged) |
| 2. SV list-normalize case exists and passes | real VS Code | `test/vscode-e2e/exact-authority-other-actions.spec.ts` | new test `sv: each action after a typed character changes only its span, Undo restores the typed state and Save writes the result`, scenario `list-normalize-sv` (plus `table-format-sv`) |
| 2. | real VS Code | `test/vscode-e2e/list-normalize.spec.ts` | `:77` passes (its SV part) |
| 3. Each listed failure fixed or recorded with a reason | real VS Code and Chromium | specs in the baseline table | one triage run on the integrated `dev`; results recorded in this file |
| 4. Focused real-VS-Code spec written and run; quality stages pass | real VS Code and gates | the specs above; the `npm run quality` stages run one by one (the dependency audit is omitted in this queue) | closure step |

### Edge cases and cheapest test layer

- SV text with Vditor's trailing newline span (and U+200B after a direct SV open): Vitest.
- CRLF document: host keeps CRLF, editor gets LF, caret lands at the same character: Vitest; real VS Code `table-format.spec.ts:12`.
- Normalized SV text after an IR to SV switch (padded table, renumbered list): Vitest with real Lute text.
- Two identical tables or list lines (the case where line mapping would choose wrongly): Vitest.
- An endpoint inside a normalized-only region (for example table padding): declines with no write: Vitest.
- A selection that spans two tables or two list roots: declines as today: Vitest.
- Typing just before the command (acquisition settles the input; the SV case of item 2): real VS Code.
- A host refusal (stale host): rollback restores the editor text and the Undo stacks: Vitest (existing rollback cases).
- Composition active or the editor read-only: declines (existing cases).

### Part 2 step plan

Lane A, SV mapping (Heavy):

- **A1 RED (tests only).** Owned files: `media-src/src/editing/sv-source-proof.test.ts` (new), `media-src/src/editing/table-format-command.test.ts`, `media-src/src/editing/list-normalize-source-command.test.ts`, `test/vscode-e2e/exact-authority-other-actions.spec.ts` (add the `sv` test with the `list-normalize-sv` and `table-format-sv` scenarios; the shared kit already supports `sv`). Check: `npx vitest run --config test/vitest.config.mts media-src/src/editing/sv-source-proof.test.ts media-src/src/editing/table-format-command.test.ts media-src/src/editing/list-normalize-source-command.test.ts` exits 1. Expected: the new `Task 669:` cases fail (missing exports, or today's command declines); the existing cases pass.
- **A2 GREEN.** Owned files: `media-src/src/editing/sv-source-proof.ts`, `media-src/src/editing/table-format-command.ts`, `media-src/src/editing/list-normalize-source-command.ts`. Checks: the same Vitest command exits 0; `media-src/src/editing/block-transform-sv.test.ts` exits 0 (SV Turn Into unchanged); `npm run typecheck` and `npm run lint` exit 0; the `grep` above prints nothing. Real VS Code (orchestrator batch, after `node build.mjs`): `table-format.spec.ts:12 list-normalize.spec.ts:77`, and `exact-authority-other-actions.spec.ts -g "sv:"`, all pass.

Lane B, triage (Medium):

- **B1 Light RED+fix: `ir-click-index.spec.ts:641`.** Owned file: `test/vscode-e2e/ir-click-mutation-recorder.ts`. The spec is already RED on `dev` (`:185` drift). Check: real VS Code `ir-click-index.spec.ts:641` passes.
- **B2 Measurement.** On the integrated `dev`, one wrapper call: `outline-reorder.spec.ts:15 outline-reorder.spec.ts:187 auto-wrap.spec.ts:31 rewrap.spec.ts:116 selection-performance.spec.ts:471 large-document-interaction.spec.ts:416 link-popover.spec.ts:241`, plus scratch probes (untracked) for the outline Redo history and the SV auto-wrap capture. Run this after A2, so that a shared SV cause shows as fixed. Output: the measured cause and class of each failure, recorded here. No product change in B2.
- **B3 (only if B2 finds a test-only defect or the shared SV cause).** One Light RED+fix step per item, with files named from the measurement. Any other product defect gets a proposed follow-up task.

Closure: run the quality stages one by one (lint, knip, jscpd, dependency-cruiser, unit coverage, zero-coverage ratchet; no audit), run one combined real-VS-Code batch of the specs above, and update the acceptance boxes.

## Part 1 reconciliation (2026-11-01)

Base: `dev` at `11208300`. Since the Part 1 handoff (on `90611a6b`), Task 664 (`ce4931d5`), Task 672 (`e3b0c5ee`) and Task 671 (`11208300`) have landed. The step B1 recorder fix (`test/vscode-e2e/ir-click-mutation-recorder.ts`) is kept as an uncommitted change.

### Handoff claims re-checked against `11208300`

- **Unchanged since `90611a6b`.** The following files have no diff: `table-format-command.ts`, `list-normalize-source-command.ts`, `sv-source-proof.ts`, `find-align.ts`, `bridge/edit-sync.ts`, `table-operations.ts`, `table-format.ts`, `list-normalize-source.ts`, `table-format-command.test.ts`, `list-normalize-source-command.test.ts`, `test/vscode-e2e/table-format.spec.ts`, `test/vscode-e2e/list-normalize.spec.ts` and `nav/source-block-index.ts`. The measured root cause and the intended solution therefore still apply as written.
- **`rewrap-command.ts` (Task 671).** It adds only `proofMayCrossUnits` to the normalizing-body capture. `mapCaretOffsetByLine`, `mapOffsetToExact` and `textPointAt` are still exported, so the scope note in the handoff still holds.
- **`details-toggle.ts` (Task 671).** It proves normalizing pairs and keeps `mapRangeToExact` (line mapping plus a slice-equality proof) for the other pairs. It stays out of scope.
- **New constraint from Task 664.** `test/backend/selection-writes.test.ts` fails on any raw Selection write in webview source outside `editing/caret.ts` and `util/selection-write.ts`. The A2 code must place carets only through `requestCaret` (which both commands already use) and must not call `addRange`, `removeAllRanges`, `setBaseAndExtent` or the two-argument `collapse`. A2 runs this guard test. Today the three lane-A product files contain no such call.
- **`exact-authority-other-actions.spec.ts` (Task 671).** It gained the `duplicate` document, the Details and callout duplicate-line cases and the `knownUndoFailure` flag (Task 674). The action loop is still `for (const mode of ['ir', 'wysiwyg'] as const)` at about `:932`. Task 667 edits the `openLinkPopover` helper in this file. That is why the SV cases (A1b) wait for Task 667 to integrate.
- **Task 672 finding (for B2).** In real VS Code, the auto-wrap firing on the large IR fixture runs its proof but does not change the host text, while a manual Rewrap on the same state applies. Task 672 did not measure this further. The `auto-wrap.spec.ts:31` failure in this task is in the SV iteration of a small fixture (the IR and WYSIWYG iterations passed on `90611a6b`). B2 must check whether both failures have one cause in the auto-wrap apply path before it classifies either one.
- **Baseline unit tests on `11208300`.** `table-format-command.test.ts`, `list-normalize-source-command.test.ts`, `block-transform-sv.test.ts` and `selection-writes.test.ts` pass: 4 files, 51 tests.

### Decisions

None of the Part 1 decisions changes. The SV proof mechanism, the triage policy, the Details toggle scope and the `ir-click-index.spec.ts:641` test defect stand as recorded. No new decision check was needed. The step plan below changes only how lane A is split. Step B1 is done: `ir-click-index.spec.ts:641` passes in real VS Code with the recorder fix.

### Amended lane A plan (it replaces A1 and A2 of the handoff)

- **A1a RED (Vitest only, runnable now).** Owned files: `media-src/src/editing/sv-source-proof.test.ts` (new), `media-src/src/editing/table-format-command.test.ts`, `media-src/src/editing/list-normalize-source-command.test.ts`.
  - Cases (all titled `Task 669: …`):
    - `proveSvOffsets`: proves a caret and a range in an equal run; declines an endpoint inside normalized table padding; handles CRLF exact text against LF editor text.
    - `svRenderedBounds`: proves the bounds of a padded table and of a renumbered list root; declines when a boundary character differs.
    - `planSvRegionEdit`: CRLF replacement becomes LF, and carets map inside the region; declines when bytes outside the span differ.
    - Each command: applies when the editor text keeps Vditor's trailing newline span; applies on a normalized SV table or list with the editor text outside the region unchanged and the posted exact bytes outside the span equal to `pair.exact`; with two identical tables or list lines, chooses the proven one; declines with no write, no DOM change and no post when an endpoint is unprovable.
  - Check: `npx vitest run --config test/vitest.config.mts media-src/src/editing/sv-source-proof.test.ts media-src/src/editing/table-format-command.test.ts media-src/src/editing/list-normalize-source-command.test.ts` exits 1. Expected: only the new `Task 669:` cases fail (missing exports, or today's command declines); the existing cases pass.
- **A2 GREEN (product, runnable now).** Owned files: `media-src/src/editing/sv-source-proof.ts`, `media-src/src/editing/table-format-command.ts`, `media-src/src/editing/list-normalize-source-command.ts`.
  - Checks:
    - The A1a Vitest command exits 0.
    - `npx vitest run --config test/vitest.config.mts media-src/src/editing/block-transform-sv.test.ts test/backend/selection-writes.test.ts` exits 0.
    - `npm run typecheck` exits 0, and `npx biome check` on the owned files exits 0.
    - `grep -n mapCaretOffsetByLine media-src/src/editing/table-format-command.ts media-src/src/editing/list-normalize-source-command.ts` prints nothing.
    - After `node build.mjs`, one wrapper call: `table-format.spec.ts:12 list-normalize.spec.ts:77`. Both pass. A2 does not edit these specs.
  - These two specs prove acceptance item 1 in real VS Code. `list-normalize.spec.ts:77` also proves its own SV part (acceptance item 3).
- **A1b (after Task 667 integrates).** Owned file: `test/vscode-e2e/exact-authority-other-actions.spec.ts`. Add `'sv'` to the action loop. Add the scenarios `list-normalize-sv` and `table-format-sv` (`modes: ['sv']`, document `normalizing`), each with its span and expected result. Do not touch the `openLinkPopover` helper or the other cases.
  - Check: `npm run typecheck:vscode-e2e` exits 0. Then, after `node build.mjs`, one wrapper call: `exact-authority-other-actions.spec.ts -g "sv:"` passes.
  - This proves acceptance item 2. If A2 has landed first, A1b can run as one Light step (RED and fix together).

Lane B is unchanged. B1 is complete. B2 (measurement on the integrated `dev`) runs after A2, so that a cause shared with the SV mapping shows as fixed. B2 now also includes the Task 672 auto-wrap finding.

## Lane A review repair (2026-11-01)

An independent review of the lane A candidate found no data-loss path: the host bytes outside the planned span are enforced equal, and every failed proof declines with no write. Findings fixed in step R1:

- **F1.** The SV list command no longer widens its span to the selection and no longer requires a verbatim region. The span is the changed bytes widened to the list block (the run of non-blank lines around them). The block must be verbatim, or equal after Lute formats both LF texts. A caret outside the region keeps its own proof and maps by itself (before: same editor offset; after: moved by the region's size change). New Vitest cases cover a Lute-normalized list (`1. one` / `1. two` against an editor showing `2. two`) and scope `all` with the caret on text outside the list while a table is padded.
- **F3.** The table command cases now assert the offset passed to `requestCaret` (it lies in the formatted table) and include a verbatim-duplicates case.
- **F4.** `planSvRegionEdit` also requires both region edges to be exact text boundaries, so an edge cannot split a CR/LF pair.
- **F6.** Added the renumbered-list-root bounds case and a command case for a list whose region is not verbatim while both endpoints are proven.

Recorded, not fixed:

- **F2 (accepted limit).** A caret inside table cell padding (spaces with no exact image) is unprovable, so the table command declines silently. This follows the contract (no write from an unproven position). Follow-up candidate: snap to the nearest proven offset in the same cell.
- **F5 (residual).** The commands do not check that the acquired exact text is a projection of the retained editor text beyond the endpoint and region proofs; an optional staleness relation check could be added later. Today a stale exact text fails the proofs or leaves bytes outside the region untouched.

## A1b decision and follow-ups (2026-11-01)

### Why the SV cases could not pass as drafted

The shared test kit opens every document in IR and then switches to SV. After that switch the SV text is Lute's serialization (the table is padded), while the host text stays raw. The SV cases then type a character first. That trusted typing revokes the owned exact text, so the command's acquisition falls back to the host request. In SV the host request proves the relation only when `normalizeEol(exact) === rendered`. On a switched document that relation fails, the acquisition returns nothing, and the command declines with no write. The Task 669 mapping is never reached. This fails closed: nothing is lost, the action is just refused. On a document opened directly in SV the editor text is the raw host text, so the relation holds. `table-format.spec.ts:12` and the SV part of `list-normalize.spec.ts` already pass this way.

### Decision

- **Provisional decision (2026-11-01), reversible: SV cases in `exact-authority-other-actions.spec.ts`.** Add an opt-in switch to the shared kit that opens a document directly in SV, through the `vmde.editor.defaultMode` setting, as `sv-line-start-edit.spec.ts` already does, instead of switching modes. Then add the SV cases `list-normalize-sv` and `table-format-sv` on a document opened that way. The switched-mode limit is recorded below and becomes a follow-up task; it is not fixed here. Rejected: changing the SV relation in `bridge/edit-sync.ts` inside this task (out of scope, and it changes every exact SV action), and counting acceptance item 2 as proved without the exact-authority case. Selected by a recorded decision check (probability 0.99).

### Next step: A1c (Light, tests only)

- **Owned files:** `test/vscode-e2e/helpers/shortcut-xtest-kit.ts` and `test/vscode-e2e/exact-authority-other-actions.spec.ts`.
- **Kit change:**
  - `openDocument` gains an optional `{ direct: true }` argument and stores it on the context, so `recover()` reopens the document the same way.
  - With `direct`, `openEditor` sets `vmde.editor.defaultMode` to the context mode before `vscode.openWith` and waits for readiness in that mode, not in IR. It then sets the setting back to `ir`.
  - Without `direct`, behaviour is unchanged for every other spec.
- **Spec change:**
  - Start from the draft kept outside the tree (see the A1b step report) and add `'sv'` to the action loop.
  - Use the `sv` document (CRLF, a raw table and a list), opened with `direct` for SV only.
  - Drivers place the caret, dispatch `selectionchange` so the retained SV caret is set again after the gesture end clears it, and run `vmde.fixListNumbering` or `vmde.formatTable` from the host.
  - Expected results: `5. beta` becomes `4. beta`, and the raw table becomes the formatted table, with CRLF kept.
  - Do not touch `openLinkPopover` or the other cases.
- **Checks:** `npm run typecheck:vscode-e2e` exits 0; `npx biome check` on both files exits 0. Then `node build.mjs` and one wrapper call: `exact-authority-other-actions.spec.ts` (the whole file). Expected: every test passes, including `sv: each action after a typed character…`.
- **Proves:** acceptance item 2.

### Follow-up tasks proposed

1. **SV exact-authority relation after a mode switch.** After an IR or WYSIWYG to SV switch, the SV text is Lute's serialization while the host keeps its raw bytes. Once typing revokes the owned exact text, every exact SV action (table format, list numbering, and the other exact SV actions) declines. The cause is that the host-request relation in `bridge/edit-sync.ts` (`projectRendered` / `provesExact` for SV) is plain equality up to line endings. Scope: replace it with a proof that accepts Lute-normalized SV text against the raw host text (for example the Task 605 bounded alignment, which the SV commands already use), without accepting stale text. Add Vitest cases for edit-sync and a real-VS-Code case that switches IR to SV, types, then formats a table and renumbers a list. Fail closed on any unproven case.
2. **Redo after an outline section move.** In IR, after a webview outline drag or an outline-tree move, one Undo restores the original order, but Redo leaves the host in the original order. `outline-reorder.spec.ts:15` fails at `:108` and `:187` fails at `:276`, on `dev` before and after Tasks 668 and 669. Scope: find where Redo loses the exact-history transition recorded by the outline routes (`nav/outline-move-routes.ts`, the `boot/main.ts` wiring, host handling of the move), make Redo reapply the move exactly once, and keep both specs plus a Vitest case for the history transition.
3. **Auto-wrap apply leaves the host text unchanged.** In real VS Code the auto-wrap firing does not change the host text in the SV iteration of `auto-wrap.spec.ts:31` (at `:603`; the IR and WYSIWYG iterations pass). Task 672 saw the same on the large IR fixture: the firing runs its proof, but the wrapped text never reaches the host, while a manual Rewrap on the same state applies. Scope: measure where the firing declines (`captureAutoWrapTarget` in `boot/main.ts` through `runRewrapCommand` in `rewrap-command.ts`), fix the decline without weakening the Task 606 proof rules, and make `auto-wrap.spec.ts:31` and the Task 672 large-fixture case assert the host change.

Recorded without a follow-up (from the measurement step): `rewrap.spec.ts:116` (already a known failure; it alternates between `:308` and `:423`), `selection-performance.spec.ts:471` (the stall policy applies), `large-document-interaction.spec.ts:416` and `link-popover.spec.ts:241` (each passed once and failed once on the same code paths; they depend on load or run order).

## A1c result (2026-11-01): the SV cases in the exact-authority spec still cannot pass

A direct SV open (opt-in kit switch, `vmde.editor.defaultMode`) did not make the SV cases pass. A probe with temporary debug hooks (removed) showed the host-request relation still failing, now for a different reason: Vditor's Source mode shows an ordered list renumbered in its own text (`4. beta`) while the host keeps the authored `5. beta`, so `normalizeEol(exact) === rendered` is false and the acquisition returns nothing. A document whose list is already consistent also did not apply the table case in the first attempt (cause not measured further). Both attempts fail closed (no write). So the SV relation follow-up (follow-up 1) also covers a Source-mode text that Vditor itself changed. The draft kit change and spec cases are not part of the tree (they are described in Task 675); the tree has no change in `exact-authority-other-actions.spec.ts` or the kit.

Evidence for acceptance item 2: the SV list command applies, undoes, redoes, saves and reopens in `list-normalize.spec.ts` (SV part, passes), and the SV table command in `table-format.spec.ts:12` (passes; one run in a long batch failed at its final reopen step with a hidden editor, and passed alone). The item as worded (a case in `exact-authority-other-actions.spec.ts`) is therefore not met; that gap depends on follow-up 1.

## Closure (2026-11-01)

### Failure triage

| Failure | Measured cause | Class | Action |
|---|---|---|---|
| `table-format.spec.ts:12` | Both SV commands compared the editor text with the exact text as a whole; Vditor's appended newline and Lute's padded tables make that never equal | product defect in scope | fixed (alignment proof); passes (once failed at its last reopen step in a long batch, passed alone) |
| `list-normalize.spec.ts:77` | Same product cause, plus two test defects: untrusted `textContent` + `input` left the owned exact text stale, and synthetic Ctrl+Z/Y no longer undo | product defect in scope + test defects | fixed (host edit for the source, workbench keys for Undo/Redo); passes |
| `ir-click-index.spec.ts:641` | The recorder's copy of the admission predicate lacked `data-vmde-indent` and `data-vmde-indent-root` (Task 649) | test defect | fixed; passes |
| `shortcut-negative.spec.ts:509`, `callout-ir.spec.ts:597` | Chromium specs (`media-src/e2e`), not real VS Code; already known Chromium failures | known failure | recorded; reproduced |
| `outline-reorder.spec.ts:15`, `:187` | Redo after an outline section move does not reapply the move (Undo works) | product defect, other | [Task 676](../676-redo-after-outline-section-move.md) |
| `auto-wrap.spec.ts:31` | SV pass: the firing leaves the host unchanged; same as the Task 672 large-fixture finding; not the SV commands | product defect, other | [Task 677](../677-auto-wrap-apply-leaves-host-text-unchanged.md) |
| `rewrap.spec.ts:116` | Alternates between a WYSIWYG failure at `:308` and `scrollKept: false` at `:423` | known failure (timing) | recorded |
| `selection-performance.spec.ts:471` | `fullGetValueCalls` 2 > 1 on unchanged code | stall policy / load | recorded |
| `large-document-interaction.spec.ts:416` | Passed in one run, failed (`getValueCalls` 1) in another | load-dependent | recorded |
| `link-popover.spec.ts:241` | Passed in one run, failed (first image event `selectionchange`) in another; `:110` passed | order/load-dependent (Task 667 attribution) | recorded |

### Verification actually run

- Vitest: the three lane A files, `block-transform-sv.test.ts` and `test/backend/selection-writes.test.ts`: 77 passed. Full `npm run test:coverage`: 383 files, 8351 tests passed (1 expected failure).
- Gates: `check:brand-identifiers`, `lint:ci`, `typecheck`, `typecheck:vscode-e2e`, `knip`, `jscpd`, `depcruise`, `check:coverage-modules` (9 source modules at 0%, baseline 9) all exit 0. Reporting only: `check:bundle-size` fails on `main.js` (1092 KB against 608 KB) and `check:startup-cost` on the eager module count (407 against 294); both exceed their budgets on unchanged code and are not caused by this task (the change adds one webview test file and edits three modules).
- Real VS Code (wrapper): `table-format.spec.ts`, `list-normalize.spec.ts`, `ir-click-index.spec.ts:641` pass; the IR and WYSIWYG exact-authority matrices (26 and 20 cases) and both stale-host tests pass; the measurement batch for the remaining failures is in the table.

### Decisions

- SV proof mechanism: the Task 605 alignment proof with a region splice (selected by a recorded decision check, probability 1.0).
- Triage policy: fix only a shared SV cause or a test-only defect; record the rest (selected by a recorded decision check, probability 0.86).
- Details toggle and SV Rewrap Document stay out of scope.
- A1b: direct Source open plus a follow-up (selected by a recorded decision check, probability 0.99); the direct open did not remove the blocker (Vditor renumbers lists in Source text), so the exact-authority SV case moved to Task 675 as a whole. The orchestrator closed item 2 as partially met.

### Residuals

- F2: a caret inside table cell padding has no exact image, so Format table declines silently (accepted limit; follow-up candidate: snap to the nearest proven offset in the same cell).
- F5: the optional staleness relation check between the retained editor text and the acquired exact text is not added.
- Follow-ups: Tasks 675, 676 and 677.
