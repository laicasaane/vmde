# Task 640 — Prioritized wrap points for long unbroken text in table cells

**Status:** planned (2026-10-15).
**Origin:** Project Owner feature request (chat, 2026-10-15).
**Severity:** feature (readability of tables with long paths and identifiers).
**Tech stack:** TypeScript webview (table rendering and `media-src/src/chrome/responsive-tables.ts`), table CSS (`media-src/src/main.css`), Vitest, Chromium, real VS Code.
**Related:** [Task 639](done/639-content-aware-table-column-widths.md) (content-aware column widths), [Task 219](219-table-column-resize.md) (column resize), [Task 369](369-table-inline-code-row-height-delta.md) (table row height).

## Problem

A table cell that holds a long unbroken run of text, such as a file path or an identifier in inline code, wraps at arbitrary characters. Table cells use `overflow-wrap: anywhere` (`media-src/src/main.css`), so a line can break in the middle of a word, for example between two letters of a class name, even when a slash, a dot or a word boundary nearby would read much better.

## Example (Project Owner)

```
| `../EncosyTower.Tests.EditorMode/EncosyTower.PageFlows/PageFlowTestDoubles.cs` | `TestFlowContext` gains `public Option<IPageOwnershipTracker> OwnershipTracker { get; set; }` after `FlowScopeCollectionApplier` (default none) |
```

## Requested behavior (Project Owner, verbatim)

"I expect that the first column will be wrapped at characters following this order:

1. Prioritize wrapping at non-alphanumeric characters such as `<space>`, `/`, `.`, `,`, etc
2. Wrap at numeric characters
3. Wrap at position after a lowercase and before the immediate uppercase: `TableList` => wrap at after character `e`"

## Constraints

- View-only: no change to the markdown source, the host bytes, the dirty state or Undo history. Any break hint added to the rendered DOM must be invisible to serialization (see the `vmde-lute-features` skill).
- Works with Task 639's column widths (min-content measurement) and Task 219's manual resize.
- Caret movement, selection and copy inside the cell keep the original text (no inserted characters in copied text).
- Large documents must not open or scroll slower (Task 573).

## Acceptance

- [ ] In the example table, the first column wraps only at the priority-1 positions when they are enough to fit the column, uses priority-2 positions only when a priority-1 segment is still too wide, and priority-3 positions only after that; a break inside a word happens only as a last resort.
- [ ] The same rule applies in IR, WYSIWYG and Preview (SV shows source text; record its behavior).
- [ ] Source bytes, dirty state, Undo history, caret movement and copied text are unchanged.
- [ ] Focused Chromium and real-VS-Code tests written and run; network-free gates pass.

## Open questions for Part 1

- Which cells: every table cell, or only cells whose content overflows the column?
- Which content: inline code only, or any text run (links, plain words)?
- Exact break position for priority 1 (before or after the separator character).
