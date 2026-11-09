# Task 722 — List bullet and its fold control are misaligned vertically

**Status:** planned (2026-11-09).
**Origin:** Owner report with a screenshot, 2026-11-09.
**Severity:** low (estimated). Visual defect on every foldable list item.
**Tech stack:** list fold gutter (section fold, `section-fold` CSS and placement code), list marker styling in `main.css` and the content themes.
**Depends on:** none. Related: Task 721 (fold controls in Preview) should reuse the corrected alignment.

## Problem

Owner report: the bullet of a list item and its fold control (the triangle) are misaligned vertically. In the Owner's screenshot the bullet sits clearly above the fold triangle instead of on the same center line.

Not yet known: which modes (IR, WYSIWYG) and content themes show it, whether it depends on font size or line height, and whether ordered-list numbers and task-list checkboxes are affected too.

## Proposed work

1. Measure the bullet and fold-control boxes (vertical centers) in IR and WYSIWYG, for each content theme, at the default and a larger font size, for bullet, ordered and task lists, and nested levels.
2. Align the fold control's vertical center to the marker's (or the first text line's) center.
3. Add a real-VS-Code geometry check (centers within 1 px).

## Acceptance

- [ ] Misalignment measured across modes, themes, list kinds and nesting.
- [ ] Marker and fold control centers differ by at most 1 px in every measured case.
- [ ] Focused real-VS-Code spec and `npm run quality` pass.
