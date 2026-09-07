# Task 555 — HTML underline in visual editing

**Status:** ✅ DONE — 2026-09-07 · **Origin:** GitHub Markdown support audit, 2026-09-06

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
See [the audit](../../docs/github-markdown-support-audit-2026-09-06.md).

## Scope

Render authored INS text with underline semantics in inactive visual editing state, retaining source reveal/editing and exact HTML serialization. Cover nested emphasis, multiple spans, and malformed/unclosed tags without swallowing adjacent prose.

This task owns only the syntax named in its title. Shared helpers may support sibling tasks,
but must not silently expand this task into a general GitHub-compatibility rewrite.

## Toolbar control requirements

**Decision after Task 563: add Underline after Superscript in Row 1’s formatting group.**
It follows that group into More when space requires; it is not an additional pinned control.
This supersedes the earlier More-only placement.

- [x] Add **Underline** to wrap a supported inline selection in `<ins>…</ins>` or remove an exact
      existing INS wrapper. With an empty selection, insert the pair with the caret inside.
- [x] Preserve nested formatting and keep this action distinct from CriticMarkup/review changes.
      Use the same active/mixed/disabled selection rules as the sibling SUB/SUP actions; reject
      cross-block, code, math or overlapping tag ranges without editing.
- [x] Verify exact HTML output, toggle state, selection/caret retention and one-step undo across
      source and visual modes. No default keyboard shortcut is required.

For added or extended controls: use the existing toolbar overflow, localization, tooltip and
keyboard-accessibility conventions (Tasks 492/505). Preserve selection when focus enters a menu,
support keyboard activation and Escape/focus return, and disable mutations in read-only Preview.
Use the row/group placement above and its ordinary overflow behavior; do not duplicate the action or add a new pinned control.
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

Extended the closed SUB/SUP descriptor set with INS over the same source planner, token-owned
reader and guarded transaction. Underline follows Superscript in Row 1 and ordinary group
overflow, with independent state and no hotkey. Exact authored tag bytes and nested content are
preserved. Lute, sanitization, CSP and bootstrap policies remain unchanged.

- Test-first focused unit/toolbar coverage: seven files / 93 tests passed.
- Build, webview/strict/real-spec types, lint, knip, duplication, module manifest and seven
  module-boundary tests passed. Full unit coverage and the 13-module coverage ratchet passed.
- Focused Chromium coverage: 18/18 passed, exercising INS presentation, serializer/spin fidelity,
  wrap/unwrap and Preview protection in IR/WYSIWYG, with retained SUB/SUP regressions.
- Real VS Code 1.129.0: three OS XTEST cases passed in one invocation with one worker and zero
  retries. They verify Preview disabled/non-mutation, backward selection and one-step Undo/Redo,
  WYSIWYG empty insertion/typing and exact CRLF save/reopen, and forced More keyboard activation.
- Bounded source and real-spec oracle reviews found no remaining findings.
- Final main.js: 658,417 bytes / 642.99 KiB, +760 bytes / +0.74 KiB versus Task 554;
  301 eager modules, delta 0. Existing size/startup ceilings remain unchanged and reporting-only.

Initial unit assertions needed two INS-specific offset corrections. One Chromium assertion passed
the outer shell instead of the active IR/WYSIWYG element to Lute spin; correcting the test oracle
produced the final pass without a product change. Full unit coverage ran outside the managed
sandbox for release-fixture child processes. Dependency-cruiser exited zero but inspected no
modules because its transpiler excludes TypeScript 7; this is not dependency-graph verification.

Dependency/vendor audits and the aggregate quality wrapper were intentionally omitted by Project
Owner instruction. FAST and full Chromium/real-VS-Code suites were omitted under the focused queue
policy. All work is local; no push.
