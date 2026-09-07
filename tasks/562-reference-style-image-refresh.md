# Task 562 — Reference-style image asset refresh

**Status:** 🚧 IN PROGRESS — reasoning ready; implementation pending · **Origin:** GitHub Markdown support audit, 2026-09-06

## Syntax and upstream contract

[Official GitHub documentation](https://github.github.com/gfm/#images) (checked 2026-09-06).

````markdown
![Diagram][diagram]

[diagram]: diagram.png "Title"
````

## Evidence and existing-task ownership

Reference images already render in Lute HTML/IR. However, src/session/image-asset-watcher.ts explicitly excludes them: extractLocalImagePaths only scans inline Markdown images and raw IMG. Replacing the referenced local image is therefore not watched. Task 513 records this as an excluded limitation.

Task 550 owns reference hyperlinks, Task 240 owns title serialization, and completed Task 513 explicitly excludes reference images. None owns this remaining image-syntax gap.

Evidence is limited to source inspection and a small pinned-Lute probe where stated.
No browser or real-VS-Code reproduction ran in the audit session. Confirm the user-visible
baseline before implementation; engine output alone is not a packaged-editor result.
See [the audit](../docs/github-markdown-support-audit-2026-09-06.md).

## Scope

Resolve full, collapsed, and shortcut reference images against live definitions for local-image watching and refresh. Share reference semantics where practical; retain label case, definition ordering/titles, and exact source bytes. Cover duplicate/missing definitions, definition retargeting, code guards, encoded paths, and on-disk replacement under an unchanged path.

This task owns only the syntax named in its title. Shared helpers may support sibling tasks,
but must not silently expand this task into a general GitHub-compatibility rewrite.

## Toolbar control requirements

**Decision: no additional toolbar control.** Refresh is automatic after a referenced local asset
changes. Neither a manual Refresh button nor a reference-image insertion/conversion form is needed
to fix the watcher exclusion.

- [ ] Verify a manually authored reference image refreshes after on-disk replacement without a
      toolbar gesture and without changing Markdown or adding an undo entry.

## Implementation and verification

- [ ] Confirm the focused baseline in the current editor and define the smallest correction.
- [ ] Implement the syntax contract without losing source bytes or weakening sanitization/CSP.
- [ ] Unit coverage for valid, malformed, escaped, and literal-code cases and source fidelity.
- [ ] Focused Chromium coverage for affected Preview/IR/WYSIWYG behavior and source-mode fidelity.
- [ ] Build first, then a focused real-VS-Code spec under xvfb covering actual interaction,
      saved/reopened Markdown, and undo/redo; verify host navigation where applicable.
- [ ] Run applicable focused gates and final quality validation per DEVELOPMENT.md before closure.

Audit-session validation is deliberately minimal; all implementation checkboxes remain open.
