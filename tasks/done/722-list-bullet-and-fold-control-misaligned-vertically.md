# Task 722 — List bullet and its fold control are misaligned vertically

**Status:** done (2026-11-10).
**Origin:** Owner report with a screenshot, 2026-11-09.
**Severity:** low (estimated). Visual defect on every foldable list item.
**Tech stack:** list fold gutter (section fold, `section-fold` CSS and placement code), list marker styling in `main.css` and the content themes.
**Depends on:** none. Related: Task 721 (fold controls in Preview) should reuse the corrected alignment.

## Problem

Owner report: the bullet of a list item and its fold control (the triangle) are misaligned vertically. In the Owner's screenshot the bullet sits clearly above the fold triangle instead of on the same center line.

Not yet known: which modes (IR, WYSIWYG) and content themes show it, whether it depends on font size or line height, and whether ordered-list numbers and task-list checkboxes are affected too.

## Decisions

- D1 (Owner, 2026-11-10; first recorded as provisional): the fold triangle follows the bullet's centre on one vertical line; the bullet does not move. The Task 569 stacked layout stays (triangle directly beneath its marker); the fix moves the triangle so its horizontal centre equals the painted marker's centre within 1 px.

## Findings

- Cause: `listSymbolMetrics` in `media-src/src/nav/section-fold.ts` modelled the bullet centre as half a line box before the text. Chromium paints disc, circle and square markers as shapes sized from the marker font's integer ascent A (box starts floor(2A/3) + 8 px before the text; shape floor((floor(2A/3) + 1) / 2) px, 1 px into the box). The old model matched only near 14 px; the triangle was 2 to 5 px off at 20 and 25 px in every theme and mode.
- Fix: the bullet centre uses that geometry with the measured font ascent (fallback to the old model when it cannot be measured). Measured max offset 5.0 px before, 0.5 px after, over 320 cases (themes auto, github-light, material-dark, vscode-dark-2026; sizes default, 13, 20, 25 px; IR and WYSIWYG; bullet, ordered and task lists; levels 1 to 3; wrapped first item).
- Pre-existing, not changed: Chromium harness `section-fold.spec.ts` "list fold gutters use bounded trusted targets in both editor modes" fails the same way without this change (`.vmde-block-handle` not visible on hover).

## Proposed work

1. Measure the bullet and fold-control boxes (vertical centers) in IR and WYSIWYG, for each content theme, at the default and a larger font size, for bullet, ordered and task lists, and nested levels.
2. Align the fold control's vertical center to the marker's (or the first text line's) center.
3. Add a real-VS-Code geometry check (centers within 1 px).

## Acceptance

- [x] Misalignment measured across modes, themes, list kinds and nesting.
- [x] Marker and fold control centers differ by at most 1 px in every measured case.
- [x] Focused real-VS-Code spec and `npm run quality` pass.

## Verification

- Unit: `section-fold.test.ts` 37 passed (6 new cases fail on the old source).
- Real VS Code: `list-fold-alignment.spec.ts` (4 themes, default and 20 px, IR and WYSIWYG) failed before the fix and passes after; with `section-fold.spec.ts`: 5 passed.
- `npm run quality`: exit 0.
