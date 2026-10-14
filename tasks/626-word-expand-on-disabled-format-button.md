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

## Execution progress — 2026-10-14 (S1)

- Failing test first: the new cases in `selection-scope.test.ts` ("installFormatWordExpand skips disabled buttons") failed before the fix (5 failed, 81 passed): a disabled bold, italic or strike click expanded the collapsed caret to a word, scheduled the restore timer and moved the caret.
- The caret shift on a disabled click was real before the fix: after the restore timer ran, a caret at offset 7 ended at 9 (bold), at offset 3 ended at 5 (strike), and with the button also current it ended at 5 (7 - 2).
- Fix: in `selection-scope.ts` the click listener now resolves the button through a small helper that returns nothing for a button carrying `vditor-menu--disabled`, so no expansion, no restore timer and no caret request happen. The enabled path is unchanged. The helper keeps `onToolbarClick` under the lint complexity limit.
- Cases covered: disabled bold, italic and strike with a collapsed caret (selection empty, offset unchanged, no timer, offset unchanged after timers); disabled and current together; non-collapsed selection untouched; synthetic (hotkey-path) click leaves the caret unchanged; existing enabled-button cases stay green.
- Checks: Vitest `selection-scope.test.ts` 86 passed; `npm run typecheck` passed; `npx biome check` on both files clean.
- Not run: real-VS-Code and Chromium checks (S2).

## Execution progress — 2026-10-15 (S2)

- Chromium check (acceptance 3): new `media-src/e2e/format-word-expand-disabled.spec.ts`, 4 test cases. The gate harness (`format-hotkey-gate-harness.ts`) gained an opt-in `installWordExpand` entry that installs `installFormatWordExpand` as boot does; the existing gate specs do not call it, so they are unaffected.
  - IR, caret inside inline code, Vditor's own highlight settled (button confirmed disabled): a real pointer click on Bold, Italic and Strike each leaves the selection empty, the anchor node and offset unchanged after the restore timer and a frame, and the source unchanged (3 cases).
  - Control: an enabled Bold click in plain text still expands to the word and formats it (`**bravo**`).
  - Fail-without-fix: with the disabled-class skip temporarily removed, the 3 disabled cases failed (caret offset 3 became 5, 4 and 5) and the control passed; the fix was restored and the build re-run.
- Acceptance 4 (gate specs, each run once): Chromium `format-word-expand-disabled`, `format-hotkey-gate*` and `blockless-caret` together 53 passed. Real VS Code `format-hotkeys.spec.ts` 8 passed. `format-hotkey-live-gate.spec.ts` is skipped without `VMDE_XTEST=1`; with it, a window manager is also needed for the XTEST helper (bare `xvfb-run` fails on `xdotool getactivewindow`), and with a window manager started in the same display it passed 2 of 2.
- The Chromium port 9123 was held by another worktree, so the Chromium runs used a temporary config on port 9626 (deleted afterwards).
- Checks: `npm run typecheck` passed; `npx biome check` on the two e2e files clean.
- No webview behaviour changed in S2, so no new real-VS-Code spec was written; item 3 allows a Chromium check.
