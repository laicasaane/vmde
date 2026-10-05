# Task 593 — Keyboard and clipboard on the web

> **For agentic workers:** Use `superpowers:executing-plans`. Checkboxes track implementation and acceptance.

**Status:** planned (draft, 2026-09-28).
**Goal:**
- On the web, VMDE's contributed shortcuts do what VS Code for the Web does for the same function.
- The browser's own action for those keys does not also run.
- The copy buttons put the right text on the clipboard in every supported browser.
- The web-only limitations are documented.
- Desktop keyboard and clipboard behavior does not change.

**Spec:** This file, [Task 581](581-web-extension-support.md) section 2, and the shortcut policy of [Task 580](done/580-rectify-shortcuts-vscode-identity.md): same shortcut identity as VS Code, and every user-facing shortcut is a rebindable command.
**Dependencies:**
- [Task 579](done/579-split-find-and-find-replace.md) and [Task 580](done/580-rectify-shortcuts-vscode-identity.md) must be closed; this task works on their final keymap.
- [Task 591](591-web-entry-bundle-and-harness.md) (the web harness).
- Task 582 row P6 (clipboard results).

**Repository skills:** `.agents/skills/vmde-testing/SKILL.md`.

## 1. Implementation

### Checkpoint 1 — Web keybindings and browser defaults

- [ ] Inventory the defaults that VS Code for the Web binds differently from desktop, for every function VMDE mirrors in the post-Task-580 table. Use the VS Code source for rules conditioned on `isWeb` in the pinned version. Record each function's web key per platform in section 4.
- [ ] Add `when`-scoped web variants (`isWeb` / `!isWeb`) in `package.json` wherever VS Code's web default differs, so VMDE keeps the same shortcut identity as VS Code on each platform.
- [ ] Extend the webview guard (`media-src/src/editing/format-hotkey-guard.ts`, or its Task 580 successor) to cover every chord VMDE contributes as a default.
  - It only calls `preventDefault()` on web, so the browser's own action does not also run. Examples: `Ctrl+H` (History), `F3` / `Shift+F3`, `Cmd+G` / `Cmd+Shift+G`, `Shift+Esc`.
  - It must not stop VS Code's key forwarding: the Task 505 guard already prevents B/I/U and the commands still arrive.
  - It must not change desktop dispatch, Task 463 undo routing, or the native formatting guard.
- [ ] Check the post-Task-580 defaults against the chords browsers reserve, which a page can never receive (for example, Chrome on macOS takes `Cmd+Shift+[` and `Cmd+Shift+]` for tab switching). For each remaining collision, use VS Code for the Web's own mapping for that function; if there is none, leave it unbound on web. Record every case in section 4.
- [ ] Document in `README.md` that, in VS Code for the Web, user keybindings that include `Ctrl/Cmd+C`, `V` or `X` do not reach VS Code from the editor. VS Code's webview host hands those keys to the browser.

### Checkpoint 2 — Clipboard

- [ ] Write the copy-button text from the webview click handler: Copy code, HTML, Markdown and link (`media-src/src/clipboard/code-copy.ts:18-27`).
  - Use `navigator.clipboard.writeText` inside the user gesture.
  - Fall back to `document.execCommand('copy')` with a `copy` listener that sets `clipboardData`.
  - Use the host path (`src/session/editor-session.ts` around lines 427–441, `vscode.env.clipboard.writeText`) only when both fail.
  - The written text and flavors are unchanged.
- [ ] Make `vmde.pastePlain` (`src/app/commands.ts` around lines 316–330) show an information message when `vscode.env.clipboard.readText()` returns an empty string because the browser denied access. Today it silently does nothing.

## 2. Scope

- **In scope:** the items above.
- **Out of scope:** the shortcut identity policy itself (Task 580) and Find/Replace keys (Task 579).
- **Preservation:** desktop keyboard dispatch, IME composition guards, native Undo/Redo, clipboard content and the cut/paste patches.

## 3. Verification

- Unit tests:
  - guard coverage against the contributed-keybindings table;
  - the web variants in the manifest;
  - clipboard fallback ordering.
- Web (`test:web`, Chromium): with focus in the editor, pressing `Ctrl+H` opens VMDE Replace and reports `defaultPrevented` in the webview frame. Each copy button puts the expected text on the clipboard; grant clipboard permissions in Playwright.
- Real VS Code (OS-level XTEST keyboard input to the focused window): run `node build.mjs` first. Then run the focused format-hotkey, Find and copy-button specs with `--retries=0`.
- Firefox and Safari checks follow program decision D1 and are recorded in Task 595.
- Changed-line coverage and the network-free quality stages run once on the final candidate.

## 4. Web keybinding inventory

Filled in Checkpoint 1.

## Execution progress

Not started.
