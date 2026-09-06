# Task 559 — GitHub commit-reference syntax

**Status:** 📋 TODO · **Origin:** GitHub Markdown support audit, 2026-09-06

## Syntax and upstream contract

[Official GitHub documentation](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/autolinked-references-and-urls#commit-shas) (checked 2026-09-06).

````markdown
0123456789abcdef0123456789abcdef01234567
example/repo@0123456789abcdef0123456789abcdef01234567
````

## Evidence and existing-task ownership

The link implementation has URL/wiki/code-reference routes but no GitHub commit-SHA resolver. Lute URL autolinking cannot resolve a bare SHA against repository context.

Task 228 owns issue/ticket patterns, not commit-SHA semantics. Reuse its future context infrastructure without combining the syntax tasks.

Evidence is limited to source inspection and a small pinned-Lute probe where stated.
No browser or real-VS-Code reproduction ran in the audit session. Confirm the user-visible
baseline before implementation; engine output alone is not a packaged-editor result.
See [the audit](../docs/github-markdown-support-audit-2026-09-06.md).

## Scope

In an explicit GitHub-authoring context, recognize documented SHA and qualified SHA reference forms and route links through the existing policy. Define repository/host resolution and abbreviation ambiguity handling; leave unresolved values as text. Preserve bytes and guard ordinary hashes, code, URLs, and email addresses.

This task owns only the syntax named in its title. Shared helpers may support sibling tasks,
but must not silently expand this task into a general GitHub-compatibility rewrite.

## Toolbar control requirements

**Decision: no additional toolbar control.** Type or paste the commit reference; the resolver
uses configured repository context. A commit picker/history browser would add separate Git
workflow scope and is not required.

- [ ] Verify recognition and activation from typed/pasted references, ordinary-text fallback,
      and source fidelity without introducing a toolbar dependency.

## Implementation and verification

- [ ] Confirm the focused baseline in the current editor and define the smallest correction.
- [ ] Implement the syntax contract without losing source bytes or weakening sanitization/CSP.
- [ ] Unit coverage for valid, malformed, escaped, and literal-code cases and source fidelity.
- [ ] Focused Chromium coverage for affected Preview/IR/WYSIWYG behavior and source-mode fidelity.
- [ ] Build first, then a focused real-VS-Code spec under xvfb covering actual interaction,
      saved/reopened Markdown, and undo/redo; verify host navigation where applicable.
- [ ] Run applicable focused gates and final quality validation per DEVELOPMENT.md before closure.

Audit-session validation is deliberately minimal; all implementation checkboxes remain open.
