# Task 654 — Raw HTML links render as links in IR and WYSIWYG

**Status:** open.
**Origin:** Project Owner request (follow-up of Task 647).
**Severity:** low to medium.
**Tech stack:** webview (IR and WYSIWYG rendering of inline raw HTML).
**Related:** [Task 647](done/647-ir-inline-code-in-link-underline.md) (IR inline code in link underline).

## Problem

Raw HTML `<a href="…">` shows as source markers and plain text in IR and WYSIWYG. It has no link element, so it is neither a link nor underlined in those panes. Preview renders a real link.

## Requirements

1. In IR and WYSIWYG, a raw HTML `<a href="…">` element is shown as a link.
2. The link is underlined in the same way as other links in those panes.
3. The saved Markdown is unchanged.

## Open design points

- How the raw HTML anchor is recognised and displayed in IR and WYSIWYG.
- Handling of anchors without an `href`, or with other attributes.

## Scope

- In: display of raw HTML `<a href>` links in IR and WYSIWYG.
- Out: Preview, Split, and Markdown link syntax, which already render correctly.

## Acceptance

- [ ] A raw HTML `<a href="…">` in IR and in WYSIWYG renders as a link element with underline.
- [ ] Preview output for the same content is unchanged.
- [ ] Saved Markdown is byte-identical after editing and saving.

## Tests

- To be specified in Part 1 (webview behaviour; real-VS-Code verification is required for behaviour that depends on the VS Code integration).
