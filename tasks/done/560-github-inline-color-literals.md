# Task 560 — GitHub inline color-literal previews

**Status:** ✅ done — Part 1 feedback, implementation, acceptance, and local commit complete · **Origin:** GitHub Markdown support audit, 2026-09-06

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

- [x] Verify wrapping a valid color with the existing Inline code control produces the swatch,
      preserves the literal's chosen HEX/RGB/HSL format, and remains one undoable edit.

## Implementation and verification

- [x] Confirm the focused baseline in the current editor and define the smallest correction.
- [x] Implement the syntax contract without losing source bytes or weakening sanitization/CSP.
- [x] Unit coverage for valid, malformed, escaped, and literal-code cases and source fidelity.
- [x] Focused Chromium coverage for affected Preview/IR/WYSIWYG behavior and source-mode fidelity.
- [x] Build first, then a focused real-VS-Code spec under xvfb covering actual interaction,
      saved/reopened Markdown, and undo/redo; verify host navigation where applicable.
- [x] Run applicable focused gates and final quality validation per DEVELOPMENT.md before closure.

Audit-session validation was deliberately minimal; Part 2 evidence and residuals follow.

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

No owner decision remains. The refreshed local queue assigns Part 2 Medium / `gpt-6-luna` /
`reasoning_effort=max`; the original handoff line said xhigh and is superseded. The orchestrator
accepted the Luna/max route; this subagent had no separate runtime telemetry.

## Part 1 feedback cycle — 2026-09-24

The real-editor test first showed that the Inline code toolbar action changed the exact source and
painted the expected swatch, but Undo stayed disabled. The Sol-Max feedback pass identified the
opening Vditor history baseline as a likely race: Part 2 had waited for router/mode readiness but
not for the debounced opening snapshot. A bounded XTEST probe confirmed it: before the action, IR
undo stack length was 0 (process timer 3, Undo disabled); immediately after wrapping, stack length
was 1 (last text length 3256, timer 16, `undoDelay` 800 ms, Undo still disabled).

Part 2 added the established 1500 ms opening-history settle and verifies the inline-code action
increases the actual undo stack before sending physical Ctrl+Z. With that precondition, Ctrl+Z
restored the original CRLF Markdown and Ctrl+Y restored the wrapped source. No production history
changes were needed.

## Part 2 — implementation and validation — 2026-09-24

- Added resource-scoped, default-off `vmde.github.colorLiterals` and threaded it through the host
  config payload, shared protocol, initial webview options, and live `config-changed` handling.
- Added `media-src/src/editing/github-color-literals.ts`: strict full-span HEX/RGB/HSL parsing;
  validated and reconstructed CSS values; attribute-only class/custom-property decoration; and a
  pseudo-element swatch. The code text, child nodes, selection, and serialized Markdown stay
  unchanged. Fenced blocks and `.vditor-sv` Source content are excluded. The scoped observer reapplies
  after DOM rebuilds and live setting changes clear decorations.
- Pinned Lute probe: Markdown code spans carry the authored color in their rendered `<code>`; raw
  HTML `<code>` is represented as `data-type="html-inline"` markers in IR/WYSIWYG. Preview emits the
  same `<code>` element for both source spellings, so valid raw HTML code also gets a Preview swatch;
  the Preview renderer does not preserve that spelling distinction. The browser tests cover it.
- Tests: parser/decorator and setting unit coverage (41 parser/decorator cases; 97/97 across the six
  focused unit files), manifest setting/group checks (2/2), focused Chromium (4/4 across IR,
  WYSIWYG, Source/Preview, default-off and live toggles), and real VS Code with OS-level XTEST
  (1/1). The real journey verifies Inline code authoring, one undo/redo step, Preview swatch, exact
  CRLF save and reopen. Webview and VS Code e2e typechecks and scoped Biome pass. `node build.mjs`
  passes.
- Focused changed-line coverage: `github-color-literals.ts` 100% lines, 96.77% statements,
  94.44% branches, 100% functions. In the combined 4-file focused report, `finish-init.ts`,
  `live-config.ts`, and `editor-config.ts` are also instrumented by their focused tests; the new
  observer/settings call sites are exercised. The residual decorator branches are defensive
  `textContent === null` / already-equal style guards.
- Whole-tree quality residuals: the full `test:coverage` run before the final escaped-literal case reported 4,239/4,247 passing and 8 unrelated or
  in-progress failures: three Task 298 protected-container transform cases; the existing probe-tier
  convention for `context-menu-probe.spec.ts`; the vendored-license inventory missing `emoji`; two
  module-boundary failures (including `markdown->platform`); and the pre-existing missing `order`
  for `vmde.editor.emojiPickerCloseOnSelect`. The coverage-module ratchet could not read
  `coverage/coverage-summary.json` after that failed full run; it was not run against the later
  focused-only summary.
- Whole-tree `lint:ci` still reports formatting in five unrelated files:
  `media-src/e2e/list-harness.ts`, `media-src/src/editing/block-transform.test.ts` (Task 298),
  `media-src/src/editing/escape-toolbar.ts`, `src/session/editor-session.ts`, and
  `test/backend/emoji-catalog.test.ts`. Scoped Task 560 Biome passes. `check:brand-identifiers`
  reports three historical `vmarkd` occurrences in the test-playwright patch script/test. `knip`
  reports 11 unrelated unused exports/types, including Task 298's `BlockTransformStatus`.
  Dependency-cruiser reports no violations but inspects 0 modules because its current TypeScript
  range excludes TypeScript 7. jscpd reports 8.16% duplicated tokens against the configured 8.8%
  threshold.
- Bundle report from the shared Task 495/560 build: `main.js` is 773,258 bytes / 755.13 KiB,
  323 eager modules, largest module 29.7 KiB. This is +1.4 KiB and +1 eager module versus Task
  219's 753.7 KiB / 322-module report; Task 495 was built in the same candidate, so byte growth is
  shared and not isolated to Task 560. The inherited 608 KiB / 294-module ceilings are reporting-only
  under the queue waiver and were not raised.
- Dependency audits and aggregate `npm run quality` were intentionally omitted under the Project
  Owner's local queue waiver. No push.
