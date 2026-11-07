# Task 705 — Report mermaid diagram errors and defects instead of failing silently

**Status:** planned (2026-11-08). Scope set by the Owner on 2026-11-08: every mermaid failure, fallback or detected defect is reported visibly; no diagram fails or degrades silently.
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

## Proposed work

1. Inventory every mermaid render path (IR, WYSIWYG, sv preview, Preview pane, live re-theme `reRenderMermaid`, render cache, export, copy-as-image, harnesses) and every way it can end without a visible result: thrown error, rejected promise, empty or zero-size SVG, render that never finishes (timeout), viewport gating that never fires, and silent fallbacks (`layout: elk` without registered loaders falls back to dagre for flowchart and class diagrams, Finding 3). Record the list in this file.
2. Errors: every path that fails shows the existing `.vmde-diagram-error` box with the Mermaid message (for example `Unknown layout algorithm: elk`) and the diagram source stays editable. No blank block.
3. Fallbacks: when VMDE renders with a different layout or setting than the diagram asked for, show a visible, non-blocking warning on the diagram (for example "ELK layout unavailable, drawn with dagre").
4. Detectable defects: report, as a warning, defects VMDE can measure after render, starting with overlapping edge-terminal (cardinality) labels (Finding 2). Keep the check cheap and limited to what can be measured reliably.
5. Register the ELK loaders on every render path so Finding 3 no longer happens in normal use; the error/warning reporting stays as the safety net.

## Acceptance

- [ ] Step 1 inventory recorded.
- [ ] No inventoried path ends with a blank or missing diagram without a visible error.
- [ ] A state diagram with `layout: elk` and unregistered loaders shows an error or a fallback warning, never a blank block.
- [ ] A flowchart that falls back from ELK to dagre shows the fallback warning.
- [ ] `special-ball-abilities-data-model` shows the overlapping-label warning; the other 74 combat diagrams show none (except the 4 that overlap in the reference too, if the check flags them).
- [ ] Focused tests fail before and pass after; real-VS-Code spec passes; `npm run quality` passes.

## Tests to write

- Chromium harness spec: `stateDiagram-v2` with front matter `layout: elk` renders an SVG, no `Unknown layout algorithm` error.
- Real-VS-Code spec: a fixture with one flowchart, one class diagram with cardinalities and one state diagram, all with `layout: elk`; each renders an SVG in IR and Preview.
