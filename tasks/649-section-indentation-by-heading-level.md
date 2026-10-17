# Task 649 — Indent each section by its heading level

**Status:** open.
**Origin:** Project Owner feature request.
**Severity:** feature (low to medium risk; display only, across every mode).
**Tech stack:** extension host settings (`package.json` contributes, `src/platform/editor-config.ts`, `src/shared/protocol.ts`, `src/webview-host/html-builder.ts`), webview (`media-src/src/boot/live-config.ts`, section structure from [Task 258](done/258-section-folding.md)), CSS (`media-src/src/main.css`, content themes), Vitest, Chromium, real VS Code.
**Related:** [Task 258](done/258-section-folding.md) (section folding: the heading-to-section structure), [Task 438](done/438-vscode-native-preview-margins.md) and [Task 497](done/497-full-width-top-padding.md) (page margins and `--vmde-gutter`), [Task 300](300-content-width-presets.md) (content-width presets, planned), [Task 250](250-heading-numbering.md) (automatic heading numbering, planned).

## Problem

Every section of a document starts at the same left edge, whatever its heading level. In a long document with nested headings (`##` inside `#`, `###` inside `##`), the nesting is visible only from heading sizes, so it is hard to see where a subsection belongs.

## Requirements

1. **Indent sections recursively.** A new setting, off by default, indents each section by its depth: the content under a level-2 heading is indented one step, under a level-3 heading two steps, and so on, for every level. A section ends at the next heading of the same or a higher level, so its indentation ends there too.

   ```markdown
   # Guide                     ← no indent
   Intro text.                 ← no indent
   ## Install                  ← 1 step
   Install text.               ← 1 step
   ### Linux                   ← 2 steps
   Linux text.                 ← 2 steps
   ## Use                      ← 1 step
   ```

2. **One size setting.** A second setting sets the size of one indentation step, applied at every depth (depth × step).
3. **Every mode.** Both settings take effect in WYSIWYG, Instant Rendering, Split (source pane and preview pane) and Preview. *Amended by the Owner (2026-10-17): the Split source pane is not indented; only its preview pane is.*
4. **Display only.** Indentation never changes the document text, dirty state, Undo history, caret or selection, and is not copied, exported or saved.
5. **Live and scoped.** Both settings apply live, without reopening the editor, and have `resource` scope like the other `vmde.editor.*` settings. Invalid values fall back to the default.
6. **Layout stays correct.** Indented content keeps working with: section folding and hoisting, the outline and its viewport highlights, block and list gutter handles, fold glyphs, Git change bars, wide content (tables, code blocks, diagrams, images), the full-width and narrow layouts, and the Split View scroll sync.

## Open design points (settled in Part 1)

- Setting names and value format (proposed: `vmde.editor.sectionIndent` boolean and `vmde.editor.sectionIndentSize` in pixels, with a default and an allowed range).
- Whether the heading line itself is indented with its section's content (as in the example) or one step less, and whether the first level starts at depth 0 when a document's top heading is `##`.
- How depth is computed: from the heading level in the source, or relative to the nearest enclosing heading (a `####` directly under `##`); headings inside lists, quotes, Details or callouts.
- How Split's source pane shows indentation for raw Markdown (visual offset per source line), and how that interacts with Task 645's line-number gutter.
- How wide blocks behave when the indent plus their width exceeds the column (shrink, scroll, or overflow), and the cost on large documents (Task 573 budgets) during streaming.

## Scope

- In: the two settings, depth calculation, indentation in all four modes, compatibility with the listed layout features.
- Out: changing heading styles or sizes, heading numbering (Task 250), content-width presets (Task 300).

## Acceptance

- [ ] With the setting on, measured left offsets of headings and section content match depth × step in WYSIWYG, IR, Split (both panes) and Preview, for a fixture with levels 1–6 and level skips.
- [ ] A section's indentation ends at the next heading of the same or a higher level.
- [ ] Changing the step size changes every depth's offset proportionally, live.
- [ ] With the setting off, layout is unchanged from today.
- [ ] Folding, hoisting, outline highlights, gutter handles, fold glyphs, change bars, wide blocks and scroll sync keep working with indentation on.
- [ ] Document text, dirty state, Undo history, caret and selection are unchanged; copy and export carry no indentation.
- [ ] Large-document scrolling and typing stay within the Task 573 budgets with indentation on.
- [ ] Focused Vitest, Chromium and real-VS-Code specs are written and run; network-free gates pass at closure.

## Tests

- Vitest: depth calculation (levels, skips, nested containers), setting validation.
- Chromium: measured offsets per mode and depth, live size change, interaction checks (folding, hoisting, outline, handles, change bars, wide blocks), copy content, large-document timing.
- Real VS Code (`test/vscode-e2e/`): settings applied live in each mode with measured offsets; document bytes, dirty state and Undo unchanged.

## Part 1 handoff (2026-10-17)

Read-only source mapping; nothing was run (no Vitest, Chromium, build or VS Code). Paths are repository-relative. Items marked "probe" are unverified until Part 2 runs the listed probe.

### Verified facts

- **Settings pattern.** Editor settings are `resource`-scoped `vmde.editor.*` entries: boolean `vmde.editor.headingColors` (`package.json:885-890`), number with a range `vmde.editor.autoWrapDelay` (`package.json:1125-1133`). The host reads them in `collectConfigOptions(uri)` (`src/platform/editor-config.ts:228-314`, `highlightHeadings` at 258) and separately for first paint (`src/app/markdown-editor-provider.ts:216` into `buildBodyAttrs`, `src/webview-host/html-builder.ts:104-111`; inline body CSS variables at `:349`). Live path: `handleConfigChanged` calls `applyBodyOptions` (`media-src/src/bridge/message-router.ts:410-421`), which writes body attributes and CSS variables only on change (`media-src/src/boot/live-config.ts:82-138`); only `INIT_ONLY_OPTIONS` re-initialise Vditor (`live-config.ts:205-220`). Every new `VmdeConfigOptions` key must also be classified in `KNOWN_NON_DIAGRAM_KEYS` (`media-src/src/diagram-kit/diagram-config-delta.test.ts:238`), and `test/backend/config-keys.test.ts` scans every `get<…>('key')` against the manifest.
- **Settings Sync.** VS Code syncs user settings itself; the extension's `setKeysForSync` list holds only `globalState` keys (`src/app/extension.ts:187`). Nothing to add.
- **Section structure (Task 258).** There is no section wrapper. A section is a run of top-level siblings: `topLevelBlocks` returns the surface children carrying `data-block` (`media-src/src/nav/section-range.ts:15-20`); a section ends at the next heading of the same or a higher level (`section-range.ts:27-42`). Folding marks blocks with attributes only (`data-vmde-foldable`, `-folded`, `-fold-hidden`; `media-src/src/nav/section-fold.ts:18-22`, `687-707`) and works in IR and WYSIWYG only (`blockModeElement` returns null in Split: `media-src/src/util/source-map.ts:339-342`). Its controller observes `childList`/`subtree` on one surface, classifies records with `classifyEditorMutations`, and runs a full pass whenever a heading changed (`section-fold.ts:542-566`, `919-984`). Headings inside lists, quotes, callouts and Details are not top-level blocks, so they start no section.
- **Source heading scan.** `sourceHeadings` (`section-range.ts:299-341`) handles fences, HTML blocks, front matter and setext headings but is module-private. The Split scroll sync has its own ATX-only scanner (`media-src/src/nav/split-scroll-sync.ts:55-80`).
- **Split source pane DOM.** One flat run of spans: each source line ends with `span[data-type="newline"]` (a `<br>` plus a hidden `\n`); an ATX heading line starts with `span.vditor-sv__marker--heading.hN[data-type="heading-marker"]` and its text spans carry class `hN` (Lute's SV `renderHeading` in `media-src/vendor/lute/lute.min.js`; Lute output recorded in `media-src/src/clipboard/clipboard-line.test.ts:320-336`). After `setValue` the whole document is one `div[data-block]`; a re-spin splits the edited region at blank lines (`source-map.ts:332-338`; Vditor `sv/process.ts:17-26`, `54-60`). Saved text is `textContent` (`media-src/src/bridge/edit-sync.ts:470-483`), and the spin reads `blockElement.textContent` (`sv/process.ts:21`).
- **Preview DOM.** `previewElement` is a `div.vditor-reset` inside `.vditor-preview` (Vditor `preview/index.ts:29-32`), replaced wholesale on each render; the render-complete hook is `__vmdePreviewRendered` (`media-src/src/editing/preview-state.ts:147-166`). Preview copy clones the selection into a temporary `.vditor-reset` appended to `.vditor-preview` and copies it with `execCommand` (`preview/index.ts:37-47`, `266-288`); the whole-preview copy buttons (`preview/index.ts:121-122`) are unreachable because `preview.actions` is empty (`media-src/src/boot/vditor-options.ts:40`). IR and WYSIWYG copy write an empty `text/html` (Vditor `ir/index.ts:92`, `wysiwyg/index.ts:222-243`).
- **Undo snapshots.** Vditor's undo stores the mode element's `innerHTML` (Vditor `undo/index.ts:239-258`) and restores it with `innerHTML` (`:150`), so block attributes enter snapshots. Fold attributes already do; attribute-only differences have no change site (`media-src/src/editing/undo-restore-caret.test.ts:176-180`).
- **Geometry consumers.** The heading fold glyph is an absolute `::after` of the heading (`media-src/src/main.css:2038-2050`, `2076-2106`); heading-level markers float inside the heading with Vditor's `margin-left: -29px` (`main.css:1753-1757`); both move with the heading box. The block handle reads the element rectangle on every positioning (`media-src/src/nav/block-handle.ts:115-140`, `557-579`). Change bars use only `offsetTop`/`offsetHeight`, are appended to the editor without `data-block` (`media-src/src/chrome/diff-markers.ts:107-140`), and are re-rendered only on `diff-info` (`message-router.ts:185`, `621-624`). Split sync uses vertical positions only (`split-scroll-sync.ts:185-200`). Large documents put `content-visibility: auto` on non-heading top-level blocks (`main.css:1278-1282`).
- **Attribute observers.** The block-handle source index ignores only `class`, `style`, the two fold-able attributes and `aria-*` (`media-src/src/nav/source-block-index.ts:110-122`); any other attribute write invalidates it and costs a full serialization on the next hover (the Task 573 regression). The block-handle unit cache drops on any attribute change (`block-handle.ts:170-180`). Table resize treats any non-`aria`, non-`style` attribute as a membership change (`media-src/src/chrome/table-resize.ts:679-687`), observes `.vditor` only (`:725-733`) and re-measures on window `resize` (`:738`).
- **Instant-paint overlay.** `#vmde-prerender … pre.vditor-reset` is emitted by the host (`html-builder.ts:156-158`), followed immediately by an inline nonce script (`html-builder.ts:175`, `351-352`).

### Decisions

1. **Settings.** `vmde.editor.sectionIndent`: boolean, default `false`, `resource`, `order` 7.5 (after `headingColors`). `vmde.editor.sectionIndentSize`: number of pixels per step, default `24`, `minimum` 4, `maximum` 64, `resource`, `order` 7.6, `markdownDescription` naming `#vmde.editor.sectionIndent#`. One shared pure resolver `resolveSectionIndentSize(value): number` beside `resolveSourceFontFamily` in `src/shared/theme-registry.ts`: a finite number within 4–64 is used as is; anything else (string, NaN, out of range) gives 24 (fallback, not clamping, per requirement 5). `VmdeConfigOptions` gains `sectionIndent?: boolean` and `sectionIndentSize?: number` (`src/shared/protocol.ts:87`); `collectConfigOptions` reads both. Neither is init-only. Body state: `data-section-indent="1|0"` and `--vmde-section-indent-step: <n>px`, written by `buildBodyAttrs`/the body style for first paint and by `applyBodyOptions` live. Settings Sync: no change.
2. **Depth rule.** A top-level heading's depth is its level − 1, and the heading line is indented with its section's content (requirement 1 example). Every other top-level block takes the depth of the nearest preceding top-level heading; anything before the first heading (intro, front matter) has depth 0. Skipped levels keep the absolute rule: `#` then `###` gives the `###` section 2 steps; a document whose top heading is `##` starts at 1 step (Owner question 1). Headings inside lists, quotes, callouts, Details and HTML blocks start no section and take their container's depth, as for folding. Lute moves `footnotes-block` and `link-ref-defs-block` to the document end in IR and WYSIWYG; they get depth 0 there, while Split's source lines keep their authored position. Depth range 0–5. Consequence used below: a heading change affects only the blocks up to the next top-level heading.
3. **Marks and CSS (display only).** One attribute, `data-vmde-indent="1"…"5"` (absent means 0), on each indented top-level block in IR, WYSIWYG and Preview, and on the Split newline span that starts an indented line. A root marker `data-vmde-indent-root` goes only on the live surfaces (`ir.element`, `wysiwyg.element`, `sv.element`, `previewElement`, and the overlay `pre`). Every rule is gated on `body[data-section-indent="1"]` and the root marker, so the Preview copy element (no root marker) carries no indentation. Blocks: `margin-inline-start: min(calc(N * var(--vmde-section-indent-step)), 40%)`. Split: `span[data-type="newline"][data-vmde-indent="N"]::after { content: ""; display: inline-block; width: min(calc(N * var(--vmde-section-indent-step)), 40%) }`, plus `data-vmde-indent-first` on the root for the first line (`> [data-block]:first-child::before`). No node is injected anywhere: Lute's IR/WYSIWYG serializers already ignore block attributes (fold precedent), Split serializes `textContent`, and pseudo-elements are never text, so `data-render` is not needed. Off: no controller, no observers, no attributes; switching off removes the attributes once so the DOM equals today's.
4. **Mechanism per mode.** New module `media-src/src/nav/section-indent.ts` (`nav` entry in `scripts/module-manifest.mjs:397-414`), wired in `media-src/src/boot/finish-init.ts` next to `section-fold` (`:381`) and started or stopped from the live config path.
   - IR and WYSIWYG: a `MutationObserver` (`childList`, `subtree`, no attributes) on each block surface. Work runs in the observer callback, before paint, so a re-spun block never shows a frame at depth 0. Full pass on `impact.full`/`modeRebuild` or mode switch; otherwise a local pass from the first affected top-level block (from `impact.blocks`, or a removed node's `nextSibling`) forward, stopping at the first top-level heading after the affected range. Writes only changed values. Records counts with `recordHelperMutationPass('section-indent', …)` (`media-src/src/util/mutation-impact.ts`).
   - Preview (Preview mode and Split's right pane): an observer on `previewElement` (`childList` only); a re-render replaces everything, so one full pass over its children (top-level `H1`–`H6`).
   - Split source pane: lines from the DOM, not a text rescan. A line is a heading line when its first element (after leading whitespace) is a `heading-marker` span; the level comes from its `hN` class; a setext title line is recognised from the `hN` class on its first text span (probe P2). Local pass: start depth from the previous `div[data-block]`'s last newline span, walk the replaced div, continue into later divs only until the next heading line. Only the first visual row of a wrapped source line is indented (Owner question 2). Task 645's line-number gutter must not use the newline span's `::after`; its row measurements are vertical and are not affected.
   - First paint: when the setting is on, `html-builder.ts` appends a few lines to the inline script after the overlay that mark the overlay `pre` and its top-level children with the same depth rule, so the overlay and the live editor match (probe P5).
5. **Wide blocks and layout.** Indentation narrows the block's box (margin inside the content column); tables, code, diagrams and images use their existing overflow and `max-width` rules inside the narrower box, so nothing overflows into the right gutter. The 40% cap keeps narrow panes usable. Full-width and narrow (800 px) layouts and future content-width presets (Task 300) indent inside the column. Fold glyphs, heading markers and block handles follow the block box; the outline and Split scroll sync are vertical. Change bars keep their x position and are re-rendered after a live toggle or size change. Hoisted sections keep their absolute depth (Owner question 3).
6. **Side effects to neutralise in Part 2.** Add `data-vmde-indent`, `data-vmde-indent-root` and `data-vmde-indent-first` to the ignore list in `source-block-index.ts:110-122`; classify them as `geometry`, not `membership`, in `table-resize.ts:679-687`. After a live enable/disable or size change, dispatch one window `resize` (table handles and list fold glyphs re-measure, `table-resize.ts:738`, `section-fold.ts` window listener) and re-render change bars from the router's `lastDiffChanges`.
7. **Large documents.** Nothing runs with the setting off. With it on: no scroll or pointer listeners; per mutation batch a local pass bounded by the affected blocks plus the blocks up to the next heading; streaming appends are local; Preview re-renders cost one pass over its top-level children. Budget, in Task 573's style (mechanism assertions in CI, measured times recorded, not hard ceilings): (a) setting off: zero `section-indent` callbacks and zero attributes; (b) typing in a paragraph of the large fixture: only local passes, no full pass, writes at most the affected blocks; (c) pointer and wheel: zero extra source-index builds (`__vmdeBlockHandleCacheMetrics.indexBuilds`, `source-block-index.ts:124-132`) and zero indent work; (d) recorded: full pass on `test/vscode-e2e/fixtures/large-observable-models-synthetic.md` at most 4 ms in IR and 8 ms in Split, local pass median at most 1 ms; above that, investigate before closing.

### Part 2 steps (RED then GREEN in each step)

- **P0 probes (Chromium, before S3 and S4; record results in this file).** P1: Split caret with the `::after` spacer at a line start (click in the indent area, Home/End, ArrowUp/Down, typing and IME at line start, selection rectangles); if it fails, use `margin-inline-start` on the line's first element instead and record why. P2: Split DOM for setext, `> ## x`, `- ## x`, `  ## x` under a list, a fenced `#`, front matter, and after a local edit. P3: computed `margin-inline-start` of every top-level block type in IR, WYSIWYG and Preview for each content theme; a non-zero value gets a `calc()` rule. P4: Preview copy `text/html` with indentation on contains no margin. P5: overlay to live swap with indentation on shows no horizontal shift (`media-src/e2e/prerender.html`).
- **S1 host settings.** Files: `package.json`, `src/shared/protocol.ts`, `src/shared/theme-registry.ts`, `src/platform/editor-config.ts`, `src/app/markdown-editor-provider.ts`, `src/webview-host/html-builder.ts` (body attribute and variable only). RED tests: `test/backend/manifest.test.ts` (types, defaults, range, scope), `test/backend/config-keys.test.ts` (scan passes), `test/backend/html-builder.test.ts` (attribute and variable for on, off, invalid size), resolver cases in the theme-registry test, `diagram-config-delta.test.ts` key list.
- **S2 depth core.** Files: `media-src/src/nav/section-indent.ts` (pure `blockDepths` and `sourceLineDepths`), `scripts/module-manifest.mjs`. RED Vitest `media-src/src/nav/section-indent.test.ts`: levels 1–6, skips, top heading `##`, before the first heading, front matter, container headings, footnotes and link-ref blocks, and local result equal to a full pass after insert, remove and level change of a heading.
- **S3 IR, WYSIWYG and Preview.** Files: `section-indent.ts` (controller), `media-src/src/boot/live-config.ts`, `media-src/src/bridge/message-router.ts`, `media-src/src/boot/finish-init.ts`, `media-src/src/main.css`, `media-src/src/nav/source-block-index.ts`, `media-src/src/chrome/table-resize.ts`, overlay script in `html-builder.ts`. RED Chromium `media-src/e2e/section-indent.spec.ts`: measured offsets per depth in IR, WYSIWYG and Preview; section end at a same or higher heading; live size change; off equals no attributes and today's offsets; fold glyph, marker and block handle positions relative to the block; folding and hoisting; change bars after toggle; wide table, code and diagram inside the column at a narrow width; copy `text/plain` and `text/html` without indentation.
- **S4 Split source pane.** Files: `section-indent.ts`, `main.css`. RED Chromium in the same spec: first-row offsets per depth, source text and caret offset unchanged while typing, Enter, paste and Undo, re-spin keeps depths with no unindented frame (sampled in `requestAnimationFrame` after input), Split scroll sync still aligns headings.
- **S5 large document.** RED Chromium on the Task 573 synthetic fixture: budget items (a)–(d).
- **S6 real VS Code.** New `test/vscode-e2e/section-indent.spec.ts` (pattern of `test/vscode-e2e/sv-source-font.spec.ts`): setting changed live through the configuration API, measured offsets in WYSIWYG, IR, Split (both panes) and Preview, size change, off restores layout; host document bytes, dirty state and Undo step count unchanged by toggling; one Ctrl+Z after typing restores the text in one step.

### Tests mapped to acceptance

- Offsets match depth × step in every mode with levels 1–6 and skips: S2 Vitest (depths), S3/S4 Chromium (geometry), S6 real VS Code.
- Indentation ends at the next same or higher heading: S2 Vitest, S3 Chromium.
- Size change proportional and live: S1 Vitest (resolver), S3 Chromium, S6 real VS Code.
- Off equals today: S1 html-builder test, S3 Chromium, S6.
- Folding, hoisting, outline highlights, handles, fold glyphs, change bars, wide blocks, scroll sync: S3/S4 Chromium.
- Text, dirty state, Undo, caret, selection, copy: S3/S4 Chromium (caret, selection, copy), S6 (bytes, dirty, Undo).
- Large-document budgets: S5.
- Gates at closure: focused Vitest, typecheck, lint of changed files, the new Chromium and real-VS-Code specs, `npm run quality`.

### Owner questions (Part 2 proceeds with the recommendation unless told otherwise)

1. **Depth when levels are skipped or the top heading is `##`.** (a) Recommended: absolute, depth = level − 1 (requirement 1's wording; a `##`-only document is one step in; adding or removing an H1 never re-indents the whole document; heading edits stay local). (b) Relative to the document's shallowest heading level (no wasted step; adding an H1 shifts every block, a full pass). (c) Nesting depth (`###` directly under `#` is one step; most compact, but a level change re-indents every later section).
2. **Wrapped rows in Split's source pane.** (a) Recommended: indent the first visual row of each source line only; wrapped rows start at the pane edge (display-only pseudo-element, no DOM change). (b) No indentation in the source pane, only in its preview (contradicts requirement 3). (c) Hanging indentation through per-line wrapper elements (needs a Vditor SV patch; high risk to caret, IME, paste and Undo; not recommended).
3. **Hoisted section.** (a) Recommended: keep absolute depths while hoisted (no extra pass; same look as unhoisted). (b) Re-base so the hoisted heading is at depth 0 (one extra pass on hoist and unhoist).

**Owner answers (2026-10-17, chat):** 1 (a) absolute depth, level − 1. 2 (b) no indentation in Split's source pane; the Split preview pane is indented. This amends requirement 3 for the source pane: the source-pane spacer, its CSS, step S4 and probe P1 are dropped, and P2 is needed only if the Split preview pane relies on it. 3 (a) keep absolute depths while hoisted.


### Residual risks

- Split caret and selection near the indent pseudo-element (probe P1).
- Undo snapshots carry indentation attributes (as fold attributes do today); an Undo restores snapshot attributes, which the observer corrects before paint. S6 checks the Undo step count.
- Themes or user CSS that set left margins on top-level blocks (probe P3); a user rule with higher specificity can override the indentation.
- `sourceHeadings` (text) and Lute (DOM) can disagree for a heading with 1–3 spaces of indentation under a list item; Part 2 uses Lute's DOM in every mode, so all modes follow Lute.

## Execution progress — 2026-10-17 (S1 host settings)

- Added `vmde.editor.sectionIndent` (boolean, default false, order 7.5) and `vmde.editor.sectionIndentSize` (number, default 24, 4–64, order 7.6) to `package.json`.
- Added `resolveSectionIndentSize` (`src/shared/theme-registry.ts`), `VmdeConfigOptions` fields, `collectConfigOptions` reads, first-paint `data-section-indent` and `--vmde-section-indent-step` (`html-builder.ts`, `markdown-editor-provider.ts`).
- Tests (RED shown failing first, then GREEN): `manifest.test.ts`, `html-builder.test.ts`, `content-theme.test.ts`, `diagram-config-delta.test.ts` key lists; `config-keys.test.ts` scan passes.
- Checks: focused Vitest 6 files / 170 tests pass; `tsc --noEmit -p ./` and `npm run typecheck` exit 0; `biome check` on changed files clean.
- Not started: S2 to S6 (depth core, IR/WYSIWYG/Preview, large document, real VS Code). Split source-pane steps are dropped per the Owner answer.

## Execution progress — 2026-10-17 (S2 depth core)

- Added `media-src/src/nav/section-indent.ts` with pure `blockDepths` (full O(n) pass) and `updateBlockDepths` (local pass from the affected range to the next top-level heading), and registered `section-indent` in the `nav` group of `scripts/module-manifest.mjs`. `sourceLineDepths` is not implemented (Split source pane is not indented, per the Owner answer).
- Input contract for the controller step: top-level headings carry `headingLevel`; headings inside list, quote, callout, Details and HTML blocks must be passed without `headingLevel`; footnote and link-reference definition blocks are passed with `tail: true`.
- Tests: `media-src/src/nav/section-indent.test.ts` (RED shown failing first, then GREEN).
- Not started: S3 to S6.
