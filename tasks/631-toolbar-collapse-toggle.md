# Task 631 — Toolbar toggle to collapse and expand the toolbar

**Status:** planned (2026-10-14). The Project Owner requested this task on 2026-10-14. Implementation has not started.
**Origin:** Project Owner feature request (chat, 2026-10-14).
**Severity:** feature (low risk).
**Tech stack:** TypeScript webview (`media-src/src/chrome/`), toolbar CSS, Vitest, Chromium, real VS Code.

## Problem

The two-row editor toolbar always takes vertical space. The user cannot hide it for a moment and bring it back. The only option today is the `vmde.editor.toolbar` setting, which removes the toolbar for the whole editor and needs a reopen.

## Requested behavior

- A toggle on the toolbar expands or collapses the toolbar at will.
- The toggle uses the up and down arrow symbols that are common for this control: an up chevron (▲ / `chevron-up`) while the toolbar is expanded ("Collapse toolbar"), and a down chevron (▼ / `chevron-down`) while it is collapsed ("Expand toolbar").

## Default decisions (Project Owner may override)

- The toggle sits at the trailing end of toolbar row 1 and stays visible in both states.
- Collapsed: both toolbar rows hide every item except the toggle, leaving a slim strip. The editor area gains the freed height. Open toolbar menus and overflow panels close on collapse.
- Collapsing or expanding does not change the document, the caret, the selection or the scroll position, does not mark the document dirty and adds no Undo step.
- The icon matches the existing toolbar icon style (`media-src/src/chrome/toolbar-icons.ts`) and follows the active theme.
- Accessibility: the toggle is a button with `aria-expanded`, a localized `aria-label`/tooltip ("Collapse toolbar" / "Expand toolbar", with Chinese translations like Task 564), and it is reachable by the toolbar's keyboard traversal.
- The state survives a webview reload through the webview state (`vscode.setState`), like `media-src/src/nav/reading-position.ts`. A new editor opens expanded. A global or per-workspace setting is out of scope unless the Owner asks.
- When `vmde.editor.toolbar` is off, no toolbar and no toggle are shown (unchanged).

## Entry points (to confirm in Part 1)

- `media-src/src/chrome/toolbar.ts`, `toolbar-layout.ts` (two-row ownership), `toolbar-overflow.ts` (overflow recompute after collapse/expand), `toolbar-icons.ts`, `toolbar-submenu-aria.ts`, `toolbar-labels.test.ts`.
- `media-src/src/boot/finish-init.ts` (toolbar row setup).

## Acceptance

- [ ] The toggle is shown at the end of toolbar row 1 in IR, WYSIWYG and SV, with an up chevron while expanded and a down chevron while collapsed.
- [ ] Clicking the toggle or pressing Enter/Space on it collapses and expands the toolbar; `aria-expanded` and the label follow the state.
- [ ] Collapse and expand leave the document bytes, the dirty state, the Undo history, the caret, the selection and the scroll position unchanged.
- [ ] Open toolbar menus close on collapse; overflow layout is correct after expand.
- [ ] The state survives a webview reload; a new editor opens expanded.
- [ ] With `vmde.editor.toolbar` off, no toggle is shown.
- [ ] Focused real-VS-Code spec written and run; `npm run quality` passes.

## Tests

- Vitest: toggle state, icon and label switching, persistence read/write, no toggle when the toolbar is disabled.
- Chromium harness: collapse/expand layout, menu close, overflow after expand, caret/selection/scroll unchanged.
- Real VS Code (`test/vscode-e2e/`): toggle in each mode, host bytes clean, state after webview reload. Run `node build.mjs` first, then the spec under `xvfb-run`.

## Part 1 handoff (2026-10-14)

Read-only review of the source; nothing was run.

- **Entry points.** Toolbar items: `media-src/src/chrome/toolbar.ts` `createToolbar` (Vditor custom items take icon, tip and click; Preview disables only the edit items, so a custom toggle stays enabled). Toolbar off: `boot/vditor-init.ts` passes `toolbar: []`, so no toggle is created; `showToolbar` is init-only (`boot/live-config.ts`). Rows: `chrome/toolbar-layout.ts` (`ROW_ONE`, `ensureToolbarRows`). Overflow: `chrome/toolbar-overflow.ts` (`KNOWN_TOOLBAR_ITEMS`, cluster tables, `measure`/`apply`). Keyboard: `editing/escape-toolbar.ts` (`rovingItems` skips `display: none` items; `refreshToolbarRoving`). Menus: `chrome/toolbar-submenu-aria.ts` `closeSubmenuPanels`, `chrome/toolbar-dismiss.ts`. State: `nav/reading-position.ts`, `nav/section-hoist.ts`, `nav/section-fold.ts` merge into `getState()` before `setState`. Strings: `util/lang.ts` (en_US, zh_CN). Find widget: `editing/selection-scope.ts` `syncWidgetPosition`. Prerender placeholder height: `src/webview-host/html-builder.ts` (70 px).
- **Contract.**
  1. The toggle is a Vditor custom item `collapse-toolbar`, last in the flat list, in `ROW_ONE`, with no separator before it; it sits at the trailing edge of row 1 (`margin-inline-start: auto`).
  2. New module `chrome/toolbar-collapse.ts` (+ test, + `scripts/module-manifest.mjs` entry): read/write the webview-state key `vmdeToolbarCollapsed` by merging into existing state; `installToolbarCollapse(toolbarEl, api)` applies the stored state, binds the button and returns a disposer. Collapsing sets class `vmde-toolbar--collapsed`, `aria-expanded` (`true` while expanded), `aria-label`, and swaps the icon between a chevron-up (expanded) and chevron-down (collapsed) 16×16 `currentColor` icon in `toolbar-icons.ts`. Wired in `boot/finish-init.ts` after `refreshToolbarRoving` and before `installToolbarOverflow`.
  3. Collapsed CSS (`vscode-chrome.css`): hide row 2 and every row-1 item and divider except the toggle, leaving one strip of the normal row height; hidden items use `display: none`, so roving reduces to the toggle.
  4. Mouse `mousedown` on the toggle calls `preventDefault` so editor focus and selection survive; Enter/Space keep focus on the toggle in both states.
  5. Collapse closes open panels (More, emoji, headings, edit-mode, math) and re-syncs the Find widget position.
  6. Overflow: `apply()` returns early while collapsed; the first apply after expand forces a re-measure (hidden items report width 0). The toggle is in `KNOWN_TOOLBAR_ITEMS` as a pinned item in no cluster.
  7. No document effect: no editor DOM write, no change event, no Undo entry. Persistence in webview state only (a new editor opens expanded); no setting; no toggle when the toolbar is off.
- **Part 2.** S1: `toolbar.ts`, `toolbar-icons.ts`, `toolbar-layout.ts`, `util/lang.ts` (`collapseToolbar`/`expandToolbar`), new `toolbar-collapse.ts`, `toolbar-overflow.ts` known-items entry, `finish-init.ts`, manifest; Vitest for labels/icons, `aria-expanded`, persistence with a stub API (absent or bad state, other keys kept), no toggle without a toolbar, toggle last in row 1 of the `createToolbar()` inventory. S2: CSS and overflow re-measure; Chromium in `media-src/e2e/toolbar-overflow.spec.ts`: collapse/expand at wide and narrow widths restores the same overflow set, open menus close on collapse, caret/selection/`scrollTop` unchanged by a click, Tab lands on the toggle while collapsed. S3: new `test/vscode-e2e/toolbar-collapse.spec.ts` (IR, WYSIWYG, SV; host bytes unchanged, not dirty, no Undo step, state after webview reload, no toggle with `vmde.editor.toolbar` off); update `toolbar-order.spec.ts` if its flat-order tokens include the toggle.
- **Edge cases.** Preview active; a panel open at collapse; narrow width with items already in More; reload while collapsed (brief 70 px placeholder, then the collapsed strip); resize while collapsed then expand; hide/reveal of the retained webview; mode switch; focus on an item that collapse hides (move focus to the toggle); no transition under `prefers-reduced-motion`.
- **Coordination with Task 632.** Both change `toolbar.ts`, `toolbar-layout.ts`, `toolbar-overflow.ts` and the order tests (`toolbar-layout.test.ts`, `toolbar.test.ts`, `toolbar-overflow.test.ts`, `test/vscode-e2e/toolbar-order.spec.ts`, `toolbar-overflow.spec.ts`). Recommendation adopted: run Task 632 first; Task 631 then appends one trailing token per list.
- **Owner questions (provisional choices, reversible).** (1) Collapsed strip height: keep the normal row height — adopted. (2) Reload while collapsed shows the 70 px placeholder briefly: accept, add a check that it settles — adopted. (3) Keyboard shortcut for the toggle: none (reachable by Tab and arrows) — adopted.
- **Probes for Part 2.** State restores the collapsed class after a real webview reload; the Find widget follows the toolbar bottom after collapse; `mousedown` `preventDefault` keeps tooltip and focus ring behaviour like other buttons.

## Execution progress — 2026-10-14 (S1)

Part 2 S1 (button, icons, labels, state) is implemented; no CSS yet (S2), so the toggle does not hide anything visually.

- `collapse-toolbar` is a Vditor custom item appended last to the flat list in `chrome/toolbar.ts` (after `more`, no separator, no click of its own), listed in `ROW_ONE`, and pinned in `KNOWN_TOOLBAR_ITEMS` (no cluster). The separator rule in `chrome/toolbar-overflow.ts` treats it as non-content, like `more`.
- `chrome/toolbar-icons.ts` gains `chevronUpIcon` / `chevronDownIcon` (16×16, `currentColor`); `util/lang.ts` gains `collapseToolbar` / `expandToolbar` (en_US "Collapse toolbar" / "Expand toolbar"; zh_CN 折叠工具栏 / 展开工具栏).
- New `chrome/toolbar-collapse.ts` (manifest entry added): `installToolbarCollapse(toolbarEl, api)` reads and writes the webview-state key `vmdeToolbarCollapsed` (merged into existing state; absent or non-boolean state opens expanded), applies class `vmde-toolbar--collapsed`, `aria-expanded`, `aria-label` and the icon swap, calls `preventDefault` on `mousedown`, and returns a disposer; with no toggle it does nothing. Wired in `boot/finish-init.ts` after `refreshToolbarRoving` and before `installToolbarOverflow`.
- Tests: new `toolbar-collapse.test.ts`; the Task 632 order tests (`toolbar.test.ts`, `toolbar-layout.test.ts`, `toolbar-overflow.test.ts`) gained one trailing token (counts 34 to 35 and 32 to 33); new separator case in `toolbar-overflow.test.ts`. The new cases failed before the change (missing module; order and count mismatches; separator kept a dangling rule) and pass after.
- Verification: toolbar unit tests, `module-boundaries`, `npm run typecheck`, `node build.mjs`, `npx biome check` on the touched files and `npm run knip` pass.
- Not done here (open for later steps): collapsed CSS, panel close and Find re-sync on collapse, overflow early return and re-measure (S2); Chromium and real-VS-Code specs, including any flat-order tokens in `test/vscode-e2e/toolbar-order.spec.ts` (S3).
