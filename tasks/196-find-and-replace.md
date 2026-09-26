# Task 196 — In-editor find & replace

> **For agentic workers:** Use `superpowers:systematic-debugging` for Checkpoint 1, then `superpowers:executing-plans` for Checkpoints 2–6. Checkboxes track implementation and acceptance.

**Status:** reopened (2026-09-26): performance and source-authority rework. The original delivery (2026-08-31, `437c6793`) and the [Task 568](done/568-find-replace-match-highlighting.md) highlighting follow-up (2026-09-07, `3a8cccb3`) stand as history. Their behavior contracts carry into this rework. · **Impact:** 🔴 high · **Origin:** task 192 §2; reopened on a Project Owner report.

## Reopened 2026-09-26 — rework Find & Replace for performance

### Report

The Project Owner reports that Find & Replace performance is at its worst and the feature is no longer usable; it may be broken entirely. The whole feature must be reworked according to the performance improvements made since it shipped (Tasks 573 and 574).

### Evidence (2026-09-26, `2fc8546e` plus uncommitted planning files, after `node build.mjs`)

- **Small documents still work.** Chromium `media-src/e2e/find-replace.spec.ts` passes 7/7, and real VS Code `test/vscode-e2e/find-replace.spec.ts` passes 1/1 (9.0 s), both with `--retries=0`. The feature is not broken outright. It fails with document size.
- **Large documents hang.** A temporary Chromium probe (not committed) loaded `test/vscode-e2e/fixtures/large-observable-models-synthetic.md` in IR (see [Task 574](done/574-text-selection-performance.md) for its hash). It typed four Find queries, `F` → `Fggf`, through the widget's `input` handler. The run did not finish in 600 s.
- **Measured unit costs on that fixture (IR, Chromium, one run):** 2,560 serializable text-node candidates, which is 107 batches of 24. Each batch costs about 128 ms: a 2 ms editor deep clone plus a 126 ms whole-document `VditorIRDOM2Md`. `getValue()` costs 131 ms. The best case is therefore about 13.8 s of main-thread work per Find keystroke. A failed batch retries once per node, adding up to 24 more whole-document serializations per batch, which is consistent with the timeout. These are single-run Chromium numbers: re-measure matched runs in Checkpoint 1, and measure WYSIWYG and real VS Code there too.

### Root causes (from source, `media-src/src/editing/selection-scope.ts`)

1. **Mapping cost scales with document size multiplied by node count.** `refresh` → `cachePoints` → `sourcePoints` calls `serializeFindClone` once per 24-node batch. Each call walks all text nodes twice, deep-clones the whole editor, scans `textContent` for a sentinel, and serializes the whole clone with Lute. A failed batch retries every node individually.
2. **The mapping is rebuilt for every query keystroke and option toggle**, although it depends only on the document, not the query. Match `refresh` always calls `cachePoints` when there are matches.
3. **A full refresh runs on unrelated events.** While the widget is open, it runs on the next frame after every click and every `input` event outside the widget (`onDocumentClick` in the capture phase, and `onEditorInput`). It also runs after every editor mutation (a private `MutationObserver` recreated on each refresh). When there are matches, each of these refreshes calls `getValue()` and rebuilds the whole mapping. None of this uses the revision authority or the drained-mutation index from Tasks 573/574. While Find is open, typing or clicking in a large document pays the full cost again.
4. **Paint and reveal repeat whole-document scans.** `renderOverlays` runs on every scroll/resize frame and paints every match, not just the visible ones. `revealCurrent` does the same. For matches without a cached point, `specialMatchRange` reruns `querySelectorAll`, `fencedBodies(markdown)` and `tableCellRegions(markdown)` over the whole document, once per match.
5. **Suspected, verify in Checkpoint 1: search and replace use rendered Markdown, not the exact source.** Find searches `window.vditor.getValue()`. `applyFindReplaceResult` rebuilds the document from that string, calls `outer.setValue` (a whole-document re-render, and a second one on failure), then sends it to the host with `postExact`. Unlike block actions (`block-action-client.ts`: `snapshotExactMarkdown()`, host-verified `before`/`after`), this path can rewrite bytes that Vditor normalizes outside the matches. It can also report counts and offsets for text that differs from the file. The retry note in the original record below shows Replace All normalized a live table.

### Contracts to preserve (Task 196 and Task 568)

- One accessible widget outside Vditor's editable DOM, used in IR, WYSIWYG and SV. Ctrl/Cmd+F runs `vmde.findReplace`; Ctrl/Cmd+H stays the Headings shortcut (Task 505). Escape closes and returns focus. Enter / Shift+Enter move next / previous with wrap-around.
- Literal search, case and Unicode whole-word toggles, UTF-16/surrogate-safe offsets, including case-insensitive dotted-I. Replacement text is literal: no regex or back-references.
- Matches in prose, inline formatting, headings, lists, fenced/diagram source and GFM tables. The current match is exact and distinguishable. Source-only or unmappable matches are counted honestly, without a block highlight or a redirect to unrelated visible text.
- Match-only highlight fragments, never a containing block. The `vmde.findMatch.{color,opacity,currentColor,currentOpacity}` settings apply live. Overlays stay pointer-inert and Lute-invisible, and never enter serialized or clipboard Markdown.
- Replace edits the indicated occurrence, and Replace All edits exactly the matched ranges, as one undo step. Unrelated bytes, CRLF and Unicode are preserved. Caret, focus and scroll are restored. Save/reopen gives the same bytes. Preview stays read-only.

### Design direction (finalized in Part 1 from Checkpoint 1 evidence)

Reuse the performance foundations instead of adding a Find-private path:

- **Source authority:** search the exact source from `EditSync` (`snapshotPair().exact`), keyed by the source revision. A query keystroke or option toggle on an unchanged revision reuses the cached source and never serializes. Resolve root cause 5 before choosing between exact and rendered offsets; do not guess offsets.
- **Mapping:** map a match's source range to its block through the shared per-revision source block index (`nav/source-block-index.ts`: `read()`/`peek()`, `units[].start/end/element`, `memo(slot)`). Within a block, resolve exact text fragments lazily, and only for the current match and matches near the viewport. Use a bounded, block-scoped proof, not a whole-editor clone and serialization. Memoize per index entry. Unmappable matches stay counted and are never approximated.
- **Invalidation:** subscribe to the index's `onInvalidate`/revision changes instead of a private observer. Remove the per-click refresh. Geometry-only work (scroll, resize, zoom) reads cached ranges and paints only matches in or near the viewport (compare Task 573's viewport-bounded table geometry).
- **Replace:** plan edits on the exact source and apply them through a host-verified exact transaction (compare `block-action-client.ts` and the table-format command). Keep one undo step and preserve unrelated bytes. Measure re-render cost; avoid a second whole-document render.
- A debounce may coalesce typing, but it must not be the only fix. Use no Worker, Lute fork, new dependency, disabled feature or generated-output edit.

### Test fixture scope (Project Owner, 2026-09-26)

- Every Chromium and real-VS-Code Find & Replace test in this rework uses only `test/vscode-e2e/fixtures/large-observable-models-synthetic.md` (SHA-256 `a4a39d6f6c605eb82b0e03a236f67388bceeae9a85450b0d4285053b28299f65`). That covers new phases, migrated existing cases and acceptance runs. Do not add a small control document or another Markdown fixture. Do not edit the fixture.
- The fixture covers every rendered surface this feature must handle: prose, headings, lists, GFM tables, C# and XML fenced code, inline bold and raw HTML. Derive query terms and expected counts/offsets from the fixture's exact bytes at test time; do not hard-code counts that were copied from the rendered DOM.
- Load it in Chromium from disk as `selection-performance.spec.ts` does. In real VS Code, copy it into the test's `baseDir` before any edit, save or history journey, and verify host text and disk bytes against that copy. Keep fixture contents out of assertion diffs and diagnostic output.
- The fixture has no CRLF, surrogate pairs or dotted-I. Those contracts stay in the Vitest unit tests of the pure engine functions, which test string inputs rather than documents.

### Checkpoint 1 — Reproduce and write red regressions

**Reuse:** the synthetic fixture (see Test fixture scope), `media-src/e2e/structural-selection-harness.ts`, `media-src/e2e/find-replace.spec.ts`, `test/vscode-e2e/find-replace.spec.ts`, `test/vscode-e2e/selection-performance-probe.ts` (counter patterns), `test/vscode-e2e/helpers/xtest-input.ts`.

- [x] Record the build, mode and fixture hash. Using test-only counters, count full `getValue`/`VditorIRDOM2Md`/`VditorDOM2Md` calls, editor deep clones, index builds, long tasks and rAF gaps.
- [x] Measure these on the large fixture in IR, WYSIWYG and SV: open Find; type a 4-character query one key at a time; toggle case and word; Next/Previous across many matches; scroll with Find open; type and click in the editor with Find open; Replace; Replace All; Undo. (Undo was exercised functionally between phases to restore state for the next phase, but was not itself wrapped in the probe as a separately counted phase — see results below.)
- [ ] Migrate the existing Chromium `find-replace.spec.ts` cases (7) and the real-VS-Code `find-replace.spec.ts` case from their inline documents onto the fixture. **Chromium: done (7/7), run, and all red** — see results below. **Real-VS-Code `test/vscode-e2e/find-replace.spec.ts` small-doc case: not yet migrated** (out of scope for this pass; the new `test/vscode-e2e/find-replace-large.spec.ts` covers the large-fixture real-VS-Code evidence instead). Leaving this box unchecked until that migration lands.
- [x] Confirm or reject root cause 5. Use a fixture region that Vditor normalizes, for example table whitespace. Check whether Find counts and offsets match the exact file, and whether Replace/Replace All change bytes outside the matches (host text, disk and save/reopen). **Confirmed** — see results below.
- [x] Write red assertions as deterministic work counts, not only elapsed time. Target shape, finalized in Part 1: a query keystroke or toggle on an unchanged revision causes 0 whole-document serializations and 0 editor clones; at most 1 index build per revision; scroll/resize causes 0 serializations and paints only in-viewport matches; editor clicks cause no Find recompute.
- [x] Use OS-level XTEST input for keyboard acceptance in real VS Code. Browser-protocol input is diagnostic only.

### Checkpoint 2 — Exact-source match engine keyed by revision

- [x] Search the exact source, and cache matches per query, options and revision. Keep the pure engine functions (`findMarkdownMatches`, `replaceMarkdownMatch`, `replaceAllMarkdownMatches`) and their unit coverage. Add revision-keyed reuse and stale-result rejection tests.

### Checkpoint 3 — Index-backed, lazy, viewport-bounded mapping and paint

- [x] Replace `sourcePoints`/`serializeFindClone` whole-document probes with index-unit mapping plus bounded, block-scoped fragment resolution. Hoist fence and table region scans into per-revision memos.
- [x] Paint only the current match and in-viewport matches. Scroll and resize never serialize.
- [x] Unit tests: mapping across prose, inline, code, table and nested blocks; unmappable-match counting; surrogate pairs; a stale entry after an edit fails closed.

### Checkpoint 4 — Revision-driven invalidation

- [ ] Remove the private `MutationObserver` and the per-click refresh. Recompute on index invalidation or a revision change, coalesced to at most once per frame, and only while Find is open.
- [ ] Editing with Find open keeps the counts and the current match correct, without a whole-document recompute for each keystroke beyond the one index rebuild per revision.

### Checkpoint 5 — Exact, host-verified replace transaction

- [ ] Plan Replace and Replace All on the exact source and apply them through a host-verified exact transaction with one undo step. Unrelated bytes are identical in host text and on disk, and after save/reopen. Caret, focus and scroll are restored.
- [ ] If Checkpoint 1 rejected root cause 5, record the evidence here, and keep the current transaction only if it meets the performance gates.

### Checkpoint 6 — Integrated acceptance and closure

- [ ] The red regressions pass in IR, WYSIWYG and SV on the large fixture. Run three matched serial real-VS-Code runs and report before/after work counts and latencies.
- [ ] Focused regressions pass with `--retries=0`: Chromium `find-replace.spec.ts` (the migrated cases plus the new ones, all on the fixture) and real VS Code `find-replace.spec.ts`. Rerun `selection-performance.spec.ts`, `block-handle.spec.ts` and `large-document-interaction.spec.ts` in both layers if the shared index or `EditSync` changed.
- [ ] Task 568's highlighting acceptance: fragment geometry, live settings in light/dark, readability, and no stacked duplicate fragments.
- [ ] Changed-line coverage, typechecks and the network-free quality stages once on the final candidate. Bundle bytes and eager-module count are reporting-only.
- [ ] Record the results here, move this record back to `tasks/done/`, and restore the `tasks/README.md` checkbox only when every item is complete. Make one focused local commit per checkpoint; do not push.

### Execution progress

#### Part 1 handoff — Checkpoint 1 probes (2026-09-26)

**Code-path reading (`media-src/src/editing/selection-scope.ts`, `installFindReplace`), not measured:**

- `refresh()` runs on every find `input`, toggle, open, rAF after any editor `input`, rAF after any document `click`, and rAF after any editor mutation seen by `mappingObserver`. Each run does `getValue()` + `findMarkdownMatches`. With ≥ 1 match, it also calls `cachePoints` → `sourcePoints`: ⌈candidates/24⌉ × (`textNodes` ×2 + `editor.cloneNode(true)` + one whole-document `VditorIRDOM2Md`/`VditorDOM2Md`), plus a per-node retry of a failed batch. `cachePoints` also recreates the `MutationObserver`.
- `renderOverlays` (every scroll/resize frame) and `revealCurrent` map every match. They call `specialMatchRange` per unmapped match, which reruns `querySelectorAll` plus `fencedBodies`/`tableCellRegions` over the whole Markdown.
- The replace path: `getValue()` → engine → `applyFindReplaceResult`: `outer.setValue(marked)` (whole re-render), plus a second `setValue` on failure, then `postExact(result.markdown)`. The markdown is Vditor's serialization, not `EditSync.snapshotPair().exact` (root cause 5).
- SV maps text nodes directly and has no Lute probe. Its cost is `getValue()` plus text-node walks.

**Probe specification (Part 2, test-only).**

1. Add a `test/vscode-e2e/find-replace-probe.ts`, following the `selection-performance-probe.ts` pattern, and share it with Chromium as that probe is shared. Counters, armed per phase:
   - full `getValue`;
   - Lute `VditorIRDOM2Md`/`VditorDOM2Md`/`Md2VditorIRDOM`/`Md2VditorDOM` calls, split into whole-document vs fragment;
   - deep `cloneNode(true)` calls on the active editor root (wrap `Node.prototype.cloneNode`; count only `this === root && deep`);
   - `outer.setValue` calls;
   - `MutationObserver` constructions;
   - `indexBuilds` (`__vmdeBlockHandleCacheMetrics`, real VS Code only);
   - long tasks (count, total, max);
   - max rAF gap;
   - phase wall time;
   - `.vmde-find-overlay` count after the phase.

   Keep fixture contents out of the logs; print counts and offsets only.
2. Chromium: extend `media-src/e2e/structural-selection-harness.ts` so a spec can load the synthetic fixture: read it from disk in the spec, as `selection-performance.spec.ts` does, and `__setValue` it. Add these phases to `media-src/e2e/find-replace.spec.ts` in IR, WYSIWYG and SV:
   - open Find;
   - type a 4-character query one key at a time;
   - toggle case, then word;
   - Next ×5 and Previous ×5;
   - scroll the editor ×5 with Find open;
   - click in the editor and type one character with Find open;
   - Replace;
   - Replace All;
   - Undo.

   Derive the query at test time from the fixture's exact bytes: a 4-character token that occurs in prose, a GFM table cell and a fenced block. Report its exact-source count per region. Do not hard-code counts.
3. **The current implementation needs about 14 s per refresh on this fixture, and the planning probe did not finish.** Therefore:
   - Bound every phase with a per-phase deadline (for example 120 s), recording `timedOut` and the counters reached.
   - In IR and WYSIWYG, measure the query phase as the first keystroke plus one following keystroke rather than all four. Record the reduction.
   - Do not let the before run exceed the Playwright timeout.
   - Prefer one test per mode, so a hang in one mode does not hide the others.
4. Real VS Code (`test/vscode-e2e/find-replace.spec.ts`): copy the fixture into `baseDir` and open it in IR. Use OS-level XTEST for Ctrl+F, the query typing and Escape (`createXtestInput`, the `selection-performance.spec.ts` pattern). Measure open plus the first keystroke, one toggle and one scroll, each with a deadline, then Replace, Replace All and Undo if time allows. Verify host text and disk bytes against the copy.
5. Migrate the existing cases onto the fixture (7 in Chromium, 1 in real VS Code), keeping every asserted contract:
   - marker-safe current replace inside inline formatting (pick a fixture match inside `**…**`);
   - repeated same-block occurrences decorated as separate fragments;
   - prose/fence/table mapping (overlay count equals the mappable count);
   - Replace All across prose, fence and table, undone in one step;
   - case/word toggles and Escape;
   - WYSIWYG and SV transactions;
   - in real VS Code: Ctrl+F opens the widget, Ctrl+H opens Headings, and a saved replace persists.

   They are expected to be slow or red until Checkpoints 2–5. Gate them behind the same per-phase deadlines so the red run finishes.
6. **Root cause 5 probe.** On the fixture, compare `window.vditor.getValue()` with the exact file bytes (length, and the first differing offset and region kind, e.g. a table delimiter row). Pick a query whose exact-source count differs from its `getValue()` count, or whose offsets differ, if one exists, and record both counts. Then Replace one match outside any normalized region. In real VS Code, compare the host text and the saved disk bytes with the expected exact-byte edit, `exact.slice(0,s) + replacement + exact.slice(e)`, reporting whether bytes outside the match changed and in which region. State "confirmed" or "rejected" with the numbers.
7. **Red assertions (target shape; write them once the counters exist).** Per mode, on the fixture:
   - A query keystroke or option toggle on an unchanged revision: 0 whole-document serializations (`getValue` plus root Lute calls) and 0 editor deep clones.
   - A whole Find session with no edits: at most 1 index build (real VS Code).
   - Scroll/resize with Find open: 0 serializations and 0 clones; painted overlays ≤ the matches intersecting the viewport ± one screen.
   - An editor click with Find open: 0 serializations.
   - Replace and Replace All: exactly one `setValue` or host transaction; bytes outside the matched ranges are identical to the exact source (host and disk).

   Timing is reported, not gated. Expected to be red now.
8. Commit the probe, harness, spec phases, migrated cases and red evidence as one focused commit. Record in this section: per-mode tables, the root cause 5 verdict, the red assertion output, and commands with exit codes.

**Expected outcome.**

- IR/WYSIWYG: tens of whole-document serializations and clones per keystroke, toggle, click and scroll frame.
- SV: `getValue` per refresh, with no clones.
- Root cause 5 is likely confirmed for table delimiter/whitespace normalization.

#### Checkpoint 1 results (Part 2, 2026-09-26)

**Build and fixture.** `node build.mjs` (main.js 869.0 KB / main.css 52.9 KB this build). Fixture SHA-256
`a4a39d6f6c605eb82b0e03a236f67388bceeae9a85450b0d4285053b28299f65`, 174,527 bytes — verified by every
spec run below before use.

**Deliverables added (test-only, no `media-src/src` change):**

- `test/vscode-e2e/find-replace-probe.ts` — work-counter probe (`__vmdeFindReplaceProbe`): full
  `getValue`, `VditorIRDOM2Md`/`VditorDOM2Md`/`Md2VditorIRDOM`/`Md2VditorDOM` split whole-document vs
  fragment, `Node.prototype.cloneNode(true)` on the active editor root, `setValue` calls,
  `MutationObserver` constructions, `indexBuilds` (real VS Code only), long tasks, max rAF gap,
  `.vmde-find-overlay` count. Shared by Chromium and real VS Code, matching the
  `selection-performance-probe.ts` pattern.
- `test/vscode-e2e/find-replace-fixture-helpers.ts` — the exact fixture text/hash and derived query
  tokens (`QUERY_TOKEN='FGGF'`, `CROSS_REGION_TOKEN='ncjw'`, `PAIR_TOKEN='etkwysrw'`,
  `BOLD_TOKEN='Ldbw'`, `UNIQUE_PROSE_TOKEN='ldbsra'`), plus pure region/count/match helpers. Every
  count used in an assertion is recomputed from the loaded fixture text at test time by these
  functions; only the token *choice* is a literal, picked by a one-off analysis script (regex over
  the loaded text, never printed) and re-verified here — never a count copied from a rendered DOM.
- `media-src/e2e/find-replace-large.spec.ts` (new) — per-mode (ir/wysiwyg/sv) Chromium spec.
- `test/vscode-e2e/find-replace-large.spec.ts` (new) — real-VS-Code equivalent via OS-level XTEST.
- `media-src/e2e/find-replace.spec.ts` — the 7 pre-existing small-doc cases migrated onto the fixture.
- `media-src/e2e/structural-selection-harness.ts` — added `__scrollEditor(deltaY)` (uses the existing
  product exports `findScroller`/`activeModeElement`, no new product behavior) so Chromium can scroll
  the active mode's real container.

**Evidence goal and gating (per coordinator guidance mid-Checkpoint-1):** not a full timeline of every
phase, but "does a refresh complete, and what does ONE completed refresh cost". `query-first-keystroke`
gets a long deadline (400 s Chromium / 240 s real VS Code) so a single refresh has a real chance to
finish; once any heavy phase in a mode times out, every later heavy phase is skipped and recorded
`notMeasured: blocked by prior timeout` instead of queuing more work onto an already-busy page. Cheap
phases (navigate, scroll) still run regardless. Chromium and real VS Code were never run concurrently.

**Root cause 5 — CONFIRMED**, consistently, across every surface measured:

| Surface | `getValue()` = exact? | got bytes | exact bytes | first diff offset | region |
|---|---|---|---|---|---|
| Chromium IR | no | 181,855 | 174,517 | 66 | table |
| Chromium WYSIWYG | no | 181,843 | 174,517 | 74 | table |
| Chromium SV | no | 181,846 | 174,517 | 74 | table |
| Real VS Code (IR) | no | 181,855 | 174,517 | (same byte count as Chromium IR) | — |

`getValue()` is ~4-4.2% larger than the file in every mode, diverging within the first 100 bytes, in a
table region — before any Find interaction. Find therefore searches/replaces a string that is not the
file's exact bytes, independent of query or mode.

A second, sharper piece of evidence came from the migrated small-doc case `sv uses the same source
replacement transaction`: `UNIQUE_PROSE_TOKEN` (`ldbsra`) is verified case-insensitively unique
(count 1, at byte offset 2024) in the pristine fixture (`node` check, not the widget), yet after
`__setValue(FIXTURE)` + switching to SV the widget reported **`1/2`**, not `1/1`. This means the
IR→SV round trip does not just reformat whitespace (table column padding, the likely cause of the
byte-count growth above) — it can introduce an actual *second occurrence* of a word that has only one
occurrence in the exact source. This test is now red on that mismatch; it was not further
root-caused (out of this checkpoint's scope) and is flagged here as a concrete lead for Checkpoint 2/5.

By contrast, the mechanical Replace/Replace-All transform itself is byte-precise *relative to what it
searched*: Chromium IR's `replace-all` phase (`CROSS_REGION_TOKEN`, case-sensitive) changed exactly
the matched ranges of the live `getValue()` snapshot and issued exactly one `setValue` — so root cause
5 is specifically about the SEARCH SOURCE (`getValue()` vs exact bytes), not (on this evidence) about
the replace mechanics corrupting unrelated bytes once it has a match. The WYSIWYG `replace-all` phase's
byte-identity check did NOT match this pattern (see WYSIWYG notes below) — flagged as unresolved.

**Clone-attribution caveat.** `editorDeepClones` counts every `cloneNode(true)` on the active editor
root, not only Find's own `serializeFindClone` clone — Vditor's own Undo (`undo/index.ts:239`) and
word-Counter (`toolbar/Counter.ts:15`) modules also clone the root for unrelated reasons. Attributing
by call-stack function name was tried and found impractical: the harness serves the production bundle
(`media-src/build.mjs`: `minify: !watch`), and `serializeFindClone` does not appear as a literal in
`media/dist/main.js` (`grep -c` = 0), so a stack-trace check can never match. `rootLuteCalls`/
`fragmentLuteCalls` (whole-document/fragment `VditorIRDOM2Md`/`VditorDOM2Md`) have no such ambiguity —
nothing else in Vditor serializes the whole document on a keystroke, toggle, click or scroll — so they
are the PRIMARY attributable-to-Find signal in the tables below; `editorDeepClones` is reported for
context with this caveat, not gated as precisely.

**Chromium — IR** (`find-replace-large.spec.ts`, mode=ir; blocked after the 2nd keystroke):

| phase | wall ms | timedOut | getValue | whole-doc Lute | fragment Lute | clones | setValue | observers | long tasks (max ms) | max rAF gap ms | overlays |
|---|---|---|---|---|---|---|---|---|---|---|---|
| query-first-keystroke | 179,387 | false | 1 | 1 | 2,411 | 2,412 | 0 | 1 | 2 (169,668) | 179,360 | 3,516 |
| query-second-keystroke | 150,101 | **true** | 1 | 1 | 2,411 | 2,411 | 0 | 1 | 2 (167,911) | 168,043 | 205 |
| toggle-case | — | notMeasured (blocked) | | | | | | | | | |
| toggle-word | — | notMeasured (blocked) | | | | | | | | | |
| navigate-next5-previous5 | 1,534 | false | 0 | 0 | 0 | 0 | 0 | 0 | 9 (137) | 133 | 205 |
| scroll-x5 | 683 | false | 0 | 0 | 0 | 0 | 0 | 0 | 6 (137) | 150 | 205 |
| editor-click-type … toggle-escalation-* (8 phases) | — | notMeasured (blocked) | | | | | | | | | |

Headline: one completed keystroke refresh costs **179.4 s**, 2,411 fragment Lute serializations and
2,412 editor deep clones (one clone + one fragment serialize per 24-node candidate batch, matching the
task record's earlier ~2,560-candidate/~107-batch estimate). The very next keystroke did not finish in
150 s. Navigate and scroll stayed fast (≤1.5 s, zero Lute/clone activity) even while blocked, confirming
those code paths (`move()`, `renderOverlays`) are independent of the expensive mapping path.

**Chromium — WYSIWYG** (mode=wysiwyg; never blocked by a timeout, but the test HARD-failed on an Undo
verification after Replace All, so the remaining 3 phases were never attempted — not `notMeasured`,
genuinely not reached):

| phase | wall ms | timedOut | getValue | whole-doc Lute | fragment Lute | clones | setValue | observers | overlays |
|---|---|---|---|---|---|---|---|---|---|
| query-first-keystroke | 151,614 | false | 1 | 1 | 2,391 | 2,393 | 0 | 1 | 3,570 |
| query-second-keystroke | 140,534 | false | 1 | 1 | 2,391 | 2,391 | 0 | 1 | 205 |
| toggle-case | 141,556 | false | 1 | 1 | 2,391 | 2,391 | 0 | 1 | 42 |
| toggle-word | 116 | false | 1 | 1 | 0 | 0 | 0 | 0 | 0 |
| navigate-next5-previous5 | 341 | false | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| scroll-x5 | 12 | false | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| editor-click-type | 419 | false | 5 | 5 | 0 | 1 | 0 | 0 | 0 |
| mapping-query | 146,630 | false | 1 | 1 | 2,463 | 2,464 | 0 | 1 | 14 |
| replace-all | 2,177 | false | 5 | 5 | 1 | 3 | 1 | 0 | 0 |
| (test then failed: `expect.poll` Undo-restore check exceeded 30 s — see below) |

Every heavy phase completed in WYSIWYG (unlike IR), each still costing 140-152 s and ~2,390-2,460
fragment Lute calls/clones — confirming the same root-cause-1 mechanism (`VditorDOM2Md` in place of
`VditorIRDOM2Md`) at essentially the same per-refresh cost as IR. `toggle-word` was cheap (116 ms) —
Find only rebuilds the mapping `if (matches.length > 0)`, and by that point the query+case-sensitive
combination apparently had 0 matches, so `cachePoints` was skipped; `editor-click-type` cost 5 getValue/
whole-doc calls, not the ~2,400 of a query fill — worth a closer look in Checkpoint 3/4 (a plain click+
type should not itself force a mapping rebuild the way a query fill does, but VS Code's own
`refresh(false)` path costs something non-zero).

WYSIWYG's `replace-all` also surfaced two open items, not further diagnosed in this checkpoint:
1. The byte-identity-outside-match soft check failed: the actual post-Replace-All text had MORE
   occurrences replaced than a plain case-sensitive substring re-derivation
   (`literalMatches`/`applyReplacements` in the fixture helpers) predicted. This is most likely the
   test helper's substring search not exactly matching the product's whole-word-plus-case-sensitive
   semantics (both toggles were ON from the earlier phases) rather than a product bug, but it was not
   confirmed either way.
2. After Replace All, `__undoFindReplace()` did not restore the pre-replace `getValue()` within 30 s,
   throwing a hard (non-soft) failure that ended the test before `replace-single-bold`,
   `repeated-block-query` and the toggle-escalation phases could run. Whether this is genuine Undo
   slowness/incorrectness in WYSIWYG on this fixture, or another effect of the same expensive refresh
   still running, is unresolved and should be investigated before Checkpoint 5.

**Chromium — SV** (mode=sv; never blocked — every phase completed, all fast):

| phase | wall ms | timedOut | getValue | clones | setValue | observers | overlays |
|---|---|---|---|---|---|---|---|
| query-first-keystroke | 16,831 | false | 1 | 2 | 0 | 1 | 4,407 |
| query-remaining-keystrokes | 753 | false | 3 | 0 | 0 | 3 | 310 |
| toggle-case | 105 | false | 1 | 0 | 0 | 1 | 57 |
| toggle-word | 103 | false | 1 | 0 | 0 | 1 | 46 |
| navigate-next5-previous5 | 505 | false | 0 | 0 | 0 | 0 | 46 |
| scroll-x5 | 10 | false | 0 | 0 | 0 | 0 | 46 |
| editor-click-type | 351 | false | 5 | 1 | 0 | 5 | 46 |
| mapping-query | 74 | false | 1 | 0 | 0 | 1 | 23 |
| replace-all | 531 | false | 3 | 2 | 1 | 0 | 0 |
| replace-single-bold | 461 | false | 4 | 2 | 1 | 1 | 0 |
| repeated-block-query | 51 | false | 1 | 0 | 0 | 1 | 2 |
| toggle-escalation-fill/word/case | 183/207/88 | false | 1 each | 0 | 0 | 1 each | 310/221/46 |

SV has no Lute entry points at all (`rootLuteCalls`/`fragmentLuteCalls` are 0 throughout — SV's
`sourcePoints` branch is a plain text-node walk, confirmed by code reading). The 2 clones and 5
`MutationObserver`s on the first keystroke and editor-click phases are Vditor-internal (Undo/Counter;
see the clone-attribution caveat), not Find's own path. `query-first-keystroke` costs 16.8 s here mostly
from *painting* 4,407 overlays for a single-letter substring query (`renderOverlays` maps every match,
one DOM Range + rect computation each) — a distinct cost driver from IR/WYSIWYG's clone/serialize path,
confirming root cause 4 (paint/reveal cost scales with match count) independently of root causes 1-3.

**Real VS Code (IR)** (`find-replace-large.spec.ts`; one run, 6.6 minutes total, well under the ~10 min
guidance; blocked after `toggle-case`):

| phase | wall ms (action) | probe-measured elapsed ms | timedOut | getValue | whole-doc Lute | fragment Lute | clones | overlays |
|---|---|---|---|---|---|---|---|---|
| open | 177 | 195 | false | 1 | 1 | 0 | 0 | 0 |
| query-first-keystroke | 30 | 207,376 | false | 1 | 1 | 2,411 | 2,412 | 3,516 |
| toggle-case | 90,002 | — | **true** (probe unreachable) | — | — | — | — | — |
| scroll | — | notMeasured (blocked) | | | | | |
| replace-all | — | notMeasured (blocked) | | | | | |

`query-first-keystroke`'s OS-level key dispatch (`xdotool type`) returned almost immediately (30 ms) —
it only sends the X11 event — but the probe's own in-page timer shows 207.4 s elapsed before the
webview's main thread was free enough to run `endWorkload()`/`stop()`, with fragment-Lute-call and
clone counts (2,411 / 2,412) essentially identical to Chromium IR's same phase. This is the strongest
single piece of evidence in this checkpoint: the SAME synchronous cost reproduces, with the same
magnitude, through the real VS Code webview/custom-editor pipeline, not just in the Chromium harness.
`toggle-case` then genuinely exceeded 90 s without the frame responding at all.

**Migrated Chromium cases** (`media-src/e2e/find-replace.spec.ts`, 7 cases, `test.setTimeout(120_000)`,
per-action `timeout: 100_000`) — **all 7 failed**:

| case | result |
|---|---|
| marker-safe replace inside bold (`BOLD_TOKEN`, 1 match) | `TimeoutError: locator.fill exceeded 100000ms` |
| repeated same-block occurrence (`PAIR_TOKEN`, 2 matches) | `TimeoutError: locator.fill exceeded 100000ms` |
| prose/fence/table mapping (`CROSS_REGION_TOKEN`, 23 matches) | `TimeoutError: locator.fill exceeded 100000ms` |
| Replace All one-undo-step (`CROSS_REGION_TOKEN`) | `TimeoutError: locator.fill exceeded 100000ms` |
| case/word toggle escalation + Escape (`QUERY_TOKEN`) | `TimeoutError: locator.fill exceeded 100000ms` |
| WYSIWYG shared transaction (`UNIQUE_PROSE_TOKEN`, 1 match, globally unique) | `TimeoutError: locator.fill exceeded 100000ms` |
| SV shared transaction (`UNIQUE_PROSE_TOKEN`) | functional mismatch: widget reported `1/2`, expected `1/1` (root-cause-5 evidence above) |

Six of the seven — including the WYSIWYG case using a token with exactly **one** match anywhere in the
document — failed on the very first query `.fill()` exceeding 100 s. This directly confirms root cause
1's "cost scales with document size, not match count" claim: even the cheapest possible single-match
query on this fixture costs more than 100 s in IR/WYSIWYG, because `sourcePoints`/`serializeFindClone`
walks every serializable text node in the whole document regardless of what (or how much) the query
matches.

**Red assertions — output (soft, so every phase's evidence is reported together):**

- IR: `query-second-keystroke` — 0 whole-document Lute calls: **FAILED** (received 1); 0 editor deep
  clones: **FAILED** (received 2,411). `scroll-x5` — both **PASSED** (0/0, green as expected).
  `editor-click-type` — not reached (blocked).
- WYSIWYG: never reached the final assertion block (hard failure on the Undo-restore poll first); the
  same two phases can be read directly from the per-phase table above and are equally red
  (`query-second-keystroke`: rootLuteCalls 1, editorDeepClones 2,391; `scroll-x5`: 0/0, green;
  `editor-click-type`: fullGetValueCalls 5, red).
- SV: `query-remaining-keystrokes` — 0 whole-document Lute calls: **PASSED** (SV has none); 0 editor
  deep clones: **PASSED**. `scroll-x5` — **PASSED**. `editor-click-type` — 0 getValue calls:
  **FAILED** (received 5; Vditor-internal, see clone/getValue caveat — still non-zero, still red
  against the literal assertion).
- Real VS Code (IR): `query-first-keystroke` — 0 whole-document Lute calls: **FAILED** (received 1);
  0 editor deep clones: **FAILED** (received 2,412). `scroll`/whole-session-index-builds — not reached
  (blocked); `indexBuilds` was 0/uninstrumented in every phase actually measured.

**Commands and exit codes:**

- `node build.mjs` — ok.
- `npm run typecheck` (media-src) — clean on every check in this pass.
- `npm run typecheck:vscode-e2e` — only the pre-existing `preview-task-checkbox.spec.ts(122,28)` error,
  unchanged; no new errors added.
- `npx biome check --write <changed files>` — clean (a handful of empty-catch-block, unused-variable
  and one excessive-cognitive-complexity finding were fixed along the way; the last one carries a
  `biome-ignore` with a reason comment per `.agents/rules/ts.md`).
- `xvfb-run -a npm --prefix media-src run test:e2e -- find-replace.spec.ts find-replace-large.spec.ts --retries=0 --workers=1`
  → **rc=1** (10 failed, all expected-red — see tables above). ~14 minutes wall time (IR ~7 min,
  WYSIWYG ~9 min including its hard failure, SV ~25 s, migrated cases ~9 min).
- `/tmp/xtest-run.sh <log> find-replace-large.spec.ts` (real VS Code, `env … xvfb-run -a … npm --prefix
  test/vscode-e2e test -- find-replace-large.spec.ts --workers=1 --retries=0`) → **rc=1** (1 failed,
  expected-red), 6.6 minutes wall time.
- Real-VS-Code small-doc `test/vscode-e2e/find-replace.spec.ts` — **not run in this pass** (not
  migrated yet; see the unchecked box above).
- `npm run quality` — not run (out of Checkpoint 1's own checklist; scheduled for Checkpoint 6 closure).

**Surprises / notes for later checkpoints:**

- Every heavy phase that ran to completion cost within a fairly narrow band (140-207 s) regardless of
  mode (IR/WYSIWYG/real-VS-Code) or which specific query/toggle triggered it — strong confirmation
  that the cost is dominated by total document node count (~2,400 fragment Lute calls, one per
  24-node batch), not by the query, the match count, or the specific action.
- SV's cost driver is different and smaller in absolute terms (16.8 s worst case) but has its own
  scaling problem: overlay-painting cost scales with match count (4,407 overlays for a 1-character
  query), independent of the clone/serialize path SV doesn't have.
- `editorDeepClones`/`fullGetValueCalls` are not perfectly Find-attributable (Vditor's own Undo/Counter
  modules clone/read too); `rootLuteCalls`/`fragmentLuteCalls` are the cleaner signal for Checkpoint 3's
  "0 whole-document Lute calls" gate.
- Two open items for the next checkpoints to pick up (not chased further here): the WYSIWYG Replace-All
  byte-identity mismatch, and the SV IR→SV round trip introducing a second occurrence of an
  otherwise-unique word.

#### Part 1 handoff — Checkpoints 2–5 design (2026-09-26)

**Evidence used (Checkpoint 1):**

- Root cause 5 is confirmed. `getValue()` is 181,855 (IR), 181,843 (WYSIWYG) or 181,846 (SV) bytes, against the 174,517 exact bytes. It first differs at offset 66–74, in a table.
- One IR/WYSIWYG refresh costs 140–210 s: about 2,411 fragment Lute serializations and 2,412 editor clones, independent of match count. Six migrated cases time out on the very first fill, even for a query with a single match.
- SV has no Lute work. Its first keystroke is dominated by painting 4,407 overlays (root cause 4).

**Source authority and match engine (Checkpoint 2).** New module `editing/find-source.ts`:

- `FindSource`: `{ key, exact, mode }`.
  - IR/WYSIWYG: the source comes from the shared source block index entry (`index.peek() ?? index.read()`; the key is the entry key).
  - SV (no index key): `deps.snapshotPair().exact`, cached per `(snapshotRevision(), root, mode)`.
- Matches come from the unchanged pure engine (`findMarkdownMatches`) on `exact`. They are cached per `(source key, query, caseSensitive, wholeWord)`. A query keystroke or toggle on an unchanged key does no serialization and no clone.
- A match result from an older key is never painted or used for an action (stale rejection).
- `configureFindReplaceActions` gains `snapshotPair` and `snapshotRevision` (EditSync in `boot/main.ts`). `installFindReplace(doc, { index })` receives finish-init's shared `sourceIndex`. There is no new index or EditSync contract: only existing public methods are used.

**Exact↔rendered alignment and lazy, viewport-bounded mapping (Checkpoint 3).** New pure helper `editing/find-align.ts`: a bounded Myers diff used as a proof of alignment, not a guess.

- It trims the common prefix/suffix, runs a line-level diff and then a character-level diff inside the changed hunks. It gives up (returns `null`) beyond fixed cost bounds.
- An exact offset maps to a rendered offset only inside an *equal* run. A match is mappable only if its start and end map and the resulting DOM range's text equals the exact match text. Anything else is unmappable: counted, never highlighted, never redirected.
- **IR/WYSIWYG, per unit, memoized on the index entry (`entry.memo`), and only for units that contain the current match or lie within the viewport ± one screen:**
  - Serialize a detached clone of the unit's members (list items wrapped as `canonicalMembers` does) with sentinels at code-point boundaries of serializable text nodes. This is one small Lute call per block.
  - Strip the sentinels to get the rendered block `R` and its points.
  - Align `exact.slice(unit.start, unit.end)` to `R`.
  - Fenced code and table cells keep the existing region fallback, scoped to the unit's exact slice.
  - The unit is found by binary search on `units[].start`; for nested units, the smallest containing unit wins. The visible units are found by binary search on unit element rects.
- **SV:** one alignment of `exact` against the SV text per source key, plus a prefix-offset table of text nodes (binary search). A match's range is then found without further serialization. The visible matches are found by binary search on mapped match rects.
- **Paint:** `renderOverlays` paints only the current match and the visible matches (capped). Scroll and resize reuse memoized mappings and never serialize or clone.
- **Status:** `k/N` counts every exact-source match. The title explains when the *current* match is not visible in this mode (replacing the old all-match count, which needed a whole-document mapping).
- `sourcePoints`, `serializeFindClone`, `specialMatchRange` (whole-document) and the per-match `fencedBodies`/`tableCellRegions` scans are removed.

**Invalidation (Checkpoint 4):**

- Remove the private `MutationObserver` and the document-click refresh.
- While Find is open, `index.onInvalidate` and editor `input` events (including SV) mark the source stale and schedule one refresh. The refresh runs after a short input-quiet coalescing delay (a coalescer, not the fix) and at most once per frame. The source-key check makes any stale result inert.
- Mode switches are caught by the key and mode comparison at refresh time.
- Overlays hide immediately when the source goes stale, so stale geometry is never painted.

**Replace (Checkpoint 5):**

- At action time: `before = deps.snapshotPair().exact` (one serialization per action). Recompute the matches on `before`. The current match must equal the displayed match (same offsets and text) or the action declines and refreshes.
- Plan with `replaceMarkdownMatch`/`replaceAllMarkdownMatches` on `before`.
- Apply locally: one `setValue(marked)` between undo checkpoints (`checkpointEditorUndo`), then remove the caret marker. A failure restores `before` with no second attempt.
- Record exact undo history (`recordRewrapDocumentHistory`, with `beforeExact`/`afterExact` and the rendered states) so that Undo/Redo restore exact bytes.
- Then `postExact(after)`. The host receives exact bytes built from exact bytes, so bytes outside the matches are unchanged.
- The host is the verifier through EditSync's existing exact-transaction path, the same one rewrap uses. Checkpoint 5 must confirm, with host text, disk bytes and save/reopen on the fixture, that bytes outside the matches are identical, including Undo. If the host path does not preserve them, return that evidence to Part 1 (a scope question if it needs a new protocol).

**Harness (Checkpoint 2, test-only).** `structural-selection-harness.ts` mirrors EditSync's exact authority:

- `__setValue(markdown)` records `exact = markdown`, anchored to the rendered value at the first snapshot.
- A trusted `input` clears it and advances the revision; `postExact` sets it.
- It creates a shared source block index (as `selection-bubble-harness.ts` does) and passes it to `installFindReplace`.
- It exposes `__exact()` so the Chromium specs can assert exact-byte results.

**Gates finalized:**

- A query keystroke or toggle on an unchanged revision: 0 root Lute calls, 0 full `getValue`, 0 index builds, and at most one small fragment Lute call per newly visible block.
- Scroll ×5: 0 root Lute calls, 0 `getValue`, 0 index builds.
- An editor click: 0 `getValue` and 0 root Lute calls from Find.
- Replace and Replace All: exactly one `setValue`, and the result equals the exact-source plan (checked through `__exact()` in Chromium, and host/disk in real VS Code).
- Every phase finishes far below its deadline. Wall time is reported.

**Tier.** Checkpoints 2–5 are Heavy (shared foundations, serializer parity, source mapping, undo), implemented on Opus 5.5.

#### Checkpoint 2 results (Part 2, 2026-09-26)

**Pure engine.** It moved to `editing/find-engine.ts`; `selection-scope.ts` re-exports its functions. Its results are unchanged, and it is now linear:

- Case-sensitive search uses `indexOf`.
- Case-insensitive search keeps the per-candidate slice-and-fold check behind a conservative first-code-unit prefilter. Surrogates, Σ/σ/ς and Turkish/Lithuanian I/J/Į always pass the prefilter.
- Line and block indexes are computed in one forward pass. Before, each match rescanned from offset 0 (`offsetToLine`) and reparsed every block range (`blockIndexForSourceLine`).
- `find-engine.test.ts` keeps the pre-rework engine verbatim as an oracle. The two agree on 400 seeded random Unicode/Markdown samples in all four option combinations (dotted I, σ/ς, ß, K, combining dot, astral letters, fences, tables), and on a 1,000-match document.

**Source tracker.** `editing/find-source.ts`: `createFindSourceTracker`.

- IR/WYSIWYG use the shared source block index entry. Its exact bytes and units are keyed by root, owner, mode, revision and DOM revision.
- SV, or a missing index key, uses an EditSync `snapshotPair().exact` cached per post-snapshot revision, root and mode. It is uncached when there is no revision.
- Matches are cached per source key, query and options. `isCurrent` rejects results from an older source.
- `find-source.test.ts` (6 tests): one build across keystrokes and toggles; revision rejection and rebuild; DOM-change rebuild; SV per-revision snapshot; the no-revision fallback; no source without a root or mode.

The module manifest registers `find-engine` and `find-source`.

**Not yet done.** The widget is not wired to the tracker; that happens in Checkpoint 3 with the mapping, because the old whole-document point mapping is keyed to rendered offsets. Until then, only the faster engine is live.

**Checks.**

- Vitest: `find-engine.test.ts`, `find-source.test.ts`, `selection-scope.test.ts` and `module-boundaries.test.ts` pass (67 tests).
- The whole `media-src/src/editing/` Vitest directory passes, apart from the manifest entry fixed before commit.
- `npx biome check media-src/src scripts` is clean. `npm run typecheck` is clean.



The original record below had these errors, corrected in place:

- The Problem section described the pre-196 state. It is now marked as history: Ctrl/Cmd+F runs `vmde.findReplace` (`package.json` keybindings), no longer `editor.action.webvieweditor.showFind`. The stale `package.json:614-617` line reference was removed.
- `source-map.ts` lives at `media-src/src/util/source-map.ts`. Block mapping was superseded by Task 568's fragment ranges and is now being replaced by this rework.
- The highlight scope line was a garbled sentence ("… or CSS Custom Highlight API is REJECTED …") and contradicted the Prior-art section. Rewritten below.
- Verification L3 said Ctrl+H reaches the widget. It does not: Ctrl+H is the Headings picker (Task 505), and the shipped real-VS-Code acceptance proves Ctrl+F.
- "Source-accurate" in the Completed section describes the intended contract. Root cause 5 questions whether the `getValue()`-based implementation meets it.

---

## Original record (2026-07 to 2026-08-31)

### Problem (history, before this task shipped)

Ctrl+F was bound by task 01 to `editor.action.webvieweditor.showFind`. VS Code's webview find widget is **find-only**: no replace, no regex, no whole-word. Replacing text meant switching to the text editor (Ctrl+Alt+E). This is a daily-frequency journey (190 J21).

### Scope

- [x] Design decision: a custom find/replace widget in the webview operating on the
      Vditor model, versus (b) a replace-only companion that reuses the native find for locating.
      Chose (a): the native widget searches the rendered DOM (IR markers included), which
      makes match counts wrong in edit modes.
- [x] Widget: find + replace + replace-all, case toggle, whole-word. Operates on `getValue()`
      text with results mapped to blocks via `media-src/src/util/source-map.ts` (superseded; see above);
      replace = targeted model edit + caret/scroll preservation, one undo step per replace-all.
- [x] Keybinding: Ctrl/Cmd+F opens the custom find/replace widget; Ctrl/Cmd+H remains the shipped
      Headings shortcut from Task 505. Escape closes without leaking to editor content.
- [x] Highlight the current match and all matches on the visible surface. Decorations must be
      Lute-invisible: either overlay rectangles outside the editable DOM (chosen), or spans that
      follow the vmde-lute-features skill (`data-render="2"`). The memory that rejected the
      CSS Custom Highlight API concerned live WYSIWYG code coloring, not search highlighting
      (see Prior art).

### Out of scope

- Multi-file search/replace (VS Code's Ctrl+Shift+F covers it), regex back-references in v1,
  search history.

### Verification (as planned)

- L1: replace engine unit (match mapping, replace-all single undo step, code-fence hits).
- L2: harness — open widget, replace mid-doc term, `getValue()` correct, caret/scroll kept,
  markers not corrupted (torture fixture).
- L3 real-VS-Code (mandatory): Ctrl/Cmd+F reaches the widget in the real webview (key-capture
  seam) while Ctrl/Cmd+H still opens Headings; replace persists to disk after Ctrl+S; undo restores.

### Prior art — fork re-scan 2026-07-23 (task 358)

- `zaaack` PR #163 `feat: add in-editor find bar with CSS Custom Highlight API` (0.1.17) — a working reference for the find-bar UI + highlight layer half of this task. Note our own Custom-Highlight-API verdict was about live WYSIWYG code colouring (memory `wysiwyg-code-highlight-custom-highlight-api`), a different use — the rejection does not carry over to search highlighting.

### Completed (2026-08-31)

VMDE now owns one source-accurate find/replace widget across IR, WYSIWYG, and SV. The literal match
engine searches `getValue()` with case and Unicode-aware whole-word toggles, maps every result to
Task 52's Markdown block ranges, and includes prose, fenced/diagram source, tables, and marker text
without relying on rendered-DOM counts. Replace and Replace All build deterministic source strings;
replacement text is literal (no regex/back-reference interpretation).

The widget lives outside Vditor's editable DOM with labeled native inputs/buttons, status live
region, next/previous navigation, Escape close/focus return, and fixed pointer-inert overlay
rectangles for all matched blocks plus a distinct current block. No decoration span enters Lute,
clipboard Markdown, or saved source. Direct editor input refreshes open results.

Both replacement actions use the existing eager `selection-scope.ts` module and one exact Vditor
transaction: pre/post undo checkpoints, collision-safe caret marker removal, scroll/focus/caret
restoration, extension-update suppression, and one `postExact`. Replace All is therefore one undo
step regardless of match count. The same adapter passes in all three edit modes.

The design chose the full custom widget rather than a replace-only native-find companion. Ctrl/Cmd+F
now invokes the discoverable `vmde.findReplace` command instead of VS Code's rendered-DOM find.
The task's old Ctrl+H proposal was deliberately not used: Task 505 subsequently promoted Ctrl+H as
the Headings picker, and the real acceptance explicitly proves it remains intact.

#### Verification

- TDD RED coverage began with five absent engine APIs. The final selection-scope file passes 48/48
  focused tests, covering literal/case/Unicode-word matching, block/line mapping, code-fence/table
  hits, literal single/all transforms, accessible external-DOM widget behavior, exact transactions,
  two-checkpoint Replace All, and Escape.
- Final repository-configured Chromium coverage passes 5/5 with `--retries=0`: marker-safe current
  replace, prose/fence/table Replace All plus one-step undo, toggles/close/overlays, and identical
  WYSIWYG/SV transactions. The coverage bundle exercises the find widget/action paths; full unit
  coverage reports `selection-scope.ts` at 88.88% lines / 84.32% statements.
- After `node build.mjs`, the one-boot real-VS-Code spec passes 1/1 with `--retries=0` in 7.0s.
  Real Ctrl+F focuses the widget; Replace All spans prose/fence/table and one Ctrl+Z restores the
  exact live baseline; Ctrl+H still opens Headings; a marker-safe current replace persists to disk
  after Ctrl+S and undo restores the live baseline.
- Build, all three type checks, manifest/command routing, and protocol shape checks pass. Main.js
  measures 533.9 KB and is recorded as 534/536 KB; reusing the eager scope module keeps startup at
  275/275 modules.
- Aggregate quality passes brand checks, lint, jscpd, dependency-cruiser, all audits, 3,398/3,398
  unit coverage tests, and the 15-module ratchet. Its only failure is the unrelated pre-existing
  `knip` report for `yazl` in `test/backend/package-local-preview-core.test.ts`.

Retry history: the first real undo assertion compared against the raw fixture rather than Vditor's
already-normalized live table source; it was corrected to capture the pre-command model. The final
candidate passed without Playwright retries. Per queue policy, no FAST, full Chromium, or full
real-VS-Code suite was run.
