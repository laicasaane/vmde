# Task 726 — Pipe and backtick pasted into table-cell inline code break the table

**Status:** planned (2026-11-10).
**Origin:** found by the Task 719 paste measurement, 2026-11-10 (filed separately under 719 D3, provisional).
**Severity:** medium (estimated). Pasted text silently changes the table structure or the code span.
**Tech stack:** IR paste into inline code inside a GFM table cell (Vditor `ir/index.ts` paste, `fixBrowserBehavior.ts`), Lute table serialization, settle re-spin (`edit-activity.ts`, `vditor/ir/input.ts`).
**Depends on:** none. Related: Task 719.

## Problem

- A pasted `|` inside inline code in a table cell is saved unescaped, for example `` | row `alphax|y`z tail beta` | other | ``, so the table re-parses with a different cell layout.
- A pasted backtick inside the code span splits the span at the next settle re-spin (`edit-activity.ts:487` to `vditor/ir/input.ts:237`).

## Proposed work

1. Reproduce both in a focused real-VS-Code spec (failing first).
2. Escape `|` as `\|` inside table-cell content on paste (or on serialization), and keep a pasted backtick inside the span (for example by widening the code delimiter), without changing other cells.
3. Byte checks on the saved Markdown.

## Acceptance

- [ ] A pasted `|` in table-cell code keeps the table's cell layout; the saved Markdown escapes it.
- [ ] A pasted backtick keeps the code span whole after settle.
- [ ] Focused real-VS-Code spec and `npm run quality` pass.
