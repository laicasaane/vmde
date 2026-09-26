# Task 580 — Rectify VMDE shortcuts to VS Code identity and full remappability

> **For agentic workers:** Use `superpowers:writing-plans` for the Checkpoint 1 inventory, then `superpowers:executing-plans`. Checkboxes track implementation and acceptance.

**Status:** planned (2026-09-27).
**Goal:**

- Every user-facing VMDE shortcut is a contributed VS Code command that users can rebind in Keyboard Shortcuts.
- A function that has a VS Code equivalent ships with VS Code's default key for that function on each platform.
- VMDE invents no other default keys, except Bold (Ctrl/Cmd+B) and Italic (Ctrl/Cmd+I).
- Toolbar tooltips show action names only.

This is an intentional breaking change.

**Tech stack:** TypeScript (extension host and webview), VS Code commands/keybindings/context keys, Vitest, Chromium Playwright and real VS Code with OS-level keyboard input.
**Spec:** The owner decisions, policy and acceptance criteria in this file are the specification.
**Dependencies:**

- **Task 579** (Find/Replace with VS Code's keys) runs first. This task covers every other shortcut and must keep Task 579's result.
- **Task 505** (promoted formatting hotkeys, one owner per key) and **Task 463** (undo/redo routing) are the designs this task replaces or must preserve behaviorally. Read their records.
- Independent of Task 578; run it serially.

## Owner decisions (2026-09-27)

- **Principle:** "use the same VSCode shortcut for each functionality. I don't want to reinvent the shortcut for vmde." And: "We use the same shortcut identity and leave actual key combination to user."
- **Breaking change:** "this would be a breaking change, but it's fine since vmde does not promise backwards compatibility with vmarkd."
- **VMDE-only functions** (no VS Code equivalent): ship unbound. The only exceptions are Bold (Ctrl/Cmd+B) and Italic (Ctrl/Cmd+I), kept as the near-universal Markdown-editor convention.
- **Tooltips:** show the action name only, with no key. An extension cannot read a user's remapped keys, so a shown key could be wrong.
- **Task 579:** stays separate and runs first.

## Policy

1. **Everything user-facing is rebindable.** Every shortcut that triggers a user-facing action becomes a VMDE command with a `contributes.keybindings` entry (or none, if unbound), scoped by `when` clauses. It is dispatched to the webview by message, not by a hard-coded webview `keydown` match.
2. **Allowed fixed keys.** Only keys local to a VMDE widget or popover, which VS Code also treats as fixed input keys, may stay hard-coded in the webview: Enter, Shift+Enter, Escape and Tab inside VMDE's own inputs, popovers and menus. The same applies to text triggers that are not shortcuts, such as the `;;` snippet. Checkpoint 1 records each exception and why.
3. **VS Code identity.** A function with a VS Code equivalent ships with that equivalent's default key per platform, exactly as the pinned VS Code build defines it. Record the VS Code command it mirrors.
4. **No invented defaults.** VMDE-only functions ship unbound (Command Palette, toolbar, user keys), except Bold and Italic.
5. **Collisions.** Where a kept default collides with a VS Code default for a different function under overlapping `when` clauses, the VS Code function wins. The VMDE command stays available and rebindable.
6. **Tooltips** show names only. `README.md` documents the default keys and how to rebind them.
7. **Browser-native editing commands** (Chromium's contenteditable Ctrl/Cmd+B, +I, +U execCommand) must stay blocked on every VMDE editing surface, whatever the user binds. A remapped or unbound key must never corrupt the DOM (see Task 505's `format-hotkey-guard.ts` finding). Selection capture before a formatting command must follow the command's message, not a default-key match.

## Starting inventory

To be completed and verified in Checkpoint 1. VS Code defaults are from its documentation, not yet verified against the pinned build.

| Function (current VMDE key) | How it is wired today | Target under the policy |
| --- | --- | --- |
| Bold Ctrl+B, Italic Ctrl+I | contributed (`FORMAT_HOTKEYS`) | keep Ctrl/Cmd+B, Ctrl/Cmd+I |
| Strike Ctrl+D, Headings Ctrl+H, List Ctrl+L, Ordered list Ctrl+Shift+7, Checklist Ctrl+Shift+9, Quote Ctrl+;, Code block Ctrl+U, Inline code Ctrl+G | contributed | unbound. Ctrl+H becomes Replace in Task 579. |
| Outdent/Indent Ctrl+[ / Ctrl+] | contributed | VS Code Outdent/Indent Line (`editor.action.outdentLines`/`indentLines`): keep if verified identical |
| Rewrap Alt+Q, Paste plain Ctrl+Shift+V, Open link Ctrl+Enter, Open in text editor Ctrl+Alt+E | contributed | unbound. VS Code has no default for Rewrap or Reopen With; Ctrl+Shift+V (Markdown preview) and Ctrl+Enter (insert line below) are other VS Code functions. |
| Toggle section fold Ctrl+Alt+[ (Cmd+Alt+[) | contributed and also matched in the webview (`section-fold.ts`) | mirror VS Code folding: Fold, Unfold, Toggle Fold (and Fold All/Unfold All if VMDE supports them) with VS Code's keys |
| Find Ctrl+F | contributed | handled by Task 579 |
| Undo/Redo Ctrl+Z, Ctrl+Y, Ctrl+Shift+Z | webview (`undo-keybind.ts`, Task 463) | mirror VS Code Undo/Redo keys through rebindable commands, keeping Task 463's measured behavior (feedback-path risk) |
| Heading level up/down Ctrl+Shift+[ / ], and +Alt for a section | webview (`rewrap-command.ts`) | VMDE-only: unbound command. This frees VS Code's fold keys. |
| Table Ctrl+Shift+L/C/R (align), Ctrl+Shift+F, Ctrl+= and Ctrl+- | webview (`table-hotkey.ts`) | VMDE-only: unbound commands |
| Move block Alt+Up/Down | webview (`block-handle.ts`) | VS Code Move Line Up/Down: keep the key as a contributed command |
| Structural select Ctrl+A and Escape stepping out | webview (`selection-scope.ts`) | select all mirrors VS Code (`editor.action.selectAll`); Part 1 decides whether structural expansion mirrors Expand/Shrink Selection (Shift+Alt+Right/Left) |
| Copy/cut line with no selection Ctrl+C/X | webview (`clipboard-line.ts`) | VS Code copy/cut: same key; Part 1 decides the command form |
| Callout popover focus Ctrl/Cmd+Alt+Enter | webview (Task 459) | VMDE-only: unbound command |
| Save flush on Ctrl/Cmd+S | webview keydown (`save-flush.ts`) | not a shortcut. Part 1 decides whether flushing on the host's will-save (any save key, auto-save) replaces the keydown watch, keeping the Task 196 exact-ownership guard. |
| Link popover and Find widget Enter/Escape; `;;` snippet | webview, widget-local | allowed fixed keys (policy 2) |

## Checkpoint 1 — Inventory, VS Code defaults and red expectations

- [ ] Complete the inventory by search. Cover every `keydown`/`keyup` handler that matches modifier chords in `media-src/src`, every `contributes.keybindings` entry, `FORMAT_HOTKEYS`/`UNBOUND_FORMAT_COMMANDS`, Vditor hotkeys still active after `chrome/toolbar.ts`, and any host-side key handling.
- [ ] Read the pinned VS Code build's actual default keybindings (for example its default keybindings JSON) for every VS Code-equivalent row. Record the mirrored command, Windows/Linux key, macOS key and `when` context.
- [ ] Record the final target table: command ID, title, default key per platform or "unbound", `when` clause, and allowed fixed-key exceptions with reasons.
- [ ] Write red unit expectations for the manifest: bindings, `when` clauses, unbound commands present, and no VMDE binding on a key that VS Code uses for a different function under an overlapping `when`.

## Checkpoint 2 — Move webview-matched shortcuts to commands

- [ ] For each webview-matched user-facing shortcut:
  - register a command in `src/app/commands.ts`;
  - route it through a validated host→webview message (`src/shared/protocol.ts`, `bridge/message-router.ts`);
  - remove the webview chord matching.
  Keep the actions' behavior identical, including caret, selection, focus, undo boundaries, exact source and composition guards.
- [ ] Undo/redo: redesign under the policy while keeping Task 463's measured behavior in all three edit modes. That includes Ctrl/Cmd+Shift+Z, VS Code's native undo never also firing, and the key working with focus outside the editable element. Use the §2a feedback path if the measurements disagree.
- [ ] Browser-native editing command guard (policy 7): block Chromium's contenteditable B/I/U commands independently of bindings, and drive selection capture from the command message.
- [ ] Unit tests per converted action (handler to webview effect) and for the guard.

## Checkpoint 3 — Apply defaults, tooltips and docs

- [ ] Restructure `src/shared/format-hotkeys.ts` (or its successor) so the manifest, command registration and tests share one table. Update `package.json` to the Checkpoint 1 target table and `test/backend/format-hotkeys.test.ts` and `manifest.test.ts`.
- [ ] Tooltips (`chrome/toolbar.ts`, `formatTip`) show names only. Update the tooltip, accessibility-label and toolbar-order tests.
- [ ] `README.md`:
  - the shortcut table with each default key, marked as mirroring VS Code or as a convention (Bold, Italic);
  - the unbound commands;
  - how to rebind in Keyboard Shortcuts;
  - that VMDE cannot follow a user's remap of VS Code's own commands.
- [ ] Record a **BREAKING** note for the release changelog pass: the removed and changed default keys, with the rebinding instructions.

## Checkpoint 4 — Acceptance and closure

- [ ] Real VS Code (OS-level XTEST, large synthetic fixture copied into `baseDir`):
  - every shipped default key performs its action in IR, WYSIWYG and SV where applicable;
  - an unbound former key (for example Ctrl+D, Ctrl+U, Ctrl+G) now does VS Code's own function, or nothing, and never a VMDE action;
  - Ctrl/Cmd+B/I/U never produce native contenteditable formatting;
  - a user keybinding written to the test profile rebinds one representative command per mechanism (formatting, table, fold, undo), and the old key no longer triggers it;
  - exact source, host and disk bytes and native Undo/Redo stay intact.
- [ ] Rerun the focused specs that exercise changed shortcuts, found by search, with `--retries=0`. At minimum: `format-hotkeys.spec.ts`, `toolbar-order.spec.ts`, block-handle, table, callout, section-fold, undo and the Find specs. Run them in Chromium and in real VS Code where they exist.
- [ ] Changed-line coverage, typechecks and the network-free quality stages once on the final candidate. Bundle and startup numbers are reporting-only.
- [ ] Record the evidence here, move this record to `tasks/done/` and add the `tasks/README.md` entry only when every item is complete. One focused local commit per checkpoint; do not push.

## Execution progress

Not started. Owner decisions recorded 2026-09-27.
