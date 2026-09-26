# Task 579 — Split Find (Ctrl+F) from Find and Replace (Ctrl+Shift+F)

> **For agentic workers:** Use `superpowers:executing-plans`. Checkboxes track implementation and acceptance. Resolve the decision points below with the Project Owner before Checkpoint 1; the recommended defaults apply only if the owner accepts them.

**Status:** planned (2026-09-27).
**Goal:** Ctrl/Cmd+F opens Find only: the find row, match navigation, case and whole-word toggles and highlights, with no Replace controls. Ctrl/Cmd+Shift+F opens Find and Replace: today's widget with both rows. Both work in IR, WYSIWYG and SV, and both keep every Task 196 and Task 568 behavior contract.
**Tech stack:** TypeScript (extension host and webview), VS Code keybindings/commands, Vitest, Chromium Playwright and real VS Code with OS-level keyboard input.
**Spec:** The request, behavior contract and acceptance criteria in this file are the specification.
**Dependencies:** [Task 196](done/196-find-and-replace.md) (the reworked widget and exact transaction) and [Task 568](done/568-find-replace-match-highlighting.md) (highlighting) are complete. Preserve their contracts. Independent of [Task 578](578-ir-click-source-index-rebuild.md); if both run, run them serially, since both touch Find specs.

## Request

The Project Owner (2026-09-27): "split between Find and Find&Replace. Ctrl+F to Find only, Ctrl+Shift+F to find and replace."

## Current state

- `package.json` binds `ctrl+f` / `cmd+f` to `vmde.findReplace` when `activeCustomEditorId == vmde.editor`. `ctrl+h` / `cmd+h` stays `vmde.format.headings` (Task 505).
- `src/app/commands.ts` registers `vmde.findReplace`, which posts `{ command: 'open-find-replace' }` (`src/shared/protocol.ts`). The webview routes it through `bridge/message-router.ts` to `openFindReplace()` in `editing/selection-scope.ts`.
- The widget (`createFindReplaceElements`) always renders both rows. Replace and Replace All are always available.
- Tests and docs that name the binding:
  - `test/backend/manifest.test.ts` (asserts `ctrl+f` → `vmde.findReplace` and the `onCommand` activation event);
  - `test/backend/commands-and-handlers.test.ts`;
  - `README.md` (keyboard table, "Find in document");
  - `media-src/e2e/find-replace.spec.ts`, `media-src/e2e/find-replace-large.spec.ts`;
  - `test/vscode-e2e/find-replace.spec.ts`, `test/vscode-e2e/find-replace-large.spec.ts`.
- VS Code's default Ctrl/Cmd+Shift+F is **Find in Files** (the Search view). A VMDE binding shadows it wherever its `when` clause is true.

## Decision points (Project Owner) and recommended defaults

1. **Scope of Ctrl/Cmd+Shift+F.** Recommended: the binding applies only while a VMDE editor's webview has keyboard focus, so Find in Files keeps working from the Explorer, the Search view, the terminal and text editors. If no context key can express "VMDE webview focused", fall back to `activeCustomEditorId == vmde.editor`, which is what Ctrl+F uses today. That shadows Find in Files whenever a VMDE editor is the active editor, even while focus is elsewhere. Part 1 must test which context keys VS Code exposes for a focused custom-editor webview and report the choice.
2. **macOS keys.** Recommended: Cmd+F for Find and Cmd+Shift+F for Find and Replace, mirroring the request. VS Code's own macOS replace key is Cmd+Alt+F; it is not added unless the owner asks.
3. **Command IDs.** Recommended:
   - add `vmde.find` ("VMDE: Find") on Ctrl/Cmd+F;
   - keep `vmde.findReplace` ("VMDE: Find and Replace") on Ctrl/Cmd+Shift+F, so existing user keybindings to that ID keep opening Replace.
4. **Switching while open.** Recommended, following VS Code's editor widget:
   - Ctrl/Cmd+F while Replace is shown collapses to Find only and focuses the find input.
   - Ctrl/Cmd+Shift+F while Find only is shown expands the Replace row. It focuses the replace input when the find input already has text, otherwise the find input.
   - The query, options and current match are kept across the switch.
5. **In-widget toggle.** Recommended: add an accessible "Toggle Replace" button (`aria-expanded`), so Replace is reachable from Find without the keyboard and discoverable in the UI.

## Behavior contract

- **Find only:**
  - It renders no Replace input and no Replace or Replace All controls. They are removed from layout and from the accessibility tree, not just visually hidden.
  - A replace action cannot run from a stale button, a message or a key.
  - Everything else is unchanged from Task 196: literal search over the exact source, case and whole-word toggles, Enter/Shift+Enter navigation with wrap, match-only highlights and live `vmde.findMatch.*` settings, viewport-bounded paint, Escape closes and returns focus, counts are honest for unmappable matches, and Preview stays read-only.
- **Find and Replace:** today's widget and exact transaction are unchanged: exact-source plan, one `setValue`, exact Undo/Redo history, host-verified bytes, caret/focus/scroll restore.
- Ctrl/Cmd+H stays the Headings shortcut.
- Both commands are available from the Command Palette while a VMDE editor is active.
- The message protocol stays validated. Either `open-find-replace` gains a typed `replace: boolean` field (default `true` for an old sender), or a separate `open-find` message is added. Choose one in Part 1, and update `message-router.ts` validation and `webview-message-shape`/protocol tests.
- No new setting or dependency, no generated-output edit, no Worker. Keep the widget outside Vditor's editable DOM (Lute-invisible).

## Test fixture scope

Owner rule from Task 196 (2026-09-26): every Chromium and real-VS-Code Find & Replace test uses only `test/vscode-e2e/fixtures/large-observable-models-synthetic.md` (copy it into the test's `baseDir`; never print its contents; derive counts from its exact bytes). Pure logic stays in Vitest.

## Checkpoint 1 — Commands, keybindings, protocol and widget modes

- [ ] Implement the owner-approved decisions:
  - `package.json` commands and keybindings, and the activation event if needed;
  - the `src/app/commands.ts` handlers;
  - the `src/shared/protocol.ts` message shape;
  - `message-router.ts` routing and validation;
  - the widget mode in `selection-scope.ts` (Find-only rendering, mode switch, toggle button, focus rules).
- [ ] Unit tests:
  - the manifest bindings and when-clauses;
  - both command handlers post the right message;
  - message validation;
  - the widget: Find only has no Replace controls in the accessibility tree and ignores replace attempts; the mode switch keeps the query, options and current match; focus rules; Escape; the toggle's `aria-expanded`.

## Checkpoint 2 — Browser and real-VS-Code acceptance, docs and closure

- [ ] Chromium (large fixture): Find-only and Find-and-Replace modes in IR, WYSIWYG and SV; the mode switch both ways; the toggle; all existing `find-replace.spec.ts` and `find-replace-large.spec.ts` cases still pass.
- [ ] Real VS Code (OS-level XTEST, large fixture):
  - Ctrl+F opens Find only (no Replace row) and searches.
  - Ctrl+Shift+F opens Find and Replace; Replace All then gives exact host bytes, one Undo restores the exact baseline, and save/reopen keeps the bytes.
  - Ctrl+Shift+F while Find only is open expands to Replace, and Ctrl+F collapses it again.
  - Ctrl+H still opens Headings.
  - With focus outside the VMDE webview (for example the Explorer or a plain text editor), Ctrl+Shift+F still opens VS Code's Find in Files, as allowed by decision 1.
- [ ] Update `README.md`'s keyboard table (Find; Find and Replace) and any other user-facing shortcut docs found by search. The changelog entry waits for the release pass.
- [ ] Changed-line coverage, typechecks and the network-free quality stages once on the final candidate. Bundle and startup numbers are reporting-only.
- [ ] Record the evidence here, move this record to `tasks/done/` and add the `tasks/README.md` entry only when every item is complete. One focused local commit per checkpoint; do not push.

## Execution progress

Not started. Decision points 1–5 await the Project Owner.
