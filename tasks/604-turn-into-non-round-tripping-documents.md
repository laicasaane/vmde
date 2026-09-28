# Task 604 — Turn Into on documents whose serialization does not round-trip

**Status:** planned (2026-09-28). The Project Owner requested this record. Implementation has not started. The owner decisions below are open.
**Origin:** pre-existing limitation found during the Task 579 acceptance (CP2 Steps N3 and N4, 2026-09-28). Task 579 did not introduce it. The Task 579 N4 decision assigned it to a separate task.
**Recommended implementer effort:** high. The work touches the exact-vs-rendered source authority boundary.
**Tech stack:** TypeScript webview (`media-src/src/editing/block-transform-command.ts`, `editing/rewrap-command.ts`, `nav/source-block-index.ts`, `nav/block-handle.ts`), Vitest, Chromium Playwright, real VS Code with XTEST.
**Dependencies:**

- **[Task 196](done/196-find-and-replace.md)** (complete) owns the exact-vs-rendered source authority for Find and confirmed root cause 5. Reuse its approach; do not weaken its contract.
- **[Task 579](579-split-find-and-find-replace.md)** (in progress) owns Find focus and the R1b deferred Turn Into capture. Run this task after Task 579 closes. Both tasks edit `block-transform-command.ts` and `test/vscode-e2e/block-transform.spec.ts`.
- **Tasks 573/574/578** own the shared per-revision source block index and its performance gates. Any new use of the index must keep their gates.

**Evidence:** `tmp/task579-checks/vscode/n3/` in the main checkout, if still present (`deferred-capture.test.ts`, `deferred-capture-result.json`, `deferred-capture.log`). The result file contains only lengths and booleans, no fixture content. Real IR Lute, canonical fixture `test/vscode-e2e/fixtures/large-observable-models-synthetic.md`.

## Problem

Turn Into finds no target when the document's Vditor serialization does not equal its exact source. The QuickPick never opens. This happens from a normal editor selection and from Find. The Task 579 R1b deferred capture restores the Find range correctly, so Find is not the cause.

Route:

1. `vmde.turnInto` (`src/app/commands.ts`) posts `request-block-transform-options` to the active panel.
2. The webview router calls `requestBlockTransformOptions`. It posts `block-transform-options` only for a non-null result. The host opens the QuickPick only on that reply.
3. `requestBlockTransformOptions` calls `capture()` for a live selection, or `captureDeferred()` for the R1b retained range. `captureDeferred()` restores the range and then calls the same `capture()`.
4. `capture()` (`block-transform-command.ts`, `function capture`):
   - `exact = deps.snapshotExactMarkdown()`;
   - `selection = captureRewrapSourceSelection(win, { authoritativeMarkdown: exact })`;
   - returns `null` when `!selection || selection.markdown !== exact`.
5. `captureRewrapSourceRange` (`rewrap-command.ts`) maps the DOM range through `sourceSelectionFromDom`, which serializes the whole editor. With the default `requireExactMarkdown`, it also returns `null` unless `mapped.markdown === authoritative`.

Both equality checks compare a whole-document Vditor serialization with the whole exact source. On any document that Vditor normalizes anywhere (for example GFM table padding), both checks fail. The selection's own block does not matter.

Measured on the canonical large fixture (Task 579 N3, real IR Lute):

| Field | Value |
| --- | --- |
| `exactLength` | 174,517 |
| `capturedLength` | 181,855 |
| `capturedEqualsExact` | `false` |
| `capturedEqualsRendered` | `true` |
| `strictMappingReturned` | `false` |
| `permissiveMappingReturned` | `true` |
| `captureWasDeferred` / `restoredMatchesToken` | `true` / `true` |
| `snapshotCalls` | 1 |
| `optionsReturned` | `false` |

Task 196 measured the same divergence in every mode: `getValue()` is 181,855 (IR), 181,843 (WYSIWYG) or 181,846 (SV) characters against 174,517 exact. It first differs at offset 66–74, in a table.

The Task 579 N4 real-VS-Code case `Task 579 non-round-tripping paragraph declines Turn Into equally from Find and editor selection` (`test/vscode-e2e/block-transform.spec.ts`) currently asserts this decline as known behavior: no QuickPick and unchanged host bytes, from Find and from an editor selection.

## Affected modes

- **IR:** measured (N3 unit and N4 real VS Code).
- **WYSIWYG:** expected, same `capture()` path; Task 196 measured the same whole-document divergence. Measure before the fix.
- **SV:** expected, same `capture()` path; Task 196 measured 181,846 serialized characters after an IR→SV switch. The SV apply path (`replaceSvMarkdownRange(editor, bookmark.exact, …)`) also assumes that SV text and exact source correspond. Measure capture and apply before choosing the SV design.
- **Block handle Turn Into:** uses a different entry, `requestBlockTransformOptionsAtSource`, with a `resolveBlockHandleUnits(editor, exact, rendered, projection)` proof. Its behavior on this fixture is not measured. Measure it in Checkpoint 1; if it works, it is the model for the fix.

## Source-fidelity constraints

- Never write rendered bytes as exact. `getValue()` output must never become `bookmark.exact`, the transform input, the undo history's exact state or the `postExact` payload.
- Keep the Task 196 exact-vs-rendered authority: exact source from `EditSync` is the only authority for offsets and edits. A rendered offset maps to an exact offset only through a proof, never an approximation. An unprovable selection declines; it does not guess.
- Do not only drop the equality checks. Without a proof, the mapped offsets are rendered-document offsets, and `describeBlockAt(exact, anchor, focus)` would target the wrong block.
- The transform must change only the target block's exact bytes. Every byte outside that block, including the normalized table regions, stays identical in host text, disk and save/reopen.
- Keep the existing guards: owner/revision, mode, composition, `batchOwnershipIsLive`, `revalidate` before apply, one undo step (`checkpointEditorUndo`, `recordBlockHistory` with exact before/after), rollback to exact on failure.
- Keep the Task 573/574/578 performance gates. Capture on the large fixture must not add whole-document serializations beyond the current count.

## Candidate approaches

1. **Block-scoped exact mapping through the shared source block index (recommended to evaluate first).** Do what Task 196 does for Find:
   - read the per-revision index entry (`index.peek() ?? index.read()`), keyed by root, owner, mode, revision and DOM revision;
   - find the unit whose element contains the selection's anchor and focus (binary search on `units[].start`; the smallest containing unit wins);
   - serialize only that unit and align `exact.slice(unit.start, unit.end)` to it with the bounded `find-align.ts` proof;
   - map the selection's rendered offsets inside equal runs to exact offsets; decline if any endpoint falls outside an equal run.

   Pass the proven exact offsets to `describeBlockAt(exact, …)`. The whole-document equality is replaced by a block-scoped proof, so normalization in other blocks no longer matters.
2. **Reuse the block handle proof.** Route the editor-selection path through `requestBlockTransformOptionsAtSource` with the unit from `resolveBlockHandleUnits`. This reuses an existing proof, but it targets a whole unit only. It covers a caret or a selection inside one block, not a multi-block selection.
3. **Find-specific span (the Task 579 N3 alternative).** Carry Find's already source-proven exact match span with its deferred Range and revalidate it at request time. This fixes only the Find route; the editor-selection route stays broken. Not recommended as the whole fix.
4. **Whole-document alignment.** Align the whole rendered serialization to exact once per revision. Simple, but it costs a whole-document diff on large documents and conflicts with the performance gates. Not recommended.

Multi-block selections (Task 298 multi-block Turn Into) need both endpoints proven. Approach 1 proves each endpoint in its own unit.

## Owner decisions needed

1. Approach: block-scoped index mapping (1, recommended), block handle proof (2), or another?
2. Scope of this task: IR and WYSIWYG only, with SV as a follow-up after measurement, or all three modes?
3. Multi-block selections on non-round-tripping documents: support them (both endpoints proven), or decline them in this task?
4. Should the same block-scoped capture also replace Rewrap's whole-document equality (`captureRewrapSourceRange`), which has the same limitation? Recommended: record Rewrap as a follow-up task, not in this scope.

## Implementation checklist

- [ ] Checkpoint 1 — measure: on the large fixture, record Turn Into capture per mode (IR/WYSIWYG/SV) from an editor selection, from Find and from the block handle. Record the counters (`getValue`, root/fragment Lute calls, index builds, `blockTransformCaptureCalls`). Add the red tests below.
- [ ] Checkpoint 2 — implement the approved capture proof in `block-transform-command.ts`. Keep `bookmark.exact` from `snapshotExactMarkdown()` only.
- [ ] Checkpoint 3 — apply and history: confirm exact-only block changes, one Undo and exact save in every approved mode.
- [ ] Checkpoint 4 — replace the Task 579 N4 decline assertion with the positive large-fixture cases. Keep the small round-tripping case.

## Tests

- **Vitest** (`block-transform-command.test.ts`, real IR Lute where needed, following `tmp/task579-checks/vscode/n3/deferred-capture.test.ts`):
  - a document with a normalized table before the target paragraph: capture returns options whose exact span is the paragraph's exact span;
  - the same from the R1b deferred range;
  - a selection inside a normalized region that the proof cannot map declines (returns `null`), with no snapshot write;
  - multi-block selection per decision 3;
  - `bookmark.exact` equals `snapshotExactMarkdown()` and never equals `getValue()` on this document;
  - WYSIWYG and SV cases per decision 2.
- **Chromium** (`media-src/e2e`): a normalizing fixture; Turn Into to Heading 2 from a selection; the harness `__exact()` equals `exact.slice(0,s) + transformed + exact.slice(e)`.
- **Real VS Code** (XTEST, on `test/vscode-e2e/fixtures/large-observable-models-synthetic.md`; `node build.mjs` first, then `xvfb-run`):
  - Turn Into from a normal editor selection on a paragraph after the first table: the QuickPick opens, Heading 2 applies to that paragraph only;
  - Turn Into from Find (query, F3 to a later match, Find input focus, native Turn Into): same result;
  - for each: host text and saved disk bytes equal the exact-byte plan, all bytes outside the block (including tables) unchanged;
  - one OS Undo restores the exact baseline, and a save after Undo equals the original file bytes;
  - modes per decision 2;
  - the large-fixture cheap-phase counters stay within the Task 573/574/578 gates.

## Acceptance

- [ ] Turn Into opens the QuickPick on the large fixture from an editor selection and from Find, in every approved mode.
- [ ] The transform changes only the target block's exact bytes; host text, disk and save/reopen match the exact-byte plan.
- [ ] One Undo restores the exact baseline, and its save is byte-identical to the original file.
- [ ] No path writes rendered bytes as exact.
- [ ] Unprovable selections decline without a partial or approximate edit.
- [ ] The Task 579 N4 decline case is replaced by the positive cases.
- [ ] Performance gates of Tasks 573/574/578 still pass. `npm run quality` passes or its residuals are recorded.
