# Task 706 — Preview diagram markup differs from the edit view for d2 and wavedrom

**Status:** ✅ done (2026-11-08).
**Origin:** Split from [Task 697](../697-preview-and-diagram-renders-do-not-settle-in-the-preview-pane.md). After the Task 697 test fix, three real-VS-Code cases still fail on markup comparison only; the cause is in product code, not in the specs.
**Severity:** low-medium (estimated). Markup and render-reuse parity between the Preview and the edit view. Likely invisible to the reader unless a d2 mask id collides, or the missing wavedrom reuse costs time on large documents.
**Tech stack:** Preview route `renderHeavyBlock` in `media-src/src/editing/preview-render.ts` against the IR render; render cache in `media-src/src/diagrams/render-cache-client.ts` (`data-vmde-cache-hit`); d2 mask id suffix in `media-src/src/diagrams/d2/d2-svg-paths.ts` (comment at line 532); wavedrom engine in `media-src/src/diagrams/engines/wavedrom.ts`; specs `test/vscode-e2e/mode-switch-render-reuse.spec.ts` and `test/vscode-e2e/wysiwyg-parity.spec.ts`.
**Depends on:** none.

## Problem

Run of 2026-11-08 after the rebase onto `dev` `5559608c`: 9 spec files, `--workers=1 --retries=0`, 15 cases passed and 3 failed (7.2 min). The failing cases are the same as in the Part 2 GREEN run of Task 697:

- `mode-switch-render-reuse.spec.ts:210`
- `mode-switch-render-reuse.spec.ts:361`
- `wysiwyg-parity.spec.ts:160`

All three fail on the markup comparison only. Render-ready waits and pair counts pass. Two diffs, measured but not explained:

1. **d2 mask id.** The mask id differs by the `-vm` suffix between the compared renders (`d2#10`, `d2#11`). The Preview side shows `data-vmde-cache-hit=1`. `d2#11` (IR against WYSIWYG) already fails at `32d6bf84`, the parent of Task 643, so this diff is older than the Preview render rewrite. `d2#10` (WYSIWYG against Preview) appears only after the Preview render is complete.
2. **wavedrom (`#0` to `#3`).** The Preview markup has no `<div>` wrapper that the edit view output has. `data-vmde-cache-hit` is null, so the Preview does not reuse the cached render.

These are measured locations. The causes are not known.

## Proposed work

1. Write a failing test first for each diff (see "Tests to write").
2. Find why the d2 mask id suffix differs between the renders: compare the suffix source in `d2-svg-paths.ts` with the Preview `renderHeavyBlock` call and with the cache-hit path that restores stored markup.
3. Find why the wavedrom Preview output has no wrapper and skips reuse: compare the `renderHeavyBlock` route with the IR render route and with the wavedrom engine and cache key.
4. Fix the product cause. Change a spec only if the specs, not the product, are wrong (state which, with evidence).

## Acceptance

- [x] `mode-switch-render-reuse.spec.ts:210` and `:361` and `wysiwyg-parity.spec.ts:160` pass in one real-VS-Code run. (Part 2 run2: 6 passed, see Part 2 results.)
- [x] A focused test fails before and passes after the fix, for the d2 mask id and for the wavedrom wrapper and reuse. (Part 2: three RED→GREEN Vitest cases.)
- [x] `npm run quality` passes. (Part 2: exit 0, all 8 stages PASS.)

## Tests to write

- Vitest: the d2 mask id for a Preview render equals the id of the same source rendered by the IR route, or the exact difference is specified.
- Vitest: the wavedrom Preview render has the same wrapper and takes the cache hit that the IR render takes.
- The three real-VS-Code cases above are the acceptance tests.

## Part 1 handoff

Investigation of 2026-11-08 at `0931cbbf`. One real-VS-Code run of the three acceptance cases (`node build.mjs` exit 0; wrapper run exit 1, 3 failed, the same three cases). Log: `tmp/706/run1.log`.

### 1. d2 mask id

- **Where `-vm` comes from.** `uniquifySvgIds` (`media-src/src/diagrams/render-cache-client.ts:399`) appends `-vm<paintSeq>` to every REFERENCED id (`url(#…)`, `href="#…"`). Its only caller is `paintCached` (`render-cache-client.ts:441`), so every cache paint adds the suffix: WYSIWYG after a mode switch, the full Preview, and the open-path host cache restore (`applyCacheHits`). An engine render (the first IR render) never adds it. `rememberLocal` stores the stem (`stripSvgIdNamespace`, `:386`), so the suffix is always one level deep.
- **The suffix is by design.** Task 373: duplicate ids made `url(#…)` resolve into the hidden pane, so mermaid and flowchart lost their arrowheads. The d2 label mask (`vmde-d2lbl-<djb2>`, `d2-svg-paths.ts:532`) is referenced through `mask="url(#…)"`, so it is renamed on purpose.
- **The specs already normalize it.** `stripIdNs` at `test/vscode-e2e/mode-switch-render-reuse.spec.ts:179` and `test/vscode-e2e/wysiwyg-parity.spec.ts:138` removes `-vm\d+` before comparing. The failure text prints the first RAW difference (`at 373` / `at 367`, in `compare`, `mode-switch-render-reuse.spec.ts:192`), which is the suffix. The stripped strings still differ further on. **So the `-vm` suffix is not the failure. Something after it differs.**
- **What the residual difference is tied to (measured pattern, run1).** The fixture has 12 rendered d2 blocks. Only #10 and #11 differ. These are the only blocks whose `|md` labels hold a table (#10) or a task list plus an indented code block (#11). #9 also has a `|md` label (heading, list, inline code, link) and matches.
  - #11: IR ≠ WYSIWYG and IR ≠ Preview, but WYSIWYG = Preview. Both copies are cache paints of the stored bytes. So the IR live markup moved away from the bytes it stored, through an attribute-only change after the store. The render-cache observer watches `childList` only (`render-cache-client.ts:917`), so that change is never re-stored. This explains why #11 already fails at `32d6bf84`: it does not depend on the Preview route.
  - #10: only the Preview copy differs (WYSIWYG = IR). This is a Preview-only decoration on the painted copy.
  - Strongest candidate for #10: `normalizeResponsiveTables` / `track` (`media-src/src/chrome/responsive-tables.ts:736`, `:263`). It styles every `table` under `.vditor-reset`, the md-label table inside the d2 `foreignObject` included. It gives a measured table a per-element class from `nextAutoWidthId` (`:98`), and `dropStaleAutoClasses` (`:104`) removes a copied class. This is not proven. The #11 decoration is not identified.
- **Specs or product?** The `-vm` normalization in the specs is right and must stay. The residual is product markup that pane-level passes change inside the d2 md-label `foreignObject`. It is not proven to come from the render cache. The exact attribute is NOT yet named: the spec prints only 60 characters of raw context. **Open item**: one probe run of `tmp/706/probe-d2-stripped-diff.spike.spec.ts` (copy it to `test/vscode-e2e/706-d2-probe-spike.spec.ts`, run it through the wrapper, then delete it). The probe prints the first difference after the strip and the per-element attribute diff inside `foreignObject` for d2 #9..#11. This brief allowed only one real-VS-Code run, and that run was used to capture the acceptance diffs.

### 2. wavedrom wrapper and cache miss

- **Edit-view wrapper.** `renderWavedrom` (`media-src/src/diagrams/engines/wavedrom.ts:131-136`) creates `div#__vmde_wd_<n>` in the faithful-render stage, renders into it, themes the SVG (`themeWavedromSvg`) and removes the id. The output is `<div><svg …>`.
- **Preview route.** `renderHeavyBlock` (`media-src/src/editing/preview-render.ts:246`) calls Vditor's NATIVE `wavedromRender(root, cdn)`, imported at `preview-render.ts:22`. VMDE stubs that renderer (`media-src/src/chrome/stubs/vditor-toolbar-stubs.ts:24-26`: "Keep one authoritative renderer"). The esbuild resolver stub (`media-src/esbuild-shared.mjs:143-151`) applies only when the importer path contains `vditor/src/`. `test/backend/vditor-source-patches.test.ts:240-242` pins that VMDE-owned importers are not stubbed. So the Task 643 import resolves to the real Vditor module. Probe `tmp/706/probe-wavedrom-meta.txt` (from `media/dist/main.meta.json`) shows that every Vditor-internal importer resolves to the stub, and `src/editing/preview-render.ts -> node_modules/vditor/src/ts/markdown/wavedromRender.ts` does not. `media/dist/main.js` contains `renderWaveElement` (count 1).
- **Effect.** The native renderer (`media-src/node_modules/vditor/src/ts/markdown/wavedromRender.ts`) swaps the `<code>` for a `div.language-wavedrom` and draws directly into it with `renderWaveElement`. The result has no inner `<div>` and no `themeWavedromSvg` pass, so the colours are also unthemed. The renderer then sets `data-processed="true"`.
- **Why the cache misses.** The cause is the route, not the key. `findBlocks` (`media-src/src/diagram-kit/diagram-dom.ts:129`) and therefore `paintLocalHits` (`render-cache-client.ts:512-514`) select only `:not([data-processed="true"])`. Once the native pass has marked the block, neither the local-cache paint nor VMDE's engine touches it, so `data-vmde-cache-hit` stays null. The key is the same as for IR (`localKey` trims both sides, `:368`).
- Introduced by `6dede194` (Task 643), the first commit that imports Vditor renderers from VMDE source. The same resolver gap also bundles the real `imageCaptionRender` through `preview-render.ts:14`. That renderer is harmless while `preview.markdown.imageCaption` is off. It is outside this task: note only.

### 3. Fix contract

**wavedrom (decision-complete):**
- `media-src/src/editing/preview-render.ts:22`: delete the `wavedromRender` import.
- `preview-render.ts:246`: delete `wavedromRender(root, cdn)`. Update the comment at `:236`: Vditor's afterRender order without WaveDrom, which the diagram runtime owns (`observeCustomDiagrams` scans a released block through `PREVIEW_BLOCK_RELEASED_EVENT`, and the code→div swap in `findBlocks` lets `paintLocalHits` paint the cached render).
- Allocation: the change removes work. Blocks without diagrams get no new work.
- Do not widen the esbuild stub filter: `vditor-source-patches.test.ts:240` pins the current scope on purpose.
- Vitest RED, `media-src/src/editing/preview-render.test.ts`, under `describe('renderFullPreview, heavy blocks')` (`:404`): add `it('leaves wavedrom to the diagram runtime and never runs Vditor\'s native renderer')`. Render ``` ```wavedrom ``` with a `NEAR` source, await `.done`, then assert `expect(renderers.wavedromRender).not.toHaveBeenCalled()` and that the Preview `.language-wavedrom` element has no `data-processed` attribute. This fails before the fix, because the mock is called.
- Same file: remove `'wavedrom'` from the order expectation at `:467` and its `mockImplementation` at `:448`. Drop the now-unused `wavedromRender` mock (`:34`, `:78-80`).
- The cache-hit half is proven by the real-VS-Code cases (`hit=1` requires the paint path). An optional Vitest addition in `render-cache-client.test.ts` would not fail before the fix, because the cause is in the Preview route.

**d2 (blocked on the probe):** the exact change cannot be named until the probe names the attribute. Contract shape, depending on the result:
- (a) If a pane-level pass decorates elements inside a diagram `foreignObject` (the responsive-tables `track` class or styles, or a list or heading decorator), make that pass skip elements under `svg foreignObject`, for example a `closest('foreignObject')` filter at its element query (`responsive-tables.ts:743-745` for tables). A diagram's internal HTML is not a document table. The check runs only on candidates the pass already found, so a block without diagrams gets no new work.
  - Vitest RED: `media-src/src/chrome/responsive-tables.test.ts`. A `table` inside `.vditor-reset svg foreignObject div` keeps its exact `outerHTML` after `fixResponsiveTables` and a flush.
- (b) If the probe shows only `-vm`-style id differences that the regex misses (for example an id referenced in another form), extend `uniquifySvgIds` and `stripSvgIdNamespace` together.
  - Vitest RED: `render-cache-client.test.ts`, `stripSvgIdNamespace(uniquifySvgIds(x)) === x` for the d2 md-label fixture.
- No spec expectation changes in either case. The `stripIdNs` normalization stays.

### 4. Open product choices

- d2 md-label content: should page-level decorators (responsive tables, task checkboxes, section folding) apply inside a diagram's `foreignObject`? Recommendation: no. The label is part of the diagram picture, and its layout was measured before those passes run, so a decoration can only change it after measurement. Confirm after the probe names the pass.

## Part 2 results

2026-11-08. One probe run, then the fixes, then one combined real-VS-Code run.

### Probe

The probe spike was copied to `test/vscode-e2e/zz-tmp706-d2-probe.spike.spec.ts`, run once with `VMDE_SPIKES=1` (1 passed, exit 0), then deleted.

| Block | After the `-vm` strip | Exact difference | Code that writes it |
|-------|-----------------------|------------------|---------------------|
| d2#9 | equal | — | — |
| d2#10 | not equal | The md-label `<table>` inside the `foreignObject` carries `class="vmde-table-auto-2"` in Preview only. Both panes also carry the responsive inline `style`. | `normalizeResponsiveTables` and `track` (`media-src/src/chrome/responsive-tables.ts`). The class is the per-table auto-width class (`nextAutoWidthId`). |
| d2#11 | not equal | The md-label `<pre>` carries `data-vscode-context="{"webviewSection":"code"}"` in the cache-painted copies. The IR copy has no such attribute. | `desiredContexts` (`media-src/src/chrome/webview-context.ts`), selector `pre:not(.vditor-reset)` |

Both causes are contract shape (a): a page-level decorator writes inside a diagram label. Fixed as Owner decision Q2 requires: decorators must not apply inside `svg foreignObject`.

### Changes

- `media-src/src/editing/preview-render.ts`:
  - Removed the native `wavedromRender` import and its call in `renderHeavyBlock`.
  - Added a comment that names the cause and states that the diagram runtime owns WaveDrom.
  - The stub rule in `esbuild-shared.mjs` is unchanged.
- `media-src/src/chrome/responsive-tables.ts` (`normalizeResponsiveTables`): the table list also drops tables that have an `svg` ancestor.
- `media-src/src/chrome/webview-context.ts` (`desiredContexts`): a code-block candidate with an `svg` ancestor gets no `code` context. It inherits the diagram context.
- Both decorator filters run only on candidates the pass already found, so a document without diagrams does no extra work.
- `closest('svg')` is used instead of `closest('foreignObject')`: the mixed-case type selector does not match in jsdom. HTML reaches an svg only through `foreignObject`.
- Tests:
  - `preview-render.test.ts`: new case. Removed `wavedrom` from the order test. The `wavedromRender` mock stays, so a re-added import is caught.
  - `responsive-tables.test.ts`: new case.
  - `webview-context.test.ts`: new case.

### Evidence

- **RED, before each fix:**
  - `preview-render.test.ts`: "leaves wavedrom to the diagram runtime…" failed at `expect(renderers.wavedromRender).not.toHaveBeenCalled()` (number of calls: 1). 1 failed, 35 passed.
  - `responsive-tables.test.ts`: "leaves a table inside a diagram label (svg foreignObject) untouched" failed. Received `style="display: table; table-layout: fixed !important; …"`.
  - `webview-context.test.ts`: "does not stamp a code context inside a diagram label (svg foreignObject)" failed. Expected null, received `{"webviewSection":"code"}`.
- **GREEN:** `npx vitest run --config test/vitest.config.mts` on the three files: 58 passed.
- `node build.mjs`: exit 0. `media/dist/main.js` no longer contains `renderWaveElement` (count 0, was 1).
- **Real VS Code**, one wrapper call: `mode-switch-render-reuse.spec.ts wysiwyg-parity.spec.ts webview-context-menu.spec.ts table-auto-width.spec.ts --workers=1 --retries=0`. 6 passed (3.6 min), exit 0. This includes `mode-switch-render-reuse.spec.ts:210`, `:361` and `wysiwyg-parity.spec.ts:160`. Log: `tmp/706/run2.log`.
- `npm run typecheck`: exit 0.
- `npm run lint:ci`: exit 0 (4 infos).
- `npm run quality`: exit 0. All stages PASS: brand-identifiers, lint:ci, knip, jscpd, depcruise, audit, test:coverage (389 files, 8761 passed, 1 expected fail), coverage-modules.

### Residual risks

- A render stored in the persistent host cache before this fix can still hold the old decorations (the table style and class, the `pre` context) until the cache key changes. It is cosmetic: the decorations sit inside the label only.
- The real `imageCaptionRender` is still bundled through `preview-render.ts:14`. This is the same resolver gap, outside this task, and is noted only.

## Closure (2026-11-08)

Both diffs were product causes.

- **wavedrom:** the Preview route called Vditor's native `wavedromRender`, which drew an unthemed SVG with no wrapper and marked the block `data-processed`, so the cache paint skipped it. The call is removed; the diagram runtime renders the block.
- **d2:** two page decorators wrote inside the diagram label (`svg foreignObject`): the responsive-tables pass (an auto-width class on the Preview copy) and the webview-context pass (a `code` context on cache-painted `pre`). Both now skip anything inside an `svg`. Provisional decision (on the Owner's behalf): page decorators do not apply inside a diagram label.
- Evidence: RED then GREEN in `preview-render.test.ts`, `responsive-tables.test.ts` and `webview-context.test.ts` (58 tests). Real VS Code: `mode-switch-render-reuse.spec.ts` `:210` and `:361`, `wysiwyg-parity.spec.ts:160`, `webview-context-menu` and `table-auto-width` pass in one run (6 of 6). `npm run quality` passes all 8 stages.
- Residual: renders saved in the persistent cache before this fix keep the old decorations inside the label until the cache key changes (cosmetic). The Preview route still bundles Vditor's real `imageCaptionRender` (harmless while that option is off; not in scope).
