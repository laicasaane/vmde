# Task 640 — Prioritized wrap points for long unbroken text in table cells

**Status:** planned (2026-10-15).
**Origin:** Project Owner feature request (chat, 2026-10-15).
**Severity:** feature (readability of tables with long paths and identifiers).
**Tech stack:** TypeScript webview (table rendering and `media-src/src/chrome/responsive-tables.ts`), table CSS (`media-src/src/main.css`), Vitest, Chromium, real VS Code.
**Related:** [Task 639](done/639-content-aware-table-column-widths.md) (content-aware column widths), [Task 219](219-table-column-resize.md) (column resize), [Task 369](369-table-inline-code-row-height-delta.md) (table row height).

## Problem

A table cell that holds a long unbroken run of text, such as a file path or an identifier in inline code, wraps at arbitrary characters. Table cells use `overflow-wrap: anywhere` (`media-src/src/main.css`), so a line can break in the middle of a word, for example between two letters of a class name, even when a slash, a dot or a word boundary nearby would read much better.

## Example (Project Owner)

```
| `../EncosyTower.Tests.EditorMode/EncosyTower.PageFlows/PageFlowTestDoubles.cs` | `TestFlowContext` gains `public Option<IPageOwnershipTracker> OwnershipTracker { get; set; }` after `FlowScopeCollectionApplier` (default none) |
```

## Requested behavior (Project Owner, verbatim)

"I expect that the first column will be wrapped at characters following this order:

1. Prioritize wrapping at non-alphanumeric characters such as `<space>`, `/`, `.`, `,`, etc
2. Wrap at numeric characters
3. Wrap at position after a lowercase and before the immediate uppercase: `TableList` => wrap at after character `e`"

## Constraints

- View-only: no change to the markdown source, the host bytes, the dirty state or Undo history. Any break hint added to the rendered DOM must be invisible to serialization (see the `vmde-lute-features` skill).
- Works with Task 639's column widths (min-content measurement) and Task 219's manual resize.
- Caret movement, selection and copy inside the cell keep the original text (no inserted characters in copied text).
- Large documents must not open or scroll slower (Task 573).

## Acceptance

- [ ] In the example table, the first column wraps only at the priority-1 positions when they are enough to fit the column, uses priority-2 positions only when a priority-1 segment is still too wide, and priority-3 positions only after that; a break inside a word happens only as a last resort.
- [ ] The same rule applies in IR, WYSIWYG and Preview (SV shows source text; record its behavior).
- [ ] Source bytes, dirty state, Undo history, caret movement and copied text are unchanged.
- [ ] Focused Chromium and real-VS-Code tests written and run; network-free gates pass.

## Open questions for Part 1

- Which cells: every table cell, or only cells whose content overflows the column?
- Which content: inline code only, or any text run (links, plain words)?
- Exact break position for priority 1 (before or after the separator character).

## Part 1 handoff (2026-10-15)

Read-only review of the source plus scratch probes; no source or test file changed. Probes: (P-A) the vendored Lute blob in Node (`media-src/vendor/lute/lute.min.js`, `Md2VditorIRDOM`/`Md2VditorDOM`, `VditorIRDOM2Md`/`VditorDOM2Md`, `SpinVditorIRDOM`/`SpinVditorDOM`); (P-B) standalone headless Chromium pages with the cell CSS reproduced (padding 6px 13px, `white-space: normal`, `word-break: break-word`, `overflow-wrap: anywhere`, inline code at 85% monospace) and `allocateColumnWidths` imported from the source. P-B does not load the editor, its theme or its fonts, so its pixel values are indicative only; the Part 2 S1 baseline must re-measure in the harness. Scratch files stayed outside the repository.

### Cause (verified)

- Cells wrap with `overflow-wrap: anywhere` (`media-src/src/main.css:1441-1448`) plus Vditor's cell rule patched to `word-break: break-word; white-space: normal` (`build.mjs:570-571`). The browser breaks at its own (UAX #14) opportunities first and breaks anywhere only when a run does not fit, at the last character that fits.
- The Owner path has no native opportunity at all: P-B, `overflow-wrap: normal` in a 30 px column renders the whole path on one line; its min-content equals its max-content (659.9 px). With `overflow-wrap: anywhere` the min-content is one glyph (40.6 px).
- Task 639 measures min-content in clones with `overflow-wrap: normal; word-break: normal` (`media-src/src/chrome/table-resize.ts:151-159`, read by `measureColumns`, `media-src/src/chrome/responsive-tables.ts:130-155`). For the Owner table that gives min = 659.9 / 264.3 px, so the sum of min-content (924 px) exceeds the table width and `allocateColumnWidths` falls back to equal shares (`media-src/src/chrome/table-column-widths.ts:78`). P-B result: 336/336 px at W = 673 (the real-VS-Code fixture width in Task 639) and 400/399 px at W = 800; column 1 lines `../EncosyTower.Tests.EditorMode/Encos | yTower.PageFlows/PageFlowTestDoubles. | cs` (673) and mid-word breaks at every narrower width (for example 160 px: `../EncosyTower. | Tests.EditorMode | /EncosyTower.Pag | eFlows/PageFlowT | estDoubles.cs`).
- The browser cannot honour a priority order. Break opportunities have no rank: each line takes the last opportunity that fits. P-B: `ab/` + hint + `Page` + hint + `Flow` + hint + `Test` in a 100 px column renders `ab/Page | FlowTest`, a priority-3 break, although a priority-1 break after `/` was available. CSS has no property that ranks break opportunities (`word-break`, `line-break`, `overflow-wrap`, `hyphens`, `text-wrap` only switch classes of opportunities on or off; `word-break: auto-phrase` is CJK only). So the priority must be applied by choosing which opportunities exist.

### Mechanism options

- **(a) Zero-width break hints in the rendered DOM.** Shapes probed (P-B, P-A):
  - `<wbr>`: breaks correctly and copies clean, but it is Vditor's caret marker. `util/selection.ts:188` restores the caret at the first `wbr` in the block and `wysiwyg/input.ts:41` deletes every `wbr` in the editor on input (paths under `media-src/node_modules/vditor/src/ts/`), and Lute renders `<wbr>` as the caret. **Rejected.**
  - A ZWSP text node: breaks, but `textContent`/`innerText` change (P-B) and the character would reach Find and copy. **Rejected.**
  - An empty element whose CSS adds the break: `<span class="vmde-wrap-hint" data-render="1"></span>` with `.vmde-wrap-hint::after { content: "\200B" }`. P-B: same break positions as `<wbr>` (min-content of the path drops to 190.7 px, the widest priority-1 segment `PageFlowTestDoubles.`), `textContent` unchanged, clipboard text from a real Ctrl+C unchanged (`ab/PageFlow`), `window.find('Tower.Tests')` still matches across the hint. An empty span without the `::after` rule gives no opportunity (min-content stays 659.9 px). **Recommended.**
  - `contenteditable="false"` on the hint (the shape the Lute skill recommends for widgets) must NOT be used. P-B in a plain contenteditable: crossing the hint costs one ArrowRight press with no visible move, Shift+ArrowRight then selects nothing and Backspace deletes nothing. Without the attribute, ArrowRight moves one character per press and Shift+ArrowRight/Backspace act on `P` as with no hint.
- **(b) Tiered insertion (recommended on top of a).** The priority is built from which hints exist, per whitespace-delimited token: a token that fits the cell's content width gets no hints. A token wider than the content width gets priority-1 hints. Any priority-1 piece still wider gets priority-2 hints inside it, then priority-3 inside priority-2 pieces still wider. Anything still wider falls back to today's `overflow-wrap: anywhere` (kept in CSS, unchanged). The browser then fills lines greedily, so a priority-2 or priority-3 break is only ever used inside a higher-priority piece that cannot fit a line on its own. P-B with this rule on the Owner path: 120 px column `../Encosy | Tower. | Tests. | EditorMode/ | Encosy | Tower.Page | Flows/Page | FlowTest | Doubles.cs` (each priority-3 break sits inside a priority-1 piece wider than 81 px). At 70 px the last resort appears (`Encos | y`). Greedy filling can put the tail of one split piece and the head of the next on one line (`Tower.Page`). A stricter "split piece starts on its own line" would need forced breaks and is not proposed.
- **(c) CSS only.** Not possible (see Cause). Changing `overflow-wrap` to `break-word` changes only min-content, not the choice of break.
- **Where hints live.** Lute renders inline code without a preview half (P-A): IR is `<span data-type="code" class="vditor-ir__node"><span class="vditor-ir__marker">`</span><code data-newline="1">…</code><span class="vditor-ir__marker">`</span></span>`, WYSIWYG is `<code data-marker="`">​…</code>`, Preview is plain `<code>`. So the hints go into the editable text of `<code>` (and of plain text and link text) in IR and WYSIWYG, never into the IR marker spans (`.vditor-ir__marker`, including the link URL marker) or `[data-render]` previews.
- **Serialization (P-A, verified).** IR: `VditorIRDOM2Md` and `SpinVditorIRDOM` ignore the hint inside code, plain text and link text (round trip byte-identical, with or without `data-render`). **WYSIWYG: `VditorDOM2Md` truncates inline code at the first element child**: `` `src/<hint>Table.cs` `` serializes as `` `src/` `` (data loss), with or without `data-render`; plain text and link text are unaffected. WYSIWYG therefore needs the hint stripped before Lute, the existing `wrapLuteFlatten`/`flattenSourceHtml` path (`media-src/src/editing/wysiwyg-code-highlight.ts:64-102`, wraps `SpinVditorDOM` and `VditorDOM2Md`; its early return at `:65` must also let hint-bearing HTML through). Every WYSIWYG Lute call must go through that wrapper: `getMarkdown`, the incremental block path (`media-src/src/bridge/edit-sync.ts:958`), Vditor's copy handler (`vditor/src/ts/wysiwyg/index.ts:242`, text/plain = `VditorDOM2Md` of the selection) and the Find map, which serializes a detached block clone with one Lute call (`media-src/src/editing/find-map.ts:1-6`).
- **While a cell is edited.** Vditor replaces the whole table on a keystroke (Task 639 S1 probe 1) and the spin output contains no hints (P-A), so every hint of the edited table disappears and its cells fall back to today's wrapping until hints return. Proposed: in Task 639's synchronous replacement callback, re-apply cached hint plans (keyed by text node content and column content width) to every text node of the replacement except the one holding the caret, and re-plan the caret's text node at the 600 ms typing pause together with Task 639's recompute. Only `splitText` and `insertBefore` may be used (they keep the live Selection range); replacing a text node would lose the caret. Hints already present when the caret enters a cell stay (they do not affect caret steps without `contenteditable="false"`).

### Exact break positions (provisional rule)

Positions are between two code points of one token (no break at the token start or end, never inside a surrogate pair, before a combining mark `\p{M}`, ZWJ or a variation selector).

- **Priority 1.** After a separator run: after the last of consecutive ASCII separators from `/ \ . , ; : _ - | = & ? # ! @ ~ + * % $ ^` and the closers `) ] } >`, when the next character is not a separator. Before an opener `( [ { <` when the previous character is not punctuation. No break inside a run of punctuation (`../` stays whole, `::` stays whole). Quotes and backticks are not separators. Space already breaks natively. Reason for "after": the separator at the line end shows that the token continues, matches how the browser already breaks after `-`, and keeps `.cs` and path parts readable. Reason for "before" openers: `Option<IPage…>` and `Foo(bar)` keep the bracket with its contents.
- **Priority 2.** At a letter/digit boundary in either direction (`\p{L}|\p{Nd}` and `\p{Nd}|\p{L}`), never inside a digit run: `URP17Compat` gives `URP|17|Compat`, `LitPass2D` gives `LitPass|2|D`.
- **Priority 3.** Between a lowercase and an uppercase letter (`\p{Ll}|\p{Lu}`): `TableList` gives `Table|List`. An acronym boundary (`HTMLParser` as `HTML|Parser`) is not in the Owner rule and is left out (open question 5).
- **Last resort.** Today's break anywhere, only for a piece with no hint that fits.
- Applied to the Owner path, priority 1 gives the pieces `../`, `EncosyTower.`, `Tests.`, `EditorMode/`, `EncosyTower.`, `PageFlows/`, `PageFlowTestDoubles.`, `cs`.

### Interaction with Task 639

- Min-content must use the priority-1 pieces: before the `min` layout, strip any hint from the clone and add priority-1 hints to every token of the clone (clone only; the live table is untouched). Max-content is unchanged (hints are zero width: 659.92 px against 659.88 px in P-B).
- Effect on the Owner table (P-B, indicative): min-content goes from 659.9 / 264.3 px to 190.7 / 250.7 px. The sum (441 px) is below W, so the allocation leaves the equal-share fallback: 243/429 px at W = 673 (equal 336/336) and 289/510 px at W = 800 (equal 400/399). The path column shrinks, the table gets shorter (87 px against 106 px at 673; 78 px against 87 px at 800), and column 1 breaks only at priority-1 positions: `../EncosyTower.Tests. | EditorMode/EncosyTower. | PageFlows/ | PageFlowTestDoubles.cs` (673) and `../EncosyTower.Tests. | EditorMode/EncosyTower. | PageFlows/PageFlowTestDoubles. | cs` (800).
- Priority 2/3 hints are planned after the widths are known (automatic or Task 219 manual), against each cell's content width (column width minus cell padding and border, minus the inline-code horizontal padding). Segment widths are read with Range rects in the same measurement host pass, only for tokens whose width exceeds the content width. Because min-content counts only priority-1 pieces, there is no loop between widths and hints.
- Re-plan triggers: every Task 639 trigger (first near-viewport visibility, column count change, table width change of at least 1 px, `document.fonts` `loadingdone`, typing pause), plus any applied width change: an automatic recompute, a Task 219 drag (re-plan at drag end only; during the drag the old hints stay and the last resort covers the rest), double-click auto-fit and clearing a manual width. Planning is limited to the near-viewport tables Task 639 already tracks.

### Contract (provisional)

1. View-only: the markdown, host bytes, dirty state, Undo/Redo history, caret steps and copied text are the same with and without hints, in IR, WYSIWYG and Preview.
2. Hint shape: `<span class="vmde-wrap-hint" data-render="1"></span>` plus the `::after` ZWSP rule in `main.css`; no `contenteditable="false"`, no `<wbr>`, no inserted characters.
3. Scope: text of `th`/`td` cells of the tables Task 639 handles, including the tables it leaves at equal widths and tables with manual widths: inline code, plain text, emphasis and link text. Excluded: `.vditor-ir__marker` spans, `[data-render]` previews (math, diagrams), images, inline HTML, `contenteditable="false"` widgets (wiki chips), nested tables.
4. A token gets hints only when its nowrap width exceeds the cell's content width; tiers as in (b); last resort unchanged.
5. SV: out of scope. SV shows the source line with its own wrapping and is unchanged (record that in the acceptance item).
6. Every observer and serializer that reads the editor treats hints as non-content (see Part 2 S2b).

### Edge cases

- CJK: the browser's native opportunities stay; the rules add none inside CJK text (no ASCII separators, no case). Mixed tokens still get priority-1 hints at ASCII separators.
- Emoji and combining sequences: no position inside a grapheme (rule above); Vitest cases.
- Links: link text gets hints. The URL lives in an IR marker span (shown only while the caret is in the link) and gets none, so an expanded long URL keeps today's wrapping.
- Inline code with spaces: spaces already break. Only the tokens between them are checked.
- Very long hint-free runs (hashes, base64): no hint fits, so the last resort applies exactly as today.
- A run that crosses an element boundary with no space (for example code followed directly by text) is planned per text node part. Parts that fit alone get no hint, so the joined run may fall back to the last resort. This is accepted and recorded.
- Copy/paste: IR and WYSIWYG copy text/plain is Lute markdown (`vditor/src/ts/ir/index.ts:91`, `wysiwyg/index.ts:242`), clean after the WYSIWYG strip. Preview copy is DOM text, clean (P-B). Text/html carries empty spans, which Lute's paste conversion drops (Part 2 check).
- Find: the Find map clones blocks and serializes them with Lute (WYSIWYG strip needed). DOM ranges across a hint verify by `range.toString()` (`find-map.ts:65-80`), which is unaffected.
- Caret and selection: no extra key press (probe above); vmde caret helpers that assume one text node per `<code>` must be checked (Part 2 S2b inventory).
- Undo: Vditor's undo text is `innerHTML`, so hints enter snapshots. `withoutCaret` (`media-src/src/editing/undo-boundaries.ts:258-264`) must also drop hint spans, as Task 639 did for its width classes, or a hint-only difference counts as an edit. An Undo that restores an old snapshot brings back its old hints; the restored tables are re-planned like replacements.
- Large documents: only near-viewport tables, only overflowing tokens, plans cached per (text, content width); one DOM write phase per flush. Gate: the Task 573 open/scroll numbers on the large fixture.
- Mutation side effects: hint writes are `childList`/`characterData` mutations inside cells. The webview has about 49 MutationObservers on or near the editor (grep `new MutationObserver` in `media-src/src`). `isOwnDecoration` (`media-src/src/util/mutation-impact.ts:40-45`) and `seedMutationAffectsSource` (`media-src/src/bridge/edit-sync.ts:184-192`) recognise `data-render` nodes, but a `splitText` also adds a plain text node, which those filters treat as content. Task 639's own `onContentMutations` (`responsive-tables.ts:476`) would treat a hint write as an edit and hold or re-measure the table, which loops. Part 2 must classify hint writes (see S2b).

### Test plan

- Vitest: the pure position rule `wrapBreakPositions(token)` (priority-1 after a separator run, before openers, no break inside `../` or `::`, quotes excluded; priority-2 both directions, not inside `17`; priority-3 `TableList`; no position at token ends, inside surrogate pairs, emoji ZWJ sequences or before combining marks; CJK gives none) and the tier planner `planWrapBreaks(token, measure, limit)` with a fake measure (Owner path at several limits: priority-2/3 only inside wider pieces, unchanged when the token fits, empty plan for a long hint-free run). Expected values worked out by hand from this contract. Real-Lute round trip (`media-src/src/testing/real-lute.ts`): IR and WYSIWYG markdown byte-identical with and without hints, including inline code (the WYSIWYG truncation case must fail first). `undo-boundaries.test.ts`: a hint-only difference keeps the history and Redo.
- Chromium (`media-src/e2e`, new `table-wrap-hints.spec.ts` and a fixture with the Owner table plus rows with a digit path, a camel-case identifier, prose, a link, CJK and emoji), per mode IR, WYSIWYG, Preview: (1) column 1 line texts (Range rects, as in P-B) contain only priority-1 breaks at the automatic width; the path column is narrower than its equal share. (2) With a manual width that forces priority-2/3 breaks, every lower-tier break lies inside a higher-tier piece wider than the line. (3) `getValue()` is unchanged. (4) Copy text equals the source selection. (5) ArrowRight across a hinted token moves one character per press. (6) Typing in a hinted cell: other cells keep their breaks during typing, and the edited cell has hints again after the pause. (7) Find matches across a hint in WYSIWYG.
- Real VS Code (`test/vscode-e2e/table-wrap-hints.spec.ts`): the Owner fixture in IR, WYSIWYG and Preview (line texts, column widths); host text, disk bytes, dirty state and Undo/Redo lengths unchanged after layout; OS (XTEST) typing in a hinted cell gives one Undo step and Ctrl+Z restores the exact bytes; OS Ctrl+C of the path gives the source text. SV: record the unchanged behaviour.
- Reruns of specs that exercise changed files: `table-auto-width`, `table-resize`, `copy-cut`, `find-replace`, `undo-boundaries`, `mutation-local`, and the Task 573 gate.

### Part 2 steps

- **S1 (measure, no source change).** Harness baseline for the fixture in IR, WYSIWYG and Preview: column widths, line texts of column 1 and table heights at 1280 and 800. Probe 1: insert hints with `splitText` into the text node holding the caret in IR and WYSIWYG, then type; confirm the caret, Vditor's caret restore and the spin output. Probe 2: list which MutationObservers react to a hint write. A no-op that only runs again is acceptable; one that serializes, posts an edit, invalidates the source block index or holds a table must be fixed.
- **S2a.** Pure module (proposed `media-src/src/chrome/table-wrap-hints.ts`, registered in `scripts/module-manifest.mjs`): position rule and tier planner with Vitest, written first.
- **S2b.** Wiring in the Task 639 engine. Clone hinting before the min-content layout. Planning against the applied widths. One write phase. Synchronous re-apply in the replacement callback. Re-plan at drag end and auto-fit (Task 219). WYSIWYG strip in `flattenSourceHtml`. `withoutCaret` scrub. Hint writes made invisible to the editor's observers: a shared "own view mutation" classifier in `mutation-impact.ts` used by Task 639's observer, the source block index and the seed observer, or writes followed by `takeRecords()` on the observers that support it. Chromium spec.
- **S3.** Real-VS-Code spec, reruns, Task 573 gate.
- **S4.** Closure.

### Provisional decisions (reversible)

1. Mechanism (a) with tiers (b): an empty `data-render="1"` span with a CSS ZWSP, without `contenteditable="false"`.
2. Priority-1 break after separator runs and before openers; no break inside punctuation runs.
3. Priority 2 on both sides of a digit run.
4. Greedy line filling (no forced line starts for split pieces).
5. Min-content for Task 639 uses priority-1 pieces.
6. While typing, the caret's text node stays unhinted until the pause.

### Owner questions (provisional answers)

1. **Which cells?** All cells of the tables Task 639 handles are checked, but a hint is added only to a token wider than its cell's content width, so cells whose content fits are not changed. In addition, min-content measurement counts priority-1 pieces in every cell, which lets path-like columns shrink.
2. **Which content?** Any text run in a cell (inline code, plain text, emphasis, link text). Excluded: IR marker spans (including link URLs), rendered previews (math, diagrams), images, inline HTML and widgets.
3. **Before or after the separator?** After the separator (the separator ends the line), except before an opening bracket `( [ { <`. Consequence: the Owner path at W = 800 ends with `PageFlowTestDoubles. | cs` (P-B).
4. (New) Keep a short final piece such as `cs` on the previous line (an orphan guard), or break before the extension (`PageFlowTestDoubles | .cs`)? Provisional: no guard, rule as written.
5. (New) Add an acronym boundary to priority 3 (`HTMLParser` as `HTML|Parser`)? Provisional: no, Owner rule only.

### Risks

- WYSIWYG inline-code truncation: any Lute call that bypasses the strip loses data. Every call site must be covered, and a real-Lute test must show the RED case first.
- Observer side effects of hint writes (49 observers). Unclassified writes can loop Task 639's engine or post edits.
- Caret handling during the synchronous re-apply (S1 probe 1).
- Measurement cost of segment widths on tables with many long tokens (Task 573 gate).
- P-B pixel numbers are from a reproduced stylesheet, not the editor; S1 replaces them.

## Execution progress — 2026-10-15 (Part 1)

- Changed: this record only (Part 1 handoff above).
- Commands: Lute probes in Node against the vendored blob (exit 0; outputs quoted above); three headless Chromium probe scripts against the repository's Playwright (exit 0; one first run failed on `navigator.clipboard` outside a secure origin and was rerun on a routed `http://localhost` page, exit 0); a debug rerun of the narrow-column probe to confirm segment widths (`PageFlows/` 82 px against an 81 px limit, exit 0). No build, Vitest, Chromium spec or real-VS-Code run (none required for a record-only step).
- Open: the Owner questions above; Part 2 S1 to S4.

## Owner decisions (2026-10-15, chat, verbatim)

1. "Based on the \"words too wide\" on any cell. Any cell have \"words too wide\" will get the hints. So this might not be table problem but should be generalized into common practice to break \"words too wide\"?"
2. "Prioritize inline code first, then \"words too wide\". And \"hidden Markdown syntax, images, inline HTML or rendered widgets\" are all excluded"
3. "Break after it"
4. "Allow piece up to N characters => This can be configured, default is 3"
5. "No, we never know which acronym is possibly valid programmatically in real world situations"

Orchestrator reading (reversible): (1) the rule applies to any word too wide for its line box anywhere in the rendered document (table cells, paragraphs, list items, headings, blockquotes, callouts), not only tables; (2) inline code is handled first, then other words too wide; hidden Markdown syntax, images, inline HTML and rendered widgets are excluded; (3) priority-1 breaks always come after the separator, including after an opening bracket (no "before an opener" exception); (4) a new setting gives N (default 3): a final piece of at most N characters is not split off (it stays with the previous piece); (5) no acronym splitting — priority 3 is only between a lowercase letter and the following uppercase letter.

