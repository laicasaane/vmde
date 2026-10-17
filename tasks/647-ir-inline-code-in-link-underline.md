# Task 647 — Underline every link in Preview and IR, including inline code used as link text

**Status:** open.
**Origin:** Project Owner request.
**Severity:** low to medium (visual consistency across all links; no source change).
**Tech stack:** webview CSS (`media-src/src/main.css`, content themes in `media/markdown-themes/`, Vditor's `.vditor-reset` styles), IR link DOM (Vditor/Lute `data-type="a"` nodes), Preview DOM, Chromium, real VS Code.

## Problem

Links are not underlined consistently:

- **Preview:** not every link has an underline today. Which links lack one depends on the link kind and the content theme (for example, a theme that underlines links only on hover).
- **IR:** a link whose text is inline code shows the code without the link underline that Preview draws for it.

Example source:

```markdown
[`Code.cs:53-58`](../../../Module/Code.cs#L1-L5)
```

- Preview: `Code.cs:53-58` is drawn in the inline-code style, with the link underline.
- IR: `Code.cs:53-58` is drawn in the inline-code style, without the link underline.

## Requirements

1. **Every link is underlined in Preview and IR.** Every hyperlink shows an underline at rest, not only on hover, in every content theme and in high-contrast themes. This covers inline links, reference links, autolinks (`<https://…>` and bare URLs), HTML `<a href="…">`, links to headings and anchors in the same document, links to other files (including `file.ts:42` and `#L42` forms), and wiki links.
2. **Inline code inside a link is underlined.** When link text is, or contains, inline code, the underline runs under the code too, matching the rest of the link, in Preview and IR.
3. **One look.** The underline uses the same style, thickness and color source for every link kind within a theme, and the same in Preview and IR.
4. **Rendered state only in IR.** The underline applies while an IR link shows its rendered form. When the caret enters the link and IR reveals its Markdown markers, the source keeps today's look.
5. **Not links stay as they are.** Text that is not a hyperlink keeps today's look: plain inline code, emphasis, HTML targets without `href` (`<a id="…">`, `<a name="…">`), and footnote markers unless Part 1 shows they are links.
6. **No source change.** The fix is styling only: document text, caret, selection, dirty state and Undo history do not change.

## Open design points (settled in Part 1)

- An inventory of link kinds in Preview and IR, with today's measured underline (at rest and on hover) per content theme and in high contrast, and the rule that sets or removes it for each (Vditor's `.vditor-reset a`, a content theme, or `main.css`).
- The IR DOM of a link whose text is inline code (where `<code>` sits relative to `.vditor-ir__link` and the marker spans).
- Detected code references (`code.vmde-code-ref` and `.vmde-code-ref-chip`, for text such as `src/foo.ts:42` that is not written as a link) are clickable but are not Markdown links; they keep their hover underline unless the Owner decides otherwise. When such text is also link text (as in the example), the link underline wins and must not be doubled or removed on hover.
- Whether WYSIWYG and Split's preview pane show the same gaps; fix them in this task if they share the cause, otherwise record them.

## Scope

- In: link underline CSS in Preview and IR (and WYSIWYG or Split's preview pane if they share the cause), including inline code inside links.
- Out: link colors, fonts or padding; link behaviour; underlines for text that is not a link.

## Acceptance

- [ ] For a fixture with every link kind in requirement 1, each link in Preview and in IR (rendered state) has a computed `text-decoration-line` of `underline` at rest, in light, dark and high-contrast themes and in every bundled content theme.
- [ ] For the example source, the inline code inside the link is underlined in Preview and IR, with the same underline style and color as the rest of the link.
- [ ] With the caret inside an IR link (markers revealed), the source look is unchanged from today.
- [ ] Plain inline code, emphasis, HTML targets without `href`, and detected code references outside links are unchanged.
- [ ] Document text, caret, selection, dirty state and Undo history are unchanged.
- [ ] A focused Chromium check and a real-VS-Code spec are written and run; network-free gates pass at closure.

## Tests

- Chromium: a fixture with every link kind plus non-link controls; computed `text-decoration` per element in Preview and IR, per content theme and in high contrast; the example's `<code>`; the caret-inside state.
- Real VS Code (`test/vscode-e2e/`): the same fixture in IR and Preview in the real webview, measured computed style for each link kind and the example.
