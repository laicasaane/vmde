# Task 691 — Switching between Preview and Edit, and between IR and Split view, feels slower

**Status:** done (2026-11-02). Filed 2026-11-01. Filed from an Owner report during light manual use.
**Origin:** Owner report (2026-11-01).
**Severity:** medium (estimated; user-visible, not measured).
**Tech stack:** `media-src/src/editing/preview-state.ts`, `media-src/src/editing/preview-render.ts`, `media-src/src/editing/preview-morph.ts`, `media-src/src/editing/preview-caret.ts`, `media-src/src/nav/preview-scroll-preserve.ts`, `media-src/src/nav/split-scroll-sync.ts`, `media-src/src/bridge/edit-sync.ts` (`reanchorAfterModeSwitch`), `media-src/src/editing/vditor-chord-actions.ts` (`switchEditMode`, the entry point of the edit-mode switches including IR↔Split; registered in `media-src/src/boot/main.ts`).
**Depends on:** none.

## Problem

The Owner feels that switching Preview on and off (Preview ↔ Edit) and switching between IR mode and Split view is a bit slower than before. No measurement exists yet. Everything below is unmeasured.

"Before" is not pinned. The reference point is the pre-release cut after Task 670 (commit `30426a37`, 2026-10-19, `feat(670): preserve front matter across exact-source editing`).

Candidate commits since then that touch these paths (unverified as causes):

- `6dede194` `feat(643): render Preview itself, stream large documents and defer the edit view`.
- `8b8740be` `fix(652): restore the caret and selection after Preview off`.
- `88cc673d` `feat(645): add Split View source pane font size, line numbers, background, current-row highlight and pane gap`.
- The Task 675 and 677 mode-switch changes in `media-src/src/bridge/edit-sync.ts` (`reanchorAfterModeSwitch`), commits `47ae8ee5` and `fbe97b56`.

## Proposed work

1. Measure first, in real VS Code on a quiet machine. Time the path from the user gesture to the settled view for four switches: Preview on, Preview off, IR→Split, Split→IR. Use a small, a mid-size and a large fixture, several runs each, on `30426a37` and on current `dev`. Use `performance` marks or CDP traces.
2. If current `dev` is slower, bisect the candidate commits and attribute the cost with a CPU profile.
3. Fix the attributed cost without removing the behaviour those tasks added. Or record the measured cost as accepted, with the Owner informed.
4. If no difference is measured, record the numbers and close.

## Acceptance

- [x] Switch times are measured on both revisions. The numbers are recorded with fixture sizes and run counts. (Part 2 step 1.)
- [x] The cause is attributed to a commit and a function, or "no regression measured" is recorded. (Step 2: `6dede194`, `renderNow` in `installFullPreviewRoute`; no regression for the other three switches.)
- [x] Any fix brings the switch time back within the measured noise of `30426a37`, or states the remaining cost. (Fix step: mid input-to-paint 55 ms against 42 ms, +13 ms under a 22 ms threshold.)
- [x] A real-VS-Code timing spec or probe is written and run. (`mode-switch-timing-probe.spec.ts`, `@probe`.)
- [x] The quality stages pass. (All stages pass except the dependency audit, which reports known advisories and is omitted by the Owner's rule for this run; see the fix section.)

## Tests to write

- A real-VS-Code probe (tag `@probe`) in `test/vscode-e2e/` that measures the four switches.
- A regression test for any fix.

## Part 1 handoff (2026-11-02)

Part 1 is source, test and history reading only. No build, test or timing ran in this part, so every cost below is still a hypothesis.

### 1. Problem restated

The Owner feels that four switches are slower than at `30426a37`: Preview on, Preview off, IR→Split and Split→IR. Part 2 must find out with measurement whether current `dev` is slower and by how much, per switch and per document size. If it is slower, Part 2 must also find the commit and function that cause it. The behaviour that later tasks added must stay.

Two corrections to the record above, from the history:

- `8b8740be` (Task 652, 2026-10-18) is an ancestor of `30426a37`. It is in the reference build already, so it cannot cause a difference. Its caret restore on Preview off runs on both revisions.
- `47ae8ee5` (Task 675) and `fbe97b56` (Task 677) do not change `reanchorAfterModeSwitch` (`media-src/src/bridge/edit-sync.ts:578`). That function was last changed before `30426a37`. Task 675 adds `hostDerivesSourceText` (`edit-sync.ts:628`), which runs only when a host reply to an exact-authority request arrives in Source mode. Task 677 adds a `recordedEntry` option to `flushHistoryInput` and makes only trusted input schedule an automatic wrap (`media-src/src/boot/main.ts`, input listener). Neither adds work on a mode switch. Task 677 removes some, because untrusted input no longer schedules a wrap attempt.

Commits since `30426a37` that touch the listed paths (`git log 30426a37..HEAD` on the tech-stack files, `boot/main.ts` and `esbuild-shared.mjs`): `6dede194` (643), `88cc673d` (645), `47ae8ee5` (675), `fbe97b56` (677), `03a20622` (676), `90611a6b` (668), `32d6bf84` (644), `e8325451` (624), `3dd38c6d` (612), `1db03714` (646). Only `6dede194` adds synchronous work on a switch path. `88cc673d` adds CSS for all users, and adds work only when its settings are on. The others change outline moves, Insert ID, debounce timing, PageUp/PageDown, host revisions and auto-wrap, and none of them runs on a mode switch.

### 2. Code paths, gesture to settled view

Shared entry points. The toolbar Preview button runs Vditor's `Preview._bindEvent` handler (`vditor/src/ts/toolbar/Preview.ts:13`). The edit-mode choice runs `setEditMode` (`vditor/src/ts/toolbar/EditMode.ts:23`). The `vmde.switchTo*` commands reach the same click through `switchEditMode` (`media-src/src/editing/vditor-chord-actions.ts:81`, registered at `media-src/src/boot/main.ts:771-775`). A capture-phase listener persists the mode and reports it 500 ms later (`media-src/src/chrome/toolbar-actions.ts:67`). That listener is the same on both revisions.

**Preview on (IR or WYSIWYG).**
1. `Preview.ts`: disable the toolbar, show `preview.element`, hide the edit pane, call `vditor.preview.render(vditor)`, then schedule `outline.render` for `preview.delay + 10` ms.
2. The patched toolbar entry asks `__vmdeEnterPreview` (`media-src/src/editing/preview-state.ts:148`). If content and config are unchanged since the last committed render (Task 530 reuse), nothing renders. Otherwise it calls `render(vditor, undefined, true)`.
3. Reference `30426a37`: Vditor's `Preview.render` reads `__vmdePreviewSnapshot` (the exact snapshot, `finish-init.ts:484`) and schedules the render with `setTimeout(…, 0)` (`patchPreviewImmediateAndCommit`, `media-src/esbuild-shared.mjs`). In that next task it runs one `Md2HTML`, the Task 187 morph, `afterRender` (every heavy renderer on the whole pane) and `__vmdePreviewRendered`. The click task ends before the render, so the shell can paint first.
4. `dev` (`6dede194`): `patchPreviewFullRoute` calls `__vmdeRenderFullPreview` at the top of `Preview.render`. The hook (`media-src/src/editing/preview-render.ts:597`) renders **synchronously inside the click task** (`renderNow`, `:587`, `:606`). The steps are: `maskPreviewSource`, `planPreviewChunks` and `buildDefMap` (`:164-195`), `Md2HTML`, `globalizeFootnotes` when footnotes exist (`:124`), `morphAndProcess` (`:468`), the cheap passes, `gateHeavyBlocks` (`:286`, which reads each heavy block's rectangle in `nav/viewport-gate.ts:50`; blocks within 800 px render now and the rest wait), and `finish` (`:322`). `finish` renders the outline synchronously when the outline panel is open (`:333-345`), and the delayed Vditor outline render is then skipped (`__vmdeFullPreviewOwnsOutline`, `:620`). Above 50,000 characters the render streams (`streamUnits`, `:490`): it yields a frame after every 12 ms of work (`:526`), pauses the coalesced decorating observers until the end (`util/observe-coalesce.ts`, then runs them one per frame), and, when the pane already shows content (`replacing`, `:405`), keeps the old content until every unit is ready and then morphs once (`:545`).
5. Both revisions: the style observer in `preview-scroll-preserve.ts:542` calls `onEnterPreview` (`:400`), which pins the Preview scroll for `PREVIEW_PIN_MS`. On `dev` this returns early when no edit anchor is stored. The pin is extended while the content grows (`pinFramesAfterTick`, `:66`; by at least 30 frames, up to about 1 minute).

**Preview off.**
1. `Preview.ts`: show the edit pane, hide `preview.element`, enable the toolbar, and call `vditor.outline.render(vditor)` synchronously (`Preview.ts:36`). This is the same on both revisions.
2. Capture listeners on the button from `finish-init.ts:180` run: Preview memory (Task 651, both revisions); `installEditViewBuildOnLeave` (`media-src/src/chrome/open-preview.ts:75`, `dev` only), which does nothing when no edit view is deferred; and the caret restore (`media-src/src/editing/preview-caret.ts:166`, both revisions).
3. `dev`: `watchPreviewHidden` (`preview-render.ts:568`) ends the current run (`beginRun`). A stream still in progress stops, and its paused observers resume.
4. `preview-scroll-preserve.ts:429` `onLeavePreview` pins the edit pane for `EDIT_PIN_MS`. On `dev` it returns early when no Preview anchor exists.

**IR→Split.**
1. `setEditMode(…, 'sv')`: `getMarkdown` (a full IR serialization), `processSpinVditorSVDOM`, `sv.element.innerHTML`, `processSVAfterRender` (`vditor/src/ts/sv/process.ts:104`). That calls `preview.render(vditor)` without `immediate`, so Vditor debounces the render by `preview.delay` and renders the right pane on its own path, with the Task 187 morph. Then `setPadding`, `focus`, `renderToc`.
2. `dev`: the full-Preview hook returns `false` at once in Split (`showsFullPreview`, `preview-render.ts:557`, `:603`). The Split pane keeps Vditor's path.
3. Both revisions: `preview-scroll-preserve.ts:400` (SV branch) pins the source pane for 400 ms, and `split-scroll-sync.ts` aligns the panes.
4. `88cc673d`: new CSS rules match `.vditor-sv` style and attribute substrings (`main.css`, Task 645 block). The line-number gutter and the current-row band (`media-src/src/chrome/sv-gutter.ts`) mount only when `vmde.editor.sourceLineNumbers` or `sourceHighlightCurrentLine` is on. Both default to off. When on, the gutter mounts once the pane is shown and runs a global pass after the next frame and an idle callback (bounded at 120 ms). That pass reads every line break's rectangle.

**Split→IR.**
1. `setEditMode(…, 'ir')`: hide the preview, `getMarkdown` (an SV serialization), `Md2VditorIRDOM`, IR `processAfterRender` (undo stack timer), `setPadding`, the code-render loop, `focus`, `renderToc`.
2. `dev`: hiding the preview makes `watchPreviewHidden` call `beginRun` (cheap). `sv-gutter` unmounts if mounted.
3. Both revisions: `onLeavePreview` pins the IR pane, and the exact snapshot re-anchors on its next read (`reanchorAfterModeSwitch`, unchanged).

What each candidate commit adds to these paths:

| Commit | Preview on | Preview off | IR→Split | Split→IR |
|---|---|---|---|---|
| `6dede194` (643) | New renderer, synchronous in the click task; outline before paint when the panel is open; streaming above 50,000 characters; pin extension | Run ends; no-op deferred-build listener; anchor guard | Hook early return | Hook early return; `beginRun` |
| `88cc673d` (645) | — | — | CSS rules; gutter only with settings on | Gutter unmount |
| `47ae8ee5` (675) | — | — | Only on a Source-mode host reply | — |
| `fbe97b56` (677) | — | — | Untrusted input no longer schedules a wrap (less work) | Same |
| `8b8740be` (652) | In the reference already | In the reference already | — | — |

### 3. Ranked cost hypotheses (unmeasured)

1. **Preview on, documents at or below 50,000 characters: the render moved from a follow-up task into the click task** (`preview-render.ts:606`; the reference used `setTimeout(…, 0)` from the Task 530 patch). The total work is about the same, but the first frame after the click now waits for `Md2HTML`, the morph and the passes. The Task 643 record measured about 100 ms for one 50 KB pass. Expected to show in input-to-next-paint, and only a little in the settled time. Probability that this is the main cause of the Owner's report: about 0.35.
2. **Preview on with the outline panel open: the outline renders before paint** (`preview-render.ts:333-345`). The reference rendered it about 510 ms later, after paint. It is a whole-outline pass ("hundreds of ms for a heading-heavy document", per the comment in the Task 643 patch). Only with the panel open. About 0.2.
3. **Preview on above 50,000 characters: streaming adds frame yields and catch-up passes.** One yield per 12 ms of work (`:526`), observers resumed one per frame after the stream, and the `replacing` path holds the old content until the last unit. The settled time can grow by tens to hundreds of ms on the mid and large fixtures, while the first content may arrive sooner. The pin extension (`preview-scroll-preserve.ts:66`) can hold the scroll for 30 more frames after the last growth. About 0.2.
4. **Preview on: whole-document passes added to the one-pass path.** `planPreviewChunks`, `buildDefMap`, and the HTML parse and serialize in `globalizeFootnotes` when footnotes exist (`:124-195`). Small, roughly linear. About 0.05.
5. **Preview on: the viewport gate's layout read** (`viewport-gate.ts:50`) forces one layout before paint. This is probably offset by skipping off-screen heavy renders, which the reference ran for the whole pane, so `dev` may be faster on code- and diagram-heavy documents. About 0.03.
6. **IR→Split: CSS from `88cc673d`.** Attribute-substring and sibling selectors add style invalidation when `.vditor-sv` changes its style. The gutter, if the Owner turned it on, adds a whole-pane layout read after the switch. About 0.05.
7. **No regression on Preview off, IR→Split or Split→IR.** No new synchronous code is on these paths with default settings. A perceived slowdown there may come from costs present on both revisions: `getMarkdown` plus `processSpinVditorSVDOM` or `Md2VditorIRDOM`, the Split preview debounce (`preview.delay`), and the synchronous `outline.render` on Preview off (`Preview.ts:36`). About 0.12 that these switches show no measured difference at all.

### 4. Part 2, step 1: measurement design (first step)

**Probe.** New `test/vscode-e2e/mode-switch-timing-probe.spec.ts`. The title carries `@probe`. The probe is non-asserting except for the readiness and settled predicates, and it never assumes `dev`-only hooks. It may use only hooks that exist on both revisions: `__vmdePreviewRendered`, `__vmdeInvalidatePreview`, `vditor.vditor.*` and the toolbar DOM. It also logs `__vmdeOpenMetrics` when present (on `dev` only, for information).

**Fixtures** (all present and unchanged at `30426a37`):
- small: `fixtures/all-renderers.md` (17,549 bytes). One-pass Preview; code, diagrams and math exercise the on-screen-first gate.
- mid: `fixtures/perf-prose.md` (54,600 bytes). Just above the 50,000-character Preview stream threshold, so `dev` streams 4 chunks.
- large: `fixtures/large-observable-models-synthetic.md` (174,527 bytes). Streamed Preview on `dev`. Below the 700,000-character edit-view stream threshold, so both revisions build the edit view in one pass.

**Session setup.** Open the fixture copy in IR with Preview off. Assert the starting state, because a remembered Preview (Task 651) or a remembered Split mode from an earlier session would change the path. Wait for `waitForE2EReadiness`. Then install the instrumentation with one frame `evaluate`:
- A capture-phase `click` listener on `document` for `.vditor-toolbar [data-type="preview"]` and `.vditor-toolbar [data-mode]`. It records `t0 = performance.now()` and `event.timeStamp`, and schedules a double `requestAnimationFrame` whose time is `tPaint` (the first paint after the click task).
- A `PerformanceObserver` for `event` entries (`durationThreshold: 16`) to read the click's input-to-next-paint duration. When the entry type is missing, `tPaint` is the fallback.
- A `PerformanceObserver` for `longtask`. When that is missing, use a rAF gap sampler (gaps over 50 ms), as `d2-edit-perf.spec.ts` does.
- A wrapper around `window.__vmdePreviewRendered` that records call times and then calls the original. Install it after readiness, and install it again if the hook object changes.

**Gestures.** Real clicks through the webview frame locators: the Preview button, then the edit-mode menu followed by `button[data-mode="sv"]` or `button[data-mode="ir"]`. `t0` is taken at the mode button's click, not at the menu click.

**"Settled" per switch.** Poll once per animation frame for the switch predicate, then require a quiet window of 300 ms with no long task. Settled time = max(predicate time plus a double rAF, end of the last long task before the quiet window). Cap: 30 s. A timeout is recorded as a failure, not as a sample.
- Preview on: `preview.element` shows `display: block`, `previewElement` has children, and (fresh variant) a `__vmdePreviewRendered` call with a time after `t0`.
- Preview off: the edit pane's parent shows `display: block`, the preview shows `display: none`, and the `vditor-menu--current` class is gone from the button.
- IR→Split: `currentMode === 'sv'`, `sv.element` has children, the preview shows `display: block`, and a `__vmdePreviewRendered` call came after `t0` (the debounced Split render, on both revisions).
- Split→IR: `currentMode === 'ir'`, `ir.element` has children, and the preview shows `display: none`.

**Metrics per switch.** `inputToPaintMs` (the Event Timing duration, or `tPaint − t0`) and `settledMs` (settled time − `t0`). Also the long-task count and total inside the window.

**Cycle.** Call `__vmdeInvalidatePreview('content')` outside the timed window, then Preview on → Preview off → IR→Split → Split→IR, with a 500 ms idle gap after each settled switch. Reuse variant: 3 extra Preview on/off pairs without invalidation, reported separately.

**Run counts.** Per fixture and revision: 2 sessions × (2 warm-up cycles discarded + 10 measured cycles), so 20 samples per fixture, switch and revision. Run order A B A B per fixture (reference, `dev`, reference, `dev`) to spread machine drift. Machine: quiet, with no other real-VS-Code, Chromium or build process running. The orchestrator schedules it.

**Settings variants.** Defaults on all three fixtures. One outline-open variant (open the outline panel before the cycles) for Preview on and off on the large fixture, on both revisions. One `sourceLineNumbers`-on variant on `dev` only, for IR→Split and Split→IR on the large fixture, reported as feature cost, because the reference has no such setting.

**Both revisions.** The orchestrator creates a detached worktree at `30426a37` beside the task worktree (for example `../vmde-wt/691-base`). It links `node_modules` and `media-src/node_modules` as the task worktrees do, copies the probe spec in as an untracked file, and runs `node build.mjs` there. The same spec runs in both worktrees through the shared real-VS-Code wrapper, one call per worktree, each with `VMDE_PROBES=1 … mode-switch-timing-probe.spec.ts --workers=1 --retries=0` under `xvfb-run`. Output: one `[mode-switch-probe]` JSON line per sample, kept under `tmp/691/` in the task worktree.

**Noise rule ("regression measured").** For each fixture, switch and metric: the `dev` median minus the reference median exceeds max(16 ms, 10% of the reference median, 2 × the larger of the two revisions' median absolute deviations), **and** the difference has the same sign and is at least 16 ms in each of the two sessions separately. Otherwise record "no regression measured" for that cell, with both medians and the interquartile ranges. An improvement is recorded by the same rule with the sign reversed.

### 5. Conditional steps (Part 2)

2. **Attribution (only for cells where a regression was measured).**
   - Preview on: first a runtime A/B on `dev` in one session. After readiness, delete `window.__vmdeRenderFullPreview` and `window.__vmdeFullPreviewOwnsOutline`, so Vditor's own render runs as in the reference, and rerun the regressed cells. If the gap closes within the noise rule, the cause is `6dede194`.
   - Then attribute the function with wrapper timings on the hook, `__vmdeMorphPreview`, `vditor.vditor.lute.Md2HTML` and `vditor.vditor.outline.render`, plus a CPU profile over CDP if the webview target can be attached. Compare against hypotheses 1 to 5.
   - Other switches, or a Preview gap the A/B does not explain: bisect only over the commits in section 1 that touch that switch's path, with one build per step.
3. **Fix or accepted cost.**
   - Hypothesis 1: start the one-pass render after the click task's first paint (as the reference's zero-delay task did). Keep the Task 530 reuse commit, Preview Find, reading position and streaming.
   - Hypothesis 2: run the outline after paint when the panel is open.
   - Hypothesis 3: tune the yield budget or the `replacing` hold, only if the probe attributes the cost there.
   - Each fix gets a Vitest regression test for the scheduling it changes. The probe then reruns on `dev` and must land within the noise rule of the reference, or the record states the remaining cost.
   - If the cost is accepted, record the numbers and tell the Owner.
4. **Closure.** Record the numbers (fixture sizes, run counts, medians, interquartile ranges, verdict per cell) and tick the acceptance items. Run `npm run quality`. Move the record to `tasks/done/` and index it only when everything is complete.

### 6. Edge cases

- **Reuse.** An unchanged document skips the Preview render entirely. A Split visit commits the shared preview pane, so the next full Preview may reuse it. The probe invalidates explicitly.
- **Preview-first open.** A deferred edit view makes the first Preview off build the edit view. Sessions must open in IR, never in Preview.
- **Preview off during a stream** (mid and large on `dev`). The run ends, and the resumed observers run one per frame after the switch. Off is timed only after on has settled. A separate check that turns Preview off during the stream is informational only.
- **Persisted mode and Preview memory.** The 500 ms save timer after a mode click falls inside the quiet window on both revisions. Each session must end in IR with Preview off.
- **Split preview debounce.** IR→Split settled includes `preview.delay` on both revisions, so the time is comparable but not zero-based.
- **Missing entry types.** Event Timing or Long Tasks may be missing in the webview. Use the fallbacks in section 4, and name which one was used.
- **Pin extension.** The scroll pin is not a long task and does not delay "settled". It is recorded only when the scroll moves after settled.

### 7. Focused checks and expected outcomes

| Check | Expected |
|---|---|
| `npm run lint` on the new spec | passes |
| `node build.mjs` in each worktree | exit 0 |
| The probe under `VMDE_PROBES=1`, one call per revision | 20 samples per fixture, switch and revision; no settled timeouts |
| A rerun of one `dev` session | medians within the noise rule of the first `dev` session (a sanity check of the rule) |
| If a fix lands: its Vitest test, then the probe on `dev` | the test passes; the fixed cells are within the noise rule of the reference |
| Closure: `npm run quality` | passes |

### 8. Tier

**Medium.** One new probe spec, real-VS-Code runs on two builds, and a conditional fix most likely confined to `media-src/src/editing/preview-render.ts` with one regression test. No protocol, host, setting or API change is expected. It would become Heavy only if attribution points across several modules.

### 9. Provisional decisions (2026-11-02), reversible

1. **Reference measurement:** a detached worktree at `30426a37` with the probe copied in untracked, built separately (probability 1.0). Alternatives: a runtime A/B on `dev` only (0; it does not measure the reference code), or a branch with the probe committed (0; it needs a commit).
2. **Preview-on content state:** a fresh render as the primary metric, with a smaller reuse variant (0.94). Alternatives: fresh only (0.03), reuse only (0.01).
3. **Noise rule:** the median-difference rule in section 4 (0.94). Alternatives: percentage only (0.02), a significance test regardless of size (0).
4. **Attribution order:** runtime A/B, then a limited bisect, then wrapper timings and a CPU profile (1.0). Alternatives: full bisect first (0), profile only (0).
5. **Settings variants:** defaults, plus outline open on both revisions, plus the source gutter on `dev` only as feature cost (0.91). Alternatives: ask the Owner for their settings first (0.04 for that candidate, plus 0.04 for asking in general), defaults only (0).
6. **Fixtures:** `all-renderers.md`, `perf-prose.md`, `large-observable-models-synthetic.md` (0.82). Alternatives: `large-structured-synthetic.md` as mid (0.05), a 0.5 KB small fixture (0.01).
7. **Tier:** Medium (0.98). Alternatives: Light (0), Heavy (0).

### 10. Part 1 status

- [x] Problem restated; the record's commit premise corrected (section 1).
- [x] Path map with entry points and per-commit changes (section 2).
- [x] Ranked hypotheses with source evidence (section 3).
- [x] Measurement design, conditional steps, edge cases, checks and tier (sections 4 to 8).
- [ ] Nothing measured yet. Acceptance items stay open for Part 2.


## Part 2 step 1 (2026-11-02): measurement

Measurement only. No attribution and no fix in this step.

### Method as run

- Probe: `test/vscode-e2e/mode-switch-timing-probe.spec.ts` (`@probe`, run with `VMDE_PROBES=1`). Real clicks through the webview; the in-page click listener takes `t0`; settled = predicate true plus a double animation frame, then 300 ms without a long task (cap 30 s). Event Timing and Long Tasks were both available in the webview, so no fallback sampler ran. Hooks used exist on both revisions (`__vmdePreviewRendered` wrapped by an accessor, `__vmdeInvalidatePreview`, `vditor.vditor.*`, toolbar DOM).
- Revisions: reference `30426a37` (detached worktree, probe copied in untracked, built separately, since removed) and current `dev` (`6a1a6e19`). Same VS Code 1.129.0.
- Fixtures: small `all-renderers.md` 17,549 bytes; mid `perf-prose.md` 54,600 bytes; large `large-observable-models-synthetic.md` 174,527 bytes. Each session opens in IR with Preview off and the outline closed (outline variant: open).
- Runs: four, in order reference, dev, reference, dev (2 sessions per revision). One session = one VS Code boot per fixture/variant. Each session: 2 warm-up cycles (discarded) + 10 measured cycles of Preview on → off → IR→Split → Split→IR with the preview content invalidated before each cycle (fresh), then one primed fresh pair, then 3 Preview on/off pairs without invalidation (reuse). So 20 samples per fixture, switch, revision and metric for fresh; 6 for reuse. Outline-open variant on the large fixture on both revisions. Source line numbers on (dev only, feature cost) on the large fixture.
- Metrics: `input-to-paint` = time from the click listener to the second animation frame after it (Event Timing durations, 8 ms granularity and absent below 16 ms, were logged as `eventMs` but not used for the rule). `settled` as above. Medians in ms.
- Noise rule (as designed): regression when dev median − reference median > max(16, 10% of reference median, 2 × larger MAD) and the difference has the same sign and at least 16 ms in each of the two session pairs. Sign-reversed = improvement. IQR is the interquartile range.
- Data: 1,008 timed samples, 0 timeouts, 18 sessions all ended in IR with Preview off. Raw lines and per-run logs are kept under `tmp/691/` (`mode-switch-probe.jsonl`, `run-*.log`, `analysis.txt`).
- Load average (1 min) at each session start is recorded in the raw `session` lines (range 0.6 to 1.84); no other real VS Code, Chromium or build process ran.
- Deviation: the VS Code install used by the runner lives under `test/vscode-e2e/.vscode-test/`, not the repository root `.vscode-test/`; it was copied there for the reference worktree.

### Results (all cells)

| Fixture / variant / content | Switch | Metric | Ref median (MAD, IQR), n | Dev median (MAD, IQR), n | Diff | Threshold | Per-session diff | Verdict |
|---|---|---|---|---|---|---|---|---|
| small / defaults / fresh | Preview on | input-to-paint | 272 (18, 261-297), 20 | 210 (43, 174-254), 20 | -62 | 85 | -25, -88 | no regression measured |
| small / defaults / fresh | Preview on | settled | 390 (25, 371-424), 20 | 294 (64, 236-366), 20 | -97 | 128 | -48, -137 | no regression measured |
| small / defaults / fresh | Preview off | input-to-paint | 154 (12, 143-170), 20 | 164 (37, 127-195), 20 | +11 | 74 | 27, -16 | no regression measured |
| small / defaults / fresh | Preview off | settled | 163 (12, 154-179), 20 | 186 (44, 142-226), 20 | +22 | 89 | 48, -12 | no regression measured |
| small / defaults / fresh | IR→Split | input-to-paint | 465 (28, 440-490), 20 | 488 (98, 390-583), 20 | +23 | 196 | 106, -58 | no regression measured |
| small / defaults / fresh | IR→Split | settled | 860 (18, 848-881), 20 | 921 (74, 852-1017), 20 | +61 | 149 | 136, 4 | no regression measured |
| small / defaults / fresh | Split→IR | input-to-paint | 622 (35, 601-662), 20 | 755 (148, 566-864), 20 | +133 | 297 | 211, -43 | no regression measured |
| small / defaults / fresh | Split→IR | settled | 1202 (36, 1170-1264), 20 | 1481 (342, 1135-1753), 20 | +279 | 684 | 512, -41 | no regression measured |
| small / defaults / reuse | Preview on | input-to-paint | 60 (3, 57-62), 6 | 42 (3, 39-43), 6 | -18 | 16 | -19, -17 | improvement measured |
| small / defaults / reuse | Preview on | settled | 82 (2, 78-83), 6 | 52 (9, 45-61), 6 | -31 | 18 | -35, -26 | improvement measured |
| small / defaults / reuse | Preview off | input-to-paint | 157 (14, 146-169), 6 | 157 (6, 152-162), 6 | -1 | 28 | -7, 6 | no regression measured |
| small / defaults / reuse | Preview off | settled | 166 (15, 155-184), 6 | 179 (6, 172-182), 6 | +13 | 29 | 12, 14 | no regression measured |
| mid / defaults / fresh | Preview on | input-to-paint | 42 (4, 38-47), 20 | 72 (4, 68-80), 20 | +30 | 16 | 28, 31 | regression measured |
| mid / defaults / fresh | Preview on | settled | 138 (6, 130-144), 20 | 102 (9, 95-115), 20 | -36 | 19 | -45, -30 | improvement measured |
| mid / defaults / fresh | Preview off | input-to-paint | 81 (4, 77-88), 20 | 82 (5, 77-88), 20 | +1 | 16 | 4, -3 | no regression measured |
| mid / defaults / fresh | Preview off | settled | 96 (5, 93-105), 20 | 97 (5, 93-104), 20 | +1 | 16 | 5, -2 | no regression measured |
| mid / defaults / fresh | IR→Split | input-to-paint | 148 (9, 142-165), 20 | 154 (9, 146-163), 20 | +6 | 19 | 11, 3 | no regression measured |
| mid / defaults / fresh | IR→Split | settled | 741 (114, 641-868), 20 | 733 (114, 638-876), 20 | -8 | 228 | -4, 5 | no regression measured |
| mid / defaults / fresh | Split→IR | input-to-paint | 175 (10, 166-192), 20 | 172 (9, 166-185), 20 | -3 | 20 | -1, -7 | no regression measured |
| mid / defaults / fresh | Split→IR | settled | 200 (12, 192-221), 20 | 197 (9, 191-213), 20 | -3 | 24 | -1, -10 | no regression measured |
| mid / defaults / reuse | Preview on | input-to-paint | 19 (1, 19-23), 6 | 39 (4, 36-42), 6 | +20 | 16 | 12, 23 | no regression measured |
| mid / defaults / reuse | Preview on | settled | 35 (1, 34-42), 6 | 48 (3, 48-53), 6 | +13 | 16 | 10, 14 | no regression measured |
| mid / defaults / reuse | Preview off | input-to-paint | 80 (4, 76-85), 6 | 91 (7, 80-97), 6 | +12 | 16 | -9, 19 | no regression measured |
| mid / defaults / reuse | Preview off | settled | 96 (4, 94-100), 6 | 107 (8, 96-113), 6 | +12 | 17 | -8, 16 | no regression measured |
| large / defaults / fresh | Preview on | input-to-paint | 450 (20, 442-482), 20 | 231 (13, 221-248), 20 | -218 | 45 | -234, -227 | improvement measured |
| large / defaults / fresh | Preview on | settled | 663 (9, 658-684), 20 | 400 (19, 385-437), 20 | -262 | 66 | -251, -272 | improvement measured |
| large / defaults / fresh | Preview off | input-to-paint | 157 (5, 152-162), 20 | 163 (6, 158-174), 20 | +6 | 16 | 5, 8 | no regression measured |
| large / defaults / fresh | Preview off | settled | 163 (5, 158-169), 20 | 179 (6, 174-192), 20 | +16 | 16 | 14, 18 | no regression measured |
| large / defaults / fresh | IR→Split | input-to-paint | 1163 (29, 1135-1188), 20 | 1213 (36, 1189-1271), 20 | +50 | 116 | 47, 63 | no regression measured |
| large / defaults / fresh | IR→Split | settled | 2662 (60, 2614-2748), 20 | 2803 (84, 2734-2959), 20 | +141 | 266 | 93, 153 | no regression measured |
| large / defaults / fresh | Split→IR | input-to-paint | 498 (21, 482-525), 20 | 512 (12, 504-533), 20 | +14 | 50 | 9, 25 | no regression measured |
| large / defaults / fresh | Split→IR | settled | 583 (23, 566-707), 20 | 605 (14, 600-631), 20 | +22 | 58 | 17, 35 | no regression measured |
| large / defaults / reuse | Preview on | input-to-paint | 92 (11, 85-123), 6 | 86 (2, 85-93), 6 | -6 | 22 | -39, 2 | no regression measured |
| large / defaults / reuse | Preview on | settled | 154 (41, 143-483), 6 | 145 (3, 144-157), 6 | -9 | 81 | -430, 4 | no regression measured |
| large / defaults / reuse | Preview off | input-to-paint | 174 (37, 159-216), 6 | 162 (8, 156-169), 6 | -12 | 74 | -63, 4 | no regression measured |
| large / defaults / reuse | Preview off | settled | 182 (38, 165-224), 6 | 177 (9, 170-186), 6 | -4 | 77 | -55, 12 | no regression measured |
| large / outline / fresh | Preview on | input-to-paint | 531 (83, 473-667), 20 | 236 (10, 230-247), 20 | -295 | 166 | -432, -242 | improvement measured |
| large / outline / fresh | Preview on | settled | 928 (20, 923-954), 20 | 435 (33, 407-483), 20 | -493 | 93 | -507, -519 | improvement measured |
| large / outline / fresh | Preview off | input-to-paint | 208 (44, 165-251), 20 | 164 (5, 160-172), 20 | -44 | 87 | -82, -4 | no regression measured |
| large / outline / fresh | Preview off | settled | 217 (46, 172-263), 20 | 180 (6, 176-189), 20 | -37 | 93 | -78, 5 | no regression measured |
| large / outline / fresh | IR→Split | input-to-paint | 1618 (80, 1316-1666), 20 | 1255 (24, 1232-1281), 20 | -363 | 162 | -399, -75 | improvement measured |
| large / outline / fresh | IR→Split | settled | 3721 (493, 3444-4236), 20 | 3304 (130, 2849-3358), 20 | -417 | 986 | -857, -625 | no regression measured |
| large / outline / fresh | Split→IR | input-to-paint | 626 (117, 562-750), 20 | 545 (15, 528-557), 20 | -81 | 234 | -197, -28 | no regression measured |
| large / outline / fresh | Split→IR | settled | 874 (299, 634-1179), 20 | 624 (18, 612-1003), 20 | -250 | 598 | -555, 180 | no regression measured |
| large / outline / reuse | Preview on | input-to-paint | 122 (37, 86-164), 6 | 107 (15, 95-130), 6 | -15 | 74 | -69, 49 | no regression measured |
| large / outline / reuse | Preview on | settled | 374 (232, 144-607), 6 | 169 (15, 155-206), 6 | -205 | 463 | -451, 72 | no regression measured |
| large / outline / reuse | Preview off | input-to-paint | 196 (46, 167-250), 6 | 170 (3, 167-173), 6 | -26 | 92 | -90, 5 | no regression measured |
| large / outline / reuse | Preview off | settled | 207 (44, 175-261), 6 | 187 (4, 184-190), 6 | -20 | 89 | -84, 17 | no regression measured |

Source line numbers on (dev only; the reference has no such setting; compare with the dev defaults rows above):

| Switch (dev only, gutter setting on, large) | Metric | Median (MAD, IQR), n=20 |
|---|---|---|
| Split→IR | input-to-paint | 512 (17, 508-538) |
| Split→IR | settled | 606 (18, 596-722) |
| Preview off | input-to-paint | 161 (6, 156-170) |
| Preview off | settled | 177 (9, 170-188) |
| Preview on | input-to-paint | 230 (9, 222-240) |
| Preview on | settled | 395 (18, 381-423) |
| IR→Split | input-to-paint | 1197 (31, 1173-1230) |
| IR→Split | settled | 2796 (72, 2737-2939) |

### Verdicts per switch

- **Preview on: regression measured** in one cell only. Mid fixture (54,600 bytes, fresh content), input-to-paint: reference 42 ms, dev 72 ms (+30 ms, both sessions +28 and +31, threshold 16). The same cell settles 36 ms earlier on dev (improvement measured). Small fixture: no regression measured (input-to-paint and settled both lower on dev, not past the rule). Large fixture (streamed on dev): improvement measured, input-to-paint 450 → 231 ms and settled 663 → 400 ms. Outline open (large): improvement measured, settled 928 → 435 ms. Reuse: no regression measured on mid (+20 ms input-to-paint, per-session +12 and +23; the first session pair is below 16 ms, so the rule is not met), improvement on small.
- **Preview off: no regression measured** in any cell (largest difference +16 ms settled on large, equal to the threshold, not above it).
- **IR→Split: no regression measured** in any cell. Split settle time is high on both revisions (about 0.9 s small, 0.7 s mid, 2.7 s large), so the slowness is not new. Outline-open large shows lower input-to-paint on dev.
- **Split→IR: no regression measured** in any cell.
- Source line numbers on: IR→Split and Split→IR medians are within the dev defaults noise (IR→Split settled 2,796 vs 2,803 ms; Split→IR settled 606 vs 605 ms).

### Notes for the next step (no conclusion drawn)

- The measured Preview on gap on the mid fixture is in the click-to-paint time only. The settled time and every other fixture do not show it.
- Small-fixture dev sessions were noisy (MAD up to 148 ms in the Split→IR input-to-paint), so small-fixture verdicts have wide thresholds.
- The sanity check "rerun one dev session within the rule" is covered by the two dev sessions: per-session differences agree in sign wherever a regression or improvement is claimed.

## Part 2 step 2 (2026-11-02): attribution

Scope: only the regression measured in step 1 (Preview on, mid fixture of 54,600 bytes, fresh content, input-to-paint 42 ms on the reference and 72 ms on dev). Build and revision unchanged from step 1 (`6a1a6e19`). The probe gained an attribution mode (route switch, call timers, optional CPU profile); the same `@probe` spec file is used.

### 1. Runtime A/B on dev (one session per run, 2 sessions)

After readiness, route A keeps `window.__vmdeRenderFullPreview` and `window.__vmdeFullPreviewOwnsOutline`; route B deletes both, so Vditor's own render runs as in the reference. Each cycle runs A (invalidate, Preview on, Preview off) and then B, interleaved A/B/A/B over 2 warm-up and 10 measured cycles, in 2 sessions (n = 20 per route and switch). Load average (1 min) at the start of the two sessions: 1.17 and 1.15.

| Switch | Metric | A unchanged: median (MAD, IQR) | B hooks removed: median (MAD, IQR) | B minus A | Threshold | Per session |
|---|---|---|---|---|---|---|
| Preview on | input-to-paint | 68 (3, 65-71) | 42 (4, 39-47) | -26 | 16 | -22, -25 |
| Preview on | settled | 97 (7, 92-117) | 113 (15, 103-130) | +16 | 29 | +30, +11 |
| Preview off | input-to-paint | 69 (3, 66-72) | 70 (4, 67-75) | +1 | 16 | +5, -2 |
| Preview off | settled | 79 (3, 77-83) | 79 (5, 75-85) | 0 | 16 | +1, -1 |

Verdict: **the gap closes.** With the full-Preview route removed, input-to-paint is 42 ms, equal to the reference median of 42 ms, and 26 ms below the unchanged route (same sign and above 16 ms in both sessions). Settled time is not worse beyond noise (+16 ms against a threshold of 29 ms). Preview off does not depend on the route.

### 2. Call timers (dev, route unchanged, 10 measured Preview on samples per fixture)

Wrappers on the hook, `__vmdeMorphPreview`, `lute.Md2HTML`, `outline.render` and `preview.render`. `outline.render` was not called with the outline panel closed. Times in ms from the click, medians.

| Fixture | Input-to-paint | Hook duration (synchronous in the click task) | First `Md2HTML` starts at | `Md2HTML` total (calls) | `morph` starts at |
|---|---|---|---|---|---|
| mid | 73 | 39 (samples 44 and 53) | 21 (samples 26 and 37) | 27 (5) | 69 |
| large | 197 | 111 | 95 | 120 (13) | 284 |

On the mid fixture the hook runs about 21 to 37 ms of whole-document work before the first `Md2HTML` call, then three chunk renders of about 18 ms, then yields. The remaining chunks and the morph run after the first paint. So the synchronous part of the click is the pre-passes plus the first stream slice, and it matches the measured +26 to +30 ms.

CPU profile: the Profiler domain attached to the workbench page only; the profile held no webview functions (idle 97%, no `Md2HTML`, no hook). The webview target did not attach through the test driver's page. No profile of the webview exists. The call timers above replace it.

### 3. Comparison with the hypotheses

- Hypothesis 1 (render moved from a follow-up task into the click task): **confirmed** by the A/B (26 ms of the 30 ms gap) and by the hook duration (39 ms). Probability for this attribution: about 0.95.
- Hypothesis 4 (whole-document passes, `maskPreviewSource`, `planPreviewChunks`, `buildDefMap`): larger than estimated. They are about half of the synchronous cost on mid (21 to 37 ms before the first chunk) and 95 ms on large. Part of hypothesis 1, not a separate cause.
- Hypothesis 3 (streaming): does not cost time to first paint on mid. The large fixture benefits from it (step 1: 450 to 231 ms).
- Hypotheses 2 and 5: not exercised here (outline closed). Step 1 outline-open variant already showed an improvement, not a regression.
- No bisect was needed: the A/B explained the gap, so no build was made for the commits of section 1.

### 4. Attribution

Commit `6dede194` (Task 643), function `renderNow` in the hook installed by `installFullPreviewRoute` (`media-src/src/editing/preview-render.ts`), called synchronously from `Preview.render` when the toolbar click passes `immediate`: the pre-passes and the first stream slice run in the click task, before the first paint. The reference started that work in a zero-delay task after the paint.

### 5. Fix proposal and accepted-cost case

- Size of the effect: +30 ms input-to-paint on a 54,600-byte document; no regression on 17,549 bytes (improved) and 174,527 bytes (improved by 218 ms input-to-paint and 262 ms settled). Preview off, IR→Split and Split→IR: none. Settled time on mid improved by 36 ms.
- Recommended fix (Light): in the hook, when `immediate` is true, start `renderNow` after the first paint (a double animation frame or a zero-delay task, as the reference did) instead of inside the click task, and keep the existing token so a Preview off in between cancels it. Keep the Task 530 reuse, the streaming and the viewport gate. Do not move the streaming yields. Expected result: mid input-to-paint back to about 42 ms; settled time rises by up to one frame.
- Risk to check in the fix step: Preview Find, reading-position restore and the outline-before-paint behaviour assume the content exists right after the click; the scroll pin starts at click time. A Vitest test for the scheduling (render not called before the callback runs, cancelled by Preview off) and the probe rerun on dev are needed.
- Accepted-cost alternative: 30 ms on one mid-size document is below the 100 ms the Task 643 record measured for a 50 KB pass and is outweighed by the large-document gain. If the Owner prefers no change, record it as accepted with these numbers.
- Tier for the fix step: Light (one function, one Vitest test, one probe rerun).

### 6. Status

- [x] Runtime A/B, interleaved, with the step 1 sample count and noise rule.
- [x] Call timers; CPU profile attempted (not attached to the webview; recorded).
- [x] Bisect not needed.
- [x] Attribution, fix proposal and accepted-cost case recorded. No fix implemented.

## Part 2 fix (2026-11-02): defer the Preview render after the first paint

Provisional decision (2026-11-02), reversible: fix, not accepted cost. The Owner reported the slowdown, and the fix keeps the large-document gain.

### Change

`installFullPreviewRoute` (`media-src/src/editing/preview-render.ts`): an immediate render (the toolbar click, a host refresh) no longer calls `renderNow` inside the click task. The hook returns `true` and starts the render in a zero-delay task, as the route before Task 643 did. It uses the same pending-start timer as the debounced path, so Preview off (`watchPreviewHidden`), a newer render and dispose clear it, and a render that cannot run falls back to Vditor's own render. A non-immediate render keeps the Preview delay. Nothing else changed (Task 530 reuse, streaming, viewport gate, outline in `finish`).

Dependency check: the completion signal that Preview Find, the reading-position restore (`restorePendingScroll`) and the outline-in-`finish` use is `__vmdePreviewRendered`, which `finish` still calls after the render; none reads the pane right after the click. The scroll pin starts at the click and holds for the render (it already waits for content growth).

### Tests

- RED (unchanged product): five new scheduling tests in `media-src/src/editing/preview-render.test.ts` failed (5 failed, 31 passed): "returns at once without rendering, then renders in the next task", "is cancelled by Preview off before it starts", "renders once when a newer immediate render replaces it", "is dropped when the route is disposed", "lets Vditor render when the one-pass render fails".
- GREEN: the five pass. Four older tests that expected a synchronous immediate render now wait one task; the superseded "declines when the one-pass render fails" test was replaced by the fallback test above. `preview-render.test.ts`: 35 passed. The `media-src/src/editing` suites and `test/backend/vditor-source-patches.test.ts`: 104 files, 3181 tests passed.
- Real VS Code (one run): `preview-caret`, `preview-mode-features`, `preview-mode-find`, `preview-mode-open-switch`, `preview-mode-stream` passed. `preview-mode-timing` failed once (150,000 characters: Preview visible 783 ms against a limit of 630 ms) while another agent kept the machine at load 5 to 12; rerun alone at the next quiet moment it passed (150,000 characters: Preview visible 295 ms, complete 592 ms, against IR 655 and 661 ms).

### Probe on the fix build

Two sessions per fixture (10 measured cycles each, n = 20), fresh content, same noise rule as step 1. The first session ran with the 1-minute load at 8.2 at its start (mid at 7.63, large at 3.39); the second at 1.5. Medians in ms (MAD).

| Fixture / switch | Metric | Reference | Dev before fix | Fix | Fix minus reference | Threshold | Per session (fix) |
|---|---|---|---|---|---|---|---|
| mid / Preview on | input-to-paint | 42 (4) | 72 | 55 (11) | +13 | 22 | 31, 58 |
| mid / Preview on | settled | 138 (6) | 102 | 106 (11) | -32 | 22 | 120, 98 |
| large / Preview on | input-to-paint | 450 (20) | 231 | 86 (2) | -364 | 45 | 85, 86 |
| large / Preview on | settled | 663 (9) | 400 | 380 (7) | -283 | 66 | 374, 382 |

The mid input-to-paint median is within the noise rule of the reference (+13 ms is below the 22 ms threshold and the per-session differences, -11 and +16, differ in sign): no regression measured. The first session was taken under load and its spread is wide (IQR 27 to 60 ms). A quiet-machine check on the fix build, same session, hook route A (fixed) against route B (hook removed, Vditor's render): input-to-paint 53 (MAD 2) against 39 (MAD 3), +14 ms, below the 16 ms floor, n = 10; settled 90 against 106. So about 14 ms of the former 26 ms remain; they are below the rule and are not pursued. A variant that waits for a frame before the timer would remove them at a cost of up to one frame in settled time; it was not built.

The large fixture keeps its gain and gains more (input-to-paint 231 to 86 ms against 450 ms on the reference). Preview off, IR to Split and Split to IR on mid and large stay within the noise of the reference (all differences below their thresholds; mid Split settled -105 ms).

### Checks

- `npm run typecheck`: pass. `npx biome check` on the changed files and the probe: pass. `node build.mjs`: exit 0.
- `npm run quality`: `check:brand-identifiers`, `lint:ci`, `knip`, `jscpd`, `depcruise` pass. `test:coverage` failed in the first run on one 5 s test timeout in `toolbar-overflow.test.ts` (machine at load 10; unrelated file); rerun alone: 384 files, 8506 tests passed; `check:coverage-modules` then passed (9 modules at 0%, baseline 9). `audit` fails with 11 advisories (6 moderate, 5 high) in the dependency tree, unchanged by this work; omitted by the Owner's rule for this run, to be reported.

### Probe spec

Kept as `test/vscode-e2e/mode-switch-timing-probe.spec.ts`, tagged `@probe`. It is excluded from the default suite (0 tests listed without `VMDE_PROBES=1`, 5 with it) and runs with `VMDE_PROBES=1`. Its attribution mode (`VMDE_PROBE_ATTR=ab|wrap`, `VMDE_PROBE_PROFILE=1`) stays for later use.

### Closure note (2026-11-02)

- `preview-mode-timing.spec.ts` (150 KB, Preview complete against IR complete) is marginal on both revisions: with this fix it failed once at 631 ms against a 629 ms limit; on unchanged `dev` (`6efcab8d`) it passed once and failed once (633 ms against 629 ms) at load 0.5. The failure predates this task and is handed to Task 695 (gate completion, unconfirmed failures).
