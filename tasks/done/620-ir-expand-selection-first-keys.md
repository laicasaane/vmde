# Task 620 — IR Expand Selection stays on the inline scope on the first keys after opening

**Status:** done (2026-10-08). The Project Owner approved filing this record on 2026-10-05; closure authority is Project Owner §2a of 2026-10-07. Fixes `3e5d5996` (empty text nodes), `0dc086c3` (covered-scope rule); real-VS-Code spec `558d2877`.
**Origin:** Task 580 CP4-1 classification runs (2026-10-05). Pre-existing: the same result on the pre-580 build `8c2ec1f0` (Expand was Ctrl+E) and on HEAD `0138a286` (Expand Selection is Shift+Alt+Right, `vmde.expandSelection`).
**Severity:** medium. Expand Selection does not widen past the inline scope, so the command does nothing useful. The source is not changed.
**Scope:** IR structural selection (`media-src/src/editing/selection-scope.ts`) inside an inline IR node (for example bold) on a document with no edit since it opened. Keep the Task 580 CP2-6 inline → cell → block → document ladder.

## Problem

Open a document in IR, put the caret inside a bold span, and run Expand Selection several times. Every press selects the same inline text. Expected: the first press selects the inline text, and the second selects the paragraph.

## Measured evidence

Real VS Code 1.129.0, Linux X11, Xvfb + Openbox, OS-level XTEST keys, `--retries=0`. Large synthetic fixture `test/vscode-e2e/fixtures/large-observable-models-synthetic.md` (174,517 characters), IR. The caret was placed collapsed 3 characters into a word inside a bold IR node whose text is 20 characters. Three presses, 900 ms apart. Two runs per build gave identical results.

| Build | Key | Selection after presses 1, 2, 3 | Text-node lengths inside the inline node after presses 1, 2, 3 |
| --- | --- | --- | --- |
| `8c2ec1f0` (pre-580) | Ctrl+E | 20 characters each time, not the paragraph | `[2,0,20,0,2]`, `[2,0,0,20,0,0,2]`, `[2,0,0,0,20,0,0,0,2]` |
| `0138a286` (HEAD) | Shift+Alt+Right | 20 characters each time, not the paragraph | `[2,0,0,20,0,0,2]`, `[2,0,0,0,20,0,0,0,2]`, `[2,0,0,0,0,20,0,0,0,0,2]` |

- Each press adds 2 empty text nodes inside the bold node (one on each side of the 20-character text).
- On HEAD the selection ends move onto the new empty text nodes (start `#text` length 0, offset 0).
- Host: on HEAD the host stayed exact and clean. On the pre-580 build the host became dirty (181,855 characters, first difference at offset 66, the known large-fixture normalization).
- Evidence: session scratch logs `cls-pre1.log` and `cls-head1.log` from a temporary classification spec (`zz-cls580.spec.ts`) in a scratch worktree. Neither is committed; the numbers above are copied from them.

## Reproduction

1. Open the large synthetic fixture in IR. Do not edit.
2. Place the caret inside a bold word.
3. Press Shift+Alt+Right three times, about 1 s apart. The selection stays on the bold text.

## Suspected cause

- `handleScopeSelect` (`media-src/src/editing/selection-scope.ts:516`) → `selectNextScope` (`:492-499`) picks the first scope whose range is not `rangesEqual` (`:390`) to the current selection.
- The inline scope range comes from `inlineContentRange` (`:326`), which snaps its ends to the edge text nodes. When new empty text nodes appear between presses, the freshly computed inline range has different endpoint nodes than the current selection. `rangesEqual` never matches, so the inline scope is selected again on every press.
- The empty text nodes probably come from Vditor's `recordFirstPosition` → `addCaret` (`media-src/node_modules/vditor/src/ts/undo/index.ts:84-108`, `:227`). On each keydown while the history has one entry, it inserts and removes a `vditor-wbr` marker, which splits text nodes (the text-node split that `766eb74a` handles for the command selection snapshot). Unverified: confirm which code creates the nodes.
- Related: [Task 617](../617-first-keydown-select-all-delete.md) (the same first-keydown path desynchronizes a whole-document selection).

## Candidate approaches

1. Compare scopes by text position (for example, by the text offsets within the inline node), not by DOM node identity, or ignore empty text nodes in `rangesEqual` for scope matching.
2. Stop the first-keydown marker insert from leaving empty text nodes (normalize after `addCaret`), coordinated with Task 617 and [Task 598](598-first-edit-undo-baseline.md).

## Tests

- **Vitest:** `selection-scope` with empty text nodes added around an inline node's text: the next scope after the inline stage is the block.
- **Chromium:** fresh document, caret in bold, three Expand Selection runs: inline, then paragraph, then document.
- **Real VS Code** (build first, `--retries=0`, OS-level XTEST): the same with Shift+Alt+Right on a freshly opened document; host exact and clean.

## Execution progress

- 2026-10-05, Task 580 regression fix (uncommitted at the time of writing): `rangesEqual` in `media-src/src/editing/selection-scope.ts` now treats two ranges as equal when they cover the same characters. Two boundary points match when no character lies between them, so split text nodes, empty text nodes and element boundaries next to text no longer make the ladder re-select a stage. This is candidate approach 1. Vditor still adds the empty text nodes; the ladder ignores them.
- Vitest (`selection-scope.test.ts`): new tests for empty text nodes around the inline text (Expand widens to the block), a split text node, element-versus-text boundaries, and distinct ranges staying unequal. They failed before the change and pass after it.
- Chromium `structural-selection.spec.ts`: the Ctrl+A and Expand Selection tests (including :115, inline → paragraph → document) pass in two runs of 4 workers × 4 repeats and in one 1-worker run.
- Real VS Code with XTEST and Openbox (`shortcut-identity.spec.ts`, large fixture, IR, fresh document): the stages after the inline stage were block then document in 2 of 2 full runs. Before the change, 3 of 13 recorded runs stayed on the inline stage. The leg now asserts block then document; one run passed with the tighter assertion.
- Not yet done: a dedicated real-VS-Code three-press check on a freshly opened document with "host exact and clean" recorded as this task's own evidence, and the "unchanged after an edit" acceptance item. Do not close this task on the evidence above alone.

## Acceptance

- [x] IR, fresh document: Expand Selection inside an inline node selects the inline text, then the block, then the document (Chromium and real VS Code). Chromium: `structural-selection.spec.ts:115` loads a fresh page and presses Expand with no prior edit (15 of 15 passed on the fixed source, S3 run); it does not wait for the initial undo snapshot, so the empty-text-node path is covered by Vitest and by real VS Code S1/S3. Real VS Code: `expand-selection-first-keys.spec.ts` S1 (small fixture) and S3 (large fixture, empty nodes present).
- [x] Repeated presses do not keep adding text nodes, or the ladder ignores them.
- [x] The Task 580 CP2-6 ladder (inline, cell, block, document) and Select All are unchanged after an edit.

## Part 1 handoff (2026-10-08)

Agent `opus-medium` (Opus 5.5, requested effort medium; effective effort from the agent definition, runtime metadata unverified). Read-only.

- Commit `3e5d5996` covers the cause by mechanism: `rangesEqual` compares boundary points by covered characters (`pointsEquivalent`, `hasCharacters`), so empty or split text nodes no longer make `selectNextScope` re-select the inline stage. Vditor's `addCaret` still creates the nodes. After Task 598 (`922a0686`) the first non-modifier keydown on an empty history seeds the baseline and skips the marker insert; with one history entry and an empty redo stack, the upstream marker insert still runs on every keydown (unverified on HEAD; S1 records it).
- Existing coverage does not test a fresh document: `shortcut-identity.spec.ts` `expandLeg` runs after other legs on the large fixture (its "first keys after opening" comment is misleading), and the Chromium test does not wait for the initial undo snapshot.
- Decision: add `test/vscode-e2e/expand-selection-first-keys.spec.ts` with a small fixture `test/vscode-e2e/fixtures/expand-selection-first-keys.md` (bold span in a paragraph, bold span plus text in a table cell, several blocks).
  - S1 (fresh document, IR, OS-level XTEST): paragraph ladder `inline, block, document`; cell ladder `inline, cell, block, document`; host exact and clean; per-press text-node lengths in the strong node recorded.
  - S2 (after typing one character): the same ladders, then Select All block then whole; host unchanged by the ladders.
- RED: run S1 once on the parent of the fix (`3e5d5996^`) in a scratch worktree; expected `inline, inline, inline`. Fallback if setup fails within about 30 minutes: the recorded Vitest RED plus the 2-of-2-per-build classification table, with the reason recorded.
- Orchestrator rulings: correct the misleading `expandLeg` comment in this task; leave the Chromium spec unchanged (outside the minimum).

## Execution progress — 2026-10-08 (S1/S2 spec)

Agent `sonnet-high` (Sonnet 5.5, requested effort high; runtime metadata unverified). New spec `test/vscode-e2e/expand-selection-first-keys.spec.ts` with fixture `fixtures/expand-selection-first-keys.md`; `expandLeg` comment corrected in `shortcut-identity.spec.ts`. Real VS Code, XTEST + Openbox, `--workers=1 --retries=0`.

- HEAD: S1 paragraph ladder inline (10), block (26), document (whole); strong text nodes `[2,10,2]` on every press (no empty nodes on the small fixture); undo stack `{1,0}` before and after; host exact and clean. S2 after typing `q`: undo `{2,0}`, same paragraph ladder, Ctrl+A paragraph then whole, host unchanged by the ladders. S3 (large fixture, added because the small fixture shows no empty nodes): inline (20), block (185), document (whole), strong text nodes `[2,0,0,20,0,0,2]`, host exact and clean — passes.
- Pre-fix build `3e5d5996^` (scratch worktree, removed): S3 RED — inline, inline, inline, text nodes growing by 2 per press, matching the classification table. S1 paragraph ladder passes there (no empty nodes on the small fixture).
- New pre-existing defect, both builds: in a table cell that starts with a bold span, the ladder cycles inline, cell, inline, cell and never reaches block or document. Cause (subagent analysis): `structuralScopes` builds the cell range with `textContentsRange(cell)`, which snaps its start to the strong node's marker text node; the inline scope is then recomputed from that start and re-selected. A cell `word **cellbold**` gives inline, cell, block, document on HEAD.
- Owner decision (2026-10-08, chat): fix the cell cycle inside Task 620.
- `npm run typecheck:vscode-e2e` reports one error in an untouched file (`preview-task-checkbox.spec.ts(122,28)`, `Property 'vditor' does not exist on type 'Window'`); baseline not yet confirmed.

## Part 1b handoff — cell-ladder cycle (2026-10-08)

Agent `opus-medium` (Opus 5.5, requested effort medium; runtime metadata unverified). Read-only.

- Cause confirmed: the cell scope from `textContentsRange(cell)` starts on the strong node's `**` marker text, so the next press rebuilds the inline scope and `selectNextScope` ("first scope not equal to the selection") moves back down. The same mechanism cycles a block or document selection restored onto edge text inside a leading inline node (for example after the Vditor undo round trip). Headings and cells ending with an inline node are safe; WYSIWYG and SV are not affected (the ladder is IR-only).
- Fix: `selectNextScope` picks the first scope the current selection does not already cover, judged by characters (new `rangeCovers(outer, inner)` using `compareBoundaryPoints` plus `pointsEquivalent`). The same rule applies to the Select All fence pre-stage. `rangesEqual` and the equal-stage dedup stay.
- Vitest RED: (a) cell starting with bold; (b) paragraph starting with bold after an edge-text restore at the block stage; (d) document stage terminal after an edge-text restore; (e) fence pre-stage after a restore. Guards expected green on HEAD: (c) heading starting with bold, caret on an expanded marker.
- Orchestrator rulings: include the fence pre-stage change and its test (same mechanism); keep today's behaviour for a selection that only partly overlaps a scope; the Chromium harness case is optional and not required (real-VS-Code S1/S2 cover the cell ladder).

## Execution progress — S3 fix (2026-10-08)

Agent `sonnet-xhigh` (Sonnet 5.5, requested effort xhigh; runtime metadata unverified). Fix for the cell-ladder cycle from the Part 1b handoff, inside `media-src/src/editing/selection-scope.ts`. Uncommitted at the time of writing.

- Change: new `rangeCovers(outer, inner)` (character coverage by `compareBoundaryPoints` plus `pointsEquivalent`). `selectNextScope` picks the first scope the current selection does not already cover, and the Select All fence pre-stage runs only when the selection does not already cover the fence source. `rangesEqual` (still used by the equal-scope dedup in `structuralScopes` and by Escape) and `handleEscape` are unchanged. A selection that only partly overlaps a scope behaves as before.
- Vitest RED (`selection-scope.test.ts`, new describe `ladder never re-selects a scope the selection already covers (Task 620)`, with the fix absent): 5 failed, 70 passed. Failing for the stated reason: cell starting with bold (third press gave `cellbold`, not the table), paragraph starting with bold restored on edge text (gave `lead`, not the document), document restored on the first and last text nodes (Expand Selection and Select All each returned `true` instead of `false`), fence block restored with its start on the code text (Select All re-selected the fence source). The heading guard and the caret-on-expanded-marker guard passed on the unfixed code, as expected.
- Vitest after the fix: `selection-scope.test.ts` 75 passed (all existing tests included).
- Chromium: `media-src/e2e/structural-selection.spec.ts`, xvfb, `--workers=1 --retries=0`: 15 passed (including the :115 inline → paragraph → document and :129 cell → table → document ladders, the Select All fence legs, and the post-edit legs).
- Real VS Code 1.129.0, XTEST + Openbox with the empty-keybinding config, `node build.mjs` first, `expand-selection-first-keys.spec.ts`, `--workers=1 --retries=0`: S1, S2, S3 passed. Cell ladder in S1 and S2: inline (`cellbold`, 8), cell (`**cellbold** word`, 17), block (table text, 30), document (whole). Paragraph ladder unchanged: inline, block, document. S2 Select All: block, then whole. S3 (large fixture): inline (20), block (185), document (whole), strong text nodes `[2,0,0,20,0,0,2]` on every press. Host exact and clean after the ladders in all three.
- First real-VS-Code run after the fix: S1 and S2 failed on the classifier, not the editor. The table selection text (`NameNote**cellbold** wordplain`) also contains the cell text, so `classify` in the spec labelled the table block `cell`. The spec now tests the table/paragraph block before the cell. The editor behaviour in that run was already correct (press 3 selected the whole table, press 4 the document).
- Changed-line coverage of `selection-scope.ts` (v8, `selection-scope.test.ts`): `rangeCovers` (line 398) called 67 times, every changed line and every branch on lines 399, 577 and 588 has hits.
- Biome check on the four changed files: clean. `npm run typecheck`: clean. `npm run typecheck:vscode-e2e`: only the known `preview-task-checkbox.spec.ts(122,28)` error. `npm run typecheck:strict` reports 15 errors; the two in `selection-scope.ts` (`child = ... ?? undefined`, `liveToolbar` possibly null) are on lines outside this change.
- Acceptance items ticked above: the repeated-press item (S3 text nodes stay `[2,0,0,20,0,0,2]` while the ladder widens) and the after-an-edit item (S2 paragraph and cell ladders and Select All after one typed character, plus the Vitest cases). The fresh-document item stays open here: real VS Code S1 and S3 pass, but the Chromium run is the existing ladder tests, not a fresh-document run (see the Part 1 handoff ruling).

## Closure — 2026-10-08

Agent `sonnet-medium` (Sonnet 5.5, requested effort medium; runtime metadata unverified). Commits: `3e5d5996` (rangesEqual by covered characters), `0dc086c3` (`rangeCovers`: the ladder never re-selects a scope already covered; fixes the cell cycle), `558d2877` (real-VS-Code fresh and after-edit legs).

- **Evidence.** Vitest `selection-scope.test.ts` 75 passed (5 RED before `0dc086c3`). Chromium `structural-selection.spec.ts` 15 passed. Real VS Code `expand-selection-first-keys.spec.ts` S1, S2, S3 passed, `--workers=1 --retries=0`; S3 RED on `3e5d5996^` (inline, inline, inline). Host exact and clean in all legs.
- **Gates at `558d2877` (run individually, network-free).** `lint:ci` 0 (1,136 files); `knip` 10 findings (9 unused exports, 1 unused type; baseline 10); `jscpd` exit 0; dependency-cruiser exit 0 (webview 274 modules, no violations); `test:coverage` 332 files, 6,166 passed and 1 expected failure; `check:coverage-modules` OK, 11 modules at 0% (baseline 11). Dependency audits and the aggregate `npm run quality` were omitted by Project Owner instruction. `check:brand-identifiers` (also a `quality` stage) fails with 3 former-brand hits in `scripts/patch-vscode-test-playwright.mjs` and `test/backend/patch-vscode-test-playwright.test.ts`, files this task did not touch (not re-run on a scratch worktree).
- **Bundle (reporting only).** `main.js` 943,959 B (921.8 KiB; +252 B against the Task 603 close of 943,707 B); 352 eager modules (unchanged). Legacy budgets (608 KB, 294 modules) remain exceeded as before.
- **Other checks (from the S3 run).** `typecheck` clean; `typecheck:vscode-e2e` 1 baseline error; `typecheck:strict` 15 errors (baseline), none on changed lines.
- **Residual.** Vditor still creates the empty text nodes (`addCaret`); the ladder ignores them. A selection that only partly overlaps a scope behaves as before.
- **Jev gate (orchestrator, 2026-10-08).** `jev_gate` escalated: blast radius scored at confidence 0.17 (diff only; `rangeCovers`, `selectNextScope` and `handleSelectAll` are module-private and serve only IR Expand Selection and Select All), the real-VS-Code claim at confidence 0.37 (the run log `s3-run.log` confirms `--workers=1 --retries=0`, 3 passed, `hostExact` true and `dirty` false in S1-S3), and the gates claim was read as contradicted because `knip` and `check:brand-identifiers` exit 1 (knip at its baseline of 10; brand hits only in files this task did not change). 5 of 6 claims verified. The orchestrator reviewed these points against the logs and accepted the closure.
