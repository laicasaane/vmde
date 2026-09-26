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

- [ ] Record the build, mode and fixture hash. Using test-only counters, count full `getValue`/`VditorIRDOM2Md`/`VditorDOM2Md` calls, editor deep clones, index builds, long tasks and rAF gaps.
- [ ] Measure these on the large fixture in IR, WYSIWYG and SV: open Find; type a 4-character query one key at a time; toggle case and word; Next/Previous across many matches; scroll with Find open; type and click in the editor with Find open; Replace; Replace All; Undo.
- [ ] Migrate the existing Chromium `find-replace.spec.ts` cases (7) and the real-VS-Code `find-replace.spec.ts` case from their inline documents onto the fixture. Keep every contract they assert: marker-safe current replace, repeated same-block occurrences, prose/code/table mapping, one-step Replace All undo, case/word toggles and Escape, WYSIWYG/SV transactions, Ctrl/Cmd+F and Ctrl/Cmd+H routing, and save persistence.
- [ ] Confirm or reject root cause 5. Use a fixture region that Vditor normalizes, for example table whitespace. Check whether Find counts and offsets match the exact file, and whether Replace/Replace All change bytes outside the matches (host text, disk and save/reopen).
- [ ] Write red assertions as deterministic work counts, not only elapsed time. Target shape, finalized in Part 1: a query keystroke or toggle on an unchanged revision causes 0 whole-document serializations and 0 editor clones; at most 1 index build per revision; scroll/resize causes 0 serializations and paints only in-viewport matches; editor clicks cause no Find recompute.
- [ ] Use OS-level XTEST input for keyboard acceptance in real VS Code. Browser-protocol input is diagnostic only.

### Checkpoint 2 — Exact-source match engine keyed by revision

- [ ] Search the exact source, and cache matches per query, options and revision. Keep the pure engine functions (`findMarkdownMatches`, `replaceMarkdownMatch`, `replaceAllMarkdownMatches`) and their unit coverage. Add revision-keyed reuse and stale-result rejection tests.

### Checkpoint 3 — Index-backed, lazy, viewport-bounded mapping and paint

- [ ] Replace `sourcePoints`/`serializeFindClone` whole-document probes with index-unit mapping plus bounded, block-scoped fragment resolution. Hoist fence and table region scans into per-revision memos.
- [ ] Paint only the current match and in-viewport matches. Scroll and resize never serialize.
- [ ] Unit tests: mapping across prose, inline, code, table and nested blocks; unmappable-match counting; surrogate pairs; a stale entry after an edit fails closed.

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

### Audit corrections (2026-09-26)

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
