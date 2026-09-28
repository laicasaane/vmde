# Task 596 — Toolbar hotkeys act on the live selection, not stale toolbar classes

**Status:** planned (2026-09-28). The Project Owner approved the finding. Implementation has not started; the decisions below are still open.
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
