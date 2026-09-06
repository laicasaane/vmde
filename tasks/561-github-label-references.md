# Task 561 — GitHub repository-label URL presentation

**Status:** 📋 TODO · **Origin:** GitHub Markdown support audit, 2026-09-06

## Syntax and upstream contract

[Official GitHub documentation](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/autolinked-references-and-urls#labels) (checked 2026-09-06).

````markdown
https://github.com/example/repo/labels/enhancement
````

## Evidence and existing-task ownership

URL autolinking produces an ordinary link; no repository-label chip resolver or metadata path was found. GitHub label presentation depends on the current repository, unlike an ordinary GFM URL.

Task 228 handles issue/ticket patterns, and Task 509 handles pasted URL titles; neither owns repository-label presentation.

Evidence is limited to source inspection and a small pinned-Lute probe where stated.
No browser or real-VS-Code reproduction ran in the audit session. Confirm the user-visible
baseline before implementation; engine output alone is not a packaged-editor result.
See [the audit](../docs/github-markdown-support-audit-2026-09-06.md).

## Scope

In an explicit GitHub-authoring context, support same-repository label URL presentation. Define a local/cached metadata contract and ordinary-link fallback before implementation; do not assume credentials or add automatic network access. Preserve the original URL, reject cross-repository special rendering, and cover the documented period-in-label limitation.

This task owns only the syntax named in its title. Shared helpers may support sibling tasks,
but must not silently expand this task into a general GitHub-compatibility rewrite.

## Toolbar control requirements

**Decision: no additional toolbar control.** Pasting the label URL or using the existing Link
control supplies the reference; rendering may enrich it when repository metadata is available.
A label picker would require additional discovery/metadata UI outside this task.

- [ ] Verify pasted URLs and existing Link-authored references retain normal activation and
      source behavior; apply enrichment only to the documented eligible reference form.

## Implementation and verification

- [ ] Confirm the focused baseline in the current editor and define the smallest correction.
- [ ] Implement the syntax contract without losing source bytes or weakening sanitization/CSP.
- [ ] Unit coverage for valid, malformed, escaped, and literal-code cases and source fidelity.
- [ ] Focused Chromium coverage for affected Preview/IR/WYSIWYG behavior and source-mode fidelity.
- [ ] Build first, then a focused real-VS-Code spec under xvfb covering actual interaction,
      saved/reopened Markdown, and undo/redo; verify host navigation where applicable.
- [ ] Run applicable focused gates and final quality validation per DEVELOPMENT.md before closure.

Audit-session validation is deliberately minimal; all implementation checkboxes remain open.
