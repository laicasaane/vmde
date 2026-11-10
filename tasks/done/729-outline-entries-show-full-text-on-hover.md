# Task 729 — Outline entries show their full text on hover

**Status:** done (2026-11-10).
**Origin:** Owner request, 2026-11-10.
**Severity:** low. Feature: in a narrow outline panel, long heading entries end in an ellipsis and their full text cannot be read.
**Tech stack:** the editor's outline panel in the webview (Vditor outline, `media-src/src/nav/outline-*.ts`, `.vditor-outline` rules in `media-src/src/main.css`, setting `vmde.outline.position`). The VS Code Outline tree view (`src/markdown/outline-tree.ts`) already sets a tooltip (`H<level>: <heading>`).
**Depends on:** none.

## Owner request

When the pointer hovers an outline entry, a tooltip shows the entry's full text, because a narrow outline panel cuts long entries off with an ellipsis.

## Decisions

- D1 (orchestrator, PROVISIONAL): every entry gets the tooltip, whether or not it is cut off, like VS Code's own Outline tree view. It is the browser's native tooltip (`title`), so it follows the pointer delay of the platform and needs no new UI.

## Acceptance

- [x] Hovering an outline entry in the webview outline panel shows a tooltip with the entry's full heading text (as rendered in the outline, without Markdown markers).
- [x] Every entry shows the tooltip, cut off or not (D1).
- [x] The tooltip updates when the heading text changes, and does not change the document, dirty state, Undo history, caret or outline selection.
- [x] Focused real-VS-Code spec and `npm run quality` pass.

## Implementation

- `media-src/src/nav/outline-keyboard.ts`: `applyOutlineTitles` sets each entry's `title` to its rendered label (trimmed, whitespace collapsed) in the existing re-tag pass that runs after every Vditor outline rebuild. It writes only when the value differs, and the observer does not watch `title`, so the pass does not retrigger itself.

## Verification (orchestrator, 2026-11-10)

- `node build.mjs`: exit 0. `npm test`: 9434 passed, 1 expected fail.
- Real VS Code, through the wrapper: `outline-tooltip.spec.ts` (new: long and short headings, IR and WYSIWYG, title updates after a heading edit, document, dirty state and Undo unchanged), `outline-keyboard.spec.ts`, `outline-state.spec.ts`, `outline-viewport.spec.ts`, `outline-toggle-undo.spec.ts`: 7 passed.
- `npm run quality`: exit 0; every stage passes.
