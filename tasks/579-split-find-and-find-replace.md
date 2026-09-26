# Task 579 — Split Find from Replace using VS Code's own shortcuts

> **For agentic workers:** Use `superpowers:executing-plans`. Checkboxes track implementation and acceptance.

**Status:** planned (2026-09-27; owner decisions recorded 2026-09-27).
**Goal:** VMDE's Find and Replace follow VS Code's own editor Find shortcuts, one-to-one. Find opens a Find-only widget. Replace opens the widget with the Replace row. Each in-widget action uses the same shortcut as the matching action in VS Code's editor find widget. VMDE invents no Find shortcut of its own. Every binding is an ordinary VMDE command that users can rebind in Keyboard Shortcuts.
**Tech stack:** TypeScript (extension host and webview), VS Code keybindings/commands/context keys, Vitest, Chromium Playwright and real VS Code with OS-level keyboard input.
**Spec:** The owner decisions, behavior contract and acceptance criteria in this file are the specification.
**Dependencies:** [Task 196](done/196-find-and-replace.md) (the widget and exact transaction) and [Task 568](done/568-find-replace-match-highlighting.md) (highlighting) are complete. Preserve their contracts. Independent of [Task 578](578-ir-click-source-index-rebuild.md), but both touch Find specs, so run them serially.

## Request and owner decisions (2026-09-27)

- **Request:** "split between Find and Find&Replace."
- **Refinement:** "I want this task to use the same VSCode shortcut for each functionality. I don't want to reinvent the shortcut for vmde." The original Ctrl+Shift+F proposal is withdrawn: Ctrl/Cmd+Shift+F stays VS Code's Find in Files.
- **Conflicts:** "User can configure custom shortcut key combination so it's not a concern. We use the same shortcut identity and leave actual key combination to user." The same applies to the Cmd+G conflict.

**What this means in practice.** An extension cannot register VS Code's built-in Find command IDs (`actions.find`, `editor.action.startFindReplaceAction` and so on). It also cannot read a user's custom key for them. "Same shortcut identity" is therefore implemented as follows:

- **Keys:** each VMDE Find command's default binding uses the same key, on each platform, as VS Code's default for the same function.
- **Titles:** command titles mirror VS Code's command names.
- **Customization:** users who remap VS Code's Find keys can remap VMDE's commands the same way.

Record this limitation in the README shortcut docs.

**Collision rule.** Where a VS Code Find default collides with an existing VMDE default on the same platform and the `when` clauses overlap, the VS Code Find function gets the key.

- The VMDE command keeps working from the toolbar and Command Palette, and stays user-bindable.
- A Find action that VS Code only offers while its find widget is involved (for example Find Next) is scoped with a `when` context key to VMDE's Find widget being open. That way the colliding VMDE command keeps its key the rest of the time.

## VS Code defaults to mirror

Verify every row against the pinned VS Code build in Checkpoint 1; these values come from VS Code's documented defaults, not from a probe.

| Function | VS Code command | Windows/Linux | macOS |
| --- | --- | --- | --- |
| Find | `actions.find` | Ctrl+F | Cmd+F |
| Replace | `editor.action.startFindReplaceAction` | Ctrl+H | Alt+Cmd+F |
| Find Next / Previous | `editor.action.nextMatchFindAction` / `previousMatchFindAction` | F3 / Shift+F3 (Enter / Shift+Enter in the widget) | Cmd+G / Shift+Cmd+G (also Enter / Shift+Enter) |
| Toggle Match Case | `toggleFindCaseSensitive` | Alt+C | Alt+Cmd+C |
| Toggle Match Whole Word | `toggleFindWholeWord` | Alt+W | Alt+Cmd+W |
| Replace one | `editor.action.replaceOne` | Ctrl+Shift+1 (Enter in the replace input) | Shift+Cmd+1 |
| Replace All | `editor.action.replaceAll` | Ctrl+Alt+Enter | Alt+Cmd+Enter |
| Close | `closeFindWidget` | Escape | Escape |
| Toggle Replace row | the find widget's toggle button | (button) | (button) |

Regex (Alt+R) and "Find in Selection" are not VMDE Find features (Task 196 scope) and are not added.

**Known collisions** (resolved by the collision rule; verify exhaustively in Checkpoint 1 against `package.json` and `src/shared/format-hotkeys.ts`):

- **Ctrl+H** (Windows/Linux) is `vmde.format.headings` today (Task 505) and becomes Replace. Headings keeps Cmd+H on macOS, where Replace is Alt+Cmd+F, unless the check finds another collision.
- **Cmd+G** (macOS) is `vmde.format.inlineCode`. It becomes Find Next only while VMDE's Find widget is open, and stays Inline Code otherwise.

## Current state

- `package.json`: `ctrl+f` / `cmd+f` → `vmde.findReplace` (title "Find and Replace"). `ctrl+h` / `cmd+h` → `vmde.format.headings`. Both apply `when: activeCustomEditorId == vmde.editor`.
- `src/app/commands.ts` posts `{ command: 'open-find-replace' }`; the webview routes it through `bridge/message-router.ts` to `openFindReplace()` in `editing/selection-scope.ts`.
- The widget always shows both rows. In-widget keys are handled by its own `keydown` handler: only Enter, Shift+Enter and Escape.
- Tests and docs naming these bindings:
  - `test/backend/manifest.test.ts` (asserts `ctrl+f` → `vmde.findReplace`);
  - `test/backend/commands-and-handlers.test.ts`;
  - `README.md` (keyboard table);
  - the Task 505 Headings tests (search for `ctrl+h` / `Control+h`, including `test/vscode-e2e/find-replace.spec.ts`, which asserts Ctrl+H opens Headings);
  - the Chromium and real-VS-Code Find specs.

## Behavior contract

- **Find** (VS Code's Find key):
  - It opens a Find-only widget, or switches an open widget to Find only, and focuses the find input with its text selected.
  - The Replace input and its buttons are absent from layout and from the accessibility tree.
  - No replace action can run in this mode: not from a stale button, a message or a key.
- **Replace** (VS Code's Replace key):
  - It opens the widget with the Replace row, or expands an open one.
  - Focus follows VS Code's editor widget behavior, verified against the pinned build in Checkpoint 1.
- The query, options and current match survive a mode switch.
- A "Toggle Replace" button (`aria-expanded`, accessible name) matches VS Code's widget chevron.
- The in-widget keys from the table act only while VMDE's Find widget is open. Each is a contributed, rebindable VMDE command, gated by a context key the webview reports to the host, for example `vmde.findWidgetVisible` set with `setContext`.
- Everything else is unchanged from Task 196 and Task 568: exact-source search and transaction, one-step exact Undo/Redo, match-only live-setting highlights, viewport-bounded paint, honest counts, Escape returns focus, and Preview stays read-only.
- Ctrl/Cmd+Shift+F keeps VS Code's Find in Files; VMDE contributes no binding on it.
- **Command IDs:**
  - `vmde.findReplace` keeps its ID (existing user bindings keep opening Replace) and is retitled to mirror VS Code ("Replace").
  - A new `vmde.find` ("Find") is added, plus commands for the in-widget actions.
  - The final ID list is fixed in Checkpoint 1 and recorded here.
- The host↔webview protocol stays validated: a typed mode on the open message and a visibility report back. Update `protocol.ts`, `message-router.ts` validation and the protocol-shape tests.
- No new setting or dependency, no generated-output edit, no Worker. The widget stays outside Vditor's editable DOM.

## Test fixture scope

Owner rule from Task 196 (2026-09-26): every Chromium and real-VS-Code Find & Replace test uses only `test/vscode-e2e/fixtures/large-observable-models-synthetic.md` (copy it into the test's `baseDir`; never print its contents; derive counts from its exact bytes). Pure logic stays in Vitest.

## Checkpoint 1 — Commands, keybindings, context key and widget modes

- [ ] In the pinned VS Code test build, read the actual default keybindings for every function in the table, for example from the default keybindings JSON. Record them and correct the table if they differ.
- [ ] Record the full collision list against VMDE's contributed keybindings and `FORMAT_HOTKEYS`, and the resolution of each under the collision rule.
- [ ] Implement:
  - the `package.json` commands and keybindings, with per-platform keys and `when` clauses;
  - the `src/app/commands.ts` handlers;
  - the protocol message shapes and `message-router.ts` routing and validation;
  - the webview→host widget-visibility report and `setContext`;
  - the widget mode, toggle button and focus rules in `selection-scope.ts`.
- [ ] Unit tests:
  - the manifest keys per platform, `when` clauses, and no Ctrl/Cmd+Shift+F binding;
  - the resolved collisions: Headings has no Ctrl+H default; Cmd+G Find Next is gated on the context key;
  - the command handlers and message validation;
  - the widget: Find only has no Replace controls in the accessibility tree and ignores replace attempts; the mode switch keeps the query, options and current match; focus; the toggle's `aria-expanded`; Escape.
- [ ] Update the Task 505 Headings tests and docs that assert Ctrl+H opens Headings, in line with the owner decision.

## Checkpoint 2 — Browser and real-VS-Code acceptance, docs and closure

- [ ] Chromium (large fixture): Find-only and Replace modes in IR, WYSIWYG and SV; the mode switch both ways; the toggle; all existing `find-replace.spec.ts` and `find-replace-large.spec.ts` cases pass.
- [ ] Real VS Code (OS-level XTEST, large fixture, Linux keys):
  - Ctrl+F opens Find only (no Replace row).
  - Ctrl+H opens Replace; Replace All then gives exact host bytes, one Undo restores the exact baseline, and save/reopen keeps them.
  - Ctrl+F while Replace is open switches to Find only, and Ctrl+H switches back.
  - F3/Shift+F3, Alt+C and Alt+W act on the widget.
  - Ctrl+Shift+1 replaces one match and Ctrl+Alt+Enter replaces all.
  - Escape closes the widget.
  - Ctrl+Shift+F opens VS Code's Find in Files.
  - With Find closed, Inline Code and the other formatting keys still work.
- [ ] Update `README.md`'s keyboard table and shortcut docs: Find and Replace mirror VS Code's keys; the Headings shortcut changed; how to rebind; the limitation above.
- [ ] Changed-line coverage, typechecks and the network-free quality stages once on the final candidate. Bundle and startup numbers are reporting-only.
- [ ] Record the evidence here, move this record to `tasks/done/` and add the `tasks/README.md` entry only when every item is complete. One focused local commit per checkpoint; do not push.

## Execution progress

Not started. Owner decisions recorded 2026-09-27; no decision points remain open.
