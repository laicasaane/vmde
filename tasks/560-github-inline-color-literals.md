# Task 560 — GitHub inline color-literal previews

**Status:** 🚧 in progress — Part 1 handoff ready; implementation pending · **Origin:** GitHub Markdown support audit, 2026-09-06

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

## Part 1 handoff — 2026-09-24

Requested `gpt-6-sol` at `reasoning_effort=xhigh`; the runner did not expose
independent telemetry confirming the selected model/effort. Reasoning only: no
implementation, executable probes, acceptance runs, or commits. Caveman Mode task
guidance is unavailable here (only its persona picker is callable), so the concise
evidence-driven fallback was used.

- Add a resource-scoped, default-off `vmde.github.colorLiterals` setting so ordinary
  Markdown-file rendering remains unchanged. Thread it through `package.json`,
  `src/platform/editor-config.ts`, `src/shared/protocol.ts`, initial webview config,
  and live config changes. Keep the existing Inline code toolbar action.
- Add a focused color-literal parser/decorator under `media-src/src/editing/`. Accept
  whole-span `#RRGGBB`, decimal `rgb(R,G,B)` with 0–255 components, and
  `hsl(H,S,L)` with integer 0–360 hue and 0–100 percent saturation/lightness.
  Allow documented comma forms with optional internal ASCII spaces; reject outer
  padding, alpha, short hex, malformed values, and out-of-range components. GitHub's
  published page leaves some grammar boundaries unspecified, so keep this grammar
  conservative and test it explicitly.
- Decorate existing inline `code` elements using a class and validated, reconstructed
  CSS color variable plus `::before` swatch. Keep text visible and editable; add no
  child nodes or focus target, and exclude fenced/preformatted blocks. Account only
  for Vditor's known leading WYSIWYG U+200B caret marker. Reapply after DOM rebuilds,
  clear on invalid edits or setting-off, and leave Source mode raw. Verify that a code
  span holding the caret is not disrupted. Inspect whether raw HTML `code` is
  distinguishable from Markdown code spans before broadening targets.
- Confirm the visible baseline in Part 2. Add parser/cleanup/source-fidelity units,
  focused Chromium tests across Preview/IR/WYSIWYG/Source and live toggling, and a
  build-first real-VS-Code spec for Inline code authoring, OS-level undo/redo, and
  saved/reopened exact Markdown. Run changed-line coverage and applicable network-free
  quality stages; dependency audits and aggregate `npm run quality` are waived by the
  local queue. Record bundle bytes, delta, and eager modules.

No owner decision is outstanding. Part 2 is assigned `gpt-6-luna` at
`reasoning_effort=xhigh`; return any parser/serializer uncertainty to reasoning.
