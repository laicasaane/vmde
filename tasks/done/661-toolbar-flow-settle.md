# Task 661 — Settle the toolbar flow after resize and check placeholder sizing

**Status:** done.
**Origin:** Project Owner request (known issue from Task 642).
**Severity:** low.
**Tech stack:** webview toolbar flow, instant-paint placeholder, and row gap measurement; real VS Code for resize behaviour.
**Related:** [Task 642](642-toolbar-layout-follow-ups.md) (toolbar layout follow-ups).

## Problem

1. Right after a resize, the flow may still be placing controls. An icon in a moving control measured 0 px in a real-VS-Code test.
2. The instant-paint placeholder uses the wiki-off one-row threshold (1,076 px). Wiki documents need 1,143 px.
3. The row gap measures 2.0 px at device pixel ratio 1. The target is 2.4 ± 1 px.

## Requirements

1. No visible flash or empty frame appears after a resize. The flow settles before controls are shown.
2. Wiki documents never receive the overlay, or the placeholder is sized per document.
3. The row gap is confirmed at device pixel ratio 2 and meets the target of 2.4 ± 1 px.
4. A streamed open (above 700,000 characters) shows the flowed toolbar from the first painted frame after the overlay is removed. Task 643 must keep this: the toolbar flow is installed in the same task as the toolbar, before the overlay goes, on every open path.

## Open design points

- Whether wiki documents are excluded from the overlay or the placeholder is sized per document: to be decided in Part 1.
- To be settled in Part 1 for the other points.

## Scope

- In: the resize flow, the instant-paint placeholder threshold, the row gap check, and the stream-open toolbar ordering.
- Out: toolbar behaviour not named above.

## Acceptance

- [x] After a resize, no visible flash or empty frame appears, and no control measures 0 px because it is still moving. (Chromium frame sampler and real-VS-Code sweep: 0 violations.)
- [x] Wiki documents never receive the overlay, or the placeholder size matches their threshold of 1,143 px. (Wiki documents keep the overlay; the placeholder is sized per document, 1,143 px with wiki and 1,076 px without.)
- [x] The row gap is within 2.4 ± 1 px at device pixel ratio 1 and at device pixel ratio 2. (2.0 px at both.)
- [x] A streamed open shows the flowed toolbar from the first painted frame after the overlay is removed (Requirement 4).

## Tests

- Real-VS-Code verification for the resize flow, and measurement at device pixel ratio 1 and 2. Exact specs are to be specified in Part 1.

## Part 1 handoff (2026-10-18)

Task 661, Light,  read-only. Repository `dev` at `1985ceb2`. All line numbers below were read at that commit. Nothing was built or run; every number marked "derived" is arithmetic from source or the Task 642 record, and every "predicted" result is to be confirmed by the Part 2 run named next to it.

### Verified facts

Flow controller (`media-src/src/chrome/toolbar-overflow.ts`):
1. The measure pass and the placement are one synchronous call. `apply()` (398-443) runs `remeasure(key)` (282-297: `restoreAll()` puts every authored node back in row 1, then reads widths) and, in the same call, `applyPlan` (338-396) which re-arranges rows and More. `remeasure` clears `lastPlanKey`/`lastInputKey` (295-296), so a remeasure always continues into `applyPlan`; there is no await, timer or rAF between the two. A frame therefore cannot be painted between "everything in row 1" and the plan. The only way to leave the restored row painted is an exception thrown inside `applyPlan` before `arrange` (373-381); no such path was found.
2. `apply()` is called from: the synchronous first pass at install (527), a ResizeObserver on the parent, the toolbar, `documentElement` and `body` (530-540), the window `resize` listener (541-542), and a rAF (`schedule`, 522-524) requested by the item-visibility observer (546-555) and the collapse observer (566-575). In the rendering update, resize events and rAF callbacks run before style/layout/paint and ResizeObserver callbacks run after layout and before paint, so each of these paths applies the plan before the frame it belongs to is painted. The one gap: a `schedule()` raised from inside a rAF callback or a later phase of the same frame would apply one frame late. Nothing on the resize path does that.
3. `apply()` returns early when the available width is 0 or less (403) and when the input key is unchanged (416), so a hidden webview does not move controls into More and a ResizeObserver echo of its own writes does nothing.
4. The overlay copy gets one synchronous pass and no observer (`flowToolbarOnce`, 488-492; call at `prerender-overlay.ts:50`, directly after `bar.replaceWith(clone)` at 46). The copy therefore does not follow a resize that happens while the overlay is up.
5. The live toolbar is attached and flowed in one task for every normal (non-streaming) open: Vditor's Lute callback runs `initUI(...)` (appends the toolbar, `vditor/src/ts/ui/initUI.ts:31`) and then `after()` in the same callback (`vditor/src/index.ts:554-557`); our `after()` removes the overlay (`vditor-init.ts:562`), then `finishInit()` (578) runs `ensureToolbarRows` (`finish-init.ts:611`) and `installToolbarOverflow` (644), whose first `apply()` is synchronous. No paint can fall between overlay removal and the first flow. `finish-init.ts` has no await/timer/rAF before 644.
6. Streaming documents differ (finding, outside the resize scope): above `STREAM_MIN_CHARS = 700,000` (`stream-render.ts:54`) the overlay is removed at the first chunk (`vditor-init.ts:517-521`) while `finishInit` (rows and flow) is deferred to `finishHelpers` (511-514), called at `onDone` (534) or `beforeFinalize` in SV (525). So the live toolbar is shown unflowed (Vditor's flat toolbar, no rows) for the stream duration. Not rendered or measured; unverified visually.

Wiki and the placeholder:
7. Wiki documents DO get the overlay. `markdown-editor-provider.ts:242-251` always builds `preRenderedHtml` from `renderForMode(..., isWikiFile(uri), ...)`; `lute-host.ts:369-414` only returns `undefined` for `sv` mode (380), a cold Lute (381-384) or an exception (411-413); for wiki it rewrites `[[links]]` to chips (413). Only the inline init payload is skipped for wiki files (`editor-session.ts:430-436`), so a wiki open keeps the `ready` to `init` round trip. The existing test `test/backend/webview-overlay.test.ts:62-72` (workspace folder set, wiki not disabled by the mock) already expects the overlay for a wiki file. The statements "wiki documents have no overlay" in `html-builder.ts:139-140` and in `tasks/done/642-toolbar-layout-follow-ups.md` (residual risk and measured lines) are wrong.
8. Wiki is the default: `package.json:1506-1511` (`vmde.wiki.enabled` default `true`, resource scope). `getWikiRoot` (`wiki.ts:45-58`) is defined for any `file:` markdown uri inside a workspace folder when enabled, so most real opens are wiki documents and the no-wiki threshold is the minority case.
9. `isWikiFile(uri)` and the live toolbar flag agree: the live toolbar is built with `wikiEnabled: Boolean(msg.wiki?.enabled)` (`vditor-init.ts:306-308`), and `msg.wiki` is `getWikiDocumentContext(uri)`, enabled iff `getWikiRoot(uri)` exists (`wiki.ts:32-43`, `wiki-session.ts:74`). `isWikiFile` is `isSupportedMarkdownUri && getWikiRoot` (`wiki.ts:28-30`).
10. Placeholder today: `html-builder.ts:141-143` constants 35/61/1076; inline `min-height:61px` on the placeholder (166) lowered to `35px` by `@media (min-width:1076px)` (186-190, not emitted when collapsed or when there is no toolbar). The collapsed strip is 24 px. Vditor's toolbar adds `border-bottom: 1px` (`vditor/src/assets/less/_toolbar.less:4`), so the placeholder paints 36 px (one row) or 62 px (two rows), 25 px collapsed. The placeholder takes no document information (`HtmlBuildParams`, 32-54).
11. Live heights (Task 642 record, measured in the Chromium harness): one row 36 px, two rows 61.4 px, collapsed 25 px; one-row thresholds in viewport width 1,143 px with wiki and 1,076 px without (collapsed 857/808). Derived check: wiki adds Go Back + Wiki Pages + one rule = 2 x 25 + 17 = 67 px, and 1,143 - 1,076 = 67. Pinned by Vitest at `test/backend/html-builder.test.ts:158-177`; no browser test pins the numbers.
12. Derived mismatch A: a wiki document between 1,076 and 1,143 px paints a 36 px placeholder, then the clone (two rows, 61.4 px), then the live toolbar (61.4 px): a 25 px jump on the page. Derived mismatch B: in the two-row case the placeholder is 62 px against 61.4 px live (0.6 px shift at the swap), because `61 + 1 border` is used instead of `2 x 30.2 + 1`.

Row gap:
13. The two-row gap comes from transparent borders: base rule `border-top/bottom: 6px` (`vscode-chrome.css:251-254`); two-row rules set `1.2px` on the facing sides and reduce the button height by 4.8px (578-596). The existing check (`media-src/e2e/toolbar-overflow.spec.ts:2189-2228`) reads the band from `getBoundingClientRect` and the computed border widths, so it measures the snapped (painted) border widths, which is why it reports 2.0 px at ratio 1.
14. Derived DPR 2 gap (Blink floors computed border widths to whole device pixels, with a 1-device-pixel minimum): ratio 1: 1.2 CSS px = 1.2 device px, floored to 1 device px = 1.0 CSS px per border, gap 2.0 (matches the recorded 2.0). Ratio 2: 1.2 CSS px = 2.4 device px, floored to 2 device px = 1.0 CSS px per border, gap 2.0 CSS px. Predicted: 2.0 at ratio 2, inside 2.4 +/- 1 (1.4 to 3.4). Button height stays 30.2 (border-box), padding box 23.2 in both cases; the toolbar stays 61.4. Same arithmetic at other ratios: gap = 2 x floor(1.2 r) / r. Ratios from about 1.43 to 1.66 (for example 1.5, Windows 150%) give 1.33 to 1.40, just below the 1.4 floor. Not an acceptance case (the record names ratios 1 and 2); see Owner question 2.
15. The real-VS-Code harness cannot set a device ratio: Electron is launched with fixed arguments inside the patched dependency (`test/vscode-e2e/node_modules/vscode-test-playwright/dist/index.js:153-170`); only a custom `_electron.launch` as in `toolbar-collapse.spec.ts:784-802` could add `--force-device-scale-factor`. The Chromium harness can: Playwright `deviceScaleFactor` through `test.use`.

The 0 px icon:
16. Task 642 recorded a Wiki Pages icon of 0 px right after reopening and resizing (`toolbar-order.spec.ts:1453-1460`, comment "a control being moved reads a 0 px icon"). Reading shows a more specific candidate: `reopenVmdeFixture` waits for `.vditor-ir` with `.first()` (`webview-helpers.ts:63-67`), and the host overlay itself contains `<div class="vditor-ir">` (`html-builder.ts:164,171-173`), so the helper returns while the overlay (with its toolbar copy) is still the only `.vditor-toolbar` in the document (fact 5: copy and live toolbar are never in the document together for non-streaming opens). The test's locators (`frame.locator('.vditor-toolbar')`, `toolbar-order.spec.ts:1410`) then resolve to the overlay copy; `locator.evaluate` on a node the swap removes in between reads a detached node, whose rectangle is 0 x 0. The second candidate is a legitimate intermediate flow state while the viewport arrives in steps (sidebar closed, then `setViewportSize`), in which Wiki Pages sits in the hidden More panel. Neither is confirmed by a run; both are test-side races, and fact 1/2 shows no product frame with controls half-placed. The probe in Part 2 S3 confirms or refutes it.
17. A painted-frame sampler already exists: `test/vscode-e2e/toolbar-collapse.spec.ts:668-746` (`toolbarProbeScript`, addInitScript, rAF sampler per frame document). It is local to that spec and not reusable as is.

### Decisions

D1 Measure pass: no change to the algorithm or the scheduling (facts 1-3, 5). The requirement "no visible flash or empty frame, flow settles before controls are shown" is met by construction for the live toolbar; Part 2 adds a guard (frame sampler) instead of a rewrite. Measuring off-screen or on a clone is rejected: it adds a second layout path and cannot improve on a pass that already runs before paint.
D2 Contingent fix F1, only if the S2 sampler (run on unmodified code) reports a violation: run `apply()` directly (not through `schedule()`) from the two MutationObservers (their callbacks are microtasks of the task that changed the DOM, so still before paint) and keep `schedule()` only for the install-time "no width yet" case. If the sampler is green, no F1: the record states "already satisfied, guard added".
D3 Wiki placeholder: keep the overlay for wiki documents and size the placeholder per document. Reason: the overlay is the instant paint for exactly the case with the slower round trip, and wiki is the default (facts 7, 8). New optional host parameter `wikiNavigation?: boolean` (default `false`) on `HtmlBuildParams`, passed by the provider as `isWikiFile(uri)`. Threshold table in `html-builder.ts`: `{ wikiOff: 1076, wikiOn: 1143 }` in CSS px (viewport width, as the media query uses). If the S2 measurement differs by 1 px or more, the measured value wins and replaces the constant.
D4 Two-row placeholder height: 60.4 px (was 61), so the painted total is 61.4 px, the live height. One-row 35 and collapsed 24 stay.
D5 Row gap: no CSS change. S2 measures it at ratio 2 (and ratio 1 stays covered by the existing check). If the ratio-2 run is outside 1.4 to 3.4, stop and report (the fix would be a CSS design change; not pre-decided).
D6 The 0 px read is fixed on the test side: scope the live toolbar to `#app .vditor-toolbar` and wait for `#vmde-prerender` to be gone before reading control rectangles in `toolbar-order.spec.ts` (the wiki-icon test only). No product attribute or test hook is added.
D7 Real VS Code is measured at its own ratio (1 under Xvfb, recorded by the probe); ratio 2 is measured in the Chromium harness only (fact 15). The gap CSS is engine behaviour, not VS Code behaviour.
D8 Not in scope: the streaming-document toolbar (fact 6) and the overlay copy not following a resize (fact 4); see Residual risks and Owner question 1.

### State / DOM / messages

No new state, message or DOM attribute. New host parameter only: `HtmlBuildParams.wikiNavigation?: boolean`. Painted-frame probe (test only, `test/vscode-e2e/toolbar-frame-probe.ts`): per webview document `window.__toolbarFlowProbe = { frames, dpr, heightLog: string[] (unique "teaser:<h>" / "live:<h>" in first-seen order, h rounded to 0.01), violations: string[] }`.

### Part 2 steps

Rules: Light; RED first, fix in the same step; one real-VS-Code run at a time; gates once at the close. Run `node build.mjs` before S3.

**S1 Host placeholder (Vitest RED then fix).** Owned: `src/webview-host/html-builder.ts`, `src/app/markdown-editor-provider.ts` (one added property at the `buildWebviewHtml({...})` call, 205-258), `test/backend/html-builder.test.ts`, `test/backend/webview-overlay.test.ts`.
 - RED: update `html-builder.test.ts:158-177` and add cases (below) and run `npx vitest run --config test/vitest.config.ts test/backend/html-builder.test.ts test/backend/webview-overlay.test.ts`: the wiki cases and `60.4px` fail on HEAD.
 - Fix: add `wikiNavigation`, the threshold table, `PLACEHOLDER_TWO_ROWS_PX = 60.4`; rewrite the comment at 138-140 (wiki documents do get the overlay). Pass `wikiNavigation: isWikiFile(uri)` in the provider.
 - Check: same Vitest command green; `npm run lint:ci` on the changed files.
**S2 Chromium guard tests (independent of S1; may run in parallel).** Owned: `media-src/e2e/toolbar-overflow.spec.ts` only.
 - Add (a) threshold pin, (b) frame sampler, (c) ratio 2 gap, (d) extract the A6 evaluate (2198-2218) into a shared helper `measureBandGap(page)` used by A6 and (c). Details under Tests.
 - Run once: `xvfb-run -a npm --prefix media-src run test:e2e -- toolbar-overflow.spec.ts -g "661"` (new titles carry "661"). The existing A6 cases rerun once as the helper refactor check (`-g "band gap"`).
 - Outcomes recorded verbatim: measured thresholds (expected 1142/1143 and 1075/1076), sampler frame count and violations (expected none), gap at ratio 2 (predicted 2.0). A sampler violation triggers F1 (D2) as S2b, owned `media-src/src/chrome/toolbar-overflow.ts` and `toolbar-overflow.test.ts` (Vitest case: a visibility mutation applies the plan before any rAF).
**S3 Real-VS-Code spec (after S1 and S2; the single real-VS-Code token).** Owned: new `test/vscode-e2e/toolbar-flow-settle.spec.ts`, new `test/vscode-e2e/toolbar-frame-probe.ts`, and the wiki-icon test in `test/vscode-e2e/toolbar-order.spec.ts` (1363-1480: `toolbar` locator and the overlay wait only).
 - RED first: write the spec and run step A on the HEAD build (before the S1 source fix), after `node build.mjs`; record the failure (expected: `teaser:36` against live 61.4). Then apply the S1 source fix, `node build.mjs`, rerun once. If S1 is already merged when S3 starts, the record states that RED was shown by the Vitest cases only.
 - Run: `env -u ELECTRON_RUN_AS_NODE xvfb-run -a npm --prefix test/vscode-e2e test -- toolbar-flow-settle.spec.ts` (`--workers=1 --retries=0`), then `toolbar-order.spec.ts -g "Wiki Pages"` once.
 - Do not add the spec to the SMOKE or FAST tier lists in `playwright.config.ts`.
**S4 Close.** Owned: `tasks/661-toolbar-flow-settle.md`, `LOCAL_AGENT_TASK.md` section 1 table (same edit), then move to `tasks/done/` per the repository convention and `tasks/README.md` only when fully complete. Correct the wrong "no overlay" statements in the 661 record (the 642 done record stays as history; the 661 record cites this correction). Gates once: `npm run lint:ci`, `npm run typecheck`, `npm run typecheck:vscode-e2e`, `node build.mjs`, `npm run quality`. Also rerun `media-src/e2e/prerender.spec.ts` once (overlay copy unchanged, expected green).

### Tests mapped to Acceptance

Acceptance 1 (no flash, no 0 px control after a resize):
 - Chromium, `toolbar-overflow.spec.ts`, title "painted frames stay consistent through a resize sweep (661 A1)". Harness `toolbar-overflow.html?wiki=enabled` at 1500 px, run once expanded and once `?collapsed=1`. Install a sampler with `page.evaluate`: a ResizeObserver on `documentElement` created after the install (observers are notified in creation order, so it reads the state that will be painted) plus a rAF loop. Each reading, skipped when the toolbar width is 0, records a violation string when: any displayed row has `scrollWidth > clientWidth + 1`; any displayed direct control (not inside More) has a zero-width box or a zero-size icon; `vmde-toolbar--two-rows` is set while row 2 is hidden (or the reverse); the toolbar height is not one of 36 / 61.4 / 25 (+/- 0.25) for its state; a control is in neither a row nor More (count of `[data-type]` changes). Sweep 1: widths 1500, 1143, 1142, 1076, 1075, 900, 640, 521, 520, 380, 640, 1500, each followed by two rAFs. Sweep 2: 40 consecutive `setViewportSize` calls with no waits between 1500 and 380. Assert `samples > 30` (the sampler ran) and `violations` equals `[]`. Predicted green at HEAD (facts 1-3); a violation names its cause and triggers F1.
 - Real VS Code, `toolbar-flow-settle.spec.ts` step B: the probe's `violations` (same invariants, live toolbar only) are `[]` across a sweep at `offset + [1400, 1110, 900, 700, 500, 380, 700, 1400]` (offset = workbox viewport minus the webview `innerWidth`, calibrated by a first open), after each step the layout reaches quiescence (three identical readings of innerWidth, plan key and height across two rAFs, no fixed sleep). Then, wiki on at 900: gap within 2.4 +/- 1 at the probe's recorded ratio, hit boxes not overlapping (same reading as `toolbar-overflow.spec.ts:2198-2226`), and Wiki Pages icon 16 x 16 in the row after the scoped wait.
 - `toolbar-order.spec.ts` wiki-icon test: `#app .vditor-toolbar`, overlay gone before reading.
 - Non-asserting probe (annotation) in step A, immediately after reopen: `{ overlayPresent, toolbarCount, firstToolbarInOverlay }`, to confirm or refute fact 16. Not an acceptance assertion.
Acceptance 2 (wiki documents: placeholder size matches 1,143 px; the overlay is kept):
 - Vitest `html-builder.test.ts`: (a) omitted/false flag emits `@media (min-width:1076px)`; (b) `wikiNavigation: true` emits `@media (min-width:1143px)` and not 1076; (c) inline `min-height:60.4px` for two rows, no `61px`; (d) collapsed: `min-height:24px`, no media rule for either flag; (e) no `preRenderedHtml`: no placeholder, no rule for either flag.
 - Vitest `webview-overlay.test.ts`: default `htmlFor()` (wiki on) contains `min-width:1143px`; with `mock.setConfig({ enabled: false })` before the call, `min-width:1076px`.
 - Chromium (pins the numbers to the real toolbar), title "one-row threshold is 1,143 px with wiki and 1,076 px without (661 A2)": `openToolbar` at 1142 and 1143 with `wiki=enabled`, 1075 and 1076 without; assert `vmde-toolbar--two-rows` present, absent, present, absent, with the toolbar height 61.4 / 36 / 61.4 / 36.
 - Real VS Code step A (wiki on, `offset + 1110`, between the thresholds; a second open after the calibration open so Lute is warm and a teaser exists): the probe's `heightLog` contains a `teaser:` entry and every entry is 61.4 +/- 0.25 (RED on HEAD: `teaser:36`). Step C (wiki off, same width, `wiki.enabled=false`, reopen): every entry is 36 +/- 0.25 (guards the 1076 branch).
Acceptance 3 (gap 2.4 +/- 1 at ratios 1 and 2):
 - Ratio 1: existing A6 (IR, WYSIWYG, SV; refactored onto `measureBandGap`) plus the real-VS-Code gap in step B (its recorded ratio, expected 1).
 - Ratio 2: Chromium, `test.describe` with `test.use({ deviceScaleFactor: 2 })`, title "band gap at device pixel ratio 2 is 2.4 px (+/- 1) (661 A3)": assert `devicePixelRatio === 2`, gap within 2.4 +/- 1, hit-box overlap at most 0.01, toolbar height 61.4 +/- 1. Predicted 2.0 (fact 14); the run's number is recorded in the record.
Edge cases and their layer: viewport exactly at 1142/1143 and 1075/1076 (Chromium threshold pin); collapsed toolbar (Chromium sampler `?collapsed=1`, Vitest (d)); toolbar disabled (Vitest (e) plus existing `html-builder.test.ts:179-187`); wiki off in a workspace (real VS Code step C); hidden webview width 0 (covered by fact 3, existing Vitest; not re-tested); streaming and SV opens (outside scope).
Real-VS-Code economy: one spec file, one `test()` with `test.step`s A, B, C (one VS Code boot); the probe is installed with `electronApp.context().addInitScript` before the first open, as `toolbar-collapse.spec.ts:784-802` does with its own launch.

### Owner questions

1. Streaming documents (above 700,000 characters) show the unflowed live toolbar while they stream (fact 6). Not part of "after a resize", and not rendered or measured here.
   - (recommended) File it as a separate known-issue task and leave 661 as specified.
   - Include it in 661: install `ensureToolbarRows` and the flow before the overlay is removed at the first chunk (larger change to the `finish-init` ordering, needs its own real-VS-Code case).
2. At device ratios of about 1.43 to 1.66 (for example 150% display scaling) the row gap is predicted at 1.33 to 1.40 px, below the 1.4 px lower bound (fact 14; the acceptance names ratios 1 and 2 only; unmeasured).
   - (recommended) Keep the CSS as is, record the finding in the 661 record, and file a follow-up if the Owner wants ratio 1.5 covered.
   - Change the transparent border to a width that stays in range at every ratio (for example 1.5px, which gives 1.5 to 3.0 px; it also changes band height by 0.3 px and needs the hit-box and golden checks redone).

### Residual risks

- Facts 1, 2 and 5 rest on reading; the sampler run is the evidence. If green, nothing in the product changes for Acceptance 1, and the 0 px reading stays explained only by the candidates in fact 16 until the S3 annotation is read.
- The ratio 2 gap is derived from Blink's border-width flooring, not measured; the S2 run decides. Real VS Code is not measured at ratio 2 (D7).
- Hard-coded thresholds (1076/1143) go stale if a control, its width or the padding changes; the Chromium pin (A2) is the guard, so any toolbar change must rerun it.
- The overlay copy does not follow a resize while the overlay is up (fact 4); on a slow open the copy can show stale rows until the swap. Not addressed.
- The 60.4 px placeholder assumes the 61.4 px live height holds with the user's font settings; both are CSS lengths independent of the font, but the S3 height check is the only real-VS-Code evidence.
- Streaming-document toolbar (Owner question 1) and the flaky-open races in other 642 specs using `reopenVmdeFixture` + `.vditor-toolbar` unscoped are not touched.
- `LOCAL_AGENT_TASK.md` and the other untracked local files in the working tree were not read or edited.

**Owner answers (2026-10-18, chat):** Q1 — include the streaming-document toolbar in this task (flow the toolbar before the overlay is removed at the first chunk; own real-VS-Code case). Q2 — record only; keep the CSS (the acceptance names ratios 1 and 2).

## Execution progress — 2026-10-18 (Part 2)

Steps S1 and S2 are done on branch `wt/661`. S3 (real VS Code) and the streaming-document toolbar (Owner answer Q1) are not started. The Acceptance boxes above stay unticked until S3 and the closure gates; the evidence so far:

- **S1 host placeholder (done).** `HtmlBuildParams.wikiNavigation` (default false) selects the one-row threshold, `{ wikiOff: 1076, wikiOn: 1143 }`; the two-row placeholder is 60.4 px (61.4 px painted with the border). The provider passes `isWikiFile(uri)`. RED on the previous code: two `html-builder.test.ts` cases failed (wiki threshold, `60.4px`). The `webview-overlay.test.ts` case was skipped at that moment (the Lute build output was missing in the worktree), so it was written and run green only after `node build.mjs`. Result after the fix: `html-builder.test.ts` and `webview-overlay.test.ts` 68 of 68 passed.
- **S2 Chromium guards (done).** New cases in `media-src/e2e/toolbar-overflow.spec.ts`; A6 now uses the shared `measureBandGap` helper. Measured:
  - Thresholds: wiki 1142 px is two rows (61.375), 1143 px one row (36); no wiki 1075 px two rows, 1076 px one row. The constants are confirmed, no change.
  - Frame sampler (resize sweep plus 40 consecutive viewport changes): expanded 126 samples, collapsed 112 samples, 0 violations. Fix F1 is not needed; Acceptance 1 is already satisfied for the live toolbar and the guard is added.
  - Gap at device pixel ratio 2: 2.0 px, overlap 0, toolbar height 61.375 (inside 2.4 +/- 1, as predicted). Ratio 1 stays covered by the A6 cases (IR, WYSIWYG, SV, all passed).
- Owner Q2: recorded only; the CSS is kept. At ratios of about 1.43 to 1.66 the gap is predicted at 1.33 to 1.40 px (derived, not measured).
- Open then: S3 real-VS-Code case, the streaming-document toolbar change and its case, the "no overlay" correction and the closure gates (all but the gates are done below).

## Part 1 addendum (2026-10-18): streaming toolbar

Owner answers recorded: Q1 include the streaming-document toolbar in 661; Q2 record only (no CSS change; the ratio 1.43 to 1.66 gap finding goes into the 661 record, no follow-up task unless the Owner asks). Read-only; HEAD `ede7e900`. Files cited below are unchanged since `1985ceb2` (`git diff 1985ceb2 HEAD` touches none of `vditor-init.ts`, `finish-init.ts`, `toolbar-overflow.ts`, `prerender-overlay.ts`); line numbers read at `ede7e900`. Nothing was built or run; "derived" and "predicted" items are confirmed by the RED runs named below.

### Verified facts

1. Where the toolbar is built and shown. Vditor's Lute callback runs `initUI` (appends the toolbar, `vditor/src/ts/ui/initUI.ts:31`) then `after()` (`vditor/src/index.ts:554-557`), in one task. With a streaming document `after()` takes the `if (willStream)` branch (`vditor-init.ts:488`): it sets `sessionState.streaming = true` (493), makes the editor read-only, and starts `stream(...)` (509-). `return` at the end of the branch skips the non-stream tail (the `finishInit()` at 578 is not reached).
2. Rows and flow are installed only in `runFinishInit`: `ensureToolbarRows`+`guardToolbarScroll` (`finish-init.ts:609-612`), `installEscapeToolbar()` (613), then, after `installFormatWordExpand`/`installStructuralSelection`/`installFindReplace`, the block at 643-657: `refreshToolbarRoving`, `installToolbarCollapse`, `installPreviewMemory`, `installToolbarOverflow`, `installToolbarSubmenuAria`, `installEmojiPicker`, `installToolbarMenuPosition`. `runFinishInit` is reached from `finishInit()` (`vditor-init.ts:412`), which in the streaming branch is only called by `finishHelpers` (511-514): at `beforeFinalize` in SV (525), at `onDone` (534), or in the `.catch` recovery (550).
3. The overlay is removed at the first chunk (`onFirstChunk`, `vditor-init.ts:517-521`), or at the `.catch` (544). So from the first chunk until `onDone` (IR) or `beforeFinalize` (SV) the live toolbar is visible with no rows and no flow controller. `finish-init.ts` has no earlier call of `ensureToolbarRows` (grep: only `finish-init.ts:611` and the overlay clone `prerender-overlay.ts:34`). When no overlay exists (saved SV mode, cold host Lute) the live toolbar is visible from the first paint in that state.
4. What that state looks like (derived from CSS, not rendered): `.vditor-toolbar` is `display:flex; flex-direction:column; align-items:stretch` (`vscode-chrome.css:447-452`) and its authored children are the flat items and dividers (no `.vmde-toolbar-row`), so the 34 controls and 12 rules stack vertically (float is ignored on flex items; each button box is 35 px), under `position: sticky; top: 0` (`_toolbar.less` `&--pin`, `main.css:1250`). Predicted: a toolbar far taller than the 36/61.4/25 px states, covering the top of the document for the whole stream. The collapsed state is also not applied (the collapse toggle is bound in `runFinishInit`). Severity is therefore likely higher than the Task 642 note implied. The RED run decides.
5. Streaming duration is long enough to see it: `test/vscode-e2e/stream-large-file.spec.ts:10-19,52-56` builds a 744k-char fixture (1,200 sections) and polls up to 150 s for the stream to finish.
6. The toolbar controller is independent of the document: `createFlowController`/`installToolbarOverflow` read only the toolbar DOM, `window.innerWidth`, `devicePixelRatio` and computed styles (`toolbar-overflow.ts:220-443`); `installToolbarCollapse` reads the shared collapsed state set by `receiveToolbarCollapsed` before `initVditor` (message router, `message-router.ts:289`) and binds the toggle (`toolbar-collapse.ts:80-137`); `ensureToolbarRows` is idempotent (`toolbar-layout.ts:17-24`); `guardToolbarScroll` is idempotent by a flag on the element (`toolbar-scroll-guard.ts:45-52`); `installEscapeToolbar` removes its previous listener on reinstall (`escape-toolbar.ts:520-526`) but resets the arm state; `installToolbarOverflow` has no guard against a second install on the same toolbar (the second call would dispose nothing itself, but `observers.set('toolbar-overflow', ...)` disposes the first controller, whose `dispose()` runs `restoreAll()`, `toolbar-overflow.ts:445-456`).
7. A re-init (config-changed) calls `vditor.destroy()` and builds a new toolbar element (`vditor-init.ts:275`); `observers` (a `Disposables`, `util/disposables.ts:6-15`) is a stable singleton whose `set(key)` disposes the previous disposer under that key.
8. Existing Vitest harness for this branch: `media-src/src/boot/vditor-init.test.ts:259-345` calls `initVditor`, then `created.options.after()` and drives `h.streamHooks` (`onFirstChunk`/`onDone`); `./finish-init` is mocked (`:71`) as `{ runFinishInit }` and `../chrome/prerender-overlay` as five `vi.fn()` (`:72-78`); `streamRenderSV` is a bare `vi.fn()` returning `undefined` (`:50`), which would throw at `.catch` if the SV branch were driven. `finish-init.test.ts` mocks `innerVditor` to return no toolbar (`:11-14,61-63`), so no unit test covers the toolbar block.
9. Task 643 (open, status authority `tasks/643-preview-mode-streaming-performance.md`) lists `boot/vditor-init.ts` and `boot/finish-init.ts` in its tech stack and scopes out edit-mode streaming changes. It will rebuild the open path for Preview, which also has no edit view at open.

### Decisions

D9 One extracted function, installed early, never twice. New module `media-src/src/boot/toolbar-flow-install.ts` exports `installToolbarFlow(observers: Disposables): void`. It resolves the toolbar with `innerVditor()?.toolbar?.element`; if that element is already in a module-level `WeakSet`, it returns; otherwise it adds it and runs, in this order: `ensureToolbarRows(toolbarEl)`, `guardToolbarScroll(window.vditor, toolbarEl)`, `observers.set('escape-toolbar', installEscapeToolbar())`, `refreshToolbarRoving(toolbarEl)`, `observers.set('toolbar-collapse', installToolbarCollapse(toolbarEl))`, `observers.set('toolbar-overflow', installToolbarOverflow(toolbarEl, refreshToolbarRoving))`. With no toolbar element it still runs only `observers.set('escape-toolbar', installEscapeToolbar())` once per call (as `runFinishInit` does today when the toolbar is off). A new module (not a function in `finish-init.ts`) so `vditor-init.ts` can import it without the 40-module mock list of `finish-init.test.ts`; `boot` list in `scripts/module-manifest.mjs:244` gets `'toolbar-flow-install'`.
D10 When, exactly. In the streaming branch of `after()`: `installToolbarFlow(observers)` is the first statement inside `if (willStream) {` (`vditor-init.ts:488`), before `sessionState.streaming = true`, before `stream(...)` is called. Consequences: it runs in the same task as `initUI`, so the live toolbar is flowed before its first paint on any open path; it runs before `onFirstChunk`, so when the overlay is removed the toolbar behind it is already flowed (the controller measured it while covered: the overlay is absolute and does not affect the toolbar's layout); the `.catch` recovery finds it installed. It is not placed in `onFirstChunk` (would flow in the same task as the overlay removal, which also works but leaves the no-overlay case unflowed until the first chunk).
D11 The non-stream path keeps its timing: `runFinishInit` calls `installToolbarFlow(observers)` at the spot where `ensureToolbarRows`/`guardToolbarScroll`/`installEscapeToolbar` are today (`finish-init.ts:609-613`), and the toolbar block at 643-657 shrinks to what stays (below). In a streaming open the later call from `finishInit` is a no-op because the element is in the `WeakSet`. Observable change for the non-stream path: collapse and overflow are installed before `installFormatWordExpand`, `installStructuralSelection` and `installFindReplace` instead of after them, still in the same synchronous task; Find's toolbar-size observer then reads the flowed toolbar at install. No handler depends on the order of these four.
D12 What stays in `runFinishInit` (must not move): `handleToolbarClick()` (193, listeners that persist options), `installPreviewMemory` (Preview toggle memory; Preview is not opened on a streamed document), `installToolbarSubmenuAria`, `installEmojiPicker` (needs the emoji insertion wiring), `installToolbarMenuPosition` (panel placement), all editor observers, `placeInitialCaret`, reading position, undo, edit-sync (`startIncrementalSeed` is in `vditor-init.ts`'s `finishInit` wrapper). All of these keep running at `onDone`/`beforeFinalize` exactly as today. They still follow the flow install because they stay after the `installToolbarFlow` call.
D13 Behaviour during the stream after the change: toolbar rows, collapse toggle (its state applied and clickable; the click posts `save-toolbar-collapsed` as usual), overflow into More and keyboard roving work; actions that edit the document remain what they are today (the editor is read-only, `vmde-streaming`); submenu aria, emoji picker and panel placement appear at the end of the stream. No change to which toolbar actions are enabled during the stream.
D14 Not included: any change to `stream-render.ts`, to the overlay clone (`prerender-overlay.ts`), to the placeholder, or to hiding/disabling the toolbar while streaming.
D15 Task 643 interaction: the invariant to carry forward is "`installToolbarFlow(observers)` runs in the same task as `initUI`, before the overlay is removed, on every open path (edit-mode stream, Preview-first)". The function takes no edit view or document, so a Preview-first open can call it unchanged. 661 closes with this recorded in its record; 643's Part 1 must list it as a constraint and re-run the stream toolbar case it inherits.

### Risks to the stream path

- Cost: the controller adds a ResizeObserver (parent, toolbar, `documentElement`, `body`) and runs `apply()` on each delivery. During a stream the callback fires only when one of those four boxes changes size; in the VS Code webview the scrolling element is the bounded `pre.vditor-reset`, so body size is stable. A callback that does fire costs one `getComputedStyle` pass over about 34 items plus a key comparison, after layout has already run (ResizeObserver runs post-layout). Expected negligible; not measured. The real-VS-Code case records the stream wall time as a non-asserting annotation so a regression is visible; no budget is asserted.
- Re-init mid-stream: the early call replaces the previous toolbar's disposers through `observers.set`; the old controller's `dispose()` runs against a detached toolbar. Same as the non-stream re-init today.
- Double install: prevented only by the `WeakSet` on the toolbar element; any future second caller must go through `installToolbarFlow`.
- Escape/roving earlier: `installEscapeToolbar` binds a document-level capture keydown during the stream; its handlers read the editor through `activeModeElement(window.vditor)`, which exists (empty) from construction. Tab/Escape semantics during a read-only stream are those of a read-only editor.
- Merge risk with Task 643: both edit the `after()` streaming branch and `finish-init.ts`; the change here is one call plus a replaced block, kept small for that reason.

### State / DOM / messages

No new message or DOM attribute. New module-level `WeakSet<HTMLElement>` in `toolbar-flow-install.ts`. The probe (`test/vscode-e2e/toolbar-frame-probe.ts`, shared with S3 of the main handoff; whichever step is written first creates it) gains: `liveFrames`, `liveStreamingFrames`, `firstLiveFrame` ({ height, flatItems, rows }), counted only for painted frames where `#vmde-prerender` is absent and `#app .vditor-toolbar` exists with width > 0; "streaming" means `document.querySelector('.vmde-streaming')` is set. Live-frame invariants (added to the existing list): direct toolbar children that are items or dividers (`:scope > .vditor-toolbar__item, :scope > .vditor-toolbar__divider`) number 0; the toolbar has exactly two `.vmde-toolbar-row` children; height is 36 / 61.4 / 25 (+/- 0.25); each displayed row has `scrollWidth <= clientWidth + 1`.

### Part 2 steps (added to S1-S4 of the main handoff)

**S5a Init ordering (Vitest RED then fix; disjoint from S1/S2, may run in parallel).** Owned: new `media-src/src/boot/toolbar-flow-install.ts`, new `media-src/src/boot/toolbar-flow-install.test.ts`, `media-src/src/boot/finish-init.ts`, `media-src/src/boot/vditor-init.ts`, `media-src/src/boot/vditor-init.test.ts`, `media-src/src/boot/finish-init.test.ts`, `scripts/module-manifest.mjs` (boot ids only).
 - RED first (tests written against the new export, which does not exist yet): `npx vitest run --config test/vitest.config.ts media-src/src/boot/vditor-init.test.ts media-src/src/boot/toolbar-flow-install.test.ts media-src/src/boot/finish-init.test.ts`. They fail on HEAD (missing module and no early call).
 - Fix: D9-D12. In `finish-init.ts`, import `installToolbarFlow`, call it at the old 609-613 spot, delete the now-moved calls (`ensureToolbarRows`, `guardToolbarScroll`, `installEscapeToolbar`, `refreshToolbarRoving`, `installToolbarCollapse`, `installToolbarOverflow`) and their imports; keep the rest of the 643-657 block (still guarded by `toolbarEl`). In `vditor-init.ts`, import it and add the first statement of the `willStream` branch.
 - Checks: same Vitest command green; `npm run lint:ci`; `npm run typecheck`; `npm run knip` (the new export is used); `npx vitest run --config test/vitest.config.ts test/backend/module-boundaries.test.ts`.
**S5b Real-VS-Code stream case (after S5a RED is written; shares the single real-VS-Code token with S3, run after it).** Owned: `test/vscode-e2e/stream-large-file.spec.ts` (extend the existing single `test()`; no new boot), `test/vscode-e2e/toolbar-frame-probe.ts`.
 - Extend the existing test: before opening, `electronApp.context().addInitScript(toolbarFrameProbeScript)` (add the `electronApp` fixture to the test arguments); after the existing assertions, read the probe and assert (below). Record `streamMs` (first live frame to the last section) as a test annotation only.
 - RED first: write the case, `node build.mjs` on the HEAD sources (the same build serves S3 step A), run once, record the failure (predicted: `flatItems > 0`, no rows, height far above 61.4 in `firstLiveFrame`). Then apply S5a (and S1), `node build.mjs`, rerun `env -u ELECTRON_RUN_AS_NODE xvfb-run -a npm --prefix test/vscode-e2e test -- stream-large-file.spec.ts` once (`--workers=1 --retries=0`), then S3 once.
 - The spec keeps its 300 s timeout; it stays out of the SMOKE/FAST tier edits unless it is already listed (check `playwright.config.ts` before editing; do not change tier membership).
**S4 additions.** The 661 record gains: Requirement 4 (a streamed open shows the flowed toolbar from the first painted frame after the overlay is removed), Acceptance item 4 with the same wording and the Task 643 constraint, Scope line "stream-open toolbar ordering", the Q2 finding (ratios 1.43 to 1.66, predicted 1.33 to 1.40 px, record only), and corrected "no overlay" statements. Gates unchanged (`npm run quality` covers the new module; `check:coverage-modules` ratchet must not list `toolbar-flow-install.ts` at 0%).

### Tests mapped to the new acceptance item

Acceptance 4 (a streamed open shows a flowed toolbar from the first painted frame after the overlay goes):
 - Vitest, `vditor-init.test.ts` (add `installToolbarFlow` to the `./finish-init`-adjacent mocks as a hoisted `vi.fn` mocking `./toolbar-flow-install`; hoist the five `prerender-overlay` mocks into `h` so call order is readable; make the `streamRenderSV` mock return `Promise.resolve()` after storing the hooks):
   - (a) streamed IR (`HUGE = 'x'.repeat(700_001)`): after `after()` and before any hook, `installToolbarFlow` was called once with the shared observers; calling `h.streamHooks.onFirstChunk()` then `removePrerenderOverlay` runs after it (`mock.invocationCallOrder`); `runFinishInit` not yet called.
   - (b) streamed SV (options that make `streamModeDecision` return `streamInSV`; verify the option name against `buildVditorOptions` when writing): same ordering, and `streamRenderSV` was the stream used.
   - (c) the stream failure path (`h.streamResult` rejecting): `installToolbarFlow` called exactly once in total.
   - (d) small document: `installToolbarFlow` is not called by `vditor-init.ts` (only `runFinishInit` calls it, mocked here), so the non-stream path is not doubled.
 - Vitest, `toolbar-flow-install.test.ts` (jsdom; mock `../chrome/toolbar-layout`, `../chrome/toolbar-scroll-guard`, `../chrome/toolbar-collapse`, `../chrome/toolbar-overflow`, `../editing/escape-toolbar`, `../util/inner-vditor`):
   - (e) first call runs rows, guard, escape, roving, collapse, overflow in that order for a toolbar element and registers the three observer keys;
   - (f) a second call for the same element changes nothing (each mock called once);
   - (g) a different element (re-init) installs again;
   - (h) no toolbar element: only the escape-toolbar observer is set, nothing else;
   - (i) the order is `ensureToolbarRows` before `installToolbarCollapse` before `installToolbarOverflow` (the comments at `finish-init.ts:636-641` and `toolbar-overflow.ts` require rows first and the stored collapse state before the first measurement).
 - Vitest, `finish-init.test.ts`: (j) `runFinishInit` calls `installToolbarFlow` once with its `observers`, before `installFindReplace`'s observer is registered (call order via the existing mocks); and when the module is mocked as already installed, `runFinishInit` still sets `toolbar-submenu-aria`, `emoji-picker` and `toolbar-menu-position` (they stay after the flow).
 - Real VS Code, extended `stream-large-file.spec.ts`: a generated document of 744,000 characters (`buildLargeMarkdown`, already in the file; over `STREAM_MIN_CHARS = 700,000`), default IR mode. After the existing assertions: `probe.liveStreamingFrames >= 3` (vacuity guard: frames were sampled while `vmde-streaming` was set and the overlay was gone); `probe.firstLiveFrame.flatItems === 0`, `.rows === 2`, `.height` within 0.25 of 36 / 61.4 / 25 for its state; `probe.violations` equals `[]` across all live frames, from the first frame after the overlay goes to the end of the stream. When the host Lute is cold and there is no overlay, `firstLiveFrame` is the first frame ever painted and the same invariants apply. The existing assertions (all 1,200 headings, editor back to `contenteditable=true`, spinner gone) stay. Predicted RED at HEAD (fact 4), predicted GREEN after S5a.
 - SV streaming is covered at the Vitest layer only (b); an SV real-VS-Code case would need a saved-mode setup and a second boot, and the call placed in the shared branch start is identical for both modes.
Edge cases and layer: toolbar disabled (`toolbar: []`) (h); re-init mid-stream (g plus the existing re-init Preview tests, unchanged); collapsed remembered state applied during the stream (covered by (e) order plus the probe's height check if the fixture runs collapsed; not separately tested, the code path is the same one the non-stream open uses); resize during the stream (same controller as the main handoff's A1 sampler, not repeated).

### Residual risks

- Fact 4 (the flat vertical stack and its height) is derived from CSS and the absence of rows; the S5b RED run is the evidence. If it is not RED (for example some other rule hides the flat toolbar), the change is still the correct ordering, but the record must say the visible symptom was not reproduced.
- Reordering collapse/overflow ahead of three editor observers on the non-stream path (D11) is judged independent by reading; the real-VS-Code toolbar specs that run in S3 and the Chromium toolbar harness (`toolbar-overflow.spec.ts`, which wires its own order) do not prove it. The Vitest ordering test (j) and one run of `toolbar-order.spec.ts` and `toolbar-collapse.spec.ts` after S5a cover it; add them to the S3 run (one run each, `--workers=1 --retries=0`).
- Controls act on a read-only partial document during a stream, as today; the flowed toolbar makes them easier to reach. Not changed.
- Stream throughput with the controller present is expected unchanged but only recorded, not asserted.
- Task 643 merge conflicts in `vditor-init.ts` and `finish-init.ts` are likely small; the invariant in D15 is what 643 must keep.
- The overlay clone still does not follow a resize (main handoff fact 4); unchanged.

### S5a streaming toolbar init ordering (done, Vitest only)

New `media-src/src/boot/toolbar-flow-install.ts` (`installToolbarFlow(observers)`, once per toolbar element via a `WeakSet`) now holds rows, scroll guard, Escape handler, roving refresh, collapse and overflow. `vditor-init.ts` calls it first in the streaming branch of `after()`; `runFinishInit` calls it at the old spot (a no-op after a streamed open). Module manifest `boot` ids gain `toolbar-flow-install`. RED: the new cases (a), (b), (c), (j) failed and `toolbar-flow-install.test.ts` could not resolve its module before the fix. After the fix, `vditor-init.test.ts`, `toolbar-flow-install.test.ts`, `finish-init.test.ts` and `module-boundaries.test.ts` passed (47 of 47); `npm run typecheck`, `npm run knip` and `npm run lint:ci` were clean. Real-VS-Code case S5b (stream probe) and S3 are not run. Acceptance 4 stays open until S5b.

### Real-VS-Code results (S3 and S5b) and corrections

RED for the host placeholder and the stream ordering was shown by the Vitest cases only (the source changes were already applied when the real-VS-Code specs were written), so the real-VS-Code cases are guards, not reproductions. Ran with `--workers=1 --retries=0` under `xvfb-run -a` with openbox and `VMDE_XTEST=1`, after `node build.mjs`:

- `stream-large-file.spec.ts` (extended with the frame probe): passed. Probe: 88 frames, 54 live frames of which 24 while streaming, first live frame 61.375 px with 0 flat controls and 2 rows, heights `teaser:61.39`, `teaser:61.38`, `live:61.38`, 0 violations. Open to last section 3.6 s (annotation, not asserted).
- `toolbar-flow-settle.spec.ts` (new): passed. Calibration: window 1400, webview 1352, offset 48. Step A (wiki, webview width 1110, between 1,076 and 1,143): placeholder heights 61.39 / 61.38 and live 61.38, no 36 px entry, 0 violations. Step B (sweep 1400, 1110, 900, 700, 500, 380, 700, 1400): 173 live frames, 0 violations; gap 2.0 px, overlap 0, device pixel ratio 1; Wiki Pages icon 16 x 16 in the row at 900. Step C (wiki off, same width): `teaser:36`, `live:36`, 0 violations.
- `toolbar-order.spec.ts -g "Wiki Pages"` (live toolbar scoped to `#app .vditor-toolbar`, waits for the overlay to go): passed. `toolbar-collapse.spec.ts`: 5 of 5 passed.
- Fact 16 (the 0 px icon): the non-asserting read right after the reopen showed `overlayPresent: false`, one toolbar, not in the overlay, so the overlay-copy race was not reproduced in that read; the test-side scoping stays as a guard.
- Probe notes: a reading taken in an animation-frame callback runs before the flow controller's resize observer, so the probe checks row overflow only in a resize-observer reading created after the controller's (the state that gets painted); a teaser frame is counted once the toolbar's 1 px bottom border has applied (the first teaser frame before the stylesheet reads 60.39 px and is not a painted state). An earlier run of step A saw no teaser frame at all (the probe armed after it); the later runs saw 11 to 12 overlay frames.
- Corrected statement: wiki documents DO get the instant-paint overlay (fact 7). The "no overlay" wording in `html-builder.ts` was rewritten in S1; the Task 642 done record stays as history.
- Q2 finding (record only, CSS kept): at device ratios of about 1.43 to 1.66 (for example 150% display scaling) the row gap is predicted at 1.33 to 1.40 px, just below the 1.4 px lower bound. Derived from Blink's border-width flooring, not measured; the acceptance names ratios 1 and 2 only.
- Task 643 constraint: `installToolbarFlow(observers)` must run in the same task as the toolbar's construction, before the overlay is removed, on every open path (edit-mode stream, Preview-first); 643's Part 1 must list it and rerun the stream toolbar case.
- Still open: closure gates (`npm run quality`, `check:coverage-modules`, `media-src/e2e/prerender.spec.ts`), the tracking table, and moving the record to `tasks/done/`.

## Closure — 2026-10-18 (batch 4)

Gate run on HEAD `dbb3c104` (one run serves batches 3 and 4).

| Command | Exit | Result |
| --- | --- | --- |
| `node build.mjs` | 0 | built |
| `npm run lint:ci` | 0 | 1,226 files checked, no fixes |
| `npm run typecheck` | 0 | clean |
| `npx tsc --noEmit -p ./` | 0 | clean |
| `npm run knip` | 0 | clean |
| `npm run jscpd` | 0 | clean |
| `npm run depcruise` (host and webview) | 0 | clean |
| `npm run test:coverage` (gate run, then two more) | 0, 0, 0 | 358 files, 7,256 passed, 1 expected fail, in each of the three runs; no timeout, no unhandled error; statements 80.19%, branches 73.59%, functions 83.51%, lines 82.44% (gate run) |
| `npm run check:coverage-modules` | 0 | ratchet OK, 10 modules at 0% (baseline 10), no prune notice |
| `npm run check:brand-identifiers` | 0 | clean |
| `npm run check:bundle-size` | 1 | reporting only: `media/dist/main.js` 1,037,005 B (1,013 KB) against the 608 KB budget (inherited miss); lazy bundles within budget |
| `npm run check:startup-cost` | 1 | reporting only: 384 eager modules against 294 (inherited miss); largest module 30 KB of 34 KB |

`npm run quality` and `npm run audit` were not run (audit omitted by Owner instruction). No new failure; no real VS Code or Chromium run in the closure. Bundle: 1,037,005 B, +2,959 B against batch 2 (1,034,046 B); eager modules 384, +3 against batch 2 (381). The new webview modules since batch 2 are `toolbar-flow-install` (Task 661) and `preview-raw-headings` (Task 660), plus the changed section-indent and table code; the split was not measured.

Task commits: dbb3c104 (progress), b7496091, f02c9a75, 51263bcd, 0189c003; filed in 1985ceb2 and 20c08750.

Acceptance: All four acceptance items ticked earlier (Chromium frame sampler 0 violations; real VS Code `stream-large-file`, `toolbar-flow-settle`, `toolbar-order` Wiki Pages and `toolbar-collapse` 5 of 5 passed). Closure gates passed; `prerender.spec.ts` was not run in the closure.

Residual risks: At device pixel ratios of about 1.43 to 1.66 the row gap is predicted at 1.33 to 1.40 px (derived, not measured); the overlay clone does not follow a resize; Task 643 must keep `installToolbarFlow` running before the overlay is removed on every open path.

Owner rulings already recorded: Owner answers: Q1 streamed-document toolbar change accepted; Q2 CSS kept.
