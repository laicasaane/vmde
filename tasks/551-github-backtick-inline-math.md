# Task 551 — GitHub backtick-delimited inline math

**Status:** 🚧 IN PROGRESS — reasoning ready; implementation pending · **Origin:** GitHub Markdown support audit, 2026-09-06

## Syntax and upstream contract

[Official GitHub documentation](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/writing-mathematical-expressions) (checked 2026-09-06).

````markdown
$`x^2`$
````

## Evidence and existing-task ownership

The pinned Lute emits language-math content containing the literal backticks: `\`x^2\``. Vditor mathRenderAdapter.getCode returns textContent unchanged, so those delimiter bytes reach KaTeX. Ordinary dollar math already works.

Tasks 57 (KaTeX error handling), 246 (equation numbering), and 248 (completion) do not own delimiter compatibility.

Evidence is limited to source inspection and a small pinned-Lute probe where stated.
No browser or real-VS-Code reproduction ran in the audit session. Confirm the user-visible
baseline before implementation; engine output alone is not a packaged-editor result.
See [the audit](../docs/github-markdown-support-audit-2026-09-06.md).

## Scope

Recognize the paired dollar/backtick delimiters as syntax; render only the expression. Preserve the original delimiter bytes during editing and saving. Cover Markdown punctuation inside the expression, escaped dollars, incomplete delimiters, adjacent code spans, and ordinary dollar math.

This task owns only the syntax named in its title. Shared helpers may support sibling tasks,
but must not silently expand this task into a general GitHub-compatibility rewrite.

## Toolbar control requirements

**Decision: add an Inline math (GitHub) action in a shared Math toolbar menu.**

- [ ] Introduce a Math entry in the existing More menu, with an **Inline math (GitHub)** action
      that wraps selected expression text in the dollar/backtick delimiters shown above. With no
      selection, insert the delimiter pair and place the caret inside it.
- [ ] Task 551 owns the shared Math menu entry. Task 552 contributes its own **Math block** action
      to that same menu; if implemented first, it may establish the shared entry. Do not create
      competing math buttons or force either syntax task to implement the other.
- [ ] Preserve existing ordinary dollar math during unrelated actions. Reject unsafe selections
      such as multiline ranges or conflicting delimiters with a clear explanation and no edit.
- [ ] Verify exact inserted bytes, caret placement, selection preservation, and one-step undo.

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
