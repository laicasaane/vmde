# Task 596 — Toolbar hotkeys act on the live selection, not stale toolbar classes

**Status:** in progress (2026-10-07). Part 1 handoff ready (below); Part 2 S1 next.
**Origin:** Task 579 real-VS-Code acceptance, 2026-09-28. The defect predates Task 579.
**Recommended implementer effort:** high.
**Tech stack:** TypeScript webview (`media-src/src`), Vditor 3.11.3 source predicates, Vitest, Chromium Playwright, real VS Code with OS-level XTEST input.
**Dependencies:**

- Run after **Task 579**. Coordinate with **Task 580**: the gate is keyed by toolbar name, so it must not depend on a default key or command id. Keep the gate as one call immediately before dispatch, so Task 580's selection-capture move does not touch it.
- **Task 597** makes Undo/Redo place the caret inside the editor, so Vditor's own highlight runs again after them. This task must still be correct without Task 597.
- **Task 506** (indent/outdent/list-family class strip) is replaced by this task.

**Evidence:** `tmp/task596-603-evidence/t596/` (`results-matrix1..4.json`, `probe.spec.ts`) and `tmp/task596-603-evidence/pre579-probe/` in the main checkout. The run was real VS Code 1.129.0 with `VMDE_XTEST=1`, on the Task 579 build (`dev` `f7d37efd` plus the uncommitted Task 579 diff).

## Problem

`handleTriggerToolbarHotkey` (`media-src/src/bridge/message-router.ts:815-848`) runs 12 names by dispatching a click on the Vditor toolbar button:

- bold, italic, strike, headings, list, ordered-list, check, outdent, indent, quote, code, inline-code (source: `FORMAT_HOTKEYS` in `src/shared/format-hotkeys.ts`)
- undo/redo take a shortcut path and are not affected.

The click acts on the button's classes:

- `vditor-menu--disabled`: the click does nothing (`toolbar/MenuItem.ts:40`, `Headings.ts:38`, `Indent.ts`, `Outdent.ts`).
- `vditor-menu--current`: the click means "remove this format" (IR `ir/process.ts:132-163`, WYSIWYG `wysiwyg/toolbarEvent.ts:93-141`, `Headings.ts:42-49`).

Vditor sets these classes only in `highlightToolbarIR` / `highlightToolbarWYSIWYG`:

- debounced by 200 ms;
- run on an editor click, on keyup (IR keyup is skipped while Ctrl is held), and on Undo/Redo;
- never run for SV.

A selection that changes by program, or less than 200 ms before the hotkey, therefore acts on the previous context. This happens in both directions.

Measured results. Each case settles context A first, then moves to B with no click or keyup and presses the key immediately.

| Case (IR unless noted) | Stale class at dispatch | Result |
| --- | --- | --- |
| In inline code → select plain "bravo" → Ctrl+B | disabled | no-op |
| In inline code → plain word → Ctrl+G | current | no-op |
| Plain → select "foxtrot" inside inline code → Ctrl+B | enabled | ``Echo `**foxtrot**` `` — **code span corrupted** |
| Plain → "foxtrot" in code → Ctrl+G | not current | ` ``foxtrot`` ` — **nested code** |
| Plain → "India" in `**India**` → Ctrl+B | not current | `****India****` — **corrupted** |
| Plain → text in `> oscar papa` → quote | not current | `>> oscar papa` plus a stray `>>` line — **corrupted** |
| Heading → caret in paragraph → headings | current | no-op; the picker panel stays hidden |
| Plain → caret in list item → list | not current | no-op |
| WYSIWYG: heading → plain word → Ctrl+B | disabled | no-op |
| WYSIWYG: inline code → paragraph contents selected (`P`@0, first child STRONG) → Ctrl+G | current | **removes the bold from `**India**`** |
| WYSIWYG: quote → same range → quote | current | **removes the bold from India** |
| Keyboard only: caret in "go\|lf", Ctrl+Left twice, Ctrl+B about 50 ms later | enabled | ``Echo `****foxtrot` `` — **corrupted** |
| Double-click a plain word 134 ms after leaving inline code, then Ctrl+B | disabled | no-op |
| `End`, `Shift+Home` 94 ms after leaving inline code, then Ctrl+B | disabled | no-op |

In each case, a "fresh" control (real keyup plus 450 ms before the key) gave Vditor's correct result.

## Design

Rejected options:

- **A synchronous Vditor highlight.** Both highlight bodies are anonymous `setTimeout` closures. The WYSIWYG pass also rebuilds popovers. Both return early when the selection is outside the editor.
- **A detached button**, as `selection-format-actions.ts` uses. It bypasses the Task 506 word-expansion capture listener (`selection-scope.ts:274-299`).

Chosen design:

1. Add a new module, `media-src/src/editing/format-hotkey-context.ts`. It holds three pure functions and imports Vditor's own predicates (`vditor/src/ts/util/hasClosest`, `hasClosestByHeadings`):
   - `resolveVditorEditorRange(inner, mode)` mirrors `util/selection.ts` `getEditorRange`. It returns, in order: the live range if it starts inside the editor, else the stored `inner[mode].range`, else the start of the editor.
   - `toolbarHotkeyGate(mode, range, editor, name)` returns `{disabled, current}`, or `'blocked'` when the editor is read-only (`contenteditable=false`) or Preview is active. The rules mirror `highlightToolbarIR.ts:21-94` and `highlightToolbarWYSIWYG.ts:53-194` exactly, including each mode's own way of deriving the element from the range start:
     - IR: a `.vditor-reset` container resolves to `childNodes[startOffset]`.
     - WYSIWYG: `childNodes[min(offset, len-1)]`.
     - SV: every name enabled and not current, except indent/outdent, which are disabled.
   - `syncToolbarButtonGate(button, gate)` sets or clears only the two classes on that one button.
2. Change `message-router.ts` `handleTriggerToolbarHotkey` to run in this order:
   1. the undo/redo shortcut path;
   2. `restoreFormatHotkeySelection`;
   3. resolve the range, compute the gate and sync the button;
   4. dispatch.

   Delete the Task 506 branch and its helpers: `LIST_FAMILY_TOOLBARS`, `LIST_BLOCKED_CONTEXT` and `listFamilyHotkeyHasEditableContext`. Keep the measured rationale in the comment. Note that Task 506's `LIST_BLOCKED_CONTEXT` misses WYSIWYG inline code, which is a bare `<code>` with no `data-type`. That gap is inferred, not measured.
3. Follow-up, in scope unless the owner cuts it: make `formatIsActive` (`selection-format-actions.ts:22-32`) and `isInsideInlineFormat` (`selection-scope.ts`, near lines 148-154) call the helper. That way the caret-restore "removing" decision cannot disagree with the class Vditor acts on.

Edge cases:

- A backward range: use `startContainer`, as Vditor does.
- A selection that spans code and plain text is gated on its start (parity with Vditor).
- Table cells: IR disables headings, the list family, quote and code. WYSIWYG disables none of the hotkey names.
- A WYSIWYG heading disables bold and makes headings current only outside CODE.

## Owner decisions needed

1. Confirm that the scope covers all 10 affected names and replaces the Task 506 branch. The earlier draft covered 4 names.
2. Match Vditor's rules exactly (recommended), or be stricter? For example, WYSIWYG allows list, quote and code-block in table cells. A stricter policy would also have to apply to toolbar mouse clicks.
3. When the selection is outside the editor, gate on the fallback range Vditor will use (recommended), or leave the classes unchanged?
4. Clear stale classes in SV as well? This is cheap. The stray-timer case after a mode switch is inferred, not measured.

These were settled under the Owner rule of 2026-09-28 (take every recommended option; `tmp/queue-part1/596-603-rulings.md`): all 12 toolbar names, exact Vditor parity, gate on Vditor's fallback range, and clear SV classes too.

## Part 1 handoff (2026-10-07, reconciled with `732654ca`)

Reasoning: Claude Opus 5.5 `medium` (`opus-medium`), read-only, no runs. Supersedes the source references of `tmp/queue-part1/596-native-handoff.md` (written against pre-580 `8c2ec1f0`).

**Source facts at `732654ca`.**

- `handleTriggerToolbarHotkey` (`media-src/src/bridge/message-router.ts:838-889`) runs: name whitelist (`:843`), the Undo/Redo engine path with an early return (`:848-858`), `restoreCommandSelection()` (`:862`), the Task 600 refusal (`:864`), the Task 506 class strip (`:866-885`), then the click (`:886`). The Task 506 helpers `LIST_FAMILY_TOOLBARS`, `LIST_BLOCKED_CONTEXT` and `listFamilyHotkeyHasEditableContext` are at `:800-818`.
- `src/shared/format-hotkeys.ts` no longer exists. Names come from `TOOLBAR_COMMAND_NAMES` (`src/shared/editor-shortcuts.ts:469`). Ctrl+B, Ctrl+I, Ctrl+] and Ctrl+[ are bound (`:140-167`); the other 8 names are unbound (`:319-333`).
- Vditor's clicks act on `getEditorRange` (`util/selection.ts:5-22`; `ir/process.ts:124`; `wysiwyg/toolbarEvent.ts:87`). A disabled button is a no-op (`MenuItem.ts:40`, `Headings.ts:38`, `Indent.ts`/`Outdent.ts:13-14`); a current button means "remove" (`ir/process.ts:132-163`, `toolbarEvent.ts:93`, `Headings.ts:42-49`). SV reads only the disabled class, except that a current headings button makes the SV click a no-op.
- Highlight rules: IR `highlightToolbarIR.ts:20-94`; WYSIWYG `highlightToolbarWYSIWYG.ts:47-192`, which gives up when the selection is outside the editor (`:47-63`). A WYSIWYG `footnotes-block` start enables every button and returns (`:65-72`); both earlier drafts missed this. IR inline code disables bold but not inline-code (`highlightToolbarIR.ts:83-87`). The predicates return `false` for `undefined`, so an IR root offset past the end needs no special case.
- The IR highlight timer reads `vditor[currentMode]` when it fires (`:8-13`), so a pending timer can run after a switch to SV (`EditMode.ts:44-46`); this supports clearing SV classes.
- Reusable Preview test: the preview button's `vditor-menu--current` class plus `contenteditable="false"` (`bridge/editor-actions.ts:172-183`, not exported). `inner-vditor.ts:10-33` has no `range` field yet.
- Other "current" deciders: `formatIsActive` (`editing/selection-format-actions.ts:22-32`, used at `:59` and `selection-bubble.ts:343`) and `isInsideInlineFormat` (`selection-scope.ts:150-155`, used by the capture-phase word-expand listener at `:293`).

**Design.** One gate for all 12 names, keyed by toolbar name only (no key or command id); Undo/Redo unchanged. Exact Vditor parity. Outside the editor, gate on the `getEditorRange` fallback (live range, then the stored `inner[mode].range`, then the editor start); the helper never focuses anything. SV: all names enabled and not current, indent and outdent disabled. New order: whitelist, Undo/Redo, restore the command selection, Task 600 refusal, gate and sync this one button's classes, click. The gate changes only toolbar classes outside the editor (no DOM edit, input event or engine call), so Task 580's one-engine-call rule and Task 602's checkpoint flush and undo-keybind wrapper are unaffected.

**Steps.**

- **S1** `media-src/src/editing/format-hotkey-context.ts` (`resolveVditorEditorRange`, `toolbarHotkeyGate(mode, range, editor, name, { fullPreview })`, `syncToolbarButtonGate`, the footnotes rule) plus jsdom Vitest, and a typed `range?: Range` on `inner-vditor.ts` for `ir`, `wysiwyg` and `sv`. `'blocked'` for full Preview, read-only, no editor, or a disconnected stored range start. RED: the test file fails to import. Cover IR/WYSIWYG probe shapes, simultaneous disabled and current (IR code block: `code`), footnotes, root offset past the end, `P`@0 with STRONG first, a backward range, the three fallback steps, the blocked cases, SV and the SV both-pane layout.
- **S2** Router integration after the Task 600 refusal; delete the Task 506 helpers and branch (keep a short comment on the measured stale window). RED on HEAD in `message-router.test.ts`: a stale disabled Bold in plain text never runs its click handler; a stale enabled Bold inside `data-type="code"` reaches the click without the class (assert from inside the click listener). Update `mockToolbarButton` (`:1428-1452`) and the `it.each` name tests (`:1484+`) with a mode, editor and selection; rewrite the Task 506 tests (`:1561-1660`); keep the Task 600 tests (`:1296+`). Point `formatIsActive` at the shared rule; update `selection-format-actions.test.ts:41` and `selection-scope.test.ts:684-698`.
- **S3** Chromium: new `media-src/e2e/format-hotkey-gate-harness.ts` registered in `harness-entries.mjs`, importing Vditor from source (the `vditor-chords-harness` pattern) so the Task 600 patch applies. Parity spec: after Vditor's highlight settles, every IR/WYSIWYG fixture caret's 12 classes equal the helper's. Behaviour spec: reselect by program, gate and click immediately, assert exact `getValue()` for the record's corruption rows. RED: the behaviour rows without the gate.
- **S4** Real VS Code XTEST `test/vscode-e2e/format-hotkey-live-gate.spec.ts` on the probe fixture: Ctrl+B, Ctrl+I, Ctrl+] and Ctrl+[ through XTEST; the other 8 names through `executeCommand` (Linux Ctrl+G is Go to Line). RED on HEAD: the code-span, `****India****`, quote and WYSIWYG remove-bold rows. Remove Task 579's workaround at `find-replace.spec.ts:601-607` (the `Shift_L` key and its `not.toHaveClass` check), keeping the focus and selection asserts; probe first whether `selectFixtureWord`'s caret arming holds without `Shift_L`.
- **S5** Closure: focused gates, coverage ratchet, task record.

**Orchestrator rulings (2026-10-07, under the Owner rule).**

1. `'blocked'` means no click at all (Preview, read-only, no editor, disconnected stored range), consistent with `editableSurfaceAvailable`.
2. The word-expand `removing` decision (`selection-scope.ts:293`) reads the clicked button's `vditor-menu--current` class, which is what Vditor's click reads for mouse clicks too. If `isInsideInlineFormat` becomes unused, delete it.
3. A word-expand on a disabled button still moves the caret. This looks pre-existing; record it as a follow-up at closure and do not fix it here.
4. The other Task 596 test workarounds stay (`shortcut-identity.spec.ts:87-133`, `shortcut-remap.spec.ts:87-97`, `undo-first-edit.spec.ts:806-814`).
5. Export a gate-and-click function so the Chromium harness runs product code rather than a stand-in.

Owner decisions: none open. Blockers: none. Confidence: high on the source mapping; medium on the S4 `Shift_L` removal until probed.

## Tests

- **Vitest**
  - `media-src/src/editing/format-hotkey-context.test.ts` (jsdom), with IR and WYSIWYG DOM that matches the probed structures. Cover:
    - plain text, inline code and code-block;
    - strong, em and s;
    - a heading in both modes;
    - an LI in UL, OL and a task list;
    - a blockquote and a table cell;
    - the element container `P`@0 whose first child is STRONG;
    - a `.vditor-reset` container and a backward range;
    - the three steps of the outside-editor fallback;
    - the `'blocked'` cases and the SV constants.
  - `message-router.test.ts`: a stale disabled or current class is corrected before dispatch, in both directions. Rewrite the Task 506 tests.
- **Chromium** (`media-src/e2e`)
  - A parity spec, which guards against Vditor drift: for each mode and fixture caret, let Vditor's own highlight settle, then assert all 10 buttons' classes equal the helper's output.
  - A behaviour spec: reselect by program and dispatch immediately. Assert exact `getValue()` for the corruption cases in the table.
- **Real VS Code**
  - New spec `test/vscode-e2e/format-hotkey-live-gate.spec.ts`, run with `VMDE_XTEST=1` after `node build.mjs`, on the probe's fixture.
  - Settle each context with an XTEST `Shift_L` and 450 ms. Before each programmatic reselection, send a synthetic `keydown` so the ADR-0007 caret intent does not re-assert the old caret.
  - Assert exact `docText` for every row in the table, including the keyboard-only Ctrl+Left case. Drive italic, strike, inline-code and headings through `executeCommand`, because Task 580 may unbind their keys.
  - Remove the Task 579 spec's `Shift_L` refresh workaround once this task covers it.
- **Gates:** typecheck (all three), `lint:ci`, bundle/startup checks, and `npm run quality`.

## Acceptance

- [ ] Every table row gives the "fresh" result in real VS Code, in IR and WYSIWYG.
- [ ] The Chromium parity spec passes for every mode and fixture caret.
- [ ] The Task 506 behaviour is preserved, and its branch is removed.
- [ ] Coverage includes the new module's lines. The zero-coverage ratchet passes.
