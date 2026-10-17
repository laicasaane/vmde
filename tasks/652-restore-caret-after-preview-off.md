# Task 652 — Restore caret and selection after Preview is turned off

**Status:** open.
**Origin:** Project Owner request (follow-up of Task 651).
**Severity:** low to medium (the caret position is lost on every Preview toggle).
**Tech stack:** webview (Vditor Preview overlay in IR, WYSIWYG and Split source panes).
**Related:** [Task 651](done/651-remember-preview-toggle-state.md) (remember Preview toggle state).

## Problem

Vditor's Preview overlay collapses the editor selection and moves the caret on every Preview toggle. Turning Preview on hides the focused pane. The same happens on any click on the Preview control.

## Requirements

1. After Preview is turned off, the caret and selection return to the position they had before Preview was turned on, in IR, WYSIWYG and Split source.
2. Turning Preview on and off does not change the saved Markdown.

## Open design points

- Where the selection is captured and restored: the Preview toggle path, the Vditor overlay, or both.
- Behaviour when the document changes while Preview is open.

## Scope

- In: caret and selection restore after Preview is turned off, in IR, WYSIWYG and Split source.
- Out: Preview rendering, Preview toggle state memory (Task 651), and any other pane behaviour.

## Acceptance

- [ ] In IR, WYSIWYG and Split source, the caret and selection are unchanged after a Preview on and off cycle.
- [ ] A click on the Preview control has the same result as the toolbar toggle.
- [ ] Saved Markdown is unchanged by the cycle.

## Tests

- To be specified in Part 1 (webview behaviour; real-VS-Code verification is required for behaviour that depends on the VS Code integration).
