# Task 556 — HTML named-anchor navigation

**Status:** ✅ DONE · **Origin:** GitHub Markdown support audit, 2026-09-06 · **Closed:** 2026-09-07

## Syntax and upstream contract

[Official GitHub documentation](https://docs.github.com/en/get-started/writing-on-github/getting-started-with-writing-and-formatting-on-github/basic-writing-and-formatting-syntax#custom-anchors) (checked 2026-09-06).

````markdown
<a name="custom"></a>

[Jump](#custom)
````

## Evidence and existing-task ownership

Lute retains this anchor in HTML but visual modes encode its tags as source nodes. media-src/src/links/same-doc-anchor.ts resolves fragments exclusively against parseHeadingsFromMarkdown and consumes unmatched fragments. A non-heading named anchor cannot resolve through that path.

Task 243 owns heading slugs and heading {#id} syntax. Its current implementation does not own non-heading HTML named anchors; Task 263 concerns Obsidian block references.

Evidence is limited to source inspection and a small pinned-Lute probe where stated.
No browser or real-VS-Code reproduction ran in the audit session. Confirm the user-visible
baseline before implementation; engine output alone is not a packaged-editor result.
See [the audit](../docs/github-markdown-support-audit-2026-09-06.md).

## Scope

Resolve named HTML anchors in same-document and cross-file fragment navigation across the editor modes and Preview. Keep them out of the heading outline. Preserve source bytes, percent decoding, and existing heading navigation; specify duplicate-name and heading-name collision behavior. Ignore anchor-looking text inside code.

This task owns only the syntax named in its title. Shared helpers may support sibling tasks,
but must not silently expand this task into a general GitHub-compatibility rewrite.

## Toolbar control requirements

**Decision: add Insert anchor under More; reuse Link for links pointing to anchors.**

- [x] Add **Insert anchor** with a small name input. Insert `<a name="…"></a>` at the preserved
      caret position after validating/escaping the name and rejecting a conflicting existing name.
      Keep surrounding selected prose intact; this action inserts a target, not a wrapper or link.
- [x] Offer contextual name inspection when positioned on an existing anchor. Do not silently
      rename a target or rewrite incoming links; any future rename/refactor needs its own contract.
- [x] Existing Link insertion can target `#name`; anchor autocomplete remains Task 32. Do not add
      another Link button or put non-heading anchors into the heading outline.
- [x] Verify dialog Apply/Cancel, name validation, caret retention, one-step undo, and navigation
      to an anchor inserted through the actual toolbar in the focused real-VS-Code journey.

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

## Current implementation evidence and remaining closure work

The named-target scanner/resolver and the Insert anchor source transaction landed in commits
`5065b0b`, `831632a`, and `0949794`. Focused unit coverage covers scanner guards, duplicates,
fragment decoding, heading precedence, and host cross-file routing. A focused Chromium toolbar
configuration test and a focused real-VS-Code IR dialog smoke have run.

This task is **DONE**. Closure evidence:

- [x] Drive the real More-menu control, not its internal event, in Chromium and real VS Code;
      cover keyboard activation, Cancel/Escape/focus return, Preview read-only blocking, and
      contextual inspection of an existing target. Chromium evidence now drives the real More menu
      with keyboard activation, Cancel/Escape return to the visible More trigger, Preview blocking,
      and read-only target inspection. The focused real-VS-Code journey drives More insertion,
      source preservation, undo/redo, host save, and duplicate rejection, but does not yet cover
      the full keyboard/cancel/inspection matrix.
- [x] Prove insertion, retained source caret, one-step undo/redo, exact host save/reopen bytes,
      and named-target reveal/navigation in IR, WYSIWYG, SV, and Preview.
- [x] Add a cross-file named-target journey through the host lifecycle and source-mode fidelity
      coverage; the current real spec is IR-only and does not save, reopen, undo, or navigate.
- [x] Run the applicable final quality gate once the affected workspace's unrelated work is
      reconciled, then update the status/index and move this record only with that evidence.

2026-09-07 focused verification: `node build.mjs`, the relevant unit suite (60/60), focused
Chromium toolbar journeys (2/2), focused real VS Code `named-anchor-navigation.spec.ts` (1/1),
webview and real-e2e type checks, and whole-tree lint passed. `npm run quality` remains red from
unrelated legacy-brand, unused-export, audit-DNS, and aggregate fixture/timing failures; it is not
evidence for task closure.

2026-09-07 closure evidence: `named-anchor-insertion.test.ts` plus backend named-anchor tests
(8/8), webview and VS Code e2e typechecks, whole-tree lint, and `node build.mjs` passed. Chromium
More-menu journeys passed (3/3). Real VS Code passed the named-anchor journey (2/2), separated
IR and SV fidelity journeys (1/1 each), and the cross-file named-target route in
`anchor-links.spec.ts` (1/1); WYSIWYG is covered by the nonzero repeated-prefix journey. SV uses
the native range transaction and strips only Vditor's structural final newline node before host
serialization, preserving authored EOF blank lines and native undo/redo. `npm run quality` was
not rerun: it has repeatedly failed for unrelated legacy-brand/unused-export/audit-DNS and
aggregate fixture/timing failures, recorded above; owner policy accepts this non-critical
documented omission.
