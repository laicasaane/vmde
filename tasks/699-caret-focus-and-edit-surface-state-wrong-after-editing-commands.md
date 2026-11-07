# Task 699 — Caret, focus and edit-surface state or command results are wrong after editing commands at `f84a4258`

**Status:** planned (2026-11-02). Filed from the full real-VS-Code gate of queue run 2026-11-01d.
**Origin:** Gate rerun at `f84a4258` (Task 695): the suite failed these cases in chunks and again when each spec file ran alone (`--workers=1 --retries=0`, XTEST, fresh X server per file).
**Severity:** medium (estimated; deterministic assertion failures in editing commands, extent of user impact not measured).
**Tech stack:** `test/vscode-e2e/{id-insertion-mode-fidelity,link-button-url,table-operations,rewrap,marker-reveal,callout-edit,callout-arrow-nav,section-fold,bare-url-autolink}.spec.ts`; editing code in `media-src/src/editing/`.
**Depends on:** none.

## Problem

These cases fail in the full suite and again alone at `f84a4258`:

- `id-insertion-mode-fidelity.spec.ts:140` (WYSIWYG): the host text holds `before <a id="mode-wysiwyg"></a>selected prose after` where `before selected prose after` is expected at the failing comparison.
- `link-button-url.spec.ts:148` (WYSIWYG): a selected URL stays plain text, with no `[url](url)` link.
- `table-operations.spec.ts:48`: a table row is padded (`| r0a  | r0b  |`) where `| r0a | r0b |` is expected; `:242`: the WYSIWYG range transaction never becomes ready.
- `rewrap.spec.ts:116`: scroll position is not kept (`scrollKept` false).
- `marker-reveal.spec.ts:172`: the parent keeps class `vditor-ir__marker` after the caret leaves.
- `callout-edit.spec.ts:41`: click on `after paragraph` times out.
- `callout-arrow-nav.spec.ts:71`: ArrowDown does not put the caret in the callout body text.
- `section-fold.spec.ts:495`: `.vmde-block-handle` stays visible where hidden is expected.
- `bare-url-autolink.spec.ts:340`: 8 decorations where at least 10 are expected after the setting is restored.

Task 696 (rewrap) is filed separately and is not the cause of `rewrap.spec.ts:116` unless the measurement shows it. Whether the cases share one cause is not measured.

No earlier full-suite baseline exists, so the commit that introduced each failure is unknown, and whether the cases in this group share one cause is not measured.

## Proposed work

1. Find the last good commit for each failing case: run the spec alone on earlier `dev` revisions.
2. Group the cases by first bad commit and measure the cause of each group.
3. Fix each cause with a failing test first, or fix the test where the test, not the product, is wrong (state which).

## Acceptance

- [ ] Each failing case has a first bad commit (or is shown to be a test defect) and a measured cause.
- [ ] Each product cause is fixed with a test that fails before and passes after.
- [ ] The listed cases pass in one real-VS-Code run, alone and in the full suite.

## Tests to write

- A test per product cause; the listed real-VS-Code cases are the acceptance tests.

## Part 1 handoff

Read-only cause assessment (2026-11-02) at `c8775fb1`. No build, no test run. Evidence: the solo logs of the Task 695 gate at `f84a4258` (one spec file per Playwright run, fresh X server), the fresh solo rerun at `c8775fb1` (only `bare-url-autolink`, `callout-arrow-nav` and `callout-edit` had logs when this was written; all three fail with the same messages as at `f84a4258`), earlier run logs of Tasks 644 and 670, the `tasks/done/` records, and `git log` of the specs and product paths. Probabilities are estimates from that evidence, not measurements.

### Correction to the Problem section

`table-operations.spec.ts:48` is recorded the wrong way round. The spec expects the padded row `| r0a  | r0b  |` and receives `| r0a | r0b |`. The received row equals the fixture source (`fixtures/table-nav.md:7`) and the IR expectation of the same test (`:81`).

### Cases, last pass and causes

| Case | Last recorded pass | First recorded failure | Ranked causes (probability) | Call |
|---|---|---|---|---|
| `id-insertion-mode-fidelity.spec.ts:140` WYSIWYG (fails at `:181`, after a direct `vditor.undo.undo` call the host still has the inserted ID) | 2026-11-01 06:17, Task 644 R1 run (IR, WYSIWYG and SV pass; committed as `32d6bf84`) | Task 695 gate at `dc622900`/`f84a4258` (SV also failed in the suite but passes alone) | `79c0a367` (Task 685: exact-action Undo and Redo through VS Code history; its record says IR and WYSIWYG replays changed and other exact-action specs were not rerun) 0.30; `80871f91` (Task 692: deferred history base before an action's checkpoint; Insert ID is the first action after open) 0.25; `446e7aa0` (Task 688: seed the undo history before first actions after open) 0.20; `e7e73b39` (Task 673) 0.05; test defect (the direct Vditor undo call is no longer the supported route) 0.15; environment 0.05 | product defect, regression in `32d6bf84..f84a4258` (22 product commits) |
| `link-button-url.spec.ts:148` WYSIWYG (toolbar Link on a selected URL; host text unchanged, no brackets at all, so nothing was written) | Task 512/483 records (2026-08); no later recorded run found | Task 695 gate | Not on the selection-bubble path: the toolbar calls `insertMarkdownLink` (`media-src/src/chrome/toolbar.ts:145`), unchanged since `ccfe1357` (2026-10-17). Candidates: range or write lost in WYSIWYG after `6dede194` (Task 643, deferred edit view and mode-switch changes) 0.20; `ce4931d5`/`179fa1b8` (caret-intent retirement) 0.20; older than `32d6bf84` 0.30; test defect 0.15; `79c0a367` 0.10; environment 0.05 | product defect probable; window unknown, so the bisect starts by checking `32d6bf84` |
| `callout-arrow-nav.spec.ts:71` (ArrowDown lands in the callout, expanded, but on an empty text node: `anchorText` is `""`) | 2026-10-19 (Task 670 run, passes) | Task 695 gate; again at `c8775fb1` | `4e6547d5` (Task 648: ArrowLeft/ArrowRight through revealed IR markers; element-position adjacency reveal and empty-text-node handling in `editor-caret.ts`) 0.35; `ce4931d5` or `179fa1b8` (caret intent) 0.25; `6dede194` 0.10; environment 0.10 (Playwright keys, not XTEST); other 0.20 | product defect, regression in `30426a37..f84a4258` (29 product commits) |
| `bare-url-autolink.spec.ts:340` (after the setting returns to on, the Split preview has 8 decorations, not 10) | 2026-10-18 (Task 655 round 5, 5 of 5) | Task 695 gate; again at `c8775fb1` | `6dede194` (Task 643: own Preview renderer, "decorating observers wait while a Preview streams", `live-config.ts` and `finish-init.ts` changes) 0.50; `e39bb013` (Task 691: immediate Preview render) 0.15; other 0.25; test defect 0.10 | product defect probable; same surface as Task 697 (Preview, `sv-split`) |
| `table-operations.spec.ts:48` (WYSIWYG rectangle copy) | before 2026-09-27 | Task 578 relay 6/7 (2026-09-27), when the spec moved from DOM-dispatched keys to XTEST; also red before `1d8e37a9` (Task 607) | Expectation pinned to the output of the old DOM-key journey; the received row equals the source 0.80; product WYSIWYG copy defect 0.20 | test defect probable (changing the assertion needs the orchestrator's approval) |
| `table-operations.spec.ts:242` (mode stays `ir`, so the WYSIWYG readiness wait times out) | not found | red before `1d8e37a9` (Task 607, 2026-10-14) | The spec clicks the mode menu right after `.vditor-ir td` appears, with no router or editor readiness wait (`:48` waits and its switch works) 0.65; product drops an early mode click 0.35 | test defect probable; if the probe still stays in IR, product defect |
| `marker-reveal.spec.ts:172` (fails at `:165`, `parentClass` still a marker after Home/End) | 2026-11-01 default-screen run in Task 612 (passes there; racy) | Task 648 record (2026-11-01): fails on unchanged `editor-caret.ts` | Race in the check: the poll before `:165` is already true before the key (the node was expanded before Home/End), so `:165` reads the caret once before the frame that moves it 0.75; product caret lands inside a marker 0.25 | test defect probable |
| `rewrap.spec.ts:116` (fails at `:423`, `scrollKept` false; the same test also fails at `:308` in other runs) | not found | Task 606 (2026-10-14) "known `scrollKept: false`"; Task 669 "alternates between `:308` and `:423`, known failure (timing)" | Exact `scrollTop` equality after a document reflow and caret restore; timing 0.50; product does not keep the scroll position 0.40; other 0.10 | not decided; needs the probe |
| `callout-edit.spec.ts:41` (fails at `:126`, the click on `after paragraph` is intercepted by `.vmde-callout-controls` in `.vmde-callout-context-panel`) | Task 518 batch (2026-09) | 2026-10-19, Task 670 run, also in its `[baseline]` run before Task 670 | The callout context panel (Task 527, `3bcd8a77`) covers the next paragraph and the spec clicks the element centre 0.55 (test defect); product layout defect: the panel covers editable text 0.45 | open: test or product depends on the panel clearance contract (see open decisions) |
| `section-fold.spec.ts:495` (fails at `:1000`, the block handle stays visible after the post-normalization decline) | not found | Task 641 (2026-10-15): fails the same way on its parent build, "pre-existing, not on the known list" | `bb4cbf18` (Task 607: show the block handle once a background exact-authority acquire succeeds, 2026-10-14) re-shows the handle 0.45; older cause 0.30; test expectation stale after Task 607 0.25 | not decided; bisect pair below |

Environment: the X server upgrade (2026-11-01) and the Task 693 XTEST keymap limit explain none of the cases with a good probability. Six cases were already red before 2026-11-01, and the typed text in the others is ASCII. Probability that one environment cause explains all cases: 0.03.

### Groups

- **G1, recent WYSIWYG command regressions (product):** `id-insertion-mode-fidelity:140` WYSIWYG, `link-button-url:148`. Both are WYSIWYG toolbar commands whose IR case passes. A shared cause is possible (0.35), not shown.
- **G2, recent caret-landing regression (product):** `callout-arrow-nav:71`.
- **G3, Preview decoration (product):** `bare-url-autolink:340`. Same surface as Task 697.
- **G4, failures older than this queue run, mostly in the specs:** `table-operations:48` and `:242`, `marker-reveal:172`, `rewrap:116`, `callout-edit:41`, `section-fold:495`. Each has its own cause. They do not share a cause with G1 to G3.

### Proposed split (orchestrator decides)

- Move `bare-url-autolink:340` to Task 697 (Preview renders); bisect it there together with `sv-split`.
- File a new task for G4 ("Pre-existing real-VS-Code failures in table-operations, marker-reveal, rewrap, callout-edit and section-fold"). It needs probes and test-only fixes, plus one bisect pair (`section-fold`), not a bisect over this queue run.
- Keep G1 and G2 in Task 699: one bisect over `30426a37..f84a4258` covers all three cases.

### Part 2 plan

Scratch worktree for earlier revisions: `../vmde-wt/699-bisect` (`git worktree add --detach`, links and copies as in the common rules), `node build.mjs` per revision. Run each revision's own spec files. They are unchanged in the window, except that `id-insertion-mode-fidelity` exists only from `32d6bf84`.

**B1, bisect for G1 and G2.** One wrapper call per revision, about 3 min of tests:
`id-insertion-mode-fidelity.spec.ts:140 -g "in wysiwyg" link-button-url.spec.ts:148 callout-arrow-nav.spec.ts:71` (from `32d6bf84` on; before it, only the last two).

1. Ends: `c8775fb1` (expected: all 3 fail) and `32d6bf84` (expected: id-insertion passes; the other two are unknown).
2. Direct candidate pairs, before a blind bisect:
   - id-insertion: `fbe97b56` vs `79c0a367`, `927cffac` vs `80871f91`, `80871f91` vs `446e7aa0`.
   - callout-arrow-nav: `30426a37` (expected pass) vs `4e6547d5^` vs `4e6547d5`.
   - link-button-url: `ce4931d5^` vs `ce4931d5`, `6dede194^` vs `6dede194`.
3. If no pair flips a case, bisect the product commits of the window (list: `git log --reverse --oneline 30426a37..f84a4258 -- media-src/src src media/vditor ':!*.test.ts'`). Midpoints: `2a66d831` for `32d6bf84..f84a4258`, then halves. For link-button-url, if `32d6bf84` also fails, go back to `30426a37`, then `b777fe7d`, then `1d8e37a9`.
4. Confirm each first bad commit by a second run at it and its parent (2 of 2 each).

**B2, `section-fold.spec.ts:495` (G4).** `bb4cbf18^` vs `bb4cbf18`, about 1 min each. If both fail, record it as older than Task 607 and probe the handle-visibility rule on `c8775fb1` instead of bisecting further.

**Probes on `c8775fb1` (G4, one wrapper call, private copies of the specs under `tmp/699/`).** Each probe changes one thing:
- `marker-reveal`: replace the one-shot read at `:165` with `expect.poll` on `parentClass`. Expected: the case passes, so it is a test defect. If the poll times out, it is a product caret defect.
- `table-operations:242`: add the `:68` readiness wait (`routerReady && mode === 'ir'`) before the mode click at `:265` to `:273`. Expected: the mode switches and the case runs on. If the mode still stays `ir`, the product drops the mode click.
- `table-operations:48`: log `wysiwyg.markdown` beside the fixture row. Expected `| r0a | r0b |`. The assertion change needs approval (open decision 1).
- `rewrap:116`: log `saved.top`, `scrollTop` and `scrollHeight` before and after `vmde.rewrapDocument`, 3 runs. A difference of 0 to 1 px that varies between runs means a test tolerance issue. A stable larger jump (caret scrolled into view) means a product defect.
- `callout-edit:41`: through CDP, read the rects of `.vmde-callout-context-panel` and of the `after paragraph` element just before `:126`. Compare them with what `contextual-panel-clearance.spec.ts` guarantees.

**Failing tests to write first (Part 2, after each cause is measured):**
- G1 id-insertion: none to write; `id-insertion-mode-fidelity.spec.ts:140` WYSIWYG is the red test. Add a Vitest case in the module the first bad commit touches (for example `src/writeback/history-coupling.ts` or `media-src/src/editing/undo-keybind.ts`) that covers a Vditor-side Undo of a WYSIWYG exact action as the first action after open.
- G1 link: `link-button-url.spec.ts:148` is the red test; add a Vitest case on the WYSIWYG range read by `insertMarkdownLink` when the cause is in the range or write path.
- G2: `callout-arrow-nav.spec.ts:71` is the red test; add an `editor-caret.test.ts` case that covers ArrowDown into a collapsed callout and its first text node (not an empty text node) when the cause is `4e6547d5`.
- G4: the fixed specs are the tests. Show red to green against the unchanged product.

Affected paths (expected): `media-src/src/chrome/toolbar.ts`, `media-src/src/editing/editor-caret.ts`, `media-src/src/editing/undo-keybind.ts`, `src/writeback/history-coupling.ts`, `src/writeback/writeback-controller.ts`, `media-src/src/nav/block-handle.ts`, `media-src/src/links/bare-url-decorate.ts` (if not moved to Task 697), and the G4 spec files.

### Open decisions

1. `table-operations.spec.ts:48`: may Part 2 change the WYSIWYG expectation to the source row `| r0a | r0b |`, which equals the IR expectation? Recommendation: yes, after the probe shows the received row equals the fixture.
2. `callout-edit.spec.ts:41`: may the callout context panel cover the paragraph after the callout? If yes, fix the test (click a point outside the panel, or leave by keyboard). If no, it is a product layout defect, outside the caret scope of this task.
3. The split above.

### Orchestrator decisions

- Provisional decision (2026-11-02), reversible: split by cause. Task 699 keeps G1 (`id-insertion-mode-fidelity:140` WYSIWYG, `link-button-url:148`) and G2 (`callout-arrow-nav:71`). `bare-url-autolink:340` moves to new Task 702 with `sv-split:31` from Task 697 (Split View and Preview regressions). G4 (`table-operations:48`/`:242`, `marker-reveal:172`, `rewrap:116`, `callout-edit:41`, `section-fold:495`) moves to new Task 703 (older failures, probes first).
- Part 2 runs in two steps: P2a bisect B1 (measure only, no product change), then P2b fix with the failing tests first, after the orchestrator reviews the first bad commits.

## Part 2a results

Measurement only (2026-11-02). Real-VS-Code runs through the wrapper, one `node build.mjs` per revision in a scratch worktree (removed afterwards), logs in `tmp/699/bisect-<rev>*.log` (not tracked). Case selection: `file:line` combined with `-g` does not select the WYSIWYG case, so the runs used whole spec files with `-g 'in wysiwyg$|WYSIWYG: a selected URL becomes|ArrowDown from the paragraph above enters'`; later solo runs used one spec file, one `-g` and `--repeat-each`. Notation: pass/total runs of the case at that revision. All runs used `--workers=1 --retries=0`, `VMDE_XTEST=1`.

### Result summary

| Case | First bad commit | Confidence |
|---|---|---|
| `callout-arrow-nav.spec.ts:71` | `11208300` fix(671): prove Details and callout targets on normalizing documents | confirmed: 3 of 3 fail at it (plus 2 mixed-run fails), 3 of 3 pass at parent `ce4931d5` (plus 2 mixed-run passes) |
| `link-button-url.spec.ts:148` | `3d9855e7` fix(628): publish the boundary state before recording its undo entry | strong, not 2 of 2 clean: 0 of 8 pass at it; parent code (`072cfedd` and docs-only `5210dfa0`, identical product code) passes 12 of 14. The case is flaky at the parent at about 15 percent |
| `id-insertion-mode-fidelity.spec.ts:140` WYSIWYG | none found | flaky at every revision that has the spec (see below); not a bisectable regression |

### callout-arrow-nav.spec.ts:71

Failure at the bad commit (same at `c8775fb1`): `expect(received).toContain(expected)`, expected substring `callout body text`, received `""`.

| Revision | Result |
|---|---|
| `30426a37` | pass (1, mixed with link) |
| `32d6bf84` | pass (mixed x3: 3 of 3) |
| `6dede194` | pass (1) |
| `ce4931d5` | pass (mixed x2, solo x3 = 5 of 5; the parent `90611a6b` also passed, 1) |
| `11208300` | fail (mixed x2, solo x3 = 0 of 5) |
| `5aaf5d16` | fail (1) |
| `2a66d831`, `79c0a367` | fail (1 each) |
| `c8775fb1` | fail (mixed x2, solo x3 = 0 of 5) |

Candidates `4e6547d5` and `4e6547d5^` were not needed: `4e6547d5` is older than `32d6bf84`, where the case passes. Files changed by `11208300` in the exercised path: `media-src/src/editing/callouts.ts`, `media-src/src/editing/details-toggle.ts`, `media-src/src/editing/rewrap-command.ts` (plus tests and a fixture).

Reading (not measurement): `callouts.ts` now captures a `Range` clone when the callout panel renders and, on a normalizing document, proves the callout offsets through `captureRewrapSourceRange` instead of mapping lines. Callout controls or the ArrowDown landing may now run that capture or the changed rewrap path and leave the caret on an empty text node. The `anchorText` of `""` suggests the caret write or the Range clone touches selection state on entry.

### link-button-url.spec.ts:148

Failure at the bad commit: `expect(received).toContain(expected)`, expected substring `[https://example.com/a-paper](https://example.com/a-paper)`, received the unchanged `# Links` document (no brackets written; poll timeout 20000 ms).

Important: the case is order-dependent. In mixed runs (callout, id-insertion, link in one session) it fails at revisions where it passes alone (`b54b4a71`, `8d1def9b`: 3 of 3 pass solo, fail in a mixed run). Only solo runs are used below.

| Revision | Result (solo unless noted) |
|---|---|
| `c8775fb1`, `32d6bf84` | fail 3 of 3 each |
| `ccfe1357`, `30426a37`, `f67c6767`, `24044615` (parent of `f67c6767`), `4083e92c`, `cafd59bb` | fail 2 of 2 each |
| `3d9855e7` | fail 0 of 8 pass (x2 and x6) |
| `5210dfa0` (docs-only parent, same product code as `072cfedd`) | pass 7 of 8 (x2: 1 pass 1 fail; x6: 6 pass) |
| `072cfedd` | pass 7 of 8 (x2: 2 pass; x6: 5 pass, 1 fail) |
| `c8460d23` | pass 2 of 2 |
| `b54b4a71`, `8d1def9b`, `5ed045ac`, `1d8e37a9` | pass 3 of 3 each |

Files changed by `3d9855e7` in the path the case exercises: `media-src/src/editing/undo-boundaries.ts` (6 lines: `settled.options?.input?.(vditor.getValue())` moved before `checkpointUndoBoundary`). Tests changed: `undo-boundaries.test.ts`, `undo-boundaries-harness.ts`, `undo-boundaries.spec.ts`, `test/backend/history-coupling.test.ts`.

Reading (not measurement): the toolbar Link runs through the undo boundary; the new order posts the edit to the host before the boundary entry is recorded, so the host may now see a write that the following selection write or the entry flush discards or that arrives out of order, leaving the host text unchanged. The 15 percent failure rate at the parent shows a timing race exists already; the commit makes it deterministic.

### id-insertion-mode-fidelity.spec.ts:140 (WYSIWYG)

Failure (all failing revisions): `expect.poll(() => docText(...)).toBe(initial)` at `:181` times out at 20000 ms. The host keeps `before <a id="mode-wysiwyg"></a>selected prose after`; the expected text is `before selected prose after`.

| Revision | Result |
|---|---|
| `32d6bf84` (the last recorded pass) | pass 3 of 7 (mixed r1 fail, r2 fail, r3 pass; solo x4: 2 pass 2 fail) |
| `90611a6b` | fail (1) |
| `ce4931d5` | pass (2 of 2, mixed) |
| `6dede194` | pass (1) |
| `5aaf5d16` | pass (1) |
| `11208300`, `2a66d831`, `79c0a367` | fail (11208300 x2; the other two x1) |
| `c8775fb1` | fail 4 of 6 (mixed x2 fail; solo x4: 2 pass 2 fail) |

The case fails about half the runs at its own introduction commit, so there is no clean window and the candidate pairs (`fbe97b56` vs `79c0a367`, `927cffac` vs `80871f91`, `80871f91` vs `446e7aa0`) cannot separate a regression from the base flake. They were not run: the ends already show the same rate. Files: none identified. Conclusion for the orchestrator: `id-insertion-mode-fidelity.spec.ts:140` WYSIWYG is a flaky case at `32d6bf84`, not a regression of `32d6bf84..f84a4258`; the direct `vditor.undo.undo` call is the suspect (Part 1 test-defect cause, 0.15) and needs a repeat-based probe, not a bisect.

### Other observations

- Pass counts come from `tmp/699/bisect-*.log`. The messages at `c8775fb1` match the Part 1 handoff.
- No product or test file was changed; the scratch worktree was removed.

## Part 1b handoff (2026-11-08)

Read-only mechanism and fix design at `5559608c`. No product or test change. Evidence: the diffs of `11208300` and `3d9855e7`, the current source, the Part 2a logs in `tmp/699/` (not tracked), and one Node probe (`tmp/699/split-probe.cjs`, output `tmp/699/split-probe.log`). No real-VS-Code run. Probabilities are estimates.

### Case 1: `callout-arrow-nav.spec.ts:71` (first bad `11208300`)

**Mechanism (read, then confirmed by the DOM probe; confidence 0.9).** `11208300` added `const target = captureCalloutActionTarget(window)` at the top of `renderIrPanel` (`media-src/src/editing/callouts.ts:1181`). ArrowDown enters the collapsed callout: `callout-nav.ts` puts the caret at offset 0 of the text node `callout body text`. The `selectionchange` frame (`updateFromSelection`) finds a new blockquote and calls `renderIrPanel`. In IR the capture runs `captureRewrapSourceSelection` → `captureRewrapSourceRange` → `markerSourceSelectionFromDom` (`media-src/src/editing/rewrap-command.ts:285`). That function calls `startRange.insertNode(startNode)` on a range collapsed at offset 0 of a Text node. Per the DOM standard `insertNode` first runs `splitText(0)`: the original node keeps `""`, a new node gets `callout body text`, and the marker goes between them. A live range at (original, 0) does not move on that split. The `finally` block removes the marker but does not merge the halves (deliberate, see its comment). The selection is left at offset 0 of the empty text node: `anchorText ""`, `anchorOffset 0`, which is the recorded failure. The Range clone that the capture stores is taken before the split, so it ends in the empty node too.

The probe (jsdom, same DOM algorithm) gives: caret at the start, nodes `["", "callout body text"]` and anchor `""`/0. Caret at the end, nodes `["callout body text", ""]` and anchor `callout body text`/17. This explains why only the ArrowDown case fails: the ArrowUp case (`:96`) lands at the end of the text node, and there the split leaves the caret in the full node.

**Fix design.** Owned file: `media-src/src/editing/callouts.ts` (and its test).
- `renderIrPanel` takes no marker capture any more. It keeps only a clone of the live Range, when that Range lies inside the active mode element: no DOM mutation, no serialization.
- `captureCalloutActionTarget(win, held?: Range)` gets an optional Range. With `held` (IR/WYSIWYG), it uses that Range in place of the live selection: `range = held.cloneRange()` is taken before the capture, and `selection = captureRewrapSourceRange(win, held)`, the same call `captureLegacySelection` makes with the live range. Without `held`, the behavior does not change (SV branch, Details, toolbar callout path).
- The panel's `apply` and `remove` callbacks call `runConfiguredCalloutAction(action, captureCalloutActionTarget(window, heldRange))` at click time, before `dismiss()`. If `heldRange` is missing or no longer inside the editor, they pass `undefined`, so `runCalloutAction` captures the live selection as it did before Task 671.
- Add a comment at the held Range that says why the panel must not capture at render time: the marker insertion splits the caret's text node and strands the caret on an empty node.

**Why Task 671 stays green.** The Task 671 IR panel test (`callouts.test.ts`, "applies to the proven block when the selection has left the editor by the time Apply is pressed") removes the selection before `apply.click()`. The held Range still points into the editor, so the apply-time capture maps it, `exactCalloutOffsets` proves its clone, and the posted Markdown is the same. The Task 630/671 exact-authority cases call `captureCalloutActionTarget(window)` with no Range, so their path does not change. Details (`details-toggle.ts:81`) also calls it with no Range. The marker capture still runs once, at apply time, which is what happened before Task 671. There the action replaces the DOM and `dismiss()` refocuses the editor, so the split is harmless.

**Performance intent.** This change removes work from the caret path. Today every first caret entry into a blockquote serializes the whole editor (`serialize(editor.innerHTML)` in the marker capture) inside the `selectionchange` frame. After the change that frame only clones a Range. Apply does no extra work.

**Failing test first (Vitest).** In `media-src/src/editing/callouts.test.ts` (the Task 671 IR panel `describe`, same real-Lute harness), add: "rendering the IR panel leaves the caret in its text node". Put the caret at offset 0 of the `quote paragraph` text node, dispatch `selectionchange`, flush frames, and check that the panel rendered. Then expect `getSelection().anchorNode.data` to contain `quote paragraph`, `anchorOffset` to be 0, and the quote `<p>` to have exactly one child text node. This fails before the fix (anchor `""`) and passes after it. Keep the existing Task 671 panel case as the guarantee check.

**Acceptance (real VS Code).** `callout-arrow-nav.spec.ts` (both cases) and the Task 671 callout panel cases in `exact-authority-other-actions.spec.ts`.

**Checks.** `npx vitest run media-src/src/editing/callouts.test.ts media-src/src/editing/details-toggle-controls.test.ts media-src/src/editing/rewrap-non-round-trip.test.ts`, lint and typecheck as in DEVELOPMENT.md, `node build.mjs`, then the two real-VS-Code specs in one wrapper call.

**Probe needed:** no.

### Case 2: `link-button-url.spec.ts:148` (first bad `3d9855e7`)

**Path (read).** The spec dispatches a click on `.vditor-toolbar [data-type="link"]`. In WYSIWYG, Vditor's `wysiwyg/toolbarEvent.ts` (`commandName === "link"`, non-empty range) runs these steps synchronously:
1. It wraps the selection in `<a>`.
2. The `patchWysiwygLinkSelectedUrl` patch sets `href` and calls `__vmdeExplicitEdit()`, which sets `__vmdeExplicitEditPending`.
3. It opens the link popover and focuses its second input, so the live selection leaves the editor.
4. It arms Vditor's after-render timer.

The window click listener of `installUndoBoundaries` (`undo-boundaries.ts`, `onClick` → `boundary()`) schedules a `setTimeout(0)` callback. That callback runs `cancelPendingAfterRender`, which cancels Vditor's own after-render timer, so the boundary is now the only thing that can publish the link. At `3d9855e7` the callback calls `options.input(getValue())` and then `checkpointUndoBoundary`. The checkpoint's `onEntryRecorded` (finish-init) calls `flushHistoryInput({ recordedEntry: true })`, which posts the scheduled edit at once, inside the same task. Before `3d9855e7`, `input` ran after the checkpoint, so the edit went out on edit-sync's 250 ms debounce.

`[url](url)` is GFM-equivalent to the bare URL on disk. The host's minimal-diff write-back keeps the original bytes unless the edit carries `explicitBlock`. `explicitBlock` is computed once, in `postEdit`: `takeExplicitEdit` reads the flag, then `explicitBlockMd()` (`edit-sync.ts:978`) finds the block through the live selection or `trackedEditorRange()`. The flag is read once and cleared.

**Mechanism candidates (reading only, not measured; overall confidence 0.5).** They are not exclusive:
- **H2a (0.45), the flag is spent too early.** The immediate flush at time 0 consumes the flag while focus is in the popover input. `explicitBlockMd()` then depends on `trackedEditorRange()`, which may not yet point into the new `<a>` block (the `selectionchange` events from `setSelectionFocus` and the input focus are queued tasks). It returns `undefined`, the host classifies the edit as a no-op, and no later post carries the flag. Before `3d9855e7` the read happened about 250 ms later, after the tracked range had settled. The case still failed in about 15 percent of runs, when a `selectionchange` was late, which matches the flaky parent.
- **H2b (0.30), the boundary publishes nothing (from `cafd59bb` on, so at HEAD).** `equivalentToHost(markdown)` (Task 628 R2) is true for `[url](url)` against the bare-URL host text, because they render the same. The boundary then skips `input`, and Vditor's timer was already cancelled, so nothing ever posts. If this holds, it is a second deterministic blocker at HEAD on top of `3d9855e7`.
- **H2c (0.15), the edit is dropped as exact-owned.** The flush goes through `settleExactInput` (`edit-sync.ts:1230`). With `!userInputPending`, because a synthetic click fires no `input` event, and an exact transaction pair still set, it cancels the pending edit as an exact-owned re-rendering.
- Other: 0.10.

**Probe P2 (required before the fix).** Make a spec copy `tmp/699/link-button-url-probe.spec.ts` of the WYSIWYG case only. Build at HEAD and run it with `--repeat-each=4`. Just before `clickLinkButton`, install these in the frame:
1. An accessor on `window.__vmdeExplicitEditPending`. On set and on get, log `performance.now()`. On get also log: `document.activeElement` (tag and class), whether the live anchor is inside `.vditor-wysiwyg`, whether `.vditor-wysiwyg a[href="<URL>"]` exists and is connected, and whether `getValue()` contains `[<URL>](<URL>)`.
2. A wrapper on `window.vscode.postMessage` that logs `command`, `performance.now()`, whether `content` contains the link, `explicitBlock` (value or `undefined`), and `revision`.
3. A wrapper on `vditor.vditor.options.input` that logs each call and its caller (first 4 stack frames).
4. A wrapper on `vditor.vditor.undo.addToUndoStack` that logs times.

After the click, wait 1500 ms and print the log as `LINK_PROBE <json>`, together with the host's `docText`. Expected:
- H2a: `input` is called from the boundary at about t0. One `edit` post carries the link, with `explicitBlock` `undefined` and the flag read in the same millisecond. Focus is in the popover input.
- H2b: no `input` call from the boundary, no `edit` post, and the flag is never read.
- H2c: `input` is called but no `edit` post follows, and the flag is never read.
- A run in which an `edit` carries a non-empty `explicitBlock` while the host stays unchanged points at the host side (`src/writeback/`). That result would need a new reading, not one of these fixes.

**Fix design (by the probe result; each keeps Task 628's order, input before the entry's checkpoint).**
- For H2a: tie the explicit block to the node the explicit edit made, not to the caret at post time. `__vmdeExplicitEdit(node?)` stores the node it is given. The WYSIWYG patch passes `node`; the IR patch and the paste patch pass nothing and keep today's selection lookup. `explicitBlockMd()` prefers the stored node while it is connected inside the active mode element, and falls back to today's lookup otherwise. The flag stays read-once with its TTL. Owned files: `media-src/esbuild-shared.mjs` (`patchWysiwygLinkSelectedUrl`; update its anchor test in `test/backend/vditor-source-patches.test.ts`), `media-src/src/links/link-url.ts`, `media-src/src/bridge/edit-sync.ts`. This also removes the 15 percent flake at the parent.
- For H2b: an explicit edit is never "equivalent to host". Add a non-consuming `explicitEditPending(win)` to `link-url.ts` (same TTL rule). In `boundary()`'s timer, skip the `equivalentToHost` short cut while it is true. Owned files: `media-src/src/editing/undo-boundaries.ts`, `media-src/src/links/link-url.ts`. If both H2a and H2b show up, apply both.
- For H2c: `settleExactInput` must not cancel while `explicitEditPending(window)` is true. Owned file: `edit-sync.ts`.

**Performance intent.** On the typing and undo path the only addition is one read of a window property, made only where a boundary or settle already runs. No serialization, no DOM walk and no allocation when no explicit edit is pending. `explicitBlockMd` already runs only when the flag is set.

**Failing test first (Vitest).**
- H2a: in `media-src/src/bridge/edit-sync.test.ts` (or the existing Task 390 explicit-block test file), set the flag through `__vmdeExplicitEdit(node)`, move the live selection out of the editor, leave no tracked range, and flush. Expect the posted `explicitBlock` to be the node's block. It fails before the fix (`undefined`).
- H2b: in `media-src/src/editing/undo-boundaries.test.ts`, use `equivalentToHost: () => true`, a pending explicit flag, and a toolbar click. Expect `options.input` to be called once, before the checkpoint. It fails before the fix (not called). Keep the Task 628 ordering cases in that file.

**Acceptance (real VS Code).** `link-button-url.spec.ts` (IR and WYSIWYG cases), `undo-boundaries.spec.ts` (the Task 628 guarantee), and `--repeat-each=6` on the WYSIWYG case alone (the Part 2a rate was 7 of 8 at the parent, so 6 of 6 is the bar).

**Probe needed:** yes (P2).

### Case 3: `id-insertion-mode-fidelity.spec.ts:140` WYSIWYG (flaky, no regression)

**Correction to Part 2a.** The failure has two forms, not one. The Part 2a logs show 10 failures at `:181:65` (after Undo the host keeps the inserted ID) and 3 at `:188:65` (all three in `bisect-c8775fb1-id4.log`: after Redo the host keeps the initial text).

**What the logs show (measured, from the spec's own `ID_INSERTION_HISTORY` probe).**
- `:188` form: the `undone` snapshot is `undo 4, redo 0, hasUndo false`, with one more `addToUndoStack` call than at `inserted` (3 → 4). In passing runs it is `undo 3, redo 1, hasUndo true`. So the Undo worked (the `:181` poll passed), and then a late `addToUndoStack` recorded a new entry. Vditor's `addToUndoStack` clears the Redo stack when `hasUndo` is set, so the next Redo did nothing. The caller of the late entry is an anonymous function inside a function named `run` (`main.js:131:4134 < run :131:3437` at the `c8775fb1` build). The best match is the patched after-render record's `record.run` (`AFTER_RENDER_RECORD_HELPER`, `media-src/esbuild-shared.mjs`, `record.timer = window.setTimeout(record.run, delay)`), that is, a delayed Vditor after-render record whose `enableAddUndoStack` is on.
- `:181` form: no `undone` snapshot exists (the poll failed first), and `inserted` shows `undo 4` or `5`. Which entry the Undo popped is not recorded.

**Ruling.** Product race, probable (0.65): in WYSIWYG, Insert ID leaves, or a reply arms, a delayed history record that runs after the transition. The supported keyboard and toolbar routes go through the same coupled engine wrapper (`installVditorHistoryCoupling`, `undo-keybind.ts`), which also wraps the spec's direct `outer.vditor.undo.undo` call. So the direct call is not a bypass, and the Part 1 suspicion of a test defect is weaker (0.20). A user who undoes and then redoes within the record's delay would lose the Redo too. The remaining 0.15 covers a `:181`-specific cause: an extra same-text entry, so the Undo makes no text change and no `history-transition` is posted.

**Probe P3 (required).** Make a spec copy `tmp/699/id-insertion-probe.spec.ts` of the WYSIWYG case. Build at HEAD and run it with `--repeat-each=10`. Before `insertFromToolbar`, install:
1. An accessor on `vditor.vditor.wysiwyg.vmdeAfterRender`. On each set, log `performance.now()`, the record's `options` (`enableAddUndoStack`, `enableInput`) and the caller (first 6 stack frames). On each clear, log the time.
2. A wrapper on `addToUndoStack` that logs the time, the stack length before and after, `hasUndo`, and the caller.
3. A wrapper on `window.vscode.postMessage` that logs `command` and `kind`, plus the before and after lengths of `history-transition` messages.
4. A `message` listener that logs each incoming `command` with a timestamp. It is the same as the spec's, but logs times.

In the Undo `evaluate`, also log the stack lengths and `getValue()` just before and just after the engine call. Print `ID_PROBE <json>` after each of Undo, Redo and the final poll (use soft polls so all three print). Expected:
- The race for the `:188` form: a record with `enableAddUndoStack: true` is set before the Undo and fires after it, or is set after it, and its run is the late `addToUndoStack`. The set-time caller names the source: the `setValue` in `id-insertion.ts:330`, an incoming `update` or `exact-applied` reply, or something else.
- For the `:181` form: either the stack before the Undo has an entry whose text equals the inserted state (Undo before == after, no `history-transition` post), or the transition is posted and the host does not apply it (a host-side matching defect in `src/writeback/history-coupling.ts`).

**Fix design (by the probe result).**
- If the late record is armed before the Undo and is not drained: `drainPendingCheckpoint` (`undo-boundaries.ts:338`) only drains records with `enableAddUndoStack && enableInput`. A `setValue` record (`enableInput: false`) is skipped and later records an entry. Fix: in `prepareHistory`, retire, not run, an armed record that has `enableAddUndoStack` and no `enableInput` (clear its timer and `vmdeAfterRender`, as `cancelPendingAfterRender` does). Its state is the one `checkpointEditorUndo` already recorded, so the history loses nothing. Owned file: `media-src/src/editing/undo-boundaries.ts`.
- If the record is armed after the Undo, by a host reply: turn off that record's `enableAddUndoStack` through the Task 603 item 3 mechanism for the reply's `setValue`. Owned files: the router's update path and `undo-boundaries.ts`.
- If the `:181` form is a same-text entry: make the Insert ID checkpoint coalesce. Use `checkpointEditorUndoCoalescing` for the post-apply checkpoint in `id-insertion.ts:331`, so that a caret-only entry rewrites the top entry in place. Owned file: `media-src/src/editing/id-insertion.ts`.
- If the probe shows none of these, return to the orchestrator with the log. Do not guess.

**Performance intent.** `prepareHistory` already reads `owner.vmdeAfterRender`. One more flag test and a `clearTimeout` happen only on Undo/Redo, never on typing.

**Failing test first (Vitest).** In `media-src/src/editing/undo-boundaries.test.ts`: arm a WYSIWYG record with `{ enableAddUndoStack: true, enableInput: false }`, call the coupled `undo`, run the timers, then call `redo`. Expect the Redo to restore the inserted text, with the Redo stack not emptied. It fails before the fix. For the coalescing branch, an `id-insertion.test.ts` case: after Insert ID, the top entry differs from the previous one in text.

**Acceptance (real VS Code).** `id-insertion-mode-fidelity.spec.ts` (all three modes) and `--repeat-each=10` on the WYSIWYG case. The Part 2a rate was about 50 percent, so 10 of 10 is the bar.

**Probe needed:** yes (P3).

### Batching for Part 2

P2 and P3 can run in one wrapper call after one `node build.mjs` at HEAD (two spec copies under `tmp/699/`). Case 1 needs no probe and can be fixed in the same round. Run the acceptance specs of all three cases in one combined real-VS-Code call after the fixes.

### Open questions (orchestrator decides)

1. `markerSourceSelectionFromDom` leaves a split, empty text node under any live caret that sits at offset 0 of a text node. This affects every marker capture caller (Details, links, anchors, emoji, math, Turn Into). They run at action time, so no failing case is known. Options: (a) fix only the callout panel (recommended: it is in scope and is the only caller that captures on caret movement); (b) also merge the split halves in the `finally` block while keeping the live selection, which touches every caller and conflicts with the comment there; (c) file a follow-up task for (b). Recommendation: (a) now, plus (c).
2. Case 3 is likely a product race, not the test defect that Part 1 suspected. If P3 confirms it, it stays in Task 699 (same undo files as case 2). Recommendation: keep it in 699.

### Orchestrator decisions on the Part 1b questions (2026-11-08; provisional, on the Owner's behalf, reversible)

- **Q1:** fix only the callout panel capture in this task (the only caller that runs on caret movement); the general empty-text-node split of the marker capture at offset 0 becomes a follow-up.
- **Q2:** case 3 (`id-insertion-mode-fidelity:140` WYSIWYG) stays in Task 699 as a product race (it shares the undo files with case 2).
- **Part 2 order:** P2b = case 1 failing test and fix, plus probes P2 (case 2) and P3 (case 3) in one wrapper call; P2c = the case 2 and case 3 fixes chosen from the probe results.

## Part 2b results (2026-11-08)

### Case 1 (`callout-arrow-nav.spec.ts:71`): fixed

- Files: `media-src/src/editing/callouts.ts`, `media-src/src/editing/callouts.test.ts`.
- The IR panel keeps only a Range copy at render (`rangeInside` + `liveRange` helpers). `captureCalloutActionTarget(win, held?)` takes the optional Range and, with it, calls `captureRewrapSourceRange(win, held)`. Apply and Remove build the target at click time. Without `held`, behavior is unchanged (SV, Details, toolbar, Task 630/671 exact-authority cases).
- RED: new case "rendering the IR panel leaves the caret in its text node" failed before the fix: `expected '' to contain 'quote paragraph'` (1 failed, 43 passed). GREEN after the fix.
- `npx vitest run` on `callouts`, `details-toggle-controls`, `rewrap-non-round-trip`, `details-toggle`, `rewrap-command`: 5 files, 224 tests, exit 0. `npm run lint:ci` exit 0 (one complexity finding fixed by extracting helpers). `npm run typecheck` exit 0.
- Real VS Code: `callout-arrow-nav.spec.ts` (both cases) plus an identical copy: 4 of 4 pass.
- Performance: the caret path no longer serializes the editor or mutates the DOM on blockquote entry.

### Probe P2 (case 2, `link-button-url:148` WYSIWYG), 4 runs at HEAD, logs `tmp/699/p2b-run.log`

`window.vscode` is frozen, so the first run (wrapper on `postMessage`) saw no posts; the second run replaced `window.vscode` and worked. Results:

- 2 of 4 runs: the explicit-edit flag was never set, `options.input` was never called, no `edit` post. The click did not reach the patched link branch (no link made). A pre-existing flake path, separate from `3d9855e7`.
- 2 of 4 runs: flag set at t0, `input` at +23 ms, `addToUndoStack` at +0.3 ms, one `edit` post at +2.6 ms with the link in `content`, `explicitBlock` `undefined`. The flag was never read (no getter call, no clearing set). Host text stayed unchanged.
- Reading: the post came from `flushEdit` (`edit-sync.ts` lines 1183 and 1205, reached through `onFlush` from `flushHistoryInput`), and that path never calls `takeExplicitEdit`. Only `postEdit` (line 1058) reads the flag. So H2a (flag read too early), H2b (no input call) and H2c (edit cancelled) are all not supported for these runs. New hypothesis H2d: the boundary's immediate flush uses `flushEdit`, which posts without `explicitBlock`, and the flag stays unread (stale until the 5 s TTL). Before `3d9855e7` the debounced idle path used `postEdit`, which read the flag.
- Fix direction for P2c (the orchestrator decides): make `flushEdit` read `takeExplicitEdit` and compute `explicitBlock` the same way `postEdit` does (both branches at 1183 and 1205). Then re-check H2a (tracked range at flush time) with the stored-node design. The 2 of 4 no-flag runs need their own cause (why the click does not make the link) before the 6 of 6 bar can hold.

### Probe P3 (case 3, `id-insertion-mode-fidelity:140` WYSIWYG), 10 runs at HEAD

Result: 7 pass, 3 fail. Posts were visible after the `window.vscode` replacement.

- The `:188` form (late `addToUndoStack` after Undo): 0 of 10 runs. No record was armed after the Undo with `enableAddUndoStack` true. Not reproduced.
- The `:181` form: 1 of 10 (r0). The stack held 5 entries before Undo; the 5th came from `record.run` (anonymous function in `run`) 40 ms after the `edit` post, with `before 4, after 5`. The Undo popped it: stack 5 to 4, redo 1, but the text stayed the inserted text, and no `history-transition` post followed. The host never changed. Supports the "same-text entry" branch (Undo before equals after, no transition). The late entry arrives about 77 ms before the Undo, so retiring records in `prepareHistory` would not remove it. Fix direction: coalesce or skip the duplicate entry (`checkpointEditorUndoCoalescing` at `id-insertion.ts:331`, or skip `record.run`'s add when the top entry has the same text).
- New form (2 of 10, r4 and r8): the pre-Undo wait fails. The host shows `<a id="mode-wysiwyg"></a>before selected prose after`: the ID was inserted at the paragraph start, not after `before `. The caret offset was lost between `placeCaret` and the insert. A separate caret-placement race, not an undo race (test setup or product, unresolved).
- 7 passing runs: Undo changed the text and posted a `history-transition` for Undo and Redo.

### Not done

Case 2 and case 3 fixes (per brief). Nothing staged or committed. Probe specs live in `tmp/699/` (ignored); the copies placed in `test/vscode-e2e/` for the run were removed.

## Part 1c decisions (2026-11-08)

Read-only. Evidence: the Part 2b results, `tmp/699/p2b-run.log` (re-read per event below), and the current source at `5559608c` plus the uncommitted case 1 fix. No new run. Confidence values are estimates.

### Q1. Case 2 (`link-button-url:148`)

**Form 1, link posted without `explicitBlock` (2 of 4).**

*Decision:* fix in edit-sync. `flushEdit` must read the explicit-edit flag the same way `postEdit` does. Confidence 0.85 that this removes form 1. The P2 log shows the link in the flushed `content` with `explicitBlock` `undefined` and the flag never read. The only reader is `postEdit` (`edit-sync.ts:1058`), and `flushEdit` (`edit-sync.ts:1155`, both branches at 1183 and 1205) never calls it. Before `3d9855e7` the boundary's `input` reached the host through the debounced `postIdleEdit` → `postEdit`. After it, the post goes through `flushHistoryInput` → `settleExactInput` → `pendingEdit.flush()` → `flushEdit`. This explains a deterministic break at `3d9855e7`.

*Fix design:*
- In `edit-sync.ts`, add one helper next to `explicitBlockMd`: `const takeExplicitBlock = () => (takeExplicitEdit(window) ? explicitBlockMd() : undefined)`.
- `postEdit` uses it in place of its inline expression.
- `flushEdit` calls it once before serializing and adds `explicitBlock` to the `edit` message in both branches.
- No change to the host: `editor-session.ts:590` already passes `message.explicitBlock` through, including on save.
- `rewrapDocument` flushes: the host applies `explicitBlock` only to non-exact edits (`writeback-controller.ts:451`). A rewrap flush carries the flag only when one is pending, within its 5 s TTL. Reading it there also clears a stale flag that would otherwise attach to an unrelated later post.

*Block lookup at flush time:* the flush runs in the click's own `setTimeout(0)` task, before the queued `selectionchange` events. `explicitBlockMd` falls back to `trackedEditorRange()`, which still holds the spec's pre-click selection of the URL text node. `range.surroundContents` moved that node into the new `<a>`, inside the same paragraph, so the lookup finds the right block. Do not add the Part 1b stored-node design now. Add it only if acceptance shows an `edit` whose `explicitBlock` is `undefined` while the flag was read.

*Failing test first (Vitest):* add a case to `media-src/src/bridge/edit-sync.test.ts`, or to the existing Task 390 explicit-block test file if that is where its harness lives. In WYSIWYG, set `__vmdeExplicitEditPending` to `Date.now()` with the caret in a paragraph, schedule an edit, then call `flushHistoryInput()`. Expect the posted `edit` to carry `explicitBlock` equal to that paragraph's Markdown, and the flag to be cleared. Before the fix: `undefined`, and the flag stays set. Also run a second assertion through the save flush (`flush()`).

*Performance intent:* `flushEdit` adds one window-property read and clear per flush. `explicitBlockMd` (one DOM walk up to the top-level block and one Lute block serialize) runs only while the flag is set, so the common typing, undo and save paths do no extra work.

*Task 628 guarantee:* unchanged. The boundary still calls `input` before its checkpoint, and the flush still posts before the entry; the post now only carries the block.

**Form 2, no link made (2 of 4).**

*Decision:* not settled. Confidence 0.5 that it is a test-setup race, not a product defect. A next probe is needed, not an escalation yet.

*What is known:* in these runs the patched WYSIWYG link branch never ran. No flag was set, no `input` call, no `edit` post, and no `<a>` was made. That branch runs synchronously inside Vditor's toolbar handler, so the click either did not reach Vditor's handler or the handler left early. Part 2a also measured the case as order-dependent: it failed in mixed sessions at revisions where it passed alone. Candidates, by reading:
- (a) 0.35: Vditor's toolbar handler returns early. Its known early exits are the `vditor-menu--disabled` class on the button and `wysiwyg.composingLock`. The `edit-mode` panel, opened and closed by the spec's synthetic clicks just before, can leave the Link button disabled until `highlightToolbarWYSIWYG` runs for the new selection.
- (b) 0.30: the spec's `selectText` selection is not inside `.vditor-wysiwyg` when the handler reads its range: the WYSIWYG DOM was re-rendered after the readiness wait. `range.toString() === ""` then takes the empty branch, which only makes a link when the range is inside the editor.
- (c) 0.20: the synthetic `dispatchEvent('click')` reaches a stale toolbar node: the toolbar row was rebuilt by the overflow layout after the mode switch, and `.first()` picked a detached or hidden copy.
- (d) 0.15: other.

*Probe P2b:* use the same spec copy (`tmp/699/zz-699-link-probe.spec.ts`), `--repeat-each=8`. Just before `clickLinkButton`, log:
1. For every `.vditor-toolbar [data-type="link"]` match: `isConnected`, `classList`, `offsetParent !== null`, and whether it is the node `vditor.vditor.toolbar.elements.link.children[0]`.
2. `vditor.vditor.wysiwyg.composingLock`.
3. The live selection: `toString()`, whether its `commonAncestorContainer` is inside `.vditor-wysiwyg`, and whether it is connected.
4. `vditor.vditor.wysiwyg.range?.toString()`.

Also add a capture listener on the link button for `click` that logs the time and whether `event.target` is connected. Expected results per candidate:
- (a): the `vditor-menu--disabled` class is on the button.
- (b): the selection is empty or outside the editor.
- (c): the matched node is not `toolbar.elements.link.children[0]`, or is not connected.
- None of these: the click listener did not fire, and the next step is to read the toolbar binding.

*Fix after P2b:* if (a), (b) or (c) shows up, it is a test-setup race. Wait for `e2eReadiness` and the toolbar state, and click `toolbar.elements.link.children[0]` (the element Vditor binds), or press the real button with Playwright. If the product leaves Link disabled for a user's real selection, that is a product defect, outside the 628 regression; return it to the orchestrator.

*Acceptance bar:* the 6 of 6 solo bar for `:148` holds only after both forms are fixed.

### Q2. Case 3 `:181` form (same-text entry)

*Decision:* neither proposed option as stated.
- **Coalescing at `id-insertion.ts:331` is rejected** (confidence 0.85). In the failing run r0 the entries were: pre-checkpoint (`Te`, 2 → 3), `setValue` record armed and retired (1518.0 and 1518.3), post-checkpoint (`Te`, 3 → 4), `edit` post (1527.9), then the extra entry (4 → 5) at 1567.5 from `record.run`. The duplicate is added 40 ms after line 331 has run. Coalescing there cannot remove an entry recorded later, and the duplicate itself stays a caret-only entry: the text is the same and the caret differs, because Insert ID's `requestCaret` frame moved it.
- **Skipping the add generically inside `record.run`** (patching the Task 601 helper to coalesce caret-only adds) is also not chosen. It changes every delayed Vditor entry in all three modes, which is wider than the defect.

*Mechanism (read from the log; confidence 0.7):* the late `record.run` belongs to a record that was never a live WYSIWYG record during the action. The probe watched only `wysiwyg.vmdeAfterRender`. No WYSIWYG record was set before the late run, and its run logged no clear. A WYSIWYG record's `run` clears `vmdeAfterRender` only when it is still the current record, and Insert ID had already retired the current one. In 6 of the 10 runs the same kind of `run` entry (`at run`) appears before the insert, as the WYSIWYG history's next entry soon after the switch. In r0, the fastest timeline of the set (insert posted at page time 1528 ms, against about 2900 to 4200 ms in most runs), it lands after the insert. That fits a record armed in IR (open or switch) whose timer (IR `undoDelay` 800 ms plus delay) fires after the switch. Its body calls `vditor.undo.addToUndoStack(vditor)`, which records into the current mode's (WYSIWYG) history. `cancelPendingAfterRender` and `cancelPendingUndoSnapshot` retire only the current mode's record (`pendingTimer` and `inner[inner.currentMode]`), so an exact action in WYSIWYG never retires a pending IR record.

*Fix design:*
- Retire the after-render records of all three mode owners wherever a pending record is cancelled before an exact checkpoint.
- New exported helper in `media-src/src/editing/undo-boundaries.ts`: `retireAfterRenderRecords(inner)`. For `ir`, `wysiwyg` and `sv`: if `owner.vmdeAfterRender` is set, `clearTimeout(record.timer)` and set it to `undefined`. For the current mode also keep today's `clearTimeout(pendingTimer(inner))`.
- `cancelPendingAfterRender` (`undo-boundaries.ts:144`) and `cancelPendingUndoSnapshot` (`rewrap-command.ts:663`) call it in place of their current-mode-only retirement. That covers `checkpointEditorUndo`, `checkpointEditorUndoCoalescing`, every exact action and the boundary timer.
- Comment: say that a record armed in another mode runs its body against the current mode's history.
- Leave `drainPendingCheckpoint` as it is: it drains only the current mode's input record before a transition.

*Why the Task 601, 603 and 628 guarantees hold:*
- A record of a mode that is not current has no edit the current history needs: the current mode's pre-checkpoint records the live state. So retiring it loses nothing.
- Task 628's order (input, then the entry) is unchanged.
- Task 603's flag handling only matters for a record that is still armed, so it does not apply here.

*Confirm before the fix (probe P4, one cheap run):* same P3 spec copy, `--repeat-each=10`. Install the `vmdeAfterRender` accessor on all three owners (`ir`, `wysiwyg`, `sv`) right after the open readiness wait, before `switchMode`, and log the owner name with each set, clear and run. Wrap each record's `run` at set time to log `run` with its owner. Expected (0.7): the late entry's record has owner `ir`, is set before the switch, and is never cleared. If the owner is `wysiwyg` (a replaced record whose timer was not cleared), the fix moves to the Task 601 helper (`AFTER_RENDER_RECORD_HELPER` in `media-src/esbuild-shared.mjs`): clear the previous record's `timer` when re-arming. The Vitest case below then targets that helper.

*Failing test first (Vitest):* add to `media-src/src/editing/undo-boundaries.test.ts`, or `rewrap-command.test.ts` next to the `checkpointEditorUndo` cases. Set `currentMode: 'wysiwyg'`, and give `ir.vmdeAfterRender` a record whose `run` calls `inner.undo.addToUndoStack(inner)` and whose `timer` is a fake timer. Call `checkpointEditorUndo(inner)` and advance timers by 2000 ms. Expect `addToUndoStack` to be called exactly once (the checkpoint) and `ir.vmdeAfterRender` to be `undefined`. Before the fix it is called twice.

*Performance intent:* three property reads per cancel, at exact checkpoints and boundaries only. Nothing on the typing path; `clearTimeout` runs only for an armed record.

### Q3. Case 3 new form (ID at the paragraph start, 2 of 10)

*Decision:* test-setup race, probable (confidence 0.6). This is below the 0.7 bar, so it is not definitive; the probe below can settle it.

*Reading:*
- `placeCaret` first clicks the WYSIWYG root at `(8, 8)`, which is the start of the paragraph. It then writes the selection programmatically (`setBaseAndExtent` at offset 7) and stores `wysiwyg.range`.
- Insert ID uses the selection retained by its own `selectionchange` and `pointerdown` listeners (`retainEditorSelection`, `id-insertion.ts:420-470`).
- The click's own selection handling runs in later tasks. That includes the caret authority's one-shot repairs (`editor-caret.ts:230`, `:459`) and Vditor's click handler on the WYSIWYG element. It can put the caret back at the click point after the spec's write. The toolbar `pointerdown` then retains offset 0.
- The programmatic write is not a user gesture and is not marked deliberate (Task 664). So the product may rightly treat the click as the caret intent.
- The IR and SV cases click the same `(8, 8)` point and pass, which points at WYSIWYG-only click handling.

*Probe P5 (same P3 spec copy, run together with P4):* in `placeCaret`, after `setBaseAndExtent`, log the selection's anchor node text and offset at +0, after 2 animation frames, at +100 ms and at +300 ms. Then, in a window `pointerdown` capture listener on the toolbar Insert ID button, log the live selection and `vditor.vditor.wysiwyg.range` offsets. Expected:
- Test race (0.6): the offset falls from 7 to 0 within a few frames of the write, before the toolbar click.
- Product defect (0.4): the offset is 7 at `pointerdown` but the insert lands at 0. That means Insert ID loses its retained range between `pointerdown` and submit (the dialog focus path), and it would be a product fix in `id-insertion.ts`.

*Fix if it is a test race:* in `id-insertion-mode-fidelity.spec.ts`, place the caret with real input instead of a programmatic write in WYSIWYG: click the text `before`, press `Home`, then press `ArrowRight` 7 times. That uses XTEST ASCII keys, which are allowed. Then poll until the anchor offset is 7 for two frames, before `insertFromToolbar`. Apply it to all three modes, so the spec has one path. Show RED to GREEN with `--repeat-each=10` against the unchanged product.

### Escalation

- Q1 form 1 and Q2 do not need escalation; their designs are complete. Q2 should be confirmed by P4 before the fix, and P4 picks between the two named fixes.
- Q1 form 2 (0.5) and Q3 (0.6) are below 0.7. Run P2b and P5 next, in one wrapper call with P4, before escalating. If P2b fits none of (a) to (c), or P5 shows the product branch with no clear loss point, escalate. A second opinion would then need:
  - the probe spec copies, `zz-699-link-probe.spec.ts` and `zz-699-id-probe.spec.ts`, plus their logs;
  - the attempts so far: P2, P3, and the P2b/P4/P5 logs;
  - the open uncertainty: why a synthetic toolbar click sometimes makes no link, and which handler moves the caret to the click point.

## Part 2c results (2026-11-08)

Case 1 fix from Part 2b is kept (uncommitted). Unit tests use `--config test/vitest.config.mts` (the bare `npx vitest run` fails with `VDITOR_VERSION is not defined` on files that import Vditor sources).

### Case 2 form 1: fixed

- Files: `media-src/src/bridge/edit-sync.ts`, `media-src/src/bridge/edit-sync.test.ts`.
- `takeExplicitBlock()` (one reader of the flag) is used by `postEdit` and by `flushEdit`, which adds `explicitBlock` to both `edit` messages. The block lookup runs only while the flag is set.
- RED: `flushHistoryInput()` and `flush()` cases "carries the explicit block of a pending explicit edit and clears the flag" failed with `expected undefined to be 'BLOCK-MD'`. GREEN after the fix.
- Probe confirmation (P2b run, built with the fix): in 4 of 8 runs `input` ran, the flag was read (`flag-get`) and cleared, and one `edit` carried `explicitBlock` `See [https://example.com/a-paper](https://example.com/a-pape...`.
- Open: in those 4 runs the probe still read the unchanged host text 1.5 s later (the probe's one-time read, no poll). The acceptance run below passes `link-button-url.spec.ts:148` 3 of 3 with its 20 s poll, so the host does apply the block; the probe read was too early or the host write lags. Not investigated further.

### Probe P2b (case 2 form 2, 8 runs; log `tmp/699/p2c-probe.log`)

Per run: the link button (one match) was connected, visible, without `vditor-menu--disabled`, and was the node Vditor binds; `composingLock` false; `wysiwyg.range` was `null` in all runs.
- (a) disabled button: not supported (0 of 8).
- (c) stale or unbound node: not supported (0 of 8).
- (b) empty selection: run 6 only (1 of 8): `sel.text ''`, click listener fired, no flag, no link.
- New split: runs 2, 3, 7 (3 of 8) had the full URL selected, the click listener fired and the flag was set (a link was made), but `options.input` was never called, so nothing was posted. This fits H2b (`equivalentToHost` skips the boundary's `input`, and Vditor's own after-render timer was cancelled) or another skip in the boundary timer. Not a test-setup race. Not fixed (per brief); needs a probe of the boundary timer (`equivalentToHost` result and the cancelled timer) before a fix.
- Form 2 did not appear in the acceptance run (3 of 3 pass).

### Probe P4 (case 3 late record owner, 10 runs)

- Accessors on `ir`, `wysiwyg` and `sv` were installed after the open readiness wait, before the mode switch.
- In 10 of 10 runs an `ir` owner record with `enableAddUndoStack` true existed at install time (armed at open). In 10 of 10 it was cleared while `currentMode` was `wysiwyg`, and an `addToUndoStack` whose caller is `run` landed at the same time (after the switch, in the WYSIWYG history). This confirms the owner is `ir`, a mode that is not current.
- In these 10 runs the late run came before the insert in 7 and after the first checkpoint in 3; the `:181` failure (run after the edit post) did not reproduce (0 of 10 with this probe's timing). The mechanism is confirmed; the failing timing is not.
- Fix applied (the Part 1c design): `retireAfterRenderRecords(inner)` in `undo-boundaries.ts` clears the timer and record of all three modes; `cancelPendingAfterRender` and `cancelPendingUndoSnapshot` (`rewrap-command.ts`) call it. Files: `undo-boundaries.ts`, `rewrap-command.ts` and their tests.
- RED: `rewrap-command.test.ts` "retires the other mode record, so only the checkpoint adds a history entry" (`addToUndoStack` called 2 times, expected 1) and `undo-boundaries.test.ts` "cancelling the pending callback also retires the record of a mode that is not current (Task 699)" (record run called). GREEN after the fix.

### Probe P5 (case 3 caret race)

- WYSIWYG, 10 runs, none failed: anchor offset was 7 at +0, after 2 frames, at +100 ms and at `pointerdown` on the Insert ID button (the `wysiwyg.range` offset was 7 throughout). Offset 1 at +300 ms is the dialog input taking focus. The test-race branch (offset falls before the click) was not seen. Inconclusive for the failure itself.
- The acceptance run then failed `id-insertion-mode-fidelity.spec.ts:140` in IR (1 of 3 IR runs): the host shows `<a id="mode-ir"></a>before selected prose after`, the ID at the paragraph start. So the caret race is not WYSIWYG-only, which contradicts the Part 1c reading that IR and SV pass. Not fixed (per brief).

### Checks

- `npx vitest run --config test/vitest.config.mts media-src/src/bridge media-src/src/editing`: 112 files, 3386 tests, exit 0. `test/backend/history-coupling.test.ts` and `vditor-source-patches.test.ts`: 392 tests, exit 0.
- `npm run lint:ci` exit 0. `npm run typecheck` exit 0.
- Wrapper call, `callout-arrow-nav`, `link-button-url`, `id-insertion-mode-fidelity`, `undo-boundaries` specs with `--repeat-each=3 --workers=1 --retries=0`: 26 of 27 pass.

| Case | Pass |
|---|---|
| callout-arrow-nav:71 | 3 of 3 |
| callout-arrow-nav:93 | 3 of 3 |
| link-button-url:108 (IR) | 3 of 3 |
| link-button-url:148 (WYSIWYG) | 3 of 3 |
| id-insertion IR | 2 of 3 (one run: ID at paragraph start) |
| id-insertion WYSIWYG | 3 of 3 |
| id-insertion SV | 3 of 3 |
| SV exact CRLF | 3 of 3 |
| undo-boundaries:20 | 3 of 3 |

### Open

- Case 2 form 2: runs with the link made but no `input` call (3 of 8).
- Case 3 caret race (IR and WYSIWYG): the ID lands at offset 0; needs a failing capture of the selection between `placeCaret` and the insert.
- Nothing staged or committed.
