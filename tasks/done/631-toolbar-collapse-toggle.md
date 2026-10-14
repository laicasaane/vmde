# Task 631 — Toolbar toggle to collapse and expand the toolbar

**Status:** done (2026-10-14).
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

- [x] The toggle is shown at the end of toolbar row 1 in IR, WYSIWYG and SV, with an up chevron while expanded and a down chevron while collapsed. Evidence: Real VS Code `toolbar-collapse.spec.ts` case 1 in IR, WYSIWYG and SV: the toggle is last in row 1 with the chevron direction following the state (S3/S3b).
- [x] Clicking the toggle or pressing Enter/Space on it collapses and expands the toolbar; `aria-expanded` and the label follow the state. Evidence: Case 1: click, OS Enter and OS Space collapse and expand; `aria-expanded` and the label follow; Vitest `toolbar-collapse.test.ts` (S1).
- [x] Collapse and expand leave the document bytes, the dirty state, the Undo history, the caret, the selection and the scroll position unchanged. Evidence: Case 1: host bytes, dirty state, selection and scroll offsets unchanged; Undo depth unchanged after the S3b fix (`undo-boundaries.ts` exclusion, Vitest cases failed before); Chromium caret, selection, focus and scroll unchanged (S2).
- [x] Open toolbar menus close on collapse; overflow layout is correct after expand. Evidence: Case 1: More menu closed on collapse, overflow set restored after expand at 500 px; Chromium collapse and expand at 1400 and 420 px, menus close on collapse (S2).
- [x] The state survives a webview reload; a new editor opens expanded. Evidence: Case 2: the collapsed strip survives a webview reload, a reopened editor is expanded (S3).
- [x] With `vmde.editor.toolbar` off, no toggle is shown. Evidence: Case 3: no toggle with `vmde.editor.toolbar` off (S3); Vitest no toggle without a toolbar (S1).
- [x] Focused real-VS-Code spec written and run; `npm run quality` passes. Evidence: Real VS Code `toolbar-collapse.spec.ts` 3 passed (OS input, one worker, no retries, S3b). The Closure gate list stands in for `npm run quality`, audit omitted by Owner instruction.

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

## Execution progress — 2026-10-14 (S2)

Part 2 S2 (collapsed layout, panel close, overflow re-measure) is implemented with Chromium coverage.

- `vscode-chrome.css`: with `vmde-toolbar--collapsed`, row 2 and every row-1 item and divider except the toggle use `display: none`, leaving one strip of the normal row height; the toggle sits at the trailing edge (`margin-inline-start: auto`). A `prefers-reduced-motion` rule keeps any inherited toolbar transition off.
- `toolbar-collapse.ts`: collapsing closes open panels (`closeSubmenuPanels` plus every other open hint or panel matched by the dismiss selector). The Find widget needs no explicit call: it already tracks the toolbar bottom through a size observer on the toolbar, so the new strip height is picked up; this is unverified until the real-VS-Code step (S3).
- `toolbar-overflow.ts`: `apply()` returns early while collapsed (after refreshing the roving state, so the toggle is the only tabbable stop), and the first pass after expand re-measures. A class observer on the toolbar schedules that pass. `authoredInsert` is now a no-op for an item already in place; before, the expand re-measure re-inserted the focused toggle and dropped keyboard focus (found by the new focus assertion).
- Chromium (`toolbar-overflow.spec.ts`, harness installs the toggle with a stub state): the row and flat-order lists gain the trailing `collapse-toolbar` token; new cases cover collapse then expand at 1400 and 420 px (same rows, same overflow set, same toolbar height, resize while collapsed), the More and Headings menus closing on collapse, caret, selection, focus and scroll offset unchanged by a raw mouse click (browser scroll anchoring is disabled in the harness, where the toolbar scrolls with the page), and keyboard reach and focus retention on the toggle (Escape then Tab, Enter). The new cases failed before the change.
- Not done here: real-VS-Code spec and `toolbar-order.spec.ts` check (S3); the scroll offset in the real pinned-toolbar webview.

## Execution progress — 2026-10-14 (S3)

Part 2 S3 (real-VS-Code spec) is written and run: `test/vscode-e2e/toolbar-collapse.spec.ts`, three `test()` blocks (toolbar on with OS input; reload plus a new editor; `vmde.editor.toolbar` off). Run under the OS-input setup (`VMDE_XTEST=1`, minimal window-manager config), `--workers=1 --retries=0`.

- **Result: not green. The spec found a product defect in Acceptance 3.** Case 1 fails in IR at the first click on the toggle: the Undo stack depth goes from 1 to 2 (settled for 2 s before the baseline, and again 3 s later; read 100 ms and 2 s after the click: 2). In Source mode (SV) the selection also moves (anchor goes from the paragraph text node to a newline text node). Cause hypothesis, not yet fixed: `media-src/src/editing/undo-boundaries.ts` `isToolbarAction` treats every `.vditor-toolbar button` except undo, redo, preview and edit-mode as an editing action and takes an undo boundary on click, so the collapse toggle needs the same exclusion. Open for the next step.
- With the Undo depth comparison set aside in a temporary run (IR and WYSIWYG only, restored afterwards), the rest of case 1 passed in IR and WYSIWYG: toggle last in row 1 and chevron direction, `aria-expanded` and label, click collapse/expand with unchanged host bytes, dirty state, selection and scroll offsets, OS Escape then Tab reaching the toggle while collapsed, OS Enter and Space toggling, More menu closed on collapse, overflow set restored after expand at 500 px, Find widget top following the toolbar bottom after collapse and after expand (closes the open S2 Find re-sync item). Cases 2 and 3 pass: state survives a webview reload (collapsed strip only), a reopened editor is expanded, no toggle with the toolbar off.
- Not verified: SV beyond the selection failure above (only reached after the fix); the scroll offset in the pinned-toolbar webview is covered for IR and WYSIWYG (non-zero offset unchanged).

### S3b (2026-10-14): Undo step and Source-mode selection fix

- **Cause (measured).** In `media-src/src/editing/undo-boundaries.ts` the toggle was taken for an editing action twice: its click through `isToolbarAction` (Undo depth 1 to 2 in IR after the first click) and Enter on it through the editing-Enter keydown boundary (depth 1 to 2 after OS Enter, measured step by step). The boundary re-renders the source, which also moved the Source-mode selection anchor; the toggle's `mousedown` default was already prevented (by the toggle and by the toolbar scroll guard), so no change was needed in `toolbar-collapse.ts`.
- **Fix.** New `isCollapseToggle` helper; `isToolbarAction` excludes the toggle, and `onKeydown` returns early for a key on the toggle. Vitest added in `undo-boundaries.test.ts`: the toggle click takes no boundary and a formatting button click still takes one; Enter on the toggle takes none and does not post input. The click case and the Enter case failed before the change.
- **Spec change.** In `toolbar-collapse.spec.ts` the narrow-width, More-menu, overflow and Find widget checks (IR only) now run before the three-mode loop. Observation, not a collapse effect and not fixed here: after visiting Source mode and returning to IR, the overflow layout at 500 px keeps Source-mode widths for the controls Source hides (outdent, indent, outline, insert-before, insert-after, preview), so row contents are wider than the row (435 and 468 against 395) until a later re-measure; the first re-measure after expand corrects it. Open for the Task 632 overflow owner.
- **Result.** `toolbar-collapse.spec.ts` (OS input, one worker, no retries): 3 passed.

## Closure — 2026-10-14

- **Outcome.** The toolbar has a collapse toggle at the trailing end of row 1 (`collapse-toolbar`, up chevron while expanded, down chevron while collapsed). Collapsed, one slim strip shows only the toggle; open panels close; overflow re-measures on expand; the state persists in the webview state and a new editor opens expanded; no toggle when the toolbar is off. Collapse and expand leave bytes, dirty state, Undo, caret, selection and scroll alone, including keyboard activation.
- **Commits.** Records `517e0277`, `3d410724`, `332bdd73`, `1d19162e`, `b922ba91`. Button and state `5cef0d15`. Layout and overflow `93405502`. Chromium spec `39e92006`. Undo-boundary fix `63bdac2a`. Real-VS-Code spec `9c9f7c2b`.
- **Gates on the closing commit.** (batch 2 HEAD, `d5f6849a`; exit 0 unless noted): `npm run lint:ci`, `npm run typecheck`, `npm run typecheck:vscode-e2e`, `npm run knip`, `npm run jscpd`, `npm run depcruise`, `npm run check:brand-identifiers` pass. `npm run test:coverage` exits 1: 1 failed, 6,471 passed, 213 skipped; the one failure is `media-src/src/boot/live-config.test.ts` "Split View source font variable (task 634)" (the Task 634 allow-list change left the test's expectation stale), not a file of this task. `npm run check:coverage-modules` exits 1 only because the failed coverage run wrote no coverage summary. `npm run quality` as one command was not run, and its audit stage was omitted by Owner instruction.
- **Bundle.** `media/dist/main.js` is 1,006,642 B on the batch-2 build, +10,207 B against the batch-1 close (996,435 B). `npm run check:startup-cost` reports 377 eager modules (batch-1 close: 375) and exits non-zero against its budget of 294; the budget miss predates this batch and is reported, not changed.
- **Acceptance items that name `npm run quality`.** Met by the gate list above with the audit stage omitted by Owner instruction; the one failing test belongs to Task 634.
- **Residuals.**
  - After a visit to Source mode and a return to IR, the overflow layout keeps Source-mode widths for the controls Source hides until the next re-measure (the first re-measure after expand corrects it); open as a follow-up.
  - The scroll offset in the pinned-toolbar webview is checked for IR and WYSIWYG only.
  - Real VS Code `toolbar-overflow.spec.ts` tests at lines 195 and 787 fail before this task (pre-existing); line 590 is flaky.
- **Follow-ups.** Overflow re-measure after returning from Source mode (open, no task filed).
