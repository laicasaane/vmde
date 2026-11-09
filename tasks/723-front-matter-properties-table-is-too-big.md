# Task 723 — Front-matter properties table is too big

**Status:** planned (2026-11-10).
**Origin:** Owner request with a screenshot, 2026-11-10.
**Severity:** medium (estimated). The properties table (Task 207) takes far more space than its content needs at the top of every document with front matter.
**Tech stack:** front-matter properties table (Task 207: renderer, copy buttons, CSS in `main.css` and the content themes), extension settings in `package.json` `contributes.configuration` and the host-to-webview settings path.
**Depends on:** none.

## Problem

Owner request: the YAML front-matter table is too big. In the Owner's screenshot (dark theme) each row is about twice the height of its text line, and the name column takes about half the width although the longest name is short, leaving a wide empty gap before the name cell's copy button.

## Required changes (Owner)

1. Row height fits the text inside, given the table's font size and font family, with a reasonable amount of padding around the text (amended by the Owner 2026-11-10; this replaces the first wording "half the current height").
2. The first column is only as wide as the longest property name, plus its copy button, plus a very small gap after the longest name. No large empty space.
3. The second column fills the remaining width.
4. New settings change the front-matter table's font size and font family, separate from the other font settings.

Open before implementation: the setting names and defaults (for example, a size and a family under the existing `vmde.` setting groups, with an empty or inherit default), and whether they apply in every mode (IR, WYSIWYG, Split View preview, Preview). Settle them in the contract step and ask the Owner if unclear.

## Proposed work

1. Measure the current row height and column widths in every mode and content theme.
2. Fix the row padding and line height, and size the name column to its content (for example `width: 1px; white-space: nowrap` or `max-content` sizing) with the copy button kept inside it.
3. Add the two settings, applied live, with a unit test for the settings plumbing.
4. Real-VS-Code geometry check: row height equals the text line box plus the stated padding, for the default and a changed font size and family, name column width equal to longest name + button + small gap (stated tolerance), value column fills the rest, settings change the font live.

## Acceptance

- [ ] Row height equals the text line height plus a small, stated padding (within 1 px) in every mode and theme, and follows a changed font size and family.
- [ ] The name column fits the longest name, its copy button and a small gap; the value column fills the remaining width.
- [ ] The font size and font family settings change only the front-matter table, live.
- [ ] Copy buttons still work; saved Markdown is unchanged.
- [ ] Focused real-VS-Code spec and `npm run quality` pass.
