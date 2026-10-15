# Task 640 — Prioritized wrap points for words too wide for their line

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


## Part 1 revision (2026-10-15)

Revision of the Part 1 handoff after the Owner decisions above. Where this section and the handoff differ, this section wins. Unchanged and still valid: Cause, the hint shape (an empty `data-render="1"` span with a CSS ZWSP, no `contenteditable="false"`, no `<wbr>`), tiered insertion, the WYSIWYG inline-code truncation finding, the typing behaviour, priority 2 and the Task 639 measurement interaction. New evidence: (P-C) a Lute round trip in Node with hints in a heading, a paragraph (plain, bold and link text), a list item, a blockquote and a callout, each also holding inline code; (P-D) a Chromium page measuring a long word in place in a 200 px paragraph with `overflow-wrap: break-word`. Record only; no source or test file changed.

### 1. Scope: every word too wide for its line box

- **Rule.** A word (a run without white space) whose width exceeds the width of the line box it sits in gets hints, wherever it is rendered: paragraphs, list items, headings, blockquotes, callouts and table cells, in IR, WYSIWYG and Preview. A word that fits gets none, so normal prose is unchanged.
- **Today outside tables.** `.vditor-reset` ships `word-break: break-word` (`build.mjs:545-546`), so a too-wide word breaks at the last character that fits. That is the same last-resort behaviour as in cells, and it stays the fallback.
- **Line box width.** This is the content width of the nearest block container of the text: `p`, `li`, `h1`-`h6`, `td`/`th`, a blockquote or callout paragraph, or the Preview equivalents. For inline code, subtract the code's horizontal padding. Read it with `clientWidth` minus padding on that container.
- **Where hints live, per mode.** Hints go into text nodes only.
  - IR: the editable text of `p`, `li > p`, headings (never the `#` marker span), blockquotes, table cells, inline `<code>` and `.vditor-ir__link` text. For a callout, the hints go into the editable source half and into the rendered `.vmde-callout__preview` that is visible while the caret is outside. That preview is a `data-render` subtree that `callouts.ts` rebuilds, so it is re-hinted after each rebuild.
  - WYSIWYG: the same containers; inline code is `<code data-marker="`">`.
  - Preview: plain HTML, so no serialization risk there.
- **Serialization (P-C, verified).**
  - IR: `VditorIRDOM2Md` and `SpinVditorIRDOM` return the source byte-identical with hints in every container listed.
  - WYSIWYG: `VditorDOM2Md` and `SpinVditorDOM` keep heading, paragraph, bold, link, list, quote and callout text intact, but truncate every inline code span at the hint, in every container (`` `src/HCode.cs` `` became `` `src/` `` in the heading, paragraph, list, quote and callout).
  - So the WYSIWYG strip in `flattenSourceHtml`/`wrapLuteFlatten` (`media-src/src/editing/wysiwyg-code-highlight.ts:64-102`) must remove `.vmde-wrap-hint` from the whole HTML, not only from tables. Its early return at `:65` must also pass HTML that contains `vmde-wrap-hint`.
  - The strip must cover every WYSIWYG Lute entry that can see hints: `getMarkdown`, the incremental block path (`media-src/src/bridge/edit-sync.ts:958`), Vditor's copy (`vditor/src/ts/wysiwyg/index.ts:242`) and the Find map's block serialization (`media-src/src/editing/find-map.ts`). The cheapest guarantee is to strip in the wrapper around the Lute instance methods, which all of these call; Part 2 S1 confirms that each site goes through it.
- **Measurement cost outside tables (Task 573).** There is no clone and no Task 639 engine here; detection is read-only and in place.
  - Visible only: candidate blocks are the top-level blocks within about one viewport of the scroller, found with an IntersectionObserver as in Task 639 (`rootMargin: 100% 0px`). Blocks skipped by `content-visibility` are never read. Far blocks are planned when they come near.
  - String pre-filter, no layout: a word can only be too wide if its length in code points exceeds `lineWidth / (1.5 × font-size)`, assuming no glyph is wider than 1.5 em. At 700 px and 14 px that is 33 characters. Ordinary prose never reaches the layout step.
  - Layout step, one read phase per frame: for each candidate, the width is the sum of the widths of its Range client rects. P-D: a word broken over 3 fragments in a 200 px paragraph measured 526.81 px against a nowrap width of 526.80 px, so no clone is needed. Piece widths for the tiers are read the same way on sub-ranges.
  - Then one write phase. A plan cache keyed by (word text, font key, line width) makes re-hinting after a rebuild or a scroll back free.
  - Gate: the Task 573 numbers on the large fixture (open to ready, longest task, scroll p95, zero reads of off-screen blocks) must not regress. A large-document check with many long paths is added to S3.
- **Re-plan triggers outside tables.** First near-viewport visibility of a block; a line-width change of the block's container (one ResizeObserver on the surface; whether the existing width-change hook of the table normalizer can be reused is unverified, S1); `document.fonts` `loadingdone`; the typing pause for the edited block (Vditor rebuilds a block on input; the caret's text node waits for the pause, other text nodes of the rebuilt block get cached plans synchronously); a settings change (section 4); a content-theme or font-size change.

### 2. Order and exclusions

- **"Inline code first, then words too wide" (reading).** (a) Delivery: Part 2 implements and tests inline code in every container first, then other too-wide words. (b) Runtime: within one frame's planning budget, inline-code candidates are planned before other words, so the most common case is fixed first on large pages. A word is either inside code or not, so the two never compete for the same break.
- **Excluded (Owner):**
  - Hidden Markdown syntax: `.vditor-ir__marker*` spans, including link URLs, heading `#`, emphasis and code backticks.
  - Images: `img` and its IR source spans.
  - Inline HTML: IR/WYSIWYG `data-type="html-inline"`, `html-entity`, and the Preview's raw HTML elements other than the Markdown inline set.
  - Rendered widgets: math, diagrams and other `[data-render]` previews except the callout preview; wiki and code-ref chips; `contenteditable="false"` nodes; footnote references; the find, selection and table overlays.
- **Also excluded** (not inline text, own wrapping): fenced code blocks and their previews (`pre`), front matter, HTML blocks.

### 3. Break positions (final rule; supersedes the provisional rule)

- **Priority 1.** After the last character of a run of ASCII punctuation, when the next character is not punctuation. The set is `/ \ . , ; : _ - | = & ? # ! @ ~ + * % $ ^ ( ) [ ] { } < >`; quotes and the backtick are excluded. Opening brackets are ordinary separators, so `Option<IPageOwnershipTracker>` breaks after `<` (`Option<|IPageOwnershipTracker>`) and `Foo(bar)` after `(`. No break inside a run (`../`, `::`, `()`, `>(` stay whole).
- **Priority 2.** Unchanged: at a letter/digit boundary in either direction, never inside a digit run.
- **Priority 3.** Only between a lowercase letter and the next uppercase letter (`\p{Ll}` then `\p{Lu}`). No acronym splitting (`HTMLParser` gets no priority-3 position; its only break is the last resort).
- Never at a word start or end, inside a surrogate pair, before a combining mark, ZWJ or variation selector.
- Owner path with priority 1 (before the final-piece rule): `../`, `EncosyTower.`, `Tests.`, `EditorMode/`, `EncosyTower.`, `PageFlows/`, `PageFlowTestDoubles.`, `cs`.

### 4. Final-piece setting

- **Name:** `vmde.editor.wrapHints.minLastPiece`.
  - Type `integer`, default `3`, `minimum: 0`, `maximum: 20`, scope `resource`, like the other `vmde.editor.*` settings.
  - Description: "Long words are not broken before a last piece of this many characters or fewer. 0 allows any last piece."
  - Not tied to `vmde.editor.wrapColumn`, which rewraps the source and is unrelated.
- **Rule (exact).** For a word W and N = the setting: any break position p (any tier) with `graphemes(W.slice(p)) ≤ N` is dropped. Graphemes are counted with `Intl.Segmenter`, and the separators count. The rule is applied to the priority-1 positions before piece widths are checked for priority 2. The merged last piece is therefore measured and, if it is still too wide, it gets priority-2/3 positions, which the same rule filters again.
  - The rule applies to the end of the whole word only. A short first piece (`../`) and short inner pieces are allowed.
  - The last resort (CSS break anywhere) cannot honour N.
  - Owner path, N = 3: the position before `cs` is dropped, so the last piece is `PageFlowTestDoubles.cs`. At the P-B 800 px width, column 1 would read `../EncosyTower.Tests. | EditorMode/EncosyTower. | PageFlows/ | PageFlowTestDoubles.cs` (indicative; S1 re-measures). With N = 0 the old `… | cs` split returns.
- **Plumbing.** Add the key to `package.json` `contributes.configuration`, to `collectConfigOptions`/`VmdeConfigOptions` (`src/platform/editor-config.ts`, `src/shared/protocol.ts`, as `preview.reflowLineBreaks` does at `editor-config.ts:272`, `protocol.ts:119`), and read it in the webview `media-src/src/boot/live-config.ts`.
- **Live update.** `onDidChangeConfiguration` already posts `config-changed` for any `vmde.*` change scoped to the document (`src/session/editor-session.ts:1533-1558`, `src/webview-host/panel-config.ts:37-45`). On a changed N the webview clears the plan cache and re-plans near blocks and tables, with no Vditor re-init and no reopen. In tables the Task 639 min-content uses the priority-1 pieces after this rule, so a change of N also marks automatic tables for measuring again.

### Contract (replaces the provisional contract)

1. View-only: markdown, host bytes, dirty state, Undo/Redo history, caret steps, selection, copied text and Find matches are the same with and without hints, in IR, WYSIWYG and Preview.
2. Hint shape: `<span class="vmde-wrap-hint" data-render="1"></span>` plus `.vmde-wrap-hint::after { content: "\200B" }` in `main.css`.
3. Scope: every word whose width exceeds its line box, in the containers of section 1, minus the exclusions of section 2. A word that fits gets no hint.
4. Tiers: priority 1 (section 3); then priority 2 inside priority-1 pieces still too wide; then priority 3 inside priority-2 pieces still too wide; then today's break anywhere. The final-piece rule (section 4) filters positions at every tier.
5. Tables: Task 639 min-content uses the priority-1 pieces (after the final-piece rule) in clones only, so a path column can shrink without mid-word breaks; priority-2/3 hints are planned against the applied widths (automatic or Task 219 manual).
6. SV: unchanged (source text with its own wrapping); recorded, not tested beyond one check.
7. Only blocks and tables near the viewport are read or written; the Task 573 gate holds.
8. Hint writes are treated as non-content by every observer, by the Undo comparison and by every Lute serializer.

### Edge cases (additions and changes)

- Headings: the `#` marker is excluded. Heading text is often large, so the pre-filter uses the heading's own font size.
- List items and nested lists: the line box is the `li` content width at its nesting level. Task-list items: the checkbox is outside the text.
- Blockquotes and callouts: in IR the callout's visible preview is rebuilt by `callouts.ts`, so it is re-hinted after each rebuild. The callout title text is included and the `[!TYPE]` marker is excluded.
- Links: link text gets hints. The URL marker is hidden syntax (excluded); a bare URL in text is an ordinary word and gets hints (the common case for long URLs in prose).
- Emphasis spanning part of a word (`**src**/Path.cs`): the word crosses elements and is planned per text node part, as recorded for tables.
- Inline code wider than its line in a paragraph: code first (section 2).
- Section folding, `content-visibility` and hoisting: hidden or skipped blocks are not read. They are planned when they become near.
- Theme, font-size and outline/panel width changes alter line widths and re-plan near blocks only.
- The final piece is `≤ N` graphemes, so emoji and CJK count as one each.
- All earlier edge cases stay: CJK, emoji, very long hint-free runs, copy/paste, Find, caret, Undo scrub, mutation side effects. The mutation risk now covers the whole editor, not only tables.

### Test plan (replaces the earlier plan)

- **Vitest (pure, written first):**
  - `wrapBreakPositions(word)`:
    - Priority 1 after every separator run, including `<` and `(` (`Option<|IPage`), and nothing inside `../`, `::` or `()`.
    - Priority 2 on both sides of digit runs.
    - Priority 3 only lowercase to uppercase; `HTMLParser` gives none.
    - No positions at the ends, in surrogate pairs, in ZWJ emoji or before combining marks.
  - `planWrapBreaks(word, measure, limit, minLastPiece)`:
    - The Owner path at several limits; tier gating.
    - N = 3 drops the break before `cs`; N = 0 keeps it; N = 20 keeps a word whole when every break is within 20 graphemes of the end.
    - A merged last piece still too wide gets priority-2/3 positions that obey N.
    - An empty plan when the word fits.
  - Pre-filter `mayBeTooWide(length, lineWidth, fontSize)`.
  - Real-Lute round trip (`media-src/src/testing/real-lute.ts`) in IR and WYSIWYG with hints in a heading, paragraph, list item, blockquote, callout and table cell, each with inline code. Shown RED for WYSIWYG before the strip.
  - `undo-boundaries.test.ts`: a hint-only difference is not an edit.
  - The setting appears in `collectConfigOptions` (backend test next to the existing config tests).
- **Chromium (`media-src/e2e/wrap-hints.spec.ts`, fixture `media-src/e2e/fixtures/wrap-hints.md`).** The fixture has the Owner table plus the same long path as inline code and as plain text in a paragraph, a list item, a heading, a blockquote and a callout; a digit path; `HTMLParser…` in a narrow cell; a link with a long URL; CJK; emoji. Per mode IR, WYSIWYG and Preview:
  1. Line texts of each long word: breaks only at the expected positions from the contract, and no break before a last piece of 3 characters or fewer.
  2. A word that fits has no hint (count of `.vmde-wrap-hint` in short prose is 0).
  3. A forced narrow table column: lower-tier breaks only inside wider higher-tier pieces.
  4. `getValue()` is unchanged.
  5. Copy text equals the source selection.
  6. ArrowRight steps one character per press across hints.
  7. Typing in a hinted paragraph and in a hinted cell: other text keeps its breaks, and the edited word is re-hinted after the pause.
  8. Find matches across a hint in WYSIWYG.
  9. A live change of N (posted `config-changed`) re-plans without a reload (N = 0 brings the `cs` split back).
  10. Excluded nodes (markers, images, inline HTML, math) contain no hint.
- **Real VS Code (`test/vscode-e2e/wrap-hints.spec.ts`), as few `test()` blocks as states need:**
  - The fixture in IR, WYSIWYG and Preview: line texts and the table column widths.
  - Host text, disk bytes, dirty state and Undo/Redo lengths unchanged after layout.
  - OS (XTEST) typing in a hinted word: one Undo step, and Ctrl+Z restores the exact bytes.
  - OS Ctrl+C gives the source text.
  - Changing `vmde.editor.wrapHints.minLastPiece` in the settings updates the open editor live.
  - SV: one check that the source line is unchanged.
- **Reruns of specs that exercise changed files:** `table-auto-width`, `table-resize`, `copy-cut`, `find-replace`, `undo-boundaries`, `mutation-local`, callout specs, `large-document-interaction`, plus the Task 573 gate.

### Part 2 steps (replace the earlier steps)

- **S1 (measure, no source change).**
  - Harness baseline for the fixture in IR, WYSIWYG and Preview at 1280 and 800: line texts of every long word, table column widths and heights.
  - Probe 1: `splitText` hints into the caret's text node in IR and WYSIWYG, then type; check the caret, Vditor's caret restore and the spin output.
  - Probe 2: which MutationObservers react to a hint write, in a paragraph and in a table.
  - Probe 3: does every WYSIWYG Lute call site go through the wrapped Lute methods?
  - Probe 4: cost of the pre-filter and the read phase on the large fixture.
- **S2a.** Pure module (proposed `media-src/src/editing/wrap-hints.ts`, registered in `scripts/module-manifest.mjs`): positions, tiers, final-piece rule and pre-filter, with Vitest written first.
- **S2b, inline code first.** A hint engine for every container: a near-viewport observer, the read and write phases, the plan cache, and the rebuild re-apply with the caret's text node deferred. Also:
  - The WYSIWYG strip for the whole HTML.
  - The `withoutCaret` scrub.
  - Observer classification: a shared "own view mutation" check in `media-src/src/util/mutation-impact.ts`, used by Task 639's observer, the source block index and the seed observer, or `takeRecords()` after writes where supported.
  - Chromium cases for inline code.
- **S2c, then other words.** Extend the candidate set to plain, emphasis and link text; callout preview re-hinting; exclusions; Chromium cases.
- **S2d, tables (Task 639 interaction kept).** Priority-1 clone hints before the min-content layout (with the final-piece rule). Planning against applied widths. Re-plan at Task 219 drag end and auto-fit.
- **S2e.** The setting, host plumbing and live update; the backend config test; the Chromium live-change case.
- **S3.** Real-VS-Code spec, reruns, Task 573 gate with a long-path large document.
- **S4.** Closure.

### Provisional decisions (updated)

1. Mechanism and hint shape unchanged.
2. Priority 1 is always after the separator run, brackets included.
3. Priority 3 is lowercase to uppercase only.
4. Final-piece rule on the word end only, graphemes counted, separators included, applied before tier width checks; the last resort ignores it.
5. Setting name `vmde.editor.wrapHints.minLastPiece` (0 to 20, default 3, resource scope, live).
6. Detection outside tables in place (Range fragment widths) with a length pre-filter of 1.5 em per character.
7. Fenced code blocks, front matter and HTML blocks are out of scope.
8. "Inline code first" is read as delivery and planning order.

### Task title and file name (proposal)

The task is no longer specific to tables. Proposed title: "Task 640 — Prioritized wrap points for words too wide for their line". Proposed file name: `tasks/640-long-word-wrap-break-priority.md`. No tracked file links to the current name (searched `tasks/`, `docs/` and the root Markdown files), so only the file moves. The acceptance items should then read "in the example table and in the same words in paragraphs, list items, headings, blockquotes and callouts", and add one item for the setting.

### Open points for the Owner

1. Should the setting also protect a short first piece (`../`)? Provisional: no, last piece only, as decided.
2. Should fenced code blocks (which scroll today) stay out of scope? Provisional: yes.

## Execution progress — 2026-10-15 (Part 1 revision)

- Changed: this record only (section above).
- Commands:
  - Lute round trip in Node with hints in a heading, paragraph, list item, blockquote and callout, in IR and WYSIWYG, directly and after the spin (exit 0): IR identical; WYSIWYG truncates inline code in every container, other text intact.
  - Headless Chromium in-place width probe (exit 0): fragment sum 526.81 px against a nowrap width of 526.80 px, 3 fragments in a 200 px line.
  - Read the settings plumbing (`package.json` keys, `panel-config.ts`, `editor-session.ts`, `editor-config.ts`).
  - No build, Vitest, Chromium spec or real-VS-Code run.
- Open: the two Owner points above; Part 2 S1 to S4.

## Execution progress — 2026-10-15 (S1)

Measurement only; no product, test or generated file changed. The scratch harness, probe scripts and JSON outputs live under the ignored `tmp/640/`. Numbers below are counts, lengths, timings and booleans; no document text is recorded.

### Method

- **Harness.** The real webview entry (`main.ts`) as `finish-init.ts` boots it, served by a scratch server on a private port from the `shortcut-negative` harness page (Vditor from source with the shipped patches, the real `main.css`, the real Lute blob). `node build.mjs` ran first. The page gets an `init` reply as the host sends it (`e2e: true`), so every observer, the source index, edit-sync, Task 639 and Task 219 are live. Chromium headless, one fresh page per mode, viewport 1280 x 900 unless stated.
- **Hint prototype (scratch, not product).** `<span class="vmde-wrap-hint" data-render="1"></span>` plus `.vmde-wrap-hint::after { content: "\200B" }`, inserted with `splitText` + `insertBefore` only, no `contenteditable="false"`. Positions follow the "Break positions (final rule)" section; the planner follows the tier rule and the final-piece rule with N = 3.
- **WYSIWYG strip prototype (scratch).** A copy of the repository bundle in which `flattenSourceHtml` first removes `.vmde-wrap-hint` (before its early return), built by a scratch esbuild plugin; the repository file is unchanged. A flag switches it off to show the RED case.
- **Instrumentation (init script, before the bundle):** a `MutationObserver` subclass that records every instance (creation stack mapped to its module), its callback count and record count; a recorder around every method of every Lute instance (`Lute.New` wrapped): method, input length, whether the input contains a hint, time, stack; a `DataTransfer.setData` recorder for copy; a counter for measurement hosts added to `<body>` (Task 639/219 passes); the opt-in `__vmdeBlockHandleCacheMetrics.indexBuilds` counter (source index builds); the e2e ledgers `__vmdeMutationImpactStats`, `__vmdeTocInvalidationStats`, `__vmdeIncrementalSeedStats`.
- **Fixtures.** Probes 1-3: a document with the Owner path as plain text, as inline code, in a table cell, a heading, a list item, a quote and a callout (76-character path, 14 hints per path at all tiers). Probe 4: `test/vscode-e2e/fixtures/large-observable-models-synthetic.md` (174,517 characters, 265 top-level blocks in IR/WYSIWYG, scroll height about 22,300 px at 1280), plus two derived stress documents: the fixture three times (795 blocks, 545,570 characters) and a path-dense synthetic document (900 blocks, 2 paths per block, 238,159 characters).
- **Input.** Real key events (CDP key dispatch, trusted) for typing, arrows, Backspace, Delete, Shift+arrows, Ctrl+arrows, Ctrl+C; real mouse events for click/double-click. Undo/Redo called programmatically (`inner.undo.undo/redo`) because the harness blocks the browser default of Ctrl+Z as VS Code does.

### Probe 1 - caret and typing near and away from hint insertions: GO

- **Matrix (176 cases, final run).** Container {plain text, inline code, table cell} x hints {none, away from the caret (more than 6 characters), near the caret (within 6, including exactly at the caret), all 14} x action {type 2 characters at a non-position and at a hint position, Backspace, Delete, ArrowRight x12, ArrowLeft x12, Shift+ArrowRight x5 then replace by typing}; IR (84 cases), WYSIWYG with the strip (84), WYSIWYG without the strip (8).
- **Insertion itself.** 130 cases wrote hints around a live caret: the caret offset in the block was unchanged immediately and after 100 ms (130/130), the selection stayed collapsed (130/130), the caret's text node is replaced by the split head or tail (130/130, as the DOM spec says for a `splitText` at or before the caret).
- **Typing and edits.** `getValue()` equals the expected bytes in 84/84 IR cases and 84/84 WYSIWYG-with-strip cases (expected values built from the no-hint source by index arithmetic; table padding normalized). The caret after the action equals the no-hint control in 126/126 compared cases. Every block that was edited (type, Backspace, Delete, replace: 90 cases with hints) was rebuilt by Vditor and holds 0 hints afterwards (90/90), so typing re-plans exactly the edited block.
- **Arrows.** ArrowRight/ArrowLeft move exactly one character per press in all cases (12 presses each, 0 stuck presses). Shift+ArrowRight x5 selects exactly the next 5 characters in all cases; replacing that selection by typing gives the expected bytes.
- **Other gestures (6 cases = 3 containers x IR, WYSIWYG).** A non-collapsed selection set before the write keeps the same text (12 characters) after 14 hints are written (6/6). Double-click word selection selects the same 5-character word (6/6). Ctrl+ArrowRight stops are identical with and without hints (6/6). A click on the middle of a character puts the caret on the same character in 4/6 and one character off in 2/6 (the plain-text paragraph in IR and WYSIWYG): hints add about 0.009 to 0.011 px of width each (0.125 to 0.156 px for 14 hints, measured with a Range over the whole word), which moves a click that lands on a pixel boundary. Not a defect of the shape; recorded so the Chromium spec does not assert click offsets across hints.
- **Undo/Redo (12 cases = 3 containers x {hinted, control} x {IR, WYSIWYG}, fresh page each).** One Undo step per typing burst (12/12); Undo restores the exact bytes (12/12); Redo restores the typed bytes (12/12); no hint is left after Undo (12/12). Difference: the caret after Undo is 2 characters further than the pre-typing caret in the no-hint control, and exactly the pre-typing caret in the hinted case (6/6 pairs). Open: decide whether the contract "caret unchanged by hints" must normalize this (S2b), or accept it as Vditor's own restore using a snapshot that carries hint spans.
- **WYSIWYG without the strip (RED case).** Typing in a block with hinted inline code loses data: length change of -72 and -73 bytes (inline code in a paragraph), -216 and -219 (table cell); the no-hint control is correct. IR needs no strip (84/84 correct without it).
- **Go.** Conditions for S2b: only `splitText` + `insertBefore`; never replace a text node; no `contenteditable="false"`; the caret's text node needs no deferral for correctness (a hint split at the caret is safe), but an edited block is rebuilt by Vditor anyway, so deferral only avoids wasted work.

### Probe 2 - MutationObserver reactions to a hint write: CONDITIONAL GO (classification required)

- **Observers in a boot.** 49 `new MutationObserver` sites produce 60 live instances in IR and in WYSIWYG after open.
- **One write of 14 hints (42 records: 14 characterData, 28 childList; paragraph, heading, list item, quote and table cell, caret absent and caret in the text).** 34 instances (27 distinct modules) in IR and 35 (28 modules) in WYSIWYG ran their callback once for the batch, in paragraph and table alike (instances in `table-cell-selection`, `responsive-tables` x2, `table-resize`, `source-block-index`, `selection-bubble`, `link-popover`, `section-hoist`, `section-fold` x2, `webview-context`, `mutation-impact` x4, `link-like-semantics`, `diagram-semantics`, `toc-invalidation`, `code-ref-decorate`, `github-color-literals`, `diagram-zoom`, `diagram-controls`, `svg-data-image-adapter`, `html-subscript`, `inline-picture`, `wysiwyg-code-highlight`, `gap-paragraph`, `echarts-fit`, `observe-coalesce`, `render-cache-client`, `custom-diagrams`, `echarts-retheme`; WYSIWYG adds `native-popover-position`). A control window with no write ran 0 callbacks.
- **No loop, no post, no content change.** 0 callbacks in the three follow-up windows (0.25 to 2.25 s, to 4.75 s, to 7.25 s) for all 8 write cases; 0 `edit` posts (a caret case posts one `save-reading-position`, which is selection bookkeeping); `getValue()` unchanged; Undo depth unchanged; 0 follow-on DOM records on the editor surface (a raw record probe sees exactly the 42 own records); hints stay in the DOM (14/14).
- **The helper ledger** (`recordHelperMutationPass`) shows the scoped decorators ran one local pass each (`diagram-zoom`, `diagram-controls`, `custom-diagrams`, `render-cache`, `responsive-tables`, `toc-invalidation`) or one skipped pass (`section-fold-*`); `toc-invalidation` counted one `skippedImpacts` and 0 invalidations, 0 outline changes (heading, paragraph, cell).
- **Reactions that are real and need classification (each measured):**
  1. **Source block index** (`nav/source-block-index.ts`): its observer treats any non-attribute record as relevant, so `domRevision` increases and the entry is dropped. Measured with the build counter: 0 index builds for a control hover, 1 build for the first hover after a write (19/19 measured write cases in IR and WYSIWYG, every container: table, paragraph, heading, list item, quote, with and without a caret). Cost: one `snapshotPair` (a full serialization) per write batch for the next consumer. Consequence for the selection bubble: with a non-collapsed selection, a write elsewhere or in the same block hides the bubble for 3 frames and shows it again (IR 2/2, WYSIWYG 2/2; the no-write control stays visible for all 40 frames), because its bookmark is keyed on the index key.
  2. **Task 639 content observer** (`responsive-tables.ts` `onContentMutations`): a write inside an owned table counts as an edit, holds the table and runs one measurement pass (measurement hosts added to `<body>`: 1 pass within 4 s for the table cases, 0 for paragraph, heading, list, quote). Table class, column widths and the width rule element were unchanged afterwards (same 290/509 px, same rule length). Bounded (one pass per write batch), not a loop; but a planner that writes after every measurement must write nothing when the plan is unchanged, or each write costs a pass and a 600 ms hold.
  3. **Edit-sync seed observer** (`bridge/edit-sync.ts`): `seedMutationAffectsSource` is true for a hint write (target is not inside `data-render`), so a write while the seed is pending cancels it and restarts it from block 0. Measured on the 900-block path-dense document (host-canonical seed, reason `source-blocks`): no write: ready in 1774 ms, 900 block serializations, 89 batches; one write while pending: restarted, ready in 1184 ms after the restart, 1189 serializations (+289 redone); the engine sweeping during the seed: 1287 serializations (+387), ready. A continuous stream of writes would starve the seed.
  4. **Undo comparison and snapshot** (`undo-boundaries.ts` `sourceNeutral`, Vditor `addToUndoStack`): the predicate `withoutCaret(innerHTML) === withoutCaret(lastText)` is true before the write and false after it in 19/19 cases; it is true again when hint spans are scrubbed from the live HTML (19/19). Vditor's snapshot stores `innerHTML` with hint spans and diffs it against the previous snapshot: in WYSIWYG on the large fixture the first snapshot after 113 hints took 423 ms against 161 ms without hints (+262 ms), and the edit post came 200 ms later (1162 against 969 ms; Lute time unchanged at about 100 ms, strip about 6 ms).
  5. **Incremental IR cache** (`bridge/incremental-md.ts`): the block diff compares `outerHTML` strings; a hinted block differs from the cached string and is re-serialized once. On the 795-block document (35 blocks holding 532 hints) the first edit after the writes took 2845 ms against 1599 ms (+1.25 s once); the next edit 1491 against 1401 ms. The posted bytes were identical to the no-hint run.
  6. **Code-reference decorator** (`links/code-ref-decorate.ts`, prose only; inline code is matched on the whole `textContent` and is safe): it matches per text node. A hint inside `dir/File.cs:42` in prose splits the text node, and the tail alone matches as a different reference (regex check: whole text gives the full path, the tail gives only the file name). It also splits and replaces text nodes itself, so its chips and the hint cache must tolerate each other. Not exercised end to end (needs a host resolution reply); static plus regex evidence.
- **Correction to Part 1.** The "49 observers" are 49 call sites; the count in a boot is 60 instances.
- **Go/no-go.** Go only with one shared "own hint write" proof used by: the source index (`sourceNeutral` scope with an `accept` proof, or a hint-aware `relevantMutations`), the Task 639 content observer (ignore hint-only batches), the seed observer (ignore, or defer hint writes until the seed settles), the Undo comparison and snapshot (scrub spans in `withoutCaret` and in Vditor's snapshot text), the incremental block strings (scrub before comparing). The proof can be a WeakMap of the nodes the writer created or truncated with their expected data, so a later real edit of a split tail is not mistaken for a hint write.

### Probe 3 - WYSIWYG Lute call sites and the strip: GO

- **Instances.** 1 Lute instance in the webview (IR and WYSIWYG), so every call site uses it; no site stores a pre-wrapper reference (static read of `wiki-serialize`, `live-line-breaks`, `html-subscript` (chains), `block-handle`, `live-config`, `list-normalize`, `list-backspace`, `source-map`, `rewrap-command`, `html-subscript-command`, `edit-sync`: all fetch the method from `innerVditor().lute` at call time or chain it).
- **Dynamic coverage with the strip prototype on (hints in 6 containers, 84 hints).**

  | Site | Exercised by | Reached Lute with a hint | Result |
  | --- | --- | --- | --- |
  | `getMarkdown` / `getValue` (save, host snapshot) | `getValue()`, mode switch, edit post | 0 | bytes equal, 6/6 code spans intact (also after the switch to IR) |
  | Vditor input spin (`SpinVditorDOM` on the block) | typing in a block with hinted code | 0 | posted bytes keep 6/6 code spans, typed character present |
  | host `edit` post (`serializeForHost`) | typing in another block | 0 | 6/6 code spans in the posted bytes, +2 bytes for 2 typed characters |
  | Vditor copy handler | Ctrl+C on the code contents and on the whole paragraph | 0 | `text/plain` equal to the no-hint control (code and paragraph), `text/html` set empty in both |
  | Find map and index (`block-handle` `serialize`) | Find widget, 3 queries incl. one across hint positions | 0 of 33 calls | each query "1 of 6", same as the no-hint control |
  | mode switch (WYSIWYG to IR) | toolbar | 0 | 6/6 code spans after the switch |

- **RED without the strip.** `getValue()` 584 bytes short and 0 of 6 code spans intact; the edit post 582 bytes short; typing in hinted code loses the tail; the Find calls: 10 of 12 Lute calls carried hints; the copy of the code contents returned 6 characters. Find counts stayed "1 of 6" (they come from DOM text), so the Find defect shows only in the source mapping.
- **IR.** Hints reach Lute (16 Find-time calls carried hints) and every output is identical (value, edit post, Find "1 of 6", copy, mode switch); IR needs no strip. IR full serialization of the 311,602-character document took 729 against 776 ms over 5 calls with 113 hints (extra 5.9 KB of input), so scrubbing in IR is a small optimization, not a requirement.
- **Strip cost.** On the live innerHTML of the large documents: finding the marker with `indexOf` 0 ms; an exact string replace of the serialized span 0 ms (0.3 MB) and 0.8 ms (0.9 MB); a template parse + remove + serialize 5.7 ms and 27.2 ms; both give identical output (3 documents). Recommended: the string replace on the exact span form (`class` first, then `data-render`), template parse only as a fallback.
- **Corrections to Part 1.** `edit-sync.ts:958` is `explicitBlockMd` (the explicit block for the link button), not an incremental save path; the incremental serializer is IR-only (`irIncrementalElement` returns nothing unless the mode is IR). No other Lute site serializes WYSIWYG DOM. Not triggered end to end: `explicitBlockMd`, `rewrap-command`, the caret-token round trip in `source-map`, list normalization (call-time lookups, covered by the static read).
- **Go.** Strip in `flattenSourceHtml` (early return widened to pass hint-bearing HTML), no change to the two wrapped methods; the strip is outermost or chained, both work.

### Probe 4 - cost on the large fixture: CONDITIONAL GO (needs a frame budget and a clean-layout read)

- **Whole-document sweep (60 scroll stops, engine writes hints, near window of about one viewport above and below).**

  | Width and mode | Words read | Pre-filter pass | Too wide | Hints | Per run median / p95 / max | Document total |
  | --- | --- | --- | --- | --- | --- | --- |
  | IR 1280 | 7,617 | 84 | 6 | 14 | 0.2 / 0.6 / 4.4 ms | 19 ms |
  | IR 700 | 6,924 | 136 | 14 | 45 | 0.2 / 2.3 / 4.3 ms | 24 ms |
  | IR 480 | 5,865 | 273 | 47 | 113 | 0.2 / 2.6 / 4.9 ms | 34 ms |
  | WYSIWYG 1280 | 7,644 | 84 | 6 | 14 | 0.2 / 0.5 / 3.8 ms | 18 ms |
  | WYSIWYG 700 | 6,861 | 136 | 14 | 45 | 0.2 / 1.9 / 4.0 ms | 22 ms |
  | WYSIWYG 480 | 5,885 | 276 | 47 | 113 | 0.2 / 2.8 / 4.6 ms | 32 ms |

  The 1.5 em pre-filter rejects 98.9 percent (1280) to 95.3 percent (480) of words before any layout read; the fixture has few real too-wide words. `checkVisibility({ contentVisibilityAuto: true })` skipped 0 blocks in the near window, so the skip branch was not exercised (unverified).
- **Open (3 runs each, ready = first frame with the editor ready and blocks present).** IR 1280: no engine median 993 ms (901-1135), engine 894 ms (882-905); IR 480: 914 (891-951) against 935 (922-940); WYSIWYG 1280: 918 (913-1021) against 1016 (1005-1048); WYSIWYG 480: 981 (971-982) against 997 (973-1029). The engine's first run took 1.7 to 2.9 ms and starts after the ready time is recorded, so the ready differences (up to about 100 ms, WYSIWYG 1280) are run-to-run noise, not engine cost. Longest long task during open 523 to 650 ms in every group (the open itself). No open impact attributable to the engine.
- **Scroll (about 500 px per frame, engine run in the same frame after each step).** p95 frame time, median of 3 runs [range]: IR 1280 19.6 [17.1-19.8] against 17.7 [17.5-19.0]; IR 480 17.5 [17.3-17.5] against 19.1 [19.0-19.5]; WYSIWYG 1280 18.2 [17.3-18.3] against 19.1 [18.6-21.0]; WYSIWYG 480 17.7 [17.4-17.7] against 20.4 [19.1-23.6], worst frame 36.3 [28.9-38.5] against 18.9. Engine time over the scroll 39 to 71 ms in total, at most 14.4 ms in one step. No long task during scroll in any run.
- **Edit latency (type one character, time to the host post).** IR (not incremental on this fixture, 265 blocks): noise 397-907 ms with and without hints. WYSIWYG 1280: 986 against 996 ms; WYSIWYG 480 (113 hints): 964 against 1162 ms, explained by the Undo snapshot diff (+262 ms, probe 2 item 4), not by Lute (100 ms) or the strip (about 6 ms).
- **Stress: path-dense document (900 blocks, 2 paths per block).** Run synchronously right after each scroll step, the engine took 9.2 to 13.9 ms per step (median; maximum 23.4 to 36.8 ms) and scroll p50/p95/max went from 16.5/23.1/25.6 ms to 36.1/49.7/61.5 ms (IR 1280, 44 too-wide words, 264 hints), from 16.7/18.7/20.4 to 40.1/76.8/94.8 ms (IR 480, 5,200 hints) and from 16.6/21.9/27.3 to 43.3/85.3/103.2 ms (WYSIWYG 480, 5,200 hints). Attribution (IR 1280, 100 steps): 1033 of 1435 ms in 1,262 Range width reads (0.8 ms each), context reads 210 ms, planning 16 ms, writes 9 ms, forced layout after writes 123 ms. Cause: the first geometry read after a scroll lays out the blocks that just became relevant (content-visibility), so the read pays the layout. Re-running the same engine on clean layout (two frames later): median 2.9 ms (IR 1280) and 8.0 ms (IR 480) per run for the whole near window, width reads 0.6 and 0.3 ms in total, against first-run medians of 42.4 and 26.4 ms.
- **Baseline for the Owner table (two columns, hinted with the tier planner N = 3; Task 639 widths unchanged because min-content does not yet use hints).** At 1280: widths 290/509 px, table 800 px wide; column 1 wraps in 3 lines with 2 breaks, both mid-word without hints; with hints both are priority-1 breaks, table height unchanged (IR 118.7 px, Preview 119 px; WYSIWYG 140.6 px falls to 118.7 px). At 800: widths 251/442 px, table 694 px wide; without hints 3 lines (2 mid-word breaks in IR and Preview, 1 mid-word plus 1 priority-3 break in WYSIWYG); with hints 4 lines, 3 priority-1 breaks, 0 mid-word breaks, height +21.9 px in IR (118.7 to 140.6), WYSIWYG unchanged at 140.6, Preview +22 px (119 to 141). Only priority-1 hints were planned (6 per path), because every priority-1 piece fits the column.
- **Go/no-go.** Go, with these changes to S2b: (a) read widths only after the frame's layout is clean (second frame or idle callback), never synchronously after a scroll; (b) a per-frame time budget (about 4 ms) with a resumable queue, near blocks that are really rendered only; (c) a tighter pre-filter than 1.5 em for monospace code (use the measured advance of the container's font, cached per font key), because at 14 px the 1.5 em rule passes every 61-character path; (d) cache line width and font per surface width, not per block; (e) one write phase, then no forced layout; (f) the Task 573 gate with the path-dense document (900 blocks) at 480 and 1280 as an acceptance document in S3.

### Go/no-go summary for the Part 2 plan

| Probe | Verdict | Gate for S2b |
| --- | --- | --- |
| 1 caret, typing, arrows, selection | Go | Chromium cases: no-op for click offsets; decide the Undo caret difference |
| 2 observers | Conditional go | one shared own-write proof for 5 consumers (source index, Task 639, seed, Undo, incremental cache); code-ref prose hazard in S2c |
| 3 Lute call sites | Go | strip in `flattenSourceHtml` with a string replace; IR needs none; RED real-Lute test first |
| 4 cost | Conditional go | clean-layout reads, 4 ms frame budget, tighter pre-filter, path-dense document in the Task 573 gate |

### Commands and results

- `node build.mjs`: exit 0.
- Scratch probes through a private Chromium and a private HTTP port, each under `xvfb-run -a node tmp/640/<probe>.mjs`: the final version of every probe exited 0 (probe 1: 176 cases plus 6 gesture cases and 12 Undo/Redo cases; probe 2: 8 write cases, 19 index/Task 639/Undo-predicate cases, 6 bubble cases, 3 seed scenarios; probe 3: 5 runs; probe 4: 6 sweeps, 24 open/scroll/edit runs, 2 edit runs on the 795-block document, 3 strip-cost runs, 6 path-dense runs, 2 attribution runs). Earlier iterations of probes 1, 1c, 2b and 4c threw or produced wrong expected values because of defects in the scratch script (a live caret intent re-placing a programmatic caret, a table re-aligned by Lute, a stale text-node lookup, a readiness poll on the wrong root); they were fixed and rerun, and their output is not used. One of 20 cases in the index/Task 639/Undo-predicate run (WYSIWYG blockquote with a caret) failed its text-node lookup and is not counted (19 measured).
- No Vitest, repository Chromium spec, lint or typecheck run (no repository file changed besides this record).
- Leftover-process check after the last run: no process of this step is running (the only matches are the desktop session processes that are not mine); the scratch server was closed by each probe.

### Open and unverified

- Real VS Code was not run (no token); every number is from the Chromium harness. IME composition near a hint was not run. The `contentVisibilityAuto` skip branch was not exercised. `explicitBlockMd`, `rewrap-command`, the caret-token round trip and list normalization were checked statically only. The code-reference decorator hazard was not run end to end.
- The large fixture's seed does not complete with a seed built by the host function (an ordered-list block does not locate in the canonical text), so the seed probe used the path-dense document; that fixture behavior is unrelated to hints and was not investigated.
- Decision for the Owner or orchestrator: the Undo caret difference (hinted case restores the pre-typing caret, the no-hint case 2 characters further).
