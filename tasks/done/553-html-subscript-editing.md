# Task 553 — HTML subscript in visual editing

**Status:** ✅ DONE (2026-09-07) · **Origin:** GitHub Markdown support audit, 2026-09-06

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
See [the audit](../../docs/github-markdown-support-audit-2026-09-06.md).

## Scope

Present the subscript semantically in inactive IR/WYSIWYG reading state; reveal and edit the original HTML predictably. Preserve exact tag bytes and nested inline content. Do not translate HTML to the optional tilde extension.

This task owns only the syntax named in its title. Shared helpers may support sibling tasks,
but must not silently expand this task into a general GitHub-compatibility rewrite.

## Toolbar control requirements

**Decision after Task 563: add one Subscript action after Strike in Row 1's formatting group.**
It moves with that group into More when space requires; it is not one of the pinned
Emoji/Undo/Redo controls. This supersedes the earlier More-only placement.

- [x] Add **Subscript** as a toggle that wraps a supported inline selection in `<sub>…</sub>`;
      toggling an exact existing SUB wrapper removes only that wrapper. With an empty selection,
      insert the pair and place the caret between its tags.
- [x] Emit HTML regardless of the optional `markdownSupSub` setting. Preserve nested formatting;
      do not treat tilde-based subscript as permission to rewrite its syntax automatically.
- [x] Derive active/mixed/disabled state from the selection. Disable unsupported cross-block,
      code, math or partially overlapping tag selections instead of producing malformed HTML.
- [x] Verify inserted/removed bytes, state, caret and one-step undo in source and visual modes.

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

Implemented reversible owned SUB presentation and one Row 1 Subscript control, with
active/mixed/disabled state, exact source splices, empty-pair caret placement, directional
selection, normal writeback and one-step undo. The shared Escape→Tab origin preserves the
selection made before structural Escape handling. Background undo snapshots preserve toolbar
focus. Table edits retain original row padding and CRLF through the prerequisite `6350237`.

Validation completed:

- `npm run lint:ci` — 921 files passed. Webview, strict and VS Code spec type checks passed.
- `npm run knip`, `npm run jscpd`, module manifest and boundary checks — passed.
- `npm run test:coverage` — 267 files / 3,847 tests passed; coverage-module ratchet passed.
  Focused command tests passed 33/33; table writeback tests passed 34/34.
- Focused Chromium coverage — 7/7 passed across IR, WYSIWYG and SV. Visual-mode placeholders
  are excluded from quick state; literal SV U+200B source and offsets remain intact.
- Focused real VS Code XTEST — 2/2 passed, covering actual OS keyboard selection/activation,
  narrow More, Escape return, exact source, table wrap, Undo/Redo, CRLF save and reopen.
- Routine real VS Code fast tier — 59/59 passed. The final SV-only state correction reused
  that result and refreshed its affected unit/Chromium coverage rather than repeating the tier.
- Final build — 655,938-byte / 640.56 KiB `main.js`, +27,603 bytes / +26.96 KiB versus Task 563;
  301 eager modules, +5. Existing ceilings remain unchanged and reporting-only.

Dependency-cruiser exited zero but inspected no modules because its TypeScript support excludes
TypeScript 7; this is a tooling limitation, not dependency-graph verification. Dependency/vendor
audits and the aggregate quality wrapper were intentionally omitted under the Project Owner's
queue-wide waiver. The individual network-free gates above passed.

OS keyboard setup and the reusable helper are documented in the
[Project Owner runbook](../../docs/os-keyboard-testing-setup.md). All work is local; no push.
