# Task 651 — Remember the Preview toggle state across files and sessions

**Status:** open.
**Origin:** Project Owner feature request (split out of [Task 642](642-toolbar-layout-follow-ups.md) requirement 12).
**Severity:** feature (low to medium risk; one persisted preference and the open-mode rule).
**Tech stack:** extension host (`src/platform/default-mode.ts`, `src/platform/state-keys.ts`, `src/session/editor-session.ts`, `src/shared/protocol.ts`, `src/webview-host/webview-message-shape.ts`, `src/webview-host/html-builder.ts`), webview (`media-src/src/chrome/open-preview.ts`, `boot/vditor-init.ts`, `boot/finish-init.ts`), Vitest, Chromium, real VS Code.
**Builds on:** [Task 282](done/282-default-open-mode.md) (`vmde.editor.defaultMode: "preview"` and `chrome/open-preview.ts`), [Task 631](done/631-toolbar-collapse-toggle.md) (a user-level state in `globalState`, carried in `init` and the first-paint payload).
**Related:** [Task 642](642-toolbar-layout-follow-ups.md) (Preview toggle placement and icon), [Task 643](643-preview-mode-streaming-performance.md) (Preview streaming for large documents), [Task 650](650-remember-outline-open-state-and-width.md) (Outline state; same storage pattern).

## Current behaviour (from source)

Preview is Vditor's overlay, switched by the toolbar's Preview button. VMDE opens a document in Preview only when the host resolves the open mode to `preview` (`platform/default-mode.ts`: the first matching `vmde.editor.defaultModeByGlob` rule, else `vmde.editor.defaultMode`); the webview then clicks the button (`chrome/open-preview.ts`). Documents over 700,000 characters stream into an edit mode and never open in Preview. Turning Preview on or off by hand is not stored: the next document opens in its resolved or remembered edit mode.

## Requirements

1. **Preview is the fourth mode, with its own toggle.** Preview sits beside the three edit modes (WYSIWYG, Instant Rendering, Split) but is switched by the Preview toggle, not by the Edit Mode menu. Whether Preview is on is kept across VS Code sessions and is shared by every file.
2. **Preview on.** Every document opened after Preview is turned on opens in Preview, unless a path rule (`vmde.editor.defaultModeByGlob`) or an explicit `vmde.editor.defaultMode` value (`ir`, `wysiwyg`, `sv` or `preview`) chooses its mode. Path rules and the setting keep supporting `preview`.
3. **Preview off.** The editor returns to the stored edit mode (WYSIWYG, Instant Rendering or Split), and documents opened after that open in that edit mode.
4. **Only the toggled editor changes.** Other open editors keep their state until they are reopened.
5. **Large documents.** They open in Preview too. Until [Task 643](643-preview-mode-streaming-performance.md) streams them into Preview, a document over the streaming threshold (700,000 characters) opens in Preview after it has finished streaming into its edit mode.
6. **No document effect.** Toggling or opening in Preview changes no document text, dirty state, Undo history, caret or selection.
7. **Storage.** The state is a profile-local `globalState` value, not synced across machines, like the toolbar collapse state.

## Open design points (settled in Part 1)

- How the stored edit mode (`vmde.options` `mode`, synced) and the new Preview value combine at open, and which one `defaultMode: "remember"` reads.
- Where the rule lives: host-side in `resolveDefaultMode` (which knows the path rules) or in the webview; how the streaming exception reaches it.
- How Preview combines with Split, which has its own preview pane (Preview over Split today opens the overlay over the Split layout).
- Which toggles store the value: the toolbar button, the `vmde.switchTo*` commands, the status-bar mode control, and opening in Preview because of a path rule or the setting (proposed: only user toggles store; rule-driven opens do not).

## Scope

- In: the stored Preview state, the open rule, the streaming interim behaviour, `init` and first-paint delivery.
- Out: the toolbar placement and icon of the Preview control (Task 642), Preview rendering and streaming (Task 643).

## Acceptance

- [ ] With Preview on, documents opened afterwards open in Preview, also after a VS Code restart.
- [ ] With Preview off, documents open in the stored edit mode, and the toggled editor returns to that mode.
- [ ] A path rule or an explicit `vmde.editor.defaultMode` value decides the mode whatever the toggle state; `preview` rules still open in Preview.
- [ ] Other open editors are unchanged by a toggle.
- [ ] A document over the streaming threshold ends in Preview after streaming when Preview is on.
- [ ] No document text, dirty state, Undo history, caret or selection change.
- [ ] Focused Vitest, Chromium and real-VS-Code specs are written and run (restart case with the own-launch pattern from Task 631); network-free gates pass at closure.

## Tests

- Vitest: the open rule (toggle state × setting × path rule × streaming), state key read and write, message shapes.
- Chromium: a user toggle posts the state; `init` with Preview on opens in Preview at first paint; rule-driven opens post nothing.
- Real VS Code (`test/vscode-e2e/`): toggle then open a second file; restart; a path rule overriding the toggle; a large streamed document.
