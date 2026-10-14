# Task 639 — Content-aware table column widths

**Status:** planned (2026-10-14). The Project Owner requested this task on 2026-10-14. Implementation has not started.
**Origin:** Project Owner feature request (chat, 2026-10-14).
**Severity:** feature (medium value; readability of every table).
**Tech stack:** TypeScript webview (`media-src/src/chrome/responsive-tables.ts`, `media-src/src/chrome/table-resize.ts`), table CSS (`media-src/src/main.css`), Vitest, Chromium, real VS Code.
**Related:** [Task 219](done/219-table-column-resize.md) (view-only column resize), [Task 369](done/369-table-inline-code-row-height-delta.md) (table row height), [Task 573](done/573-large-document-open-scroll-performance.md) (visible-only table resize at open).

## Problem

Tables split the available width equally between columns. A column that holds only short values (an ID, a status, a number, a date) gets as much width as a column of long prose. The long columns then wrap into many lines, and the table grows much taller than it needs to be, which makes it hard to read.

## Current code

- `media-src/src/chrome/responsive-tables.ts` normalizes every table to `table-layout: fixed; width: 100%` and removes any width on `col`, `th` and `td`, unless the user resized the table (Task 219 session widths).
- `media-src/src/main.css` (`.vditor-reset table`) also sets `table-layout: fixed` "for even column fit".
- With fixed layout and no column widths, the browser gives every column the same width.

## Requested behavior

Assign column widths reasonably instead of equally. Columns with short text take only the width they need, so columns with long text get the rest of the width and wrap less. The table becomes shorter and easier to read.

## Default decisions (Project Owner may override)

- Allocation rule, per table, from measured content widths of each column (min-content: the longest unbreakable word; max-content: the longest unwrapped line):
  1. A column whose max-content fits within an equal share of the available width gets its max-content (no wrapping for short columns).
  2. The remaining width goes to the other columns in proportion to their max-content, but never below their min-content.
  3. When the sum of min-content widths exceeds the available width, keep today's overflow behavior (horizontal scroll), with each column at its min-content.
  4. Respect a small minimum column width (the Task 219 minimum) and cell padding.
- The table still fills the available width (`width: 100%`) unless all columns fit at their max-content; then the table may keep 100% with the slack spread proportionally (no visual change from today's full-width tables).
- A user's manual resize (Task 219 session widths) always wins over the automatic widths for that table.
- Stability while editing: widths are computed when a table first renders, when its column count or the available width changes, and after typing pauses (debounced). They do not change on every keystroke, so the caret and the row being typed in do not jump.
- Performance: keep Task 573's visible-only work at open; measure only tables in or near the viewport and cache per table until its content or width changes. Large documents must not open slower.
- Applies to IR, WYSIWYG and Preview. SV shows source text and is out of scope.
- View-only: no change to the markdown source, the host bytes, the dirty state or Undo history.

## Acceptance

- [ ] On a fixture table with short columns (ID, status, date) and long prose columns, short columns do not wrap and the table is clearly shorter than with equal widths (record both heights).
- [ ] A table whose columns are all similar keeps roughly equal widths (no regression).
- [ ] A table too wide for the view still scrolls horizontally as today.
- [ ] Manual column resize (Task 219) still works and overrides automatic widths; its handles line up with the new widths.
- [ ] Typing in a cell does not shift column widths on each keystroke; widths settle after the pause.
- [ ] Open time and scroll on the large fixture are not slower than the Task 573 baseline (record numbers).
- [ ] Source bytes, dirty state and Undo history are unchanged by layout.
- [ ] Focused real-VS-Code spec written and run in IR, WYSIWYG and Preview; `npm run quality` passes.

## Tests

- Vitest: the pure allocation function (short and long mix, all short, all long, min-content overflow, single column, minimum width, rounding to the available width).
- Chromium harness: rendered widths and table height on the fixture versus equal widths; manual resize precedence; typing stability; Task 369 row-height checks stay green.
- Real VS Code (`test/vscode-e2e/`): the fixture in IR, WYSIWYG and Preview; host bytes clean. Geometry assertions are allowed here because the defect is geometric; measure them as `vmde-visual-debugging` describes. Run `node build.mjs` first, then the spec under `xvfb-run`.
