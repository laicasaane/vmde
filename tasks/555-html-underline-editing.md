# Task 555 — HTML underline in visual editing

**Status:** 📋 TODO · **Origin:** GitHub Markdown support audit, 2026-09-06

## Syntax and upstream contract

[Official GitHub documentation](https://docs.github.com/en/get-started/writing-on-github/getting-started-with-writing-and-formatting-on-github/basic-writing-and-formatting-syntax#styling-text) (checked 2026-09-06).

````markdown
<ins>added text</ins>
````

## Evidence and existing-task ownership

Sanitized Md2HTML preserves INS, while IR and WYSIWYG emit its tags as escaped html-inline code nodes. No VMDE inline-HTML decorator was found.

Task 249 is CriticMarkup and Task 237 is review annotations; neither owns the authored INS syntax.

Evidence is limited to source inspection and a small pinned-Lute probe where stated.
No browser or real-VS-Code reproduction ran in the audit session. Confirm the user-visible
baseline before implementation; engine output alone is not a packaged-editor result.
See [the audit](../docs/github-markdown-support-audit-2026-09-06.md).

## Scope

Render authored INS text with underline semantics in inactive visual editing state, retaining source reveal/editing and exact HTML serialization. Cover nested emphasis, multiple spans, and malformed/unclosed tags without swallowing adjacent prose.

This task owns only the syntax named in its title. Shared helpers may support sibling tasks,
but must not silently expand this task into a general GitHub-compatibility rewrite.

## Toolbar control requirements

**Decision: add an Underline formatting action under More.**

- [ ] Add **Underline** to wrap a supported inline selection in `<ins>…</ins>` or remove an exact
      existing INS wrapper. With an empty selection, insert the pair with the caret inside.
- [ ] Preserve nested formatting and keep this action distinct from CriticMarkup/review changes.
      Use the same active/mixed/disabled selection rules as the sibling SUB/SUP actions; reject
      cross-block, code, math or overlapping tag ranges without editing.
- [ ] Verify exact HTML output, toggle state, selection/caret retention and one-step undo across
      source and visual modes. No default keyboard shortcut is required.

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
