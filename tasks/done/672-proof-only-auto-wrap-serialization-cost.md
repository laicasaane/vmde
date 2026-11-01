# Task 672 — Extra IR serialization of proof-only auto-wrap

**Status:** done (2026-11-01), cost recorded as acceptable. Filed 2026-10-18 at the close of Tasks 606 and 630. One open finding is split out below (the wrap does not reach the host on the large fixture in real VS Code).
**Origin:** Task 606.
**Severity:** low (estimated).
**Tech stack:** `media-src/src/editing/rewrap-command.ts`, `media-src/e2e/auto-wrap.spec.ts` ("large IR typing").
**Depends on:** Task 606.

## Problem

Proof-only auto-wrap adds one more full IR serialization on a large IR document (`fullIrSerializes` 1 to 2 in the "large IR typing" case). The Task 606 timing gates (which do not exercise auto-wrap typing) showed no change. Measure it in the Chromium "large IR typing" case before deciding.

## Proposed work

Measure the cost on a large document. If over budget, cache the proof input or reuse the serialization.

## Acceptance

- [x] `fullIrSerializes` is back to 1 on a large IR document, or the measured cost is recorded as acceptable. Recorded as acceptable (two calls kept; see Part 1 handoff and Verification).
- [x] Focused real-VS-Code spec written and run (`auto-wrap-proof-cost.spec.ts`, 1 passed); the quality stages ran individually and exit 0 (the dependency audit stage is omitted by instruction, so the aggregate `npm run quality` was not run).

## Part 1 handoff (2026-11-01)

Measured on `dev` `9dc5c094` in the Chromium harness (`rewrap.html?mode=ir&column=48&auto=1&delay=1200`, the large mixed fixture from `test/vscode-e2e/large-mixed-markdown.ts`: 141,727 characters, 2,692 lines, live IR HTML about 666 KB). Scratch probes only (untracked); no product code or tracked test changed.

### Problem and root cause (measured)

The "large IR typing" case pins `fullIrSerializes: 2` after the delay. A stack capture on every `VditorIRDOM2Md` call with more than 50,000 characters of input shows exactly two calls, both inside the single proof that `rewrapTarget` runs through `captureProvenSelection` and `proveSelectionSource`:

1. **Exact-byte proof in edit-sync.** `snapshotPair` → `rebaseUnpublished` → `rebaseOneSpan` → `provesExact` → `projectRendered`. It renders the rebased exact text with `Md2VditorIRDOM` and serializes the result, to prove that the typed span maps onto the host bytes without carrying normalized bytes (Task 607 D3). Serialize 282 to 318 ms, render 180 to 239 ms.
2. **Live-DOM check in the source index.** `read` → `resolvePairUnits` → `resolveBlockHandleUnits` → `proof.serialize(root.innerHTML) === rendered`. It proves that the snapshot rendering still matches the live DOM before units are mapped. 219 to 273 ms.

The Task 606 comment in `media-src/e2e/auto-wrap.spec.ts` names these two sources correctly. The two calls serialize different inputs (a projection of the candidate exact text, and the live DOM), so neither result can stand in for the other. Inside one firing both are already cached (`lastRebase` and the unit cache), so caching the proof input saves nothing.

Typing is unaffected: during the burst the case records 0 captures, 0 `getValue` calls and 0 full serializations, as pinned.

Whole cost of one auto-wrap firing on this document (long-task observer, three runs, load average about 3 to 4.6): about 1,037 ms, then 2,280 to 2,510 ms, then about 60 ms of main-thread long tasks. The extra serialization (about 220 to 270 ms) is about 7 % of that. The remaining cost is not attributed in this task (it includes the second large render and the apply itself).

Budget: no record or spec defines a time budget for auto-wrap or other idle-time actions. The existing 50 ms long-task limits (`incremental-seed.spec.ts`, `incremental-md.spec.ts`, Preview streaming) cover typing, snapshot and streaming paths. The one-serialization path before Task 606 already exceeded 50 ms on this document.

Tasks 666 and 671 (not yet integrated) change only `captureRewrapSourceRange` (the legacy and normalizing-body captures, behind opt-in flags). The auto-wrap path on a round-trip document reaches `captureProvenSelection` with a proven result and does not call `captureRewrapSourceRange`, so they do not change the measured path. Part 2 still runs after they are integrated.

### Scope, interfaces and invariants

- Tier: Light. The chosen solution changes no edit-sync or source-index state.
- No public name, numbering, storage format or compatibility rule changes.
- Source-fidelity invariants kept: both proofs stay; auto-wrap still does no target or full-document acquisition before the delay; the wrapped bytes still reach the host through the exact post.

### Provisional decisions

- **Provisional decision (2026-11-01), reversible — cost.** Record the measured cost as acceptable and keep two full serializations. Removing the live-DOM check or the exact-byte proof would weaken a shared source-fidelity proof and move edit-sync state into scope; the extra cost is about 7 % of an idle-time action that already exceeded 50 ms before Task 606. Selected by a recorded decision check (probability 1.00 against 0.00 for skipping the live-DOM check and 0.00 for skipping the exact-byte proof).
- **Provisional decision (2026-11-01), reversible — real-VS-Code placement.** Add one test in a new file `test/vscode-e2e/auto-wrap-proof-cost.spec.ts` instead of extending `auto-wrap.spec.ts`, whose large-document sequence already fails on unchanged code ("Paragraph 401 … not found in IR"). Selected by a recorded decision check (probability 1.00 against 0.00 for each in-file option).

### Acceptance to test map

| Acceptance item | Layer | File | Test |
| --- | --- | --- | --- |
| 1. Cost measured and recorded as acceptable | Chromium | `media-src/e2e/auto-wrap.spec.ts` | "large IR typing performs no target or full-document acquisition before the delay" (keeps `fullIrSerializes: 2`; comment cites this measurement) |
| 1. Same, in production | Real VS Code | `test/vscode-e2e/auto-wrap-proof-cost.spec.ts` | "proof-only auto-wrap on a large IR document serializes the full document twice, only after the delay" |
| 2. Focused real-VS-Code spec written and run; quality stages pass | Real VS Code and gates | the spec above; the `npm run quality` stages except `audit` | — |

Edge cases and cheapest layer:

- No serialization while typing: Chromium (existing assertion) and the new real-VS-Code test.
- A small document stays under the 50,000-character counter threshold: not counted; no test (the counter does not apply).
- SV has no IR serialization; WYSIWYG uses `VditorDOM2Md`, which the counter does not watch: outside this task's measurement.
- An owned exact pair (no rebase) skips the exact-byte proof, giving one serialization: not reached by the typing case; no test.

### Part 2 plan (one Light step, after Tasks 666 and 671 are integrated)

**P2-S1 (Light: test and record).** Owned files: `test/vscode-e2e/auto-wrap-proof-cost.spec.ts` (new), `media-src/e2e/auto-wrap.spec.ts` (comment at the `fullIrSerializes: 2` pin only), this record.

- New spec: write `largeMixedMarkdown()` to a file in `baseDir` before opening; set the `vmde` settings `editor.wrapColumn` 48, `editor.autoWrap` true, `editor.autoWrapDelay` 1200, `editor.defaultMode` `ir`, `preview.reflowLineBreaks` false; reset them in `afterEach`. Open with `vmde.editor`, wait for `.vditor-ir` and for the editor value to equal the file. Install a counter on `vditor.vditor.lute.VditorIRDOM2Md` for inputs over 50,000 characters. Place the caret after `LARGE_MIXED_TARGET`, type `abcdefghijkl`, assert 0 at once; poll the host text until the target paragraph is wrapped (its bytes differ from the typed text and match `rewrapMarkdownRange` on the typed text, as `auto-wrap.spec.ts` computes it); then assert the counter equals 2. Keep helpers compact and do not copy blocks from `auto-wrap.spec.ts` (jscpd).
- Update the Chromium comment to cite this record's measurement and the acceptance decision.
- Checks:
  - `timeout 900 node build.mjs` exits 0.
  - `npm run typecheck:vscode-e2e` exits 0.
  - Real VS Code: the repository's guarded real-VS-Code runner with `env -u ELECTRON_RUN_AS_NODE xvfb-run -a sh -c 'openbox & OB=$!; VMDE_XTEST=1 npm --prefix test/vscode-e2e test -- auto-wrap-proof-cost.spec.ts --workers=1 --retries=0; R=$?; kill $OB; exit $R'`. Expected: 1 passed. If production counts a number other than 2, stop and report the count and stacks; do not change the pin to match.
  - Chromium: `npx playwright test e2e/auto-wrap.spec.ts -g "large IR typing"` from `media-src` (temporary config on a free port in `tmp/672/` when 9123 is busy). Expected: 1 passed.
  - Gates: `npm run check:brand-identifiers`, `npm run lint:ci`, `npm run knip`, `npm run jscpd`, `npm run depcruise`, `npm run test:coverage`, `npm run check:coverage-modules`, each exit 0 or only the known baseline findings. The aggregate `npm run quality` is not run (its audit stage is omitted).

## Verification (2026-11-01)

Tree: `dev` `1986f97a` (Task 666 integrated; it changes only `captureRewrapSourceRange`, not the measured path).

- New real-VS-Code spec `test/vscode-e2e/auto-wrap-proof-cost.spec.ts` (1 test, large mixed IR fixture, wrap column 48, auto-wrap delay 800 ms, one typed character after a warm-up edit taken with auto-wrap off). Instrument check first: a direct call of the counted serializer on the whole IR HTML moves the counter 0 to 1, and a small input leaves it at 0. Then: 0 whole-document serializations while typing (read before the delay), exactly 2 after the delay. Result: 1 passed.
- Cost basis, real VS Code (this run): the firing produced main-thread long tasks of 311 ms and 562 ms. In the Chromium harness (Part 1, three runs) the long tasks after the delay were about 1.0 s and 2.3 to 2.5 s with serializations of 220 to 320 ms and renders of 180 to 240 ms. Those long tasks come from the same proof path (the two serializations, the matching renders, and the apply); no single long task above 2 s was attributable to the two serializations alone (each serialization is 220 to 320 ms). No time budget for auto-wrap exists in any record or spec.
- Chromium "large IR typing performs no target or full-document acquisition before the delay": 1 passed (comment at the `fullIrSerializes: 2` pin now cites the measurement).
- Gates, each exit 0: `check:brand-identifiers`, `lint:ci`, `typecheck`, `typecheck:vscode-e2e`, `knip`, `jscpd`, `depcruise`, `test:coverage`, `check:coverage-modules` (9 modules at 0%, baseline 9).

### Findings kept out of this task

- In real VS Code the auto-wrap firing runs its proof (2 whole-document serializations) but the wrapped text did not reach the host on the large fixture, with delays of 800 ms and 5,000 ms and with 1 and 12 typed characters (host text unchanged four seconds and more after the firing). A manual Rewrap on the same state applied the wrap. The Chromium harness applies it. The spec therefore pins the serialization count only and prints, but does not assert, whether the host text changed. This looks like a decline in the production auto-wrap apply on a large document (not measured further here); it needs its own task. Unchanged by this task.
- The first edit of a freshly opened large document, enabling auto-wrap, and clicking into a block each do their own whole-document serialization (measured: one after the setting change, two after the click). The spec waits for the count to settle before counting.
