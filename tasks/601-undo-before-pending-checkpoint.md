# Task 601 — Undo/Redo pressed before a pending undo checkpoint lands

**Status:** planned (2026-09-28). The Project Owner approved the finding. Implementation has not started.
**Origin:** found during the Task 598 investigation (2026-09-28).
**Recommended implementer effort:** high.
**Tech stack:** `media-src/src/editing/undo-keybind.ts`, `undo-boundaries.ts`, `edit-activity.ts`, Vitest, Chromium, real VS Code with XTEST.
**Dependencies:**

- **Task 598** must land first. The flush relies on a seeded baseline.
- **Task 602** covers the host coupling; run it after this task. Both touch the history transition.
- Related history: Task 488 (undo checkpoint granularity), Task 463 (undo routing).

**Evidence:** `tmp/task596-603-evidence/t598/results3.json` (scenarios `cur-pending-second-W300`, `cur-pending-second-W700`) and `results2.json` (`flush-*`, the rejected unconditional flush), in the main checkout.

## Problem

This defect is measured in real VS Code on the Task 579 build, IR mode.

Steps:

1. Type `X`.
2. Pause 1.5 s, so `X` gets its own checkpoint.
3. Type `W`.
4. Press Ctrl+Z 300 or 700 ms later, while `W`'s checkpoint is still pending (`undoDelay` 800 ms; the IR prose path delays about 250 ms).

Result:

- The **webview removes both `X` and `W`.**
- The **host keeps `X`**, because native undo reverted only `W`.
- `W` can no longer be redone.
- Webview and host disagree until the next edit.

A Ctrl+Z within about 1 s of any edit with no earlier checkpoint is also a no-op, and the edit stays. This is the same pending-checkpoint window.

## Design

Before running Undo or Redo, record any pending checkpoint, but only when input has arrived since the last one.

1. **Hook points:**
   - the history wrapper in `undo-keybind.ts` (near `:63`, before `original(inner)`);
   - a capture click listener on the toolbar Undo/Redo buttons that runs before `toolbar/Undo.ts`'s disabled check. After the flush, the button may become enabled.
2. **The guard.** Flush only when input has arrived since the last checkpoint. Settle `edit-activity.ts`'s prose delay first, so Vditor has processed the pending input.
   - An unconditional flush was emulated. It recorded spurious entries and cleared the redo stack in IR and SV (`flush-*`). The guard is therefore required.
3. **Ordering.** The checkpoint must be recorded and synced to the host before the history transition is posted, so that Task 602's coupling sees consistent before/after text.

## Owner decisions needed

1. Should an Undo pressed during the pending window undo the pending edit (recommended; the editor convention), or be ignored until the checkpoint lands?

## Tests

- **Vitest** (`undo-keybind.test.ts`, `undo-boundaries.test.ts`):
  - a pending edit is flushed exactly once before Undo;
  - no flush happens without input since the last checkpoint;
  - the redo stack is preserved when nothing is pending;
  - the toolbar-button capture path flushes before the disabled check.
- **Chromium:** type `X`, wait 1.5 s, type `W`, then call `__undo()` 300 ms later. The value is `delta.X`. `__redo()` restores `W`.
- **Real VS Code** (XTEST):
  - The same sequence in IR, WYSIWYG and SV, with Ctrl+Z at 300 and 700 ms. After Undo, the host is exactly `delta.X`. After Redo, exactly `delta.XW`.
  - Webview `getValue()` equals the host after every step.
  - Repeat with the toolbar Undo button and `vmde.format.undo`.

## Acceptance

- [ ] Undo during the pending window removes only the latest edit, in both webview and host, and Redo restores it.
- [ ] No spurious checkpoints are recorded, and the redo stack is not cleared when nothing is pending.
