# Task 720 — IR Undo and Redo flicker the whole view

**Status:** done (2026-11-10).
**Origin:** Owner report, 2026-11-09.
**Severity:** high (estimated). Every Undo and Redo in IR is visibly disruptive.
**Tech stack:** Vditor IR undo (`vditor/src/ts/undo/index.ts`), VMDE Undo patches in `esbuild-shared.mjs`, `media-src/src/editing/undo-boundaries.ts`, renderers and decorators that run after an Undo (diagram cache, responsive tables, properties table, wiki chips, fold gutters).
**Depends on:** none.

## Problem

Owner report: after pasting or typing in IR, Ctrl+Z makes the entire IR view flash and refresh, and text and elements jump around. Ctrl+Y (Redo) does the same. The Owner expects Undo and Redo to remove or reapply only the recent input, without affecting anything else on screen.

Not yet known: whether the whole editor DOM is replaced, which blocks render again (diagrams, tables, previews), what moves the layout and the scroll position, and whether WYSIWYG and Split View behave the same.

## Decisions

- D1 (Owner, 2026-11-10): fix direction A+B. Undo and Redo restore only the blocks that differ (block-scoped restore in Vditor `renderDiff`), and every VMDE reaction is hardened as well: the scroll reveal waits until off-screen blocks regain their size, table column widths survive N-to-N table replacement, and the WYSIWYG caret no longer falls back to the document start.
- D2 (provisional, orchestrator, 2026-11-10): the large-document Undo/Redo time (1.2 to 1.4 s after fix A) is mostly the history coupling's two whole-document `getValue` calls (`undo-keybind.ts:226` and `:228`, 70 to 80 percent). It is fixed in this task as Part 2c, after Parts 2a and 2b are merged: `readText` uses the incremental IR serializer (byte-identical to `getValue` by contract) and the last published text for the "before" side.
- D3 (provisional, orchestrator, 2026-11-10): the WYSIWYG front-matter source flash after Undo comes from the opening snapshot's caret marker sitting in the front matter. Part 2b re-anchors or skips a caret marker inside the front matter so a history restore keeps the table.
- D4 (provisional, orchestrator, 2026-11-10): the new Vditor patch gets a row in `docs/vditor-patch-checklist.md`.
- D5 (provisional, worker, accepted by the orchestrator 2026-11-10): the large-document scroll jump is fixed by carrying each block's measured size across the restore (inline `contain-intrinsic-size` on re-created blocks, matched by tag and source text) inside the restore bridge, instead of skipping or re-anchoring the reveal. Measured: the jump comes from lost block sizes, and re-anchoring would still change `scrollTop` by about 97 px.

## Proposed work

1. Part 1: a `@probe` real-VS-Code spec measures DOM mutations, re-rendered blocks, layout shifts, block positions and scroll per frame after a real Ctrl+Z and Ctrl+Y in IR, with frame screenshots to confirm the flicker.
2. Decide the fix from the measured mechanism (ask the Owner if it changes Undo granularity or behavior).
3. Fix with a failing test first, and a focused real-VS-Code spec.

## Acceptance

- [x] The mechanism is measured and named for Undo and Redo after typing and after paste. Vditor `renderDiff` set `element.innerHTML` for the whole root on every Undo and Redo (Part 1 probe `ir-undo-flicker-probe.spec.ts`).
- [x] Undo and Redo in IR change only the blocks the undone or redone edit touched; unchanged blocks keep their DOM identity and position, and the scroll position stays. Blocks kept 29/30 and 1329/1330; scroll change 0 px; table widths unchanged (`undo-block-restore.spec.ts`, `undo-restore-reactions.spec.ts`).
- [x] No visible flash in a frame series around Undo and Redo. Kept previews are not re-rendered; the WYSIWYG front matter stays a table.
- [x] Undo/Redo correctness and caret-restore specs still pass. History text is byte-identical to `getValue()` in every audited read (`history-text-identity.spec.ts`, 4 fixtures). On the 112 KB document, key to end of the Undo/Redo task is 196/116 ms (was 872/1202 ms).
- [x] `npm run quality` passes.

## Verification (2026-11-10)

- `node build.mjs`: pass.
- Real VS Code: `history-text-identity`, `undo-block-restore`, `undo-restore-reactions`, `undo-restore-caret`, `front-matter-table`, `table-auto-width`: 23 passed.
- `npm run quality`: all stages pass.
- Known unrelated flake: `undo-restore-caret.spec.ts:805` failed on the 719 base in an earlier run; it passed in this run.

## Owner approval

- 2026-11-10 (Owner, chat): "I approve to close 719–725 as they are now." Every provisional decision in this record is accepted as final.
