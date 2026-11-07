# Task 697 — Preview and diagram renders do not settle, or measure wrong, in the Preview pane at `f84a4258`

**Status:** ✅ done (2026-11-08). Filed 2026-11-02. Filed from the full real-VS-Code gate of queue run 2026-11-01d.
**Origin:** Gate rerun at `f84a4258` (Task 695): the suite failed these cases in chunks and again when each spec file ran alone (`--workers=1 --retries=0`, XTEST, fresh X server per file).
**Severity:** medium (estimated; Preview shows missing or unfinished diagrams, or wrong geometry, in a full-suite run and alone).
**Tech stack:** `test/vscode-e2e/{diagram-render-sweep,diagram-sizing,mode-switch-render-reuse,preview-rehighlight,wavedrom-theme,parity,wysiwyg-parity,preview-spacing,sv-split}.spec.ts`; Preview render pipeline in `media-src/src/`.
**Depends on:** none.

## Problem

These cases fail in the full suite and again alone at `f84a4258`:

- `diagram-render-sweep.spec.ts:1221`: `.vditor-preview .language-markmap svg` is not visible after 30 s.
- `diagram-sizing.spec.ts:14`: the sizing poll stays false for 30 s.
- `mode-switch-render-reuse.spec.ts:210` and `:359`: "Preview pane finished rendering every engine after the switch" is false.
- `preview-rehighlight.spec.ts:90`: "Preview settled on visit 1 (highlighted + d2 swapped)" is false.
- `wavedrom-theme.spec.ts:173`: the Preview-pane background poll stays false for 30 s.
- `parity.spec.ts:51`: IR and Preview code-block heights differ (for example ir 110 against pv 22).
- `wysiwyg-parity.spec.ts:158`: 5 diagram pairs compared where more than 10 are expected.
- `preview-spacing.spec.ts:87`: the edit-surface lookup `edit.found` is false.
- `sv-split.spec.ts:31`: `previewOffset` is 37.2 where less than 30 is expected (section sync).

Typing is not involved, so the X keymap limit is not a cause. Whether the render-not-settled cases share one cause with the geometry cases is not measured.

No earlier full-suite baseline exists, so the commit that introduced each failure is unknown, and whether the cases in this group share one cause is not measured.

## Proposed work

1. Find the last good commit for each failing case: run the spec alone on earlier `dev` revisions.
2. Group the cases by first bad commit and measure the cause of each group.
3. Fix each cause with a failing test first, or fix the test where the test, not the product, is wrong (state which).

## Acceptance

- [x] Part 2: group A and A2 cases (gating, deferred edit view) shown to be test defects by the probe; `sv-split:31` (group B) moved to [Task 702](../702-split-view-section-sync-and-preview-decorations-regress.md). The `d2#11` and wavedrom markup diffs have a measured location but no cause yet (see Part 2 results).
- [x] Each product cause is fixed with a test that fails before and passes after. Done by closure: the cases were test defects, fixed in the specs; the remaining product causes (d2 mask id suffix, wavedrom Preview wrapper and reuse) moved to [Task 706](../706-preview-diagram-markup-differs-from-the-edit-view-for-d2-and-wavedrom.md).
- [x] The listed cases pass in one real-VS-Code run, alone and in the full suite. Done by closure: 15 of 18 cases pass in the combined run of 2026-11-08; the 3 failing cases (markup comparison) moved to Task 706. The full suite runs at the next gate (provisional decision of the orchestrator, 2026-11-08).

## Tests to write

- A test per product cause; the listed real-VS-Code cases are the acceptance tests.

## Part 1 handoff (2026-11-02)

Source and log reading only at `c8775fb1`. No build, no test, no real VS Code. Evidence: the alone logs of the Task 695 gate at `f84a4258` (one spec file per Playwright invocation and X server). The confirmation rerun on `c8775fb1` had not reached any spec of this task when Part 1 ended, so it adds no evidence here.

### Last recorded pass

None of the nine spec files changed after 2026-09-06 (`git log` of each file), so the cause is product code or environment, not an edit to the specs.

- `sv-split`: passed alone in Task 619 (`4317eebc`, 2026-10-14) and Task 634 (`b13461f6`, 2026-10-14). It did not run in any later record.
- `parity`, `wysiwyg-parity`, `diagram-render-sweep`, `wavedrom-theme`, `mode-switch-render-reuse`, `diagram-sizing`, `preview-rehighlight`, `preview-spacing`: the last recorded passes are from the Task 518/519/528/530/531 runs (2026-08-29 to 2026-08-31). No later record ran them. Task 643, which rewrote full Preview, ran only its six new `preview-mode-*` specs and the updated `preview-memory` and `preview-performance` specs.

### Main candidate: Task 643 (`6dede194`, 2026-11-01)

`6dede194` ("render Preview itself, stream large documents and defer the edit view") is in `f84a4258`. It made two intended changes (Task 643 requirements 1 and 5) that these specs do not expect:

1. **Heavy blocks render only when near the screen.** `media-src/src/editing/preview-render.ts:232` defines heavy blocks as `pre > code, .language-math, [class*="language-"]`: every code block and every diagram. `gateHeavyBlocks` (`:286-312`) marks each one `data-vmde-preview-pending` and renders it (highlight.js, then each diagram engine, `renderHeavyBlock` `:237`) only when it is within `PREVIEW_RENDER_MARGIN_PX = 800` (`:49`) of the viewport (`nav/viewport-gate.ts`). A block further down stays as unrendered source until the pane scrolls near it. Split View's preview pane keeps Vditor's `Preview.render` and is not gated (Task 643 decision 3).
2. **No edit view when the document opens in Preview.** With `vmde.editor.defaultMode = preview`, the IR/WYSIWYG/SV elements stay empty until the first switch out of Preview (`boot/deferred-edit-view.ts`).

The new spec `preview-mode-output.spec.ts:63-92` already uses `renderEverything`: it scrolls the pane through, then polls until no `[data-vmde-preview-pending]` remains. None of the older specs do this.

### Assessment per case

Fixture `all-renderers.md` (786 lines): js/python at lines 14-21, mermaid 47/56, echarts 70, mindmap 84, markmap 96, flowchart 111, graphviz 125, plantuml 139, abc 151, smiles 166, wavedrom 176-194, nomnoml, geo, vega, stl, and 13 d2 blocks at lines 477-696.

| Case | Assertion | Probable cause | P(cause) | Defect |
|---|---|---|---|---|
| `wysiwyg-parity.spec.ts:158` | WYSIWYG to Preview pairs `> 10`, got 5 | Gating. The log names the missing pairs: "WYSIWYG->Preview d2: 12 drew vs 0", "wavedrom: 4 drew vs 0", "nomnoml: 2 drew vs 0", "vega-lite: 2 drew vs 0". These are all blocks below the fold. | 0.95 | test |
| `wysiwyg-parity.spec.ts:172` (same test, sub-case) | "IR->WYSIWYG d2#11: markup differs (size 292x433 -> 292x433)" | Not Preview, so not gating. Unknown: possibly older or intermittent. | n/a | unknown, see group C |
| `mode-switch-render-reuse.spec.ts:210`, `:359` | `renderReady('v.vditor.preview.previewElement')` false for 30 s | Gating. `renderReady` requires every engine in the Preview pane, including the d2 blocks at lines 477+. | 0.9 | test |
| `parity.spec.ts:51` | Code-block heights differ, for example ir 110 against pv 22 (16 blocks) | Gating. Pending Preview blocks are one line of source, while IR shows the rendered diagram. | 0.85 | test (see open decision 2) |
| `diagram-sizing.spec.ts:14` (poll at `:107-123`) | Preview abc and graphviz `svg` width > 0 | Gating (graphviz at line 125, abc at 151, below about 1.5 viewports of rendered mermaid, echarts, mindmap and markmap). | 0.85 | test |
| `wavedrom-theme.spec.ts:173` | Preview wavedrom background poll | Gating (wavedrom at lines 176-194). | 0.8 | test |
| `preview-rehighlight.spec.ts:90` | `PREVIEW_SETTLED` (`:73-77`): the one `pre > code` has class `hljs` | Gating. Highlighting is now part of the gated heavy render, and the code block is at line 67 of 82 in `preview-rehighlight.md`, after long prose. The message's "d2 swapped" text is wrong: the predicate checks only `hljs`. | 0.8 | test |
| `diagram-render-sweep.spec.ts:1221` (wait at `:176-179`) | First `.vditor-preview .language-markmap svg` visible within 30 s | Gating. The test calls `preview.render` directly (`:153-173`), and that call now goes through the Task 643 route. Markmap is at line 96, after two mermaid blocks, echarts and mindmap. | 0.75 | test |
| `preview-spacing.spec.ts:87` (`:181`) | `edit.found` (metrics read from `.vditor-ir`) | The spec opens with `defaultMode = preview` (`:93-99`). Since Task 643, the edit view is not built until a switch, so `.vditor-ir` has no paragraph. | 0.85 | test |
| `sv-split.spec.ts:31` (`:220`) | `previewOffset` 37.2, expected `< 30` | Not explained by gating, because Split is not gated. The nearest heading is right ("12. WaveDrom") and `sourceOffset` is 0.19. Candidates: shared diagram code changed by Task 643 (`diagram-kit/diagram-dom.ts`, `diagrams/custom-diagrams.ts`, `diagram-semantics.ts`, `editing/preview-morph.ts`) 0.35; Task 645 Split pane layout (`88cc673d`, gutter overlay and pane gap change the pane width and wrapping) 0.25; a late diagram resize after the 100 ms settle in the spec (`:177-181`) 0.2; other 0.2. | low | unknown, see group B |

Environment: the X server upgrade of 2026-11-01 and the XTEST keymap limit (Task 693) do not apply. No case types text, and the gating explanation needs no environment change. P(environment cause for group A) is about 0.05.

### Groups

- **A, test defect from intended Task 643 behaviour (8 cases in 7 files):** `wysiwyg-parity:158` (Preview pairs), `mode-switch-render-reuse:210` and `:359`, `parity:51`, `diagram-sizing:14`, `wavedrom-theme:173`, `preview-rehighlight:90`, `diagram-render-sweep:1221`. The specs assume that full Preview renders every block at once.
- **A2, test defect from the deferred edit view (1 case):** `preview-spacing:87`.
- **B, unknown cause (1 case):** `sv-split:31`.
- **C, unknown cause (1 sub-check):** `wysiwyg-parity:172`, the "IR->WYSIWYG d2#11" diff. It may disappear or persist once group A is fixed.

### Proposed split (the orchestrator decides)

Keep groups A and A2 in Task 697: one test-only fix of one mechanism. Move `sv-split.spec.ts:31` (group B) to a new task, "Split View section sync puts the target heading 37 px from the Preview centre". Group B needs a bisect and may be a product defect. Add the `d2#11` IR-to-WYSIWYG diff (group C) to that task, or file it separately, only if it still fails after the group A fix.

### Part 2 plan

**Step 1, probe to confirm the cause (a single real-VS-Code call, under 15 min).** Use a detached scratch worktree, set up as in the common rules. Run this subset at `32d6bf84` (the parent of `6dede194`) and then at `6dede194`:
`diagram-sizing.spec.ts:14 mode-switch-render-reuse.spec.ts:359 preview-rehighlight.spec.ts:90 preview-spacing.spec.ts:87 wysiwyg-parity.spec.ts:158 parity.spec.ts:51 sv-split.spec.ts:31`
Expected: the group A and A2 cases pass at `32d6bf84` and fail at `6dede194`, and `sv-split` gives the same result at both revisions. If a group A case fails at `32d6bf84` too, bisect it on `b13461f6..32d6bf84` with the same subset.

**Step 2, group A fix (test only, no product change).**
- Move `renderEverything` from `test/vscode-e2e/preview-mode-output.spec.ts:63-92` into `test/vscode-e2e/webview-helpers.ts` as an exported helper with the pane selector as a parameter, for example `renderAllPreviewBlocks(frame, pane = '.vditor-preview')`. Then use the helper in `preview-mode-output.spec.ts`.
- Call it after the switch to Preview and before the waits or reads in: `mode-switch-render-reuse.spec.ts` (before `:216-231` and `:376-390`), `wysiwyg-parity.spec.ts` (before the Preview read), `parity.spec.ts` (before the Preview measurement; keep the IR read before the switch, because the IR pane has zero-size boxes while Preview is shown), `diagram-sizing.spec.ts` (after the toolbar click at `:94-101`), `wavedrom-theme.spec.ts` (after the click at `:206`), `preview-rehighlight.spec.ts` (after each `TOGGLE`; also correct the message at `:126`, which mentions a d2 swap that the predicate does not check), and `diagram-render-sweep.spec.ts` (after the direct `preview.render` at `:173`).
- The helper ends with the pane scrolled back to the top. For `diagram-render-sweep`, which later zooms and pans the first markmap, check that the first markmap is in view again.
- "Failing test first": the listed cases already fail at `c8775fb1`. Record that failure from the first Part 2 run before you change the specs.

**Step 3, group A2 fix (test only).** In `preview-spacing.spec.ts`, read the Preview metrics first. Then switch to IR through the toolbar, wait for `.vditor-ir p`, and read the edit metrics. Alternative: open with `defaultMode = ir` and switch to Preview. Either way the spec still checks the Preview metrics and the edit surface.

**Step 4, group B bisect (if `sv-split` stays in this task).** Good: `b13461f6` (Task 634 pass). Bad: `f84a4258`. Probe these revisions first: `4e6547d5` (before Task 645), `88cc673d` (Task 645), `32d6bf84` (before Task 643), `6dede194` (Task 643). Then run `git bisect` inside the bounding pair; there are 79 commits on `media-src/src` in the window, so about 7 steps. Run `sv-split.spec.ts:31` alone at each revision (about 25 s plus the build). Also log the `previewOffset` value at each revision. A product cause gets a failing test first: the existing `:220` assertion, or a narrower Vitest case on the sync anchor if the cause is in `nav/`.

**Step 5, acceptance run.** One combined real-VS-Code call of the nine spec files, then the full suite in the planned chunk order.

### Open decisions for the Owner

1. Split: move `sv-split:31` (and the `d2#11` sub-check if it persists) to a new task? Recommended: yes.
2. `parity.spec.ts` compares IR against Preview over the whole document. With gating, a pending Preview block is one line high until it renders, so the page height changes as the reader scrolls. Recommended: fix the test only (render all blocks, then compare), as Task 643 requirement 5 allows. Alternative: a product change that makes pending blocks reserve an estimated height. That is outside this task.
3. Helper style: scroll through the pane (the real user path, as `preview-mode-output` does), or add a test-only hook that releases all pending blocks. Recommended: scroll. It needs no product hook. Cost: about 150 ms per 0.7 viewport, a few seconds per spec.

### Residual risks

- The ranking is from source and log reading. The Step 1 probe confirms or rejects it.
- `mode-switch-render-reuse` also checks that Preview reuses IR renders (`data-vmde-cache-hit`). The gated render path (`renderHeavyBlock`) may reuse less than Vditor's earlier full render. If the reuse sub-check fails after the helper is added, that is a product question for Task 643's reuse, not a test defect.

### Orchestrator decisions

- Provisional decision (2026-11-02), reversible: run the Step 1 probe; if it confirms gating, fix groups A and A2 in the tests only with a shared scroll-through helper (the real user path, no product hook); `parity.spec.ts` renders all blocks before comparing. Move `sv-split.spec.ts:31` (and the `d2#11` sub-check if it persists after the group A fix) to a new task.

## Part 2 results

### Probe (scratch worktree, task name 697, subset of 7 cases)

| Case | `32d6bf84` | `6dede194` |
|---|---|---|
| `diagram-sizing:14` | pass | fail |
| `parity:51` | pass | fail |
| `preview-rehighlight:90` | pass | fail |
| `preview-spacing:87` | pass | fail |
| `wysiwyg-parity:158` | fail, only `IR->WYSIWYG d2#11: markup differs` | fail, pairs `> 10` got 5, plus `d2#11` and `WYSIWYG->Preview` d2 12, wavedrom 4, nomnoml 2, vega-lite 2 drew vs 0 |
| `mode-switch-render-reuse:359` | fail, only the `d2#11` markup diff | fail, Preview render-ready timeout (30 s) |
| `sv-split:31` | fail, `previewOffset` 37.21875 | fail, `previewOffset` 37.21875 |

Result: gating confirmed for `diagram-sizing`, `parity`, `preview-rehighlight`, `preview-spacing`, and for the Preview half of `wysiwyg-parity` and `mode-switch-render-reuse`. The design stands. Two findings: (1) the `d2#11` markup diff (IR against WYSIWYG or Preview, the `-vm` id suffix at the d2 mask id) already fails at `32d6bf84`, so it is older than Task 643. (2) `sv-split:31` has the same `previewOffset` at both revisions, so Task 643 is not its cause (it moves to the new task as planned). Logs: `tmp/697/probe-32d6bf84.log`, `tmp/697/probe-6dede194.log`.

### RED (`tmp/697/red.log`, 8 spec files before any change)

9 failed, 8 passed (8.6 min). Failed: `diagram-render-sweep:1221`, `diagram-sizing:14`, `mode-switch-render-reuse:210` and `:359`, `parity:51`, `preview-rehighlight:90`, `preview-spacing:87`, `wavedrom-theme:173`, `wysiwyg-parity:158`.

### GREEN (`tmp/697/green.log`, the 8 files plus `preview-mode-output.spec.ts`)

3 failed, 15 passed (8.2 min). Pass now: `diagram-render-sweep`, `diagram-sizing`, `parity`, `preview-rehighlight`, `preview-spacing`, `wavedrom-theme` (both cases), `preview-mode-output`. Still failing, no product change made:
- `mode-switch-render-reuse.spec.ts:210` and `:361`: the Preview render-ready wait now passes; the markup comparison fails on `d2#10` and `d2#11` (mask id `-vm` suffix, preview cache-hit=1) and `wavedrom#0..3` (the Preview markup has no `<div>` wrapper, cache-hit=null, so no reuse).
- `wysiwyg-parity.spec.ts:160`: pairs `> 10` now pass; the diffs are `IR->WYSIWYG d2#11`, `WYSIWYG->Preview d2#10` and `wavedrom#0..3`.
These are the reuse and markup sub-checks named in the brief. `d2#11` is older than Task 643 (probe). The `d2#10` and wavedrom diffs appear only in Preview after the render is complete, so they are a new-task candidate (Preview render route `renderHeavyBlock` against the IR render), not a test defect.

### Test change notes

- The helper first waits for the pane to have a child. Without that wait the walk ran on an empty pane right after the switch (render is asynchronous), found nothing pending, and `wysiwyg-parity`, `mode-switch-render-reuse` and `diagram-render-sweep` stayed red.
- `diagram-render-sweep.spec.ts` also needed the helper after the toolbar Preview click in the inline-zoom case (second Preview entry).
- `preview-spacing.spec.ts` reads the Preview metrics, then switches to IR via the toolbar (preview, edit-mode, IR) and waits for `.vditor-ir p` before reading the edit metrics. No threshold changed.
- `preview-rehighlight.spec.ts` message now says: one `pre > code` left, and it is highlighted.

### Static checks

`npx biome ci` exit 0 (4 infos, none in changed files); `npm run typecheck:vscode-e2e` exit 0.

### Files changed

`test/vscode-e2e/webview-helpers.ts` (new export `renderAllPreviewBlocks`), `preview-mode-output.spec.ts`, `wysiwyg-parity.spec.ts`, `mode-switch-render-reuse.spec.ts`, `parity.spec.ts`, `diagram-sizing.spec.ts`, `wavedrom-theme.spec.ts`, `preview-rehighlight.spec.ts`, `diagram-render-sweep.spec.ts`, `preview-spacing.spec.ts`, and this record. `sv-split.spec.ts` and product code untouched.

## Closure (2026-11-08)

Run after the rebase onto `dev` `5559608c` (9 spec files, `--workers=1 --retries=0`, log `tmp/697/run-0811.log`): 15 passed, 3 failed (7.2 min). The failing cases are the same as in the Part 2 GREEN run: `mode-switch-render-reuse.spec.ts:210` and `:361`, `wysiwyg-parity.spec.ts:160`. They fail on markup comparison only: the d2 mask id `-vm` suffix differs (`d2#10`, `d2#11`; `d2#11` already fails at `32d6bf84`, older than Task 643), and the Preview wavedrom markup has no `<div>` wrapper and is not reused (cache-hit null).

Provisional decision of the orchestrator (2026-11-08), for the Owner: Task 697 closes with its test fix. These three cases move to [Task 706](../706-preview-diagram-markup-differs-from-the-edit-view-for-d2-and-wavedrom.md). `sv-split.spec.ts:31` stays in [Task 702](../702-split-view-section-sync-and-preview-decorations-regress.md). The full suite runs at the next gate.
