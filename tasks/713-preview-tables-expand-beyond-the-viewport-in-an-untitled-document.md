# Task 713 — Preview content expands beyond the viewport (tables first, every Markdown construct in scope)

**Status:** in progress (2026-11-09). Reported by the Owner.
**Origin:** Owner report: manual reproduction in VS Code on an untitled (never saved) document.
**Severity:** medium (estimated). In Preview, wide tables overflow the editor viewport, so content is cut off or needs horizontal scrolling. The edit modes are not affected. The Owner asked that the task cover every construct the editor renders, not only tables.
**Tech stack:** Preview rendering (`.vditor-preview`, `.vditor-reset`, content themes in `media/markdown-themes/`), diagram runtime (`media-src/src/diagrams/`, `media-src/src/diagram-kit/`), math, callouts, details, front matter, `media-src/src/chrome/responsive-tables.ts` (table width and `max-width` handling, Task 640 wrap hints), the content-theme CSS, and the Preview pane that Vditor's toolbar shows. Whether the untitled-document path matters is not yet known.
**Depends on:** none.

## Problem

Steps to reproduce:

1. In a new VS Code window, press `Ctrl+N` to create an untitled tab.
2. Paste the sample below into the tab.
3. Do not save it to a file.
4. Switch the editor on that tab to VMDE.
5. Change the edit mode to IR.
6. Toggle the "Preview" toolbar button.
7. With Preview on, the tables expand beyond the VS Code viewport.
8. With Preview off, the tables stay within the viewport.

Expected: the tables always stay within the VS Code viewport, including with Preview on.

Not yet known: whether a saved file shows the same overflow; whether WYSIWYG and SV entry into Preview behave the same; which element overflows (the table, its wrapper, or the Preview pane); and the first bad commit.

Sample (paste as is):

```markdown
## Rename candidates

| Current | Meaning | Candidate |
|---|---|---|
| `IServiceBootstrap` | Module start-up contract | `IInjectingBootstrap` |
| `DefaultServiceBootstrap` | Default module start-up | `DefaultInjectingBootstrap` |
| `DisableServiceBootstrapOverrideAttribute` | Turns off bootstrap override | `DisableInjectingBootstrapOverrideAttribute` |
| `ProjectServices` | Project composition root | `ProjectInjection` / `ProjectRoot` |
| `SceneServices` | Scene composition root component | `SceneProvider` / `SceneRoot` |
| `ProjectScopeServices` | Project-scope provider | `ProjectScopeProvider` |
| `SceneServiceRouter` | Routes scenes to providers | `SceneProviderRouter` |
| `IServiceScope` | Struct scope identifier | `IInjectingScope` (optional) |
| `FindServices` | Resolves all matches | `GetServices` / `ResolveAll` |
| `InstallDiscoveredServices` | Runs discovered installers | `InstallDiscovered` |
| `__ServiceCatalogs__` | Generated catalog holder | `__InjectingCatalogs__` |

## Keep

| Name | Reason |
|---|---|
| `IServiceProvider` | Extends `System.IServiceProvider` (D3) |
| `ServiceProvider` | Runtime node (D2) |
| `ServiceProviderBehaviour` | Subtree component (D2) |
| `GetService` | BCL name |
| `GetRequiredService` | Microsoft DI name |
| `GetOptionalService` | Same family as `GetRequiredService` |
| `TryGetService` | Same family as `GetService` |
| `IServiceInstaller` | Installs services; `IInstaller` too generic |
| `_services` | Private field |
| `IShopService` | Sample user type |
| `ShopService` | Sample user type |
| `IInventoryService` | Sample user type |
| `MatchmakingService` | Sample user type |
| `PlayerSaveService` | Sample user type |
| `VContainerServiceProvider` | Implements `IServiceProvider` |
| `ReflexServiceProvider` | Implements `IServiceProvider` |
```

The long cells are inline code without spaces (for example `DisableInjectingBootstrapOverrideAttribute`), so a table can only fit if the code breaks inside a word. In the edit modes, Task 640 wrap hints break long table words; Preview may not get those hints or the same width rules.

## Scope: every rendered construct

The reported case is the table. The Owner asked that the fix and its tests cover everything the editor renders in Preview. Each of these must stay within the viewport width, wrapping or scrolling inside its own box instead of widening the page:

- Block text: headings (long unbroken words), paragraphs with long URLs, long unbroken words or long inline code, block quotes, horizontal rules.
- Lists: nested ordered and unordered lists, task lists (the Preview checkboxes), deep nesting.
- Tables: wide tables, long inline code and URLs in cells, aligned columns, tables inside lists, block quotes, callouts and details, resized column widths (Task 640 wrap hints and `table-column-widths`).
- Code: fenced code blocks with long lines (highlight.js), indented code, inline code in every context above.
- Math: inline and block math with wide formulas.
- Diagrams and embedded renderers listed in `diagram-kit/engine-registry.ts`: mermaid, flowchart, mindmap, markmap, plantuml, d2, graphviz, nomnoml, wavedrom, echarts, vega, vega-lite, abc, smiles, geojson, topojson, stl. That covers wide SVG and canvas output and the diagram controls and zoom.
- Media: images wider than the viewport, SVG data images, links, footnotes and their back links.
- Raw HTML blocks and inline HTML, including wide elements.
- Callouts (GitHub alerts), `<details>` blocks (open and closed), the front-matter properties table (Task 207), wiki links and their hover previews, table of contents.
- Combinations: any of the above nested inside block quotes, lists, callouts and details.

For each construct, record whether it already fits in Preview. Fix the ones that overflow and add a regression check for every construct, including the ones that already fit. Edit modes (IR, WYSIWYG, SV) must also keep every construct within the viewport. If the same defect appears there, record it here, and ask the Owner before widening the fix.

## Proposed work

1. Reproduce the table case in real VS Code with the sample. Test an untitled document and a saved file, in IR, WYSIWYG and SV, toggling Preview each time. Measure (CDP, per the vmde-visual-debugging skill) the widths of the viewport, the Preview pane, each table and its wrapper, and the computed `max-width`, `width`, `table-layout`, `overflow-wrap` and `word-break` of the cells and inline code.
2. Build one stress fixture with every construct in the scope list, each sized to exceed the viewport (long unbroken words, long code lines, wide tables, wide diagrams and images, wide math). Measure in Preview, entering from each edit mode, which top-level or nested elements have a right edge past the viewport or make `document.scrollingElement.scrollWidth` exceed `clientWidth`. Also measure the edit modes for comparison.
3. For each overflowing construct, name the rule or step that differs between Preview and the edit modes. Examples: responsive-table sizing or wrap hints not applied to the Preview DOM, a theme rule, a renderer's fixed width.
4. Find the first bad commit for each construct that regressed.
5. Fix with failing tests first: a real-VS-Code spec in `test/vscode-e2e/` that opens the stress fixture (and the table sample in an untitled document), enters Preview from IR, WYSIWYG and SV, and asserts that no element exceeds the viewport and the page has no horizontal overflow. Add Vitest coverage for any pure helper that changes.

## Acceptance

- [ ] For an untitled and a saved document, the overflowing element and the rule that causes it are measured for the table case.
- [ ] Every construct in the scope list is measured in Preview and recorded as fitting or overflowing, with its cause.
- [ ] A real-VS-Code spec fails before the fix and passes after it. It covers the table sample and the stress fixture with every construct.
- [ ] In Preview, every construct stays within the viewport for every entry mode (IR, WYSIWYG, SV). The edit modes do not regress.
- [ ] `npm run quality` passes.

## Tests to write

- Real-VS-Code spec, table case: the sample in an untitled document, IR → Preview, no table wider than the viewport. Repeat for WYSIWYG and SV entry, and for a saved file if the behavior differs.
- Real-VS-Code spec, all constructs: the stress fixture in Preview from each entry mode. Assert per construct, so a failure names the construct: no element wider than the viewport, and no horizontal page overflow.
- Vitest for any changed sizing or wrap helper.
