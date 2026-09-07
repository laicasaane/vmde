# Task 568 — Fix Find & Replace targeting and match-only highlighting

**Status:** 📋 TODO · **Origin:** Project Owner report and screenshot, 2026-09-07

## Problem and evidence

The owner reports that Find does not work as expected, requests configurable highlight color
and opacity, and requires highlighting only matching text, never an entire block.

The supplied dark-theme screenshot searches for `import`, displays `6/9`, and shows a large
filled yellow rectangle obscuring content beneath a heading. The count is an observed UI value,
not proof that nine matches or the sixth target are correct. Reproduce with a sanitized mixed
Markdown fixture; do not copy the private document or assume its contents from the screenshot.
Record editor mode, query options, loaded build, theme, zoom and content width.

Current source evidence:

- `media-src/src/editing/selection-scope.ts`: `installFindReplace` maps results to block indexes;
  `renderOverlays` deduplicates those indexes and uses each block's `getBoundingClientRect()`.
  `revealCurrent` likewise scrolls to the block, not the individual occurrence.
- `media-src/src/main.css`: `.vmde-find-overlay` and its current-match variant use VS Code
  theme colors with translucent fallbacks. A supplied theme value can replace the fallback;
  the actual winning color/alpha in the screenshot has not been measured.
- [Task 196](done/196-find-and-replace.md) deliberately shipped block overlays. This task
  supersedes that presentation choice while retaining its source-accurate search/replacement
  contract and existing keyboard bindings.

Block geometry explains the coarse highlight at source level. The broader Find malfunction and
exact opacity cause still need runtime reproduction; no browser or real-VS-Code test ran while
creating this task.

## Scope and acceptance

- [ ] Reproduce Find behavior with repeated `import` occurrences in one block and across prose,
      headings, lists, tables, fenced code and mixed inline formatting. Establish expected source
      offsets/count/order independently of the rendered DOM, including source/preview duplicates.
- [ ] Fix query updates, current-match ordinal, next/previous navigation and wrap-around so each
      step identifies and reveals the exact occurrence. Verify literal search, case/whole-word
      options, no matches, edits while Find is open and mode changes. Diagnose rather than assume
      which of these mechanisms causes the reported malfunction.
- [ ] Replace block-sized decoration with match-text geometry. Highlight only the matched
      characters, including separate fragments when a match wraps or crosses inline text nodes.
      Multiple matches in one paragraph/cell/code block must remain individually distinguishable.
      Never paint the containing paragraph, heading, row, cell, code fence or whole block as a
      substitute, even when exact visual mapping is unavailable.
- [ ] Define an honest reveal path for source-only or folded matches: reveal the exact editable
      source occurrence where supported, or communicate that it is not currently visible. Do not
      manufacture a block highlight or silently redirect to unrelated visible text.
- [ ] Provide documented VS Code settings for highlight color and opacity, covering ordinary and
      current matches. Keep those states distinguishable, choose readable theme-aware defaults,
      validate color input and opacity bounds, and apply changes live through existing configuration
      plumbing. Apply alpha to the highlight paint, never to document text or a content container.
      Setting names and exact defaults belong to implementation planning, not this untested report.
- [ ] Keep text readable in light/dark themes, including themes whose Find colors are fully opaque.
      Verify configured opacity endpoints and an intermediate value; avoid stacking duplicate
      fragments into a darker or opaque patch. Clear stale highlights on query change and close.
- [ ] Preserve Find/Replace semantics: Replace targets the indicated occurrence; Replace All edits
      exactly the matched source ranges. Preserve unrelated bytes, literal replacement text,
      CRLF/Unicode, undo/redo, Preview read-only policy and the existing Ctrl/Cmd+F binding.
      Do not change the established Ctrl/Cmd+H Headings shortcut.
- [ ] Keep decoration out of serialized Markdown and clipboard source, pointer-inert, aligned during
      scrolling/resizing/zoom and non-disruptive to caret/focus. Avoid document-wide expensive
      rendering or serialization on every geometry-only refresh.

## Implementation starting points

Inspect the existing Find engine, transaction and widget in `selection-scope.ts` and its unit
spec; overlay CSS in `main.css`; configuration definitions in `package.json`,
`src/platform/editor-config.ts`, `src/webview-host/panel-config.ts` and the webview live-config
path. Reuse the existing source model and transaction authority. Choose DOM ranges, text-fragment
rectangles or an appropriate highlight API only after proving source-to-visible-text mapping in
IR/WYSIWYG/SV and relevant Preview behavior. Do not edit generated or vendored output.

## Focused verification and completion

- [ ] Extend focused unit coverage for exact match ranges, navigation/current replacement,
      configuration validation and mapping edge cases; retain Task 196 replacement regressions.
- [ ] Extend `media-src/e2e/find-replace.spec.ts` with a controlled mixed document. Assert highlight
      rectangles/ranges correspond to matched text fragments, exclude surrounding nonmatching text,
      and never equal a larger containing block. Include wrapped matches, multiple same-block hits,
      table/code content, option changes, scroll/resize and configurable paint in light/dark themes.
- [ ] Build, then extend/run `test/vscode-e2e/find-replace.spec.ts` in the actual VS Code webview.
      Use the established OS XTEST route for keyboard acceptance. Verify exact navigation targets,
      rendered readability/geometry, live settings, replacement/undo and saved/reopened bytes.
      Use sanitized fixtures and record screenshots/geometry as evidence, not text-only assertions.
- [ ] Follow DEVELOPMENT.md and the active queue's focused-testing overrides. Report actual bundle
      bytes/KiB, delta and eager-module count; existing size ceilings are reporting-only. Audits
      remain waived for this queue. Do not use broad suites as a debugging loop.
- [ ] Update this task with actual results and limitations, then the index only on completion;
      create a focused local commit without pushing.

Independent follow-up to completed Task 196. No dependency on Task 567's wrapping fix; coordinate
shared CSS if necessary. Application implementation and acceptance validation have not started.
