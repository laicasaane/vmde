# Task 731 — Links show their target on hover

**Status:** done (2026-11-10).
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

- [x] Hovering a link in IR, WYSIWYG, Split's preview pane and Preview shows its destination as written (D1); the Owner example shows `scoping-proposal.md#L674`.
- [x] Titled, wiki, reference, autolink and bare-URL links follow D1.
- [x] Images show their target as written, below their caption when they have one (D3–D5): title, alt text, target, one to three lines.
- [x] The tooltip text never reaches the saved Markdown (no `title` added to the source), and hover changes no document, dirty state, Undo history or caret.
- [x] Focused real-VS-Code spec and `npm run quality` pass.

## Implementation decisions (worker and orchestrator, PROVISIONAL unless noted)

- D6 (PROVISIONAL): Lute reads a `title` on a WYSIWYG `<a>`/`<img>` back as the Markdown title, and any attribute write under the editor root enters Undo snapshots, so nothing under the IR or WYSIWYG root is written. While the pointer is over a link or image, the tooltip text goes on `<body>` (outside every serialized root, Undo snapshot and editor observer). Preview and Split's preview pane set the hovered element's own `title` and restore it on leave. An element with its own `title` (wiki chip, code reference, WYSIWYG titled link or image) shadows `<body>`.
- D7 (PROVISIONAL): wiki chips keep their existing title `Open wiki page <target>` / `Missing wiki page <target>`, which already shows the target as written (Task 636 assertions depend on it).
- D8 (PROVISIONAL): Preview shows the `href`/`src` that Lute rendered; measured exceptions to "as written": `<b c.md>` shows `b%20c.md`, `./ü.md` shows `./%C3%BC.md`.
- D9: a bare URL shows its text as written (`www.example.com`).
- D10: a reference link shows its definition's destination; IR and WYSIWYG drop a definition's title (Lute), so only Preview shows it.
- D11: decorated raw HTML anchors (Task 654) show their href; code references keep their own titles; diagram, math and code output and the Split source pane show nothing.
- D12: an IR title comes from its marker with delimiters removed and backslash escapes resolved; alt text is the `<img alt>` attribute; lines join with LF.
- D13: a key press, pointer press, edit, scroll, window blur or leaving the document drops the tooltip; the next pointer move shows it again.
- D14: the installer is wired in `boot/finish-init.ts` next to the caret-link observer.
- D15 (orchestrator, PROVISIONAL; open question Q1): in WYSIWYG, a link or image that has its own Markdown title shows only that title natively, not the full D1/D4 lines, because changing that attribute would leak into the saved Markdown. Kept (option B) instead of a serialization/Undo strip change (A) or a custom tooltip (C). This one case does not fully meet Owner D4; option C is the follow-up if the Owner wants it.

## Verification (orchestrator, 2026-11-10)

- `node build.mjs`: exit 0. `npm test`: 9537 passed, 1 expected fail.
- Real VS Code, through the wrapper: `link-tooltip.spec.ts` (new: real pointer hover on every form in IR, WYSIWYG, Split's preview pane and Preview; document, dirty flag and Undo depth unchanged after hover and save), `link-underline.spec.ts`, `local-link-open.spec.ts`, `wiki-deferred-keys.spec.ts`, `line-fragment-links.spec.ts`, `undo-redo-steps.spec.ts`: 19 passed.
- `npm run quality`: first run failed only `knip` (unused exported type `LinkTooltipSurface`); un-exported, then `npx knip` exit 0, typecheck 0, `link-tooltip.test.ts` 66 passed. Every other stage passed.
- Lute round-trip unit tests prove the saved Markdown is byte-identical with tooltips active.
