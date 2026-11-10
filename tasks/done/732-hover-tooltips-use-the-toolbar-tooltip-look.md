# Task 732 — Hover tooltips use the toolbar tooltip look

**Status:** done (2026-11-10).
**Origin:** Owner report, 2026-11-10.
**Severity:** low. Visual: the Task 729 and Task 731 tooltips are the browser's native `title` tooltip, which does not look like VS Code's.
**Tech stack:** webview chrome (`media-src/src/chrome/toolbar-row-hover.ts`, `vscode-chrome.css`), outline (`media-src/src/nav/outline-keyboard.ts`), link and image tooltips (`media-src/src/links/link-tooltip.ts`).
**Depends on:** Tasks 729 and 731.

## Owner request

"The tooltip does not look like native VSCode tooltip at all. Must use the same tooltip from toolbar."

## Decisions

- D1 (orchestrator, PROVISIONAL): outline entries (Task 729) and links and images (Task 731) show their text in the same hover box as the More and Math rows (`.vmde-row-hover`, Task 642), which repeats the toolbar tooltip look: VS Code hover-widget colours and border, `vmde.editor.tooltipFontSize`, padding, radius, fade-in. No native `title` is written any more.
- D2 (orchestrator, PROVISIONAL): the box opens under the hovered line box of the element, centred on it like the toolbar's `__s` tooltip, flips above when it does not fit below, and stays inside the viewport. It appears as soon as the pointer is on the element, like the toolbar tooltip (Vditor's `:hover::after`, 0.15 s fade); the Owner's 50 ms latency ceiling (2026-11-10) rules out a longer wait.
- D3 (orchestrator, PROVISIONAL): multi-line text (title, alt text, target) is left-aligned in the box; single-line text looks the same as the toolbar tooltip.
- D4 (orchestrator, PROVISIONAL): in Preview and Split's preview pane, a hovered link or image with a Markdown `title` loses that attribute while hovered (restored on leave), so the native tooltip never doubles the box.
- D5 (orchestrator, PROVISIONAL): in WYSIWYG, a link or image with its own Markdown title still shows only the native title (Task 731 D15): that attribute is serialized and cannot be removed while hovered. Wiki chips and code references keep their own native titles (Task 731 D7, D11); changing them is outside this task.

## Acceptance

- [x] Outline entries, links and images show their tooltip in the toolbar-style hover box in IR, WYSIWYG, Split's preview pane and Preview; no native `title` is written for them.
- [x] Tooltip text and lines are unchanged from Tasks 729 and 731.
- [x] Hover changes no document, dirty state, Undo history or caret.
- [x] Focused real-VS-Code specs and `npm run quality` pass.

## Implementation decisions (orchestrator, PROVISIONAL)

- D6: new module `media-src/src/chrome/hover-tip.ts` (`installHoverTips`, `createHoverTip`, `placeHoverTip`, `anchorRect`). The box has class `vmde-hover-tip`, which joins every `.vmde-row-hover` rule in `vscode-chrome.css`; it is a separate element and class so the More and Math row box and its specs are untouched.
- D7: `links/link-tooltip.ts` gets the installer from `boot/finish-init.ts` (`installLinkTooltips(document, installHoverTips)`), so the `links` module keeps no edge to `chrome` (module-boundaries allowlist unchanged).
- D8: Task 729's `applyOutlineTitles` is replaced by `outlineTipAt` / `outlineEntryLabel` in `nav/outline-keyboard.ts`; nothing is written to outline entries.
- D9: a long target wraps inside the webview (`pre-wrap`, `overflow-wrap: anywhere`, `max-width: calc(100vw - 18px)`).

## Verification (orchestrator, 2026-11-10)

- `node build.mjs`: pass.
- Real VS Code (`outline-tooltip.spec.ts`, `link-tooltip.spec.ts`, `toolbar-menu-tooltip-style.spec.ts`): first run 4 passed, 1 flaky (Split/Preview case, Undo depth 0 to 1 on the first attempt, passed on retry); after the delay change, 5 passed. The style spec compares the content box with the toolbar `::after` tooltip on font size, family, line height, padding, radius, background and colour, and follows `vmde.editor.tooltipFontSize`.
- `npm test`: 9544 passed, 1 expected fail.
- `npm run quality`: knip, jscpd, depcruise, audit, brand identifiers, coverage and coverage-module ratchet pass. `lint:ci` reports 5 errors in files this task does not touch (`media-src/e2e/ir-arrow-markers.spec.ts`, `media-src/src/editing/rewrap-command.test.ts`, `test/vscode-e2e/preview-mode-timing.spec.ts`); the same 5 appear with this task's changes stashed. The first coverage run hit a 30 s timeout in `test/backend/lute-code-cache.test.ts`; the rerun passed.
