# Task 703 — Older real-VS-Code failures in table-operations, marker-reveal, rewrap, callout-edit and section-fold

**Status:** ✅ done (2026-11-08); the undo-snapshot caret restore behind `marker-reveal:172` and the `rewrap` caret offset moved to [Task 708](../708-undo-snapshot-caret-restore-moves-the-caret-back-into-a-marker-or-to-offset-0.md).
**Origin:** Gate rerun at `f84a4258` (Task 695); each spec file failed alone too.
**Severity:** low (estimated; mostly test defects, one possible product layout defect).
**Tech stack:** `test/vscode-e2e/{table-operations,marker-reveal,rewrap,callout-edit,section-fold}.spec.ts`; `media-src/src/nav/block-handle.ts`, callout context panel.
**Depends on:** none.

## Problem

Each case below has its own cause; each is listed separately:

- `table-operations.spec.ts:48` (WYSIWYG rectangle copy): the spec expects the padded row `| r0a  | r0b  |` and receives `| r0a | r0b |`, which equals the fixture source and the IR expectation (the Task 699 record listed it the wrong way round). Failing since the spec moved to XTEST keys (Task 578, 2026-09-27).
- `table-operations.spec.ts:242`: mode stays `ir`, so the WYSIWYG range transaction never becomes ready; the spec clicks the mode menu with no readiness wait.
- `marker-reveal.spec.ts:172` (fails at `:165`): the parent keeps class `vditor-ir__marker` after Home/End; the check reads the caret once, possibly before the frame that moves it.
- `rewrap.spec.ts:116` (fails at `:423`, sometimes `:308`): `scrollKept` false; recorded as a known failure since Task 606 (2026-10-14).
- `callout-edit.spec.ts:41` (fails at `:126`): the click on `after paragraph` is intercepted by `.vmde-callout-controls` in `.vmde-callout-context-panel`; failing since at least 2026-10-19.
- `section-fold.spec.ts:495` (fails at `:1000`): `.vmde-block-handle` stays visible after the post-normalization decline; failing since at least Task 641 (2026-10-15); candidate `bb4cbf18` (Task 607).

## Proposed work

1. Probe each case on current `dev` with one change at a time (poll instead of one-shot read; readiness wait; log values; read panel and paragraph rects); bisect `section-fold` at `bb4cbf18^` vs `bb4cbf18`.
2. Decide test defect or product defect per case from the measurement.
3. Fix with a failing test first.

## Acceptance

- [x] Each case has a measured cause and a test-or-product call. Test defects: `table-operations:48`, `:242`, `callout-edit:41`, `rewrap:116` scroll check, `section-fold:495` (stale since Task 607). Product: `marker-reveal:172` and the `rewrap` caret offset (Vditor undo snapshot `addCaret` restores the caret into the closing marker or to offset 0).
- [x] Each product cause is fixed with a test that fails before and passes after. Provisional decision of the orchestrator (2026-11-08): the undo-snapshot caret restore moves to Task 708 with the open follow-up on the `addCaret` patch; no product change in this task.
- [x] The listed cases pass in one real-VS-Code run. The fixed cases pass 2 of 2 each (Part 2b, 2c); `marker-reveal:172` and the `rewrap` caret check (2 of 8 fail) are acceptance tests of Task 708.

## Tests to write

- The fixed specs; a test per product cause.

## Part 2a results (2026-11-08)

Measurement only; no product or spec change. Run on `dev` `58a3caaa` (build once). Probe spec copies and logs are in the untracked `tmp/703/` (`specs/`, `probe.log`, `base-*.log`, `probe-*.log`, `bisect-*.log`). The brief pointed to a "Part 2 plan" in the Task 699 record, which does not exist on `dev`; the probes below follow the Task 703 "Proposed work" list instead.

Baseline (current `dev`, one case alone, 2 runs each): `table-operations:48` fail, fail; `table-operations:242` fail, fail; `marker-reveal:172` fail, pass; `rewrap:116` fail (`:423`), fail (`:310`); `callout-edit:41` fail, fail; `section-fold:495` fail, fail. All six stay in scope; `marker-reveal` passes only 1 of 2.

### table-operations.spec.ts:48 — test defect (high confidence)
- Probe: logged the WYSIWYG copy markdown next to the fixture row. WYSIWYG copy = `| r0a | r0b |\n|---|---|`; IR copy = same; fixture row = `| r0a | r0b |`. The `before` value shows the aligned form (`| r0a  | r0b  |`) only in the document value, not in the copied markdown.
- Change: line 119 expects `'| r0a | r0b |\n|---|---|'` (the same string as the IR expectation at line 118).

### table-operations.spec.ts:242 — test defect (high confidence for cause; 1 run for the fix)
- Probe: before the mode-menu click, wait with `waitForE2EReadiness(frame, s => s.routerReady && s.mode === 'ir')` (the same wait as the `:48` case). Case passed (1 of 1). Without the wait the snapshot at failure is `{"routerReady":true,"mode":"ir","editorEpoch":1,"modeEpoch":1}`: the click lands before the mode switch is accepted.
- Change: add that readiness wait after `.vditor-ir td` appears and before the `edit-mode` click.

### marker-reveal.spec.ts:172 — not a one-shot-read defect; cause open (low confidence)
- Probe: replaced the one-shot `parentClass` read at `:165` with a per-frame loop (up to 40 samples, then a 5 s `expect.poll`). 3 runs: pass, fail, fail. Failing samples never cleared: `End` on `real-end-code` kept `vditor-ir__marker` for the whole 4 s loop; `End` on `real-end-link` kept `vditor-ir__marker vditor-ir__marker--paren`. Samples before them (all `Home` cases, `End` bold) read an empty class at once.
- So polling does not fix it. After `End` on a trailing inline element the caret anchor sits in the trailing marker element in some runs, in others not. Leading hypothesis: product defect in the "protect hidden inline markers" caret placement at line end (typing there would land in the marker). Not proven; needs a caret-anchor probe (anchor node, offset, marker text) before a fix or a spec change.

### rewrap.spec.ts:116 — test defect for the scroll check (medium confidence); a second failure remains open
- Probe: logged `saved.top`, `scrollTop`, `scrollHeight`, `clientHeight` before, right after, and after `vmde.rewrap` / `vmde.rewrapDocument` (3 + 3 runs). The saved "scroller" is `.vditor-content`; its inline `height: 80px` does not apply (computed height 724.6 px). `scrollHeight` 726 vs `clientHeight` 725, so the range is 1 px: `scrollTop = 20` clamps to 1 (IR, WYSIWYG) and 0 (SV). The values do not change across `vmde.rewrap` (1 → 1). In the `vmde.rewrapDocument` phase `scrollTop` is already 0 before the command in 3 of 3 IR runs (a 1 px clamp reset after `replaceDocument`/`switchMode`), so `scrollKept` (`:423`) compares noise.
- Proposed change: build a real scroll range (a scroller whose height is forced with `!important`/`flex: none`, and content taller than it) and read the baseline just before the command. Forcing 80 px alone is not enough: with it the run failed at `:318` (`sourceCaretOffset` expected 13, received 0), the same failure as baseline run 2 (`:310`).
- Open: the caret offset 0 (vs 13) after `vmde.rewrap`, and one run where `vmde.rewrapDocument` left the document unchanged (3 runs after a probe edit). These look like timing in the product or the harness; not measured. Not a one-line fix.

### callout-edit.spec.ts:41 — panel covers the paragraph; test defect (high confidence), orchestrator decides on the design
- Probe: rects just before the click at `:126` (viewport px): quote `{52,250,580,308}`; `.vmde-callout-context-panel` `{52,316,489,350}`; `.vmde-callout-controls` `{53,317,488,349}`; `after paragraph` `{52,324,580,345}`. The panel lies below the quote and fully covers the paragraph's left 437 px. The first click (`:78`) runs before the panel exists, so it passes.
- By design? `contextual-panel-clearance.spec.ts` guarantees only that the panel stays inside the viewport/scroller (8 px), clears the owning quote (7 px above or below) and clears the caret rect. It makes no guarantee about the neighbouring paragraph, so the overlap is allowed by the current guarantees.
- Verified change (2 of 2 passes in a copy): click with a position to the right of the panel, `.click({ position: { x: 500, y: 8 } })`, for the clicks at `:126` and `:137`.
- Open design question for the orchestrator: whether the panel should also clear the next block.

### section-fold.spec.ts:495 — behaviour change from Task 607 commit `1d8e37a9` (medium confidence)
- Bisect (scratch detached worktree, removed afterwards): `bb4cbf18^` fails, `bb4cbf18` fails (2 runs each, same line `:1000`), so the commit named in the record is not the cause. Next bisect step: `1d8e37a9^` passes (1 run), `1d8e37a9` fails (1 run) — "keep exact ownership through trusted edits and guard exact host writes", 2026-10-14. Single run per side.
- Handle rule probe on `dev` (hover over `pointer parent` after the native click normalized the value): handle `hidden: true` right after the hover, `hidden: false` (left 28 px, top 73 px) 1.5 s later, and it stays visible for the 5 s `toBeHidden` wait. This matches `showHover`/`retryUnitlessHover`: a hover with no owned exact source stays hidden, then shows once the index announces a revision. Since `1d8e37a9` the index keeps exact ownership across the normalizing edit, so the "post-normalization decline" (added in `5c25770b`, 2026-09-24) no longer happens.
- Classification: the spec expectation is stale if keeping ownership through the fold-click normalization is intended (change: assert the handle is visible and aligned, or drop the branch); a product defect only if the handle must decline after that normalization. Decision for the orchestrator.

## Orchestrator decisions (2026-11-08; provisional, on the Owner's behalf, reversible)

- **D1 `table-operations:48`, `:242`:** test defects; fix the specs as Part 2a proposes (unpadded expectation; readiness wait before the mode click).
- **D2 `callout-edit:41`:** the callout context panel may cover the next paragraph (the clearance contract covers only its own quote, the caret and the viewport edges); test defect: click outside the panel as Part 2a proposes.
- **D3 `rewrap:116` scroll check:** test defect (no real scroll range); fix the spec setup. The caret offset 0 after `vmde.rewrap` and the unchanged-document run go to a reasoning pass with `marker-reveal:172` and `section-fold:495`.

## Part 2b results (2026-11-08)

Test-only fixes for D1–D3; each spec run alone, `--repeat-each=2`, one worker, no retries.

- **D1 (`table-operations.spec.ts`):** `:48` now expects the unpadded WYSIWYG copy `| r0a | r0b |\n|---|---|`; `:242` waits for `routerReady && mode === 'ir'` before the mode click. Result: 4 of 4 pass (2 per case).
- **D2 (`callout-edit.spec.ts`):** the three clicks on `after paragraph` made while the context panel can be open (before the callout-body typing, the leave click, and the final leave click) use `{ position: { x: 500, y: 8 } }`, with a comment citing the clearance contract in `contextual-panel-clearance.spec.ts`. The click at `:78` stays (the panel does not exist yet). The first run fixed only two clicks and failed 1 of 2 at the third (`:192`, same panel interception); after fixing it: 2 of 2 pass.
- **D3 (`rewrap.spec.ts`):** `placeCaret` forces the scroller height with `!important`, adds 600 px bottom padding for a real scroll range, and a `markScrollBaseline()` helper reads the baseline right before `vmde.rewrap` and `vmde.rewrapDocument`. Result: 2 of 2 pass. The caret offset 0 vs 13 failure (`:318`) did not appear in these 2 runs; it stays open for the reasoning pass with `marker-reveal:172` and `section-fold:495`.
- Checks: `npm run typecheck:vscode-e2e` exit 0; `npx biome check` on the three specs exit 0. Logs: `tmp/703/p2b-*.log`.

## Part 1 decisions (2026-11-08)

Read-only reasoning on the Part 2a measurements, the source, and the Task 569 and Task 607 records. No product or spec change and no real-VS-Code run in this part.

### Q1 `section-fold.spec.ts:495` (fails at `:1000`) — spec stale (confidence 0.8)

- The branch at `:996`–`:1001` came with `5c25770b` (Task 569). Task 569 did not require a decline after normalization: its record covers handle placement beside the fold controls ("without changing which source groups receive handles"). The decline was a side effect of the pre-607 rule: after a trusted edit the webview lost exact ownership, the source pair no longer matched, and `resolveBlockHandleUnits` failed closed.
- Task 607 changed that rule on purpose. Decision 1 (`tasks/done/607-exact-actions-after-trusted-edit.md`, "Decisions") accepts a display gap after a trusted edit: the handle stays hidden only until a background authority acquire completes. Step S4b (`bb4cbf18`) added the end of that gap: `source-block-index.ts` announces a `revision` when the acquire is adopted, and `block-handle.ts` `retryUnitlessHover` shows the handle for a resting hover. This matches the Part 2a probe exactly: hidden at hover, visible about 1.5 s later, still visible at 5 s.
- The handle comes back only from an owned exact source whose projection proof matches the live DOM (`resolveBlockHandleUnits`). No exact-ownership rule is weakened. The host bytes stay the authored bytes (the spec's own save check at `:1010` and `:1018` passes in the same flow).
- Bisect note: `1d8e37a9` already fails, before the retry in `bb4cbf18`. At that revision the handle can show without the retry, for example when the rebase keeps ownership or another consumer rebuilds the entry. Either way, the decline is gone because of Task 607's ownership change. Nothing points to a separate product defect.
- **Change (spec only, `test/vscode-e2e/section-fold.spec.ts:996`–`:1001`):** keep the hover. Replace `await expect(freshHandle).toBeHidden()` with `toBeVisible()`, using the default 5 s poll, which covers the round trip of about 1.5 s. Then assert that the handle does not overlap `listGutterBox(listItem(frame, 'pointer parent')).box`, as the spec already does for the fresh handle at `:971`. Update the comment: "Task 607 decision 1: after the normalization the handle returns once the exact source is acquired again." No product test is needed: the S4b unit tests in `block-handle.test.ts` (a resting hover shows the handle after an adopted acquire; a failed acquire keeps it hidden) already cover this rule. Run first: the changed spec alone, which fails today at `:1000` and should pass after the change.

### Q2 `marker-reveal.spec.ts:172` (fails at `:165`) — mechanism not proven (confidence 0.5); leading hypothesis is a product-side caret interaction

- What the source rules out. No VMDE or Vditor handler acts on `End` in IR. Vditor's IR keyup calls `expandMarker` only for Arrow keys and `keyCode 229` (`vditor/src/ts/ir/index.ts:249`). Trailing-paragraph navigation handles only ArrowDown. `ir-page-navigation.ts` handles only PageUp and PageDown. So the native End moves the caret into the closing marker (`` ` `` for code, `)` with `vditor-ir__marker--paren` for link), and `installIrMarkerReveal`'s frame (`editor-caret.ts` `apply` and `normalizeMarkerNavigationCaret`) is the only code that ejects it.
- What the 4 s persistence requires. After the End frame, either the ejection was declined, or the caret was put back afterwards with no later normalizing frame. A normalizing frame does not follow because `apply` returns early when the range equals `lastRange` (`sameRange`). For a closing marker of a node that was expanded before the key (true here: `placeInline` expanded it), the ejection is declined only through `allowVisibleMarkerEdit || hasLiveCaretIntent()`. The keydown clears the flag, so a declined ejection means that a caret intent (`caret.ts`) was live when the frame ran.
- Leading hypothesis H1: an intent is armed on the in-marker range between End and the frame, or in the same frame. The likeliest writer is `focus-restore.ts`: a window `focus` or editor `focusout` restore, one frame later, calls `requestCaret({node, offset})` with the live range. The intent then re-asserts that range on every frame for up to `MAX_TOTAL_TICKS = 300` frames (about 5 s). While it is live, `apply` keeps the marker landing. After it retires, nothing moves the caret. This explains the intermittent failure (focus handover timing in VS Code), the persistence for the whole 4 s loop, and why `Home` cases and `End` bold passed in the same runs. It is not proven: no measurement links a focus event or an intent to the failing frame.
- Alternative H2: the ejection runs, then a DOM rebuild puts the caret back into the marker. Candidates: a late publication or host echo of the previous sample's typed character, or a selection-time decoration such as `caret-link-decorate.ts`. Alternative H3: the frame never normalizes, because `selectedRangeInIr` returns `null` (for example, `composingLock`) or `sameRange` matches an earlier stored range.
- Product impact if H1 holds. Typing at the end of a closing marker probably serializes to the same Markdown (`` `c `` after `real-end-code` re-parses as code plus `c`). The visible symptom is the caret inside revealed syntax, and any intent armed on a marker landing suppresses the Task 286 ejection. The fix would be in the product (for example, a marker landing re-armed by a caret restore still goes through the ejection). That is a design question for the orchestrator, not a spec change. Do not change the spec to poll longer or to drop the check: Part 2a showed that polling does not help.
- **Discriminating probe (copy of the spec only, no product change):** before each `End` press, install the following in the webview page, through `frame.locator('body').evaluate`:
  1. Wrap `Selection.prototype.addRange`, `setBaseAndExtent`, `collapse`, and `removeAllRanges` to log `performance.now()`, the target node's class and offset, and `new Error().stack` (first 6 frames). If the e2e bundle is minified, build with source maps so the stacks name functions.
  2. Add capture listeners on `window` `focus`/`blur` and on `document` `focusin`/`focusout`, `keydown`, `keyup`, and `selectionchange`, each logging a timestamp.
  3. Add a `MutationObserver` on the sample's paragraph (`childList`, `characterData`, `subtree`) that logs records with timestamps.
  4. Add a `requestAnimationFrame` sampler for 60 frames that logs the anchor's parent class and offset.
  Read the log after the press (keep the 4 s check so the failing runs are recorded too). Run the spec copy alone 6 times (the baseline failure rate was about 1 of 2).
- Expected results per hypothesis:
  - H1: in failing runs, a `focus`/`focusout` event, or another `requestCaret` caller, appears after `keydown End`. Its stack shows `restoreEditorFocus` → `requestCaret` (or another `requestCaret` caller), followed by about one write per frame from `tick` → `tryPlace` with the in-marker target for up to about 5 s. The sampler never shows the paragraph-level position (`{p, index + 1}`, parent class `''`). Passing runs show no such event.
  - H2: the sampler shows the outside position (parent class `''`) for at least one frame, then the marker again. Childlist or characterData records on the paragraph come in the same frame, and the stack of the write names a Vditor spin (`setRangeByWbr`) or a VMDE decorator.
  - H3: no selection write at all after the native End, no focus event, and the sampler shows the marker from the first frame. To tell H3 from an intent that left no write, log `window.vditor.ir.composingLock` in the sampler.
- Second opinion: if the probe confirms H1, the open question is design (should a live caret intent ever keep a marker landing, or should focus-restore not re-arm on a marker range). That needs the probe log, `editor-caret.ts` `apply` and `normalizeMarkerNavigationCaret`, `focus-restore.ts` `restoreEditorFocus`, and `caret.ts` `requestCaret`, `tick` and `MAX_TOTAL_TICKS`. Smallest reproduction: the spec copy with only the `real-end-link` and `real-end-code` samples, after one prior typed sample.

### Q3 `rewrap.spec.ts` caret offset 0 instead of 13 (`:318` in the probe copy, `:323` in the fixed spec) — keep open, low priority (confidence 0.6 that it is not a defect of the D3 fix)

- Correction: the failure was seen twice, not once. It appeared in baseline run 2 (`tmp/703/base-2-rewrap.spec.ts:116.log`, `:310`, 9.2 s, so in the first loop iteration) and in the probe `p703-rewrap3` (`:318`, IR, the first iteration; `probe.log` shows the scroller at 80 px with a scroll range of 1 px). It did not appear in the 2 Part 2b runs with the D3 setup. Both failures happened in the IR iteration that runs right after the document opens, which points to a caret write racing with the rewrap's own write. Neither failure points to the scroll check.
- Mechanism (source reading). `rewrap-command.ts` `removeRenderedCaret` calls `editor.focus()` and then `requestCaret({ textOffset })`. That intent stays live until a gesture or the 5 s backstop. An offset of 0 means that something later wrote a document-start position, or that the intent did not resolve. Candidates: the initial-caret `'document-start'` intent (`initial-caret.ts:88`), a focus restore (`focus-restore.ts`, which re-arms with the live range), or a host echo that re-renders the IR DOM after the command. This is the same family as Q2 H1, which is a reason to run both probes in one round.
- Decision: do not close it as "not reproduced" from 2 passing runs. Two options for the orchestrator:
  - (a) Recommended: run the fixed `rewrap.spec.ts` alone with `--repeat-each=8`. With 0 failures, close the case as not reproduced under the D3 setup and record the 2 earlier occurrences.
  - (b) Probe it now. In a spec copy, log `sourceCaretOffset` right before `vmde.rewrap` (expected 13), and wrap the selection writers as in Q2 with stacks and timestamps relative to the command, from the command until the `docText` poll ends.
- Expected probe results: a late override shows a write to offset 0 after the rewrap's write, with a stack naming `requestCaret('document-start')`, `restoreEditorFocus`, or a Vditor `setValue`/spin. An unresolved intent shows no write at 13 at all, and the `tick` misses run out within about 1.5 s. A wrong baseline shows `sourceCaretOffset` before the command not equal to 13 (a `placeCaret` race; then it is a test defect: wait for the caret before running the command).

## Part 2c results (2026-11-08)

One `node build.mjs` (exit 0); no product change. Logs: `tmp/703/p2c-*.log`, `tmp/703/marker-probe.log`; the probe spec copy is `tmp/703/specs/p703c-marker.spec.ts`.

### Q1 `section-fold.spec.ts` (spec fix) — 2 of 2 pass
The post-normalization branch now hovers `pointer parent`, expects `toBeVisible()` (default poll), and asserts that the handle rect does not overlap `listGutterBox(...).box` of that item (same check as the fresh handle). The comment cites Task 607 decision 1. `npm run typecheck:vscode-e2e` and `npx biome check` exit 0.

### Q2 `marker-reveal:172` — H2 supported; the writer is Vditor's undo snapshot (`addCaret`), not a caret intent
Probe: wrapped `Selection` writers with stacks, focus/key/selection listeners, a mutation observer on the sample paragraph, and a 60-frame sampler (anchor parent class, offset, `composingLock`) around `End` for `real-end-link` and `real-end-code`. 6 runs, 6 failures. The runs failed at: link `)` (`--paren`) ×2, `--bracket` ×2, plain `vditor-ir__marker` ×2 (code); the dump was reached in only 2 runs (both `real-end-link`), the other 4 failed at a sample the probe did not instrument (earlier `End` or later sample), so they are unprobed.
- Logged sequence in both probed runs: `keydown End` → native caret lands in the closing marker (`)`, offset 1) → within about 20–50 ms one frame-time write pair (`removeAllRanges` + `addRange`) moves the caret to the paragraph (`parent class ''`, offset 2): the ejection works. The sampler shows the outside position for 5–10 frames (about 130–260 ms). Then a second write pair, stack `Rm.addCaret` ← `a` ← `Object.k [as sourceNeutral]`, puts the caret back into the marker text node (`)`, offset 1), accompanied by paragraph `childList` records (add 1 / remove 1) and a `selectionchange`; after it, every later frame shows the marker through the whole 1 s sampled window and the 4 s check.
- That second writer is Vditor's undo snapshot `addCaret(inner, true)`, called inside `sourceNeutral` (`undo-snapshot-neutral.ts`, Task 611/610; also `undo-boundaries.ts` `coalesceCaretOnlyDifference`). It fires 196–332 ms after `End`, consistent with the 800 ms `undoDelay` timer started by the previous typed sample.
- H1 (focus restore re-arming a caret intent): not supported. No `focus`/`blur`/`focusin`/`focusout` event in either run, and no per-frame re-assert writes. H3 (no normalization): rejected, the ejection write is visible and `composingLock` stays `false`.
- Open detail: why the snapshot restores into the marker (the live range `{p, 2}` is an element-boundary position; the snapshot's marker insertion and removal appear to normalize it into the end of the previous text node). Not measured. A product fix would make the snapshot's caret restore keep an ejected caret outside the marker. Design question for the orchestrator.
- The 4 unprobed failures (`--bracket`, code) most likely share this writer; not confirmed.

### Q3 `rewrap.spec.ts` (option a, `--repeat-each=8`, D3 setup) — 6 of 8 pass, 2 fail
Both failures: `rewrap.spec.ts:323`, caret offset 0 instead of 13 after `vmde.rewrap`. The failure is therefore reproducible under the D3 setup (about 1 of 4), not a leftover of the scroll setup; the scroll check passed in every run. Stays open for the reasoning pass (probe option (b), with the Q2 finding in mind: an undo snapshot `addCaret` can also override a caret write).

## Closure (2026-11-08)

Test-only commit on `dev`; `typecheck:vscode-e2e`, `lint:ci` and `jscpd` exit 0 after the rebase. The product cause found by the Part 2c probe (an undo snapshot's `addCaret` re-places the caret after the marker-reveal ejection) is filed as Task 708.
