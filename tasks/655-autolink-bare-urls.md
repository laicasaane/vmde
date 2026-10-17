# Task 655 — Autolink bare URLs

**Status:** open.
**Origin:** Project Owner request (follow-up of Task 647).
**Severity:** low (feature).
**Tech stack:** webview and Lute options (Preview, IR, WYSIWYG and Split preview).
**Related:** [Task 647](done/647-ir-inline-code-in-link-underline.md) (IR inline code in link underline).

## Problem

Bare URLs (`https://example.com` without `<>`) are plain text in every pane.

## Requirements

1. Decide in Part 1 whether to enable GFM autolink literals (a Lute option) for Preview, IR, WYSIWYG and Split preview.
2. If enabled, bare URLs render as links in the panes covered by the decision.
3. The saved Markdown stays byte-identical. Autolinking must not rewrite the source text.

## Open design points

- Whether to enable GFM autolink literals, and for which panes.
- How the decision affects Markdown that already uses `<>` or `[text](url)` links.

## Scope

- In: the autolink decision and, if enabled, its display in the panes it covers.
- Out: other Lute options and link syntax changes.

## Acceptance

- [ ] Part 1 records the decision for each pane.
- [ ] If enabled, a bare `https://example.com` renders as a link in each covered pane.
- [ ] Saved Markdown is byte-identical after editing and saving.

## Tests

- To be specified in Part 1 (webview and Lute behaviour; real-VS-Code verification is required for behaviour that depends on the VS Code integration).
