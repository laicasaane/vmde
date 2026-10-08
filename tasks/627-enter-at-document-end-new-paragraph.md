# Task 627 — Enter at the end of the document does not open a new paragraph to type in

**Status:** planned (2026-10-08).
**Origin:** Project Owner report (2026-10-08).
**Severity:** medium (estimated). A basic authoring action needs a workaround.
**Tech stack:** webview Enter handling (`media-src/src/editing/`, Vditor IR/WYSIWYG/SV Enter paths), real VS Code with XTEST.

## Problem

The Owner reports: pressing Enter at the last position in the file should insert a new paragraph block to write in. Today the Owner has to type a character first, then place the caret before that character and press Enter to get a new paragraph block.

So with the caret at the very end of the document, Enter does not give a new empty paragraph the user can type into. The workaround shows that Enter works when the caret is not at the document end. The report does not say which mode or which kind of last block was involved, so the investigation has to measure that.

## Related

- [Task 625](625-ir-enter-next-char-wrong-block.md): in IR, after Enter at the end of the last paragraph, the first typed character lands at the end of the previous paragraph (measured as `lima.Y`). This is likely the same cause or an overlapping one.
- [Task 608](608-remaining-blockless-caret-routes.md) and [Task 600](done/600-no-blockless-caret-in-ir.md): IR carets that sit at the document root, outside any block.
- [Task 486](done/486-repeated-enter-after-callout-code-caret-snapback.md) and [Task 428](done/428-list-editing-usability-vs-real-editors.md): earlier Enter and list-Enter work. Check them, and the double-Enter list-exit fix in the CHANGELOG 1.4.0 Fixed section, for rules that must keep working.

## First steps

1. Reproduce in real VS Code with OS-level keys (XTEST) in IR, WYSIWYG and SV. Cover these last-block kinds: paragraph, heading, list item, blockquote, code block, table, callout or details, horizontal rule, and an empty document. Test each with and without a trailing newline in the file.
2. For each case, record the DOM after Enter (is there a new block, and where is the caret?), what the next typed character does, the host bytes, and the Undo steps.
3. Compare with Enter at the end of a middle block.
4. Use Task 625's evidence to decide whether the two tasks should be merged.

## Acceptance

- [ ] Enter at the end of the document opens a new empty paragraph after the last block. For a list item or blockquote, Vditor's normal continue and exit rules apply. Inside a fenced code block, Enter stays a newline in the code.
- [ ] The caret is inside the new paragraph, and the next typed character lands there.
- [ ] The saved markdown is the expected text: one paragraph appended, exact bytes elsewhere.
- [ ] One Undo removes the new paragraph.
- [ ] A real-VS-Code XTEST spec covers the measured cases in each mode.
- [ ] Task 602's Undo specs and the list-Enter undo specs stay green.

## Tests

- Real VS Code with XTEST: Enter at the document end, then one character, in IR, WYSIWYG and SV for the last-block kinds above.
- Chromium harness or Vitest for any Enter or caret helper that changes.

## Part 1 handoff (2026-10-08)

Shared with Task 625; see the Part 1 handoff in [Task 625](625-ir-enter-next-char-wrong-block.md). The combined probe covers this task's matrix (T2 IR, T3 WYSIWYG, T4 SV by last-block kind).

## Execution progress — 2026-10-08 (S1 probe, shared with Task 625)

Probe `test/vscode-e2e/enter-new-paragraph-probe.spec.ts` (commit `630bd01b`); full per-case results are summarized in [Task 625](625-ir-enter-next-char-wrong-block.md). Shift-modified `Y` after Enter at the document end:

- IR and WYSIWYG paragraph (with and without a final LF) and heading: empty zero-height `<p>`, `Y` appended to the previous block (`…lima.Y`, `## Echo foxtrotY`) — Task 625's cause. An unshifted key lands correctly but the empty paragraph is still invisible (height 0), which matches the Owner's report.
- IR blockquote: `Y` escapes into the hidden trailing paragraph, leaving `>\n`; WYSIWYG blockquote: `Y` appended inside the quote. Both have the same empty zero-height inner `<p>`.
- IR empty document: a second zero-height `<p>` is created and `Y` lands in the leading block (host `Y\n`, an extra empty block remains).
- List: expected in IR, WYSIWYG and SV (`- Y`). SV heading, list and empty document: expected.
- Different shapes: IR code block at the end — after Ctrl+End and Enter the caret jumps to the end of the first heading and `Y` lands there (`# ProbeY`). Table last cell: Enter gives a `<br>` in the cell (Vditor's rule). SV paragraph: one Enter inserts a single `\n`, so `Y` continues the paragraph (`lima.\nY`).
- Undo observation: after Enter plus a key in an IR/WYSIWYG list or table cell, Undo restores the view but leaves the host dirty with the typed key (the Task 602 history walk does not find the view's text). Not this task's cause; reported to the Owner.
- Orchestrator rulings: merge the IR/WYSIWYG paragraph, heading, blockquote and empty-document cases into Task 625's fix; keep Vditor's rules for list, table-cell and code-block Enter and SV line semantics (one Enter is one source line in SV); the IR code-block-end caret jump to the first heading is a defect in this task's scope and gets its own fix step after Task 625's fix.

## Execution progress — 2026-10-08 (S2 fix, shared with Task 625)

Agent `sonnet-xhigh` (Sonnet 5.5, requested effort xhigh; runtime metadata unverified). The shared CSS fix and its RED/GREEN evidence are recorded in [Task 625](625-ir-enter-next-char-wrong-block.md). Real VS Code, XTEST, spec `test/vscode-e2e/enter-new-paragraph.spec.ts` (build with the fix):

- IR and WYSIWYG paragraph with and without a final LF, and heading: Enter at the end opens an empty `<p>` with a line box (height 21); a Shift-modified `Y` lands in it; host `…lima.\n\nY\n` (no-LF: `…lima.\n\nY`), `## Echo foxtrot\n\nY\n`. The Owner's report is explained by this: before the fix the new paragraph was invisible (height 0) and the next key went into the previous block.
- Blockquote, measured with Vditor's own rule (nothing invented): IR and WYSIWYG both give `> Echo foxtrot golf.\n>\n> Y\n`, with `Y` in the new empty paragraph inside the quote. Before the fix IR let `Y` escape into the hidden trailing paragraph (`> Echo foxtrot golf.\n>\n\nY\n`) and WYSIWYG appended it to the quote text.
- Empty document: IR and WYSIWYG host `Y\n`; `Y` is in the second block (the one Enter added). Before the fix IR typed into the first block and left an extra empty block.
- Two Undos return each case to the opened bytes, clean, with the opened block count (the first removes `Y`, the second the empty paragraph). The "one Undo removes the new paragraph" acceptance item was not measured for Enter without a typed key.
- Not covered by this step: list item, table cell, code block, callout, details, horizontal rule and SV (Vditor's rules kept, per the Part 2 S1 ruling); the IR code-block-end caret jump to the first heading still needs its own fix step.
