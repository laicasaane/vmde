# Task 627 — Enter at the end of the document does not open a new paragraph to type in

**Status:** done (2026-10-14).
**Origin:** Project Owner report (2026-10-08).
**Severity:** medium (estimated). A basic authoring action needs a workaround.
**Tech stack:** webview Enter handling (`media-src/src/editing/`, Vditor IR/WYSIWYG/SV Enter paths), real VS Code with XTEST.

## Problem

The Owner reports: pressing Enter at the last position in the file should insert a new paragraph block to write in. Today the Owner has to type a character first, then place the caret before that character and press Enter to get a new paragraph block.

So with the caret at the very end of the document, Enter does not give a new empty paragraph the user can type into. The workaround shows that Enter works when the caret is not at the document end. The report does not say which mode or which kind of last block was involved, so the investigation has to measure that.

## Related

- [Task 625](625-ir-enter-next-char-wrong-block.md): in IR, after Enter at the end of the last paragraph, the first typed character lands at the end of the previous paragraph (measured as `lima.Y`). This is likely the same cause or an overlapping one.
- [Task 608](../608-remaining-blockless-caret-routes.md) and [Task 600](600-no-blockless-caret-in-ir.md): IR carets that sit at the document root, outside any block.
- [Task 486](486-repeated-enter-after-callout-code-caret-snapback.md) and [Task 428](428-list-editing-usability-vs-real-editors.md): earlier Enter and list-Enter work. Check them, and the double-Enter list-exit fix in the CHANGELOG 1.4.0 Fixed section, for rules that must keep working.

## First steps

1. Reproduce in real VS Code with OS-level keys (XTEST) in IR, WYSIWYG and SV. Cover these last-block kinds: paragraph, heading, list item, blockquote, code block, table, callout or details, horizontal rule, and an empty document. Test each with and without a trailing newline in the file.
2. For each case, record the DOM after Enter (is there a new block, and where is the caret?), what the next typed character does, the host bytes, and the Undo steps.
3. Compare with Enter at the end of a middle block.
4. Use Task 625's evidence to decide whether the two tasks should be merged.

## Acceptance

- [x] Enter at the end of the document opens a new empty paragraph after the last block. For a list item or blockquote, Vditor's normal continue and exit rules apply. Inside a fenced code block, Enter stays a newline in the code. Evidence: `enter-new-paragraph.spec.ts` (paragraph, heading, blockquote, empty document, code block; SV line semantics pinned); list item kept on Vditor rules (S1 ruling).
- [x] The caret is inside the new paragraph, and the next typed character lands there. Evidence: same spec, Shift-modified `Y` lands in the new paragraph or code (fix `bba7985d`, `af315ebf`).
- [x] The saved markdown is the expected text: one paragraph appended, exact bytes elsewhere. Evidence: same spec, exact host text asserted per cell.
- [x] One Undo removes the new paragraph. Evidence: holds as worded for Enter alone (1 Undo, host clean); Enter plus a typed key takes 2 Undos (two edits, as in Task 625). See Closure.
- [x] A real-VS-Code XTEST spec covers the measured cases in each mode. Evidence: `enter-new-paragraph.spec.ts`, 6 tests in IR, WYSIWYG and SV; `code-block-end-enter-probe.spec.ts` probe.
- [x] Task 602's Undo specs and the list-Enter undo specs stay green. Evidence: `undo-host-coupling`, `list-enter-undo-caret`, `list-enter-start`, `gap-enter-chain`, `trailing`: 13 passed.

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

The implementer. The shared CSS fix and its RED/GREEN evidence are recorded in [Task 625](625-ir-enter-next-char-wrong-block.md). Real VS Code, XTEST, spec `test/vscode-e2e/enter-new-paragraph.spec.ts` (build with the fix):

- IR and WYSIWYG paragraph with and without a final LF, and heading: Enter at the end opens an empty `<p>` with a line box (height 21); a Shift-modified `Y` lands in it; host `…lima.\n\nY\n` (no-LF: `…lima.\n\nY`), `## Echo foxtrot\n\nY\n`. The Owner's report is explained by this: before the fix the new paragraph was invisible (height 0) and the next key went into the previous block.
- Blockquote, measured with Vditor's own rule (nothing invented): IR and WYSIWYG both give `> Echo foxtrot golf.\n>\n> Y\n`, with `Y` in the new empty paragraph inside the quote. Before the fix IR let `Y` escape into the hidden trailing paragraph (`> Echo foxtrot golf.\n>\n\nY\n`) and WYSIWYG appended it to the quote text.
- Empty document: IR and WYSIWYG host `Y\n`; `Y` is in the second block (the one Enter added). Before the fix IR typed into the first block and left an extra empty block.
- Two Undos return each case to the opened bytes, clean, with the opened block count (the first removes `Y`, the second the empty paragraph). The "one Undo removes the new paragraph" acceptance item was not measured for Enter without a typed key.
- Not covered by this step: list item, table cell, code block, callout, details, horizontal rule and SV (Vditor's rules kept, per the Part 2 S1 ruling); the IR code-block-end caret jump to the first heading still needs its own fix step.

## Execution progress — 2026-10-14 (S2b-a, code-block-end caret probe)

Probe `test/vscode-e2e/code-block-end-enter-probe.spec.ts` (`@probe`; commit `736cb197`). Real VS Code, XTEST, four runs, leg B identical in all four. Document `# Probe\n\nAlpha bravo charlie delta.\n\n```js\nconst echo = 1\n```\n`; contract host text `…const echo = 1\nY\n```\n`.

- **Where Ctrl+End lands.** In the code block's rendered preview (`div.vditor-ir__node > pre.vditor-ir__preview > span > #text`, offset 1, a zero-width space), outside the editable code. No VMDE code writes the selection on that key; it is Chromium's native last caret position in the editable root (there is no trailing paragraph at that moment). Arrow navigation never lands there; a click in the preview is moved into the code by Vditor's own click handler.
- **Cause, in order.** (1) Enter keydown: the caret is in the preview, so Vditor's IR code-block Enter rule (`ir/processKeydown.ts`, keyed to `.vditor-ir__marker--pre`) does not run and the key is not prevented. (2) Native `insertParagraph` adds a second `<code><br></code>` inside the marker `pre`. (3) Vditor `input()` re-spins the block; Lute drops the second `<code>` and its `<wbr>`, so the newline is lost and `setRangeByWbr` finds no marker; the selection is left collapsed on the editable root. (4) The patched Undo `addCaret` (VMDE patch layer, `media-src/esbuild-shared.mjs` `patchUndoCaretSplitRestore`) turns that root-level selection into text offset 7. (5) The caret authority (`media-src/src/editing/caret.ts`) resolves offset 7 to the end of the first heading, and `Y` lands there (`# ProbeY`).
- **Legs.** Ctrl+End, Enter, Shift+Y: defect. A caret written into the preview text, then Enter: same defect. A caret at the code line end (programmatic, or Ctrl+End from there): contract met. Ctrl+End then typing without Enter: `const echo = 1Y` (typing is fine). Click on the code line: Vditor puts the caret at code offset 0 (Vditor's rule, not this defect). WYSIWYG, record only: Ctrl+End also lands in the preview and Enter then types at the end of the previous paragraph (`…delta.Y`).
- **Orchestrator ruling (2026-10-14).** Fix layer: a VMDE keydown handler in the capture phase. When Enter is pressed with a collapsed selection inside a code block's rendered preview, move the selection to the end of that block's code text before Vditor's keydown runs, so Vditor's own code-block Enter rule applies. IR is in scope; WYSIWYG is in scope too (same landing, same acceptance item "Inside a fenced code block, Enter stays a newline in the code"), with the WYSIWYG code-block structure measured in the RED step. Not in scope: changing where Ctrl+End lands, and hardening the Undo `addCaret` patch against root-level selections (a shared caret layer with many consumers; offered to the Owner as a follow-up task).
- **RED cases for the fix.** IR and WYSIWYG: (1) Ctrl+End, Enter, Shift+Y gives `…const echo = 1\nY\n```\n`, caret inside the code after Enter; (2) a caret placed in the preview text, Enter, Y gives the same; controls that must stay unchanged: a caret at the code line end, then Enter; Ctrl+End then typing without Enter (`const echo = 1Y`); Enter at the end of a paragraph (Task 625 behaviour).

## Execution progress — 2026-10-14 (S2b and S3)

Fix commits: CSS `bba7985d` (Task 625, empty-paragraph line box) and `af315ebf` (`setupCodeBlockPreviewEnter`, `media-src/src/editing/code-block-enter.ts`: Enter with the caret in a code block's rendered preview moves the caret to the end of the block's code first, so Vditor's own code-block Enter rule runs).

**Spec.** `test/vscode-e2e/enter-new-paragraph.spec.ts` (extended; real VS Code, XTEST, `VMDE_XTEST=1`) now has six tests. The four from Task 625 are unchanged. New:

- IR and WYSIWYG, one test each, document `# Probe\n\nAlpha bravo charlie delta.\n\n```js\nconst echo = 1\n```\n`. Cell `code-ctrl-end`: focus, Ctrl+End, Enter, Shift+Y by XTEST. Cell `code-line-end` (control): caret at the end of the code line, Enter, Shift+Y. Both assert host text exactly `…```js\nconst echo = 1\nY\n```\n`, the caret in the editable code (not the preview) after Enter and after `Y`, and the Undo presses back to the opened bytes with the host clean. Ctrl+End lands in the rendered preview in both modes (measured: `placed: preview`).
- SV, one test, two cells. `code-ctrl-end` (Ctrl+End, Enter, `Y`): host `…```js\nconst echo = 1\n```\n\nY\n`. In SV, Ctrl+End lands after the closing fence, so Enter is a source newline there and `Y` is a separate line after the block (Vditor/SV semantics kept, one Enter is one source line). `code-line-end` (caret at the end of `const echo = 1`): host `…```js\nconst echo = 1\nY\n```\n`, a source newline inside the fence.
- IR and WYSIWYG, Enter alone (no typed key) at the end of a final paragraph, with and without a final LF.

**Undo counts (measured).**

- Code block at the end, Enter then `Y` with the pause between them above Vditor's 800 ms undo delay: 2 Undo presses back to the opened bytes, clean (first removes `Y`, second the newline), in IR and WYSIWYG, for both Ctrl+End and the line-end control; 12 of 12 repeated cells. With a 100 ms pause the count was 1 or 2 from run to run (the two edits merge into one undo step when both fall inside the delay), so the spec uses the longer pause and asserts 2.
- Enter alone at the end of a final paragraph, IR and WYSIWYG, with and without a final LF: the host text does not change (the empty trailing paragraph does not serialize; the document stays clean), the view goes from 3 to 4 blocks, and one Undo press returns the opened block count. The acceptance wording "One Undo removes the new paragraph" therefore holds for Enter alone; with a typed key after it, two Undos are needed (Task 625/627 cells, unchanged). The wording decision is left to the orchestrator.

**Commands and totals.** Build `node build.mjs` before each real-VS-Code run; runs `env -u ELECTRON_RUN_AS_NODE xvfb-run -a … npm --prefix test/vscode-e2e test -- <spec> --workers=1 --retries=0` inside the isolated Xvfb/Openbox shell of `docs/os-keyboard-testing-setup.md`.

- `enter-new-paragraph.spec.ts` on the fixed build: 6 passed (final run). One earlier whole-file run had one failure in an unchanged Task 625 cell (WYSIWYG `paragraph-nolf`, "Undo 1: the host is clean" read as dirty right after the text matched); the same test then passed 4 of 4 repeats and the next whole-file run passed 6 of 6, so it is recorded as an intermittent dirty-flag lag in that older cell, not caused by this step.
- Code-block cells repeated 3 times in IR and WYSIWYG: all green after the pause change.
- Without the `setupCodeBlockPreviewEnter` call (call commented out in `media-src/src/boot/main.ts`, rebuilt, restored byte-identical and rebuilt after): `code-ctrl-end` fails in IR (`# ProbeY…`, caret in the first heading) and in WYSIWYG (`…delta.Y`, caret in the previous paragraph); the line-end controls and the SV cells pass. 2 failed, 1 passed (SV).
- Regression reruns on the fixed build, one invocation: `undo-host-coupling.spec.ts`, `list-enter-undo-caret.spec.ts`, `list-enter-start.spec.ts`, `gap-enter-chain.spec.ts`, `trailing.spec.ts`: 13 passed (8 + 1 + 1 + 2 + 1).
- `npm run typecheck:vscode-e2e` clean; `npx biome check test/vscode-e2e/enter-new-paragraph.spec.ts` clean.

**Open.** Acceptance items now covered by specs: caret and next typed character in the new paragraph, saved text, code-block Enter staying in the code, Undo counts as measured above. Not changed: where Ctrl+End lands, and hardening the Undo `addCaret` patch against root-level selections (offered to the Owner as a follow-up).

## Closure — 2026-10-14

**Commits.** Probe `630bd01b` (shared with Task 625), CSS fix `bba7985d` (shared with Task 625), code-block probe `736cb197`, RED `9773062f`, fix `af315ebf`, real-VS-Code legs `5c9d6294`, record commits `9fdb1a9d`, `0704d810`.

**Gates on HEAD `4c97b1f2`** (network-free, run once):

- `npm run lint:ci`: exit 0 after the RED spec `media-src/e2e/code-block-enter-preview-caret.spec.ts` was refactored (its selection helper split so cognitive complexity is within the limit, then formatted; first run on HEAD had 2 errors there). Chromium run of that spec: 10 passed.
- `npm run typecheck`: exit 0. `npm run knip`: exit 0. `npm run depcruise`: exit 0 (no violations, 66 and 275 modules). `npm run jscpd`: exit 0 (1,527 clones, 6.35% duplicated lines).
- `npm run test:coverage`: exit 0; 333 files passed; 6,176 tests passed, 1 expected fail. Statements 77.88%, branches 71.32%, functions 81.54%, lines 80.01%.
- `npm run check:coverage-modules`: exit 0 (11 modules at 0%, baseline 11). `npm run check:brand-identifiers`: exit 0 (2,424 tracked paths).
- `npm run quality` and any audit were not run (omitted by Owner instruction).
- `node build.mjs`: exit 0. `media/dist/main.js` 945,162 B (923.0 KiB), +1,203 B against the Task 625 close (943,959 B). `npm run check:startup-cost`: eager modules 353 (Task 625: 352), over the 294 budget as before; largest module 30 KB of 34 KB.

**Rulings.**

- "One Undo removes the new paragraph" holds as worded: Enter alone at the end of a final paragraph takes 1 Undo (host unchanged and clean; the empty paragraph does not serialize). Enter followed by a typed key takes 2 Undos (two edits, as in Task 625). No fast-typing variant: edits inside Vditor's undo delay merge (upstream).
- Out of scope, kept on Vditor's rules per the S1 ruling: list item, table cell, callout, details, horizontal rule. SV keeps one Enter as one source line (measured and pinned in the spec).

**Residuals.**

- [Task 628](628-list-table-enter-undo-host-dirty.md): list and table Undo leaves the host dirty.
- A possible hardening of the Undo caret patch for root-level selections is offered to the Owner (not filed).
- One WYSIWYG `paragraph-nolf` run failed once on "Undo 1: the host is clean" (dirty-flag lag); it passed 4 of 4 repeats and the next whole-file run. Recorded, not new to this change.
