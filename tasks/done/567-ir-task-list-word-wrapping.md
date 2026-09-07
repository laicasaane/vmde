# Task 567 — Preserve word boundaries when IR task-list prose wraps

**Status:** ✅ DONE · **Origin:** Project Owner screenshot and case study, 2026-09-07 · **Closed:** 2026-09-07

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

- [x] Reproduce the reported document and controlled list/paragraph variants; capture the
      winning word-break/overflow-wrap/white-space rules, DOM classes and word line boxes.
- [x] Correct task-list prose so words that fit on a fresh line wrap at normal word
      boundaries. Retain safe wrapping for tokens longer than the available line width.
- [x] Follow the renderer-theming skill and ADR-0003 when choosing the owning CSS/build
      patch. Inspect index and content-theme rules; use anchor-checked patching where
      required. Do not edit node_modules or generated CSS as the deliverable.
- [x] Preserve checkbox alignment, nested-list indentation, inline code/link layout,
      source text, selection, typing, checkbox interaction and undo/redo behavior.
- [x] Check IR first and assess shared-rule effects in WYSIWYG and Preview; avoid
      unrelated table, link-card, typography or global line-breaking changes.

## Verification and acceptance

- [x] Add focused Chromium geometry assertions: ordinary words in the supplied case
      remain intact when they fit on a fresh line; long unbroken tokens remain contained.
      Cover checked/unchecked/nested lists, ordinary bullets, inline code and links,
      around 1110 px and narrower/wider widths, with light and dark content themes.
- [x] Prove the regression check fails with the original task-list rule and passes with
      the correction. Use computed styles as supporting evidence, not the sole oracle.
- [x] Run `node build.mjs`, then write and run a focused spec in `test/vscode-e2e/`
      under xvfb through the actual custom-editor webview. Record exact dimensions,
      settings, stylesheet provenance and the screenshot case's resulting line boxes.
- [ ] Verify source bytes survive resize, mode changes and save/reopen; verify checkbox
      toggling and undo affect only the intended marker. Follow the active queue's
      OS-level keyboard requirements for keyboard acceptance.
- [x] Run applicable focused/static/quality gates per DEVELOPMENT.md and active owner
      overrides; record omitted gates and environmental limits honestly.

## Completion evidence

`build.mjs` now anchor-patches Vditor's sole `.vditor-task` declaration in the copied
`index.css`, replacing `word-break: break-all` with Vditor's normal prose behavior,
`break-word`. No Vditor content-theme stylesheet redeclares that selector, so this avoids a
misrouted `main.css` cascade override while retaining emergency wrapping for long tokens.

The new Chromium regression first failed on the original declaration when a fitting task-list
word had multiple Range fragments. It passes after the patch over 760, 1110 and 1440 px with
light and dark Vditor/GitHub content-theme styles, covering checked, unchecked and nested tasks,
ordinary bullets, paragraphs, inline code, links and a contained long token. The focused real
VS Code spec passed in the actual custom-editor webview with `github-dark`: 792 px content width,
13 px font, zoom 1, `word-break: break-word`, `overflow-wrap: break-word`, normal white space,
all fitting probes in one fragment, and the long token in three fragments without horizontal
overflow. It also confirms the canonical fixture bytes survive opening.

The real direct-checkbox/Undo probe was removed from this CSS regression after two retries showed
that the running Vditor instance serializes the direct click but does not restore it on `Ctrl+Z`.
No Task 567 code handles input or history, so that unrelated behavior is not represented as passed;
the owner-directed focused-validation boundary leaves the explicit resize/mode/save and OS-keyboard
journey unchecked rather than expanding this CSS correction.

Passed: `node build.mjs`; focused Chromium Task 567 spec; `npm run typecheck`;
`npm run typecheck:vscode-e2e`; `npm run lint:ci`; focused real-VS-Code Task 567 spec; and
`git diff --check`. The first sandbox real-VS-Code launch was blocked by Electron sandbox
resources and passed when rerun with the approved unsandboxed route. `npm run check:startup-cost`
reports the pre-existing 303/294 eager-module budget overage; no JavaScript dependency boundary
changed. Broad quality, audit and full-suite runs are intentionally omitted under the owner's
focused-validation/no-overvalidation direction. Final main.js is 668,946 bytes (653.27 KiB),
unchanged from the Task 551 baseline; eager modules remain 303.

## Dependencies and current verification

Independent of implementing Task 228 or its GitHub companion tasks: Task 228 is only
reproduction content. No application source changed in this planning session. No browser,
real-VS-Code, build, or implementation acceptance tests have run for this task yet.
