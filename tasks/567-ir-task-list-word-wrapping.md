# Task 567 — Preserve word boundaries when IR task-list prose wraps

**Status:** 📋 TODO · **Origin:** Project Owner screenshot and case study, 2026-09-07

## Problem and reproduction

Open [Task 228](228-issue-tracker-links.md) in IR mode at an approximately 1110 px
viewport. Its Scope checklist wraps ordinary prose inside words: `config` becomes
`c` / `onfig`, `Lute-invisible` ends with `Lute-invisibl` / `e`, and `wire` becomes
`wir` / `e`. The screenshot also shows a split inside `math`. These are visual line
breaks, not requested source edits. Record actual webview/content width, font settings,
zoom and content theme when reproducing; the reported viewport is approximate.

Compare identical text as unchecked `- [ ]`, checked `- [x]`, ordinary `-` bullets,
and a paragraph. Preserve Task 228 itself as the original case study.

## Source evidence and diagnosis boundary

The installed Vditor stylesheet, `media-src/node_modules/vditor/dist/index.css`,
contains `.vditor-task { list-style: none !important; word-break: break-all; }`
(lines 1130–1133 at investigation time). This explicitly allows mid-word wrapping
for task-list items. The ordinary `.vditor-reset` rule instead uses
`word-break: break-word`; `build.mjs` preserves that property in its base-font patch.
No task-specific correction was found in `build.mjs`, `scripts/`, or
`media-src/src/main.css` during this source inspection.

This is a concrete source-level explanation consistent with the screenshot and the
checkbox-versus-bullet hypothesis. Winning computed styles, exact loaded artifact and
before/after geometry have not yet been measured in Chromium or real VS Code.
Confirm those before selecting the implementation; do not claim a runtime-proven fix.

## Scope and implementation checklist

- [ ] Reproduce the reported document and controlled list/paragraph variants; capture the
      winning word-break/overflow-wrap/white-space rules, DOM classes and word line boxes.
- [ ] Correct task-list prose so words that fit on a fresh line wrap at normal word
      boundaries. Retain safe wrapping for tokens longer than the available line width.
- [ ] Follow the renderer-theming skill and ADR-0003 when choosing the owning CSS/build
      patch. Inspect index and content-theme rules; use anchor-checked patching where
      required. Do not edit node_modules or generated CSS as the deliverable.
- [ ] Preserve checkbox alignment, nested-list indentation, inline code/link layout,
      source text, selection, typing, checkbox interaction and undo/redo behavior.
- [ ] Check IR first and assess shared-rule effects in WYSIWYG and Preview; avoid
      unrelated table, link-card, typography or global line-breaking changes.

## Verification and acceptance

- [ ] Add focused Chromium geometry assertions: ordinary words in the supplied case
      remain intact when they fit on a fresh line; long unbroken tokens remain contained.
      Cover checked/unchecked/nested lists, ordinary bullets, inline code and links,
      around 1110 px and narrower/wider widths, with light and dark content themes.
- [ ] Prove the regression check fails with the original task-list rule and passes with
      the correction. Use computed styles as supporting evidence, not the sole oracle.
- [ ] Run `node build.mjs`, then write and run a focused spec in `test/vscode-e2e/`
      under xvfb through the actual custom-editor webview. Record exact dimensions,
      settings, stylesheet provenance and the screenshot case's resulting line boxes.
- [ ] Verify source bytes survive resize, mode changes and save/reopen; verify checkbox
      toggling and undo affect only the intended marker. Follow the active queue's
      OS-level keyboard requirements for keyboard acceptance.
- [ ] Run applicable focused/static/quality gates per DEVELOPMENT.md and active owner
      overrides; record omitted gates and environmental limits honestly.

## Dependencies and current verification

Independent of implementing Task 228 or its GitHub companion tasks: Task 228 is only
reproduction content. No application source changed in this planning session. No browser,
real-VS-Code, build, or implementation acceptance tests have run for this task yet.
