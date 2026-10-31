# Task 605 — Turn Into with exact source in SV mode

**Status:** implemented and verified (2026-11-01); ready to close. (Planned 2026-09-29.) Task 604 deliberately scoped its exact selection proof to IR and WYSIWYG; the SV design and acceptance remain open.
**Origin:** [Task 604](604-turn-into-non-round-tripping-documents.md), Owner decision 2 and independent-review residual.
**Scope:** SV capture, exact apply/Undo/save, and SV or index-less passive Details capture while a Turn Into choice is pending. Do not change Task 604's IR/WYSIWYG proof or its pending-choice contract.
**Dependency:** Task 604's shared exact-source proof and host cancellation lifecycle.

## Problem and evidence

SV's `captureRewrapSourceRange` uses `clone.textContent` (`media-src/src/editing/rewrap-command.ts`), including an appended newline span, then requires whole-document equality with the exact source. The canonical fixture has 174,517 exact characters; direct SV renders at 174,527–174,529 characters and a WYSIWYG→SV switch renders at 181,844. The small round-tripping SV control F5b also declines: 32 exact characters versus 35 rendered, and host-style serialization differs from exact. SV apply also assumes the editor text and exact source correspond (`media-src/src/editing/block-transform-command.ts`, `replaceSvMarkdownRange`). Task 604's Details guard covers its indexed fallback only; SV/index-less passive capture can still insert markers while a choice is pending.

Evidence: Task 604 Checkpoint 1 D6 and F5b in `tmp/task604-checks/cp1/`, especially `tmp/task604-checks/cp1/vscode/r0-b.json`; S6 review disposition in the Task 604 record. The fixture is synthetic and its content must not be printed in diagnostics.

## Investigation and design boundary

1. Measure direct SV and IR/WYSIWYG→SV entry on the same exact fixture, including the small F5b control. Record the source, SV text and host identities by length/hash and prove caret/selection membership before Turn Into.
2. Design an exact↔SV-text alignment for both selection endpoints, using Task 604's `toExact` and Find's SV mapper as references. Reject ambiguous offsets, appended controls and any span whose source ownership cannot be proven. Keep exact source as the transform input and posted result.
3. Prove that applying the exact span changes only the intended block and records history against SV's rendered `getValue()` where required. Preserve one OS Undo, Redo where supported, host/disk/save/reopen fidelity and mode-switch behavior.
4. Measure SV/index-less Details capture with a pending choice. Decide how to defer source-affecting passive capture until apply/cancel without disabling indexed or explicit Details actions. Coordinate with Task 606's broader marker-capture work rather than duplicating it.

## Verification

- Real-Lute/unit cases for direct and switched SV, small F5b, appended-newline boundaries, CRLF, unmappable endpoints, and pending-choice apply/cancel.
- Chromium coverage for exact target-only transformation, Details resumption, and Undo/Redo.
- Build first, then focused real-VS-Code XTEST coverage for direct and switched SV QuickPick, exact host/save/Undo/reopen, focus and selection ownership. Compare Task 604 IR/WYSIWYG controls and report inherited gates separately.

## Acceptance

- [x] Turn Into offers only source-proven targets from both direct and switched SV, including the small F5b control.
- [x] Unprovable SV selections decline without posting or applying an approximate edit.
- [x] Apply, one OS Undo and save/reopen preserve exact bytes outside the target; rendered bytes never become exact authority.
- [x] A pending SV choice survives passive Details activity and Details resumes after apply or matching cancel.

## Part 1 handoff (2026-10-14)

Read-only review of the source and the Task 604 recorded lengths; no probes or tests were run. V = verified; I = inferred.

- **Cause and entry points.** V: SV never uses the index (`indexedSourceFor` returns null for SV in `media-src/src/editing/block-transform-command.ts`), so capture goes to `legacyCapture`, which inserts live markers through `captureRewrapSourceSelection` (`rewrap-command.ts`), serializes with `clone.textContent` and requires `selection.markdown === exact`; direct SV (+11 characters), WYSIWYG→SV (+7,327) and the small F5b control (34 vs 32) all fail it (Task 604 recorded lengths). V: every SV gate assumes text equals exact source (`batchOwnershipIsLive`, `prepareChoice`, apply `replaceSvMarkdownRange` guarded in `rewrap-command.ts`). V: SV `getValue()` is `code160to32(textContent + "\n")` with a trailing `\n\n` reduced, while DOM offsets index `textContent` (T); I: the F5b +2 sits before the end (S1 locates it). V: SV skips the `hasRewrapDocumentHistoryTransition` decline. V: the Details pending-choice guard covers only the indexed fallback (`details-toggle.ts`); the legacy branch inserts markers while a choice is pending, splitting text nodes so `markDirty`'s same-selection check clears the pending choice (SV and index-less IR/WYSIWYG). Reference: Find's SV mapper (`find-map.ts`) aligns exact with the joined text nodes and accepts a span only when the rendered slice equals the exact slice; Task 604's caret rule and boundary checks are in `selection-source-proof.ts`.
- **Contract.** (1) SV proof uses no markers: build T from text nodes (as Find's SV mapper), compute `alignText(exact, T)` memoized on (exact, T); endpoints must be connected Text nodes in the editor (element offsets decline). (2) Map endpoints with start/end bias for a range and the caret rule for a collapsed selection (disagreeing biases decline), then `isExactTextBoundary` (no CRLF or surrogate splits), the character-identity check and `start <= end`. (3) Ownership: `describeBlockAt(exact, anchor, focus)` gives the span; its rendered image must exist, be verbatim (`T.slice(...) === exact.slice(span)`) and contain both rendered endpoints, else decline (rejects offsets inside the appended trailing newline span). (4) Multi-span selections only when round-trip (`exact === getValue()`), mirroring Task 604's Owner rule. (5) Decline on `hasRewrapDocumentHistoryTransition` in SV too. (6) The bookmark stores exact, `getValue()`, T and the rendered span; revalidation checks all four (replaces the `textContent === exact` tests). (7) Apply plans on exact; assert prefix and suffix outside the span equal exact; splice only the rendered span with the changed block text (rendered text outside the target unchanged); caret at `rs + (exactOffset - span.start)`, rejected outside the new block. (8) Decline if the replacement contains `\r` or U+00A0 unless S1 proves SV keeps those bytes verbatim. (9) Post exact `result.markdown`; history stays `recordBlockHistory` with SV `getValue()` before and after; one checkpoint before and after. (10) Details: in `update()`'s legacy branch, when a choice is pending and the selection is expanded, defer the fallback (button state kept; the observer reschedules after apply or cancel); collapsed/retained state reads no markers; the explicit button path unchanged. Splice instead of `setValue(exact)` (a re-render of a switched document would rewrite thousands of rendered characters outside the target); align against T, not `getValue()`.
- **Part 2.** S1: privacy-safe probe (lengths and hashes only) on `test/vscode-e2e/fixtures/large-observable-models-synthetic.md` (direct SV, IR→SV, WYSIWYG→SV) and F5b (`test/vscode-e2e/turn-into-non-round-trip-helpers.ts` `SMALL`): T, `getValue()` and host lengths and hashes, first-difference offset, alignment run count, whether the near/far paragraph spans are verbatim in T, endpoint node kinds for caret and range routes, whether `\r` and U+00A0 survive in T for a CRLF variant, alignment build time on the switched route (diff limit may fail closed), other passive SV DOM mutators during a pending choice; an `@probe` test in `turn-into-non-round-trip-probe.spec.ts`. S2a: RED real-Lute `media-src/src/editing/block-transform-sv.test.ts` (direct, switched, F5b, appended-newline boundary before/inside/after, CRLF caret and replacement, nbsp, element-offset decline, ambiguous caret at a deletion boundary, non-round-trip multi-span decline, stale T, history-transition decline) and cases in `block-transform-command.test.ts`. S2b: new `media-src/src/editing/sv-source-proof.ts` (prove/rendered-span helper reusing `alignText`) wired into capture, bookmark, revalidate, batch ownership and prepare (manifest entry). S3: apply with a rendered-span splice (a new `replaceSvMarkdownRange` variant or local helper; Rewrap callers unchanged); Chromium SV cases in `media-src/e2e/turn-into-non-round-trip.spec.ts` (target-only exact bytes, one Undo, Redo, caret). S4: the `details-toggle.ts` legacy-branch guard with tests in `details-toggle-controls.test.ts` and `media-src/e2e/details.spec.ts`. S5: real-VS-Code SV cases in `test/vscode-e2e/turn-into-non-round-trip.spec.ts` (direct and switched SV QuickPick; Heading 2 posts exact; outside bytes, host and disk unchanged; one OS Undo exact; save/reopen in SV; F5b offered; unprovable endpoint declines with no post; focus and selection); rerun IR/WYSIWYG Task 604 controls and `details-toolbar.spec.ts`. S6: closure.
- **Edge cases.** Backward selection; caret at the document end vs inside the appended newline; exact without a final newline; fence or table targets with normalized padding (decline); a mode switch between request and apply; a trusted edit while the choice is pending; Find focus deferral in SV; the selection-bubble Turn Into route.
- **Decisions (provisional, reversible).** (1) Non-round-trip SV multi-block selections decline even when every span is verbatim, mirroring Task 604's Owner rule — adopted. (2) SV replacements containing CRLF or U+00A0 decline unless S1 proves the bytes are kept — adopted.
- **Risks.** Stale SV highlight spans after the splice until the next respin (existing SV Rewrap pattern); `details-toggle.ts` is shared with Task 606's Details repair and `replaceSvMarkdownRange` with SV Rewrap — sequence 606 first or merge carefully and keep the old signature; a later trusted SV edit resyncs the host with rendered bytes (Task 607 territory).

## Part 1 reconciliation (2026-11-01)

Read-only re-check of the 2026-10-14 handoff against `dev` `4e6547d5`. Since the handoff, Tasks 607, 609, 610 and 611 (2026-10-14, after the handoff commit), 630, 606 and 670 changed the files this task touches. No product code was changed and no acceptance test was run in this step. V = verified at `4e6547d5`; I = inferred.

### Re-verified handoff claims

| # | Handoff claim | Status at `4e6547d5` |
|---|---|---|
| 1 | SV never uses the index: `indexedSourceFor` accepts only `ir`/`wysiwyg` (`block-transform-command.ts`). | V, unchanged. |
| 2 | SV capture goes to `legacyCapture`, which calls `captureRewrapSourceSelection` (live markers, `serializeForMode` = `clone.textContent`) and requires `selection.markdown === exact`. | V, unchanged. New (Task 607): `legacyCapture` returns `null` when `snapshotExactMarkdown()` is `null`. Task 606 added a marker-free proof path (`captureProvenSelection`, `proofOnly`), and Task 670 added a front-matter body proof, but both run only when `isProvenMode` (IR/WYSIWYG). Turn Into calls `captureRewrapSourceSelection` without `proofOnly`, so SV still uses the marker capture. |
| 3 | Every SV gate assumes `textContent === exact`: `batchOwnershipIsLive`, `prepareChoice`, `replaceSvMarkdownRange` (`rewrap-command.ts`, before and after the splice). | V, unchanged. `replaceSvMarkdownRange` is also the SV Rewrap apply (`applySvDocumentOrSelection`); its signature must stay. |
| 4 | SV `getValue()` is `code160to32(textContent + "\n")` with a final `\n\n` reduced to `\n`. | V, unchanged (Vditor `markdown/getMarkdown.ts`). |
| 5 | SV skips the `hasRewrapDocumentHistoryTransition` decline (it applies only with an indexed source). | V, unchanged. |
| 6 | The Details pending-choice guard covers only the indexed fallback. | V, unchanged: `exactFallbackState` defers while `choicePending`; `update()`'s non-indexed branch still runs `applyState(statusOf(legacyTarget()))`, and `legacyTarget` calls `captureTarget` (marker capture) for an expanded selection. Task 630 changed the explicit toggle to acquire host exact bytes first; Task 609 changed caret-intent handling; neither touches this branch. |
| 7 | Find's SV mapper (`find-map.ts` `svMapper`) aligns `exact` with the joined text nodes and accepts a span only when the rendered slice equals the exact slice. | V, unchanged. Tasks 610 and 670 changed only the indexed mapper (block-map refresh, YAML and math marker filter). `textNodes` stays private. |
| 8 | Task 604's caret rule (`through`) and boundary check (`isExactTextBoundary`) live in `selection-source-proof.ts`. | V, unchanged and still private. Task 670 skips front-matter units in `unitIndexOf`; Task 607 declines a `null` exact. |
| 9 | Fixtures: `test/vscode-e2e/fixtures/large-observable-models-synthetic.md` and F5b `SMALL` in `turn-into-non-round-trip-helpers.ts`. | V. `SMALL` is 32 characters. |

### Changes since the handoff that the design must absorb

- **C1 (Task 607, exact authority).** `snapshotExactMarkdown()` returns `string | null`. The palette entry is now `requestBlockTransformOptionsAcquiring`: without owned exact bytes it settles typing, pulls the host's bytes and retries only for the same live selection. The SV proof must run after that acquisition and decline on `null`. V.
- **C2 (Task 607 D2, host refusal).** `postExact(markdown, { rollback })`: when the host refuses the guarded exact edit, EditSync calls `vditor.setValue(hostContent)` and the rollback restores the Undo stacks. In SV this re-renders the whole document from host bytes; this is the refusal path only and is accepted (host bytes stay authoritative). V.
- **C3 (Task 611, one Undo entry).** Apply now pre-checkpoints with `checkpointEditorUndoCoalescing(inner, isOwnCheckpoint(...))` and post-checkpoints once. Handoff contract (9) "one checkpoint before and after" is replaced by: keep the existing coalescing pre-checkpoint and the single post-checkpoint unchanged for SV. V.
- **C4 (Task 670, front matter).** `describeBlockAt` declines front-matter targets (`block-transform.ts` `frontMatter` state); Lute drops the blank line after YAML, so a front-matter document is a non-round-trip SV case. Add SV front-matter cases to S2a (caret inside YAML declines; body paragraph after YAML is proven when its rendered image is verbatim). V for the decline; I for the SV rendering, S1 measures.
- **C5 (apply caret).** SV apply calls `caretFromTextOffsets(result.anchor, result.focus)` with exact offsets used as `textContent` offsets. With a rendered-span splice both must be mapped to `rs + (x - span.start)` (handoff contract (7) named only the focus). V.
- **C6 (revalidate).** `revalidate` compares `snapshotExactMarkdown()` with `bookmark.exact` and `getValue()` with `bookmark.rendered`; the SV text `T` check is additional, as contract (6) states. V.
- **C7 (handle route).** `requestBlockTransformOptionsAtSource` accepts only `ir`/`wysiwyg`; SV has no block handles. Out of scope. V.
- **C8 (existing probe).** `turn-into-non-round-trip-probe.spec.ts` already has Task 604's `R0 A @probe` (IR, WYSIWYG and switched SV) and `R0 B @probe` (direct SV and the round-trip control), both behind `VMDE_XTEST=1`. S1 adds one new probe beside them instead of a new file. V.

The handoff contract (1)–(10) otherwise stands, with C3 and C5 replacing the matching parts of (7) and (9).

### Decisions re-settled

- **Decision 1 (non-round-trip SV multi-block selections decline).** Unchanged. Task 606 allows proven multi-unit Rewrap selections in IR/WYSIWYG, but Turn Into's `indexedBookmark` still restricts a non-round-trip selection to one proven unit; SV mirrors Turn Into's rule, not Rewrap's. Provisional decision (2026-10-14), reversible; still valid.
- **Decision 2 (SV replacements with `\r` or U+00A0 decline unless S1 proves the bytes kept).** Unchanged; no code since the handoff touches it. Provisional decision (2026-10-14), reversible.
- **Decision 3 (new). Shared caret and boundary helpers.** Export Task 604's private `through` as `exactOffsetThrough` and `isExactTextBoundary` from `selection-source-proof.ts`, unchanged in behaviour; `sv-source-proof.ts` imports them. Rejected: moving them to `find-align.ts` (touches one more file) and duplicating them (jscpd). Provisional decision (2026-11-01), reversible; selected by a recorded decision check (probability 0.85; move 0.14; duplicate 0.00).
- **Decision 4 (new). SV splice placement.** Export the existing private `textPointAt` from `rewrap-command.ts` (no behaviour change) and implement the rendered-span splice in the new `sv-source-proof.ts`, next to the SV proof. `replaceSvMarkdownRange` and its Rewrap callers stay unchanged. Rejected: a new export in `rewrap-command.ts` (separates proof and apply) and an optional argument on `replaceSvMarkdownRange` (changes the shared signature). Provisional decision (2026-11-01), reversible; selected by a recorded decision check (probability 0.80; new export in Rewrap 0.10; generalize 0.02).

### Settled names (Part 2 uses these exactly)

- Module `media-src/src/editing/sv-source-proof.ts`; manifest id `sv-source-proof` in `scripts/module-manifest.mjs`, directly after `selection-source-proof`, comment `// Task 605 — marker-free SV selection → exact-source proof and rendered-span splice.`
- `exactOffsetThrough(alignment, offset, bias)` and `isExactTextBoundary(source, offset)` exported from `selection-source-proof.ts`; `textPointAt(root, offset)` exported from `rewrap-command.ts`.
- In `sv-source-proof.ts`:
  - `svText(editor: HTMLElement): string` — the joined Text node data in document order (equals `editor.textContent`).
  - `proveSvSelection(editor: HTMLElement, exact: string, range: Range): SvSelectionProof`, where `SvSelectionProof = { status: 'proven'; exact: string; text: string; start: number; end: number; renderedStart: number; renderedEnd: number } | { status: 'unprovable' }`. Endpoints must be connected Text nodes inside `editor` (element offsets decline); rendered offsets map through a memoized `alignText(exact, text)` (memo keyed on the last `(exact, text)` pair) with `start`/`end` bias for a range and `exactOffsetThrough(..., 'caret')` for a collapsed range; both exact offsets must pass `isExactTextBoundary`, the character-identity check (`text[r] === exact[x]` where both exist) and `start <= end`.
  - `svRenderedSpan(exact: string, text: string, span: { start: number; end: number }, renderedStart: number, renderedEnd: number): { start: number; end: number } | null` — maps `span` with `start`/`end` bias, requires `text.slice(rs, re) === exact.slice(span.start, span.end)` and `rs <= renderedStart <= renderedEnd <= re`; otherwise `null` (this rejects offsets inside the appended trailing newline).
  - `spliceSvRenderedSpan(editor: HTMLElement, text: string, span: { start: number; end: number }, replacement: string): boolean` — requires `svText(editor) === text`, replaces `[span.start, span.end)` through `textPointAt`, normalizes, then requires `svText(editor) === text.slice(0, span.start) + replacement + text.slice(span.end)`. The caller places the caret.
- `BlockBookmark` gains `sv: { text: string; span: { start: number; end: number } } | null` (`null` in IR/WYSIWYG). SV `revalidate`, `batchOwnershipIsLive` and `prepareChoice` check `svText(editor) === bookmark.sv.text` instead of `textContent === exact`.
- No new public API, message, setting or storage format.

### Part 2 step plan (amended)

Command shorthands, run from the worktree root:
- `VT <files>` = `npx vitest run --config test/vitest.config.mts <files>`
- `CR <spec>` = `xvfb-run -a npm --prefix media-src run test:e2e -- <spec>`
- `RV <spec> [-g <title>]` = hold the real-VS-Code token, run `node build.mjs`, then `env -u ELECTRON_RUN_AS_NODE xvfb-run -a sh -c 'openbox & VMDE_XTEST=1 npm --prefix test/vscode-e2e test -- <spec> --workers=1 --retries=0 [-g <title>]'`, then release the token. Probes add `VMDE_PROBES=1`.

Fixture content is never printed: lengths, SHA-256 prefixes and offsets only.

1. **S1 — measure (probe; real-VS-Code).** Result: `tmp/605/s1/r0-d.json` with, for direct SV, IR→SV, WYSIWYG→SV on the large fixture and for F5b: `exact`, `T` and `getValue()` lengths and hashes; first-difference offset; alignment run count and build time on the switched route; whether the near and far paragraph spans are verbatim in `T`; endpoint node kinds for caret and range selections; a CRLF variant of `SMALL` (does `\r` survive in `T` and in `getValue()`); a U+00A0 variant; a front-matter variant of `SMALL` (does the body paragraph stay verbatim); passive SV DOM mutators seen while a choice is pending. Owned: `test/vscode-e2e/turn-into-non-round-trip-probe.spec.ts` (new `R0 D @probe Task 605 measures SV text alignment`), `tmp/605/s1/`. Proves: evidence for items 1–3 and Decision 2. Check: `RV turn-into-non-round-trip-probe.spec.ts -g "R0 D"` with `VMDE_PROBES=1` exits 0 and writes the JSON; `npm run typecheck` exits 0. If the switched alignment exceeds the diff limit (alignment `null` or one run), stop and report a design question.
2. **S2a — RED unit tests.** Result: failing real-Lute cases. Owned: new `media-src/src/editing/block-transform-sv.test.ts` (boot real Lute as `block-transform-non-round-trip.test.ts` does): direct SV, switched SV, F5b offered; trailing-newline boundary before/inside/after; CRLF caret and CRLF replacement; U+00A0; element-offset endpoint declines; ambiguous caret at a deletion boundary declines; non-round-trip multi-span declines; stale `T` declines at apply; history-transition declines; front-matter caret declines and body paragraph after YAML; `null` exact declines. Add apply-plan cases to `block-transform-command.test.ts` only where its mocks already cover SV. Proves: items 1 and 2 (RED). Check: `VT media-src/src/editing/block-transform-sv.test.ts` fails only on the new SV-proof cases (decline cases that already decline pass); `npm run typecheck` exits 0.
3. **S2b — GREEN proof and decline logic.** Result: S2a passes. Owned: new `media-src/src/editing/sv-source-proof.ts`; `selection-source-proof.ts` (two exports only); `rewrap-command.ts` (`textPointAt` export only); `block-transform-command.ts` (SV capture through `proveSvSelection` + `describeBlockAt` + `svRenderedSpan`, the `sv` bookmark field, SV `revalidate`/`batchOwnershipIsLive`/`prepareChoice`, `hasRewrapDocumentHistoryTransition` decline in SV); `scripts/module-manifest.mjs`. IR/WYSIWYG paths unchanged. Proves: items 1 and 2 (GREEN). Check: `VT media-src/src/editing/block-transform-sv.test.ts media-src/src/editing/block-transform-command.test.ts media-src/src/editing/block-transform-non-round-trip.test.ts media-src/src/editing/rewrap-command.test.ts media-src/src/editing/rewrap-non-round-trip.test.ts test/backend/module-boundaries.test.ts` all pass; `npm run typecheck` and `npm run lint` exit 0.
4. **S3 — exact apply, one Undo, Chromium (merged RED+fix, Light).** Result: SV apply splices only the rendered span with `result.markdown.slice(span.start, span.end + delta)` (`delta = result.markdown.length - exact.length`), asserts the exact prefix and suffix outside the span are unchanged, maps anchor and focus to `rs + (x - span.start)` (declines if outside the new block), keeps the Task 611 coalescing pre-checkpoint and one post-checkpoint, records `recordBlockHistory` with SV `getValue()` before and after, posts exact `result.markdown` with the existing rollback. Owned: `block-transform-command.ts` (SV apply branch), `sv-source-proof.ts`, `media-src/e2e/turn-into-non-round-trip.spec.ts` (new SV cases: target-only exact bytes, one Undo, Redo, caret, F5b), and the matching harness file only if a hook is missing. Proves: item 3 (Chromium part). Check: `CR turn-into-non-round-trip.spec.ts` passes apart from the known load-dependent `:852`; the step 3 Vitest files still pass.
5. **S4 — Details pending choice (merged RED+fix, Light).** Result: in `update()`'s non-indexed branch, when `choicePending` and the selection is expanded, set `fallbackDeferred = true` and keep the button state; the existing observer reschedules after apply or cancel. Collapsed and retained reads stay; the explicit button path stays. Owned: `media-src/src/editing/details-toggle.ts`, `media-src/src/editing/details-toggle-controls.test.ts`, `media-src/e2e/details.spec.ts`. Proves: item 4. Check: `VT media-src/src/editing/details-toggle-controls.test.ts media-src/src/editing/details-turn-into-pending.test.ts media-src/src/editing/details-toggle.test.ts` pass; `CR details.spec.ts` passes.
6. **S5 — real-VS-Code SV cases.** Result: new SV cases in `test/vscode-e2e/turn-into-non-round-trip.spec.ts`: direct and switched SV QuickPick offers Heading 2; apply posts exact; bytes outside the target, host and disk unchanged; one OS Undo restores exact; save and reopen in SV keeps exact; F5b offered; "unprovable endpoint declines with no post"; focus and selection ownership. Owned: that spec and `turn-into-non-round-trip-helpers.ts`. Proves: items 1–3 (real VS Code). Check: `RV turn-into-non-round-trip.spec.ts` passes (Task 604 IR/WYSIWYG cases included), then `RV details-toolbar.spec.ts` passes (item 4 rerun).
7. **S6 — closure.** Focused gates: `node build.mjs`, `npm run typecheck`, `npm run lint`, the Vitest files of steps 3–5, `CR turn-into-non-round-trip.spec.ts details.spec.ts`, the step 6 specs, `npm run quality` (record each stage; known failures in the run rules are not regressions). Update the acceptance and checklists, write the completion report.

Routing: every Part 2 step is a settled-contract execution step (queue routing). A step that finds the contract contradicted by S1 evidence stops and reports a design question.

### Edge cases (added)

Host refusal rollback re-renders SV from host bytes (C2); acquisition changes the selection key (request dropped, C1); Find focus deferral in SV; selection-bubble Turn Into route uses the same capture; a trusted SV edit while the choice is pending invalidates `T` (apply declines).

### S1 results (2026-11-01)

Probe `R0 D1`–`R0 D5` in `test/vscode-e2e/turn-into-non-round-trip-probe.spec.ts` (tagged `@probe`, real VS Code, 8 test cases pass). Only lengths, 32-bit hash prefixes, offsets and booleans were recorded; no document content was printed. Raw numbers: `tmp/605/s1/r0-d.json` (untracked). `T` is the joined SV Text node data (equal to `textContent` in every case). The alignment was built in the Node test process (same `alignText`), so its time is a proxy for the diff-limit check, not a webview timing.

| Route (large fixture, exact length 174,517) | `T` length | `getValue()` length | First difference | Equal-run starts | Unmapped exact offsets | Align build (Node) |
|---|---|---|---|---|---|---|
| direct SV | 174,528 (+11) | 174,529 (`T` + 1) | 10,153 | 29 | 6 | 19 ms |
| IR → SV | 181,846 (+7,329) | 181,846 (= `T`) | 74 | 312 | 6 | 46 ms |
| WYSIWYG → SV | 181,844 (+7,327) | 181,844 (= `T`) | 74 | 312 | 6 | 37 ms |

- The alignment does not fail closed on any route: the line-diff limit is not reached, and the 6 unmapped exact offsets (first 37,912, last 121,465) are the same on all three routes.
- The near and far paragraph spans map and are verbatim in `T` on all three routes. A caret in the near paragraph maps to the expected exact offset with agreeing start/end bias (15,401), and the far token range maps to a slice equal to the token. Both endpoints are Text nodes whose parent is not the editor root (no element-offset endpoints).
- Direct SV: `T` ends with a newline and U+200B after the exact text's final newline (appended control); the `+11` is that 2-character tail plus a mid-document drift of 9 characters first seen at offset 10,153. Switched SV: `T` is the Lute serialization (equal to `getValue()`); it ends one newline longer than the exact text and has no U+200B.
- **F5b (32 exact characters):** `T` is 34 and `getValue()` 35. Exact is a prefix of `T`, so the `+2` is the appended trailing newline and U+200B at the end. This contradicts the handoff inference that it sits before the end; the alignment design is unaffected (one equal run, no unmapped offsets, target verbatim, caret maps to the expected offset).
- **CRLF variant:** `T` contains no `\r` (5 in exact, 0 in `T` and `getValue()`), so a replacement containing `\r` cannot be kept; the caret still maps to the expected exact offset. Decision 2 stands for `\r`.
- **U+00A0 variant:** `T` keeps U+00A0 verbatim (1 in exact, 1 in `T`) while `getValue()` converts it (0). Decision 2's "unless S1 proves the bytes are kept" clause is met for `T`; S2b may allow U+00A0 in a replacement, with the history record using `getValue()` as designed. `\r` still declines.
- **Front-matter variant:** exact is a prefix of `T` plus the same 2-character tail, so a body paragraph after YAML is verbatim and its caret maps; front matter alone does not make SV non-round-trip.
- **Pending choice and passive mutators (`R0 D5`):** Turn Into opens no picker in SV today (confirms the acceptance gap), so a pending SV choice cannot be observed yet. Baseline with an expanded selection and a `selectionchange`: one mutation batch with 6 child-list records, 4 added and 2 removed Text nodes, 2 character-data records, `T` unchanged, Text node count 11 → 13, and selection offsets in `T` terms unchanged. This is the Details legacy marker capture splitting Text nodes, which changes the Range container identity that `samePendingSelection` compares (S4 hypothesis confirmed in kind; the pending-choice case is re-measured by S4's tests once S2b/S3 open the picker).

No finding invalidates the Part 1 design. The plan changes only the S2a expectation for the U+00A0 case (offered and applied, not declined) and the contract-(3) note that the appended tail is a newline plus U+200B in direct SV.

### S2a results (2026-11-01)

RED tests are in `media-src/src/editing/block-transform-sv.test.ts` (23 cases, real Lute). The SV editor is rendered the way Vditor's `setValue` renders it: a `data-block` wrapper around Lute's SV spans (`SpinVditorSVDOM`), plus an appended U+200B text node for direct SV (S1), and the Lute IR or WYSIWYG serialization as the displayed text for the switched routes. The exact source stays the posted and proven authority.

- Cases: F5b offered and applied (exact bytes posted, only the target text changes in the SV text); direct, IR→SV and WYSIWYG→SV large-fixture near caret offered, far range offered, and near Heading 2 applied with every other exact byte unchanged; trailing-newline boundary (caret at the end of the last paragraph offered; caret inside the appended newline and after U+200B declines); CRLF caret mapping and posted CRLF bytes; a replacement that carries `\r` declines; U+00A0 kept verbatim; element-offset endpoint declines; caret on a deletion boundary declines; stale SV text at apply declines; exact-history transition declines; front matter (body paragraph offered, YAML caret declines); non-round-trip multi-block selection declines; no owned exact source declines. Each decline case first asserts an offered control, so it is RED today and stays meaningful after S2b.
- `P0` (model check) passes today: it asserts the modeled direct SV text is the exact text plus a newline and U+200B (S1's F5b numbers), that CR is dropped from the SV text, and that U+00A0 stays in the text but not in `getValue()`.
- Result: 1 passed, 22 failed. All 22 failures are `expected null not to be null` at the first Turn Into request or control, i.e. SV declines every selection today; none is a setup error.
- Not covered here (by design): one-checkpoint Undo, Redo and real caret placement (S3 Chromium); Details pending state (S4).

### S2b results (2026-11-01)

GREEN: SV Turn Into now captures through a marker-free proof, and `block-transform-sv.test.ts` passes (24 cases).

- New module `media-src/src/editing/sv-source-proof.ts` (manifest id `sv-source-proof`): `svText`, `proveSvSelection`, `svRenderedSpan`, `spliceSvRenderedSpan` as settled, plus one helper added during implementation, `planSvEdit` (checks that the bytes outside the target are unchanged, that the replacement carries no carriage return, and maps the carets into the new block; it feeds the splice). Alignment is memoized on the last `(exact, text)` pair.
- `selection-source-proof.ts` exports `exactOffsetThrough` (the former private `through`) and `isExactTextBoundary`, unchanged in behavior; `rewrap-command.ts` exports `textPointAt`. `replaceSvMarkdownRange` and its Rewrap callers are untouched.
- `block-transform-command.ts`: SV capture (`svCapture`) replaces the marker capture for SV; it declines on an exact-history transition, on `null` exact, on an endpoint that is not a connected Text node, on an ambiguous caret, on more than one block, and on a target whose rendered image is not verbatim. The bookmark gains `sv: { text, span } | null`; revalidation, the pending check and `prepareChoice` compare the editor text instead of `textContent === exact`; apply splices only the rendered span, keeps the Task 611 coalescing pre-checkpoint and the single post-checkpoint, and posts the exact result. IR and WYSIWYG capture moved into `captureVisual` with no behavior change.
- Test adjustments (two, both reported): the S2a "carriage return" case assumed a multi-line CRLF paragraph is offered and then fails at apply, but such a span has no verbatim image in the SV text and is declined at capture, as contract (3) requires; it now asserts that decline, and a separate case covers `planSvEdit` rejecting a replacement with a carriage return. The S2a "deletion boundary" case put the deletion inside the target, which already declines as non-verbatim; the deletion now sits between two blocks so only the ambiguous caret is under test. In `block-transform-command.test.ts` the old SV Find-deferral case now expects 0 inserted markers (the SV capture inserts none) and its module mock gained the two exports the command uses.
- Checks: `block-transform-sv.test.ts` 24 passed; the whole `media-src/src/editing` suite plus `module-boundaries.test.ts` passed (100 files, 2,629 tests); `npm run lint`, `npm run typecheck`, `knip`, `depcruise:webview` and `jscpd` exit 0.

### S3 results (2026-11-01)

Chromium cases in `media-src/e2e/turn-into-non-round-trip.spec.ts` (five new `S3` cases, SV harness mode):

- Direct SV, IR→SV and WYSIWYG→SV on the large fixture: Heading 2 on the near paragraph posts exactly the planned exact bytes (differing from the rendered plan, bytes outside the target unchanged), the editor text changes only by the inserted `## ` at the target, the caret is collapsed at the expected offset inside the new block, one native Undo returns the exact baseline and the rendered baseline, and Redo returns the plan.
- The small control (F5b-shaped document) behaves the same.
- An SV caret on an element offset (not a text position) opens no choice and posts nothing.
- Result: the five cases pass, and the whole spec file passes (15 of 15) on a temporary free-port configuration because port 9123 was held by another session. The cases passed on first run: the apply path was already completed in S2b, so no product change was needed in this step; the RED evidence for the same behavior is the S2a unit run (22 failures before S2b). One case of my own needed a fix (it used the editor root at offset 0, which is the focus sentinel that retains an earlier capture, not an element-offset decline).
- Not covered here: Details pending state (S4) and real-VS-Code save/reopen and OS Undo (S5).

### S4 results (2026-11-01)

The handoff expected Details' passive SV capture to insert markers and split Text nodes, so S4 planned a guard in `details-toggle.ts`. Reading the code contradicts that for SV: `captureCalloutActionTarget` has a separate SV branch that computes offsets from the live Range and `getValue()` and inserts no markers (`callouts.ts`). Only IR and WYSIWYG use the marker capture, and in production they always run the indexed branch, which already defers while a choice is pending. The S1 "pending choice" baseline (4 added and 2 removed Text nodes) was therefore mis-attributed: it was recorded while the old Turn Into request ran its own marker capture (before S2b), not Details. Correction to the S1 section: passive Details activity in SV does not mutate the editor.

- No product change was made: a guard in the SV branch would defer a capture that changes nothing. Nothing else in `details-toggle.ts` needed to change for SV.
- Tests that prove acceptance item 4 for SV (both pass on the current code, so there was no RED to show):
  - `details-toggle-controls.test.ts`: with a real pending SV choice, a passive Details update runs (its capture is called) with no marker insertion and no DOM mutation, the token still applies and posts the exact bytes (apply) or cancels cleanly (cancel), and Details keeps tracking the selection afterwards.
  - `media-src/e2e/details.spec.ts` (Chromium, SV): a pending choice survives a settled selection update with zero DOM mutation records, applies (posts the exact Heading 2 plan) or cancels, and the pinned Details control is enabled again for the next selection. The Details harness gained the Turn Into command wiring and a small `__details.turnInto` hook (request, apply, cancel, posted).
- Checks: Vitest `details-toggle-controls`, `details-turn-into-pending`, `details-toggle` 47 passed; Chromium `details.spec.ts` 13 passed (temporary free-port configuration, port 9123 busy); `npm run lint` and `npm run typecheck` exit 0.
- The real-VS-Code rerun of `details-toolbar.spec.ts` stays in S5.

### S5 results (2026-11-01)

Real-VS-Code cases in `test/vscode-e2e/turn-into-non-round-trip.spec.ts` (describe `Task 605 real VS Code SV`; native QuickPick, XTEST keys, exact host and disk checks):

- R5 direct SV, R6 IR→SV, R7 WYSIWYG→SV (large fixture): a caret in the near paragraph opens the QuickPick with the paragraph as current type and Heading 2 offered; the request leaves host and disk unchanged; choosing Heading 2 makes the host and (after save) the disk equal the exact plan with every other byte unchanged; the Undo depth grows; one OS Undo returns host and disk to the exact original; R5 also redoes, saves and reopens in SV with host and disk equal to the plan.
- R8 the small control (F5b-shaped): offered, applied and undone the same way.
- R9 an SV selection whose endpoint is an element offset: the command opens no QuickPick and host and disk stay unchanged (no post).
- The Task 604 IR and WYSIWYG real-VS-Code controls (R1–R4) and `details-toolbar.spec.ts` pass in the same run.
- Result: the five SV cases passed in a first run and again together with R1–R4 and `details-toolbar.spec.ts` (10 passed, 2.5 minutes). No product change was needed. The runs went through the shared token wrapper (the first waited about 28 minutes for another session's run).

All four acceptance items now have unit, Chromium and real-VS-Code evidence. The remaining work is closure (focused gates, `npm run quality`, final review).

### R1 repair results (2026-11-01)

An independent review of S2b–S5 raised three test or edge gaps; all are fixed.

- **Cancel case proves the choice was pending.** In the Details SV cases the choice observer now reports `true` right before the outcome and `false` right after apply or cancel.
- **Editor-text gate tested alone.** A new case swaps U+00A0 for a space in the editor text: `getValue()` maps U+00A0 to a space and stays equal, so only the `svText === bookmark.sv.text` gate can decline the apply; it does, and nothing is posted.
- **Line-end endpoints in CRLF documents.** The SV text has no carriage returns, so at a CRLF line end the character after an endpoint is a newline in the editor but a carriage return in the exact source, and a range ending there was declined although the alignment mapped it correctly. The character check now looks at the character before a range end or caret and after a range start. A caret at a CRLF line end sits between two exact offsets (before the carriage return, and between it and the newline); only the first is a text boundary, so it is chosen, while two real text boundaries (a deleted blank line) still decline. A new case covers a CRLF range end and caret at the line end (it failed before the fix: `expected null not to be null`).
- Info only, no change: the cached alignment keeps two document-sized strings alive.
- Checks: Vitest `media-src/src/editing` plus `module-boundaries` 100 files, 2,633 tests passed; Chromium `turn-into-non-round-trip.spec.ts` and `details.spec.ts` 28 passed; real VS Code `turn-into-non-round-trip.spec.ts` 9 passed (Task 604 R1–R4 and Task 605 R5–R9, through the shared wrapper); `npm run lint`, `npm run typecheck`, `knip` exit 0.

### S6 closure (2026-11-01)

- Focused gates (all after the last product change, R1): Vitest `media-src/src/editing` plus `module-boundaries` 100 files, 2,633 tests passed; Chromium `turn-into-non-round-trip.spec.ts` and `details.spec.ts` 28 passed; real VS Code `turn-into-non-round-trip.spec.ts` 9 passed (Task 604 R1–R4, Task 605 R5–R9) and `details-toolbar.spec.ts` passed in the S5 run (no product change since then touched Details); `npm run typecheck`, `npm run lint`, `knip` exit 0.
- `npm run quality`: `check:brand-identifiers`, `lint:ci`, `knip`, `jscpd`, `depcruise`, `test:coverage` (371 files, 7,957 tests passed, 1 expected failure) and `check:coverage-modules` pass; `audit` fails on dependency advisories in the shared dependency tree (`@azure/msal-node`, `@vitest/mocker`), which this task does not touch; recorded, not fixed.
- Acceptance items 1–4 are proven by: item 1 `block-transform-sv.test.ts` and real-VS-Code R5–R8; item 2 the decline cases there, the Chromium element-offset case and R9; item 3 Chromium S3 cases and real-VS-Code save, one OS Undo, Redo and reopen; item 4 `details-toggle-controls.test.ts`, `details.spec.ts` and `details-toolbar.spec.ts`.
- Known limits: a multi-block SV selection always declines (SV text is never the exact bytes, so the document never round-trips); a multi-line CRLF paragraph is not offered (its span has no verbatim image in the SV text); a replacement carrying a carriage return declines.

### Checklists

- [x] Implementation: SV proof module, capture, bookmark, revalidation, exact-span splice, history-transition decline, module manifest entry.
- [x] Verification: real-Lute unit, Chromium and real-VS-Code evidence for every acceptance item; focused gates and quality recorded above.
- [x] Task record: handoff, reconciliation, step results and corrections (S1 baseline, S4 contradiction) recorded.

### Checkpoint

All steps (S1–S6) and the review repair R1 are complete (2026-11-01). Ready to close.
