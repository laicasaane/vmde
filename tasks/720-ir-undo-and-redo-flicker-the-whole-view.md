# Task 720 — IR Undo and Redo flicker the whole view

**Status:** in progress (2026-11-09). Part 1 (measurement and cause) running.
**Origin:** Owner report, 2026-11-09.
**Severity:** high (estimated). Every Undo and Redo in IR is visibly disruptive.
**Tech stack:** Vditor IR undo (`vditor/src/ts/undo/index.ts`), VMDE Undo patches in `esbuild-shared.mjs`, `media-src/src/editing/undo-boundaries.ts`, renderers and decorators that run after an Undo (diagram cache, responsive tables, properties table, wiki chips, fold gutters).
**Depends on:** none.

## Problem

Owner report: after pasting or typing in IR, Ctrl+Z makes the entire IR view flash and refresh, and text and elements jump around. Ctrl+Y (Redo) does the same. The Owner expects Undo and Redo to remove or reapply only the recent input, without affecting anything else on screen.

Not yet known: whether the whole editor DOM is replaced, which blocks render again (diagrams, tables, previews), what moves the layout and the scroll position, and whether WYSIWYG and Split View behave the same.

## Proposed work

1. Part 1: a `@probe` real-VS-Code spec measures DOM mutations, re-rendered blocks, layout shifts, block positions and scroll per frame after a real Ctrl+Z and Ctrl+Y in IR, with frame screenshots to confirm the flicker.
2. Decide the fix from the measured mechanism (ask the Owner if it changes Undo granularity or behavior).
3. Fix with a failing test first, and a focused real-VS-Code spec.

## Acceptance

- [ ] The mechanism is measured and named for Undo and Redo after typing and after paste.
- [ ] Undo and Redo in IR change only the blocks the undone or redone edit touched; unchanged blocks keep their DOM identity and position, and the scroll position stays.
- [ ] No visible flash in a frame series around Undo and Redo.
- [ ] Undo/Redo correctness and caret-restore specs still pass.
- [ ] `npm run quality` passes.
