# Task 731 — Links show their target on hover

**Status:** planned (2026-11-10).
**Origin:** Owner request, 2026-11-10.
**Severity:** low. Feature: hovering a link or an image shows a tooltip with the link target as written.
**Tech stack:** webview link rendering and decoration (`media-src/src/links/*`: `custom-renderer.ts`, `raw-href.ts`, `caret-link-decorate.ts`, `html-link.ts`, wiki links), IR, WYSIWYG, Split's preview pane and Preview.
**Depends on:** none. Related: Task 730 (line-fragment links).

## Owner request

Hovering a hyperlink shows a tooltip with the link. Example: hovering `[point 14](scoping-proposal.md#L674)` shows `scoping-proposal.md#L674`.

## Decisions

- D1 (orchestrator, PROVISIONAL): the tooltip shows the destination exactly as written in the Markdown source (the raw href, not a resolved or percent-decoded URL). For a link with a Markdown title (`[a](b.md "Title")`), the tooltip shows the title on the first line and the destination on the second. Wiki links show their target as written (`[[Page#Heading]]` shows `Page#Heading`). Reference links show the resolved destination of their definition. Autolinks and bare URLs show the URL.
- D2 (orchestrator, PROVISIONAL): native browser tooltip (`title`), in IR, WYSIWYG, Split's preview pane and Preview.
- D3 (Owner, 2026-11-10): images also show their target in the tooltip. When the image has a caption, the caption is the first line and the target the second.
- D4 (Owner, 2026-11-10): an image tooltip shows its title and its alt text when they exist, and the target as written on the last line, so it has 1 to 3 lines: title, alt text, target. Images inside a link show the link's tooltip on the link and the image's on the image.
- D5 (orchestrator, PROVISIONAL): when the title and the alt text are the same text, it shows once.

## Acceptance

- [ ] Hovering a link in IR, WYSIWYG, Split's preview pane and Preview shows its destination as written (D1); the Owner example shows `scoping-proposal.md#L674`.
- [ ] Titled, wiki, reference, autolink and bare-URL links follow D1.
- [ ] Images show their target as written, below their caption when they have one (D3–D5): title, alt text, target, one to three lines.
- [ ] The tooltip text never reaches the saved Markdown (no `title` added to the source), and hover changes no document, dirty state, Undo history or caret.
- [ ] Focused real-VS-Code spec and `npm run quality` pass.
