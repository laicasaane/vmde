# Task 642 — Responsive toolbar flow, collapsed-row buttons, Preview placement and tooltips

**Status:** open.
**Origin:** Project Owner feature request.
**Severity:** feature (low to medium risk; toolbar chrome and one persisted preference).
**Tech stack:** TypeScript webview (`media-src/src/chrome/toolbar.ts`, `toolbar-collapse.ts`, `toolbar-layout.ts`, `toolbar-overflow.ts`, `util/lang.ts`), toolbar CSS, extension host (`globalState`), Vitest, Chromium, real VS Code.
**Related:** [Task 644](644-insert-id-html-id-targets.md) (Insert ID writes and resolves `id` targets), [Task 643](643-preview-mode-streaming-performance.md) (Preview streaming and performance).
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
12. **Preview is the fourth mode, with its own toggle.** Preview sits beside the three edit modes (WYSIWYG, Instant Rendering, Split) but is switched by the Preview toggle, not by the Edit Mode menu. Whether Preview is on is kept across VS Code sessions and is shared by every file.
    - When Preview is turned on, every document opened after that opens in Preview, unless a path rule (`vmde.editor.defaultModeByGlob`) or an explicit `vmde.editor.defaultMode` value (`ir`, `wysiwyg`, `sv` or `preview`) chooses its mode. Path rules and the setting keep supporting `preview`.
    - When Preview is turned off, the editor returns to the stored edit mode (WYSIWYG, Instant Rendering or Split), and documents opened after that open in that edit mode.
    - Turning Preview on or off changes only the editor where it is toggled; other open editors keep their state until they are reopened.
    - Large documents open in Preview too. Streaming them into Preview, as the edit modes stream today, is [Task 643](643-preview-mode-streaming-performance.md); until it lands, a document over the streaming threshold (700,000 characters) opens in Preview after it has finished streaming into its edit mode.

### Wiki Pages icon

13. The Wiki Pages control uses a standard icon with the letter "W". Today it uses the codicon `book` (`wikiPagesIcon` in `media-src/src/chrome/toolbar-icons.ts`), an open book drawn as two panels, which reads as split view.

### Insert anchor name

14. The More item "Insert anchor" is renamed **Insert ID**, in its menu label, tooltip, dialog title and command title. What it inserts changes to an `id` target in [Task 644](644-insert-id-html-id-targets.md).

### Tooltips and More menu items

15. Every toolbar button and every More menu item has a short tooltip that says what it does, not only its name. Tooltips show no key, because an extension cannot read the user's rebindings.
16. Every More menu item shows its name next to its icon, never an icon alone. This includes controls that overflow into More from the toolbar.
17. The Settings item in More shows the cog icon (the codicon `settings-gear`, as on the editor title bar) next to its name.

## Open design points (settled in Part 1)

- How Preview combines with Split, which has its own preview pane.
- What happens when the second expanded row is also full. Proposed: the remaining controls move into More, with Preview, Edit Mode and More kept as the last three controls.
- Whether a separator may end a row.
- The width of the gap before the toggle.
- How tooltips are shown for More items, whose `tip` text is also their menu label.
- Which other More items have no icon today (they render as text only) and whether each needs one to meet requirement 16; any icon added for them goes to the Owner first.
- The Preview icon source (document with an eye): an existing codicon if one fits, otherwise a 16×16 `currentColor` SVG with a compatible license, recorded with its provenance.
- The "W" icon source: a 16×16 `currentColor` SVG with a license compatible with the extension (a plain letter glyph, not a third-party brand logo such as Wikipedia's), recorded with its provenance.
- Which collapsed-row controls are shown, and the strip height (Task 631 set the toggle to 17.5×24 px with an 11.2 px icon and the strip to 25 px).

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

- In: control order and flow, row gap, collapsed-row buttons, toggle position, separation gap and tooltip, Preview placement and remembered state, the Wiki Pages and Preview icons, tooltips for toolbar buttons and More items, More item labels, keyboard traversal and overflow for the new layout.
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
- [ ] With Preview on, documents opened afterwards (also after a VS Code restart) open in Preview; with Preview off, they open in the stored edit mode, and the toggled editor returns to that mode; other open editors are unchanged; documents over the streaming threshold also end in Preview; no edit, dirty state or Undo step results.
- [ ] Every toolbar button, More item and the toggle has a non-empty descriptive tooltip; no tooltip shows a key.
- [ ] Every More item, including overflowed controls, shows a visible text label beside its icon, in both toolbar states.
- [ ] The Settings item in More shows the cog icon beside its name and still opens the VMDE settings.
- [ ] The Wiki Pages control shows a "W" icon at the same size as the other toolbar icons, in the toolbar and in More, and still lists the wiki pages.
- [ ] Keyboard traversal follows the visual order in both states.
- [ ] Focused Vitest, Chromium and real-VS-Code specs are written and run; network-free gates pass at closure.

## Tests

- Vitest: control sequence and Preview position, flow planning at given widths (expanded and collapsed, Preview, Edit Mode and More as the last three), tooltip text for every item, Preview preference message shape and host storage.
- Chromium: flow at several widths and after resize, row gap, toggle box in both states, separation gap, collapsed-row button sizes and actions, overflow into More with a visible label for each item, keyboard order.
- Real VS Code (`test/vscode-e2e/`): extend the `toolbar-collapse` and `toolbar-order` specs (flow at two widths, resize, toggle position); Preview state across a restart (own-launch pattern from Task 631) and across two files.
