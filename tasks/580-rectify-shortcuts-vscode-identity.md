# Task 580 — Rectify VMDE shortcuts to VS Code identity and full remappability

> **For agentic workers:** Use `superpowers:writing-plans` for the Checkpoint 1 inventory, then `superpowers:executing-plans`. Checkboxes track implementation and acceptance.

**Status:** In progress — Checkpoint 1 complete; Checkpoint 2 next (2026-10-04).
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

## Checkpoint 1 inventory

Verified on 2026-10-04 against HEAD `8c2ec1f0` by the handoff §1.1 searches (`grep -rn`). Webview paths are relative to `media-src/src/`. Vditor paths are relative to `media-src/node_modules/vditor/src/ts/`. Classes: **A** user-facing shortcut, **B** browser-native guard, **C** key-identity coupling, **D** fixed widget-local key, **E** editing key or key observer, **F** mouse gesture, **G** label that shows a key, **H** test only.

### Inventory

| # | Key (Win/Linux; macOS) | Where (file:line) | Class | Target |
| --- | --- | --- | --- | --- |
| W1 | Undo Ctrl+Z; Redo Ctrl+Y, Ctrl+Shift+Z (Cmd forms, including Cmd+Y) | `editing/undo-keybind.ts:82-95, 116-134` (window capture, `stopImmediatePropagation`) | A | `vmde.format.undo`/`redo`, VS Code keys |
| W2 | Rewrap Alt+Q | `editing/rewrap-command.ts:792-815` (window capture, `stopPropagation`); `package.json:1173` | A | `vmde.rewrap`, unbound |
| W3 | Heading level Ctrl/Cmd+Shift+[ / ] (+Alt for the section) | `editing/rewrap-command.ts:686-698, 776-790` (window capture, no context check) | A | heading commands, unbound |
| W4 | Section/list fold Ctrl+Alt+[; Cmd+Alt+[ | `nav/section-fold.ts:941-953, 1068-1077`; `package.json:1209` | A | `vmde.fold`/`unfold`/`toggleSectionFold`, VS Code keys |
| W5 | Move block Alt+Up/Down | `nav/block-handle.ts:435-444, 827-853, 918` | A | `vmde.moveBlockUp`/`Down`, VS Code keys |
| W6 | Staged Select All Ctrl/Cmd+A; scope expand Ctrl/Cmd+E; Escape steps out (IR) | `editing/selection-scope.ts:468-482, 527-534, 555-585` | A, D | `vmde.selectAll`, `vmde.expandSelection`; Escape ladder fixed |
| W7 | Table moves Ctrl/Cmd+Shift+[ / ], +PageUp/PageDown in a cell | `editing/fix-table-ir.ts:364-389`; `editing/table-wysiwyg-controls.ts:156-178` | A | four `vmde.table.move*`, unbound |
| W8 | Ctrl/Cmd+Enter: link, chip, code ref or callout popover | `util/caret-gesture.ts:130-149`; `links/link-click-fix.ts:249`; `editing/callout-popover-keys.ts:121`; `package.json:1185` | A | `vmde.activateLinkAtCaret`, unbound |
| W9 | Ctrl+Alt+E; Cmd+Ctrl+E | `boot/main.ts:758-769` posts `edit-in-vscode` (`src/session/editor-session.ts:1340`); `package.json:1191` runs `vmde.openTextEditor` (`src/app/commands.ts:275`) | A | `vmde.openTextEditor`, unbound, one route |
| W10 | Copy/Cut, collapsed selection, Ctrl/Cmd+C/X | `clipboard/clipboard-line.ts:136-175` | C | VS Code owns the keys; mechanism after P7 (CP1-4) |
| W11 | Save flush Ctrl/Cmd+S | `bridge/save-flush.ts:16-43` (no `preventDefault`) | C | VS Code owns the key; will-save flush after P8 (CP1-4) |
| W12 | `FORMAT_HOTKEYS` guard: selection capture, bridged mark, `preventDefault` | `editing/format-hotkey-guard.ts:72-97, 156-176` | B, C | key-independent B/I/U/A guard; capture on the command message |
| W13 | Undo boundary on Ctrl/Cmd+{b,i,d,h,l,e,k,m,u,=,-,+,_}, Ctrl/Cmd+Shift+{c,r,g}, Enter | `editing/undo-boundaries.ts:12-26, 77-89, 161-165, 189` | C | remove each key only with its replacement action boundary |
| W14 | Ctrl/Cmd+Z/Y clears the table-cell rectangle | `editing/table-cell-selection.ts:343-350` | C | clear from the undo/redo path |
| W15 | Ctrl/Cmd+F exits a hoisted section | `nav/section-hoist.ts:391-400` | C | exit on the Find message (required) |
| W16 | IR table panel sends synthetic Vditor chords; `stopEvent` blocks forwarding | `editing/fix-table-ir.ts:240-276, 353-362`; `editing/table-hotkey.ts:39-58` | C | table commands call the action directly |
| W17 | Find widget Enter, Shift+Enter, Escape; macOS Cmd+Enter in Replace | `editing/selection-scope.ts:734-750, 1493-1502, 1522` | D | fixed (Task 579) |
| M1 | 12 `FORMAT_HOTKEYS` rows | `package.json:1215-1285`; `src/shared/format-hotkeys.ts:40-125`; `trigger-toolbar-hotkey` at `src/app/commands.ts:234-245` | A | four bound, eight unbound |
| M2 | `UNBOUND_FORMAT_COMMANDS` (undo, redo) | `src/shared/format-hotkeys.ts:132-138` | A | bound (W1) |
| M3 | Paste as plain text Ctrl/Cmd+Shift+V | `package.json:1179`; `src/app/commands.ts:322` | A | unbound |
| M4 | Find family, 10 bindings | `package.json:1197-1207, 1287-1345`; `src/app/commands.ts:194-207, 223-233` | A | keys unchanged; add G1 |
| V1 | Ctrl/Cmd+Alt+1…6 heading | `util/editorCommonEvent.ts:178-195` | A | `vmde.format.heading1`…`6`, unbound |
| V2 | Ctrl/Cmd+Alt+7/8/9 edit mode | `util/editorCommonEvent.ts:197-207` | A | three `vmde.switchTo*`, unbound |
| V3 | ⌘= / ⌘- in a heading | `ir/processKeydown.ts:163-181`; `wysiwyg/processKeydown.ts:165-185` | A | into Promote/Demote Heading |
| V4 | Nine table chords | `util/fixBrowserBehavior.ts:913-1000` | A | nine `vmde.table.*`, unbound |
| V5 | ⌘A in a code PRE | `util/fixBrowserBehavior.ts:1009` | A | into Select All (keep IR code stage) |
| V6 | ⇧⌘J task checkbox | `util/fixBrowserBehavior.ts:1155` | A | `vmde.toggleTaskCheckbox`, unbound |
| V7 | ⇧⌘; nest in blockquote (WYSIWYG) | `util/fixBrowserBehavior.ts:1125` | A | remove the key path |
| V8 | ⇧⌘U / ⇧⌘D move, ⇧⌘X remove (WYSIWYG popover) | `wysiwyg/processKeydown.ts:218-235, 355` | A | up/down into Move Block; remove: no key, no `vmde.deleteBlock` |
| V9 | Alt+Enter popover focus hops (WYSIWYG) | `wysiwyg/processKeydown.ts:90-96, 199-210`; `util/fixBrowserBehavior.ts:887`; `wysiwyg/highlightToolbarWYSIWYG.ts:975` | D | fixed exception |
| V10 | Alt+Enter, Ctrl/Cmd+Alt+Enter blockquote exits (WYSIWYG) | `wysiwyg/processKeydown.ts:124-144` | A | remove |
| D | Widget-local keys | see the fixed-key exceptions table below | D | fixed |
| E | Editing keys and key observers | `editing/gap-nav.ts:78-119`; `editing/gap-paragraph.ts:273, 329, 423`; `editing/callout-nav.ts:84, 217`; `links/link-click-fix.ts:256-310`; `editing/editor-caret.ts:399-423`; `editing/caret.ts:491-498`; `editing/caret-scroll.ts:47`; `editing/details-toggle.ts:530-570`; `editing/list-normalize-source-command.ts:161`; `editing/list-normalize.ts:374`; `editing/table-format-command.ts:175`; `editing/block-transform-command.ts:571`; `editing/emoji-picker.ts:586-587`; `boot/main.ts:676-682`; patches `media-src/esbuild-shared.mjs:478-512, 550-578, 742-747` | E | keep |
| F | Mouse gestures | `diagrams/diagram-zoom-gate.ts:59-96`; `diagrams/diagram-zoom.ts:130-163, 242`; `diagrams/engines/stl.ts:81-93`; `links/link-open-policy.ts:44-59`; `editing/link-popover.ts:132`; `editing/gap-click.ts:52-55`; `media-src/esbuild-shared.mjs:2245-2249` | F | keep |
| G | Labels with keys | `chrome/toolbar.ts:38, 264, 271`; `src/shared/format-hotkeys.ts:143-162`; `editing/fix-table-ir.ts:19-100`; Headings/EditMode tips `media-src/esbuild-shared.mjs:672-701`; `wysiwyg/highlightToolbarWYSIWYG.ts:323-458, 574-722, 893-939`; `README.md:140-311` | G | names only (CP3); Find labels stay a Task 579 exception |
| H | Tests that press modifier keys | 111 files in `media-src/e2e`, `test/vscode-e2e` and `media-src/src`; the only non-test source hit is W16 | H | update with each conversion |

Inactive Vditor keys: ⌘Enter (`util/editorCommonEvent.ts:146`, `ctrlEnter` unset), ⌘Z/⌘Y (`:153-165`, the toolbar has Undo/Redo), comment ⌘X (`:128`, comments disabled). The toolbar `hotkey` table (`util/Options.ts:197-383`) is inactive: every keyed item is `hotkey: ''` in `chrome/toolbar.ts` or is not in the toolbar (fullscreen). Host: the only key handling is the contributed keybindings; `onWillSaveTextDocument` is at `src/session/editor-session.ts:1482`. Engines stay `^1.110.0`.

### Verified VS Code defaults (pinned 1.129.0)

Source: [P1 summary](../tmp/task580-checks/defaults/summary.md). The Linux default-keybindings dump (1,134 rows) matches the bundle decode on all 29 target rows, including `when`. Windows and macOS keys come from the bundle decode. VS Code 1.110.0 has identical keys and `when` for all 28 registrations. `—` means no `when`.

| Function | VS Code command | Windows | Linux | macOS | VS Code `when` |
| --- | --- | --- | --- | --- | --- |
| Indent / Outdent | `editor.action.indentLines` / `outdentLines` | Ctrl+] / Ctrl+[ | same | Cmd+] / Cmd+[ | `editorTextFocus && !editorReadonly` |
| Undo | `undo` | Ctrl+Z | Ctrl+Z | Cmd+Z | — |
| Redo | `redo` | Ctrl+Y; Ctrl+Shift+Z | same | Cmd+Shift+Z | — |
| Select All | `editor.action.selectAll` | Ctrl+A | Ctrl+A | Cmd+A | — |
| Expand Selection | `editor.action.smartSelect.expand` | Shift+Alt+Right | same | Ctrl+Shift+Cmd+Right; Ctrl+Shift+Right | `editorTextFocus` |
| Shrink Selection | `editor.action.smartSelect.shrink` | Shift+Alt+Left | same | Ctrl+Shift+Cmd+Left; Ctrl+Shift+Left | `editorTextFocus` |
| Move Up / Down | `editor.action.moveLinesUpAction` / `DownAction` | Alt+Up / Alt+Down | same | same | `editorTextFocus && !editorReadonly` |
| Fold / Unfold | `editor.fold` / `editor.unfold` | Ctrl+Shift+[ / ] | same | Cmd+Alt+[ / ] | `editorTextFocus && foldingEnabled` |
| Toggle Fold | `editor.toggleFold` | Ctrl+K Ctrl+L | same | Cmd+K Cmd+L | `editorTextFocus && foldingEnabled` |
| Find | `actions.find` | Ctrl+F | Ctrl+F | Cmd+F | `editorFocus \|\| editorIsOpen` |
| Replace | `editor.action.startFindReplaceAction` | Ctrl+H | Ctrl+H | Cmd+Alt+F | `editorFocus \|\| editorIsOpen` |
| Find Next / Previous | `editor.action.nextMatchFindAction` / `previousMatchFindAction` | F3 / Shift+F3 | same | Cmd+G, F3 / Cmd+Shift+G, Shift+F3 | `editorFocus` |
| Match Case / Whole Word | `toggleFindCaseSensitive` / `toggleFindWholeWord` | Alt+C / Alt+W | same | Cmd+Alt+C / Cmd+Alt+W | `editorFocus` |
| Replace One | `editor.action.replaceOne` | Ctrl+Shift+1 | same | Cmd+Shift+1 | `editorFocus && findWidgetVisible` |
| Replace All | `editor.action.replaceAll` | Ctrl+Alt+Enter | same | Cmd+Alt+Enter | `editorFocus && findWidgetVisible` |
| Close Find | `closeFindWidget` | Escape; Shift+Escape | same | same | `editorFocus && !isComposing && findWidgetVisible` |
| Copy / Cut | `editor.action.clipboardCopyAction` / `CutAction` | Ctrl+C, Ctrl+Insert / Ctrl+X, Shift+Delete | Ctrl+C / Ctrl+X | Cmd+C / Cmd+X | — |
| Save | `workbench.action.files.save` | Ctrl+S | Ctrl+S | Cmd+S | — |

The Find widget's input keys (Enter, Shift+Enter, Enter in Replace, macOS Cmd+Enter in Replace) are also VS Code defaults; VMDE keeps them as widget-local keys (W17). VS Code's preconditions above are reference only. VMDE bindings use G1 and their own widget predicates.

### Final target table

G1 = `activeCustomEditorId == vmde.editor && !inputFocus && !sideBarFocus && !panelFocus && !auxiliaryBarFocus`. Every contributed VMDE binding uses G1. All commands keep category `VMDE`.

| Command | Title | Win/Linux | macOS | `when` | Identity |
| --- | --- | --- | --- | --- | --- |
| `vmde.format.bold` | Format: Bold | Ctrl+B | Cmd+B | G1 | convention (Owner) |
| `vmde.format.italic` | Format: Italic | Ctrl+I | Cmd+I | G1 | convention (Owner) |
| `vmde.format.indent` | Format: Indent | Ctrl+] | Cmd+] | G1 | `editor.action.indentLines` |
| `vmde.format.outdent` | Format: Outdent | Ctrl+[ | Cmd+[ | G1 | `editor.action.outdentLines` |
| `vmde.format.undo` | Undo | Ctrl+Z | Cmd+Z | G1 | `undo` |
| `vmde.format.redo` | Redo | Ctrl+Y; Ctrl+Shift+Z | Cmd+Shift+Z | G1 | `redo` |
| `vmde.selectAll` (new) | Select All | Ctrl+A | Cmd+A | G1 | `editor.action.selectAll` |
| `vmde.expandSelection` (new) | Expand Selection | Shift+Alt+Right | Ctrl+Shift+Cmd+Right; Ctrl+Shift+Right | G1 | `editor.action.smartSelect.expand` |
| `vmde.moveBlockUp` (new) | Move Block Up | Alt+Up | Alt+Up | G1 | `editor.action.moveLinesUpAction` |
| `vmde.moveBlockDown` (new) | Move Block Down | Alt+Down | Alt+Down | G1 | `editor.action.moveLinesDownAction` |
| `vmde.fold` (new) | Fold | Ctrl+Shift+[ | Cmd+Alt+[ | G1 | `editor.fold` |
| `vmde.unfold` (new) | Unfold | Ctrl+Shift+] | Cmd+Alt+] | G1 | `editor.unfold` |
| `vmde.toggleSectionFold` | Toggle Fold | Ctrl+K Ctrl+L | Cmd+K Cmd+L | G1 | `editor.toggleFold` |
| `vmde.find` | Find | Ctrl+F | Cmd+F | G1 | `actions.find` |
| `vmde.findReplace` | Replace | Ctrl+H | Cmd+Alt+F | G1 | `editor.action.startFindReplaceAction` |
| `vmde.findNext` | Find Next | F3 | F3; Cmd+G | G1 `&& vmde.findWidgetVisible` | `editor.action.nextMatchFindAction` |
| `vmde.findPrevious` | Find Previous | Shift+F3 | Shift+F3; Cmd+Shift+G | G1 `&& vmde.findWidgetVisible` | `editor.action.previousMatchFindAction` |
| `vmde.toggleFindCaseSensitive` | Toggle Find Case Sensitive | Alt+C | Cmd+Alt+C | G1 `&& vmde.findWidgetVisible` | `toggleFindCaseSensitive` |
| `vmde.toggleFindWholeWord` | Toggle Find Whole Word | Alt+W | Cmd+Alt+W | G1 `&& vmde.findWidgetVisible` | `toggleFindWholeWord` |
| `vmde.replaceOne` | Replace One | Ctrl+Shift+1 | Cmd+Shift+1 | G1 `&& vmde.findWidgetVisible` | `editor.action.replaceOne` |
| `vmde.replaceAll` | Replace All | Ctrl+Alt+Enter | Cmd+Alt+Enter | G1 `&& vmde.findWidgetVisible` | `editor.action.replaceAll` |
| `vmde.closeFindWidget` | Close Find Widget | Escape; Shift+Escape | same | G1 `&& vmde.findWidgetVisible` | `closeFindWidget` |

**Unbound** (VMDE-only; Command Palette, toolbar or user keys; palette entries gated to VMDE):

| Commands | Titles | Former key |
| --- | --- | --- |
| `vmde.format.strike`, `.headings`, `.list`, `.orderedList`, `.check`, `.quote`, `.code`, `.inlineCode` | existing `Format: …` titles | Ctrl/Cmd+D, macOS Cmd+H, Ctrl/Cmd+L, +Shift+7, +Shift+9, +;, +U, +G |
| `vmde.rewrap`, `vmde.rewrapDocument`, `vmde.pastePlain`, `vmde.activateLinkAtCaret`, `vmde.openTextEditor`, `vmde.formatTable`, `vmde.turnInto`, `vmde.fixListNumbering`, `vmde.renormalizeAllLists` | existing titles | Alt+Q, Ctrl/Cmd+Shift+V, Ctrl/Cmd+Enter, Ctrl+Alt+E / Cmd+Ctrl+E |
| `vmde.promoteHeading`, `vmde.demoteHeading` (V3 folds in) | existing titles | Ctrl/Cmd+Shift+[ / ], ⌘= / ⌘- |
| `vmde.promoteHeadingSection`, `vmde.demoteHeadingSection` (new) | Promote / Demote Heading Section | Ctrl/Cmd+Alt+Shift+[ / ] |
| `vmde.table.alignLeft`, `alignCenter`, `alignRight`, `insertRowAbove`, `insertRowBelow`, `insertColumnLeft`, `insertColumnRight`, `deleteRow`, `deleteColumn`, `moveColumnLeft`, `moveColumnRight`, `moveRowUp`, `moveRowDown` (new, 13) | Table: Align Left … Table: Move Row Down | V4 chords; W7 moves |
| `vmde.format.heading1` … `heading6` (new) | Format: Heading 1 … 6 | Ctrl/Cmd+Alt+1…6 |
| `vmde.switchToWysiwyg`, `vmde.switchToInstantRendering`, `vmde.switchToSplitView` (new) | Switch to WYSIWYG / Instant Rendering / Split View Mode | Ctrl/Cmd+Alt+7/8/9 |
| `vmde.toggleTaskCheckbox` (new) | Toggle Task Checkbox | Ctrl/Cmd+Shift+J |

Totals: 22 bound commands and 44 unbound commands (25 new). Also removed with no command: Win/Linux Ctrl+Alt+[ (W4), Ctrl/Cmd+E (W6), macOS Cmd+Y redo, V7, V8 remove, V10. **VS Code owns** Copy, Cut, Save and Shrink Selection; VMDE contributes no binding for them.

### Allowed fixed-key exceptions

| Keys | Where | Reason |
| --- | --- | --- |
| Find widget Enter, Shift+Enter, Escape; macOS Cmd+Enter in Replace | `editing/selection-scope.ts:734-750` | Task 579 widget; the same input keys as VS Code's Find widget |
| Link popover Enter, Escape | `editing/link-popover.ts:946-960, 994` | Widget-local input and dialog keys (policy 2) |
| Escape in selection bubble, callout popover, inline-picture dialog, named-anchor dialog, diagram fullscreen, section-hoist menu, outline reorder | `editing/selection-bubble.ts:500`; `editing/callout-popover-keys.ts:37`; `editing/inline-picture.ts:494`; `editing/named-anchor-insertion.ts:220`; `diagrams/diagram-fullscreen.ts:80`; `nav/section-hoist.ts:386-390`; `nav/outline-reorder.ts:103-104, 124` | Dialog close (policy 2) |
| Arrows, Home/End, Enter/Space, Escape, Tab in toolbar, menus, outline tree, emoji picker | `editing/escape-toolbar.ts:436-446, 521`; `nav/outline-keyboard.ts:275`; `editing/emoji-picker.ts:508-514, 574-587` | WAI-ARIA widget pattern (Owner Q2) |
| Resize-handle arrows, Home/End | `nav/outline-resize.ts:176`; `chrome/table-resize.ts:369` | WAI-ARIA separator pattern (Owner Q2) |
| `+ - = 0` on a focused diagram | `diagrams/diagram-zoom.ts:215-232`; `diagrams/diagram-zoom-keys-gated.ts:34-48` | Unmodified keys local to a focused widget (Owner Q2) |
| Enter/Space on a focused code-ref chip or details summary | `links/link-click-fix.ts:223-238`; `editing/details.ts:600, 623` | Button activation pattern (Owner Q2) |
| Table rectangle Escape, Delete/Backspace, Shift+Arrow | `editing/table-cell-selection.ts:351-373` | Local selection widget (Owner Q2) |
| Vditor hint popup keys | `util/editorCommonEvent.ts:121-124`; `hint/index.ts:237` | Popup list pattern (Owner Q2) |
| `;;` snippet then Enter | `editing/snippet-templates.ts:56, 76-90` | Text trigger, not a shortcut (policy 2) |
| IR Escape ladder (Task 288); Escape then Tab to the toolbar (Task 456) | `editing/selection-scope.ts:493, 533`; `editing/escape-toolbar.ts:48-58` | Owner Q3; Task 456 is the WCAG 2.1.2 keyboard-trap exit |
| WYSIWYG Alt+Enter popover focus hops (V9) | see V9 | Owner Q4; without it the popover inputs are not reachable by keyboard. Provisional: P4 did not show either hop |

Class E (editing keys) and class F (mouse gestures) are not shortcuts and stay as they are.

### Owner answers (2026-09-29) and probe limits

- Q1: G1 on every binding, including Task 579's Find bindings. `engines.vscode` stays `^1.110.0`.
- Q2: widget-local keys beyond Enter, Shift+Enter, Escape and Tab are recorded exceptions.
- Q3: the IR Escape ladder and Escape-then-Tab stay fixed.
- Q4: V1, V2, V4, V6 become unbound commands; V3, V5 and V8 up/down fold into existing actions; V7 and V8 remove lose their key paths, with no `vmde.deleteBlock`; V9 stays fixed; V10 is removed.
- Q5: a small exact-round-trip fixture is allowed for exact-source, callout and task-list legs; the large fixture stays for the other legs.
- P2 limits: the text editor in another group was not measured; the terminal row used a private `commandsToSkipShell` exception. CP4 must cover both, plus Explorer/Search Undo and Select All.
- P4 limits: five cells are unmeasured (IR H5 Ctrl+Alt+5, IR Ctrl+Shift+J, IR Ctrl+Shift+D, IR table Ctrl+Shift+], WYSIWYG V9 input-to-editor). Also open: both V9 directions, table-alignment source effects, a clean Move Block Up, one source-reveal route, and V10 against Replace All. No further P4 relay is authorized; CP2/CP4 own these gaps.
- P3 limits: on Linux, Ctrl+Shift+U makes IME composition text in the real webview; CP2 must mitigate or accept it. macOS and Windows native key behavior is not measured.
- Collision rows for bound and freed keys and candidate remap keys are not yet derived; they come from the P1 dump before the CP1-6 red tests.

### Orchestrator rulings (2026-10-04)

These rulings fall under Part 1 handoff §9 (orchestrator decisions). They make no new product choice.

- **G1 inside VMDE's own inputs.** P2 shows that G1 also matches when focus is in the Find input or the link-popover URL input. Keep G1. The CP2 dispatcher gives each command to the focused VMDE input when one has focus: Select All, Undo and Redo act on the input, and formatting commands do nothing. Coordinate the Find-input Undo case with Task 603.
- **`vmde.openTextEditor`.** It takes the behavior of the old Ctrl+Alt+E: when a VMDE panel exists, open the text editor and reveal the caret position in the source. The command is the only route.
- **Command titles.** Accept the titles in the target table. They mirror VS Code titles where the function is the same.
- **Bold and Italic collisions (CP1-6).** Ctrl/Cmd+B (Toggle Primary Side Bar) and Ctrl/Cmd+I (`holdToVoiceChatInChatView`, only with a speech extension) stay as the Owner's convention keys. G1 excludes side bar, panel and auxiliary bar focus, so the chat-view binding does not overlap in practice.
- **Policy 5 reading (CP1-6).** A VMDE command on the default key of the VS Code function that it mirrors is not a collision, even where VS Code binds other functions on that key under other contexts (for example the webview's own Find on Ctrl+F).
- **Unowned red rows (CP1-6).** Adding G1 to the existing bindings and removing the Ctrl/Cmd+Shift+V binding belong to CP3-1.

## Checkpoint 1 — Inventory, VS Code defaults and red expectations

- [x] Complete the inventory by search. Cover every `keydown`/`keyup` handler that matches modifier chords in `media-src/src`, every `contributes.keybindings` entry, `FORMAT_HOTKEYS`/`UNBOUND_FORMAT_COMMANDS`, Vditor hotkeys still active after `chrome/toolbar.ts`, and any host-side key handling.
- [x] Read the pinned VS Code build's actual default keybindings (for example its default keybindings JSON) for every VS Code-equivalent row. Record the mirrored command, Windows/Linux key, macOS key and `when` context.
- [x] Record the final target table: command ID, title, default key per platform or "unbound", `when` clause, and allowed fixed-key exceptions with reasons.
- [x] Write red unit expectations for the manifest: bindings, `when` clauses, unbound commands present, and no VMDE binding on a key that VS Code uses for a different function under an overlapping `when`.

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

Checkpoint 1 measurement and reconciliation ran under the accepted
[Part 1 handoff](../tmp/queue-part1/580-part1-handoff.md) and
[native resume handoff](../tmp/queue-part1/580-native-resume-handoff.md). The current
pre-580 candidate is `8c2ec1f0a3d7a8396195b4c22b46b26bb37430c1`. Runtime evidence is
Linux X11 with pinned VS Code 1.129.0, with the explicitly recorded 1.110.0 spot
checks; this is not physical macOS or Windows acceptance. CP1-5 consolidated
the inventory, verified defaults, target table and fixed-key exceptions above
(2026-10-04, against `8c2ec1f0`).

| Slice | Current result and evidence boundary |
| --- | --- |
| P1 / CP1-1 — defaults | Complete for the targeted default-key investigation: 29 decoded/dumped command/key/`when` rows agree, with minimum-version comparison. This is not the complete collision/remap audit. [Report](../tmp/task580-checks/defaults/summary.md). |
| P2 / CP1-2a — focus and forwarding | Probe execution concluded; coverage remains partial: 14/15 contexts on 1.129.0 and two 1.110.0 spot contexts. G1 agrees in all 16 valid rows; eight forwarding controls ran. The other-editor-group key was not sent, and the terminal row used a private diagnostic exception. These limits remain later acceptance obligations. [Report](../tmp/task580-checks/routing/final-report.md). |
| P3 / CP1-2b — native defaults | Complete for its Linux probe matrix: 204/204 Chromium rows and 51/51 bare real-webview rows, with stable no-key baselines. This does not replace real-editor mode acceptance. [Report](../tmp/task580-checks/native/final-report.md). |
| P4 / CP1-2c — Vditor chords | Partial: 95 distinct measured rows across the two preserved relays, with five explicit missing cells. The last relay exited 1 with 93/100 valid rows. No further P4 relay is authorized; the gaps remain assigned to later targeted acceptance. [Report](../tmp/task580-checks/vditor-chords/final-report.md). |
| P5 / CP1-3a — Undo/Redo routing | Accepted bounded slice: 18 valid mode/chord/focus cells, composed of 12 IR/WYSIWYG cells and six separately measured SV cells. Earlier invalid runs remain preserved; this was not one green 18-cell invocation. [Report](../tmp/task580-checks/baseline/routing/final-report.md), [independent review](../.superpowers/sdd/580-part1-handoff/cp1-3a-review.md). |
| P5 / CP1-3b1 — Bold | Accepted bounded slice: six early/settled mode cells, with direct editable-root receipts, exact action/recovery and successful save/disk checks. Reopen was not run. The initial run remains observations only because it lacked per-key editability evidence. [Report](../tmp/task580-checks/baseline/actions/final-report.md), [review](../.superpowers/sdd/580-part1-handoff/cp1-3b1-review.md), [atomic-claim verification](../.superpowers/sdd/580-part1-handoff/cp1-3b1-atomic-verification.md). |
| P5 / CP1-3b2 — Rewrap | Accepted bounded slice: six corrected early/settled mode cells with exact action/outside bytes and host/view/disk recovery. Original failed cells and two IR diagnostics remain preserved. Native-focus provenance is qualified: the standard guard may activate the native window, and its branch is unlogged. Reopen was not run. [Report](../tmp/task580-checks/baseline/rewrap/final-report.md), [review](../.superpowers/sdd/580-part1-handoff/cp1-3b2-review.md). |
| P5 / CP1-3b3 — Demote Heading | Accepted bounded slice: the single H2-to-H3 demotion relay `run.XY1NEV` exited 0 with six valid early/settled mode cells, exact source/outside bytes, caret projection 13 to 14 to 13, and successful save/disk recovery. Independent review resolved the low-confidence Jev timing flag; the original verdict is retained. Native activation remains qualified and reopen was not run. [Brief](../.superpowers/sdd/580-part1-handoff/cp1-3b3-brief.md), [report](../tmp/task580-checks/baseline/heading-shift/final-report.md), [review](../.superpowers/sdd/580-part1-handoff/cp1-3b3-review.md). |
| P5 / CP1-3b4 — List Normalize | Accepted bounded four-plus-two composite: four visual no-ops from the initial exit-1 relay and two exact-source SV actions from the corrected SV-only exit-0 relay. The original two invalid SV setups, one setup-only Document diagnostic, one instrumentation repair and both input versions remain preserved. One native Undo restores exact E0 and each mode's initial raw R/public V; all saves/disk checks passed. SV action caret moves 26 to 41, then Undo restores 26; final stack is 2/1 rather than opening 1/0. Effectful visual action history, nonempty Redo preservation and reopen remain unproved. Independent review resolved the original Jev confidence escalation without retry. [Report](../tmp/task580-checks/baseline/list-normalize/final-report.md), [review](../.superpowers/sdd/580-part1-handoff/cp1-3b4-review.md). |
| P5 / CP1-3b5 — Table Format | Accepted bounded four-case baseline: two unsupported visual controls with zero Undo and two SV exact-source actions, each recovered E/H/T/R/P on its first native Undo before save. All saves/disk checks passed. Logical caret stayed stable; rendered R did not change, host restoration had reason `other` and remained dirty until save, and final stack was 2/1. Final independent review resolved the original gate escalation; API setState forwarding was unexercised, native activation is unlogged and reopen was not run. [Report](../tmp/task580-checks/baseline/table-format/final-report.md), [review](../.superpowers/sdd/580-part1-handoff/cp1-3b5-review.md). |
| P5 / CP1-3b6 — Block Move | Accepted bounded five-case baseline: four visual native Alt+Down moves each recovered on the original first Undo, plus one unsupported SV native control with no Undo. Matching asynchronous applied outcome returned before each Undo; both early handler and calibrated native bounds passed. All pre-save source and save/disk checks passed. Caret 21 to 35 to 0 to 21 and final stack 2/1 remain explicit; no continuous caret preservation, forwarding suppression or native command-count inference. Independent review resolved the original gate escalation; activation, Redo, reopen and other-platform limits remain. [Report](../tmp/task580-checks/baseline/block-move/final-report.md), [review](../.superpowers/sdd/580-part1-handoff/cp1-3b6-review.md). |
| P5 / CP1-3b7 — Table operation | Accepted through the right-column variant: `right/run.jFcDS0` exited 0 with four valid IR/WYSIWYG early/settled cases, one physical Ctrl+Shift+= and one Ctrl+Z each, early handler-to-Undo 153.3/115.5 ms, pre-save E0 and save/disk recovery. The original Ctrl+Shift+G run `run.Dim1Xz` stays four invalid Undo cells (SCM focus takeover). SV is source-excluded. [Report](../tmp/task580-checks/baseline/table-operation/right/final-report.md). |
| P5 / CP1-3b8 — Find Replace All | Accepted six-cell composite: five valid cells from `run.viUqjt` and SV early from the scoped SV relay `run.2CuCip` (155.2 ms). The original late SV early cell (330.3 ms) stays invalid. One Ctrl+Alt+Enter and one Ctrl+Z each, exact action and pre-save recovery. After Escape the caret is at offset 0 (Task 599 behavior). [Report](../tmp/task580-checks/baseline/find-all/final-report.md). |
| P5 / CP1-3c — first edit | Accepted: `run.qL53Mo` 9/9 valid after one probe repair (count only trusted `input` events). A settled first-edit Undo is a delivered no-op in every mode (Task 598 defect). [Report](../tmp/task580-checks/baseline/first-edit/final-report.md). |
| P6 / CP1-3d — selection at command arrival | Accepted: `run.eJMaH3` 27/27 valid. At message arrival the selection equals the keydown snapshot. First actions make raw node/offset snapshots stale, so CP2 needs a structural snapshot. The router restore turns a backward selection forward (native route). Palette cells have no originating key. [Report](../tmp/task580-checks/baseline/selection/final-report.md). |
| P7 / CP1-4a1 — Chromium clipboard | Accepted 12-cell composite (`run.HiMxAS` + native-only `run.EbtmKZ`). With a collapsed caret, before-events and copy/cut fire on both paths; `preventDefault` on the before-event changes nothing. [Report](../tmp/task580-checks/clipboard-save/p7/chromium/final-report.md). |
| P7 / CP1-4a2 — Electron clipboard | Accepted bounded IR slice: `run.AA3aaN` 12/12. Expand-then-prevent at the before-event gives correct line copy and cut on the command path. Command cells needed live frame activation; WYSIWYG/SV and menu/Palette copy are unmeasured (CP2-11 obligations). [Report](../tmp/task580-checks/clipboard-save/p7/electron/final-report.md). |
| P8a / CP1-4b1 — native Save race | Accepted: `run.2XCROX` 6/6. Ctrl+S 2–5 ms after typing saves the typed text in every mode, clean and dirty. The host is still stale at will-save. [Report](../tmp/task580-checks/clipboard-save/save/native/final-report.md). |
| P8b / CP1-4b2 — Palette and auto-save | Accepted: `run.vbpIsh` 9/9. Palette Save and auto-save include pending typing only when the debounced post wins; onFocusChange was stale in 4/4. This is the CP2-12 will-save flush target. [Report](../tmp/task580-checks/clipboard-save/save/routes/final-report.md). |
| P8c / CP1-4b3 — large-fixture cost | Accepted: `run.3Q62Pd` 3/3. Save callback IR 141, WYSIWYG 257, SV 12 ms; will-save to applied edit about 200/330 ms. A will-save limit near 1000 ms fits; under about 500 ms fails SV. [Report](../tmp/task580-checks/clipboard-save/save/timing/final-report.md). |
| P8d / CP1-4b4 — exact Replace All and Save | Accepted: `run.omsfTb` 3/3. Task 196 exact bytes survive Replace All, Ctrl+S from the Find input and reopen in every mode, because save uses the guarded `flush()`. CP2-12 must reuse that guarded flush. [Report](../tmp/task580-checks/clipboard-save/save/exact/final-report.md). |

Checkpoint 1 is complete (2026-10-04). All four CP1 checkboxes are ticked. The
P2/P4 gaps, the P7 Electron gaps and all platform limits stay explicit and move to
CP2/CP4 acceptance.

**Verification mode for CP2–CP3 (Owner, 2026-10-04):** the accepted CP1 baselines
are the reference. Each CP2/CP3 step runs focused unit, Chromium and real-VS-Code
specs for the touched behavior with `--retries=0`; it adds no new probe-grade
measurement matrix. The full Checkpoint 4 acceptance matrix runs once.

The probes and their local evidence are ignored development artifacts. The CP1
commit holds this record and the red tests. Task 580 is not done:
the task-record move, `tasks/README.md` index update and final closure wait for all
checkpoint criteria. Protected local queue files remain untracked and unstaged; the root maintains authorized operator progress separately.
