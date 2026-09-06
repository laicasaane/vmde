# Task 556 — HTML named-anchor navigation

**Status:** 📋 TODO · **Origin:** GitHub Markdown support audit, 2026-09-06

## Syntax and upstream contract

[Official GitHub documentation](https://docs.github.com/en/get-started/writing-on-github/getting-started-with-writing-and-formatting-on-github/basic-writing-and-formatting-syntax#custom-anchors) (checked 2026-09-06).

````markdown
<a name="custom"></a>

[Jump](#custom)
````

## Evidence and existing-task ownership

Lute retains this anchor in HTML but visual modes encode its tags as source nodes. media-src/src/links/same-doc-anchor.ts resolves fragments exclusively against parseHeadingsFromMarkdown and consumes unmatched fragments. A non-heading named anchor cannot resolve through that path.

Task 243 owns heading slugs and heading {#id} syntax. Its current implementation does not own non-heading HTML named anchors; Task 263 concerns Obsidian block references.

Evidence is limited to source inspection and a small pinned-Lute probe where stated.
No browser or real-VS-Code reproduction ran in the audit session. Confirm the user-visible
baseline before implementation; engine output alone is not a packaged-editor result.
See [the audit](../docs/github-markdown-support-audit-2026-09-06.md).

## Scope

Resolve named HTML anchors in same-document and cross-file fragment navigation across the editor modes and Preview. Keep them out of the heading outline. Preserve source bytes, percent decoding, and existing heading navigation; specify duplicate-name and heading-name collision behavior. Ignore anchor-looking text inside code.

This task owns only the syntax named in its title. Shared helpers may support sibling tasks,
but must not silently expand this task into a general GitHub-compatibility rewrite.

## Toolbar control requirements

**Decision: add Insert anchor under More; reuse Link for links pointing to anchors.**

- [ ] Add **Insert anchor** with a small name input. Insert `<a name="…"></a>` at the preserved
      caret position after validating/escaping the name and rejecting a conflicting existing name.
      Keep surrounding selected prose intact; this action inserts a target, not a wrapper or link.
- [ ] Offer contextual name inspection when positioned on an existing anchor. Do not silently
      rename a target or rewrite incoming links; any future rename/refactor needs its own contract.
- [ ] Existing Link insertion can target `#name`; anchor autocomplete remains Task 32. Do not add
      another Link button or put non-heading anchors into the heading outline.
- [ ] Verify dialog Apply/Cancel, name validation, caret retention, one-step undo, and navigation
      to an anchor inserted through the actual toolbar in the focused real-VS-Code journey.

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
