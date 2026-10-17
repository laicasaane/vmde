# Task 653 — Outline toggle adds an Undo step with no Markdown change

**Status:** open.
**Origin:** Project Owner request (follow-up of Task 650).
**Severity:** low.
**Tech stack:** webview (toolbar Outline button, Vditor undo history, outline decorations).
**Related:** [Task 650](done/650-remember-outline-open-state-and-width.md) (remember Outline open state and width).

## Problem

A click on the toolbar Outline button with the caret in the editor adds one Undo snapshot. The snapshot holds only DOM decoration (`data-vmde-foldable` attributes and a caret marker) and no Markdown change. As a result, the next Ctrl+Z does nothing visible.

The likely cause is Vditor's `Outline.toggle` calling `setSelectionFocus` on the click path.

## Requirements

1. A toolbar Outline click with the caret in the editor adds no Undo step that holds only decoration.
2. Ctrl+Z after such a click undoes the previous real edit, as it did before the click.
3. The Markdown and the Outline open state behave as before.

## Open design points

- Confirm the cause on the click path before changing it.
- Whether the fix belongs in the toggle path or in the undo recording.

## Scope

- In: the extra Undo step created by the toolbar Outline click.
- Out: Outline open state and width memory (Task 650) and other toolbar actions.

## Acceptance

- [ ] After an edit, a toolbar Outline click followed by Ctrl+Z undoes that edit, not nothing.
- [ ] The Outline opens and closes as before.
- [ ] Saved Markdown is unchanged by the click.

## Tests

- To be specified in Part 1 (webview behaviour; real-VS-Code verification is required for behaviour that depends on the VS Code integration).
