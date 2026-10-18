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
- Out: Outline open state and width memory (Task 650) and toolbar actions that insert or format text.
- Scope extension (Owner, 2026-10-18, "Fix all in 653"): every other view-only toolbar control takes no undo boundary either (see the 2026-10-18 extension progress below).

## Acceptance

- [x] After an edit, a toolbar Outline click followed by Ctrl+Z undoes that edit, not nothing.
- [x] The Outline opens and closes as before.
- [x] Saved Markdown is unchanged by the click.

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

## Execution progress — 2026-10-18 (S1–S3)

Correction to the Problem text: the cause is VMDE's toolbar undo boundary (`isToolbarAction` in `media-src/src/editing/undo-boundaries.ts` matched the Outline button), not Vditor's `setSelectionFocus`. Option (a) applied: Outline only. `navigate-back`, `wiki-pages`, `edit-in-vscode` and the More trigger are unchanged and still need a follow-up task.

- **S1 (RED), real VS Code, `outline-toggle-undo.spec.ts`:**
  - First run: the IR click case passed (Undo depth unchanged) because the caret was still where the last entry left it; the WYSIWYG case failed (depth 2, then 3 after the click). The handoff's expectation that the IR case fails without a caret move did not hold: the extra entry needs a caret position that differs from the last entry.
  - The spec was changed so that every case first moves the caret off the last entry (ArrowLeft twice), as the Task 650 evidence had it.
  - Second run: failed at the IR click, `IR click adds no Undo step`, expected 2, received 3. The IR keyboard and WYSIWYG cases were not reached in that run; WYSIWYG had failed in the first run.
- **S2 (Vitest RED, then fix):** the three new cases (toolbar, panel, Enter) failed before the change; after `isViewToggle` replaced `isCollapseToggle` the file passes (199 tests). Changed lines of `undo-boundaries.ts` are covered (file lines 99.09 percent; uncovered 487-488 are unrelated).
- **S3 (GREEN):** `outline-state.spec.ts` now asserts exact equality of the Undo depth and no longer presses Ctrl+Z (owned by the new spec). One invocation of both specs, `--workers=1 --retries=0`: 3 passed.
- Not run: `npm run quality` (S4, closure batch).

## Execution progress — 2026-10-18 (scope extension to every view-only toolbar control)

Owner answered Owner question 1 with option (b): all view-only toolbar controls are fixed in Task 653.

- **Controls found by reading** (each is a `.vditor-toolbar` or `.vditor-panel` button that edits no Markdown):
  - `navigate-back`, `wiki-pages` (post a host message): `media-src/src/chrome/toolbar.ts:296`, `:308`.
  - `edit-in-vscode` (host message): `toolbar.ts:323`.
  - `more` (opens the overflow panel): `toolbar.ts:339`.
  - In the More panel: `settings` (host message), `info` (Vditor About dialog), `about` (VMDE About dialog), `both` (SV preview layout, Vditor `Both.ts`).
  - Kept as they were: `undo`, `redo`, `preview`, `edit-mode`, `[data-mode]` (already excluded); every control that inserts or formats text, including the `insert-anchor` and `insert-picture` More rows, `upload`, `link`, `table`, `line`, `emoji` and `headings` menu triggers, and all formatting buttons. The menu triggers open a panel and the edit is its own panel click that keeps its boundary; exempting the triggers was not requested, so they are not in the list (design question below).
- **Change:** `isViewToggle` in `media-src/src/editing/undo-boundaries.ts` now matches a list of `data-type` values (`collapse-toolbar`, `outline`, `navigate-back`, `wiki-pages`, `edit-in-vscode`, `more`, `settings`, `info`, `about`, `both`) inside `.vditor-toolbar` or `.vditor-panel`. Click and Enter on any of them take no seed, no checkpoint, no `input` and cancel no pending callback.
- **Vitest (`undo-boundaries.test.ts`):** the Outline cases became a `describe.each` over ten control and container pairs (click and Enter each). RED run before the change: 16 failures (the eight new pairs, click and Enter), the two Outline pairs passed. GREEN: file passes (218 tests); changed lines covered (file lines 99.09 percent, uncovered lines unrelated to this change). New control case: the `insert-anchor` and `insert-picture` rows in a panel keep their boundary.
- `npm run typecheck` and `biome check` on both changed files: clean.
- **Coordinator ruling (same day):** the panel-opening triggers are exempt too. Checked by reading Vditor's toolbar sources: `emoji` (toggles its panel only; the insertion is a click on a panel button) and `math` (a Custom item whose `toolbar` panel holds the insert rows) were added to the list. Left as they were because their own click edits: `headings` (the trigger removes the current heading), `code`, `table`, `line`, `link`, `upload` and the formatting buttons. Panel items keep their boundary.
- **Vitest, second step:** RED with `emoji` and `math` missing from the list: 4 failures (click and Enter for each); GREEN 228 tests. New control cases prove that the `insert-anchor`, `insert-picture` and `math-block` rows, a heading choice, an emoji choice, and the `headings`, `code` and `table` buttons still take their boundary.
- **Real VS Code** (`outline-toggle-undo.spec.ts`, new test `view-only toolbar controls add no Undo step`, wiki workspace on): a real click on More (open and close), Emoji (open and close), Math (open and close), About VMDE in More, Wiki Pages (quick pick) and Navigate back leaves the Undo depth, the value and the host text unchanged. Edit in VS Code and Settings open an editor tab, which hides the webview; the webview comes back with a fresh history (measured: depth 2 became 1 after the tab closed), so the depth cannot be compared there. For those two controls the click runs in the page and counts `addToUndoStack` and `input` calls for 150 ms: 0 and 0; the host text was read unchanged right after the Edit in VS Code click. `both` is SV-only and unreachable in the IR session; Vitest covers it. `info` is covered by Vitest only.
- Result: `outline-toggle-undo.spec.ts` 2 passed (exit 0, `--workers=1 --retries=0`).
- **Open:** `outline-state.spec.ts` test 2 (restart persistence, line 592) failed in three runs (frame not found in the restarted VS Code, then zero painted frames sampled). Test 1 of that file passes. It passed in the earlier S3 run of this branch; the cause is unverified and nothing in the change touches the restart path. `npm run quality` is left to the closure batch.

## Review follow-up — 2026-10-18

**Owner answer (2026-10-18, chat):** fix every view-only toolbar button in this task (option b).

- `isViewToggle` now also covers `preview`, `edit-mode` and the `[data-mode]` choices, and is the single predicate used by `onKeydown` and `isToolbarAction`. Enter on those focused buttons no longer seeds or posts `input(getValue())`. RED: the Enter gestures added to the edit-mode, SV, WYSIWYG and Preview cases failed 4 times with the old predicate; GREEN: 234 tests.
- New nested-DOM case: a trigger and a sibling `.vditor-hint` or `.vditor-panel` row inside one item div without `data-type` (More row, Math row, emoji tile). The trigger takes no boundary and the row still does.
- Behaviour change (by reading, not measured): typing before and after a view-only toggle within `undoDelay` now merges into one Undo step, because the toggle no longer checkpoints the first edit. The first edit is still recorded by its own after-render timer or drained on Ctrl+Z (Task 601).
- Real VS Code: `outline-toggle-undo.spec.ts` rerun is waiting for the token.

**Combined real-VS-Code run (2026-10-18, integration build of dev + 652 + 653 + 654 + 656, `--workers=1 --retries=0`):** `outline-toggle-undo.spec.ts` 2/2 passed (`:134` Outline click/Enter, `:253` view-only controls); `undo-boundaries.spec.ts:20` passed.
