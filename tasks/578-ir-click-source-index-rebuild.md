# Task 578 — Stop IR clicks from rebuilding the shared source index

> **For agentic workers:** Use `superpowers:systematic-debugging` for the attribution checkpoint, then `superpowers:executing-plans` for the fix checkpoints. Checkboxes track implementation and acceptance; the hypotheses below are not a confirmed diagnosis.

**Status:** Checkpoint 1 committed at `83fbfd3e`; Checkpoint 2 parts A/B committed at `5b51f154` / `7c2166ae`. Part C is verified and ready for its separate commit request: 75 focused units, 27 Chromium cases and three real-VS-Code cases pass; every measured warm phase in both modes is 0/0/0. Checkpoint 3 integrated acceptance remains open (2026-09-27).
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

- [x] Add a test-only recorder to the IR root. For each click in a warm-index phase, record every MutationObserver record that `relevantMutations` would admit: type, target node name and class, `attributeName`, added/removed node names and classes, and old/new `characterData` values. Truncate text values to their length plus a marker class, never fixture text. Also record whether `getValue()` before and after the click is byte-identical.
- [x] Click targets on the large fixture, in IR, all after an idle hover warmed the index:
  - plain prose;
  - inside bold/italic/inline code;
  - inside a link;
  - a heading;
  - a list item;
  - a table cell;
  - fenced code source;
  - a math/diagram preview, if present.
  Repeat each target twice at different offsets. Include WYSIWYG as the control.
- [x] Attribute each admitted record to its writer with a temporary stack probe (added and removed, not shipped). Record which of hypotheses 1–4 hold, per target, and whether the rendered Markdown changed (it must not for a plain click).
- [x] Write red assertions as deterministic counts. Target shape, finalized in Part 1: for a click on an unchanged, warm IR source, 0 index builds, 0 full `getValue` calls and 0 root Lute calls in the click phase, across all targets.
- [x] Use OS-level XTEST input for any keyboard steps. Browser-protocol input is diagnostic only.

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

### Part 1 handoff — Checkpoint 1 probes (2026-09-27)

**Code-path reading (static, not measured).** The index drops its entry for three reasons (`nav/source-block-index.ts`): `'dom'` (any record in an observer batch that `relevantMutations` admits), `'revision'` (EditSync `advanceSourceRevision`: trusted `input`, `postExact`, `invalidate`, `reseed`, or `snapshotPair` revoking exact ownership) and `'authority'` (root/owner/mode change, or root `contenteditable="false"`). Admitted = every `childList`/`characterData` record, plus every attribute except `class`, `style`, `aria-*`, `data-vmde-foldable` and `data-vmde-list-foldable`. `setAttribute` queues a record even when the value is unchanged. Ranked by static likelihood:

1. **H4, VMDE decorations: confirmed writers exist.**
   - `links/caret-link-decorate.ts` → `caret-link.ts::applyCaretInside` sets and removes `data-caret-inside` on `[data-wiki-link="1"],[data-code-ref="1"],a[href],.vditor-ir__link` on every `selectionchange` (rAF-coalesced, installed on `#app` in `finish-init.ts`). The attribute is admitted. So a click into an IR link (`.vditor-ir__link`) invalidates, and so does the next click that leaves it (removal). This fires in WYSIWYG (`a[href]`) too.
   - `editing/fix-table-ir.ts`: the first IR table click in a session appends `#tablePanelId` (with its `innerHTML`) into the contenteditable IR root. That is an admitted `childList` record. Later clicks only change `style` (filtered).
   - `editing/gap-click.ts`: a mousedown whose target is the editor itself (an inter-block gap) inserts a ZWSP gap paragraph (`childList`). It is excluded from the plain targets and listed as an edge case.
   - `links/code-ref-decorate.ts` re-walks on `selectionchange`. It writes only for resolvable code refs, and the fixture has none, so it is expected absent.
2. **H3, preview maintenance: weak.** No `$$`, math or diagram fences are in the fixture (fences are C#, XML and plain), so that target is `notPresent`. Clicking a collapsed IR code preview makes Vditor's click handler move the caret into the source and `expandMarker` add a class. `code-source.ts` also only adds a class. No preview re-render runs without `input`.
3. **H1, marker reveal: ruled out as a direct writer by code.** Stock `ir/expandMarker.ts`, VMDE `installIrMarkerReveal`/`normalizeMarkerNavigationCaret` and the `patchIrBlurExpand` rAF only toggle classes and write the selection. No VMDE observer watches editor `class` and writes back (the attribute observers are chrome-only). Expect only non-admitted `class` records.
4. **H2, caret normalization: ruled out for in-block clicks by code.** Vditor inserts `<wbr>` on click only below the last block (`insertAdjacentHTML('<p data-block="0">…<wbr></p>')` + `setRangeByWbr`), plus `Undo.addCaret` after edits. `fixCJKPosition` is keydown-only. `editing/caret.ts` does no DOM writes. `util/caret-gesture.ts` writes to `documentElement`, which is outside the root.
5. **Not in the list: a stale precondition or a non-DOM key change.** Task 196's heading click at (12,12) is not explained by 1–4. It may be an invalidation left by the earlier (8,8) click, or by focus handling, and only paid for in the phase. Checkpoint 1 must prove the index is warm before each click.

**Paths (Checkpoint 1 commits test code only; `git diff media-src/src` must be empty).**
- New `test/vscode-e2e/ir-click-mutation-recorder.ts`: a page function `installIrClickMutationRecorder()` exposing `window.__vmdeIrClickRecorder` (`start(label)`/`stop()`). It is committed and test-only, like `find-replace-probe.ts`.
- New `test/vscode-e2e/ir-click-index.spec.ts`: skipped unless `VMDE_XTEST=1`, one VS Code session. It reuses `installFindReplaceProbe` for `fullGetValueCalls`, `rootLuteCalls`, `fragmentLuteCalls`, `indexBuilds` (`__vmdeBlockHandleCacheMetrics`, installed with `addInitScript` as in `find-replace-large.spec.ts`) and `longTaskMaxMs`.
- Optional Chromium isolation: a new `media-src/e2e/ir-click-index.spec.ts` on `details.html` (shared index, block handle, Details and stock Vditor IR click, but no caret-link, fix-table-ir, marker-reveal or gap wiring). It loads the fixture via `__details.editor.setValue` and imports the recorder from `../../test/vscode-e2e/`, as `selection-performance.spec.ts` imports its probe. If `details-harness.ts` needs a test-only fixture hook, keep that edit minimal.
- Temporary, deleted before commit: a stack-probe init script and a scratch source-map script.
- Leave `find-replace-large.spec.ts` unchanged; Checkpoint 3 tightens it.

**Recorder design.**
- Attach to the root `activeBlockRoot()` returns (`vditor.vditor.ir.element`/`.wysiwyg.element`). Use the index's options (`subtree`, `childList`, `characterData`, `attributes`) plus `attributeOldValue`/`characterDataOldValue`. Those options only add old values and do not change which records are delivered. Re-attach in `start()` if the root changed.
- Predicate: copy `relevantMutations` verbatim, with a source comment, rather than exporting it (no product change). Add a drift guard in the spec: read `media-src/src/nav/source-block-index.ts` in Node, slice `function relevantMutations`, and assert that the ignored list and the `aria-` prefix match the copy.
- Log every record, flagged `admitted`, so H1's `class` records are visible too.
- Record fields:
  - `batch` (the recorder callback index), `t`, and `lastEvent` (from capture listeners for pointerdown, mousedown, mouseup, click, selectionchange and focus/blur);
  - `type`, and the target's `nodeName`, `className` and `data-type`;
  - `attributeName`, `oldLen`/`newLen` and `sameValue`;
  - added and removed nodes as `{nodeName, className, dataType, textLen}`, plus an `outerHTML` hash so an insert/remove pair that restores the DOM shows as `restoredPair`;
  - for `characterData`: `oldLen`, `newLen`, `sameText` and the parent's `vditor-ir__marker*` class.
- Never record `textContent`, values or fixture text.
- The index flushes with `takeRecords()` in `currentKey()`, so its batches can split differently from the recorder's. Invalidation (any admitted record) is unaffected, but Checkpoint 2 must account for the split before relying on pair neutrality.
- Source identity: call the unwrapped `getValue` outside the armed window before and after each click, and return only `{length, sha256}` (`crypto.subtle`) → `sourceUnchanged`. At the end, compare host text and disk bytes with the fixture, as `find-replace-large.spec.ts` does.

**Temporary stack attribution** follows `caret-click-during-init-stacktrace-probe.spec.ts`: `addInitScript` wraps the writers in every frame before app code runs, and logs only while the recorder is armed and only when `this` is inside the root. Wrap:
- `setAttribute`, `setAttributeNS`, `removeAttribute`, `toggleAttribute`;
- `appendChild`, `insertBefore`, `removeChild`, `replaceChild`;
- `remove`, `replaceWith`, `before`, `after`, `append`, `prepend`, `insertAdjacent*`;
- the `innerHTML`, `outerHTML` and `textContent` setters;
- `CharacterData` `data`/`nodeValue` and `*Data`, plus `splitText` and `normalize`;
- `Range` `insertNode`, `surroundContents` and `deleteContents`/`extractContents`;
- `execCommand`;
- reflected property setters (`title`, `tabIndex`, `id`, `hidden`, `contentEditable`), and a `dataset` Proxy.

Each entry holds `{seq, api, target summary, attributeName, the first 8 main.js frames of new Error().stack}`. Correlate an entry with records by a WeakMap node id plus type and `attributeName`. `media/dist/main.js` is minified: map frames offline with `media/dist/main.js.map` and a scratch Node script using the already installed `@jridgewell/trace-mapping`. Do not add it to any `package.json`. Run once, delete the probe, rebuild, and confirm the file is gone from `git status` and that `main.js` bytes are unchanged.

**Targets and phase protocol.** Run IR first, then WYSIWYG as the control (the same targets through WYSIWYG selectors: `strong`, `code`, `a`, `h2`, `li`, `td`, `pre`). Use this fixed order, because leaving a link generates a record:
1. plain prose: the first `p[data-block="0"]` with no `.vditor-ir__node` child and at least 40 characters;
2. heading: an `h2.vditor-ir__node` text node, clicked at least 60 px from its left edge (the block-handle gutter and the Vditor heading panel intercepted a click in Task 577);
3. list item: `ol > li` text;
4. bold: `[data-type="strong"] > strong`;
5. italic: `[data-type="em"] > em`, if present, else `notPresent`;
6. inline code: `p [data-type="code"] > code`;
7. table cell: `table[data-block="0"] tbody td`. Its first offset is the session's first table click;
8. fenced code: offset 1 on the collapsed `.vditor-ir__preview`, offset 2 in the expanded `pre.vditor-ir__marker--pre > code`;
9. inline raw HTML: `[data-type="html-inline"]`, if Lute renders the fixture's tag-like prose tokens that way, else `notPresent`;
10. link: `[data-type="a"] > .vditor-ir__link`;
11. plain prose again, after the link, to capture the leave transition;
12. math/diagram: `notPresent`.

Offsets use `locator.hover/click({position})`: 30% and 70% of an inline element box at mid-height, or the first-line rects at ¼ and ¾ of a block's first text node.

Per click:
- (a) Scroll into view, hover the point, then wait for quiescence: 600 ms with no recorder record and no `getValue`.
- (b) Warm check: arm, move the mouse 1 px (a block-handle hover calls `index.read()`), wait 300 ms, and stop. Require `indexBuilds === 0` and no admitted records → `warmVerified`. Retry once, then report `false`.
- (c) Take the pre-click hash.
- (d) Arm (the recorder plus the counters), `click`, wait 500 ms (longer than the 100 ms marker dwell, the rAF writers and the Details settle), then make a trailing 1 px move, wait 300 ms, and stop. The trailing read exposes an invalidation that no consumer paid for inside the click.
- (e) Take the post-click hash, and record the caret anchor's `nodeName`/class and offset (no text).

**Red assertions.** Follow the Task 196/577 style: plain `expect`s over the collected phases, asserted after every phase has been logged. No `test.fail` (the repository uses none). The spec is committed red and fails until Checkpoint 2.
- For every IR phase with `present && warmVerified`: `indexBuilds === 0`, `fullGetValueCalls === 0` and `rootLuteCalls === 0`. Report failures as `mode/target/offset` lists.
- For every phase: `sourceUnchanged === true`, and host/disk equality at the end. These are expected green.
- The drift guard is expected green.
- WYSIWYG counters and the admitted-record counts are reported only. If a WYSIWYG link is non-zero, report it to Part 1; do not assert it (it is a scope question).

**Runs.** First `node build.mjs`, `npm run typecheck:vscode-e2e` (577 saw one unrelated `preview-task-checkbox.spec.ts` error; confirm it on `dev`), `npm run typecheck`, and `npx biome check --write <new files>`. Then:
- Chromium (isolation): `xvfb-run -a npm --prefix media-src run test:e2e -- ir-click-index.spec.ts --retries=0 --workers=1`.
- Real VS Code (attribution and red), inside the XTEST shell from `docs/os-keyboard-testing-setup.md`: `env -u ELECTRON_RUN_AS_NODE -u WAYLAND_DISPLAY XDG_SESSION_TYPE=x11 VMDE_XTEST=1 xvfb-run -a -s '-screen 0 1600x1000x24 +extension XTEST' bash`, then `openbox &`, then `npm --prefix test/vscode-e2e test -- ir-click-index.spec.ts --workers=1 --retries=0`. Run once with the stack probe and once clean and final.

Astra's sandbox blocks xvfb, loopback and `.git`, so every xvfb, VS Code or git step is a **RELAY REQUEST** with the exact command. Clicks go through Playwright mouse (the repository pattern). Any keyboard step uses `createXtestInput`.

**Expected outcomes (predictions).**
- IR link click and the post-link prose click: admitted `data-caret-inside` records → 1 build.
- First IR table click: a `childList` record for the panel.
- Plain prose, heading, list, bold and code: no admitted records, if the precondition holds.
- WYSIWYG link: also admitted.
- Chromium: no `data-caret-inside` or panel records, because that wiring is absent.

If a heading or prose click still builds with `warmVerified`, the stack probe decides. If it builds without `warmVerified`, the cause is H5 (pre-click).

**Edge cases.**
- Composition: none in these journeys.
- Vditor panels intercepting a click: log the target actually hit.
- An empty `lastEvent`, meaning an async writer (the dwell timer or `setTimeout`).
- Folded sections: none are folded.
- Readiness-ledger work: arm only after `waitForE2EReadiness`.

**Return to Part 1.**
- Per mode/target/offset rows: present, warmVerified, the counters, longest task, sourceUnchanged, and the admitted-record table (type, target, attribute or nodes, lastEvent).
- The mapped writer source for each admitted class.
- Hypothesis verdicts H1–H5 per target.
- The red failure output.
- The commands with exit codes.
- Proof that the probe was removed (`git status` and an empty `git diff media-src/src`).

**Open questions.**
- Does Lute's IR serializer ignore `data-caret-inside` and the table-panel subtree? This is Checkpoint 2 parity work; Checkpoint 1 only records `sourceUnchanged`.
- A fix for WYSIWYG links would touch shared caret-link code. Confirm the scope with the Project Owner.
- If the fixture lacks an italic or HTML-inline node, do not add fixtures without asking.

## Execution progress

### Checkpoint 1 Part 2 — completed red evidence (2026-09-27)

The clean, probe-free relay 5 completed **42 measured phases**, all `warmVerified=true` and
`sourceUnchanged=true`, with **6 explicit optional absences** and **no unavailable targets**.
All source/host/disk and setup assertions passed. The **only failure** was the intended warm IR
zero-work red assertion. Checkpoint 1 is complete and ready for the requested local commit, subject
to the orchestrator's final Jev review. Checkpoints 2–3 are untouched; no product fix was made.

Commit candidate paths are `test/vscode-e2e/ir-click-mutation-recorder.ts`,
`test/vscode-e2e/ir-click-index.spec.ts` and this record (including the preserved Part 1 handoff).
`find-replace-large.spec.ts`, product source, generated-output inputs, `tasks/README.md`, protected
queue files and git state are unchanged. The optional Chromium isolation spec was not added.

### Clean run evidence (relay 5) and attribution (relays 2–4)

Full log and copied artifacts are under
`/tmp/claude-1000/-home-user-Projects-vmde/ad8ae665-0ee1-4231-b125-ffd821f1c04b/scratchpad/`:
`578-cp1-relay5.log` and `578-cp1-relay5-results/ir-click-index-evidence.json` are the final clean
run; `578-cp1-relay4.log` and `578-cp1-relay4-results/ir-click-index-evidence.json` retain attribution.
Text-free mapped stacks: `/tmp/task578-relay4-mapped.json`. All **16 admitted records** have captured
writer APIs, matching WeakMap node IDs and mapped source frames. The recorder's batch boundaries
still need independent index-observer analysis before any Checkpoint 2 pair filter.

Every measured row below has **warmVerified=true** and **sourceUnchanged=true**. These are the
**clean relay-5** counts/times, without the temporary stack probe; times are reporting only.
`Build/Get/Root/Fragment` are deterministic counts. An offline comparison verified that all **41
shared phases** exactly match relay 4's four work counters and admitted-record fingerprints
(type, target name/class, attribute, sameValue and added/removed node names/classes/lengths/hashes).
The added WYSIWYG fenced-source offset has zero work and no admitted records.

| Mode | Target | Offset | Build | Get | Root | Fragment | Longest task ms | Admitted |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| ir | plain | 1 | 1 | 1 | 2 | 122 | 767 | 2 |
| ir | plain | 2 | 0 | 0 | 0 | 0 | 0 | 0 |
| ir | heading | 1 | 0 | 0 | 0 | 0 | 0 | 0 |
| ir | heading | 2 | 0 | 0 | 0 | 0 | 0 | 0 |
| ir | list | 1 | 0 | 0 | 0 | 0 | 0 | 0 |
| ir | list | 2 | 0 | 0 | 0 | 0 | 0 | 0 |
| ir | bold | 1 | 0 | 0 | 0 | 0 | 0 | 0 |
| ir | bold | 2 | 0 | 0 | 0 | 0 | 0 | 0 |
| ir | italic | 1 | 0 | 0 | 0 | 0 | 0 | 0 |
| ir | italic | 2 | 0 | 0 | 0 | 0 | 0 | 0 |
| ir | inline-code | 1 | 0 | 0 | 0 | 0 | 0 | 0 |
| ir | inline-code | 2 | 0 | 0 | 0 | 0 | 0 | 0 |
| ir | table | 1 | 1 | 1 | 2 | 122 | 617 | 2 |
| ir | table | 2 | 1 | 1 | 2 | 122 | 632 | 2 |
| ir | fenced-code | 1 | 0 | 0 | 0 | 0 | 0 | 0 |
| ir | fenced-code | 2 | 0 | 0 | 0 | 0 | 0 | 0 |
| ir | link | 1 | 1 | 5 | 8 | 244 | 1022 | 4 |
| ir | link | 2 | 1 | 5 | 8 | 244 | 924 | 4 |
| ir | post-link-plain | 1 | 0 | 0 | 0 | 0 | 0 | 0 |
| ir | post-link-plain | 2 | 0 | 0 | 0 | 0 | 0 | 0 |
| wysiwyg | plain | 1 | 0 | 0 | 0 | 0 | 0 | 0 |
| wysiwyg | plain | 2 | 0 | 0 | 0 | 0 | 0 | 0 |
| wysiwyg | heading | 1 | 0 | 0 | 0 | 0 | 0 | 0 |
| wysiwyg | heading | 2 | 0 | 0 | 0 | 0 | 0 | 0 |
| wysiwyg | list | 1 | 0 | 0 | 0 | 0 | 0 | 0 |
| wysiwyg | list | 2 | 0 | 0 | 0 | 0 | 0 | 0 |
| wysiwyg | bold | 1 | 0 | 0 | 0 | 0 | 0 | 0 |
| wysiwyg | bold | 2 | 0 | 0 | 0 | 0 | 0 | 0 |
| wysiwyg | italic | 1 | 0 | 0 | 0 | 0 | 0 | 0 |
| wysiwyg | italic | 2 | 0 | 0 | 0 | 0 | 0 | 0 |
| wysiwyg | inline-code | 1 | 0 | 0 | 0 | 0 | 0 | 0 |
| wysiwyg | inline-code | 2 | 0 | 0 | 0 | 0 | 0 | 0 |
| wysiwyg | table | 1 | 0 | 0 | 0 | 0 | 0 | 0 |
| wysiwyg | table | 2 | 0 | 0 | 0 | 0 | 0 | 0 |
| wysiwyg | fenced-code | 1 | 0 | 0 | 0 | 0 | 0 | 0 |
| wysiwyg | fenced-code | 2 | 0 | 0 | 0 | 0 | 0 | 0 |
| wysiwyg | html-inline | 1 | 0 | 0 | 0 | 0 | 0 | 0 |
| wysiwyg | html-inline | 2 | 0 | 0 | 0 | 0 | 0 | 0 |
| wysiwyg | link | 1 | 1 | 1 | 2 | 122 | 583 | 1 |
| wysiwyg | link | 2 | 0 | 0 | 0 | 0 | 0 | 0 |
| wysiwyg | post-link-plain | 1 | 1 | 1 | 2 | 122 | 586 | 1 |
| wysiwyg | post-link-plain | 2 | 0 | 0 | 0 | 0 | 0 | 0 |

The corrected WYSIWYG fenced-source offset is now measured and passes its source/setup checks.
Click 1 reveals the separate source and hides the preview; offset 2 explicitly targets
`[data-type="code-block"] pre.vditor-wysiwyg__pre > code`. Source geometry is deferred until click 1,
just like IR. No unavailable-target or missing-required-target assertion failed in relay 5.

Absent optional offsets: IR HTML-inline 1–2 (DOM nodes exist but no rendered click target), and
math/diagram 1–2 in both modes (0 DOM candidates). There is **no relay-4/relay-5 HTML-inline drift**:

| Relay | Mode | DOM candidates | Painted candidates | Sample node shape | Outcome, both offsets |
| --- | --- | --- | --- | --- | --- |
| 4 | IR | 82 | 0 | SPAN.vditor-ir__node with hidden marker CODE | notPresent as click target |
| 5 | IR | 82 | 0 | same SPAN shape | notPresent as click target |
| 4 | WYSIWYG | 82 | 82 | CODE[data-type="html-inline"] | measured |
| 5 | WYSIWYG | 82 | 82 | same CODE shape | measured |

The painted CODE entries in relay 4 belong to **WYSIWYG**, not IR. Both runs report the same
mode-specific DOM/visibility distinction. `notPresent` is explicitly absence of an eligible painted
click target; the preflight retains the 82 IR DOM candidates rather than claiming the node type is
missing from the document.

### Admitted-record table and writer attribution

| Phase | Records / target | Attribute or nodes | Last recorded event | Mapped writer |
| --- | --- | --- | --- | --- |
| ir/plain/1 | childList on PRE.vditor-reset | append DIV wrapper | click on P | fix-table-ir.ts:205, called at 281 |
| ir/plain/1 | childList on wrapper DIV | add DIV.vditor-panel.vditor-panel--none.vditor-panel-ir plus #text | click on P | fix-table-ir.ts:206, called at 281 |
| ir/table/1 | attributes on two BUTTON.vditor-icon.vditor-tooltipped.vditor-tooltipped__n nodes | disabled on moveColumnLeft and moveRowUp; sameValue=false | click on TD | fix-table-ir.ts:156 via 158/160, called at 334 |
| ir/table/2 | attributes on the same two buttons | disabled; sameValue=true | click on TD | same reflected disabled setter stacks |
| ir/link/1 | four childList records on SPAN.vditor-ir__marker.vditor-ir__marker--link | add #text length 16; add #text length 18; remove 18; remove 16; same-node/hash restored pairs | click on SPAN.vditor-ir__link in clean run | rewrap-command.ts:241/245 inserts; 212 removes, via 271/272 |
| ir/link/2 | same four-record shape, new marker node IDs | same two marker lengths and restored-pair hashes | click on SPAN.vditor-ir__link in clean run | same stacks |
| wysiwyg/link/1 | attributes on A | set data-caret-inside | selectionchange | caret-link.ts:72 via caret-link-decorate.ts:39 and observe-coalesce.ts:28 |
| wysiwyg/post-link-plain/1 | attributes on the same A | remove data-caret-inside | selectionchange | caret-link.ts:67 via caret-link-decorate.ts:39 and observe-coalesce.ts:28 |

The IR link prediction was **not confirmed**: these clicks do not produce `data-caret-inside` records.
Their stack chain is `link-popover.ts:721 (onClickCapture) → makeOwner:602 → sourceSpanFor:275 →
captureRewrapSourceRange (rewrap-command.ts:355) → sourceSelectionFromDom:280 →
markerSourceSelectionFromDom:241/245`. That helper inserts end/start text markers, serializes, and
removes them in `finally` through lines 271/272 and 212. The first two admitted records have
`restoredPair` IDs matching the removals. The caret remains in the prior fenced-code source because
the popover intercepts the click. Consequently the later IR prose click has no caret-link removal.

The attribution recorder's document capture listeners were installed after the popover's document
handlers, which call `stopImmediatePropagation`; that is why IR-link `lastEvent` is null despite the
mapped synchronous click handler. **Null did not prove an async writer.** The clean recorder listens
in window capture so it observes the actual pointer/click target before document-level interception.
This changes test observability only. Relay 5 confirms `lastEvent.type=click` on
`SPAN.vditor-ir__link` for all eight admitted IR-link records; all other admitted fingerprints and
work counters match the attribution run.

### Per-target hypothesis verdicts

| Measured targets | H1 marker reveal | H2 caret normalization | H3 preview maintenance | H4 VMDE writer | H5 precondition |
| --- | --- | --- | --- | --- | --- |
| IR plain/1 | not an admitted writer | not observed | not observed | confirmed: table panel creation | warm check passed |
| IR table/1–2 | not an admitted writer | not observed | not observed | confirmed: panel button disabled writes, including no-op writes | warm checks passed |
| IR link/1–2 | not an admitted writer | predicted WBR/caret-normalization path not observed; transient text-marker mechanism found in a different owner | not observed | confirmed additional VMDE writer: link-popover source-range capture | warm checks passed |
| WYSIWYG link/1 and post-link-plain/1 | not applicable | not observed | not observed | confirmed: caret-link attribute add/remove | warm checks passed |
| All other completed offsets in the measurement table | no admitted marker/class writes | no admitted normalization writes | no admitted preview writes | no admitted VMDE writes | warm checks passed |
| Absent optional offsets only | unmeasured | unmeasured | unmeasured | unmeasured | unmeasured |

These are per-journey observations, not global serializer-neutrality proofs. Revision/authority
invalidation reasons are not independently instrumented. The earlier stale-index-precondition
explanation was not observed in any completed warm check. No filter or product contract was changed.

### Source identity and red assertions

All measured IR pre/post serializations: **181,855 UTF-16 code units / 181,865 UTF-8 bytes**, SHA-256
`9cb6fdff071edf7fd93eff2f7560db9b64f172cc67d801256303fed53c19bcb8`.
All measured WYSIWYG pre/post serializations: **181,842 UTF-16 code units / 181,852 UTF-8 bytes**, SHA-256
`f8b8e9da0dcb65c93e17e39463aaf8ac46289e2d5f2f0902905c159c85fcb34e`.
These are per-mode serializer baselines, not assertions that normalized serialization equals the
original fixture text. Every phase compared before/after hashes outside the armed window.

Final relay-4 and relay-5 host and disk equality checks both passed; the document was found, **dirty=false,
version=1**. Host and disk SHA-256 both equal fixture SHA-256
`a4a39d6f6c605eb82b0e03a236f67388bceeae9a85450b0d4285053b28299f65`.
The old evidence's host `length=174517` was JavaScript UTF-16 length; disk `length=174527` was Buffer
byte length. A Node check measured **174,517 UTF-16 code units / 174,527 UTF-8 bytes**, and verified
`Buffer.from(decodedFixture, 'utf8').equals(fixtureBytes) === true`. This is a units difference,
not a source discrepancy. Relay 5 explicitly reports host `utf16Length=174517`, host
`utf8Bytes=174527` and disk `utf8Bytes=174527`, with matching SHA-256 hashes.

The clean relay-5 failure output is the intended red assertion
`warm IR click work counts (red until Checkpoint 2)` at `ir-click-index.spec.ts:777`:

```text
indexBuilds:       [ir/plain/1, ir/table/1, ir/table/2, ir/link/1, ir/link/2]
fullGetValueCalls: [ir/plain/1, ir/table/1, ir/table/2, ir/link/1, ir/link/2]
rootLuteCalls:     [ir/plain/1, ir/table/1, ir/table/2, ir/link/1, ir/link/2]
Expected each list: []
```

The process exits **1** intentionally. No `test.fail` annotation or relaxed expectation masks it.
Source identity, final host/disk equality, the predicate drift guard, missing-target and unmeasured-
target gates all passed. WYSIWYG link/leave work is reported only, as the handoff requires.

### Probe removal, validation and relay history

The temporary `test/vscode-e2e/ir-click-stack-probe.tmp.js` and `/tmp/task578-map-stacks.mjs` were
removed after mapping relay 4. Spec init-script wiring and stack globals/fields were also removed.
Mapped JSON evidence remains available. Removal checks passed; `git status` no longer lists the
probe, and `git diff --numstat -- media-src/src src tasks/README.md` is empty.

| Command/check | Exit / result |
| --- | --- |
| node build.mjs | 0; built once, reused across relays |
| npm run typecheck | 0; unchanged webview inputs, not rerun |
| targeted Biome on both new TS files | 0 on clean candidate; initial complexity errors were fixed |
| npm run lint:ci | 0 on clean candidate, 1069 files |
| npm run typecheck:vscode-e2e | 1; only existing preview-task-checkbox.spec.ts:122 TS2339, no new-file errors |
| focused Playwright --list | 0; one test |
| temporary scripts node --check, stack URL parser checks | 0 before removal |
| predicate drift guard / temporary-script removal / git diff --check | 0 |
| npm run check:bundle-size | 1, reporting-only: 898,191 bytes, delta 0 from Task 196 |
| npm run check:startup-cost | 1, reporting-only: 346 eager modules |
| relay 1 | 1 / 58.0 s; italic union-box hover, 8 completed phases |
| relay 2 | 1 / 23.3 s; premature bold pre-hover hit guard, 6 completed phases |
| relay 3 | 1 / 49.0 s; hidden HTML-inline target, 16 completed phases |
| relay 4 | 1 / 3.1 min; WYSIWYG preview/source target transition, 41 completed phases |
| final clean relay 5 | 1, intended IR red assertion only; 42 completed phases, 6 optional absences, 0 unavailable |

Relays 1–3 logs are `578-cp1-relay{1,2,3}.log` under the same orchestrator scratchpad; partial artifacts
and mapped JSON were retained. Relay 1's Playwright failure included fixture text; do not quote it.
Action errors now suppress element-bearing messages, and the relay's `PLAYWRIGHT_NO_COPY_PROMPT=1`
suppresses automatic page snapshots. Read-only per-mode preflight logs all 24 target/offset plans;
optional no-painted-target cases are distinct from present-but-unmeasured failures. Failed targets
are collected without losing later phases, then fail a deferred setup gate. All source/hash gates
use booleans or hashes rather than text-bearing assertion diffs. No keyboard steps were required;
`createXtestInput` verified and focused the X11 client, and the spec is gated by `VMDE_XTEST=1`.

Build SHA-256 remains `c1fb62d1c39c3357acf2c22f41765cdd036f09be7b33264643d272318bbea61c`.
Test-only edits are not bundle inputs, so the operator's build-reuse policy overrides the handoff's
redundant post-probe rebuild. Dependency/vendor audits, broad suites and aggregate quality were
omitted under the explicit focused-testing policy. Relevant static logs are `/tmp/task578-build.log`,
`/tmp/task578-typecheck.log`, `/tmp/task578-clean-lint.log`, `/tmp/task578-clean-typecheck-vscode.log`
and `/tmp/task578-clean-spec-list.log`.

Jev is exposed and its skill was read. Its earlier gate call was blocked by `MCP tool call requires
approval, but approval policy is never`; no verdict exists. The orchestrator will run the final gate
with the final diff and real check logs. No Codex settings were changed. Caveman Mode and the task
header's optional Superpowers skills are unavailable in the exposed tools/skill locations.

### Completion and Part 1 handoff

- Checkpoint 1 implementation, attribution and clean red validation are complete. All five
  Checkpoint 1 checkboxes are checked; Checkpoints 2–3 remain open. Task 578 is not closed and
  tasks/README.md is unchanged.
- Request a local commit of the three explicit candidate paths after the orchestrator's Jev gate.
  No git mutation has been performed by this agent. Jev has no verdict in this approval-blocked
  session; pass the real exit-1 red evidence rather than claiming a green runtime test.
- Checkpoint 2 still needs serializer parity for panel nodes, disabled/data-caret-inside attributes
  and transient marker pairs before any ignore rule. IR link-popover source-range capture is an
  additional measured writer, outside the handoff's initial ranked predictions. WYSIWYG caret-link
  invalidation is measured too; confirm shared-code fix scope with Part 1/the Project Owner.

### Part 1 handoff — Checkpoint 2 design (2026-09-27)

**Inputs.** Checkpoint 1's clean relay-5 attribution at `83fbfd3e`, plus static reading of the writers, the index, EditSync and vendored Vditor. The call accounting below comes from reading the code. It was not measured, except for the totals quoted from the evidence table. `relevantMutations` is unchanged in this design, so the recorder drift guard stays green.

**Tier: Heavy.** The design changes the IR link popover's source-span proof. Edit and Unlink rely on that proof for exact bytes, and it currently uses the IR marker mapping (`captureRewrapSourceRange`). The design also moves a VMDE panel that currently lives inside the editable IR root. No `source-block-index.ts` or `EditSync` change is planned.

**Writer 1: first IR click appends the table panel (`ir/plain/1`).**
- Root cause: `editing/fix-table-ir.ts::insertTablePanel` (`eventRoot.appendChild(tablePanel)` at 205, `innerHTML` at 206) is called from the root click listener (281) on every IR click, including non-table ones. The first call creates `#fix-table-ir-wrapper` inside `pre.vditor-reset`. Upstream Vditor keeps its own panels outside the editable root: the WYSIWYG `popover`/`selectPopover` are siblings of `pre.vditor-reset` in `div.vditor-wysiwyg` (`vditor/src/ts/wysiwyg/index.ts:49-59`). Upstream IR has no table panel, so this wrapper is VMDE's own.
- Fix (stop at source): create the wrapper as a sibling of the IR root, in `eventRoot.parentElement` (`div.vditor-ir`, `position: relative` in `_ir.less`). Replace `eventRoot.querySelector('#…')` with a lookup there, or with a closure reference. Keep lazy creation: `fixPanelHover()` (`util/utils.ts`) queries the panel once at init, after `fixTableIr()`. Eager creation would newly bind its 2 s collapse delay, a behavior change that is out of scope. Keep the id, `contenteditable=false`, `user-select:none`, the 0×0 absolute box, the mousedown `preventDefault`, and the click handler with `stopPropagation`. The id-scoped CSS (`main.css:1262-1290`, `vscode-chrome.css:253-270`) keeps matching.
- Geometry requirement: `.vditor-ir pre.vditor-reset { position: relative }` (`main.css:1227`) and Vditor's `overflow: auto` make the IR root both the wrapper's containing block and its scroller. Today the panel therefore scrolls with its cell and is clipped by the root. Preserve both:
  - Put the 0×0 id'd layer inside a non-id clip box (`position:absolute; inset:0; overflow:hidden; pointer-events:none`) in `div.vditor-ir`.
  - Give the panel `pointer-events:auto`.
  - On a passive root `scroll` listener, set the id'd layer's `transform: translate(-scrollLeft px, -scrollTop px)` once at creation and again on each scroll. The click-time positioning is delta-based on `getBoundingClientRect` (fix-table-ir.ts:297-327), so it stays correct under the transform.
  - Before changing code, measure the panel–cell offset after a 200 px root scroll in Chromium, and assert the same offset afterwards.
  - If the table geometry specs below cannot be matched within this shape, stop and return to Part 1 with the measurements. Do not switch designs silently.
- Result: panel creation, `style`/`class` churn and writer 2 all leave the observed subtree. That also frees the block-handle `unitCache` observer (`nav/block-handle.ts:167`), which admits every attribute, and edit-sync's `seedObserver`.

**Writer 2: `disabled` on panel buttons (`ir/table/1–2`).** `updateTableActionDisabled` (fix-table-ir.ts:152-163) sets `button.disabled` on every table click, including no-op writes (`sameValue=true` on table/2). Relocation alone removes these records from the root observer. Checkpoint 1 recorded `sameValue=false` on table/1, so a no-op guard alone (`if (button.disabled !== value)`) would not fix table/1. That guard is optional hygiene.

**Writer 3: IR link click inserts transient markers (`ir/link/1–2`).**
- Root cause: `link-popover.ts::onClickCapture` (721) → `makeOwner` (573-626) → `sourceSpanFor` (263) → `captureRewrapSourceRange` (`rewrap-command.ts:342`) → `markerSourceSelectionFromDom` (221-274). That function inserts two text nodes into the live `.vditor-ir__marker--link`, serializes `editor.innerHTML`, and removes them in `finally`.
- The same click also does the popover's own whole-document work, independent of the markers:
  - `makeOwner` calls `deps.snapshotExactMarkdown()` (→ `snapshotPair` → `getValue`) and `outer.getValue()` (600-601).
  - The marker serialization is a root-size Lute call.
  - `sourceGroupBinding` → `resolveBlockHandleUnits` re-proves `proof.serialize(root.innerHTML)` when its `unitCache` was dropped. The marker records drop it.
  - The popover's own `#app` observer (868-878) then sees the marker `childList` records and runs `sameLiveOwner` (another `getValue` plus `snapshotExactMarkdown`).
  - With the index rebuild, that plausibly accounts for the measured 5 `getValue` / 8 root Lute. This is inference, not attribution.
- Conclusion: removing the mutation alone would give `ir/link` 0 index builds, but at least 2 `getValue` and at least 2 root Lute calls. The committed red assertion (0/0/0) cannot pass that way.
- Chosen fix (L2, pending owner question Q1):
  - Add `index: SourceBlockIndexHandle` to `LinkPopoverDeps`, as `installSelectionBubble` already receives it. `finish-init.ts:197` creates `sourceIndex` before `installLinkPopover` at 220. This reuses the existing handle; there is no new contract.
  - In `makeOwner`, take `entry = deps.index.read()` and require `entry.key.mode === 'ir'` and `entry.key.root === editor`. Use `entry.exact`/`entry.rendered` as `owner.exact`/`owner.rendered`.
  - Bind the group from `entry.units`: the unit whose `members` contain the target. Take rendered group ranges from `scanMovableBlocks(entry.rendered)` by index, with the same length and kind checks as `sourceGroupBinding`.
  - Memoize the per-entry scans with `entry.memo(slot, …)`: that scan and `listLinkPopoverCandidates(exact|rendered)`.
  - Choose the candidate by ordinal, `index = liveNodes.indexOf(target)`, instead of by marker offsets. Keep every current structural gate: equal counts of source candidates, rendered candidates and live nodes; `orderedTargetIdentityMatches` (kind, label, destination and title, with the live destination read from the marker text); and `planLinkPopoverAction(...unlink).status === 'changed'`.
  - If `entry` is null or `units` is null, set `sourceSpan = null`: Open and Copy work, Edit and Unlink are disabled, as today when binding fails.
- Why this is equivalent:
  - IR `getValue()` is `lute.VditorIRDOM2Md(ir.element.innerHTML)` (`vditor/src/ts/markdown/getMarkdown.ts`).
  - `resolveBlockHandleUnits` returns non-null units only after `proof.serialize(root.innerHTML) === rendered` (`block-handle.ts:363-367`), and the entry key's `domRevision` proves no admitted mutation since.
  - So `entry.rendered` equals `getValue()` under Task 574's existing contract. The marker check was a redundant cross-check of an ordering the old code already assumed (`liveNodes[index] === target`).
- Keep the marker-based `sourceSpanFor` for action time: `prepareLinkAction` (398-413) re-proves with fresh `getValue` and requires `rebound` to equal the ordinal span. Every Edit or Unlink therefore still cross-checks exact offsets, and a divergence fails closed. Action time is followed by a real edit anyway, so its markers are harmless.
- Fallback if Q1 is declined (L1): the same ordinal binding on fresh `snapshotPair`, with no markers at click time. The acceptance for `ir/link` would then need owner-approved amendment to "0 index builds; `getValue`/root reported, not above before".

**Writer 4: WYSIWYG caret-link (`links/caret-link.ts:67/72` via `caret-link-decorate.ts:39`).** This has the same cause class: a VMDE attribute write into editable DOM. It is not IR-only. `LINK_LIKE_SELECTOR` includes `.vditor-ir__link`, wiki chips and code refs. An IR click into a wiki chip or code ref, which the link popover does not intercept, or keyboard caret entry into an IR link, would invalidate the same way. The fixture has none, so this is unmeasured. It is **owner question Q2**, not implemented here.
- Recommendation if approved: switch the decoration to a VMDE class (`vmde-caret-inside`). Task 574 already treats `class` as neutral, so this stops invalidation without widening the filter.
- Risk: Task 457 chose an attribute to avoid Vditor class churn. It touches `main.css:1329/2796/2827`, both caret-link unit tests and `wiki-chip-focus.spec.ts`.
- Alternative: add `data-caret-inside` to the ignore list. This needs a real-Lute parity proof for every selector shape in both modes. Wiki chips serialize through `wiki-serialize.ts`, so prove the attribute cannot reach `VditorDOM2Md` output.

**Rejected.**
- (a) Filtering the wrapper subtree in `relevantMutations`. The skill's block-drop and `data-render` rules make this provable, but it widens the index contract while a source fix exists, and needs a nav-level helper marker.
- (b) A "quiet"/self-mutation guard or `takeRecords()` around marker insertion. That is a new `SourceBlockIndexHandle` contract (owner scope). The `unitCache`, link-popover, `seedObserver` and ToC observers would each need it. It leaves the popover's `getValue` cost in place. The only precedent, `toc-invalidation.ts:156/186/224` (`takeRecords` after its own render, plus a `.vditor-panel` exclusion), is consumer-local.
- (c) Batch pair-neutrality for the marker pairs. `currentKey()` drains with `takeRecords()` and can split batches (Checkpoint 1 note), and this still leaves the `getValue` cost.
- (d) Serializing a detached clone with markers. It is mutation-free but still does a whole-document Lute call. That call would only move to the fragment counter, which games the metric.
- (e) Eager in-root panel creation. `setValue`, mode switch and IR Undo rebuild `innerHTML` and drop or re-clone the wrapper, and real `disabled` changes still invalidate.

**Edge cases Astra must check.**
- First IR click after open, after a mode round-trip and after `setValue`/reseed: the panel is created outside the root with 0 records.
- Table panel:
  - show/hide/position on cell and non-cell clicks, narrow panes, and a scroll while shown;
  - alignment `--current` highlight;
  - every button, including move and range actions, `disabled` state, and hotkeys with `disableVscodeHotkeys`;
  - buttons still work after IR Undo/Redo (static concern: an in-root wrapper can be captured in undo HTML without listeners; unverified).
- Link popover:
  - Open/Copy/Edit/Unlink exactness and one-step Undo/Redo;
  - the noncanonical (CRLF/table-normalized) document;
  - images and link-wrapped images;
  - several links per block;
  - cold index (the first click builds once);
  - index key null (SV, or root `contenteditable=false`);
  - `selectedOwner` keyboard entry;
  - composition hides the popover.
- Record whether `sourceSpan` was non-null for the fixture's link targets before and after. The measured 244 = 2×122 fragments hints that `orderedTargetIdentityMatches` may not have run, so the old outcome must be compared, not assumed.
- Focus and scroll are unchanged. Details state stays accurate. Find counts and highlights, with Find open, are unchanged. The gap click still inserts its ZWSP paragraph (a legitimate record).

**Unit tests (Vitest, real Lute through `media-src/src/testing/real-lute.ts`).**
- The IR serialization of a table fixture is identical with and without the old in-root wrapper markup, in each panel state. This documents that relocation changes no bytes.
- A new `fix-table-ir` jsdom test: a click creates the wrapper outside `vditor.ir.element`. A root-scoped `MutationObserver` sees no records across the click, `disabled` updates and alignment updates. The scroll transform is applied.
- Link popover (new unit test or extended harness): the ordinal span equals the marker-derived `captureRewrapSourceRange` span on a real-Lute IR DOM for several links per block, an image, a link-wrapped image, and a noncanonical source. A reordered, missing or extra live node yields `sourceSpan = null`. `makeOwner` performs no DOM mutation (observer) and no `getValue` on a warm index.
- The existing `source-block-index.test.ts`, `block-handle.test.ts` and `details-toggle-controls.test.ts` pass unchanged. These cover text edits, href/src changes and node insertion/removal.

**Runs (every xvfb, VS Code or git step is a RELAY REQUEST; Astra's sandbox blocks xvfb, loopback and `.git`).**
1. `node build.mjs`, `npm run typecheck`, `npm run typecheck:vscode-e2e` (the known `preview-task-checkbox.spec.ts:122` error only), and targeted `npx biome check`.
2. Targeted Vitest.
3. Chromium: `xvfb-run -a npm --prefix media-src run test:e2e -- link-popover.spec.ts link-popover-noncanonical.spec.ts table-hotkey.spec.ts mouse-selection.spec.ts table-resize.spec.ts webview-behaviors.spec.ts block-handle.spec.ts details.spec.ts --workers=1 --retries=0`. `media-src/e2e/link-harness.ts` must pass an index built with `createSourceBlockIndex`.
4. Real VS Code, in the XTEST shell from the Checkpoint 1 handoff:
   - `npm --prefix test/vscode-e2e test -- ir-click-index.spec.ts --workers=1 --retries=0`. The red assertion must turn green: every IR row 0/0/0, `sourceUnchanged`, host and disk equal.
   - Then `link-popover.spec.ts table-operations.spec.ts contextual-panel-clearance.spec.ts gap-cursor.spec.ts hr-edit.spec.ts` with the same flags.
   - Checkpoint 3 owns the broader regressions and the matched runs.

**Expected outcome.** Every IR row reads 0 builds, 0 `getValue` and 0 root Lute. `ir/link` fragment calls drop to only `candidateTuple` renders. WYSIWYG link and leave stay at 1 build (Q2).

**Owner questions (blocking for their parts only).**
- **Q1:** may the link popover consume the shared index (L2) and replace click-time marker mapping? If not, amend the `ir/link` acceptance (L1). Writers 1–2 can proceed meanwhile.
- **Q2:** is caret-link invalidation (WYSIWYG, and unmeasured IR wiki/code-ref/keyboard) in this task? If so, which option: class or ignore-list?
- Follow-up, not this task: once the wrapper leaves the root, `isHelper` (`trailing-paragraph.ts:135`) and the Vditor splice-boundary patch for `contenteditable=false` neighbors become dormant for it. Also, `fixPanelHover` appears never to bind, because the panel is lazy (static observation).
- Effort note: this design was produced by a general-purpose subagent with only a model override, at the session's medium effort, not the requested max.

### Part 1 handoff — Checkpoint 2 addendum: caret-link class (2026-09-27)

**Decision (Project Owner, 2026-09-27).** Q2 is in scope. Replace the `data-caret-inside` attribute with a CSS class. `relevantMutations` (`nav/source-block-index.ts:95-107`) stays unchanged, so the recorder drift guard (`guardPredicateDrift`) stays green. **Tier: Medium.** This touches one pure module, its DOM wiring, three CSS selectors and three tests. There is no serializer, index or EditSync contract change.

**Class name: `vmde-caret-inside`.** It follows the `vmde-` prefix. The closest precedent is a state class that VMDE toggles on editable nodes: `vmde-cell-selected` on `td` (`editing/table-cell-selection.ts:215`). Other VMDE classes already sit on editable nodes: `vmde-table-resized` (`chrome/table-resize.ts:79`), and `vmde-code-ref` on inline `code` / `vmde-code-ref-chip` (`links/code-ref-decorate.ts:66-67,154,190`). Rename `CARET_INSIDE_ATTR` to `CARET_INSIDE_CLASS` and use `classList.contains/add/remove` plus the `.vmde-caret-inside` query. Keep the no-write-when-unchanged idempotence. Task 457 chose an attribute to avoid "Vditor class churn". That risk is not present here: no Vditor or VMDE code assigns `className` or `setAttribute('class')` on `a`, `.vditor-ir__link`, chips or code refs (the only such writes are on newly created nodes). Rewrite the rationale comment at `caret-link.ts:29-33` (ts.md rule).

**Every reader and writer of `data-caret-inside`** (rg excluding dist; `tasks/done/457`, `tasks/done/502` and `LOCAL_AGENT_TASK.md` are history, leave them):

- Writer/reader: `media-src/src/links/caret-link.ts:33` (constant), `:64` (query), `:67` (remove), `:71-72` (has/set).
- Comments only: `links/caret-link-decorate.ts:1,16`, `boot/finish-init.ts:375`, `main.css:1325` (comment block 1321-1328).
- CSS: `media-src/src/main.css:1329` `[data-caret-inside]`, `:2796` HC `:is(body.vscode-high-contrast, body.vscode-high-contrast-light) [data-caret-inside]`, and `:2827` inside `@media (forced-colors: active)`.
- There are no hits in `vscode-chrome.css`, `media/markdown-themes/*.css`, `src/` (host), `media-src/e2e/` or docs. The `caretInside` names in `media-src/e2e/gap.spec.ts` and `callout-ir*.ts` are unrelated.
- Tests: `links/caret-link.test.ts:4,113-142` (`applyCaretInside` block), `links/caret-link-decorate.test.ts:3,6,78,89,99-100,129`, and `test/vscode-e2e/wiki-chip-focus.spec.ts:12,112-114,123,211`.

**Can Lute or the serializers see the class? Reasoning says no; an unreviewed scratch probe agrees.** The Part 1 agent ran a scratch probe of the vendored `lute.min.js` with the `real-lute.ts` options. Executable probes belong to Part 2, so Astra must reproduce this as the committed real-Lute unit below; the scratch result is not acceptance evidence.

- IR `VditorIRDOM2Md` and WYSIWYG `VditorDOM2Md` output was byte-identical with and without the class and the attribute, on `a`/`.vditor-ir__link` (inline, title, reference, link-wrapped image, autolink) and `code` with the code-ref class.
- `Spin*` re-renders drop the class, as they drop the attribute today; the next `selectionchange` repaints it.
- Wiki chips: `wiki-serialize.ts:26` `CHIP_RE` matches `class="[^"]*wiki-link-chip[^"]*"`, so `class="wiki-link-chip vmde-caret-inside"` still matches.
- Copy/cut: Vditor IR (`ir/index.ts:91-92`) and WYSIWYG (`wysiwyg/index.ts:222-243`) set `text/plain` from the serializer or `href` and `text/html` to `""`. VMDE's only copy handler (`table-cell-selection.ts:328-329`) writes plain text and Markdown. Paste runs `Lute.Sanitize` + HTML→MD. The class does not reach clipboard HTML. A native drag of editor HTML carries it, as it carries the attribute today.

**Other MutationObservers.**

- **Newly triggered:** `chrome/webview-context.ts:128-133` (`attributeFilter: ['class','data-type','data-wiki-link']`). A class toggle now calls `stampWebviewContexts(root, link)`. It is scoped and idempotent (`setContext` writes only on change), so no DOM writes are expected. Assert this (below).
- **Unchanged (every attribute already counts):** `nav/block-handle.ts:167-178` `unitCache`, and direct `resolveBlockHandleUnits` callers (`block-action-client`, `find-map`, `block-transform-command`). Pre-existing re-proof cost, not the shared index; out of scope.
- **Unchanged, identical treatment:** `chrome/table-resize.ts:593-599` treats a non-table `class` as `membership`, as it treats `data-caret-inside` today.
- **Unaffected (childList/characterData only, or filters without `class`):** `util/mutation-impact.ts`, edit-sync `seedObserver`, link-popover, selection-bubble, toc-invalidation, code-ref, link-like-semantics, gap-paragraph, split-scroll-sync, `responsive-tables.ts:151`, `details-toggle.ts:546`, and `style`-only filters.

**CSS migration.** Replace the three selectors in place, keeping their order: `.vmde-caret-inside`, `:is(body.vscode-high-contrast, body.vscode-high-contrast-light) .vmde-caret-inside`, and the forced-colors `.vmde-caret-inside`. Specificity is unchanged ((0,1,0); HC stays (0,2,1) with `!important`). No theme sets `outline` on links or chips; the `:focus-visible` code-ref rules (1368-1387) are untouched. Update the comment at 1321-1328 (css.md rule).

**Tests.**

- Update `caret-link.test.ts` and `caret-link-decorate.test.ts` to `classList.contains(CARET_INSIDE_CLASS)`. Update `wiki-chip-focus.spec.ts:112-123,211` to `el.classList.contains('vmde-caret-inside')`, keeping its `outlineStyle === 'solid'` paint check.
- New unit in `source-block-index.test.ts` (existing `setup()` with its `a[href]`): `read()`, `applyCaretInside(root, a)`, `applyCaretInside(root, null)`, `read()`; expect `snapshotPair` called once and no `dom` event.
- New unit in `webview-context.test.ts`: toggling the class on a chip and on `a > img` produces no `data-vscode-context` mutation records.
- New real-Lute unit: IR and WYSIWYG serializer parity with the class on each `LINK_LIKE_SELECTOR` shape, plus `rewriteWikiChipsToSource` with a classed chip.
- E2E: Chromium lacks the caret-link wiring, so run `ir-click-index.spec.ts` in real VS Code. Checkpoint 1 measured `wysiwyg/link/1` and `wysiwyg/post-link-plain/1` at 1 build / 1 `getValue` / 2 root / 122 fragment with 1 admitted record each; the prediction is 0/0/0 with 0 admitted (not measured). Extend the red assertion from `mode === 'ir'` to every warm phase in both modes (all other WYSIWYG rows already read 0/0/0).

**Edge cases Astra must check.**

- IR keyboard/arrow entry into `.vditor-ir__link`, a wiki chip or a code ref: the class paints and the index stays warm. The fixture has none of these; add them in a unit/Chromium check or record them as unmeasured.
- After Part B (L2), an IR link click that leaves the caret in the link must be neutral; Part C guarantees it.
- Theme switch or `setValue`/mode round-trip: the class is lost with the DOM and restored on the next `selectionchange`, as today.
- Undo/redo: a class toggle records no history. Snapshots can carry a stale class, as they carry the attribute today; `applyCaretInside` clears it on the restore's `selectionchange`. Verify no dirty or history change from clicks.
- `Ctrl/Cmd+Enter` activation (`link-click-fix.ts`) uses `linkLikeAt`, not the decoration. Re-run `wiki-chip-focus.spec.ts` in full.

Routing note: written by `claude-opus-5-5` in a general-purpose subagent at the session effort (`medium`), not `max`.

### Checkpoint 2, part A — implementation relay progress (2026-09-27)

Scope is writers 1–2 only. The Part 1 design above is preserved. Link-popover
and caret-link implementation remains deferred to later parts; the Checkpoint 1
assertion will remain unchanged even if only the plain/table rows reach 0/0/0.
The Project Owner approved Q1's L2 design (shared-index reads at click time,
marker cross-check retained for Edit/Unlink) and Q2's CSS-class replacement
with the index filter unchanged on 2026-09-27. Neither is started in part A.

- Prepared `media-src/e2e/table-panel-scroll.spec.ts` to measure the existing
  panel/cell offset before and after a 200 px IR-root scroll at 1100 px and
  520 px viewport widths. It records geometry JSON and before/after screenshots
  and asserts scroll-follow and source identity. Runtime results are pending.
- Product code is unchanged until the design's required baseline measurement
  returns through the sandbox relay. The existing `media/dist/main.js` SHA-256
  matches Checkpoint 1 (`c1fb62d1c39c3357acf2c22f41765cdd036f09be7b33264643d272318bbea61c`);
  baseline assets are present. No build has been rerun for this test-only edit.
- `npx biome check media-src/e2e/table-panel-scroll.spec.ts`: exit 0.
- `npm --prefix media-src run test:e2e -- table-panel-scroll.spec.ts --list --workers=1 --retries=0`:
  exit 0, two Chromium tests discovered.
- `git diff --check`: exit 0 before this progress entry. No git mutations.
- Jev tools are exposed and its skill is loaded. Caveman Mode and the optional
  Superpowers skills are not available in the exposed tools or skill locations.
  A preliminary `jev_gate` call with the current diff and actual static-check
  output returned `MCP tool call requires approval, but approval policy is never`.
  No verdict exists; the final implementation gate is still pending.

**Baseline relay 1 (exit 1, two failed tests).** Neither width scrolled the root:
`scrollTop` stayed 0, root height was 1887 px, and panel/cell offset stayed
`left=0, top=-29` px. Source identity was true at both widths. This is an invalid
scroll precondition, not a measurement of panel scroll-follow. The shared table
harness omits `height`, so Vditor defaults to `"auto"`; `initUI.ts` writes that
value into the mount's inline height, overriding `main.css`. Production
`boot/vditor-init.ts` sets `height` and `minHeight` to `"100%"`.

The spec now applies those production height options and mount styles to its
own test instance before loading the fixture. It leaves shared harness and
product code unchanged, records root client/scroll heights and overflow, and
requires a bounded root with more than 200 px of scroll range before measuring.
It also checks that the document and root viewport origin do not move during
the root scroll. Corrected runtime results are pending relay 2.

Relay-1 full log: `/tmp/claude-1000/-home-user-Projects-vmde/ad8ae665-0ee1-4231-b125-ffd821f1c04b/scratchpad/578-cp2a-relay1.log`.
Screenshots and failure artifacts: the sibling `578-cp2a-relay1-results/` directory.

Corrected-spec static checks: targeted Biome initially exited 1 for one line's
formatting, then exited 0 after formatting that line. `git diff --check` exited 0;
the product-source and task-index diff is empty. No build was needed for this
test-only correction, and no runtime command has been rerun in the sandbox.

**Baseline relay 2 (exit 0, two passed tests).** The corrected root is bounded
and scrolls internally. At 1100 px width, its client height was 862 px and
`scrollTop` moved 110 → 310; at 520 px width, client height was 792 px and
`scrollTop` moved 159 → 359. In both cases the cell and panel moved exactly
−200 px, panel/cell offset stayed `left=0, top=-29` px, document scroll stayed
0, and source identity was true. Full evidence is in sibling files/directories
`578-cp2a-relay2.log` and `578-cp2a-relay2-results/` under the relay-1 scratchpad.

**Candidate implementation, awaiting geometry validation.**
- `fix-table-ir.ts` retains lazy creation and stores a closure reference to the
  wrapper. A non-id absolute clip box (`inset:0`, `overflow:hidden`,
  `pointer-events:none`) is appended to the IR root's parent. The existing 0×0
  id'd wrapper remains non-editable and unselectable, with `pointer-events:auto`.
- One passive root scroll listener translates the wrapper by negative horizontal
  and vertical scroll offsets; its initial call covers creation in a scrolled
  root. Existing viewport-delta positioning and action routing are unchanged.
  Button `disabled` writes now occur outside the editable subtree. No source-index
  filter, EditSync, link-popover, rewrap, caret-link, CSS, or vendor source changed.
- New real-Lute/jsdom tests cover zero root records during creation, disabled and
  alignment updates, scroll transforms, old-wrapper serialization parity, panel
  identity and handler retention after root HTML replacement, every button route,
  selection retention, range actions, and hotkey suppression.
- The Chromium scroll spec now fixes the measured baseline offset at `0/-29`,
  verifies the sibling clip's bounds and pointer hit-testing, and scrolls the
  panel above the pane to verify clipping. These new runtime assertions have
  not run. If table geometry fails, stop and return its evidence to Part 1;
  do not change the chosen design.

| Candidate command/check | Exit / result |
| --- | --- |
| `npx biome check --write media-src/src/editing/fix-table-ir.ts media-src/src/editing/fix-table-ir.test.ts` | 0; formatted test |
| `npx biome check --write media-src/src/editing/fix-table-ir.test.ts media-src/e2e/table-panel-scroll.spec.ts` | 0; formatted spec |
| focused Vitest with changed-file coverage, initial run | 1; 73 passed, one assertion expected CSS `inset` as `0` rather than normalized `0px`; corrected |
| `COLUMNS=2000 npx vitest run --config test/vitest.config.mts --coverage --coverage.include=media-src/src/editing/fix-table-ir.ts --coverage.reporter=text --coverage.reporter=json media-src/src/editing/fix-table-ir.test.ts media-src/src/nav/source-block-index.test.ts media-src/src/nav/block-handle.test.ts media-src/src/editing/details-toggle-controls.test.ts` | 0; 74 tests in 4 files, including 18 new tests; three existing test files unchanged |
| changed-file coverage | Statements 90.57%, branches 77.23%, functions 86.66%, lines 92.96%; JSON confirms every added relocation statement executed, including initial and subsequent scroll transform |
| `npm run lint:ci` | 0; 1071 files |
| `npm run typecheck` | 0 |
| `npm run typecheck:strict` | 1; 13 diagnostics on unchanged code, including the pre-existing `event.preventDefault()` in `fix-table-ir.ts` (confirmed in HEAD); no new relocation diagnostic |
| `npm run typecheck:vscode-e2e` | 1; only the known `preview-task-checkbox.spec.ts:122` TS2339 |
| `node build.mjs` | 0; one candidate build after stable source inputs, to be reused |
| `npm run check:bundle-size` | 1, reporting-only; main.js 898,555 B, +364 B from Task 196/Checkpoint 1 |
| `npm run check:startup-cost` | 1, reporting-only; 346 eager modules, unchanged from Checkpoint 1 |
| `git diff --check` | 0 before this evidence entry |

Local logs are `/tmp/task578-cp2a-{unit,unit-final,typecheck,strict,lint,vscode-types,build,bundle,startup}.log`.
Candidate `media/dist/main.js` SHA-256:
`76dce529dd1bbf3fbafc8f4005777aa96820fc944730032c6570b79371589d9c`.
The implementation is not ready to commit: candidate Chromium geometry and
focused regressions, a focused real-VS-Code spec with XTEST keyboard steps,
and Checkpoint 1 per-target counts remain pending. No checkpoints are newly
marked complete. Dependency/vendor audits, aggregate quality and broad suites
are omitted under the focused-testing override; Checkpoint 3 retains its gates.

**Candidate relay 3 (exit 1: 37 passed, one range-action failure).** Both new
scroll/clip tests and all existing table geometry tests passed. At both widths,
the 200 px root scroll preserved the baseline `0/-29` px panel/cell offset,
source was unchanged, clip bounds matched the root exactly (`clipError=0`),
the visible panel received pointer hits, and the panel scrolled above the pane
did not receive pointer hits. The narrow clipped-panel screenshot was inspected.
The geometry stop condition did not fire; the chosen clip-box design is retained.

The sole failure was `table-hotkey.spec.ts:212`, "range panel insertion adds the
selected column span in one transaction": expected 4 columns, received 3.
`table-cell-selection.ts::onDocumentPointerDown` treated the relocated IR panel
as an outside click and cleared the two-cell rectangle before the button click.
It already exempted the sibling WYSIWYG panel but depended on root containment
for IR. The fix adds an IR-panel exemption scoped to the controller root's own
`.vditor-ir` parent; other outside clicks and another pane's panel still clear.
This supporting listener change is required to preserve the table-panel range
actions in the approved relocation design. No link/caret/index-filter work was added.

An added unit regression first failed with `dimensions() === null` immediately
after the sibling panel's pointerdown (exit 1, one failed/seven skipped), then
passed after the listener correction. The earlier panel test mocked the range
action and therefore could not catch document-level dismissal; this new test
uses the real selection controller.

| Correction check | Exit / result |
| --- | --- |
| `npx vitest run --config test/vitest.config.mts media-src/src/editing/table-cell-selection.test.ts -t 'retains the rectangle on its sibling IR panel'` before the fix | 1, deterministic red reproduction |
| `npx biome check media-src/src/editing/table-cell-selection.ts media-src/src/editing/table-cell-selection.test.ts` | 0 |
| `COLUMNS=2000 npx vitest run --config test/vitest.config.mts --coverage --coverage.include=media-src/src/editing/fix-table-ir.ts --coverage.include=media-src/src/editing/table-cell-selection.ts --coverage.reporter=text --coverage.reporter=json media-src/src/editing/fix-table-ir.test.ts media-src/src/editing/table-cell-selection.test.ts media-src/src/nav/source-block-index.test.ts media-src/src/nav/block-handle.test.ts media-src/src/editing/details-toggle-controls.test.ts` | 0; 82 tests in 5 files |
| changed-line coverage | New panel ownership check and early return executed; both owning-panel retention and foreign-panel dismissal covered. Whole-file lines: fix-table-ir 92.96%, table-cell-selection 80.09% |
| `npm run typecheck` | 0 |
| `node build.mjs` | 0; rebuilt because the selection-controller source changed, to be reused |
| `git diff --check` | 0 before this evidence entry |

Logs: `/tmp/task578-cp2a-range-{red,unit,types,build}.log`.
Current main.js: 898,667 B (+476 B from Task 196/Checkpoint 1), SHA-256
`a772c5ca03f44ce66ed8c3ab8cf0f50d70833db9a5f7bdce1e222de88d617a94`.
Relay-3 log/artifacts are the sibling `578-cp2a-relay3.log` and
`578-cp2a-relay3-results/` under the same scratchpad. Browser coverage is at
`578-cp2a-relay3-results/media-src/coverage/e2e/index.html`; that pre-correction
run measured fix-table-ir line coverage 87.96%, statement coverage 90.91%,
function coverage 100%. Correction runtime validation and the remaining focused
Chromium/real-VS-Code acceptance are still pending. No commit is requested yet.

**Candidate relay 4 (exit 0: 97 passed in 1.9 min).** All seven focused Chromium
specs passed, including the corrected range-panel insertion, table geometry,
mouse selection, webview behaviors, block handles and Details. Both widths again
preserved the `0/-29` px offset, exact 200 px scroll-follow, zero clip-bound error,
correct visible/clipped hit-testing and unchanged serialized source. No passing
Chromium command is to be rerun on this unchanged product tree.

Full log/artifacts: sibling `578-cp2a-relay4.log` and `578-cp2a-relay4-results/`
under the same scratchpad. Browser coverage lives in
`578-cp2a-relay4-results/media-src/coverage/e2e/index.html`:
fix-table-ir statements 91.61%, lines 88.27%, functions 100%; table-cell-selection
statements 74.35%, lines 67.52%. Unit changed-line coverage remains as recorded above.

**Prepared real-VS-Code validation (not yet run).**
- Added `test/vscode-e2e/table-panel.spec.ts`, gated by `VMDE_XTEST=1`. It checks
  sibling ownership, scroll geometry, non-cell hiding, mode round-trip identity,
  clean unchanged host/disk before edits, two-column range insertion, one-step
  XTEST Undo/Redo, working panel buttons after history replacement, and final
  source/disk restoration.
- Updated keyboard steps in the four requested existing regression specs
  (`table-operations`, `contextual-panel-clearance`, `gap-cursor`, `hr-edit`) to
  use `helpers/spec-keyboard.ts`. With `VMDE_XTEST=1`, this adapter calls
  `createXtestInput`, verifies/focuses the mapped X11 client and never falls back.
  Existing ordinary-suite runs retain a clearly labelled browser-input diagnostic
  path; they do not count as OS acceptance. Assertions remain intact. Synthetic
  clipboard/composition events in the existing table spec are not OS clipboard/IME
  evidence; its keyboard steps now use the selected input route.
- `ir-click-index.spec.ts` is unchanged. Its all-IR red assertion is expected to
  remain red for deferred link rows; plain/table rows must independently reach
  0 builds / 0 full getValue / 0 root Lute. Per-target artifacts will be reported.
- Static checks: targeted Biome formatting exited 0 (one unused callback-parameter
  warning in the new spec was corrected); `npm run lint:ci` exited 0, 1073 files.
  `npm run typecheck:vscode-e2e` exited 1 only for the known checkbox-spec TS2339.
  `npm run typecheck:strict` exited 1 with the same 13 existing diagnostics.
  Focused `VMDE_XTEST=1 ... --list --workers=1 --retries=0` exited 0, discovering
  ten tests across the six specs. `git diff --check` exited 0.
- Static logs: `/tmp/task578-cp2a-real-{types,lint,strict,list}.log`. All edits
  since relay 4 are test/record-only: the current build hash remains
  `a772c5ca03f44ce66ed8c3ab8cf0f50d70833db9a5f7bdce1e222de88d617a94` and was not rebuilt.

**XTEST relay preflight.** The first attempts at relays 5/6 exited 1 before any
test because `rg` was absent from the relay host's PATH. Commands were resent
with `grep -q XTEST`; this runner difference was not counted as a test failure.
The subsequent completed runs reused those relay log names.

**Real-VS-Code relay 5 (exit 1, only deferred IR links red).** All 42 phases
completed, six optional absences, zero unavailable targets. Every phase had
`warmVerified=true` and `sourceUnchanged=true`. The unchanged committed assertion
failed only on `ir/link/1–2`; no assertion was weakened.

| Target | Before build/get/root | Part A build/get/root | Part A fragments | Longest task ms | Admitted records |
| --- | --- | --- | --- | --- | --- |
| ir/plain/1 | 1/1/2 | 0/0/0 | 0 | 0 | 0 |
| ir/table/1 | 1/1/2 | 0/0/0 | 0 | 0 | 0 |
| ir/table/2 | 1/1/2 | 0/0/0 | 0 | 0 | 0 |
| ir/link/1 (deferred) | 1/5/8 | 1/5/8 | 244 | 1033 | 4 |
| ir/link/2 (deferred) | 1/5/8 | 1/5/8 | 244 | 1032 | 4 |

All other measured IR rows were 0/0/0 with zero long tasks. WYSIWYG link/1 and
post-link-plain/1 remained 1/1/2 (678/616 ms longest tasks), consistent with the
deferred caret-link work. Writers 1–2 are confirmed removed from the admitted
root mutations. Host/disk equality passed; both UTF-8 byte lengths are 174,527,
SHA-256 `a4a39d6f6c605eb82b0e03a236f67388bceeae9a85450b0d4285053b28299f65`.
Host `dirty=false`, version 1. No fixture text was printed during analysis.

Evidence: sibling `578-cp2a-relay5.log` and
`578-cp2a-relay5-results/test/vscode-e2e/test-results/ir-click-index-Task-578-wa-fdb35-and-serialize-nothing-in-IR/ir-click-index-evidence.json`
under the same scratchpad. No repeat of this completed measurement is planned
on the unchanged product tree. Three matched runs remain Checkpoint 3's work.

**Real-VS-Code relay 6 (exit 1: six passed, three failed).** Contextual-panel
clearance (including narrow table geometry), gap cursor, two HR cases, exact
noncanonical IR move/Undo/Redo/save/reopen, and WYSIWYG range insertion/Undo/IME
retirement passed with the XTEST input route. Failures:
- HR ArrowDown/Up: `electronApplication.browserWindow: Resulting promise was
  garbage collected` inside `createSpecKeyboard`, before opening the fixture.
  This is a window-mapping setup failure; comparison is pending, with no product
  attribution or test-assertion change.
- Table rectangle copy: expected WYSIWYG Markdown cells with two spaces, received
  single spaces. All earlier selection, source identity and TSV checks passed.
  Comparison against pre-change product with the same XTEST tests is pending.
- New table-panel lifecycle: sibling/clip checks, mode identity, clean source,
  range insertion, its first Undo/Redo, and a working move button after history
  passed. The final second consecutive Undo did not restore SOURCE. Geometry
  measured panel/cell offset `0/-33` px before/after exactly 200 px scroll,
  `clipError=0`, root top fixed at 71 px. The failure is in later history behavior,
  not geometry. A temporary history fingerprint/stack-count probe was added to
  this spec with every assertion unchanged; remove it before any commit request.

**Comparison preparation.** A read-only `git archive 83fbfd3e` was extracted to
`/tmp/task578-cp2a-baseline-_8zwsmy8`, without changing repository git state.
Only the current XTEST-adapted HR/table-operations specs and keyboard adapter
were copied into this scratch tree. Initially symlinking Vditor let its build
patches resolve VMDE imports back into the working tree; that candidate baseline
was rejected before testing. Materializing the baseline's Vditor package fixed
the resolution, and a rebuild (changed dependency layout) exited 0. Its bundle
now exactly matches Checkpoint 1: 898,191 B, 346 modules, SHA-256
`c1fb62d1c39c3357acf2c22f41765cdd036f09be7b33264643d272318bbea61c`, zero foreign product
inputs in the build manifest. Both relevant product files match commit 83fbfd3e.
No installed dependencies or candidate build artifacts were modified by this setup.

Local diagnostic preparation: targeted Biome exited 0; VS Code typecheck exited
1 only for the same known checkbox-spec error; focused discovery found the one
candidate history test and two baseline comparison tests. Build logs are
`/tmp/task578-cp2a-baseline-build{,-final}.log`; typecheck log is
`/tmp/task578-cp2a-diagnostic-types.log`. The temp-directory tool launches emitted
`Failed to create stream fd: Operation not permitted` warnings, but builds
completed with exit 0 and the final artifact identity was verified. Baseline
comparison and candidate history diagnostics require the next serial relays.

**Baseline relay 7 (exit 1: one passed, one failed).** Verified the full log:
HR ArrowDown/Up passed on 83fbfd3e with the same XTEST-adapted test. The table-copy
test failed identically on baseline and candidate: two expected spaces per
WYSIWYG cell versus one actual space. This establishes the mismatch also exists
on the pre-change product under this input journey; it is not attributed to the
panel relocation. The original byte assertion is retained. Baseline log:
the sibling `578-cp2a-relay7.log` under the same scratchpad; artifacts remain in
`/tmp/task578-cp2a-baseline-_8zwsmy8/test/vscode-e2e/test-results`.

**Candidate history relay 8 (exit 1).** The same final Undo assertion failed.
Geometry again passed (`0/-33` px offset retained through 200 px scroll).
The temporary probe used webview `console.log`, but this spec did not forward
webview console events to the runner; the returned log therefore contains no
probe data. No native history diagnosis is claimed from that run. The probe now
stores bounded fingerprints/stack summaries in the test page and the spec reads
them in `finally`, prints them from the runner and attaches
`table-history-probe.json` even when its assertion fails. It also records whether
the rendered Markdown changed during each history call, without printing text.
All acceptance assertions remain unchanged. Remove this probe before commit.

The HR spec now creates its XTEST route after `open()` has reached its rendered
fixture readiness, instead of requesting `electronApp.browserWindow(workbox)`
before the open. This addresses the earlier window-mapping setup race; it does
not change any navigation assertion or add retries. Candidate verification is
pending; the baseline pass does not itself prove the changed candidate run.
Only the failed HR ArrowDown/Up case and the history diagnostic are requested
next. Passing cases, Chromium and click-count measurements are not repeated.
Targeted Biome exited 0; no product input changed and the candidate build is reused.

**Candidate relay 9 (exit 1: HR passed, panel history failed).** HR ArrowDown/Up
now passed on the candidate with XTEST mapping performed after fixture readiness.
The new history probe returned eight complete records in the runner log. The
attachment was not present in the copied artifacts, so those records were
parsed from the full log into `/tmp/task578-cp2a-history-relay9.json`.

The final Undo was delivered and executed: it popped undo depth 5 → 4 and pushed
redo depth 1 → 2. The exact rendered Markdown remained unchanged
(`sourceUnchanged=true`, length 944, fingerprint `c95a4c48` before/after). It
consumed the same native patch fingerprint that the pre-move checkpoint added
at record 5 (undo depth 4 → 5). That checkpoint changed native HTML length
2188 → 2347 and caret-marker position 0 → 1102 before the move transaction.
The preceding Undo at record 7 had correctly reverted the move. Thus the failing
last assertion is explained by a source-neutral pre-move DOM/caret history entry,
not a missed OS key or a transition lock. The initial insertion Undo/Redo also
changed source correctly (records 3/4).

The checkpoint writer is unchanged `table-actions.ts::commitTableTransform` →
`checkpointEditorUndo` → native `addToUndoStack`, which diffs HTML including the
caret marker. Whether the original product exhibits the same sequence remains
to be measured; unchanged writer code alone is not treated as proof of that.
No history implementation or acceptance assertion was changed.

Prepared identical temporary `table-history-comparison.tmp.spec.ts` files in the
candidate and the existing 83fbfd3e baseline. They retain the mode round-trip,
range insertion, Undo/Redo, later cell click, panel move, and two Undo operations;
they omit only the relocation-specific geometry/identity checks so the original
in-root design can reach the history comparison. The move uses the same panel
button in both products, without a keyboard fallback if the baseline panel fails.
Both files write `table-history-probe.json` explicitly before attaching it, so
artifact preservation no longer depends on the reporter's inline attachment
handling. They are diagnostics, not substitutes for the unchanged acceptance spec.
Remove the comparison spec and probe before any commit request.

Preparation checks: targeted Biome exit 0; VS Code typecheck exit 1 only for the
known checkbox-spec TS2339; focused discovery exit 0 (one comparison test).
Logs: `/tmp/task578-cp2a-history-comparison-{types,list}.log`. Candidate and baseline
product/build inputs remain unchanged and both builds are reused. Passing HR,
Chromium, and click-count checks are not repeated.

### Checkpoint 2, part A — pre-review handoff (superseded below, 2026-09-27)

**History attribution completed, without a history fix.** Relays 10 (83fbfd3e)
and 11 (candidate) both exited 1 at the same final SOURCE-restoration assertion
in the identical temporary panel-action journey. Both probes recorded eight
calls, and their normalized sequences match: call kind, rendered Markdown
fingerprints/lengths, exact within-call source-equality booleans, caret-marker
positions, and undo/redo stack deltas. The candidate began with one fewer native
history entry; absolute depths therefore differ, but the relevant suffix is
the same. In both products, the final Undo consumes the pre-move DOM/caret entry
without changing rendered Markdown. This is a reproduced baseline behavior,
not a relocation regression. The preceding move Undo and insertion Undo/Redo
work in both products. The preserved acceptance spec's final save/restoration
steps remain unexecuted because its final Undo assertion stays red.

Evidence: sibling `578-cp2a-relay10.log`, `578-cp2a-relay11.log`, and each
`578-cp2a-relay{10,11}-results/test/vscode-e2e/test-results/table-history-comparison.t-efa18-rison-through-panel-actions/table-history-probe.json`
under the same scratchpad. A text-free normalized comparison is saved at
`/tmp/task578-cp2a-history-comparison-summary.json` (`match=true`).

**Final scope and measured acceptance.**
- [x] Lazy IR panel creation and all its button-attribute writes moved outside
  the editable root, retaining the specified clip box and two-axis scroll transform.
- [x] Rectangle selection survives a click on its own relocated panel; foreign
  panel and ordinary outside clicks still clear it.
- [x] Real-Lute parity, zero-root-record unit coverage and the existing index,
  block-handle and Details contracts pass: 82 focused unit tests.
- [x] Seven focused Chromium specs pass: 97 tests, including panel actions,
  range insertion, narrow geometry, 200 px scroll-follow and clipping.
- [x] One clean real-VS-Code click measurement proves ir/plain/1 and ir/table/1–2
  each 0 builds / 0 full getValue / 0 root Lute, zero admitted records and zero
  longest tasks, with exact host/disk bytes, clean state and unchanged version.
- [x] Real VS Code measured sibling/clip geometry, 200 px scroll-follow, non-cell
  hiding, mode round-trip identity, unchanged clean source before edits, range
  insertion, insertion Undo/Redo, and working panel actions after history.
  Contextual-panel geometry, gap, all three HR cases, the noncanonical IR move
  journey and WYSIWYG range/Undo/IME case pass across the focused serial runs.
- [ ] All focused real-VS-Code assertions green: WYSIWYG copy-spacing and the new
  panel spec's later two-action Undo-chain assertion remain red on both products
  under the same XTEST journeys. Assertions are retained; no test.fail annotation,
  expectation relaxation or additional skip masks them.
- [ ] Deferred link-popover L2 and caret-link class implementation (Q1/Q2 approved
  for later parts) and Checkpoint 3's broader/matched-run acceptance remain open.

**Cleanup and final static checks.** Removed `helpers/table-history.tmp.ts`,
`table-history-comparison.tmp.spec.ts`, their import/setup/finally wiring, and
the baseline copies. No temporary probe references remain. The retained
`table-panel.spec.ts` is byte-identical to its pre-probe version from relay 6;
its assertions remain unchanged. Runtime checks are not repeated solely for
probe removal: that clean spec was already run, and product inputs never changed
after the passing Chromium/click-count runs. Artifacts/logs are retained.

`npm run lint:ci` exited 0 on the cleaned candidate (1073 files);
`npm run typecheck:vscode-e2e` exited 1 only for the known
`preview-task-checkbox.spec.ts:122` TS2339. Logs:
`/tmp/task578-cp2a-final-{lint,vscode-types}.log`. The ordinary webview typecheck,
82 focused unit tests, changed-line coverage and build results above remain valid
for the unchanged product files. Strict typecheck retains the 13 recorded baseline
diagnostics. No aggregate-quality, audit, FAST or full-suite result is claimed.

`link-popover.ts`, `rewrap-command.ts`, caret-link files, tasks/README.md and
tracked generated outputs have no diff. LOCAL_AGENT_TASK files were not edited.
No stage/commit/stash/checkout/reset/push or other git-state mutation was performed.
The owner's original uncommitted Part 1 design section remains in this task record
and is included in the bounded commit request. Task 578 is not closed or moved.

**Part 1 follow-up:** the two reproduced baseline assertions need separate scope
decisions; this part does not change table/history/source formatting contracts.
The table-panel relocation itself has no unresolved geometry-design question.
Jev remains exposed but each attempted gate is denied by the session's approval
policy; no Jev verdict is claimed. Caveman Mode remains unavailable.

### Orchestrator review — completing Task 578 acceptance independently (2026-09-27)

The first commit request was not executed. The orchestrator accepted the panel
relocation, its sibling-panel pointerdown exception and the XTEST conversions
in HR, gap-cursor and contextual-panel-clearance, but required the new
`table-panel.spec.ts` to finish Task 578's own save/reopen journey independently
of the reproduced pre-existing extra-history-checkpoint defect.

**Finding 1, revised acceptance (runtime pending).** The new spec retains its
scroll-follow, sibling ownership, mode round-trip, exact source restoration by
one XTEST Undo, byte-identical Redo, and working panel action after history. It
now also checks actual pointer hit-testing while visible and after scrolling
above the clip edge. After the post-history move and its single Undo restore
the exact inserted state, the test saves that known state, checks UTF-8 disk
bytes, closes/reopens the document, checks exact host/disk bytes and clean state,
and uses the reopened panel. Completion evidence is written explicitly to
`table-panel-lifecycle.json` only after these assertions pass.

The additional cumulative Undo that consumes a source-neutral caret/DOM entry
is isolated as **recorded evidence of a pre-existing defect for the Project
Owner**, not as a Task 578 regression or a new committed red test. Relays 10/11
and their permanent artifacts above retain the failing observation, including
the native stack pop and unchanged Markdown. The review expressly authorized
restructuring this new checkpoint-only test; no assertion in a spec that existed
before Task 578 was relaxed. No history implementation was changed.

**Finding 2, explicit baseline and input provenance.**
`test/vscode-e2e/table-operations.spec.ts:48`, "cell rectangles are source-invisible
in IR and WYSIWYG", fails identically on the pre-change 83fbfd3e baseline in
relay 7 and on the candidate in relay 6: expected two spaces in each WYSIWYG
Markdown cell, received one. This checkpoint converted that spec's previously
DOM-dispatched keyboard steps to XTEST under `VMDE_XTEST=1`, as required by the
operator's OS-keyboard policy. The baseline comparison used those same converted
steps and unchanged byte assertions. This spacing assertion remains a pre-existing
residual under that input journey, with no expectation change in this checkpoint.

Only `table-panel.spec.ts` and this task record changed during the review response.
Product inputs and the accepted implementation remain unchanged; reuse the
existing `a772c5ca03f44ce66ed8c3ab8cf0f50d70833db9a5f7bdce1e222de88d617a94`
build. Do not repeat the passing unit, Chromium, HR or click-count commands.
A new commit request is withheld until the revised Task 578 lifecycle steps
have a green focused real-VS-Code result.

Review-response checks: `npx biome check --write test/vscode-e2e/table-panel.spec.ts`
exit 0; `npm run lint:ci` exit 0 (1073 files); focused XTEST `--list` exit 0
(one lifecycle test); `npm run typecheck:vscode-e2e` exit 1 only for the known
checkbox-spec TS2339; `git diff --check` exit 0 before this check entry.
Logs are `/tmp/task578-cp2a-review-{lint,types,list}.log`. No runtime pass is
claimed for the revised save/reopen or real-webview pointer-clipping assertions yet.

### Reviewed part A completion — relay 12 (2026-09-27)

The revised `table-panel.spec.ts` passed to completion with exit 0, one test,
13.1 s test time / 15.0 s total. Verified the full log and its explicit lifecycle
artifact. The isolated pre-existing extra-checkpoint observation no longer
masks Task 578's acceptance:

- [x] Root scroll 213 → 413 px moved both cell and panel exactly −200 px; the
  `0/-33` px panel/cell offset remained unchanged and `clipError=0`.
- [x] The sibling panel received pointer hits while visible and received none
  when scrolled above the pane while the test point remained inside the viewport.
- [x] Non-cell hiding, mode round-trip panel identity and clean unchanged source
  before edits passed.
- [x] XTEST range selection inserted two columns; a single Undo restored exact
  original source and Redo restored the exact inserted state. A panel move after
  history worked, and its single Undo restored that known inserted state.
- [x] Saving wrote the exact 922-byte UTF-8 inserted state. Closing/reopening
  preserved exact host and disk bytes and clean state. The reopened panel was
  unique, outside the root, correctly clipped/positioned and pointer-reachable.

Saved-byte SHA-256:
`29dbb5e02f6217262be8cc542022deb6e7597759f246f02040c3918df8764256`.
Artifact flags: `reopenedSourceExact=true`, `reopenedDiskExact=true`,
`reopenedDirty=false`. Full log: sibling `578-cp2a-relay12.log`; artifact:
`578-cp2a-relay12-results/test/vscode-e2e/test-results/table-panel-IR-sibling-tab-0d242-EST-history-save-and-reopen/table-panel-lifecycle.json`
under the same scratchpad.

The orchestrator review's lifecycle blocker is resolved by this green owned
journey. No assertion from a pre-existing spec was relaxed. The copy-spacing
assertion in `table-operations.spec.ts:48` remains explicitly red on both baseline
and candidate under the converted XTEST journey (relay 7 / relay 6); it is not
claimed green. The source-neutral pre-move Undo entry remains recorded from
relays 10/11 as a pre-existing residual for the Project Owner, not a Task 578
regression and not an additional committed red test.

All product files and all checks other than the reviewed new lifecycle test
remain unchanged. Reuse the recorded 82 unit passes, 97 Chromium passes,
plain/table 0/0/0 measurement, build, coverage and static-check results. Across
the focused real-VS-Code regression runs, eight of the nine cases now passed;
the ninth is the explicitly reproduced baseline copy-spacing assertion.
Deferred link rows keep the separate Checkpoint 1 all-IR assertion red, as
required for part A. No aggregate-green or whole-task closure is claimed.

The revised commit request includes the same 12 explicit source/test/record
paths, including the owner's original Part 1 design. Temporary probes remain
removed. No product rebuild, passing runtime rerun or git-state mutation was
performed during this final evidence update. The last review-response lint and
discovery checks exited 0; VS Code typecheck remains exit 1 for only the known
checkbox-spec TS2339. Q1/Q2 implementation and Checkpoint 3 remain open.

### Checkpoint 2, part B — baseline action-state measurement (2026-09-27)

Confirmed HEAD `5b51f154` and retained the owner's uncommitted caret-link addendum.
Q1 L2 is approved: the popover will reuse the existing index at click time and
retain the marker cross-check for Edit/Unlink. No new index/EditSync contract is
authorized. Part C is approved but remains serially deferred until part B has
its focused evidence and separate commit request.

Before changing product code, extended `ir-click-index.spec.ts` measurements
with `linkActions: { visible, editEnabled, unlinkEnabled }`. These are read-only
UI booleans captured after work counters stop; no URL, marker or fixture text is
recorded. Hidden panels report null action availability rather than claiming a
null source span. `show()` assigns both disabled states from `!record.sourceSpan`,
so the visible state provides the requested before/after binding evidence without
exposing a new product API. The committed count/source assertions are unchanged.

The existing part A build is reused (SHA-256
`a772c5ca03f44ce66ed8c3ab8cf0f50d70833db9a5f7bdce1e222de88d617a94`); no product input
has changed and no rebuild was run. Targeted Biome exited 0; focused XTEST test
discovery exited 0 (one test); VS Code test typecheck exited 1 only for the known
`preview-task-checkbox.spec.ts:122` TS2339. Logs:
`/tmp/task578-cp2b-baseline-{types,list}.log`. Baseline runtime action availability
is pending; the IR link rows are expected to retain their pre-L2 red counts.

The required repository and Jev skills are loaded. Jev tools are exposed;
Caveman Mode is unavailable. The session's previously observed Jev approval
restriction will be reported if it still blocks the final gate. No part B or C
implementation or runtime acceptance is claimed yet.

### Checkpoint 2, part B — L2 candidate and local validation (2026-09-27)

**Baseline relay 1 (exit 1, expected link counts).** Read the complete text-free
artifact: 42 phases, six optional absences, zero unavailable targets; source and
host/disk identity passed, document clean at version 1. Both ir/link offsets were
warm and showed the popover with **Edit disabled and Unlink disabled**. Each
performed 1 index build / 5 full getValue / 8 root Lute / 244 fragments; longest
tasks were 1113 and 993 ms. This records the previously unknown action state;
the counts alone do not establish which binding guard rejected the target.
Log/artifacts are `578-cp2b-relay1.log` and `578-cp2b-relay1-results/` under the
same orchestrator scratchpad as part A; the latter contains the full
`ir-click-index-evidence.json` with `linkActions` fields.

**Implementation.** `finish-init.ts` passes the existing `sourceIndex` into the
popover. Click-time ownership reads that entry, checks root/mode/renderer owner,
uses its exact/rendered strings and proven units, and binds by the live target's
ordinal. Rendered block scans and exact/rendered candidate scans use per-entry
memo slots. Candidate counts, group kinds, ordered source/projected/live identity
and the valid Unlink plan remain required. `sourceSpanFor` remains the marker
cross-check at Edit/Unlink action time; a mismatch prevents a write.

Null units disable source actions. An uncacheable/null-key surface obtains only
the existing owner snapshots needed for Open/Copy and keeps source actions
disabled; warm IR entries never take that direct snapshot fallback. The index
and EditSync contracts/filter are unchanged. The link harness now creates an
index with matching projection/units and source revision handling. No part C
code, CSS, vendored file or generated output was hand-edited.

**Unit evidence.** New real-Lute/jsdom tests compare ordinal source spans with
marker offsets for duplicate links, images, table cells and noncanonical
CRLF/table source. They assert zero warm-click getValue/serialize calls and root
mutation records, cached scans, one cold build, source-revision refresh, null
units/key behavior, wrong owner/root/mode and group guards, reordered/missing/
extra nodes, selected-owner keyboard entry, composition hiding, SV exclusion,
and action-time marker mismatches failing closed. Linked images retain the
existing lexical-candidate/live-node count rejection; their marker offsets are
measured separately rather than claiming editable support the old gates rejected.

The initial unit run was 17 passed / 1 failed: jsdom's `contentEditable` property
assignment did not change the attribute inspected by the index. Setting the
test fixture's real `contenteditable="false"` attribute fixed that setup. The
initial Biome run also exposed makeOwner complexity (18/15); moving source
binding into a private helper resolved it without a contract change.

**Real-VS-Code input preparation.** Existing link-popover specs keep their source,
caret/reflow, copy, Open, Edit/Unlink and history assertions, and now route URL
typing and Undo/Redo through XTEST when `VMDE_XTEST=1`. Modifier-click also uses
XTEST: the existing helper verifies the focused client, translates a page point
using Electron content bounds at DPR 1, and releases the held modifier in
`finally`. Unit tests cover coordinate bounds, focus routing and release on
failure. The ordinary non-XTEST adapter remains explicitly diagnostic. Actual
OS modifier-click and the edited link actions still require relay validation.

| Check | Exit / result |
| --- | --- |
| targeted Biome on final changed TS | 0 |
| focused Vitest with link-popover coverage | 0; 106 tests in 7 files: link-popover, link-popover-plan, source-block-index, block-handle, details-toggle-controls, finish-init, xtest-input |
| changed-line coverage | Every added link-popover executable statement covered; module lines 71.35%, statements 69.17%, branches 57.62%, functions 83.01% |
| `npm run typecheck` | 0 |
| `npm run lint:ci` | 0; 1074 files |
| `npm run typecheck:strict` | 1; same 13 existing diagnostics, with link-popover action-path locations shifted by the added code |
| `npm run typecheck:vscode-e2e` | 1; only the known checkbox-spec TS2339 |
| `node build.mjs` | 0; one candidate build after stable product inputs, to be reused |
| focused XTEST `--list --workers=1 --retries=0` | 0; three tests in ir-click-index and link-popover |
| `npm run check:bundle-size` | 1, reporting-only; main.js 899,647 B (+980 from part A; +1,456 from Task 196) |
| `npm run check:startup-cost` | 1, reporting-only; 346 eager modules, unchanged |
| `git diff --check` | 0 before this progress entry |

Full unit command:
`COLUMNS=2000 npx vitest run --config test/vitest.config.mts --coverage --coverage.include=media-src/src/editing/link-popover.ts --coverage.reporter=text --coverage.reporter=json media-src/src/editing/link-popover.test.ts media-src/src/editing/link-popover-plan.test.ts media-src/src/nav/source-block-index.test.ts media-src/src/nav/block-handle.test.ts media-src/src/editing/details-toggle-controls.test.ts media-src/src/boot/finish-init.test.ts test/backend/xtest-input.test.ts`.
Logs: `/tmp/task578-cp2b-{unit-initial,unit,unit-final,typecheck,lint,strict,vscode-types-final,build,bundle,startup,vscode-list}.log`.
Candidate main.js SHA-256:
`2705c9fba7c7683bc85b64c38519393fb666e00f88127751bca4ac1430b26c6e`.

The next relay covers the three Chromium specs consuming the changed link
harness. Real-VS-Code action fidelity and post-L2 ir/link 0/0/0 plus enabled-state
comparison remain pending. No design-invalidating runtime evidence has yet been
produced, no assertion was weakened, and no part B commit is requested yet.

### Part B resume — Chromium green, real-VS-Code relay pending (2026-09-27)

Read the complete dispatch brief at
`/home/user/.local/state/codex-visible/runs/20260927-180851-578-cp2b-resume/brief.md`.
The working-tree candidate is intact, HEAD remains `5b51f154`, and main.js still
has SHA-256 `2705c9fba7c7683bc85b64c38519393fb666e00f88127751bca4ac1430b26c6e`.
No source/build input changed, so no rebuild is required.

The original Chromium relay-2 result was 25 passes with exit 0. The dispatch
reports that its old scratchpad was cleared, so the orchestrator performed a
fresh verbatim rerun to recover evidence. Verified the replacement full log:
**exit 0, 25 passed in 37.8 s, no retries**. It covers noncanonical CRLF/table
source, duplicate-link identity, image Edit/Unlink, Open/Copy, stale-source and
composition rejection, rollback, changed-selection cancellation, narrow-pane
geometry and the IR/WYSIWYG/SV link policies. Link-popover browser coverage:
lines 89.18%, statements 85.78%, branches 80.49%, functions 98.11%.

Current retained log:
`/tmp/claude-1000/-home-user-Projects-vmde/a7361092-51f9-4a87-a5a3-14560d1c12f3/scratchpad/578-cp2b-relay2-rerun.log`.
Coverage: `media-src/coverage/e2e/index.html`. The old scratchpad paths above
are historical provenance, not assurances that those raw files still exist.
At least `/tmp/task578-cp2b-vscode-list.log` is also absent after the session
restart; the earlier inspected check outputs and baseline action-state values
remain recorded in this file and thread. Do not rerun a passing command merely
to recreate its log on the unchanged tree.

Next: serial XTEST real-VS-Code invocations for the unchanged IR work-count gate
with action availability, then the link-popover action/history/fidelity specs.
Post-change ir/link 0/0/0 and Edit/Unlink state remain unmeasured. No part B commit
request or part C implementation is made until the required part B evidence is
green. Network-free quality stages remain due once on the final Checkpoint
candidate under the dispatch policy; no aggregate quality result is claimed.

### Part B real-VS-Code results and URL-input setup correction (2026-09-27)

Read the complete relay dispatch
`/home/user/.local/state/codex-visible/runs/20260927-181850-578-cp2b-relay3/brief.md`
and both retained full logs.

**Counts relay A: exit 0, one passed (2.2 min).** All 42 measured phases were
warm and source-identical, with six optional absences and zero unavailable
targets. Every measured IR row reached 0 builds / 0 full getValue / 0 root Lute;
the three red-count arrays were empty. Host/disk bytes and SHA-256 stayed
unchanged, and the host remained clean at version 1.

Crucially, the actual `ir/link/1` and `ir/link/2` click-phase objects both have
`linkActions={visible:true, editEnabled:false, unlinkEnabled:false}`. The
hidden/null states also occur inside nested `warmChecks`; those do not describe
the actual click-phase objects and do not establish that the clicked popover was absent.
The before/after comparison is therefore measured: **both source actions remain
disabled on the large fixture targets, while work drops from 1/5/8 to 0/0/0**.
Fragments and longest tasks also dropped from 244 and 1113/993 ms to zero.
Both click phases contain zero mutation records, not merely zero admitted ones.

The subsequent spec run overwrote the default test-results copy of the evidence
JSON. Recovered the full phase/absence/unavailable/identity/red-count objects
from their complete JSON log lines into `tmp/task578-cp2b-counts-recovered.json`,
explicitly marked `recoveredFromLog` with its source path. This preserves
text-free evidence without rerunning the passing measurement. Retained log:
`/tmp/claude-1000/-home-user-Projects-vmde/a7361092-51f9-4a87-a5a3-14560d1c12f3/scratchpad/578-cp2b-counts.log`.

**Actions relay B: exit 1, two failed.** Both tests reached the enabled Edit URL
action but then lost the input during `replaceUrl`, before the changed URL
value assertion. Diagnosis: the new XTEST adapter journey called `.click()` on
the input, although `showEdit` had already focused/selected it. The existing
popover `onClick` handler hides on a non-button click (`!action`), so that extra
setup click synchronously dismissed the form. Both this click handler and
`showEdit` compare byte-identically with their versions in `5b51f154`; neither
was changed by L2. This failure does not establish an L2 source-binding defect.

Corrected only the test setup: `replaceUrl` now asserts the input is visible
and focused by Edit URL, then sends Ctrl+A and URL text through the same XTEST
route. The expected URL, source, history, geometry and Open/Copy assertions are
unchanged. No product behavior or design was altered. The corrected action run
is pending. Full failed log: sibling `578-cp2b-actions.log` at the path above.

Targeted Biome exit 0; VS Code test typecheck exit 1 only for the known checkbox
TS2339 (`/tmp/task578-cp2b-input-types.log`); diff check exit 0. Product inputs and
the candidate build are unchanged. Rerun only `link-popover.spec.ts`, not the
passing click-count/Chromium/unit commands. Part C remains deferred.

### Part B action rerun — link green, image reopen setup (2026-09-27)

Read the full dispatch
`/home/user/.local/state/codex-visible/runs/20260927-182810-578-cp2b-relay4/brief.md`
and `578-cp2b-actions-focused.log` in the retained `a7361092-.../scratchpad`.
Exit 1: **one passed, one failed (20.3 s), no retries**.

- The exact link balloon test passed to completion (10.1 s): CRLF/table bytes,
  no marker reflow, Copy, XTEST URL typing, Edit/Unlink, one-step Undo/Redo and
  save/reopen assertions all passed. The corrected use of Edit URL's existing
  input focus worked.
- The image test reached and passed image Edit/Unlink, XTEST history, saved
  exact bytes and the explicit Open action. It failed before delivering the
  modifier click: `scrollIntoViewIfNeeded` found its target detached while
  waiting for stability after reopening (7.6 s).

The reopen helper can initially see the host prerender's `.vditor-ir`; the spec
then waited only for `routerReady`. Source reading confirms that router readiness
is independent of `markEditorReady`, and the small-document prerender is removed
before `finishInit` marks the live editor ready. A prerender-to-live/initial DOM
replacement is therefore the supported setup-race explanation; the exact retired
node was not captured. This is not evidence of a changed URL or failed action.

Strengthened only the failed image journey's reopened-target setup: wait for
`routerReady`, `editorEpoch > 0` and IR mode; resolve the modifier target under
`#app`; require visibility and membership in the actual `vditor.ir.element`
before measuring its point for XTEST. Apply the same full readiness gate to the
as-yet-unexecuted legacy-policy reopen. Source/action assertions and product code
are unchanged. No fixed sleep or test retry was added.

Targeted Biome exited 0; VS Code typecheck exited 1 only for the known checkbox
TS2339 (`/tmp/task578-cp2b-reopen-types.log`); diff check exited 0. Reuse the same
build and rerun only the failed image test. The passing link journey, counts,
Chromium and unit commands will not be repeated on the unchanged product tree.

### Part B completion and pre-commit review (2026-09-27)

Read the complete dispatch
`/home/user/.local/state/codex-visible/runs/20260927-183542-578-cp2b-relay5/brief.md`
and its retained log `578-cp2b-image.log` in the current scratchpad. The isolated
image test passed with exit 0 (10.0 s test / 12.1 s total), `--workers=1`,
`--retries=0`, using verified XTEST client `:99 / 0x400003 / pid 27890`.
Image Edit/Unlink, exact host/disk source, Undo/Redo, explicit Open, OS modifier-click
and legacy plain-click navigation all passed. The earlier exact CRLF/table link
journey passed in `578-cp2b-actions-focused.log`; its body was unchanged by the
subsequent image-only reopen setup edit. Both action cases are now green across
the focused serial runs; no combined same-tree rerun is claimed or needed.

**Explicit review of the two test setup corrections.**
- Removing the extra URL-input click removed no acceptance assertion or expected
  value. The original pre-checkpoint `.fill()` path did not click the input.
  The XTEST path now uses Edit URL's existing focus, asserts visibility/focus,
  sends Ctrl+A and text through XTEST, and retains the URL/source/history checks.
  The click-dismissal and Edit-focus handlers are byte-identical to `5b51f154`.
  This does not claim to fix or cover manual clicks inside the URL field; their
  pre-existing non-button dismissal is outside this journey. It does not bypass
  an L2 failure or manufacture focus: incorrect automatic focus still fails.
- The reopen edit strengthened the wait predicate from router readiness alone
  to router readiness plus a positive editor epoch and IR mode, scoped the point
  target to `#app`, and added visibility/current-root assertions. No navigation
  assertion was removed or expected target changed. It avoids acting on a
  prerender/stale node before the live editor is ready; it does not claim coverage
  of interaction during prerender. Failure to become ready or attach the live
  target still fails the test, as does wrong modifier/legacy navigation.

Thus these setup edits do not mask a measured L2 regression within the approved
post-ready popover contract. They deliberately leave the two stated interactions
outside coverage, rather than asserting they were repaired. No assertion from
a pre-existing spec was weakened.

**Click-count evidence remains applicable to the current candidate.** Since the
passing `ir-click-index.spec.ts` run, only `link-popover.spec.ts` and this record
changed. No product, shared helper, count-spec or build input changed. The shipped
main.js hash is still
`2705c9fba7c7683bc85b64c38519393fb666e00f88127751bca4ac1430b26c6e`.
The recovered JSON again verifies ir/link/1–2 each 0/0/0, visible popover,
Edit/Unlink disabled as before, source unchanged. All 42 phases remain warm and
source-identical; host/disk bytes and clean version-1 state are unchanged.
WYSIWYG caret-link work remains for part C; the IR-only assertion is not extended
prematurely.

**Part B acceptance.**
- [x] Existing shared index supplied to the popover; no index/EditSync contract
  or admission-filter change.
- [x] Click-time ordinal/identity binding with per-entry scans; warm clicks make
  no source mutations or whole-document calls.
- [x] Action-time marker cross-check and fail-closed mismatches retained.
- [x] 106 focused unit tests, changed-statement coverage, 25 Chromium cases and
  both real-VS-Code XTEST action cases pass; IR work-count assertion passes.
- [x] Baseline and post-change Edit/Unlink availability are explicitly measured.
- [ ] Part C class migration and both-mode work-count assertion: next, not started.

Final lint after the spec-only corrections exited 0 (1074 files), log
`/tmp/task578-cp2b-final-lint.log`; latest spec typecheck retains only the known
checkbox-spec error. Ordinary webview typecheck, build and unit results remain
valid for unchanged inputs. Strict typecheck retains the 13 recorded diagnostics.
No passing runtime/build command was repeated here; network-free quality stages
remain due once on the final Checkpoint candidate, and no aggregate quality pass
is claimed. Part C source/CSS, source-index/EditSync/rewrap contracts, task index,
vendored and tracked generated files are unchanged. Temporary probes are absent;
LOCAL_AGENT_TASK files and git state were not modified.

Return a commit request for part B's 10 explicit paths, including the new
`media-src/src/editing/link-popover.test.ts` and the task record with the preserved
owner addendum. Continue to part C after this serial commit boundary. Task 578
is not closed or moved.

Final part B `jev_gate` was attempted with the product/harness diff, the new
real-Lute unit, supporting test/XTEST and task-record diffs, and retained real
check logs. It returned `MCP tool call requires approval, but approval policy is
never`; no review verdict or gate pass was produced. The exact review payload is
saved at ignored `tmp/task578-cp2b-final-jev-gate.json` (22,419 characters of
primary diff; eight evidence items, 88,269 characters). Caveman Mode is
unavailable. This tool-policy limitation is reported with the commit request.


### Checkpoint 2, part C — implementation and local validation (2026-09-27)

Read the complete dispatch
`/home/user/.local/state/codex-visible/runs/20260927-185140-578-cp2c/brief.md`.
Part B was committed by the orchestrator as `7c2166ae`. The orchestrator reports
its advisory Jev gate escalated on confidence only: four verified claims, zero
contradicted; limiting rubric `test_gap` confidence 0.28. The action-time rebind
claim was manually confirmed against the unchanged `sourceSpanFor` refusal path.
This is an advisory result, not an automatic gate pass.

Part C follows the approved addendum without changing the shared index filter,
EditSync or serializer contracts. `CARET_INSIDE_CLASS` is `vmde-caret-inside`;
classList updates remain idempotent and preserve unrelated classes. The normal,
high-contrast and forced-colors selectors changed in place, with unchanged
specificity, order and declarations. Source/comments/spec assertions no longer
use the old attribute. The work-count assertion now covers every warm phase in
both modes, retaining source/host/disk identity and missing-target guards.

New committed-test candidate `caret-link-lute.test.ts` runs the real vendored Lute
in both modes on inline/title, reference, linked-image, autolink, actual decorated
prose/inline-code refs, and wiki chips through `rewriteWikiChipsToSource`.
The first run exited 1 (72 pass, three missing-target preconditions): reference
links render as `data-type=link-ref` spans in both modes, and an IR image-only
link has no `.vditor-ir__link` label. A bounded probe on only those authored test
strings confirmed those node shapes. They are outside the existing caret selector;
the test now names those exact nodes, asserts they are not caret targets, and
still proves the broader class-parity claim. No serializer equality failed,
no runtime selector was expanded, and no test assertion from before this task
was weakened.

The corrected focused Vitest run exited 0: **75 tests across six files**, including
12 real-Lute cases. Coverage on `caret-link.ts` and `caret-link-decorate.ts` is
100% statements (33/33), branches (24/24), functions (7/7) and lines (30/30).
Tests also prove no warm-index rebuild/DOM invalidation after class entry/leave,
zero context-attribute mutations on a wiki chip and a linked image, idempotent
no-write repeats, and restoration/clearing after simulated root/history replacement.
Command:
`COLUMNS=2000 npx vitest run --config test/vitest.config.mts --coverage --coverage.include=media-src/src/links/caret-link.ts --coverage.include=media-src/src/links/caret-link-decorate.ts --coverage.reporter=text --coverage.reporter=json media-src/src/links/caret-link.test.ts media-src/src/links/caret-link-decorate.test.ts media-src/src/links/caret-link-lute.test.ts media-src/src/nav/source-block-index.test.ts media-src/src/chrome/webview-context.test.ts media-src/src/links/wiki-serialize.test.ts`.
Logs: `/tmp/task578-cp2c-unit.log` (initial),
`/tmp/task578-cp2c-unit-final.log` (corrected). A first Biome write pass exited 1
for a deliberate DOM self-assignment in the new restore test; using a named
history HTML snapshot resolved it. The focused formatting pass then exited 0.

Browser candidate: `caret-link.spec.ts` plus production `observeCaretLink` wiring
in the existing link harness. It asserts source/history/warm-entry preservation
through caret entry, a real pointer click, theme/forced-colors checks and caret
exit in IR/WYSIWYG. It uses DOM Range setup, not claimed OS arrow evidence.
`wiki-chip-focus.spec.ts` keeps the existing solid-outline/source/activation
assertions, migrates the class query, and converts Ctrl+Enter to the verified
XTEST helper (diagnostic browser input remains only outside VMDE_XTEST=1).
Runtime evidence is pending; no 0/0/0 or styling result is claimed for C yet.


**Local gates on the stable part C candidate.** One `node build.mjs` run exited 0;
reuse this build until a source/build input changes. main.js is 899,650 B (+3 B
from part B), SHA-256
`8687380dbfd4c367890f58a25c8f75462abb6ba3fb5e19015f6b50553fa2966e`;
eager modules remain 346. Bundle/startup budgets each exited 1, reporting-only.

| Command | Exit | Evidence |
| --- | --- | --- |
| `npm run lint:ci` | 0 | 1,076 files |
| `npm run typecheck` | 0 | no diagnostics |
| `npm run typecheck:strict` | 1 | same 13 existing diagnostics; none in the changed caret modules |
| `npm run typecheck:vscode-e2e` | 1 | only unchanged preview-task-checkbox.spec.ts:122 TS2339 |
| `npm run check:brand-identifiers` | 1 | four matches in unchanged patch-vscode-test-playwright script/test and Task 580 record |
| `npm run knip` | 1 | nine unused exports and one exported type in unchanged table-resize, emoji, image/SVG and outline modules |
| `npm run jscpd` | 0 | 6.98% duplicated lines; threshold 8.8% |
| `npm run depcruise` | 0 | no detected violations; both stages warn TypeScript >=7 is unsupported, so analysis may be incomplete |
| `git diff --check` | 0 | no whitespace errors |

These are the network-free quality stages for the current candidate, not an
aggregate `npm run quality` pass. The operator prohibits audits and broad test
runs: full coverage and its whole-tree ratchet were not run from focused
coverage (which would misrepresent whole-tree coverage). Diagnostics outside the
changed modules are not repaired in this part; no fresh baseline quality run is
claimed. All local logs and the focused coverage JSON are preserved under ignored
`tmp/task578-cp2c-checks/` as well as the `/tmp/task578-cp2c-*.log` paths.

**Pending relay acceptance.** Chromium: caret-link and the three link specs
(the harness now includes the production caret listener). Real VS Code: the
both-mode `ir-click-index.spec.ts` and the full `wiki-chip-focus.spec.ts`, serial
XTEST with workers=1/retries=0. The existing count spec supplies host/disk and
source invariants; the new browser spec supplies history-length/paint checks.
IR wiki/code-ref/link selection restoration has unit coverage using Range
placement, not OS arrow entry. Actual setValue/mode/history restoration and
full theme message routing are not claimed from that simulation; Checkpoint 3
owns integrated acceptance. Part C remains uncommitted pending runtime evidence.

Pre-relay `jev_gate` was attempted on the full candidate (including both new
tests) with actual local check logs and explicitly pending runtime claims. It
returned `MCP tool call requires approval, but approval policy is never`; no
verdict exists. Payload: ignored `tmp/task578-cp2c-pre-relay-jev-gate.json`.
Caveman Mode remains unavailable. A final review with runtime evidence is still
required before the part C commit request.


### Part C completion — runtime evidence and baseline quality comparison (2026-09-27)

Read the complete dispatch
`/home/user/.local/state/codex-visible/runs/20260927-190516-578-cp2c-relay1/brief.md`.
Both relayed commands ran serially with workers=1/retries=0 and exited 0:

- Chromium: `PLAYWRIGHT_NO_COPY_PROMPT=1 E2E_COVERAGE=1 xvfb-run -a npm --prefix media-src run test:e2e -- caret-link.spec.ts link-popover.spec.ts link-popover-noncanonical.spec.ts link.spec.ts --workers=1 --retries=0` — **27 passed (35.3 s)**.
- Real VS Code: `PLAYWRIGHT_NO_COPY_PROMPT=1 env -u ELECTRON_RUN_AS_NODE -u WAYLAND_DISPLAY XDG_SESSION_TYPE=x11 VMDE_XTEST=1 xvfb-run -a -s '-screen 0 1600x1000x24 +extension XTEST' bash -c 'openbox > /tmp/task578-cp2c-openbox.log 2>&1 & VMDE_WM_PID=$!; trap "kill $VMDE_WM_PID 2>/dev/null || true" EXIT; xdpyinfo -queryExtensions | grep -q XTEST || exit 1; npm --prefix test/vscode-e2e test -- ir-click-index.spec.ts wiki-chip-focus.spec.ts --workers=1 --retries=0'` — **three passed (2.3 min)**.

Retained full logs: `578-cp2c-chromium.log` and `578-cp2c-vscode.log` under
`/tmp/claude-1000/-home-user-Projects-vmde/a7361092-51f9-4a87-a5a3-14560d1c12f3/scratchpad/`.
Coverage: `media-src/coverage/e2e/index.html`. Complete text-free measurement JSON
was copied from the ir-click-index test attachment into ignored
`tmp/task578-cp2c-checks/runtime-evidence.json` before another run can overwrite it.

**Work-count hypothesis confirmed for every measured target.** All 42 phases
are warm/source-identical; six optional targets are absent, zero are unavailable.
Every phase has 0 index builds / 0 full getValue / 0 root Lute, zero fragment
Lute and zero longest long-task duration. In particular:

| Target | Before C | After C | Attribution |
| --- | --- | --- | --- |
| wysiwyg/link/1 | 1/1/2, 122 fragments, one admitted record | 0/0/0, zero fragments/admitted | A gains vmde-caret-inside via class |
| wysiwyg/post-link-plain/1 | 1/1/2, 122 fragments, one admitted record | 0/0/0, zero fragments/admitted | A loses that class |
| ir/link/1–2 | already 0/0/0 after B | remains 0/0/0 | visible popover, Edit/Unlink remain disabled on large-fixture targets |
| all other measured IR/WYSIWYG targets | already 0/0/0 | remains 0/0/0 | both-mode assertion passes |

The two WYSIWYG transition rows have 73 total records: one changed class on A
plus 72 same-value syntax-highlight class writes. Their second-click rows have
72 total records and no anchor write. All are unadmitted; do not claim zero total
DOM mutations. The unchanged predicate drift guard passed. Host/disk SHA-256 is
`a4a39d6f6c605eb82b0e03a236f67388bceeae9a85450b0d4285053b28299f65`,
UTF-8 length 174,527 B; host remains clean at version 1.

**Styling was observed in actual VS Code.** The passing first wiki-chip-focus
case (5.6 s) explicitly asserts `classList.contains('vmde-caret-inside') === true`
and `getComputedStyle(chip).outlineStyle === 'solid'` before XTEST Ctrl+Enter.
The verified XTEST client was `:99 / 0x400003 / pid 35391`, visible. Activation
opened the expected wiki page without changing source. The second host-command
case (5.7 s) also asserted the class and unchanged serialization, then verified
activation/source identity. The large-fixture recorder independently shows class
entry/leave on a WYSIWYG anchor, but does not sample that anchor's computed outline.
Normal/HC/HC-light/forced-colors outline widths and offsets passed in Chromium,
along with source identity, history stack lengths and reuse of the same warm entry
through entry/click/exit. No additional real runtime run was needed.

**Brand/knip are confirmed pre-existing at `7c2166ae`.** Exported that exact
commit into `/tmp/task578-cp2c-quality-baseline-vup1xb3z` using read-only git archive;
no git metadata was copied or changed. With existing dependencies supplied via
three temporary symlinks, baseline knip exited 1 with nine unused exports/one
exported type. Its output is byte-for-byte identical to the candidate output.
The brand check initially hit EISDIR because git's untracked scan listed a temporary
dependency-directory symlink as a file. Removed only those three temporary
symlinks (brand uses Node built-ins), then reran the failed baseline check:
exit 1 with the same four diagnostics, also byte-for-byte identical.

Baseline commands, cwd that exported directory:
- `GIT_DIR=/home/user/Projects/vmde/.git GIT_WORK_TREE=/tmp/task578-cp2c-quality-baseline-vup1xb3z npm run knip` — 1.
- `GIT_DIR=/home/user/Projects/vmde/.git GIT_WORK_TREE=/tmp/task578-cp2c-quality-baseline-vup1xb3z npm run check:brand-identifiers` — 1 initially (setup EISDIR), 1 after correction (four baseline violations).
Logs: `/tmp/task578-cp2c-baseline-knip.log`,
`/tmp/task578-cp2c-baseline-brands.log` (setup failure), and
`/tmp/task578-cp2c-baseline-brands-final.log`. Copies are in the ignored check folder.
No passing command was rerun on an unchanged tree. Main.js still has the recorded
part C hash; runtime/test/product sources have not changed since the passing runs.

**Acceptance and limits.**
- [x] Approved class migration, unchanged index filter and CSS declarations.
- [x] Committed-test candidate proves real-Lute parity; scratch probe is not relied on.
- [x] Context observer neutrality, warm-index reuse, idempotence and simulated restoration units.
- [x] Both-mode warm 0/0/0, exact host/disk identity, real caret-class paint and XTEST activation.
- [x] Chromium contrast paint, history-length and warm-entry/source invariants.
- [x] Brand/knip failures reproduced identically before this part.
- [ ] Checkpoint 3 integrated acceptance remains separate: OS arrow entry into every link shape,
  full mode/setValue/undo restoration and real theme-message routing were not measured here.

No Part 1 design question is reopened. The evidence did not invalidate the class
design. No index/EditSync contract, vendor/generated source, task index or protected
LOCAL_AGENT_TASK file was edited, and no temporary test probe remains in the commit
candidate. Return the 15-path part C commit request; Task 578 itself stays open.

Final `jev_gate` was attempted with the full implementation/new-test diff and
15 evidence items including real local checks, runtime logs/attachment summaries,
and the baseline comparisons (32,880 diff characters; 71,389 evidence characters).
It returned `MCP tool call requires approval, but approval policy is never`;
there is no Jev verdict. The exact payload is preserved at ignored
`tmp/task578-cp2c-final-jev-gate.json` for the orchestrator. Caveman Mode remains
unavailable. Final diff whitespace check passed; no source/build/runtime command
was repeated merely for this documentation update.
