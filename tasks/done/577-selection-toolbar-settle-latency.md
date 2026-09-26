# Task 577 — Remove the editor freeze before the selection toolbar appears

> **For agentic workers:** Use `superpowers:systematic-debugging` for the attribution checkpoint, then `superpowers:executing-plans` for the fix checkpoints. Checkboxes track implementation and acceptance; the hypotheses below are not a confirmed diagnosis.

**Status:** complete (2026-09-26). All three checkpoints closed with real-VS-Code and Chromium acceptance evidence.
**Goal:** When a text selection ends in IR or WYSIWYG (mouse release or the last Shift+Arrow), the editor stays responsive and the floating selection toolbar (`vmde-selection-bubble`) appears without a perceptible stall.
**Tech stack:** TypeScript, Vditor/Lute, Vitest, Chromium Playwright and real VS Code with OS-level keyboard input.
**Spec:** The report, behavior contract and acceptance criteria in this file are the specification.
**Dependencies:** [Task 574](574-text-selection-performance.md) is complete. This task reuses its shared source block index (`nav/source-block-index.ts`), `EditSync.snapshotPair()`, the status-only Details classifier and the split bubble bookmark. Preserve their contracts. Deferred Task 572 is not a prerequisite.

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

- [x] Implement the chosen design in the smallest set of files. Expected: `media-src/src/editing/details-toggle.ts`, `media-src/src/editing/selection-bubble.ts`, possibly `media-src/src/nav/source-block-index.ts` and `media-src/src/boot/finish-init.ts`.
- [x] Unit tests for the new ordering, including a selection that changes or an edit that lands between bubble paint and the deferred Details update. The deferred result must be discarded, not applied to the new selection.
- [x] Confirm Details wrap/unwrap parity and retained-selection behavior still pass: `details.spec.ts` (Chromium) and `details-toolbar.spec.ts` (real VS Code).

## Checkpoint 3 — Integrated acceptance and closure

- [x] The Checkpoint 1 red assertions pass in both modes. Report release-to-visible times and the longest task before and after, for the large fixture and the small control. Use three matched serial real-VS-Code runs.
- [x] Focused regressions pass with `--retries=0`: Chromium `selection-bubble.spec.ts`, `details.spec.ts`, `block-handle.spec.ts`, `selection-performance.spec.ts`; real VS Code `selection-bubble.spec.ts`, `details-toolbar.spec.ts`, `block-handle.spec.ts`, `large-document-interaction.spec.ts`, `selection-performance.spec.ts`.
- [x] Exact source, host and disk equality after the selection journeys; no dirty or history change from passive selection.
- [x] Changed-line coverage, typechecks and the network-free quality stages once on the final candidate. Record bundle bytes, the change from Task 574 (888,821 B) and the eager-module count as reporting-only.
- [x] Update this record with the evidence, move it to `tasks/done/` and add the `tasks/README.md` entry only when every item above is complete.

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

1. `npm run typecheck:vscode-e2e` — exit 1 (only one pre-existing, unrelated `preview-task-checkbox.spec.ts` error confirmed present on unmodified `dev` via `git stash`).
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

### Part 1 handoff — Checkpoint 2 design (2026-09-26)

**Attribution used.** Checkpoint 1 measured exactly one shared-index build before the bubble's first visible frame in every drag phase that stalled. Real VS Code, large fixture:

| Mode | Key state | Release → visible |
| --- | --- | --- |
| IR | warm | 257 ms |
| IR | cold | 270 ms |
| WYSIWYG | cold | 186 ms |

The build came either from the Details settle `read()` or from the block handle's post-release hover `units()`, whichever ran first. Chromium dispatches that hover through its own fake `mousemove` after `pointerup`, so H3 holds even with a still pointer. The exact fallback, live markers and bubble-local work were 0 in every case (H2 absent, H4 small). Keyboard releases show the bubble within 0–12 ms, because the timer already fired between keys. Their in-selection build stays inside Task 574's accepted keyboard ceiling and is out of scope. The warm IR drag is invalidated during the gesture by an IR DOM mutation. This design does not depend on that mutation: a cold key after every edit is the common case anyway.

**Design: a presentation hold on the shared index.** Settle-time consumers route their builds through the index. The bubble holds those builds until its first visible frame has painted. One coalesced build then serves every waiter.

1. `nav/source-block-index.ts` gains two members on `SourceBlockIndexHandle`:
   - `holdBuilds(): () => void` returns an idempotent release.
   - `readWhenReady(callback): () => void` (the return value cancels):
     - With no hold active, it calls `callback(read())` synchronously, exactly as today.
     - With a hold active, it queues the callback. When the last hold is released, the index runs one `read()` and passes that entry to every queued callback (each callback re-validates itself).
     - `dispose()` drops the holds and waiters.
   - `read()`, `peek()` and `currentKey()` are unchanged, so action paths keep their synchronous exact proofs.
2. `editing/selection-bubble.ts` takes one hold whenever a refresh is scheduled (selectionchange, pointer release, mutation reschedule, compositionend). `refresh()` releases it:
   - If refresh hides, it releases immediately (nothing to paint).
   - If it shows, it releases after the shown frame has painted (`requestAnimationFrame` → `setTimeout(0)`), and only if no newer refresh is pending.
   - `dispose()` releases.
   A disabled bubble (`enabled: false`) takes no hold.
3. `editing/details-toggle.ts`, IR/WYSIWYG indexed path: when the selection has settled and `peek()` misses, or the state is `'unknown'` and needs the exact fallback, `update` calls `index.readWhenReady`. It no longer calls `read()`/fallback inline. The callback discards itself if any of these changed since the request:
   - the selection generation (a reselection);
   - an input generation (an edit);
   - the pointer is held again.
   Otherwise it computes the state from the delivered entry, with the fallback allowed, and applies it. A newer update or dispose cancels a pending request. Until the result lands, the button keeps its current state, the same rule that already applies before settle. `onToggle` still captures exact source at action time, so no action runs on a stale proof.
4. `nav/block-handle.ts` ordinary `hover`: when `peek()` misses, it calls `index.readWhenReady` instead of `read()`. The callback re-runs the hover lookup for the last hover target only if the target is still connected, still under the active root, and still the latest hover. It also requires that no drag, menu or native selection is in progress. Drag, drop, keyboard and menu paths keep synchronous `units()`.
5. `boot/finish-init.ts` needs no change: the shared index is already passed to all three consumers.

**Tier.** Heavy: this changes `source-block-index.ts` and the index-consumer ordering. Implementation and validation run on Opus 5.5.

**Required checks.**

- Unit tests:
  - `source-block-index.test.ts`: sync without a hold; deferral and one coalesced build with a hold; nested and idempotent release; cancel; dispose.
  - `details-toggle-controls.test.ts`: a deferred result is discarded after a reselection or edit, and applied when still current; an unknown state defers the fallback.
  - `selection-bubble.test.ts`: the hold is taken on schedule and released after paint when shown or immediately when hidden; a newer pending refresh keeps the hold; a disabled bubble takes none.
  - `block-handle.test.ts`: hover defers under a hold and resumes on release; a stale deferred hover is dropped.
- Chromium: `details.spec.ts`, `selection-bubble.spec.ts`, `block-handle.spec.ts`, `selection-performance.spec.ts`.
- Real VS Code: `details-toolbar.spec.ts`, then the Checkpoint 3 set.

**Expected outcome.** The Checkpoint 1 settle assertions pass (0 builds, 0 `getValue` and 0 markers before visible), and release→show stays ≤ 150 ms in real VS Code. The number of builds per phase does not increase; the build moves to after the bubble's first visible frame.

### Checkpoint 2 results (Part 2, 2026-09-26)

Implemented the Part 1 design in four source files; `boot/finish-init.ts` is unchanged:

- `nav/source-block-index.ts`: `holdBuilds()` and `readWhenReady()`.
- `editing/selection-bubble.ts`: holds builds from the scheduled refresh until after the shown frame has painted, or releases at once when the bubble hides; a disabled bubble takes no hold.
- `editing/details-toggle.ts`: `warmDetailsState` handles the cheap pass. The settled build and the exact fallback go through `readWhenReady`. A request is canceled by a newer update or dispose, and discarded after a reselection, an input event or a new primary press.
- `nav/block-handle.ts`: a cold ordinary hover goes through `readWhenReady` and resumes only for the latest, still-connected hover target.

Checks:

- **Unit:** 79 tests passed across the five focused files:
  - `source-block-index.test.ts`: 5 new tests (sync without a hold; one coalesced deferred build; cancel; null key; dispose).
  - `details-toggle-controls.test.ts`: 2 new tests (deferred apply; discard after an edit and after an expanded reselection). A mutation check confirmed the discard test fails with the generation guards removed.
  - `selection-bubble.test.ts`: 3 new tests (hold until painted; immediate release on hide; hold kept for a pending refresh and released on dispose; none when disabled).
  - `block-handle.test.ts`: 2 new tests (deferred latest hover; dropped detached target).
  - `details-toggle.test.ts`: unchanged, still passing.
- **Lint and typecheck:** `npx biome check media-src/src` is clean. `npm run typecheck` exits 0. `npm run typecheck:strict` exits 1, but only on pre-existing diagnostics outside this diff (see Checkpoint 3); the original note here called it clean without checking the exit code (corrected at closure).
- **Build:** `node build.mjs` succeeded.
- **Chromium:** `details.spec.ts`, `selection-bubble.spec.ts`, `block-handle.spec.ts` and `selection-performance.spec.ts` passed 43/43 with `--retries=0 --workers=1`.
- **Real VS Code (XTEST, Openbox, `--retries=0 --workers=1`):**
  - `details-toolbar.spec.ts`: 1/1 passed.
  - Design-validation run of `selection-performance.spec.ts`: 1/1 passed; the Checkpoint 1 red assertions are now green.

Every settle case now has 0 index builds, 0 full `getValue` calls and 0 markers before the first visible frame. Release→visible frame on the large fixture, after vs Checkpoint 1:

| Mode | Drag | Before | After |
| --- | --- | --- | --- |
| IR | warm | 257 ms | 57 ms |
| IR | cold | 270 ms | 37 ms |
| WYSIWYG | warm | 54 ms | 37 ms |
| WYSIWYG | cold | 186 ms | 37 ms |

- The longest task inside the window is now 0 ms in every settle case.
- The small control document measures 43–45 ms for drags and 0–1 ms for keyboard.
- The deferred build lands after the visible frame (`settleIndexBuildsAfterVisible` = 1 on cold drags).
- The cold drag phase now builds once instead of twice.
- `detailsEnabled` stayed correct in every phase, and host and disk bytes stayed exact.

### Checkpoint 3 results (Part 2, 2026-09-26)

**Scope.** Acceptance ran on the exact tree already built and committed at `d7bd12e8` (Checkpoint 2). No product source changed in this checkpoint; `git status` stayed clean apart from the two untracked, unrelated `LOCAL_AGENT_TASK*.md` operator files, which are excluded from this commit.

**Three matched serial real-VS-Code runs of `selection-performance.spec.ts`** (OS-level XTEST, `--workers=1 --retries=0`; logs `/tmp/577-cp3-selperf-run{1,2,3}.log`, all `rc=0`, 1/1 passed each, ~54–56 s). Every one of the 14 settle-observed cases across all 3 runs (42 samples) measured `settleIndexBuildsBeforeVisible = 0`, `settleFullGetValueBeforeVisible = 0`, `settleLiveMarkersBeforeVisible = 0`, and `settleLongestTaskMs = 0` — the Checkpoint 1 red assertions are green in every sample, not just on average. `detailsEnabled`, `hostUnchanged`, and `diskUnchanged` were `true` in every sample (no dirty or history change from a passive selection).

Release→visible frame (`releaseToVisibleFrameMs`), averaged across the 3 runs, before (Checkpoint 1) vs after (Checkpoint 2/3, this run):

| Mode | Doc | Input | Warmth | Before (r→vf) | After (r→vf, avg of 3) | After (r→show, avg of 3) |
| --- | --- | --- | --- | --- | --- | --- |
| IR | large | drag | warm | 257 ms | 57.7 ms | 42.7 ms |
| IR | large | drag | cold | 270 ms | 54.0 ms | 45.7 ms |
| WYSIWYG | large | drag | warm | 54 ms | 37.7 ms | 33.3 ms |
| WYSIWYG | large | drag | cold | 186 ms | 38.3 ms | 33.7 ms |
| IR | large | slow-keyboard | warm | 5 ms | 4.0 ms | 0 ms |
| IR | large | burst-keyboard | warm | 12 ms | 5.7 ms | 0 ms |
| IR | large | cold-edit-selection (keyboard) | cold | 12 ms | 6.7 ms | 0 ms |
| WYSIWYG | large | slow-keyboard | warm | 10 ms | 14.3 ms | 0 ms |
| WYSIWYG | large | burst-keyboard | warm | 7 ms | 11.0 ms | 0 ms |
| WYSIWYG | large | slow-keyboard | cold | 6 ms | 8.7 ms | 0 ms |
| IR | small | drag | warm | 61 ms | 55.0 ms | 44.7 ms |
| IR | small | slow-keyboard | warm | 12 ms | 8.0 ms | 0 ms |
| WYSIWYG | small | drag | warm | 45 ms | 43.7 ms | 33.0 ms |
| WYSIWYG | small | slow-keyboard | warm | 3 ms | 7.0 ms | 0 ms |

The large-fixture drag cases (the ones that stalled 186–270 ms in Checkpoint 1) now settle in 38–58 ms, all with a 0 ms longest task in the settle window; the small remaining latency is entirely the bubble's fixed 32 ms debounce plus a couple of animation frames (H5), never a synchronous whole-document build. The keyboard-only cases were already fast in Checkpoint 1 (out of scope) and show run-to-run jitter of a few ms, consistent with XTEST/IPC noise, with no regression. Per-run raw JSON matches the `[Task 574 OS selection performance]` line in each log; the three runs agree within a few ms on every case, confirming the fix is not timing-lucky.

**Focused regressions, real VS Code** (`/tmp/577-cp3-regressions.log`, one XTEST invocation, `--workers=1 --retries=0`, `rc=0`): `block-handle.spec.ts` (13/13), `large-document-interaction.spec.ts` (4/4), `selection-bubble.spec.ts` (4/4) — **21/21 passed** in 2.6 minutes. `details-toolbar.spec.ts` was already re-validated on this unchanged tree at Checkpoint 2 (`/tmp/577-cp2-details-toolbar.log`, 1/1, cited rather than rerun).

**Chromium focused regressions** were already run and passed on this unchanged tree at Checkpoint 2 (`details.spec.ts`, `selection-bubble.spec.ts`, `block-handle.spec.ts`, `selection-performance.spec.ts`, 43/43, `/tmp/577-cp2-chromium.log`) — cited, not rerun, since no source or build input changed since that log was produced.

**Exact source/host/disk equality.** Every measurement in all three new real-VS-Code runs plus all 21 regression tests reported `hostUnchanged`/`diskUnchanged` true (or the equivalent exact-byte/history assertions each spec makes); `block-handle.spec.ts` and `large-document-interaction.spec.ts` additionally assert one-step native Undo/Redo history and exact-byte round trips, all green.

**Changed-line coverage** (`COLUMNS=2000 npx vitest run --config test/vitest.config.ts --coverage --coverage.include=... --coverage.reporter=text`, cross-checked against the raw `coverage-final.json` statement map to avoid table truncation):

| File | Stmts/Branch/Funcs/Lines % | Changed lines (from `d7bd12e8`) | Uncovered changed lines |
| --- | --- | --- | --- |
| `nav/source-block-index.ts` | 99.25 / 93.54 / 95.83 / 99.15 | new `holdBuilds`/`readWhenReady`/`flushWaiters`/dispose additions | none — only uncovered line (314) is pre-existing `onInvalidate` code untouched by this task |
| `editing/details-toggle.ts` | 90.81 / 78.22 / 97.61 / 93.93 | `indexedUpdate`'s `readWhenReady` path, `inputGeneration++`, `cancelSettledRead` wiring | none — all uncovered lines (37, 53, 104-114, 122-123, 144-145, 331, 418-419, 519-520, 525-526, 544) are pre-existing context lines the diff did not add or modify |
| `editing/selection-bubble.ts` | 81.14 / 65.21 / 78.57 / 83.84 | `releaseBuildHold`/`paintToken`/`releaseBuilds`/`releaseBuildsAfterPaint`, the `schedule()` hold-take, and the two `dispose`/hide release sites | none — all uncovered statements are pre-existing (turn-into/link-popover/etc. branches far from the new code) |
| `nav/block-handle.ts` | 73.34 / 63.03 / 79.72 / 76.10 | `hoverUnit`, `cancelDeferredHover`, its call sites in `hover` and `dispose` | none — the two nearby uncovered lines (727, 729) are pre-existing `hover()` guard clauses the diff only shifted, not added |

Every changed line introduced by Checkpoint 2 is exercised by the existing unit tests added in that checkpoint (`source-block-index.test.ts`, `details-toggle-controls.test.ts`, `selection-bubble.test.ts`, `block-handle.test.ts`); no new unit tests were needed at Checkpoint 3.

**Typechecks:**

- `npm run typecheck` — **pass** (rc=0).
- `npm run typecheck:strict` — rc=1, 13 diagnostics, all pre-existing and outside Task 577's diff (`boot/main.ts`, `editing/fix-table-ir.ts`, `editing/link-popover.ts`, `editing/list-normalize-source-command.ts`, `editing/table-actions.ts`, `editing/table-cell-selection.ts`, plus one in `editing/selection-bubble.test.ts` line 121 which is verified byte-identical to the pre-Task-577 `e52a64e2` revision). None fall inside the `d7bd12e8` diff.
- `npm run typecheck:vscode-e2e` — rc=1, the single pre-existing `test/vscode-e2e/preview-task-checkbox.spec.ts(122,28)` error already confirmed present on unmodified `dev` at Checkpoint 1 (via `git stash`, recorded there); unrelated to this task and untouched by its diff.

**Network-free quality stages, run once on the final candidate** (dependency audit intentionally omitted by Project Owner instruction):

| Stage | Command | Exit code | Notes |
| --- | --- | --- | --- |
| Lint | `npm run lint:ci` | 0 | Biome clean, whole tree (1055 files) |
| Unused code | `npm run knip` | 1 | 9 unused exports + 1 unused type, all in files Task 577 never touched (`table-resize.ts`, `emoji-recents.ts`, `inline-picture.ts`, `svg-data-image-adapter.ts`, `outline-tree.ts`, `emoji-recents-store.ts`) — pre-existing |
| Duplication | `npm run jscpd` | 0 | 1389 clones, 7.14% duplicated lines, under threshold |
| Dependency graph | `npm run depcruise` | 0 | No violations (host 66 modules/154 deps; webview 264 modules/787 deps); the `missing-typescript-transpiler` note is an environment warning, not a violation |
| Unit coverage | `npm run test:coverage` | 0 | 4623 passed, 1 expected fail; thresholds met |
| Coverage ratchet | `npm run check:coverage-modules` | 0 | 13 zero-coverage modules, matches baseline 13 |

Dependency audit intentionally omitted by Project Owner instruction. Broader real-VS-Code/Chromium suites beyond the focused regressions above were not run per the local queue's scoped-verification policy for this checkpoint.

**Bundle/startup (reporting-only, not a gate):**

- `npm run check:bundle-size` — rc=1 (budget exceeded, pre-existing since before this task: `media/dist/main.js` 869 KB / 608 KB budget). Exact bytes: **889,902 B**, vs Task 574's baseline of 888,821 B — a delta of **+1,081 B (+0.12%)**, consistent with the small `holdBuilds`/`readWhenReady` addition across 4 files. The other four lazy engine bundles (ELK, D2, mermaid-ELK-layout, PlantUML awslib) stay within budget.
- `npm run check:startup-cost` — rc=1 (budget exceeded, pre-existing): 342 eager modules vs a 294 budget; largest eager module unchanged at 29.8 KB (`vditor/src/ts/util/fixBrowserBehavior.ts`).

Both budget overruns pre-date this task (Checkpoint 1 already recorded `main.js` at 868.0 kB before any Task 577 source change) and are reporting-only per the operator queue; they do not block this checkpoint.

**Not run / explicitly omitted (honest accounting):**

- The root/webview/vendor dependency audit (`npm run audit`) — omitted by explicit Project Owner instruction for this checkpoint.
- The aggregate `npm run quality` — not run because it internally invokes the audit stage the Owner excluded; the equivalent lint/knip/jscpd/depcruise/coverage/ratchet stages were run individually instead (see table above).
- No new unit tests were added at this checkpoint: changed-line coverage confirmed every line touched by Checkpoint 2 is already exercised.
- No product source changed at this checkpoint: acceptance ran entirely against the `d7bd12e8` build; the exact same `main.js` bytes measured here match Checkpoint 1/2's build output, confirming reuse rather than a silent rebuild drift.
