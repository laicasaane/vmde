# Task 604 — Turn Into on documents whose serialization does not round-trip

**Status:** Checkpoint 1 measured (2026-09-29). Implementation has not started. The owner decisions below remain open.
**Origin:** pre-existing limitation found during the Task 579 acceptance (CP2 Steps N3 and N4, 2026-09-28). Task 579 did not introduce it. The Task 579 N4 decision assigned it to a separate task.
**Recommended implementer effort:** high. The work touches the exact-vs-rendered source authority boundary.
**Tech stack:** TypeScript webview (`media-src/src/editing/block-transform-command.ts`, `editing/rewrap-command.ts`, `nav/source-block-index.ts`, `nav/block-handle.ts`), Vitest, Chromium Playwright, real VS Code with XTEST.
**Dependencies:**

- **[Task 196](done/196-find-and-replace.md)** (complete) owns the exact-vs-rendered source authority for Find and confirmed root cause 5. Reuse its approach; do not weaken its contract.
- **[Task 579](done/579-split-find-and-find-replace.md)** (complete) owns Find focus and the R1b deferred Turn Into capture. Run this task after Task 579 closes. Both tasks edit `block-transform-command.ts` and `test/vscode-e2e/block-transform.spec.ts`.
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

## Checkpoint 1 results — measurement only (2026-09-29)

The fixture SHA-256 is `a4a39d6f6c605eb82b0e03a236f67388bceeae9a85450b0d4285053b28299f65` (174,527 bytes; 174,517 characters). T_near is the first plain paragraph after the first table, line 208. The earlier static line-24 note identifies an emphasized secondary paragraph. T_far is the second case-insensitive token match, line 1297. The first differing table insertion boundary is offset 66 in IR and 74 in WYSIWYG. Source, DOM, and host values were compared without logging fixture text.

In the tables, `1` means true and `0` means false. `U` is real-Lute Vitest, `C` is Chromium, and `V` is real VS Code. V uses native QuickPick visibility as the options signal because its `window.vscode` API was not instrumentable. Work columns count the V request window; root Lute calls include calls made by `getValue()`. The later hover is a separate window.

The first V relay's WYSIWYG and SV editor-range setup collapsed before Turn Into. Relay 2 used the live caret authority and confirmed the token range remained selected in all three modes. The first relay's numeric reports remain under `tmp/task604-checks/cp1/vscode-relay1/`; the table uses the corrected relay.

| Mode | Route | U options | C options | V picker | V captures | V snapshots | V getValue | V markers | V root Lute | V fragments | V request index builds | V next-hover builds |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| IR | caret T_near | 0 | 0 | 0 | 1 | 1 | 1 | 1 | 2 | 0 | 0 | 1 |
| IR | range T_far | 0 | 0 | 0 | 1 | 1 | 1 | 2 | 2 | 0 | 0 | 1 |
| IR | Find T_far | 0 | 0 | 0 | 1 | 3 | 4 | 4 | 9 | 120 | 1 | 1 |
| WYSIWYG | caret T_near | 0 | 0 | 0 | 1 | 1 | 1 | 1 | 2 | 0 | 0 | 1 |
| WYSIWYG | range T_far | 0 | 0 | 0 | 1 | 1 | 1 | 2 | 2 | 0 | 0 | 1 |
| WYSIWYG | Find T_far | 0 | 0 | 0 | 1 | 3 | 4 | 4 | 9 | 120 | 1 | 1 |

The large block handle was hidden in IR and WYSIWYG in C and V. C's direct at-source verifier returned no options while its diagnostic oracle returned options. The small round-tripping control returned options through selection and handle in U/C and through native IR selection in V. The small normalizing control declined through selection and worked through the handle in U/C. A trusted edit elsewhere returned options in U/C and in V relay 1; V relay 2 declined after the caret-authority setup. Both V relays restored original host and saved disk bytes with OS Undo. This differing control outcome is unresolved; neither measurement was discarded.

| SV open path | Route | V picker | V captures | V snapshots | V getValue | V markers | V Lute |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| WYSIWYG switch | caret | 0 | 1 | 1 | 0 | 1 | 0 |
| WYSIWYG switch | range | 0 | 1 | 4 | 1 | 2 | 0 |
| WYSIWYG switch | Find | 0 | 1 | 5 | 2 | 2 | 0 |
| direct | caret | 0 | 1 | 1 | 0 | 1 | 0 |
| direct | range | 0 | 1 | 4 | 1 | 2 | 0 |
| direct | Find | 0 | 1 | 5 | 2 | 2 | 0 |
| small direct | caret | 0 | 1 | 3 | 0 | 1 | 0 |

SV had no block handle in C/V; C measured SV caret and Find declines, not an SV editor-range route. Find's focus-transfer window was deferred without capture or markers in IR/WYSIWYG. In V, the subsequent Find request restored the token range but did extra work inside that one-second native-command window: one index build and 120 fragment Lute calls. In relay 2 the next hover also built one index in both visual modes; C built its index on that hover without a request-phase build. SV Find's zero-Lute decline held, but its V focus-transfer snapshot count made `captureWasDeferred` false; C recorded true.

| Mode | U exact scan | C exact scan | C rendered scan | C pairs | C exact units | C list mismatches | C mapped paragraphs | C total paragraphs | V cold index builds | V cold root Lute | V cold fragments | V cold ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| IR | 387 | 387 | 387 | 1 | 0 | 64 | 164 | 166 | 1 | 4 | 120 | 1592.3 |
| WYSIWYG | 387 | 387 | 387 | 1 | 0 | 64 | 164 | 166 | 1 | 4 | 120 | 1282.1 |

D1–D3 agree in U/C: exact and rendered blocks pair, but the exact-unit projection rejects after fragment comparison, including 64 list-item differences. Thus the proposed direct use of `entry.units` and the large-fixture block-handle proof cannot serve as the complete capture solution. Document alignment mapped 164/166 direct-child paragraphs; T_near and T_far mapped through Find, whereas the emphasized paragraph, paragraph pair, and table boundary showed narrower limits. D3 mapped endpoints where exact/rendered spans paired, but endpoint mapping alone did not prove the whole selection. U's CRLF diagnostic (D4) failed document-level caret mapping and mapped single-line carets at block scope. U's optional D7 construct checks are in the S1 probe result.

| Visual mode | C setValue | C exact post | C outside bytes unchanged | C exact Undo | C exact Redo | C two Undos exact |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| IR | 1 | 1 | 1 | 0 | 0 | 0 |
| WYSIWYG | 1 | 1 | 1 | 0 | 0 | 0 |

| V control mode | Small apply | One OS Undo restores host | Saved disk restores |
| --- | ---: | ---: | ---: |
| IR | 1 | 1 | 1 |

D5's C at-source oracle applied one Heading 2 transform in each visual mode, posted the exact-byte plan rather than the rendered-byte plan, and left bytes outside the target unchanged. C Undo restored the rendered baseline but did not restore exact authority; Redo and two consecutive Undos also failed their exact checks. The V diagnostic oracle was unavailable through production's exposed surface. The V small IR round-tripping control applied Heading 2 and restored exact host/disk bytes with one OS Undo. Large-fixture product Undo remains unmeasured because R1/R2 declined before the QuickPick; this evidence does not attribute C's exact-history loss conclusively to harness wiring or production behavior. WYSIWYG and SV positive V cases await Owner decision 2.

| Document/mode path | Exact characters | C rendered characters | V rendered characters |
| --- | ---: | ---: | ---: |
| large IR | 174517 | 181855 | 181855 |
| large WYSIWYG | 174517 | 181842 | 181842 |
| large WYSIWYG→SV | 174517 | 181844 | 181844 |
| large direct SV | 174517 | 174527 | 174529 |

| V SV path | SV text minus exact | SV host serialization equals exact |
| --- | ---: | ---: |
| large WYSIWYG switch | 7327 | 0 |
| large direct | 11 | 0 |

D6 measured distinct SV paths. The small V SV control had 32 exact characters, 35 rendered characters, and a text-content surplus of 2; its host-style serialization still differed from exact and Turn Into declined. The C small SV control used a different 17-character source, so its one-character surplus and host-style equality are not a same-source parity claim. WYSIWYG's 181,842-character C/V rendering is one character shorter than the 181,843-character U rendering and the earlier static estimate. The V direct-SV rendered output is two characters longer than C's direct-SV output. These are measured environment/route differences, not evidence that rendered bytes became exact.

R1 and R2 each failed at the intended QuickPick assertion within the one-second window. Their host and disk copies remained byte-identical to the fixture. R2's Find input received the exact OS-typed token and reached the second match; the editor range was restored at the command. C1–C4 and V1–V5 remain expected-fail regression tests until the approved capture proof exists.

Evidence status from the Part 1 handoff (§9): E1 outcome matrix is measured in U/C/V, including valid V WYSIWYG/SV editor ranges in relay 2. E2 request counters and cold-build costs are recorded for approved routes (V success ceiling is IR only). E3 exact-unit failure is measured in U/C; E4 document/Find mapping and E5 block-scoped endpoint mapping are measured in U/C. E6 oracle apply is measured in C and real small-document Undo in V, with the large exact-history cause unresolved. E7 SV direct/switch/control lengths and E8 handle visibility are measured in C/V. E9 controls and index churn are measured in U/C/V within the approved V scope; the V trusted-edit control has differing outcomes across two runs. E10 commands, exit codes, fixture hash, environment and deviations are recorded below. D4 ran in U; optional D7 ran in U.

Verification and evidence (all commands from the repo root; browser and VS Code relays ran in the orchestrator's shell, with Xvfb/Openbox for S4):

| Step / requesting Codex run | Command or evidence | Exit code | Result |
| --- | --- | ---: | ---: |
| S1 `20260928-233113-604-cp1-s1` | `node node_modules/vitest/vitest.mjs run --config tmp/task604-checks/cp1/vitest.config.mts` | 0 | 1 passed |
| S2 `20260928-234928-604-cp1-s2` | `npx vitest run --config test/vitest.config.mts media-src/src/editing/block-transform-non-round-trip.test.ts` | 0 | 5 passed, 8 expected failures |
| S3 relay 1 (requested by S3 run `20260929-004335-604-cp1-s3`) | Chromium focused spec | 1 | 3 setup failures; retained |
| S3 relay 2 (requested by S3 r1 `20260929-014923-604-cp1-s3-r1`) | `xvfb-run -a npm --prefix media-src run test:e2e -- turn-into-non-round-trip.spec.ts --workers=1 --retries=0` | 0 | 5 passed, including 4 expected failures |
| S3 relay 1 (requested by S3 run `20260929-004335-604-cp1-s3`) | `npx vitest run --config test/vitest.config.mts test/backend/harness-registry.test.ts` | 0 | 5 passed |
| S4 relay 1 (requested by S4 run `20260929-020224-604-cp1-s4`) | Xvfb/Openbox, `VMDE_XTEST=1 VMDE_PROBES=1 npm --prefix test/vscode-e2e test -- turn-into-non-round-trip.spec.ts --workers=1 --retries=0` | 0 | 5 passed, including 2 expected failures |
| S4 relay 2 (requested by S4r+S5 `20260929-022807-604-cp1-s4r-s5`) | Same Xvfb/Openbox command; valid WYSIWYG/SV ranges | 0 | 5 passed, including 2 expected failures |
| S3/S4 | `node build.mjs`; `npm run typecheck`; focused Biome; `npx jscpd --config .jscpd.json` | 0 | 0 new-file clones |
| S4 | `npm run typecheck:vscode-e2e` | 1 | 1 inherited TS2339 |

Current focused commands after the probe-file split: run R0 measurements with `VMDE_XTEST=1 VMDE_PROBES=1 npm --prefix test/vscode-e2e test -- turn-into-non-round-trip-probe.spec.ts --workers=1 --retries=0`; run the R1/R2 regression assertions with `VMDE_XTEST=1 npm --prefix test/vscode-e2e test -- turn-into-non-round-trip.spec.ts --workers=1 --retries=0`. Both need the same Xvfb/Openbox session used for S4. The S4 rows above retain the commands actually run before the split.

CP1 unit-gate repair after `01b12c63`: the three R0 tests now follow the probe-file convention, while R1/R2 remain in the default spec; V6 and V7 use 60-second real-Lute timeouts, matching the existing heavy-unit bound. Focused Vitest passed (8 passed, 8 expected failures), focused Biome and jscpd passed, and Playwright discovery found R1/R2 by default and all five with `VMDE_PROBES=1`. Focused coverage ran the tests successfully but exited 1 on the expected whole-repository coverage threshold because only two files were selected. `npm run typecheck:vscode-e2e` still reports only the inherited TS2339 at `preview-task-checkbox.spec.ts:122`. The full coverage and real-VS-Code relays followed with the results below.

Repair relay (`tmp/queue-relay/coverage2.log`, `ratchet2.log`, `tmp/task604-checks/cp1/relay/repair-vscode.log`): full `npm run test:coverage` exited 0 (318 files; 4,938 passed, 9 expected failures), and `npm run check:coverage-modules` exited 0 (11 zero-coverage modules against baseline 13). The first post-split real-VS-Code run exited 1: R0 A/B passed, R1/R2 reached their expected failures, and R0 C failed at the trusted-edit one-Ctrl+Z assertion because host and saved disk bytes did not return to the original. Its small-document apply/Undo control passed and its trusted-edit QuickPick opened. Discriminating R0 C runs on clean `01b12c63` failed with the split (`tmp/task604-checks/cp1/relay/r0c-base.log`) and passed with the original spec (`r0c-base-orig.log`); the current tree with the split also failed (`r0c-cand.log`). Task 600 is therefore not required for the failure. The split made R0 C sensitive to Vditor's debounced Undo checkpoint: the test acknowledged the typed edit but had not awaited its history entry. R0 C now waits for the opening and typed-edit stack entries while preserving its single Ctrl+Z and exact-byte assertions. The post-fix real-VS-Code relay (`repair-vscode-r2.log`) exited 0 with 5 tests passing, including R1/R2's 2 expected failures. R0 C recorded stack lengths 1 before typing and 2 before Undo, then restored exact host and saved disk bytes. No assertion was relaxed.

An intermediate S1 table-target precondition exited 1 because it assumed an unmappable original character; the corrected insertion-boundary probe passed, and the failed log is retained under `tmp/task604-checks/cp1/`. S3 relay 1 failed three Find setup assertions before the intended red assertions; relay 2 corrected that test-side condition. S4 relay 1 passed but its WYSIWYG/SV attempted ranges had collapsed; relay 2 proved those ranges before the measured requests. These diagnostic runs are separate from product regressions and the final focused results above.

The inherited type error is `preview-task-checkbox.spec.ts:122` (`Window.vditor`). `npm run quality`, full real-VS-Code, and release gates were not run for this measurement checkpoint. S4 used VS Code 1.129.0, Electron 42.6.0, Chromium 148.0.7778.280, a mapped X11 client, the literal X11 launch flag, and XTEST input. Diagnostic outputs contain only numbers/booleans and stay under `tmp/task604-checks/cp1/` and `/tmp/`; those paths remain excluded from the commit.

Part 1 design questions remain: which rendered-unit and exact-span proof can survive the 64 list mismatches while keeping the warm capture cost within the observed decline count; whether the approved mode scope includes SV; whether non-round-tripping multi-block selections should decline; whether Rewrap remains a separate follow-up; how to prove large-document exact Undo after the C oracle/history discrepancy; and whether V's trusted-edit outcome depends on caret-authority setup or another state difference. No Checkpoint 2 approach is approved by these measurements.

## Implementation checklist

- [x] Checkpoint 1 — measure: on the large fixture, record Turn Into capture per mode (IR/WYSIWYG/SV) from an editor selection, from Find and from the block handle. Record the counters (`getValue`, root/fragment Lute calls, index builds, `blockTransformCaptureCalls`). Add the red tests below.
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
