# Task 557 — Inline picture element in visual editing

**Status:** ✅ DONE (2026-09-07) · **Origin:** GitHub Markdown support audit, 2026-09-06

## Syntax and upstream contract

[Official GitHub documentation](https://docs.github.com/en/get-started/writing-on-github/getting-started-with-writing-and-formatting-on-github/quickstart-for-writing-on-github) (checked 2026-09-06).

````markdown
Text <picture><source media="(prefers-color-scheme: dark)" srcset="dark.png"><img src="light.png" alt="Example"></picture> text.
````

## Evidence and existing-task ownership

Lute preserves picture/source/img in sanitized HTML. A standalone multiline picture already gets an HTML-block preview. The inline form instead becomes separate escaped html-inline nodes in IR, with no picture preview. This is a partial visual-editing gap, not absent block-picture support.

Task 47 concerns raw IMG/data-URI behavior; it does not specify picture/source selection. Coordinate shared safe HTML machinery with it.

Evidence is limited to source inspection and a small pinned-Lute probe where stated.
No browser or real-VS-Code reproduction ran in the audit session. Confirm the user-visible
baseline before implementation; engine output alone is not a packaged-editor result.
See [the audit](../../docs/github-markdown-support-audit-2026-09-06.md).

## Scope

Render an inline picture as one image presentation while retaining its original HTML editing surface. Preserve source ordering, media/srcset/alt attributes and fallback IMG; verify relative assets and theme selection through the real webview. Retain working multiline HTML-block behavior. Investigate any resource-routing issue before claiming it is a separate confirmed defect.

This task owns only the syntax named in its title. Shared helpers may support sibling tasks,
but must not silently expand this task into a general GitHub-compatibility rewrite.

## Toolbar control requirements

**Decision: add Insert picture under More; preserve the current Upload action.**

- [x] Add **Insert picture** with fallback image path/URL, alt text, and optional dark/light image
      fields. Require a fallback and generate one inline PICTURE with ordered SOURCE elements and
      a fallback IMG; escape attribute values and keep relative paths as authored.
- [x] Reuse established asset-input validation where applicable. Applying the form inserts markup;
      it must not upload files or fetch remote assets as part of the insertion action.
- [x] Existing arbitrary picture markup must remain source-editable. This initial insertion form
      must not flatten an existing picture's unsupported media/srcset choices when opened nearby.
- [x] Verify form cancellation, preserved insertion position, attribute escaping, exact generated
      Markdown, one-step undo, and the inserted picture's rendering in the real webview.

For added or extended controls: use the existing toolbar overflow, localization, tooltip and
keyboard-accessibility conventions (Tasks 492/505). Preserve selection when focus enters a menu,
support keyboard activation and Escape/focus return, and disable mutations in read-only Preview.
Keep new actions in the menu placements above rather than pinning extra buttons by default.
Use a single command handler per action; do not introduce duplicate Vditor/VS Code hotkeys.
Include toolbar interaction in this task's focused Chromium and real-VS-Code verification.

## Implementation and verification

- [x] Confirm the focused baseline in the current editor and define the smallest correction.
- [x] Implement the syntax contract without losing source bytes or weakening sanitization/CSP.
- [x] Unit coverage for valid, malformed, escaped, and literal-code cases and source fidelity.
- [x] Focused Chromium coverage for affected Preview/IR/WYSIWYG behavior and source-mode fidelity.
- [x] Build first, then a focused real-VS-Code spec under xvfb covering actual interaction,
      saved/reopened Markdown, and undo/redo; verify host navigation where applicable.
- [x] Run applicable focused gates and final quality validation per DEVELOPMENT.md before closure.

## Delivered

- `inline-picture.ts` recognizes only a contiguous balanced PICTURE → SOURCE* → IMG marker run,
  accepts relative or HTTPS raster assets, creates a DOM-built `data-render="1"` presentation, and
  restores the untouched marker surface when it receives selection/pointer focus.
- More → Insert picture emits ordered dark/light sources and a fallback IMG through one exact-source
  transaction. It rejects missing, SVG, data, JavaScript, and non-raster locations; it never uploads,
  fetches, or rewrites an authored path to a webview URI.
- The existing multiline HTML-block path remains Lute-owned and untouched.

## Verification

- RED → GREEN: focused unit `inline-picture.test.ts` (6 cases) and focused Chromium form transaction.
  Unit and Chromium V8 reports both exercise `inline-picture.ts`.
- `node build.mjs`; `npm run typecheck`, `npm run typecheck:strict`, and
  `npm run typecheck:vscode-e2e` passed.
- Focused real VS Code (`inline-picture-editing.spec.ts`, no retry) passed: IR source-faithful preview,
  More interaction, escaped exact source written to disk, undo/redo, save/reopen, WYSIWYG, and Preview.
- Final aggregate validation was run. `check:bundle-size` reports 681 KB against the inherited 608 KB
  ceiling (the queue treats this ceiling as reporting-only); `npm run quality` remains red for shared
  in-progress formatting/brand drift, npm-audit DNS (`EAI_AGAIN`), and unrelated release-fixture tests.
  The full Chromium suite also has unrelated Math/toolbar-overflow failures; the focused Task 557 case
  passed. No task-specific regression was observed.
