# Task 713 — Preview tables expand beyond the viewport in an untitled document

**Status:** planned (2026-11-10). Reported by the Owner.
**Origin:** Owner report: manual reproduction in VS Code on an untitled (never saved) document.
**Severity:** medium (estimated). In Preview, wide tables overflow the editor viewport, so content is cut off or needs horizontal scrolling. The edit modes are not affected.
**Tech stack:** Preview rendering, `media-src/src/chrome/responsive-tables.ts` (table width and `max-width` handling, Task 640 wrap hints), the content-theme CSS, and the Preview pane that Vditor's toolbar shows. Whether the untitled-document path matters is not yet known.
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

## Proposed work

1. Reproduce in real VS Code with the sample. Test an untitled document and a saved file, in IR, WYSIWYG and SV, toggling Preview each time. Measure (CDP, per the vmde-visual-debugging skill) the widths of the viewport, the Preview pane, each table and its wrapper, and the computed `max-width`, `width`, `table-layout`, `overflow-wrap` and `word-break` of the cells and inline code.
2. Compare those values with the edit-mode values, where the tables fit, and name the rule or step that differs (for example responsive-table sizing or wrap hints not applied to the Preview DOM, or a theme rule).
3. Find the first bad commit if the overflow is a regression.
4. Fix with a failing test first: a real-VS-Code spec in `test/vscode-e2e/` that opens the sample (untitled when that matters), enters Preview from IR, and asserts that no table's right edge exceeds the viewport. Add Vitest coverage for any pure helper that changes.

## Acceptance

- [ ] The overflowing element and the rule that causes it are measured, for an untitled and a saved document.
- [ ] A real-VS-Code spec fails before the fix and passes after it.
- [ ] In Preview, tables stay within the viewport in every entry mode (IR, WYSIWYG, SV); the edit modes are unchanged.
- [ ] `npm run quality` passes.

## Tests to write

- Real-VS-Code spec: the sample in an untitled document, IR → Preview, no table wider than the viewport; repeated for WYSIWYG and SV entry, and for a saved file if the behavior differs.
- Vitest for any changed sizing or wrap helper.
