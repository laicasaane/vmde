# Task 660 — Fix section indentation residuals in Preview

**Status:** open.
**Origin:** Project Owner request (known issue from Task 649).
**Severity:** low.
**Tech stack:** Preview renderer, first-paint overlay script, and table layout in the webview.
**Related:** [Task 649](done/649-section-indentation-by-heading-level.md) (section indentation by heading level).

## Problem

Four residual issues remain from Task 649:

1. In Preview, a heading inside a raw HTML block renders as a top-level heading and is treated as a section heading. IR and WYSIWYG are unaffected.
2. The first-paint overlay script does not account for `<details>` sibling blocks.
3. The Preview footnote selector (`.footnotes-defs-div, .footnotes-defs-ol, ol.footnotes-defs`) was checked only in jsdom.
4. A table whose column minimum widths exceed the room left by the indentation overflows by the difference.

## Requirements

1. A heading inside a raw HTML block gets the correct depth in Preview.
2. The first-paint overlay marking accounts for `<details>` sibling blocks.
3. The Preview footnote selector is verified in the real webview.
4. Narrow tables have a decided behaviour. The candidate named in the brief is horizontal scroll inside the block; the decision is to be settled in Part 1.

## Open design points

- Narrow-table behaviour: to be decided in Part 1.
- To be settled in Part 1 for the other requirements.

## Scope

- In: the four residuals above.
- Out: IR and WYSIWYG section indentation, which are unaffected.

## Acceptance

- [ ] In Preview, a heading inside a raw HTML block has the correct depth and is not a top-level heading.
- [ ] `<details>` sibling blocks are marked correctly by the first-paint overlay.
- [ ] The Preview footnote selector is verified in the real webview.
- [ ] A narrow table follows the decided behaviour and does not overflow the block.

## Tests

- Real-VS-Code verification for the Preview and overlay behaviour, and the footnote selector check in the real webview. Exact specs are to be specified in Part 1.
