# Task 558 — GitHub mention syntax

**Status:** 📋 TODO · **Origin:** GitHub Markdown support audit, 2026-09-06

## Syntax and upstream contract

[Official GitHub documentation](https://docs.github.com/en/get-started/writing-on-github/getting-started-with-writing-and-formatting-on-github/basic-writing-and-formatting-syntax#mentioning-people-and-teams) (checked 2026-09-06).

````markdown
@octocat @example/team
````

## Evidence and existing-task ownership

Pinned Lute leaves both forms as text. No GitHub mention tokenizer or decorator was found in the host/webview link implementation. Task 211 is local wiki unlinked mentions, not GitHub mentions.

No existing owner. This is GitHub platform enrichment, not a failure of the published GFM grammar.

Evidence is limited to source inspection and a small pinned-Lute probe where stated.
No browser or real-VS-Code reproduction ran in the audit session. Confirm the user-visible
baseline before implementation; engine output alone is not a packaged-editor result.
See [the audit](../docs/github-markdown-support-audit-2026-09-06.md).

## Scope

Add an explicit GitHub-authoring option for person/team mention links. Define GitHub host/context before resolving destinations; use the existing host link policy. Preserve source text, avoid email/code/URL false positives, and do not send notifications or fetch account data. Keep ordinary Markdown-file behavior unchanged by default.

This task owns only the syntax named in its title. Shared helpers may support sibling tasks,
but must not silently expand this task into a general GitHub-compatibility rewrite.

## Coordination with Task 228

This is a deferred companion to [Task 228](228-issue-tracker-links.md). Implement the
228 repository/host context and link-decoration contract first, then reuse it here.
Do not introduce a second remote parser, navigation route or competing decorator.
Task 228 continues to own configurable issue/ticket patterns; this task owns its named syntax.

Recognize person/team mentions using the shared host context; keep mentions distinct from issue patterns, commit qualifiers and email addresses.

- [ ] Agree the shared context contract with 228: explicit opt-in, configured host/repository,
      optional authorized origin derivation, and unresolved/offline fallback. No automatic fetches.
- [ ] Define recognizer precedence and shared exclusions for code, escaped text and existing
      links; never nest links or decorate the same source range twice.
- [ ] Reuse source-preserving presentation and the existing host activation policy; turning
      enrichment off restores the original text or ordinary link without changing Markdown.
- [ ] Add mixed-reference integration fixtures with 228 and the other companion tasks,
      proving deterministic recognition, exactly one navigation event, and byte-stable
      edit/save/reopen plus undo/redo. Keep separate task acceptance and focused commits.

## Toolbar control requirements

**Decision: no additional toolbar control.** Type or paste a mention; recognition supplies the
link presentation. Enable/configure the optional GitHub-authoring context through settings.
A people picker, autocomplete or account lookup is not required by this task.

- [ ] Verify plain typing/paste and the existing link activation policy work without a toolbar
      action, and disabling GitHub authoring restores ordinary text behavior.

## Implementation and verification

- [ ] Confirm the focused baseline in the current editor and define the smallest correction.
- [ ] Implement the syntax contract without losing source bytes or weakening sanitization/CSP.
- [ ] Unit coverage for valid, malformed, escaped, and literal-code cases and source fidelity.
- [ ] Focused Chromium coverage for affected Preview/IR/WYSIWYG behavior and source-mode fidelity.
- [ ] Build first, then a focused real-VS-Code spec under xvfb covering actual interaction,
      saved/reopened Markdown, and undo/redo; verify host navigation where applicable.
- [ ] Run applicable focused gates and final quality validation per DEVELOPMENT.md before closure.

Audit-session validation is deliberately minimal; all implementation checkboxes remain open.
