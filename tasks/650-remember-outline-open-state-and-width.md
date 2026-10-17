# Task 650 — Remember whether the Outline panel is open, and its width, across files and sessions

**Status:** open.
**Origin:** Project Owner feature request.
**Severity:** feature (low risk; one persisted preference and a check of an existing one).
**Tech stack:** extension host (`src/session/editor-session.ts`, `src/platform/state-keys.ts`, `src/shared/protocol.ts`, `src/webview-host/webview-message-shape.ts`, `src/webview-host/html-builder.ts`), webview (`media-src/src/nav/outline.ts`, `nav/outline-resize.ts`, `boot/live-config.ts`, `boot/vditor-init.ts`), Vitest, Chromium, real VS Code.
**Builds on:** [Task 08](done/08-outline-width-show-by-default.md) (outline width and open-by-default), [Task 631](done/631-toolbar-collapse-toggle.md) (a user-level toggle state in `globalState`, carried in `init` and the first-paint payload, broadcast to other open editors).

## Current behaviour (from source)

- **Open state is not remembered.** The in-editor Outline panel opens according to the setting `vmde.outline.defaultOpen` (default off) every time an editor opens. Toggling it by hand lasts only for that editor.
- **Width is already stored.** Resizing the panel posts `save-outline-width`, which writes the width to `globalState` under `vmde.outlineWidth` (`editor-session.ts`). The next editor receives it as `outlineWidth` in `init` and applies it as `--me-outline-width` (`live-config.ts`). Editors that are already open do not follow a resize made in another editor, and whether the width survives every path (restart, first paint, Preview, Split) is not covered by a real-VS-Code test.

## Requirements

1. **Remember the open state.** Opening or closing the Outline panel (toolbar button, command or keyboard) stores the state as one user-level value, shared by every file and kept across VS Code sessions. Every editor opened afterwards opens with the panel in that state.
2. **Remember the width.** The width the user last set (drag or keyboard resize) applies to every editor opened afterwards, across files and VS Code sessions, in every mode, from the first paint.
3. **Open editors.** Part 1 decides whether other open editors follow a toggle or a resize at once (as the toolbar collapse state does) or keep their state until reopened (as the Preview toggle in Task 642 does); the same rule applies to both values.
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

- [ ] Opening or closing the panel in one file, then opening another file, shows the panel in the same state; the same after a VS Code restart.
- [ ] Resizing the panel, then opening another file and restarting VS Code, shows the panel at the resized width from the first paint, in IR, WYSIWYG, Split and Preview.
- [ ] Other open editors behave according to the Part 1 rule for both values.
- [ ] `vmde.outline.defaultOpen` behaves according to the Part 1 rule.
- [ ] A stored width wider than the current window is clamped for display without changing the stored value.
- [ ] No document text, dirty state, Undo history, caret, selection or scroll change.
- [ ] Focused Vitest, Chromium and real-VS-Code specs are written and run (restart case with the own-launch pattern from Task 631); network-free gates pass at closure.

## Tests

- Vitest: state key read and write, message shapes, the `defaultOpen` rule, width clamping.
- Chromium: toggle and resize post the right messages; init values applied at first paint; clamping.
- Real VS Code (`test/vscode-e2e/`): two files and a restart for both values, other open editors, each mode.
