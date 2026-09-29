# Task 579 — Split Find from Replace using VS Code's own shortcuts

> **For agentic workers:** Use `superpowers:executing-plans`. Checkboxes track implementation and acceptance.

**Status:** done (2026-09-28; CP2 behavior accepted with the explicit state-B waiver; network-free gates passed or matched the pre-CP2 baseline; focused local commit requested, not yet made).
**Goal:** VMDE's Find and Replace follow VS Code's own editor Find shortcuts, one-to-one. Find opens a Find-only widget. Replace opens the widget with the Replace row. Each in-widget action uses the same shortcut as the matching action in VS Code's editor find widget. VMDE invents no Find shortcut of its own. Every binding is an ordinary VMDE command that users can rebind in Keyboard Shortcuts.
**Tech stack:** TypeScript (extension host and webview), VS Code keybindings/commands/context keys, Vitest, Chromium Playwright and real VS Code with OS-level keyboard input.
**Spec:** The owner decisions, behavior contract and acceptance criteria in this file are the specification.
**Dependencies:** [Task 196](196-find-and-replace.md) (the widget and exact transaction) and [Task 568](568-find-replace-match-highlighting.md) (highlighting) are complete. Preserve their contracts. Independent of [Task 578](578-ir-click-source-index-rebuild.md), but both touch Find specs, so run them serially.

## Request and owner decisions (2026-09-27)

- **Request:** "split between Find and Find&Replace."
- **Refinement:** "I want this task to use the same VSCode shortcut for each functionality. I don't want to reinvent the shortcut for vmde." The original Ctrl+Shift+F proposal is withdrawn: Ctrl/Cmd+Shift+F stays VS Code's Find in Files.
- **Conflicts:** "User can configure custom shortcut key combination so it's not a concern. We use the same shortcut identity and leave actual key combination to user." The same applies to the Cmd+G conflict.
- **Visual and behavior decision (2026-09-28):** mirror VS Code's observed Find widget behavior and visuals. The reference was observed on vscode.dev with real key presses and DOM/style inspection; default keys were independently checked against the pinned desktop VS Code 1.129.0 bundle. See the CP1 execution record for the exact differences from the initial proposal.
- **Highlight repair decision (2026-09-28):** the toolbar-hidden highlight was displaced by 36 px on both the pre-CP1 `66bd2da4` Chromium baseline and the CP1 tree. The Project Owner approved fixing this pre-existing Task 568 defect inside Task 579. The toolbar hide/show geometry assertion remains the acceptance gate.

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
- [x] Update the README shortcut documentation in CP2. The completed Task 505 record retains its historical acceptance evidence.
- [x] Run the focused real-VS-Code `format-hotkeys.spec.ts` check on the built candidate (6/6 in the final CP2 relay).

## Checkpoint 2 — Browser and real-VS-Code acceptance, docs and closure

- [x] Chromium (large fixture): Find-only and Replace modes in IR, WYSIWYG and SV; the mode switch both ways; the toggle; all existing `find-replace.spec.ts` and `find-replace-large.spec.ts` cases pass (14/14 in the final relay).
- [x] Real VS Code (OS-level XTEST, large fixture, Linux keys; tracked Find keys 1/1 and full Find 2/2 in the final relay):
  - Ctrl+F opens Find only (no Replace row).
  - Ctrl+H opens Replace; Replace All then gives exact host bytes, one Undo restores the exact baseline, and save/reopen keeps them.
  - Ctrl+F while Replace is open keeps the Replace row and focuses Find; the toggle collapses it, and Ctrl+H expands it again.
  - F3/Shift+F3, Alt+C and Alt+W act on the widget.
  - Ctrl+Shift+1 replaces one match and Ctrl+Alt+Enter replaces all.
  - Escape closes the widget.
  - Ctrl+Shift+F opens VS Code's Find in Files.
  - With Find closed, Inline Code and the other formatting keys still work.
- [x] After hiding and showing the toolbar, match highlights reposition to their text. The prior 36 px drift was also present on the pre-CP1 baseline; the Owner approved repairing it here, and the final Chromium/real-VS-Code geometry checks pass.
- [x] Update `README.md`'s keyboard table and shortcut docs: Find and Replace mirror VS Code's keys; the Headings shortcut changed; how to rebind; the limitation above.
- [x] Changed-path coverage and network-free quality stages ran once on the final candidate: lint, jscpd, dependency-cruiser, unit coverage and module ratchet pass; brand/knip fail identically on the pre-CP2 baseline. Strict/spec type findings are baseline-equivalent. Bundle and startup numbers are reporting-only; dependency audit is omitted by Owner instruction.
- [x] Record final evidence, move this record to `tasks/done/` and add the `tasks/README.md` entry. The focused local commit is requested separately; do not push.

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
had been performed; subsequent CP1 and CP2 results are recorded here. The focused local commit
is requested separately.

## CP2 — acceptance, repairs and closure evidence (2026-09-28)

**Behavior acceptance:** the N12 product/build candidate passed its tracked Chromium and real-VS-Code gates with one worker and zero Playwright retries. The full run `run.iQ6B1b` passed counters, navigation attribution, IR click-index and all nine block-transform cases, then hit an Owner-classified invalid selection stall. The replacement `run.NVeVJd` verified the same candidate's 1,467 guarded inputs/outputs and those four passes, replaced the selection invocation, and completed every later tracked stage through final guard. The replacement run's raw final exit is **1 only because the theme-state table enforced the superseded state-B requirement**; its other recorded stages exit 0.

| Accepted stage | Result | Source of proof |
| --- | ---: | --- |
| Large Find counters; navigation attribution; IR click-index; block transforms | 1/1; 1/1; 1/1; 9/9 | full run `run.iQ6B1b`, hash-verified by replacement |
| Selection performance; large-document interaction | 1/1; 4/4 | replacement `run.NVeVJd` |
| Large-document Undo/Redo stability; six history regression files | 3/3; 7/7 | replacement, exact host/save/reopen assertions retained |
| Details toolbar/editing; current-overlay diagnostic; Find keys | 1/1; 1/1; 1/1; 1/1 | replacement; the tracked Find spec also checks live current-match geometry |
| Chromium Details; theme diagnostic; tracked Task 568 highlight | 11/11; 20/20; 10/10 | replacement; light/dark and toolbar geometry checks retained |
| Full Find spec; formatting hotkeys; Chromium Find | 2/2; 6/6; 14/14 | replacement, including OS keys and exact source/Undo/save/reopen |
| Final source/build guard | exit 0 | replacement |

**Theme state-B ruling:** the diagnostic's 20 runs all passed in state A and observed **zero** state B. The old table required at least two passing B runs and therefore exits 1. The orchestrator waived that criterion because N12 prevents reveal from settling on the placeholder layout that defined B. This is a waiver, not a state-B pass. The unchanged tracked highlighting gate passed 10/10, and the current-overlay probe showed the range parent skipped at the first in-box measurement, then laid out and displaced offscreen; the new reveal made a second scroll and ended with one positive-area current match inside the scroller. No later product change was made.

### CP2 issues and decisions

| Issue and observed cause | Owner decision and change | Evidence on the final candidate |
| --- | --- | --- |
| Xvfb/xdotool delivered requested F3 as Alt+F3, so VS Code never matched Find Next. | Resolve the live unmodified function-key keycode and send numeric XTEST keys; keep the OS-input acceptance path. | Tracked Find keys 1/1; helper units and actual XTEST keymap/routing diagnostics preceded it. |
| Find-input Enter reached the global Undo-boundary capture listener before local navigation and published Vditor's rendered `getValue()` despite no edit. | Exempt Find input actions and Find/Replace/Search keys from editor edit boundaries; retain editor Enter/paste grouping. | Fail-first IR/WYSIWYG/SV units, exact-host checks, full Find/Undo/save/reopen pass. |
| A scripted caret Range was overwritten by an older Undo caret intent before Ctrl+F; the resulting marker selection could not seed Find. | Arrange the test's caret through the existing caret-authority bridge, wait two frames, and assert exact live endpoints before OS input. CP1's separate focus repair retires old caret intent before opening Find. | Seed diagnostic established the overwrite; tracked Find keys pass without relaxing focus or delivery assertions. |
| After Undo, programmatic selection did not refresh Vditor's disabled Bold toolbar state; the Ctrl+B route arrived but the toolbar ignored it. | Test-only bare XTEST Shift tap after arrangement, with control-enabled, focus and exact-selection checks; stale-toolbar product hardening remains separate. | Formatting hotkeys 6/6 and Find-closed formatting/Undo assertions pass. |
| Match Case persisted correctly, but the counter spec attempted to turn it off after Escape hid the widget; WYSIWYG then used the case-sensitive count. | Reset the option while the widget is visible and assert it is off before the next mode. | Large Find counter gate passes unchanged count and work thresholds. |
| Theme/toolbar layout moved line boxes without a source mutation or scroll; skipped content-visibility blocks could report zero-area ranges. The pre-CP1 hidden-toolbar offset was separately measured as 36 px and approved for repair. | Repaint on stylesheet load/error, resize and content-visibility state changes; count unlaid-out current matches and bound settle retries. Toolbar position uses the visible toolbar's measured bottom. | Tracked highlight 10/10, theme probe 20/20, toolbar geometry in Chromium and real VS Code. |
| Find Next/Previous bounced focus Find→editor→Find. Eager Turn Into focusout capture inserted markers, serialized source and rebuilt the index; passive Details refresh also captured. | R1b retains only a guarded Range/key until an explicit Turn Into request; B1 defers passive Details while Find owns focus. Exact capture still runs at action time. | Large counter gate, navigation attribution and IR click-index pass with zero forbidden passive source work; Details and block transforms pass. |
| The large synthetic IR fixture is not a whole-document Lute round trip (181,855 rendered versus 174,517 exact characters), so Turn Into correctly declined even with the deferred Range. | Owner kept R1b unchanged and scoped one action acceptance case to a small exact-round-tripping document. Large-fixture Find-focus and editor-selection controls assert the same conservative decline. Broader exact/rendered mapping is a separate follow-up. | Nine native block-transform cases pass; exact Heading 2, save and one-step Undo remain checked in the small case. |
| A pending post-Undo IR edit echo and Vditor's delayed identical echo consumed a one-shot host expectation twice, normalizing exact bytes and clearing Redo. | Owner authorized a narrow Task 579 overlap with planned Task 602: retain the accepted history pair across matching plain echoes while the host is unchanged; reject other edits, exact/block/rewrap messages and host drift. | Fail-first controller/session tests; 95/95 focused history tests, three `:871` passes, seven history regressions and exact save/reopen. General multi-host-edit coupling remains Task 602. |
| Current-match reveal could mistake a zero-area first rectangle for an on-screen line. Later, a positive placeholder line briefly sat in-box before `content-visibility: auto` laid out the target UL and pushed it offscreen. | Select the first positive-area rectangle or ancestor placeholder, then make up to four bounded layout waits that do not consume scroll-correction passes. The tracked spec now requires a live-range/overlay overlap inside the scroller. | Fail-first reveal units, 96/96 focused Find tests, current-overlay probe 1/1 and tracked Find keys 1/1. |
| Three full runs exceeded the 150 ms selection-settle bound in late small-document phases. Each failed sample had an observation gap ≥600 ms, a show delay within 30 ms of it, zero long tasks and rAF maximum <100 ms. | Owner's stall policy classifies `run.U77NVu`, `run.jK1eoM` and `run.iQ6B1b` as invalid, not counted, with no count reset. Each was replaced by one unchanged, no-retry spec invocation after a hash-verified prior-stage guard. No process-leak or product cause was established. | Replacements `run.b7rer3`, `run.roJPMZ` and `run.NVeVJd` pass; Task 577/578 historical selection evidence and the six-run comparison remain distinct from the counted passes. |

### Final quality and follow-up ownership

- README now describes the split, the platform defaults, in-widget keys, rebinding and the changed Headings collision. The repository keeps historical release sections in `CHANGELOG.md`; there is no development-section requirement and no release entry is added here.
- The outside-sandbox, network-free quality relay verified all **1,467** accepted input/build files plus the README at both ends. Lint, jscpd, dependency-cruiser, unit coverage and the coverage-module ratchet exit **0**. Unit coverage runs **317 files / 4,888 passes / one expected failure**; totals are **76.03% statements, 69.09% branches, 79.61% functions and 78.22% lines**. The zero-coverage count improves from baseline 13 to 11; the ratchet exits 0 and identifies two modules eligible for later baseline pruning. Focused N1/N9/N12 regressions exercised the changed navigation, history and reveal paths. The dependency audit was deliberately omitted by Owner instruction; no aggregate `npm run quality` pass is claimed.
- Brand exits **1** with four former-name findings and knip exits **1** with nine exports/one type. Both outputs, from their finding headers onward, are byte-identical in the read-only `f2d136bf` pre-CP2 worktree. Its dependency symlinks made the direct brand scan hit `EISDIR`; a temporary Git exclude setting, without changing the worktree, yielded the same four findings. The VS Code spec typecheck is byte-identical at the existing `preview-task-checkbox.spec.ts:122` TS2339. Strict typecheck has **15** findings on both baseline and candidate with identical file/code/message multiset. Two `selection-scope.ts` positions shifted by CP2, but each flagged source line is unchanged. Task 578 recorded 13 findings on an older tree; the later pre-CP2 `f2d136bf` baseline already has 15. No finding is newly introduced by Task 579.
- Reporting-only checks exit **1** against inherited budgets: `media/dist/main.js` is **909,324 B**, **+8,993 B** from Task 578's **900,331 B**; the eager graph has **346 / 294** modules and its largest module is **29.8 / 34 KB**. The result is recorded without raising a budget or claiming a passing budget gate.
- C5 documentation checks matched nine README defaults to `package.json`, confirmed VMDE contributes no Find-in-Files binding, passed whole-tree `lint:ci` (1,080 files) and `git diff --check`, and found no tracked source or acceptance spec importing a disposable Task 579 probe. After the move/index update, lint still passes, this record's outgoing task links resolve, and brand retains the same four baseline violations. The baseline worktree retained its existing untracked dependency symlinks and has no tracked or staged changes. No Git staging, commit or push was performed in this step.
- After the quality relay, HEAD advanced from `f2d136bf` to `8e831815` in an external docs-only commit adding [Task 604](604-turn-into-non-round-tripping-documents.md). All 1,467 accepted source/build hashes and the README hash remain identical; no product rerun is inferred or needed from that docs commit. Incoming links in Tasks 593, 602 and 604 now point to this completed record.
- Tasks **596–603** remain separate planned work. Task 604 owns the large-fixture Turn Into non-round-trip exact/rendered mapping follow-up. The stale Bold toolbar state after programmatic arrangement needs product hardening outside Task 579. Task 602's general history-coupling scope remains planned; its Owner-authorized overlap note is included in the focused Task 579 commit request.
- Tracked acceptance specs and unit regressions establish behavior; the named geometry/routing probes support attribution and are reported separately. Those disposable probes remain ignored material and do not replace the tracked Chromium or real-VS-Code gates. The baseline worktree and protected `LOCAL_AGENT_TASK*.md` files remain under orchestrator/user ownership.

**Verified dispatch routing:** the model and effort below were read from each step's dispatch metadata, rather than inferred from the brief's requested tier.

| CP2 step(s) | Verified tier | Model / effort |
| --- | --- | --- |
| C2, C2r1–r3, C2r5, C2r8, N1–N3, N5–N10 | high | `gpt-6-astra` / `xhigh` |
| C2r4, C2r6, C2r10–r11, N4, C5, C5b | low | `gpt-6-sol` / `high` |
| C2r7, C2r9, T1, N11–N13 | medium | `gpt-6-sol` / `max` |

Task 579 is complete under the explicit theme state-B waiver and byte-identical pre-CP2 gate findings. Its record is in `tasks/done/` and the task index points there. The orchestrator still owns the focused local commit request; no push is authorized.
