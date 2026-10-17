# Task 650 — Remember whether the Outline panel is open, and its width, across files and sessions

**Status:** done (2026-10-17).
**Origin:** Project Owner feature request.
**Severity:** feature (low risk; one persisted preference and a check of an existing one).
**Tech stack:** extension host (`src/session/editor-session.ts`, `src/platform/state-keys.ts`, `src/shared/protocol.ts`, `src/webview-host/webview-message-shape.ts`, `src/webview-host/html-builder.ts`), webview (`media-src/src/nav/outline.ts`, `nav/outline-resize.ts`, `boot/live-config.ts`, `boot/vditor-init.ts`), Vitest, Chromium, real VS Code.
**Builds on:** [Task 08](08-outline-width-show-by-default.md) (outline width and open-by-default), [Task 631](631-toolbar-collapse-toggle.md) (a user-level toggle state in `globalState`, carried in `init` and the first-paint payload, broadcast to other open editors).

## Current behaviour (from source)

- **Open state is not remembered.** The in-editor Outline panel opens according to the setting `vmde.outline.defaultOpen` (default off) every time an editor opens. Toggling it by hand lasts only for that editor.
- **Width is already stored.** Resizing the panel posts `save-outline-width`, which writes the width to `globalState` under `vmde.outlineWidth` (`editor-session.ts`). The next editor receives it as `outlineWidth` in `init` and applies it as `--me-outline-width` (`live-config.ts`). Editors that are already open do not follow a resize made in another editor, and whether the width survives every path (restart, first paint, Preview, Split) is not covered by a real-VS-Code test.

## Requirements

1. **Remember the open state.** Opening or closing the Outline panel (toolbar button, command or keyboard) stores the state as one user-level value, shared by every file and kept across VS Code sessions. Every editor opened afterwards opens with the panel in that state.
2. **Remember the width.** The width the user last set (drag or keyboard resize) applies to every editor opened afterwards, across files and VS Code sessions, in every mode, from the first paint.
3. **Open editors.** Part 1 decides whether other open editors follow a toggle or a resize at once (as the toolbar collapse state does) or keep their state until reopened (as the Preview toggle in [Task 651](651-remember-preview-toggle-state.md) does); the same rule applies to both values.
4. **Relation to `vmde.outline.defaultOpen`.** Part 1 settles the rule; proposed: until the user first toggles the panel, `vmde.outline.defaultOpen` decides; after that the remembered state decides, and changing the setting resets the remembered state to the new setting value.
5. **No document effect.** Toggling or resizing changes no document text, dirty state, Undo history, caret, selection or scroll position.
6. **Storage.** Both values are profile-local `globalState` entries and are not synced across machines, like the toolbar collapse state.

## Open design points (settled in Part 1)

- The rule for open editors (requirement 3) and for `vmde.outline.defaultOpen` (requirement 4).
- Whether the width is kept per side (`vmde.outline.position` left or right) or one value for both.
- Clamping a stored width to the current window (the panel already clamps to [100 px, 50% of the viewport]) without overwriting the stored value.
- Interaction with section hoisting, Preview, Split and streamed large files, and with the Explorer "Markdown Outline" tree (`vmde.outline.tree`), which is a separate view and stays unchanged.

## Scope

- In: the in-editor Outline panel's open state and width, their storage, `init` and first-paint delivery, and the rule for open editors.
- Out: the Explorer outline tree, outline content and highlighting, outline position.

## Acceptance

- [x] Opening or closing the panel in one file, then opening another file, shows the panel in the same state; the same after a VS Code restart.
- [x] Resizing the panel, then opening another file and restarting VS Code, shows the panel at the resized width from the first paint, in IR, WYSIWYG, Split and Preview.
- [x] Other open editors behave according to the Part 1 rule for both values.
- [x] `vmde.outline.defaultOpen` behaves according to the Part 1 rule.
- [x] A stored width wider than the current window is clamped for display without changing the stored value.
- [ ] No document text, dirty state, caret, selection or scroll change. *Narrowed by the Owner (2026-10-17, chat): a click on Vditor's toolbar Outline button with the caret in the editor adds one Undo step holding only DOM decoration (pre-existing, also without this task's hook); removing it is a separate task.*
- [x] Focused Vitest, Chromium and real-VS-Code specs are written and run (restart case with the own-launch pattern from Task 631); network-free gates pass at closure. *Gates for this task's files passed on the batch-1 HEAD; the batch-level failures (knip, coverage exit code) belong to Tasks 649 and 641 (see the closure section).*

## Tests

- Vitest: state key read and write, message shapes, the `defaultOpen` rule, width clamping.
- Chromium: toggle and resize post the right messages; init values applied at first paint; clamping.
- Real VS Code (`test/vscode-e2e/`): two files and a restart for both values, other open editors, each mode.

## Part 1 handoff (2026-10-17)

Read-only source mapping; nothing was run (no Vitest, Chromium, build or VS Code).

### Verified facts

- The only way to toggle the panel is Vditor's own toolbar `outline` button (`media-src/node_modules/vditor/src/ts/toolbar/Outline.ts:12-19`: it flips `vditor.options.outline.enable`, then calls `vditor.outline.toggle`). There is no VMDE command or key binding (`package.json` has no outline toggle command). Keyboard use is Enter/Space on the focused button, which fires the same click.
- Programmatic hides do not change `enable`: switching mode calls `toggle(vditor, mode !== 'sv' && enable)` (`toolbar/EditMode.ts:150`); a window under 520 px wide hides the panel without touching `enable` (`outline/index.ts:28`, `Constants.MOBILE_WIDTH`). Split (sv) therefore shows no panel at all; the Outline button stays usable in Preview (Preview disables only `EDIT_TOOLBARS`, `both`, `edit-mode`, `devtools`).
- Open state at init: `boot/vditor-options.ts:90-95` sets `outline.enable = msg.options?.showOutlineByDefault === true` from `vmde.outline.defaultOpen` (`src/platform/editor-config.ts:265`). `showOutlineByDefault` and `outlinePosition` are `INIT_ONLY_OPTIONS` (`boot/live-config.ts:203-213`), so a setting change re-inits Vditor in every open editor (`bridge/message-router.ts:498-530`, merge `{...lastInitMsg.options, ...msg.options}`).
- Width: `finish-init.ts:359-363` posts `save-outline-width` from `setupOutlineResize` (`nav/outline-resize.ts`; drag posts on mouseup, keyboard posts per press). Host writes the raw number: `editor-session.ts:1536-1537`; the shape check only requires type `number` (`webview-message-shape.ts:105`), so negative, zero and NaN-like values are stored. `buildInitOptions` adds `outlineWidth` when truthy (`editor-session.ts:392-396`), used by both the `init` post (337) and the inline first-paint payload (`inlineInitPayload`, 430). `applyBodyOptions` writes `--me-outline-width` when > 0 (`live-config.ts:110`), on init (`message-router.ts:301`) before Vditor is built, so the panel's first frame already has the stored width. `build.mjs:491-492` patches Vditor's CSS to `width: var(--me-outline-width, 200px)` with no clamp; only the drag/keyboard paths clamp (`clampOutlineWidth`, 100 px to 50% of `innerWidth`). A stored width wider than the window is therefore displayed unclamped today (the panel has `flex-shrink: 0`, `main.css:1931`). Keyboard basis `currentWidth()` reads the unclamped var (`outline-resize.ts:170-175`).
- `KeyOutlineWidth` is in the Settings Sync key list (`app/extension.ts:187`, asserted in `test/backend/extension.test.ts:47`). Requirement 6 ("profile-local, not synced") is wrong for the width as shipped; see Owner question 1.
- The instant-paint overlay and `html-builder.ts` have no outline handling today (no hit for "outline"); the panel exists only once Vditor is built. A remembered-open panel therefore appears with the Vditor build, exactly as `defaultOpen` does today.
- Task 631/651 pattern: `platform/state-keys.ts` key plus reader, `editor-session.ts` init and inline payloads, handler in the message table (`:1536-1540`), shape row in `webview-message-shape.ts`. 651 requirement 4: only the toggled editor changes.

### Decisions

1. **Open editors follow nothing (aligned with 651).** A toggle or resize changes the stored value only; other open editors keep their state until reopened. Reason: no host-to-webview broadcast or message type, no layout or selection side effects on editors the user is not looking at (a live `outline.toggle` re-renders the outline and calls `setPadding`), and one rule for the Outline and Preview preferences. Last writer wins.
2. **`vmde.outline.defaultOpen` rule (as proposed).** Until the user first toggles, the setting decides. After that, the stored boolean decides. A change to `vmde.outline.defaultOpen` (any scope) clears the stored open value on the host, and the re-init that the setting change already causes in every open editor drops the remembered value too, so the editor shows the new setting value and the setting decides again.
3. **Which actions store.** Only a click on the toolbar Outline button (mouse, Enter, Space). Mode switches, Split, narrow windows, re-inits and `defaultOpen` never store. A click that Vditor ignores (disabled button) stores nothing: the hook compares `vditor.options.outline.enable` with the last known value and posts only on change. A toggle in a window under 520 px stores the intent (`enable`) even though the panel stays hidden.
4. **Width per side: one value for both sides.** The existing key stays; per-side storage would need a migration for little gain. The remembered width is clamped by the panel on display (decision 5), so a width set on the other side is still valid.
5. **Clamping for display, stored value untouched.** Change the `build.mjs` patch to `width: min(max(var(--me-outline-width, 200px), 100px), 50vw)`, so first paint and later window resizes clamp with no JS and nothing is posted. `outline-resize.ts` `currentWidth()` clamps the parsed var with `clampOutlineWidth(v, innerWidth)` so keyboard steps start from the shown width, and the separator's `aria-valuenow` shows the shown width. The stored value changes only when the user resizes. Host hardening: ignore a `save-outline-width` that is not finite and > 0; `buildInitOptions` ignores a stored non-finite or <= 0 width.
6. **Hoisting, Preview, Split, streaming.** Open state and width are independent of them. Section hoisting does not touch the panel. Preview: the toggle is stored; opening in Preview via 651 does not touch it. Split shows no panel (Vditor), stored values are untouched and apply on return to IR or WYSIWYG. Streamed large files (`inlineInitPayload` returns undefined) get the same values from the `init` post. The Explorer tree (`vmde.outline.tree`) is unchanged.
7. **Re-init keeps live state.** The toggle hook also writes `outlineOpen` into `sessionState.lastInitMsg.options`, so a later re-init caused by an unrelated setting keeps the user's current state. (The width lives in the body CSS var, which a re-init does not reset.)

### State and messages

- Key `vmde.outlineOpen` (`KeyOutlineOpen` in `platform/state-keys.ts`), profile-local: NOT added to `setKeysForSync`. `readOutlineOpen(store): boolean | undefined` returns the value only when it is a strict boolean. Existing `vmde.outlineWidth` is unchanged.
- Webview to host: `save-outline-open { open: boolean }` (add to `protocol.ts` and a `['open','boolean']` row in `webview-message-shape.ts` plus the comment list there). Existing `save-outline-width { width: number }` stays.
- Host to webview: no new message. `outlineOpen?: boolean` is added to the options blob next to `outlineWidth` (`protocol.ts:150` type, `buildInitOptions`, so both the `init` post and the inline payload carry it). Absent means the setting decides.
- Host reset: in the `onDidChangeConfiguration` handler (`editor-session.ts:1568`), before `postLiveConfig`, `if (e.affectsConfiguration('vmde.outline.defaultOpen')) globalState.update(KeyOutlineOpen, undefined)`.

### Where the rule lives

Host owns storage and delivery; the webview owns the resolution: `enable = typeof options.outlineOpen === 'boolean' ? options.outlineOpen : options.showOutlineByDefault === true` in `boot/vditor-options.ts` (pure, unit-testable). The host does not rewrite `showOutlineByDefault`, because `postLiveConfig` sends raw `collectConfigOptions` and a rewritten init value would make every unrelated config change look like an init-only change and close the panel. In `message-router.ts` `handleConfigChanged`, when `msg.options.showOutlineByDefault` differs from `lastInitMsg.options.showOutlineByDefault`, remove `outlineOpen` from the merged re-init options.

### Part 2 steps

- **S1 host.** `src/platform/state-keys.ts`, `src/shared/protocol.ts`, `src/webview-host/webview-message-shape.ts`, `src/session/editor-session.ts` (build options, handler, width validation, setting reset). Tests: `test/backend/editor-session.test.ts`, `test/backend/extension.test.ts` (open key not in the sync list, width still is; valid and malformed `save-outline-open`; `save-outline-width` with negative or zero stored nothing).
- **S2 webview open state.** `media-src/src/boot/vditor-options.ts`, new `media-src/src/nav/outline-state.ts` (+ test, + `scripts/module-manifest.mjs` entry next to `outline-resize`) that binds a click listener on `toolbar.elements.outline`, reads `options.outline.enable` after Vditor's handler, posts on change and updates `lastInitMsg.options.outlineOpen`; `boot/finish-init.ts` wiring and disposer; `bridge/message-router.ts` (drop on setting change); `boot/live-config.ts` option type. Tests: Vitest (resolution, hook posts once per change, disabled click posts nothing, router drop); Chromium in `media-src/e2e/outline.spec.ts` (+ harness hook for init values).
- **S3 webview width.** `build.mjs` patch, `media-src/src/nav/outline-resize.ts` (`currentWidth` clamp), `outline-resize.test.ts`. Tests: Chromium measured panel width with an oversized var (clamped, var unchanged), window narrowing clamps live, keyboard step from the clamped basis.
- **S4 real VS Code.** New `test/vscode-e2e/outline-state.spec.ts`; restart case with the own-launch pattern of `wiki-persistent-keys.spec.ts`; extension ID from the shared constant.

### Test list mapped to acceptance

- Open state across files and restart: host Vitest (stored value in init and inline payload; absent, string, number stored values mean "setting decides"); real VS Code (toggle in file A, file B opens in that state, restart, same).
- Width at first paint in each mode: host Vitest (width in init and inline payload); real VS Code (second file and restart: panel width equals stored from the first frame where the panel exists, sampled; IR, WYSIWYG, Preview; Split shows no panel and the width applies on return).
- Other open editors: host Vitest (a toggle posts nothing to other sessions); real VS Code (two editors open, toggle and resize in one, the other unchanged until reopened).
- `defaultOpen` rule: Vitest (resolution, setting change clears the key and the router drops the remembered value); real VS Code (toggled closed with setting on, still closed in the next file; changing the setting then reopens per the setting).
- Clamp: Chromium (S3) and a Vitest on the clamp helper use; stored value unchanged after display.
- No document effect: real VS Code (host bytes, dirty state, Undo step, caret and scroll unchanged by toggle and resize).
- Edge cases: disabled-button click, narrow window toggle, mode switch stores nothing, malformed width, re-init by an unrelated setting keeps the state, Preview toggle.

### Owner question

1. Width sync. `vmde.outlineWidth` is already in Settings Sync (Task 08 era), but requirement 6 says both values are profile-local. Recommendation: keep the width synced as shipped (changing it silently stops syncing for existing users) and make only the new open key profile-local. Alternative: stop syncing the width too (window sizes differ per machine). Part 2 S1 proceeds with the recommendation unless told otherwise.

   **Owner answer (2026-10-17, chat):** keep the width synced as shipped; only the new open key `vmde.outlineOpen` is profile-local. Requirement 6 applies to the open key only.

### Residual risks

- Content reflow when the panel appears with the Vditor build after the instant-paint overlay (same as `defaultOpen` today); not addressed here.
- A folder-level override of `vmde.outline.defaultOpen` clears the one global open value for all folders.

## Execution progress — 2026-10-17 (S1 host)

Part 2 S1 (host) is implemented and checked; no Acceptance box is ticked (webview and real-VS-Code steps S2 to S4 remain).

- Files: `src/platform/state-keys.ts` (`KeyOutlineOpen`, `readOutlineOpen`; not in `setKeysForSync`, width stays synced), `src/shared/protocol.ts` (`outlineOpen`, `save-outline-open`), `src/webview-host/webview-message-shape.ts` (boolean `open` row), `src/session/editor-session.ts` (init options carry `outlineOpen` only for a strict boolean and a width only when positive finite; `save-outline-open` stores and posts nothing; `save-outline-width` stores only positive finite numbers; a `vmde.outline.defaultOpen` change clears the key after the active-uri early return), plus `media-src/src/diagram-kit/diagram-config-delta.test.ts` (exhaustiveness literals) and `test/backend/vscode-mock.ts` (optional affected-sections list for `fireDidChangeConfiguration`).
- Tests: `test/backend/editor-session.test.ts` (describe "remembered Outline state"), `test/backend/webview-message-shape.test.ts`, `test/backend/extension.test.ts`. Written first: 11 failed before the change; afterwards the three files pass (215 tests).
- Checks: `tsc --noEmit -p ./` and `npm run typecheck` exit 0; `biome check` on the changed files clean.
- Accepted limit: if no open editor is affected by a `defaultOpen` change, nothing clears the key.

## Execution progress — 2026-10-17 (S3 width clamp)

Part 2 S3 is implemented and checked; no Acceptance box is ticked (S2 and S4 remain).

- Files: `build.mjs` (the `.vditor-outline` patch now emits `width: min(max(var(--me-outline-width, 200px), 100px), 50vw)`, replace still matches once), `media-src/src/nav/outline-resize.ts` (new pure `shownOutlineWidth`; `currentWidth()` uses it so keyboard steps start from the shown width), `media-src/src/nav/outline-resize.test.ts`, `media-src/e2e/outline.spec.ts`.
- Tests (written first, shown failing: 4 Vitest cases and 3 Chromium cases): Vitest `shownOutlineWidth` (oversized to 50% of viewport, undersized to 100, in-range unchanged, unset or malformed falls back to the measured width) proves the Clamp row; Chromium proves: var `5000px` shows 50% of the viewport (within 1 px), var unchanged, nothing posted, narrowing the window re-clamps live; var `50px` shows 100 px; a keyboard step and `aria-valuenow` start from the shown width and only the user step stores a value.
- Checks: `node build.mjs` exit 0 (no tracked file changed); Vitest file 13 passed; `outline.spec.ts` 21 passed; `npm run typecheck` exit 0; `biome check` on changed files clean.
- Not run: real VS Code (S4), full-suite gates.

## Execution progress — 2026-10-17 (S2 open state)

Part 2 S2 (webview open state) is implemented and checked; no Acceptance box is ticked (S4 real VS Code remains).

- Files: `media-src/src/boot/vditor-options.ts` (remembered boolean decides, else the setting), new `media-src/src/nav/outline-state.ts` (+ test; module-manifest entry in the `nav` group), `media-src/src/boot/finish-init.ts` (`outline-state` observer; writes `outlineOpen` into `sessionState.lastInitMsg.options`), `media-src/src/bridge/message-router.ts` (re-init options drop `outlineOpen` when `showOutlineByDefault` differs), `media-src/e2e/outline-harness.ts` and `outline.spec.ts`.
- `live-config.ts` needed no change: `outlineOpen` is already on the shared options type, and neither `outlineWidth` nor `outlineOpen` belongs in `INIT_ONLY_OPTIONS` (only the setting `showOutlineByDefault` is).
- Tests: Vitest resolution table (9 cases), hook (post once per user toggle, nothing for a disabled click or a programmatic change, nothing after dispose, `remember` called), router (drop on setting change, keep on unrelated init-only change); written first and shown failing. Chromium (24 passed in `outline.spec.ts`): remembered open with setting off opens and a user toggle posts the right `open`; remembered closed with setting on stays closed; a mode switch cycle posts nothing. The Chromium cases were added with the implementation (harness hook needed), not shown failing first.
- Checks: `npm run typecheck`, `tsc --noEmit -p ./`, `biome check` clean; `node build.mjs` exit 0 with no tracked file changed.
- Not run: real VS Code (S4).

## Execution progress — 2026-10-17 (S4 real VS Code)

Part 2 S4 is implemented and run. Acceptance boxes 1 to 5 are ticked (box 5 on the S3 Chromium evidence); box 6 (no document effect) stays open because of the Undo finding below; the Tests and closure-gates box stays open.

- File: new `test/vscode-e2e/outline-state.spec.ts` (two `test()` blocks: the in-harness case that needs the shared VS Code, and the restart case with four own launches of the installed VS Code on one user-data directory, the design of `toolbar-collapse.spec.ts`). Every toggle is a real click on the toolbar Outline button; resizes are real key presses (Home, then the growing arrow key) and one real mouse drag on the separator; widths are the measured content width of `.vditor-outline`.
- Proves (Acceptance 1): toggle in file A, file B opens in that state; after restart the state is the same, for the same and another file. (2): after a restart the panel is at the stored width on every sampled painted frame where it is visible (per-frame sampler from document start, `seen` equals exactly one `width|variable` pair), in IR, WYSIWYG and Preview; the host `init` carries the stored `outlineOpen` and `outlineWidth`; Split shows no panel (`enable` still true, variable unchanged) and the width applies on return to IR. (3): with two editors open, a toggle and a resize in one leave the other unchanged until all editors are closed and it is reopened; files opened afterwards follow the last writer. (4): with the setting on, a user toggle to closed stays closed in the next file; a setting change (`false`, then `true`) makes the setting decide again (open) although "closed" was stored.
- Acceptance 6, partly proven: host bytes, dirty flag, markdown value, caret position inside its block and scroll positions are identical after toggle, toggle back, keyboard resize and mouse drag; Undo after all of it leaves value and host text unchanged. Finding (not caused by Task 650): the first real click on the toolbar Outline button with the caret in the editor adds one Undo snapshot (depth 1 to 2) and splits the caret's text node. The snapshot holds only DOM decoration (`data-vmde-foldable` attributes and the caret marker), no markdown. It also occurs with the Task 650 click hook disabled (measured with the hook turned off and the bundle rebuilt, then restored), and Vditor's own `Outline.toggle` restores the selection (`setSelectionFocus`), which is the likely source. The spec therefore allows at most one such snapshot and asserts nothing else moves. Whether to suppress that snapshot is a design question for the Owner (it would need a change in the Vditor patch layer, outside Task 650's own files).
- Environment notes: the spec restores the stored width to 200 px, the panel to closed, IR and Preview off at its end, and clears `vmde.outline.defaultOpen`. One full run failed once at the first launch of the restart case (the webview did not appear within 30 s after the previous case); the same spec passed alone and in the next full run. Two stored-value writes made 1 s apart were reliable (no lost last value seen).
- Checks: `node build.mjs` exit 0; `npm run typecheck:vscode-e2e` exit 0; `biome check` on the spec clean; spec run under `xvfb-run -a` with `--workers=1 --retries=0`: 2 passed. Not run: Vitest, Chromium, `npm run quality` (closure gates).


## Closure — 2026-10-17 (batch 1)

- **Gates, once on the combined HEAD `57b7a957` (batch 1: Tasks 651, 650, 647, 641; network-free; `npm run quality` and `npm run audit` not run, audit omitted by Owner instruction).**
  - `npm run lint:ci` exit 0; `npm run typecheck` exit 0; `npx tsc --noEmit -p ./` exit 0; `npm run jscpd` exit 0; `npm run depcruise` (host and webview) exit 0; `npm run check:brand-identifiers` exit 0; `node build.mjs` exit 0.
  - `npm run knip` exit 1: one unused export, `MAX_SECTION_DEPTH` in `media-src/src/nav/section-indent.ts:25` (added by Task 649, `f450644d`; not a file of this task). New failure, attributed to Task 649.
  - `npm run test:coverage`: 349 test files and 7,109 tests passed, 1 expected failure, but the command exits 1 because of one unhandled error, `ReferenceError: requestAnimationFrame is not defined`, raised from `scheduleGlyphFlush` (`media-src/src/nav/section-fold.ts:802`) during `section-fold.test.ts`. New failure, attributed to Task 641 (`ec671180`, glyph flush after first paint); no file of this task is involved. Two earlier runs of the same command on this HEAD (the first before `node build.mjs`, so the Lute host test cases skipped) failed once on a timing assertion in `markmap-security.test.ts` (passes alone) and once on the known 5 s timeout in `block-transform-non-round-trip.test.ts`.
  - `npm run check:coverage-modules` exit 0 (10 modules at 0%, baseline 11; `prerender-overlay.ts` now has coverage and can be pruned from `BASELINE_ZERO`).
  - Reporting only: `npm run check:bundle-size` exit 1 (`media/dist/main.js` 990 KB against a 608 KB budget, inherited); `npm run check:startup-cost` exit 1 (378 eager modules against 294, inherited). `media/dist/main.js` is 1,014,169 B (990.4 KiB), +4,069 B against the Task 638 close (1,010,100 B); eager modules 378 (Task 638 close: 377). The growth belongs to every task merged since that close, not to one task.

- **Commits:** `2c2f23a4` (filed), `d96c6040` (Part 1 design handoff), `0f2f6176` (Owner answer on width sync), `3466d6cf` (host: remember the open state), `19ad75da` (clamp the shown width to the window), `2eab8975` (reopen the Outline as it was left), `70a1339d` (real-VS-Code spec), `57b7a957` (Owner ruling on the Undo scope).
- **Acceptance:** all items ticked except the Owner-narrowed item (No document text, dirty state, caret, selection or scroll change): text, dirty flag, caret position, scroll and Undo result are unchanged; a click on Vditor's toolbar Outline button with the caret in the editor adds one Undo step holding only DOM decoration, which also happens without this task's hook. Owner ruling (2026-10-17, chat): removing that Undo step is a separate task.
- **Follow-up task the Owner asked for:** make the Outline toggle leave no decoration-only Undo step.
- **Tests:** Vitest (host, resolution table, hook, router, width clamp), Chromium `outline.spec.ts` (24 passed), real VS Code `outline-state.spec.ts` (2 passed, `--workers=1 --retries=0`).
- **Owner rulings recorded:** `vmde.outlineWidth` stays in Settings Sync; only `vmde.outlineOpen` is profile-local (2026-10-17); the Undo-scope narrowing above.
- **Residual risks:** a drag stores `offsetWidth`, which includes a 1 px border, so the stored width may drift by 1 px; content reflow when the panel appears after the instant-paint overlay (as with `defaultOpen`); a folder-level override of `vmde.outline.defaultOpen` clears the one global open value for all folders; if no open editor is affected by a `defaultOpen` change, nothing clears the key; one full real-VS-Code run failed once at the first launch of the restart case (webview did not appear within 30 s) and passed alone and in the next run. Quality umbrella not run, audit omitted by Owner instruction.
