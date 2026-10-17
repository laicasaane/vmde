# Task 647 — IR: inline code inside a link shows the link underline, as in Preview

**Status:** open.
**Origin:** Project Owner request.
**Severity:** low (visual consistency; no source change).
**Tech stack:** webview CSS (`media-src/src/main.css`, content themes in `media/markdown-themes/`), IR link DOM (Vditor/Lute `data-type="a"` nodes), Chromium, real VS Code.

## Problem

In Preview, a link whose text is inline code draws the link underline under the code. In IR, the same link shows the inline code without that underline, so it does not look like a link.

Example source:

```markdown
[`Code.cs:53-58`](../../../Module/Code.cs#L1-L5)
```

- Preview: `Code.cs:53-58` is drawn in the inline-code style, with the link underline.
- IR: `Code.cs:53-58` is drawn in the inline-code style, without the link underline.

## Requirements

1. **IR matches Preview.** In IR, inline code that is the text (or part of the text) of a link is underlined the same way as in Preview: same underline style, thickness and color source, in every content theme and in high-contrast themes.
2. **Rendered state only.** The underline applies while the link shows its rendered form. When the caret enters the link and IR reveals its Markdown markers, the source keeps today's look.
3. **Only code inside links.** Inline code that is not inside a link keeps today's look, including the code-reference hover underline (`code.vmde-code-ref`, for text such as `src/foo.ts:42`). Link text that is not code keeps today's look.
4. **No source change.** The fix is styling only: document text, caret, selection, dirty state and Undo history do not change.

## Open design points (settled in Part 1)

- The IR DOM of a link whose text is inline code (where `<code>` sits relative to `.vditor-ir__link` and the marker spans), and which rule in Preview draws the underline under the code today (Vditor's `.vditor-reset a`, a content theme, or `main.css`).
- How the rule interacts with `code.vmde-code-ref` when the code text looks like a file reference (as in the example), so the underline is neither doubled nor removed on hover.
- Whether WYSIWYG and Split's preview pane show the same gap; fix them in this task if they share the cause, otherwise record them.

## Scope

- In: CSS for inline code inside links in IR (and WYSIWYG or Split's preview pane if they share the cause).
- Out: changing link or inline-code colors, fonts or padding; link behaviour.

## Acceptance

- [ ] In IR, for the example source, the inline code inside the link has a computed text decoration that matches Preview's (line, style, color), in light, dark and high-contrast themes.
- [ ] With the caret inside the link (markers revealed), the source look is unchanged from today.
- [ ] Inline code outside links and link text without code are unchanged, including the code-reference hover underline.
- [ ] Document text, caret, selection, dirty state and Undo history are unchanged.
- [ ] A focused Chromium check and a real-VS-Code spec are written and run; network-free gates pass at closure.

## Tests

- Chromium: computed `text-decoration` of the `<code>` inside the link in IR versus Preview for the example; caret-inside state; controls for plain inline code, plain link text and a code reference.
- Real VS Code (`test/vscode-e2e/`): the example in IR, measured computed style in the real webview, and the same in Preview.
