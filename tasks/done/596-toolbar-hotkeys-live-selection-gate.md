# Task 596 — Toolbar hotkeys act on the live selection, not stale toolbar classes

**Status:** ✅ DONE (2026-10-07) on `dev`. Commits: `df5f49a5` (Part 1 handoff record), `5ce15571` (gate helper and its Vitest), `d06cd46b` (router integration), `fb799628` (Chromium parity and behaviour specs), `57f5c4ae` (real-VS-Code XTEST acceptance spec and removal of the Task 579 workaround). Follow-up: [Task 626](../626-word-expand-on-disabled-format-button.md).
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

## Owner decisions (answered)

The four questions of the first draft were settled under the Owner rule of 2026-09-28 (take every recommended option; `tmp/queue-part1/596-603-rulings.md`):

1. Scope: all 12 toolbar names (the earlier drafts said 10 and 4), and the Task 506 branch is replaced.
2. Match Vditor's rules exactly. Stricter rules would also have to apply to toolbar mouse clicks.
3. Outside the editor, gate on the fallback range Vditor uses.
4. Clear stale classes in SV as well.

The orchestrator's rulings of 2026-10-07 are in the Part 1 handoff below.

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


## Execution progress

All steps ran on `dev` on 2026-10-07 under Project Owner authority (§2a). Reasoning for the plan and the reviews: Claude Opus 5.5 `medium`; implementation steps: Claude Sonnet 5.5 (efforts set by the agent definitions).

- **S1, `5ce15571`.** New `media-src/src/editing/format-hotkey-context.ts` (`resolveVditorEditorRange`, `toolbarHotkeyGate`, `syncToolbarButtonGate`, the footnotes rule) plus a typed `range` on the inner-Vditor type. RED: the test file failed to import. 76 jsdom unit tests; 100 % line and 95 % branch coverage of the module; mutation checks made the tests fail. An independent Opus 5.5 `medium` review compared the helper with Vditor's highlight code (IR `highlightToolbarIR` 20–94, WYSIWYG 47–192, SV, `getEditorRange`, the blocked cases): accepted, 0 mismatches. Two Low findings were fixed.
- **S2, `d06cd46b`.** `handleTriggerToolbarHotkey` now runs: name whitelist, Undo/Redo, `restoreCommandSelection`, Task 600 refusal, gate and sync of that one button, click. The Task 506 helpers are deleted. `formatIsActive` and the word-expand `removing` decision use the shared rule; `isInsideInlineFormat` is deleted. RED on the previous HEAD: a stale disabled Bold was clicked (the class was still disabled inside the click listener), and Bold inside inline code reached the click without the disabled class. Vitest: 342 passed in the touched suites.
- **S3, `fb799628`.** A source-patched Chromium harness runs the product gate. Parity spec: 72 IR and WYSIWYG caret cells, 0 mismatches against Vditor's own highlight. Behaviour spec: 21 stale-class rows; a plain click fails all 21, and the gated click equals Vditor's fresh result. 7 tests passed in about 51 s.
- **S4, `57f5c4ae`.** Real VS Code 1.129.0 XTEST spec `test/vscode-e2e/format-hotkey-live-gate.spec.ts`: 2 tests, 35 rows (23 IR, 12 WYSIWYG). Ctrl+B, Ctrl+I, Ctrl+] and Ctrl+[ go through XTEST; the other 8 names go through `vmde.format.*` commands. RED on the pre-596 product: 29 of 35 rows failed (for example `****India****`, `` `**foxtrot**` ``, ` ``foxtrot`` `, `>> oscar papa` with a stray `>>`, WYSIWYG bold removal from the first child, and stale no-ops including double-click and End/Shift+Home). Indent, outdent, ordered-list and check already passed before 596 through Task 506. The control mode (settled context) passed 2/2 on the pre-596 product. GREEN 2/2 in three runs (about 2.5–3 min each). The Task 579 `Shift_L` workaround was removed from `find-replace.spec.ts` (find-replace 3/3). Regression specs passed: shortcut-identity 7, shortcut-remap 3, selection-bubble 4, format-hotkeys 8, blockless-caret 2, vditor-chords 5, block-transform 9. `structural-selection` :449 failed as already known.
- **S4b, undo-first-edit.** One S4 run showed a failure of "keyboard Undo leaves the host clean". Four reruns on HEAD and four on the pre-596 product: HEAD 4 failed tests, pre-596 3, all of them the known leg-level "race window missed" precondition at the same rates, so those are pre-existing. The Undo assertion did not reproduce (0 of 4 on both); 596 does not change the Undo route. It stays unreproduced. A cold Mermaid re-render after Undo is the known Task 623.
- **S5a, gates at `57f5c4ae`.** `lint:ci` 0; `typecheck` 0; host `tsc` 0; `typecheck:strict` 15 (baseline); `typecheck:vscode-e2e` 1 (baseline, `preview-task-checkbox:122`); knip 10 (baseline); jscpd 0; dependency-cruiser 0; module manifest OK; `test:coverage`: 331 files, 6,097 passed, 1 expected failure and the known block-transform P0 5 s timeout; `check:coverage-modules` OK (9 modules at 0 %, baseline 11). Changed-line coverage 102 of 102. Bundle `main.js` 941,638 B (+2,113 B against the Task 602 close at 939,525 B); 351 eager modules (+1, the new module). The legacy budgets are exceeded as before (reporting only). Dependency audits were omitted by Project Owner instruction, and the aggregate `npm run quality` was not run; its network-free stages were run individually.
- **S5b.** This record, the README entry and Task 626.

## Tests

- **Vitest**
  - `media-src/src/editing/format-hotkey-context.test.ts` (jsdom): IR and WYSIWYG DOM shaped like the probed structures; plain text, inline code, code block, strong/em/s, headings, lists, task list, quote, table cell, the `P`@0 container with a STRONG first child, a root container with an offset, a backward range, the outside-editor fallback steps, the blocked cases, the footnotes rule, and SV.
  - `message-router.test.ts`: a stale disabled or current class is corrected before dispatch, in both directions; the Task 506 tests were rewritten; the Task 600 tests are kept. `selection-format-actions.test.ts` and `selection-scope.test.ts` follow the shared rule.
- **Chromium** (`media-src/e2e`): a source-patched harness (`format-hotkey-gate-harness.ts`, registered in `harness-entries.mjs`) with a parity spec (72 caret cells) and a behaviour spec (21 stale rows).
- **Real VS Code:** `test/vscode-e2e/format-hotkey-live-gate.spec.ts` with `VMDE_XTEST=1` after `node build.mjs`: 2 tests, 35 rows, covering the 12 toolbar names (4 by real key chord, 8 by command). The Task 579 `Shift_L` workaround in `find-replace.spec.ts` is removed.
- **Gates:** see S5a above.

## Residual risks and follow-ups

- **Word-expand on a disabled button** ([Task 626](../626-word-expand-on-disabled-format-button.md)). The capture-phase word-expand listener still expands a collapsed caret to the word when the clicked button is disabled, so a click that Vditor ignores still changes the selection. This predates 596 and is not fixed here (ruling 3).
- **Unreproduced Undo assertion.** The one "keyboard Undo leaves the host clean" failure seen in an S4 run did not recur in 8 reruns. It is not explained, only not reproduced.
- **Contracts kept by design.** The gate changes only toolbar classes; Task 580's one-engine-call rule and Task 602's checkpoint flush and undo-keybind wrapper are unchanged.
- **Linux-only real-VS-Code evidence.** The XTEST runs are on Linux (Xvfb and Openbox). Ctrl+G is Go to Line on Linux, which is why 8 names use commands. Other platforms are unverified.
- **Other Task 596 workarounds stay** (`shortcut-identity.spec.ts`, `shortcut-remap.spec.ts`, `undo-first-edit.spec.ts`, ruling 4).

## Acceptance

- [x] Every probe-table row gives the "fresh" result in real VS Code, in IR and WYSIWYG: the XTEST spec has 35 rows (23 IR, 12 WYSIWYG), RED 29 of 35 on the pre-596 product, GREEN 2/2 in three runs. All 14 Problem-table rows map to spec rows (checked by the orchestrator); evidence is Linux XTEST only.
- [x] The Chromium parity spec passes for every mode and fixture caret (72 cells, 0 mismatches).
- [x] The Task 506 behaviour is preserved, and its branch is removed (indent, outdent, ordered-list and check pass in the XTEST spec; the Task 506 helpers are deleted).
- [x] Coverage includes the new module's lines (100 % lines, 95 % branches; changed lines 102 of 102). The zero-coverage ratchet passes.
- [x] The quality gate was run as its network-free stages individually (lint, typecheck ×3, knip, jscpd, dependency-cruiser, unit coverage, zero-coverage ratchet); all at baseline. The aggregate `npm run quality` and the dependency audits were intentionally not run, under the Project Owner's 2026-10-04 instruction for this queue.
