# Task 578 — Stop IR clicks from rebuilding the shared source index

> **For agentic workers:** Use `superpowers:systematic-debugging` for the attribution checkpoint, then `superpowers:executing-plans` for the fix checkpoints. Checkboxes track implementation and acceptance; the hypotheses below are not a confirmed diagnosis.

**Status:** Checkpoint 1 complete (red evidence); local commit requested. Checkpoints 2–3 remain open (2026-09-27).
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
