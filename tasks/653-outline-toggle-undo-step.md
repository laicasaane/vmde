# Task 653 — Outline toggle adds an Undo step with no Markdown change

**Status:** open.
**Origin:** Project Owner request (follow-up of Task 650).
**Severity:** low.
**Tech stack:** webview (toolbar Outline button, Vditor undo history, outline decorations).
**Related:** [Task 650](done/650-remember-outline-open-state-and-width.md) (remember Outline open state and width).

## Problem

A click on the toolbar Outline button with the caret in the editor adds one Undo snapshot. The snapshot holds only DOM decoration (`data-vmde-foldable` attributes and a caret marker) and no Markdown change. As a result, the next Ctrl+Z does nothing visible.

The likely cause is Vditor's `Outline.toggle` calling `setSelectionFocus` on the click path.

## Requirements

1. A toolbar Outline click with the caret in the editor adds no Undo step that holds only decoration.
2. Ctrl+Z after such a click undoes the previous real edit, as it did before the click.
3. The Markdown and the Outline open state behave as before.

## Open design points

- Confirm the cause on the click path before changing it.
- Whether the fix belongs in the toggle path or in the undo recording.

## Scope

- In: the extra Undo step created by the toolbar Outline click.
- Out: Outline open state and width memory (Task 650) and other toolbar actions.

## Acceptance

- [ ] After an edit, a toolbar Outline click followed by Ctrl+Z undoes that edit, not nothing.
- [ ] The Outline opens and closes as before.
- [ ] Saved Markdown is unchanged by the click.

## Tests

- To be specified in Part 1 (webview behaviour; real-VS-Code verification is required for behaviour that depends on the VS Code integration).

## Part 1 handoff (2026-10-18)

### Verified facts

1. **The cause is VMDE's toolbar-click undo boundary, not Vditor's `setSelectionFocus`.**
   - `media-src/src/editing/undo-boundaries.ts:561-563`: `onClick` calls `boundary()` whenever `isToolbarAction(event.target)` is true.
   - `undo-boundaries.ts:380-397`: `isToolbarAction` matches any `.vditor-toolbar button, .vditor-panel button`. It excludes only the collapse toggle, `undo`, `redo`, `preview`, `edit-mode` and `[data-mode]`. It does not exclude `outline`.
   - The Outline button is a `<button data-type="outline">` inside `.vditor-toolbar` (`node_modules/vditor/src/ts/toolbar/MenuItem.ts:22-32`). VMDE adds the item at `media-src/src/chrome/toolbar.ts:291`.
2. **What `boundary()` does** (`undo-boundaries.ts:486-522`):
   - It seeds an empty history (`seedUndoBaseline`).
   - If an edit is still pending (`dirty`), it records a checkpoint right away.
   - On `setTimeout(0)` it calls `cancelPendingAfterRender`, posts `options.input(getValue())` unless `equivalentToHost`, then records `checkpointUndoBoundary(settled, false)`, which calls `addToUndoStack`.
   - `addToUndoStack` (`vditor/src/ts/undo/index.ts:111-133`) adds an entry for any difference between `addCaret()`'s snapshot and `lastText`. That includes attribute-only differences such as `data-vmde-foldable` (`media-src/src/nav/section-fold.ts:20`) and a moved caret.
   - `addCaret` (`undo/index.ts:227-267`) inserts a `span.vditor-wbr` at the live caret, which splits the caret's text node. This explains every symptom in the Task 650 S4 evidence: one extra entry, the decoration-only snapshot, the `<wbr>` caret marker and the split text node.
3. **Vditor's own Outline toggle records no undo entry.**
   - The click handler (`vditor/src/ts/toolbar/Outline.ts:11-19`) calls `vditor.outline.toggle(vditor, enable)`.
   - `outline/index.ts:27-44` shows or hides the panel, re-renders it, re-adds the same selection range through `setSelectionFocus` (`util/selection.ts:95-99`, only `removeAllRanges` and `addRange`) and calls `setPadding`.
   - None of these touches `vditor.undo`. This matches the Task 650 probe, where a programmatic `outline.toggle` added no entry: there was no DOM click, so `onClick` never ran.
4. **Keyboard activation also takes a boundary.**
   - In `onKeydown` (`undo-boundaries.ts:529-537`), Enter on the focused Outline button meets `isEditingEnter` (`:358-364`) and calls `boundary()`.
   - The click the browser then fires also reaches `onClick`.
   - Only the collapse toggle is exempt (`:532`, Task 631).
   - `media-src/src/nav/outline-state.ts:2` confirms that Enter or Space on the button fires the same click.
5. **Mode coverage.** Vditor hides the Outline button in SV (`vditor/src/ts/toolbar/EditMode.ts:106`) and shows it in IR and WYSIWYG (`:50`, `:80`). Only IR and WYSIWYG are affected.
6. **The Task 650 hook is unrelated.** `outline-state.ts:32` adds a bubble `click` listener on the wrapper that stores the open state and never touches undo.
7. **Where the boundaries are installed.**
   - Production: `boot/finish-init.ts:577-584` installs them with `equivalentToHost`. That is why host bytes stayed unchanged in Task 650: the posted `getValue()` was equivalent.
   - Chromium harnesses: `media-src/e2e/undo-boundaries-harness.ts:117-124` builds its toolbar from `['bold','undo','redo']` only, with no Outline. `media-src/e2e/outline-harness.ts` installs no undo boundaries and no section fold. Neither harness can reproduce the failure as it stands.
8. **The current real-VS-Code spec has to change after the fix.**
   - `test/vscode-e2e/outline-state.spec.ts:429-445` allows one extra entry (`undoAllowance = 1`).
   - `:456-460` expects Ctrl+Z after the toggles to leave the value unchanged. Once the fix lands, that Ctrl+Z undoes the real edit, so this assertion would fail.
9. **Existing test patterns to extend.**
   - `undo-boundaries.test.ts:307` ("Enter on the collapse toggle takes no undo boundary").
   - `:337-381` (the `it.each` of view-only controls).
   - `:383` (Preview toggle).
   - `:412` (formatting actions keep their boundary).

### Decisions

- **Fix layer: the VMDE undo boundary, in `media-src/src/editing/undo-boundaries.ts` only.** No build-time Vditor patch and no change to `Outline.toggle`. Filtering decoration at snapshot time is also rejected: it would change every history entry and the Task 611/601 comparisons, which is a much wider surface.
- **New contract.** Add `function isViewToggle(target: EventTarget | null): boolean`. It is true when `target.closest('.vditor-toolbar [data-type="collapse-toolbar"], .vditor-toolbar [data-type="outline"], .vditor-panel [data-type="outline"]')` matches; the panel case covers Outline moved into More by `chrome/toolbar-overflow.ts`. Then:
  - `onKeydown` returns early when `isViewToggle(event.target)`. This replaces the `isCollapseToggle` early return and keeps its behaviour, seed skipped included.
  - `isToolbarAction` excludes `isViewToggle(action)` in place of `!isCollapseToggle(action)`.
  - `isCollapseToggle` is removed only if nothing else uses it. In the file it is used only at `:376`, `:390` and `:532`.
- **Result.** An Outline click or keypress takes no seed, records no checkpoint, posts no `input` and does not cancel a pending after-render callback. A real edit that is still pending is recorded by its own after-render timer as before. A Ctrl+Z inside that window is still drained by Task 601's `prepareHistory`.
- **Nothing changes in** Markdown, the host, the Outline open state or width, or Task 650's storage. SV is not applicable.

### State, DOM and messages

No new state, DOM or protocol messages. Removed side effects of an Outline toggle: one `input(getValue())` post (it was already suppressed when equivalent to the host), one seed and one `addToUndoStack` call.

### Part 2 steps

**S1: real-VS-Code reproduction, RED first.** Owned file: new `test/vscode-e2e/outline-toggle-undo.spec.ts`, with one `test()` block.
- Open a fixture with headings, so the section-fold markers exist.
- IR case:
  1. Click a paragraph and type a word.
  2. Wait past `undoDelay`.
  3. Record the Undo depth, the value and the host text.
  4. Click the toolbar Outline button for real (open), then press Ctrl+Z.
  5. Expect: depth unchanged after the click; after Ctrl+Z, the value and host text no longer contain the typed word; Outline is open.
  6. Click Outline again (closed); expect closed and host bytes unchanged by the clicks.
- Same `test()`, keyboard case: focus the Outline button and press Enter. Expect the depth unchanged.
- WYSIWYG case:
  1. Switch through the edit-mode control and type a word.
  2. Wait past `undoDelay`.
  3. Press ArrowLeft twice so the caret differs from the last entry.
  4. Click Outline, then press Ctrl+Z.
  5. Expect the depth unchanged and the word undone.
- Restore at the end: Outline closed, IR, stored width 200 (as `outline-state.spec.ts` does).
- Run `node build.mjs`, then `env -u ELECTRON_RUN_AS_NODE xvfb-run -a npm --prefix test/vscode-e2e test -- outline-toggle-undo.spec.ts --workers=1 --retries=0`. Record the actual RED result.
- Expected but unverified: the IR click and keyboard checks fail before the fix. Whether the WYSIWYG caret-only case fails is unverified; record what happens.

**S2: Vitest RED, then the fix.** Owned files: `media-src/src/editing/undo-boundaries.test.ts`, `media-src/src/editing/undo-boundaries.ts`.
- RED tests (write them first and show them failing):
  - (a) A click on a `.vditor-toolbar button[data-type="outline"]`, with history `['earlier']`, calls no `addToUndoStack`, no `options.input` and no `vmdeSeedBaseline`. Use the Preview-test shape.
  - (b) The same button inside `.vditor-panel` (moved into More) behaves the same.
  - (c) Enter keydown on the Outline button: no `addToUndoStack`, no `input`, no seed.
  - (d) With a pending after-render record (`ir.vmdeAfterRender` and `processTimeoutId` set), an Outline click leaves both in place, so it cancels nothing.
  - (e) Control: a `bold` click still records its boundary (the existing `:412` test stays green).
- Then implement the Decisions.
- Checks:
  - `npx vitest run --config test/vitest.config.mts media-src/src/editing/undo-boundaries.test.ts`
  - Coverage of the changed lines with the skill's coverage command using `--config test/vitest.config.mts --coverage --coverage.include='media-src/src/editing/undo-boundaries.ts'`.

**S3: update the existing real-VS-Code spec, then run GREEN.** Owned file: `test/vscode-e2e/outline-state.spec.ts`.
- Set `undoAllowance` to 0, replace the at-most-one comment (`:429-432`), and assert exact depth equality.
- Remove the Ctrl+Z block at `:455-460`; the new spec owns Ctrl+Z.
- Run `node build.mjs`, then both specs under `xvfb-run -a` with `--workers=1 --retries=0`. The S1 spec must now pass.

**S4: closure checks.** `npm run typecheck:vscode-e2e`, `biome check` on the changed files, then `npm run quality` once for the closure batch.

### Tests mapped to Acceptance

| Acceptance item or edge case | Layer | Test |
|---|---|---|
| After an edit, Outline click then Ctrl+Z undoes that edit | Real VS Code (required: real click with VS Code focus) | S1 IR and WYSIWYG cases |
| | Vitest | S2 (a) and (d) for the predicate and the pending edit |
| Outline opens and closes as before | Real VS Code | S1 open and closed checks |
| | Regression | `outline-state.spec.ts` (S3) |
| Saved Markdown unchanged by the click | Real VS Code | S1 host text unchanged across the clicks |
| | Vitest | S2 (a): no `input` |
| Keyboard Enter on the Outline button | Vitest | S2 (c) |
| | Real VS Code | S1 keyboard case |
| Outline inside the More panel | Vitest | S2 (b) |
| Formatting toolbar actions keep their boundary | Vitest | Existing `:412` test |
| SV mode | None needed | Button hidden (`EditMode.ts:106`) |

No Chromium step is planned: neither harness has both the Outline button and the undo boundaries. Vitest covers the predicate, and real VS Code is mandatory and covers the real click.

### Owner question

1. **Other non-editing toolbar buttons take the same boundary.** By code reading only (not run), `navigate-back`, `wiki-pages`, `edit-in-vscode` and the `more` trigger are `.vditor-toolbar button`s that `isToolbarAction` does not exclude. They probably add a caret-only or decoration-only step the same way.
   - (a) Keep Task 653 to Outline and file a follow-up task for those buttons (recommended: it stays within the stated scope).
   - (b) Add them to `isViewToggle` now and extend the tests.

### Residual risks

- `data-vmde-foldable` (and other view attributes) are still captured in every Undo snapshot. Any other path that calls `addToUndoStack` after a decoration-only change can still add an entry with no Markdown change. That is outside this task.
- If a real edit is still pending when the user clicks Outline, the previous code recorded it immediately at the click. After the fix it is recorded when its own after-render timer fires, or drained by Task 601 on Ctrl+Z. Expected to behave the same; only S1 can confirm it.
- Whether the WYSIWYG caret-only case fails before the fix is unverified (S1 records it).
