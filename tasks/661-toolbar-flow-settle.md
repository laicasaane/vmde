# Task 661 — Settle the toolbar flow after resize and check placeholder sizing

**Status:** open.
**Origin:** Project Owner request (known issue from Task 642).
**Severity:** low.
**Tech stack:** webview toolbar flow, instant-paint placeholder, and row gap measurement; real VS Code for resize behaviour.
**Related:** [Task 642](done/642-toolbar-layout-follow-ups.md) (toolbar layout follow-ups).

## Problem

1. Right after a resize, the flow may still be placing controls. An icon in a moving control measured 0 px in a real-VS-Code test.
2. The instant-paint placeholder uses the wiki-off one-row threshold (1,076 px). Wiki documents need 1,143 px.
3. The row gap measures 2.0 px at device pixel ratio 1. The target is 2.4 ± 1 px.

## Requirements

1. No visible flash or empty frame appears after a resize. The flow settles before controls are shown.
2. Wiki documents never receive the overlay, or the placeholder is sized per document.
3. The row gap is confirmed at device pixel ratio 2 and meets the target of 2.4 ± 1 px.

## Open design points

- Whether wiki documents are excluded from the overlay or the placeholder is sized per document: to be decided in Part 1.
- To be settled in Part 1 for the other points.

## Scope

- In: the resize flow, the instant-paint placeholder threshold, and the row gap check.
- Out: toolbar behaviour not named above.

## Acceptance

- [ ] After a resize, no visible flash or empty frame appears, and no control measures 0 px because it is still moving.
- [ ] Wiki documents never receive the overlay, or the placeholder size matches their threshold of 1,143 px.
- [ ] The row gap is within 2.4 ± 1 px at device pixel ratio 1 and at device pixel ratio 2.

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
