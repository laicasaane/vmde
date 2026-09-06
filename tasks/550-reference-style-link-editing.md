# Task 550 — Render and activate reference-style links cleanly in visual edit modes

**Status:** 📋 TODO · **Impact:** 🟠 common technical-document authoring gap ·
**Origin:** user report, 2026-09-06 · **Related:** Tasks 32, 62, 240, 297, and 542

## Reported case

```markdown
- `IsExternalInit.cs`: Enable [`init`][init] of C# 9

[init]: https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/keywords/init
```

In the visual editor, the inline reference label remains visible as a second raw `[init]` after the
rendered `` `init` ``, and the destination definition occupies its own visible source-like row. The
result reads as duplicated prose instead of the single linked code label produced by Markdown
Preview.

No existing task owns this presentation and interaction gap. Task 240 preserves definition titles
and prevents serialization corruption; it deliberately excludes reference-link authoring. Task 542
activates references only in the split-source pane. Task 297 covers ordinary IR-link editing and
currently excludes reference nodes.

## Confirmed engine contract

The pinned Lute already parses and serializes the reported bytes without loss:

- IR emits a `span[data-type="link-ref"]` containing the visible label plus a
  `.vditor-ir__marker--link` `[init]`, and a separate
  `div[data-type="link-ref-defs-block"]` containing the definition.
- WYSIWYG emits a `span[data-type="link-ref"][data-link-label="init"]` plus the same definition
  block.
- `Md2HTML` resolves the construct to one `<a href="…"><code>init</code></a>`.

This is therefore a visual-edit-mode presentation/activation problem, not a request to change C#
syntax or Markdown parsing. Preserve Lute's nodes and exact source bytes rather than replacing the
reference with an inline link.

## Implementation contract

- In IR and WYSIWYG, present `[text][label]`, `[label][]`, and shortcut `[label]` references as one
  ordinary linked label while the reference is inactive. Do not show a duplicate label suffix in
  reading state.
- Resolve labels case-insensitively against the live document's link-reference definitions, matching
  Markdown semantics. Support inline formatting in the visible label, including the reported code
  span.
- Apply the existing `vmde.editor.linkOpenWithModifier` policy and secure host `open-link` route.
  A reference activation must post exactly once; missing or malformed definitions must fail closed.
- Keep reference syntax editable. When the caret enters a reference or its definition, expose enough
  source UI to change the label or destination without converting it to `[text](url)`. Define and
  test the reveal/dismiss interaction before implementation; coordinate it with Task 297 rather than
  creating a competing link popover.
- Keep definitions available to editing and serialization while preventing inactive definition rows
  from reading as document prose. Any collapse/reveal treatment must preserve caret, selection,
  find/reveal, accessibility, scroll position, mode rebuilds, undo/redo, and all definition order,
  case, destination, and title bytes covered by Task 240.
- Leave split-source mode source-like. Retain Task 542's existing reference activation and exact
  Markdown behavior there.

## Required verification

- [ ] RED/GREEN unit coverage against the real vendored Lute DOM for full, collapsed, and shortcut
      references; code-formatted labels; case-insensitive resolution; titles and escaped or
      parenthesized destinations; duplicate, missing, and malformed definitions.
- [ ] Chromium coverage in IR and WYSIWYG for inactive presentation, caret-driven syntax/definition
      reveal and dismissal, editing, modifier-policy activation, exactly one host post, keyboard and
      screen-reader access, and no layout jump when definitions hide or reveal.
- [ ] One focused no-retry real-VS-Code journey opens the reported C# fixture, confirms one linked
      `init` label with no source-like definition row in reading state, edits the destination, follows
      it through the host route, saves/reopens, and proves exact expected Markdown plus one-step
      undo/redo.
- [ ] Regression coverage retains Task 240's title/order/case fidelity and Task 542's split-source
      activation. Run build, applicable typechecks, focused changed-line coverage, budgets, lint, and
      one final quality gate before closure.

## Out of scope

- Reference-label or path autocomplete (Task 32), hover previews (Task 210), or redesigning all link
  editing independently of Task 297.
- Changing Preview output, inlining destinations, rewriting reference definitions, or hiding
  unresolved syntax as if it were a valid link.
