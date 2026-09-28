# Task 603 — Undo routing cleanup: VS Code chords, Find input and caret-only steps

**Status:** planned (2026-09-28). The Project Owner approved the findings. Implementation has not started.
**Origin:** incidental findings from the Task 597 investigation (2026-09-28).
**Recommended implementer effort:** medium. Item 3 needs high if it is not folded into Task 597.
**Tech stack:** `media-src/src/editing/undo-boundaries.ts`, `undo-keybind.ts`, `media-src/src/bridge/message-router.ts`, Vitest, Chromium, real VS Code with XTEST.
**Dependencies:**

- Run after **Task 579**, which owns the Find input.
- Coordinate with **Task 580**: the command rework changes which keys reach the webview.
- Item 3 overlaps Task 597's optional capture-time hardening. If Task 597 includes that hardening, close item 3 there.

**Evidence:** `tmp/task596-603-evidence/t597/` in the main checkout. Real VS Code 1.129.0, `VMDE_XTEST=1`, Task 579 build.

## Items

1. **Ctrl+Shift+E creates an undo boundary and re-sends the document (measured).**
   - `MODEL_COMMAND_KEYS` contains `'e'` (`undo-boundaries.ts:18`).
   - VS Code's Explorer chord Ctrl+Shift+E therefore runs a checkpoint and `input(getValue())` (`:87-88`, `:164`).
   - Fix: only treat as a model command a chord that actually maps to a webview model command. Derive the set from the shared hotkey table rather than a letter list, so Task 580's remapping cannot make it stale.
2. **Ctrl+Z inside the Find input undoes the document (inferred from source; measure first).**
   - `undo-keybind.ts:116-133` has no exclusion for the Find widget.
   - Expected, as in VS Code: Ctrl+Z / Ctrl+Y inside the Find or Replace input edit the input's own text.
3. **An external change leaves a caret-only undo step (measured).**
   - After a host `update` (`message-router.ts:229` → `setValue(content, true)` → `clearStack`), the base snapshot has a `<wbr>` at the root.
   - The 800 ms debounce then adds a second entry that differs only in the caret.
   - The user's second Ctrl+Z changes no text and moves the caret to `PRE@0`.
   - Fix: record the base snapshot after `caret-preserve.ts` restores the caret, or drop entries that differ only in the caret.

## Tests

- **Vitest:**
  - `undo-boundaries.test.ts`: Ctrl+Shift+E and other VS Code chords record no checkpoint; mapped model commands still do.
  - `undo-keybind.test.ts`: key events targeting the Find inputs are not routed to document undo.
  - Item 3: no caret-only entry after a simulated host update.
- **Real VS Code** (XTEST):
  - Ctrl+Shift+E, then Ctrl+Z: no extra undo step, and the host version does not change.
  - Type in the Find input, press Ctrl+Z: the input text reverts and the host document does not change.
  - External WorkspaceEdit, type `Y`, Ctrl+Z twice: the second Ctrl+Z undoes the external change (or does nothing, per the owner's decision), and never produces a text-free step.

## Owner decisions needed

1. Item 3: should the second Ctrl+Z after an external change undo the external change in the webview history, or should that history start at the external change?

## Acceptance

- [ ] Each item has its real-VS-Code leg passing with exact host text and version checks.
