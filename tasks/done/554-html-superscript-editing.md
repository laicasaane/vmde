# Task 554 — HTML superscript in visual editing

**Status:** ✅ DONE — 2026-09-07 · **Origin:** GitHub Markdown support audit, 2026-09-06

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
See [the audit](../../docs/github-markdown-support-audit-2026-09-06.md).

## Scope

Render authored HTML superscript in inactive IR/WYSIWYG state and keep its source editable. Preserve exact tag bytes and nested inline content. Keep authored SUP distinct from generated footnote references and optional caret syntax.

This task owns only the syntax named in its title. Shared helpers may support sibling tasks,
but must not silently expand this task into a general GitHub-compatibility rewrite.

## Toolbar control requirements

**Decision after Task 563: add Superscript after Subscript in Row 1’s formatting group.**
It follows that group into More when space requires; it is not an additional pinned control.
This supersedes the earlier More-only placement.

- [x] Add **Superscript** to wrap a supported inline selection in `<sup>…</sup>` or remove an exact
      existing authored SUP wrapper. With an empty selection, insert the pair with the caret inside.
- [x] Emit HTML independently of `markdownSupSub`. Do not toggle generated footnote SUP elements
      or rewrite caret-based syntax. Preserve nested formatting.
- [x] Share selection/toggle plumbing with Task 553 when available, while keeping the syntax
      acceptance criteria independent. Define active/mixed/disabled states and reject cross-block,
      code, math or partially overlapping tag selections without changing the document.
- [x] Verify source and visual modes, footnote isolation, saved bytes, caret and one-step undo.

For added or extended controls: use the existing toolbar overflow, localization, tooltip and
keyboard-accessibility conventions (Tasks 492/505). Preserve selection when focus enters a menu,
support keyboard activation and Escape/focus return, and disable mutations in read-only Preview.
Use the row/group placement above and its ordinary overflow behavior; do not add a duplicate More item or another pinned control.
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

## Completion and verification

Implemented a closed SUB/SUP descriptor over the shared source planner, reversible reader
ownership and guarded transaction. Superscript follows Subscript in Row 1 and ordinary group
overflow. Authored tag case, attributes and nested source remain intact; generated footnote
SUP is excluded by source-marker eligibility. No Lute, sanitization or CSP policy changed.

- Build, webview/strict/real-spec type checks, lint, knip, duplication, module manifest and
  seven module-boundary tests passed.
- Unit coverage: 267 files / 3,853 tests passed; coverage-module ratchet passed at 13 modules.
- Focused Chromium coverage: 13/13 passed, including retained SUB behavior and SUP/footnote
  isolation in IR/WYSIWYG with optional supSub off/on.
- Four focused real-VS-Code 1.129.0 cases passed serially with one worker and zero retries:
  OS XTEST backward selection and Undo/Redo with Preview disabled/non-mutation assertions;
  empty SUP insertion through WYSIWYG exact CRLF save/reopen; generated-footnote isolation;
  and forced More keyboard activation. Test-oracle review found no remaining findings.
- Final main.js: 657,657 bytes / 642.24 KiB, +1,719 bytes / +1.68 KiB versus Task 553;
  301 eager modules, delta 0. Existing 608 KiB / 294-module ceilings are reporting-only and
  unchanged; largest eager module is 29.7 KiB within its 34 KiB ceiling.

Validation required test-only corrections for differing footnote DOM, initial footnote-definition
normalization, revealed-source selectors, keyboard offsets and persisted WYSIWYG reopen readiness.
The CRLF fixture is separate from footnotes so its exact-byte assertions remain independent of
pre-action footnote normalization. One overlapping runner start was refused by the existing lock;
final evidence comes from completed serial invocations. Managed-sandbox unit coverage encountered
child-process EPERM; the permitted outside-sandbox rerun passed fully.

Dependency-cruiser exited zero but inspected no modules because its transpiler does not support
TypeScript 7; this is not substantive dependency evidence. Dependency/vendor audits and the
aggregate quality wrapper were intentionally omitted by Project Owner instruction. FAST and full
Chromium/real-VS-Code suites were omitted under the focused queue policy. All work is local; no push.
