# Task 704 — A table row with unescaped pipes in a code span loses its trailing cells

**Status:** planned (2026-11-08). Owner priority: first in the queue.
**Origin:** Owner report: `tmp/pending-questions.md` renders wrong.
**Severity:** high (estimated). The display hides text, and an edit of the table can delete that text from the saved file.
**Tech stack:** vendored Lute (`media/vditor/dist/js/lute/lute.min.js`, table parse and `VditorIRDOM2Md`); `media-src/src/bridge/incremental-md.ts` and `edit-sync.ts` (save path); `src/lute/lute-host.ts` (host prerender); IR, WYSIWYG, SV and Preview.
**Depends on:** none (D1 settled 2026-11-08).

## Problem

`tmp/pending-questions.md` line 151 (row `I57` of table 3, a 5-column table) has a code span that holds unescaped pipes:

```markdown
| I57 | Which operations … no `EnterAt`). | `Add | Enter | EnterAt | Leave | LeaveActive | LeaveAll`, as `StageListSingle`, because its replay re-enters through `EnterAtAsync`. | The task's set, which makes every replay fail. | [F11](../F11-sample-custom-kind.md) |
```

GFM splits table cells on every unescaped `|`, also inside a code span. The row therefore has 10 cells against a 5-cell header. Lute keeps the first 5 cells and ignores the rest (GFM rule: excess cells are ignored). Measured on 2026-11-08 with the vendored Lute in Node:

- `Md2HTML` and `Md2VditorIRDOM`: row `I57` shows `I57`, the question, `` `Add ``, `Enter`, `EnterAt`. The text from `Leave` to the `[F11]` link is not displayed. The opening backtick shows as a literal character.
- `VditorIRDOM2Md(Md2VditorIRDOM(md))`: the row becomes `| I57 | … | `Add | Enter | EnterAt |`. `EnterAtAsync`, the alternative column and the `[F11]` link are gone from the markdown. Any IR edit that reserializes table 3 (an edit in the table, or a structural edit next to it) writes this loss to disk.
- The full-document round trip also grows the file from 67,748 to 264,428 bytes (Lute pads every table cell). It is not yet known whether the VMDE save path keeps that padding or restores the source gaps; step 1 measures it.

All other rows of the 3 tables have the correct cell count (65 rows of 6 pipe fields, 132 rows of 7).

The display matches GFM and GitHub. The defect in VMDE is that (a) the user gets no sign that source text is hidden, and (b) editing can delete source text that the user never touched.

## Decision D1 (settled by the Owner, 2026-11-08)

Options offered: (1) GFM display, keep the source text, mark the row; (2) treat `|` inside a code span as literal; (3) GFM display, keep the source text, no mark.

**Owner choice: option 2.** Inside a table row, a `|` between the backticks of a code span is part of the code span, not a cell separator. Row `I57` then has 5 cells and shows the full code span. This differs from GFM, GitHub and the VS Code built-in preview; the Owner accepts that.

Related finding (2026-11-08): Lute already serializes `` `x \| y` `` in a cell back to `` `x | y` ``, so the escape is lost on round trip. Under D1 that output parses the same way again, but the source bytes change. The fix must keep `\|` when the source had it.

## Proposed work

1. Reproduce in real VS Code: open a fixture with row `I57` in IR, WYSIWYG, SV and Preview. Record what each mode shows, and the bytes on disk after (a) an edit in another block, (b) an edit in a cell of that row, (c) an edit in another row of the same table. Record whether the cell-padding growth reaches disk.
2. Find every place that parses markdown to a table: webview Lute calls (`Md2VditorIRDOM`, `Md2VditorDOM`, `Md2HTML`, paste and SpinVditor paths), host prerender in `src/lute/lute-host.ts`, the Preview pane renderer, and SV table helpers if they split cells. List them in this record before the fix.
3. Write the failing tests first (see below).
4. Fix in VMDE code: before Lute parses, escape a `|` inside a code span on a table row (code-span rules per CommonMark: matching backtick runs, a backslash does not escape inside code). After serialization, restore the source form, so `|` stays `|` and `\|` stays `\|`. Use one shared helper for host and webview. Patch vendored Lute only when a VMDE-side fix is not possible, per `vmde-lute-features`.
5. Optional, outside the repository: no change to `tmp/pending-questions.md` is needed under D1.

## Acceptance

- [ ] Step 1 results recorded for all 4 modes and the 3 edit cases.
- [x] D1 settled and recorded (option 2).
- [ ] Step 2 parse-site list recorded.
- [ ] Row `I57` of `tmp/pending-questions.md` shows 5 cells and the full code span in IR, WYSIWYG, SV and Preview, and in the host prerender.
- [ ] A `|` outside a code span still separates cells; `\|` outside a code span still shows as `|` in one cell.
- [ ] Opening, editing any block and saving keeps the source of row `I57` and of a row with `` `x \| y` `` byte-for-byte, except the cells the user edits.
- [ ] Focused tests fail before the fix and pass after; `npm run quality` passes.

## Tests to write

- Vitest: the shared helper (code-span detection with 1 and 2 backtick runs, unclosed backtick, `\|` inside and outside code, pipe-free rows unchanged); serialize round trip of a table with both row forms on the incremental and full paths.
- Real-VS-Code spec in `test/vscode-e2e/`: open the fixture, check cell count and code text in IR, WYSIWYG and Preview, edit another cell of the table, save, and compare the bytes on disk.
