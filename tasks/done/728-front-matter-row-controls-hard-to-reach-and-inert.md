# Task 728 — Front-matter row controls are hard to reach and do nothing

**Status:** done (2026-11-10).
**Origin:** Owner report, 2026-11-10, after Task 725.
**Severity:** high. Task 725's Add, remove and reorder controls do not work for the user.
**Tech stack:** `media-src/src/editing/front-matter-editor.ts`, `front-matter-table.ts`, `media-src/src/main.css` (Task 725 editing styles), real-VS-Code spec `test/vscode-e2e/front-matter-edit.spec.ts`.
**Depends on:** Task 725 (done).

## Owner report

1. The drag handle and the remove button are hard to click: they disappear when the pointer leaves the table.
2. "+ Add property" should sit closer to the table.
3. "+ Add property", drag and remove do nothing when used.
4. Suggestion: in edit mode (IR, WYSIWYG) the drag handle is always visible, inside the first column near its left edge, with a small padding between the handle and that edge.
5. The remove button sits close to the right edge of the second column, outside the table, and appears when the pointer is over its own region (outside the table) as well as over the row.
6. Fix the three functions.

## Decisions

- D1 (Owner, 2026-11-10): "+ Add property" adds a new last line with a placeholder name, so the front matter stays valid YAML. This replaces Task 725 Owner requirement 4 (`: ""` lines) for Add; existing empty-key rows still show as editable placeholder rows (725 D1).
- D2 (Owner, 2026-11-10): the placeholder name format is `property_<N>`, where `<N>` is an auto-incrementing number per session. The line is `property_<N>: ""`.
- D3 (Owner, 2026-11-10): when the document editor is closed and reopened, the first Add of that editor session takes its base number from the existing properties, so the new name never collides with an existing one. The Owner offered a timestamp as the other option.
- D4 (orchestrator, PROVISIONAL): use the incrementing number, not a timestamp (shorter, readable names). The first Add of an editor session (one webview for one document) uses the largest `<N>` among existing top-level `property_<N>` keys plus 1, or 1 when there is none. Each later Add in that session uses the previous number plus 1; Undo does not lower it. A number whose `property_<N>` is already a top-level key is still skipped. After Add, the new row's name cell opens with its text selected, so typing replaces the placeholder name.
- D5 (Owner, 2026-11-10): opening the name cell after Add must not get in the way of several Adds in a row.
- D6 (orchestrator, PROVISIONAL): a click on "+ Add property" while the new row's name editor is open, with the placeholder unchanged, closes that editor without a write or an Undo step and adds the next row in the same click; each click is exactly one Add and one Undo step. A changed name is committed first as its own step (725 D13), then the row is added. The pointer press on Add must not be lost to the editor's blur, focus moves or a table rebuild.

## Cause

- Remove and drag: the row tools sat 3.5 px right of the value cell and were `visibility: hidden` unless the row had `:hover` or `:focus-within`. Crossing that strip dropped the row hover, the hidden tools stopped being hit-tested, and the click went to the editor (in IR it expanded the YAML source). The Task 725 spec missed it because `hover()` then `locator.click()` jumps over the strip.
- Add: a real click worked in every state tried; not reproduced as inert. The button sat 20 px below the table (Vditor's table `margin-bottom: 16px` plus 4 px).
- Undo chain (found here, already on dev at 5e7e1952): each table transaction pushed a caret-only native Undo entry, so after one Undo the next press changed nothing. Fixed in `front-matter-editor.ts` with the existing coalescing checkpoint (`checkpointEditorUndoCoalescing`); the shared Undo core is unchanged.

## Implementation decisions (worker, PROVISIONAL)

- D7: the remove button's box starts 3.5 px right of the value cell; a transparent full-height wrapper fills the gap, so the hover never drops on the way to it.
- D8: the drag handle is 16 px wide, one line box tall, aligned with the first line like the copy button.
- D9: `front-matter-table-size.spec.ts` (Task 723) now expects a 24 px name-cell left padding in IR and WYSIWYG (8 px elsewhere) to make room for the handle; row heights unchanged (30 px).
- D10: the remove button hides with `opacity`, so it stays in the Tab order and shows on focus.
- D11: Add is one transaction of two operations (append, then rename the new entry to `property_<N>`): one Undo step, and the text never holds an empty key. `src/shared/front-matter-edit.ts` is unchanged.
- D12: the `property_<N>` counter is webview module state, reset when the editor installs and when it is disposed.
- D13 (orchestrator): Ctrl+Z inside the name editor that Add opened does nothing until the editor closes; kept, per the approved Task 725 D25.

## Acceptance

- [x] A real mouse click on "+ Add property" appends a `property_<N>: ""` row (D1–D4) and the front matter still parses, in IR and WYSIWYG; several Adds give unique names; N quick clicks in a row (name editor open after each) give exactly N rows and N Undo steps (D5, D6).
- [x] A real mouse click on the remove button removes that row, in IR and WYSIWYG.
- [x] A real mouse drag of the handle reorders rows, in IR and WYSIWYG.
- [x] Each action is one Undo step and changes only its own bytes (Task 725 rules kept).
- [x] The drag handle is always visible in IR and WYSIWYG, inside the first column at its left edge with a small padding; Preview and Split's preview pane show no handle.
- [x] The remove button sits just outside the right edge of the value column and stays visible while the pointer moves from the row to the button and while it is over the button.
- [x] "+ Add property" sits close under the table.
- [x] Focused real-VS-Code spec and `npm run quality` pass.

## Verification (orchestrator, 2026-11-10)

- `node build.mjs`: exit 0. `npm test`: 9430 passed, 1 expected fail.
- Real VS Code, through the wrapper: `front-matter-row-controls.spec.ts` (new, real pointer), `front-matter-edit.spec.ts`, `front-matter-table.spec.ts`, `front-matter-table-size.spec.ts`, `front-matter-fold.spec.ts`, `front-matter-matrix.spec.ts`, `undo-redo-steps.spec.ts`: 26 passed.
- `npm run quality`: exit 0; every stage passes.
- Geometry (IR = WYSIWYG): handle 4.5 px from the name column's left edge; remove button 3.5 px right of the value column, centred on its row; Add 4 px under the table.
- Residual: in WYSIWYG, Vditor's block popover covers the first row's handle for about 200 ms after the caret leaves the front matter; in a pane whose right padding is under 24 px, the remove button is clipped.
