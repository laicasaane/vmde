# Task 639 — Content-aware table column widths

**Status:** planned (2026-10-14). The Project Owner requested this task on 2026-10-14. Implementation has not started.
**Origin:** Project Owner feature request (chat, 2026-10-14).
**Severity:** feature (medium value; readability of every table).
**Tech stack:** TypeScript webview (`media-src/src/chrome/responsive-tables.ts`, `media-src/src/chrome/table-resize.ts`), table CSS (`media-src/src/main.css`), Vitest, Chromium, real VS Code.
**Related:** [Task 219](done/219-table-column-resize.md) (view-only column resize), [Task 369](done/369-table-inline-code-row-height-delta.md) (table row height), [Task 573](done/573-large-document-open-scroll-performance.md) (visible-only table resize at open).

## Problem

Tables split the available width equally between columns. A column that holds only short values (an ID, a status, a number, a date) gets as much width as a column of long prose. The long columns then wrap into many lines, and the table grows much taller than it needs to be, which makes it hard to read.

## Current code

- `media-src/src/chrome/responsive-tables.ts` normalizes every table to `table-layout: fixed; width: 100%` and removes any width on `col`, `th` and `td`, unless the user resized the table (Task 219 session widths).
- `media-src/src/main.css` (`.vditor-reset table`) also sets `table-layout: fixed` "for even column fit".
- With fixed layout and no column widths, the browser gives every column the same width.

## Requested behavior

Assign column widths reasonably instead of equally. Columns with short text take only the width they need, so columns with long text get the rest of the width and wrap less. The table becomes shorter and easier to read.

## Default decisions (Project Owner may override)

- Allocation rule, per table, from measured content widths of each column (min-content: the longest unbreakable word; max-content: the longest unwrapped line):
  1. A column whose max-content fits within an equal share of the available width gets its max-content (no wrapping for short columns).
  2. The remaining width goes to the other columns in proportion to their max-content, but never below their min-content.
  3. When the sum of min-content widths exceeds the available width, keep today's overflow behavior (horizontal scroll), with each column at its min-content.
  4. Respect a small minimum column width (the Task 219 minimum) and cell padding.
- The table still fills the available width (`width: 100%`) unless all columns fit at their max-content; then the table may keep 100% with the slack spread proportionally (no visual change from today's full-width tables).
- A user's manual resize (Task 219 session widths) always wins over the automatic widths for that table.
- Stability while editing: widths are computed when a table first renders, when its column count or the available width changes, and after typing pauses (debounced). They do not change on every keystroke, so the caret and the row being typed in do not jump.
- Performance: keep Task 573's visible-only work at open; measure only tables in or near the viewport and cache per table until its content or width changes. Large documents must not open slower.
- Applies to IR, WYSIWYG and Preview. SV shows source text and is out of scope.
- View-only: no change to the markdown source, the host bytes, the dirty state or Undo history.

## Acceptance

- [ ] On a fixture table with short columns (ID, status, date) and long prose columns, short columns do not wrap and the table is clearly shorter than with equal widths (record both heights).
- [ ] A table whose columns are all similar keeps roughly equal widths (no regression).
- [ ] A table too wide for the view still scrolls horizontally as today.
- [ ] Manual column resize (Task 219) still works and overrides automatic widths; its handles line up with the new widths.
- [ ] Typing in a cell does not shift column widths on each keystroke; widths settle after the pause.
- [ ] Open time and scroll on the large fixture are not slower than the Task 573 baseline (record numbers).
- [ ] Source bytes, dirty state and Undo history are unchanged by layout.
- [ ] Focused real-VS-Code spec written and run in IR, WYSIWYG and Preview; `npm run quality` passes.

## Tests

- Vitest: the pure allocation function (short and long mix, all short, all long, min-content overflow, single column, minimum width, rounding to the available width).
- Chromium harness: rendered widths and table height on the fixture versus equal widths; manual resize precedence; typing stability; Task 369 row-height checks stay green.
- Real VS Code (`test/vscode-e2e/`): the fixture in IR, WYSIWYG and Preview; host bytes clean. Geometry assertions are allowed here because the defect is geometric; measure them as `vmde-visual-debugging` describes. Run `node build.mjs` first, then the spec under `xvfb-run`.

## Part 1 handoff (2026-10-14)

Read-only review of the source; nothing was built or run.

- **Cause (verified).** `media-src/src/chrome/responsive-tables.ts` `normalizeResponsiveTables` sets `table-layout: fixed !important; width: 100%` on every `.vditor-reset` table and strips width, min-width, max-width and white-space from `col`, `th` and `td`; with fixed layout and no widths every column is equal. `media-src/src/main.css` repeats the fixed layout and sets `overflow-wrap: anywhere` on cells, and the build patches Vditor's cells to `word-break: break-word`, so CSS min-content is about one character — a real min-content measurement must set both back to `normal`. Callers in `boot/finish-init.ts` (`fixResponsiveTables`, `installTableColumnResize`). Task 219 session widths (`table-resize.ts`): a table class plus a head `<style>` of `nth-child` `width: Npx !important` rules keyed by a WeakMap, 48 px floor; the handles read live header rects (`measuredWidths`), so they follow any applied widths. Task 573's visible-only work is an IntersectionObserver in `table-resize.ts`, not in the normalizer (which does a full pass on every resize) — the new measuring needs its own visibility gate. Measuring precedent: `autoFitWidth` clones cells into `body` with nowrap (padding fidelity unverified). Today plain fluid tables never scroll horizontally (cells break anywhere); only resized tables scroll (IR-only rule `.vditor-ir__node:has(> table.vmde-table-resized) { overflow-x: auto }`).
- **Contract (record defaults, refined).** Inputs per column from rectangular tables only (as `headerCells`, Preview included): minᵢ = max(48, min-content with wrap/break `normal`), maxᵢ = max(minᵢ, max-content with nowrap), both border-box; W = the table's current width. (1) Iterative equal share: share = R/k; every column with maxᵢ ≤ share takes maxᵢ, then the share is recomputed for the rest (at most n passes). (2) When Σmax ≤ W: every column gets maxᵢ and the slack is spread in proportion to maxᵢ (similar tables come out about equal). (3) Long columns split the remainder in proportion to maxᵢ, water-filling at minᵢ. (4) When Σmin > W: no new horizontal scroll — scale in proportion to minᵢ to fit W and keep breaking long words as today. (5) Integer px with largest-remainder rounding, Σ = floor(W). (6) Precedence: session widths (Task 219) win — auto widths are not written and the auto class is removed; when session widths are cleared (rebuild or reopen) the table falls back to auto; a drag starts from the auto widths (no jump). (7) Writing: a separate class `vmde-table-auto-N` plus a head `<style>` with non-important `nth-child` width rules; nothing in a colgroup or the Lute DOM; the normalizer keeps stripping inline widths and leaves the auto class alone. (8) Recompute: first time near the viewport (IntersectionObserver on the editor scroller with about one viewport of margin), on column-count change, on a W change ≥ 1 px (off-screen tables marked stale), and after a typing pause of about 600 ms; skip updates where every column moves < 2 px; cache per table {W, column count, dirty, widths}. (9) No change to markdown, host bytes, dirty state or Undo; SV untouched.
- **Part 2.** S1: new fixture under `media-src/e2e/fixtures/` with three tables — (a) ID/status/date columns plus two long prose columns, (b) all-similar columns, (c) over-wide; per table in IR, WYSIWYG and Preview record each column's width, table height and horizontal overflow; Probe 1: does the `table` element and its class survive a keystroke in a cell (IR and WYSIWYG)? Probe 2: do clone widths match in-place auto-layout widths within 1 px? S2a: pure `allocateColumnWidths({min, max, available, minimum})` in a new `media-src/src/chrome/table-column-widths.ts` with Vitest (mix, all short, all long, Σmin overflow, single column, 48 px floor, rounding Σ = floor(W), iterative-share case). S2b: measurement by cloning into a hidden host appended to `body` outside the observers' root, copying the `.vditor-reset` and theme/mode classes, two layouts (`table-layout: auto` max-content nowrap, then min-content with normal wrap), reading first-row cell widths — or, if Probe 2 fails, a per-table head-style toggle read in place; writer next to the normalizer with an auto-class exemption; extend `isResizeWidthClassMutation` to ignore `vmde-table-auto-*`; if Probe 1 shows rebuilds, re-apply cached widths to the replacement synchronously in the MutationObserver callback (matched by table index and column count, then marked dirty) so widths do not flash back on each keystroke. Chromium tests (`table-resize.spec.ts` or new `table-auto-width.spec.ts`): fixture (a) at least 25% shorter than the equal-width baseline (threshold confirmed against S1), short columns on one line, fixture (b) max/min column ratio ≤ 1.15, fixture (c) no new horizontal scroll, a resize beats auto widths with handles within 3 px of borders, widths stable across 10 keystrokes and settled once after the pause, Task 369 row-height checks green, no reads of off-screen tables. S3: real-VS-Code `test/vscode-e2e/table-auto-width.spec.ts` (IR, WYSIWYG, Preview: widths, height vs the S1 baseline, resize precedence and alignment, exact host/disk bytes, dirty state, Undo), reruns of `table-column-resize.spec.ts` and `large-document-interaction.spec.ts`, and the Task 573 open/scroll gate on the large fixture (open-to-ready, long tasks, scroll p95/max vs the recorded baseline, zero off-screen header reads). S4: closure.
- **Edge cases.** colspan/rowspan, nested tables, tables in list items or blockquotes, HTML-block tables keep today's equal layout; empty cells, images, inline code (Task 369's zero-width markers), wide-glyph/CJK text; font loading (`document.fonts` `loadingdone` marks tables dirty); content-visibility skipped blocks (measure only near the viewport); mode switch and re-init (dispose observers and style elements as Task 219 does); hidden or zero-width surface (skip); table height changing above the viewport (verify scrollTop stays stable).
- **Decisions (provisional, reversible).** (1) Rule 3 vs today: the record says "scroll as today", but fluid tables never scroll today — no new scroll; fit W in proportion to min-content; scrolling stays limited to resized tables — adopted. (2) Typing-pause recompute while the caret is in the table moves the edited row once after the pause (the record accepts this): ~600 ms with 2 px hysteresis — adopted.
- **Risks.** Table rebuild on keystroke (Probe 1); clone style fidelity (Probe 2); border-collapse box model when converting measured to assigned width (must round-trip with Task 219 within 1 px); measurement cost on large files (S3 gate).

## Part 2 S1 record (2026-10-14): Chromium baseline and probes

Measurement only; no source change. Fixture: `media-src/e2e/fixtures/table-widths.md` with three tables: (a) five columns, ID/status/date plus two long prose columns, 3 body rows; (b) four similar short columns, 3 body rows; (c) eight columns of long single words, 2 body rows. The measurement spec and its temporary Playwright config were kept outside the repo under the ignored `tmp/639/` (non-asserting; run with `npx playwright test -c ../tmp/639/playwright.config.ts` from `media-src`, `xvfb-run -a`). Column widths are the first-row cell border-box widths in px. The harness page (IR, then WYSIWYG via the edit-mode toolbar, then Preview via the preview overlay render) was used at 1280x800 and 800x800. The worktree needed `node build.mjs` once to create the ignored `media/vditor` before the harness server could serve the page.

Baseline (identical in IR, WYSIWYG and Preview except Preview heights):

| Viewport | Table | Table width | Columns (equal share) | Height IR / WYSIWYG / Preview | Overflow (table, parent, surface) |
| --- | --- | --- | --- | --- | --- |
| 1280 | a | 800 | 159.8 x5 (last 159.81) | 665 / 665 / 692.56 | 0 / 0 / 0 |
| 1280 | b | 800 | 199.75 x4 | 149 / 149 / 149 | 0 / 0 / 0 |
| 1280 | c | 800 | 99.88 x8 | 190 / 190 / 195.91 | 0 / 0 / 0 |
| 800 | a | 728 (Preview 778) | 145.39 x4, 145.44 (Preview 155.39 x4, 155.44) | 686 / 686 / 692.56 | 0 / 0 / 0 |
| 800 | b | 728 (Preview 778) | 181.75 x4 (Preview 194.25) | 149 / 149 / 149 | 0 / 0 / 0 |
| 800 | c | 728 (Preview 778) | 90.88 x8 (Preview 97.13) | 235 / 235 / 197.92 | 0 / 0 / 0 |

So no table scrolls horizontally today; table (c) at 800 wraps long words to 235 px height in IR and WYSIWYG.

Content-derived widths (same in all modes and viewports; border-box, from the probe 2 in-place layouts):

- (a) min-content: 53.72, 81.88, 67.69, 117.56, 117.03 (sum 437.9). max-content: 66.05, 81.88, 108.38, 977.88, 917.78 (sum 2151.97). Auto layout at W=800: 56.31, 81.88, 76.25, 298.81, 285.75; at W=728: 55.8, 81.88, 74.55, 262.67, 252.11 (Preview W=778: 56.16, 81.88, 75.73, 287.77, 275.47).
- (b) min-content: 72.08, 76.94, 82.69, 69.5. max-content: 98.98, 113.02, 105.78, 105.58 (sum 423.36, below W so contract step 2 applies; max ratio 1.14). Auto at W=800: 186.8, 213.28, 199.63, 199.3 (ratio 1.14).
- (c) min-content equals max-content: 165.53, 189.55, 225.34, 210.11, 200.86, 179.72, 194.03, 187.61 (sum 1552.75, above W, so contract step 4 applies). Auto layout at any W keeps these widths, which would scroll horizontally by 752.75 px at W=800 and 824.75 px at W=728.

Reference for the S2 thresholds: the equal-width height of table (a) is 665 px (IR and WYSIWYG, 1280) and 686 px (800); the 25% reduction target must be confirmed against heights measured with the new widths.

Probe 1 (keystroke inside a cell, real pointer click then keyboard, Chromium harness, 1280): in both IR and WYSIWYG the edited table is replaced by a new element after the first keystroke (new table, new test cases, the test class is gone) and stays replaced after 6 keystrokes; the other two tables keep identity and class. Result: rebuild on keystroke is confirmed, so the widths must be re-applied to the replacement synchronously (as the S2b note says) and the auto class must be re-added. Not measured: whether every later keystroke replaces the table again (only the first and the burst end state were compared).

Probe 2 (clone widths versus in-place auto layout): the clone sits in a hidden host appended to `body`, outside the editor, with the `.vditor` and `.vditor-reset` class names copied and the container width set to the table parent's client width. For three layouts (max-content nowrap, min-content wrap normal, auto at W with wrap normal), 3 tables, 3 modes, 2 viewports (54 comparisons), the largest per-column difference is 0 px, so the 1 px bar is met. The in-place layout was forced with inline important table-layout/width and cell wrap/break values and then restored. Caveat: only the first-row cells were read and the fixture has no padded, CJK or image cells.
