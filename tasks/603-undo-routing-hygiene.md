# Task 603 — Undo routing cleanup: VS Code chords, Find input and caret-only steps

**Status:** in progress (2026-10-07). Part 1 handoff ready (below); Part 2 S1 next.
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

Settled under the Owner rule of 2026-09-28 (`tmp/queue-part1/596-603-rulings.md`): the webview history starts at the external change, so a second Ctrl+Z changes neither text nor caret.

## Part 1 handoff (2026-10-07, reconciled with `c9b259d7`)

Reasoning: Claude Opus 5.5 `medium` (`opus-medium`), read-only, no runs. Supersedes the source references of `tmp/queue-part1/603-native-handoff.md` (written against pre-580 `8c2ec1f0`).

**Item 1, Ctrl+Shift+E boundary: cause removed by Task 580; add regression tests only.** `MODEL_COMMAND_KEYS` no longer exists. The keydown boundary applies only to the macOS Cocoa Ctrl+D/H/K chords (`media-src/src/editing/undo-boundaries.ts:21`); `isUndoBoundaryCommand` returns false when `shiftKey` is set (`:187`), and `onKeydown` (`:342-348`) only seeds an empty history and posts no `input`. Existing tests cover Ctrl+E but not Ctrl+Shift+E (`undo-boundaries.test.ts:68-94`, `:199-213`). The new tests pass on HEAD; record that as "cause removed by Task 580", not as a RED.

**Item 2, Ctrl+Z / Ctrl+Y in the Find or Replace input undo the document: still present (from source).** VS Code's webview preload calls `preventDefault` on Ctrl/Cmd+Z/Y, so the input's native undo never runs; Task 580's P2 measured that the G1 `when` clause (`src/shared/editor-shortcuts.ts:24`) matches with focus in the Find input. `vmde.format.undo` therefore posts `trigger-toolbar-hotkey`, whose handler calls `inner.undo.undo` with no input check (`media-src/src/bridge/message-router.ts:827-838`; comment at `:807-811`). Fix: in that Undo/Redo branch, after `discardCommandSelection()` and `invalidateCaret()`, if `focusedTextInput()` returns an input, run `document.execCommand(msg.name)` on it and return, even when the call returns false (empty input history). This is the order `runEditorAction` already uses (`editor-actions.ts:241-246`); export `focusedTextInput` (`:160`) and reuse it. VS Code's own webview Undo sends `execCommand` the same way. The Find input's `input` listener (`selection-scope.ts:1823`) refreshes matches; `undo-boundaries` `onInput` skips Find events. Edge cases: opening Find writes `elements.find.value = seed` (`selection-scope.ts:1701`), which clears the input's native history, so an Undo right after opening changes neither the input nor the document; Redo works through Ctrl+Y and Ctrl+Shift+Z; focus stays in the same input; the document's Undo depth and host version do not change.

**Item 3, caret-only step after an external change: still present (from source).** `setHostUpdateValue` (`message-router.ts:230-255`) calls `setValue(content, true)`. Vditor's `setValue` arms the delayed after-render record (`enableAddUndoStack: true`, `enableInput: false`), then its `clearStack` resets the stacks and immediately adds a base entry (`node_modules/vditor/src/index.ts:363-366`). That base is taken before `preserveCaretAndScroll` calls `requestCaret` (`caret-preserve.ts:46-53`), so it records the caret at the root; 800 ms later the record adds a second entry with the same text and a different caret (`tmp/task596-603-evidence/t597/results-small2.json` P8). Tasks 598, 601 and 602 do not change this (Task 602's wrapper only reports entries, `undo-keybind.ts:65-86`; Task 601's drain skips records without `enableInput`, `undo-boundaries.ts:160`). Fix, ordinary `!owned` branch only: call `setValue(content, false)`; inside the same `mutate`, set `enableAddUndoStack = false` on the after-render record `setValue` just armed (new helper in `undo-boundaries.ts`; the callback keeps its counter, cache and render work); after `preserveCaretAndScroll` returns, call `vditor.clearStack()` so one base is taken with the restored caret. No Vditor source patch. The checkbox path, the no-op update, the streaming guard and init are unchanged. Interactions: Task 602's `history-base` must still be posted once for the new base and before `editSync.reseed` (`recordBase` is idempotent, `src/writeback/history-coupling.ts:69`) — Part 2 verifies the order; an edit made before the record fires re-arms a fresh record, so it keeps its checkpoint; Vditor's `recordFirstPosition` still moves the base caret on the first keydown; Task 597's restore covers a base with no caret marker. Residual: a caret retry that resolves late leaves the base at the earlier caret but adds no step.

**Steps.**

- **S1** Items 1 and 2, units and fix. Units: Ctrl+Shift+E (`key` `'E'`) on Linux and Cmd+Shift+E on macOS give no `addToUndoStack` and no `input` (pass on HEAD); router with a Find, Replace or link-popover input focused: Undo/Redo calls `execCommand`, not `inner.undo`; an empty input history does not fall through to the document; with the editor focused the engine still runs. RED on HEAD: the focused-input router test calls `inner.undo.undo`. First probes P1 (Ctrl+Z in the Find input reaches `trigger-toolbar-hotkey` on VS Code 1.129.0 and changes the document) and P2 (`execCommand('undo'/'redo')` in the real webview's Find input after typing).
- **S2** Item 3. First probes P3 (the depth-2 stack after an external update on HEAD) and P3b (turning off `enableAddUndoStack` on the armed record in the built bundle stops the delayed entry). Router units: `setValue(..., false)`, then the caret restore, then `clearStack` (update `message-router.test.ts:781`); the record's flag is off; the owned path unchanged (`:816`). Browser or real-VS-Code check in IR, WYSIWYG and SV: depth 1 one second after the update, base caret equals the restored caret, and a genuine edit inside 800 ms still gets its step. RED on HEAD: depth 2 with a caret-only second entry.
- **S3** New `test/vscode-e2e/undo-routing-hygiene.spec.ts` (XTEST) and closure. Leg 1: an authored step, then Ctrl+Shift+E; host text, version and Undo depth unchanged; refocus the editor before Ctrl+Z (Explorer focus would send Ctrl+Z to Explorer's file-operation undo); one Ctrl+Z undoes the authored step. Leg 2, large fixture: type in Find, then Replace; Undo, then Redo through both keys; assert the input value, focus, match count, host bytes and version. Leg 3, small round-tripping document: external `WorkspaceEdit`, type Y, Undo twice; the second Undo changes neither text, caret, host version nor focus, in all three modes.

**Orchestrator rulings (2026-10-07, under the Owner rule).**

- D1: the input route also covers the link-popover input, through `focusedTextInput`, as Task 580's ruling requires.
- D2: item 3's history starts at the external change.
- S2 runs at Sonnet 5.5 `xhigh` rather than the queue's `high`: it changes undo base state shared with Task 602's history-base and Task 601's drain.

Owner decisions: none open. Blockers: none. Confidence: high for items 1 and 2; medium-high for item 3 until probe P3b.

## Acceptance

- [ ] Each item has its real-VS-Code leg passing with exact host text and version checks.
