# Task 662 — Verify link underline for visited links and forced colors

**Status:** open.
**Origin:** Project Owner request (known issue from Task 647).
**Severity:** low.
**Tech stack:** webview Preview and IR link styling; theme CSS.
**Related:** [Task 647](done/647-ir-inline-code-in-link-underline.md) (IR inline code in link underline).

## Problem

The `a:visited` state and forced colors (Windows high contrast) were not verified for the new link underline in Preview and IR, which Task 647 introduced.

## Requirements

1. The link underline is present and legible for `a:visited` in Preview and IR.
2. The link underline is present and legible under forced colors in Preview and IR.
3. If either state fails, fix it.

## Open design points

- To be settled in Part 1.

## Scope

- In: link underline in Preview and IR for `a:visited` and forced colors.
- Out: link styling not related to the underline.

## Acceptance

- [ ] The underline is present and legible for visited links in Preview.
- [ ] The underline is present and legible for visited links in IR.
- [ ] The underline is present and legible under forced colors in Preview.
- [ ] The underline is present and legible under forced colors in IR.

## Tests

- Verification of the four states above in the webview. Exact specs are to be specified in Part 1.
