# Task 729 — Outline entries show their full text on hover

**Status:** planned (2026-11-10).
**Origin:** Owner request, 2026-11-10.
**Severity:** low. Feature: in a narrow outline panel, long heading entries end in an ellipsis and their full text cannot be read.
**Tech stack:** the editor's outline panel in the webview (Vditor outline, `media-src/src/nav/outline-*.ts`, `.vditor-outline` rules in `media-src/src/main.css`, setting `vmde.outline.position`). The VS Code Outline tree view (`src/markdown/outline-tree.ts`) already sets a tooltip (`H<level>: <heading>`).
**Depends on:** none.

## Owner request

When the pointer hovers an outline entry, a tooltip shows the entry's full text, because a narrow outline panel cuts long entries off with an ellipsis.

## Decisions

- D1 (orchestrator, PROVISIONAL): every entry gets the tooltip, whether or not it is cut off, like VS Code's own Outline tree view. It is the browser's native tooltip (`title`), so it follows the pointer delay of the platform and needs no new UI.

## Acceptance

- [ ] Hovering an outline entry in the webview outline panel shows a tooltip with the entry's full heading text (as rendered in the outline, without Markdown markers).
- [ ] Every entry shows the tooltip, cut off or not (D1).
- [ ] The tooltip updates when the heading text changes, and does not change the document, dirty state, Undo history, caret or outline selection.
- [ ] Focused real-VS-Code spec and `npm run quality` pass.
