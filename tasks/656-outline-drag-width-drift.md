# Task 656 — Outline drag-resize drifts the stored width by 1 px

**Status:** open.
**Origin:** Project Owner request (follow-up of Task 650).
**Severity:** low.
**Tech stack:** webview (Outline drag-resize, `media-src/src/nav/outline-resize.ts`).
**Related:** [Task 650](done/650-remember-outline-open-state-and-width.md) (remember Outline open state and width).

## Problem

The Outline drag-resize stores `outlineEl.offsetWidth` in `onUp` of `media-src/src/nav/outline-resize.ts`. That value is the content width plus the 1 px border. The `--me-outline-width` variable holds the content width. Each drag can therefore grow the stored width by 1 px.

## Requirements

1. The drag-resize stores the content width, the same value held by `--me-outline-width`.
2. Repeated drags without a size change do not change the stored width.

## Open design points

- None beyond confirming the content width source in `onUp`.

## Scope

- In: the stored width written by the Outline drag-resize.
- Out: Outline open state memory (Task 650) and other resize paths.

## Acceptance

- [x] After a drag, the stored width equals the value of `--me-outline-width`.
- [x] Ten drag-and-release cycles with no pointer movement leave the stored width unchanged.
- [x] The Outline width restores as before after reopening.

## Tests

- To be specified in Part 1 (webview behaviour; real-VS-Code verification is required for behaviour that depends on the VS Code integration).

## Part 1 handoff (2026-10-18)

Read-only source mapping at HEAD `9a9f54ff`. Nothing was built or run (no Vitest, Chromium, build or VS Code); the drift arithmetic below is derived from the source, not measured. Part 2 S1 shows it as RED first. Every fact below was checked by reading the cited lines.

### Verified facts

- The record names `onUp`, but the defect is wider: the drag path reads the border-box `offsetWidth` twice, and both reads carry the 1 px border.
  - `media-src/src/nav/outline-resize.ts:129`: on mousedown `startW = outlineEl.offsetWidth`. This becomes the basis of every move (`:148`, `pendingW = clampOutlineWidth(startW + delta, innerWidth)`), so the written `--me-outline-width` is already 1 px too wide after any mousemove, even a move that returns to the start x.
  - `:161`: `onUp` stores `finalW = outlineEl.offsetWidth` through `onResize(finalW)` (wired at `media-src/src/boot/finish-init.ts:364-367` to `save-outline-width`). This is the content width plus the border, so the stored value is 1 px more than the var after the last write.
  - `:117`: the initial `aria-valuenow` is `syncSeparatorValue(outlineEl.offsetWidth)`.
- `offsetWidth` includes the border because `.vditor-outline` is content-box.
  - Vditor's rule is `width; border-right: 1px solid; background; display: none; overflow: auto` (`media-src/node_modules/vditor/src/assets/less/_reset.less:582-590`); the right-side variant swaps to `border-left: 1px` (`:591-594`; class set at `vditor/src/ts/ui/initUI.ts:53`). So the border total is always 1 px.
  - The patched rule is `width: min(max(var(--me-outline-width, 200px), 100px), 50vw)` (`build.mjs:493-495`), so `width` sets the content box.
  - VMDE adds only `position: relative; flex-shrink: 0` (`media-src/src/main.css:1978-1981`). No padding or `box-sizing` rule targets the panel (the only universal rule is the reduced-motion block, `main.css:3022-3030`, which has no `box-sizing`). Vditor's `box-sizing: border-box` rules in `dist/index.css` belong to other selectors.
  - Task 650's `outline.spec.ts:565-575` also records that `offsetWidth` is 1 px more than the content width (a comment plus a passing test; not re-measured here).
  - Vditor's own `setPadding` reads `offsetWidth` (`initUI.ts:125,128`) for layout space. That use is correct and unrelated to the stored value.
- Derived drift for a content width V with the var set (`border = 1`):

  | Gesture | Var after | Stored after |
  |---|---|---|
  | mousedown and mouseup, no mousemove | V (`applyWidth` never runs) | V+1 |
  | net move d | V+1+d | V+2+d |
  | move away and back (d=0), per cycle | +1 per cycle (ten cycles: V+10) | var+1 each time |

  - Zero-motion cycles do not compound inside one session. They store V+1, which differs from the var; on the next open the var becomes V+1, so each session that clicks the handle grows the width by 1 px.
  - Move-and-return cycles compound immediately. The brief's "Repeated drags without a size change" must cover this case; a test with only zero pointer movement would miss it.
- With the var unset (no stored width, a new user), the panel shows the CSS fallback 200 px; `offsetWidth` is 201. The first drag therefore starts from 201, and the first keyboard step starts from 201 as well (`currentWidth()` falls back to `outlineEl.offsetWidth`, `:186-191`). The existing test encodes that basis (`media-src/e2e/outline.spec.ts:565-583`, `afterFirstPress = startOffset + 10`).
- Initial `aria-valuenow` quirk, three cases:
  - Var unset: `201` instead of `200`.
  - Var set to V: `V+1` (applied before Vditor is built, `media-src/src/boot/live-config.ts:121-123`).
  - Panel closed at setup (`display: none`): `offsetWidth` is `0`, below `aria-valuemin=100`.
  - Later `syncSeparatorValue` calls come only from `writeWidth` (`:135-138`), so the first value stays until a resize.
- Clamp interaction (Task 650 S3):
  - Display is clamped in CSS (`build.mjs:494`); `shownOutlineWidth` (`outline-resize.ts:38-47`) already gives the shown content width for a stored var, and keyboard steps use it (`:186-191`).
  - The drag path does not: with an oversized var the drag starts from `offsetWidth` (shown+1), so the same bug applies.
- Host and restore: the host stores the raw number (`src/session/editor-session.ts:1568-1573`, `isUsableOutlineWidth` at `:123`; init options at `:392-407`). The webview writes it back as `--me-outline-width` (`live-config.ts:121-123`). No other code reads or rounds the width (grep of `me-outline-width|outlineWidth` over `media-src/src`, `src`, `build.mjs`).
- Existing coverage:
  - Vitest `media-src/src/nav/outline-resize.test.ts` (clamp, `keyboardWidthDelta`, `shownOutlineWidth`).
  - Chromium `media-src/e2e/outline.spec.ts` (keyboard resize `:546-615`, clamp `:617-671`); the harness `media-src/e2e/outline-harness.ts:93-100` exposes only the last persisted width as `__lastOutlineWidth`. No drag case exists.
  - Real VS Code `test/vscode-e2e/outline-state.spec.ts` has `dragResize` (`:131-144`), `outlineView` with `width` (computed content width) and `varPx` (`:42-77`), and `show()` and `toggleOutline()` helpers. It has no assertion on a drag's stored width after reopening.

### Decisions

1. **Stored value = the content width written to the var, never a measurement.** Drag and keyboard both persist the same number the var holds (`${width}px`), so "stored equals `--me-outline-width`" holds by construction. Border and `box-sizing` stop mattering for the width logic.
2. **One basis, no DOM measurement.** The shown content width is `clampOutlineWidth(parseFloat(var) or 200, innerWidth)`. The `200` is the CSS fallback in `build.mjs:494`; a private constant `DEFAULT_OUTLINE_WIDTH = 200` with a comment pointing at that patch. `shownOutlineWidth` loses its `measuredWidth` parameter: new signature `shownOutlineWidth(rawVar, viewportWidth)`. A Chromium case guards the constant against the CSS (the existing default-200 test, `outline.spec.ts:347`, plus the new aria case).
3. **`currentWidth()` is used by drag start, keyboard and the initial `aria-valuenow`.** It must move above its first use (`:117`; it is a `const`, so calling it earlier is a temporal-dead-zone error).
4. **Store what the user's gesture wrote, only when it changed the size.** `onUp` persists the last width `applyWidth` wrote during this gesture, and only when it differs from `startW`. A press with no movement, or a move that returns to the start, posts nothing. Reasons:
   - It satisfies Requirement 2.
   - It adds no `globalState` or Settings Sync churn.
   - It keeps Task 650's rule that the stored value changes only when the user resizes (a click on the handle with an oversized stored 5000 must not overwrite it with the shown 640).
   - Tests assert "every posted value equals S and the var equals S", so they stay valid if a later owner prefers always posting.
5. **Clamp interaction: store the shown (clamped) width the gesture produced, never the user's unclamped intent.** A drag begins at the shown width, and `clampOutlineWidth` already bounds every write, so intent and result cannot diverge. This matches the keyboard path (`setWidthAndPersist` stores the clamped value). A stored oversized value stays untouched until the user actually resizes.
6. **Pure helper for the persist rule:** `widthToPersist(startWidth: number, writtenWidth: number | undefined): number | undefined` returns `writtenWidth` when it is finite, `> 0` and `!== startWidth`, otherwise `undefined`. Exported for Vitest like the neighbouring helpers.
7. **Initial `aria-valuenow` = `currentWidth()`** (the shown content width from the var or the default), also when the panel is closed at setup. No observer change: opening the panel does not change the var, so the value stays correct. Staleness after a window resize is pre-existing and out of scope (Residual risks).
8. **Scope note (necessary consequence, not an expansion by choice):** the keyboard path shares `currentWidth()`; removing its `offsetWidth` fallback changes the first keyboard step from an unset var by 1 px (210 instead of 211). The existing Chromium test that encodes `offsetWidth + 10` must change in the same step. Host, `build.mjs`, `main.css`, `finish-init.ts` and the protocol stay unchanged (`onResize` keeps its `(width: number) => void` shape).

### State / DOM / messages

No new state, message or DOM. `save-outline-width { width }` keeps its shape; only the value changes (content width) and the call is skipped when the gesture left the size unchanged. Harness addition (test only): `window.__outlineWidthPosts: number[]` (every `onResize` value, in order) beside `__lastOutlineWidth`; harness query `?outlineVar=<px>` sets `--me-outline-width` on the body before Vditor is built (mirrors `applyBodyOptions`) so the initial `aria-valuenow` can be checked with a stored width.

### Part 2 steps

One step: **S1** (Light; RED and fix together). Order inside S1:

1. Write the tests below. Run the Vitest file and the Chromium spec; record the failures (RED) in the record.
2. Change `media-src/src/nav/outline-resize.ts` (decisions 1 to 7; update the header comment lines 11-12 and replace the stale basis comment at `:176-184`; comment the `DEFAULT_OUTLINE_WIDTH` link to `build.mjs:493-495` and why drag start no longer reads `offsetWidth`, per `.agents/rules/ts.md`).
3. Re-run Vitest and Chromium (GREEN), then `node build.mjs`, then the real-VS-Code spec.
4. Update the record (Acceptance ticks, progress, test results). Keep `LOCAL_AGENT_TASK.md` §1 table current (orchestrator-owned, untracked).

Owned files:
- `media-src/src/nav/outline-resize.ts`
- `media-src/src/nav/outline-resize.test.ts`
- `media-src/e2e/outline.spec.ts`
- `media-src/e2e/outline-harness.ts`
- `test/vscode-e2e/outline-state.spec.ts`
- `tasks/656-outline-drag-width-drift.md`

Not touched: `finish-init.ts`, `build.mjs`, `main.css`, host files.

Checks (exact):
- `npx vitest run --config test/vitest.config.mts media-src/src/nav/outline-resize.test.ts`
- `node build.mjs`
- `xvfb-run -a npm --prefix media-src run test:e2e -- e2e/outline.spec.ts`
- `env -u ELECTRON_RUN_AS_NODE xvfb-run -a npm --prefix test/vscode-e2e test -- outline-state.spec.ts` (run with `--workers=1 --retries=0` as in Task 650)
- `npm run typecheck`, `npm run typecheck:vscode-e2e`, `npx biome check` on the six files.
- Coverage: `COLUMNS=2000 npx vitest run --config test/vitest.config.mts --coverage --coverage.include='media-src/src/nav/outline-resize.ts' --coverage.reporter=text outline-resize.test.ts`; confirm the new `widthToPersist` lines are not in the uncovered ranges (the `onUp` and drag lines are covered by the Chromium spec, check with `npm --prefix media-src run test:e2e:coverage` if needed).
- Closure gates (`npm run quality`) once per closure batch, not here.

### Tests mapped to Acceptance and edge cases

Vitest, `outline-resize.test.ts` (pure):
- `shownOutlineWidth`:
  - Update the "falls back to the measured width" case: `('', 2000)` gives 200, `('abc', 2000)` gives 200, `('', 300)` gives 150 (the 50% cap beats the default).
  - Keep the oversized, undersized and in-range cases with the two-argument signature.
- `widthToPersist`:
  - unchanged gives `undefined`
  - changed gives the value
  - `undefined`, `NaN`, `0` and negative give `undefined`
  - fractional equal values give `undefined`
- Maps to Acceptance 1 and 2 at the rule level.

Chromium, `media-src/e2e/outline.spec.ts` (drag via `page.mouse` on `.outline-resize-handle`; harness panel is on the right, so dragging left grows):
- **Acceptance 1.** Fresh page (var unset): drag 50 px left. Poll until `parseFloat(var)` is 250. Assert the last `__outlineWidthPosts` entry equals `parseFloat(var)` equals `parseFloat(getComputedStyle(panel).width)`. (RED: var 251, stored 252.)
- **Acceptance 2, move and return.** After the drag above, ten cycles of mousedown, move 20 px away and back to the start x, mouseup (recompute the handle box each cycle; the panel moved). Assert var unchanged and every posted value equals S.
- **Acceptance 2, no movement.** Ten cycles of mousedown and mouseup with no mousemove. Assert var unchanged and every posted value equals S. A variant starting from a fresh page asserts nothing is posted.
- **Clamp interaction.** Var `5000px`, ten zero-motion cycles: var still `5000px`, nothing posted. Then a drag that shrinks by 30 px starts from the shown width: var and stored equal `floor(viewport/2) - 30`. (RED: starts from shown+1.)
- **Initial aria-valuenow:**
  - Fresh page gives `200`.
  - `?outlineOpen=0` gives `200` (RED: `0`).
  - `?outlineVar=321` gives `321` (RED: `322`).
- **Existing test update:** `outline.spec.ts:565-583`: the first keyboard press from the default basis now yields `contentWidthBefore + 10` (210), where the content width is read from computed style before the press; later assertions follow from it.

Real VS Code, extend the existing `outline-state.spec.ts` minimally: no new `test()` block, one section "(e) Task 656" in the first test, inserted after section (a) (editor A is open and shown at width 180):
1. `dragResize(workbox, frame, 40)`; assert `outlineView(frame)` gives `width` 220 and `varPx` 220 (exact: the helper moves by integer pixels from a 180 basis; RED: 221).
2. `show(fileD)` (another file, no close-others): panel open, `width` and `varPx` both 220, which proves the host round trip stores the content width.
3. Ten real mouse down/up cycles on the separator with no movement, one `settle` at the end; then `show(fileC, true)` (all editors closed, a fresh editor): `width` and `varPx` still 220 (RED: 221).
- Why this is the minimum, and why it is needed: the mandate (`AGENTS.md`) requires a written and run real-VS-Code spec for webview behaviour, and Acceptance 3 ("restores as before after reopening") crosses the host `globalState` round trip, which Chromium cannot show. Zero-motion cycles post nothing under decision 4, so there is no write-race cost. The move-and-return case stays Chromium-only (the border arithmetic does not depend on VS Code). Time added: about 15 s of the existing 900 s test.
- Cleanup: the spec's `restoreDefaults` already resets width to 200 and the panel to closed.

Acceptance mapping:

| Acceptance item | Cheapest layer |
|---|---|
| 1 stored equals `--me-outline-width` | Vitest rule and Chromium drag; real-VS-Code step 1 and 2 |
| 2 ten cycles unchanged | Chromium (move-and-return and no-movement); real-VS-Code step 3 |
| 3 restores as before after reopening | real-VS-Code steps 2 and 3, plus the unchanged section (a) |

### Owner questions

None. The stored-value contract, the clamp interaction, the skip-when-unchanged rule and the aria value are technical consequences of the Owner's two requirements. The keyboard first-step change is flagged in decision 8 for the orchestrator.

### Residual risks

- `aria-valuenow` still goes stale after a window resize (the max is recomputed only on a sync; the value follows only a resize action). Pre-existing, outside this task.
- The default `200` lives in two places (`build.mjs:493-495` and the new constant). A comment and the Chromium default-width and aria cases guard against drift between them.
- Fractional pointer coordinates (zoom) could store a fractional width. The var and the stored value are the same number, so equality holds; the host and clamp accept fractions.
- Already-stored widths that carry earlier +1 drift are not corrected; users keep their current width once and then stay stable.
- Left-side panel: the harness only covers the right side. The fix is independent of the side (the border is 1 px on either side and no longer measured).
- Real VS Code has one occasional-launch flake recorded in Task 650 (first launch of the restart case); this step adds no restart case.

## Execution progress — 2026-10-18 (Part 2)

S1 (Vitest and Chromium parts done; the real-VS-Code section (e) is not written or run yet, it waits for the real-VS-Code token).

- RED (before the fix):
  - Vitest `outline-resize.test.ts`: 8 failed, 9 passed (`widthToPersist` missing; the two-argument `shownOutlineWidth` returned the old fallback).
  - Chromium `outline.spec.ts -g "task 656"`: 5 failed. Drag stored var `251` where `250` was expected (Acceptance 1, move-and-return, no-movement cases), the clamp case started from the shown width plus 1, and the initial `aria-valuenow` was `201` where `200` was expected.
- Fix in `media-src/src/nav/outline-resize.ts`: `shownOutlineWidth(rawVar, viewportWidth)` with a private `DEFAULT_OUTLINE_WIDTH = 200`, the new pure `widthToPersist`, `currentWidth()` moved above its first use and used for drag start and the initial `aria-valuenow`, and `onUp` persists only the width the gesture wrote when it differs from the start width. Harness: `__outlineWidthPosts` and `?outlineVar=<px>`. The first keyboard step from an unset var now gives 210 (decision 8); the existing keyboard case was updated.
- GREEN:
  - Vitest `outline-resize.test.ts` and `finish-init.test.ts`: 28 passed.
  - Chromium `outline.spec.ts` (whole file): 29 passed.
  - `npm run typecheck` and `npx tsc --noEmit -p ./`: exit 0.
  - `npx biome check` on the four changed source and test files: clean.
  - Coverage of `outline-resize.ts` from Vitest: `widthToPersist` lines are covered (uncovered ranges are the DOM setup and drag lines, covered by Chromium).
- Not done yet: real-VS-Code section (e) in `test/vscode-e2e/outline-state.spec.ts`, `npm run typecheck:vscode-e2e`, and biome on that file.
- Acceptance stays unticked until the real-VS-Code run: Acceptance 1 and 2 are proven in Chromium (drag, move-and-return and no-movement cases), Acceptance 3 needs the host round trip.

### Real-VS-Code (S1 continued)

- Section (e) added to test 1 of `test/vscode-e2e/outline-state.spec.ts`: a real drag of 40 px from width 180 gives panel and var 220; another file opens at 220; ten real press-and-release cycles with no movement, then a fresh editor still opens at 220. Result with the fix: `outline-state.spec.ts` both tests passed (2 passed, 1.9m, exit 0). The failing-before-fix run in real VS Code was not repeated (the 221 failure is shown by the Chromium RED above).
- Scope addition (orchestrator): the restart test now uses a user-data directory of its own (`restart-user-data` under `baseDir`, recreated at the test start) instead of the shared user-data, so state left by other specs cannot leak into it; the extensions dir is unchanged. The leak could not be reproduced in this worktree: the test cache is a per-run temporary directory and the old restart test passed against it, both alone and after `default-open-mode`, `escape-toolbar` and `outline-keyboard` in one run.
- Found: `test/vscode-e2e/outline-keyboard.spec.ts:177` expects `offsetWidth + 10` for the first keyboard step (211); with the fix it is 210 (decision 8). That file is not owned by this step; it needs the same update as the Chromium case (open question).
- `test/vscode-e2e/outline-keyboard.spec.ts` (approved addition): the first keyboard step now expects the computed content width plus 10 (was `offsetWidth + 10`). `outline-keyboard.spec.ts` and `outline-state.spec.ts` together: 3 passed.
- `preview-memory.spec.ts` restart test fails in the first launch before any Outline code runs (the VMDE webview frame never appears within 30 s at the quick-open step); not caused by this task.
- Cross-task test-isolation fix (orchestrator scope addition; to be committed separately as `test(657): give the Preview restart test its own user-data directory`): `preview-memory.spec.ts` restart test now uses `restart-user-data` under `baseDir` (recreated at test start), waits for no other main VS Code process of the install, attaches launch-failure artifacts, and focuses Quick Open before filling it. Runs: before any edit 2 of 2 failed at the first Quick Open; with isolation only, 1 failed (first launch: another VS Code still running) and 1 passed; with the process wait added, 1 failed (second launch: Quick Open input did not hold focus) and 1 passed; with the focus check added, 1 passed and 2 failed (second launch, a later Quick Open in the same launch, Quick Open never took focus). Not yet passing reliably; the orchestrator's combined run decides next steps.

**Orchestrator note (2026-10-18):** the `preview-memory.spec.ts` restart-isolation attempt above was reverted from this task (still flaky: Quick Open focus in the second launch); its patch and run history move to Task 665.

**Combined real-VS-Code runs (2026-10-18, integration build of dev + 652 + 653 + 654 + 656, `--workers=1 --retries=0`):** round 1 `outline-state.spec.ts` section test and `outline-keyboard.spec.ts` passed; the restart test failed (inline init probe missed the init). After the probe fix, round 3 `outline-state.spec.ts:635` (restart) passed.
