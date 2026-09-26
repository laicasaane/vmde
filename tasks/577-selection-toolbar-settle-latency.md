# Task 577 — Remove the editor freeze before the selection toolbar appears

> **For agentic workers:** Use `superpowers:systematic-debugging` for the attribution checkpoint, then `superpowers:executing-plans` for the fix checkpoints. Checkboxes track implementation and acceptance; the hypotheses below are not a confirmed diagnosis.

**Status:** planned (2026-09-26).
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

- [ ] Add a **settle** phase to the existing selection-performance specs: measure from the release event (`pointerup`, or the last Shift+Arrow keyup) to the first frame where the bubble is visible. Record the longest task and the rAF gaps in that window, plus full `getValue`, `indexBuilds`, exact-fallback captures and live marker insertions.
- [ ] Measure each case in IR and WYSIWYG: warm key (an idle hover already built the index), cold after one edit plus Undo, and cold after a keyboard-only selection. Include a small ordinary document as a control, so fixed latency (hypothesis 5) is separated from document-size-dependent work.
- [ ] Attribute the longest task in each case to its call path, using a temporary stack/timing probe (added and removed, not shipped) where the counters are not enough. Record which of hypotheses 1–5 hold, with numbers.
- [ ] Write the red assertions for the confirmed mechanism. Target shape (finalized in Part 1): no whole-document serialization or index build runs synchronously between release and the bubble's first visible frame, and the bubble becomes visible within one debounce interval plus two frames of release.
- [ ] Use OS-level XTEST input for the keyboard acceptance steps. Browser-protocol input is diagnostic only.

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

Not started.
