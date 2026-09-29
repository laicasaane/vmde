# Task 604 — Turn Into on documents whose serialization does not round-trip

**Status:** done (2026-09-29). Checkpoints 2–4 and S7/S8 are accepted with the documented residuals; move to `tasks/done/` is requested with the docs commit.
**Origin:** pre-existing limitation found during the Task 579 acceptance (CP2 Steps N3 and N4, 2026-09-28). Task 579 did not introduce it. The Task 579 N4 decision assigned it to a separate task.
**Recommended implementer effort:** high. The work touches the exact-vs-rendered source authority boundary.
**Tech stack:** TypeScript webview (`media-src/src/editing/block-transform-command.ts`, `editing/rewrap-command.ts`, `nav/source-block-index.ts`, `nav/block-handle.ts`), Vitest, Chromium Playwright, real VS Code with XTEST.
**Dependencies:**

- **[Task 196](196-find-and-replace.md)** (complete) owns the exact-vs-rendered source authority for Find and confirmed root cause 5. Reuse its approach; do not weaken its contract.
- **[Task 579](579-split-find-and-find-replace.md)** (complete) owns Find focus and the R1b deferred Turn Into capture. Run this task after Task 579 closes. Both tasks edit `block-transform-command.ts` and `test/vscode-e2e/block-transform.spec.ts`.
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

At intake, the Task 579 N4 real-VS-Code case `Task 579 non-round-tripping paragraph declines Turn Into equally from Find and editor selection` (`test/vscode-e2e/block-transform.spec.ts`) asserted this decline as known behavior: no QuickPick and unchanged host bytes, from Find and from an editor selection. Checkpoint 4 replaced it with positive acceptance.

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

## Owner questions at intake

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

At the Part 1 measurement boundary, the open questions were which rendered-unit and exact-span proof could survive the 64 list mismatches within the warm capture budget; whether to include SV or non-round-tripping multi-block selections; whether Rewrap should be separate; how to prove large-document exact Undo; and why V's trusted-edit setup differed. Those measurements alone did not approve a Checkpoint 2 approach. The Owner decisions and accepted result appear in the final closure section below.

## Checkpoint 2 S6 — production bind and focused acceptance (2026-09-29)

This section records S6 evidence; the final closure section reconciles the implementation and acceptance checklists below. The approved visual-mode scope is IR and WYSIWYG. SV and Rewrap remain follow-up work; a non-round-tripping multi-block selection declines.

The webview now binds Turn Into to the shared source index with the uncounted exact/rendered snapshot pair and unbinds on disposal. After a measured passive Details fallback inserted live markers and canceled a Find-route choice, Details began deferring that fallback while a Turn Into choice is pending. Pending selection identity follows source-neutral Undo text-node splits but still cancels a genuinely changed selection; missing revision authority does not authorize cached-proof reuse or deferred Find capture. R1–R4 verify native QuickPick, exact Heading 2 host/save bytes and one OS Undo in both visual modes; R1 also verifies Redo and reopen. The Task 579 N4 decline case was replaced by a positive Find and editor-selection case while its small round-tripping case remains.

Pre-review focused relay requested by run `20260929-094728-604-s6-r8`, reported in `20260929-100741-604-s6-r9`:

| Gate | Evidence | Result |
| --- | --- | --- |
| Chromium `block-transform.spec.ts` + `turn-into-non-round-trip.spec.ts` | `tmp/task604-checks/cp2/s6-r8-chromium.log` | exit 0, 25/25 |
| Real VS Code same pair, XTEST in Xvfb/Openbox | `tmp/task604-checks/cp2/s6-r8-pair.log` | exit 0, 13/13 |
| Real VS Code R1/R3 caret and Task 579 Find Next, each repeated three times | `tmp/task604-checks/cp2/s6-r8-repeat.log` | exit 0, 9/9 |
| Earlier real-VS-Code performance and interaction gates (before the r8 identity repair) | `tmp/task604-checks/cp2/gates-vscode.log` | exit 0, 27/27 |

The earlier broad Chromium gate passed 91/93; its two `block-transform.spec.ts` failures prompted the r8 repair and both passed in the final focused Chromium pair. The five related Vitest files passed 101/101 with focused command coverage at 92% of lines. Build, webview typecheck, whole-tree lint, jscpd and dependency-cruiser passed. `npm run typecheck:vscode-e2e` retains only the inherited `preview-task-checkbox.spec.ts:122` TS2339. `npm run quality` exited 1: four former-brand identifiers, existing unused exports, vendor audit DNS failure, and 49 full-unit failures whose names all match the earlier Task 600 S4 sandbox baseline (Git/child-process `EPERM`); the aggregate coverage-module check then lacked a summary file. These residuals and the local Chromium `listen EPERM` attempt are detailed in `tmp/task604-checks/cp2/s6-r8-findings.md`. No repository-wide green quality claim is made.

Independent review follow-up `20260929-101239-604-s6-r10`: the host had early return paths that dropped a validated Turn Into token without posting `cancel-block-transform-choice`. The S6 repair makes every validated-token drop in the options and consent handlers post one cancel, including inactive or invalid options, picker dismissal, warning/language dismissal, and stale host state. The post-repair real-VS-Code relay is recorded below. Residual for Task 605: the Details pending-choice guard applies to the indexed exact fallback; SV and other index-less passive capture can still run while a choice is pending. That broader behavior is outside Task 604's approved visual-mode scope and remains follow-up work.

R10 local verification: `test/backend/editor-session.test.ts` passed 48/48; the Details/pending and block-transform webview unit files passed 31/31. The focused host coverage report exercised every changed executable line; its command exited 1 solely because focusing on this large session module yields 44.17% function coverage below the repository-wide 54% threshold. `node build.mjs`, `npm run typecheck`, focused Biome, jscpd, and `git diff --check` passed. Strict typing retained the same 15 diagnostics outside the changed code, and VS Code test typing retained only `preview-task-checkbox.spec.ts:122` TS2339. Logs and changed-line evidence are under `tmp/task604-checks/cp2/s6-r10-*`.

R10 relay reported in `20260929-102952-604-s6-r11`: the post-repair real-VS-Code pair plus `details-toolbar.spec.ts` passed 14/14 (`tmp/task604-checks/cp2/s6-r10-vscode.log`). The outside-sandbox full `npm run test:coverage` exited 1 with 319/320 files passing and one timeout: the new handle-origin Details test took 7,808 ms against the default 5,000 ms limit (`tmp/task604-checks/cp2/s6-coverage.log`). The ratchet did not run in that relay. Its file now gives that test and the other remaining real-Lute case explicit 60-second per-test limits, consistent with the file's existing cases and V6/V7; no behavior assertion changed. The later passing full coverage and ratchet relay is recorded below.

## Checkpoints 2–4 — decisions, final evidence and closure (2026-09-29)

The Project Owner chose the shared indexed **1-R** rendered-to-exact proof for IR and WYSIWYG. The proof pairs rendered blocks with exact source spans and declines unprovable endpoints; whole-document equality remains the sound fallback only on round-tripping documents. SV is [Task 605](../605-turn-into-source-mode.md). A non-round-tripping multi-block selection declines in this task, while existing round-tripping multi-block transforms remain supported. Rewrap and its other marker-capture users are [Task 606](../606-rewrap-non-round-tripping-documents.md). After the measured N3 cancellation, the Owner authorized the indexed Details pending-choice guard. Trusted-edit exact ownership N9 is [Task 607](../607-exact-actions-after-trusted-edit.md).

| Work | Dispatch run IDs and Codex settings | Result |
| --- | --- | --- |
| S0a/S0b history and trusted-edit controls | `20260929-053938-604-s0a`, `20260929-055428-604-s0b` — sol-max | Browser timing P1–P5 and R0 setups recorded before the source proof. |
| S1/S2 inverse alignment and shared rendered map | `20260929-061048-604-s1`, `20260929-061703-604-s2` — sol-max | Tested and committed in group A. |
| S3/S4 exact selection proof and block command | `20260929-062801-604-s3`, `20260929-063717-604-s4` — astra-xhigh | Real-Lute source proof, apply guards and exact payload tested; group A. |
| S4b and group A review repair | `20260929-064421-604-s4b` — sol-max; `20260929-065421-604-a-review-fix` — sol-max | Multi-block decline, warm budget, CRLF, marker and stale-state cases; review repair retained. |
| S5 Chromium harness and acceptance | `20260929-070540-604-s5` through `20260929-072404-604-s5-r2` — astra-xhigh, then sol-max/low repairs | Group B exact history and C1–C8 coverage. |
| S6 production bind, native acceptance and review repair | `20260929-072511-604-s6` through `20260929-094728-604-s6-r8` — astra-xhigh; `20260929-100741-604-s6-r9` — sol-high; `20260929-101239-604-s6-r10` — sol-max; `20260929-102952-604-s6-r11` — sol-high | Group C committed as `8b546d1f`; the final relays below include the host cancellation review repair. |
| S7/S8 gates and records | `20260929-103640-604-s7-s8` — sol-high | Network-free gates and task lifecycle recorded here. |

| Final evidence on group C HEAD `8b546d1f` | Result | Evidence |
| --- | --- | --- |
| Full unit coverage | exit 0; 320/320 files, 5,046 passed and one expected failure | `tmp/task604-checks/cp2/s6-coverage2.log` |
| Zero-coverage-module ratchet | exit 0; 11 at 0% versus baseline 13 | `tmp/task604-checks/cp2/s6-ratchet2.log` |
| Chromium block-transform plus exact Turn Into | exit 0; 25/25 after both earlier Chromium gate failures were repaired | `tmp/task604-checks/cp2/s6-r8-chromium.log` |
| Real-VS-Code block-transform, Turn Into and Details | exit 0; 14/14 with XTEST after the host review repair | `tmp/task604-checks/cp2/s6-r10-vscode.log` |
| R1/R3 caret plus Task 579 Find Next, three repetitions each | exit 0; 9/9 before the host-only cancellation repair | `tmp/task604-checks/cp2/s6-r8-repeat.log` |
| Broader real-VS-Code performance/interaction gates | exit 0; 27/27 before the r8/r10 repairs | `tmp/task604-checks/cp2/gates-vscode.log` |
| R0 probes | exit 0; 3/3 | `tmp/task604-checks/cp2/s6-probe.log` |

The broader Chromium run passed 91/93 before r8; its two failures were in `block-transform.spec.ts` and both passed in the later focused 25/25 run. The full real-VS-Code fast tier was not rerun after the host repair; the final targeted 14/14 run and prior 27/27 gate are the available evidence. R1–R4 prove exact host and saved disk bytes, one OS Undo and unchanged bytes outside the target in both visual modes; R1 also proves Redo and save/reopen. C1–C8 include unprovable-selection decline, CRLF, multi-block refusal and exact Chromium history. The retained small Task 579 round-trip control and positive N4 replacement passed in the 14-case real-VS-Code pair.

S7 ran the remaining network-free checks once on HEAD; exact commands, exit codes and logs are in `tmp/task604-checks/cp4/s7-results.json`. `lint:ci`, jscpd, dependency-cruiser, regular webview typecheck and `git diff --check` passed. Dependency-cruiser warned that its TypeScript transpiler does not support TypeScript 7. Knip exited 1 on the same nine unused exports and one exported type as before Task 604; `RenderedPlan` and `blockMapOffset` are consumed by the new proof. The former-brand check retained four violations outside this task. Strict typecheck retained 15 diagnostics outside the changed paths; VS Code test typecheck retained only `preview-task-checkbox.spec.ts:122` TS2339. The dependency audit was omitted by Owner instruction. Bundle/startup budget checks are reporting-only and exited 1: `media/dist/main.js` is 916,137 bytes (5,182 over the prior 910,955-byte snapshot) and 347 eager modules (one over the prior 346), against 608 KB and 294-module budgets. These residuals keep an aggregate `npm run quality` claim red; they do not change the focused acceptance result.

The independent review's host token-drop finding was fixed in group C: validated options, picker and consent drop paths now send exactly one cancel, and a handle-origin token resumes Details after the matching cancel. Its comment-accuracy finding was also fixed. Its SV/index-less Details observation remains with Task 605. Other bounded observations remain separate: R0's `addRange` setup opened the picker but did not keep the target range or offer Heading 2; caret-authority setup did (`tmp/task604-checks/cp2/s0b-vscode-r1.log`). The same diagnostic recorded a caret-only Undo checkpoint after the trusted edit, without changing the final one-Undo Turn Into acceptance. Vditor's transient `span.vditor-wbr` inserts/removes advance the shared index's DOM revision even though Markdown is unchanged (`tmp/task604-checks/cp2/s6-r7-attribution.md`); no index classifier fix was included. C6 P5b observed that two immediate Redos can leave exact authority behind the second plan (`tmp/task604-checks/cp2/s0a-report.md`); it does not weaken the accepted one-step Undo and R1 Redo. Task 607 owns the broader N9 risk after trusted input, and Task 606 owns Rewrap's distinct whole-document marker mapping.

## Implementation checklist

- [x] Checkpoint 1 — measure: on the large fixture, record Turn Into capture per mode (IR/WYSIWYG/SV) from an editor selection, from Find and from the block handle. Record the counters (`getValue`, root/fragment Lute calls, index builds, `blockTransformCaptureCalls`). Add the red tests below.
- [x] Checkpoint 2 — implement the approved capture proof in `block-transform-command.ts`. Keep `bookmark.exact` from `snapshotExactMarkdown()` only.
- [x] Checkpoint 3 — apply and history: confirm exact-only block changes, one Undo and exact save in every approved mode.
- [x] Checkpoint 4 — replace the Task 579 N4 decline assertion with the positive large-fixture cases. Keep the small round-tripping case.

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

- [x] Turn Into opens the QuickPick on the large fixture from an editor selection and from Find, in every approved mode (R1–R4).
- [x] The transform changes only the target block's exact bytes; R1–R4 prove host/disk plans and R1 proves save/reopen.
- [x] One OS Undo restores the exact baseline and a subsequent save is byte-identical in R1–R4.
- [x] Task 604's new source-proven path plans from the exact snapshot and never posts its rendered bytes as exact (C1–C8 and R1–R4); Task 607 records the separate pre-existing post-trusted-input authority gap.
- [x] Unprovable selections decline without a partial or approximate edit (V6 and C8 controls).
- [x] The Task 579 N4 decline case is replaced by positive Find and editor-selection cases, with its round-trip control retained.
- [x] Task 573/574/578 performance gates passed in the recorded 27-case relay and focused post-repair runs; quality residuals and the intentionally omitted dependency audit are recorded above.
