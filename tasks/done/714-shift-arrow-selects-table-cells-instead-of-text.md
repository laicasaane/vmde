# Task 714 — Shift+Arrow selects table cells instead of text (every Markdown construct in scope)

**Status:** done (2026-11-09). Fixes `4bbcfa2e`, `6f44a05f`; tests `66ef6fb3`, `410ee21f`. Reported by the Owner.
**Origin:** Owner report: manual reproduction in VS Code.
**Severity:** high (estimated). Shift+Arrow is the basic keyboard text selection. Inside a table cell it selects whole cells, so the user cannot select part of a cell's text from the keyboard.
**Tech stack:** `media-src/src/editing/table-cell-selection.ts` (keydown handler, about lines 371–400: plain Shift+Arrow is the rectangle key, from `2b3b5511` and Task 580 Owner Q2), `media-src/src/editing/editor-caret.ts`, `media-src/src/editing/details-selection-state.ts`, structural selection (Task 288), and the Task 580 key bindings.
**Depends on:** none.

## Problem

Steps to reproduce:

1. Create a table with 3 columns and 3 rows.
2. Put lorem ipsum text into every cell.
3. Put the caret in the center cell, in the middle of its text.
4. Press `Shift+ArrowLeft`.
5. Expected: text is selected (one character to the left of the caret).
6. Actual: a table cell is selected.
7. `Shift+ArrowRight` shows the same problem.

Source reading (not yet measured): the keydown handler in `table-cell-selection.ts` treats every plain Shift+Arrow as the cell-rectangle key, even with no rectangle active. It takes the caret's cell as the anchor and moves the rectangle focus to the neighbouring cell. Native text selection inside the cell never runs.

Not yet known: which edit modes show it (IR, WYSIWYG, SV); whether Shift+ArrowUp and Shift+ArrowDown inside a multi-line cell are affected the same way; and the first bad commit.

## Scope: every Markdown construct

The Owner asked for tests and fixes for every Markdown construct, not only tables. Keyboard selection keys must extend a text selection inside a construct, in every edit mode where the construct is editable. The keys in scope are `Shift+ArrowLeft`, `Shift+ArrowRight`, `Shift+ArrowUp`, `Shift+ArrowDown`, `Shift+Home`, `Shift+End` and word selection (`Ctrl+Shift+ArrowLeft` and `Ctrl+Shift+ArrowRight`, with the macOS equivalents). A construct must not take these keys over while the caret is inside its text. This applies to:

- Block text: paragraphs, headings, block quotes, horizontal rules (step over).
- Inline: bold, italic, strike-through, inline code, links, wiki links, footnote references, emoji, inline math, inline HTML.
- Lists: ordered, unordered, task lists, nested lists.
- Tables: cell text in head and body cells, aligned columns, tables inside lists, quotes, callouts and details.
- Code blocks (fenced and indented) and the source of every diagram engine in `diagram-kit/engine-registry.ts`.
- Math blocks.
- Callouts (GitHub alerts), `<details>` (summary and body), raw HTML blocks, the front-matter block and table, footnote definitions.
- Selection that starts in one construct and crosses into the next.

Shortcuts that this fix must not break: Task 580 bindings (Select All, Expand Selection `Shift+Alt+Right` and its platform equivalents, Undo/Redo), structural selection (Task 288), and the table cell rectangle itself. The rectangle must stay reachable from the keyboard (see Open decision).

## Open decision (for the Owner, before the fix)

When should plain Shift+Arrow in a table switch from text selection to the cell rectangle? Options:

- A (recommended): text selection while the caret can still move within the cell in that direction. The rectangle starts only when the selection already reaches the cell edge in that direction, or when a rectangle is already active.
- B: the rectangle needs a separate chord, and plain Shift+Arrow is always text selection.
- C: the rectangle starts only when the whole cell text is already selected.

## Decisions

- D1 (provisional, 2026-11-09, orchestrator under Owner rule R3): option A. Plain Shift+Arrow is text selection while the caret or selection focus can still move within the cell in that direction. The rectangle starts only when the selection already reaches the cell edge in that direction, or when a rectangle is already active. Reversible if the Owner chooses B or C.

- D2 (provisional, 2026-11-09, R3): Shift+ArrowUp/Down at the first or last line of a code, diagram, math, HTML or front-matter block, or a block quote, never runs Vditor's block escape (no caret move out, no inserted paragraph). A selection key does not edit the document.
- D3 (provisional, R3): `gap-nav.ts` also moves the selection focus past a horizontal rule for Shift+ArrowDown/Up, keeping the anchor.
- D4 (provisional, R3): the `<details>` summary is a non-editable toggle in IR and WYSIWYG; keyboard selection of summary text is checked in SV only.
- D5 (provisional, R3): inline math and inline HTML anchor moves, the inline-HTML Shift+ArrowUp collapse, and the IR footnote/emoji marker caret stay in this task, after one probe each.
- D6 (provisional, 2026-11-09, R3): Shift+Home/End inside an inline-block (`kbd` in IR, the inline-math source in WYSIWYG) keeps native Chromium behaviour: the selection stops at the inline-block's own line edge. No product change; the spec expects that line box.
- First bad commit (source evidence; the runtime probe on older builds failed before any key on an XTEST window error): `2b3b5511` added the handler that makes every plain Shift+Arrow the rectangle key.

## Progress

- 2026-11-09 Part 1: matrix spec `keyboard-text-selection.spec.ts` (RED: IR 47, WYSIWYG 57 mismatches, SV clean). Causes: A rectangle handler takes mid-cell Shift+Arrow (34); B Vditor `insertAfterBlock`/`insertBeforeBlock` treat Shift+Up/Down as block escape (IR 16, WYSIWYG 25; WYSIWYG inserted paragraphs); C Vditor `fixTable` Up/Down ignores Shift; D inline math/HTML re-render moves the anchor; E inline-HTML Shift+Up collapses; F Shift+Down over a rule leaves focus on the root; G IR caret not kept in footnote/emoji markers. Rectangle at the cell edge already works.
- 2026-11-09 Part 2a: causes A, B, C, F fixed (rectangle only at the cell edge via `canMoveWithinCell`; Vditor block escape and `fixTable` skip Shift+Up/Down; `gap-nav` extends the focus across a rule). Real VS Code: table-operations, table-panel, structural-selection, expand-selection-first-keys, gap-cursor, hr-edit pass (18); the matrix spec still fails IR and WYSIWYG on details (spec entry), inline math/HTML, footnote/emoji markers, math-block and WYSIWYG diagram Shift+ArrowUp. Part 2b diagnoses and fixes the rest.
- 2026-11-09 Part 2b (partial): spec entry fixed for details and IR emoji/footnote markers (real click); Vditor patches for inline math Shift+Up/Down, emoji hint Shift+Up/Down, keyup preview reveal on Shift. Still failing: Shift+Up collapse into previews (another path), inline-block Home/End (D6), and new WYSIWYG callout/code cases plus a `structural-selection:198` guard failure, cause unmeasured. Part 2c continues.
- 2026-11-09 Part 2c: XTEST releases Shift before the arrow, so the keyup preview patches now test for a non-collapsed selection, not `shiftKey`; Up-into-preview cases pass. D6 applied in the spec. 6 mismatches left (spec counting of revealed markers, callout expectation, re-placement after a preview); `structural-selection:198/:369` fail only in combined runs. Part 2d continues.
- 2026-11-09 Part 2d and 2e (test only): the spec ignores marker text IR reveals outside the caret's own inline element, takes the next visible character at a text-node end, and places the caret in a hidden WYSIWYG block deterministically (normalize split text nodes, poll for the shown source). `structural-selection:198` is pre-existing: it fails 5 of 6 on the base `88dc7f49` without Task 714.
- 2026-11-09 orchestrator: rebased onto dev (Tasks 713, 715, 716); the Task 664 guard `selection-writes.test.ts` caught a raw `Selection.extend` in `gap-nav.ts`, now written through `writeSelection`. `npm run quality` exit 0. Real VS Code on the rebased tree: keyboard-text-selection, table-operations, gap-cursor, expand-selection-first-keys, table-panel, hr-edit, preview-overflow, preview-mode-features pass (22), except the intermittent WYSIWYG placement fixed in Part 2e (then WYSIWYG 3 of 3 and the whole spec pass) and the pre-existing `structural-selection:198`.

## Proposed work

1. Reproduce in real VS Code in IR, WYSIWYG and SV with the 3×3 lorem ipsum table, for Shift+ArrowLeft, Right, Up and Down. Record the selection (DOM range and text) and whether the rectangle state is set.
2. Find the first bad commit (`2b3b5511` and the Task 580 changes are candidates).
3. Build one fixture with every construct in the scope list, with text long enough to place the caret in the middle. For each construct, edit mode and key in scope, record whether the key extends a text selection as expected.
4. Get the Owner's decision on the rectangle trigger, then fix with failing tests first.

## Acceptance

- [x] The table case is measured in IR, WYSIWYG and SV, with the cause and the first bad commit.
- [x] Every construct, edit mode and key in the scope list is recorded as working or failing, with the cause.
- [x] A real-VS-Code spec (OS-level XTEST keys) fails before the fix and passes after it. It covers the table case and every construct in the scope list, per edit mode.
- [x] Keyboard text selection works inside every construct, and the cell rectangle still works as the Owner decided.
- [x] Task 580 bindings, structural selection and the existing table-selection specs still pass, except `structural-selection:198`, which already fails 5 of 6 on the base without this task (follow-up).
- [x] `npm run quality` passes.

## Tests to write

- Vitest: the `table-cell-selection.ts` keydown decision (text selection inside a cell versus rectangle start or extension) for each arrow key, at the cell edge and in the middle.
- Real-VS-Code spec, XTEST keys: the 3×3 table case, then the all-constructs fixture. For each construct, edit mode and key, assert the selected text after the key press, so a failure names the construct, mode and key.
