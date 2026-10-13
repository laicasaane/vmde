# Task 632 — Rearrange toolbar buttons into conventional groups

**Status:** planned (2026-10-14). The Project Owner requested this task on 2026-10-14 and approved the reorder the same day (see Owner decision). Implementation has not started.
**Origin:** Project Owner feature request (chat, 2026-10-14).
**Severity:** feature (low risk; layout only).
**Tech stack:** TypeScript webview (`media-src/src/chrome/toolbar.ts`, `toolbar-layout.ts`, `toolbar-overflow.ts`), Vitest, Chromium, real VS Code.
**Supersedes:** the two-row order of [Task 571](done/571-reorder-two-row-toolbar-controls.md) (Owner-approved 2026-10-14). Task 571 keeps its record as history.
**Related:** [Task 631](631-toolbar-collapse-toggle.md) (collapse toggle at the end of row 1).

## Problem

The current two-row order (Task 571) mixes groups that established editors keep apart. For example, Undo/Redo sit in the middle of row 2, Inline Code is separated from the other inline formats, and block inserts (Code Block, Math, Table) are split across both rows. Users who know Word, Google Docs, Notion, Typora, Obsidian or the GitHub Markdown editor look for these controls in familiar places.

## Conventions to follow

Established editors group toolbar controls in this left-to-right order:

1. History: Undo, Redo.
2. Block type: Headings / paragraph style.
3. Inline text formatting: Bold, Italic, Underline, Strikethrough, Inline Code; then Subscript, Superscript.
4. Link.
5. Lists and indentation: Bulleted, Numbered, Checklist; Outdent, Indent.
6. Block inserts: Blockquote, Callout, Details, Code Block, Math, Table, Horizontal Rule.
7. Media and symbols: Upload (image/file), Emoji.
8. Document structure: Insert Before, Insert After.
9. View and navigation: Outline, Preview; Go Back, Wiki Pages.
10. Mode and app: Edit In VS Code, Edit Mode, More.

## Proposed order (approved by the Project Owner on 2026-10-14)

Row 1 (editing and formatting):

Undo, Redo | Headings | Bold, Italic, Underline, Strikethrough, Inline Code | Subscript, Superscript | Link | Bulleted List, Numbered List, Checklist | Outdent, Indent

Row 2 (insert, view and mode):

Blockquote, Callout, Details, Code Block, Math, Table, Horizontal Rule | Upload, Emoji | Insert Before, Insert After | Outline, Preview | Go Back, Wiki Pages | Edit In VS Code, Edit Mode, More

`|` is a separator. Go Back and Wiki Pages appear only when wiki navigation is enabled (unchanged). Task 631's toggle, when present, stays at the trailing end of row 1.

## Owner decision (2026-10-14, chat)

The Project Owner approved reordering the toolbar controls and changing their positions based on the established patterns and designs of highly regarded software and applications. The proposed order above is the approved starting point. Part 1 may refine positions within it when a well-established convention supports the change; record each refinement and its reason in this file. No further Owner approval is needed for such refinements. Adding, removing or renaming controls stays out of scope.

## Scope

- Change only the order, row membership, separators and the overflow give-way order of existing top-level controls. Overflow gives way from the end of each row by whole groups; History, Headings and More stay visible longest.
- Preserve every control's action, submenu, tooltip, shortcut, enabled/active state, wiki availability, keyboard access, focus return and read-only Preview behavior. Keep exactly two rows.
- No new controls, icons or actions.

## Acceptance

- [ ] The final order (the approved proposal plus any recorded Part 1 refinements) is recorded in this file before implementation.
- [ ] Both rows match the approved order and separators, with wiki navigation enabled and disabled; no control is missing or duplicated.
- [ ] Narrow widths overflow whole groups into More in the approved give-way order, restore them in order, and leave no leading, trailing or doubled separators.
- [ ] Keyboard traversal follows the new visual order.
- [ ] Unit inventory test, Chromium wide/narrow checks and a focused real-VS-Code spec updated and run; `npm run quality` passes.

## Tests

- Vitest: update the Task 571 inventory and row-order tests (`toolbar-layout.test.ts`, `toolbar-overflow.test.ts`) to the approved order, wiki on and off.
- Chromium harness: wide and narrow layouts, overflow and restore, separators, keyboard order.
- Real VS Code (`test/vscode-e2e/`): update the Task 571 toolbar-order spec. Run `node build.mjs` first, then the spec under `xvfb-run`.
