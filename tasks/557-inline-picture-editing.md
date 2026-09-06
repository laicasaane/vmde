# Task 557 — Inline picture element in visual editing

**Status:** 📋 TODO · **Origin:** GitHub Markdown support audit, 2026-09-06

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
See [the audit](../docs/github-markdown-support-audit-2026-09-06.md).

## Scope

Render an inline picture as one image presentation while retaining its original HTML editing surface. Preserve source ordering, media/srcset/alt attributes and fallback IMG; verify relative assets and theme selection through the real webview. Retain working multiline HTML-block behavior. Investigate any resource-routing issue before claiming it is a separate confirmed defect.

This task owns only the syntax named in its title. Shared helpers may support sibling tasks,
but must not silently expand this task into a general GitHub-compatibility rewrite.

## Toolbar control requirements

**Decision: add Insert picture under More; preserve the current Upload action.**

- [ ] Add **Insert picture** with fallback image path/URL, alt text, and optional dark/light image
      fields. Require a fallback and generate one inline PICTURE with ordered SOURCE elements and
      a fallback IMG; escape attribute values and keep relative paths as authored.
- [ ] Reuse established asset-input validation where applicable. Applying the form inserts markup;
      it must not upload files or fetch remote assets as part of the insertion action.
- [ ] Existing arbitrary picture markup must remain source-editable. This initial insertion form
      must not flatten an existing picture's unsupported media/srcset choices when opened nearby.
- [ ] Verify form cancellation, preserved insertion position, attribute escaping, exact generated
      Markdown, one-step undo, and the inserted picture's rendering in the real webview.

For added or extended controls: use the existing toolbar overflow, localization, tooltip and
keyboard-accessibility conventions (Tasks 492/505). Preserve selection when focus enters a menu,
support keyboard activation and Escape/focus return, and disable mutations in read-only Preview.
Keep new actions in the menu placements above rather than pinning extra buttons by default.
Use a single command handler per action; do not introduce duplicate Vditor/VS Code hotkeys.
Include toolbar interaction in this task's focused Chromium and real-VS-Code verification.

## Implementation and verification

- [ ] Confirm the focused baseline in the current editor and define the smallest correction.
- [ ] Implement the syntax contract without losing source bytes or weakening sanitization/CSP.
- [ ] Unit coverage for valid, malformed, escaped, and literal-code cases and source fidelity.
- [ ] Focused Chromium coverage for affected Preview/IR/WYSIWYG behavior and source-mode fidelity.
- [ ] Build first, then a focused real-VS-Code spec under xvfb covering actual interaction,
      saved/reopened Markdown, and undo/redo; verify host navigation where applicable.
- [ ] Run applicable focused gates and final quality validation per DEVELOPMENT.md before closure.

Audit-session validation is deliberately minimal; all implementation checkboxes remain open.
