# Task 578 — Stop IR clicks from rebuilding the shared source index

> **For agentic workers:** Use `superpowers:systematic-debugging` for the attribution checkpoint, then `superpowers:executing-plans` for the fix checkpoints. Checkboxes track implementation and acceptance; the hypotheses below are not a confirmed diagnosis.

**Status:** ✅ CLOSED (2026-09-28). Checkpoints 1 and 2 are committed at `83fbfd3e`, `5b51f154`, `7c2166ae` and `ede2c686`; Checkpoint 3's final tracked-input acceptance and quality evidence is recorded at the end of this file. Earlier relay failures and the optional unmeasured residuals remain documented below. Focused commits for the pending Checkpoint 3 changes are requested separately; nothing has been pushed.
**Goal:** An ordinary click in the IR editor does not invalidate the shared per-revision source block index when the Markdown source did not change. The next index consumer therefore reuses the warm entry instead of rebuilding it with whole-document serialization.
**Tech stack:** TypeScript, Vditor/Lute, Vitest, Chromium Playwright and real VS Code with OS-level keyboard input.
**Spec:** The report, behavior contract and acceptance criteria in this file are the specification.
**Dependencies:** [Task 574](574-text-selection-performance.md) (shared index), [Task 577](577-selection-toolbar-settle-latency.md) (build holds) and [Task 196](196-find-and-replace.md) (Find on the index) are complete. Preserve their contracts. The original source-neutral-mutation scope now also includes the Owner-approved CP3 fix in `caret.ts` for a snapshot re-arming intent during a held primary drag; other caret callers and Vditor remain excluded.

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

- [x] Implement the chosen design in the smallest set of files.
- [x] Unit tests on the real Lute IR DOM: each ignored record class leaves `VditorIRDOM2Md` output unchanged. Every source-changing mutation still invalidates, including text edits, link href/image src changes (existing tests), node insertion/removal, and details/table structure. The chosen fixes stop writers at source; the admission filter is unchanged.
- [x] Confirm the existing `source-block-index.test.ts`, `block-handle.test.ts` and `details-toggle-controls.test.ts` invalidation contracts still pass unchanged.

## Checkpoint 3 — Integrated acceptance and closure

- [x] The Checkpoint 1 red assertions pass for every click target in IR. Three matched historical runs and timings are preserved; relay 16 supplies the required fresh rebuilt-candidate sweep: 42 warm phases, zero builds/getValue/root/fragment Lute, exact source/history, six optional absences and no unavailable target.
- [x] Complete the approved held-primary-pointer authority fix: immediate repair without re-arming, release/cancel/focus-loss recovery, unit and unchanged Vditor-patch coverage, forced and natural-timer drag proofs in both modes/layers, the named caret/Undo/gap/IME regressions, and three consecutive unchanged `selection-performance.spec.ts:471` passes. Product changes stay confined to `caret.ts`.
- [x] Focused regressions pass with `--retries=0`: Chromium `block-handle.spec.ts`, `details.spec.ts`, `selection-bubble.spec.ts`, `selection-performance.spec.ts` and `find-replace-large.spec.ts`. Real VS Code: `block-handle.spec.ts`, `details-toolbar.spec.ts`, `selection-bubble.spec.ts`, `selection-performance.spec.ts`, `large-document-interaction.spec.ts`, `find-replace.spec.ts` and `find-replace-large.spec.ts`. The measured Find-open IR click gate is absolute zero; the cold Find-closed phase retains its separate precondition.
- [x] Exact source, host and disk equality after the rebuilt candidate's click journey; no dirty or history change from clicks. Relay 16 confirms all per-phase source/history identities and original host/disk hash; host remains found, clean and version 1.
- [x] Resolve the relay-only OS-input dependency before final closure: tracked Unicode-scalar XTEST delivery, unit coverage and legacy-spec adapter wiring replace the ignored runtime hook; final acceptance uses the tracked checkout.
- [x] Changed-line coverage, typechecks and the network-free quality stages ran once on the rebuilt final candidate. Nonzero known findings and reporting-only bundle/startup budgets are recorded below; no new finding was identified.
- [x] Update this record with the evidence, move it to `tasks/done/` and add the `tasks/README.md` entry after every required item above is complete.

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

### Checkpoint 3 — final-candidate preparation and local evidence (2026-09-27)

Read the entire dispatch `20260927-191136-578-cp3/brief.md` and this task record.
Confirmed clean tracked starting tree and HEAD `ede2c686`; the two protected
LOCAL_AGENT_TASK files remain untracked and untouched. Part C's commit status
above is corrected. No product, generated output, task index or git metadata is
changed in this checkpoint.

**Orchestrator advisory review, as reported in the dispatch:** Part B had four
verified claims, zero contradicted, escalating only on confidence (`test_gap`).
Part C had five verified claims, zero contradicted, escalating only on confidence
(`blast_radius`). The orchestrator separately ran
`npx vitest run media-src/src/links/caret-link-lute.test.ts`: 12 passed. These
advisory results are not automatic gate passes. The earlier Part B confidence
0.28 remains recorded above; no unreported Part C confidence is inferred.

**Prepared runtime evidence, not yet acceptance:**
- `ir-click-index.spec.ts` now checks native history identity per click: SHA-256
  of undo/redo patch contents and lastText, plus stack lengths, sampled outside
  the armed work window. It also requires every measured phase to be warm and
  asserts the host is found, clean and still version 1. Source comparisons remain
  text-free. Work-count and target/source assertions are retained.
- New `caret-link-lifecycle.spec.ts` covers the four current selector shapes
  (ordinary link, wiki chip, prose code reference, inline-code reference), IR /
  WYSIWYG / IR mode round-trip, host WorkspaceEdit causing actual setValue,
  single-step XTEST Undo/Redo, and actual workbench theme changes with observed
  `set-theme` messages and computed outline widths. Only the starting boundary
  uses DOM Range; ArrowRight entry and editing use the verified X11 client.
  It checks source/history lengths and warm 0/0/0 for each arrow phase, verifies
  decoration against live selection, and preserves partial JSON on failure.
  This is a candidate test, not a claimed pass. Forced colors remain Chromium
  evidence from Part C; reference spans and IR image-only links remain outside
  the existing caret selector, as documented by the real-Lute tests.
- Existing block-handle, details-toolbar and selection-bubble keyboard steps
  now use the existing SpecKeyboard XTEST adapter when VMDE_XTEST=1. Find specs'
  remaining fill steps now use focused XTEST Ctrl+A/type. Existing acceptance
  assertions and expected bytes are unchanged. Synthetic selection/drag/IME
  setup is still synthetic, not OS gesture/IME evidence.
- `find-replace-large.spec.ts` retains its relative IR click gate until its own
  fresh open/closed phase measurements support tightening to absolute zero.
  Part C's retained JSON was re-read: 42/42 warm, source-identical, zero-work
  phases, clean host/version 1. That does not substitute for the pending three
  matched candidate runs. Their before rows will use the recorded Checkpoint 1
  clean run; no three-run pre-fix timing distribution is claimed.

**Final candidate local checks.** Logs and exact command arrays are retained in
ignored `tmp/task578-cp3-checks/<name>.{log,json}`. The network-free quality stages
were each run once; `npm run quality`, audits, FAST and full browser/VS-Code
suites were not run.

| Command/check | Exit / result |
| --- | --- |
| targeted `npx biome check --write` on seven changed/new TS specs | 0; two formatted |
| `npm run lint:ci` | 0; 1,077 files |
| `npm run typecheck` | 0 |
| `npm run typecheck:strict` | 1; 13 diagnostics, output byte-identical to retained Part C log |
| `npm run typecheck:vscode-e2e` | 1; only checkbox-spec TS2339, output byte-identical to Part C |
| `npm run knip` | 1; nine exports/one type, output byte-identical to Part C's baseline-proven output |
| `npm run jscpd` | 0; 6.98% duplicated lines |
| `npm run depcruise` | 0; no detected violations; TypeScript 7 support warning still limits analysis |
| `npm run test:coverage -- --coverage.reporter=text --coverage.reporter=html --coverage.reporter=json-summary --coverage.reporter=json` | 1; 313 files passed / 3 failed; 4,675 tests passed / 49 failed / 1 expected fail; 131.03 s |
| `npm run check:coverage-modules` | 1; missing full `coverage/coverage-summary.json`, not a measured module regression |
| focused Vitest coverage, 14 files (exact command in `focused-coverage.json`) | 0; 191 passed |
| focused real-VS-Code `--list --workers=1 --retries=0`, VMDE_XTEST=1 | 0; 28 cases across nine specs (including count and new lifecycle specs) |
| focused Chromium `--list --workers=1 --retries=0` | 0; 46 cases across five specs |
| `npm run check:bundle-size` / `npm run check:startup-cost` | 1 / 1, reporting-only; 899,650 B, +1,459 B vs Task 196; 346 eager modules |
| `git diff --check`, relay script `bash -n` | 0 |

The once-only full unit run failed before child probes could execute:
`prepare-production-release.test.ts` (21), `package-local-preview.test.ts` (27),
and `markmap-security.test.ts` (1) report `spawnSync git`, `/usr/bin/git`, or
Node `EPERM`. Exported pre-task `d56ca040` with read-only `git archive` to
`/tmp/task578-cp3-pre-task-7loqq7ek`, linked the existing installed dependencies,
and ran only those three files there with
`npx vitest run --config test/vitest.config.mts test/backend/prepare-production-release.test.ts test/backend/package-local-preview.test.ts test/backend/markmap-security.test.ts`.
Exit 1: the same 49 failures / 6 passes. Exact failure-name sets match, with no
candidate-only failure (`baseline-failure-comparison.json`); all 49 share the
same process-spawn restriction. These are reproduced environmental failures,
not evidence of product regressions. No root repository git state was changed.
Vitest emitted no full coverage report on failure. Do not run the module ratchet
against focused coverage or claim whole-tree coverage is green. The once-only
full coverage/ratchet acceptance remains explicitly incomplete; no full rerun
is requested under this dispatch's once-only constraint.

**Changed-line coverage for the whole Task 578 implementation.** The requested
`e52a64e2..HEAD` range includes intervening Tasks 196/577. The four Task 578
commits are consecutive, so `d56ca040..ede2c686` isolates their cumulative diff.
`changed-coverage.json` records every added line and the statement-start mapping
from the focused V8 report: fix-table-ir 14/14, table-cell-selection 3/3,
link-popover 30/30, caret-link 4/4 changed statement starts covered. The new
finish-init dependency property belongs to the enclosing installLinkPopover
call at line 220, executed eight times; its other change and caret-link-decorate
changes are comments. Both caret modules retain 100% whole-module coverage.
The XTEST helper has 11/12 changed statement starts covered; line 196's browser
`window.devicePixelRatio` callback is mocked by the unit driver and remains a
unit coverage gap (Part B's real modifier-click passed, but is not V8 coverage).
CSS paint and harness/spec behavior require runtime evidence, not unit line
percentages. No blanket 100% whole-diff coverage claim is made.

**Build reuse.** Product/build inputs are unchanged since Part C's successful
`node build.mjs`. Confirmed main.js SHA-256 remains
`8687380dbfd4c367890f58a25c8f75462abb6ba3fb5e19015f6b50553fa2966e`.
Reuse it for all relays; no redundant build or generated-file edit was made.

**Pending serial relays and closure.** The prepared ignored
`tmp/task578-cp3-checks/vscode-relay.sh` verifies that hash, starts Openbox in the
provided Xvfb display, checks XTEST, and runs lifecycle, three separate count
invocations, then the seven requested regression specs, with workers=1/retries=0
and distinct output directories. It stops after a lifecycle/count failure so
its evidence can return to Part 1 without redesign. Chromium's five requested
specs are a separate relay. Run all relays serially to avoid timing contention.

- [x] Three matched candidate count runs and before/after longest-task table (completed before the owner pause; extracted on resume).
- [ ] New caret lifecycle and real theme-routing acceptance — unmeasured residuals after the final authorized optional attempt; no further optional relay (see completed relay 9 below).
- [x] All requested Chromium regressions: 46 passed, retries=0 (Checkpoint 3 relay 1).
- [ ] All requested real-VS-Code regressions, with any new failure
  reproduced on a pre-task baseline before labeling it pre-existing.
- [x] Fresh Find open/closed click evidence and conditional absolute-zero gate — the measured Find-open IR gate is tightened and passes in relay 10; cold Find-closed remains separately accounted.
- [x] Full unit coverage report and successful module ratchet (authorized unsandboxed relay 2).
- [ ] Final runtime-informed Jev review, commit request and whole-task closure.

The known table copy-spacing and extra source-neutral Undo checkpoint remain
recorded residuals from the earlier baseline comparison, not new fixes here.
No new caret/undo/shared-state or serializer-parity defect has been measured in
this checkpoint. A runtime defect in those areas must return to the Opus Part 1
feedback path; this checkpoint does not authorize redesign. Task remains here;
`tasks/README.md` stays unchanged. No commit is requested before runtime evidence.

The Jev, testing, Lute, visual-debugging and renderer-theming skills were read.
Caveman Mode was found at the installed caveman/2.7.0 skill path and loaded;
contrary to prior sessions, it is available here. Optional Superpowers skills
were not found in the exposed local skill locations.

Checkpoint 3 pre-relay `jev_gate` was attempted with 38,048 characters of
cumulative product/core acceptance diff and 14 evidence items (101,366 characters),
including the other current test diffs, real check logs and the baseline failure
comparison. Result: `MCP tool call requires approval, but approval policy is never`.
No verdict exists. Exact payload and result are in
`tmp/task578-cp3-checks/jev-gate.json` and `jev-result.txt` for the orchestrator.
This is a tool-policy block, not a reviewed rejection of the implementation.
A final runtime-informed review remains pending. Final whitespace check passed.

### Checkpoint 3 relay 1 — Chromium accepted, XTEST preflight repaired (2026-09-27)

Read the complete `20260927-193134-578-cp3-relay1/brief.md`. The new dispatch
explicitly authorizes an unsandboxed relay of full unit coverage plus the module
ratchet. This supersedes the earlier decision not to retry those failed stages;
it does not authorize rerunning the passing quality stages or audits.

**Chromium relay: exit 0, 46 passed (3.5 min), workers=1/retries=0.** All five
requested specs completed. The full log contains 46 passing case records and
45 Find phase objects. Find's editor-click phase is 0 index builds / 0 full
getValue / 0 root Lute and 0 ms longest task in IR, WYSIWYG and SV. The selection
performance gates pass: no live markers, at most one full getValue/index build
per keyboard phase, and zero drag source/index work. Source-owned block actions,
Details, selection-bubble formatting/history and the large Find journeys pass.
Browser coverage reports 74.64% aggregate lines for this focused harness set;
it is not whole-product or real-VS-Code coverage. The real Find click gate still
awaits its own host-integrated phase evidence before tightening.

Retained full log:
`/tmp/claude-1000/-home-user-Projects-vmde/a7361092-51f9-4a87-a5a3-14560d1c12f3/scratchpad/578-cp3-chromium.log`.
Copied to `tmp/task578-cp3-checks/chromium-relay.log`; SHA-256
`8b4dad710d89a9efd4fac1640a095e718f9183aaca59cb234d0d7b1128819a21`.
The parsed summary is `chromium-relay-summary.json` in the same check folder.
Artifacts: `tmp/task578-cp3-checks/chromium-results`; coverage:
`media-src/coverage/e2e/index.html`. Do not rerun this passing command.

**VS Code relay: exit 1 before any spec.** The full log contains only the verified
Part C build hash. There is no lifecycle exit line or spec log, and Openbox's
log is empty. This is a runner setup failure, not a product/test assertion.
The previous `xdpyinfo -queryExtensions | grep -q XTEST` ran under `pipefail`;
`grep -q` can exit at its first match and cause the producer to receive SIGPIPE.
The original run did not retain individual pipeline statuses, so SIGPIPE is a
credible runner explanation, not a measured attribution.

Changed only the ignored relay script: capture all `xdpyinfo` output first in
`xdpyinfo-preflight.log`, then grep that completed file. A failed xdpyinfo now
reports its exit code; a missing extension reports a separate error. The script
prints an explicit preflight-success line before any spec. No XTEST focus guard,
acceptance assertion, retry setting or product code changed. The same build and
pending serial lifecycle/count/regression commands are reused. Original failed
log copied to `vscode-relay-preflight-failure.log` in the check folder.

Prepared `tmp/task578-cp3-checks/unit-relay.sh` for the authorized unsandboxed
retry. It runs `npm run test:coverage` with text/html/json-summary/json reporters
and `--coverage.reportOnFailure=true` (verified in installed Vitest CLI), then
runs `npm run check:coverage-modules`, records each exit code independently,
and fails if either stage fails. Full reports go to `coverage/`; the earlier
focused report stays separate. No audits or aggregate quality script are used.

`bash -n` on both relay scripts exited 0. Runtime specs, product/build inputs,
protected queue files, task index and git metadata remain unchanged in this
relay response. No new design question is established. VS Code acceptance and
full unit coverage/ratchet evidence remain pending; no commit or task closure
is requested. Run the two requested relays serially to avoid CPU contention
with the three timing measurements.

Relay-response `jev_gate` was attempted with the corrected runner, current
candidate and real Chromium/preflight evidence (41,113 diff characters,
16 evidence items). It again returned `MCP tool call requires approval, but
approval policy is never`; no verdict exists. Exact attempted payload:
`tmp/task578-cp3-checks/jev-relay1-gate.json`. Final `git diff --check` exited 0.

### Checkpoint 3 relay 2 — full unit gate green, lifecycle focus target corrected (2026-09-27)

Read the complete `20260927-193900-578-cp3-relay2/brief.md`, the lifecycle log
and partial JSON, and the actual full-unit/ratchet outputs.

**Full unit relay: exit 0; ratchet: exit 0.** The authorized outside-sandbox
run completed 316 files: **4,724 passed, one expected failure, zero unexpected
failures**, 127.17 s. All 49 process-spawn failures from the sandbox run disappear.
Full coverage: statements 75.61% (23,302/30,817), branches 68.49%
(14,433/21,073), functions 79.29% (3,795/4,786), lines 77.84%
(21,066/27,063). The module ratchet passes with 11 zero-coverage modules against
baseline 13; the suggested baseline pruning is outside this task and was not done.
Logs: `tmp/task578-cp3-checks/unit-coverage-relay.log` and
`coverage-ratchet-relay.log`, with command/exit metadata in their sibling JSONs.
Full reports are `coverage/coverage-final.json` and `coverage/coverage-summary.json`.
Orchestrator transcript: `578-cp3-unit.log` in the retained scratchpad.
Do not rerun these passing stages.

Recomputed the Task 578 cumulative changed-line map from this **full** report
without executing tests (`changed-coverage-full.json` in the check folder).
It independently confirms changed product statement starts: 14/14 fix-table-ir,
30/30 link-popover, 3/3 table-cell-selection, 4/4 caret-link. Both caret modules
are 100% in all four full-unit coverage metrics. The default full-unit coverage
includes product source only, so the XTEST helper is absent there; its earlier
separate 11/12 focused statement result is retained, not replaced by a 0% claim.
The unchanged product source means these reports remain applicable after the
following test-only setup correction.

**VS Code relay: exit 1 after the lifecycle case (45.1 s), no later specs ran.**
XTEST preflight now passed, using verified visible client `0x400003`, pid 62375.
The initial IR sequence completed all four shapes: ordinary link, wiki chip,
prose code reference and inline-code reference. Each entered on one physical
ArrowRight, painted its caret class/solid outline, retained undo/redo lengths
1/0 and exact serialized source, and performed **0 builds / 0 full getValue /
0 root Lute**, with longest task 0 ms. The ordinary link had two fragment renders;
the other shapes had none. These are actual partial acceptance results, not a
pass for the whole lifecycle. Mode/setValue/history/theme sections remain pending.

At `wysiwyg/link`, Playwright resolved the correct paragraph but its hard-coded
`position:{x:4,y:4}` was intercepted by a Down button in
`.vditor-panel.vmde-element-panel`. The actionability log reports that same
interceptor through the timeout. Failure is on the focus-setup click at old
line 60, **before** setting the boundary Range, arming counters or sending the
WYSIWYG arrow. No WYSIWYG caret, serializer, shared-index or history assertion
failed. The intended test contract is physical editor focus followed by OS arrow
entry, not access to the paragraph's top-left padding under a visible control.
This is a test-targeting failure. No pre-existing product defect is asserted,
so no unsupported baseline attribution or product redesign is introduced.

The new spec now locates the authored paragraph's plain-text suffix, selects its
first nonempty painted client fragment, and uses that fragment's midpoint for
the physical focus click. It keeps Playwright actionability and the real panel
intact: no forced click, synthetic click, hidden panel, sleep or retry is added.
An added assertion verifies the actual editable root gained DOM focus. Boundary
Range placement, XTEST ArrowRight, caret-class/paint/source/history/count
assertions and all lifecycle actions are unchanged. This setup correction is
still awaiting runtime verification; manual clicks on the formerly obscured
padding are not claimed fixed or covered.

Preserved failed evidence before the next run can overwrite its output:
`tmp/task578-cp3-checks/lifecycle-relay2.log` and `lifecycle-relay2-results/`
(include the four-row `caret-link-lifecycle.json`). The outer relay transcript is
`578-cp3-vscode2.log` in the retained scratchpad.

Correction checks: targeted `npx biome check --write test/vscode-e2e/caret-link-lifecycle.spec.ts`
exit 0, no formatting changes; `npm run typecheck:vscode-e2e` exit 1 with only
the known checkbox-spec TS2339; focused VMDE_XTEST=1 `--list --workers=1 --retries=0`
exit 0, one lifecycle case; changed-coverage analysis and diff whitespace check
exit 0. Local logs are `lifecycle-target-types.log` and `lifecycle-target-list.log`.
No successful Chromium, unit, coverage, quality or build run is repeated.

Re-request only the corrected serial VS Code relay: lifecycle, then counts 1–3,
then the seven regression specs. The script still stops at the first failed
lifecycle/count case. Same verified Part C build (899,650 B, SHA-256
`8687380dbfd4c367890f58a25c8f75462abb6ba3fb5e19015f6b50553fa2966e`).
No source/build, generated, task-index, protected queue or git-state changes.
No new product design question is established; task closure and commit remain
pending the remaining runtime evidence.

Relay-2 response `jev_gate` was attempted on the exact 1,680-character setup
correction with seven evidence items (old/new spec, failed lifecycle log,
full-unit/ratchet output, coverage map and static checks). It returned the same
approval-policy denial; no verdict exists. Payload:
`tmp/task578-cp3-checks/jev-relay2-gate.json`. Final diff whitespace check passed.

### Checkpoint 3 relay 3 — replace the covered setup target and compare panel ownership (2026-09-27)

Read the complete `20260927-194503-578-cp3-relay3/brief.md` and full lifecycle
log. Exit 1, lifecycle 46.1 s; counts/regressions did not run. The same four IR
shapes again completed one-arrow entry with unchanged source/history and warm
0/0/0. At the first WYSIWYG shape, the painted suffix point was intercepted by
an `input[placeholder="ID<Alt+Enter>"]` in the element panel. The previous
correction changed the point but still targeted the covered paragraph. It did
not resolve the setup failure. Preserve this as a failed correction, not a pass.
Evidence is copied to `lifecycle-relay3.log` and `lifecycle-relay3-results/` in
the ignored check folder; the original transcript is `578-cp3-vscode3.log` in
the retained orchestrator scratchpad.

**Every acceptance setup click audited and changed at its shared owner.**
`focusEditor()` now clicks an authored, separate plain-text paragraph
`Caret focus staging.` appended after all four link paragraphs. Its locator is
`#app .vditor-reset:visible > p` filtered by that exact staging text. No link
paragraph or link target is clicked for focus. All arrow phases (initial modes,
mode restoration, after setValue and after Undo) call this one helper. A real
Playwright click still must pass actionability, and the actual editable root
must gain DOM focus before the boundary Range and OS ArrowRight steps.

Static grep and an exact audit script confirm **three click call sites** in
`caret-link-lifecycle.spec.ts`: the staging anchor, the toolbar mode button and
the requested mode option. There is **no `ancestor::p`, `paragraph.click`,
`target.click`, or force-click** in this acceptance spec. The earlier setup
coordinate and suffix-locator route are gone. No caret/class/paint/source/history/
work-count assertion is weakened. The fixture source and all host/disk oracles
include the extra staging paragraph. Read-only focus diagnostics now log panel,
heading, first-paragraph and staging-anchor rectangles, selection-owner tag and
hit-test metadata without fixture text. Runtime success is still pending.
Audit artifact: `tmp/task578-cp3-checks/relay3-panel-scope-and-click-audit.json`.

**Panel ownership and Part A scope (static evidence).** The ID input is created
specifically in Vditor's heading branch in
`wysiwyg/highlightToolbarWYSIWYG.ts` (lines 714–748), which calls
`setPopoverPosition` for the heading. VMDE's `installNativePopoverPlacement`
then uses `elementPanelPosition(..., 'above')`, which tries below the owner when
above does not fit. Its contract clears the owner/caret and viewport boundaries;
it does not reserve all neighboring paragraphs. Therefore a heading's floating
panel can cover an inactive following paragraph under the existing design.
This is the supported explanation for these setup points, not proof yet of the
same runtime geometry before Task 578.

`native-popover-position.ts`, `floating-overlay.ts`, `esbuild-shared.mjs`, the
webview dependency lock and the exact `.vditor-wysiwyg > .vditor-panel.vmde-element-panel`
CSS rule compare byte-identically with pre-task `d56ca040`. The unchanged
finish-init observer installs that WYSIWYG placement path. Part A binds its
`eventRoot` specifically to `inner.ir.element` and appends its lazy clip box to
that IR root's parent. Its shared table-selection edit retains the existing
WYSIWYG-panel early return and adds only IR sibling ownership. Part A changes
no WYSIWYG placement or CSS. Part C's CSS diff only migrates the three caret
outline selectors with unchanged declarations. No product geometry fix is made.

**Bounded runtime baseline comparison prepared, not claimed complete.** The
pre-task archive `/tmp/task578-cp3-pre-task-7loqq7ek` already existed from the
unit-failure comparison. Materialized only its Vditor dependency locally so
anchored patch imports cannot resolve back to candidate product source, then
ran `node build.mjs` there once: exit 0. Its 898,191 B main.js has the exact
Checkpoint 1 SHA-256
`c1fb62d1c39c3357acf2c22f41765cdd036f09be7b33264643d272318bbea61c`;
its build manifest contains zero candidate product-source inputs. Candidate
build remains 899,650 B with the recorded Part C hash. No repository git state
or candidate generated output changed.

Identical temporary `caret-panel-geometry.tmp.spec.ts` probes now exist in the
archive and candidate. They retain the original four-link fixture and its IR
physical-focus/ArrowRight journey, switch to WYSIWYG, then record heading/panel/
paragraph rectangles and hit-tests at both previously blocked points. They
check host source equality. They intentionally do not apply Task 578's new
class or 0/0/0 gates to the old product; this is a geometry comparison, not
acceptance. Their legacy paragraph focus locator is restricted to the reproduced
IR setup, not the corrected lifecycle spec. They use `@probe` and require
VMDE_PROBES=1/VMDE_XTEST=1. Remove both temporary probe files before commit.

The optional VMDE_COMPARE_PANEL=1 path in the relay script runs baseline and
candidate probes serially, preserving both logs and explicit JSON artifacts.
A deterministic comparison requires the same heading-panel obstruction at both
old points, no IR panel under WYSIWYG, and unchanged host source in both products.
If those observations differ or setup fails, it stops for review before lifecycle
acceptance. Otherwise it runs the corrected lifecycle, then counts 1–3 and the
seven regressions. This supplies the requested pre-task evidence without silently
labeling a product failure pre-existing. Any resulting caret/shared-state design
question still returns to Part 1; no redesign is authorized.

Checks: targeted Biome on the corrected spec and temporary probe exit 0;
VMDE_XTEST=1/VMDE_PROBES=1 focused discovery exit 0 (two cases); spec typecheck
exit 1 only for the known checkbox TS2339; both relay scripts pass `bash -n`;
static click/placement audit and diff whitespace check exit 0. Logs:
`lifecycle-staging-types.log`, `lifecycle-staging-list.log`, and
`pre-task-panel-build.log` in the check folder. No passing Chromium, full unit,
coverage, quality or candidate build is repeated. The task and task index remain
open/unchanged respectively; no commit request is made.

Relay-3 response `jev_gate` was attempted on the setup/probe/runner diff
(13,910 characters) with five evidence items. It was denied by approval policy
`never`; no review verdict exists. Payload: `tmp/task578-cp3-checks/jev-relay3-gate.json`.
Final whitespace check and syntax checks passed. Temporary probe cleanup remains
an explicit prerequisite to a future commit request.

### Checkpoint 3 relay 4 — baseline obstruction confirmed; complete pointer audit (2026-09-27)

Read the complete `20260927-195741-578-cp3-relay4/brief.md`, full lifecycle log
and `panel-comparison.json`. Both panel probes exited 0 (one passed each).
The comparison's entire baseline/candidate geometry objects are equal, with
`sameObservedObstruction=true`, owner H1, no IR panel under WYSIWYG and unchanged
host source. On both pre-task `d56ca040` and candidate `ede2c686`:
- heading: left/right 52/740, top/bottom 104/148.390625 px;
- heading panel: left/right 52/232, top/bottom 156.390625/181.390625 px;
- following paragraph: top/bottom 164.390625/186.78125 px;
- old x4/y4 point hits BUTTON; the suffix midpoint hits INPUT, both inside the panel.

The panel is exactly 8 px below the heading and overlaps 17 px of the inactive
following paragraph. This proves that specific obstruction pre-exists Task 578,
matching the unchanged placement contract. Part A's IR table-panel relocation
is not the cause. It is a user-facing residual: while the native panel occupies
those pixels, pointer access to the underlying text is blocked. No panel geometry
or dismissal behavior is repaired in Task 578. The later link-panel hover
interception below is another candidate observation of this obstruction class;
the exact link-panel geometry was not independently compared on the baseline.

The lifecycle then failed, exit 1 / 46.7 s. The staging paragraph successfully
received focus in WYSIWYG; its hit-test was P with insideFocusAnchor=true. After
the boundary Range, however, the **pre-measurement `target.hover()`** was blocked
by a native link-panel input with placeholder `text(no empty)`. No WYSIWYG arrow
was sent or measured. Four IR shapes again passed beforehand. The earlier audit
covered clicks only and missed both hovers; that was incomplete. Preserve the
failed run as `lifecycle-relay4.log` / `lifecycle-relay4-results/`, rather than
claiming the staging correction completed the lifecycle.

**Every pointer action audited, then removed from this keyboard lifecycle spec.**
There were five call sites. Their replacements are:

| Previous pointer action | Panel-independent replacement |
| --- | --- |
| staging paragraph click for focus | active editable-root DOM focus precondition, with unique-root and `toBeFocused()` assertions |
| link hover before measurement | XTEST Ctrl+F / Escape, outside the work window, to read/warm the actual shared source index |
| link hover inside measurement | the same keyboard Find read inside the armed 0/0/0 window, exposing an unpaid invalidation |
| edit-mode trigger click | no menu opening; focus the active root and use the native XTEST mode chord |
| mode-option click | Ctrl+Alt+7 for WYSIWYG / Ctrl+Alt+8 for IR, followed by the existing readiness and decoration checks |

The installed production code supports these routes: `package.json` maps Ctrl+F
to `vmde.findReplace`, the host posts `open-find-replace`, and Find's `open()`
calls `refresh(true)` before focusing its input. `createFindSourceTracker.find`
calls `source(true)` **even for the empty query**, draining/reading the same
shared index through peek/read. Escape is delivered while the actual Find input
is focused; its own handler closes the widget and returns editor focus. The
helper asserts visible/focused Find, empty value, 0/0 status, then hidden Find
and focused editor. It does not fake a source-index handle or call a test-only
product API. Native mode chords are implemented by Vditor's
`util/editorCommonEvent.ts` Digit7/Digit8 branch and advertised by EditMode.

All actual keys still use the verified X11 client. DOM focus and the initial
boundary Range are setup preconditions; the asserted entry is still OS
ArrowRight. There are no synthetic keyboard or pointer events. The unused
staging paragraph and its coordinate/geometry helper were removed. The original
four-link fixture is restored. Source/host/disk oracles still derive from that
fixture. Existing link membership, class, solid outline, selection consistency,
source equality, native-history lengths, instrumented index and 0/0/0 assertions
remain, as do mode/setValue/Undo/Redo/theme-message and final clean-save checks.
In particular, the trailing keyboard consumer is inside the count window; zero
work is not asserted merely by omitting the consumer. Runtime success and caret
retention through that Find read remain unclaimed until the next relay.

Static audit now scans **all** click/hover/dblclick/tap/dragTo/dispatchEvent,
mouse.* and XTEST clickWithModifier call patterns, including in-page evaluation:
zero remain in `caret-link-lifecycle.spec.ts`. The only focus call is the verified
root setup. `scrollIntoViewIfNeeded` is layout setup, not pointer dispatch.
Audit: `tmp/task578-cp3-checks/relay4-all-pointer-audit.json`; exact change:
`lifecycle-keyboard-relay4.diff`. Pointer acceptance remains in the unchanged
`ir-click-index.spec.ts` matrix, which still requires its three runs.

**Cleanup and checks.** Removed `caret-panel-geometry.tmp.spec.ts` from both
candidate and pre-task archive, and removed the comparison branch from the relay
runner. Passing comparison logs/artifacts remain retained. The next command must
omit VMDE_COMPARE_PANEL; do not rerun the completed comparison or any passing
Chromium/unit/coverage stage. Targeted Biome exit 0; focused discovery exit 0
(one lifecycle case); spec typecheck exit 1 only for the known checkbox TS2339;
complete pointer audit, temporary-file absence checks, runner `bash -n` and
`git diff --check` exit 0. Logs: `lifecycle-keyboard-types.log` and
`lifecycle-keyboard-list.log` in the check folder.

No product/build input, generated output, task index, protected queue or git
metadata changed. Reuse the Part C build. No Task 578 caret/shared-state or
serializer-parity defect has been established. The confirmed pre-existing native
panel pointer obstruction is recorded as a residual, not a fix in this task.
The corrected keyboard lifecycle, counts and requested real regressions remain
pending; no commit request or whole-task closure is made.

Relay-4 response `jev_gate` was attempted with the exact keyboard-route diff
(6,637 characters), complete pointer audit, paired geometry evidence, real
failure/static logs and the production Find/mode paths. It again returned the
approval-policy denial; no verdict exists. Payload:
`tmp/task578-cp3-checks/jev-relay4-gate.json`. Final whitespace/syntax checks pass.

### Checkpoint 3 relay 5 — separate Find diagnosis and audit the whole lifecycle (2026-09-27)

Read the complete `20260927-200846-578-cp3-relay5/brief.md` and full lifecycle
log. Exit 1 / 28.3 s, **before the first IR arrow phase**: the Find widget became
visible, but its input stayed inactive for the 20 s assertion. No counts or
regressions ran. Preserved `lifecycle-relay5.log` / `lifecycle-relay5-results/`.
The log lacks the active element, document/iframe focus state and the focus
writer, so it does not yet distinguish a product focus defect from a setup
artifact. No baseline or Task 578 attribution is claimed from that log.

**Find focus diagnosis remains mandatory and independent.** The Find UI/source
tracker, focus restore, caret authority, source index, host Find command and
panel-config controller all compare byte-identically with pre-task `d56ca040`.
That is scope evidence, not runtime proof. Two identical temporary diagnostic
cases are prepared in candidate and the already-built pre-task archive:
`caret-find-focus.tmp.spec.ts`, gated @probe/VMDE_PROBES and VMDE_XTEST. Each
uses the original small fixture and a fresh VS Code test boot. One reproduces
DOM-only editor focus before Ctrl+F; the other uses the existing Task 196
real-click focus setup before the same chord. Neither manually focuses Find.

The transparent, bounded init probe records focus/selection calls and their
`main.js:line:column` stack frames, focusin/out and trusted input events, plus
inner document focus, active element, selected-node metadata and outer workbox
focus. It emits no fixture text or input values. Both routes retain visible
Find and host-source checks; Find-focus outcomes are reported as diagnostics,
not silently marked acceptance passes. The relay records each route on both
products. It stops for review if the failed route is not reproduced equally or
if the real-click Find control does not pass on both products. A Task 578-only
focus failure must return to Part 1, not be patched here. Temporary probes must
be removed after attribution and before commit. Both product builds are reused.

**Find is no longer the source-index probe.** No direct shared-index read hook is
exposed by the existing runtime: the window surface provides build/snapshot
counters, while `SourceBlockIndexHandle` remains local to finish-init. Details
is not a reliable cold reader for a collapsed caret: its warm state can return
`disabled` without building. Adding a new product handle/contract is unnecessary.

The lifecycle now invokes the **existing block-handle consumer as an explicitly
synthetic cache diagnostic**: a buttons=0 bubbling mousemove on a current source
paragraph reaches the document's existing hover handler, which calls index.peek
and, if cold, readWhenReady. A source-owned, shown handle confirms a successful
unit lookup. The probe checks that the exact selection endpoints and active
element are unchanged. It is not a claim of physical hover/pointer accessibility;
native panel hit-testing is intentionally outside a diagnostic event dispatch.
Actual pointer acceptance remains in the three requested ir-click-index runs.
The warm-up is outside the count window; the trailing diagnostic is inside it,
so a pending invalidation must still pay its build and fail the original 0/0/0
gate. The existing generic work-counter installer retains its historical
`find-replace-probe.ts` name, but the lifecycle opens no Find widget, sends no
Ctrl+F and depends on no Find/Replace shortcut policy. All Task 578 caret, paint,
source, history and work-count assertions remain. Find's input-focus contract
remains asserted in the existing Task 196 regression spec and is separately
investigated above; removing our coupled probe does not waive it.

**Whole-journey assumption audit and corrections (source-grounded, runtime pending):**

| Step | Input route | Expected focus/selection and proof |
| --- | --- | --- |
| Open/init | host openWith, router/editor-epoch/IR readiness | no focus assumed until the live IR editor exists |
| Initial real focus | one Playwright click on authored IR plain text, before any WYSIWYG mode | WYSIWYG is hidden; exposed point passes hit-test/actionability; active editable PRE and document.hasFocus=true |
| Per-phase setup | explicit DOM root focus precondition | one active root, toBeFocused and document.hasFocus=true |
| Seed target boundary | existing __vmdeRequestCaret bridge | authoritative collapsed boundary before target; no caret class yet |
| Warm cache after boundary settlement | synthetic block-handle read diagnostic | same active element and exact Selection endpoints; source-owned handle |
| Enter each link shape | fresh trusted XTEST ArrowRight | key sequence advances with target inside editor; actual caret enters target; class and solid outline paint |
| Trailing index consumer | same synthetic read inside armed window | focus/selection unchanged; 0 builds/getValue/root Lute and unchanged source/history lengths |
| Mode round-trip | XTEST Ctrl+Alt+7/8, native Vditor mode branch | ready new mode, focused new PRE, real document focus; decoration matches live selection before reseeding |
| Host setValue | real host WorkspaceEdit | actual setValue counted; source arrives; editor focus and selection decoration checked before reseeding |
| Edit link | XTEST x after verified entry | active PRE retained; changed host bytes |
| Undo/Redo/Undo | XTEST Ctrl+Z/Y/Z | exact host bytes for each state, focused PRE and decoration matching restored selection after each operation |
| Theme switches | real workbench setting updates | actual config-changed with the requested themeKind; body kind/class, focused PRE and expected link outline width |
| Save | host save command | exact host/disk bytes and clean document |

Two additional risks were corrected in this pass. A bare Range after setValue
or Undo can be overwritten by the caret authority's still-live restoration
intent; boundary setup now uses the **existing** __vmdeRequestCaret bridge,
which binds the intended boundary until the trusted ArrowRight invalidates it.
The native restoration is checked before any reseeding, so this does not replace
or mask the mode/history decoration assertion. Arrow delivery is independently
verified by a fresh trusted keydown sequence targeting the active editor.

The theme expectation was wrong: the current host's onDidChangeActiveColorTheme
calls PanelConfigController.postLiveConfig(), which emits **config-changed**
with theme/themeKind, not set-theme. The new listener and assertion check that
actual message and exact requested kind, retaining computed paint and caret
checks. High-contrast theme IDs were checked in the shipped test VS Code theme
manifest. This corrects the unexecuted test oracle; no theme product code changed.

The initial real focus click is confined to IR and uses the already-proven
plain suffix of the authored code-reference paragraph. It asserts that WYSIWYG
is hidden and the chosen point hits its intended paragraph. There are no link
hovers, mode-menu clicks or pointer actions while WYSIWYG panels can be open.
The synthetic mousemove is clearly separated as a non-input cache probe; it
neither changes focus/selection nor bypasses any physical-pointer acceptance
assertion in the click matrix. Full static audit/step list is retained in
`tmp/task578-cp3-checks/relay5-lifecycle-assumptions.json`.

**Checks and next relay.** Targeted Biome on both specs exits 0 (an intermediate
format-only indentation error in the temporary probe was corrected); focused
VMDE_XTEST=1/VMDE_PROBES=1 discovery exits 0 (two diagnostic cases plus lifecycle);
spec typecheck retains only known checkbox TS2339. Current and baseline probe
copies are byte-identical. No product source/build input changed; hashes remain
Part C `8687380d...fa2966e` and baseline `c1fb62d1...7bbea61c`. No passing Chromium,
unit, coverage, quality or build command was repeated.

With VMDE_FIND_FOCUS_COMPARE=1, the serial relay first runs both focus routes on
baseline and candidate and saves find-focus-comparison.json plus full traces.
Only an equally reproduced failed route with passing real-click controls allows
the corrected lifecycle/count/regression sequence to continue automatically.
Otherwise return the diagnostic evidence for attribution before any further
acceptance. Find-focus classification, the new diagnostic cache route and the
remaining lifecycle stages are **not yet verified**. No Task 578 design defect,
commit readiness or whole-task closure is claimed.

Final static checks use `lifecycle-assumptions-final-types.log` (only known
checkbox TS2339) and `lifecycle-assumptions-final-list.log` (three cases).
The warm diagnostic now runs after boundary/marker settlement, before arming
work counters. An exact-token theme regex check passes both its positive HC
case and negative HC-light case. Final Jev was attempted with the updated diff,
full candidate, focus-attribution probe, production paths and real check logs;
approval policy `never` blocked it, so no verdict exists. Payload:
`tmp/task578-cp3-checks/jev-relay5-gate.json`. Final whitespace and runner syntax
checks pass. The Find-focus temporary probe remains explicitly pending cleanup.

### Checkpoint 3 relay 6 — Find loss unreproduced; retire the diagnostic guard (2026-09-27)

Read the complete `20260927-205200-578-cp3-relay6/brief.md`, the outer relay
transcript, both diagnostic logs, comparison JSON and the four trace artifacts.
Baseline and candidate each exited 0: **two probes passed**, 18.5 s / 18.4 s.
Both DOM-focus and real-click routes on both products show active Find input,
real document focus and unchanged host source. All four sampled states in each
route retain Find focus. DOM-focus traces have three events; real-click traces
have one; none were dropped. Each contains a focus call targeting the Find input,
with no sampled loss afterward. Full traces and source-map frame locations remain
in `find-focus-baseline-results/` and `find-focus-candidate-results/`.

`find-focus-comparison.json` reports matched=true, realInputControlPasses=true,
failedRouteReproduced=false. The overall relay exited 1 **only because the guard
required reproduction of the old failed route**. Lifecycle, counts and
regressions did not run. The still-present `lifecycle.log` belongs to relay 5;
it is not a fresh failure from this relay.

The earlier Find-focus failure is retained as an **unreproduced, route-specific
observation**. This evidence does not establish a product defect, a Task 578
regression, a fix, or a definitive test-artifact mechanism. Per the explicit
orchestrator direction, do not spend further relays attributing it. This
supersedes the preceding section's mandatory-attribution/guard requirement.
Find's normal contract remains covered by the requested existing regression
spec; the lifecycle already has no Find UI/shortcut dependency.

Removed `caret-find-focus.tmp.spec.ts` from both candidate and pre-task archive
and removed VMDE_FIND_FOCUS_COMPARE and its invocation from the acceptance runner.
Retained a source copy at ignored `tmp/task578-cp3-checks/find-focus-probe-source.ts`
and a compact evidence summary at `find-focus-relay6-summary.json`. Full logs,
comparison JSON and all traces are preserved. Lifecycle/test/product inputs are
otherwise unchanged, so no build, unit, coverage, Chromium, typecheck or passing
runtime command is repeated for this cleanup.

Cleanup assertions (both temporary copies absent, guard absent), runner
`bash -n` and `git diff --check` exit 0. The next relay is again only lifecycle,
three matched count invocations and the seven requested real-VS-Code regression
specs, serially with workers=1/retries=0 and the same verified Part C build.
No new product design question is established. Existing native-panel obstruction
and the unreproduced Find observation remain explicit residuals. Task/commit
closure remains pending the required runtime results; task index, protected
queue files, product/generated files and git metadata are unchanged.

Relay-6 cleanup/status `jev_gate` was attempted against the actual comparison,
trace summaries, logs and authorized cleanup. Approval policy `never` blocked
it; no verdict exists. Payload: `tmp/task578-cp3-checks/jev-relay6-gate.json`.
Final whitespace check passed; no implementation or runtime assertion changed.

### Checkpoint 3 relay 7 — repair recorder scope; required acceptance runs first (2026-09-27)

Read the entire `20260927-205601-578-cp3-relay7/brief.md` and full lifecycle log.
Exit 1, lifecycle 6.8 s, before the first arrow-result row. The matcher received
undefined for __caretKeySequence. This is an instrumentation failure, not a
measured caret/source/history failure. Counts and regressions again did not run;
the prior ordering was wrong for an optional extension. Failed evidence is
preserved as `lifecycle-relay7.log` / `lifecycle-relay7-results/`.

**Recorder inspection and correction.** No VMDE_PROBES or other environment
switch controls its installation. Previously a context-wide addInitScript bound
a **document** key listener before the VMDE document was ready, and the counter
was created lazily only when that listener observed a key. An undefined value
means the read had no initialized event state; the log alone cannot prove
whether early document lifecycle or propagation prevented observation. It does
not establish a product input defect or a particular wrong-frame mechanism.

The existing metrics object still initializes early for build instrumentation.
Key and theme listeners now install separately through the **actual ready VMDE
frame** after router/editor-epoch/IR readiness. The installer initializes
sequence=0, lastKey=null and the theme array, uses **window capture** before
application document-capture handlers, and returns a checked handshake:
sequence=0 and editor.ownerDocument===document. Every arrow phase checks the
counter is an integer and polls for a fresh sequence advance before checking
trusted ArrowRight delivery into the editor. This removes the undefined matcher
path and the unverified early-document listener dependency. No environment flag
or fallback that pretends a key arrived was added. Core acceptance assertions
and the generic cache probe remain unchanged.

**Focused infrastructure proof (not OS acceptance).** Executed the actual
installer extracted from the spec in jsdom. It initializes numeric state in the
owning document, observes an event before a document capture handler calls
stopImmediatePropagation, keeps observing after editor root innerHTML replacement,
and records a config-changed theme message. The synthetic event remains
trusted=false; the real spec still requires trusted=true. Command:
`node tmp/task578-cp3-checks/check-lifecycle-observers.cjs`, exit 0. Result:
`lifecycle-observers-smoke.json` in the same check folder. This tests recorder
binding/initialization only; it is not proof of real VS Code key delivery.

**Relay dependency correction.** `vscode-relay.sh` now runs:
1. counts-1, counts-2, counts-3, serially; a failing required count run stops;
2. the seven required regression specs, recording their exit;
3. the optional lifecycle spec last, recording its separate exit even if
   regressions failed.

`relay-status.tsv` is cleared per invocation and records every completed stage.
The final console summary separates required counts/regressions from optional
lifecycle. The overall script remains nonzero if either latter stage fails;
that status must not be misreported as a count failure. Optional lifecycle
failure cannot prevent any required count or regression run.

Ran the actual orchestration tail with npm stubbed in isolated temporary output
directories: optional failure left all required stages completed; regression
failure still ran lifecycle; required count failure stopped as intended. All
three control-flow scenarios passed (exit 0 for the smoke driver). Artifact:
`relay-flow-smoke.json`, explicitly labelled shell-only simulation. No VS Code
process was launched and none of these simulated statuses are runtime evidence.

Other checks: targeted Biome exit 0; `npm run typecheck:vscode-e2e` exit 1 only
for the known checkbox TS2339; focused VMDE_XTEST=1 discovery exit 0, one lifecycle
case; runner syntax and diff whitespace checks exit 0. Logs:
`lifecycle-live-observer-types.log` and `lifecycle-live-observer-list.log`.
No passing Chromium, unit, coverage, quality or build stage was repeated.
Product/generated files, task index, protected queue files and git metadata are
unchanged. Reuse the Part C build.

**Explicit scope/closure direction from this dispatch:** if the next optional
lifecycle attempt again fails for a test-infrastructure reason, do not spend
another relay on it. Record OS arrow entry/restoration/theme routing as unmeasured
residuals to the extent not established by retained evidence, keep or drop the
spec on its merits, and proceed toward closure on the required counts,
regressions and exact-source items. Do not turn those residuals into claimed
passes or commit an unexplained failing default test. A measured Task 578
product defect remains a separate design-feedback matter; no such defect is
established by this counter failure. Task and commit remain open pending the
required runtime evidence.

Relay-7 final `jev_gate` was attempted with the exact recorder diff, required-first
runner, actual failed log, instrumentation/control-flow smoke evidence and static
check outputs. Approval policy `never` blocked it; no verdict exists. Payload:
`tmp/task578-cp3-checks/jev-relay7-gate.json`. Final whitespace check passed.

### Checkpoint 3 resume — three count runs accepted; resume only unfinished checks (2026-09-27)

Read the complete `20260927-214059-578-cp3-resume/brief.md`. Reconfirmed dev at
`ede2c686`, the unchanged scoped CP3 working tree and reusable 899,650 B Part C
bundle SHA-256 `8687380dbfd4c367890f58a25c8f75462abb6ba3fb5e19015f6b50553fa2966e`.
The owner pause interrupted the regression invocation after all three counts
completed. Per the dispatch, **the killed regressions.log/results provide no
acceptance evidence**, including their partial cases. The latest optional
lifecycle recorder fix has not run. No completed count run is repeated.

**Count evidence extracted and reconciled.** Each command
`npm --prefix test/vscode-e2e test -- ir-click-index.spec.ts --workers=1 --retries=0`
ran serially in the verified XTEST shell, exited 0 and reported one passed
(2.1 min). `relay-status.tsv` contains counts-1, counts-2 and counts-3, each 0.
Parsed all three explicit ir-click-index-evidence.json artifacts and cross-checked
every completed phase object against its full log. Each run has 42 measured
phases (20 IR / 22 WYSIWYG), six explicit optional absences, zero unavailable
targets and complete=true. Phase keys and order match all 42 rows in the recorded
Checkpoint 1 clean baseline. **All 126 measured observations** are warm,
source-identical, history-identical and instrumented, with zero builds / full
getValue / root Lute / fragment Lute and zero admitted mutation records.

The before column below is the recorded single Checkpoint 1 clean relay-5 run
at `83fbfd3e`; this is not a three-run pre-fix timing distribution. B/G/R/F =
index builds / full getValue / root Lute / fragment Lute.

| Phase | Before B/G/R/F | Before longest task ms | After B/G/R/F, each of runs 1–3 | After longest task ms, runs 1 / 2 / 3 |
| --- | --- | --- | --- | --- |
| ir/plain/1 | 1/1/2/122 | 767 | 0/0/0/0 | 0 / 0 / 0 |
| ir/table/1 | 1/1/2/122 | 617 | 0/0/0/0 | 0 / 0 / 0 |
| ir/table/2 | 1/1/2/122 | 632 | 0/0/0/0 | 0 / 0 / 0 |
| ir/link/1 | 1/5/8/244 | 1,022 | 0/0/0/0 | 0 / 0 / 0 |
| ir/link/2 | 1/5/8/244 | 924 | 0/0/0/0 | 0 / 0 / 0 |
| wysiwyg/link/1 | 1/1/2/122 | 583 | 0/0/0/0 | 0 / 0 / 0 |
| wysiwyg/post-link-plain/1 | 1/1/2/122 | 586 | 0/0/0/0 | 0 / 0 / 0 |
| wysiwyg/bold/2 | 0/0/0/0 | 0 | 0/0/0/0 | 50 / 0 / 0 |
| All other 34 matched phases | 0/0/0/0 | 0 | 0/0/0/0 | 0 / 0 / 0 |

Run maxima are **50 / 0 / 0 ms**. The single 50 ms WYSIWYG bold task is retained
as an unattributed timing observation; its work counts remain zero. Zero here
means no browser long-task entry was observed, not zero end-to-end click latency.
Times are reporting-only; observation windows include deliberate settle waits.

Every source pre/post identity object and native-history pre/post object compares
equal within every phase. The history proof includes undo/redo patch contents
and lastText hashes, not only stack depths. All three final host states are
found=true, dirty=false, version=1. Host/disk bytes equal the original fixture:
174,527 UTF-8 bytes (174,517 UTF-16 code units), SHA-256
`a4a39d6f6c605eb82b0e03a236f67388bceeae9a85450b0d4285053b28299f65`.
Editor serialization is unchanged from its per-mode baseline; as already
recorded in CP1, normalized rendered Markdown is not asserted equal to the
original noncanonical file. Optional absences remain IR HTML-inline offsets
1–2 (no painted eligible target) and math/diagram offsets 1–2 in both modes
(no DOM candidates). No required target was missing.

Full logs/results: `tmp/task578-cp3-checks/counts-{1,2,3}.log` and the corresponding
`counts-{1,2,3}-results/`. Complete matched before/after rows, source/history checks,
artifact paths and SHA-256 values are retained in
`tmp/task578-cp3-checks/three-count-runs-summary.json`. Extraction/reconciliation
exited 0. The preserved status file SHA-256 is
`044bf716f00458164e5714d03c91e0748b84888046333fcd86404d8e6f0788a3`.

**Resume runner.** `vscode-relay.sh` now verifies the existing count statuses and
reuses them; it contains no count invocation. It keeps the build-hash check,
Openbox, XTEST preflight, serial workers=1/retries=0, required regressions first
and optional lifecycle second, with independent exit reporting. Each invocation
creates a unique `remaining-run.XXXXXX/` directory for status.tsv, full logs,
results and preflight/WM output. It never opens the legacy relay-status.tsv for
writing and does not overwrite count artifacts or the interrupted regression
output. The script prints the fresh directory and status path for the detached
runner to return. No skip-count flag is needed: this script is now resume-only.

Runner `bash -n` and whitespace checks exit 0. A shell-only control-flow smoke
runs the actual orchestration tail with npm stubbed: zero count invocations,
regressions followed by lifecycle in all scenarios, correct independent exit
statuses, and byte-identical legacy count status afterward. The smoke driver
exits 0; result is `resume-runner-flow-smoke.json`. An initial smoke-helper
placeholder replacement corrupted its own variable name; that helper was
corrected. It did not execute VS Code or alter the actual runner/count evidence.
No accepted unit, coverage, typecheck, quality, Chromium or count test was rerun.

**Requested and observed execution settings.** The resume brief requests
GPT-6 Astra / xhigh and classifies the task Medium under the Project Owner's
assignment. The launcher run.json records model=gpt-6-astra, effort=xhigh,
sandbox=workspace-write, approval=never, codex-cli 0.157.1 and resume mode.
Its separate launcher tier field is `high`; that is recorded without changing
the task's Medium classification. The actual latest Codex turn_context
(2026-09-27T14:41:03.385Z) reports gpt-6-astra / xhigh, approval_policy=never,
workspace-write with network_access=false and the correct working directory.
These are observed session records, not inferred self-identification. Selected
non-secret settings are saved in `resume-settings.json`. Existing repository,
Jev and Caveman skills remain loaded; the new implement-work skill and its
execution-continuity reference were read for this resume. No settings changed.

**Relay-cycle reconciliation:**

| Cycle | Result actually established |
| --- | --- |
| CP3 relay 1 | Chromium 46 pass; VS Code preflight failed before specs |
| Relay 2 | Full unit/ratchet pass; lifecycle blocked at top-left WYSIWYG setup click |
| Relay 3 | Lifecycle blocked at suffix click in the same covered paragraph |
| Relay 4 | Baseline/current panel obstruction matched; lifecycle blocked at link hover |
| Relay 5 | Find-based probe input inactive; no arrow/count/regression result |
| Relay 6 | Both Find routes pass on both builds; old failure unreproduced; guard stopped lifecycle |
| Relay 7 | Lifecycle key recorder undefined; required-first ordering prepared afterward |
| Relay 8, before owner pause | Three count runs pass; regression invocation killed by owner pause; lifecycle not started |
| Current resume | Count/source/history evidence accepted and preserved; unfinished checks prepared for detached relay |

The remaining required evidence is the seven completed real-VS-Code regression
specs and their Find open/closed click phases. Keep the relative IR Find gate
until those own-phase results justify absolute zero; the interrupted run is not
used to tighten it. The optional lifecycle gets its already-authorized last
attempt; another infrastructure failure becomes explicit unmeasured residuals
under the owner direction, not another diagnostic cycle. A measured product
caret/undo/shared-state or serializer-parity defect still returns to Part 1.
Task remains open here; task index/incoming links move only at actual closure.
No commit request yet. Product/generated files, protected queues and git metadata
remain unchanged, and nothing is pushed.

### Checkpoint 3 relay 9 — completed regressions, one required failure (2026-09-27)

The `20260927-220906-578-cp3-relay8` dispatch returns the resumed command's
fresh `tmp/task578-cp3-checks/remaining-run.G1oKXO/` results. Its `status.tsv`
records regressions=1 and lifecycle=1 (overall exit 1); the orchestrator reports
no leftover Xvfb/VS Code process. This is distinct from the owner-killed partial
regression run, which remains excluded. No count run was repeated.

**Required regressions: 25 passed, one failed, 6.5 min, workers=1/retries=0.**
Block-handle 13/13, Details toolbar 1/1, selection-bubble 4/4,
large-document-interaction 4/4, Find 2/2 and large Find 1/1 pass. These results
cover the actual XTEST keyboard adapters added in CP3; their assertions remain
intact. Only `selection-performance.spec.ts:471` fails, at the forward/nonempty
selection aggregate (line 985). Its 17-row report identifies exactly one
non-hover failure:

| Mode / phase | Selection | Details / bubble | Build / getValue / root / fragment | Host / disk |
| --- | --- | --- | --- | --- |
| WYSIWYG / large / cold drag | length 0, forward=false | disabled / hidden | 0 / 0 / 0 / 0 | both unchanged |

This phase follows the IR edit/Undo cold drag and a toolbar mode switch; it uses
the first top-level paragraph's box, clears the old selection, waits 100 ms,
then drags from x+6 to x+90 at y+min(height/2,12). The probe saw 14 selection
events and one Range.insertNode call, but has no pointer-target or selection
transition trace. Every reported host/disk check is true. All other non-hover
phases end in a forward nonempty selection. Work-count and source fields are
observations here: the first failed assertion prevented later gates from
executing, so this spec is **not accepted**.

The original selection spec and performance probe are byte-identical to the
pre-task `d56ca040` archive. That fact alone does not establish a baseline
failure. The prior Task 577 accepted runs and the separate small-fixture panel
comparison also do not reproduce this particular failed drag. It is therefore
neither labeled pre-existing nor flaky. A later diagnostic pass alone will not
convert the failed acceptance run into a pass.

**Find gate, supported by this completed run.** The two IR phases have different
preconditions: Find-closed has no explicit warm-index check after opening;
Find-open follows the populated search index. Recorded builds/getValue/root/
fragment counts are 1/1/2/122 closed, **0/0/0/0 open**. WYSIWYG reports the same
closed/open counts; SV is zero for both. `find-replace-large.spec.ts` now asserts
absolute zero builds/getValue/root Lute for the IR Find-open editor click,
retains the relative controls and all other gates, and corrects the obsolete
comment claiming every IR click rebuilds. No unsupported zero gate is imposed
on the cold Find-closed sample. The new assertion matches the recorded phase
object; one focused run will execute the tightened assertion itself.

**Optional lifecycle: final attempt, no further relay.** It exits 1 in 11.9 s at
`readIndexProbe` before the first IR link ArrowRight. The assertion reports
handleVisible=false with sourceOwned/focusUnchanged/selectionUnchanged=true;
the attachment is `[]`, so no arrow-entry row completed. The probe synthesized
a buttons=0 mousemove and treated a visible block handle after two animation
frames as a cache-read certificate. That is a test measurement precondition,
not an observation of arrow entry: block-handle visibility can be cleared or
geometrically hidden independently, and its aria-disabled attribute alone does
not prove a completed fresh lookup. The log does not identify which hiding
path fired. No caret-class, restoration, theme-route or serializer assertion
failed because none was reached. The required block-handle regressions pass.
This establishes failure of the optional instrument's readiness proof, not
proof of an underlying product fix or of the entire lifecycle being sound.

Under the owner's final-attempt instruction, OS arrow entry into every link
shape, caret-class restoration across mode/setValue/Undo, and real theme-message
routing are **unmeasured residuals**. The untracked draft was copied byte-for-byte
to ignored `tmp/task578-cp3-checks/lifecycle-final-unmeasured.ts` (SHA-256
`e644165847ee7d46b69cf1bf4379f9df3707b685eec51c93aa9d729de4549b94`) and removed
from spec discovery. It is not useful as a permanent regression with an
unproven cache precondition. No product code or required acceptance assertion
was removed, and no extra optional diagnostic run is requested.

**Next focused diagnosis.** `selection-attribution-relay.sh` runs the same
selection journey once on the verified pre-task archive and once on the
candidate, serially, with workers=1/retries=0. A temporary identical copy adds
bounded text-free capture of pointer targets, hit-test geometry, focus and
selection endpoints, plus forwarding Selection API wrappers with call stacks.
Original input actions, waits, measurement phases and assertions are unchanged.
Listeners/wrappers are removed at each drag's end. This instrumentation may
perturb timing, so these are diagnostic runs, not substitute acceptance.
Attachments and logs retain all six drag traces even when the final aggregate
fails. Original spec SHA-256:
`2a7f153a9108f5f30ade914fc618093f7eebfc82856ebb89c0ac7faa5a855317`.

Both product builds retain their recorded hashes. The archive's test-only XTEST
helper is aligned to the candidate's: its only prior difference was the unused
`clickWithModifier` addition; existing selection-test key methods were identical.
Original helper bytes are archived. Other imported helpers/config match exactly.
The runner verifies both builds, source/probe hashes and helper parity before
exclusive creation of temporary specs; cleanup deletes only unchanged temporary
copies. A unique `selection-compare.XXXXXX/` holds separate baseline, candidate
and focused Find-gate logs/results/status. Baseline or candidate failure does
not suppress the other's diagnostic run or Find verification. No optional
lifecycle, accepted count run, broad suite or rebuild is in this runner.

Local validation: `bash -n selection-attribution-relay.sh` exit 0; focused Biome
check of the changed Find spec exit 0; `npm run typecheck:vscode-e2e` exit 1 with
only the recorded `preview-task-checkbox.spec.ts(122,28)` TS2339 (the temporary
attribution spec was included and emitted no diagnostic). The first ignored
probe-generator attempt tripped its own occurrence-count guard before writing
any diagnostic source; the guard now locates the intended function boundary.
Extracted measurements, Find objects and residual status are retained in
`relay9-selection-measurements.json`, `relay9-summary.json`,
`selection-attribution-manifest.json` and `selection-attribution.diff`.

Required selection acceptance and the CP3 regression checkbox remain open;
no move to done/index update or commit request yet. If matched evidence exposes
a Task 578 caret/selection/shared-state or serializer-parity defect, return to
Part 1 for a design decision. Product/generated files, protected queues and git
metadata are unchanged; nothing is pushed. Final Jev review remains with the
orchestrator because the session's approval policy prevents that MCP call.

Relay preparation checks also pass: `git diff --check` exit 0; the actual runner's
stage tail, exercised with an npm shell stub, executes baseline → candidate →
Find in all four pass/fail combinations with correct independent statuses and
aggregate exit (driver exit 0, `selection-relay-flow-smoke.json`). No GUI process
runs in this smoke. Temporary specs are absent afterward; original spec/probe,
all diagnostic helpers/config and both build hashes were rechecked. The original
three-count status file remains byte-identical with its recorded SHA-256.

### Checkpoint 3 relay 10 — product selection interaction; return to Part 1 (2026-09-27)

The `20260927-222904-578-cp3-relay10` dispatch returns
`tmp/task578-cp3-checks/selection-compare.8obCZa/`: baseline=0, candidate=1,
find-gate=0; overall exit 1. Each invocation is serial, workers=1/retries=0.
Baseline diagnostic takes 1.1 min; candidate diagnostic 1.0 min; focused Find
56.9 s. The runner removed its temporary spec from both trees, and the
orchestrator verified no leftover GUI process. Both product build hashes still
match their recorded values. No counts, broad suite or optional lifecycle reran.

**Find acceptance complete.** `find-replace-large.spec.ts:73` passes with the new
absolute-zero IR Find-open click assertion executed: builds/getValue/root Lute
are all 0. Existing exact replacement/Undo/save and relative controls also pass.
This finishes the conditional Find-gate obligation, not the remaining selection
regression obligation.

**Two failures, different surfaces.** The original uninstrumented candidate
relay failed because the large cold WYSIWYG drag ended collapsed (length 0,
Details disabled, bubble hidden). The matched diagnostic does not reproduce
that exact endpoint: baseline finishes that drag at length 4, candidate at
length 2, both forward. Instead, candidate fails the 150 ms release-to-show
bound in all four small-document phases; baseline passes that bound everywhere.

| Small-document phase | Original candidate release-to-show ms | Matched baseline ms | Matched candidate ms |
| --- | --- | --- | --- |
| IR drag | 43 | 46 | 992 |
| IR slow keyboard | 0 | 0 | 623 |
| WYSIWYG drag | 33 | 33 | 995 |
| WYSIWYG slow keyboard | 0 | 0 | 650 |

All four matched candidate failures have zero index builds, full getValue and
live marker insertions before visibility; longest settle task=0 and maximum
settle rAF gap=17 ms. Candidate large drags show in 33–48 ms. Thus the observed
small-control failure is not the old whole-document-build-before-paint mechanism.
The spec's own 500 ms post-work observation wait also stretches: total observed
minus workload is 991 ms for IR small drag and 1,025 ms for WYSIWYG small drag,
versus baseline 536/544 ms. That suggests a scheduling/dispatch issue but does
not establish timer throttling or a harness defect: timer dispatch and document
visibility were not recorded. The measurement cannot justify weakening the
latency bound or adding a sleep. All 17 host/disk identity observations remain
true on both builds; no serializer-parity failure is observed.

**Concrete selection writer, verified through both existing source maps.**
The large cold WYSIWYG traces show every initial hit-test point and every
pointer target inside the intended paragraph. No panel intercepts those two
diagnostic gestures. A primary-button drag grows a native selection, but
product JavaScript repeatedly replaces it with earlier endpoints while the
pointer is still held:

- Baseline: eight `Selection.setBaseAndExtent` calls, from 386.6 to 970.0 ms
  after trace start. Native lengths 5,6,7,8,9,10,10,11 are each reset to 4.
  Pointerup is at 983.3 ms.
- Candidate: nine calls, from 368.5 to 1,035.4 ms. Native lengths
  4,5,6,7,8,9,10,10,11 are each reset to 2. Pointerup is at 1,053.6 ms.
- Both stacks map to `editing/caret.ts:303` (`tryPlace` writes the directional
  selection) from `editing/caret.ts:384` (`tick`). These are product calls,
  not the probe's setup or a test-written Range. The diagnostic wrapper only
  records and forwards the original Selection arguments.

The caret authority's documented contract at `caret.ts:438–466` invalidates a
live intent on pointerdown. A snapshot/restore can nevertheless re-arm it later
in the held gesture. The existing `patchUndoCaretSplitRestore` at
`media-src/esbuild-shared.mjs:289–334` captures directional endpoints and passes
them to `__vmdeRequestCaret`; Vditor `Undo.addToUndoStack` invokes `addCaret`
before even determining whether a new history patch exists. The observed text
node split and one Range.insertNode are consistent with that path. **The actual
re-arming caller was not captured**, so native Undo is a supported hypothesis,
not a fully attributed cause. The later authority rewrites themselves are
confirmed. A zero-length snapshot would plausibly explain the original collapsed
result, but that run has no trace proving this was its cause.

Baseline also exhibits the held-drag overwrite (and its small IR drag resets
13 characters back to 3). The aggregate nonempty/forward assertion permits that
truncation to pass. A passing baseline aggregate therefore does not prove
normal native extension. Conversely, this shared behavior alone does not prove
that the candidate's length-zero failure is pre-existing.

**Relationship to the three Task 578 changes.**

| Change | Relevant path and current attribution strength |
| --- | --- |
| A: IR table panel moved outside source root | Removes an IR click mutation/build and can change the timing of the preceding IR journey. The panel stays in the IR pane; diagnostic WYSIWYG drag points hit the intended paragraph. No direct WYSIWYG selection writer is added. A timing interaction remains possible, unisolated. |
| B: shared-index link-popover binding | Changed owner construction rejects non-IR mode. The prior IR paragraph includes a link and can exercise the changed path, so earlier scheduling/source-state effects remain possible. It cannot directly explain a plain small WYSIWYG drag through that owner path. |
| C: caret attribute becomes class | It changes presentation mutation/index invalidation for link-like caret targets in both modes; that is a plausible shared-state/timing influence in the large linked paragraph. The small fixture has no link-like targets, so its four timing failures have no demonstrated direct caret-class trigger. |

`caret.ts`, `selection-bubble.ts`, the Undo source patch, the required selection
spec and its probe are unchanged across `d56ca040..ede2c686`. This narrows the
writer's ownership but does not rule out a timing interaction caused by A/B/C.
No single-component counterfactual has been run. Attribution is therefore:
**high confidence that a product selection-restoration interaction occurs during
held drags on both builds; insufficient evidence to assign the two failed
acceptance symptoms to A, B or C, or to call either failure test-side.** Per the
owner's instruction, treat the candidate as regressed until resolved. A later
pass alone will not clear these failures.

**Part 1 design question / stopping boundary.** How should CP3 proceed with
this in-gesture caret-restoration interaction and the separate unresolved
small-document settle delays? Recommended next decision: a bounded Part 1
investigation that identifies the caller re-arming the caret intent during the
held drag and the source of the small-webview timer/dispatch delay, with
component isolation if needed, before choosing any product change or determining
whether a separate baseline issue owns it. This is not an implementation plan
or authorization to change caret/Undo policy. The dispatch explicitly requires
Part 2 to stop on a product caret/selection/shared-state interaction; no supported
test-only repair is available from these logs. No retry, test weakening,
product redesign or commit is requested here.

**Evidence and local checks.** Text-free extracted rows, all latency failures,
rewrites, mapped stack positions, Find results and log/build/map SHA-256 values
are in `tmp/task578-cp3-checks/relay10-attribution-summary.json`; focused cold-drag
traces are `relay10-{baseline,candidate}-cold-wysiwyg-drag.json`. Full logs and
JSON attachments remain in `selection-compare.8obCZa/`. Summary extraction and
source-map reconciliation exit 0. Its first local extraction attempt used a
non-limited delimiter split and failed before producing the summary; prefix
slicing corrected that helper (no input evidence changed). No runtime check was
rerun during this diagnostic reading. Only this task record is changed this
turn; ignored diagnostic reports were added. Required selection and final
closure remain unchecked; task/index stay in place. Optional lifecycle residuals
and previously accepted checks remain as recorded. Product/generated files,
protected queues and git metadata are untouched; nothing is pushed.

### Checkpoint 3 — accepted Part 1 handoff and E1–E3 preparation (2026-09-27)

The `20260927-223938-578-cp3-part1-exp` brief resolves the design question:
**stay inside Task 578 for attribution only; no product change and no caret/Undo
policy change.** The orchestrator accepts the handoff from Claude Opus 5.5,
general-purpose subagent `a8f2bfb1334cb88a3`, as the next Part 2 plan.
**Requested Part 1 effort: high; effective effort: medium.** The handoff states
that no agent definition had an `effort:` key and the Agent tool had no effort
option. These are the Part 1 owner's reported settings, not an assertion that
its request took effect. Part 2 remains the assigned Astra session; no model or
session setting was changed. The complete handoff is preserved at ignored
`tmp/task578-cp3-checks/part1-selection-handoff.md`, with source path/hash and
settings in `part1-handoff-provenance.json`.

**Part 1 assessment, hypotheses rather than new acceptance evidence:**

- Small-document delays are estimated ~80% likely to be environment timer
  throttling: 32 ms bubble and 500 ms observation timers were late while rAF
  remained prompt and no long task or source build explained the gap. Short
  task flooding is not yet excluded. A/B/C add no timers/rAF/observers or
  selection writes (A adds a passive scroll listener); the small fixture has
  no link-like targets for C, and B rejects non-IR ownership.
- Held-drag restoration is estimated ~85% likely to be a pre-existing mechanism,
  ~70% likely to originate in the pending afterRender/process Undo timer. The
  proposed chain is mode rendering → delayed addToUndoStack → addCaret →
  patched `__vmdeRequestCaret` → repeated authority writes after pointerdown.
  WYSIWYG can use 2,000 ms undoDelay for the large fixture; ordinary/IR uses
  800 ms. These estimates do not supersede the pending experimental proof.

**Authorized experiments and interpretation:**

1. E1, diagnostic copy: at release, bubble show and stop record document
   visibility/focus plus timer-0, timer-32, MessageChannel and rAF latency.
   Timers at least 500 ms late with prompt MessageChannel/rAF support environment
   throttling; MessageChannel also late supports queue flooding. Hidden or
   unfocused measured phases are environment failures. Candidate-only flooding
   would require Task 578 attribution.
2. E2: run the unchanged required test B,C,B,C,B,C. Candidate-only ~1 s latency
   in at least two of three, with zero of three baseline, implicates Task 578
   and triggers E4. Both builds or rare timing failures support environment
   classification under the handoff, with E1 still needed for recurring failures.
   A length-zero drag on either build is evidence of the pre-existing race.
3. E3, same diagnostic copy as E1: timestamp/stack the caret bridge and
   addToUndoStack, observe timer-ID assignments, and connect timer firing →
   Undo → requestCaret to the first overwrite between pointerdown and pointerup.
   A different caller, particularly an A/B/C path, reopens attribution.
4. E4 is conditional on E2 implicating Task 578: single-component scratch-copy
   counterfactuals. It is **not** prepared or run prematurely, and neither
   verified build is rebuilt.

**Acceptance remains strict.** The unchanged required test must pass in three
consecutive serial candidate observations with visible/focused environment
health recorded or checked. A throttled run is invalid, not a pass; rerun only
after addressing its environment. A collapsed drag with an E3-confirmed Undo
re-arm also observed on baseline remains a pre-existing defect requiring the
Project Owner's decision, never an implicit waiver. The handoff's owner choices
are: (1) separate task, close Task 578's selection gate on clean repeat runs;
(2) expand Task 578; or (3) separate task plus a pending-timer setup wait, only
with explicit Owner confirmation that this does not weaken acceptance. None of
those remedies is implemented here. If the pre-existing defect blocks
acceptance, return that question; do not close the task.

**Prepared relay: eight invocations, no automatic retries.** Order is E13-B,
E13-C, then E2-B1,C1,B2,C2,B3,C3, each workers=1/retries=0. Combining E1 and E3
uses one instrumented journey per build; six unchanged journeys supply the
requested alternating repetitions. No accepted Find/count/Chromium/unit check
or optional lifecycle is in this runner.

`part1-experiments-relay.sh` creates a fresh `part1-experiments.XXXXXX/` for logs,
status, preflights, attachments and the exact manifest. Both product hashes and
the unchanged required-spec hash are checked before every invocation. Temporary
files are exclusively created and recorded as owned; cleanup removes only owned,
hash-identical copies. A pre-existing or changed file is never overwritten or
deleted. The baseline and candidate use identical test helpers/config. A test
failure is preserved and does not suppress the paired/repeat evidence; input
hash drift aborts the runner. Original count status/artifacts are never opened
for writing. Openbox and XTEST preflight follow the previously verified pattern.

**Health without changing the required test.** E2's tiny temporary wrapper
imports runner-owned health hooks and then imports the original
`selection-performance.spec.ts` byte-for-byte (SHA-256 remains
`2a7f153a9108f5f30ade914fc618093f7eebfc82856ebb89c0ac7faa5a855317`). Discovery
resolves exactly the original `selection-performance.spec.ts:471` test. The
before-test hook runs after that invocation's BrowserWindow exists, before its
journey: it verifies/activates the exact mapped XTEST client and asserts native
visibility/focus, not-minimized state and matching X11 active/focus IDs. The
same native state is checked after the test without refocusing it. Passive
frame-health listeners retain visibility/focus changes and first interaction
across recreated documents, including frames later closed; they do not patch
product APIs or change input. Health is written to the log and an attachment.
E2 has no new waits, API wrappers, changed workload, assertion, or phase.

**E1/E3 mechanics and limits.** The ready-frame diagnostic installer observes
IR processTimeoutId and WYSIWYG afterRenderTimeoutId assignments and timer fires;
forwarding wrappers retain timeout arguments/callback receiver, Undo receiver/
arguments/results and caret bridge behavior. Existing pending timers at install
are explicitly marked armed-at-unknown-time; subsequent mode-switch arms have
schedule time, delay and stack. Undo nesting and active timer IDs connect the
caller chain; Selection API calls while the primary pointer is held identify
subsequent overwrites. E1 sends 0/32 ms timers, a MessageChannel ping and rAF at
release/show/stop, with phase/armed identity and visibility/focus at send/receive.
The probe stores only lengths, offsets, node kinds, timings and stacks, never
fixture text or markup. Events are capped and any dropped count is reported.

The diagnostic copy preserves the original journey and assertions. It drains
only the already-issued sentinels after the original measured probe stops, then
attaches the report before moving on. Those measurements and forwarding wrappers
can alter scheduling, so E13 remains diagnostic and cannot substitute for E2.
No arbitrary sleep, pending-Undo wait, threshold relaxation or product fix was
added. Instrumentation dies with the diagnostic document/process; required runs
start fresh without it.

**Local verification actually run:**

- Script syntax and Python compilation exit 0. Actual temporary-file installer,
  per-run verifier and ownership/hash-limited cleanup each exit 0; no temporary
  spec/helper remains in either tree after validation.
- Individual Playwright `--list --workers=1 --retries=0` discovery exits 0 for
  E2 (one original `:471` test) and E13 (one copied test); no VS Code launched.
- `npm run typecheck:vscode-e2e` with all four temporary sources included exits
  1 only at the established checkbox-spec TS2339; no experiment diagnostic.
- A deterministic recorder smoke exits 0 for prompt scheduling, late timers
  with prompt MessageChannel/rAF, and a delayed queue. It proves sentinel fields,
  timer→Undo→caret correlation and argument/result forwarding. It is not real
  browser, OS-input or acceptance evidence. The first smoke-driver draft had a
  missing object brace; it was corrected before running any experiment.
- The actual runner's stage tail with npm/preflight stubs exits 0 as a driver
  across five failure scenarios, retaining all eight calls in the correct order
  and independent statuses, with correct aggregate exit and unchanged count
  status. It launches no GUI.

Sources, manifest, diagnostic diff and verification reports are under
`tmp/task578-cp3-checks/`: `experiment-*-source.ts`,
`experiment-required-wrapper.ts`, `experiment-diagnostic.diff`,
`part1-experiment-manifest.json`, `part1-instrumentation-smoke.json`,
`part1-runner-flow-smoke.json` and discovery/typecheck logs. The prepared runner
has not been relayed yet. Only this task record and ignored diagnostic tooling
changed in this step. CP3 remains open; no done move, index edit or commit request
until the acceptance rules are satisfied. Product/generated files, protected
queues and git metadata remain unchanged; nothing is pushed.

### Checkpoint 3 relay 12 — pre-existing Undo-timer race confirmed; owner decision required (2026-09-27)

Dispatch `20260927-230315-578-cp3-relay12` returns the verbatim Part 1 experiment
runner results in `tmp/task578-cp3-checks/part1-experiments.Z8YQJ5/` (console
`578-cp3-vscode11.log`). All eight serial workers=1/retries=0 invocations finish;
overall exit 1. Cleanup removed all temporary specs/helpers from both trees.
The orchestrator reports no leftover Xvfb/VS Code process. No product source,
verified build, accepted count test or optional lifecycle was changed/rerun.

| Invocation | Exit / outcome | Failed phase | Maximum reported release-to-show ms |
| --- | --- | --- | --- |
| E13 baseline | 1 / fail | large WYSIWYG cold drag: length 0, forward=false | 73 |
| E13 candidate | 1 / fail | large WYSIWYG cold drag: length 0, forward=false | 95 |
| E2 baseline 1 | 1 / fail | large WYSIWYG cold drag: length 0, forward=false | 71 |
| E2 candidate 1 | 0 / pass | none | 71 |
| E2 baseline 2 | 0 / pass | none | 63 |
| E2 candidate 2 | 1 / fail | large WYSIWYG cold drag: length 0, forward=false | 46 |
| E2 baseline 3 | 0 / pass | none | 56 |
| E2 candidate 3 | 0 / pass | none | 47 |

Each failure is the nonempty/forward selection aggregate, original spec line
985 or diagnostic-copy line 994. Details is disabled and the bubble hidden for
that same failed drag. Every failed phase records one Range.insertNode. The
unchanged E2 body is the original `selection-performance.spec.ts:471`, imported
by the temporary health wrapper, not a modified test journey. Baseline and
candidate each fail one of three unchanged runs. The candidate sequence is
**pass, fail, pass**, so the required three consecutive passes are absent.
All 17 per-run host/disk identity observations are true in every invocation.
No recorded latency row exceeds 150 ms, including rows after the first failed
assertion; those later assertions did not execute in the four failing runs.
Only the four exit-0 E2 runs are reported as full passes.

**E3 confirms the proposed pre-existing caller chain on both builds.** The
failed diagnostic phase is large-document phase 15 in each log. Timer assignment
stacks map through `toolbar/EditMode.ts` → `wysiwyg/renderDomByMd.ts:17` →
`wysiwyg/afterRenderEvent.ts:15`. Its observed delay is **800 ms on both builds**;
although Part 1 noted the possible 2,000 ms large-WYSIWYG tuning, that is not the
delay actually armed in these mode-switch samples. The timer fires during the
held drag and enters addToUndoStack. The caret bridge request has undoDepth=1
and the same activeTimer ID, with a collapsed structural intent at block path
[2], offset 1. Both stacks map from `wysiwyg/afterRenderEvent.ts:40` through
patched Vditor `Undo.addToUndoStack` / `Undo.addCaret` to `__vmdeRequestCaret`.

| Event, ms relative to pointerdown | Baseline | Candidate |
| --- | --- | --- |
| WYSIWYG Undo timer armed | -748.6 | -753.6 |
| Pointerdown | 0 | 0 |
| Timer fires while primary pointer held | 366.5 | 46.8 |
| addToUndoStack entry | 366.7 | 47.0 |
| __vmdeRequestCaret entry, undoDepth=1 | 372.9 | 54.3 |
| First authority selection write | 377.9 | 59.0 |
| Pointerup | 1,573.8 | 1,153.1 |

Baseline timer ID is 1346; candidate ID is 1354. IDs are local to their documents,
not compared across runs. The snapshot starts with a collapsed selection. After
the initial restoration, later native drag movements grow it to lengths
1,2,4,5,6,7,8,9,10,10,11; every one is reset to zero before release. In each
trace there are twelve removeAllRanges/addRange pairs while held: the initial
write plus eleven subsequent resets. The later stacks map to
`media-src/src/editing/caret.ts:338` from `tick` at line 384. This is the
collapsed-intent counterpart of the noncollapsed setBaseAndExtent resets seen
in relay 10. No alternate A/B/C caller occurs in either failed phase's chain.
Source-map line numbers for Vditor Undo refer to the patched build input,
not the unpatched installed file's line numbers.

The complete ordering is measured, not inferred from a matching error message:
mode-switch timer arm precedes pointerdown; timer → Undo → bridge occurs while
held; authority writes follow; pointerup still has a collapsed selection. Both
pre-task and candidate product builds reproduce it, and the unchanged E2 body
also reproduces the same symptom on the pre-task baseline. **The held-drag
failure is therefore attributable to a pre-existing Undo-timer re-arm defect.**
Task 578 may shift execution timing, but these small samples do not establish
changed failure probability, and no claim of complete A/B/C timing equivalence
is made. The defect is not turned into acceptance merely because it predates
the task.

**E1 / health / E2 timing interpretation.** All sixteen native before/after
health records show the exact XTEST client visible, native window visible and
focused, not minimized, with matching X11 active/focus IDs. Each E13 trace has
936 sentinel receives sent while the probe was armed, all visible and focused.
All recorded events in each failing diagnostic gesture are likewise visible and
focused. Neither diagnostic has a timer sentinel at least 500 ms late, so no
current failure is classified as the handoff's environment-throttled case.

| E1 maximum lateness, ms | Baseline, all armed samples | Candidate, all armed samples | Baseline, small document | Candidate, small document |
| --- | --- | --- | --- | --- |
| setTimeout(0) | 493.2 | 369.6 | 26.5 | 25.7 |
| setTimeout(32) beyond requested 32 ms | 461.6 | 436.3 | 4.7 | 5.3 |
| MessageChannel | 493.3 | 369.9 | 26.8 | 25.8 |
| requestAnimationFrame | 428.3 | 317.2 | 18.0 | 17.2 |

The all-phase maxima include the large-document work phases and are not paired
samples; they must not be subtracted from one another as a latency attribution.
The small document contributes 232 receives per diagnostic. Its prior ~1 s
latency does not recur in either diagnostic or any E2 run. E2 has zero such
latency failures in 3 baseline and 3 candidate runs, so the handoff's
candidate-only >=2/3 versus 0/3 baseline condition is false. **E4 is not
triggered and no component-revert build is requested.** The earlier one-off
small-document timer-delay observation remains unreproduced; E1 does not
retroactively prove that old run was throttled or invalidate it as such.

**Evidence limitations retained.** The passive frame-health hook produced zero
forwarded rows in every invocation. Native pre/post health is recorded and E13
has direct per-sentinel/gesture document health, but continuous E2 document
visibility/focus is not claimed. This gap does not explain away the independently
recorded, visible/focused E3 Undo re-arm. The configured list-reporter result
directories also contain no persisted JSON attachments from the in-memory
`test.info().attach` bodies. Full console JSON is present: 20 E13 chunks per
build, zero dropped events (1,493 baseline / 1,515 candidate events). Those full
log objects, not absent attachments, are the evidence source.

`part1-experiments-summary.json` retains each run's measurements/status, health,
latency maxima, hashes, and mapped Undo chain. Extraction writes 40 diagnostic
reports and eight native-health reports under
`part1-experiments.Z8YQJ5/extracted/`, explicitly marked as log-derived. Focused
`E13-{baseline,candidate}-confirmed-undo-chain.json` files retain the timer arm,
held-gesture chain and mapped timestamps. Full logs and status.tsv remain
untouched. Source-map reconciliation and final summary extraction exit 0. The
initial reconciliation guard exposed the missing persisted JSON attachments;
the extractor now uses and round-trips the full logged objects. An initial stack
parser also needed to accept anonymous frames without closing parentheses;
that local parsing issue is corrected and does not alter runtime evidence.

**Project Owner question (handoff options 1–3).** The pre-existing defect now
blocks the required selection acceptance. The orchestrator must ask the Owner
to choose the authorized next path:

1. Create a separate task for the Undo/caret defect; retain this spec unchanged
   and close Task 578's `:471` gate only after clean repeat runs satisfy the
   required acceptance.
2. Expand Task 578 to fix the defect, with a new approved caret/Undo design.
3. Create a separate task and permit the spec to wait for the pending
   afterRender/process timer before its cold drag; this specifically requires
   Owner confirmation that the setup change does not weaken acceptance.

No option is selected or implemented here. The brief and handoff explicitly
forbid silently waiving the baseline failure. CP3's required regression checkbox
and final closure stay open; no done move, README/incoming-link changes or commit
request. All other accepted CP3 evidence remains ready for closure, including
the tightened Find gate and three 0/0/0 click/source/history runs. Optional
lifecycle limitations remain unchanged. This turn only updates the task record
and ignored extracted evidence; product/generated files, protected queues and
git metadata remain untouched, and nothing is pushed.

### Checkpoint 3 — Owner-approved held-drag fix, implementation and fresh-build relay (2026-09-27)

Dispatch `20260927-232506-578-cp3-caret-fix` records the Project Owner's choice
of **option 2: fix the pre-existing Undo-timer re-arm inside Task 578**. This
expands scope to the authority and its tests; it does not authorize changing
Vditor, esbuild-shared.mjs or another requestCaret caller. The accepted Part 1
handoff is from Claude Opus 5.5, read-only design subagent `ab395c63d82523372`.
**Tier Heavy; requested Part 1 effort max; effective effort medium**, as reported
in the handoff because no agent definition supplied an effort key. The full
handoff and provenance are preserved at ignored
`tmp/task578-cp3-checks/caret-fix-part1-handoff.md` and
`caret-fix-part1-provenance.json`. No model/session setting or protected queue
file was changed.

**Approved rule implemented, product diff only in `editing/caret.ts`.** A
primary button-0 pointerdown still invalidates any previous intent and records
that the pointer is held (non-primary, secondary/middle or untyped pointerdown
does not start a hold). A request during the hold performs its synchronous
tryPlace repair, then clears any live intent/pending rAF and returns placement
success. It never arms a retry, including when the immediate range is not yet
paintable. Ordinary requests retain their prior lifetime. Pointerup/cancel,
button-free pointermove, window blur or hidden visibility ends the hold; none
replays an old request. Listener disposal and the test reset clear held state.
Untyped pointermove is ignored rather than treating a missing buttons field as
a release. Header/lifecycle/request comments explain why snapshot split repair
stays synchronous while native selection owns subsequent movement. Other caret
callers and the Undo patch are untouched.

**Unit evidence.** Fourteen new tests cover collapsed and backward immediate
repairs; no later overwrite after changing the live selection and flushing
frames; unresolvable/unpaintable targets; pointerup/cancel, release-outside
recovery, blur/hidden cleanup; secondary/non-primary/untyped events; keydown
while held; listener disposal and reset. Before the product patch, the focused
run reports 9 failures / 50 passes, including the expected held-intent failures.
One new write-count assertion also inherited call history from an existing
Selection spy; clearing that spy at the observation boundary and counting only
post-extension writes fixes this test-side accounting. No assertion or gesture
contract was weakened. Final focused command:

`node_modules/.bin/vitest run --config test/vitest.config.mts media-src/src/editing/caret.test.ts test/backend/vditor-source-patches.test.ts`

exits **0: 283 passed, two files**, including all 59 caret tests and the unchanged
Vditor source-patch suite. Logs: `held-drag-unit-red.log` and
`held-drag-unit-green.log`. No old 445/487/553 test fails in this unit run.

**Runtime tests authored, not yet accepted.** New
`media-src/e2e/held-drag-undo-snapshot.spec.ts` and
`test/vscode-e2e/held-drag-undo-snapshot.spec.ts` each exercise IR and WYSIWYG:

- An uninjected control drag must select more than 20 characters, preserve
  forward direction/source, and make no product Selection API writes.
- Forced addToUndoStack immediately after mouse.down must call the caret bridge
  once, retain a paintable successful immediate repair, make no Selection API
  writes after injection returns through pointerup, and finish with exactly the
  control's native selection length.
- A fresh toolbar mode switch starts the natural snapshot timer; this leg does
  not drain it before mouse.down. Twelve gradual steps each span at least two
  rAFs and 100 ms, crossing 1,200 ms while held. A timer and exactly one snapshot
  caret request must occur while held; only the synchronous bridge/Undo repair
  may write selection. All subsequent writes are forbidden, and final direction,
  source and full native length must match the control.

The test-only shared helper is
`test/vscode-e2e/helpers/held-drag-undo-probe.ts`. It forwards timer/Undo/bridge/
Selection calls, correlates timer IDs with the snapshot and records stacks for
any forbidden writer. A real non-authority write is a Part 1 stop condition,
not a reason to filter that writer out. Setup for the control/forced legs polls
actual completion of tracked snapshot timers; the natural-timer leg explicitly
omits that setup wait. Gesture duration uses rAF progression, not a pre-drag
sleep. Source text is never returned in evidence. The real spec additionally
checks document focus/visibility, exact getValue/host/disk bytes and save, and
writes an explicit JSON artifact before attaching it, avoiding the earlier
in-memory-attachment persistence gap. Its natural-timer trace supplies the
required E3-style snapshot→bridge→no-later-write evidence if it passes.

The existing registered `selection-bubble-harness.ts` gains the missing
installCaretWindowBridge call beside its existing installCaretInvalidation,
so Chromium snapshot restoration actually exercises the authority. This is
harness wiring, not another product caller change. Harness/spec source is edited;
no generated file is hand-edited.

**Rebuild and local preparation.** `node build.mjs` exits 0. Fresh main.js is
**900,331 bytes**, SHA-256
`995dd0b30645b068f3882bc812ced24d8a8b3a4f5381b4fc6708abdbeebfd1a8`:
+681 B versus Part C and +2,140 B versus Task 196's 898,191 B. Eager modules and
budget checks remain reporting-only in the final gate sequence. The old
8687380d artifact is no longer the final candidate; its accepted results remain
historical. The main CP3 checkboxes have been reopened where fresh evidence is
required, and the approved held-pointer obligation is added explicitly.

Focused Biome and whitespace checks exit 0. Spec typecheck (including temporary
relay wrappers/hooks) exits 1 only for the known checkbox-spec TS2339; no new
spec/probe/type diagnostic. Individual installer/verifier/cleanup checks exit 0.
Playwright discovery resolves **44 tests in 20 files** across the five wrapper
groups, including both new cases and the original unchanged selection test at
`:471`. The three separate selection invocations add two further executions;
no test body is silently replaced or its assertions changed by the wrapper.

**One detached-friendly relay is prepared.**
`tmp/task578-cp3-checks/caret-fix-relay.sh` reuses the verified rebuilt artifact,
checks frozen product/test/build inputs before every runtime stage, starts
Openbox/XTEST and runs these stages serially, workers=1/retries=0:

1. Focused Chromium: new held-drag, undo-boundaries, mouse-selection,
   selection-bubble, structural-selection, block-handle, details,
   selection-performance and find-replace-large.
2. New real-VS-Code held-drag spec, both modes.
3. Named caret/Undo regressions: caret-click-during-init, list-enter-undo-caret,
   undo-redo-steps, undo-boundaries, structural-selection,
   caret-authority-rebuild, caret-on-open, caret-empty-typing,
   caret-tab-return, gap-cursor and ime-composition.
4. Fresh integrated regressions: selection-bubble, block-handle,
   large-document-interaction, find-replace, find-replace-large and
   details-toolbar.
5. One fresh ir-click-index sweep, retaining the old three matched runs as
   historical evidence.
6. Three consecutive independent invocations of unchanged
   selection-performance.spec.ts:471.
7. Only after runtime gates pass: changed-line caret coverage, then once-only
   network-free lint, knip, jscpd, dependency-cruiser, full unit coverage and
   module ratchet; regular/strict/spec types and bundle/startup reporting.
   Never npm run quality or audits. Each quality/reporting status is independent.

Each completed stage writes its own log/results/status in a fresh
`caret-fix-run.XXXXXX/`. Any runtime failure stops the runner before downstream
acceptance, honoring the handoff: any 445/487/553, gap/focus, non-authority writer,
selection-performance or other new symptom returns for review; no automatic
retry. There is no product fix outside the authority in this relay. Old count
status and artifacts are not overwritten. Temporary wrappers are exclusively
created and ownership/hash-checked on cleanup, and are removed before the quality
pass so they do not become permanent analysis inputs. Unit/coverage commands also
unset the relay-only VMDE_XTEST switch, preserving their normal test environment.

Runner-owned hooks verify native window/XTEST visibility/focus and route legacy
Page.keyboard.press/type calls through createXtestInput without a CDP fallback.
They normalize modifier chord names (including conventional Control+Z spelling),
preserve requested typing delays and reject unsupported held-key/insertText
routes. Existing spec assertions remain intact. New drag specs use pointer input
and have no keyboard steps. Composition dispatch in the existing IME wiring spec
remains simulated composition evidence, not a claim of a physical IME session.

Actual runner-tail smoke tests with external commands stubbed exit 0 across
eight scenarios: ordered execution, stop on any runtime failure, full independent
quality status reporting, and correct aggregate exit. Syntax/install/discovery
checks launch no GUI. No real-VS-Code or Chromium run on this new build is claimed
yet. Jev remains unavailable under approval policy never; the orchestrator owns
the final diff gate, and the previously loaded Caveman/repository skills remain
in use.

**Closure remains pending.** If all required gates pass, propose two focused
local commits: authority fix plus its unit/runtime tests and harness wiring;
then existing CP3 acceptance-spec changes plus the completed task record/index/
incoming links. Do not move the record or request those commits before the fresh
acceptance is complete. No push or git metadata write was made. Protected queue
files and excluded product paths are untouched.

### Checkpoint 3 relay 13 — Chromium accepted; natural-timer setup corrected (2026-09-27)

Dispatch `20260927-235302-578-cp3-relay13` returns
`tmp/task578-cp3-checks/caret-fix-run.nD0oSV/`: chromium=0, vscode-new=1,
overall exit 1. The runner stopped before caret/integrated regressions, counts,
selection repeats or quality, as designed. Temporary wrappers were cleaned up;
the orchestrator reports no leftover GUI process.

**Fresh-build Chromium acceptance:** all **67 tests pass in 2.8 min**, including
both modes of the new forced/natural-timer drag test and all eight requested
focused regression specs. This is on the rebuilt 995dd0b3 candidate, not the old
Part C build. Source, shared probe and Chromium harness/spec hashes are retained
in the run manifest; the complete log is `chromium.log`.

**New real-VS-Code result is partial, not a passing spec.** Both tests reach and
fail the same first natural-timer assertion, after their control and forced
legs have passed all intervening assertions. Explicit evidence files and their
attachments show:

| Mode | Control length | Forced length | Forced bridge/paint | Writes after forced return | Natural leg |
| --- | --- | --- | --- | --- | --- |
| IR | 38, forward | 38, forward | one request, placed=true, height 19 px | 0 | no pending timer at down; no fire during 1,799 ms hold |
| WYSIWYG | 38, forward | 38, forward | one request, placed=true, height 19 px | 0 | no pending timer at down; no fire during 1,810 ms hold |

The immediate forced repair makes one removeAllRanges/addRange pair inside the
snapshot/bridge, then no further product write while held. Both forced holds
last about 1,886–1,894 ms, preserve the full native control length, and report
unchanged serialized source, visible document and focus. Controls have no
selection writes. The natural legs also finish with 38 forward characters and
unchanged source, but did not exercise a snapshot while held. Host/disk/save
assertions at the end of the test were **not reached**; they are not claimed
from these partial results. No non-authority writer or paint regression is
observed in this run.

**Test-side cause and repair.** The helper shared with Chromium records pending
timers at pointerdown; both failing records contain `pending: []`. Thus the
1.8 s hold did not begin in the required pending-snapshot window. Static path
inspection identifies an inappropriate synchronization dependency in the real
spec: even its non-settling mode switch waited for `waitForE2EReadiness(...mode)`.
`chrome/toolbar-actions.ts` publishes that ledger mode only from the 500 ms
mode-persistence/report callback. The installed Playwright expect.poll defaults
to 100/250/500/1,000 ms intervals; observing the change can therefore take about
850 ms plus tool round trips, already beyond the ordinary 800 ms Undo timer.
Vditor's actual currentMode/root changes synchronously in the toolbar click and
arms the snapshot there. The Chromium harness uses that synchronous mode path
and passes the natural-timer assertions.

The failed artifact does not retain the pre-gesture timer arm/fire timestamps,
so an exact prior firing timestamp is not invented. It does prove that no timer
was pending at the measurement boundary. The delayed-ledger wait is unsuitable
for this specific test's precondition regardless of its incidental scheduling.
Only `test/vscode-e2e/held-drag-undo-snapshot.spec.ts` changes in this repair:

- Settled control/forced setup retains the existing readiness/timer-completion
  checks.
- The natural-timer mode switch checks the actual mode and visible root directly
  after the real toolbar click. It also requires scheduled count to increase,
  completed count to remain unchanged, and exactly one timer to remain pending.
- At the actual gesture's pointerdown, evidence must still contain the target
  mode's unfired timer. The existing held-timer/bridge, zero-later-write,
  paintability, full-length, source and final host/disk gates remain intact.
- The before/current mode-switch counters and timestamp are persisted alongside
  the gesture traces, making a missed window explicit at its first boundary.

No sleep, longer timer, synthetic timer re-arm, extra snapshot, retry, product
change or relaxed assertion is introduced. The fix removes the test's delayed
status-report dependency; the actual timer-in-gesture precondition is stronger.
The product caret fix remains unchanged and no Part 1 product stop condition has
been observed.

**Reuse and next relay.** Comparison with the previous run's frozen manifest
shows exactly one changed input: the real-VS-Code drag spec. Product main.js,
caret.ts, shared drag probe, Chromium spec and harness all match. Build SHA-256
is still `995dd0b30645b068f3882bc812ced24d8a8b3a4f5381b4fc6708abdbeebfd1a8`;
no rebuild is needed. `caret-fix-relay.sh` now verifies the accepted Chromium
log/status/manifest and every prior frozen input except this real-only spec,
records `chromium-reused=0`, and starts at vscode-new. The 67 Chromium cases are
not rerun. All remaining stages retain their order, workers=1/retries=0,
independent logs/status and first-runtime-failure stop. Previous results and
count-status files are preserved in their original directories.

Local validation: focused Biome, shell syntax, Python compilation, ownership
installer/verifier/cleanup and whitespace checks exit 0. Spec typecheck exits 1
only at the known checkbox TS2339. Eight stubbed runner-flow scenarios pass,
proving that no Chromium command runs, runtime failures stop, and final quality
statuses remain independent; no GUI is launched by that smoke. Logs and hashes
are reconciled in `relay13-runtime-summary.json`; runner smoke is
`relay13-runner-flow.json`. The next runtime relay is still pending.

CP3 remains open. Accepted Chromium and unit/build evidence are preserved;
required real regressions, new timer proof, current count sweep, three selection
passes and final quality still need results. Optional lifecycle residuals remain
unmeasured. Product/generated files, excluded callers/Vditor, protected queues
and git metadata are untouched in this response; nothing is committed or pushed.

### Checkpoint 3 relay 14 — real drag proof passes; Unicode input comparison pending (2026-09-28)

Dispatch `20260928-000633-578-cp3-relay14` returns
`tmp/task578-cp3-checks/caret-fix-run.dwsGJz/`: chromium-reused=0, vscode-new=0,
vscode-caret=1. The runner stops before integrated regressions, the fresh count
sweep, selection repeats or quality. Temporary wrappers are removed and the
orchestrator reports no leftover GUI process. Chromium's 67 passing cases are
reused with unchanged-input verification, not rerun.

**New real held-drag acceptance passes in both modes.** The corrected synchronous
mode/root check finds a newly scheduled pending snapshot before the natural
leg, and the actual pointerdown retains that timer. IR uses timer 208; WYSIWYG
uses timer 164 (document-local IDs). Both control, forced and natural-timer
legs finish with **38 characters, forward selection, unchanged source and
visible/focused document**. Forced injection invokes the bridge once, performs
one immediate removeAllRanges/addRange repair at height 19 px, and makes zero
later writes. The natural timer invokes the bridge once while held; its repair
is successful/paintable at 19 px and makes no additional Selection API write.
All no-later-write/full-length assertions execute and pass. Final exact
getValue, host, disk and save checks also execute and pass. This supplies the
requested E3-style timer→snapshot→bridge→no-reassertion trace on the new product.
Explicit artifacts are under `vscode-new-results/*/held-drag-undo-evidence.json`;
paths, hashes and condensed proofs are reconciled in `relay14-summary.json`.

**Caret regression stage: 14 passed, one failed, 3.7 min, retries=0.** Passed:
first-click paint (445), list Enter/Undo caret, Undo/Redo steps, Undo boundaries,
structural selection, authority rebuild, both caret-on-open cases, all four
caret-tab-return cases, gap cursor, and IME wiring. The failed unchanged test is
`caret-empty-typing.spec.ts:87`, at its exact typed-value assertion (line 193).
The expected known six-character test input has code points
[90,97,380,243,322,263]; actual is [90,97,380,322,263], missing U+00F3. The three
pre-typing measurements show document focus, the editable PRE active and a
paintable 19 px caret. Native window pre/post checks are visible/focused and
not minimized. These preconditions do not establish where the missing character
was lost: the run has no key/beforeinput/input trace. This is not yet classified
as a baseline defect, an XTEST defect, or a flake.

The new primary-held branch does not intentionally change ordinary keyboard
input: keydown still invalidates the intent and the empty document is typed
without a pointer click. That narrows investigation but is not used to exonerate
the product without a comparison. The original regression assertion remains
unchanged. A later recovered pass by itself will not satisfy acceptance.

**Prepared bounded comparison, two serial VS Code invocations.**
`unicode-input-relay.sh` runs the same unchanged required test once on the cached
pre-task `d56ca040` build (c1fb62d1…) and once on the current candidate (995dd0b3…),
workers=1/retries=0, with native/XTEST health checks. Both build hashes are guarded;
required spec, its empty/text fixtures, XTEST helper, webview helpers and config
are byte-identical. No rebuild or main-regression rerun is requested during
attribution. This baseline is explicitly permitted by the relay-14 brief.

The diagnostic hook retains the **same captured XTEST batch type route and
20 ms delay** used by the failing stage. Immediately before that call, it
installs capture listeners in the ready target document for keydown/keyup,
beforeinput/input, composition and pointer events. It records key/data code
points for the controlled test input, cancellation after dispatch, target/focus,
visibility and selection offsets. It does not write source or caret selection.
The editor trace is copied at the original post-typing screenshot boundary:
the required spec has already sampled its value after its existing 500 ms wait,
so that read cannot alter the assertion's sampled outcome. The test body,
assertions and input are not replaced.

After the required assertion, diagnostic controls type into a plain textarea
outside the editor root in the same native window. Two predeclared XTEST routes
have three independent samples each: the original batch call and one call per
Unicode code point. Every sample starts with an empty control; these are not
resends or repairs of the editor text, and per-code-point delivery is **not yet
adopted as a fix**. A non-text XTEST right-Control release supplies a receiver-side completion
barrier for each control, with its counter captured after typing so capital-letter
Shift edges cannot satisfy it; there is no new sleep or CDP insertion. Results and
receiver traces identify whether a character reaches the browser and whether
loss also occurs outside Vditor. Control outcomes are recorded independently;
an original-test pass does not automatically mean the controls or regression
attribution passed. Explicit JSON files are written before attaching/logging.
No private or large fixture text is collected.

The two comparison runs report independent statuses even if the baseline test
fails. The runner performs exclusive temporary-file creation and ownership/hash
cleanup, uses a fresh `unicode-input.XXXXXX/`, and leaves accepted Chromium,
held-drag and caret-pass evidence untouched. It does not automatically continue
acceptance after a recovered pass. If the receiver trace implicates the caret
change, return to Part 1 under the handoff's stop rule; otherwise repair only a
supported input/test defect before resuming the failed stage.

Local checks: installer/verifier/cleanup, shell/Python syntax and discovery exit
0 (exactly the original `caret-empty-typing.spec.ts:87` test). Typecheck including
the diagnostic sources exits 1 only for the known checkbox TS2339. Four stubbed
flow scenarios preserve both serial comparison invocations and their statuses;
no GUI runs locally. Reports: `unicode-input-manifest.json`,
`unicode-input-typecheck.log`, `unicode-input-discovery.log` and
`unicode-input-flow-smoke.json`. Comparison runtime evidence remains pending.

Only this record and ignored diagnostic tooling/evidence changed in this turn.
No product or permanent test/input-driver fix was made. The same candidate build
is retained, all earlier results keep their original success/failure labels,
and CP3 is not closed or committed. Protected queues, generated files, excluded
product paths and git metadata remain untouched; nothing is pushed.

### Checkpoint 3 relay 15 — native input loss demonstrated; resume with scalar XTEST delivery (2026-09-28)

Dispatch `20260928-002233-578-cp3-relay15` returns
`tmp/task578-cp3-checks/unicode-input.CGuNYk/`: baseline=0, candidate=0, overall
exit 0. Both instrumented editor journeys satisfy the original exact-value
assertion. The orchestrator reports a detached markdown-language-features worker
exited itself seconds after its parent; no process remains and none was killed.
These recovered editor passes alone do not clear relay 14's failure.

**The native controls supply additional evidence not captured by the exit codes.**
The first **baseline batch** textarea control reproduces the exact missing
U+00F3: final value, beforeinput sequence and input sequence are all
[90,97,380,322,263], rather than [90,97,380,243,322,263]. It is a plain textarea
outside the editor root, on the pre-fix d56ca040 build, using the same XTEST batch
route/delay. No key or input event is cancelled; all samples are visible/focused.
Thus a character is lost on the XTEST/native input path **before beforeinput**,
independently of Vditor text handling and the new caret branch. Non-ASCII keydown
key values are [0] in successful and failed samples alike, so those key values
alone are not used to infer which character was delivered.

| Receiver / route | Baseline | Candidate |
| --- | --- | --- |
| Original editor journey, batch XTEST | exact 6 characters | exact 6 characters |
| Native textarea, batch sample 1 | missing U+00F3 before beforeinput/input | exact |
| Native textarea, batch samples 2–3 | both exact | both exact |
| Native textarea, per-code-point samples 1–3 | all exact | all exact |

Both editor traces contain the expected six beforeinput characters, final caret
offset 6, no pointer event during typing and no cancelled event. All **six**
per-code-point native controls produce the full beforeinput/input/value sequence.
The fixed sample counts are controls, not retries of a failed editor edit.
The diagnostic runner's exit 0 reports its original spec assertions; it does
not mean every diagnostic control succeeded. Explicit JSON artifacts retain the
failed native control and must be read alongside the successful editor results.

**Classification: XTEST/native input-route loss is demonstrated.** The original
relay-14 editor event chain was not recorded, so attributing that particular
occurrence to the demonstrated matching failure is an inference, not a captured
per-event proof. The new caret change is not implicated by the available evidence:
the same loss occurs before the browser's text-input events in a baseline native
control. No specific xdotool/X11/Electron implementation bug is claimed, and a
small control sample does not prove universal Unicode reliability. The old
failed test remains failed in the record; fresh required acceptance is still
needed after the supported test-driver mitigation.

**Runner-only mitigation.** `caret-fix-runtime-hooks.ts` keeps its ASCII type
batch and all key-chord routing unchanged. If a text argument contains non-ASCII,
it sends each Unicode scalar once through the same verified XTEST helper,
awaiting each process before the next. Requested per-call typing delay is
preserved (20 ms default). There is no retry, resend, normalization, clipboard
replacement, CDP fallback or new sleep. The required caret-empty-typing body and
its exact six-character assertion are unchanged. Product code, permanent input
helper and source fixtures are unchanged. The old batch hook is archived at
`caret-fix-runtime-hooks-batch-source.ts`, verified byte-identical to the
original relay hash e07846a9…, so the diagnostic route remains reproducible.

The evidence summary is `relay15-input-summary.json`, with original artifact
paths/hashes, exact beforeinput/input/value sequences and focus/cancellation
checks. A runner-route smoke exercises the real hook with a fake XTEST receiver:
ASCII stays one call; the six-character word becomes six scalar calls; a
supplementary-plane character stays one scalar; an explicit delay is retained;
a delivery error stops without retry; and Control+Z still routes as ctrl+z.
It passes (exit 0, `unicode-route-smoke.json`). Its initial assertion shim needed
cross-VM plain-object normalization; that smoke-only comparison issue was
corrected before the successful run, with no change to runtime evidence.

**One acceptance relay resumes at the full caret stage.** The updated
`caret-fix-relay.sh` verifies/reuses Chromium 67/67 from nD0oSV and the two new
real drag cases from dwsGJz. Every product/spec/probe input for the latter still
matches; those tests have no Page.keyboard.type call, so the changed Unicode
route is not exercised by them. Reuse is labeled `chromium-reused` and
`vscode-new-reused` in the new status file, not represented as fresh executions.
The full 15-test caret group runs again with the changed input route; the
previous 14 successes are not used to skip that group.

If it passes, the same detached invocation continues through integrated
regressions, one current-build count sweep, three consecutive unchanged
selection-performance runs, changed-line coverage and the once-only network-free
quality/type/budget stages already listed. Runtime failures still stop immediately;
quality statuses remain independent. No product rebuild is needed: main.js stays
900,331 B / 995dd0b30645b068f3882bc812ced24d8a8b3a4f5381b4fc6708abdbeebfd1a8.
No audits or npm run quality are requested.

Installer/verifier/cleanup, shell/Python syntax and whitespace checks pass.
Typecheck with the updated hook included exits 1 only for the established
checkbox-spec TS2339. Eight runner-flow smoke scenarios verify that neither
reused stage executes, caret is first, runtime failures stop, and quality
reporting continues independently (`relay15-resume-flow.json`). These local
checks launch no GUI; the fresh acceptance result is pending.

This response changes only this record and ignored runner/diagnostic evidence.
There is no product fix, permanent test change, commit, push or done/index move.
Protected queue files, excluded source paths and git metadata remain untouched.
CP3 remains open until the resumed required stages establish acceptance.

### Checkpoint 3 relay 16 — large cold IR settle outlier; Part 1 stop (2026-09-28)

Dispatch `20260928-004728-578-cp3-relay16` returns
`tmp/task578-cp3-checks/caret-fix-run.CouFzC/`, overall exit 1. Chromium/new drag
proofs are reused; **caret regressions pass 15/15**, including the exact Unicode
empty-typing assertion with scalar XTEST delivery; **integrated regressions pass
25/25**; the fresh count sweep passes; selection-1 passes and selection-2 fails.
Selection-3 and every final quality/coverage/type/budget stage do not run.
Wrappers are cleaned and the orchestrator reports no leftover process.

The brief explicitly identifies the Part 1 stop condition for a non-selection-
length failure. This response performs **read-only extraction and record updates
only**: no fix, retry, new profiling run or acceptance relay.

**The actual failed phase differs from the earlier small-document delay.**
Exactly one row in selection-2 exceeds 150 ms: **IR / large / cold drag**. It
retains 11 forward-selected characters, accurate enabled Details/visible bubble,
and exact host/disk bytes. No measured selection phase collapses in either fresh
run. All four small-document phases stay within the numeric latency gate
(maximum 41 ms in selection-2).

| Comparable phase | Release→show ms | Release→visible frame ms | Observed−workload ms | Settle longest task ms | Settle max rAF gap ms | Pre-visibility builds / getValue / markers |
| --- | --- | --- | --- | --- | --- | --- |
| Relay 16 selection-1: large cold IR drag | 36 | 53 | 554 | 0 | 17 | 0 / 0 / 0 |
| Relay 16 selection-2: large cold IR drag | **221** | 229 | **813** | **194** | **183** | **0 / 0 / 0** |
| Relay 10 candidate: large cold IR drag | 34 | 35 | 792 | 0 | 17 | 0 / 0 / 0 |
| Relay 10 baseline: large cold IR drag | 54 | 69 | 544 | 0 | 17 | 0 / 0 / 0 |

Selection-2's failed row has workload=3,125 ms and observed=3,938 ms; the 813 ms
post-work tail is 313 ms beyond the requested 500 ms observation. Whole-phase
metrics are one index build, one getValue, zero reported root Lute/two fragment
calls, zero Range.insertNode, two long tasks totaling 847 ms and max rAF gap
650.1 ms. The build/getValue deltas after visibility are also zero. These totals
and deltas are kept separate; the 194 ms task has no stack attribution.

The settle long-task field reports the whole duration of a task **overlapping**
release→visible-frame, not 194 ms proven exclusively after release and not a CPU
profile. Observed−workload includes the intended observation wait, work and
frame/tool round trips; it is not a direct timer-lateness measurement. The
console summary does not emit pre-visibility root/fragment Lute deltas; the JSON
uses null for those unavailable fields, never fabricated zeros.

Relay 10's actual violations were four **small-document** phases:

| Relay 10 candidate small phase | Release→show ms | Observed−workload ms | Settle longest task / rAF gap ms |
| --- | --- | --- | --- |
| IR drag | 992 | 991 | 0 / 17 |
| IR slow keyboard | 623 | 625 | 0 / 17 |
| WYSIWYG drag | 995 | 1,025 | 0 / 17 |
| WYSIWYG slow keyboard | 650 | 646 | 0 / 17 |

That earlier idle-looking timer-delay signature is **not reproduced by the new
failure**. Here there is an overlapping long task and a large rAF gap. Zero
pre-visibility source-work deltas do not identify that task, establish timer
clamping, or decide whether the cause is product work, renderer/layout work or
environmental scheduling. Attribution remains open.

**E1/E2 comparison and health limitations.** The prior Part 1 experiment's
same large cold IR row was 34 ms in each E1/E3 diagnostic. Its six unmodified
E2 samples were baseline 71/33/35 ms and candidate 34/34/33 ms. The 71 ms baseline
sample had an overlapping 55 ms task and 50 ms rAF gap; the others had 0 ms task
and 17 ms gap. Across all prior E1/E2 rows there was no numeric latency violation,
although some runs failed the earlier selection-collapse assertion and did not
execute later gates. Prior small-document E1 sentinels were prompt (timer-32
lateness at most 4.7/5.3 ms), with no timer sentinel >=500 ms late in either
build; those samples were visible/focused. They belong to different invocations
and cannot classify the current outlier.

For current selection-1 and selection-2, the runtime hook records the native
window visible, focused and not minimized both before and after the test.
The before record also confirms the mapped XTEST client visible. It does **not**
record per-phase document.visibilityState/document.hasFocus or timer/MessageChannel
sentinels. No new mid-phase visibility or queue evidence is claimed. The two
native endpoint records cannot prove continuous frame health during the failed
settle window.

The required text-free artifact is
**`tmp/task578-cp3-checks/relay16-latency-summary.json`**. It contains the requested
failed-phase metrics, selection-1 comparison, all four relay-10 failures, the matching
relay-10 large rows, E1/E2 numeric/health/sentinel comparisons, known measurement
limits, stage statuses, input-harness provenance and source log hashes. It is
extracted by `extract-relay16-latency.py`; extraction/reconciliation exits 0.
No fixture body is included.

**Fresh count proof preserved.** The completed count artifact has 42 measured
warm phases, six optional absences, no unavailable target and complete=true.
Every build/getValue/root/fragment count is zero; before/after source identity
and full native-history identity match in every phase. Host/disk retain the
original 174,527 UTF-8 bytes / SHA-256 a4a39d6f…; host is found, dirty=false,
version=1. Longest observed task is 58 ms, reporting-only. The corresponding
main CP3 count/source checkboxes are now checked, while the three-selection-run
and final quality/closure obligations remain open.

**Where the Unicode change lives, and reproducibility proposal.** It currently
lives **only in ignored `tmp/task578-cp3-checks/caret-fix-runtime-hooks.ts`**,
copied into a temporary hook for relays. It is not in a committed helper.
Tracked `test/vscode-e2e/helpers/xtest-input.ts` still batches the whole string.
Legacy caret/Undo specs still use Page.keyboard methods; without the temporary
hook, setting VMDE_XTEST alone does not route those calls through that helper.
Thus current successes are explicitly **qualified by the archived relay harness**,
not reproducible OS acceptance from the tracked checkout alone. Pins/hashes
preserve provenance but do not satisfy the requirement for a versioned harness.

Recommended tracked follow-up, proposed only during this stop:

1. Move the proven ASCII-batch/non-ASCII-scalar policy into
   `test/vscode-e2e/helpers/xtest-input.ts`, preserving focus checks, per-call
   delay, Unicode scalar boundaries, argument separation and fail-fast behavior.
2. Add deterministic coverage in `test/backend/xtest-input.test.ts` for batching,
   scalar/emoji boundaries, delay propagation and no retry after delivery error.
3. Route the named legacy caret/Undo specs through tracked input infrastructure
   (the existing createSpecKeyboard adapter, with required chord mappings, or a
   shared versioned fixture). Version necessary native-window health/preflight
   there as well. Moving the Unicode loop into the helper alone is insufficient
   for specs still calling Page.keyboard directly.
4. Remove the relay monkey-patch and revalidate affected OS acceptance through
   the tracked path. Keep the old failed run and the demonstrated baseline
   native-control loss in the record; no silent pass conversion.

No part of this proposal is implemented now. The failing selection-performance
spec uses its own createXtestInput instance and only types ASCII `x`; it does not
invoke the Page.keyboard.type override, so the Unicode loop was not executed
by that journey. That is a source-path fact, not a general exoneration of the
runtime environment.

**Design question for Part 1:** what bounded attribution is approved for the
194 ms task overlapping the large cold IR settle window, given zero measured
pre-visibility source-work deltas and a signature different from the prior
small-document idle delay? Also approve the tracked OS-input follow-up above,
or specify another reproducible acceptance path, before any final rerun/closure.
The explicit stop condition prevents improvising a product fix or retry here.

Only the task record and ignored extraction artifacts changed in this response.
Whitespace checks pass. No runtime test, source edit, build, quality stage,
commit, push or done/index move was performed. Protected queues, excluded source
and git metadata remain untouched. Final Jev review remains with the orchestrator
and CP3 remains open.

### Checkpoint 3 final acceptance and closure (2026-09-28)

**Decisions and provenance.** The Project Owner chose option 2 on 2026-09-27:
repair the held-primary-drag Undo-timer caret re-arm inside Task 578. On
2026-09-28, the Owner classified a `selection-performance.spec.ts:471` run with
the small-document stall signature as invalid, not counted and replaced,
rather than a counted pass or failure: observed minus workload gap at least 600 ms, show
latency within 30 ms of that gap (or no visible bubble and a gap at least
1,000 ms), zero long tasks, and maximum rAF gap below 100 ms. Any other failure
resets the count and stops for attribution. The unchanged spec's final three
consecutive invocations are each counted passes; their classifier verdicts are
in `tmp/task578-cp3-checks/acceptance-run.CVYzMJ/selection-{1,2,3}-classification.log`.
The earlier Astra latency run `20260928-010630-578-cp3-latency` was stopped
mid-turn on the Owner's order and supplies no acceptance result.

Execution changed to small per-step briefs with a tier per step. Earlier Part 1
subagents ran at effective session effort `medium` despite requested `high` or
`max`. The launcher's verified later Codex settings were S1 `gpt-6-sol/max`,
S1 fix `gpt-6-sol/high`, S1b/S1c `gpt-6-sol/max`, S4 `gpt-6-sol/max`, S6
`gpt-6-astra/xhigh`, and S7 `gpt-6-sol/high`; S9 is this record-only closure.

**Accepted product and input paths.** The only new product change is
`media-src/src/editing/caret.ts`: a request during a held primary pointer drag
repairs synchronously once and does not re-arm a later selection write. Release,
cancel and focus-loss recovery remain covered. The built `media/dist/main.js`
is 900,331 B, SHA-256
`995dd0b30645b068f3882bc812ced24d8a8b3a4f5381b4fc6708abdbeebfd1a8`.
`caret.test.ts` and the unchanged Vditor-patch suite passed 283/283 in
`tmp/task578-cp3-checks/held-drag-unit-green.log`. The two-mode forced and
natural-timer proof is in `media-src/e2e/held-drag-undo-snapshot.spec.ts`,
`test/vscode-e2e/held-drag-undo-snapshot.spec.ts` and
`test/vscode-e2e/helpers/held-drag-undo-probe.ts`; the Chromium harness installs
the same caret bridge in `media-src/e2e/selection-bubble-harness.ts`.

The tracked `test/vscode-e2e/helpers/xtest-input.ts` now delivers non-ASCII
Unicode by scalar, with batching preserved for ASCII, and
`test/backend/xtest-input.test.ts` covers boundaries, delay and failure behavior.
`caret-empty-typing.spec.ts` and `caret-tab-return.spec.ts` use the tracked
keyboard adapter. The baseline native-textarea control in
`tmp/task578-cp3-checks/unicode-input.CGuNYk/` reproduced the earlier missing
`ó` before `beforeinput`; the old editor failure is retained as failed evidence.
The accepted tracked run has no relay monkey-patch or temporary spec copy.

**Runtime acceptance, workers 1 and retries 0.** Chromium passed 67/67
(`tmp/task578-cp3-checks/caret-fix-run.nD0oSV/chromium.log`). The new real
held-drag spec passed both modes
(`tmp/task578-cp3-checks/caret-fix-run.dwsGJz/vscode-new.log`). The tracked
caret group passed 17/17, comprising the two new drag tests and the 15 named
caret/Undo/gap/IME regressions
(`tmp/task578-cp3-checks/acceptance-run.jUNMgh/vscode-caret.log`). The final
integrated set passed 25/25, including the measured absolute-zero warm IR
Find-open click gate (`tmp/task578-cp3-checks/acceptance-run.CVYzMJ/vscode-integrated.log`). The fresh
count sweep passed 42 warm phases with zero index builds, full `getValue`, root
or fragment Lute calls, exact source/history in every phase, six optional
absences and no unavailable target; host and disk remain byte-identical,
clean and version 1 (`tmp/task578-cp3-checks/acceptance-run.CVYzMJ/counts.log`).
The unchanged `selection-performance.spec.ts:471` then passed 3/3 consecutive
with zero classified stalls (`tmp/task578-cp3-checks/acceptance-run.CVYzMJ/status.tsv`).

The earlier `acceptance-run.jUNMgh` integrated attempt failed in SV because
the replacement input held `ZZZ` after XTEST requested `ZZZZ`; it is retained
as a failure, not converted into a pass. The S6 diagnosis found neither the
held-pointer fix nor Unicode-scalar helper involved in that ASCII field input.
`find-replace-large.spec.ts` now checks field focus and exact typed value before
the measured Replace All action; the final integrated run passes. The separate
`latency-run.c41EAb` experiment measured the large cold-IR drag at about 34 ms
in all six samples, with one small-document environment stall; Part 1 did not
implicate the caret change. Earlier relay 16's 221 ms long-task overlap remains
historical evidence, not a passing latency sample.

**Final candidate gates.** `acceptance-run.CVYzMJ/status.tsv` reports exit 0
for changed-caret and changed-XTEST coverage, lint, jscpd, dependency-cruiser,
unit coverage, the coverage-module ratchet and regular typecheck. Knip exits 1
with the same nine exports and one type as the `7c2166ae` baseline (output
byte-identical to `/tmp/task578-cp2c-baseline-knip.log`). Strict types exits 1
with the same 13 recorded diagnostics (output byte-identical to
`/tmp/task578-cp2c-strict.log`). VS Code spec types exits 1 only at the known
`preview-task-checkbox.spec.ts(122,28)` TS2339. No new finding appears in those
nonzero gates. Bundle and startup checks exit 1 under the Owner's reporting-only
policy: main.js is 900,331 B, **+2,140 B** from Task 196's 898,191 B, and the
eager count remains 346 (`acceptance-run.CVYzMJ/bundle.log` and `startup.log`).
The network-free stages were run individually once; no audit or aggregate
`npm run quality` is claimed.

**Residuals retained.** The optional OS-arrow/link lifecycle, caret-class
restoration and real theme-message route remain unmeasured as recorded in relay
9. The baseline table copy-spacing and extra source-neutral Undo checkpoint
remain separate known residuals. Their earlier evidence and failed attempts
are preserved above. All required Checkpoint 3 checklist items now have final
accepted evidence, so this record is closed and indexed in `tasks/README.md`.
