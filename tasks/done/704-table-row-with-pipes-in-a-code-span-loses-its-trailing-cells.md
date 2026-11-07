# Task 704 — A table row with unescaped pipes in a code span loses its trailing cells

**Status:** ✅ done (2026-11-08). Owner priority: first in the queue.
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

- [x] Step 1 results recorded for all 4 modes and the 3 edit cases.
- [x] D1 settled and recorded (option 2).
- [x] Step 2 parse-site list recorded.
- [x] Row `I57` of `tmp/pending-questions.md` shows 5 cells and the full code span in IR, WYSIWYG, SV and Preview, and in the host prerender.
- [x] A `|` outside a code span still separates cells; `\|` outside a code span still shows as `|` in one cell.
- [x] Opening, editing any block and saving keeps the source of row `I57` and of a row with `` `x \| y` `` byte-for-byte, except the cells the user edits.
- [x] Focused tests fail before the fix and pass after; `npm run quality` passes.

## Tests to write

- Vitest: the shared helper (code-span detection with 1 and 2 backtick runs, unclosed backtick, `\|` inside and outside code, pipe-free rows unchanged); serialize round trip of a table with both row forms on the incremental and full paths.
- Real-VS-Code spec in `test/vscode-e2e/`: open the fixture, check cell count and code text in IR, WYSIWYG and Preview, edit another cell of the table, save, and compare the bytes on disk.

## Decisions Q1–Q3 (settled by the Owner, 2026-11-08)

- **Q1 (Source-mode text): keep the host pre-escape.** The host keeps posting content with `|` in table code spans escaped to `\|`; Source mode shows `\|` there, and the host merge restores the source form on save.
- **Q2 (scope): include the table commands.** Format Table (`FormatStr`), row and column operations (`media-src/src/editing/table-operations.ts`) and table source selection (`media-src/src/editing/table-source-selection.ts`) use the same code-span-aware split in this task.
- **Q3 (new pipes): write a bare `|`.** A `|` the user types inside a code span of a table cell, and a code span that Format Table rewrites, is saved as `|`, not `\|`. A code span the user did not change keeps its source bytes (`|` or `\|`).

## Part 1 handoff (2026-11-08)

**Premise correction.** A host pre-escape already exists: `src/markdown/table-pipe-escape.ts` `escapeTableSpanPipes` (Vditor #1904) escapes `|` in code and math spans, but only on over-split rows and only when the escape gives the exact header cell count. It runs at `src/session/editor-session.ts:452`, `src/writeback/doc-sync.ts:76` and `:121`, `src/lute/lute-host.ts:302` and `:389`, and fires on `I57` (Node: 10 cells to 5). The first render in VS Code is therefore probably correct. The loss comes from the IR serializer: `VditorIRDOM2Md` writes a cell code span `x \| y` back as `x | y`, so every `SpinVditorIRDOM` of the table re-splits the row. WYSIWYG `VditorDOM2Md` keeps `\|`. Node prediction with the real Lute and the real `minimalDiffWriteback`: (a) an edit in another block keeps the table bytes; (b), (c) an edit in a table row pads the whole table (748 to 1376 bytes), cuts `I57` after `` `Add `` and writes `` `x \| y` `` as `` `x | y` ``.

**Design.**

- New shared module `src/shared/table-code-pipes.ts` (`git mv` from `src/markdown/table-pipe-escape.ts`; id `table-code-pipes` in `HOST_MODULES.shared.ids` of `scripts/module-manifest.mjs`, remove `table-pipe-escape` from the markdown ids; update the 3 host importers and the test import). Imports only `./md-scan`. The webview imports it as `../../../src/shared/table-code-pipes`.
- Exports: `escapeTableCodePipes(markdown)` (pre-parse; returns the same string when nothing changes); `splitTableRowCells(line)` (code-span-aware, raw cells, same outer-pipe rule as `splitRowCells`); `tableRowPipeOffsets(line)`; `escapeCellCodePipesInIrHtml(html)` (IR serializer input); `restoreCodeSpanPipeForm(originalCell, nextCell)`; `patchLuteTableCodePipes(lute)` (idempotent flag; wraps `Md2VditorIRDOM`, `Md2VditorDOM`, `Md2HTML`, `FormatStr` with the pre-escape and `VditorIRDOM2Md`, `SpinVditorIRDOM` with the IR DOM escape; never `VditorDOM2Md`, `SpinVditorDOM` or any `*SVDOM`).
- Code-span scan (CommonMark): a backtick run of length n closes only at the next run of exactly n; an unmatched opener is literal; no backslash escape inside code; outside code `\x` is copied as a pair. Inside a matched span, escape each `|` not directly preceded by `\`.
- Table-row detection: header line with `|` followed by a delimiter row (`DELIM`); body until a blank line, a line without `|`, a fence or an HTML-block start. Skip fenced code (existing tracker), HTML blocks (CommonMark types 1–7) and indented code. D1 is strict: escape code-span pipes on every header and body row with no cell-count guard (repository scan: 4677 rows, 0 correct-count rows change). The math `$…$` escape stays as today, guarded.
- IR DOM escape: inside `<td>`/`<th>`, only the `<code>` that follows the opening marker of a `span[data-type="code"]` node; text segments only (`<wbr>` safe); math (`data-type="math-inline"`) and html-inline markers untouched.
- Rejected: a private-use placeholder character (Lute deletes it).
- Install: host in `src/lute/lute-host.ts` `loadLute` after `Lute.New()`; webview in `media-src/src/boot/preload.ts` `__vmdePatchLute`, FIRST, before `patchLuteGapRepair`.
- Save path: `src/markdown/minimal-diff-writeback.ts` uses the code-aware split in `splitRow`, `isTableBlock`, `originalRowCellSpans`, `spliceChangedRow`; `cellRT` (`:317`) stops replacing `|` with `\|`; an edited cell runs `restoreCodeSpanPipeForm` so unchanged code spans keep their source bytes and changed or new code spans are written with a bare `|` (Q3).
- Table commands (Q2): `table-operations.ts` `pipeOffsets`/`parseRow` and `table-source-selection.ts` `canonicalRowSpans` use `tableRowPipeOffsets`/`splitTableRowCells`; Format Table output restores each unchanged code span's source form and writes bare `|` otherwise.
- SV (`Md2VditorSVDOM`, `SpinVditorSVDOM`) is not transformed.
- Performance: `escapeTableCodePipes` returns the input unless it contains both `|` and `` ` ``; scan with `indexOf('\n')`, no `split`; allocate only from the first changed row. `escapeCellCodePipesInIrHtml` returns the input unless it contains `<td` or `<th`, `data-type="code"` and `|`. No extra work on pipe-free or non-table text.

**Parse sites (step 2).** Host: `src/lute/lute-host.ts` `loadLute` (`:194–227`), `canonicalIrMarkdown` (`:294–310`), `renderForMode` (`:389–406`); host pre-escape sites above. Webview, all through the instance wrapper: Vditor `index.ts:304`, `:330`; `ts/toolbar/EditMode.ts:60`; `ts/wysiwyg/renderDomByMd.ts:10`; `ts/util/fixBrowserBehavior.ts:1542`, `:1546` (plain paste); `ts/preview/index.ts:188`, `:200`; `ts/markdown/getHTML.ts:7`; VMDE `media-src/src/diagrams/stream-render.ts:95–96`; `media-src/src/nav/block-handle.ts:92–93`; `media-src/src/editing/block-transform-command.ts:720`; `media-src/src/editing/preview-render.ts:113`; `media-src/src/bridge/edit-sync.ts:533–541`, `:620`; `media-src/src/diagrams/d2/engines/d2.ts:114`. `SpinVditorIRDOM` callers (IR DOM escape): `ir/input.ts:179`, `ir/process.ts:111`, `fixBrowserBehavior.ts:286`, `:355`, `:644`, `:1567`, `undo/index.ts:156`, `hint/index.ts:180`, `toolbar/Emoji.ts:52`, `outlineRender.ts:27`, VMDE `list-normalize.ts:113`, `list-backspace.ts:90`, `vditor-init.ts:376`. `FormatStr`: `media-src/src/editing/table-format-command.ts:362`, `list-normalize-source-command.ts:364`. Own cell splitters: `src/shared/md-scan.ts:18–21`, `src/markdown/minimal-diff-writeback.ts:181–370`, `media-src/src/editing/table-operations.ts:47–89`, `media-src/src/editing/table-source-selection.ts:97–133`. HTML paste needs no pre-escape; `media-src/src/clipboard/paste-table.ts:80` already writes `\|`. No export or copy-as-HTML path exists. Serializers (`VditorIRDOM2Md`/`VditorDOM2Md` on the instance, looked up at call time) are all covered by the instance wrapper.

**Residual risks.** Tables inside blockquotes or lists are not detected (existing line-detector limit). Documents over 100 KB (`MINDIFF_CAP`) or a row-count change still write canonical bytes (padding). Backtick pairs across cells now form one code span (0 rows in this repository).

**Test plan.** Vitest: `test/backend/table-code-pipes.test.ts` (moved from `table-pipe-escape.test.ts`, helper cases), `media-src/src/bridge/table-code-pipes-roundtrip.test.ts` (real Lute: IR render, spin, full and incremental serialize, WYSIWYG not double-escaped), `test/backend/minimal-diff-writeback.test.ts` (byte preservation, `cellRT`, Q3), `test/backend/lute-host.test.ts` (host prerender and reserialize), table-command cases. Real VS Code: `test/vscode-e2e/table-code-pipes.spec.ts` with fixture `test/vscode-e2e/fixtures/table-code-pipes.md` (display in IR, WYSIWYG, SV, Preview; edit and save byte comparison). Step 1 probe: `test/vscode-e2e/table-code-pipes-probe.spec.ts` (`@probe`), JSON matrix to `tmp/704/step1.json`.

## Provisional decisions P1–P4 (orchestrator, on the Owner's behalf, 2026-11-08; reversible)

- **P1 (escaped pipes outside code):** backslash parity, as CommonMark: a `|` outside a code span is escaped only when an odd number of backslashes directly precede it (`\|` escaped, `\\|` separates). Inside a code span every `|` is literal (D1). `splitTableRowCells`, `tableRowPipeOffsets`, `pipeOffsets`, `canonicalRowSpans` and `originalRowCellSpans` all use this one rule from the shared module.
- **P2 (helper contracts):** `tableRowPipeOffsets(line)` lists the absolute offsets of the outer and separating pipes, excluding pipes inside code spans and escaped pipes. `splitTableRowCells(line)` returns raw, untrimmed cells with the same outer-pipe strip as `splitRowCells`.
- **P3 (Format Table padding):** after the source pipe form is restored in each cell, Format Table recomputes column padding from the final cell text, so the formatted table stays aligned.
- **P4 (edit before an edited table):** superseded by the fix: the table merge of `minimalDiffWriteback` now pairs the first unconsumed original table block at or after the cursor, because a WYSIWYG edit in a block before the table left the cursor on that block's slot (the Source-mode case passed only because its table text matched whole-block).

## Part 2a results (2026-11-08)

Probe spec, acceptance spec, fixture and RED tests written (test files only). Vitest RED: 35 failed, 135 passed in 7 files: helper suite fails at import (module absent); roundtrip 13 failed; minimal-diff 8; lute-host 2 (correct-count row, D1 strict; the I57 cases already pass through the existing host pre-escape); table-operations 8; table-format 3; rewrap (table source selection) 1. `node build.mjs`, `typecheck`, `typecheck:vscode-e2e`, biome on the touched files: exit 0.

## Step 1 results (real VS Code, 2026-11-08, `86a6d5ce` + Part 2a tests; matrix `tmp/704/step1.json`, log `tmp/704/run1.log`)

- **Display at open.** IR: row `I57` shows 5 cells and the full code span (the host pre-escape fires). Preview: 5 cells, full code span. SV: the `I57` source line is complete. **WYSIWYG: wrong** — cell 3 shows only `` `Add `` and cell 5 shows `EnterAt` (the WYSIWYG display re-splits the row).
- **IR edits** (fixture, 771 bytes): (a) edit in another block: table bytes unchanged. (b) edit in the `I57` first cell and (c) edit in the `I56` first cell: every table row is padded (771 to 1214 bytes), `I57` loses `EnterAtAsync` and `[F11]`, `E1` `\|` becomes `|` (cells split). Same on `tmp/pending-questions.md` (67,748 to 219,182 bytes after an IR cell edit): the padding reaches disk.
- **WYSIWYG edits** (probe rerun after the open-helper repair, `tmp/704/run2.log`, 6 passed): every case, including (a) an edit outside the table, pads the table on disk (771 to 2133–2138 bytes; `tmp/pending-questions.md` 67,748 to about 226,440 bytes, 129 padded rows). (b) also loses `EnterAtAsync` and `[F11]`. `E1` keeps `\|`.
- **SV edits:** no padding (778 bytes); (b) loses the tail of `I57` after the typed character's row is reparsed; (a) and (c) keep `I57`.
- First probe run (`tmp/704/run1.log`) timed out in WYSIWYG and SV: probe defect (it waited for `.vditor-ir` after reopening a file in its remembered mode), repaired test-only.
- The SV edit before the table kept the table bytes before the fix (`T4 sv` passed); the WYSIWYG case did not (see P4).
- Acceptance spec before the fix: T1, T2, T3, T4 wysiwyg fail; T4 sv passes.

## Implementation and verification (2026-11-08)

Implemented as designed (Part 1 handoff, Q1–Q3, P1–P3): new `src/shared/table-code-pipes.ts` (moved from `src/markdown/table-pipe-escape.ts`), installed on the host Lute (`loadLute`) and on every webview Lute (`__vmdePatchLute`, first); code-aware table merge in `src/markdown/minimal-diff-writeback.ts` (no `cellRT` double escape, per-cell source pipe form, table pairing at or after the cursor); table operations, table source selection and Format Table on the shared split (Format Table restores unchanged code spans and recomputes padding). `escapeTableCodePipes` also runs the guarded math escape when the text holds `$` (keeps the earlier `| $|x|$ |` behaviour). An indented line after a list marker is list content, not indented code, so tables in list items keep their escape. `test/backend/vditor-fidelity-bugs.test.ts` now expects the canonical host reserialize `` `a\|b` `` (the old expectation encoded the defect).

Verification on the final candidate:

- `node build.mjs` exit 0; 11 focused Vitest files 283 passed; `npm run quality` exit 0 (brand identifiers, lint:ci, knip, jscpd, depcruise, audit, test:coverage 8619 passed + 1 expected fail, coverage-modules).
- Real VS Code: `table-code-pipes.spec.ts` 10/10 passed (`--repeat-each=2`, quiet machine); probe all modes and edit cases: the fixture is exact (+1 byte, only the edited row differs); `block-fidelity`, `mode-roundtrip`, `table-format` pass; `table-operations.spec.ts:48` and `:242` fail (known pre-existing). One combined run under parallel `quality` load failed `T4 wysiwyg` with the typed key not reaching the document in 20 s (load-dependent; passes alone).
- On `tmp/pending-questions.md` the only table line that changes is the edited row. Outside the table, a save after an edit drops the blank line between the front matter and the first heading (also on a pipe-free document; pre-existing, outside this task): follow-up.
