# Task 554 — HTML superscript in visual editing

**Status:** 📋 TODO · **Origin:** GitHub Markdown support audit, 2026-09-06

## Syntax and upstream contract

[Official GitHub documentation](https://docs.github.com/en/get-started/writing-on-github/getting-started-with-writing-and-formatting-on-github/basic-writing-and-formatting-syntax#styling-text) (checked 2026-09-06).

````markdown
x<sup>2</sup>
````

## Evidence and existing-task ownership

Sanitized Md2HTML preserves SUP, while both visual DOM emitters produce escaped html-inline tag nodes rather than a semantic SUP wrapper. No VMDE inline-HTML decorator was found.

Task 225 owns caret syntax; footnote support is already present. Neither owns authored HTML superscript presentation.

Evidence is limited to source inspection and a small pinned-Lute probe where stated.
No browser or real-VS-Code reproduction ran in the audit session. Confirm the user-visible
baseline before implementation; engine output alone is not a packaged-editor result.
See [the audit](../docs/github-markdown-support-audit-2026-09-06.md).

## Scope

Render authored HTML superscript in inactive IR/WYSIWYG state and keep its source editable. Preserve exact tag bytes and nested inline content. Keep authored SUP distinct from generated footnote references and optional caret syntax.

This task owns only the syntax named in its title. Shared helpers may support sibling tasks,
but must not silently expand this task into a general GitHub-compatibility rewrite.

## Toolbar control requirements

**Decision: add a Superscript formatting action under More, adjacent to Subscript.**

- [ ] Add **Superscript** to wrap a supported inline selection in `<sup>…</sup>` or remove an exact
      existing authored SUP wrapper. With an empty selection, insert the pair with the caret inside.
- [ ] Emit HTML independently of `markdownSupSub`. Do not toggle generated footnote SUP elements
      or rewrite caret-based syntax. Preserve nested formatting.
- [ ] Share selection/toggle plumbing with Task 553 when available, while keeping the syntax
      acceptance criteria independent. Define active/mixed/disabled states and reject cross-block,
      code, math or partially overlapping tag selections without changing the document.
- [ ] Verify source and visual modes, footnote isolation, saved bytes, caret and one-step undo.

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
