# Task 710 — marker-reveal: the caret still lands in the closing marker after End

**Status:** ✅ done (2026-11-08).
**Origin:** Split from [Task 708](708-undo-snapshot-caret-restore-moves-the-caret-back-into-a-marker-or-to-offset-0.md) at its closure. Task 708 fixed the Undo snapshot restore that moved an element-boundary caret back into the closing marker; `marker-reveal.spec.ts` still fails without that writer.
**Severity:** medium (estimated). After End, the next typed character can land inside a hidden closing marker.
**Tech stack:** the marker-reveal frame in `media-src/src/editing/editor-caret.ts`, caret intents in `media-src/src/editing/caret.ts`, the vendored Vditor IR input path; specs `test/vscode-e2e/marker-reveal.spec.ts`, `test/vscode-e2e/rewrap.spec.ts`, `test/vscode-e2e/github-inline-math.spec.ts`.
**Depends on:** none.

## Problem

After Task 708, `marker-reveal.spec.ts` fails 3 of 6 runs (4 of 6 on the parent `6844f1af`) in `navigateAndType`: after the key, the caret's parent class contains `vditor-ir__marker`. The writer is not known. The Undo snapshot restore is excluded: `undo-snapshot-caret.spec.ts` passes 18 of 18 with the Task 708 fix.

`rewrap.spec.ts:323` failed 2 of 8 runs before Task 708 with caret offset 0 instead of 13 in the first IR iteration after open. It did not reproduce in 8 + 12 + 12 runs since; its mechanism is unmeasured.

Added at the Task 698 closure: `github-inline-math.spec.ts:351` (SV) fails alone at `:374` (typed source differs from the selected-source expectation). Task 698 Part 2a classed it as the Undo snapshot (`addCaret` ← `sourceNeutral`) moving a caret placed after the snapshot was armed. Task 708's fix covers only an Element-container caret; the SV caret sits in a Text node.

## Proposed work

1. Measure first: record every selection write (stack and timestamp) between End and the typed key in a failing `marker-reveal` run, as Task 703 Part 2c did.
2. Write a failing test for the measured writer.
3. Fix the product cause, or the spec if the spec is wrong (state which, with evidence).
4. Rewrap offset 0: keep a probe running alongside; if it reproduces, measure the writer; if it does not reproduce in 24 runs, record that and close the item.

## Acceptance

- [x] The writer that puts the caret back in the marker is measured. Evidence: Part 1 handoff (settle re-spin `restoreLiveSelection`).
- [x] A focused test fails before and passes after the fix. Evidence: `edit-activity.test.ts` Task 710 cases, RED then GREEN.
- [x] `marker-reveal.spec.ts` passes 6 of 6 runs with no retry. Evidence: 12 of 12.
- [x] `github-inline-math.spec.ts:351` (SV) passes, or its writer is measured and fixed. Evidence: W2 plus the spec selection fix, 12 of 12.
- [x] The rewrap offset-0 case is measured, or recorded as not reproduced in 24 runs. Evidence: not reproduced in 57 runs (Tasks 708 and 710).
- [x] `npm run quality` passes. Evidence: orchestrator rerun, all 8 stages pass.

## Part 1 handoff (2026-11-08)

Measurement only. No product or test change. One `node build.mjs` (exit 0). Three real-VS-Code wrapper calls, `--workers=1 --retries=0`, Openbox with the tracked config. Probe copies (untracked, kept under `tmp/710/specs/`): `zz-tmp710-marker.spec.ts` (the six `navigateAndType` samples of `marker-reveal.spec.ts`; the check is recorded instead of thrown, so every sample of a run is measured), `zz-tmp710-svmath.spec.ts` (the SV test of `github-inline-math.spec.ts` only), `zz-tmp710-rewrap.spec.ts` (the first IR iteration of `rewrap.spec.ts` up to the `:323` caret check), and the trace helper `zz-tmp710-trace.ts`. Dumps: `tmp/710/out-run1/`, `tmp/710/out-run2/`, `tmp/710/out-run3/`; logs `tmp/710/run{1,2,3}.log`. Tools: `tmp/710/show.mjs` (trace window with stacks mapped through `media/dist/main.js.map`), `tmp/710/classify-marker.mjs` (per-sample order of writers).

The trace wraps every `Selection` writer (`addRange`, `setBaseAndExtent`, `collapse`, `removeAllRanges`, `extend`, …), writes through the live Range, `window.__vmdeRequestCaret`, `__vmdeWriteSelection`, `__vmdeRestoreUndoSnapshotCaret` and `undo.addCaret`, with time, anchor and focus after the write, and the caller stack. It also logs `selectionchange`, key, input, pointer and focus events, and mutation batches on the editor.

### Runs and failure counts

| Case | Runs | Failing runs | Notes |
| --- | --- | --- | --- |
| `marker-reveal` `navigateAndType` | 25 (1 + 24) | 9 (1 + 8) | 13 failing samples of 150 (6 per run): Home code ×3, End bold ×4, End link ×5, End code ×1 (run 2 alone: 11 of 144). Typed text was right in every sample. |
| `github-inline-math` `:351` SV | 27 (1 + 24 + 2) | 27 | Fails at `:374` in every run: deterministic. |
| `rewrap` `:323` offset 0 | 25 (1 + 24) | 0 | Final caret offset 13 and value correct in 25 of 25. |

### Case 1 — `marker-reveal`: the settle re-spin restore arms a caret intent at the unejected marker landing

Writer: `restoreLiveSelection` (`media-src/src/editing/edit-activity.ts:361-365`, the `requestCaret({ anchor, focus })` call at `:364`), called from `settleRespin` (`:466`), which the Task 180 prose skip schedules 220 ms (`QUIET_MS`, `:42`) after the previous sample's typed key. Class: **a caret intent** (not the Undo snapshot, not the marker-reveal frame).

Measured sequence in every failing sample (11 of 11 in run 2; run 1 shows the same):

1. The previous sample typed one character in another paragraph. The prose skip deferred its spin to the settle (`trySkipFenceSpin`, `deferUntilSettle(RESPIN_KEY, …)`).
2. `keydown Home/End` (trusted). The native caret lands in the closing or opening marker (`#text("**")@2`, `")"@1`, `` "`"@1 ``, `` "`"@0 ``). A `selectionchange` follows; the marker-reveal frame (`editor-caret.ts` `apply`) is scheduled for the next animation frame.
3. Before that frame runs, the settle fires (21–41 ms after the key). `captureLiveSelection` keeps the marker landing (the caret is in another block). `placeCaretAtTarget` writes a temporary caret in the typed paragraph, `dispatchRespin` spins it (`setRangeByWbr` writes there), and `restoreLiveSelection` writes the kept endpoints back with `requestCaret`. The marker text node survived the spin, so the endpoint resolves to the same node and offset: the caret is back in the marker, and a live caret intent is armed.
4. The marker frame then runs with `hasLiveCaretIntent()` true. `allowVisibleMarkerEdit: allowVisibleMarkerEdit || hasLiveCaretIntent()` (`editor-caret.ts:565`) makes `normalizeMarkerNavigationCaret` keep the landing (the node is in `previouslyExpanded`). No ejection write appears in any failing sample.
5. The intent re-asserts the marker position on each frame until the typed key's `keydown` retires it. The spec reads the marker class (`:165`), and the key is inserted into the marker text (`**b`, `)l`); Lute's re-spin turns that into the expected markdown, so the typed text is right.

Separation (run 2, 144 samples): 29 samples had a settle re-spin inside the window. 18 had the ejection write first (`normalizeMarkerNavigationCaret` → `requestCaret` to `(p, index ± 0|1)`), then the re-spin restored `(p, k)`: all passed. 11 had the re-spin before the ejection: all failed. 115 samples had no re-spin in the window: all passed, each with an ejection write. No failing sample without the re-spin; no other writer between the key and the check (one transparent `restoreUndoSnapshotCaret` write in a passing Home sample).

Why it is intermittent: the spec types the previous sample, waits for the markdown, places the caret (the placement poll waits 50 ms), and presses the key. That puts the key about 150–200 ms after the typed character, so the 220 ms settle often lands in the 10–30 ms between the key and the marker frame. A user who types in one paragraph and presses Home or End in another within 220 ms meets the same race.

### Case 2 — `github-inline-math` `:351` SV: the action refuses before any edit (not a caret writer)

Class: **other** — a basis mismatch in the GitHub inline Math action, not a selection writer. Task 698 Part 2a's H2b (the Undo snapshot moving the selection) is not the cause.

Measured in every run (27 of 27): the inline item click runs the action (`run`, `media-src/src/editing/math-insertion.ts:766`). Its only selection write is `restoreRange` (`:776`, transparent, the same Range). No `setValue`, no SV Range edit and no mutation follow. About 6 ms later, the toolbar-click checkpoint (`undo-boundaries.ts:617-618`, a `setTimeout(…, 0)` after the click) takes an Undo snapshot (`addCaret(…, true)`), and its Text-container restore re-places the same text range onto the split text nodes. That snapshot runs after the action has already returned, so it does not cause the refusal.

Cause (run 3 marks plus the source): in SV `deps.snapshotMarkdown()` is edit-sync's `serializeSvForHost` (`media-src/src/bridge/edit-sync.ts:493-506`, Task 602 `83984892`). It drops Vditor's trailing `[data-type="newline"]` span. `window.vditor.getValue()` in SV is Vditor's `getMarkdown` (`vditor/src/ts/markdown/getMarkdown.ts`), the editor `textContent` plus `\n` with `/\n\n$/` → `\n`, which keeps that span's newline. Run 3 (2 of 2 runs, at every mark from the selection to the click): the last block ends in two `[data-type="newline"]` spans; `getValue()` ends `here.\n\n` and the replica of `serializeSvForHost` (same selector, same zero-width-space rule) ends `here.\n`; `valueEqualsHostReplica` is false. So `if (window.vditor.getValue() !== snapshot) return` (`math-insertion.ts:778`) returns on every SV run (inferred from the measured inequality and the source; the probe did not instrument `run` itself, so a later check in the same basis could be the one that refuses), and the document never gets the pending `` $`target`$ ``. The same basis feeds two later SV checks: `captureRewrapSourceRange` requires `mapped.markdown === authoritative` (`rewrap-command.ts:527`; SV `serializeForMode` is the editor `textContent`), and `replaceSvMarkdownRange` requires `editor.textContent === before` (`rewrap-command.ts:767`). The fenced Math action has the same lines (`math-insertion.ts:1043-1044`).

### Case 3 — rewrap offset 0: not reproduced

Not reproduced in 25 runs of the first IR iteration (final caret offset 13, value correct), in addition to 8 + 12 + 12 runs in Task 708. Per the task's proposed work item 4 this closes the item as not reproduced in 24 runs. The trace in these runs shows no root-range snapshot after the rewrap request. The mechanism stays unmeasured.

### Fix contract — W1 (Case 1, settle re-spin restore)

- File and site: `media-src/src/editing/edit-activity.ts` `restoreLiveSelection` (`:357-382`).
- Change: when the kept selection was collapsed and its endpoint resolves to a node endpoint (the node survived the spin, or the root mapping), write it back with `writeSelectionKeepingIntent({ anchorNode, anchorOffset, focusNode, focusOffset })` instead of `requestCaret`. A collapsed endpoint that resolves through its block address (the node was replaced), and every non-collapsed selection, keep `requestCaret({ anchor, focus })`.
- Effect: the restore arms no intent, so the pending marker frame sees the restored landing with `hasLiveCaretIntent()` false and ejects it, as it does when the frame runs first. A live intent that existed before the settle stays armed (transparent write).
- Names: no new export. One local predicate is enough, for example `const collapsed = ends.anchor.node === ends.focus.node && ends.anchor.offset === ends.focus.offset`, captured before the spin. Comment per `.agents/rules/ts.md`: "Task 710" — why a surviving collapsed caret needs no re-assertion (no node was replaced) and why an armed intent would suppress the marker ejection.
- Rules kept: Task 615 (the re-spin runs on the keystroke block; Select All and extended selections keep both ends and direction through the caret authority; block-address fallback for replaced nodes); Task 613 (the write is `setBaseAndExtent`, so Chromium is resynchronized); Tasks 532/553/648 marker-reveal rules unchanged (no edit in `editor-caret.ts`); Task 609 tie rules and Task 708 snapshot rule unchanged.
- Allocation policy: the settle runs once per typing pause, not per key. The change only chooses the writer; it allocates nothing new and adds no listener or timer. No change on the per-key path.
- RED Vitest (`media-src/src/editing/edit-activity.test.ts`, the Task 615 `mountRespinEditor` fixture): keystroke in block 0, then a collapsed caret in block 1 (`select(bravo, 3, bravo, 3)`), `vi.advanceTimersByTime(300)`. Expect `liveCaretIntentForTests()` to be `null` and the selection to be `(bravo, 3)`. Today the intent is `{ anchor: { node, offset: 3 }, focus: { node, offset: 3 } }` (RED). A second case with the caret inside a `span.vditor-ir__marker` text node in block 1 gives the same expectation. Regression: the existing Task 615 cases (`:798`–`:1163`) stay green, in particular Select All (contract 4), extensions, and block-address fallbacks (contract 7).
- Optional second RED (orchestrator's call): the marker controller (`installMarkerReveal…` runtime with an injected frame) plus a settle re-spin, asserting that a marker landing restored by the re-spin is ejected on the next frame.
- Real-VS-Code acceptance: `marker-reveal.spec.ts` with `--repeat-each=12 --retries=0`, 12 of 12 (at today's 9 of 25 failing-run rate, 6 passing runs by chance has a probability of about 7%, 12 about 0.5%). Regression specs for the restore path, once: `undo-snapshot-caret.spec.ts`, `select-all-delete.spec.ts` and the Task 615 real-VS-Code coverage (`structural-selection.spec.ts`, `prose-fast-edit.spec.ts`).

### Fix contract — W2 (Case 2, SV math basis)

- File and site: `media-src/src/editing/math-insertion.ts:777-778` (inline) and `:1043-1044` (fenced).
- Change (recommended option a): in SV, take the action's basis from the Source editor itself, the same text the SV mapping (`rewrap-command.ts:527`) and `replaceSvMarkdownRange` (`:767`) check against: `window.vditor.getValue()` (equal to the editor text while Vditor's newline span is present) instead of `deps.snapshotMarkdown()`. IR and WYSIWYG keep `deps.snapshotMarkdown()`. The host sync afterwards is unchanged (`deps.scheduleSync()` serializes through edit-sync).
- Rules kept: Task 602 host serialization (`serializeSvForHost`) unchanged; Task 666 no-marker-fallback and Task 696 SV capture rules unchanged; the action's rollback path unchanged.
- Allocation policy: a toolbar action, not a typing path; no new work.
- RED: the real-VS-Code `github-inline-math.spec.ts:351` fails 27 of 27 today, so it is a deterministic RED. Vitest: no SV case exists in `math-insertion.test.ts` (only the pure planners). A DOM case needs an SV-shaped editor (`pre.vditor-sv` with the trailing `[data-type="newline"]` span), a fake `window.vditor` whose `getValue()` follows Vditor's SV rule, and `snapshotMarkdown` that drops the span; then select `target`, dispatch `vmde-insert-github-inline-math`, expect `` $`target`$ `` in the editor text. Today the text is unchanged (RED).
- Real-VS-Code acceptance: `github-inline-math.spec.ts` 3 of 3 (IR `:156`, WYSIWYG `:315`, SV `:351`), with `--repeat-each=3`.

### Open questions for the orchestrator (recommendation first)

1. W2 basis. (a) **Recommended:** the SV action basis is the Source editor's own value (`getValue()`), in both Math actions. (b) Change edit-sync `snapshotMarkdown()` for SV to keep the newline span: wider, it is also the host serialization of Task 602 and would need its specs. (c) Compare through a normalizer that drops the span on both sides: touches the shared SV mapping in `rewrap-command.ts`. Other SV callers of `snapshotMarkdown` (`html-subscript-command.ts:326`, `details-toggle.ts:84`, `emoji-insertion.ts:264`) may share the mismatch; not measured here, out of this task's scope unless the orchestrator widens it.
2. W1 scope. (a) **Recommended:** transparent restore only for a collapsed caret whose node survived. (b) Transparent restore for every surviving-node selection (also non-collapsed): simpler, but drops the re-assertion Task 615 relied on for extended selections. (c) Flush the pending re-spin on a trusted navigation keydown before the native move: removes the race at its source but moves a block spin onto the keydown path for every navigation key inside the 220 ms window. Not recommended.
3. Case 2 is not a caret writer, so the task title and the acceptance item "`:351` passes, or its writer is measured and fixed" stay valid only through W2. Confirm W2 belongs to Task 710.

## Decisions Q1–Q3 (provisional, orchestrator on the Owner's behalf, 2026-11-08)

- Q1 (a): in SV, the inline and fenced Math actions take their snapshot from the Source editor's own value; IR and WYSIWYG keep `deps.snapshotMarkdown()`. Edit-sync's SV serialization (Task 602) is unchanged. The other SV callers of `snapshotMarkdown` (`html-subscript-command.ts`, `details-toggle.ts`, `emoji-insertion.ts`) are not in scope; any mismatch there is a follow-up.
- Q2 (a): `restoreLiveSelection` writes a collapsed caret on a surviving node back with `writeSelectionKeepingIntent`; non-collapsed selections and block-address fallbacks keep `requestCaret`.
- Q3: W2 stays in Task 710, because the record already owns the `github-inline-math.spec.ts:351` SV case.
- Rewrap offset 0: closed as not reproduced (57 runs across Tasks 708 and 710), per the record's allowance.

## Part 2 results (2026-11-08)

W1 (`edit-activity.ts` `restoreLiveSelection`: a collapsed caret on a surviving node is written back with `writeSelectionKeepingIntent`) and W2 (`math-insertion.ts` `actionSnapshot`: SV plans against the Source editor value) are implemented, with three Task 710 Vitest cases in `edit-activity.test.ts`. The two collapsed cases were RED before W1; the non-collapsed case pins the unchanged Task 615 path. No W2 Vitest: `run()` needs a full SV Vditor (Lute serialization, undo slots, toolbar origin, rewrap source capture), so the deterministic real-VS-Code RED (27 of 27 before W2) is the proof.

### Baseline versus candidate (real VS Code, `--retries=0`)

Baseline is a detached worktree at `f182b542`. Threshold: a failure counts as caused by the candidate only when its candidate rate is clearly above baseline (at least 3 more failures in 12) **and** the failing path runs through the changed code.

| Test | Baseline `f182b542` | Candidate (W1+W2) | Candidate + spec selection fix |
| --- | --- | --- | --- |
| `marker-reveal` | 3 of 6 failing runs (Task 708 record) | 12 of 12 pass | — |
| `github-inline-math` IR `:156` | 10 of 12 (`:197` ×1, `:224` ×1) | 8/12, 9/12, 9/12 (`:197` ×5, `:224`/`:246` ×3) | **12 of 12** |
| `github-inline-math` WYSIWYG `:315` | 12 of 12 | 11/12, 7/12, 11/12 (`:348` ×7) | **12 of 12** |
| `github-inline-math` SV `:351` | 0 of 12 (`:374`, W2 cause) | 10/12, 11/12, 10/12 (`:374` ×5) | **12 of 12** |
| `structural-selection` `:198` | 1 of 6 (`:310` ×5) | 1 of 6 (`:310` ×5) | — |
| `structural-selection` `:719` | 5 of 6 (`:830` ×1) | 6 of 6 | — |
| `structural-selection` `:369`, `:856` | 6 of 6 each | 6 of 6 each | — |

### Attribution

- **(a) Selection collapsed to the document start before the Math action (SV `:374`, WYSIWYG `:348`, IR `:224`/`:246`).** A test-harness race; not caused by W1 or W2. The WYSIWYG and IR paths do not run any changed line: W2 branches on `currentMode === 'sv'`, and W1 runs only in the IR settle re-spin, which needs a typed key that these steps do not have. Trace (12 WYSIWYG probe runs, `tmp/710/out-wys/`): after `switchMode`, Vditor's after-render Undo snapshot (`addCaret`) fires 34 ms before to 162 ms after the selection setup starts. Its Text-container restore arms `__vmdeRequestCaret({ blockPath: [0], offsetInBlock: 0 })`, a live intent at the click's document-start caret. When the snapshot lands between the `click({ x: 8, y: 8 })` pointerdown (which retires older intents) and the raw `setBaseAndExtent`, the intent re-asserts over the raw selection (a raw write is not a gesture), and the action wraps an empty range at offset 0 (`` $``$ `` or `` $`q`$ ``). Before W2, the SV action refused earlier, so SV did not show this failure. The baseline's WYSIWYG 12 of 12 against the candidate's 7 failures in 36 is a timing difference, not a code path. Spec-side fix (applied, selection setup only): `selectText` and the collapse step write through `window.__vmdeWriteSelection`, which retires the live intent (the Task 698 pattern). Result: 36 of 36.
- **(b) `structural-selection.spec.ts:198` (`:310`, Escape leaves `REPLACED` expanded).** Pre-existing: 5 of 6 failing at baseline and 5 of 6 with the candidate. Follow-up candidate: same failure line in both builds; not traced.
- **(c) IR `:197` (hidden math overflow item).** It falls in the same window as (a): the IR test starts with the same `selectText`. Baseline 1 of 12, candidate 5 of 36, and 0 of 12 after the spec-side selection fix. No product cause measured.
- `structural-selection.spec.ts:719` (`:830`, "Shift+Arrow ran before the settle"): 1 of 6 at baseline only. Pre-existing and intermittent; follow-up candidate.

### Acceptance (Part 2)

- [x] `marker-reveal.spec.ts` 12 of 12 with no retry (W1).
- [x] `github-inline-math.spec.ts:351` SV passes: 12 of 12 with W2 and the spec selection fix.
- [x] Rewrap offset 0 closed as not reproduced (Decisions).
- [x] Focused Vitest, typecheck, lint and `npm run quality` pass (see the final report).

## Closure (2026-11-08)

- The orchestrator reviewed the diff: W1 in `edit-activity.ts`, W2 in `math-insertion.ts`, and the selection setup in `github-inline-math.spec.ts`.
- `npm run quality` failed twice on load timeouts in files this task does not touch. The orchestrator's rerun, with nothing else running, passed all 8 stages.
- Follow-up candidates, both pre-existing at `f182b542`: `structural-selection.spec.ts:198` (Escape leaves `REPLACED` expanded, failed 5 of 6) and `:719` (intermittent).
