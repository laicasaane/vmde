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
