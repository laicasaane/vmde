# Task 553 — HTML subscript in visual editing

**Status:** 🚧 IN PROGRESS — reasoning ready; baseline probes underway · **Origin:** GitHub Markdown support audit, 2026-09-06

## Syntax and upstream contract

[Official GitHub documentation](https://docs.github.com/en/get-started/writing-on-github/getting-started-with-writing-and-formatting-on-github/basic-writing-and-formatting-syntax#styling-text) (checked 2026-09-06).

````markdown
H<sub>2</sub>O
````

## Evidence and existing-task ownership

With sanitization enabled, Md2HTML preserves SUB. Md2VditorIRDOM and Md2VditorDOM instead emit escaped opening and closing tags in html-inline code nodes, with the content outside a semantic SUB element. No VMDE inline-HTML decorator was found.

Task 225 implements optional tilde/caret syntax, not HTML edit-mode presentation. Task 47 owns HTML images, not text formatting.

Evidence is limited to source inspection and a small pinned-Lute probe where stated.
No browser or real-VS-Code reproduction ran in the audit session. Confirm the user-visible
baseline before implementation; engine output alone is not a packaged-editor result.
See [the audit](../docs/github-markdown-support-audit-2026-09-06.md).

## Scope

Present the subscript semantically in inactive IR/WYSIWYG reading state; reveal and edit the original HTML predictably. Preserve exact tag bytes and nested inline content. Do not translate HTML to the optional tilde extension.

This task owns only the syntax named in its title. Shared helpers may support sibling tasks,
but must not silently expand this task into a general GitHub-compatibility rewrite.

## Toolbar control requirements

**Decision: add a Subscript formatting action under More.**

- [ ] Add **Subscript** as a toggle that wraps a supported inline selection in `<sub>…</sub>`;
      toggling an exact existing SUB wrapper removes only that wrapper. With an empty selection,
      insert the pair and place the caret between its tags.
- [ ] Emit HTML regardless of the optional `markdownSupSub` setting. Preserve nested formatting;
      do not treat tilde-based subscript as permission to rewrite its syntax automatically.
- [ ] Derive active/mixed/disabled state from the selection. Disable unsupported cross-block,
      code, math or partially overlapping tag selections instead of producing malformed HTML.
- [ ] Verify inserted/removed bytes, state, caret and one-step undo in source and visual modes.

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
