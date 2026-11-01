# Task 680 — Selection Link reads the source pair twice on a normalizing document

**Status:** done (2026-11-01).
**Origin:** Task 666 (residual).
**Severity:** low (estimated; performance only, no wrong result).
**Tech stack:** `media-src/src/editing/rewrap-command.ts` (`captureNormalizingBodyRange`), `media-src/src/editing/selection-source-proof.ts` (`proveSelectionSource`), `media-src/src/editing/selection-link-actions.ts`.
**Depends on:** none.

## Problem

On a normalizing document the selection Link path takes the source pair twice for one gesture: `captureNormalizingBodyRange` calls `source.snapshotPair()` (`rewrap-command.ts:429`) to compare the authoritative text, and then calls `proveSelectionSource(source, editor, range)` (`rewrap-command.ts:432`), which calls `source.snapshotPair()` again (`selection-source-proof.ts:206`). Each pair read serializes the document, so a large normalizing document pays the cost twice. Task 666 recorded this and left it because passing the pair through changes the proof's signature. Round-trip documents and other callers (the option is off) are unaffected. The cost is not measured yet.

## Proposed work

Measure the extra serialization on a large normalizing fixture first. If it is material, let `proveSelectionSource` accept the already-read pair (an optional argument, other callers unchanged) and pass it from `captureNormalizingBodyRange`, keeping every Task 666 refusal rule (owned exact text must equal the acquired text; no marker fallback).

## Acceptance

- [x] The Link path on a normalizing document reads the pair once (counted `snapshotPair` calls in a Vitest case).
- [x] The measured saving is recorded; it is not negligible (about 87 to 270 ms per gesture in WYSIWYG on 45 to 175 KB normalizing documents), so the change was made.
- [x] Every Task 666 Vitest guard still passes unchanged (stale exact text declines; cross-unit proof declines).
- [x] Focused real-VS-Code spec run (the existing `exact-authority-other-actions.spec.ts`, no new spec by decision; see below); the quality stages were run individually and exit 0 (the dependency audit stage and the aggregate `npm run quality` were not run, waived for this queue).

## Part 1 handoff (2026-11-01)

Measured on `dev` `03a20622`. Scratch probes only (untracked); no product code or tracked test changed.

### Problem and root cause (measured)

`captureRewrapSourceRange` with `proveNormalizingBody` (selection Link, `selection-link-actions.ts:141-144`, and Details toggle, `details-toggle.ts:144`, which also sets `proofMayCrossUnits`) calls `captureNormalizingBodyRange`. That function reads `boundSource.snapshotPair()` (`rewrap-command.ts:429`) to compare the rendering and the owned exact text with the acquired text, then calls `proveSelectionSource(source, editor, range)` (`rewrap-command.ts:432`), which reads `source.snapshotPair()` again (`selection-source-proof.ts:206`). Both reads run in the same synchronous turn with no DOM change between them, so the second read returns the same pair.

A scratch Vitest probe (real Lute, the `rewrap-non-round-trip.test.ts` mount, a counted bound source) confirms two bound-source `snapshotPair` calls for one proven paragraph selection on the `NORMALIZING` fixture, in IR and in WYSIWYG.

In production `snapshotPair` is edit-sync's `serializeForHost`: WYSIWYG runs a full `vditor.getValue()` (Lute `VditorDOM2Md`); IR runs the incremental block cache when it is admitted for the document, otherwise a full `getValue()`. Chromium probe on the link harness (median of 3 runs, normalizing documents built from `test/vscode-e2e/fixtures/large-observable-models-synthetic.md`):

| Document | WYSIWYG `getValue()` | IR `getValue()` | IR incremental cache, unchanged DOM |
| --- | --- | --- | --- |
| 1,029 characters (40 blocks) | 12 ms | 18 ms | 0.1 ms |
| 45,167 characters (77 blocks) | 87 ms | 110 ms | 0.5 ms |
| 174,556 characters (267 blocks) | 271.5 ms | 168 ms | 3.3 ms |

The redundant read therefore costs about 87 ms (45 KB) to 270 ms (175 KB) per Link or Details gesture on a normalizing WYSIWYG document, and the same order in IR when the incremental cache is not admitted; with the IR cache it is a few milliseconds. This is not negligible, so the task proceeds with one Light step instead of closing.

Unlike Task 672 (two serializations of different inputs, both needed by a fidelity proof), both reads here return the same snapshot, so reusing the first pair weakens no proof: `proveSelectionSource` still requires a non-null exact text, the same index key, `pair.exact === entry.exact` and `pair.rendered === entry.rendered`, and `captureNormalizingBodyRange` still requires `pair.exact === authoritative`.

- Tier: Light (performance only, one call path).
- Shared interface: `proveSelectionSource` gains one optional trailing parameter. Other production callers (`block-transform-command.ts:366`, `rewrap-command.ts:470` and `:579`) and every existing test call stay unchanged.
- Source-fidelity invariants kept: every Task 666 refusal rule (owned exact text must equal the acquired text; no marker fallback; a non-round-trip proof across units declines unless the caller allows it); the proof still validates the supplied pair against the index entry and key.
- Overlap: Task 677 changes `rewrap-command.test.ts`, not `rewrap-command.ts`; this task adds no case to `rewrap-command.test.ts`.

### Intended solution

- `selection-source-proof.ts`: `proveSelectionSource(source, root, range, pair?)`, where `pair?: { exact: string | null; rendered: string }`. When `pair` is given it is used instead of `source.snapshotPair()`; every later check is unchanged. The doc comment states that the caller must have read the pair from the same source in the same synchronous turn.
- `rewrap-command.ts` `captureNormalizingBodyRange`: pass its `pair` as the fourth argument. Nothing else changes.

### Provisional decisions

- **Provisional decision (2026-11-01), reversible — measured cost.** Fix the double read instead of closing: the redundant read costs about 87 to 270 ms per gesture on 45 to 175 KB normalizing WYSIWYG documents, and removing it weakens no proof. Selected by a recorded decision check (probability 1.00 against 0.00 for closing as not worth changing).
- **Provisional decision (2026-11-01), reversible — public name and signature.** An optional fourth positional parameter `pair?: { exact: string | null; rendered: string }` on `proveSelectionSource`, passed only by `captureNormalizingBodyRange`. Compatibility: optional, default behavior unchanged for every other caller; no storage format or numbering is involved. Selected by a recorded decision check (probability 0.99 against 0.01 for an options object and 0.00 for a source adapter with no signature change).
- **Provisional decision (2026-11-01), reversible — real-VS-Code verification.** Write no new spec (behavior is unchanged and the pair count is not observable in production without a test-only hook); run the existing `test/vscode-e2e/exact-authority-other-actions.spec.ts`, whose cells `bubble-link-normalizing` (apply) and `stale-host-bubble-link` (refused) drive this path in IR and WYSIWYG. Selected by a recorded decision check (probability 1.00 against 0.00 for a new counting spec and 0.00 for no real-VS-Code run).

### Acceptance to test map

| Acceptance item | Layer | File | Test title |
| --- | --- | --- | --- |
| 1. The Link path on a normalizing document reads the pair once | Vitest (real Lute) | `media-src/src/editing/rewrap-non-round-trip.test.ts` | `%s: Task 680 selection Link capture on a normalizing body reads the source pair once` (new; IR and WYSIWYG) |
| 1. (supplied pair contract) | Vitest (real Lute) | `media-src/src/editing/selection-source-proof.test.ts` | `Task 680: a supplied pair replaces the snapshot read and must still match the index entry` (new) |
| 2. Measured saving recorded | Record | this handoff | measurement table above |
| 3. Task 666 guards pass unchanged | Vitest (existing) | `rewrap-non-round-trip.test.ts` | `%s: Task 666 selection Link capture declines when the owned exact text is not the acquired text`; `%s: Task 666 selection Link capture declines a multi-unit selection on a normalizing body without the marker fallback`; `%s: Task 666 selection Link capture proves a paragraph on a normalizing body and plans only that span`; `%s: Task 666 a spaced thematic break does not make a normalizing document unprovable` |
| 4. Focused real-VS-Code spec run; quality stages pass | Real VS Code, gates | `test/vscode-e2e/exact-authority-other-actions.spec.ts` (existing, both tests); individual quality stages (the aggregate `npm run quality` and dependency audits are not run in this queue) | — |

### Edge cases and cheapest layer

| Edge case | Layer | Test |
| --- | --- | --- |
| Details toggle path (`proofMayCrossUnits`) on a normalizing body also reads once | Vitest (real Lute) | second assertion in the new `rewrap-non-round-trip.test.ts` case: a two-paragraph selection with `proofMayCrossUnits: true` is proven with one read |
| Stale owned exact text declines before the proof (one read, `null`) | Vitest (existing Task 666 guard) | unchanged guard; the new case also asserts one read for it |
| A supplied pair whose exact text differs from the index entry is `unavailable`; a supplied pair with `exact: null` is `unavailable`; `source.snapshotPair` is not called when a pair is supplied | Vitest (real Lute) | the new `selection-source-proof.test.ts` case |
| Round-trip document: the normalizing branch returns `undefined` after one read; the existing capture applies | Vitest (existing) | existing round-trip cases stay green |
| Front matter on a round-trip rendering (`captureFrontMatterRange` reads the pair and then proves again) | Out of scope | Recorded residual: same double-read shape on a different branch, reached only when the rendering equals the acquired text; not changed here |

### Part 2 step plan

**P2-S1 (Light: RED then fix in one step).** Owned files: `media-src/src/editing/rewrap-non-round-trip.test.ts`, `media-src/src/editing/selection-source-proof.test.ts`, `media-src/src/editing/selection-source-proof.ts`, `media-src/src/editing/rewrap-command.ts`.

- RED: add the two Vitest cases above. In `rewrap-non-round-trip.test.ts` mount with `bind = false`, then bind `{ index: m.index, snapshotPair: counted }` where `counted = vi.fn(() => ({ exact: m.state.exact, rendered: m.rendered() }))` (push its unbind into `teardown`), warm the index with `m.index.read()`, select `three` (five characters), call `captureRewrapSourceRange(window, range, { authoritativeMarkdown: NORMALIZING, proveNormalizingBody: true })`, expect the proven offsets and `counted` called once. Repeat for a `three` to `Omega` selection with `proofMayCrossUnits: true` (expect a proven range and one call), and for `m.state.exact = PADDED_NORMALIZING` (expect `null` and one call). In `selection-source-proof.test.ts` use the existing `mount`: read `pair = view.source.snapshotPair()`, clear the mock, call `proveSelectionSource(view.source, view.root, range, pair)`, expect `proven` and no `snapshotPair` call; then a pair with a different exact text and a pair with `exact: null`, each `unavailable`.
- RED check: `npx vitest run --config test/vitest.config.mts media-src/src/editing/rewrap-non-round-trip.test.ts media-src/src/editing/selection-source-proof.test.ts` exits 1; expected failures: the new `rewrap-non-round-trip.test.ts` case in IR and WYSIWYG (2 calls instead of 1) and the new `selection-source-proof.test.ts` case (`snapshotPair` called). The stale-text assertion passes at RED (one read already). Record the failing output.
- Fix: implement the intended solution. Comments follow `.agents/rules/ts.md`.
- Checks: the same Vitest command exits 0. Consumer regression: `npx vitest run --config test/vitest.config.mts media-src/src/editing/selection-link-actions.test.ts media-src/src/editing/details-selection-state.test.ts media-src/src/editing/block-transform-non-round-trip.test.ts media-src/src/editing/rewrap-command.test.ts` exits 0. `timeout 900 node build.mjs` exits 0; `npm run typecheck` and `npm run lint:ci` exit 0. Real VS Code, through the repository's guarded runner from the worktree: `env -u ELECTRON_RUN_AS_NODE xvfb-run -a sh -c 'openbox & OB=$!; VMDE_XTEST=1 npm --prefix test/vscode-e2e test -- exact-authority-other-actions.spec.ts --workers=1 --retries=0; R=$?; kill $OB; exit $R'`; expected 4 passed (the Task 674 `knownUndoFailure` cells are expected annotations, not failures).

**P2-S2 (closure).** No product files. Run `npm run lint:ci`, `npm run typecheck`, `npm run knip`, `npm run jscpd`, `npm run depcruise`, `npm run check:brand-identifiers`, `npx vitest run --coverage --config test/vitest.config.mts --testTimeout=60000 --maxWorkers=2 --coverage.reportOnFailure`, `npm run check:coverage-modules`, `git diff --check`. Update this record (status, acceptance boxes, verification actually run) and write the completion report.

### Baseline (unchanged code)

- `npx vitest run --config test/vitest.config.mts media-src/src/editing/rewrap-non-round-trip.test.ts media-src/src/editing/selection-source-proof.test.ts media-src/src/editing/selection-link-actions.test.ts`: exit 0, 3 files, 133 tests pass.
- Scratch counting probe: 2 bound-source `snapshotPair` calls per proven Link capture on a normalizing body, IR and WYSIWYG.
- Real VS Code not run in Part 1.

## Verification (2026-11-01)

Change: `proveSelectionSource` takes an optional fourth parameter `suppliedPair?: { exact: string | null; rendered: string }`; `captureNormalizingBodyRange` passes the pair it has just read. The supplied pair goes through the same checks as a read one (non-null exact text, index key, equality with the index entry). Every other caller is unchanged.

Files: `media-src/src/editing/selection-source-proof.ts`, `media-src/src/editing/rewrap-command.ts`, `media-src/src/editing/rewrap-non-round-trip.test.ts`, `media-src/src/editing/selection-source-proof.test.ts`.

Verification actually run, from the task worktree:

| Check | Exit | Result |
| --- | --- | --- |
| RED: `npx vitest run --config test/vitest.config.mts media-src/src/editing/rewrap-non-round-trip.test.ts media-src/src/editing/selection-source-proof.test.ts` before the fix | 1 | 3 failed, 128 passed: `expected "vi.fn()" to be called 1 times, but got 2 times` (IR, WYSIWYG); `expected "vi.fn()" to not be called at all, but actually been called 1 times` |
| Same two files after the fix | 0 | 2 files, 131 passed |
| Those two files plus `selection-link-actions`, `details-selection-state`, `block-transform-non-round-trip`, `rewrap-command`, `link-popover`, `details-toggle-controls`, `callouts` and `find-map` tests | 0 | 10 files, 362 passed; the four Task 666 guards unchanged and passing |
| `npm run typecheck` | 0 | no errors |
| `npx biome check` on the four touched files | 0 | no fixes applied |
| `npm run lint:ci`, `npm run knip`, `npm run jscpd`, `npm run depcruise`, `npm run check:brand-identifiers` | 0 each | no findings |
| `npm run test:coverage` | 0 | 384 files, 8,402 passed, 1 expected fail; no timeout, so no rerun with a longer timeout was needed |
| `npm run check:coverage-modules` | 0 | ratchet OK, 9 source modules at 0% (baseline 9) |
| `git diff --check` | 0 | clean |
| `node build.mjs`, then the existing `exact-authority-other-actions.spec.ts` through the guarded real-VS-Code runner, one worker, zero retries | 0 | 5 passed (13.5 min): IR 26 and WYSIWYG 20 matrix entries without violations, SV 8 entries; `bubble-link-normalizing` applies with Undo and Redo, both stale-host tests pass |

Bundle size (reporting only): `media/dist/main.js` is 1,121,376 bytes after the change; no baseline was recorded before it, and the change adds a few lines.

Real-VS-Code note: `stale-host-bubble-link` reported outcome `rebased` in both modes (the spec accepts a result that changes only the intended span). This task does not change that path.

Provisional decisions (all reversible), as taken in Part 1 and followed unchanged: fix instead of close (probability 1.00); optional trailing parameter on `proveSelectionSource`, passed only from `captureNormalizingBodyRange` (0.99, against 0.01 for an options object); run the existing spec and write no new one (1.00). The parameter is named `suppliedPair` so it does not shadow the local `pair`.

Residuals:

- `captureFrontMatterRange` reads the pair and then proves again (the same double-read shape). It is reached on this path only when the rendering equals the acquired text; it was left unchanged and is a candidate follow-up.
- No real-VS-Code assertion counts pair reads (the count is not observable in production without a test-only hook); it is proven in Vitest.
- The measured timings are Chromium harness timings under load from other work; the saving is one full serialization per gesture by construction.
