# Task 578 — Stop IR clicks from rebuilding the shared source index

> **For agentic workers:** Use `superpowers:systematic-debugging` for the attribution checkpoint, then `superpowers:executing-plans` for the fix checkpoints. Checkboxes track implementation and acceptance; the hypotheses below are not a confirmed diagnosis.

**Status:** planned (2026-09-27).
**Goal:** An ordinary click in the IR editor does not invalidate the shared per-revision source block index when the Markdown source did not change. The next index consumer therefore reuses the warm entry instead of rebuilding it with whole-document serialization.
**Tech stack:** TypeScript, Vditor/Lute, Vitest, Chromium Playwright and real VS Code with OS-level keyboard input.
**Spec:** The report, behavior contract and acceptance criteria in this file are the specification.
**Dependencies:** [Task 574](done/574-text-selection-performance.md) (shared index), [Task 577](done/577-selection-toolbar-settle-latency.md) (build holds) and [Task 196](done/196-find-and-replace.md) (Find on the index) are complete. Preserve their contracts. This task changes only what counts as a source-relevant editor mutation, or where such a mutation comes from.

## Report

Task 196's acceptance review measured this residual on 2026-09-26, and the Project Owner opened this task on 2026-09-27. In IR on the large synthetic fixture, a plain click in the editor can rebuild the shared source index even with Find closed and no edit. The rebuild costs one full `getValue`, two whole-document Lute serializations and a 0.2–0.7 s long task. Task 577 recorded the same trigger during drags: "the warm IR drag is invalidated during the gesture by an IR DOM mutation."

## Evidence so far (real VS Code, large fixture, OS XTEST session)

| Case | Wall | `getValue` | Root Lute | Fragment Lute | Index builds | Longest task |
| --- | --- | --- | --- | --- | --- | --- |
| IR click 1, Find closed (index possibly cold after open) | 875 ms | 1 | 2 | 122 | 1 | 722 ms |
| IR click 2, Find closed, different position (index warm from click 1) | 363 ms | 1 | 2 | 0 | 1 | 216 ms |
| IR click, Find open (Task 196 Checkpoint 5, first run) | 124 ms | 1 | 3 | 0 | 1 | 317 ms |
| IR click, Find open (Task 196 final run, different state) | 102 ms | 0 | 0 | 0 | 0 | 0 |
| WYSIWYG click, Find open | 102–149 ms | 0 | 0 | 0 | 0 | 0 |

- The rebuild is intermittent. It depends on where the click lands.
- It is IR-specific: WYSIWYG clicks on a warm index cost nothing.
- It is not Find's: it happens with Find closed.
- The shared index rebuilds when its MutationObserver sees a relevant mutation: `childList`, `characterData`, or an attribute other than `class`, `style`, `aria-*` or the fold markers. See `nav/source-block-index.ts::relevantMutations`.
- The consumers that then read the index are Details settle, block-handle hover and, when open, Find.

## Hypotheses to confirm or reject (not yet measured)

1. **IR marker reveal.** Vditor's `expandMarker`, and VMDE's `installIrMarkerReveal` (`editing/editor-caret.ts`), react to the caret entering an inline node. They may do more than toggle `vditor-ir__node--expand` (a `class` change, already ignored): for example, inserting or removing nodes, or rewriting text.
2. **Caret normalization on click.** Vditor's `setRangeByWbr`/`<wbr>` insertion and removal, or VMDE caret fix-ups (`editing/caret.ts`, `util/caret-gesture.ts`, `fixCJKPosition`), briefly insert and remove a node. This is a `childList` mutation pair that leaves the source unchanged.
3. **Placeholder/preview maintenance.** IR code/math preview refresh, `data-render` toggles or `vditor-ir__preview` re-render on focus change.
4. **A VMDE decoration** written into the editable DOM on click (gap cursor, fold affordance or block anchor) with an attribute or child not covered by the current filter.

Part 1 must attribute the mutation records before choosing a fix.

## Global constraints

- **Index correctness first.** A mutation that changes serialized Markdown must still invalidate. Never widen the filter to ignore a mutation class unless it is proven source-neutral for every record the filter admits, by serializer parity across the fixture and the edge cases below. An inserted-then-removed node pair is ignorable only if the proof covers the pair, not each record alone.
- Preserve caret, selection direction, IME/composition, focus, scroll, Undo/Redo, IR marker reveal behavior, block-handle actions, Details state accuracy, Find counts and highlights, exact source, and host/disk bytes.
- No disabled feature, global observer bypass, debounce-only fix, Lute fork, Worker, new setting or dependency, or generated-output edit. Changing vendored Vditor behavior needs a documented, minimal patch in the repository's existing patch mechanism; ask the Project Owner first if that becomes necessary.
- If the fix requires a new `SourceBlockIndexHandle` or `EditSync` contract, stop and ask the Project Owner (scope question).
- Read `DEVELOPMENT.md`, the VMDE Lute, testing and visual-debugging skills and the path-scoped rules. Follow the local queue's verification overrides.
- Keep model routing in the operator queue, not in this record. Leave `tasks/README.md` unchanged until actual closure. Make one focused local commit per checkpoint; do not push.

## Checkpoint 1 — Attribute the click mutation (red evidence)

**Reuse:** `test/vscode-e2e/selection-performance.spec.ts` and its probe, `test/vscode-e2e/find-replace-large.spec.ts` (`click-find-closed` phase), `test/vscode-e2e/helpers/xtest-input.ts`, the Chromium block-handle and details harnesses, and the synthetic fixture `test/vscode-e2e/fixtures/large-observable-models-synthetic.md` (copied into `baseDir`; never print its contents).

- [ ] Add a test-only recorder to the IR root. For each click in a warm-index phase, record every MutationObserver record that `relevantMutations` would admit: type, target node name and class, `attributeName`, added/removed node names and classes, and old/new `characterData` values. Truncate text values to their length plus a marker class, never fixture text. Also record whether `getValue()` before and after the click is byte-identical.
- [ ] Click targets on the large fixture, in IR, all after an idle hover warmed the index:
  - plain prose;
  - inside bold/italic/inline code;
  - inside a link;
  - a heading;
  - a list item;
  - a table cell;
  - fenced code source;
  - a math/diagram preview, if present.
  Repeat each target twice at different offsets. Include WYSIWYG as the control.
- [ ] Attribute each admitted record to its writer with a temporary stack probe (added and removed, not shipped). Record which of hypotheses 1–4 hold, per target, and whether the rendered Markdown changed (it must not for a plain click).
- [ ] Write red assertions as deterministic counts. Target shape, finalized in Part 1: for a click on an unchanged, warm IR source, 0 index builds, 0 full `getValue` calls and 0 root Lute calls in the click phase, across all targets.
- [ ] Use OS-level XTEST input for any keyboard steps. Browser-protocol input is diagnostic only.

## Checkpoint 2 — Remove the source-neutral invalidation

The design is finalized in Part 1 from Checkpoint 1's evidence. Candidate shapes, to be accepted or rejected with evidence:

- **Stop the mutation at its source.** If VMDE code writes a transient node, attribute or text into the editable DOM on click, move it outside the editable DOM or make it a no-op when nothing changes.
- **Filter a proven source-neutral class** in `relevantMutations`. Examples: an attribute that Lute never serializes, or a node type the serializer skips. The proof needs serializer parity on the real Lute IR DOM.
- **Batch-level neutrality.** Ignore a mutation batch only when it provably restores the prior DOM, such as a `<wbr>` insert/remove pair within one batch, verified structurally rather than by serializing.

- [ ] Implement the chosen design in the smallest set of files.
- [ ] Unit tests on the real Lute IR DOM: each ignored record class leaves `VditorIRDOM2Md` output unchanged. Every source-changing mutation still invalidates, including text edits, link href/image src changes (existing tests), node insertion/removal, and details/table structure.
- [ ] Confirm the existing `source-block-index.test.ts`, `block-handle.test.ts` and `details-toggle-controls.test.ts` invalidation contracts still pass unchanged.

## Checkpoint 3 — Integrated acceptance and closure

- [ ] The Checkpoint 1 red assertions pass for every click target in IR. Report before/after click-phase work counts and the longest task, using three matched serial real-VS-Code runs.
- [ ] Focused regressions pass with `--retries=0`: Chromium `block-handle.spec.ts`, `details.spec.ts`, `selection-bubble.spec.ts`, `selection-performance.spec.ts` and `find-replace-large.spec.ts`. Real VS Code: `block-handle.spec.ts`, `details-toolbar.spec.ts`, `selection-bubble.spec.ts`, `selection-performance.spec.ts`, `large-document-interaction.spec.ts`, `find-replace.spec.ts` and `find-replace-large.spec.ts`. Tighten `find-replace-large.spec.ts`'s relative click gate to an absolute 0 in IR if the evidence supports it.
- [ ] Exact source, host and disk equality after the click journeys; no dirty or history change from clicks.
- [ ] Changed-line coverage, typechecks and the network-free quality stages once on the final candidate. Record bundle bytes, the change from Task 196 (898,191 B) and the eager-module count as reporting-only.
- [ ] Update this record with the evidence, move it to `tasks/done/` and add the `tasks/README.md` entry only when every item above is complete.

## Execution progress

Not started.
