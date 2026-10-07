# Task 626 — Word-expand changes the selection when the clicked format button is disabled

**Status:** planned (2026-10-07).
**Origin:** found while closing [Task 596](done/596-toolbar-hotkeys-live-selection-gate.md). Measured in a Task 596 S2 unit run. It predates Task 596: the listener never looked at the disabled class.
**Severity:** low to medium. A click or hotkey that Vditor ignores still moves the selection, but no markdown is corrupted.
**Tech stack:** TypeScript webview (`media-src/src/editing/selection-scope.ts`), Vitest, Chromium, real VS Code.

## Problem

`installFormatWordExpand` in `media-src/src/editing/selection-scope.ts` is a capture-phase listener. When a format button is clicked with a collapsed caret, it expands the caret to the word under it before Vditor's own click handler runs.

It does this even when the clicked button is `vditor-menu--disabled`. Vditor ignores a click on such a button, so the format is not applied, but the listener has already changed the selection.

Measured in a Task 596 S2 unit run: with the caret at offset 7 in "hello world" and a disabled Bold button, the click turned the caret into the selection "world".

## First step

Decide whether word-expand should skip disabled buttons. If yes, the listener checks the button's `vditor-menu--disabled` class and leaves the selection alone. Note that the hotkey route (`handleTriggerToolbarHotkey`) now syncs the gate classes before the click, so the class is current there; a mouse click reads Vditor's debounced class, which can be stale for up to 200 ms.

## Acceptance

- [ ] A decision is recorded: skip disabled buttons, or keep the current behaviour and say why.
- [ ] If skipped: a unit test shows a disabled button leaves a collapsed caret unchanged, and an enabled button still expands it.
- [ ] A real-VS-Code or Chromium check shows the caret is unchanged after a click on a disabled button in a context where Vditor disables it (for example Bold inside inline code in IR).
- [ ] Task 596's gate and its specs stay green.

## Tests

- Vitest for `installFormatWordExpand` (`selection-scope.test.ts`).
- Chromium harness or real VS Code for the disabled-button case.
