# Task 723 — Front-matter properties table is too big

**Status:** done (2026-11-10).
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

## Decisions

- D1 (Owner, 2026-11-10): settings `vmde.editor.frontMatterFontSize` (string, default `"editor"` = follow Font Size, or a pixel value 6 to 100) and `vmde.editor.frontMatterFontFamily` (string, default empty = editor font), the same pattern as `vmde.editor.sourceFontSize` and `sourceFontFamily`. They apply in IR, WYSIWYG, Split View preview and Preview. Cell padding about 4 px vertical and 8 px horizontal.

- D2 (provisional, worker, accepted by the orchestrator 2026-11-10): the table's line box is a unitless `line-height: 1.5` of the table font in every theme, so it scales with a changed table font; gap after the longest name 4 px, copy button inset 4 px, name block capped at 16em; the copy button is one line box tall; the font family setting adds no generic fallback (the description asks for one).
- D3 (provisional, orchestrator, 2026-11-10): `responsive-tables.ts` skips tables inside the properties table (its inline `table-layout: fixed !important` cannot be overridden from CSS); nested map tables are skipped too.
- D4 (provisional, orchestrator, 2026-11-10): in a narrow Split View pane the name column keeps its fitted width (D1), even if the value column wraps hard; no 35 percent cap.
## Proposed work

1. Measure the current row height and column widths in every mode and content theme.
2. Fix the row padding and line height, and size the name column to its content (for example `width: 1px; white-space: nowrap` or `max-content` sizing) with the copy button kept inside it.
3. Add the two settings, applied live, with a unit test for the settings plumbing.
4. Real-VS-Code geometry check: row height equals the text line box plus the stated padding, for the default and a changed font size and family, name column width equal to longest name + button + small gap (stated tolerance), value column fills the rest, settings change the font live.

## Acceptance

- [x] Row height equals the text line height plus a small, stated padding (within 1 px) in every mode and theme, and follows a changed font size and family.
- [x] The name column fits the longest name, its copy button and a small gap; the value column fills the remaining width.
- [x] The font size and font family settings change only the front-matter table, live.
- [x] Copy buttons still work; saved Markdown is unchanged.
- [x] Focused real-VS-Code spec and `npm run quality` pass.

## Verification (2026-11-10)

- `node build.mjs`: pass. `npm test`: 9119 passed, 1 expected fail.
- Real VS Code: `front-matter-table-size` (every mode and content theme; live size and family; copy buttons; saved bytes unchanged), `front-matter-table`, `front-matter-matrix`, `sv-source-font`, `table-auto-width`, `undo-restore-reactions`: 18 passed.
- `npm run quality`: all stages pass.
