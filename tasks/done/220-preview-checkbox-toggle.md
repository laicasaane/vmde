# Task 220 — Checkbox toggle in Preview mode + sv right pane

**Status:** ✅ DONE (2026-09-25) · **Impact:** ⚪ low · **Origin:** task 192 §5

## Problem

Task-list checkboxes are inert outside the edit modes: Lute's preview render emits
`<input disabled type="checkbox">` (verified by Node probe; no click handler in vendored
`preview/index.ts` nor in our code). Users read docs in Preview and expect to tick items —
GitHub renders task lists interactively.

## Scope

- [x] Post-render pass on preview surfaces (Preview mode + sv right pane): remove
      `disabled`, add a delegated click handler.
- [x] Click → map the checkbox back to its source line (source-map / list-item index within
      the rendered tree — sv already has block anchors; reuse) → toggle `[ ]`↔`[x]` in the
      MODEL (post an edit through the normal pipeline, not DOM-only), preview re-renders
      from the change.
- [x] Setting `vmde.preview.interactiveCheckboxes` (default on); read-only contexts
      (untrusted workspace?) leave disabled.
- [x] Scroll position must survive the re-render (preview-scroll-preserve contract).

## Out of scope

- Other interactive preview elements, nested `[x]` styling changes.

## Verification

- L1: checkbox→source-line mapping unit (nested lists, multiple lists, checkbox inside
  callout/blockquote).
- L2: sv right-pane + Preview click → `getValue()` flips exactly one marker; scroll kept;
  one edit post (extends the 191 P0-15 real-click net to the preview surfaces).
- L3 real-VS-Code (mandatory): Preview toggle → click → Ctrl+S → disk shows `[x]`.

## Implementation and closure evidence (2026-09-25)

The source marker scanner pairs rendered task controls with exact three-character
markers through top-level list identity, nested list paths, and blockquote/callout
depth. It fails closed when source and rendered controls differ, or when a marker
sits in protected Markdown. A patched Vditor Preview render carries its source
snapshot and render token across delayed callbacks, so an old render cannot
enable a checkbox against newer source. One delegated controller covers full
Preview and the SV right pane. The resource-scoped
`vmde.preview.interactiveCheckboxes` setting defaults on; disabled settings and
non-writable filesystem schemes leave controls disabled. Untitled documents
remain editable. Workspace trust is not used as a writability proxy: the action
is one guarded Markdown WorkspaceEdit and does not run workspace code or write
assets.

A click posts one request containing the raw source, exact marker offsets and
request ID. The host rechecks document version and every raw byte immediately
before applying one marker-range WorkspaceEdit. It cancels a pending ordinary
document-sync update, suppresses only the matching onDidChange event, then
posts a verified raw-before/raw-after update *before* its outcome. Host-only
table-pipe normalization is carried separately as `renderedAfter`. The
webview retains Vditor's native history only when the update matches the
still-pending request, exact before snapshot, and rendered after content;
ordinary external updates still clear the stack. The existing exact-history
bridge maps one native Undo/Redo step back to the authored Markdown bytes.
The host-update refresh renders the visible Preview pane from the exact source
and restores its scroll position. Mode-choice controls no longer synthesize a
source edit when clicked; formatting toolbar actions retain their undo
boundary. This prevents Vditor's mode switch from appending a terminal newline
and racing a later SV checkbox request.

Verification:

- The early source/render-token checkpoint passed 241/241 units and documented
  99.18% combined line coverage for the two pure source modules. The final
  focused eight-suite unit command passed **151/151**. It covers nested and
  separate lists, ordered/unordered items, blockquotes/callouts, uppercase
  `[X]`, empty items, fenced/HTML/indented/escaped/prose exclusions, stale and
  read-only host requests, one marker edit, update-before-outcome ordering,
  pending-update cancellation, and a previous native history step surviving
  checkbox Undo/Redo.
- Focused V8 coverage ran the same **151/151** tests. Per-file line coverage:
  `preview-task-checkbox-edit.ts`, `doc-sync.ts`, and `preview-state.ts`
  **100%**; `list-normalize-source.ts` **99.03%**;
  `preview-task-checkboxes.ts` **87.16%**;
  `message-router.ts` **74.4%**; `undo-boundaries.ts` **71.42%**;
  `editor-session.ts` **53.84%**. These last three figures cover large
  modules with behavior outside this task. The filtered coverage command
  exits nonzero on the repository-wide percentage floor because only eight
  suites run; every selected test passed.
- `xvfb-run -a npm --prefix media-src run test:e2e -- e2e/checkbox-click.spec.ts`
  passed **4/4** for trusted IR/WYS checkbox source behavior, inert read-only
  Preview, and exactly one source-owned interactive Preview request without
  browser errors. The focused Chromium coverage form also passed **4/4** and
  reports `preview-task-checkboxes.ts` at **70.4% lines**. The browser harness
  has no VS Code host transaction; the real-editor spec below covers it.
- After `node build.mjs`, the final focused real VS Code spec
  `preview-task-checkbox.spec.ts` passed **1/1** without retries. In full
  Preview and the SV right pane it verifies exact one-marker host bytes, one
  document-version increment, the two live `getValue()` marker states,
  control re-enabling, scroll retention, one trusted Ctrl+Z/Ctrl+Y step,
  save/reopen bytes, and setting-off disabled controls.
- Host and webview TypeScript checks, scoped Biome over all 30 Task 220
  source/test/manifest files, and `git diff --check` passed. The two new
  source modules are registered in `scripts/module-manifest.mjs`.

Repository-wide gates were run and remain red for recorded work outside this
feature. `npm run check:bundle-size` measures the final eager webview bundle
at **849/608 KB**; `npm run check:startup-cost` measures **339/294** eager
modules. `npm run quality` reports failures in the legacy brand-marker
check, whole-tree formatting (`media-src/e2e/list-harness.ts` among others),
knip's unrelated unused exports, vendored emoji metadata audit, full unit
coverage, and the coverage-module ratchet after the full coverage failure.
The full unit run had 8 failures among 4,480 tests: missing module-manifest
entries/allowlist edges outside Task 220, one unordered Emoji setting, an
untagged probe convention, vendored Emoji metadata, and Task 572's deliberately
red pinned-Lute reference-label case. Task 220's two new module IDs are
registered; the remaining module-manifest totality failure names other files,
and the webview-to-host Markdown edge introduced during development was
removed. The focused tests and final real journey above verify this task's
acceptance despite those aggregate residuals.
