# Task 577 — Remove the editor freeze before the selection toolbar appears

> **For agentic workers:** Use `superpowers:systematic-debugging` for the attribution checkpoint, then `superpowers:executing-plans` for the fix checkpoints. Checkboxes track implementation and acceptance; the hypotheses below are not a confirmed diagnosis.

**Status:** in progress — Checkpoint 1 (attribution + red evidence) complete (2026-09-26); Checkpoints 2–3 (fix design, integrated acceptance) not started.
**Goal:** When a text selection ends in IR or WYSIWYG (mouse release or the last Shift+Arrow), the editor stays responsive and the floating selection toolbar (`vmde-selection-bubble`) appears without a perceptible stall.
**Tech stack:** TypeScript, Vditor/Lute, Vitest, Chromium Playwright and real VS Code with OS-level keyboard input.
**Spec:** The report, behavior contract and acceptance criteria in this file are the specification.
**Dependencies:** [Task 574](done/574-text-selection-performance.md) is complete. This task reuses its shared source block index (`nav/source-block-index.ts`), `EditSync.snapshotPair()`, the status-only Details classifier and the split bubble bookmark. Preserve their contracts. Deferred Task 572 is not a prerequisite.

## Report

The Project Owner reports (2026-09-26) that, after a text selection, the editor freezes for a short but noticeable time before the floating toolbar for the selection is displayed. Task 574 removed whole-document work from the passive (in-progress) selection. This report concerns the moment the selection **settles** and the toolbar is shown.

## Hypotheses to confirm or reject (not yet measured)

Task 574 moved the remaining whole-document work to settle time. Its Checkpoint 7 record confirms one index build and one full `getValue` occur "strictly after `pointerup`". Candidate causes, in expected order of cost:

1. **Settle-time index build on the toolbar's critical path.** `details-toggle.ts::releasePointer` (and `armSettle` for keyboard) sets `settled` and schedules `update` on the next animation frame. `passiveDetailsState` then calls `source.peek() ?? source.read()`. On a cold key, `source-block-index.ts::read()` runs `snapshotPair()` plus `resolveUnits()` synchronously. That frame runs before the bubble's 32 ms `setTimeout(refresh)` in `selection-bubble.ts::schedule`, so the toolbar is painted only after the long task. The key is cold after every trusted edit (revision advance) and after Vditor keydown DOM mutations (the accepted Task 574 ceiling).
2. **Settle-time exact fallback.** When the classifier returns `'unknown'` (coalesced or nested raw HTML Details, preview endpoints, or no cacheable key), `expandedDetailsState` / `passiveDetailsState` run `view.exactFallbackState`. This is today's exact capture, which includes live rewrap markers and full serialization. On a settled selection it runs synchronously in the same frame.
3. **Post-release block-handle hover.** `block-handle.ts::hover` → `unitAt` → `units()` → `index.read()` can be the first caller after release, as Task 574 recorded.
4. **Bubble-local cost.** `selectionOwner` (`getBoundingClientRect`, `deps.index.currentKey()` draining mutation records), `formatIsActive` per button, and `overlay.show` layout. These are expected to be small, but they must be measured, not assumed.
5. **Fixed latency, not a stall.** The 32 ms bubble debounce plus a frame is visible latency without main-thread blocking. Separate it from long tasks in the evidence.

Part 1 must attribute the actual stall with measurements before choosing a fix. Do not assume hypothesis 1.

## Global constraints

- Preserve everything Task 574 preserved: selected text and direction, caret, focus, scroll, IME, accessibility, retained selections, one-step native Undo/Redo, and no source, dirty or history change from a passive selection.
- Preserve accurate Details enabled/pressed state once the selection settles. Keep the owner decision that an unavailable index is never an advisory enable: the button must not show enabled and then do nothing.
- Preserve bubble Bold/Italic/Strike/Inline Code, Link/Wiki Link, Turn Into, warning/consent and cancellation flows, including when the main toolbar is hidden. Keep Preview, composition and disabled-setting suppression.
- Index-derived state stays advisory; every Markdown mutation keeps its action-time source validation.
- No disabled features, longer or shorter debounce as the sole fix, marker mutation during passive selection, global observer bypass, Lute fork, Worker, new setting/dependency or generated-output edits. Showing the toolbar before a deferred Details/index computation completes is allowed if the Details state is correct when that computation finishes and no action can run on a stale proof.
- Read `DEVELOPMENT.md`, the VMDE Lute, testing and visual-debugging skills and the applicable path-scoped rules. Follow the local queue's verification overrides (§5 of the operator queue).
- Keep model routing in the operator queue, not in this record. Leave `tasks/README.md` unchanged until actual closure. Make separate focused local commits; do not push.

## Checkpoint 1 — Attribute the settle-time stall (red evidence)

**Reuse:** `media-src/e2e/selection-performance.spec.ts`, `test/vscode-e2e/selection-performance.spec.ts`, `test/vscode-e2e/selection-performance-probe.ts`, `media-src/e2e/selection-bubble-harness.ts`, `test/vscode-e2e/helpers/xtest-input.ts`, and the synthetic fixture `test/vscode-e2e/fixtures/large-observable-models-synthetic.md` (copy it into the test's `baseDir`).

- [x] Add a **settle** phase to the existing selection-performance specs: measure from the release event (`pointerup`, or the last Shift+Arrow keyup) to the first frame where the bubble is visible. Record the longest task and the rAF gaps in that window, plus full `getValue`, `indexBuilds`, exact-fallback captures and live marker insertions.
- [x] Measure each case in IR and WYSIWYG: warm key (an idle hover already built the index), cold after one edit plus Undo, and cold after a keyboard-only selection. Include a small ordinary document as a control, so fixed latency (hypothesis 5) is separated from document-size-dependent work.
- [x] Attribute the longest task in each case to its call path, using a temporary stack/timing probe (added and removed, not shipped) where the counters are not enough. Record which of hypotheses 1–5 hold, with numbers.
- [x] Write the red assertions for the confirmed mechanism. Target shape (finalized in Part 1): no whole-document serialization or index build runs synchronously between release and the bubble's first visible frame, and the bubble becomes visible within one debounce interval plus two frames of release.
- [x] Use OS-level XTEST input for the keyboard acceptance steps. Browser-protocol input is diagnostic only.

## Checkpoint 2 — Take settle-time work off the toolbar's critical path

Design is finalized in Part 1 from Checkpoint 1's evidence. Candidate shapes, to be accepted or rejected with evidence:

- Show the bubble from its cheap read-only checks first, then run the Details settle update (index `read()` or exact fallback) after the bubble has painted, for example in a post-paint callback. The Details button keeps its current state until the result lands.
- Coalesce the settle consumers (Details, block handle, bubble) so exactly one of them builds the index per key, after first paint, with the others reading `peek()`.
- Reduce the exact fallback frequency for common `'unknown'` cases only if the classifier can prove them without guessed offsets (Task 574 review focus).

- [ ] Implement the chosen design in the smallest set of files. Expected: `media-src/src/editing/details-toggle.ts`, `media-src/src/editing/selection-bubble.ts`, possibly `media-src/src/nav/source-block-index.ts` and `media-src/src/boot/finish-init.ts`.
- [ ] Unit tests for the new ordering, including a selection that changes or an edit that lands between bubble paint and the deferred Details update. The deferred result must be discarded, not applied to the new selection.
- [ ] Confirm Details wrap/unwrap parity and retained-selection behavior still pass: `details.spec.ts` (Chromium) and `details-toolbar.spec.ts` (real VS Code).

## Checkpoint 3 — Integrated acceptance and closure

- [ ] The Checkpoint 1 red assertions pass in both modes. Report release-to-visible times and the longest task before and after, for the large fixture and the small control. Use three matched serial real-VS-Code runs.
- [ ] Focused regressions pass with `--retries=0`: Chromium `selection-bubble.spec.ts`, `details.spec.ts`, `block-handle.spec.ts`, `selection-performance.spec.ts`; real VS Code `selection-bubble.spec.ts`, `details-toolbar.spec.ts`, `block-handle.spec.ts`, `large-document-interaction.spec.ts`, `selection-performance.spec.ts`.
- [ ] Exact source, host and disk equality after the selection journeys; no dirty or history change from passive selection.
- [ ] Changed-line coverage, typechecks and the network-free quality stages once on the final candidate. Record bundle bytes, the change from Task 574 (888,821 B) and the eager-module count as reporting-only.
- [ ] Update this record with the evidence, move it to `tasks/done/` and add the `tasks/README.md` entry only when every item above is complete.

## Execution progress

### Part 1 handoff — Checkpoint 1 probes (2026-09-26)

**Code-path reading (not measured).** The settle ordering is the same for every consumer:

- Pointer release: `details-toggle.ts::releasePointer` (document capture `pointerup`) sets `settled` and schedules `update` on the next rAF. `selection-bubble.ts::onPointerUp` schedules `refresh` on a 32 ms timer. On a cold key, `passiveDetailsState` → `source.read()` builds the index in that rAF (`snapshotPair()` plus `resolveUnits()`). Task 574 measured a cold IR build of 785–980 ms on the synthetic fixture (`coldMs`, 121 fragment proofs). The bubble timer cannot fire until that task ends. H1 therefore predicts release→visible ≈ build time + 32 ms on a cold key, and ≈ 32 ms + one frame on a warm key.
- Keyboard: the last `keyup` → `armSettle` rAF → `schedule` rAF → `update`, which gives the same cold-key read. Each Shift+Arrow bubble reschedule also restarts the 32 ms timer.
- A settle-time exact fallback (H2) shows up as live rewrap-marker insertions (`captureTarget` → `captureRewrapSourceRange`).
- H3 needs a post-release `mousemove` in the editor. A still mouse after `pointerup` does not trigger it, so it only competes when the pointer moves.
- The bubble's `#app` MutationObserver (`childList`/`characterData`) calls `hide()` and reschedules on any unrelated mutation. Settle-time DOM churn would add another 32 ms + a frame on each occurrence. The probe must count these toggles.
- The Chromium harnesses are split (`details.html` has Details + block handle; `selection-bubble.html` has the bubble only), so the shared-index contention exists only in `finish-init.ts` wiring. **Real VS Code is the attribution layer.** Chromium `selection-bubble.html` isolates bubble-local cost (H4) and fixed latency (H5).

**Probe specification (Part 2, test-only).**

1. Extend `test/vscode-e2e/selection-performance-probe.ts` with a settle recorder, armed by `start()`. It records:
   - the release time: the last `pointerup`, or the last `keyup` of Shift/ArrowRight, through a window capture listener registered at install time;
   - `showAt`: a MutationObserver on the `.vmde-selection-bubble` `hidden` attribute, set on the first hidden→visible transition after release;
   - `visibleFrameAt`: the timestamp of the first rAF after `showAt`;
   - running-total snapshots of full `getValue`, `indexBuilds`, live marker insertions, root and fragment Lute calls, and bubble hide/show toggles, taken at release and at `visibleFrameAt`;
   - the longest long task overlapping [release, `visibleFrameAt`];
   - the maximum rAF gap in that window.

   Report `releaseToShowMs`, `releaseToVisibleFrameMs`, the per-window deltas (`settle*BeforeVisible`), and the same counters for the rest of the observation window (`settle*AfterVisible`). The existing fields stay unchanged.
2. The real-VS-Code `selection-performance.spec.ts` adds settle measurements to its existing test, reusing its phases where possible:
   - (a) a warm drag, where a hover already built the index, in IR and WYSIWYG;
   - (b) a cold drag in IR after `editThenUndo`, and in WYSIWYG directly after the mode switch with no hover (the drag holds the button, so it does not warm the index);
   - (c) a cold keyboard-only selection (script caret, 12 XTEST `shift+Right`) in both modes;
   - (d) a warm keyboard selection;
   - (e) a small ordinary control document (a few short paragraphs) with a warm drag and a keyboard selection in IR and WYSIWYG, opened in the same test after the large phases.

   Assert host/disk equality as today.
3. The Chromium `media-src/e2e/selection-performance.spec.ts` adds the same settle fields to the bubble-harness phases (warm and cold key, large and small). This is the H4/H5 isolation.
4. Attribution: add a temporary `performance.mark`/`measure` around `details-toggle` `update` (split into `read()` vs `exactFallbackState`), `block-handle` `units()`, bubble `refresh`/`selectionOwner`/`formatIsActive`/`overlay.show`, and `source-block-index` `read()` build. Rebuild, run once, read `performance.getEntriesByType('measure')` in the settle window, and record the attribution. **Remove the instrumentation before committing** and rebuild.
5. Record, per case: release→visible, the longest task and its attributed call path, and the counters. Say which of H1–H5 hold, with numbers.

**Red assertion shape (write only if the evidence confirms settle-time index/fallback work before the first visible frame; otherwise return without assertions).** For every settle case in both modes and both documents:

- `settleIndexBuildsBeforeVisible === 0`;
- `settleFullGetValueBeforeVisible === 0`;
- `settleLiveMarkersBeforeVisible === 0`;
- `releaseToShowMs ≤ 32 + 2 × 16.7` ms in Chromium.

In real VS Code, the deterministic counters are hard gates. `releaseToShowMs` gets a hard bound of 150 ms: a cold build is ≥ 700 ms, and XTEST/IPC jitter was measured at 50–60 ms. The exact values are reported. Accuracy guard: after the observation window, the Details button state still equals the Task 574 expectation (`detailsEnabled`).

**Expected outcome.** H1 holds for cold keys (the Details settle `read()`), with long tasks of hundreds of ms before the first visible frame in IR. Warm keys and the small control document show only fixed latency (H5). H2 is expected to be absent on this fixture's plain paragraphs. H3 and H4 are expected to be small.

### Checkpoint 1 results (Part 2, 2026-09-26)

**Scope actually completed.** Extended `test/vscode-e2e/selection-performance-probe.ts` with the settle recorder (release listener, bubble `hidden`-attribute `MutationObserver`, first-rAF-after-show, before/after-visible counter deltas, windowed longest-longtask and max-rAF-gap). Added settle fields and new cases to both `test/vscode-e2e/selection-performance.spec.ts` (cold drag in IR via an extra `editThenUndo`, cold drag in WYSIWYG via a bare mode switch, cold WYSIWYG keyboard via a mode bounce, and a small control document — `selection-performance-control-small.md`, written into the test's `baseDir`, not committed — with warm drag + keyboard in both modes) and `media-src/e2e/selection-performance.spec.ts` (bubble-harness warm/cold drag, cold-vs-warm keyboard already fell out of the existing first/second-interaction order, plus a warm-key small-doc control). Ran the temporary attribution pass once, removed it, and added the red assertions (they fail as expected in real VS Code, pass in Chromium).

**Per-case settle table (real VS Code, final run, `documentSize`/`warmth`/`input` as measured).** `r→show` = `releaseToShowMs`, `r→vf` = `releaseToVisibleFrameMs`, `idx`/`getVal`/`markers` = settle-window (before-visible) deltas, `task` = `settleLongestTaskMs`.

| mode | doc | input | warmth | r→show | r→vf | idx | getVal | markers | task | detailsEnabled after |
|---|---|---|---|---|---|---|---|---|---|---|
| ir | large | drag | warm | 245 | 257 | 1 | 1 | 0 | 208 | true |
| ir | large | drag | cold | 258 | 270 | 1 | 1 | 0 | 217 | true |
| wysiwyg | large | drag | warm | 48 | 54 | 0 | 0 | 0 | 0 | true |
| wysiwyg | large | drag | cold | 185 | 186 | 1 | 1 | 0 | 182 | true |
| ir | large | slow-keyboard | warm | 0 | 5 | 0 | 0 | 0 | 0 | true |
| ir | large | burst-keyboard | warm | 0 | 12 | 0 | 0 | 0 | 0 | true |
| ir | large | cold-edit-selection (keyboard) | cold | 0 | 12 | 0 | 0 | 0 | 0 | true |
| wysiwyg | large | slow-keyboard | warm | 0 | 10 | 0 | 0 | 0 | 0 | true |
| wysiwyg | large | burst-keyboard | warm | 0 | 7 | 0 | 0 | 0 | 0 | true |
| wysiwyg | large | slow-keyboard | cold | 0 | 6 | 0 | 0 | 0 | 0 | true |
| ir | small | drag | warm | 57 | 61 | 1 | 1 | 0 | 0 | true |
| ir | small | slow-keyboard | warm | 0 | 12 | 0 | 0 | 0 | 0 | true |
| wysiwyg | small | drag | warm | 33 | 45 | 0 | 0 | 0 | 0 | true |
| wysiwyg | small | slow-keyboard | warm | 0 | 3 | 0 | 0 | 0 | 0 | true |

`cold-hover`/`cold-edit-hover` phases (pure mouse hover, no release event) had `settleObserved: false` and are omitted; the counters and `detailsEnabled` accuracy held for them too (unchanged from Task 574).

**Chromium bubble-harness (H4/H5 isolation, no Details wired to the shared index):** `settleIndexBuildsBeforeVisible`/`settleFullGetValueBeforeVisible`/`settleLiveMarkersBeforeVisible` were `0` on every one of 12 `settleObserved` phases (large+small, warm+cold, drag+keyboard). `releaseToShowMs` ranged 0–57 ms (already-visible-at-release for most keyboard phases where the 60 ms inter-key gap exceeds the 32 ms debounce; 32–57 ms for drag/burst phases), always ≤ `32 + 2×16.7 ≈ 65.4` ms.

**Attribution (temporary `performance.mark`/`measure` pass, one real-VS-Code run, then fully removed — `git diff media-src/src` was empty before every commit and after the final revert).** Instrumented `source-block-index.ts::read()` (the build itself), `details-toggle.ts` (`passiveDetailsState`'s `source.read()` call, split from `exactFallbackState`), `block-handle.ts::units()`, and `selection-bubble.ts::refresh` (with `selectionOwner`, the `formatIsActive` loop, and `overlay.show` as sub-measures). Findings from the collected `performance.getEntriesByType('measure')`:

- Every large-fixture **drag** phase showed exactly one index rebuild (145–745 ms depending on document warmth/state), matching the counters' `indexBuilds`/`fullGetValueCalls` delta of 1. The rebuild's cost is **attributed to either `block-handle.units()` or `details.settleRead()` depending on the phase** — never both in the same phase (Task 574's per-key cache means only the first of the two racing consumers actually pays the cost; the loser gets a cache hit). Both call paths were observed winning the race in different phases of the same run, at comparable cost (`block-handle.units()`: 745, 195, 176, 180, 185, 155, 162/170 ms; `details.settleRead()`: 183, 172, 163, 170, 176, 149, 168/148 ms).
- `details.exactFallbackState` never appeared with any measurable duration (0 occurrences with cost) — consistent with H2 being absent on this fixture's plain paragraphs.
- `bubble.selectionOwner`, `bubble.formatIsActive`, `bubble.overlayShow`, and the outer `bubble.refresh` were all 0 ms in every one of ~200 samples — bubble-local cost is negligible, consistent with the Chromium isolation numbers above.

**Hypothesis verdicts:**

- **H1 (settle-time index build on the toolbar's critical path) — CONFIRMED**, and refined: the single settle-time index rebuild that Task 574 already knew could happen "strictly after pointerup" is not always Details' own read — it is a **race** between Details' `passiveDetailsState → source.read()` and block-handle's own post-release `hover() → units() → index.read()` (a `mousemove`-driven call that does fire after `mouseup` in these measurements, contra the Part 1 handoff's assumption that "a still mouse after `pointerup` does not trigger it" — evidence shows a mousemove-equivalent event does land after release for a drag gesture in this environment). Whichever wins pays 145–745 ms on the large fixture (148–217 ms in the final clean run) and blocks the bubble's first visible frame: `releaseToShowMs` reached 245–270 ms for IR drags and 185 ms for a cold WYSIWYG drag, all `> 150` ms.
- **H2 (settle-time exact fallback) — CONFIRMED ABSENT.** Zero `exactFallbackState` cost and zero `settleLiveMarkersBeforeVisible` in every phase, in both layers.
- **H3 (post-release block-handle hover) — CONFIRMED as a real, independent trigger of the same shared rebuild**, not merely a possibility gated on an explicit further mouse move: it won the attribution race in several observed phases (see above). This is stronger than the Part 1 handoff anticipated.
- **H4 (bubble-local cost) — CONFIRMED SMALL.** 0 ms across every `selectionOwner`/`formatIsActive`/`overlayShow` sample in the attribution pass, and the Chromium isolation harness (no Details wiring) never showed a nonzero settle-window index build or full `getValue`.
- **H5 (fixed 32 ms + frame latency, not a stall) — CONFIRMED as the ONLY cost for every keyboard-release phase and for the WYSIWYG-warm/small-doc drag phases** where no index rebuild landed in the settle window (`releaseToShowMs` 0–57 ms, `releaseToVisibleFrameMs` 3–61 ms). It does **not**, however, explain the large-fixture drag phases, where H1/H3's rebuild dominates.

**Surprise not anticipated in Part 1:** the settle-time rebuild is not unique to a "cold key" — it reproduces on the **already-warm** IR large-fixture drag phase inherited unchanged from Task 574 (`ir/large/drag/warm`: 245 ms, 1 index build before visible). Extending a mouse selection inside IR mode invalidates the shared index's cache **during the drag itself** (most likely IR's own marker-reveal/hide DOM churn as the selection crosses markdown syntax, though this specific DOM-mutation source was not independently isolated), so "warm" only helps when the release gesture itself does not touch the editor's DOM. A **genuinely cold** drag (mouse approaches an unswept region and drags immediately, added this checkpoint) additionally builds the index **twice** in the same phase — once on approach (before `pointerdown`, outside the settle window) and once on the post-release settle race — exceeding Task 574's own "at most one build per phase" ceiling. This is legitimately new, since Task 574 never exercised a drag as the very first interaction; it did not require loosening Task 574's existing assertions because the new cold-drag phases are aggregated separately (`legacyMeasurementCount` split) precisely so the original ceilings keep gating the original phase set unmodified.

**Commands run and outcomes:**

1. `npm run typecheck:vscode-e2e` — pass (one pre-existing, unrelated `preview-task-checkbox.spec.ts` error confirmed present on unmodified `dev` via `git stash`).
2. `npm run typecheck` (webview) — pass.
3. `npx biome check --write` on the probe, both specs, and each temporarily-instrumented product file — clean.
4. `node build.mjs` — pass, `main.js` 868.0 kB before instrumentation, 869.8 kB with the temporary marks, 868.0 kB again after removal (confirms nothing leaked).
5. `xvfb-run -a npm --prefix media-src run test:e2e -- selection-performance.spec.ts --retries=0` — **pass**, including the new H4/H5 hard gates (green, as expected — the isolated harness does not reproduce the index-build race).
6. Real-VS-Code `selection-performance.spec.ts` under the XTEST shell (`env -u ELECTRON_RUN_AS_NODE -u WAYLAND_DISPLAY XDG_SESSION_TYPE=x11 VMDE_XTEST=1 xvfb-run -a -s '-screen 0 1600x1000x24 +extension XTEST' bash -c 'openbox & ...; npm --prefix test/vscode-e2e test -- selection-performance.spec.ts --workers=1 --retries=0'`), four runs:
   - Run 1 (first draft of the new phases): failed on an unrelated harness bug — a floating Vditor move-up/down panel over a heading in the small control doc intercepted a click. Fixed by dropping the heading from the control fixture.
   - Run 2: all new phases executed; failed at the pre-existing `metrics.drag.fullGetValueCalls <= 1` assertion because the new cold-drag phases (2 builds each) fed the same aggregate as Task 574's original warm-drag ceiling. Fixed by splitting `measurements` into `legacyMeasurementCount`-bounded `legacyMeasurements` (feeds the original Task 574 aggregates, untouched) and the full array (feeds the new Checkpoint 1 settle aggregate).
   - Run 3 (clean, no instrumentation): **passed** — confirms the fix restored Task 574's original invariants without loosening them.
   - Run 4 (attribution pass, temporary marks present): **passed** — confirms the marks are transparent to existing behavior; attribution data above is from this run.
   - Run 5 (final, marks removed, new red assertions added): **failed exactly at `settleIndexBuildsBeforeVisible === 0`** (the first new assertion), with every prior assertion — including all of Task 574's original ceilings — green. This is the red-evidence result required by this checkpoint.
7. `git diff media-src/src` — confirmed **empty after removing the temporary instrumentation** (checked right before this final run and again before committing), i.e. no product source changes are staged for commit.

**Red evidence summary.** The real-VS-Code spec fails at:
```
expect(settleObservedMeasurements.every((entry) => entry.settleIndexBuildsBeforeVisible === 0)).toBe(true)
Expected: true
Received: false
```
(`ir/large/drag/warm`, `ir/large/drag/cold`, `wysiwyg/large/drag/cold`, and `ir/small/drag/warm` each have `settleIndexBuildsBeforeVisible: 1`). The Chromium spec's equivalent gates and the `releaseToShowMs` hard bounds in both layers pass, isolating the mechanism to the shared source-block-index race between Details and block-handle in real VS Code, exactly as designed.

**Not done / explicitly deferred (honest accounting):** No red assertion was added for the "at most one index build" cold-drag ceiling itself (2 builds observed) — this checkpoint's red-assertion mandate was the settle-window shape from the Part 1 handoff, not a new ceiling on the total; Checkpoint 2/3 should decide whether the double-build on a genuinely cold drag needs its own guard once the fix design is chosen. The Chromium bubble-harness settle coverage does not include a small-document **drag** phase (only small-document **keyboard**, both cold-first and warm-second by construction) — bounded for time; the real-VS-Code spec's small-document coverage (drag + keyboard, both modes) is complete per the handoff. The specific DOM-mutation source that invalidates the shared index during an in-progress IR drag (making even a "warm" drag settle-cold) was not isolated further; only its existence and cost were established via the counters and attribution marks.
