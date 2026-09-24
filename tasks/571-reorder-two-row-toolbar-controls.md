# Task 571 — Reorder the two-row toolbar controls and separators

**Status:** 📋 TODO — Project Owner order recorded · **Origin:** Project Owner request, 2026-09-24 · **Related:** Tasks 492 and 563

## Goal

Change the order of the existing top-level toolbar controls and group separators to match the Project Owner's two numbered lists below. These lists specify the target two-row order before responsive overflow, with wiki navigation enabled. The two wiki controls appear only when wiki navigation is enabled. Menu entries inside Headings, Math, Edit Mode, and More are not separate row controls.

The Project Owner has revised the two lists. They are the sole authority for row membership and left-to-right control and separator order. Keep each named control exactly once; Separator entries may repeat. Do not infer a preferred order or grouping from the current source.

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
11. Bulleted List
12. Numbered List
13. Checklist
14. Separator
15. Outdent
16. Indent
17. Separator
18. Blockquote
19. Callout
20. Details
21. Horizontal Rule
22. Code Block
23. Inline Code
24. Separator
25. Emoji
26. Separator
27. Math

## Row 2

1. Insert Before
2. Insert After
3. Separator
4. Upload
5. Table
6. Separator
7. Undo
8. Redo
9. Separator
10. Outline
11. Preview
12. Separator
13. Go Back
14. Wiki Pages
15. Separator
16. Edit In VS Code
17. Edit Mode
18. More

## Implementation contract

- [ ] Implement the exact control and separator placement in the two Project Owner lists. If a control is missing or duplicated after a later edit, resolve that ambiguity with the Project Owner before changing toolbar code.
- [ ] Update the authored order and row assignment together. Keep the revised relative order when controls move into More at narrow widths and when they return to a row. Keep the owner-specified separators with their adjacent groups; hide any separator whose group is absent or overflowed so no row or menu starts, ends, or doubles up with a separator. When wiki navigation is disabled, omit its controls and normalize the remaining separators in the same way.
- [ ] Preserve every control's existing action, submenu contents, tooltip, shortcut, enabled/active state, wiki availability, keyboard access, focus return, and read-only Preview behavior. Keep the toolbar at exactly two rows and preserve responsive overflow and reachable More access.
- [ ] Find or make a visible icon for the Math control, which currently has no icon configured in `media-src/src/chrome/toolbar.ts`. Check the bundled Vditor sprite and existing Codicon-style toolbar icons first; reuse a suitable math icon, or add a small source-owned icon through `media-src/src/chrome/toolbar-icons.ts`. Keep the Math menu, accessible name, tooltip, and actions unchanged.
- [ ] Limit product changes to toolbar ordering, the Math icon, and the layout/overflow/focus adjustments required to honor the revised lists. Do not implement new toolbar actions as part of this task.

## Verification for implementation

- [ ] Add or update focused unit coverage that compares the top-level control inventory, separator positions, and row order with the revised lists, including wiki enabled and disabled states.
- [ ] Verify wide and narrow Chromium toolbar layouts, separators after overflow/restore, keyboard traversal, menu access, a visible Math icon in the row and More, and no missing or duplicated controls.
- [ ] Run `node build.mjs`, then write and run a focused real-VS-Code spec under `xvfb-run` for the revised two-row order, responsive behavior, and visible Math icon in the actual webview. Inspect the icon in light, dark, and high-contrast themes.
- [ ] Run applicable focused gates and `npm run quality` from `DEVELOPMENT.md`; record actual outcomes and any limitations before closing this task.
