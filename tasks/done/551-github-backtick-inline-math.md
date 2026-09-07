# Task 551 — GitHub backtick-delimited inline math

**Status:** ✅ DONE — 2026-09-07; final verification boundary accepted by Project Owner · **Origin:** GitHub Markdown support audit, 2026-09-06

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
See [the audit](../../docs/github-markdown-support-audit-2026-09-06.md).

## Scope

Recognize the paired dollar/backtick delimiters as syntax; render only the expression. Preserve the original delimiter bytes during editing and saving. Cover Markdown punctuation inside the expression, escaped dollars, incomplete delimiters, adjacent code spans, and ordinary dollar math.

This task owns only the syntax named in its title. Shared helpers may support sibling tasks,
but must not silently expand this task into a general GitHub-compatibility rewrite.

## Toolbar control requirements

**Decision after Task 563: add Inline math (GitHub) inside one Math toolbar menu in Row 2’s Code group.**
The Math menu follows Code/Inline code and moves as one instance into More when space requires.
This supersedes the earlier More-only placement.

- [x] Introduce the shared Math entry described above, with an **Inline math (GitHub)** action
      that wraps selected expression text in the dollar/backtick delimiters shown above. With no
      selection, insert the delimiter pair and place the caret inside it.
- [x] Task 551 owns the shared Math menu entry. Task 552 contributes its own **Math block** action
      to that same menu; if implemented first, it may establish the shared entry. Do not create
      competing math buttons or force either syntax task to implement the other.
- [x] Preserve existing ordinary dollar math during unrelated actions. Reject unsafe selections
      such as multiline ranges or conflicting delimiters with a clear explanation and no edit.
- [x] Verify exact inserted bytes, caret placement, selection preservation, and one-step undo.

For added or extended controls: use the existing toolbar overflow, localization, tooltip and
keyboard-accessibility conventions (Tasks 492/505). Preserve selection when focus enters a menu,
support keyboard activation and Escape/focus return, and disable mutations in read-only Preview.
Use the row/group placement above and ordinary overflow; do not create duplicate menus or new pinned controls.
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

GitHub inline math now sends only the expression to KaTeX while retaining raw delimiter source.
One Math menu follows Inline code in Row 2 and moves into More with its Code group. Its action
supports selected and empty insertion in IR/WYSIWYG/SV, preserves source bytes and direction,
uses normal edit-sync, and rejects unsafe contexts and Preview mutation. Rollback restores source,
original selection, scroll and the same mode's undo savepoint.

Final available evidence:

- Build, lint, webview/strict/real-spec type checks and 228 affected unit tests passed.
- Focused Chromium coverage: 11/11 passed, including all modes, zero-width-character fidelity,
  literal-code/Preview rejection and forced post-checkpoint rollback. The failure regression checks
  source, backward selection, scroll, undo/redo contents and marker cleanup.
- Real VS Code 1.129.0 OS XTEST: all three modes passed before the final rollback amendment.
  The current Openbox rerun passed IR and WYSIWYG; SV exposed a test ordering race. The spec now
  waits for delimiter mutation before typing, but that test-only correction was not rerun after
  the Project Owner instructed wrapping up noncritical verification. A fully green current
  three-mode rerun is not claimed.
- Earlier full coverage passed 269 files / 3,867 tests and the 13-module ratchet. Knip, duplication
  and manifest/boundary checks passed (46 structural tests). These broad results predate the final
  mode/rollback changes; affected unit/type/lint/Chromium checks above cover the final changes.
- Final main.js: 668,946 bytes / 653.27 KiB, +10,529 bytes / +10.28 KiB versus Task 555;
  303 eager modules, +2. Existing size/startup ceilings remain unchanged and reporting-only.

Test corrections covered narrow-viewport state and reselection after the intentional Escape
start-caret return. Real assertions require a non-collapsed backward selection and explicit full
CRLF save/reopen bytes. An early protocol-keyboard run is excluded from OS acceptance. Missing
window-manager launches and sandbox child-process/browser failures are recorded as runner limits.
Production harness parity, marker coordinates, mode bookmarks and rollback received focused fixes.

Dependency-cruiser exited zero but inspected no modules because its transpiler excludes TypeScript
7; it does not establish dependency-graph coverage. Audits, the aggregate quality wrapper and broad
browser/real-VS-Code suites were intentionally omitted. The Project Owner approved wrapping up
noncritical verification and stopping after this task's local commit. No later task implementation
was started. No push.
