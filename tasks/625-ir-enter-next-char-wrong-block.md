# Task 625 — In IR, the first character typed after Enter at a paragraph end lands in a neighbouring block

**Status:** planned (2026-10-07).
**Origin:** found by the Task 602 S3b probe (real VS Code 1.129.0, XTEST). It is identical on the pre-602 product and on `dev` at `092b59e0`, so Task 602 did not cause it and does not fix it.
**Severity:** looks high, because typed text appears in the wrong block. It is measured only under XTEST input, so the first step is to confirm it with a normal key route.
**Tech stack:** IR mode caret handling in the webview (`media-src/src/editing/`), real VS Code with XTEST.

## Problem

In IR mode, press Enter at the end of a paragraph. The caret is in the new empty `<p>` at offset 0, but the next typed character does not go there:

- when another block follows, the character lands at the start of that following block (for example `YEcho ...`);
- when the paragraph was the last block, it lands at the end of the previous paragraph (for example `lima.Y`, or `lima.XY` after an earlier `X`).

## Evidence

- Task 602 S3b probe, 16 cells on the pre-602 product and 16 on `dev`, identical in every cell.
- Deterministic and independent of timing and of earlier typing: the same result with pauses of 100 ms and 1,000 ms, with and without a preceding `X`.
- The probe logs were kept in the Task 602 session scratchpad only and are not retained. The result has to be re-measured.

## First step

Confirm the defect with a normal key route (not only XTEST), and check how it relates to [Task 600](done/600-no-blockless-caret-in-ir.md) and [Task 608](608-remaining-blockless-caret-routes.md), which deal with IR carets that sit outside their block.

## Acceptance

- [ ] A real-VS-Code spec reproduces the misplacement on `dev` and shows it is removed by the fix, for an Enter at the end of a middle paragraph and at the end of the last paragraph, at 100 ms and 1,000 ms pauses.
- [ ] The cause is identified with evidence, and its relation to Tasks 600 and 608 is recorded.
- [ ] The first typed character after Enter lands in the new paragraph, and the markdown round-trip is unchanged.
- [ ] Task 602's Undo specs and the list-Enter undo specs stay green.

## Tests

- Real VS Code with XTEST: Enter at a paragraph end, then one character, in IR with and without a following block.
- Chromium harness or Vitest for any caret helper that changes.

## Part 1 handoff (2026-10-08, shared with Task 627)

Agent `opus-high` (Opus 5.5, requested effort high; runtime metadata unverified). Read-only; scratch Node runs of Lute `SpinVditorIRDOM`/`SpinVditorDOM` only.

- Primary hypothesis H1 (likely shared with Task 627): native Enter at a paragraph end creates `<p><br></p>`; Vditor's IR/WYSIWYG input re-spin drops the `<br>` and `setRangeByWbr` puts the caret at `P@0` in an empty `<p>`. Upstream Vditor gives that `<p>` a line with `p:empty::before { content: ' ' }` under `white-space: pre-wrap`, but VMDE's reflow rule `:is(.vditor-ir, .vditor-wysiwyg) .vditor-reset :is(p, li) { white-space: normal; }` (`media-src/src/main.css:177-179`, commit `28ad191a`) collapses it, so the paragraph has no line box and Chromium puts the next character at a neighbouring valid position (next block start, or previous block end for the last paragraph). Inference until measured.
- Alternative H2: a VMDE writer moves the selection between Enter and the next key. The probe's `beforeinput` record decides.
- `undo-host-coupling.spec.ts` `flushUndoJourney` pins the defect (`…lima.XY`); a fix updates those expectations (orchestrator ruling: in scope).
- Part 2 S1: one probe file `test/vscode-e2e/enter-new-paragraph-probe.spec.ts` (`@probe` titles) with T1 (625: XTEST middle/last × 100/1,000 ms, CDP route, CSS-control cells) and T2–T4 (627: IR, WYSIWYG, SV by last-block kind). Run 625 first, then 627.
- Orchestrator rulings: blockquote, list-item and code-block ends keep Vditor's Enter rules (queue rule); SV and table Enter-at-end are recorded first and decided after measurement; the fix layer (CSS line box vs a ZWSP-seeding Vditor patch) is chosen after the CSS-control cells.

## Execution progress — 2026-10-08 (S1 probe)

Agent `sonnet-high` (Sonnet 5.5, requested effort high; runtime metadata unverified). Probe `test/vscode-e2e/enter-new-paragraph-probe.spec.ts` (commit `630bd01b`, `@probe` titles). Real VS Code, XTEST + Openbox, `--workers=1 --retries=0`; the 625 test ran twice with identical cells (deterministic). Logs and JSON in the session scratchpad only.

- Confirmed with OS-level keys, timing-independent (100 and 1,000 ms): after Enter at a paragraph end in IR the caret is `P@0` in a new empty `<p>` (0 children, height 0, `white-space: normal`, no client rects). A **Shift-modified** first key (`Y` by XTEST or CDP `Shift+Y`) gets a `beforeinput` target range outside that block: the next block's start (middle: host `…\n\nYEcho…`) or the previous block's end (last: `…lima.Y`).
- An unshifted first key (`y` by XTEST, `Y` by CDP `keyboard.type`) lands correctly: Vditor's `fixCJKPosition` (`util/fixBrowserBehavior.ts:44`, called from IR/WYSIWYG `processKeydown`) seeds a ZWSP at a `p`/`li` start on keydown but returns early on `event.shiftKey` (inferred from source plus the measured mutation order).
- CSS control (`p:empty { white-space: pre-wrap }` adopted at runtime): the empty `<p>` gets height 21, the target range stays in it, and both cells give the exact expected host text. H1 holds; H2 (a VMDE writer moving the selection) is refuted — the selection stays at the new `P@0` until `beforeinput`.
- Undo after Enter+key: two host Undo steps back to the opened bytes, clean, in the paragraph cases.
- Orchestrator ruling: Task 627's IR/WYSIWYG paragraph, heading, blockquote and empty-document cases share this cause and are fixed here (merge recorded in Task 627). Fix layer: CSS line box for empty prose blocks, RED first.

## Execution progress — 2026-10-08 (S2 fix)

Agent `sonnet-xhigh` (Sonnet 5.5, requested effort xhigh; runtime metadata unverified). Fix layer: CSS line box (branch A of the Part 1 handoff).

- **RED first.** New Chromium spec `media-src/e2e/enter-empty-paragraph.spec.ts` on the keybugs harness (it serves the source `main.css`): IR and WYSIWYG, Enter at the end of a middle paragraph, the last paragraph, a last heading and a last blockquote, then Playwright `Shift+Y`. On the unchanged `main.css` all 8 cells failed (the new empty `<p>` has height 0 and `Y` lands in a neighbouring block: `YEcho …`, `…lima.Y`, `## Echo foxtrotY`, `> Echo foxtrot golf.Y`); the guard that non-empty paragraphs keep `white-space: normal` passed. The real-VS-Code spec `test/vscode-e2e/enter-new-paragraph.spec.ts` (XTEST, 14 cells) then ran on a pre-fix build: all 9 IR cells and 4 of 5 WYSIWYG cells failed (WYSIWYG empty document already worked); an earlier draft of the same spec failed the same cells.
- **Fix.** `media-src/src/main.css`: `:is(.vditor-ir, .vditor-wysiwyg) .vditor-reset p:empty { white-space: pre-wrap; }` directly after the 28ad191a reflow rule (specificity (0,3,1) against (0,2,1)). Only childless paragraphs match, so every paragraph with content keeps the reflow; the trailing, leading and gap paragraphs carry a ZWSP seed (never `:empty`) and `p[data-vmde-trailing]:not(.vmde-trailing--active)` still sets height 0. `li:empty` is not touched (Vditor has no line-box rule for it and none was measured).
- **GREEN.** Chromium: new spec 9/9. Real VS Code (XTEST, rebuilt with the fix): `enter-new-paragraph.spec.ts` 2/2 tests, all 14 cells: the new `<p>` is empty with height 21, the host text is exact, `Y` is in the block that held the caret after Enter, and two Undos return to the opened bytes, clean, with the opened block count. 625 middle and last pass at 100 ms and 1,000 ms.
- **Regression.** `undo-host-coupling.spec.ts` on the fixed build: the 7 other tests and 8 of 9 journeys in the last test passed; only `flushUndoJourney` failed, as predicted, because it pinned the defect (`…lima.XY`, host length 93 against 91). Its expectation is updated to the correct outcome (`…lima.X\n\nY\n`, in the host and the view; the entries added (3), the single native step for the first Undo and the six history steps are unchanged), and the last test then passed (all 9 journeys). Also green on the fixed build: `list-enter-undo-caret`, `list-enter-start`, `gap-enter-chain` (2), `trailing`, `softbreak`, `ir-core-interactions` (3), `hr-edit` (3), `bottom-gap`, `inline-code-gap` (4), `blockless-caret` (2) and `gap-cursor`. `auto-wrap.spec.ts` and `rewrap.spec.ts` (real VS Code) fail on the fixed build with `Paragraph 401 … not found in IR` and `scrollKept: false`; they fail identically on the unchanged build, so they are pre-existing and unrelated. Chromium neighbours (22 specs, 296 tests): 293 passed; `undo-boundaries` WYSIWYG Redo passed on rerun (load flake), and `auto-wrap` SV and `callout-ir` IR (Alt+L) fail identically in a scratch worktree at `1dc13ccf`.
- **Relation to Tasks 600 and 608.** Not a blockless caret: the selection stays at the new `P@0` inside a block, so no editor-caret route changed.
- **Not done here (Task 627 owns them).** IR code-block-end caret jump, table cell Enter, list and SV Enter semantics, the list/table Undo host-dirty observation.
