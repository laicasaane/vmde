# Changelog

All notable changes to this extension are documented here.

Format based on [Keep a Changelog](https://keepachangelog.com/), versions follow [SemVer](https://semver.org/).

## [1.4.0] — 2026-09-04

This release establishes VMDE as an independently published VS Code extension and combines the
editing, navigation, performance, accessibility, renderer, security, and release-engineering work
completed on `dev` since 1.3.0.

<!-- brand-check: former-brand-explanation-start -->

### Breaking identity change

- The public product name is now **VMDE**. The extension display name, command categories, custom
  editor label, status and output channels, webview title, documentation, and support text use that
  name consistently.
- The extension now installs as `laicasaane.vmde`. It is a separate Marketplace/Open VSX identity, not an automatic
  upgrade of `spiochacz.vmarkd`.
- Settings now use the `vmde` root (for example `vmde.editor.defaultMode`), commands use the
  `vmde.` prefix, and the custom editor is `vmde.editor`. No deprecated `vmarkd` aliases or
  dual-read migration paths are included.
- Extension-local state and editor associations from the former installation do not transfer.
  Install the new extension explicitly, reapply the settings and keybindings you still want, and
  choose VMDE again for any saved editor associations.

<!-- brand-check: former-brand-explanation-end -->

### Added

- **Markdown-native editing commands.** `Ctrl/Cmd+F` opens source-accurate find/replace; `Alt+Q`
  rewraps a paragraph or selection; **Rewrap Document** handles every eligible prose block in one
  transaction; heading promote/demote can act on one heading or its complete section; and staged
  structural selection supports block/document expansion without serializing editor chrome.
- **Optional authoring behavior.** Auto-wrap reuses the source-preserving formatter after a quiet
  interval. Bundled Lute switches expose `[toc]`, `==mark==`, and superscript/subscript syntax.
  Ordered lists can renumber after edits and drag moves while preserving authored start numbers.
- **Section workflows.** Persistent section/list folding, hierarchical section hoisting, restored
  reading position, viewport-owned outline highlighting, and source-line reveal work across the
  editor surfaces without removing hidden source from the document.
- **Discoverable heading folds.** Expanded `▼` and collapsed `▶` controls remain visible in IR
  and WYSIWYG, with a larger 36×24 px pointer target around the unchanged 12 px glyph that stays
  separate from heading markers, text, and neighboring content.
- **Details and callout authoring.** `<details>/<summary>` blocks remain interactive while editing,
  selections can be wrapped or unwrapped from the toolbar, and callouts have shared add/change/
  title/remove controls across IR, WYSIWYG, and Split.
- **Unified diagram controls.** Registry-declared zoomable renderers receive Pan, zoom, reset, and
  an optional full-screen stage without cloning the live renderer or its state.
- **Accessibility.** Editor surfaces are named multiline textboxes, one polite live region reports
  save/copy/mode/error state, link-like chips and diagrams have shared semantics, reduced-motion
  disables VMDE and Vditor motion while preserving state, and VS Code high-contrast plus browser
  forced-colors modes use visible borders, focus, and diagram palettes.
- **Large-document rendering.** Split mode can stream source and Preview directly; semantic-local
  mutation work avoids full-document helper/ToC passes; full Preview uses one immediate snapshot
  and reuses a current hidden render; and host writeback baselines prewarm after first paint.
- **Release tooling.** Guarded local preview packaging, production version contracts, GitHub and
  Azure pipeline validation, deterministic archive inspection, and commit-identifying preview
  filenames are available without pushing or publishing from the local tools.

### Changed

- **File uploads follow VS Code.** With `vmde.image.saveFolder` left at `assets`, VMDE honors the
  first matching `markdown.copyFiles.destination`, including documented variables, transforms,
  workspace roots, per-file directories, and renames. Explicit non-default VMDE folders still win.
  Images and WAV files retain their specialized markup; other dropped files insert escaped-label
  Markdown links.
- **Theme pairing follows the active workbench.** `vmde.theme.content: auto` recognizes VS Code
  Modern and GitHub themes, otherwise follows live editor tokens, including the real four-value
  high-contrast kind. Prose on the variable-driven path uses `markdown.preview.fontFamily`.
- **Formatting, toolbar, and keybinding metadata share one source.** Discoverable VS Code commands,
  tooltips, context actions, and webview dispatch no longer drift or execute twice.
- **The editor and renderer stack is security-maintained.** Vditor is 3.11.3, Mermaid 11.17.2,
  KaTeX 0.16.47, ECharts 6.1.0, abc.js 6.7.0, smiles-drawer 2.4.1, three.js 0.185.1,
  Vega 7.1.0, and D2 0.1.33. Optional renderer clusters remain lazy-loaded.
- **A VMDE-specific logo and Marketplace hero** represent the independent extension.
- **Real-VS-Code verification uses lifecycle readiness instead of broad fixed waits.** Generated
  privacy-safe large fixtures and focused no-retry recovery evidence keep release tests repeatable.

### Fixed

- Undoing back to the opening bytes now clears VS Code's dirty indicator while VMDE and native undo/
  redo remain aligned across IR, WYSIWYG, and Split.
- Cut and Backspace keep selection/caret state stable; IME composition avoids editor transforms;
  source markers reveal before navigation edits; and ordinary typing no longer triggers global
  marker/helper work.
- Trusted pointer activation now opens IR links after their source markers expand, arrow keys retain
  native movement inside fenced-code sources, and double Enter exits the final ordered or unordered
  list item into a writable paragraph.
- Wiki-shaped text inside inline code survives unrelated list edits as literal code, and
  modifier-click activation works on Split source links, autolinks, and reference links without
  changing source bytes.
- Split view aligns by heading identity even with its one-wrapper source DOM, and switching between
  edit and Preview preserves the active section.
- Image replacement, Git gutters, toolbar overflow, paste-over-link, list indentation, code copy,
  and same-document navigation refresh correctly without reloading the editor.
- Mermaid C4 labels, D2 caches, theme flips, diagram sizing, renderer controls, and code/table/
  callout palettes retain readable colors across content and workbench themes.

### Security

- Replaced advisory-affected vendored assets with SHA-pinned Mermaid 11.17.2 and KaTeX 0.16.47,
  and rebuilt Markmap 0.18.12 with markdown-it 14.3.0 / linkify-it 5.0.2. Architecture, XY, radar,
  math, mhchem, macro, and long-link security families are covered in the real VS Code webview.
- Added exact vendor-component OSV auditing, recursive asset hash/provenance checks, npm signature
  verification, and a target-aware D2 `govulncheck` gate. The release closes with zero known npm
  vulnerabilities and no reachable D2 advisory in the shipped `js/wasm` call graph.
- Updated the transitive `qs` dependency used by the local VSIX toolchain to 6.16.0 after the final
  audit exposed its newly published denial-of-service advisories.

### Known limitations

- The in-editor outline and resize separator are keyboard-operable once focused, but the shipped
  Escape-to-toolbar path does not provide an end-to-end keyboard-only route onward to the outline.
- Static SVG, Markmap, and Leaflet diagram zoom/reset have focused real-webview coverage. ECharts
  mindmap keyboard reset is intentionally unavailable, and its keyboard zoom lacks the same focused
  real-webview evidence. These are accepted accessibility residuals, not claims of full support.

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
