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

## Part 1 handoff (2026-10-14)

Read-only review of the source; nothing was run.

- **Decision: skip disabled buttons.** The word-expand listener does nothing when the clicked button has `vditor-menu--disabled`.
- **Cause (verified by reading).** `media-src/src/editing/selection-scope.ts` `onToolbarClick` (capture phase, installed from `boot/finish-init.ts`) filters on `button[data-type]` and the word formats (bold, italic, strike) but never reads `vditor-menu--disabled`. Vditor's `toolbar/MenuItem.ts` reads the same class on the same button in the same dispatch (bubble phase) and returns early when disabled, so today the caret expands to a word and nothing formats it.
- **Second effect (inference, to probe in S1/S2).** When the expansion runs, `scheduleCaretRestore` requests the caret at `caretOffset + delta` (+2 bold/strike, +1 italic), so after a disabled click the caret may also end up 1–2 characters to the right.
- **Where Vditor disables the word formats.** IR inline code and code blocks; WYSIWYG code, and WYSIWYG headings (bold only). Never in SV; tables disable none of them (`media-src/src/editing/format-hotkey-context.ts` mirrors the rules).
- **Contract.** (1) In `onToolbarClick`, right after the word-format check and before the caret offset is read, return when `button.classList.contains('vditor-menu--disabled')`: no expansion, no restore timer, no caret request. (2) Use the literal class string (as the neighbouring `vditor-menu--current` check does). (3) The enabled path is unchanged. (4) The class can be up to 200 ms stale for mouse clicks, but Vditor's own handler reads the same class in the same event, so skipping matches exactly what Vditor does: a stale "disabled" click is ignored by Vditor anyway; a stale "enabled" click inside code is the accepted Task 596 mouse-click residual (out of scope). The hotkey/command route syncs the classes before its click, so the skip is exact there.
- **Part 2.** S1 (Vitest, `selection-scope.ts` and its test only): RED first — a disabled bold click with a collapsed caret leaves the selection empty, the caret offset unchanged and schedules no timer; the same for italic and strike; disabled and current together: still skipped; a non-collapsed selection on a disabled button untouched; a synthetic click on a disabled button leaves the caret unchanged; enabled bold still expands and shifts the caret as today (existing tests). Record whether the caret shift on a disabled click is real. S2: focused real-VS-Code spec (e.g. `test/vscode-e2e/format-word-expand-disabled.spec.ts`, modelled on `format-hotkeys.spec.ts`): caret inside IR inline code, wait for Vditor's highlight to disable Bold, click the real Bold button: the button is disabled, the selection is empty, the caret offset unchanged (also after the restore delay), the document unchanged; italic and strike too; control in a plain paragraph formats the word as today. Keep `format-hotkeys.spec.ts`, `format-hotkey-live-gate.spec.ts`, the Chromium `format-hotkey-gate*` specs and `blockless-caret.spec.ts` green. S3: closure.
- **Edge cases.** Disabled and current together; SV unchanged; non-collapsed selections already untouched; heading dropdown buttons ignored; read-only and full Preview block the hotkey route before the click (mouse clicks there not covered); blockless IR refusal runs before the gate.
- **Owner questions.** None; no recorded Owner rule conflicts.
