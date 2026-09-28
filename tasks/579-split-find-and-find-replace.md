# Task 579 — Split Find from Replace using VS Code's own shortcuts

> **For agentic workers:** Use `superpowers:executing-plans`. Checkboxes track implementation and acceptance.

**Status:** in progress (2026-09-28; CP1 Find focus repair implemented and locally verified; real-VS-Code acceptance rerun pending).
**Goal:** VMDE's Find and Replace follow VS Code's own editor Find shortcuts, one-to-one. Find opens a Find-only widget. Replace opens the widget with the Replace row. Each in-widget action uses the same shortcut as the matching action in VS Code's editor find widget. VMDE invents no Find shortcut of its own. Every binding is an ordinary VMDE command that users can rebind in Keyboard Shortcuts.
**Tech stack:** TypeScript (extension host and webview), VS Code keybindings/commands/context keys, Vitest, Chromium Playwright and real VS Code with OS-level keyboard input.
**Spec:** The owner decisions, behavior contract and acceptance criteria in this file are the specification.
**Dependencies:** [Task 196](done/196-find-and-replace.md) (the widget and exact transaction) and [Task 568](done/568-find-replace-match-highlighting.md) (highlighting) are complete. Preserve their contracts. Independent of [Task 578](done/578-ir-click-source-index-rebuild.md), but both touch Find specs, so run them serially.

## Request and owner decisions (2026-09-27)

- **Request:** "split between Find and Find&Replace."
- **Refinement:** "I want this task to use the same VSCode shortcut for each functionality. I don't want to reinvent the shortcut for vmde." The original Ctrl+Shift+F proposal is withdrawn: Ctrl/Cmd+Shift+F stays VS Code's Find in Files.
- **Conflicts:** "User can configure custom shortcut key combination so it's not a concern. We use the same shortcut identity and leave actual key combination to user." The same applies to the Cmd+G conflict.
- **Visual and behavior decision (2026-09-28):** mirror VS Code's observed Find widget behavior and visuals. The reference was observed on vscode.dev with real key presses and DOM/style inspection; default keys were independently checked against the pinned desktop VS Code 1.129.0 bundle. See the CP1 execution record for the exact differences from the initial proposal.

**What this means in practice.** An extension cannot register VS Code's built-in Find command IDs (`actions.find`, `editor.action.startFindReplaceAction` and so on). It also cannot read a user's custom key for them. "Same shortcut identity" is therefore implemented as follows:

- **Keys:** each VMDE Find command's default binding uses the same key, on each platform, as VS Code's default for the same function.
- **Titles:** command titles mirror VS Code's command names.
- **Customization:** users who remap VS Code's Find keys can remap VMDE's commands the same way.

Record this limitation in the README shortcut docs.

**Collision rule.** Where a VS Code Find default collides with an existing VMDE default on the same platform and the `when` clauses overlap, the VS Code Find function gets the key.

- The VMDE command keeps working from the toolbar and Command Palette, and stays user-bindable.
- A Find action that VS Code only offers while its find widget is involved (for example Find Next) is scoped with a `when` context key to VMDE's Find widget being open. That way the colliding VMDE command keeps its key the rest of the time.

## VS Code defaults to mirror

Verified against the pinned VS Code 1.129.0 desktop bundle. Enter, Shift+Enter and macOS Cmd+Enter are handled locally in the widget; the other keys are contributed VMDE bindings.

| Function | VS Code command | Windows/Linux | macOS |
| --- | --- | --- | --- |
| Find | `actions.find` | Ctrl+F | Cmd+F |
| Replace | `editor.action.startFindReplaceAction` | Ctrl+H | Alt+Cmd+F |
| Find Next / Previous | `editor.action.nextMatchFindAction` / `previousMatchFindAction` | F3 / Shift+F3 (Enter / Shift+Enter in Find input) | Cmd+G / Shift+Cmd+G, F3 / Shift+F3 (also Enter / Shift+Enter in Find input) |
| Toggle Match Case | `toggleFindCaseSensitive` | Alt+C | Alt+Cmd+C |
| Toggle Match Whole Word | `toggleFindWholeWord` | Alt+W | Alt+Cmd+W |
| Replace one | `editor.action.replaceOne` | Ctrl+Shift+1; Enter in Replace input | Cmd+Shift+1; Enter in Replace input |
| Replace All | `editor.action.replaceAll` | Ctrl+Alt+Enter | Cmd+Alt+Enter; Cmd+Enter in Replace input |
| Close | `closeFindWidget` | Escape; Shift+Escape | Escape; Shift+Escape |
| Toggle Replace row | the find widget's toggle button | (button) | (button) |

Regex (Alt+R) and "Find in Selection" are not VMDE Find features (Task 196 scope) and are not added.

**Verified collisions and routing** (against the contributed bindings and `FORMAT_HOTKEYS`):

- **Ctrl+H** (Windows/Linux) belonged to `vmde.format.headings` in Task 505 and now belongs to Replace. Headings keeps Cmd+H on macOS, where Replace uses Alt+Cmd+F.
- **Cmd+G** (macOS) is `vmde.format.inlineCode`. It becomes Find Next only while VMDE's Find widget is open, and stays Inline Code otherwise.
- **Cmd+Enter** (macOS) is `vmde.activateLinkAtCaret`. Replace All handles it locally in the focused Replace input and stops propagation.
- **Ctrl/Cmd+F** moves from `vmde.findReplace` to `vmde.find`.
- F3, Shift+F3, Alt+C, Alt+W, Ctrl+Shift+1, Ctrl+Alt+Enter, Cmd+Alt+F, Escape and Shift+Escape have no overlapping VMDE default. VMDE contributes no Ctrl/Cmd+Shift+F binding. While the widget is open, VMDE's Escape binding can outrank another VS Code Escape action, such as hiding a notification.

## State before CP1

- `package.json` originally bound `ctrl+f` / `cmd+f` to `vmde.findReplace` (title "Find and Replace") and `ctrl+h` / `cmd+h` to `vmde.format.headings`. Both used `when: activeCustomEditorId == vmde.editor`.
- `src/app/commands.ts` posted `{ command: 'open-find-replace' }`; the webview routed it through `bridge/message-router.ts` to `openFindReplace()` in `editing/selection-scope.ts`.
- The widget always showed both rows. Its own `keydown` handler covered only Enter, Shift+Enter and Escape.
- Tests and docs that named those bindings:
  - `test/backend/manifest.test.ts` (asserts `ctrl+f` → `vmde.findReplace`);
  - `test/backend/commands-and-handlers.test.ts`;
  - `README.md` (keyboard table);
  - the Task 505 Headings tests (search for `ctrl+h` / `Control+h`, including `test/vscode-e2e/find-replace.spec.ts`, which asserts Ctrl+H opens Headings);
  - the Chromium and real-VS-Code Find specs.

## Behavior contract

- **Find** (VS Code's Find key):
  - From closed, it opens a Find-only widget, focuses the Find input and selects its text. If already open, it keeps the Replace row's current state and focuses/selects Find.
  - On opening from closed, seed from a non-empty single-line editor selection, otherwise the word at the caret. Keep the previous query for a multiline selection. Do not seed from rendered content that is absent from literal source.
  - The Replace input and its buttons are absent from layout and from the accessibility tree.
  - No replace action can run in this mode: not from a stale button, a message or a key.
- **Replace** (VS Code's Replace key):
  - From closed, it opens with the Replace row and focuses/selects Find. If already open, it expands the row; focus moves to Replace only when Find was focused, and otherwise moves to Find.
- The query, options and current match survive a mode switch.
- A "Toggle Replace" button (`aria-expanded`, accessible name) matches VS Code's widget chevron and keeps focus when clicked.
- The widget follows VS Code's compact two-row layout: theme-variable background, border and shadow; a left chevron column; Find options inside the input; match count and icon actions beside it; and a hidden Replace row when collapsed. It sits below VMDE's visible toolbar, or at the content top when the toolbar is hidden, and clears the editor scrollbar.
- Enter / Shift+Enter in Find move next / previous; Enter in Replace runs Replace One; macOS Cmd+Enter in Replace runs Replace All. Escape and Shift+Escape close the widget and return focus to the editor. Local keys ignore composing input and unintended modifiers.
- The in-widget keys from the table act only while VMDE's Find widget is open. Each is a contributed, rebindable VMDE command, gated by a context key the webview reports to the host, for example `vmde.findWidgetVisible` set with `setContext`.
- Everything else is unchanged from Task 196 and Task 568: exact-source search and transaction, one-step exact Undo/Redo, match-only live-setting highlights, viewport-bounded paint, honest counts, Escape returns focus, and Preview stays read-only.
- Ctrl/Cmd+Shift+F keeps VS Code's Find in Files; VMDE contributes no binding on it.
- **Command IDs:**
  - `vmde.findReplace` keeps its ID (existing user bindings keep opening Replace) and is retitled to mirror VS Code ("Replace").
  - A new `vmde.find` ("Find") is added, plus commands for the in-widget actions.
  - Final IDs: `vmde.find`, `vmde.findReplace`, `vmde.findNext`, `vmde.findPrevious`, `vmde.toggleFindCaseSensitive`, `vmde.toggleFindWholeWord`, `vmde.replaceOne`, `vmde.replaceAll`, `vmde.closeFindWidget`.
- The host↔webview protocol stays validated: a typed mode on the open message and a visibility report back. Update `protocol.ts`, `message-router.ts` validation and the protocol-shape tests.
- No new setting or dependency, no generated-output edit, no Worker. The widget stays outside Vditor's editable DOM.

## Test fixture scope

Owner rule from Task 196 (2026-09-26): every Chromium and real-VS-Code Find & Replace test uses only `test/vscode-e2e/fixtures/large-observable-models-synthetic.md` (copy it into the test's `baseDir`; never print its contents; derive counts from its exact bytes). Pure logic stays in Vitest.

## Checkpoint 1 — Commands, keybindings, context key and widget modes

- [x] In the pinned VS Code test build, read the actual default keybindings for every function in the table and correct the table.
- [x] Record the full collision list against VMDE's contributed keybindings and `FORMAT_HOTKEYS`, and the resolution of each under the collision rule.
- [x] Implement:
  - the `package.json` commands and keybindings, with per-platform keys and `when` clauses;
  - the `src/app/commands.ts` handlers;
  - the protocol message shapes and `message-router.ts` routing and validation;
  - the webview→host widget-visibility report and `setContext`;
  - the widget mode, toggle button and focus rules in `selection-scope.ts`.
- [x] Unit tests:
  - the manifest keys per platform, `when` clauses, and no Ctrl/Cmd+Shift+F binding;
  - the resolved collisions: Headings has no Ctrl+H default; Cmd+G Find Next is gated on the context key;
  - the command handlers and message validation;
  - the widget: Find only has no Replace controls in the accessibility tree and ignores replace attempts; the mode switch keeps the query, options and current match; focus; the toggle's `aria-expanded`; Escape.
- [x] Update the Task 505 Headings tests that assert Ctrl+H opens Headings: exercise `vmde.format.headings` as a command and assert that Ctrl+H opens Replace instead.
- [ ] Update the README shortcut documentation in CP2. The completed Task 505 record retains its historical acceptance evidence.
- [ ] Run the focused real-VS-Code `format-hotkeys.spec.ts` check on the built CP1 candidate.

## Checkpoint 2 — Browser and real-VS-Code acceptance, docs and closure

- [ ] Chromium (large fixture): Find-only and Replace modes in IR, WYSIWYG and SV; the mode switch both ways; the toggle; all existing `find-replace.spec.ts` and `find-replace-large.spec.ts` cases pass.
- [ ] Real VS Code (OS-level XTEST, large fixture, Linux keys):
  - Ctrl+F opens Find only (no Replace row).
  - Ctrl+H opens Replace; Replace All then gives exact host bytes, one Undo restores the exact baseline, and save/reopen keeps them.
  - Ctrl+F while Replace is open keeps the Replace row and focuses Find; the toggle collapses it, and Ctrl+H expands it again.
  - F3/Shift+F3, Alt+C and Alt+W act on the widget.
  - Ctrl+Shift+1 replaces one match and Ctrl+Alt+Enter replaces all.
  - Escape closes the widget.
  - Ctrl+Shift+F opens VS Code's Find in Files.
  - With Find closed, Inline Code and the other formatting keys still work.
- [ ] After hiding and showing the toolbar, match highlights reposition to their text. `tmp/task579-checks/visual/light-toolbar-hidden.png` shows highlights displaced by about one toolbar height; compare with the pre-CP1 baseline before classifying the cause.
- [ ] Update `README.md`'s keyboard table and shortcut docs: Find and Replace mirror VS Code's keys; the Headings shortcut changed; how to rebind; the limitation above.
- [ ] Changed-line coverage, typechecks and the network-free quality stages once on the final candidate. Bundle and startup numbers are reporting-only.
- [ ] Record the evidence here, move this record to `tasks/done/` and add the `tasks/README.md` entry only when every item is complete. One focused local commit per checkpoint; do not push.

## Execution progress

### CP1 design and implementation — Steps 1–4

- **Design:** The owner chose VS Code's observed behavior and visuals on 2026-09-28. The vscode.dev reference supplies interaction and visual details; the pinned VS Code 1.129.0 desktop bundle supplies default keys. The verified table, collisions, and final VMDE command IDs are recorded above. Initial spec differences were corrected: Ctrl+F keeps an already-open Replace row, opening seeds the query, Shift+Escape closes, Enter in Replace runs Replace One, and macOS Cmd+Enter in Replace runs Replace All.
- **Step 1 — gpt-6-sol/high:** added manifest commands, platform bindings, palette entries and visibility gates; moved the Win/Linux Ctrl+H default from Headings to Replace while preserving macOS Cmd+H for Headings; updated manifest, format-hotkey and toolbar unit tests.
- **Step 2 — gpt-6-sol/max:** added typed host↔webview Find messages, host command handlers, per-session `vmde.findWidgetVisible` context tracking, and focused host tests.
- **Step 3 — gpt-6-astra/xhigh:** implemented widget mode, action routing, focus, seeding, local keys, visibility reporting and guarded replacement, with focused webview tests. The detailed Step 3 evidence follows.
- **Step 4 — gpt-6-sol/max; Step 4b/4c — gpt-6-sol/high:** restyled the widget to the VS Code reference, prepared a disposable screenshot runner, then anchored it below the VMDE toolbar. Dark/light Find-only, Replace, No results, focus and toolbar-hidden screenshots are under ignored `tmp/task579-checks/visual/`. Screenshot review found the hidden-toolbar highlight offset recorded as a CP2 check above.
- **Step 5 — CP1 closeout:** updated `format-hotkeys.spec.ts` to prove Ctrl+H opens Replace rather than Headings and to exercise `vmde.format.headings` through the command; removed the obsolete Ctrl+H→Headings block from `find-replace.spec.ts`. The full Find flows remain for CP2 revision. The first real-VS-Code relay passed 5 of 6 tests but found Escape did not close Replace after Ctrl+H.
- **Step 5b — Escape repair:** the IR structural-selection document-capture listener used the editor's retained Range while Find held focus. It consumed Escape before the widget's local handler could close, and would also intercept editor-focused Escape while Find remained open. A focused unit regression failed before the fix and passes after structural selection yields keys owned by the visible widget; the real-VS-Code spec now asserts Find input focus and both widget-focused and editor-focused Escape. The 9-file focused Vitest set passed 352 tests; after a helper-only lint refactor, the 2 affected files passed 121 tests. Final `node build.mjs`, `npm run typecheck`, `npm run lint:ci`, and `git diff --check` passed. `npm run typecheck:vscode-e2e` still reports only the unchanged `preview-task-checkbox.spec.ts:122` TS2339 (`Window.vditor`). The relay outcome is recorded in Step 5c. CP1 remains uncommitted.
- **Step 5c — focus diagnosis:** the second relay again passed 5 of 6 tests, stopping at the new assertion that Find is focused after Ctrl+H. The Step 5b unit regression establishes the structural-selection conflict, but the real-webview focus loss remains unexplained. No product or caret-authority policy change is justified yet. A disposable two-case probe under `tmp/task579-checks/focus/` preserves the failing formatting sequence and records active-element transitions, focus/blur calls and events, and selection-write stacks for 1.2 seconds after Ctrl+H through Playwright and XTEST. Its TypeScript check and Playwright discovery pass; the diagnostic relay is pending. The acceptance assertions remain intact.
- **Step 5d — measured focus repair:** `tmp/task579-checks/focus/playwright.json` records an Undo checkpoint arming the caret at 13 ms, Find gaining focus at 32 ms, and `Selection.setBaseAndExtent` returning focus to the editor at 34 ms. Source-map resolution identifies `undo-boundaries.checkpointUndoBoundary` → Vditor `addCaret` for the request and `caret.tick` → `tryPlace` for the later write. Opening Find now calls the existing `invalidateCaret()` before focusing its input, retiring that earlier intent without changing caret-authority policy. Both new Find/Replace unit cases failed on a replayed selection before the fix and pass afterward. Final build, 209 tests across `find-widget`, `selection-scope`, `caret` and `undo-boundaries`, webview typecheck, whole-tree Biome and diff checks pass. The VS Code spec typecheck still has only the known `preview-task-checkbox.spec.ts:122` TS2339. The diagnostic's XTEST case failed before key delivery because the runner had no window manager; the formatting acceptance spec uses Playwright keyboard input and remains ready for the original relay command. No acceptance assertion was removed or relaxed. CP1 remains uncommitted until that relay passes.

### CP1 Step 3 — behavior dispatch 20260928-110409-579-s3-widget

Complete within this dispatch's behavior/unit scope (2026-09-28). Existing uncommitted Steps 1–2
were preserved. The dispatch's `579-vscode-reference.md` is the behavior authority and supersedes
the earlier mode-switch wording above: Find on an already-open widget keeps the Replace row's
state and focuses/selects Find. Replace expands the row and focuses/selects Replace only when
Find had focus; otherwise it focuses/selects Find. Reopening from closed uses the requested mode.

- [x] Route and validate open modes and the exhaustive action whitelist; log invalid messages.
- [x] Add mode state, accessible toggle/hidden row, focus rules, guarded replacement, local keys,
      visibility reporting through `boot/main.ts`, and the three browser harness hooks.
- [x] Seed only on opening from closed: single-line editor selection, otherwise the caret word.
      Multiline selections keep the previous query. Rendered math/diagram previews, marker/helper
      DOM, and visible phrases absent from the literal source are deliberately not seeded.
- [x] Cover reference behavior, accessibility visibility, seeding, modifier/IME guards, state
      reports, router rejection, and unchanged exact transactions with focused Vitest tests.

Verification (all final commands exit 0):

- `npm test -- --coverage --coverage.include=media-src/src/editing/selection-scope.ts
  --coverage.include=media-src/src/bridge/message-router.ts --coverage.reporter=text
  --coverage.reporter=json --coverage.reportsDirectory=/tmp/vmde-579-s3-coverage` with these files:
  `editing/{find-widget,selection-scope,find-engine,find-map,find-source,find-align}.test.ts`,
  `bridge/message-router.test.ts`, `chrome/toolbar.test.ts` (all under `media-src/src/`), and
  `test/backend/module-boundaries.test.ts`: **237 tests passed in 9 files**. Every added statement
  in the instrumented router and widget module was hit (9 and 181 statements respectively).
- `npm run typecheck`: passed.
- `node_modules/.bin/biome check` on the seven changed TypeScript source/test/harness files: passed.
- `git diff --check`: passed.

No old Task 196/568 assertions were changed: the existing helper only gained `reportState`, and
the default no-argument `openFindReplace()` continues to open Replace for compatibility. The
router's existing open assertion was strengthened to require the forwarded `'replace'` mode.
The new jsdom tests verify the actual CSS `display:none` rule and hidden descendants; native
accessibility-tree and real-webview evidence remain part of later acceptance.

At the end of Step 3, no build, e2e, aggregate quality run, visual restyle, or Git metadata operation
had been performed; subsequent steps are recorded above. CP1 real-VS-Code acceptance and CP2
documentation, browser/real-VS-Code acceptance and closure remain open. The task index stays open.
