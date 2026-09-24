# Task 220 — Checkbox toggle in Preview mode + sv right pane

**Status:** 🚧 In progress (2026-09-25) · **Impact:** ⚪ low · **Origin:** task 192 §5

## Problem

Task-list checkboxes are inert outside the edit modes: Lute's preview render emits
`<input disabled type="checkbox">` (verified by Node probe; no click handler in vendored
`preview/index.ts` nor in our code). Users read docs in Preview and expect to tick items —
GitHub renders task lists interactively.

## Scope

- [ ] Post-render pass on preview surfaces (Preview mode + sv right pane): remove
      `disabled`, add a delegated click handler.
- [ ] Click → map the checkbox back to its source line (source-map / list-item index within
      the rendered tree — sv already has block anchors; reuse) → toggle `[ ]`↔`[x]` in the
      MODEL (post an edit through the normal pipeline, not DOM-only), preview re-renders
      from the change.
- [ ] Setting `vmde.preview.interactiveCheckboxes` (default on); read-only contexts
      (untrusted workspace?) leave disabled.
- [ ] Scroll position must survive the re-render (preview-scroll-preserve contract).

## Out of scope

- Other interactive preview elements, nested `[x]` styling changes.

## Verification

- L1: checkbox→source-line mapping unit (nested lists, multiple lists, checkbox inside
  callout/blockquote).
- L2: sv right-pane + Preview click → `getValue()` flips exactly one marker; scroll kept;
  one edit post (extends the 191 P0-15 real-click net to the preview surfaces).
- L3 real-VS-Code (mandatory): Preview toggle → click → Ctrl+S → disk shows `[x]`.

## Part 2 progress checkpoint (2026-09-25)

The pure source-marker primitive and exact Preview render-source capture are in place.
findTaskListMarkers() reuses the existing forward list/protected-leaf scan and exposes
the exact three-character marker offsets and checked state. Its tests cover nested and
separate lists, ordered/unordered items, blockquotes/callouts, uppercase [X], empty
items, and fail-closed fenced, HTML, indented-code, escaped, and prose lookalikes.

The Vditor preview/index.ts source patch now captures the exact source returned by
__vmdePreviewSnapshot() before the preview delay, gives that render a token, and carries
the token through all three delayed afterRender paths and the empty-render path. A
superseded render cannot consume a newer source snapshot. The connected current preview
pane publishes the matching captured source through __vmdePreviewSourceRendered after
its render pipeline commits. A stale callback is rejected before it can mark stale DOM
reusable. Generated Vditor output was not edited.

Checkpoint verification:

- The three new delayed-source-capture assertions first failed against the prior code; the stale-render reuse assertion then exposed and verified the separate stale-commit guard.
- npx vitest run --config test/vitest.config.mts media-src/src/editing/list-normalize-source.test.ts media-src/src/editing/preview-state.test.ts test/backend/vditor-source-patches.test.ts — **241/241 passed**.
- Changed-source coverage passed **19/19**: preview-state.ts **100% lines**, list-normalize-source.ts **98.98% lines**, **99.18% combined**. The report's uncovered scanner branches are in the existing ordered-list normalizer.
- npm run typecheck — passed.
- Scoped npx biome check over the six changed TypeScript/patch files — passed.
- git diff --check — passed.
- No build, Chromium, or real-VS-Code run was made for this checkpoint.

Task remains open. Preview control-to-source container matching, interactive setting,
writability/read-only gate, the one-marker guarded host WorkspaceEdit and explicit
acknowledgement, scroll preservation, and focused Chromium/real-VS-Code journeys are
still outstanding.
