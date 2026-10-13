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
