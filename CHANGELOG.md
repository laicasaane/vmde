# Changelog

All notable changes to this extension are documented here.

Format based on [Keep a Changelog](https://keepachangelog.com/), versions follow [SemVer](https://semver.org/).

## [1.4.0] — 2026-09-04

<!-- brand-check: former-brand-explanation-start -->

### Breaking identity change

- Install VMDE (`Laicasaane.vmde`) separately from `spiochacz.vmarkd` and select it again as your Markdown editor.
- Settings and commands now use `vmde.`, and the editor ID is `vmde.editor`. Reapply custom settings and keybindings. Saved extension state does not migrate.

<!-- brand-check: former-brand-explanation-end -->

### Added

- In edit modes, `vmde.find` and `vmde.findReplace` search Markdown. In full Preview, Find searches rendered text.
- Find highlights are customizable. Close Find in an edit mode to select the current match.
- Rewrap a paragraph, a selection or the whole document, or enable `vmde.editor.autoWrap` to wrap prose after a typing pause.
- Promote or demote a heading on its own or with its entire section.
- Expand a text selection to its block or the whole document and use selection commands from the editor context menu.
- Enable `[toc]`, `==mark==` and super/subscript syntax, or edit HTML `<sub>`, `<sup>` and `<ins>` without losing the tags.
- Instant Rendering (IR) and WYSIWYG renumber ordered lists after edits and moves, keeping the starting number. Split offers manual renumbering.
- The Math menu inserts GitHub-style inline and fenced math, including around a selection in Split’s source pane.
- Enable `vmde.github.colorLiterals` to preview HEX, RGB and HSL colors beside their text.
- Search Emoji 17.0 by name or browse by category, choose a variant and reuse recent selections.
- Preview sanitized inline SVG data images and insert `<picture>` elements with local or HTTPS raster images.
- Move table rows and columns, and copy or clear a range of cells.
- Table columns fit their contents. Drag a column edge in IR or WYSIWYG to set its width until the file reopens.
- Toggle tasks in Preview or Split’s preview pane with one Undo per checkbox (`vmde.preview.interactiveCheckboxes`, on by default).
- Fold headings and lists from their gutter controls in IR, WYSIWYG or full Preview. Each file remembers its folds across these views.
- Full Preview shows Git change bars beside modified blocks.
- Hoist a section to read it on its own, reorder sections from the Outline, or move blocks and list items by their handles.
- Hover for full Outline headings and link or image destinations. Titled WYSIWYG links and images show their title.
- Format selections, add links or wiki links, or use Turn Into from the floating toolbar. Turn Into also works in Split’s source pane.
- The IR popover lets you open, copy or edit a link or image URL, or unlink it, even just after typing.
- Wrap or unwrap selected blocks in `<details>` and expand or collapse them while editing.
- Add, retitle, change or remove callouts in IR, WYSIWYG and Split, with one Undo per change.
- Zoomable diagrams have pan, zoom, reset and full-screen controls. Press `0` to reset a focused mindmap.
- Mermaid shows errors at the diagram and warns when it falls back to another layout or class-diagram labels overlap.
- Wiki completion remembers pages across restarts and updates live for `vmde.wiki.root`, `vmde.wiki.enabled` and exclusions in `vmde.wiki.exclude`.
- Wiki links and completion recognize front-matter aliases. A matching filename takes priority.
- Copy cells or fold the YAML properties table. In IR and WYSIWYG, edit, add, remove or reorder properties with one Undo per change.
- Set the properties font with `vmde.editor.frontMatterFontFamily` and `vmde.editor.frontMatterFontSize`, or start the table folded with `vmde.editor.frontMatterFolded`.
- Indent rendered sections by heading depth with `vmde.editor.sectionIndent` and choose the step with `vmde.editor.sectionIndentSize`.
- Rendered links are underlined, including HTML links. `vmde.markdown.autolinkBareUrls` turns bare URLs and email addresses into links.
- Long paths and identifiers wrap at punctuation and word boundaries. `vmde.editor.wrapHints.minLastPiece` keeps short endings together.
- Open text files at `file.ts:42:5`. In Markdown, `#L42-L50` selects the lines in IR, WYSIWYG and Split, and reveals the start in Preview.
- Set Split’s source font and background with `vmde.editor.sourceFontFamily`, `vmde.editor.sourceFontSize` and `vmde.editor.sourceBackground`.
- Configure Split’s line numbers and active line with `vmde.editor.sourceLineNumbers`, `vmde.editor.sourceHighlightCurrentLine` and `vmde.editor.sourceCurrentLineBackground`.
- Set the distance between Split’s source and preview panes with `vmde.editor.splitGap`.

### Changed

- Most default shortcuts now match VS Code. Bold and Italic keep their usual keys. Restore a removed binding such as Rewrap’s `Alt+Q` in Keyboard Shortcuts.
- IR handles Undo and Redo on keypress by default, so a character typed immediately after Undo is kept.
- Rebind IR Undo and Redo with `vmde.editor.undoRedoKeys.undo` and `vmde.editor.undoRedoKeys.redo`.
- Turn off `vmde.editor.undoRedoKeys.inEditor` to use VS Code’s Undo and Redo keybindings in IR. WYSIWYG and Source always use them.
- The toolbar (`vmde.editor.toolbar`) moves controls into More as space narrows and remembers when you collapse it to one row.
- Toolbar and Outline tooltips follow VS Code’s appearance. `vmde.editor.tooltipFontSize` sets their size.
- Preview remembers your preference unless a path rule or `vmde.editor.defaultMode` overrides it. Reopening a file restores your reading position.
- The Outline remembers its width and visibility across restarts and honors changes to `vmde.outline.defaultOpen`.
- Large files open faster. Full Preview streams long documents and loads diagrams near the viewport.
- Typing, selecting text and undoing edits in large, table-heavy IR documents are more responsive.
- With `vmde.image.saveFolder` set to `assets`, uploads follow `markdown.copyFiles.destination`. Dropped documents become Markdown links.
- With `vmde.theme.content` set to `auto`, VMDE pairs Modern and GitHub themes and uses `markdown.preview.fontFamily` on the fallback theme.
- Screen readers announce editor status and identify editing surfaces. The editor respects reduced motion and shows controls and diagrams in high contrast.
- Insert ID creates an HTML `id` and rejects duplicate names. Links to IDs and older `<a name>` targets work across files.

### Fixed

- In IR, one Undo after Replace or Replace All restores the exact Markdown, and Redo reapplies the replacement.
- Typing after an external file change preserves the newer file contents. VMDE warns if an edit was based on an older version.
- If VS Code refuses an IR replacement Undo or Redo, typing that could not be applied appears in a separate Recovered edits document.
- Undo works immediately after the first edit, restores the caret and clears the modified indicator when you return to the saved text.
- Undo in Find, Replace and popover text fields stays in the field. View-only toolbar buttons no longer add a document Undo step.
- Toolbar actions use the current selection. Link also works when the editor displays the surrounding Markdown differently from its source.
- After typing, moving a block, applying a callout or wrapping a selection in Details preserves the surrounding Markdown.
- In Split, Format Table and list renumbering preserve surrounding text after a mode switch. Format Table also works in empty or padded cells.
- Rewrap and heading changes preserve YAML front matter and its separator. Rewrap Document keeps the caret in place.
- Select All stays selected in IR. Deleting or typing over a selection in IR or Split removes only the selected text.
- With no selection, Copy and Cut act on the current line, including in Split’s source pane.
- IR arrow keys step through formatting markers. Home and End reach the visible line boundaries, and page keys move past inline code.
- In IR, typing after Enter stays in the new paragraph or code line. Press Enter twice in the last list item to continue below the list.
- In IR, the caret stays at the end of pasted inline text, even when you paste immediately after typing.
- Canceling input-method composition leaves the document and its modified state unchanged.
- The IR code-copy button copies the code without moving the caret or expanding the block.
- Links open after their IR markers expand, and modifier-click follows inline and reference links from Split’s source pane.
- Text such as `[[page]]` inside inline code stays literal when you edit a list elsewhere.
- Split keeps its panes on the same section, and leaving Preview restores the editing selection.
- Replacing an image on disk refreshes it in the editor, including images referenced through Markdown definitions.
- Opening a table with `|` inside an inline code span keeps the span in one cell. Editing elsewhere preserves the rest of the row.
- Wide tables fit Preview, and oversized math and HTML scroll within their blocks.
- Shift+Arrow extends text selections inside table cells. At a cell edge it can select adjacent cells.
- Escape returns focus from the IR callout menu, and the WYSIWYG heading popover closes when the caret leaves its heading.
- WaveDrom follows the content theme in Preview, Mermaid C4 labels stay legible and D2 labels keep their layout.

### Security

- Mermaid 11.17.2 and KaTeX 0.18.11 fix security issues in diagram and math rendering.
- Markmap 0.18.12 uses markdown-it 14.3.3 and linkify-it 5.0.2 to prevent excessive processing of long links.
- DOMPurify 3.4.17 fixes cross-site scripting vulnerabilities in rendered content.

### Known limitations

- The keyboard route from the editor through the toolbar stops before the in-editor Outline.
- Editing in Split’s source pane can change a `---` thematic break to `***` when saved.
- In WYSIWYG, the heading popover can cover the next line while the caret is in the heading.
- Saving an ordinary body edit in WYSIWYG can remove the blank line after YAML front matter.
- On large documents, some edits, Undo and Select All can still take longer than 50 ms.
- In IR, a second Undo can be refused while a replacement Undo or Redo is still running.
- Undoing an older replacement can take longer when VMDE has to restore the whole document.

<!-- brand-check: former-brand-explanation-start -->

## [1.3.0] — 2026-08-01

### Added

- **A caret position between blocks that touch**: you can now put the cursor in the gap between
  any two blocks that leave no room for one — between a horizontal rule and a code block or front
  matter, between two rules, or above a document that starts with a table, a diagram or a fence.
  Arrow keys stop there on the way past, and clicking the strip between two rendered blocks lands
  there directly. The line is transient: type and it becomes a real paragraph, leave it empty and
  it disappears behind you, so the saved markdown is untouched if you were only passing through.
  Previously those slots were unreachable by any means — there was no way to write anything there
  at all.
- **Renumber ordered lists**: two commands in the Command Palette — **vMarkd: Fix List Numbering**
  renumbers the list the caret is in, **vMarkd: Renormalize All Lists** does the whole document —
  so a list that drifted (`1.` `1.` `1.`, or `3.` `7.` `12.` after edits) becomes a clean sequence.
  They work in IR and WYSIWYG modes and do nothing in Split (source) view yet.
- **The toolbar collapses instead of clipping**: when the window is too narrow for every button,
  the ones that no longer fit move into the **More** menu at the end of the toolbar rather than
  being cut off.
- **You can leave the editor with the keyboard**: press Escape, then Tab, and focus moves to
  the toolbar instead of inserting a tab character — the toolbar is a proper ARIA toolbar you
  traverse with the arrow keys, and Escape brings you back to exactly the position you were
  editing. Ordinary Tab still indents, and Ctrl+Tab still belongs to VS Code. Previously the
  editor was a keyboard trap: nothing but the mouse could get focus out of it (WCAG 2.1.2).
- **Links from a URL, without typing the brackets**: selecting a URL and clicking the
  toolbar's link button now makes it both the link text and the destination
  (`[https://example.com](https://example.com)`) instead of leaving the destination as a
  `https://` placeholder, and pasting a URL creates the link for you — over a selection the
  selection becomes the link text, with nothing selected the URL becomes both halves. Only
  real URLs (`http(s)://`, `mailto:`, a bare `www.` host) are recognised, pasting inside code
  stays literal, and one undo takes the whole thing back. Switch the paste
  behaviour off with `vmarkd.paste.urlAsLink`.
- **Callouts / GitHub Alerts**: `> [!NOTE]` / `[!TIP]` / `[!IMPORTANT]` / `[!WARNING]` /
  `[!CAUTION]` blockquotes render as styled callout boxes with per-type accents and
  icons — GitHub- and Obsidian-compatible (Obsidian's `> [!note]-`/`+` fold suffix is
  accepted and rendered as a normal callout). When the caret is outside, the callout
  shows its rendered preview; placing the caret inside reveals the raw markdown for
  editing. Display-only and round-trip safe — the saved markdown is untouched. In WYSIWYG
  mode the callout shows a styled title, and you pick its type — plus an optional custom
  title — from a dropdown in the block's native popover, the way you set a code block's
  language.
- **ECharts chart themes** (`vmarkd.diagram.echarts.theme`): `auto` (default) pairs ` ```echarts `
  charts with the rendering theme's palette (the same pairing mermaid uses), or pick an
  explicit look — light, dark, the ECharts gallery themes (vintage, macarons,
  infographic, roma, shine, tech-blue) or vintage-dark. Charts re-theme live when the
  theme changes.
- **VS Code mermaid palettes**: `vmarkd.diagram.mermaid.theme` adds `vscode-light-2026` and
  `vscode-dark-2026`, and `auto` pairs them with the matching VS Code 2026 rendering
  theme — so ` ```mermaid ` diagrams match VS Code's own colours.
- **ELK layout for Mermaid graph diagrams** (`vmarkd.diagram.mermaid.layout`): set it to
  `elk` to lay ` ```mermaid ` graph diagrams (flowchart, class, state, ER) out with the
  Eclipse Layout Kernel — tighter graphs and orthogonal edge routing — instead of the
  default `dagre`. Runs fully offline on the main thread (no web worker), and shares the
  same ELK engine already bundled for D2 so it adds no extra download; a per-diagram
  `%%{init: {"layout":"elk"}}%%` directive works too. Non-graph diagrams (sequence, gantt,
  pie, …) keep their own fixed layout and are unaffected.
- **PlantUML standard-library icons work offline**: ` ```plantuml ` blocks that pull the
  standard library — `!include <C4/C4_Container>`, `!include <awslib/Compute/EC2>`,
  `!include <azure/…>`, plus `k8s`, `eip`, `edgy`, `DomainStory`, `cloudogu`,
  `cloudinsight` and `kubernetes` — now render fully offline, where before they failed
  with a "Fatal parsing error" (the bundled engine ships no standard library). The
  referenced icon/library files are bundled and loaded on demand — only the libraries a
  diagram actually uses are fetched, so a plain PlantUML diagram pays nothing. Remote
  `!includeurl https://…` includes stay disabled offline (they're skipped with a note).
- **Hand-drawn "sketch" look for D2 diagrams** (`vmarkd.diagram.d2.sketch`): turn it on to
  draw ` ```d2 ` shapes and connections with wobbly strokes and hachure fills — the
  hand-drawn style of `d2 --sketch`. The diagram's colours still follow the D2 color
  theme; only the drawing style changes, and the look is stable (it doesn't reshuffle on
  scroll or theme switch). Toggling the setting re-draws open diagrams live. Runs fully
  offline and only loads when a ` ```d2 ` block is on screen.
- **Flowchart diagrams follow the theme**: ` ```flowchart ` (flowchart.js) diagrams draw
  in the rendering theme's text colour with transparent boxes — instead of fixed black,
  which was invisible on dark themes — and re-draw when you switch themes.
- **HTML comments visible in the editor**: `<!-- … -->` blocks show their content as
  muted italic text in IR, WYSIWYG and the full Preview — so you can see comments
  without clicking into them. Placing the caret inside reveals the raw markdown for
  editing, without a code-panel background.
- **Live code highlighting while editing (WYSIWYG)**: code inside a fenced block is
  syntax-coloured as you type in WYSIWYG mode — full colour, bold and italic from the
  highlight.js theme — instead of plain monospace text.
- **Scroll position preserved across Edit ⇄ Preview**: switching between the editor
  (IR/WYSIWYG) and the full Preview keeps your place in the document, in both directions
  — anchored on the nearest block, so you no longer land mid-section or at the top.

### Changed

- **Clearer toolbar labels**: `Line` is now `Horizontal Rule` and `Order List` is `Numbered List`
  (they name what the button inserts), the icons are a uniform size, and the Redo tooltip
  advertises the Shift+Ctrl/Cmd+Z shortcut that already worked. The labels are also what a screen
  reader announces. Toolbar strings are translated where a translation exists, falling back to
  English otherwise.
- **Settings renamed and regrouped** — **action required if you had vMarkd settings**: the Settings
  UI now has one section per namespace — **Editor** (including the paste options), **Themes** (the
  document content and code themes only), **Diagrams** (every per-engine option grouped by engine),
  Custom CSS, Outline, Image, Wiki and **Performance**. Seventeen keys were renamed to match:
  `slugifyMode` → `vmarkd.editor.slugifyMode`, `paste.csvAsTable` → `paste.csvFormat` (it is a
  format, not a switch), `editor.pasteUrlAsLink` → `paste.urlAsLink`, `theme.highlightHeadings` →
  `editor.headingColors`, `image.allowRemoteImages` → `image.allowRemote`, `outline.openByDefault` →
  `outline.defaultOpen`, `outline.treeView` → `outline.tree`, `editor.linkOpenWithModifier` →
  `editor.modifierClickLinks`, `advanced.*` → `performance.*`, and every diagram option to
  `diagram.<engine>.<option>` (`diagram.d2.layout`, `diagram.d2.theme`, `diagram.d2.sketch`,
  `diagram.mermaid.layout`, `diagram.mermaid.theme`, `diagram.echarts.theme`, `diagram.geo.basemap`).
  The old names are **no longer read** — a value left under an old key stops taking effect, and VS
  Code marks it as an unknown setting in `settings.json`. Re-set anything you had customised under
  its new name; defaults are unchanged, so if you never touched these there is nothing to do.
- **Page margins match VS Code's built-in markdown preview**: the editor now uses the
  full window width with the same 52px side margins as the native preview, on every
  surface (edit panes, Preview, toolbar). Showing or hiding the left-gutter markers
  (`H1`…`H6`, `↩`, footnotes, ToC) no longer moves the text — the markers sit inside that
  margin. The one setting that changes the margin is `vmarkd.editor.fullWidth: false`,
  which centres a narrower 800px reading column; full width is now the default.
- **Diagrams adapt to the editor width**: mermaid, ECharts charts, mindmaps, markmap,
  Graphviz, abc music notation and SMILES chemical structures scale to fit the rendering
  column — in the editor (IR/WYSIWYG) and the full Preview — and shrink as you narrow the
  window, instead of overflowing the column or staying a fixed size. markmap tracks the
  window smoothly as you drag, rather than snapping once you stop. Wide-by-nature
  diagrams (mermaid, Graphviz) keep their natural size when there's room rather than being
  stretched. Mindmaps size to their content (no large empty margins around a small tree),
  and both ECharts charts and mindmaps render without an entry animation. Editing a chart
  or mindmap's source shows an edit field sized to the code, not to the diagram's render
  box. SMILES structures also render in WYSIWYG mode (not just the Preview/IR surfaces),
  sit directly on the page background, and follow the theme — the molecule is drawn in a
  light or dark palette to match the rendered background and re-draws when you switch
  themes.
- **VS Code rendering themes are now "2026"**: the `vmarkd.theme.content` values
  `vscode-light-modern` / `vscode-dark-modern` become `vscode-light-2026` /
  `vscode-dark-2026`, retargeted to VS Code 1.123's default "Light/Dark 2026" palette so
  the rendered Markdown mirrors VS Code's own preview (background, text, links, inline
  code, blockquotes, tables, horizontal rules). Update the setting if you pinned the old
  value.
- Bundled **ECharts upgraded 5.5.1 → 6.1.0** (the version Vditor ships is pinned at
  5.5.1; vMarkd vendors the newer build), picking up upstream chart fixes and renderers.
- **Editing a code block looks exactly like its render**: the editable source carries
  the same highlight.js theme styling (font size, padding, background panel) as the
  rendered block on every theme — no size or colour shift when entering or leaving
  edit, and no preview flash when clicking inside the block.
- **Seamless open**: the instant preview hands off to the live editor without a visible
  jump or colour flash — code blocks hold their height and colours through
  highlight.js loading, and the rendering theme applies from the very first paint.
- **Arrow-key navigation between adjacent blocks** (code↔code, quote↔code) no longer
  scatters blank lines through the document (a Vditor quirk): the in-between paragraph
  appears when you arrow into the gap — type to keep it, move on and it cleans itself
  up.
- Settings: all theme settings now live in a dedicated **Themes** group, with the
  rendering theme (`vmarkd.theme.content`) first — it drives the code, mermaid and
  echarts pairings.

### Fixed

- **The document no longer sits flush against the top edge in full width.** Full-width mode (the
  default) drew the first line hard against the top of the pane, while the narrow reading column
  had its usual breathing room; both surfaces — the editor and the Preview — now have the same
  10px above the first block.
- **Two D2 connections no longer end up drawn as one thick line.** The layout post-processing could
  straighten a connection until it ran alongside another one about 11 px away — parallel, not
  touching, and unreadable as two lines. Routes now keep the same lane the layout engine reserves
  (24 px), and where a diagram cannot give one, the line stays where it was rather than being moved
  into something else.
- **D2 labels break on `\n` again.** A label written as `"Dedicated mailbox\nExchange Online"`
  was drawn as one long line — wider than the shape it sits in, so the text spilled out of the
  box — instead of one row per line the way the `d2` CLI draws it. Node labels, container and
  grid headers, connection labels and `sql_table` / `class` titles all break on the newline now,
  and the taller title band is reserved for them.
- **Selecting text in the split-view preview pane and copying it now works.** Clicking the
  rendered pane made the editor look unfocused, so the editor's caret was restored on top of
  it — a fraction of a second later that restore wiped out whatever you had just selected, and
  Ctrl+C copied the wrong text.
- **Lists no longer reformat themselves while you edit them.** Deleting a nested bullet
  with Backspace merged it into its parent but left the text block-wrapped, so the whole
  list silently switched to the "loose" form — a blank line appeared under the parent item
  and the file was rewritten in lines you never touched. Lists you wrote loose on purpose
  are left alone.
- **Pasting over a selection now replaces exactly the selection.** It used to insert the
  pasted text before the selected text and eat the selection's last character (VS Code's
  clipboard bridge made the delete step re-entrant, and the old workaround retried it too
  late, against a selection that had already moved).
- **Cutting a selected multi-line paragraph no longer leaves part of it behind.** Ctrl+X on a
  real selection used to remove most of it but leave its last line in the document (the same
  re-entrant clipboard-bridge issue as the paste fix above). Cutting now removes exactly the
  selection, one Ctrl+Z restores it in full, and the clipboard is correct — including a
  selection that spans several paragraphs, where the two remaining halves now correctly join
  back into one paragraph instead of being left with a stray blank line between them.

## [1.2.0]

### Added

- **Mermaid diagram themes** (`vmarkd.diagram.mermaid.theme`): 15 named palettes (GitHub
  light/dark, Dracula, Nord, Tokyo Night, Catppuccin, Solarized, One Dark, Zinc, …)
  rendered via mermaid's customisable base theme, alongside mermaid's built-ins. `auto`
  pairs the palette to your rendering theme (`vmarkd.theme.content`) — GitHub → GitHub,
  Material Dark → One Dark, VS Code Light/Dark Modern → Zinc light/dark — and an explicit
  palette still wins. Diagrams re-theme live when you switch the rendering theme, not just
  the VS Code light/dark theme. Palette colours from
  [Beautiful Mermaid](https://github.com/lukilabs/beautiful-mermaid) (MIT).

### Changed

- Bundled **Mermaid upgraded 11.6.0 → 11.15.0** (the version Vditor ships is pinned at
  11.6.0; vMarkd vendors the newer same-major build), picking up upstream diagram fixes
  and rendering improvements.

## [1.1.0]

### Added

- Markdown **rendering themes** (`vmarkd.theme.content`): `auto` follows your VS Code
  theme's colours, or pick a fixed look that restyles the rendered markdown
  (background, headings, blockquotes, tables, code, scrollbars) regardless of the
  editor theme — **GitHub** light/dark, **Material Dark** (One Dark), and **VS Code
  Light/Dark Modern**. Replaces the old `vmarkd.theme.useVscodeColors` toggle.
- Code-block syntax highlighting **pairs automatically** with the chosen rendering
  theme when `vmarkd.theme.code` is `auto` (e.g. Material Dark → atom-one-dark, VS
  Code Dark Modern → vs2015); an explicit `vmarkd.theme.code` still wins.
- The editor **font size** follows GitHub's 16px reading size under a GitHub theme by
  default, and still honours an explicit `vmarkd.editor.fontSize`.

## [1.0.0]

### Added

- Search in the editor with `Ctrl/Cmd+F`.
- Outline panel: navigate by heading with click-to-flash, a configurable width and
  side (`vmarkd.outline.position`), open-by-default, and a heading-markers toggle.
- Markdown Outline in the Explorer sidebar: a clickable heading tree for the open
  file with click-to-scroll (`vmarkd.outline.tree`), separate from the in-editor
  outline panel above.
- Wiki-style `[[page]]` links: rendered as clickable chips that navigate
  (Ctrl/Cmd+click, or a plain click in preview) and offer to create the page when
  it's missing. Typing `[[` opens an autocomplete list of workspace pages by their
  original-case name (path-qualified when names collide). Enable and scope it with
  `vmarkd.wiki.enabled` / `vmarkd.wiki.root`.
- Reveal-in-source: "Open source to the side" and the toolbar "open in VS Code"
  button jump to the cursor's line in the text editor.
- Git change bars (added/modified vs the last commit) in the editor gutter.
- Status bar: estimated reading time, live word count, a WYSIWYG/Source indicator,
  and a "Large md" marker for large documents.
- Open the visual editor to the side, reusing an existing vMarkd tab instead of
  opening duplicates.
- External CSS files with live reload; `vmarkd.css.custom` is applied last so it wins.
- Live theme switching (follows your VS Code colour theme) and live settings reload
  (changes apply without reopening the editor).
- Rename tracking — the editor follows files renamed or moved in the workspace.
- Undo/redo with `Ctrl/Cmd+Z` / `Ctrl+Shift+Z` / `Ctrl+Y`.
- Appearance settings: highlight headings, heading-level markers, code-block line
  numbers, Mermaid theme, toolbar visibility, and a font size that follows VS Code's
  editor size by default.
- `vmarkd.theme.code` setting — pick the code-block highlight theme (73 highlight.js
  styles); `auto` follows your light/dark theme. Applies live.
- A Markdown icon on the editor tab; supported in untrusted and virtual workspaces.
- Opt-in editor for Markdown files: it never takes over `.md` files automatically —
  you choose when to use it.
- Configurable link-open behaviour (`vmarkd.editor.modifierClickLinks`): by
  default Ctrl/Cmd+click opens a link and a plain click edits it (in every editor
  mode).
- Image upload: images pasted or dropped into the editor are saved into the
  workspace (folder set by `vmarkd.image.saveFolder`, e.g. `${projectRoot}/assets`)
  and can be auto-converted to WebP and downscaled to a max width
  (`vmarkd.image.format` / `vmarkd.image.quality` / `vmarkd.image.maxWidth`).
- About dialogs (in English) for vMarkd and the bundled Vditor, showing engine
  versions.
- Native VS Code codicon icons throughout — the title-bar buttons and the in-editor
  toolbar.
- Heading-anchored scroll sync in Split view: the section centred in the source pane
  stays aligned with the same section in the rendered pane.
- Tab indents inside code blocks.
- Copy as HTML / Markdown through the host clipboard.

### Changed

- Removed Vditor's preview action bar (the Desktop/Tablet/Mobile width switch and
  the WeChat/Zhihu copy buttons) — irrelevant in a VS Code editor.
- Removed both theme pickers from the toolbar's "more" menu: VS Code manages the UI
  theme, and the code-block highlight theme is now the `vmarkd.theme.code` setting.
- Requires VS Code 1.110 or newer.

### Fixed

- Source Control diffs open as a normal text diff instead of the visual editor.
- The table editing panel floats over the content (no blank gap under the cursor)
  and opens at the clicked cell.
- Mermaid diagrams re-theme live when you change `vmarkd.diagram.mermaid.theme`, keeping
  your scroll position.
- Toolbar clicks keep the document scroll position, even when nothing is focused.
- Cursor and scroll position are kept when the underlying file changes on disk
  while you're editing.
- Editing one section leaves the rest of the document's formatting byte-for-byte
  unchanged — no stray whitespace or line-break churn elsewhere.
- Tables stay intact: a `|` inside inline math or code doesn't break the row, and
  editing one cell doesn't reformat the others.
- Ctrl/Cmd+S always saves the latest content, even right after a fast edit.
- Pasting code-like text is recognised and wrapped in a code block.
- A malformed math (KaTeX) formula shows an inline error instead of breaking the
  rendered document.
- Toggling a task-list checkbox no longer crashes the editor.

### Security

- Hardened webview: sandboxed with a strict Content-Security-Policy and minimal
  privileges, custom CSS is sanitised, and file access is scoped to the workspace.
- Remote images are off by default (`vmarkd.image.allowRemote`) to prevent
  tracking or data exfiltration through external image URLs.
- Supply chain: bumped `esbuild` (0.21 → 0.28) to clear a dev-server advisory, and
  CI fails the build on moderate-or-higher dependency vulnerabilities (`npm audit`).

### Performance

- Instant preview on open: the document appears immediately as a read-only preview,
  then swaps to the live editor seamlessly. Toggle with `vmarkd.advanced.instantPreview`.
- Large documents stay responsive while editing — only the section you change is
  reprocessed, not the whole file.
- Stream very large files (~700 KB+) into the editor in chunks for a responsive
  open; read-only with a spinner while it fills in. Auto-activates by size; toggle
  with `vmarkd.performance.streamLargeFiles`.
- Free memory from hidden editor tabs with `vmarkd.advanced.retainHidden`.
- Smaller package and faster startup: dropped unused MathJax (~6.5 MB; math uses
  KaTeX) and narrowed activation.

### Engine & build

- Built on Vditor 3.11.2.
- Lute markdown engine vendored and pinned at an explicit commit — ahead of the
  version Vditor bundles.
- Built with `node build.mjs` (plain Node ESM, npm).
- Vditor is tree-shaken from source — webview bundle ~310 → 261 KB.
- Dependency bumps: TypeScript 5.9, `@types/node` 22, Vitest 4.1.8; requires
  Node ≥ 22 (`.nvmrc`).

### Tests

- Backend/host logic and pure webview helpers are unit-tested with Vitest.
- A Playwright end-to-end harness exercises webview behaviour (table-editing
  hotkeys, outline, wiki links, and more) in a real browser.
- Tests drive the editor with native `KeyboardEvent` dispatch.

### Removed

- Runtime dependencies: jQuery, jquery-confirm, lodash, date-fns,
  `@testing-library/user-event`, `@testing-library/dom`, `@babel/runtime-corejs3`.
- Build tooling: `foy`, `ts-node`.
- Dead dependencies: `sharp` and the `media-src` TypeScript dev-dependency.

<!-- brand-check: former-brand-explanation-end -->
