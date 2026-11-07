# Task 705 — Report mermaid diagram errors and defects instead of failing silently

**Status:** ✅ done (2026-11-08). Scope set by the Owner on 2026-11-08: every mermaid failure, fallback or detected defect is reported visibly; no diagram fails or degrades silently.
**Origin:** Owner report: after the SVG image references in `tmp/combat-design-mechanics/**/*.md` were replaced with the matching `.mmd` source as fenced `mermaid` blocks, some diagrams do not render correctly.
**Severity:** medium (estimated). One confirmed visual defect; one hard failure on a code path that has not yet been tied to a real surface.
**Tech stack:** vendored Mermaid 11 (`media/vditor/dist/js/mermaid`), `@mermaid-js/layout-elk` 0.2.3 (`media-src/vendor/mermaid-layout-elk`), `media-src/src/diagrams/mermaid/mermaid-elk.ts`, `mermaid-theme.ts` (initialize wrapper that registers the ELK loaders), `media-src/e2e/mermaid-harness.ts`.
**Depends on:** none. Related: Task 355 (diagram sizing and fonts, open), done Tasks 112 and 113 (mermaid ELK layout).

## Input

- 19 markdown files, 75 diagrams: 53 `flowchart`, 19 `classDiagram`, 3 `stateDiagram-v2`.
- Every diagram starts with the same front matter: `config: { theme: dark, layout: elk, htmlLabels: false }`.
- Reference renders: the original `.svg` files next to each `.mmd` (made by mermaid-cli). A backup of the folder before the replacement is in the investigating session's scratchpad; the replacement is a pure substitution of each `![alt](diagrams/x.svg)` line with a mermaid block of `diagrams/x.mmd`.

## Findings (2026-11-08)

1. **Real VS Code, all modes.** A probe opened all 19 files in IR, WYSIWYG, Split (sv) and Preview with default settings. All 75 diagrams produced an SVG in every mode; no `.vmde-diagram-error`. `__vmdeMermaidElkRegistered` was true. The label words of every VMDE SVG equal those of the reference SVG (wrapping aside).
2. **Confirmed defect — class-diagram cardinality labels collide.** `D-programmer-view/05-data-models.md`, diagram 6 (index 5; source `D-programmer-view/diagrams/special-ball-abilities-data-model.mmd`, relations `SpecialBallDefinition "1" --> "*" AbilityDefinition` and `"1" --> "*" LevelValues`). VMDE lays out the layer gap at 34 px (reference: 54 px). Both target-side `*` labels are then placed at the source end of the edge, not next to the target arrowhead: the `*` of the AbilityDefinition edge sits beside its `1`, and the `*` of the LevelValues edge is not visible next to the LevelValues arrowhead. Four other class diagrams (05-data-models indices 9, 10, 12, 14) have the same collision, but the reference SVG has it too, so only index 5 differs from the reference. VMDE sets no ELK spacing option for mermaid; the difference comes from the vendored Mermaid/ELK defaults or font metrics.
3. **Hard failure when the ELK loaders are not registered.** In the Chromium harness (`media-src/e2e/mermaid.html`), which does not run the `mermaid.initialize` wrapper, the 3 state diagrams fail with `Unknown layout algorithm: elk` and render no SVG. Flowcharts and class diagrams with `layout: elk` fall back to dagre silently on the same path. Any VMDE surface that renders mermaid before or without the wrapper (cold first render, export, copy-as-image, a new harness) shows the error for state diagrams only. No such real surface has been found yet.
4. Visual review of all 75 side-by-side pairs (reference left, VMDE right, three independent reviewers) found no other defect: no clipped text, no visible HTML literals, no missing edges or markers. Differences are scale and ELK placement only.

## Scope (Owner, 2026-11-08)

Report mermaid diagram errors and defects to the user instead of silently not rendering, or silently degrading, the faulty diagram.

Placement (Owner, 2026-11-08): every report appears in place, at the position of the embedded mermaid block itself (in its rendered area, in every mode), not in a notification, status bar, Problems panel or log.

## Proposed work

1. Inventory every mermaid render path (IR, WYSIWYG, sv preview, Preview pane, live re-theme `reRenderMermaid`, render cache, export, copy-as-image, harnesses) and every way it can end without a visible result: thrown error, rejected promise, empty or zero-size SVG, render that never finishes (timeout), viewport gating that never fires, and silent fallbacks (`layout: elk` without registered loaders falls back to dagre for flowchart and class diagrams, Finding 3). Record the list in this file.
2. Errors: every path that fails shows the existing `.vmde-diagram-error` box with the Mermaid message (for example `Unknown layout algorithm: elk`) and the diagram source stays editable. No blank block.
3. Fallbacks: when VMDE renders with a different layout or setting than the diagram asked for, show a visible, non-blocking warning on the diagram (for example "ELK layout unavailable, drawn with dagre").
4. Detectable defects: report, as a warning, defects VMDE can measure after render, starting with overlapping edge-terminal (cardinality) labels (Finding 2). Keep the check cheap and limited to what can be measured reliably.
5. Register the ELK loaders on every render path so Finding 3 no longer happens in normal use; the error/warning reporting stays as the safety net.

## Acceptance

- [x] Step 1 inventory recorded. Part 1 handoff section 1 (10 render paths, 10 failure modes).
- [x] Every error and warning shows in place at its mermaid block, in IR, WYSIWYG, sv preview and Preview. `test/vscode-e2e/mermaid-report.spec.ts` passes in real VS Code (2026-11-08).
- [x] No inventoried path ends with a blank or missing diagram without a visible error. script-load failure, render timeout (30 s), poll cap (35 s), ELK load failure and empty drawing each show an in-place error or warning (Vitest and Chromium H3, H5, H6, H7).
- [x] A state diagram with `layout: elk` and unregistered loaders shows an error or a fallback warning, never a blank block. ELK loaders are registered before every render; Chromium H1 passes.
- [x] A flowchart that falls back from ELK to dagre shows the fallback warning. Chromium H2 passes; fallback renders are not cached.
- [x] `special-ball-abilities-data-model` shows the overlapping-label warning; the other 74 combat diagrams show none (except the 4 that overlap in the reference too, if the check flags them). real-VS-Code combat probe: all 75 render, no errors; `terminal-labels` only on `05-data-models` index 5 and the reference-also set 9, 10, 12, 13, 14 (decision Q1).
- [x] Focused tests fail before and pass after; real-VS-Code spec passes; `npm run quality` passes. RED in Part 2a; GREEN after; `npm run quality` exit 0 on the rebased candidate (8685 passed + 1 expected fail).

## Tests to write

- Chromium harness spec: `stateDiagram-v2` with front matter `layout: elk` renders an SVG, no `Unknown layout algorithm` error.
- Real-VS-Code spec: a fixture with one flowchart, one class diagram with cardinalities and one state diagram, all with `layout: elk`; each renders an SVG in IR and Preview.

## Part 1 handoff (2026-11-08)

Decision-complete design for Part 2. Line numbers are from `dev` at `8944ce80`. Probes are listed at the end; their scripts and outputs are untracked under `tmp/705/`.

### 1. Step 1 inventory — mermaid render paths

Every VMDE mermaid render runs Vditor's `mermaidRender` (`media-src/node_modules/vditor/src/ts/markdown/mermaidRender.ts:11-60`), as patched at bundle time by `patchMermaidErrorRender` (`media-src/esbuild-shared.mjs:2551-2588`), `patchMermaidC4Colors` (`:2593-2604`) and `patchMermaidVersion` (`:2531-2539`), registered at `:3785-3792`. `mermaid.initialize` goes through the wrapper in `applyMermaidTheme` (`media-src/src/diagrams/mermaid/mermaid-theme.ts:141-214`), which calls `registerMermaidElkLoaders()` (`mermaid-elk.ts:56-70`) after every initialize (`mermaid-theme.ts:187`). The wrapper is installed only by `vditor-init.ts:196` (and re-applied by `diagram-retheme.ts:469`).

| # | Path | Entry (file:line) | Error box today |
|---|------|-------------------|-----------------|
| P1 | IR first render and per-edit re-render | Vditor `util/processCode.ts:71` via `processCodeRender`; the IR per-input loop is routed through `window.__vmdeDeferIrDiagramRender` (`esbuild-shared.mjs:2147-2163`, installed at `edit-activity.ts:761`) | Yes, for a thrown/rejected `mermaid.render` (patched catch) |
| P2 | WYSIWYG first render and re-render | Vditor `util/processCode.ts:71` | Same as P1 |
| P3 | Large-document streamed IR render | `media-src/src/diagrams/stream-render.ts:191,196` → `processCodeRender` | Same as P1 |
| P4 | Split (sv) preview pane | Vditor `preview/index.ts:231` (Split keeps Vditor's own path, `preview-render.ts:4`) | Same as P1 |
| P5 | Full Preview pane | `media-src/src/editing/preview-render.ts:237-241` `renderHeavyBlock`, viewport-gated by `run.gate.partition` (`:307-308`) | Same as P1 |
| P6 | Live re-theme | `reRenderMermaid` (`mermaid-retheme.ts:60-107`, called from `diagram-retheme.ts:482`) → `renderNativeJobs` (`diagram-kit/native-offscreen.ts:79-133`) offscreen sandbox → `adoptRender` | Yes: `hasRenderedOutput` (`native-offscreen.ts:26-28`) adopts an error box |
| P7 | Render cache, open-time reserve and host reply | `reserveAndRequest` (`render-cache-client.ts:569`), host timeout (`:635`), `resolveRequest` (`:724-800`): HIT → `paintCached` (`:425`); MISS → `renderNativeJobs` (`:795`) | HIT: an error box is never cached (`reportRenders` needs an `<svg>`), so not applicable. MISS: as P6 |
| P8 | Same-session cache reuse on a mode switch | `paintLocalHits` (`render-cache-client.ts:482-537`) from `rememberLocal` | Not applicable (only `<svg>` renders are remembered) |
| P9 | Section-hoist deferral | `deferHiddenNative` (`render-cache-client.ts:105-116`), released on `HOIST_SCOPE_CHANGE_EVENT` (`:861-871`) | Not applicable (block is hidden while deferred) |
| P10 | Chromium harness | `media-src/e2e/mermaid-harness.ts` (imports `boot/preload`, never calls `applyMermaidTheme`, so no wrapper and no ELK registration) | Yes for a thrown render |
| — | Vditor export (`export/index.ts:72`), static `Vditor.preview` (`markdown/previewRender.ts:139`) | Not reachable: VMDE has no export toolbar item and never calls either (grep of `media-src/src`) | — |
| — | Copy-as-image, host prerender | None exist for mermaid (no mermaid code in `src/` beyond settings and palettes; `lute-host.ts` prerenders Lute HTML only) | — |

Ways a path can end without a visible result:

| ID | Failure | Paths | Visible today? |
|----|---------|-------|----------------|
| F1 | `mermaid.render` throws or rejects (parse error, `Unknown layout algorithm: elk`, ELK loader rejects) | all | Yes, `.vmde-diagram-error` with Mermaid's message |
| F2 | `layout: elk` requested, `elk` not in Mermaid's layout registry: flowchart, class, ER and requirement diagrams call `getRegisteredLayoutAlgorithm` and silently fall back to dagre (`se.warn` only, which is a no-op at Mermaid's default log level); state diagrams do not call it and throw `Unknown layout algorithm: elk` | P10 today; any path that renders before or without the wrapper | Flowchart/class/ER/requirement: no (silent fallback). State: yes (F1) |
| F3 | ELK adapter or ELK engine fails to load: `loadElkRenderModule` throws `vmde: mermaid ELK adapter unavailable` (`mermaid-elk.ts:38-44`) | all ELK renders | Yes (F1). Probe 3 shows this is an error, not a dagre fallback; the comment at `mermaid-elk.ts:35-37` ("mermaid falls back to dagre") is wrong |
| F4 | `mermaid.min.js` fails to load: `addScript(...).then(...)` has no rejection handler (`mermaidRender.ts:16`) | all | No. Raw source text stays, unhandled rejection |
| F5 | `mermaid.render` never settles (for example a hung ELK boot) — Mermaid serialises renders in one queue, so every later mermaid render in the webview also stalls | all | No. Raw source (first render) or stale picture (re-render) |
| F6 | Offscreen poll cap: `MAX_POLL_FRAMES = 1200` (~20 s of visible frames, `native-offscreen.ts:113-131`) expires before output; nothing is adopted. A cache-MISS block is reserved (`data-processed="true"`) so Vditor never re-renders it | P6, P7 MISS | No. P7: raw source text forever; P6: old-theme picture stays (acceptable) |
| F7 | Empty source in an offscreen job: `mermaidRender` returns early without `data-processed` (`mermaidRender.ts:44`), so the poll runs to the cap | P6, P7 | Nothing to show (empty block); costs a 20 s poll |
| F8 | Render resolves with an empty or zero-size SVG | all | No signal (not measured on the combat set; every one of the 75 had a non-zero SVG) |
| F9 | Viewport gating that never fires: P5 heavy blocks and P6 deferred re-themes render only when on or near screen | P5, P6 | Not a failure: the block is off screen. P6 keeps the old picture. No change needed |
| F10 | Measurable layout defect: an edge-terminal (cardinality) label placed nearer the other end of its edge (Finding 2) | all | No |

### 2. Design

#### 2a. Errors

- Keep the existing `.vmde-diagram-error` box (`diagram-error.ts`, `main.css:794-818`) and its markup; it lives inside `.language-mermaid` in the preview half, so the source stays editable in IR, WYSIWYG and sv, and Preview stays read-only as today.
- Extend `patchMermaidErrorRender` (or add `patchMermaidReporting`, chained in the same `transform` at `esbuild-shared.mjs:3785`) so the patched `mermaidRender`:
  1. F4: adds a rejection handler to `addScript(...)`. For every element with non-empty code that is not `data-processed`, render the error box with message `Mermaid renderer dependency failed to load.` (same wording as `renderDiagramLoadError`) and set `data-processed="true"`.
  2. F5: races `mermaid.render` against `MERMAID_RENDER_TIMEOUT_MS = 30_000` via `window.__vmdeMermaidHooks.timed(promise)`; on timeout the existing catch renders `Mermaid did not finish drawing this diagram within 30 seconds.`
  3. F3: `loadElkRenderModule` throws `new Error('ELK layout failed to load.')` (replaces `vmde: mermaid ELK adapter unavailable`). Fix the wrong comment at `mermaid-elk.ts:35-37`.
  4. Always sets `data-processed="true"` after the try/catch (already so).
- F6 (`native-offscreen.ts`): replace the frame cap with a time cap `NATIVE_POLL_CAP_MS = 35_000` (above the 30 s render timeout, measured with `performance.now()`). When the cap expires and a temp has no output and `lang === 'mermaid'`, call `renderDiagramError(job.live, 'mermaid', 'Mermaid did not finish drawing this diagram within 30 seconds.')` (`native-offscreen.ts` may import `diagram-error.ts`; it is not a Vditor-native file). Other languages keep today's behaviour (out of scope).
- F7: `renderNativeJobs` drops mermaid jobs whose `source.trim()` is empty.
- The patch keeps working without the hooks object (optional chaining), so a bare Vditor bundle still renders.

#### 2b. In-place warning element

New module `media-src/src/diagrams/mermaid/mermaid-report.ts` (imports only `mermaid-elk.ts`; keep it out of heavy chunks). It owns the warning markup, the pure checks, and `installMermaidRenderHooks(win)`, which `media-src/src/boot/preload.ts` calls so that `main.ts` and every harness get the hooks (the same "imported first by every entry point" reason as `__vmdePatchLute`).

Markup, appended as the LAST child of the `.language-mermaid` render target, after the `<svg>`:

```html
<div class="vmde-diagram-warning" data-render="1" role="note" data-vmde-warning="terminal-labels">
  <div class="vmde-diagram-warning__title">Mermaid warning</div>
  <p class="vmde-diagram-warning__msg">1 relation end label sits closer to the other end of its line.</p>
</div>
```

- One box per diagram, one `<p class="vmde-diagram-warning__msg">` per warning. `data-vmde-warning` is a space-separated token list: `layout-fallback`, `terminal-labels`, `empty-drawing`. Messages are escaped like `diagramErrorHtml`.
- Lute: the box carries `data-render="1"` and sits inside the preview half (`.vditor-ir__preview` / `.vditor-wysiwyg__preview`, `data-render="2"`), so both AST walkers skip it (`vmde-lute-features` skill, "make injected DOM invisible to Lute"). Full Preview and the sv preview are never serialized.
- Non-blocking: it sits below the SVG in normal flow and never covers it; no screen-reader announcement (role `note`; `diagram-semantics.ts` announces only `.vmde-diagram-error`).
- Exported functions (names fixed):
  - `mermaidWarningHtml(warnings: readonly MermaidWarning[]): string` with `interface MermaidWarning { kind: 'layout-fallback' | 'terminal-labels' | 'empty-drawing'; message: string }`.
  - `misplacedTerminalLabelCount(edges: ReadonlyMap<string, EdgeEnds>, groups: readonly TerminalGroup[]): number` (pure).
  - `collectTerminalGeometry(svg: Element): { edges: Map<string, EdgeEnds>; groups: TerminalGroup[] }` (DOM, attribute-only).
  - `isEmptyMermaidSvg(svg: Element): boolean`.
  - `mayRequestElk(code: string, globalLayout: string | undefined): boolean`.
  - `elkFallbackApplies(diagramType: string, requestedLayout: string | undefined): boolean`.
  - `withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T>`.
  - `installMermaidRenderHooks(win)` → `win.__vmdeMermaidHooks = { beforeRender, timed, fallbackAfterRender, afterInsert }` (`fallbackAfterRender(id, code, pre): Promise<boolean>` is step 3 below).
- Message constants (exact strings):
  - `MERMAID_WARNING_TITLE = 'Mermaid warning'`
  - `ELK_FALLBACK_MESSAGE = 'ELK layout is not available. Drawn with dagre instead.'`
  - terminal labels: `1 relation end label sits closer to the other end of its line.` / `${n} relation end labels sit closer to the other end of their lines.`
  - `EMPTY_DRAWING_MESSAGE = 'Mermaid produced an empty drawing.'`
- Patched render sequence per element (order matters for the offscreen poll, which treats a present `<svg>` as done):
  1. `const pre = hooks?.beforeRender(code, cdn)` — registers ELK (2d) and records whether ELK may be requested (2c). Synchronous.
  2. `const data = await (hooks ? hooks.timed(mermaid.render(id, text)) : mermaid.render(id, text))`.
  3. Only when `pre.elkRequested` and the ELK module did not draw this id: `await` the fallback parse (2c).
  4. `item.innerHTML = data.svg`; C4 hook (unchanged); then synchronously `hooks?.afterInsert(item, id, code, fallback)`, which checks fallback (2c), empty drawing (F8) and terminal labels (2e), appends the box, and stamps `data-code` with `code.trim()` (the same trimmed form `paintCached` stamps; `nativeSourceForLive` then never reads text from the rendered node, which now includes warning text).
  5. Catch and `data-processed` as today.
  Step 4 runs in one task, so no rAF poll can adopt the SVG without its warning.
- Survival:
  - Re-theme (P6) and cache MISS (P7): the offscreen temp is rendered by the same patched code, so it gets its own fresh warning; `adoptRender` copies `innerHTML`, box included.
  - Cache HIT and mode-switch reuse (P7, P8): the cache stores `el.innerHTML`, so a `terminal-labels` or `empty-drawing` box is stored and painted with its SVG (deterministic for the same source and key). `reportRenders` compares SVG markup only (`svgOnly`), so the box does not affect the stale-render guard.
  - Exception: in `reportRenders.put` (`render-cache-client.ts:240`) return early, before `rememberLocal` and the host PUT, when `el.querySelector('.vmde-diagram-warning[data-vmde-warning~="layout-fallback"]')` matches. A degraded render must not be reused once ELK is available again.

#### 2c. Detecting ELK → dagre fallback

Mermaid exposes no registry query, and `__vmdeMermaidElkRegistered` can be stale (it is set even if a later lazy module init wipes the registry, or if `registerLayoutLoaders` is a no-op). Use direct evidence instead:

- `loadElkRenderModule` returns a wrapper of the vendored render module whose `render(data, ...rest)` records `data.diagramId` in a bounded set (clear when it exceeds 256 entries) before delegating. Export `takeElkRender(id: string): boolean` (deletes and returns presence). Probe 3: `data.diagramId` equals the id passed to `mermaid.render` for flowchart, class, state and ER.
- `beforeRender(code, cdn)` returns `{ elkRequested: mayRequestElk(code, win.__vmdeMermaidLayout) }` (a string test: an `elk` word in the source, or the global setting is `elk`; no parse).
- After `mermaid.render` resolves and BEFORE the SVG is inserted: if `elkRequested && !takeElkRender(id)`, run `await mermaid.parse(code, { suppressErrors: true })` and set `fallback = elkFallbackApplies(result.diagramType, result.config?.layout ?? (globalLayout === 'elk' ? 'elk' : undefined))`. `elkFallbackApplies` is true when the requested layout is `elk` or starts with `elk.` (or the type is `flowchart-elk`) and the type is one of `flowchart-v2`, `flowchart`, `flowchart-elk`, `classDiagram`, `class`, `er`, `requirement` (the diagrams that call `getRegisteredLayoutAlgorithm`). State diagrams never reach this (they throw, F1). `afterInsert` then adds the `layout-fallback` warning.
- Cost: the extra `mermaid.parse` runs only when ELK was requested and not used, that is only on the fallback path; a normal ELK or dagre render pays a string test. Probe 3: `parse` returns `config.layout` from front matter `config:` and from `%%{init}%%`; a top-level front-matter `layout:` key is ignored by Mermaid (so it is correctly not "requested").

#### 2d. ELK loaders on every render path (Proposed work 5)

- `registerMermaidElkLoaders()` returns `boolean` (registered or not) and keeps setting `__vmdeMermaidElkRegistered`.
- `beforeRender(code, cdn)` first sets `win.__vmdeCdn ??= cdn` (the harness never sets it, so the loader would fetch a wrong path) and calls `registerMermaidElkLoaders()` right before each render. Registration is a plain overwrite, so this is cheap and closes Finding 3 for every path that runs the patched `mermaidRender` (P1–P8, P10). The initialize-wrapper call in `mermaid-theme.ts:187` stays.

#### 2e. Edge-terminal label check

- What: for each edge, its `path[data-edge="true"]` carries `data-id` and `data-points` (base64 JSON of the routed points; first = source end, last = target end). Terminal labels are `g.edgeTerminals` elements that follow the edge's `g.edgeLabel` (whose `.label[data-id]` names the edge) in document order; the first follows the start, the second the end. The label anchor is the `translate(x, y)` of `g.edgeTerminals`, parsed from the `transform` attribute. All values are attributes in one coordinate space, so no layout is needed (works in the offscreen sandbox, in `display:none` panes and on cache paints).
- Rule: for an edge with exactly two terminal labels, a label is misplaced when `distance(anchor, ownEnd) >= distance(anchor, otherEnd)`. Edges with one label are skipped (the side is not in the DOM). Warn when the count is greater than 0.
- Bounding-box overlap between terminal texts was also measured (Probe 1): zero overlapping pairs on all 75 diagrams in both the VMDE render and the reference, so it does not detect Finding 2 and is not used.
- Threshold stability (Probe 2): the flagged set is identical for ratios 1.0, 1.1, 1.25 and 1.5 (`own * ratio >= other`). Use 1.0.
- Cost bound: return immediately when `svg.querySelector('g.edgeTerminals')` is null (62 of the 75 combat diagrams); otherwise O(edges + labels) attribute reads, no layout. Probe 4: 0.0–0.3 ms per diagram.
- Expected results on the 75 combat diagrams (Probe 2, Chromium harness, same check on attributes and on boxes): VMDE flags `D-programmer-view/05-data-models.md` indices 5, 9, 10, 12, 13, 14; the reference SVGs flag 9, 10, 12, 13, 14 and not 5. Every flagged edge is a straight 34 px edge with both labels. Index 13 (`id_BuildInventory_OwnedBall_1`) is a fifth reference-also case that the Acceptance list does not name; see open question Q1.
- `empty-drawing` (F8): `isEmptyMermaidSvg` is true when the `viewBox` width or height is not a finite number above 0, or the SVG has no `path, rect, circle, ellipse, polygon, polyline, line, text, foreignObject, image` outside `defs`, `marker` and `style`.

### 3. Theming

Model #1 (CSS-inherit, theme-variable driven) like `.vmde-diagram-error`; no palette interaction. Add to `main.css` next to the error box:

```css
.vmde-diagram-warning {
  --vmde-diagram-warning-accent: var(--vscode-editorWarning-foreground, #bf8803);
  border: 1px solid var(--vscode-inputValidation-warningBorder, var(--vmde-diagram-warning-accent));
  border-left-width: 3px;
  border-radius: 4px;
  background: var(--vscode-inputValidation-warningBackground, transparent);
  padding: 0.35em 0.75em;
  margin: 0.4em 0 0;
  max-width: 100%;
  text-align: left;
  font-size: 0.85em;
}
.vditor--dark .vmde-diagram-warning { --vmde-diagram-warning-accent: var(--vscode-editorWarning-foreground, #cca700); }
.vmde-diagram-warning__title { font-weight: 600; color: var(--vmde-diagram-warning-accent); }
.vmde-diagram-warning__msg { margin: 0.15em 0 0; color: var(--vscode-foreground); white-space: normal; }
```

- Light and dark come from the VS Code variables; the hex values are harness fallbacks only (VS Code's own light and dark `editorWarning.foreground`).
- High contrast: add `.vmde-diagram-warning` and `.vmde-diagram-error` to the Task 267 rule `:is(body.vscode-high-contrast, body.vscode-high-contrast-light)` (`main.css:3009-3024`) with `border-color: var(--vscode-contrastBorder, currentcolor)`, keeping `border-left-color: var(--vmde-diagram-warning-accent)` for the warning. Add both to the `@media (forced-colors: active)` list at `main.css:3047-3059`.

### 4. Test plan

| Test | Layer | Acceptance item |
|------|-------|-----------------|
| `media-src/src/diagrams/mermaid/mermaid-report.test.ts`: `misplacedTerminalLabelCount` (misplaced start, misplaced end, correct, one-label edge skipped, missing points skipped); `collectTerminalGeometry` on a fixture SVG string (attribute parse, base64 decode); `isEmptyMermaidSvg`; `mayRequestElk`; `elkFallbackApplies` per type; `mermaidWarningHtml` (escape, `data-render="1"`, token list, singular/plural); `withTimeout` with fake timers | Vitest | Detectable defects; errors |
| `mermaid-elk.test.ts`: `registerMermaidElkLoaders` returns `true`/`false`; the loader's module wrapper records `diagramId` and `takeElkRender` consumes it; error text `ELK layout failed to load.` | Vitest | Proposed work 5; F3 |
| `native-offscreen.test.ts`: time cap renders the mermaid timeout box; empty mermaid job skipped | Vitest | No blank diagram |
| `render-cache-client.test.ts`: a `layout-fallback` render is neither PUT nor remembered; a `terminal-labels` render is PUT with its box | Vitest | Survives cache |
| `test/backend/vditor-source-patches.test.ts`: the new patch inserts the hooks, the `addScript` rejection handler and the timeout, and throws on anchor drift | Vitest | Errors |
| `media-src/e2e/mermaid-report.spec.ts` on the existing mermaid harness (add a `__setValue(md)` helper to `mermaid-harness.ts`): (H1) `stateDiagram-v2` with `layout: elk` renders an SVG, no error (hooks register ELK); (H2) `page.addInitScript` replaces `registerLayoutLoaders` with a no-op when `window.mermaid` is assigned → state shows the error box with `Unknown layout algorithm: elk`, flowchart shows `layout-fallback` with `ELK layout is not available. Drawn with dagre instead.`; (H3) `page.route` aborts `mermaid-elk-main.js` → error `ELK layout failed to load.`; (H4) synthetic class diagrams: straight TB `Owner "1" --> "*" Item` with ELK flagged, fan-out and dagre variants not flagged (Probe 4); (H5) `page.route` aborts `mermaid.min.js` → `Mermaid renderer dependency failed to load.`; (H6) `page.clock` + a never-settling `mermaid.render` stub → timeout message; (H7) `getValue()` byte-identical with a warning present | Chromium | State with unregistered loaders; flowchart fallback warning; no blank diagram; terminal-label warning |
| `test/vscode-e2e/mermaid-report.spec.ts` with fixture `test/vscode-e2e/fixtures/mermaid-report.md` (synthetic content, all `layout: elk`: one flowchart, the straight TB class diagram with `"1" --> "*"`, the fan-out class diagram, one `stateDiagram-v2`, one broken block). Case A, in IR, WYSIWYG, sv (Split) and Preview: every ELK diagram has an `<svg>` and no error; the broken block has `.vmde-diagram-error` inside its own `.language-mermaid`; the straight class diagram has `.vmde-diagram-warning[data-vmde-warning~="terminal-labels"]` inside its own block, the fan-out none; document text unchanged after the mode switches. Case B: theme flip and a mode switch back keep the warning (P6, P8). Case C (fallback): open a document without mermaid, chain the existing `window.mermaid` accessor in the frame so `registerLayoutLoaders` becomes a no-op, then add the mermaid blocks with a `WorkspaceEdit`; in all four modes the state diagram shows the error and the flowchart the fallback warning | Real VS Code | Every error and warning in place in all four modes; state and flowchart fallback items; real-VS-Code spec passes |
| 75-diagram check: `test/vscode-e2e/mermaid-report-combat.spec.ts`, tagged `@probe` and skipped unless `VMDE_COMBAT_DIR` points at the copied folder (nothing from it is committed). It opens each of the 19 files in IR and Preview and records per block: SVG present, error text, warning tokens. Expected: 0 errors, 0 `layout-fallback`, `terminal-labels` on `D-programmer-view/05-data-models.md` indices 5, 9, 10, 12, 13, 14 only | Real VS Code (`@probe`) | `special-ball-abilities-data-model` warning; other diagrams |
| Focused tests red before / green after, then `npm run quality` | Gates | Last acceptance item |

Part 2 must confirm in real VS Code that index 5 is flagged there too: the probes ran in Chromium with harness fonts, and the Finding 2 placement in real VS Code differs from the harness in detail (in the harness the LevelValues `*` is next to its arrowhead; only the AbilityDefinition edge is flagged).

### 5. Open questions

- Q1 (record correction): the Acceptance item names 4 reference-also diagrams (05-data-models indices 9, 10, 12, 14). The check also flags index 13, and so does the reference (`id_BuildInventory_OwnedBall_1`, straight 34 px edge). Recommendation: accept 9, 10, 12, 13, 14 as the reference-also set.
- Q2: the check flags every straight short ELK class edge that carries both labels (it is what makes Finding 2 ambiguous). A layout fix (for example an ELK layer spacing for class diagrams so the gap matches the reference's 54 px) is out of this task's scope. Recommendation: keep this task to reporting and file a separate task for the spacing if the Owner wants the defect itself fixed.
- Q3: the 30 s render timeout and 35 s poll cap are design values, not measured limits. Recommendation: accept; the slowest combat render in the harness took well under 1 s (75 diagrams in 11.3 s total).

### Probes run (Part 1, Chromium only, outputs in `tmp/705/`)

1. `probe-overlap.mjs` → `probe-overlap.json`, `probe-overlap.log`: all 75 with ELK unregistered: 72 SVGs, the 3 state diagrams fail with `Unknown layout algorithm: elk`. With ELK registered: 75 SVGs, 13 diagrams carry terminal labels, zero overlapping terminal-text boxes in the VMDE render and in the reference. `mermaid.parse` reports `flowchart-v2`/`classDiagram`/`stateDiagram` with `config.layout = elk` for all 75.
2. `probe-geometry.mjs` + `analyze-geometry.py`, and `probe-vmde-svgs.mjs` + `attr-check.py`: end-distance rule flags VMDE 5, 9, 10, 12, 13, 14 and reference 9, 10, 12, 13, 14, by box centres and by attributes alike; stable for ratios 1.0–1.5.
3. `probe-diagramid.mjs` → `probe-diagramid.log`: ELK render module sees `data.diagramId` equal to the render id (flowchart, class, state, ER; none for a dagre flowchart); a rejecting ELK loader makes `mermaid.render` reject with the loader's message for flowchart and state (no dagre fallback); `parse` returns `config.layout` from `%%{init}%%`, not from a top-level front-matter `layout:`.
4. `probe-synthetic.mjs` → `probe-synthetic.log`: straight TB and LR `"1" --> "*"` ELK class edges flagged (1 label each), fan-out and dagre not flagged, one-label edge skipped; check cost 0.0–0.3 ms.

### Orchestrator decisions on the open questions (2026-11-08; provisional, on the Owner's behalf, reversible)

- **Q1:** accepted. The "also in the reference" set is `05-data-models` indices 9, 10, 12, 13 and 14; index 5 is the only VMDE-only flag. The acceptance item about the 75 combat diagrams reads with this set.
- **Q2:** accepted. Changing the class-diagram ELK spacing (the layout itself) is outside this task; it is recorded as a follow-up.
- **Q3:** accepted: 30 s render timeout, 35 s poll cap.
- **Split of Part 2:** P2a failing tests (Vitest, Chromium harness, real-VS-Code spec and fixture, the `@probe` combat spec); P2b errors, timeout, script-load failure, ELK registration on every path and the hook module; P2c warning element, ELK fallback detection, edge-terminal label check and theming. Each step runs its own checks; the real-VS-Code runs are batched by the orchestrator.

## Part 2a results (2026-11-08)

Failing tests written, no product code. Tests and the acceptance item each covers are named in a header comment of the file.

- Vitest (RED): `media-src/src/diagrams/mermaid/mermaid-report.test.ts` (new module missing, whole file fails to import), `mermaid-elk.test.ts` (5 failures), `diagram-kit/native-offscreen.test.ts` (2), `diagrams/render-cache-client.test.ts` (2), `test/backend/vditor-source-patches.test.ts` (4).
- Chromium: `media-src/e2e/mermaid-report.spec.ts` H1-H7, all 7 RED; helpers `__setValue` and `__getValue` added to `mermaid-harness.ts`.
- Real VS Code (written, not run): `test/vscode-e2e/mermaid-report.spec.ts` (cases A, B, C) with fixtures `mermaid-report.md` and `mermaid-report-empty.md`; `@probe` spec `mermaid-report-combat-probe.spec.ts (renamed in Part 2b: the probe-tier guard requires the -probe suffix)` (skips without `VMDE_COMBAT_DIR`).
- Contract gaps resolved by assumption, to confirm in Part 2b: `EdgeEnds = { start, end }`, `TerminalGroup = { edgeId, labels }`, extra export `terminalLabelsMessage(n)`, the patch tests target `patchMermaidErrorRender` output.

## Part 2b/2c results (2026-11-08)

Files: `media-src/src/diagrams/mermaid/mermaid-report.ts` (new hook module), `mermaid-elk.ts` (boolean register, `takeElkRender`, `ELK layout failed to load.`), `boot/preload.ts` (installs hooks), `diagram-kit/native-offscreen.ts` (35 s time cap, timeout box, empty-source skip), `media-src/esbuild-shared.mjs` (`patchMermaidErrorRender` chain: script-load box, timeout race, ELK registration, `afterInsert`), `diagrams/render-cache-client.ts` (a `layout-fallback` render is neither remembered nor PUT), `main.css` (`.vmde-diagram-warning`, high contrast, forced-colors), `scripts/module-manifest.mjs`, tests (probe spec renamed `mermaid-report-combat-probe.spec.ts`).

Checks: `node build.mjs` exit 0; `npm run typecheck` 0 errors; `npm run typecheck:vscode-e2e` exit 0; Chromium `mermaid` specs 23 of 23 pass (H1-H7 included); Vitest on `diagrams/mermaid` plus `vditor-source-patches` green; `npm run quality`: check:brand-identifiers, lint:ci, jscpd, depcruise, audit, test:coverage, check:coverage-modules pass; knip failed on 3 unused exports of the new module, fixed (now only a pre-existing tag hint) and re-checked with `npx knip`. Real-VS-Code specs not run (orchestrator).

Decisions: the timeout text exists in the hook constant and in the patch output; a test in `vditor-source-patches.test.ts` pins them equal. `afterInsert` stamps `data-code` only when it appends a box (no measured need to stamp every render).

## Closure (2026-11-08)

Rebased onto `dev` `69d7ba28`. `node build.mjs` exit 0; `npm run quality` exit 0; Chromium mermaid specs 23/23. Real VS Code: `mermaid-report.spec.ts`, the combat probe and 6 of 7 existing mermaid specs pass; `mermaid-flip-gate.spec.ts:14` passes alone (2/2) and fails only in the combined order `diagram-cache-mermaid, mermaid-c4-colors, mermaid-elk, mermaid-error, mermaid-flip-gate`, identically on unchanged `dev` (pre-existing order dependence, follow-up). Follow-up: class-diagram ELK spacing (the label placement itself) is not changed here.
