# Task 495 — Fix/renumber ordered lists: sv mode

**Status:** 🚧 in progress — review repair · **Impact:** ⚪ low · **Origin:** split off task 255 (2026-08-04) — ir/wysiwyg shipped, sv deferred by explicit user decision

## Problem

Task 255 shipped `vmde.fixListNumbering` / `vmde.renormalizeAllLists` for ir/wysiwyg by
re-serializing a list root's `outerHTML` through `SpinVditorIRDOM`/`SpinVditorDOM`
(`media-src/src/editing/list-normalize.ts`). That approach doesn't transfer to sv mode:
measured, Vditor's `setValue()` wraps the ENTIRE sv document in ONE `<div data-block='0'>`
(`vditor/src/index.ts:317`) — per-paragraph `data-block` divs only appear after a local edit
re-spins a sub-region (`sv/process.ts`'s `processSpinVditorSVDOM`). So there is no ready-made
"list block" DOM element to scope a spin against on a freshly opened document, unlike
ir/wysiwyg's `<ul>/<ol>` roots.

## Scope

- [x] Command `VMDE: Fix list numbering` / `Renormalize all lists` work identically when
      the active mode is sv (same command IDs — `vmde.fixListNumbering` /
      `vmde.renormalizeAllLists` already exist and route through `activeModeElement`, which
      resolves the sv element too; this task only needs to make `list-normalize.ts`'s core
      handle that element shape).
- [x] Decide + implement one of:
  - Text-range block-boundary detection (find the contiguous list-marker lines around the
    caret / around each list in the raw markdown, scoped tighter than "one data-block") —
    higher-risk (a wrong boundary can absorb/corrupt an adjacent non-list paragraph, the exact
    failure mode ir/wysiwyg's "byte-identical rest of doc" verification guards against) but
    matches ir/wysiwyg's per-list scoping.
  - Normalize the enclosing `data-block` as-is (coarser but honest: on a freshly opened doc
    that may be the WHOLE document; after local edits it may be just one paragraph — behaviour
    is history-dependent, which needs to be documented as a known limitation, not hidden).
- [x] Whichever approach: caret/scroll preservation (`Lute.Caret` token round-trips to
  `<wbr>` — `sv/process.ts`'s `processPaste` already does this for the paste path, same
  mechanism reusable here) and one undo step, same bar as ir/wysiwyg.

## Out of scope

Same as task 255: auto-renumber-on-edit (task 284), list-style changes.

## Verification

L1: unit coverage for whichever block-boundary logic gets picked (messy fixtures, Node-Lute
recipe if text-range; jsdom if DOM-based). L2: harness spec (`media-src/e2e/list-normalize.spec.ts`
already has the ir/wysiwyg pattern to extend) — sv leg: numbering fixed, rest of doc
byte-identical (or documented coarser scope), caret kept, one undo. L3: extend
`test/vscode-e2e/list-normalize.spec.ts`'s existing test with an sv-mode pass, same fixture.

## Part 1 handoff — 2026-09-08

**Routing:** `gpt-6-astra`, `reasoning_effort=medium`, reasoning only. Caveman is unavailable;
the concise evidence-driven fallback was used. Part 2 is assigned `gpt-5.6-terra`,
`reasoning_effort=high`. No implementation, executable probes, acceptance tests, or commits
were performed in Part 1. Existing Task 255/284 evidence is historical, not a new SV pass.

### Decision and source contract

Choose source-range detection, independent of the current SV `data-block` partition. The live
`list-normalize.ts` still finds actual `ul`/`ol`, so both commands currently find nothing in SV.
`setValue()` still calls `SpinVditorSVDOM` inside one document-wide div. Normalizing that div
would violate the existing caret-root contract. Keep the IR/WYSIWYG implementation and Task
284 automatic-renumber exclusion of SV intact; this is explicit-command work only.

- Fix targets the outermost source list containing the range's start, matching the existing
  `Range.startContainer` contract. A nested ordered list inside a bullet/task list belongs to
  that outer root. Normalize all ordered descendants, each with its own sibling counter.
  A list inside a blockquote is a root unless also inside another list. A noncollapsed range
  does not broaden Fix to every intersected root; preserve both endpoints and direction.
- Each ordered list retains its first authored numeric value and delimiter (`.` or `)`);
  subsequent direct items become start + sibling index. Mixed marker families and changed
  delimiters may start separate lists. Confirm these boundaries against shipped Lute, including
  zero/non-one starts, all-1 lists, leading zeroes, and the nine-digit marker grammar.
- All-lists counts changed outer roots, not individual nested lists, and applies the batch as
  one transaction. Canonical/listless/outside-list cases create no edit, dirty transition, or
  history entry. All-lists must work even when the current caret is in prose.
- Preserve every byte outside changed list roots, including CRLF/mixed EOL, trailing spaces,
  literal HTML, link spelling, hard breaks, and final-newline state. Inside a root preserve
  item content, bullet/task markers, delimiter style, loose/tight structure and nesting.
  Prefer digit-only edits; marker-width changes may require narrowly adjusting owned syntax
  padding/continuation indentation to keep the same parse. Never silently detach child blocks
  when 9 becomes 10 or 99 becomes 100. Do not spin/reformat unrelated source.
- Root boundaries include owned continuation paragraphs and nested blocks; a blank alone does
  not terminate a loose list. Protect fences (including nested/quoted fences), indented code,
  raw HTML classes and their distinct lifetimes, comments, front matter, math, table contents,
  escaped markers and reference definitions. Lazy continuation and quote-depth transitions
  require explicit handling. Ambiguous ownership must decline safely, with any remaining
  unsupported acceptance case reported rather than counted complete.

### Implementation route and exact affected paths

1. Add `media-src/src/editing/list-normalize-source.ts` and its unit test as a pure source
   planner: root/child ownership, ordered marker edit spans, changed-root count, exact result,
   and mapped anchor/focus offsets. Existing `rewrap-markdown.ts` contains private container,
   tab-column and protected-block logic; `table-operations.ts` and `nav/section-range.ts`
   contain HTML-block classification. These are reference primitives, **not** an existing
   complete list-root scanner. Reuse small proven helpers if useful, without rewriting those
   features or importing an unrelated parser dependency.
2. First Part 2 probe: inspect detached `SpinVditorSVDOM` output for `li-marker`/padding spans,
   exact text equality and structural information, and compare `Md2VditorIRDOM` list trees for
   representative originals/results. If parser-proven SV marker spans can drive recognition,
   prefer that over guessing from every line matching a numeric regex. Neither method provides
   a documented source-position map. Pin actual start/delimiter/nesting behavior and width
   transitions before committing the planner. Return conflicting evidence to Part 1.
3. Add `media-src/src/editing/list-normalize-source-command.ts` (or a small adjacent adapter).
   Reuse Task 256's `table-format-command.ts` transaction design: retained source selection
   across `selectionchange`/`focusout`, exact and rendered source snapshots, editor/mode/revision
   identity checks, composition/read-only guards, source Range replacement, rollback, and
   `findScroller` preservation. A narrowly extracted shared SV helper is authorized if it
   avoids copying that machinery; preserve table-specific mapping and re-run its regressions.
   Do not let a focus-loss caret at offset zero overwrite a real retained caret; real editor
   gestures invalidate it. Reject stale document/editor/mode snapshots.
4. Use existing `checkpointEditorUndo`, `recordRewrapDocumentHistory` and
   `mapCaretOffsetByLine` from `rewrap-command.ts`, and undo rollback support from
   `table-actions.ts`. Register before/after exact bytes against the actual SV native history
   state, map both selection endpoints through replacements and EOL normalization, restore
   through `requestCaret`, then post once through `editSync.postExact`. No `setValue()` reset
   of history, no second delayed normalization, and no speculative host edit on rollback.
   Snapshot/checkpoint ordering must be verified with immediate adjacent typing and Undo/Redo.
5. In `media-src/src/bridge/message-router.ts`, route SV for the existing two messages through
   the new adapter; preserve visual-mode branches. Wire exact-sync dependencies in
   `media-src/src/boot/main.ts` following `configureTableFormatCommand`. Update stale comments
   in `list-normalize.ts`. No host protocol or command-ID changes are necessary:
   `src/app/commands.ts` and `package.json` already contribute both commands for VMDE.
   The live source search found list-numbering dispatch in the router and palette contributions;
   do not claim an additional native/menu action exists or add a new menu project here.
6. Extend `media-src/e2e/list-harness.ts`, `media-src/e2e/list-normalize.spec.ts`, and
   `test/vscode-e2e/list-normalize.spec.ts`; add a privacy-safe SV fixture under
   `test/vscode-e2e/fixtures/` as needed. A raw stale-source fixture is correct for SV; the
   visual-mode tests' injected `li.remove()` does not exercise SV. Keep existing visual tests.

### Part 2 acceptance and focused checks

- Units: nested/mixed/quoted/loose lists, starts and delimiter boundaries, protected lookalikes,
  Unicode offsets, EOL/final-newline fidelity, marker-width nesting, multiple roots, no-op,
  endpoint mapping and idempotence. Use shipped Lute to check scanner/semantic assumptions,
  not a mock that merely repeats the implementation's answer.
- Chromium: Fix and All on both fresh single-div and locally edited partitioned SV DOM; exact
  surrounding bytes, selection/caret, scroller, one-step Undo and Redo, repeated no-op,
  stale retained selection, and a following actual text input at the restored position.
- Real VS Code: execute **both existing commands** through the host; exercise actual palette
  focus transfer, nested caret scoping, selection/typing, one-step keyboard Undo/Redo, save and
  reopen with exact host/disk bytes. A harness-only or `getValue()`-only pass is insufficient.
- Build first: `node build.mjs`. Focused runs:
  `xvfb-run -a npm --prefix media-src run test:e2e -- list-normalize.spec.ts`, and
  `env -u ELECTRON_RUN_AS_NODE xvfb-run -a npm --prefix test/vscode-e2e test -- list-normalize.spec.ts --retries=0`.
  Use `test/vitest.config.mts` for focused units. Inspect changed-source unit and Chromium
  coverage. Re-run table-format focused checks if shared SV plumbing is extracted.
- Run applicable type/lint/network-free quality gates and bundle/startup measurements under
  the current session's owner waivers; do not reintroduce waived audits or broad suites.
  Record actual commands, failures/omissions, main bundle bytes and eager-module delta.
  Part 1 ran none of these checks. Do not close the task or update `tasks/README.md` until
  Part 2 acceptance, verification and focused local commit are complete. Never stage the
  local queue and never push.

**Readiness:** implementation may proceed with the bounded initial parser probes above.
No owner decision is needed for the source-range option already allowed by Scope. Parser
evidence that requires broader normalization or changes the semantic contract returns to
reasoning before implementation expands.

## Part 2 completion — 2026-09-08

Implemented source-range list planning and a retained-SV-selection transaction. SV alone routes
the existing explicit commands through it; Task 284 auto-renumber stays excluded. The planner
preserves the first marker's numeric start/delimiter, updates descendant ordered lists, adjusts
owned continuation indentation across marker-width changes, and ignores fenced, indented-code,
escaped, and ten-digit lookalikes.

Evidence: shipped-Lute differential probe; planner units 5/5; focused Chromium 18/18; fresh
`node build.mjs`; focused Biome; webview and VS Code-e2e typechecks; and a no-retry serialized
real-VS-Code run covering both host commands, undo/redo, save, and reopen (the runner cleared its
failure artifact directory). Audits, aggregate quality, coverage report, and bundle/startup
measurements were intentionally omitted under the task's minimal-validation direction.
