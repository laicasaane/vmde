# Task 571 — Reorder the two-row toolbar controls and separators

**Status:** 📋 TODO — awaiting Project Owner ordering · **Origin:** Project Owner request, 2026-09-24 · **Related:** Tasks 492 and 563

## Goal

Change the order of the existing top-level toolbar controls and group separators to match the Project Owner's edits to the two numbered lists below. The lists record the current two-row order before responsive overflow, with wiki navigation enabled. The two wiki controls appear only when wiki navigation is enabled. Menu entries inside Headings, Math, Edit Mode, and More are not separate row controls.

The Project Owner will reorder controls and separators within or between these lists and may add or remove Separator entries. After that edit, the revised lists are the sole authority for row membership and left-to-right order. Keep each named control exactly once; Separator entries may repeat. Do not infer a preferred order or grouping from the current source.

## Row 1

1. Headings
2. Separator
3. Bold
4. Italic
5. Strikethrough
6. Subscript
7. Superscript
8. Underline
9. Separator
10. Link
11. Separator
12. Emoji

## Row 2

1. Bulleted List
2. Numbered List
3. Checklist
4. Separator
5. Outdent
6. Indent
7. Separator
8. Blockquote
9. Callout
10. Details
11. Horizontal Rule
12. Code Block
13. Inline Code
14. Math
15. Insert Before
16. Insert After
17. Separator
18. Upload
19. Table
20. Separator
21. Undo
22. Redo
23. Separator
24. Outline
25. Preview
26. Separator
27. Go Back
28. Wiki Pages
29. Separator
30. Edit In VS Code
31. Edit Mode
32. More

## Implementation contract

- [ ] Wait for the Project Owner to revise the two lists, then implement their exact control and separator placement in each row. If a control is missing or duplicated after the edit, resolve that ambiguity with the Project Owner before changing toolbar code.
- [ ] Update the authored order and row assignment together. Keep the revised relative order when controls move into More at narrow widths and when they return to a row. Keep the owner-specified separators with their adjacent groups; hide any separator whose group is absent or overflowed so no row or menu starts, ends, or doubles up with a separator. When wiki navigation is disabled, omit its controls and normalize the remaining separators in the same way.
- [ ] Preserve every control's existing action, submenu contents, tooltip, shortcut, enabled/active state, wiki availability, keyboard access, focus return, and read-only Preview behavior. Keep the toolbar at exactly two rows and preserve responsive overflow and reachable More access.
- [ ] Limit product changes to toolbar ordering and the layout/overflow/focus adjustments required to honor the revised lists. Do not implement new toolbar actions as part of this task.

## Verification for implementation

- [ ] Add or update focused unit coverage that compares the top-level control inventory, separator positions, and row order with the revised lists, including wiki enabled and disabled states.
- [ ] Verify wide and narrow Chromium toolbar layouts, separators after overflow/restore, keyboard traversal, menu access, and no missing or duplicated controls.
- [ ] Run `node build.mjs`, then write and run a focused real-VS-Code spec under `xvfb-run` for the revised two-row order and responsive behavior in the actual webview.
- [ ] Run applicable focused gates and `npm run quality` from `DEVELOPMENT.md`; record actual outcomes and any limitations before closing this task.
