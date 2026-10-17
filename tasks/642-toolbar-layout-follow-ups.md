# Task 642 — Responsive toolbar flow, collapsed-row buttons, Preview placement and tooltips

**Status:** open.
**Origin:** Project Owner feature request.
**Severity:** feature (low to medium risk; toolbar chrome and one persisted preference).
**Tech stack:** TypeScript webview (`media-src/src/chrome/toolbar.ts`, `toolbar-collapse.ts`, `toolbar-layout.ts`, `toolbar-overflow.ts`, `util/lang.ts`), toolbar CSS, extension host (`globalState`), Vitest, Chromium, real VS Code.
**Related:** [Task 651](651-remember-preview-toggle-state.md) (remembered Preview state, split out of requirement 12), [Task 644](644-insert-id-html-id-targets.md) (Insert ID writes and resolves `id` targets), [Task 643](643-preview-mode-streaming-performance.md) (Preview streaming and performance).
**Builds on:** [Task 632](done/632-toolbar-conventional-grouping.md) (conventional group order) and [Task 631](done/631-toolbar-collapse-toggle.md) (collapse toggle, its size, and the shared collapse state). This task replaces Task 632's fixed row membership with a width-driven flow and keeps its group order, except that Preview moves beside Edit Mode.

## Problem

The toolbar places controls in two authored rows, regardless of the editor width. The rows sit far apart, the collapse toggle moves when the toolbar collapses or expands, and the collapsed strip holds only the toggle. Preview sits in the view group, away from Edit Mode, and its on/off state is not kept. Most tooltips name a control without saying what it does, and More menu items have none.

## Requirements

### Layout and flow

1. **One ordered sequence.** Controls keep Task 632's left-to-right group order, with Preview moved directly beside Edit Mode.
2. **Expanded toolbar.** Controls fill the first row from left to right. Only when the first row is full do the remaining controls start the second row.
3. **Collapsed toolbar.** Controls fill a single row from left to right. When the row is full, the remaining controls move into the More menu. Preview, Edit Mode and More always stay visible as the last three controls of the row, in that order: More takes the last spot.
4. **Emoji is not pinned.** Emoji moves into More like any other control when the row has no room for it.
5. **Collapsed-row buttons.** Buttons on the collapsed row are small: the same size as the collapse/expand toggle.
6. **Responsive.** The flow follows the current width of the editor. Resizing VS Code rearranges the controls to fit the new width, with no reload and no stale layout after a mode switch or collapse/expand.
7. **Row spacing.** The vertical gap between the two expanded rows is 20% of today's gap. Button sizes do not change.

### Collapse/expand toggle

8. **Fixed position.** The toggle stays in the same place when the toolbar collapses or expands. Its collapsed position is the reference; the expanded layout matches it.
9. **Separation.** In both states, a visible gap separates the controls from the toggle.
10. **Tooltip.** The toggle has a descriptive tooltip.

### Preview

11. **Icon.** The Preview control uses an icon that shows a document with an eye. The current icon reads as Search.
12. **Remembered Preview state.** Moved to [Task 651](651-remember-preview-toggle-state.md): Preview as the fourth mode with its own remembered toggle, the open rule with path rules and `vmde.editor.defaultMode`, and large documents.

### Wiki Pages icon

13. The Wiki Pages control uses a standard icon with the letter "W". Today it uses the codicon `book` (`wikiPagesIcon` in `media-src/src/chrome/toolbar-icons.ts`), an open book drawn as two panels, which reads as split view.

### Insert anchor name

14. The More item "Insert anchor" is renamed **Insert ID**, in its menu label, tooltip, dialog title and command title. What it inserts changes to an `id` target in [Task 644](644-insert-id-html-id-targets.md).

### Tooltips and More menu items

15. Every toolbar button and every More menu item has a short tooltip that says what it does, not only its name. Tooltips show no key, because an extension cannot read the user's rebindings.
16. Every More menu item shows its name next to its icon, never an icon alone. This includes controls that overflow into More from the toolbar.
17. The Settings item in More shows the cog icon (the codicon `settings-gear`, as on the editor title bar) next to its name.

## Open design points (settled in Part 1)

- How Preview combines with Split, which has its own preview pane. Settled — see Part 1 handoff.
- What happens when the second expanded row is also full. Proposed: the remaining controls move into More, with Preview, Edit Mode and More kept as the last three controls. Settled — see Part 1 handoff.
- Whether a separator may end a row. Settled — see Part 1 handoff.
- The width of the gap before the toggle. Settled — see Part 1 handoff.
- How tooltips are shown for More items, whose `tip` text is also their menu label. Settled — see Part 1 handoff.
- Which other More items have no icon today (they render as text only) and whether each needs one to meet requirement 16; any icon added for them goes to the Owner first. Settled — see Part 1 handoff.
- The Preview icon source (document with an eye): an existing codicon if one fits, otherwise a 16×16 `currentColor` SVG with a compatible license, recorded with its provenance. Settled — see Part 1 handoff.
- The "W" icon source: a 16×16 `currentColor` SVG with a license compatible with the extension (a plain letter glyph, not a third-party brand logo such as Wikipedia's), recorded with its provenance. Settled — see Part 1 handoff.
- Which collapsed-row controls are shown, and the strip height (Task 631 set the toggle to 17.5×24 px with an 11.2 px icon and the strip to 25 px). Settled — see Part 1 handoff.

## Approved icons

| Control | Icon | Source | License |
| --- | --- | --- | --- |
| Preview | Codicons `preview` | `microsoft/vscode-codicons`, `src/icons/preview.svg` | CC BY 4.0 |
| Wiki Pages | Tabler `file` with Tabler's letter W drawn in the page body (composed for this task, SVG below) | `tabler/tabler-icons`, `icons/outline/file.svg` and `icons/outline/letter-w.svg` | MIT |
| Settings (More) | Codicons `settings-gear` | `microsoft/vscode-codicons`, `src/icons/settings-gear.svg` | CC BY 4.0 |
| Split View (More) | Codicons `split-horizontal` | `microsoft/vscode-codicons`, `src/icons/split-horizontal.svg` | CC BY 4.0 |
| Insert picture (More) | Codicons `file-media` | `microsoft/vscode-codicons`, `src/icons/file-media.svg` | CC BY 4.0 |
| About Vditor, About VMDE (More) | Codicons `info` | `microsoft/vscode-codicons`, `src/icons/info.svg` | CC BY 4.0 |
| Inline math (Math menu) | Lucide `sigma` | `lucide-icons/lucide`, `icons/sigma.svg` | ISC |
| Math block (Math menu) | Lucide `square-sigma` | `lucide-icons/lucide`, `icons/square-sigma.svg` | ISC |
| Headings | Tabler `heading` | `tabler/tabler-icons`, `icons/outline/heading.svg` | MIT |
| Edit Mode | Lucide `square-pen` | `lucide-icons/lucide`, `icons/square-pen.svg` | ISC |
| Insert Before | Tabler `row-insert-top` | `tabler/tabler-icons`, `icons/outline/row-insert-top.svg` | MIT |
| Insert After | Tabler `row-insert-bottom` | `tabler/tabler-icons`, `icons/outline/row-insert-bottom.svg` | MIT |
| Insert anchor (More) | Tabler `hash` | `tabler/tabler-icons`, `icons/outline/hash.svg` | MIT |

Copy each SVG unmodified from its source file. Tabler and Lucide icons are 24×24 stroke icons, scaled to 16 px like the other toolbar icons. The Wiki Pages icon is composed from two Tabler icons:

```svg
<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3v4a1 1 0 0 0 1 1h4" /><path d="M17 21h-10a2 2 0 0 1 -2 -2v-14a2 2 0 0 1 2 -2h7l5 5v11a2 2 0 0 1 -2 2" /><path d="M8.5 11.5l1.25 5.5l2.25 -4l2.25 4l1.25 -5.5" /></svg>
```

Codicon artwork is licensed CC BY 4.0 (the code in that repository is MIT); its notice already ships as `media/codicons.LICENSE`. Tabler icons need the MIT notice and Lucide icons the ISC notice: ship `media/tabler-icons.LICENSE` and `media/lucide.LICENSE`, and add both sets to the README's Icons acknowledgements, updating its Codicons list (Wiki Pages, Edit Mode, Insert Before and Insert After no longer use Codicons or Vditor icons).

## Reference: Insert anchor and Insert picture

The More menu lists Split View, Settings, Insert anchor, Insert picture, About Vditor and About VMDE.

- **Insert anchor** (`editing/named-anchor-insertion.ts`) asks for a name and inserts an HTML named anchor (`<a name="…"></a>`) at the caret. A link such as `#name` or `file.md#name` then jumps to that spot, in the same document or from another file.
- **Insert picture** (`editing/inline-picture.ts`) asks for a fallback image, alt text, and optional dark-theme and light-theme images, and inserts an HTML `<picture>` element. The rendered image follows the light or dark theme.

## Scope

- In: control order and flow, row gap, collapsed-row buttons, toggle position, separation gap and tooltip, Preview placement, the Wiki Pages and Preview icons, tooltips for toolbar buttons and More items, More item labels, keyboard traversal and overflow for the new layout.
- Out: new actions, removing controls, renaming actions other than Insert anchor (requirement 14), changing shortcuts.

## Acceptance

- [ ] Preview sits directly beside Edit Mode; no control is missing or duplicated, with wiki navigation on and off.
- [ ] Expanded, at several editor widths, the first row holds the longest prefix of the sequence that fits and the second row starts with the next control.
- [ ] Collapsed, the row holds the longest prefix that fits plus Preview, Edit Mode and More as the last three controls; the remaining controls are in More and work from there.
- [ ] Collapsed-row buttons measure the toggle's size and run their actions.
- [ ] After resizing the editor wider and narrower, the layout matches the rules above for the new width without a reload, in both states and after a mode switch.
- [ ] The measured gap between the expanded rows is 20% (±1 px) of the gap before this task, in IR, WYSIWYG and SV.
- [ ] The toggle's bounding box is equal (±0.5 px) before and after collapse and expand.
- [ ] A measured gap separates the controls from the toggle in both states.
- [ ] The Preview control shows a document-with-eye icon at the same size as the other toolbar icons, in the toolbar and in More.
- [ ] Every toolbar button, More item and the toggle has a non-empty descriptive tooltip; no tooltip shows a key.
- [ ] Every More item, including overflowed controls, shows a visible text label beside its icon, in both toolbar states.
- [ ] The Settings item in More shows the cog icon beside its name and still opens the VMDE settings.
- [ ] The Wiki Pages control shows a "W" icon at the same size as the other toolbar icons, in the toolbar and in More, and still lists the wiki pages.
- [ ] Keyboard traversal follows the visual order in both states.
- [ ] Focused Vitest, Chromium and real-VS-Code specs are written and run; network-free gates pass at closure.

## Tests

- Vitest: control sequence and Preview position, flow planning at given widths (expanded and collapsed, Preview, Edit Mode and More as the last three), tooltip text for every item.
- Chromium: flow at several widths and after resize, row gap, toggle box in both states, separation gap, collapsed-row button sizes and actions, overflow into More with a visible label for each item, keyboard order.
- Real VS Code (`test/vscode-e2e/`): extend the `toolbar-collapse` and `toolbar-order` specs (flow at two widths, resize, toggle position).

## Part 1 handoff (2026-10-17)

Design synthesis only; no product or test file changed, nothing built or run. It reuses the Part 1 measurements taken earlier on the Chromium toolbar harness (`media-src/e2e/toolbar-overflow.html`, 1400×700, wiki on and off, IR, WYSIWYG and SV) and applies the later Owner decisions recorded above: More takes the last spot, Emoji is not pinned, the remembered Preview state belongs to Task 651, Insert anchor becomes Insert ID, and the icons in "Approved icons". Every file and line cited below was read at `dev` `d96c6040`.

### Measurements reused (Requirements 5, 7, 8, 9)

| Item | Today (IR, WYSIWYG and SV alike) |
| --- | --- |
| Normal button | 25 × 35 px border box: 6 px transparent top and bottom borders plus 4 px padding (`vscode-chrome.css:215-222`); painted hover band 25 × 23 px; icon 16 px |
| Separator | 1 × 19 px rule with 8 px side margins: 17 px per separator |
| Rows | `.vmde-toolbar-row`, `min-height: 35px` (`vscode-chrome.css:417-423`); row 1 y 1–36, row 2 y 36–71; toolbar 71 px expanded, 25 px collapsed |
| Row gap | Painted band to painted band: row-1 band ends at y 30, row-2 band starts at y 42, so **12 px**, made only by the two 6 px transparent borders |
| Toggle | 17.5 × 24 px, 11.2 px icon (`vscode-chrome.css:462-486`); x 1376.5 in both states; y 6.5 expanded (centred in a 35 px row), y 1 collapsed: a 5.5 px jump |
| Toolbar padding | 52 px start, 5 px end (Vditor's content-aligned padding, varies with the editor width) |
| Layout pass cost | Median 0.7–1.7 ms, 90th percentile 2.9 ms, maximum 6.6 ms per synchronous pass at 300–1400 px |

### Tail order (Requirements 1, 3)

Requirement 3 is unambiguous: Preview, Edit Mode and More are the last three controls of the row, in that order, with More in the last spot. The old Part 1 notes placed More before Preview; that is superseded. The same tail ends the expanded toolbar, so the sequence is one order in both states.

### Settled design points

1. **Preview and Split.** No combination logic. Preview stays Vditor's overlay over the current edit mode, Split included (verified in Task 651's handoff: Vditor's `Preview.ts` restores the Split panes on the way out). Split's own preview pane stays the More item `both` (label "editor & preview", shown only in SV). Task 642 only moves the Preview control, changes its icon and adds its tooltip; it stores no state and adds no listener.
2. **Second expanded row full.** The remaining controls move into More, and Preview, Edit Mode and More stay the last three controls of the last used row (the proposal, adopted). The toolbar never has more than two rows.
3. **Separator at a row end.** Never. A row never starts or ends with a separator, and More holds no group separator (its existing overflow divider stays). A separator is shown only between two placed controls of different groups in the same row.
4. **Gap before the toggle.** 12 px minimum, in both states and in both rows: about half a button, clearly wider than the 0 px between buttons, and no rule. Both rows reserve the toggle column (toggle width plus the gap), so no control ever sits under or beside the toggle.
5. **Tooltips for More items.** In a More row the `aria-label` (overflowed controls) or the row text (authored items) is the visible label, so the description goes into the native `title` attribute plus `aria-description`. Top-level buttons keep `aria-label` as the name and show the description through `data-vmde-tip` (details under "Tooltips").
6. **More items without icons.** Today Split View (`both`), Settings, About Vditor and About VMDE show text only, Insert picture shows the text "Image" (`toolbar.ts:361`), and Insert anchor shows the link icon only (`toolbar.ts:348`). The Math submenu rows `math-inline-github` and `math-block` show "undefined", because Vditor's `Custom` writes the missing `icon` into the row. Every one of these now gets its approved icon plus its name (see "More and Math menu rows").
7. **Preview icon.** Codicons `preview` (approved).
8. **"W" icon.** The approved Tabler composition (SVG in "Approved icons").
9. **Collapsed row.** Every control that fits, as the longest prefix of the sequence, then Preview, Edit Mode and More, then the gap and the toggle; the rest is in More. The strip stays at Task 631's height: a 24 px row plus the 1 px toolbar border, 25 px in all.

### Sequence (Requirement 1)

Wiki navigation on, `|` marks a group boundary:

`undo redo | headings | bold italic underline strike inline-code | subscript superscript | link | list ordered-list check | outdent indent | quote callout details code math table line | upload emoji | insert-before insert-after | outline | navigate-back wiki-pages | edit-in-vscode preview edit-mode more`

- Changes to `createToolbar` (`toolbar.ts:152-399`): `'preview'` leaves the outline group (`toolbar.ts:271`) and sits between `edit-in-vscode` and `edit-mode`; a `'|'` is added between `indent` and `quote` (Task 632 left none because they sat in different fixed rows; in a flow they can share a row). Wiki off drops `navigate-back wiki-pages` and its `'|'`. The toggle (`collapse-toolbar`) stays the last authored item and is not part of the flow.
- 34 controls and 12 separators with wiki on, 32 and 11 with wiki off. Preview, Edit Mode and More share the last group with Edit In VS Code, so no rule separates Preview from Edit Mode; when Edit In VS Code is in More, the rule before the tail comes from the boundary before that group.
- Nothing is pinned apart from the tail. Undo and Redo lead the sequence, so they are the last controls to leave. Emoji moves into More like any other control; its picker already has geometry inside More (`vscode-chrome.css:151-166`). Task 632's `PRIMARY_ROW_ONE`, `PRIMARY_ROW_TWO`, the row cluster tables and `ROW_ONE` go away (`toolbar-overflow.ts:68-97`, `toolbar-layout.ts:3-25`).

### Planner contract (Requirements 2, 3, 6)

New pure module `media-src/src/chrome/toolbar-flow.ts`, with no DOM access:

```ts
export interface FlowControl { name: string; group: number; width: number }
export interface FlowInput {
  controls: readonly FlowControl[] // visible controls in sequence order; hidden ones (SV) left out; no toggle
  separatorWidth: number           // rule width plus both margins, in the current state
  rowWidths: readonly number[]     // expanded: [w, w]; collapsed: [w]; w already excludes the toggle column
  tail: readonly string[]          // ['preview', 'edit-mode', 'more']
}
export interface FlowPlan {
  rows: string[][]                 // control names with '|' tokens where a rule is shown; empty rows dropped
  more: string[]                   // controls in More, in sequence order
}
export function planToolbarFlow(input: FlowInput): FlowPlan
```

Rules, in order:

1. The tail is placed as one unit and is never split across rows or moved into More. The body is every other control.
2. A row's width is the sum of its control widths plus `separatorWidth` for each `'|'`. A `'|'` sits between two neighbouring placed controls of different groups and nowhere else.
3. If the whole sequence fits the first row, the plan is that one row.
4. Otherwise each row except the last takes the longest body prefix that fits. If a non-last row cannot hold the next body control, the last-row rule applies to that row instead (no empty first row).
5. Last row: if the remaining body plus the tail fits, place it all. Otherwise reserve the tail (including the `'|'` before it when the control before it is in another group), place the longest remaining body prefix that fits before it, and move every other remaining body control into More. If the tail alone does not fit, place it anyway and move all remaining body controls into More.
6. Widths are compared as `sum <= floor(rowWidth)` on ceiled control widths. There is no hysteresis: the same inputs always give the same plan.

The DOM pass in `toolbar-overflow.ts` builds the inputs and applies the plan:

- `rowWidths`: the toolbar content width (`clientWidth` minus padding, as `toolbar-overflow.ts:477-487` does today) minus the toggle wrapper's border-box width (it carries the gap, below). Expanded uses two equal rows; collapsed uses one.
- Widths are measured in the current state, with every control back in row 1 (the existing `remeasure` pattern, `toolbar-overflow.ts:429-440`). The cache is invalidated when the state (collapsed or expanded), the metrics probe (`toolbar-overflow.ts:422-423`) or the visible set changes. This replaces "skip while collapsed" (`toolbar-overflow.ts:467-476`) and fixes the Task 631 leftover of stale widths after an SV round trip.
- The signature is the width, the state, the visible set and the plan. An unchanged signature returns early after the separator refresh (keep `toolbar-overflow.ts:507-514`). A height change alone (row 2 shown or hidden) cannot change the plan, so it cannot loop.
- Placement: walk the plan and call `insertBefore` only for nodes that are not already in place, so unmoved controls keep focus (as `authoredInsert` does, `toolbar-overflow.ts:246-262`). A `'|'` before control `y` uses the authored divider immediately before `y`'s group. Each boundary is used at most once. Unused dividers are detached and restored by the disposer. The toggle wrapper stays the last child of row 1. Row 2 gets the `hidden` attribute when the plan has one row. The toolbar gets the class `vmde-toolbar--two-rows` when the plan has two rows.
- Kept unchanged: observers and `rAF` scheduling (`toolbar-overflow.ts:568-619`), `inlineOverflowIcon`, `setArrowPanel`, the More overflow divider, `closeSubmenuPanels` on a changed plan, focus repair (a control that moves into More hands focus to More), and `refreshRoving` after each changed plan.
- Removed: `computeOverflow`, `decideOverflowGroups`, `HYSTERESIS_PX`, the cluster tables and `projectedRowWidth`. `KNOWN_TOOLBAR_ITEMS` stays and follows the new sequence.
- `toolbar-layout.ts`: `ensureToolbarRows` still creates the two row containers, but authors every control and divider into row 1 in sequence order; row 2 starts empty and the first plan distributes the controls.
- `toolbar-collapse.ts`: no layout change. The pass now runs while collapsed, with a one-row plan.

Expected one-row thresholds with today's widths (estimates; Part 2 measures them): wiki on, 34 × 25 + 12 × 17 + 29.5 = 1,083.5 px of content width (about 1,141 px of toolbar width with today's padding); wiki off, about 1,074 px of toolbar width.

### CSS changes (`media-src/src/vscode-chrome.css`)

- **Row gap (Requirement 7).** The gap stays defined as band to band: 12 px today, target 20 % = 2.4 px (acceptance ±1 px). While the toolbar has `vmde-toolbar--two-rows`, rows drop `min-height: 35px`, row-1 buttons get a 1.2 px bottom border and row-2 buttons a 1.2 px top border (instead of 6 px, overriding `vscode-chrome.css:215-222`, which uses `!important`). Bands (23 px), icons (16 px) and button widths do not change. Rows become 30.2 px each, so the two-row toolbar is 61.4 px instead of 71. A one-row toolbar keeps today's 35 px row (36 px with the border). The hit boxes meet at the midpoint of the gap: no overlap, so no row receives the other row's clicks. A negative margin on row 2, as the old notes proposed, was rejected: the 6 px row-2 border would cover 3.6 px of the row-1 band and take its clicks.
- **Toggle position (Requirement 8).** The toggle wrapper gets `align-self: flex-start`, so it sits at the top of row 1 (y 1) in both states, matching the collapsed position. Its x is already equal.
- **Gap before the toggle (Requirement 9).** The toggle wrapper keeps `margin-inline-start: auto` (`vscode-chrome.css:451-455`) and gets `padding-inline-start: var(--vmde-toggle-gap, 12px) !important`. The rule must be specific enough to beat the ≤ 520 px rule that zeroes item padding (`vscode-chrome.css:395-399`). The planner reserves the wrapper's measured width, so the measured gap (toggle left minus the right edge of the nearest control, in any row) is at least 12 px.
- **Collapsed row (Requirement 5).** Replace the rule that hides every row-1 item except the toggle (`vscode-chrome.css:443-448`) with one that hides row 2 only. Generalise the toggle's box rule (`vscode-chrome.css:465-486`) to every top-level button in the collapsed row: `width: calc(25px * var(--vmde-collapse-scale))`, `height: 24px`, `padding: 0`, 3 px transparent top and bottom borders, icon `calc(16px * var(--vmde-collapse-scale))`, giving 17.5 × 24 px with an 11.2 px icon. Separators in the collapsed row scale their height and side margins by the same variable.
- **Empty row 2.** `.vmde-toolbar-row[hidden] { display: none }`; the row rule's `display: flex` would otherwise override the attribute.
- **Stroke icons.** Vditor sets `fill: currentColor; stroke-width: 0` on every toolbar `svg` (`vditor/src/assets/less/_toolbar.less:50-56`). That would turn the unmodified Tabler and Lucide stroke icons into filled shapes. Add `.vditor-toolbar svg[fill="none"][stroke="currentColor"] { fill: none; stroke: currentColor; stroke-width: 2 }`, which also covers rows inside More and the Math menu. The SVG files stay unmodified.
- **Tooltips.** `.vditor-toolbar .vditor-tooltipped[data-vmde-tip]::after { content: attr(data-vmde-tip) }`, repeated with `!important` inside the ≤ 520 px media rule, which forces `attr(aria-label)` today (`vscode-chrome.css:403-405`).
- **Authored menu rows.** A row button that holds an icon and a `.vmde-menu-label` gets the same shape as an overflowed row (`vscode-chrome.css:121-139`): flex, 8 px gap, 16 px icon, no float.
- **Instant-paint placeholder.** `html-builder.ts:151` reserves 70 px expanded and 24 px collapsed. Expanded becomes 36 px above the measured one-row threshold and 62 px below it, through a width media query in the placeholder's style; collapsed stays 24 px. The overlay copy (`prerender-overlay.ts:33`) runs one synchronous flow pass on the clone after `bar.replaceWith(clone)` (a shared one-shot helper exported by `toolbar-overflow.ts`), so the copy shows the same rows as the live toolbar.

### Tooltips (Requirements 10, 15)

- **Channel.** New module `media-src/src/chrome/toolbar-tips.ts` holds the table below (item name to `lang.ts` key) and `applyToolbarTips(toolbar)`. On every top-level button it sets `data-vmde-tip` and `aria-description`. On every authored More and Math row it sets `title` and `aria-description`. `installToolbarOverflow` calls it once at install. `setOverflowRow` (`toolbar-overflow.ts:202-208`) sets `title` when a control moves into More and removes it when the control returns, so no control ever shows two tooltips. `renderCollapse` (`toolbar-collapse.ts:43-55`) sets the toggle's `data-vmde-tip` per state. `aria-label` stays the short name everywhere: it is the accessible name and the label of an overflowed row.
- **Direction.** After each changed plan the pass reads each placed button's box once. A button whose centre lies within 160 px of the toolbar's left content edge gets `vditor-tooltipped__se`, one within 160 px of the right edge gets `__sw`, and the others get `__s`. The toggle is always `__sw`. The `tipPosition: 'e'` on Edit Mode and More (`toolbar.ts:314`, `toolbar.ts:317`) goes away; it ran off the edge once the tail sits at the row end. Vditor already shows tooltips on `:hover` and `:focus`.
- **Text.** New `en_US` keys in `util/lang.ts`, named `tip` plus the item in PascalCase (`tipBold`, `tipInlineCode`, `tipCollapseToolbar`, `tipExpandToolbar`). Each is one short line with no key. Other languages fall back to English through `translate` (`lang.ts:88-91`).

| Control | Name (unchanged, except Insert ID) | Tooltip |
| --- | --- | --- |
| undo | Undo | Undo the last change |
| redo | Redo | Redo the last undone change |
| headings | Headings | Turn the block into a heading or paragraph |
| bold | Bold | Make the selection bold |
| italic | Italic | Make the selection italic |
| underline | Underline | Underline the selection |
| strike | Strikethrough | Strike through the selection |
| inline-code | Inline Code | Format the selection as inline code |
| subscript | Subscript | Format the selection as subscript |
| superscript | Superscript | Format the selection as superscript |
| link | Link | Insert a link, or link the selection |
| list | Bulleted List | Start or end a bulleted list |
| ordered-list | Numbered List | Start or end a numbered list |
| check | Checklist | Start or end a checklist |
| outdent | Outdent | Move the list item one level out |
| indent | Indent | Move the list item one level in |
| quote | Quote | Turn the block into a blockquote |
| callout | Callout | Insert or remove a callout |
| details | Toggle details around selected blocks | Wrap the selected blocks in a collapsible section |
| code | Code Block | Insert a code block |
| math | Math | Insert inline or block math |
| table | Table | Insert a table |
| line | Horizontal Rule | Insert a horizontal rule |
| upload | Upload image or file | Choose an image or file to insert |
| emoji | Emoji | Insert an emoji |
| insert-before | Insert line before | Insert an empty paragraph above the block |
| insert-after | Insert line after | Insert an empty paragraph below the block |
| outline | Outline | Show or hide the document outline |
| navigate-back | Go Back | Go back to the previous wiki page |
| wiki-pages | Wiki Pages | List and open the wiki pages |
| edit-in-vscode | Edit In VS Code | Open this file in the VS Code text editor |
| preview | Preview | Switch between editing and a read-only preview |
| edit-mode | Toggle Edit Mode | Choose WYSIWYG, Instant Rendering or Split View |
| more | More | More actions and settings |
| collapse-toolbar (expanded) | Collapse toolbar | Collapse the toolbar to one row of small buttons |
| collapse-toolbar (collapsed) | Expand toolbar | Expand the toolbar to full-size buttons |
| More: both | editor & preview | Show or hide the preview pane beside the source |
| More: settings | Settings | Open the VMDE settings |
| More: insert-anchor | Insert ID | Insert an ID that links can jump to |
| More: insert-picture | Insert picture | Insert a picture that follows the light or dark theme |
| More: info | About Vditor | Show the Vditor version and help links |
| More: about | About VMDE | Show the VMDE version and project link |
| Math: math-inline-github | Inline math (GitHub) | Insert inline math |
| Math: math-block | Math block | Insert a math block |

Names come from `toolbarTip` (`src/shared/editor-shortcuts.ts:478-482`), `util/lang.ts` or Vditor's `en_US` pack, and do not change (scope), except Insert ID.

### More and Math menu rows (Requirements 16, 17)

- Every row shows a 16 px icon followed by its name. Custom level-2 items (Settings, Insert ID, Insert picture, About VMDE, both Math rows) set `icon` to the icon SVG followed by `<span class="vmde-menu-label">` holding the localized name, because Vditor's `Custom` writes `icon` as the whole row (`vditor/src/ts/toolbar/Custom.ts:8`). Their `tip` stays the name. Built-in level-2 items (`both`, `info`) set `tip` to the same icon-plus-label markup, because Vditor's `MenuItem` writes a level-2 `tip` as the row's HTML (`vditor/src/ts/toolbar/MenuItem.ts:23-24`).
- Settings shows the `settings-gear` cog and still posts `open-settings`; the "No gear icon" comment (`toolbar.ts:335-336`) is replaced.
- Overflowed controls keep today's row: their icon (inlined by `inlineOverflowIcon`) plus the `::after` label from `aria-label` (`vscode-chrome.css:140-142`).

### Icon wiring and license files (Requirements 11, 13, 17)

- Every approved icon is an exported string in `media-src/src/chrome/toolbar-icons.ts`, copied unmodified from its source file, and wired through `icon:` in `toolbar.ts`. Vditor merges an `icon` override into a built-in item (`vditor/src/ts/util/Options.ts`, `mergeToolbar`, `Object.assign`), as `outline` already does (`toolbar.ts:270`). New strings: `previewIcon`, a replacement `wikiPagesIcon` (`toolbar-icons.ts:10-11`), `settingsGearIcon`, `splitHorizontalIcon`, `fileMediaIcon`, `infoIcon`, `sigmaIcon`, `squareSigmaIcon`, `headingIcon`, `squarePenIcon`, `rowInsertTopIcon`, `rowInsertBottomIcon` and `hashIcon`. Built-in items that gain an override: `headings`, `preview`, `edit-mode`, `insert-before`, `insert-after`.
- The build-time sprite is not used for these icons: `media-src/build-icon-sprite.mjs` keeps only an override's inner markup and forces `viewBox="0 0 16 16"` (lines 30-37 and 54-57), which would drop the 24 × 24 viewBox and the stroke attributes of the Tabler and Lucide icons. `media-src/icons/*.svg` stay untouched.
- The toolbar CSS sizes every toolbar `svg` to 16 px (`vscode-chrome.css:223-226`), and the collapsed row scales it; the stroke rule above keeps stroke icons drawn as strokes. Codicons are 16 × 16 fill icons and need nothing extra.
- License files: `media/codicons.LICENSE` exists. Add `media/tabler-icons.LICENSE` (MIT notice from `tabler/tabler-icons`) and `media/lucide.LICENSE` (ISC notice from `lucide-icons/lucide`). Both ship, because `.vscodeignore` does not exclude `media/*.LICENSE`. In `README.md` "Icons" (lines 540-544), update the Codicons list (add Preview, Settings, Split View, Insert picture, About; remove Wiki Pages; Edit Mode, Insert Before and Insert After are no longer Codicons or Vditor icons) and add Tabler and Lucide lines naming their controls and license files.

### Insert ID visible rename (Requirement 14)

| Where | Today | After |
| --- | --- | --- |
| More label and name (`util/lang.ts:35`, key `insertAnchor`, value only) | Insert anchor | Insert ID |
| More icon (`toolbar.ts:348`) | `linkIcon`, no label | Tabler `hash` plus the label "Insert ID" |
| Tooltip | none | "Insert an ID that links can jump to" |
| Dialog title (`editing/named-anchor-insertion.ts:190`, `aria-label`) | Insert anchor | Insert ID |
| Dialog field label (`named-anchor-insertion.ts:193`) | Anchor name | ID (Owner question 1) |
| Command title | none: no VS Code command exists for this item (no entry in `package.json` or `src/shared/editor-shortcuts.ts`) | nothing to rename |

Task 642 changes only visible strings. The item name `insert-anchor`, the `insertAnchor` key, the `vmde-insert-named-anchor` event, the dialog messages (`named-anchor-insertion.ts:205` and `:236`) and the inserted source belong to Task 644 (its requirements 1, 5 and 8), whichever lands first. Specs locate the item by `[data-type="insert-anchor"]`, so the rename does not break them; `toolbar-labels.test.ts:43-45` asserts the old label and changes in S1.

### Interaction with Task 651

- Task 651 S2 adds `installPreviewMemory(button, api)` and a programmatic guard in `media-src/src/chrome/open-preview.ts`, installs it in `media-src/src/boot/finish-init.ts` next to the other toolbar observers (`finish-init.ts:601-619`), and changes `boot/vditor-init.ts`. Its listener is bound on the Preview button (`[data-type="preview"]`) and reads `vditor-menu--current`.
- Task 642 does not edit `open-preview.ts`, `finish-init.ts` or `vditor-init.ts`. The tooltip pass runs from `installToolbarOverflow` and the toggle tip from `toolbar-collapse.ts`, so no new install line is needed in `finish-init.ts`. 642 moves the Preview wrapper by reparenting the same node (never cloning), so 651's listener survives every move into and out of More. Because the tail is always visible, the Preview button 651's tests click never sits inside More.
- Task 642 owns `media-src/e2e/toolbar-overflow-harness.ts`, `toolbar-overflow.html` and `toolbar-overflow.spec.ts`; Task 651's Chromium spec uses its own harness copy. Task 642 runs after 651 lands: S1 starts from a `dev` that contains 651 and re-reads `open-preview.ts` and `finish-init.ts` first.

### Part 2 steps

| Step | Owned files | Tests and the acceptance items they prove |
| --- | --- | --- |
| S1 product, Vitest and Chromium | `media-src/src/chrome/toolbar.ts`, `toolbar-layout.ts`, `toolbar-overflow.ts`, `toolbar-collapse.ts`, `toolbar-icons.ts`, `prerender-overlay.ts`; new `toolbar-flow.ts` and `toolbar-tips.ts` with tests; `media-src/src/util/lang.ts`; `media-src/src/vscode-chrome.css`; `media-src/src/editing/named-anchor-insertion.ts` (strings only); `src/webview-host/html-builder.ts`; `scripts/module-manifest.mjs` (`toolbar-flow`, `toolbar-tips` in the `chrome` list); `media/tabler-icons.LICENSE`; `media/lucide.LICENSE`; `README.md`; Vitest `toolbar.test.ts`, `toolbar-layout.test.ts`, `toolbar-overflow.test.ts`, `toolbar-collapse.test.ts`, `toolbar-labels.test.ts`, `prerender-overlay.test.ts`, `named-anchor-insertion.test.ts` if it asserts a changed string, `test/backend/html-builder.test.ts`; Chromium `media-src/e2e/toolbar-overflow.spec.ts` and its harness | Vitest: sequence with wiki on and off, Preview directly before Edit Mode, none missing or duplicated (A1); planner at given widths: longest first-row prefix, row 2 starts with the next control (A2), collapsed prefix plus tail, rest in More (A3), tail kept in the last row, tail alone too wide, empty first row avoided, no `'|'` at a row edge, hidden-group rule, deterministic at a boundary width (edge cases); every top-level item, More row, Math row and both toggle states has a non-empty tip with no key name (A10); every More row has a label (A11); new icons are `currentColor`, Tabler and Lucide keep their 24 × 24 viewBox and stroke attributes (A9, A13); Insert ID strings. Chromium: flow at several widths and after resizing wider and narrower, both states, after an SV round trip (A2, A3, A5); band gap 2.4 ± 1 px in IR, WYSIWYG and SV (A6); toggle box equal ± 0.5 px across collapse and expand (A7); gap ≥ 12 px in both states and both rows (A8); collapsed buttons 17.5 × 24 px and a click runs the action (A4); overflowed controls, Emoji included, work from More (A3); Preview and Wiki Pages icons are 16 px in the row and in More (A9, A13); hover and focus show the description, inside the viewport at both edges (A10); every More row, authored and overflowed, has a visible label beside its icon in both states (A11); Settings shows the cog and opens settings (A12); keyboard order follows the visual order in both states (A14) |
| S2 real VS Code | `test/vscode-e2e/toolbar-collapse.spec.ts`, `test/vscode-e2e/toolbar-order.spec.ts`; the 642-specific assertions of `test/vscode-e2e/toolbar-overflow.spec.ts` | `toolbar-order`: sequence with wiki on and off (A1), flow at two widths and after a resize (A2, A5), labels and tooltips without keys (A10, A11; the existing "no tooltip ... names a key" test at line 653 covers the new descriptions), OS-key traversal with `VMDE_XTEST=1` (A14). `toolbar-collapse`: collapsed prefix plus tail (A3), toggle box ± 0.5 px (A7), gap (A8), collapsed button size and action (A4). One probe step checks that a More row's native `title` tooltip appears in the VS Code webview. `toolbar-overflow.spec.ts` encodes Task 632's fixed rows ("responsive two-row toolbar restores overflow by keyboard", line 8, and the row assertions of "two toolbar rows survive edit-mode and Preview transitions", line 199): update those assertions to the flow. The known failures in this file, recorded as tests 195 and 787 (by title, most likely the tests now at lines 199 and 791: the edit-mode/Preview transition test and the Emoji high-contrast tile test; the mapping is inferred from a 4-line shift, not verified), stay known failures and are not fixed here. Run `node build.mjs` first, then each spec once with `--workers=1 --retries=0` under `xvfb-run -a`. |
| S3 closure | `tasks/642-toolbar-layout-follow-ups.md`, `tasks/README.md` | Network-free gates once (A15): typecheck, lint, Vitest coverage, knip, jscpd, dependency-cruiser, the zero-coverage ratchet; then the record, the acceptance evidence and the index. |

Specs that import or exercise the changed files and run once in S1: `media-src/e2e/toolbar-overflow.spec.ts`, `escape-toolbar-harness.spec.ts`, `toolbar-selection.spec.ts`, `prerender.spec.ts` (overlay copy and placeholder) and `webview-behaviors.spec.ts` (its More Insert anchor test, line 601). Real VS Code in S2 also reruns `test/vscode-e2e/escape-toolbar.spec.ts`. The local-only `@visual` toolbar goldens, if any cover the toolbar, will change and need the Owner's go-ahead to update.

### Edge cases for Part 2

A width exactly at a row or More boundary (one control flips, never oscillates); a vertical scrollbar appearing when row 2 appears; SV hiding Outdent, Indent, Outline, Insert Before and Insert After (plan, rules and widths); wiki on and off; a submenu open while the plan changes (closed, as today); focus on a control that moves into More (focus goes to More) or changes rows (focus kept); Emoji, Headings, Edit Mode and Math panels opened from the collapsed row and from inside More; Preview on (editing controls disabled but still placed); the collapsed row at a very narrow width (only Preview, Edit Mode, More and the toggle); the instant-paint height on both sides of the one-row threshold; a zoom or font-size change (re-measure through the metrics probe); `prefers-reduced-motion`.

### Owner questions (not blocking; S1 proceeds with the recommendation)

1. **Insert ID dialog field label.** (a) Rename "Anchor name" to "ID" in Task 642, and leave the dialog messages to Task 644 (recommended: the dialog then matches its title, and 644's acceptance keeps the existing duplicate message). (b) Leave the field label to Task 644.
2. **Tooltip wording.** (a) The description alone, as in the table (recommended: the name is already the accessible name and the More label). (b) Name plus description, for example "Bold: make the selection bold", which roughly doubles the tooltip width.

**Owner answers (2026-10-17, chat):** 1 (a) rename the field label to "ID" in this task; dialog messages stay with Task 644. 2 (a) description-only tooltips.


### Residual risks

- Native `title` tooltips in More rows are not part of the DOM, so tests can check the attribute but not the painted tooltip. The S2 probe checks it once in real VS Code; if the webview shows no native tooltip, the fallback is a CSS tooltip on the row, which needs a new design round.
- The two-row toolbar is 61.4 px and a one-row toolbar 36 px, against 71 px today. The document starts higher on wide windows; the Find widget follows the toolbar through its own size observer (`toolbar-collapse.ts:85-86`).
- Other languages show English descriptions next to Vditor's localized names until translations are added.
- Task 641 (open-to-ready) may also change `prerender-overlay.ts` or `html-builder.ts`; S1 checks for that at rebase.
- The 12 px gap and the 160 px tooltip edge band are design values that Part 2 measures; neither needs Owner approval unless a measurement contradicts it.

## Execution progress — 2026-10-17 (S1a, S1b)

**S1a (planner).** Committed as `8b3d507a`: the pure flow planner `media-src/src/chrome/toolbar-flow.ts` with 30 Vitest cases. Not wired into the DOM yet (S1c).

**S1b (tooltips, labels, icons, licenses, Insert ID strings).** Implemented in the working tree, not committed.

- `chrome/toolbar.ts`: one sequence (Preview between `edit-in-vscode` and `edit-mode`, a `'|'` between `indent` and `quote`, `tipPosition: 'e'` removed); `icon:` overrides for `headings`, `preview`, `edit-mode`, `insert-before`, `insert-after`; the More and Math rows carry icon plus `<span class="vmde-menu-label">` (custom rows through `icon`, built-in `both` and `info` through `tip`); Settings uses `settings-gear` and still posts `open-settings`.
- `chrome/toolbar-icons.ts`: `previewIcon`, `settingsGearIcon`, `splitHorizontalIcon`, `fileMediaIcon`, `infoIcon`, `sigmaIcon`, `squareSigmaIcon`, `squarePenIcon`, `headingIcon`, `rowInsertTopIcon`, `rowInsertBottomIcon`, `hashIcon`, and the composed `wikiPagesIcon`, each copied from its upstream file (metadata comment dropped, whitespace collapsed).
- New `chrome/toolbar-tips.ts`: tip table, `tipFor`, `collapseToggleTip`, `applyToolbarTips`, `tipDirection` (160 px bands) and `applyToolbarTipDirections`. Exported only; S1c calls it from the overflow pass and the collapse toggle. `toolbar-tips` added to the `chrome` list in `scripts/module-manifest.mjs`.
- `util/lang.ts`: `tip*` keys; `insertAnchor` is "Insert ID". `editing/named-anchor-insertion.ts`: dialog title "Insert ID", field label "ID" (messages unchanged for Task 644).
- `vscode-chrome.css`: stroke icons, `data-vmde-tip` tooltip content (with the 520 px repeat), authored menu row shape. `media/tabler-icons.LICENSE`, `media/lucide.LICENSE` (upstream texts), README Icons section.
- Tests: `toolbar.test.ts` (sequence, wiki on and off, Preview before Edit Mode: A1), `toolbar-labels.test.ts` (Insert ID; icons `currentColor`, Tabler and Lucide keep 24×24 and stroke attributes; wiring; Settings still opens settings: A9, A11, A12, A13), `toolbar-tips.test.ts` (every item, row and both toggle states has a tip without a key; directions: A10), `named-anchor-insertion.test.ts` (title and label).
- Verification: Vitest of the changed files and `module-boundaries.test.ts` pass; `npm run typecheck`, `npx tsc --noEmit -p ./`, `biome check` and `node build.mjs` pass; Chromium `webview-behaviors`, `escape-toolbar-harness` and `toolbar-selection` pass (34 tests).
- Open for S1c: `toolbar-overflow.spec.ts` cases at lines 54, 1417 and 1495 still expect Preview after Outline and fail on the new sequence; `toolbar-tips` has no importer until S1c wires it (knip will flag it until then); the painted tooltip, tip direction and Math/More row shapes are not exercised in a browser yet.

## Execution progress — 2026-10-17 (S1c)

**S1c (flow integration, layout CSS, instant-paint placeholder, Chromium).** Implemented in the working tree on top of S1a and S1b, not committed.

- `chrome/toolbar-overflow.ts`: the cluster tables, `computeOverflow`, `decideOverflowGroups`, `HYSTERESIS_PX` and `projectedRowWidth` are gone. One flow controller reads the authored sequence (controls and their separator groups), measures control and rule widths from a row that holds everything (cache key: font size, device ratio, the 520 px padding rule, collapsed state, visible set), plans with `planToolbarFlow` and places the plan with the fewest `insertBefore` moves. An unchanged width, state and visible set returns before any write; a changed input with the same plan skips the writes. Rule placement uses the authored divider before a control's group; unused dividers are detached and restored by the disposer. Row two gets `hidden` when the plan has one row, the toolbar gets `vmde-toolbar--two-rows` when it has two. `flowToolbarOnce` is the shared one-shot pass for the overlay copy. The S1b functions are wired: `applyToolbarTips` once at install, `applyToolbarTipDirections` after every changed input, `title` set and removed in `setOverflowRow`.
- `toolbar-layout.ts` authors everything into row one (row two empty and hidden); `toolbar-collapse.ts` sets the toggle's tip per state, and a host collapse moves focus to the toggle only from row two; `prerender-overlay.ts` runs `flowToolbarOnce` on the clone; `html-builder.ts` sizes the expanded placeholder 61 px (two rows) with a `min-width: 1076px` media rule lowering it to 35 px, collapsed stays 24 px (heights without the 1 px toolbar border, i.e. 62 and 36 in all).
- Panels opened from inside More: Vditor's Headings and the Emoji picker first hide every hint, More included, and Vditor closes More on any click that bubbles to its panel. While such a control is in More its trigger click stops at the trigger and an observer shows More again when a nested panel opens in the same batch (and closes the nested panels when More alone is hidden).
- CSS (`vscode-chrome.css`): `[hidden]` row, collapsed rule hides only row two, toggle at the top of row one with a 12 px gap, every collapsed button 17.5 × 24 px (11.2 px icon, scaled rules), two-row band gap (1.2 px borders, 4.8 px shorter buttons, rule margins), toggle tooltip margin.
- Measured (Chromium harness, 1,400 px unless noted): one row 36 px, two rows 61.4 px, collapsed 25 px; row heights 30.2 px each; toggle 17.5 × 24 px at y 1 in both states, x equal; band gap 2.0 px (the 1.2 px border paints as 1 px at device ratio 1; target 2.4 ± 1); gap before the toggle 12 px. One-row thresholds, viewport width: expanded 1,143 px with wiki and 1,076 px without; collapsed 857 px with wiki and 808 px without.
- Tests: Vitest `toolbar-layout`, `toolbar-overflow`, `toolbar-collapse`, `prerender-overlay`, `html-builder`; Chromium `toolbar-overflow.spec.ts` (55 tests: fixed-row assertions moved to the flow; new cases for A2 prefix and maximality, A3 collapsed and More, A4 collapsed button size and action, A5 resize and Source round trip, A6 band gap in IR, WYSIWYG and SV, A7 toggle box, A8 gap, A9 and A13 icons, A10 descriptions, hover, focus and viewport edges, A11 and A12 labels, Math rows and Settings, A14 traversal, panels opened from More).
- Not verifiable as stated: acceptance A9 says the Preview icon shows in More, but the tail (Preview, Edit Mode, More) never moves into More, so Preview is checked in the row only.
- Residual risk: the placeholder's one-row width threshold is the no-wiki value (1,076 px); a wiki document between 1,076 and 1,143 px paints a one-row placeholder and then a two-row toolbar.
