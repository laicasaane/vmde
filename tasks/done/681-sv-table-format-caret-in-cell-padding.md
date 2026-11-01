# Task 681 — SV Format Table declines silently with the caret in cell padding

**Status:** done (2026-11-01).
**Origin:** Task 669 (review finding F2, accepted limit).
**Severity:** low (estimated; the command fails closed, nothing is lost).
**Tech stack:** `media-src/src/editing/sv-source-proof.ts` (`proveSvOffsets`), `media-src/src/editing/table-format-command.ts`, `test/vscode-e2e/table-format.spec.ts`.
**Depends on:** Task 675 for the cases that follow a mode switch; the direct-open case does not need it.

## Problem

In Source mode, Lute pads table cells. A caret placed inside that padding (spaces with no image in the exact text) is unprovable, so `proveSvOffsets` declines and Format Table does nothing and shows nothing. Task 669 recorded it as F2: "a caret inside table cell padding ... is unprovable, so the table command declines silently. This follows the contract (no write from an unproven position)." The Vitest case "an endpoint inside a normalized-only region (for example table padding): declines with no write" pins the current behavior. A user who clicks at the end of a padded cell gets no feedback and no format.

## Proposed work

When a caret endpoint is unprovable but lies inside the same table cell as a provable offset, snap it to the nearest proven offset in that cell (the cell text edge nearest to the caret) and continue. A non-collapsed selection, an endpoint outside any cell, or a cell with no provable offset keeps declining with no write. Never snap across a cell boundary or a row.

## Acceptance

- [x] A caret in cell padding (left, right, and an empty cell) formats the table; host bytes outside the table span stay equal to the exact text.
- [x] A caret that cannot be snapped inside its own cell still declines with no write, no DOM change, no history entry.
- [x] Vitest: snapped offset per padding position; refusal across cells; CRLF exact text against LF editor text.
- [x] Focused real-VS-Code spec written and run; quality stages pass.

## Tests to write

- Vitest in `sv-source-proof.test.ts` and `table-format-command.test.ts`.
- Real VS Code: a Source-mode table with a caret placed in padding, Format Table, one Undo, Save.

## Part 1 handoff (2026-11-01)

Base: `dev` `e7e73b39` (Tasks 673 and 675 integrated). The dependency on Task 675 is satisfied: after a mode switch the Source-mode relation accepts Lute's table padding, and `table-format-command.ts` records its history pair in `getValue()` form.

### Problem and root cause (measured)

Lute's table padding exists in the Source editor text only after a switch from IR or WYSIWYG; on a direct Source open the editor text is the raw host text, so every caret there is verbatim and proven. After a switch, the editor shows the padded table and the host text stays raw. `runTableFormatCommand` proves the retained caret with `proveSvOffsets` (`sv-source-proof.ts:147`) and returns `false` at `table-format-command.ts:304` when the proof fails, with no feedback.

A scratch probe (untracked, `tmp/681/padding.probe.test.ts`) ran `proveSvOffsets` on every caret offset of three padded tables against raw exact text (the Task 669 CRLF fixture, an LF table with an empty cell, an LF table with a wide column). In every padded table cell the only proven caret offsets are:

- the offset just after the cell's left pipe, and
- the offset just after the cell text.

Every offset inside the left padding (between the space and the text), inside the right padding and just before the right pipe is unprovable. In an empty padded cell (`|   |` against `||`) only the offset just after the left pipe is proven. The offset just after the left pipe maps to the exact offset just before the cell text (the exact text has no padding there), so it is the cell text start. The caret proof itself is correct: these positions have no exact image.

`formatTableAtSelection` turns the exact caret offset into a cell location (row, column, offset clamped into the trimmed text) and restores the caret at that location in the formatted cell. So the snapped offset only chooses the cell and the side of the text; the table span, the region proof (`svRenderedBounds`, verbatim or equal after Lute formats both) and `planSvRegionEdit` stay unchanged and still guard the bytes outside the table.

### Scope

- In scope: a collapsed Source-mode caret inside the padding of a table cell, for Format Table only.
- Unchanged: `proveSvOffsets` and `proveSvSelection` and every other Source command (Fix list numbering, Turn Into). The Task 669 case "declines an endpoint inside normalized padding that has no exact image" stays and keeps pinning the decline for them.
- Declines as today (no write, no DOM change, no history entry): a non-collapsed selection with an unprovable endpoint; an unprovable caret outside any table cell of the editor text; a cell with no proven caret offset; a snapped offset whose exact table cell differs (row or column) from the editor cell.

### Shared interfaces and invariants

- New export in `media-src/src/editing/table-operations.ts`: `tableCellSpanAtOffset(markdown: string, offset: number): { row: number; column: number; start: number; end: number } | null`. `markdown` is one table (as `tableCellLocationAtOffset` takes it). `start` and `end` are offsets into `markdown` of the cell's raw interval, between its pipes, pipes excluded (padding included). One table parse per call. `null` when the offset is not inside a cell (on a pipe-only edge outside the first or last cell, outside the table).
- New export in `media-src/src/editing/sv-source-proof.ts`: `proveSvCaretInSpan(exact: string, text: string, at: number, span: { start: number; end: number }): SvSelectionProof`. It returns the `proveSvOffsets` result for the proven caret offset inside `span` (bounds included) nearest to `at`; on equal distance the lower offset wins; `renderedStart` and `renderedEnd` are the snapped editor offset. It returns `{ status: 'unprovable' }` when `at` is outside `span` or no offset in `span` is proven. It never returns an offset outside `span`. It reuses the cached alignment.
- `table-format-command.ts` only: when `proveSvOffsets` fails and the retained selection is collapsed, find the editor table with `sourceTableRangeAtSelection(text, at, at)`, the cell with `tableCellSpanAtOffset`, snap with `proveSvCaretInSpan`, then require the exact table cell at the snapped exact offset (`sourceTableRangeAtSelection` and `tableCellLocationAtOffset` on the exact text) to have the same row and column. Any failure returns `false` before any write. The rollback still restores the original retained offsets.
- Invariants kept: no write from an unproven position (the snapped offset is itself proven); host bytes outside the table span equal the exact text (enforced by `planSvRegionEdit`); CRLF stays in the host, LF in the editor; one native history entry; no change to the module map.

### Decisions

- **Provisional decision (2026-11-01), reversible: the snapping rule.** Search the editor cell's raw interval (between its pipes) for the proven caret offset nearest to the caret; on a tie take the lower offset. Measured result: left padding and an empty cell snap to just after the left pipe (the exact text start), right padding and the offset before the right pipe snap to just after the text. Rejected: always the cell start, always the text end (both contradict "nearest"). Selected by a recorded decision check (probability 0.99).
- **Provisional decision (2026-11-01), reversible: where the snapping lives.** A generic pure helper `proveSvCaretInSpan` in `sv-source-proof.ts` and a cell-interval export `tableCellSpanAtOffset` in `table-operations.ts`, called only by `table-format-command.ts`, which also checks the exact cell row and column; `proveSvOffsets` is unchanged. Rejected: snapping inside `proveSvOffsets` (other Source commands would snap; probability 0.00) and private pipe scanning inside the command (not testable per padding position in `sv-source-proof.test.ts`; 0.02). Selected by a recorded decision check (probability 0.97).
- **Provisional decision (2026-11-01), reversible: real-VS-Code spec placement.** A second test in `test/vscode-e2e/table-format.spec.ts`, which already opens a CRLF table in IR, switches to Source (padded editor text) and places a caret; a small local helper is extracted for the shared open, switch and caret steps so jscpd stays clean. Rejected: a new spec file, a scenario in the shared exact-authority kit (Task 682 may edit the kit). Selected by a recorded decision check (probability 1.0).
- **Provisional decision (2026-11-01), reversible: collapsed caret only.** A non-collapsed selection with an unprovable endpoint keeps declining. Settled by the task record ("A non-collapsed selection ... keeps declining"); no decision check was needed.
- Public names, compatibility: the two new exports above; no numbering, settings or storage formats are involved. Existing exports keep their signatures and behaviour.

### Acceptance to test map

| Acceptance item | Layer | File | Test |
|---|---|---|---|
| 1. Caret in left padding, right padding and an empty cell formats the table; host bytes outside the table equal the exact text | Vitest | `media-src/src/editing/table-format-command.test.ts` | new `describe('Task 681: a caret in table cell padding')` nested in the Task 669 describe: `formats the table with the caret in the left padding of a cell`, `... in the right padding of a cell`, `... in an empty cell` (CRLF host, LF padded editor; `posted` equals the CRLF host with only the table replaced; the restored caret lies in the same cell) |
| 1. | real VS Code | `test/vscode-e2e/table-format.spec.ts` | new `Format table formats a switched Source table with the caret in cell padding, through one undo and save` |
| 2. A caret that cannot be snapped inside its own cell declines with no write, no DOM change, no history entry | Vitest | `media-src/src/editing/table-format-command.test.ts` | `declines a range with an endpoint in cell padding`, `declines an unprovable caret outside any table cell` (Lute-renumbered list line), each asserting `ran === false`, `posted` empty, editor text unchanged, `recordRewrapDocumentHistory` and `checkpointEditorUndo` not called |
| 2. | Vitest | `media-src/src/editing/sv-source-proof.test.ts` | `proveSvCaretInSpan declines a span with no proven offset`, `... a caret outside the span`, `never returns an offset outside the span` |
| 3. Snapped offset per padding position | Vitest | `media-src/src/editing/sv-source-proof.test.ts` | new `describe('Task 681: proveSvCaretInSpan')`: `snaps every left padding offset to just after the left pipe`, `snaps every right padding offset to just after the cell text`, `snaps an empty cell to just after the left pipe`, `keeps a proven offset unchanged`, `takes the lower offset on a tie` |
| 3. Refusal across cells | Vitest | `media-src/src/editing/table-operations.test.ts` and `sv-source-proof.test.ts` | `tableCellSpanAtOffset returns the raw interval of the cell, pipes excluded` (first, middle, last, empty cell, escaped pipe `\|`, delimiter row, null on the outer pipe and outside the table); `never returns an offset outside the span` |
| 3. CRLF exact text against LF editor text | Vitest | both files above | the proof cases use the Task 669 CRLF fixture; the command cases use a CRLF host |
| 4. Focused real-VS-Code spec written and run; quality stages pass | real VS Code and gates | `table-format.spec.ts` (both tests); the quality stages one by one (dependency audit omitted in this queue) | closure step |

### Edge cases and cheapest test layer

- Caret just before the right pipe (unprovable): snaps to after the text. Vitest (proof).
- Empty cell: snaps to after the left pipe; the formatted caret lands inside the same empty cell. Vitest (proof and command), real VS Code.
- Delimiter row padding (`| --------- |` against `|-|`): snaps inside the delimiter cell; the format applies. Vitest (proof).
- Escaped pipe inside a cell: not a cell boundary. Vitest (`tableCellSpanAtOffset`).
- Caret already proven: no snap, behaviour unchanged. Existing Task 669 command cases.
- Unprovable caret outside a table: declines. Vitest (command).
- Range with an endpoint in padding: declines. Vitest (command).
- Direct Source open: no padding exists, so no new behaviour; covered by the existing direct-open cases (`exact-authority-other-actions.spec.ts`, `exact-action-neutral-bytes.spec.ts`), not rerun.

### Part 2 step plan

- **S1 RED (tests only).** Owned files: `media-src/src/editing/sv-source-proof.test.ts`, `media-src/src/editing/table-operations.test.ts`, `media-src/src/editing/table-format-command.test.ts`, `test/vscode-e2e/table-format.spec.ts`. The new helpers are read off the module namespace (as the Task 669 RED did) so the files compile before the exports exist. The command cases use a small Lute-like column-width formatter in the test (the Task 669 `pad` only pads single characters); the existing `run` helper gains an optional formatter parameter. The spec fixture (CRLF): `before`, ``, `|a|longer|`, `|-|-|`, `|wide text||`, ``, `after`, ``; expected Lute bytes `| a         | longer |`, `| --------- | ------ |`, `| wide text |        |` with CRLF (confirm against the run). For each of left padding (just before `a`), right padding (`a` plus 4) and the empty cell (its middle): place and capture the caret, run `vmde.formatTable`, poll the host for the expected text, check the caret cell, press Ctrl+Z, poll for the original text. Then format once more from the right padding, save, and check the file bytes. Checks: `npx vitest run --config test/vitest.config.mts media-src/src/editing/sv-source-proof.test.ts media-src/src/editing/table-operations.test.ts media-src/src/editing/table-format-command.test.ts` exits 1, only the new Task 681 cases fail (missing exports, or the command declines); `npm run typecheck` and `npm run lint` exit 0; `node build.mjs`, then through the real-VS-Code wrapper `table-format.spec.ts`: the new test fails (host text unchanged, poll timeout), the `:12` test passes.
- **S2 GREEN.** Owned files: `media-src/src/editing/table-operations.ts`, `media-src/src/editing/sv-source-proof.ts`, `media-src/src/editing/table-format-command.ts`. Checks: the S1 Vitest command exits 0; `npx vitest run --config test/vitest.config.mts media-src/src/editing/list-normalize-source-command.test.ts media-src/src/editing/block-transform-sv.test.ts` exits 0 (other Source commands unchanged); `npm run typecheck`, `npm run lint` exit 0; `node build.mjs`, then through the wrapper `table-format.spec.ts`: both tests pass.
- **S3 CLOSURE.** No product files. Run the quality stages one by one: `npm run lint`, `npm run knip`, `npm run jscpd`, `npm run depcruise`, `npm run test:coverage`, `npm run check:coverage-modules` (dependency audit omitted); inspect changed-line coverage of the three source files; update this record (status, acceptance boxes, verification run).

Files touched by Part 2 (for lane overlap): the seven files named in S1 and S2, plus this record. No shared kit change is needed.

## Implementation and verification (2026-11-01)

### Changes

- `media-src/src/editing/table-operations.ts`: new `tableCellSpanAtOffset(markdown, offset)`, the raw interval (between the pipes, padding included) of the table cell around an offset, with its row and column; `null` on an outer pipe, outside the table and for text that is no table.
- `media-src/src/editing/sv-source-proof.ts`: new `proveSvCaretInSpan(exact, text, at, span)`, the nearest proven caret offset inside a span (a tie takes the lower offset); `unprovable` when the caret is outside the span or the span holds no proven offset. `proveSvOffsets` and `proveSvSelection` are unchanged, so Fix list numbering and Turn Into keep declining in padding.
- `media-src/src/editing/table-format-command.ts`: when the proof of a collapsed retained caret fails, `snapCaretIntoCell` snaps it inside its own editor table cell and requires the exact table cell at the snapped offset to be the same row and column. A range, a caret outside every cell, a cell with no proven offset and a row or column mismatch still decline before any write; the region proof, `planSvRegionEdit` and the rollback are unchanged.

### Tests

- Vitest: `table-operations.test.ts` (`tableCellSpanAtOffset`, 3 cases), `sv-source-proof.test.ts` (`Task 681: proveSvCaretInSpan`, 6 cases), `table-format-command.test.ts` (left padding, right padding and empty cell format a CRLF host with a padded LF editor text, host bytes outside the table unchanged; a range with an endpoint in padding and an unprovable caret outside every cell decline with no write, no DOM change, no history entry).
- Real VS Code: `table-format.spec.ts`, three new tests (left padding, right padding, empty cell: the switched Source table shows Lute's padding while the host is raw; Format Table; host bytes equal the formatted CRLF text; the caret stays in its cell; one Undo restores the raw bytes; Redo; Save). The existing CRLF test uses the same extracted helpers and still passes.

### Verification run

- Unit: the three test files above plus `table-format.test.ts`, `block-transform-sv.test.ts` and `list-normalize-source-command.test.ts` pass; the unit coverage run passes (384 files, 8432 tests, 1 expected failure); coverage of the changed sources: `sv-source-proof.ts` 96.8 % lines, `table-operations.ts` 97.2 %, `table-format-command.ts` 94.4 %.
- Quality stages run one by one, each exit 0: brand identifiers, lint (CI mode), typecheck, e2e typecheck, knip, jscpd, dependency-cruiser, unit coverage, the zero-coverage-module ratchet (9 modules at 0 %, baseline 9). The dependency audit is not run in this queue.
- Real VS Code through the wrapper: `table-format.spec.ts`, 4 of 4 pass.
- Bundle sizes (reporting only): extension bundle 327,794 bytes; webview main bundle 1,122,354 bytes.

### Provisional decisions

- **Provisional decision (2026-11-01), reversible: spec isolation.** `openInSource` in `table-format.spec.ts` closes all open editors before it opens the document. Without it the first new test failed in a whole-file run (twice, the host stayed raw) while it passed alone: the existing test's Source editor stayed open in the same VS Code and the host command did not reach the intended webview. Settled by the failing and passing runs; no decision check was needed.
- The snapping rule, its placement and the spec placement are recorded above in the Part 1 handoff.

### Residual risks

- The snap tries each offset of the cell outward from the caret; the cost is bounded by the cell width and each try reuses the cached alignment, so a very wide cell is the only worst case.
- A mismatch between the editor table and the exact table (different cell structure) declines instead of snapping.
- Only a collapsed caret snaps; a range ending in padding still declines (task wording).
- Not run for this task: the Chromium harness and the full real-VS-Code suite.
