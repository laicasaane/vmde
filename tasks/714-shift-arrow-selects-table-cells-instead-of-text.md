# Task 714 — Shift+Arrow selects table cells instead of text (every Markdown construct in scope)

**Status:** planned (2026-11-10). Reported by the Owner.
**Origin:** Owner report: manual reproduction in VS Code.
**Severity:** high (estimated). Shift+Arrow is the basic keyboard text selection. Inside a table cell it selects whole cells, so the user cannot select part of a cell's text from the keyboard.
**Tech stack:** `media-src/src/editing/table-cell-selection.ts` (keydown handler, about lines 371–400: plain Shift+Arrow is the rectangle key, from `2b3b5511` and Task 580 Owner Q2), `media-src/src/editing/editor-caret.ts`, `media-src/src/editing/details-selection-state.ts`, structural selection (Task 288), and the Task 580 key bindings.
**Depends on:** none.

## Problem

Steps to reproduce:

1. Create a table with 3 columns and 3 rows.
2. Put lorem ipsum text into every cell.
3. Put the caret in the center cell, in the middle of its text.
4. Press `Shift+ArrowLeft`.
5. Expected: text is selected (one character to the left of the caret).
6. Actual: a table cell is selected.
7. `Shift+ArrowRight` shows the same problem.

Source reading (not yet measured): the keydown handler in `table-cell-selection.ts` treats every plain Shift+Arrow as the cell-rectangle key, even with no rectangle active. It takes the caret's cell as the anchor and moves the rectangle focus to the neighbouring cell. Native text selection inside the cell never runs.

Not yet known: which edit modes show it (IR, WYSIWYG, SV); whether Shift+ArrowUp and Shift+ArrowDown inside a multi-line cell are affected the same way; and the first bad commit.

## Scope: every Markdown construct

The Owner asked for tests and fixes for every Markdown construct, not only tables. Keyboard selection keys must extend a text selection inside a construct, in every edit mode where the construct is editable. The keys in scope are `Shift+ArrowLeft`, `Shift+ArrowRight`, `Shift+ArrowUp`, `Shift+ArrowDown`, `Shift+Home`, `Shift+End` and word selection (`Ctrl+Shift+ArrowLeft` and `Ctrl+Shift+ArrowRight`, with the macOS equivalents). A construct must not take these keys over while the caret is inside its text. This applies to:

- Block text: paragraphs, headings, block quotes, horizontal rules (step over).
- Inline: bold, italic, strike-through, inline code, links, wiki links, footnote references, emoji, inline math, inline HTML.
- Lists: ordered, unordered, task lists, nested lists.
- Tables: cell text in head and body cells, aligned columns, tables inside lists, quotes, callouts and details.
- Code blocks (fenced and indented) and the source of every diagram engine in `diagram-kit/engine-registry.ts`.
- Math blocks.
- Callouts (GitHub alerts), `<details>` (summary and body), raw HTML blocks, the front-matter block and table, footnote definitions.
- Selection that starts in one construct and crosses into the next.

Shortcuts that this fix must not break: Task 580 bindings (Select All, Expand Selection `Shift+Alt+Right` and its platform equivalents, Undo/Redo), structural selection (Task 288), and the table cell rectangle itself. The rectangle must stay reachable from the keyboard (see Open decision).

## Open decision (for the Owner, before the fix)

When should plain Shift+Arrow in a table switch from text selection to the cell rectangle? Options:

- A (recommended): text selection while the caret can still move within the cell in that direction. The rectangle starts only when the selection already reaches the cell edge in that direction, or when a rectangle is already active.
- B: the rectangle needs a separate chord, and plain Shift+Arrow is always text selection.
- C: the rectangle starts only when the whole cell text is already selected.

## Proposed work

1. Reproduce in real VS Code in IR, WYSIWYG and SV with the 3×3 lorem ipsum table, for Shift+ArrowLeft, Right, Up and Down. Record the selection (DOM range and text) and whether the rectangle state is set.
2. Find the first bad commit (`2b3b5511` and the Task 580 changes are candidates).
3. Build one fixture with every construct in the scope list, with text long enough to place the caret in the middle. For each construct, edit mode and key in scope, record whether the key extends a text selection as expected.
4. Get the Owner's decision on the rectangle trigger, then fix with failing tests first.

## Acceptance

- [ ] The table case is measured in IR, WYSIWYG and SV, with the cause and the first bad commit.
- [ ] Every construct, edit mode and key in the scope list is recorded as working or failing, with the cause.
- [ ] A real-VS-Code spec (OS-level XTEST keys) fails before the fix and passes after it. It covers the table case and every construct in the scope list, per edit mode.
- [ ] Keyboard text selection works inside every construct, and the cell rectangle still works as the Owner decided.
- [ ] Task 580 bindings, structural selection and the existing table-selection specs still pass.
- [ ] `npm run quality` passes.

## Tests to write

- Vitest: the `table-cell-selection.ts` keydown decision (text selection inside a cell versus rectangle start or extension) for each arrow key, at the cell edge and in the middle.
- Real-VS-Code spec, XTEST keys: the 3×3 table case, then the all-constructs fixture. For each construct, edit mode and key, assert the selected text after the key press, so a failure names the construct, mode and key.
