# Task 645 — Split View source pane: font size, line numbers, background, current-line highlight and pane gap

**Status:** complete, ready to close (2026-11-01). All acceptance items are proven; see "Closure record" at the end.
**Origin:** Project Owner feature request.
**Severity:** feature (low to medium risk; settings and Split View styling; line numbers and the current line touch the source pane's layout).
**Tech stack:** extension host settings (`package.json` contributes, `src/platform/editor-config.ts`, `src/shared/protocol.ts`, `src/webview-host/html-builder.ts`), webview (`media-src/src/boot/live-config.ts`, Split View source pane `.vditor-sv`), CSS (`media-src/src/main.css`), Vitest, Chromium, real VS Code.
**Builds on:** [Task 634](634-split-view-source-monospace-font.md) (`vmde.editor.sourceFontFamily`: a source-only setting carried as a CSS variable, applied live, with a safe fallback).
**Related:** [Task 73](../parked/73-editor-line-number-gutter.md) (parked: line-number gutter for IR and WYSIWYG, with the source-line versus visual-row analysis), the upstream source-accurate line-number and gutter-drift changes listed in [Task 358](../358-upstream-resync-review.md), and [Task 649](649-section-indentation-by-heading-level.md) (section indentation also applies to the source pane).

## Problem

Split View shows the Markdown source on the left and the rendered preview on the right. Apart from its font family (Task 634), the source pane has no settings of its own:

- Its font size follows `vmde.editor.fontSize`, which also sizes the rendered document, so source and preview cannot be sized separately.
- It has no line numbers, so a line reported elsewhere (a link such as `README.md:42`, a Git change, a lint message) is hard to find.
- Its background is the same as the preview's, so the two panes are hard to tell apart.
- The line holding the caret is not highlighted.
- The space between the source pane and the preview pane is fixed.

## Requirements

Setting names (approved): `vmde.editor.sourceFontSize`, `vmde.editor.sourceLineNumbers`, `vmde.editor.sourceBackground`, `vmde.editor.sourceHighlightCurrentLine`, `vmde.editor.sourceCurrentLineBackground`, `vmde.editor.splitGap`.

1. **Source font size.** A new setting sets the source pane's font size independently of `vmde.editor.fontSize`. By default the source pane keeps today's size. Line height and the caret follow the new size.
2. **Line numbers.** A new setting shows line numbers in a gutter at the left of the source pane, off by default. Each number belongs to one source line and is shown on its first visual row. When a long line wraps, each further row shows a continuation mark with a sub-number counted from 1, in a smaller, dimmer style than the line numbers:

   ```text
    42 │ first row of line 42
   ↳ 1 │ first wrapped row of line 42
   ↳ 2 │ second wrapped row of line 42
    43 │ line 43
   ```

   Gutter alignment: line numbers and sub-numbers are right-aligned at the gutter's right edge; the `↳` mark is left-aligned at the gutter's left edge, on the same row as its sub-number. The gutter is as narrow as its content allows, counted in digit widths of the gutter font:

   - The widest sub-number keeps one space between it and `↳`, so the sub-number column needs `2 + digits(widest sub-number)` widths.
   - The gutter width is the larger of that and `digits(highest line number)`.

   Examples with line numbers below 100:

   - Widest sub-number below 10:

     ```text
      42 │ first row of line 42
     ↳ 1 │ first wrapped row of line 42
     ↳ 2 │ second wrapped row of line 42
      43 │ line 43
     ```

   - Widest sub-number from 10 to 99:

     ```text
       42 │ first row of line 42
     ↳  1 │ first wrapped row of line 42
     ↳ 10 │ tenth wrapped row of line 42
       43 │ line 43
     ```

   - Widest sub-number from 100 to 999:

     ```text
        42 │ first row of line 42
     ↳   1 │ first wrapped row of line 42
     ↳  99 │ ninety-ninth wrapped row of line 42
     ↳ 100 │ hundredth wrapped row of line 42
        43 │ line 43
     ```

   The gutter widens or narrows only when one of those digit counts changes.

   Sub-numbers update when the pane is resized or edits change how a line wraps. Numbers update as lines are added or removed, are not part of the document text (copy, Find, save and Undo never see them), and use a muted theme color.
3. **Source background color.** A new setting sets the source pane's background color. Empty means today's background.
4. **Current-line highlight.** A new setting highlights the source line that holds the caret, off by default, and a second setting sets its background color (empty means a theme color, as for the Find match colors). The highlight covers only the visual row that holds the caret: when a long source line wraps, each wrapped row counts as its own line for the highlight. It follows the caret as it moves, including between wrapped rows of the same source line. It is hidden while a selection is not collapsed, and when the source pane does not have focus.
5. **Pane gap.** A new setting sets the width of the space between the source pane and the preview pane, in pixels. By default the gap keeps today's width.
6. **Live and scoped.** Every setting applies live, without reopening the editor, and has `resource` scope like the other `vmde.editor.*` settings. Invalid values fall back to the default without breaking the layout.
7. **Split View only.** The settings change only Split View's source pane and the gap. IR, WYSIWYG, Preview and the rendered pane are unchanged.
8. **No effect on the document.** None of these settings change the document text, dirty state, Undo history, caret or selection.

## Open design points (settled in Part 1; see "Part 1 handoff" below)

- Value formats and validation for the approved setting names: `vmde.editor.sourceFontSize` (same format as `vmde.editor.fontSize`: `"editor"` to follow it, or a pixel value), `vmde.editor.sourceLineNumbers` (boolean), `vmde.editor.sourceBackground` (color string, empty for theme), `vmde.editor.sourceHighlightCurrentLine` (boolean), `vmde.editor.sourceCurrentLineBackground` (color string, empty for theme), `vmde.editor.splitGap` (number of pixels).
- Color validation: which CSS color forms are accepted, and how the values are sanitized before they reach CSS (follow the Find match color settings).
- How to number lines and draw the current line in the source pane, which is one editable block of Lute spans rather than one element per line: a gutter beside the editable block measured from the rendered rows, or line elements inside it. The approach must keep the source pane's caret, IME, paste, Undo and the source-to-preview scroll sync working, and must stay fast on large documents (Task 573 gate) and during streaming.
- Where today's gap between the panes comes from (padding, margin or border), its current measured width, and the allowed range for the new setting.
- Whether line numbers and the current line should also apply to Source mode as reached from the status bar (if it shares the Split source pane).

## Scope

- In: the six settings above, their live application, the source pane gutter and current-line highlight, the pane gap.
- Out: changing the rendered pane, IR or WYSIWYG styling, resizing the panes by dragging, code-block line numbers (`vmde.editor.codeLineNumbers`).

## Acceptance

- [x] The source font size setting changes only the source pane's measured font size; `vmde.editor.fontSize` still sizes the rendered pane.
- [x] With line numbers on, each source line shows its number on its first row and each wrapped row shows `↳` at the gutter's left edge and its sub-number `1`, `2`, … right-aligned with the line numbers; the gutter width is the larger of the highest line number's digits and two plus the widest sub-number's digits, leaving one space between `↳` and the widest sub-number; marks update after a pane resize; numbers update after typing Enter, deleting lines, paste and Undo; copy, Find, save and Undo never include them.
- [x] The source background setting changes the source pane's measured background color; empty restores today's color.
- [x] With the current-line highlight on, only the visual row holding the caret has the configured background (on a wrapped line, one wrapped row, not the others); it follows arrow keys and clicks, and is hidden with a non-collapsed selection or without focus.
- [x] The gap setting changes the measured distance between the source and preview panes.
- [x] Changing any setting applies live; invalid values fall back to the default.
- [x] No setting changes document text, dirty state, Undo history, caret or selection.
- [x] Large-document typing and scrolling stay within the Task 573 budgets with line numbers and the current-line highlight on.
- [x] Focused Vitest, Chromium and real-VS-Code specs are written and run; network-free gates pass at closure.

## Tests

- Vitest: setting validation and defaults (font size, colors, gap), host-to-webview config shape, line-number planning from rendered rows if a pure planner exists.
- Chromium: measured font size, background colors, gap width; line numbers and `↳` wrapped-row marks (mark left-aligned, sub-number right-aligned) with wrapping and resize, Enter, delete, paste and Undo; current-line highlight on one visual row, moving between wrapped rows of one source line, and hiding with a selection; copy and Find exclude numbers; large-document timing.
- Real VS Code (`test/vscode-e2e/`): settings applied live in Split View, line numbers and current line with OS-level keys, document bytes, dirty state and Undo unchanged.

## Part 1 handoff (2026-11-01)

Design only; no product code changed in Part 1. Measurements come from a read-only Chromium probe on the `split-scroll` harness (viewport 1300×700, default light state, `node build.mjs` first) and from source reading. Values marked "inference" are not yet measured.

### Problem and cause

- Font size: the source pane `.vditor-sv` is a `pre.vditor-reset`, so it takes `font-size: var(--me-font-size) !important` from the patched Vditor `.vditor-reset` rule (`build.mjs`), the same variable that sizes the rendered pane. Measured 14px source and 14px preview. Its line height is Vditor's fixed `22px` (`_sv.less`); heading spans `.vditor-sv .h1`–`.h4` use fixed 44/38/27/25px line heights.
- Gap: the pane boundary comes from Vditor's `.vditor-sv { margin: 0 1px 0 0 }` and `.vditor-preview { margin-left: -1px; border-left: 1px solid var(--border-color) }` (`_content.less`). Measured: source border-box right edge 680px, preview border-box left edge 680px, so today's distance between the two panes is **0px**, with a 1px divider drawn as the preview's left border.
- Background: `.vditor-sv` takes the panel background, `--vscode-editor-background !important` in the `auto` state (`main.css`, `data-use-vscode-theme-color`), `transparent !important` under a named content theme (`body.markdown-body … .vditor-sv`, also `:focus`), and Vditor's `--textarea-background-color` on focus.
- Left room: `.vditor-sv` already has a 52px left padding from the generic `.vditor-reset { padding-left: var(--vmde-gutter, 52px) }` fallback (measured `padding: 10px 9px 10px 52px`). The gutter fits inside that padding for up to about four digit columns at 14px.
- Source DOM: the pane is one contenteditable that is also its own scroll container (`overflow: auto`). Lines end with `span[data-type="newline"]` (a `<br>` plus a hidden `\n`). On the 174,527-character synthetic fixture (`test/vscode-e2e/fixtures/large-observable-models-synthetic.md`, 2,334 lines) the pane held one `data-block` with 2,209 newline spans. The host text is the pane's `textContent` without Vditor's trailing editable newline span.
- Geometry: text client rects are glyph boxes (16px high) inside 22px line boxes. A collapsed caret on an empty line returns no client rects (the line's `<br>` returns a 16px rect).
- Costs on the large fixture (Chromium): listing all newline spans 0.6 ms; reading every newline `<br>` rect 4 ms warm (133 ms only on the first forced layout after `setValue`); exact per-line Range rects for every line 121 ms; visible-window measurement (binary search plus 27 lines) 1.2 ms; layout after a one-character text change 19.6 ms (paid anyway at the next paint). The longest line wrapped to 42 rows.
- Observers that constrain the design: `chrome/table-resize.ts` observes all attribute, child and text mutations in the `.vditor` subtree; `nav/source-block-index.ts` observes attributes in the editor root and advances its revision on each one; `chrome/responsive-tables.ts` observes `style` attributes. Vditor Undo snapshots the mode element's `innerHTML`; Find (`editing/find-map.ts`, `find-source.ts`) walks text nodes of the editor root. So any node or attribute written inside `.vditor` on each caret move or scroll frame would cost work in those observers, and any node inside the pane would reach Undo, Find, copy and save.

### Scope

In: the six approved settings, their shared resolvers, host config and initial HTML, live application, the source gutter and current-row highlight, the gap, docs (README, CHANGELOG). Out: everything listed under Scope above; no change to Vditor source patches, `bridge/message-router.ts` (the existing `applyBodyOptions` call already carries new options), the SV scroll container, or `nav/split-scroll-sync.ts`.

### Settled decisions

Every decision below is a provisional decision (2026-11-01), reversible.

**D1 — gutter and current-row approach.** Selected by a recorded decision check (probability 0.96; alternatives: nodes inside the pane 0.00, a `::before` string 0.01, a new scroll wrapper 0.00).
- Gutter: one `div.vmde-sv-gutter` (`aria-hidden="true"`, `pointer-events: none`, `user-select: none`, `contain: strict`, `position: fixed`) appended to `document.body`, **outside `.vditor`**, clipped to the pane's rectangle and covering the pane's left padding. An inner layer is translated by `-scrollTop` in a passive `scroll` listener on the pane. It renders labels only for the rendered window (viewport plus one viewport height above and below); scrolling inside that window costs only the translate.
- Geometry per update: (a) a global pass reads every newline `<br>` rect to get the line count and an estimated row count per line (`round(Δbottom / row pitch)`), then measures exactly (Range rects grouped by top, 1px tolerance) only the lines whose estimate reaches 10 or more rows, to find the widest sub-number; (b) a window pass measures the visible lines exactly and places labels at the row glyph boxes (label box top and height equal to the row's glyph rect; label vertically centred). Reads happen before writes; writes touch only the overlay and one state rule (below).
- Triggers: a `MutationObserver` on the pane (`childList`, `characterData`, `subtree`; no attributes) and a `ResizeObserver` on the pane schedule one coalesced `requestAnimationFrame` update (global plus window pass). Typing, Enter, delete, paste, Undo, Redo, `setValue` and host updates all arrive as mutations. Scroll schedules only a window pass when the rendered window no longer covers the viewport. A settings change and `document.fonts` `loadingdone` call a refresh. While the pane has class `vmde-streaming`, updates are skipped and one update runs when the class is removed.
- Current row: a `linear-gradient` `background-image` on `.vditor-sv` with `background-attachment: local` (scrolls natively with the text, paints behind it, adds no node). Its top and height come from two registered custom properties `--vmde-sv-row-top` and `--vmde-sv-row-height` (`@property`, `syntax: '<length>'`, `inherits: false`, initial `0px`).
- No attribute or node is written inside `.vditor` by the controller. The two row properties and `--vmde-sv-gutter-ch` are set through one CSSOM rule `.vditor-sv { … }` in a dedicated `<style id="vmde-sv-pane-state">` in `<head>` (`sheet.cssRules[0].style.setProperty`), so no observer listed above fires on caret moves or scroll.
- Caret row: on `selectionchange`, `focus`, `blur`, input updates and resize, if the selection is collapsed, inside the pane and the pane is `document.activeElement`: take the collapsed range's first client rect; if none, the rect of the `<br>` of the newline span at or after the caret; then band centre = rect centre, band height = computed `line-height` (px) of the caret's containing element, band top = centre − height/2 − (pane top + border-top) + `scrollTop`. Otherwise set height `0px`. CSS also gates the gradient on `.vditor-sv:focus` and on the setting attribute, so blur hides it without JavaScript.
- Off: the controller removes the overlay, the state rule values and all listeners and observers; zero cost when both settings are off.

**D2 — `vmde.editor.splitGap`.** Selected by a recorded decision check (probability 0.99). The gap is the measured distance from the source pane's border-box right edge to the preview pane's border-box left edge. Default `0` (today). `type: number`, `minimum: 0`, `maximum: 100`; any finite number in 0–100 is used as is, anything else gives 0 (fallback, not clamp). The 1px divider stays at the preview's left edge. CSS: `.vditor-preview { margin-left: calc(var(--vmde-split-gap, 0px) - 1px) }` only when it follows a visible `.vditor-sv` (`.vditor-content > .vditor-sv:not([style*="display: none"]):not([style*="display:none"]) ~ .vditor-preview`).

**D3 — `vmde.editor.sourceFontSize`.** Selected by a recorded decision check (probability 0.94). `type: string`, default `"editor"`. `"editor"` and `""` follow `vmde.editor.fontSize` exactly as today (no size or line-height override). A finite number, a numeric string, or a numeric string with a `px` suffix within 6–100 sets the size; anything else follows (fallback, not clamp). With a size set: line height `round(size × 22 / 14)` px and the heading-span line heights `calc(<Vditor px> × var(--me-source-line-scale))` with scale = line height / 22. Variables on `<body>`: `--me-source-font-size`, `--me-source-line-height`, `--me-source-line-scale`, all removed when following. The override uses the same selector strength as the Task 634 font-family rule (`body .vditor .vditor-content > .vditor-sv.vditor-reset`, `!important`) so it wins in the plain, `auto` and named-theme states.

**D4 — colour settings.** Selected by a recorded decision check (probability 0.81; webview-only probe 0.05). Shared `resolveCssColor(value)` in `src/shared/theme-registry.ts`: trim; at most 64 characters; the whole value must be a hex colour (`#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`), a bare keyword of letters (named colours, `transparent`, `currentcolor`), or one of `rgb`, `rgba`, `hsl`, `hsla`, `hwb`, `lab`, `lch`, `oklab`, `oklch`, `color` followed by `(`…`)` whose argument contains only letters, digits, spaces and `.,%/+-`; otherwise `undefined` (empty or invalid means the theme default). The host emits `--vmde-source-background` into the initial `<body style>` only for a passing value. The webview additionally requires the browser to parse it (the existing `configuredColor` probe in `boot/live-config.ts`) before setting `--vmde-source-background` or `--vmde-source-current-line-background`, and removes the variable otherwise. Defaults: source background = today's cascade (no override); current-line colour = `var(--vscode-editor-lineHighlightBackground, var(--vscode-editor-lineHighlightBorder, rgba(128, 128, 128, 0.15)))`. The background override rule uses `!important` at a strength that beats the `auto`, named-theme and `:focus` rules.

**D5 — source-only state.** Selected by a recorded decision check (probability 1.00). The source settings apply whenever `.vditor-sv` is visible, including the state where the toolbar's Split button hides the preview; the gap applies only while both panes are visible. IR, WYSIWYG and Preview never show the gutter, the highlight or the source size and background.

**D6 — gutter content rules** (from the requirement text; no open choice):
- One number per source line. Lines are delimited by `span[data-type="newline"]`; the gutter line count equals the host line count (`\n` count of the host text + 1), so it matches VS Code's line numbers for the text the pane holds. The last line after a final `\n` is numbered and anchored at Vditor's trailing editable newline `<br>`. Invariant check in tests: newline spans = host `\n` count + 1 trailing span.
- Columns: `subColumns = maxSub > 0 ? 2 + digits(maxSub) : 0`; `columns = max(digits(maxLine), subColumns)`; the gutter is `columns` × `1ch` of the gutter font (source font family and size). The three task examples give 3, 4 and 5 columns for lines below 100.
- Line numbers and sub-numbers right-aligned at the gutter's right edge; `↳` left-aligned at the gutter's left edge on its row; sub-numbers at `0.85em` and reduced opacity; colour `var(--vscode-editorLineNumber-foreground, …)`.
- Placement: the gutter's right edge sits 8px left of the pane's content edge. With line numbers on, the pane's left padding becomes `max(var(--vmde-gutter, 52px), calc(var(--vmde-sv-gutter-ch) * 1ch + 16px))`, so the text column moves (and rewraps) only when the column count changes and needs more than today's 52px.
- Numbers are not document text: the overlay is outside the pane, so copy, Find, save, Undo, host text and Lute never see it.

**D7 — names and storage.**
- Settings (approved names; `scope: resource`; "Editor" section after `vmde.editor.sourceFontFamily`, orders 4.51–4.56): `sourceFontSize` (string, `"editor"`), `sourceLineNumbers` (boolean, `false`), `sourceHighlightCurrentLine` (boolean, `false`), `sourceCurrentLineBackground` (string, `""`), `sourceBackground` (string, `""`), `splitGap` (number, `0`, 0–100). A non-boolean value of either boolean setting means off.
- `VmdeConfigOptions` (`src/shared/protocol.ts`): `sourceFontSize?: string`, `sourceLineNumbers?: boolean`, `sourceBackground?: string`, `sourceHighlightCurrentLine?: boolean`, `sourceCurrentLineBackground?: string`, `splitGap?: number`. Host fills them through the shared resolvers in both `src/platform/editor-config.ts` and `src/app/markdown-editor-provider.ts`; the webview resolves again (idempotent).
- Shared resolvers (`src/shared/theme-registry.ts`): `resolveSourceFontSize(value): { fontSize: string; lineHeight: string; lineScale: number } | undefined`, `resolveSplitGap(value): number`, `resolveCssColor(value): string | undefined`.
- `<body>` attributes `data-source-line-numbers="1|0"` and `data-source-current-line="1|0"`; `<body>` variables `--me-source-font-size`, `--me-source-line-height`, `--me-source-line-scale`, `--vmde-source-background`, `--vmde-source-current-line-background`, `--vmde-split-gap`; state rule properties `--vmde-sv-row-top`, `--vmde-sv-row-height`, `--vmde-sv-gutter-ch`. The host emits the same attributes and variables in the initial HTML (instant paint).
- New webview modules in the `chrome` module (add both ids to `scripts/module-manifest.mjs`): `media-src/src/chrome/sv-gutter-plan.ts` (pure: digit and column rule, rect grouping into rows, row estimate, label plan, band maths) and `media-src/src/chrome/sv-gutter.ts` (controller; export `setSourcePaneOptions({ lineNumbers, currentLine })`, called from `applyBodyOptions`; test hook `window.__vmdeSvGutterStats = { globalPasses, windowPasses, labelWrites }`).
- CSS: one contiguous Task 645 block appended at the end of `media-src/src/main.css` (shared with a parallel task; no edits elsewhere in the file).

### Invariants

1. No setting changes document text, dirty state, Undo history, caret or selection; the controller never writes nodes or attributes inside `.vditor`.
2. Default values give today's measured layout: source font 14px/22px in the probe state, gap 0px, same background, no gutter, no highlight.
3. Invalid values fall back to the default (never clamp, never an invalid CSS value that turns a background transparent).
4. Pure scrolling performs no global pass; zero overlay or observer cost with both features off.
5. IR, WYSIWYG, Preview and the rendered pane are unchanged.

### Edge cases

Empty document (one line, number 1); a file ending with or without `\n`; wrapped heading lines (taller rows); lines wrapping to 10 or more rows (column change); pane resize, outline open or resize, Split-button source-only state; mode switch away and back (the pane is `display: none`; the resize observer sees zero size and the overlay hides); streaming (skip until done); IME composition (no writes in the pane; updates are read-only); front matter lines (numbered like any line); Lute normalisation of the pane text versus disk bytes (Task 188: numbers follow the pane text; recorded risk); caret at a soft-wrap boundary (affinity not readable; the band uses the collapsed range rect; recorded risk); selection or blur (band hidden); toolbar menus and popovers over the gutter (overlay `z-index: 1`, must stay below them); theme switch and dark mode; font load after open.

### Risks

- R1 (inference): the gutter translate runs on the scroll event, so fast compositor scrolling may show a one-frame lag. Mitigation if measured visibly: drive the translate with a CSS scroll-driven animation; out of scope unless P2-6 shows it.
- R2 (inference): `background-attachment: local` may move the pane's scrolling to the main thread. P2-6 measures scroll frames with the highlight on and off.
- R3: soft-wrap caret affinity (see edge cases).
- R4: Lute normalisation can make the pane text differ from disk bytes in rare inputs; numbering follows the pane text.

### Part 2 step plan

Common to every step: owned files only; Chromium commands from the repository root as `xvfb-run -a npm --prefix media-src run test:e2e -- <spec>`; Vitest as `npx vitest run --config test/vitest.config.mts <files>`; `npm run typecheck` and Biome on changed files (`npx biome check <files>`) in every GREEN step; a RED step ends with the new tests failing for the stated reason and nothing else changed.

1. **P2-1 RED — settings contract.** Result: failing tests for the manifest entries, resolvers, host config, initial HTML and live variables. Files: `test/backend/manifest.test.ts`, `test/backend/content-theme.test.ts` (resolver cases: D2, D3, D4 incl. hostile strings such as `red;}`, `url(x)`, `</style>`), `test/backend/resource-scoped-config.test.ts`, `test/backend/html-builder.test.ts`, `media-src/src/boot/live-config.test.ts` (variables and attributes set, invalid removes, defaults unchanged), `media-src/src/diagram-kit/diagram-config-delta.test.ts` (classify the six keys as non-diagram). Proves acceptance 6 (validation and config shape). Check: the Vitest files above fail only on the missing settings and resolvers.
2. **P2-2 GREEN — settings contract.** Files: `package.json`, `src/shared/protocol.ts`, `src/shared/theme-registry.ts`, `src/platform/editor-config.ts`, `src/app/markdown-editor-provider.ts`, `src/webview-host/html-builder.ts`, `media-src/src/boot/live-config.ts` (variables and attributes only). Check: P2-1 files pass; `npm run typecheck`; `node build.mjs` exit 0. Proves acceptance 6 (unit level).
3. **P2-3 RED — pane CSS (font size, line height, background, gap).** Files: new harness `media-src/e2e/sv-pane-harness.ts` and `media-src/e2e/sv-pane.html` (Vditor in SV with preview both; settings applied through the real `applyBodyOptions`; query `?doc=large` loads the synthetic fixture), registry entry in `media-src/e2e/harness-entries.mjs`, new spec `media-src/e2e/sv-pane-settings.spec.ts`: measured source font size and line height change while the preview size stays; heading row height scales; background colour in plain, `auto`, named and focused states, empty restores today's value; gap distance 0 by default and 24 when set; invalid values keep defaults; IR and Preview unchanged. Proves acceptance 1, 3, 5 and 6 (Chromium). Check: spec fails on the missing CSS.
4. **P2-4 GREEN — pane CSS.** Files: `media-src/src/main.css` (Task 645 block: `@property` registrations, size, line height, heading scale, background, gap). Check: `sv-pane-settings.spec.ts` passes; `sv-source-font.spec.ts` and `split-scroll.spec.ts` still pass.
5. **P2-5 RED — gutter.** Files: new `media-src/src/chrome/sv-gutter-plan.test.ts` (digits, the three column examples and the no-wrap case, rect grouping, estimate, label plan), new `media-src/src/chrome/sv-gutter.test.ts` (lifecycle: overlay under `<body>`, nothing written inside `.vditor` as seen by a test `MutationObserver`, off removes overlay and listeners), new `media-src/e2e/sv-gutter.spec.ts` (number on each line's first row; `↳` at the left edge and sub-numbers right-aligned on wrapped rows; column count in `ch` follows D6; label centres within 2px of row centres; updates after resize, Enter, line delete, paste and Undo; gutter count equals host lines; copy and Find never include numbers; host text, Undo stack and caret unchanged by toggling). Proves acceptance 2 and 7 (Chromium, Vitest). Check: the three files fail on the missing modules.
6. **P2-6 GREEN — gutter.** Files: new `media-src/src/chrome/sv-gutter-plan.ts`, new `media-src/src/chrome/sv-gutter.ts`, `media-src/src/boot/live-config.ts` (call `setSourcePaneOptions`), `media-src/src/main.css` (Task 645 block: gutter styles, padding rule), `scripts/module-manifest.mjs` (two ids). Check: P2-5 files pass; `npx vitest run --config test/vitest.config.mts test/backend/module-boundaries.test.ts` passes; `node scripts/module-manifest.mjs` exit 0.
7. **P2-7 RED — current-row highlight.** Files: `media-src/src/chrome/sv-gutter-plan.test.ts` (band maths), `media-src/src/chrome/sv-gutter.test.ts` (state rule written, no attribute writes), new `media-src/e2e/sv-current-line.spec.ts` (only the caret's visual row has the configured background on a wrapped line; ArrowDown and ArrowUp move between wrapped rows of one line; ArrowRight across a line end and a click move it; empty line; hidden with a non-collapsed selection and after blur; default theme colour when empty; invalid colour keeps the theme colour). Proves acceptance 4. Check: fails on the missing highlight.
8. **P2-8 GREEN — current-row highlight.** Files: `media-src/src/chrome/sv-gutter.ts`, `media-src/src/chrome/sv-gutter-plan.ts`, `media-src/src/main.css` (Task 645 block: gradient rule). Check: P2-7 files pass; P2-5 files still pass.
9. **P2-9 Light (merged test and any fix) — large document.** Files: new `media-src/e2e/sv-pane-large.spec.ts` on `sv-pane.html?doc=large`; fixes only in `sv-gutter.ts` if needed. Measure with features off and on: 20 typed characters (input to next frame, p95 and max), 100 programmatic scroll frames (rAF gap p95 and max), long tasks. Assert mechanism: zero global passes during pure scroll; one coalesced global pass per typing frame at most; window-pass label writes bounded by the rendered window. Timing budget (Task 573 uses mechanism assertions plus recorded timings): typing p95 with features on at most off + 8 ms; scroll p95 at most off + 4 ms and max below 50 ms. Record all numbers in this task file. Proves acceptance 8.
10. **P2-10 real VS Code.** Files: new `test/vscode-e2e/sv-pane-settings.spec.ts` (pattern of `sv-source-font.spec.ts`; OS keys through `test/vscode-e2e/helpers/xtest-input.ts`): each setting changed live through the configuration API in an open Split editor with measured effect; invalid values fall back; source font size changes only the source pane; line numbers with `↳` on a wrapped line, gutter count equals `document.lineCount`, updates after XTEST Enter and Backspace; current row follows XTEST arrows and hides after Shift+Arrow; document text, `isDirty` and Undo unchanged by every toggle, and one Ctrl+Z after a typed character restores the text in one step. Check: `node build.mjs`, then under the real-VS-Code token `env -u ELECTRON_RUN_AS_NODE xvfb-run -a npm --prefix test/vscode-e2e test -- sv-pane-settings.spec.ts --workers=1 --retries=0` passes; also rerun `sv-source-font.spec.ts` and `sv-split.spec.ts`. Proves acceptance 1–7 in real VS Code.
11. **P2-11 closure.** Files: `README.md` (Split paragraph names the new settings), `CHANGELOG.md`, this task file. Gates: `node build.mjs`, `npm run typecheck`, `npm run lint`, focused Vitest files, focused Chromium specs (`sv-pane-settings`, `sv-gutter`, `sv-current-line`, `sv-pane-large`, `sv-source-font`, `split-scroll`), the focused real-VS-Code specs, `npm run quality` (record each stage). Proves acceptance 9.

### Progress checkpoint (2026-11-01)

- Part 1 complete: decisions D1–D7 recorded above; no product files changed.
- Next action: the orchestrator closes the task (move to done, update the index).

### Part 2 progress

Checklists (tick only what is proven; none of the acceptance items above is proven yet):

- [x] P2-1 RED, settings contract: failing tests written for the manifest entries, the three shared resolvers, host config per document, initial HTML, live variables and attributes, and the non-diagram classification of the six keys. 18 Vitest cases fail only because the settings, resolvers, host fields, HTML output and live variables do not exist; `npm run typecheck` fails only on the six unknown option keys in two test files.
- [x] P2-2 GREEN, settings contract: the six settings are declared; `resolveSourceFontSize`, `resolveSplitGap` and `resolveCssColor` are shared; host config, initial HTML and live variables and attributes are in place. The six P2-1 test files pass (219/219), `test/backend` passes (112 files, 2,899 passed, 1 expected fail), `npm run typecheck` and `node build.mjs` exit 0. The CSS that consumes the variables is P2-4.
- [x] P2-3 RED, pane CSS: new harness `sv-pane` (`media-src/e2e/sv-pane.html`, `sv-pane-harness.ts`, registry entry) and `media-src/e2e/sv-pane-settings.spec.ts`. 10 cases fail only because no CSS consumes the variables (size and line height stay 17px/22px, heading rows stay 44px, background stays default in the plain, auto, named and focused states, gap stays 0); 3 guard cases pass (divider kept, invalid values keep defaults, Instant Rendering unchanged).
- [x] P2-4 GREEN, pane CSS: one appended Task 645 block in `media-src/src/main.css` (source size and line height, heading row scale, background, gap). `sv-pane-settings.spec.ts` passes 13/13; `sv-source-font.spec.ts` and `split-scroll.spec.ts` still pass (18/18 together). Acceptance 1, 3, 5 and 6 are proven at the Chromium level only; the real-VS-Code proof is P2-10.
  - Contract detail: the size, line-height and background rules are gated on the variable being present in the body's inline style (`body[style*="--me-source-font-size"]`, `body[style*="--vmde-source-background"]`), because a declaration whose variable is unset would drop to `unset` and discard today's look. Heading line heights use a `calc(<px> * var(--me-source-line-scale, 1))` fallback instead.
- [x] P2-5 RED, gutter: `media-src/src/chrome/sv-gutter-plan.test.ts`, `media-src/src/chrome/sv-gutter.test.ts` and `media-src/e2e/sv-gutter.spec.ts` written. Vitest fails only on the missing modules (no tests run); 10 of 11 Chromium cases fail because no overlay exists (1 guard case passes: Instant Rendering shows no gutter).
  - Module contracts fixed by these tests (P2-6 implements them). `sv-gutter-plan.ts` exports `digitCount(n)`, `gutterColumns(maxLine, maxSub)`, `groupRows(rects, tolerance = 1)` (rects `{ top, bottom }` merged by top, sorted, zero-height ignored), `estimateRowCount(height, pitch)` (at least 1, 1 for an unusable input), `maxSubNumber(rowCounts)` and `planLabels(lines: { line, rows }[])` returning `{ kind: 'line' | 'sub', text, top, height }[]`. `sv-gutter.ts` exports `setSourcePaneOptions({ lineNumbers, currentLine })` and `flushSourceGutter()` (synchronous update for tests) and sets `window.__vmdeSvGutterStats = { globalPasses, windowPasses, labelWrites }`.
  - Overlay DOM contract: `body > .vmde-sv-gutter[aria-hidden="true"] > .vmde-sv-gutter__layer`, with one `.vmde-sv-gutter__num` per source line and one `.vmde-sv-gutter__sub` (containing `.vmde-sv-gutter__mark` with `↳` and `.vmde-sv-gutter__subnum`) per wrapped row. The layer's width is `columns` times one digit width of the gutter font.
- [x] P2-6 GREEN, gutter: new `media-src/src/chrome/sv-gutter-plan.ts` (pure planner) and `media-src/src/chrome/sv-gutter.ts` (overlay controller: global pass, window pass, coalesced `requestAnimationFrame`, scroll translate, mutation and resize observers, mode-switch watcher on the pane's `style`/`class`), `applyBodyOptions` calls `setSourcePaneOptions`, CSS appended to the Task 645 block in `main.css`, both ids in `scripts/module-manifest.mjs`. Unit: the P2-5 files and `module-boundaries` pass (53/53 with live-config); `node scripts/module-manifest.mjs` reports total and disjoint. Chromium: `sv-gutter.spec.ts` 11/11, with `sv-pane-settings`, `sv-source-font` and `split-scroll` 42/42 together, `config-apply` 6/6. `npm run typecheck`, `node build.mjs` and Biome pass. Acceptance 2 (Chromium, Vitest) and the gutter part of 7 are proven; real-VS-Code OS keys are P2-10.
  - Detail fixed in P2-6: the gutter mounts only while line numbers are on and the pane is shown, so Instant Rendering has no overlay; the pane's left padding grows to `max(gutter, columns * 1ch + 16px)` through `body[data-source-line-numbers="1"]`; a line is measured exactly in the global pass only when its estimated height is more than one row.
  - Spec timing fix: the Enter/delete/paste/Undo case waits 900 ms after the document is set, so the opening Undo snapshot settles first (same wait as the other Split View editing specs); without it the Undo step had nothing to undo.
- [x] P2-7 RED, current-row highlight: tests added to `media-src/src/chrome/sv-gutter-plan.test.ts` (band maths), `media-src/src/chrome/sv-gutter.test.ts` (state rule written, hidden for a selection and without focus, nothing written inside `.vditor`, no overlay for the highlight alone) and new `media-src/e2e/sv-current-line.spec.ts`. Vitest: 5 failed (`currentRowBand is not a function`; `expected undefined to be '47px'`), 18 passed; Chromium: 7 failed (the band never appears), 1 passed (Instant Rendering shows no band).
  - Contracts fixed by these tests (P2-8 implements them). `sv-gutter-plan.ts` exports `currentRowBand(caretRect: { top, bottom }, lineHeight, paneTop, scrollTop): { top, height } | null` (band centred on the rect, `height` = the line height, `top` in content coordinates = centre - height / 2 - paneTop + scrollTop; `null` for a non-finite input or a line height of 0 or less). The controller writes `--vmde-sv-row-top` and `--vmde-sv-row-height` (`0px` when hidden) on the `.vditor-sv` rule of `<style id="vmde-sv-pane-state">`, mounts the state rule for the highlight alone (no overlay), listens to `selectionchange`, `focus` and `blur`, and removes the style element when both options are off.
  - Caret rect fallbacks the controller must use (measured on the harness): a collapsed range at an element boundary has no client rect. Use, in order, the range's first client rect; for a range inside `span[data-type="newline"]` the `<br>` rect of that span (an empty line); otherwise the last client rect of the contents of the containing element (caret after the last character of a text span).
  - The highlight is painted by the pane's own background (`backgroundImage` is `none` without focus, with the setting off, and in Instant Rendering); the spec measures the band from the registered variables in the pane's computed style.
- [x] P2-8 GREEN, current-row highlight: `sv-gutter-plan.ts` gains `currentRowBand`; `sv-gutter.ts` now mounts for either option (the overlay and its scroll listener only for line numbers; selection, focus and blur listeners only for the highlight), writes the band variables on the state rule, and uses the caret-rect fallback chain from P2-7; `main.css` gains the `@property` registrations and the focused-pane gradient. Vitest: sv-gutter files 23/23; with `media-src/src/chrome`, `media-src/src/boot` and `module-boundaries` 32 files, 418/418. Chromium: `sv-current-line.spec.ts` 8/8, and 101/101 together with `sv-gutter`, `sv-pane-settings`, `sv-source-font`, `split-scroll`, `sv-line-start-edit`, `sv-selection-enter-backspace` and `config-apply`. `npm run typecheck`, `node build.mjs` and Biome pass. Acceptance 4 is proven in Chromium; the real-VS-Code OS-key proof is P2-10.
  - Test helper fix in the P2-7 unit test: `placeCaret` now focuses the pane before it sets the selection, because jsdom collapses the selection when an editable element takes focus; no assertion changed.
- [x] P2-9 Light, large document: new `media-src/e2e/sv-pane-large.spec.ts` (the 174 KB synthetic fixture, 2,209 lines, 900 x 700 viewport; features off, then line numbers and current-row highlight on; 3 warm-up characters, 20 timed characters 80 ms apart, 100 scroll frames of 300 px). Mechanism assertions: zero global passes during pure scrolling, at most one per typed character, at most 400 labels written per window pass; relative budgets: typing p95 at most the off run plus 8 ms, scroll p95 at most plus 4 ms, scroll max below 50 ms.
  - Fix found by the measurement and made in `sv-gutter.ts`: the first version surveyed the wrapping of every line on each edit (about 16 to 18 ms per pass plus layout) and ran inside the typed character's frame; typing p95 was 94 to 118 ms against 29 to 60 ms with the features off (heavily loaded machine, load average 10 to 14). Now an edit re-reads the line breaks and redraws the window only, the wrap survey runs 250 ms after typing pauses, and the update runs in an idle callback after the frame that painted the edit (bounded to 120 ms); the pane's box is only re-read on resize.
  - Recorded runs (features off / on; typing p95 ms, scroll p95 ms, scroll max ms, long tasks; machine load average 2 to 5 during these runs): 24.3 / 26.7, 16.7 / 16.7, 16.8 / 16.8, 5 / 3; 22.0 / 26.4, 16.7 / 16.7, 16.8 / 16.8, 3 / 3; 19.9 / 18.9, 16.8 / 16.7, 16.8 / 16.8, 3 / 4; 19.5 / 21.1, 16.8 / 16.8, 16.8 / 33.3, 3 / 3; 24.3 / 23.1, 16.8 / 16.7, 16.8 / 16.8, 3 / 3. One more run failed the typing budget (24 / 56) while other sessions loaded the machine (load average 3.9 and rising); it is recorded, not hidden. Global passes during typing: 2 (the pause pass and one after Vditor's own re-render about 2 s later, both outside the timed characters); during scrolling: 0. Labels per window pass: 43 to 82 passes wrote 3,373 to 5,715 labels (about 80 each).
  - Vditor re-renders the source block about 2 s after typing; that mutation schedules another survey 250 ms later, so the spec waits 3.5 s before the scroll phase and before typing.
  - Acceptance 8 is proven at the Chromium level only; the real-VS-Code large-document timing is not part of P2-10 (the existing Task 573 real-VS-Code large-document specs are unchanged).
  - Lint note: earlier checks of the Task 645 e2e files in P2-5 and P2-7 reported Biome clean from a truncated output; running `npx biome check media-src scripts` in full now shows three problems in `sv-current-line.spec.ts` and `sv-gutter.spec.ts`, all fixed in this step with no assertion changed.
- [x] P2-10 real VS Code: new `test/vscode-e2e/sv-pane-settings.spec.ts`, run with `sv-source-font.spec.ts` under xvfb with openbox and `VMDE_XTEST=1`, `--workers=1 --retries=0` after `node build.mjs`: 4/4 passed (started 2026-11-01 03:02 local time; log `tmp/645/p2-10-vscode-final.log`, JSON report in the same file). The new spec drives an open Split editor through the real configuration pipeline: `sourceFontSize` 20 gives a 20px/31px source pane while the rendered pane keeps the `fontSize` of 17px; `sourceBackground` gives `rgb(16, 32, 48)`; `splitGap` 24 gives a 24px measured distance; invalid values (`huge`, `red;}`, 500) fall back to the measured defaults; `sourceLineNumbers` shows one number per line equal to the host line count with `↳` sub-numbers on wrapped rows and the overlay outside `.vditor`; the highlight band follows two XTEST `Down` keys onto the caret row and is hidden by XTEST `Shift+Right`; an XTEST character reaches the host and one XTEST Ctrl+Z restores the exact bytes and a clean document; XTEST Enter adds a number and Backspace removes it; document bytes and dirty state stay unchanged by every toggle. Acceptance 1 to 7 are proven in real VS Code.
  - Findings while writing it: a lone Enter in the Split source pane is not written to the host until the next edit (the same as before this task, recorded in Task 628 for the other modes), so the spec checks the host after Backspace; the Split source pane always shows a final empty line, so the gutter matches the host line count only for a document that ends with a newline (numbers follow the pane text, risk R4); an XTEST caret placed by script can sit in a text span that begins with an empty text node, so the spec's caret helper picks the first non-empty text node.
- [x] P2-11 closure: README and CHANGELOG describe the six settings; gates below.

Contract details fixed while writing the P2-1 tests (reversible, same decision as D3, D4 and D7):

- `resolveSourceFontSize` returns `undefined` for "follow" and `{ fontSize, lineHeight, lineScale }` otherwise; `lineScale` is exactly 1 for 14. A value of `vditor` follows, because only `editor`, empty and a number or numeric string (optional `px`) from 6 to 100 are recognised.
- The host payload field `sourceFontSize` is the string `"editor"` when following, else the resolved size (for example `"18px"`); the webview resolves again and accepts that form.
- The host payload fields `sourceBackground` and `sourceCurrentLineBackground` are `''` when empty or invalid; `sourceLineNumbers` and `sourceHighlightCurrentLine` are `true` only for the boolean `true`; `splitGap` is the resolved number.
- Initial HTML always carries `data-source-line-numbers`, `data-source-current-line` and `--vmde-split-gap`; it carries `--me-source-font-size`, `--me-source-line-height`, `--me-source-line-scale` and `--vmde-source-background` only for a usable value.

## Closure record (2026-11-01)

Focused gates run in the worktree: `node build.mjs` exit 0; `npm run typecheck` exit 0; `npm run lint` exit 0 (1,273 files); focused Vitest (content-theme, manifest, resource-scoped-config, html-builder, module-boundaries, live-config, diagram-config-delta, sv-gutter-plan, sv-gutter) 9 files, 249/249; Chromium `sv-pane-settings`, `sv-gutter`, `sv-current-line`, `sv-source-font`, `split-scroll` 50/50; `sv-pane-large` rerun at load average about 4.5: typing p95 43.2 ms features off (one noisy sample) against 20.1 ms on, scroll p95 and max 16.7 and 16.8 ms in both, zero global passes during scrolling; real VS Code `sv-pane-settings` and `sv-source-font` 4/4 (P2-10, no product code changed since).

`npm run quality`: `check:brand-identifiers`, `lint:ci`, `knip`, `jscpd`, `depcruise`, `test:coverage` and `check:coverage-modules` (10 modules at 0%, baseline 10) pass; `audit` fails on dependency advisories in the shared dependency tree (for example the Azure identity library and the test runner's mocker package), not in files this task changed. It is recorded, not fixed.

Remaining known limits: the typing budget is a relative bound on frame-quantized samples and failed once in six runs under external machine load; gutter labels can lag typing by up to about 120 ms and the gutter width by 250 ms after typing pauses; a Split pane always shows a final empty line, so the numbers match the host line count only for a document that ends with a newline; a lone Enter in the Split pane reaches the host with the next edit (unchanged behavior); large-document timing is Chromium-level.
