# Task 552 — GitHub fenced math display semantics

**Status:** ✅ DONE — 2026-09-07 · **Origin:** GitHub Markdown support audit, 2026-09-06

## Syntax and upstream contract

[Official GitHub documentation](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/writing-mathematical-expressions) (checked 2026-09-06).

````markdown
```math
\sum_{i=1}^{n} i
```
````

## Evidence and existing-task ownership

Lute emits a CODE.language-math element inside PRE for this fence. Vditor mathRender selects it, but chooses displayMode only when tagName is DIV. Thus fenced math is recognized but receives inline KaTeX layout; dollar-dollar blocks emit DIV and use display layout.

Task 57 does not change display-mode detection; Tasks 246 and 248 are separate authoring features.

Evidence is limited to source inspection and a small pinned-Lute probe where stated.
No browser or real-VS-Code reproduction ran in the audit session. Confirm the user-visible
baseline before implementation; engine output alone is not a packaged-editor result.
See [the audit](../docs/github-markdown-support-audit-2026-09-06.md).

## Scope

Render math fences in display mode in Preview, IR, and WYSIWYG without converting fences to dollar delimiters. Retain editable source nodes, fence length, info string, body, and indentation. Cover large operators, multiline bodies, nested list/quote fences, and literal non-math code fences.

This task owns only the syntax named in its title. Shared helpers may support sibling tasks,
but must not silently expand this task into a general GitHub-compatibility rewrite.

## Toolbar control requirements

**Decision: add a Math block action to the shared Math toolbar menu (Task 551).**

- [x] Under More → Math, add **Math block** to insert a fenced block with the `math` info string.
      Wrap selected expression lines, or insert an empty body and place the caret inside it.
- [x] Reuse the existing code-block insertion/indentation machinery where appropriate, including
      list/quote placement and collision-safe fence length. This action must emit a math fence,
      not silently change the syntax to dollar-dollar delimiters.
- [x] Share the menu entry with Task 551; either task can establish it first. The existing general
      Code control and manual language editing remain available.
- [x] Verify insertion into empty/nonempty documents and containers, selected-body fidelity,
      caret placement and one-step undo alongside display-mode rendering.

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

Audit-session validation is deliberately minimal; all implementation checkboxes remain open.

## Completion and verification

The source-import patch now classifies `PRE > CODE.language-math` as display math for both
KaTeX and MathJax while leaving inline nodes unchanged. The shared Math menu has a localized
Math block action with collision-safe fences, quote/list continuation prefixes, retained
selection, native undo, sync, and Preview guarding.

Focused evidence: 242 affected unit/source-patch tests passed; focused Chromium display and
insertion/undo/Preview tests passed; build, webview/strict/real-spec type checks and lint passed;
and the dedicated real-VS-Code spec passed (display, menu insertion, CRLF source, undo/save).
The inherited bundle-size ceiling remains exceeded (662.6 KB vs 608 KB) and is reporting-only.
