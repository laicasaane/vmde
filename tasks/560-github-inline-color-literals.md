# Task 560 — GitHub inline color-literal previews

**Status:** 📋 TODO · **Origin:** GitHub Markdown support audit, 2026-09-06

## Syntax and upstream contract

[Official GitHub documentation](https://docs.github.com/en/get-started/writing-on-github/getting-started-with-writing-and-formatting-on-github/basic-writing-and-formatting-syntax#supported-color-models) (checked 2026-09-06).

````markdown
`#0969DA` `rgb(9, 105, 218)` `hsl(212, 92%, 45%)`
````

## Evidence and existing-task ownership

These values currently use the ordinary inline-code path; no color-literal preview decorator was found. GitHub documents this visualization only in issues, pull requests, and discussions.

No existing owner. This is one inline color-literal syntax family with three documented formats, not three renderer-engine tasks.

Evidence is limited to source inspection and a small pinned-Lute probe where stated.
No browser or real-VS-Code reproduction ran in the audit session. Confirm the user-visible
baseline before implementation; engine output alone is not a packaged-editor result.
See [the audit](../docs/github-markdown-support-audit-2026-09-06.md).

## Scope

Offer GitHub conversation authoring with non-serializing color swatches for documented HEX/RGB/HSL literals. Validate literal grammar and ranges, reject padded/malformed values, retain accessible text and editable code spans, and preserve exact bytes. Keep ordinary Markdown-file rendering unchanged by default.

This task owns only the syntax named in its title. Shared helpers may support sibling tasks,
but must not silently expand this task into a general GitHub-compatibility rewrite.

## Toolbar control requirements

**Decision: no additional toolbar control.** The existing Inline code action already authors
the necessary syntax. Swatches appear automatically when the optional context is enabled.
A color picker or color-conversion UI is not required for preview support.

- [ ] Verify wrapping a valid color with the existing Inline code control produces the swatch,
      preserves the literal's chosen HEX/RGB/HSL format, and remains one undoable edit.

## Implementation and verification

- [ ] Confirm the focused baseline in the current editor and define the smallest correction.
- [ ] Implement the syntax contract without losing source bytes or weakening sanitization/CSP.
- [ ] Unit coverage for valid, malformed, escaped, and literal-code cases and source fidelity.
- [ ] Focused Chromium coverage for affected Preview/IR/WYSIWYG behavior and source-mode fidelity.
- [ ] Build first, then a focused real-VS-Code spec under xvfb covering actual interaction,
      saved/reopened Markdown, and undo/redo; verify host navigation where applicable.
- [ ] Run applicable focused gates and final quality validation per DEVELOPMENT.md before closure.

Audit-session validation is deliberately minimal; all implementation checkboxes remain open.
