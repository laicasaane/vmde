# Task 633 — Code block copy button click falls through to the code block

**Status:** planned (2026-10-14). The Project Owner requested this task on 2026-10-14. Implementation has not started.
**Origin:** Project Owner report (chat, 2026-10-14).
**Severity:** medium (estimated). A visible control does not work; no markdown is changed.
**Tech stack:** TypeScript webview (`media-src/src/clipboard/code-copy.ts`), Vditor IR code-block DOM, Vitest, Chromium, real VS Code.

## Problem

Clicking the copy button on a code block does not copy the code. The click falls through the copy button to the code block instead. The Owner requires the fix to be tested in IR (Instant Rendering) mode.

## Current code

`installCodeCopy` in `media-src/src/clipboard/code-copy.ts` listens for `click` on the document in the bubble phase. It finds `[data-vmde-copy-code="true"]`, reads the sibling `textarea`, and posts `copy-code` to the host.

## Suspected cause (unverified)

In IR, Vditor handles the earlier `mousedown`/`pointerdown` (or its own click handler) on the code block first: it expands the block into its editable source and moves the caret. The copy button is then moved, hidden or replaced before the document-level `click` reaches it, or Vditor stops the event. Part 1 must confirm the cause by measurement before a fix is chosen.

## Acceptance

- [ ] Cause measured in real VS Code IR mode and recorded (event order, which handler wins, DOM before and after the press).
- [ ] In IR, a click on a code block's copy button copies the exact code text to the clipboard (host `copy-code` received with the expected content) and does not expand the block, move the caret or change the selection.
- [ ] The document bytes, dirty state and Undo history are unchanged by the click.
- [ ] Keyboard activation of the button (if it is focusable) behaves the same.
- [ ] WYSIWYG and the SV preview keep working (regression check); a click elsewhere on the code block still enters editing as before.
- [ ] Focused real-VS-Code IR spec written and run; `npm run quality` passes.

## Tests

- Vitest: `code-copy.test.ts` for the new event handling (press on the button is consumed; press elsewhere passes through).
- Chromium harness: IR code block, press and click on the copy button; caret, selection and block state unchanged; copy message posted.
- Real VS Code (`test/vscode-e2e/`, related: `copy-clipboard.spec.ts`): IR first, then WYSIWYG and SV preview regression test cases. Run `node build.mjs` first, then the spec under `xvfb-run`.

## Execution progress — 2026-10-14 (S1a)

Measure-only step: no product, test or generated-file edits. Real-VS-Code measurement (acceptance item 1) is still open and is planned as S1 below. Measurements ran in Chromium on the shipped IR code-block DOM, using scratch scripts under the ignored `tmp/` directory (not tracked).

### Measured (Chromium, real pointer press: move, down, 150 ms hold, up)

Test document: one fenced block after a paragraph, a second block, and a third block inside a list item; caret started in the last paragraph.

Case A, existing `code-copy-text` harness (Vditor IR plus `installCodeCopy`, without `installIrMarkerReveal`):

- Event order: `pointerdown`, `mousedown`, `pointerup`, `mouseup`, `click`, all targeting the button's `svg`. The button stayed connected and `[data-vmde-copy-code]` count stayed 3 throughout.
- Native `mousedown` default moved the selection from the paragraph into the highlighted preview text (visible at `pointerup`).
- The Vditor IR root `click` handler (`ir/index.ts`, line 139) ran before the document-level bubble listener. It moved the caret into the block's source `code` (offset 0) and `expandMarker` added `vditor-ir__node--expand`.
- `copy-code` was posted with the exact text (`const a = 1;\nconst b = 2;`), once. Document value unchanged. Same result for the second and third (list) block and with no prior focus or selection.
- Result: copy works here, but the block expands and the caret and selection move (violates acceptance item 2).
- WYSIWYG control (same harness): copy posted; the native press still moved the caret into the code text and Vditor's click handler then set the caret at offset 0 of `code.language-js` and showed the source pre (`display: block`). Same fall-through, no copy loss.

Case B, harness plus `installEditorCaretTracking()` and `installIrMarkerReveal()` (what `boot/main.ts` installs):

- `pointerdown`/`mousedown` target the `svg`; after the native selection move, the next animation frame adds `vditor-ir__node--expand`, and CSS hides `.vditor-ir__preview` (`display: none`) while the button is still pressed.
- `pointerup`, `mouseup` and `click` then target `div.vditor-ir__node.vditor-ir__node--expand`, the common ancestor of the press target and the release target.
- The document-level listener does `closest('[data-vmde-copy-code]')` from that target, finds nothing, and returns. `copy-code` was not posted (empty message list). The click carries `defaultPrevented: false`.
- The selection ends at offset 0 of `code.language-js`; the block stays expanded; `getValue()` is unchanged.

### Cause

The winner is the selection-driven marker reveal in `media-src/src/editing/editor-caret.ts` (`installIrMarkerReveal`, `selectionchange` handler, frame-coalesced), triggered by the native `mousedown` default action that places the caret inside `.vditor-ir__preview` text. It expands the node before `mouseup`; `main.css` hides the preview for an expanded node, so the button disappears under the pointer and the `click` is retargeted away from it. Vditor's own IR root `click` handler (`ir/index.ts:139`, which selects the source `code` of a clicked preview and calls `expandMarker`) is a second, independent fall-through: it runs before the document-level bubble listener in `code-copy.ts`, so even when the click does reach the button, the block expands and the caret moves.

Unverified in real VS Code: whether it reproduces exactly as in Case B. The existing real-VS-Code spec `preview-widgets.spec.ts` (lines 62 to 77) clicks the IR copy button through Playwright and expects the clipboard text, so Playwright's click timing may complete before the reveal frame; the S1 plan below uses a held press to measure it.

### Proposed fix layer (not implemented)

In `installCodeCopy` (`code-copy.ts`), add capture-phase document listeners:

- `mousedown` on the button: `preventDefault()` (stops the native caret move, focus change and selection change, so the reveal never starts).
- `click` on the button, moved from the bubble phase to the capture phase: `preventDefault()`, `stopPropagation()`, post `copy-code`. Capture phase is needed so Vditor's IR root click handler never sees the click.

A throwaway prototype of exactly this pair, run in Case B (IR blocks 1 to 3, no prior focus, WYSIWYG): `copy-code` posted once with the exact text, no `--expand` class, selection and caret unchanged, root HTML unchanged, value unchanged. A click on the code text elsewhere in the block still expanded the block as before (the prototype consumes only presses on the button).

### Edge cases the fix must hold

- A press elsewhere on the block (code text, gutter, info string) still enters editing: only presses whose `closest` matches the button are consumed.
- Keyboard activation: the button is a `span` with `tabIndex === -1`, no role and not focusable (`focus()` leaves `activeElement` unchanged; Tab visits the `code` elements only), so there is no keyboard path to keep or add. Adding one would be a separate scope decision.
- WYSIWYG: the same fall-through exists (caret and source pre), but copy works. A shared handler changes WYSIWYG too (no caret move). Open design question below.
- SV preview and the Preview panel: the buttons live in a non-editable pane; consuming the press there only prevents a `mousedown` default on a control, so `code-copy-text.spec.ts` must still pass.
- No bytes, dirty or Undo change: the fix posts only `copy-code` and writes nothing; assert `getValue()`, host text, `isDirty` and the Undo stack length before and after.
- Adjacent and nested blocks: two blocks with no paragraph between them, a block in a list item, and a block in a callout (`blockquote > [data-type=code-block]`) each have their own button; `button.parentElement.querySelector('textarea')` stays within the same `.vditor-copy`.
- Right or middle button, modifier keys: `mousedown` default is prevented for any button on the control; the `click` event only fires for the primary button, so no copy on other buttons. Decide whether to restrict `mousedown` prevention to `button === 0`.
- A block already expanded has its preview hidden (`display: none`), so its button cannot be pressed.
- Other capture listeners on the document (`pointerdown` consumers such as `editor-caret.ts`, `caret.ts`, selection bubble, auto-wrap cancel) still receive `pointerdown`; only `mousedown` and `click` are consumed. A copy press therefore still sets `allowVisibleMarkerEdit` in the reveal controller. Open design question below.

### Open design questions

1. Apply the press consumption in WYSIWYG too (shared handler, removes the caret move) or restrict it to IR so WYSIWYG stays exactly as today? The acceptance text says WYSIWYG keeps working.
2. Also consume `pointerdown` (stops other `pointerdown` observers and the `allowVisibleMarkerEdit` flag) or only `mousedown`? The prototype did not need it.

### S1 plan: real-VS-Code cause measurement (acceptance item 1)

New measurement spec under `test/vscode-e2e/` (tagged `@probe`, non-asserting, one `test()`), run after `node build.mjs`:

1. Write a temporary document: a paragraph, a fenced block (`js`, two lines), a second block, a block in a list item, a final paragraph. Open it with `vscode.openWith` and the custom editor view type, as `preview-widgets.spec.ts` does. Wait for `.vditor-ir`, then for the initial Undo snapshot (`waitForInitialUndoSnapshot`) and a settle.
2. Install in the frame (via `frame.locator('body').evaluate`): capture and bubble listeners on `document` for `pointerdown`, `mousedown`, `pointerup`, `mouseup`, `click`; per event record `target` description, `defaultPrevented`, `button.isConnected`, count of `[data-vmde-copy-code]`, per-block `vditor-ir__node--expand` flags, `getComputedStyle(preview).display`, and selection (`anchorNode` description, offsets, `isCollapsed`); a `MutationObserver` on the IR root (class and `data-render` attributes, child lists); a wrapper around `window.vscode.postMessage` that logs `copy-code` messages.
3. Record baselines: `docText`, `TextDocument.isDirty`, the IR Undo stack length (`vditor.vditor.undo.ir.undoStack.length`), root `innerHTML` of the first block, and set the host clipboard to a sentinel with `vscode.env.clipboard.writeText`.
4. Place the caret in the last paragraph with a real click and read the selection. Hover the first block's preview, read the button box with `boundingBox()`, then press with page-level mouse input: `mouse.move`, `mouse.down`, wait about 150 ms, read `elementFromPoint` at the press point and the expanded flags, `mouse.up`, wait about 500 ms.
5. Read back: the ordered event list, the `copy-code` posts, `vscode.env.clipboard.readText()`, the live-region text (`#vmde-live-region`), block HTML after (diff against before), selection after, `docText`, `isDirty`, Undo stack length.
6. Expected if Case B reproduces: `mouseup` and `click` target the expanded `div.vditor-ir__node`, no `copy-code`, clipboard still the sentinel, selection in the block's source `code`. Record any difference (for example a click that reaches the button but still expands the block).
7. Repeat once with a quick press (`mouse.click`, no hold) to compare with the existing Playwright-click behaviour, and once in WYSIWYG as a control. Record the same values; do not assert.

Run: `node build.mjs`, then `env -u ELECTRON_RUN_AS_NODE xvfb-run -a npm --prefix test/vscode-e2e test -- <spec> --workers=1 --retries=0` under `timeout`. The fix step (S2) turns this measurement into assertions on clipboard text, no `--expand`, unchanged selection, bytes, dirty state and Undo length.

## Execution progress — 2026-10-14 (S2)

Failing tests first, then the fix. Decisions applied (orchestrator, provisional, reversible): one shared handler for IR and WYSIWYG, so a copy-button press never moves the caret in either mode; only the primary-button `mousedown` and the `click` are consumed, while `pointerdown`, right and middle buttons keep their defaults (the context menu keeps working).

### Fix

`installCodeCopy` in `media-src/src/clipboard/code-copy.ts` now registers two capture-phase document listeners and returns a disposer that removes both:

- `mousedown` with `button === 0` (any modifiers) on `[data-vmde-copy-code]`: `preventDefault()`, so the native caret move, focus change and selection change never start and the marker reveal never expands the block.
- `click` on the button: `preventDefault()`, `stopPropagation()`, then the existing `copy-code` post. The capture phase runs before Vditor's IR root click handler, so that handler never sees the click.

### Tests (written first; the failing run is recorded below)

- Vitest `media-src/src/clipboard/code-copy.test.ts` (acceptance 2, edge cases): primary `mousedown` on the button and on its inner icon, and with a modifier key, is default-prevented; a `mousedown` elsewhere is not; right and middle button `mousedown` are not; the capture `click` posts `copy-code` once with the textarea text, is default-prevented and never reaches a root bubble listener; a click elsewhere is not consumed; dispose removes both listeners.
- Chromium `media-src/e2e/code-copy-text.spec.ts`, using `code-copy-text-harness.ts`, which now installs `installEditorCaretTracking` and `installIrMarkerReveal` as `boot/main.ts` does (opt-in through a page flag, so the existing text-exactness test case runs unchanged) and exposes the Undo stack length:
  - IR held press (`mouse.down`, 150 ms, `mouse.up`) on the copy button of four blocks (paragraph flow, adjacent block, list item, quote with a callout marker), caret first placed in the last paragraph: `copy-code` posted once with the exact text, no `vditor-ir__node--expand`, selection unchanged, root HTML and value unchanged, Undo stack length unchanged (acceptance 2 and 3; edge cases: list, callout, adjacent blocks).
  - IR click on the code text still expands the block, with no copy posted (acceptance 5).
  - WYSIWYG held press: copy posted once, selection, value and Undo length unchanged (decision 1).

### Failing before the fix

- Vitest: 3 of 8 failed (primary `mousedown` not prevented, capture `click` reached a root bubble listener, `dispose` was not a function).
- Chromium: the IR held-press test case failed on block 0 (no `copy-code` posted, an empty message list) and the WYSIWYG test case failed on the selection (it moved from the last paragraph into the block source). The click-on-text test case passed, as expected (it guards existing behaviour).

### Results after the fix

- Vitest `code-copy.test.ts`: 8 of 8 passed.
- Chromium `code-copy-text.spec.ts`: 4 of 4 passed (the 3 new test cases plus the existing text-exactness test case).
- `npm run typecheck`: clean. Biome check on the 4 changed files: clean.
- The e2e harness port 9123 was held by another worktree, so the Chromium run used a temporary Playwright config on a free port (same spec); it was deleted afterwards.

### Acceptance status after S2

- Item 2 (copy without expanding, moving the caret or changing the selection) and item 3 (bytes, Undo): proven in Chromium for IR with the boot-time installs; real-VS-Code confirmation is still open (S1 and the focused real-VS-Code spec).
- Item 4 (keyboard): the button is a `span` with `tabIndex === -1` and no role, so there is no keyboard path today. No test; a keyboard path would be a separate scope decision.
- Item 5: IR click on the code text still expands (Chromium). SV preview and Preview panel: the existing text-exactness test case still passes. Real-VS-Code regression is still open.
- Items 1 (real-VS-Code cause measurement), 6 (focused real-VS-Code spec, `npm run quality`) remain open.
- Real-VS-Code specs that exercise `code-copy.ts` and were not run in this step (no real-VS-Code token): `test/vscode-e2e/preview-widgets.spec.ts`, `test/vscode-e2e/large-document-interaction.spec.ts`, `test/vscode-e2e/screen-reader-semantics.spec.ts`.
