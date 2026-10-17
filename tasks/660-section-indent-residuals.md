# Task 660 — Fix section indentation residuals in Preview

**Status:** open.
**Origin:** Project Owner request (known issue from Task 649).
**Severity:** low.
**Tech stack:** Preview renderer, first-paint overlay script, and table layout in the webview.
**Related:** [Task 649](done/649-section-indentation-by-heading-level.md) (section indentation by heading level).

## Problem

Four residual issues remain from Task 649:

1. In Preview, a heading inside a raw HTML block renders as a top-level heading and is treated as a section heading. IR and WYSIWYG are unaffected.
2. The first-paint overlay script does not account for `<details>` sibling blocks.
3. The Preview footnote selector (`.footnotes-defs-div, .footnotes-defs-ol, ol.footnotes-defs`) was checked only in jsdom.
4. A table whose column minimum widths exceed the room left by the indentation overflows by the difference.

## Requirements

1. A heading inside a raw HTML block gets the correct depth in Preview.
2. The first-paint overlay marking accounts for `<details>` sibling blocks.
3. The Preview footnote selector is verified in the real webview.
4. Narrow tables have a decided behaviour. The candidate named in the brief is horizontal scroll inside the block; the decision is to be settled in Part 1.

## Open design points

- Narrow-table behaviour: to be decided in Part 1.
- To be settled in Part 1 for the other requirements.

## Scope

- In: the four residuals above.
- Out: IR and WYSIWYG section indentation, which are unaffected.

## Acceptance

- [ ] In Preview, a heading inside a raw HTML block has the correct depth and is not a top-level heading.
- [ ] `<details>` sibling blocks are marked correctly by the first-paint overlay.
- [ ] The Preview footnote selector is verified in the real webview.
- [ ] A narrow table follows the decided behaviour and does not overflow the block.

## Tests

- Real-VS-Code verification for the Preview and overlay behaviour, and the footnote selector check in the real webview. Exact specs are to be specified in Part 1.

## Part 1 handoff (2026-10-18)

Task 660, section indentation residuals. Read-only Part 1 at `dev` HEAD `1985ceb2`. Node probes ran against the vendored Lute (`media-src/vendor/lute/lute.min.js`, which is byte-identical to `media/vditor/dist/js/lute/lute.min.js` by `cmp`). The probe scripts are in a scratch folder outside the repository. Lute was set up as Vditor's preview Lute: sanitize, footnotes, callout, GFM autolink, code and math block preview, and `SetHeadingID(true)`.

### Verified facts

Each fact below was checked by reading the file at the line given, or by a probe that was run.

**Preview DOM and HTML blocks (residual 1)**

- Preview HTML is `vditor.lute.Md2HTML(markdownText)`, set as `previewElement.innerHTML` (`media-src/node_modules/vditor/src/ts/preview/index.ts:196-205`). The markdown first goes through VMDE's Preview-only source masks. The build patch rewrites the binding to `vmMaskSvgDataImagesForPreview(vmMaskCommentsForPreview(getMarkdown(vditor)))` (`media-src/esbuild-shared.mjs:3092-3112`), and `test/backend/vditor-source-patches.test.ts:3140-3157` pins that exact string. `maskCommentsForPreview` (`media-src/src/editing/html-comment.ts`) already sets the precedent: it rewrites the source so that a `<div class="vmde-comment" data-vmde-comment="1">` survives the sanitizer.
- **Probe 1 and probe 3:** `Md2HTML` emits a raw HTML block verbatim. It adds no wrapper, no class and no `data-*` attribute.
  - `<h2>Bare</h2>` comes out as `<h2>Bare</h2>`.
  - `<div>\n<h2>Inside</h2>\n</div>` keeps the h2 nested in the div, so it is not top level and is already correct.
  - `<div></div>\n<h3>second line</h3>` gives a top-level h3.
  - `para <h2>inline</h2> tail` becomes `<p>para <h2>inline</h2> tail</p>`. The browser then hoists the h2 out of the p, so it is top level.
  - `<details>…## x…</details>` gives a real `<details>` element in Preview, so headings inside it are nested and already correct.
  - So the failure exists only for **top-level raw `<hN>` elements**, from an HTML block or from inline HTML that the parser hoists.
- **Probe 2 and probe 3:** with `SetHeadingID(true)`, every Markdown heading gets an `id`. An empty `#` gets `id=""`. A raw HTML heading has an id only when the author wrote one (`<h2 id="Bare2">` keeps it). Without `SetHeadingID` no heading gets an id.
- **The id cannot be used as the test.** Vditor's outline rewrites the id of every top-level Preview heading, raw ones included, to `<base>_<index>` (`media-src/node_modules/vditor/src/ts/markdown/outlineRender.ts:7-12`). It runs synchronously in `afterRender` (`preview/index.ts:249`), so it finishes before the indent controller's MutationObserver callback runs. After the rewrite, an id-less raw heading has id `_N`, which is the same as an empty Markdown heading.
- **Probe 4 and probe 5:** a JS renderer cannot do the marking. `SetJSRenderers({Md2HTML:{renderHTML}})` is never called by the vendored Lute: zero calls, output unchanged, even with the renderer defined inside the Lute realm.
- **Probe 6:** a Preview-only source rewrite that adds `data-vmde-raw-heading="1"` to raw `<hN` opening tags does survive the sanitizer. Every raw top-level heading came out marked and every Markdown heading came out unmarked:
  - marked: the bare block, the uppercase `<H3 class id>` (Lute treats it as inline HTML in a `<p>`, and the browser hoists it), the HTML-block continuation line, and the inline one in a paragraph;
  - not rewritten: the code span, the backslash escape, indented code, fenced code, `<textarea>` content, the `$$` math block and front matter.
- `describePreview` treats every top-level `H1-H6` as a section heading (`media-src/src/nav/section-indent.ts:189-202`). The controller test feeds Preview id-less `<h2>x</h2>` and expects depth 1 (`media-src/src/nav/section-indent-controller.test.ts:82-94`). That test stays valid under the decided rule.

**Overlay (residual 2)**

- The overlay holds the host's `Md2VditorIRDOM` or `Md2VditorDOM` output inside `#vmde-prerender … pre.vditor-reset` (`src/webview-host/html-builder.ts:163-171`, `src/lute/lute-host.ts:389-405`).
- The marking script is at `html-builder.ts:207-213`. It walks every child with no `data-block` filter and no Details handling.
- The live rule pairs `<details>`/`</details>` tags from each `html-block`'s `pre code` source with a stack. It gives the blocks in between no heading level (`section-indent.ts:143-187`), and it walks `topLevelBlocks`, which are children with `data-block` (`media-src/src/nav/section-range.ts:15-20`).
- **Probe 7 (IR and WYSIWYG overlay DOM):** a Details element is split into sibling blocks: `div[data-type=html-block]` holding `<details>…<summary>` in its first `pre code`, then the body blocks (`H2`, `P`, …), then a `div[data-type=html-block]` holding `</details>`. A one-line `<details>…</details>` is a single html-block. The two modes have the same structure; IR puts the source in `pre.vditor-ir__marker--pre > code`, WYSIWYG in the first `pre > code`. The footnote and link-ref blocks carry `data-block` and their `data-type`.
  - For `# Top, intro, <details>, ## InDetails, body, ### Deeper, deep body, </details>, after, ## After …`:
  - The **current** script marks `InDetails=1, body=1, Deeper=2, deep body=2, </details>=2, after=2`.
  - The live rule, and the **proposed** script below, mark them all `0`. After that, `## After=1`, a one-block `<details><summary>` pair keeps its `#### x` inner heading at the running depth `1`, `### Third=2`, and footnotes and link-refs are `0`.
  - The proposed script gives the same results in IR and WYSIWYG.
- `test/backend/html-builder.test.ts:590-608` checks only that the script is present or absent.
- The real-VS-Code hold `VMDE_PRERENDER_PARITY_HOLD` keeps the overlay until `__vmdeReleasePrerender()` is called (`html-builder.ts:200-205`). A spec can then read the overlay before the swap and the live editor after it (`test/vscode-e2e/prerender-style-parity.spec.ts:65-140`).

**Footnotes (residual 3)**

- **Probe 1:** the Preview footnote output is a top-level `<div class="footnotes-defs-div"><hr class="footnotes-defs-hr"/><ol class="footnotes-defs-ol">…</ol></div>`, placed at the document end even when the definitions were written mid-document.
- `ol.footnotes-defs` does not exist. `.footnotes-defs-ol` is never top level. Link-ref definitions render nothing in Preview.
- The selector at `section-indent.ts:111-113` matches through `.footnotes-defs-div` only. No other VMDE code touches these classes (grep of `media-src/src`, `media-src/e2e`, `test/vscode-e2e`).

**Tables (residual 4)**

- A Markdown table is itself the indented top-level block.
- `responsive-tables.ts` pins every table inline with `width`/`max-width: calc(100% - var(--vmde-indent-offset, 0px)) !important` (`media-src/src/chrome/responsive-tables.ts:554-557`), together with `display: table` and `table-layout: fixed`. `isOwnedNormalizedAttribute` compares only these properties (`:573-583`).
- `fillWidth` targets the parent content width minus the start margin (`:157-172`).
- `main.css:3046-3069` sets `--vmde-indent-offset` with `@property` (`inherits: false`) and sets `margin-inline-start` per depth. `main.css:1481-1486` sets fixed layout and `max-width: 100%`.
- Task 478 deliberately moved tables from `display: block` to `display: table` (`main.css:1472-1480`), and a table box cannot scroll.
- When the column minima do not fit, `allocateColumnWidths` falls back to equal widths (`media-src/src/chrome/table-column-widths.ts:65-85`). Task 649 measured the physical floor at about 27 px per cell.

### Decisions

1. **Raw HTML heading (residual 1): mark it in the Preview source and skip it in `describePreview`.**
   - New module `media-src/src/nav/preview-raw-headings.ts`. It exports `RAW_HEADING_ATTR = 'data-vmde-raw-heading'` and `markRawHeadingsForPreview(md: string): string`.
   - Fast path: return `md` unchanged when `/<h[1-6]/i` does not match.
   - Otherwise scan line by line and rewrite each `<h([1-6])` followed by whitespace, `/` or `>` (case-insensitive) to `<h$1 data-vmde-raw-heading="1"`. Skip:
     - fenced code (same fence rule as `html-comment.ts`);
     - `$$` blocks;
     - leading front matter (`---` … `---`/`...`);
     - type-1 raw blocks (`<pre|script|style|textarea` until the closing tag);
     - lines with 4 or more leading spaces or a tab (such a heading cannot be top level);
     - single-line code spans;
     - tags preceded by `\`.
   - The prototype is in `probe6.js`.
   - Chain it after the comment mask so escaped comments are never touched: `vmMaskSvgDataImagesForPreview(vmMarkRawHeadingsForPreview(vmMaskCommentsForPreview(getMarkdown(vditor))))`.
   - It always runs, whether or not indentation is on, so a live enable finds the marks already in the DOM. It applies to Preview and to Split's preview pane, which share `Preview.render`.
   - `describePreview`: a top-level `H1-H6` element with `RAW_HEADING_ATTR` gets no `headingLevel`, so it takes the running depth. This matches IR and WYSIWYG, where such a heading is a non-heading `html-block`.
   - Rejected: the id test, because of the outline rewrite above; the JS renderer, because it is never called; a wrapper element, because it changes the DOM and the copy output.
2. **Overlay Details (residual 2): mirror `describeEditSurface` in the inline script.**
   - Walk only children with `data-block`.
   - First pass: Details pairing from each `html-block`'s `pre code` text with `/<(\/?)details\b[^>]*>/gi` and a stack. An unmatched tag pairs nothing, and an open and close in the same block pairs nothing.
   - Second pass: the existing depth loop, ignoring the heading level of paired-body blocks.
   - The exact script, as run in probe 7 (as a JS string literal it needs `\\/` and `\\b`):

   ```js
   (function(){var p=document.querySelector('#vmde-prerender pre.vditor-reset');if(!p)return;p.setAttribute('data-vmde-indent-root','');var b=[],c=p.children,i,k,e,m;for(i=0;i<c.length;i++)if(c[i].hasAttribute('data-block'))b.push(c[i]);var x=[],o=[];for(i=0;i<b.length;i++){if(b[i].getAttribute('data-type')!=='html-block')continue;var q=b[i].querySelector('pre code'),s=q?q.textContent:'',r=/<(\/?)details\b[^>]*>/gi;while((m=r.exec(s))){if(!m[1]){o.push(i);continue}var a=o.pop();if(a===undefined||a===i)continue;for(k=a+1;k<i;k++)x[k]=1}}var d=0;for(i=0;i<b.length;i++){e=b[i];var t=e.getAttribute('data-type');if(t==='footnotes-block'||t==='link-ref-defs-block')continue;m=!x[i]&&/^H([1-6])$/.exec(e.tagName);if(m)d=Math.min(+m[1]-1,5);if(d)e.setAttribute('data-vmde-indent',String(d))}})();
   ```

   - It stays an inline string in `html-builder.ts` because the CSP nonce script must stay small. It is still skipped for a saved Split mode.
3. **Footnote selector (residual 3):** narrow `PREVIEW_TAIL` to `'div.footnotes-defs-div'` and replace the comment with the probed structure. Behaviour does not change; the real-webview check is the acceptance item.
4. **Narrow table (residual 4): waiting on Owner question 1.** The recommendation is to cap the table's indentation. The Part 2 steps below are written for the cap; the alternatives are noted in the question.
   - Cap mechanism:
     - `responsive-tables.ts` records the table's floor, meaning its rendered width while it is wider than `inner - offset`, where `offset` is the computed `--vmde-indent-offset` and not the current margin.
     - It writes the floor inline as `--vmde-table-floor: <px>`, only when the value changes, and removes it once the table fits `inner - offset`.
     - New CSS rule: `body[data-section-indent="1"] [data-vmde-indent-root] > table[data-vmde-indent] { margin-inline-start: max(0px, min(var(--vmde-indent-offset), 100% - var(--vmde-table-floor, 0px))); }`.
     - Result: the table loses only as much indentation as it needs to end at the column edge. With the setting off, nothing is written.
   - Overflow beyond today's baseline remains only when the floor is wider than the whole column, which is today's behaviour for an unindented table.

### State / DOM / messages

- New Preview DOM attribute `data-vmde-raw-heading="1"`, on raw `<hN>` elements only (Preview and Split preview pane). It has no styling, travels in copied HTML (like `data-vmde-comment`), and never reaches the saved markdown, because the mask is Preview-only.
- New inline table custom property `--vmde-table-floor` (only if the cap is chosen). It is written by the normalizer, which owns that table's `style`. `source-block-index` and `table-resize` already treat `style` as neutral or geometry.
- No new message and no new setting.

### Part 2 steps

- **S1 probe (Chromium, only if Owner question 1 picks the cap). Throwaway; record the results in the task file.**
  - At 520 px viewport, step 64, depth 5, use a 30-column table in IR, WYSIWYG, Preview and Split preview, and confirm:
    - (a) while the table overflows, `getBoundingClientRect().width` is the same before and after changing its margin, so the floor is stable;
    - (b) `getComputedStyle(table).getPropertyValue('--vmde-indent-offset')` returns a px value;
    - (c) a `margin-inline-start` percentage resolves against the parent content width.
  - If (a) fails, fall back to the clone's `min` layout width from `measureColumns` and record the reason.
- **S2 raw headings.**
  - Owned files: `media-src/src/nav/preview-raw-headings.ts` (new), `media-src/src/nav/section-indent.ts`, `media-src/esbuild-shared.mjs` (`patchPreviewComments` chain and import), `scripts/module-manifest.mjs` (`nav` ids: `preview-raw-headings`), `test/backend/vditor-source-patches.test.ts`.
  - RED first:
    - Vitest `media-src/src/nav/preview-raw-headings.test.ts` for the rewrite rules: bare, uppercase with attributes, continuation line, inline, and every skip case from Decision 1.
    - Vitest end-to-end `test/backend/preview-raw-headings-lute.test.ts` (jsdom): real Lute `Md2HTML` of the masked source, then the top-level heading set is exactly the Markdown headings.
    - Controller test case in `section-indent-controller.test.ts`: Preview `<h1>`, `<h2 data-vmde-raw-heading="1">`, `<p>` gives depths `[null, null, null]`, and `<h3>` after it gives `'2'`.
    - Updated patch-string assertion.
  - Checks: the four Vitest files, `test/backend/module-boundaries.test.ts`, and the lint for touched files.
- **S3 overlay.**
  - Owned files: `src/webview-host/html-builder.ts`, `test/backend/html-builder.test.ts` (or a new `test/backend/overlay-indent-script.test.ts`, jsdom).
  - RED first: build the HTML with `preRenderedHtml` set to real host Lute IR and WYSIWYG output of the probe-7 document (`renderForMode`, or Lute through `luteArtifactPath`, as `lute-block-repair.test.ts:385-400` does). Execute the emitted script in jsdom and expect the depths to equal the output of `installSectionIndent` on an `ir`/`wysiwyg` surface built from the same HTML.
- **S4 footnote selector.**
  - Owned file: `section-indent.ts` (the constant and its comment).
  - Covered by the existing controller test at lines 82-94 and by the real-VS-Code test below.
- **S5 table cap (after Owner question 1).**
  - Owned files: `media-src/src/chrome/responsive-tables.ts`, `media-src/src/chrome/responsive-tables.test.ts`, `media-src/src/main.css`.
  - RED first:
    - Vitest: the floor is written only while the table overflows `inner - offset`, written only on change, and cleared when the table fits; nothing is written with the offset at 0.
    - Chromium: the new case in `media-src/e2e/section-indent.spec.ts` below.
- **S6 Chromium spec.**
  - File: `media-src/e2e/section-indent.spec.ts`. New cases, written first and seen RED:
    - `preview and sv: a raw HTML heading takes its section's depth` (bare block, inline, continuation line);
    - `preview: footnote list stays at depth 0 under a deep section`;
    - `${mode}: a table wider than the room left keeps its floor and ends inside the column`, for all four surfaces, at 520 px, step 64, depth 5.
  - Command: `xvfb-run -a npm --prefix media-src run test:e2e -- section-indent.spec.ts`.
- **S7 real VS Code.**
  - Run `node build.mjs`, then `env -u ELECTRON_RUN_AS_NODE xvfb-run -a npm --prefix test/vscode-e2e test -- section-indent.spec.ts`.
  - Add two `test()` blocks to `test/vscode-e2e/section-indent.spec.ts` (described in the next section).
- **Closure:** `npm run quality` and the coverage check for the changed modules, as DEVELOPMENT.md requires. Update the task record.

### Tests mapped to Acceptance

| Acceptance item / edge case | Cheapest layer | Real VS Code |
|---|---|---|
| Raw HTML heading has its section's depth and is not a section heading | Vitest: the mask rules, Lute end to end, and the controller | Test A |
| Inline `<h2>` in a paragraph; uppercase tag; continuation line | Vitest (mask + Lute) | — |
| Code span, fenced or indented code, escape, textarea, math, front matter are unchanged | Vitest (mask) | — |
| Heading inside `<div>` or `<details>` stays nested (no change) | Vitest (Lute end to end) | — |
| `<details>` sibling blocks get the live editor's marks in the first-paint overlay, IR and WYSIWYG | Vitest (jsdom executes the emitted script on real Lute output) | Test B (IR) |
| One-block `<details>…</details>`; unmatched tag | Vitest | — |
| Footnote selector verified in the real webview | Vitest (existing) | Test A |
| Narrow table follows the decided behaviour, ends in the column, no overflow beyond the unindented baseline | Vitest (normalizer) + Chromium (partial cap, four surfaces) | Test A (full cap with a 60-column table, whatever the window width) |
| Setting off: no `--vmde-table-floor`, Preview DOM otherwise unchanged | Vitest + existing Chromium off cases | — |

Real-VS-Code spec, two `test()` blocks:

- **Test A:** `preview: raw HTML heading, footnote list and an over-wide table follow the residual rules`.
  - One fixture in Preview, indentation on, step 24.
  - Assertions:
    - a raw `<h2>` under `###` measures `2 x step`, the same as its neighbours, and does not start a section;
    - the next Markdown `##` is at 1 step;
    - `div.footnotes-defs-div` has no `data-vmde-indent` and offset 0;
    - a 60-column table under `####` has offset 0, because the floor is wider than any test-window column, and its overflow with the setting on is at most `max(overflow off, 0) + 1`.
- **Test B:** `ir: the first-paint overlay marks Details sibling blocks like the live editor`.
  - With `VMDE_PRERENDER_PARITY_HOLD`, read the `data-vmde-indent` of the overlay's top-level children before release and the live IR's after release.
  - The two arrays are equal, and a `##` inside a paired Details has no mark.

### Owner questions

1. **How should a table behave when its columns cannot fit in the room left by the indentation?**
   - **Cap the table's indentation (recommended).** The table moves left only by its shortfall and ends at the column edge. It is still indented as far as possible. No layout model change, no new scroll container in the editable DOM, and it works the same in all four surfaces. The cost: in a very narrow pane its left edge no longer lines up with its section.
   - **Horizontal scroll inside the indented block.** The table keeps its full indentation and scrolls on its own. This needs `display: block; overflow-x: auto` on those tables, which goes back on Task 478's `display: table`. It also risks table editing in IR and WYSIWYG: caret, table-resize handle positions, cell selection overlay and block handles inside a scrolled box. For consistency it would arguably need to apply to unindented over-wide tables too, which is outside this task.
   - **Accept the overflow.** No work, and the same as an unindented over-wide table today. It does not meet acceptance item 4 as written, so the record would need changing.

### Residual risks

- The raw-heading mask is a line scanner, not a full CommonMark parser. Known leftovers:
  - a multi-line code span with `<hN` on a continuation line would show the attribute text inside the code;
  - a raw heading on a line indented 4 or more spaces that still ends up top level is not marked;
  - HTML-block start rules that Lute applies differently (Lute treats uppercase `<H3` as inline) only change which element the browser hoists, not the mark.
- `data-vmde-raw-heading` appears in Preview's copied HTML, as `data-vmde-comment` already does. Vditor's Preview outline still lists raw headings; that is outside this task.
- The overlay script copies the Details-pairing logic in `section-indent.ts`. The S3 Vitest compares the two on real Lute output to catch drift, but there is no shared source.
- The table cap depends on S1. If the overflowing width is not a stable floor, the fallback (clone min-content width) can differ from the fixed-layout floor by cell padding.
- The real-VS-Code Test A table case proves the full cap only, at offset 0. The partial cap is proven in Chromium only, because the column width of the VS Code test window is not controlled.
- IR and WYSIWYG behaviour for inline `<hN>` in a paragraph was not examined (out of scope; the record says those modes are unaffected).
- None of the Part 2 tests have been written or run.

**Owner answer (2026-10-18, chat):** Q1 — cap the table's indentation (recommended option); S1 and S5 proceed.
