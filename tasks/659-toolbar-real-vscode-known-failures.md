# Task 659 — Resolve known real-VS-Code toolbar failures

**Status:** open.
**Origin:** Project Owner request (known issue from Task 642).
**Severity:** medium (verification reliability; possible product defects).
**Tech stack:** real-VS-Code e2e specs in `test/vscode-e2e` run under `xvfb-run`; webview toolbar.
**Related:** [Task 642](done/642-toolbar-layout-follow-ups.md) (toolbar layout follow-ups).

## Problem

Four known real-VS-Code failures remain around the toolbar:

1. `toolbar-collapse.spec.ts`, restart case: intermittent. The own-launched VS Code started right after the previous case's VS Code sometimes does not activate VMDE, or Quick Open does not list the file. This also occurs on the build before Task 642.
2. `escape-toolbar.spec.ts:267`, "Tab inserted a tab character after the toolbar return": fails before Task 642 too.
3. `toolbar-overflow.spec.ts`, "two toolbar rows survive edit-mode and Preview transitions": Alt+Control+9 leaves Source mode hidden.
4. The Emoji high-contrast tile test: outline is 2.4 px where 3 px is expected.

## Requirements

1. Find the cause of each failure.
2. Fix product defects where the cause is in the product.
3. Make each test deterministic.
4. Remove each fixed item from the known-failure list.

## Open design points

- To be settled in Part 1.

## Scope

- In: the four failures above, their causes, and the specs named above.
- Out: toolbar behaviour not covered by these failures.

## Acceptance

- [x] The restart case in `toolbar-collapse.spec.ts` passes in repeated runs, with VMDE activated and the file listed in Quick Open. (Execution progress: full file 3 of 3, exit 0.)
- [x] `escape-toolbar.spec.ts:267` passes and the Tab character is inserted after the toolbar return. (passes once; see the A2 note in the progress section)
- [x] `toolbar-overflow.spec.ts` "two toolbar rows survive edit-mode and Preview transitions" passes, with Source mode visible after the Split View command (not Alt+Control+9; Task 580).
- [x] The Emoji high-contrast tile test passes with a 3 px outline (compared with a 3 px reference outline rounded the same way; passes in both environments).
- [x] Each of the four items is removed from the known-failure list. (annotated "resolved by Task 659" in the 642 record and `tasks/README.md`)

## Tests

- Real-VS-Code e2e specs named above. Run `node build.mjs` first, then run each spec under `xvfb-run`. Exact commands are to be specified in Part 1.

## Part 1 handoff (2026-10-18)

Task 659, read-only design pass at `dev` `1985ceb2` (; the effort comes from the agent definition, not from this pass). I read source, specs, the harness launch code, the Vditor source and the VS Code 1.129.0 install under `.vscode-test/worker-0` with grep only. I built nothing, ran no browser or VS Code, and ran no Lute probe (this brief did not allow one). `2 and F2.4. It verified F3.2 (0.98). It marked F2.4 "unsupported": F2.4 says a check is missing, and the evidence excerpt cannot show that something is absent. I read the whole handler (`selection-scope.ts:623-648`, `:713-716`) myself to confirm there is no target check.

### Verified facts

**Failure 2: `escape-toolbar.spec.ts:267` (Tab after the toolbar return)**

- F2.1 `finish-init.ts:614` installs `installEscapeToolbar()`, and `finish-init.ts:619` installs `installStructuralSelection()` after it. Both add capture-phase `keydown` listeners on `document` (`escape-toolbar.ts:521`, `selection-scope.ts:728`), so for one Escape the escape-toolbar listener always runs first.
- F2.2 When focus is in the toolbar and the key is Escape, `escape-toolbar.ts:470-473` calls `returnFocusToEditor()` and returns. It does not call `preventDefault` or `stopImmediatePropagation`. `returnFocusToEditor` (`escape-toolbar.ts:402-417`) puts the saved collapsed caret back right away through `requestCaret` (`caret.ts:526-541`, `tryPlace` runs in the same call) and then focuses the editor.
- F2.3 The same Escape then reaches the structural-selection listener (`selection-scope.ts:713-716`). `currentIrSelection` (`:560-574`) now finds the restored caret inside the IR editor. `handleEscape` (`:623-648`) finds the block scope, sees it differs from the collapsed range, and calls `applySelection(win, block.range)`. `blockRange` is `selectNodeContents(<p>)` (`:387-392`). Result: the whole paragraph is selected.
- F2.4 Neither `isStructuralEscape` (`:658-661`) nor `onKeydown` (`:713-716`) checks `event.target`. An Escape that started on a toolbar button is treated like one pressed in the editor.
- F2.5 The next bare Tab reaches Vditor's `fixTab` (`vditor/src/ts/util/fixBrowserBehavior.ts:578-597`). With a non-empty range it runs `range.extractContents()` and inserts `"\t"`, so the paragraph text is replaced by a tab. The test asserts `value.includes('\t')` (`escape-toolbar.spec.ts:264-267`). It most likely fails because Lute drops or trims a paragraph that is only whitespace. That serialization step is **unverified** (no Lute probe). The cause above it (the selection is widened) follows from F2.1–F2.4.
- F2.6 escape-toolbar already knows the structural listener widens the *arming* Escape (`escape-toolbar.ts:476-480`, "Structural selection's later capture listener also handles this Escape"). It has no matching guard for the *return* Escape.
- F2.7 The Chromium harness `media-src/e2e/escape-toolbar-harness.ts:22-35` installs `installEscapeToolbar`, `installFocusRestore` and `installEditorCaretTracking`, but **not** `installStructuralSelection`. That is why its return-leg test (`escape-toolbar-harness.spec.ts:123-155`) passes while real VS Code fails.
- F2.8 Structural Escape arrived in `9e03f96e` (Task 288, 2026-08-31), after Task 456's escape-toolbar work. This fits the failure showing up on the pre-642 commit too.
- **Classification: product defect.** A user who presses Escape, Tab, Escape and then types replaces the whole paragraph.

**Failure 3: `toolbar-overflow.spec.ts:202` (Alt+Control+9 leaves Source hidden)**

- F3.1 The test presses the real chord at `toolbar-overflow.spec.ts:367` and expects `.vditor-sv` at `:368`.
- F3.2 Task 580 CP2-10 (`91befe15`, 2026-10-04) changes Vditor at build time so the edit-mode chord answers only untrusted events. `media-src/esbuild-shared.mjs:1115-1116` (`DIGIT_MODE_ANCHOR`) and `:1117-1140` (`patchDigitChordsUntrusted`) rewrite `if (isCtrl(event)` to `if (!event.isTrusted && isCtrl(event)`. This is the Vditor block at `vditor/src/ts/util/editorCommonEvent.ts:196-205`. `media-src/src/editing/vditor-chord-actions.ts:1-6` states the intent: real Ctrl/Cmd+Alt+Digit no longer reaches these actions.
- F3.3 The replacement is the unbound command `vmde.switchToSplitView` (`src/shared/editor-shortcuts.ts:394-398`). It routes to `switchEditMode`, which clicks the toolbar's `button[data-mode="sv"]` (`vditor-chord-actions.ts:78-80`). `test/vscode-e2e/vditor-chords.spec.ts:229-238` already drives it through `vscode.commands.executeCommand`.
- F3.4 VS Code 1.129.0 has no default Ctrl+Alt+9 binding. The keybinding code 2590 does not appear in `workbench.desktop.main.js`. `moveEditorToLastGroup` is `primary:1566` (Shift+Alt+9). So the key reaches the webview, and the patched Vditor ignores it as intended.
- F3.5 The test's chord line dates from `0ec3a455` (2026-09-06), before Task 580. Every assertion after line 367 has not run since 2026-10-04.
- **Classification: test defect.** The test is out of date with Task 580; product behaviour is correct.

**Failure 4: Emoji high-contrast tile, 2.4 px instead of 3 px (`toolbar-overflow.spec.ts:803`, assertion `:909-915`)**

- F4.1 The 3 px comes from VMDE, not from VS Code. `main.css:2976-2979` sets `:is(body.vscode-high-contrast, body.vscode-high-contrast-light) :focus-visible { outline: 3px solid … !important }`. The picker's own rule is 2 px (`main.css:1122-1125`). The VS Code webview default stylesheet (`.vscode-test/.../webview/browser/pre/index.html:101-180`, `@layer vscode-default`) only has a 1 px `:focus` outline for `a`, `input`, `select` and `textarea`, and no high-contrast rule. The test comment at `:911-912` ("VS Code's high-contrast stylesheet … promotes") is wrong about where the value comes from.
- F4.2 Nothing in VMDE CSS or the picker code sets `zoom` or an outline in `em` units (grep of `media-src/src/**/*.css`, Vditor less, `emoji-picker.ts`). The tile is not under `.vditor-emojis`, so Vditor's `button { transition: all .15s }` (`_toolbar.less:130-142`) does not apply: `emoji-picker.ts:216` replaces the panel children, and `:344` gives the tile the class `vmde-emoji-picker__tile`.
- F4.3 2.4 = floor(3 × 1.25) / 1.25. That is Chromium rounding the outline width down to whole device pixels at a device pixel ratio of 1.25. **This is a hypothesis.** No run has recorded `devicePixelRatio`. The orchestrator's reruns used a private Xvfb with Openbox and `VMDE_XTEST=1`, which forces `--ozone-platform=x11` (`vscode-test-playwright/dist/index.js:158`) (`LOCAL_AGENT_TASK.md:614`). Its X DPI is unknown.
- F4.4 `high-contrast.spec.ts:114` also asserts a literal `'3px'`. It would fail the same way under the same device pixel ratio. Whether it passes today is unverified.
- **Classification: test defect if F4.3 holds** (the expectation ignores the device pixel ratio). **Product defect if S1 shows a different rule winning.**

**Failure 1: `toolbar-collapse.spec.ts` restart case (`:746-861`)**

- F1.1 The harness gives each worker one `--user-data-dir` (`vscode-test-playwright/dist/index.js:110, 167`, both `scope: 'worker'`). The restart case uses its own `restart-user-data` (`toolbar-collapse.spec.ts:763`) and the shared `--extensions-dir` (`:795`), and always passes `--ozone-platform=x11` (`:791`).
- F1.2 It waits up to 30 s until no main process of the install runs (`:767-779`), then opens files through Quick Open (`:811-829`). It presses `Control+P` and types the name at once (`:813-814`), without waiting for the quick-input box to show and take focus. Keys typed before the box has focus are lost. This matches the recorded "Quick Open list never showing" symptom under load. That cause is inferred, not observed.
- F1.3 The probe script arms once per root element on a 1 ms timer and reads the inline `#vmark-init` payload once (`:710-733`). If the payload tag has not been parsed yet, the read fails silently (`:731`) and is never retried. When the init is inlined (`html-builder.ts:304-308`, placed before `main.js`), there may be no `update/init` message for the listener to catch, so `inits` stays empty and `expect(inits).toContain(...)` (`:836`, `:848`, `:856`) fails. This matches the recorded "probe armed after the init message" symptom.
- F1.4 Nothing in the case waits for the extension host or VMDE's editor registration before Quick Open picks the file. Whether VS Code's editor resolver waits for extension registration on this path is **unverified**. The "opened as plain text" symptom needs the logs in S1 to explain.
- F1.5 The full file failed in 2 of 3 orchestrator runs, and 2 of 8 on pre-642 `57b7a957` (`LOCAL_AGENT_TASK.md:614`). The case alone passed 6 of 6 (`tasks/done/642…md:375`). So the failure needs the earlier cases' load or leftovers.
- **Classification: test defect** (races in the spec), possibly plus slow startup in the environment. No product code is involved.

**Known-failure list:** the four items appear in `tasks/done/642-toolbar-layout-follow-ups.md:378, 413-415` and in the 642 entry's residuals in `tasks/README.md:102`.

### Decisions

- D1 (failure 2) Fix it in `selection-scope.ts`. The structural Escape steps out only when the Escape started outside the Vditor toolbar. In `onKeydown` (`:713`), return early when `event.target` is a `Node` contained in `innerVditor()?.toolbar?.element` (`innerVditor` is already imported at `:31`). I rejected `stopImmediatePropagation` in `escape-toolbar.ts:470`: it would also hide that Escape from every capture listener installed later (block-handle menus at `block-handle.ts:889-894`, selection-bubble and others).
- D2 (failure 2) The Chromium harness installs `installStructuralSelection()` right after `installEscapeToolbar()`, in the same order as `finish-init.ts`. This is the cheap way to see the failure (RED) before the fix.
- D3 (failure 3) Replace `workbox.keyboard.press('Alt+Control+9')` with `evaluateInVSCode(vscode => vscode.commands.executeCommand('vmde.switchToSplitView'))` and rewrite the comment at `:365-366` to name the Task 580 command route. Do not restore the real chord: that would undo an Owner decision (Task 580 Q4).
- D4 (failure 4) Assert the outline width independent of the device pixel ratio. Compare the tile's computed `outlineWidth` with the computed `outlineWidth` of a throwaway reference element in the same document that has inline `outline: 3px solid`. That element gets rounded the same way. Also assert `outlineStyle: 'solid'` and correct the comment at `:911-912` to cite `main.css:2976-2979`. This holds only if S1 confirms F4.3. Otherwise S1 decides on a product fix in `main.css`, and the main thread re-plans that step.
- D5 (failure 1) Spec hardening, all in `toolbar-collapse.spec.ts`:
  - (a) `openByQuickOpen` waits for `.quick-input-widget input` to be focused before typing. It presses `Control+P` again, up to 3 times with a 5 s wait each, if the box does not appear. It types with `fill` on that input instead of `keyboard.type`.
  - (b) The probe retries the inline `#vmark-init` read on every sampler frame and on `DOMContentLoaded` until a value is recorded for that root.
  - (c) On failure of either launch step, the case attaches the `restart-user-data/logs` directory, a workbox screenshot and the `ps` list (`testInfo.attach`), so any remaining failure can be classified.
  - (d) Anything S1 shows beyond (a)–(c), such as an editor opened as plain text, gets a wait on a readiness signal that S1 names.
- D6 Close-out: in `tasks/done/642…md:378, 413-415` and in the `tasks/README.md:102` residuals, mark each item "resolved by Task 659 (`<sha>`)" instead of deleting it, so the history stays readable. Tick the Task 659 acceptance items only from real runs.
- D7 Names are fixed as follows. New Vitest case: `"ignores an Escape that starts in the toolbar"` under `describe('installStructuralSelection')`. New test-local helper in `toolbar-overflow.spec.ts`: `referenceOutlineWidth(frame, width)`. No new spec files.

### State/DOM/messages

- The return Escape after the fix: escape-toolbar puts the collapsed caret back and focuses the editor. Structural selection sees `target ∈ toolbar`, returns, and does nothing. The selection stays collapsed at the caret saved before the gesture.
- An Escape pressed inside the editor is unchanged: the target is the editor surface, so step-out still runs. Existing tests dispatch on `document`, which is not inside the toolbar, so they are not affected.
- No protocol messages change. `vmde.switchToSplitView` uses the existing `editor-action` route.

### Part 2 steps

Run `node build.mjs` before every real-VS-Code step. Run only one real-VS-Code invocation at a time; `scripts/e2e-lock.mjs` enforces this. Every real-VS-Code command:

`env -u ELECTRON_RUN_AS_NODE xvfb-run -a npm --prefix test/vscode-e2e test -- <spec> --workers=1 --retries=0`

Also run S1, S5 and S6 once in the orchestrator's environment (private Xvfb with Openbox, `VMDE_XTEST=1`), because the device pixel ratio and timing may differ there.

**S1 — diagnostic probe (no product change; not committed).** Owned: a scratch copy, `test/vscode-e2e/tmp/659-probe.spec.ts`, tagged `@probe` and deleted after the run.

- Case A (Emoji): open the Emoji fixture as `:803-907` does, switch to Default High Contrast, focus the tile, and record:
  - `window.devicePixelRatio`
  - whether the tile matches `:focus-visible`
  - the tile's computed `outlineWidth`, `outlineStyle`, `transitionProperty` and `transitionDuration`
  - the computed `outlineWidth` of a `<button style="outline:3px solid">` appended to `body`
  - every stylesheet rule that matches the tile and sets an `outline*` property (walk `document.styleSheets`, test `el.matches(selectorText)`)
- Case B (escape): reproduce the walk in `escape-toolbar.spec.ts:202-252` and record `getSelection().toString()` and `isCollapsed` right after the return Escape. Expected before the fix: the whole paragraph text, with `isCollapsed` false.
- Run once under plain `xvfb-run -a` and once in the orchestrator's environment.
- Output: a short evidence note in the 659 record. It confirms or rejects F4.3 and F2.3 and picks D4 or a product fix.

**S2 — failure 2 product fix with RED first.** Owned: `media-src/src/editing/selection-scope.ts`, `media-src/src/editing/selection-scope.test.ts`, `media-src/e2e/escape-toolbar-harness.ts`, `media-src/e2e/escape-toolbar-harness.spec.ts`.

- RED 1 (Vitest): in `selection-scope.test.ts`, add `"ignores an Escape that starts in the toolbar"`:
  - mount `setupStructuralEditor()`
  - add a `.vditor-toolbar` element with a `<button>` to `body`
  - set `window.vditor.vditor.toolbar = { element: toolbar }`
  - place a collapsed caret in "final paragraph"
  - dispatch a bubbling, cancelable `Escape` keydown on the button
  - expect `defaultPrevented === false`, `getSelection().isCollapsed === true`, and the caret still at the same node and offset

  Before the fix this fails: `handleEscape` selects the block and `defaultPrevented` is true.
- RED 2 (Chromium): add `installStructuralSelection()` to the harness after `installEscapeToolbar()`. In the return-leg test (`escape-toolbar-harness.spec.ts:123`), right after the return Escape, assert `getSelection().isCollapsed === true` and the anchor offset equal to the offset before the gesture. After the Tab, assert the value equals the baseline with `\t` inserted at that offset. Before the fix this fails.
- Fix: the early return in `onKeydown` per D1, with a comment following `.agents/rules/ts.md`.
- Checks:
  - `npx vitest run --config test/vitest.config.mts media-src/src/editing/selection-scope.test.ts media-src/src/editing/escape-toolbar.test.ts`
  - `xvfb-run -a npm --prefix media-src run test:e2e -- escape-toolbar-harness.spec.ts structural-selection.spec.ts toolbar-selection.spec.ts`
  - `npm run typecheck`
  - `npx biome check` on the changed files

**S3 — failure 2 in real VS Code.** Owned: `test/vscode-e2e/escape-toolbar.spec.ts`.

- Add assertions after `:252`: the selection is collapsed after the return, and the Tab inserts `\t` at the saved offset, comparing the whole value rather than only `includes`.
- Run `node build.mjs`, then the spec once (`escape-toolbar.spec.ts`). It must pass.

**S4 — failure 3.** Owned: `test/vscode-e2e/toolbar-overflow.spec.ts`, the `:202` test only.

- Apply D3. The RED proof is the existing failure at `:367-368`, already recorded twice in 642 S2.
- Run `node build.mjs`, then `toolbar-overflow.spec.ts -g "two toolbar rows survive"` once.
- The assertions after `:368` have not run since 2026-10-04. If one fails, record it as a new finding with its line, and classify it as product or test against Task 642's flow design before changing anything. Do not loosen an assertion to make it pass.

**S5 — failure 4.** Owned: `test/vscode-e2e/toolbar-overflow.spec.ts`, the `:803` test only. If S1 rejects F4.3, also `media-src/src/main.css`, and the main thread re-plans this step.

- Apply D4.
- RED proof: S1's recorded 2.4 px against the literal `'3px'`.
- Run `node build.mjs`, then `-g "Emoji picker keeps transparent fallback tiles"` once under plain `xvfb-run -a` and once in the orchestrator's environment. It must pass in both.

**S6 — failure 1.** Owned: `test/vscode-e2e/toolbar-collapse.spec.ts`, restart case and its helpers (`:661-861`).

- Apply D5 (a)–(c), plus (d) if S1 or the attached logs name a readiness signal.
- RED proof: the 2-of-3 record.
- Run `node build.mjs`, then the full `toolbar-collapse.spec.ts` 3 times in a row, one invocation at a time, in the orchestrator's environment. Acceptance asks for "repeated runs"; 3 matches the sample that showed the failure. All 3 must exit 0. On any failure, attach the logs and stop for classification.

**S7 — close-out.** Owned: `tasks/659-toolbar-real-vscode-known-failures.md`, `tasks/done/642-toolbar-layout-follow-ups.md` (Known lines only), `tasks/README.md` (the 642 residual sentence, plus a 659 entry when complete), `LOCAL_AGENT_TASK.md` §1 table and §7.25.

- Apply D6 and record the commands and results that actually ran.
- Run `npm run quality` once for the batch (S2 changes product code).

### Tests mapped to acceptance

| Acceptance item | Cheapest proof | Real VS Code |
|---|---|---|
| A1 restart case passes in repeated runs; VMDE active, file listed in Quick Open | none cheaper (the cause is VS Code launch timing) | S6: full `toolbar-collapse.spec.ts` ×3, exit 0 |
| A2 `escape-toolbar.spec.ts:267` passes, Tab inserted after the return | Vitest (S2 RED 1) and Chromium (S2 RED 2) | S3: `escape-toolbar.spec.ts` once |
| A3 two-row transition passes, Source visible after the mode switch | none (the cause is in the test) | S4: `-g "two toolbar rows survive"` once |
| A4 Emoji HC tile passes with a 3 px outline | none (rounding happens only in the real webview) | S5: `-g "Emoji picker keeps transparent"` in both environments |
| A5 items removed from the known-failure list | document check (grep the 642 record and README) | none |

Edge cases:

- An Escape pressed in the editor still steps out. Covered by the existing Vitest cases at `selection-scope.test.ts:1351-1385` and `structural-selection.spec.ts:206-214`, which S2 reruns.
- An Escape from a submenu panel inside the toolbar is ignored by structural selection (the target is inside the toolbar). The RED 1 case covers it with a button target.
- The arming Escape in the editor still widens to the block, while escape-toolbar's saved range keeps the caret position (`escape-toolbar.ts:476-480`). Covered by the existing S3 positive walk.

A3 wording: Source mode is reached through `vmde.switchToSplitView`, not Alt+Control+9. The record's acceptance text should say "after the Split View command". The main thread updates the record wording in S7.

No new `test()` blocks in real VS Code. S3–S6 add assertions inside existing tests.

### Owner questions

1. **(Only if S1 confirms F4.3.)** At a device pixel ratio of 1.25, VMDE's 3 px high-contrast focus ring paints as 3 device pixels, which is 2.4 CSS px. Recommended: (a) accept this rounding as platform behaviour and make the test compare against the same rounding (D4). Alternative: (b) raise the high-contrast ring to `max(3px, 3 device px)`, which needs a `resolution` media query in `main.css:2976-2979` and also changes `high-contrast.spec.ts`. Alternative: (c) leave it and keep the item as a known failure.

### Residual risks

- The F2.5 serialization step (a tab-only paragraph dropped by Lute) has not been run. The fix does not depend on it, because the widened selection is wrong whatever Lute does.
- F4.3 (device pixel ratio 1.25) is a hypothesis until S1 runs. If another rule wins, S5 becomes a product CSS change and needs a new plan.
- The assertions in the `:202` test after line 367 have not run since 2026-10-04 and may expose failures related to Task 642's flow.
- The restart case can still fail if the plain-text open (F1.4) has a cause outside D5 (a)–(c). D5 (c) makes such a failure classifiable instead of silent.
- `high-contrast.spec.ts:114` likely shares failure 4's assumption about the device pixel ratio. It is out of Task 659's scope; the main thread may want to file it.
- The D1 guard depends on `innerVditor()?.toolbar?.element` being the element that contains the More and Emoji panels. `escape-toolbar.ts:171, 433` relies on the same element.

**Owner answer (2026-10-18, chat):** none needed yet; the device-pixel-ratio question is asked only if S1 confirms the 1.25 ratio.

## Execution progress — 2026-10-18 (Part 2)

Environment: real VS Code 1.129.0, `--workers=1 --retries=0`, under `xvfb-run -a`; "orchestrator environment" = openbox started inside the shell with `VMDE_XTEST=1`.

- **S2 (done, not yet committed).** `selection-scope.ts` ignores an Escape whose target is inside the Vditor toolbar. Vitest RED (`defaultPrevented` true) then GREEN (92 passed with `escape-toolbar.test.ts`). Chromium: the harness installs structural selection; a bubble-phase probe is RED before the fix (the return Escape never reached `window`) and GREEN after; `escape-toolbar-harness`, `structural-selection`, `toolbar-selection` 47 passed. The caret assertions alone did not fail in Chromium, because `requestCaret` re-places the caret afterwards.
- **S1 probe (deleted after use).** Under plain `xvfb-run -a`: `devicePixelRatio` 1.25, tile `:focus-visible`, computed outline 2.4 px solid, a 3 px reference element also 2.4 px, winning rule `main.css` high-contrast `:focus-visible` (3 px). In the orchestrator environment: ratio 1, tile 3 px, reference 3 px. F4.3 is confirmed: the product rule is 3 px and the rounding comes from the device pixel ratio.
- **S4 / A3 (done).** `-g "two toolbar rows survive"` passed (1 test, the assertions after the mode switch ran). Source mode is reached through `vmde.switchToSplitView`.
- **S5 / A4 (done).** `referenceOutlineWidth` compares the tile outline with a 3 px reference. Passed under plain `xvfb-run -a` (ratio 1.25) and in the orchestrator environment. Option (a) used; the Owner confirmation goes through the orchestrator.
- **S6 / A1 (done).** Restart case: launch waits for the Quick Open input to hold focus (Control+P up to 3 times, then `fill`); the probe retries the inline `vmark-init` read each tick and on `DOMContentLoaded`; a failed launch attaches a screenshot, the process list and the VS Code logs. Full `toolbar-collapse.spec.ts` 3 runs in a row, each 5 passed, exit 0.
- **S3 / A2 (done after the design owner's rulings).** Two more product causes were found beyond the S2 guard. (1) The walk's ArrowRight lands on a disabled toolbar item; at the return Escape `document.activeElement` is already the editor while `event.target` is the toolbar item, so `escape-toolbar.ts` did not treat the key as a return and never restored the caret. Fix: `focusInToolbar` also counts `event.target` inside the toolbar; Vitest case in `escape-toolbar.test.ts` RED (offset 0 instead of 6) then GREEN. (2) Ctrl+Tab reached Vditor's Tab handling and replaced the widened paragraph. Fix: `patchModifiedTabInert` in `esbuild-shared.mjs` makes Ctrl/Cmd+Tab and Alt+Tab return before that handling (no `preventDefault`), chained in the `editorCommonEvent.ts` entry; Vitest transform case RED (function missing) then GREEN (339 passed in `vditor-source-patches.test.ts`). `escape-toolbar.spec.ts` gained the collapsed/offset assertions, the whole-value Tab assertion and a Ctrl+Tab-on-collapsed-caret leg; it passed once (exit 0). The Ctrl+Tab leg's own RED was not run separately; the earlier run with only the first fix showed the paragraph replaced by an empty fenced block at the following Ctrl+Tab step.
- Shared-build recheck: `toolbar-overflow.spec.ts -g "two toolbar rows survive"` passed again after the Vditor patch (exit 0).
- Left for the orchestrator: `npm run quality`, the `LOCAL_AGENT_TASK.md` updates, and the Owner confirmation of rounding option (a).
