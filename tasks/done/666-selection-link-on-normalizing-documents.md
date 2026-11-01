# Task 666 — Selection-bubble Link on normalizing documents

**Status:** done (2026-11-01). Filed 2026-10-18 at the close of Tasks 606 and 630.
**Origin:** Task 630, Task 604.
**Severity:** medium (estimated).
**Tech stack:** `media-src/src/editing/selection-link-actions.ts`, `selection-source-proof.ts`, real VS Code with XTEST.
**Depends on:** Task 630, Task 604.

## Problem

On a document whose IR or WYSIWYG DOM does not serialize back to the host bytes (a normalizing document), the selection-bubble Link does nothing. `sourcePlan` in `selection-link-actions.ts` calls `captureRewrapSourceRange(window, owner.range, { authoritativeMarkdown: before })`, which returns null unless the DOM-serialized markdown equals the acquired exact text. The action declines silently and writes nothing (fails closed). Task 630 proves the decline in the real-VS-Code cell `bubble-link-normalizing`.

## Proposed work

Map the live selection onto the acquired exact text with Task 604's proof (`proveSelectionSource`), as Details, Insert Picture, Insert ID and emoji already do. Proof-only: no marker fallback.

Scanner note: `scanMovableBlocks` (`src/shared/block-move`) classifies `* * *` as a list item, so link actions decline on documents that contain it. Fix the scanner or record the limit.

## Acceptance

- [x] A paragraph selection on a normalizing document in IR and WYSIWYG gets the link markup, and only that span changes (real VS Code `bubble-link-normalizing` apply case, both modes; Vitest capture and action cases).
- [x] An outside edit the editor has not shown is never overwritten: with a stale editor the Link is refused (Vitest: the capture declines when the owned exact text is not the acquired text); once the editor shows the outside edit the Link changes only its own span (real VS Code `stale-host-bubble-link`, both modes: `webviewStale: false`, outcome `rebased`, outside edit kept, 4 bytes of link markup at the selected word). The original wording, "A stale host is refused", could not be observed in real VS Code because the editor resynced before the click.
- [x] `bubble-link-plain` stays green. The `bubble-link-normalizing` decline case became an apply case.
- [x] Vitest case: normalizing document, paragraph selection applies.
- Task 671 (selection link step of Task 606) depends on this task.
- [x] Focused real-VS-Code spec written and run; the quality stages were run individually (below). The aggregate `npm run quality` and dependency audits were not run (waived for this queue).

## Part 1 handoff (2026-11-01)

### Problem and measured cause

- `sourcePlan` (`media-src/src/editing/selection-link-actions.ts` ~:137-162) maps the live selection with `captureRewrapSourceRange(window, owner.range, { authoritativeMarkdown: before })` and accepts it only when `mapped.markdown === before`. On a normalizing body the marker capture serializes the rendering, so `mapped.markdown` is never the exact text. The only other route is the unique ATX heading fallback. A paragraph selection therefore declines. The decline happens before any DOM or host change.
- `captureRewrapSourceRange` (`media-src/src/editing/rewrap-command.ts` ~:408-447) already calls `proveSelectionSource`, but only when the document starts with front matter and the body bytes equal the rendering (Task 670 kept the general normalizing body deferred).
- Scratch probe (real Lute, IR and WYSIWYG, `tmp/666/probe/proof.test.ts`, untracked): `proveSelectionSource` on the Task 630 fixture `exact-authority-actions.md` proves the `bubbleword` selection, and the exact slice equals the selected text. The proof needs no new pairing work for this fixture.
- After `acquireExactAuthority({ publish: true })` resolves, edit-sync sets the owned base to the host content (`receiveExactAuthority`, `media-src/src/bridge/edit-sync.ts` ~:1302-1330). `snapshotPair().exact` then equals `owner.exact`, which the proof requires.
- Scanner defect, measured: `blockAt` in `src/shared/block-move.ts` (~:383-385) tests `LIST` before `THEMATIC`, so `* * *` and `- - -` scan as list items (`_ _ _` never matches `LIST`). With such a line anywhere in a normalizing document the proof returns `unprovable` for every selection, also for far paragraphs (probe: 4 documents x 2 modes). This affects every proof-only action on such documents, not only Link. `***` is proven. A scratch copy that tests `THEMATIC` first proves all 12 probe cases with exact slices. The existing consumer suites (backend `block-move`, `block-handle`, `source-block-index`, all `block-transform*`, `block-action-client`, `link-popover`, `rewrap-non-round-trip`, `selection-source-proof`, `find-map`, `editor-session*`) pass against that copy: 14 files, 801 tests.

### Record correction

The record says Details, Insert Picture, Insert ID and emoji "already" use Task 604's proof. They do not: `details-toggle.ts` ~:273, `id-insertion.ts` ~:203 and `emoji-insertion.ts` ~:265 call the marker capture `captureRewrapSourceRange` against the rendered text and then map rendered offsets to exact offsets with their own mapping. Only Rewrap, heading shift and Turn Into use the proof. This task changes only selection Link; the other callers keep their current behavior.

### Scope

In scope: selection-bubble Link and Wiki Link (both go through `sourcePlan`) in IR and WYSIWYG on a normalizing document; the scanner order fix. Out of scope: Details, Insert ID, emoji, link popover, math and subscript capture (unchanged); SV (unchanged); Task 671's Details and callout proof-path tests.

### Shared interfaces and changes

- `CaptureRewrapSourceSelectionOptions` (`rewrap-command.ts`) gains one optional field `proveNormalizingBody?: boolean`. Default callers are unchanged.
- `src/shared/block-move.ts` `blockAt`: `THEMATIC` is tested before `LIST`. No signature change. Consumers: host `src/session/editor-session.ts`, webview `block-handle.ts`, `source-block-index.ts`, `block-transform.ts`, `block-action-client.ts`, `link-popover.ts`.
- `test/vscode-e2e/exact-authority-other-actions.spec.ts` (shared with Tasks 667, 669, 671 and 672): two small edits, listed in the step plan.

### Source-fidelity invariants

1. On a normalizing body (acquired exact text differs from the live rendering) selection Link maps offsets only through `proveSelectionSource`. The marker capture never runs there and inserts no live markers.
2. The proof runs only when `snapshotPair().exact` equals the acquired text. Otherwise the capture returns `null`.
3. A non-round-trip proof must have both endpoints in one unit (`proof.start.unit === proof.end.unit`). `planSelectedLink` still requires the exact slice to equal the selected text and rejects line breaks.
4. A round-trip document keeps today's path (marker capture plus heading fallback), so `bubble-link-plain` cannot change.
5. The existing guards stay: rendered-text and projection check before the plan, the post-insertion projection check, guarded `postExact` with `before` and rollback.

### Intended solution

`captureRewrapSourceRange`, when `options.proveNormalizingBody` is set, the mode is IR or WYSIWYG and a source is bound: read `pair = boundSource.snapshotPair()`. If the authoritative text differs from `pair.rendered` (normalizing), return the proven range when `pair.exact === authoritative`, the proof is `proven` and (round-trip or single unit); return `null` in every other case. When the authoritative text equals the rendering, fall through to the existing code. Extract the proof-to-`SourceSelection` conversion into one helper shared with the front matter branch (no duplicated block). `sourcePlan` passes `proveNormalizingBody: true`. `blockAt` tests `THEMATIC` before `LIST`.

### Provisional decisions

- **Provisional decision (2026-11-01), reversible — scanner order.** Fix `blockAt` so a thematic break wins over a list item (CommonMark precedence), with backend scanner tests and a real-Lute proof case. Evidence: measured unprovable documents with `* * *`, all probe cases proven with the reorder, 801 consumer tests pass against the reordered copy. Selected by a recorded decision check (probability 0.99 against 0.01 for recording the limit).
- **Provisional decision (2026-11-01), reversible — proof mechanism and public name.** An opt-in option `proveNormalizingBody?: boolean` on `captureRewrapSourceRange`, passed only by selection Link; proof-only on a normalizing body, no marker fallback, single unit for a non-round-trip proof. No storage format or numbering is involved; compatibility: optional field, default behavior unchanged. Selected by a recorded decision check (probability 0.94 against 0.05 for a new export and 0 for changing every caller).
- **Provisional decision (2026-11-01), reversible — stale-host proof.** Parameterize `staleHostCell` by a small driver and add a `stale-host-bubble-link` cell to the existing per-mode stale-host test, each cell on its own document; plus Vitest guards. Selected by a recorded decision check (probability 0.96 against 0.01 for Vitest only and 0 for a new spec file).

### Acceptance to test map

| Acceptance item | Layer | File | Test title |
| --- | --- | --- | --- |
| 1. Paragraph selection on a normalizing document gets the link markup in IR and WYSIWYG; only that span changes | Real VS Code | `test/vscode-e2e/exact-authority-other-actions.spec.ts` | `${mode}: each action after a typed character changes only its span, Undo restores the typed state and Save writes the result`, cell `bubble-link-normalizing` (now an apply cell: span check, exact result, Save, Undo, Redo) |
| 1. (unit) | Vitest | `media-src/src/editing/rewrap-non-round-trip.test.ts` | `%s: Task 666 selection Link capture proves a paragraph on a normalizing body and plans only that span` |
| 2. A stale host is refused | Real VS Code | same spec | `${mode}: an outside edit the webview never saw is not overwritten by a following action`, new cell `stale-host-bubble-link` (expected outcome `refused`) |
| 2. (unit) | Vitest | `rewrap-non-round-trip.test.ts` | `%s: Task 666 selection Link capture declines when the owned exact text is not the acquired text` |
| 3. `bubble-link-plain` stays green; `bubble-link-normalizing` becomes an apply cell | Real VS Code | same spec | same actions test, cells `bubble-link-plain` and `bubble-link-normalizing` |
| 4. Vitest: normalizing document, paragraph selection applies | Vitest | `media-src/src/editing/selection-link-actions.test.ts` | `passes the proof-only normalizing option to the range capture and applies on a normalizing document` (plus the capture-level case above) |
| 5. Focused real-VS-Code spec written and run; quality stages pass | Real VS Code, gates | wrapper run of the spec above; individual quality stages (aggregate `npm run quality` and audits not run in this queue) | — |

### Edge cases and cheapest layer

| Edge case | Layer | Test title |
| --- | --- | --- |
| Selection across two paragraphs on a normalizing body declines, no live markers inserted (DOM unchanged) | Vitest (real Lute) | `%s: Task 666 selection Link capture declines an unprovable selection on a normalizing body without the marker fallback` |
| Front matter plus a normalizing body is proven with the option | Vitest (real Lute) | covered by a prefix loop inside the first capture case |
| Default callers still decline on a normalizing body | Vitest (existing) | `%s: front matter does not enable legacy range capture for an already normalizing body` (unchanged, must stay green) |
| `* * *` / `- - -` scan as one thematic block; `- * * *` stays a list item | Vitest (backend) | `test/backend/block-move.test.ts`: `Task 666: a spaced thematic break scans as a thematic block, not a list item` and `Task 666: a list item whose text looks like a thematic break stays a list item` |
| A normalizing document with `* * *` is provable | Vitest (real Lute) | `%s: Task 666 a spaced thematic break does not make a normalizing document unprovable` |
| Indented ` * * *` (1-3 spaces) still declines through the existing indented-line guard | Recorded limit | none (fails closed) |
| Wiki Link uses the same capture | Vitest (existing mocked harness runs `wiki`) | covered by the action-level case |
| SV mode unchanged | Vitest (existing) | `keeps source-mode front matter capture on the source mapping path` |

### Part 2 step plan

**P2-S1 (RED, tests only).** Owned files: `test/backend/block-move.test.ts`, `media-src/src/editing/rewrap-non-round-trip.test.ts`, `media-src/src/editing/selection-link-actions.test.ts`, `test/vscode-e2e/exact-authority-other-actions.spec.ts`.
- Add the Vitest cases above. In the spec: remove `declines: true` from `bubble-link-normalizing`, set `expected` to `replaceToken(reference, 'bubbleword', '[bubbleword]()')`, update its comment and the header comment (lines 11-12); keep the `declines` support itself. Parameterize `staleHostCell` with a driver `{ id, select, click, expected }` (Details driver unchanged) and loop the stale-host test over the Details and bubble Link drivers, one document per cell.
- Checks: `npx vitest run --config test/vitest.config.mts test/backend/block-move.test.ts media-src/src/editing/rewrap-non-round-trip.test.ts media-src/src/editing/selection-link-actions.test.ts` exits 1. Expected failures: the proven-capture case, the `* * *` proof case, the thematic scanner case and the option-passing case. The stale and cross-unit guards and the `- * * *` case pass at RED (guards). `npm run typecheck:vscode-e2e` exits 0. `npm run typecheck` may report the unknown option field in the test until P2-S2; record it.

**P2-S2 (GREEN).** Owned files: `src/shared/block-move.ts`, `media-src/src/editing/rewrap-command.ts`, `media-src/src/editing/selection-link-actions.ts`.
- Implement the intended solution. Comments follow `.agents/rules/ts.md`.
- Checks: the same Vitest command exits 0. Consumer regression: `npx vitest run --config test/vitest.config.mts test/backend/block-move.test.ts test/backend/editor-session media-src/src/nav/block-handle.test.ts media-src/src/nav/source-block-index.test.ts media-src/src/editing/block-transform media-src/src/editing/block-action-client.test.ts media-src/src/editing/link-popover.test.ts media-src/src/editing/selection-source-proof.test.ts media-src/src/editing/find-map.test.ts` exits 0. `timeout 900 node build.mjs` exits 0; `npm run typecheck` and `npm run lint:ci` exit 0. Real VS Code, through the local wrapper from the worktree: `../vscode-run.sh 666 env -u ELECTRON_RUN_AS_NODE xvfb-run -a sh -c 'openbox & OB=$!; VMDE_XTEST=1 npm --prefix test/vscode-e2e test -- exact-authority-other-actions.spec.ts --workers=1 --retries=0; R=$?; kill $OB; exit $R'`; expected 4/4 tests pass, `bubble-link-normalizing` and `bubble-link-plain` apply in both modes, both stale cells `refused`.

**P2-S3 (closure).** No product files. Run `npm run lint:ci`, `npm run typecheck`, `npm run typecheck:vscode-e2e`, `npm run knip`, `npm run jscpd`, `npm run depcruise`, `npm run check:brand-identifiers`, `npx vitest run --coverage --config test/vitest.config.mts --testTimeout=60000 --maxWorkers=2 --coverage.reportOnFailure`, `npm run check:coverage-modules`, `git diff --check`. Update this record (status, acceptance boxes, verification actually run) and write the completion report.

### Baseline (unchanged code)

- `npx vitest run --config test/vitest.config.mts media-src/src/editing/rewrap-non-round-trip.test.ts media-src/src/editing/selection-link-actions.test.ts`: exit 0, 2 files, 88 tests pass.
- Real VS Code not run in Part 1; Task 630 recorded the spec at 4/4 with `bubble-link-normalizing` as a decline cell.

### Part 1 amendment (2026-11-01): stale-host bubble Link case

- **Finding.** The GREEN run of `stale-host-bubble-link` applied the link on top of the outside edit (outside edit kept, only the selected span changed). The Link always acquires the host text first, and edit-sync adopts it only when the host text projects to the live rendering. A real-Lute check shows a leading HTML comment survives the projection, so the Link could only apply because the webview already showed the outside edit: it had resynced before the click, although host `update` messages were hidden. The resync channel is not identified. The existing Details stale case may be vacuous for the same reason (its selection is lost when the editor re-renders); that is a pre-existing Task 630 test and stays out of scope.
- **Provisional decision (2026-11-01), reversible — stale-host assertion.** Classify instead of assuming staleness. Selected by a recorded decision check (probability 0.83 against 0.14 for accepting either outcome without a probe and 0.01 for finding a trigger that keeps the editor stale).
- **Exact test change (next step, spec only, `test/vscode-e2e/exact-authority-other-actions.spec.ts`).**
  1. Remove `refuseOnly` from `StaleDriver` and from the bubble driver; replace it with `probeStale?: boolean` (set on the bubble driver only).
  2. In `staleHostCell`, for a driver with `probeStale`, run `evalFrame` right before `driver.click`'s final Link click to read whether `window.vditor.getValue()` contains `<!-- external -->`; record `webviewStale` (true when it does not contain it). Do this inside the bubble driver's `click` after `showBubbleLink` and before `clickBubbleLink`, returning the flag.
  3. Assertions for the bubble driver: `clicked` must be true (existing); the outside edit must survive and only the action span may change (existing checks); when `webviewStale` is true, `after === external` (refused); when false, `rest === intended` (rebased onto the outside edit, own span only). Record `webviewStale` and `outcome` in the result.
  4. Details driver unchanged.
- **Acceptance item 2 wording (amended).** "An outside edit the editor has not shown is never overwritten: with a stale editor the Link is refused (Vitest: the capture declines when the owned exact text is not the acquired text); once the editor shows the outside edit the Link changes only its own span (real VS Code)."

### Repair R1 (2026-11-01)

- A proof-only refusal in `captureRewrapSourceRange` is now final: it no longer falls through to the front matter branch or the marker and table captures. The test that pins it spies on the mode serializer (it failed before the fix: the serializer was called once) and also covers a table-cell-to-paragraph selection. Both multi-unit cases first assert that the proof is `proven` across two units, so only the single-unit rule refuses.
- The stale Vitest case now uses an owned exact text with a padded table (same rendering, so the proof would succeed against it); it fails when the exact-text check is removed and passes with it.
- Scanner consumer test added: `* a`, `* * *`, `* b` scans as list item, thematic, list item, and deleting the thematic block leaves the two list items.
- Real VS Code stale cases now probe the editor right before the Link click. Result in IR and WYSIWYG: `webviewStale` is false, so the editor had already resynced with the outside edit (the bubble case therefore proves "outside edit kept, only the selected span changed"; refusal on a truly stale editor is proven by the Vitest cases above).
- Residual: `captureNormalizingBodyRange` reads the source pair once and the proof reads it again, so the Link path serializes twice on a normalizing document; passing the pair through would change the proof's signature, so it is left as is. Round-trip documents and every other caller are unaffected (the option is off).

### Closure (2026-11-01)

Verification actually run, from the task worktree:

| Command | Exit | Result |
| --- | --- | --- |
| Real VS Code, `exact-authority-other-actions.spec.ts`, one worker, zero retries (after the final repair) | 0 | 4 passed: IR 20 cells and WYSIWYG 14 cells without violations, both stale tests pass |
| Consumer Vitest set (scanner, block handles, planners, source index, block-transform, block-action, link popover, selection proof, find map, non-round-trip Rewrap, selection Link, session) | 0 | 15 files, 677 passed |
| `npm run check:brand-identifiers`, `lint:ci`, `typecheck`, `typecheck:vscode-e2e`, `knip`, `jscpd` (6.02% duplicated lines), `depcruise`, `git diff --check` | 0 | all pass |
| `npx vitest run --coverage --config test/vitest.config.mts --testTimeout=60000 --maxWorkers=2 --coverage.reportOnFailure` | 0 | 381 files, 8266 passed, 1 expected failure; 81.91% statements, 75.03% branches, 84.69% functions, 84.30% lines |
| `npm run check:coverage-modules` | 0 | ratchet OK, 9 zero-coverage modules (baseline 9) |
| `npm run check:bundle-size` | 1 | reporting only: `main.js` 1090 KB against a 608 KB budget. The change adds no module and a few dozen lines, so it does not explain the gap; not re-measured on the base |
| `npm run check:startup-cost` | 1 | reporting only: eager modules 406 against a budget of 294 (known baseline excess); no module added by this task |

Provisional decisions (all reversible): scanner order fix (probability 0.99); opt-in `proveNormalizingBody` option, selection Link only (0.94); stale-host case in the shared spec by a driver (0.96); stale-host assertion by probing the editor before the click (0.83). Details are in the handoff and amendment above.

Residuals:
- The Link path reads the source pair twice on a normalizing document (`captureNormalizingBodyRange` and then the proof); passing it through would change the proof's signature. Round-trip documents and every other caller are unaffected.
- The Task 630 Details stale case may also run against a resynced editor (pre-existing test, not changed).
- Indented ` * * *` (1-3 spaces) still declines (fails closed).
- The shape `* a`, `* * *`, `* b` (list item, thematic break, list item) is covered by a scanner consumer test.
- No real-VS-Code Move Block case with `* * *` exists; consumer suites pass.
