# Task 256 — Table formatter in sv/source mode (prettify pipes)

**Status:** ✅ DONE (2026-09-08) · **Impact:** ⚪ low, near-free · **Origin:** task 192 §10 (probe-verified)

## Part 1 handoff (2026-09-08)

Reasoning performed by `gpt-5.6-terra`, `reasoning_effort=medium`. Caveman Mode
was unavailable, so this is a concise source/test/history audit rather than a
plugin-produced review. No implementation, executable probe, acceptance run, or
commit was made in this phase. Part 2 remains `gpt-5.6-terra`,
`reasoning_effort=high`.

### Decided scope and dependencies

- Ship **one** `VMDE: Format table` command. It is source-first: with a collapsed
  or table-local selection in SV, replace only the caret's complete ordinary GFM
  table with Lute's table-normalized Markdown. It may work in IR/WYSIWYG through
  the same exact-source transaction after that path is explicitly proved. Do not
  ship `Format all tables`: whole-document normalization is contrary to the
  minimal-diff contract and it is optional scope.
- Task 215 is complete and supplies only native visibility gating. Its direct
  command proxy established that `webview/context` supplies no trustworthy
  clicked-node identity. The new menu row must therefore be gated by
  `webviewId == vmde.editor && webviewSection == editor` and act on the retained
  live caret/selection; it must not infer the right-clicked table, move focus, add
  a DOM context-menu listener, or prevent the native menu. The Command Palette
  route has the same caret semantics.
- Task 219 is coordination, not a prerequisite. Its live commits
  `2b3b551`, `2108493`, `1c1e953`, `0372875`, `921ca2d`, and `a62523f` establish
  the current table transaction/rollback work. Do not alter Task 219's record or
  implementation while performing this task. Its `table-operations.ts` scanner
  and parser are safe source-identification evidence, but its rendered-table
  ordinal proof and `table-actions.ts` transaction deliberately reject SV.

### Implementation handoff

1. First pin the live Lute call against the vendored runtime. The blob exposes
   `FormatStr` (and `Format`); verify the configured instance's exact table-only
   input/output for padded columns, alignment delimiters, escaped pipes and
   full-width characters before choosing it. Never run it on the complete
   document. If its output is not table-local or loses an accepted construct,
   stop and record that evidence rather than substituting a hand formatter.
2. Extract or narrowly reuse the parity-aware, fence-aware ordinary-GFM table
   range logic from `editing/table-operations.ts`: it preserves per-line EOLs and
   rejects fenced, indented-code, blockquote/list, ragged, and protected shapes.
   Do **not** reuse `src/shared/md-scan.ts::splitRowCells` alone: its single
   negative lookbehind is not a general backslash-parity tokenizer. Locate the
   one range containing the native SV caret offset; a selection spanning multiple
   blocks, an unprovable table, composition, stale snapshot/mode, or a no-op is a
   no-op with no dirty edit/history entry.
3. Add a small typed host-command/message route and manifest command/menu
   contribution, following `src/app/commands.ts` and the protocol/message-router
   conventions. Keep it distinct from Vditor toolbar-hotkey dispatch: Vditor has
   no formatter toolbar action to click. In SV, obtain and restore the source
   selection as offsets relative to the replaced range (including a caret inside
   padded content), retain focus and scroll, and refresh the preview through the
   normal edit path.
4. Commit exactly once through the existing programmatic-history bridge:
   snapshot exact source, revalidate immediately before mutation, checkpoint both
   sides of `setValue`, record exact before/after history like Task 219's
   `table-actions.ts` / `rewrap-command.ts`, then `postExact(after)` only after
   the local rebuild succeeds. `postExact` alone is insufficient: one undo and
   redo must restore exact original/formatted bytes, respectively. On any throw,
   restore source, undo state, caret/selection and scroll; do not publish a
   speculative edit. Preserve CRLF/LF form, terminal newlines, every byte outside
   the table, and source save/reopen fidelity.

### Focused validation required in Part 2

- L1: focused unit tests for table-range/caret mapping and a Lute-adapter seam;
  pin messy pipes, alignment, escaped/backslash-parity pipes, full-width text,
  CRLF, terminal newline, fenced/protected false positives, multiple/identical
  tables, selection/no-op and only-the-target-range replacement. Confirm changed
  lines are covered.
- L2: Chromium SV harness invokes the real message route and asserts source
  padding, retained logical caret/selection/focus/scroll, unchanged surrounding
  bytes, semantic right-preview equivalence, one undo/redo, and no prevented
  native `contextmenu`. Include a mode-return leg if IR/WYSIWYG support is
  claimed.
- L3 is mandatory under current repository policy, despite this record's older
  optional wording: after `node build.mjs`, add and run one focused real-VS-Code
  SV spec. Directly execute the registered command (native Electron menu clicks
  are not Playwright-drivable), prove source/save/reopen plus undo/redo and caret
  behavior, and distinguish that proxy from a clicked-target claim. Then run the
  applicable type/lint/coverage gates and `npm run quality`; report actual results
  and environmental limits only.

## Problem

Probe: IR round-trips auto-pad tables (implicit normalization on save), but
`SpinVditorSVDOM` keeps messy pipes VERBATIM — sv edits save unformatted. Users of
Markdown Table Prettify expect "format table" exactly on this raw-pipe surface. Tasks
218/219 are different (paste-import / visual widths).

## Scope

- [x] Command `VMDE: Format table` (palette + Task 215 native context menu) in SV: run only
      the caret's scanner-proven GFM table through Lute `FormatStr`, retaining CRLF/LF source
      bytes, source caret, focus, scroll, exact host history, save and reopen fidelity.
- [x] `Format all tables` deliberately not shipped: whole-document normalization is optional
      scope and violates the minimal-diff contract.

## Out of scope

- Format-on-type, column resize (219), CSV import (218).

## Verification

- [x] L1: Lute-backed units cover CRLF, escaped pipes, full-width cells, protected shapes,
      table-local selection, target-only replacement and caret mapping; writeback coverage
      proves exact source transactions are not reverted as semantic no-ops on save.
- [x] L2: Chromium SV coverage verifies padding, exact surrounding bytes, logical padded-cell
      caret, one undo, host-focus selection loss, and stale-snapshot rejection.
- [x] L3: one serialized, no-retry real-VS-Code SV run directly executes the command and proves
      CRLF source, undo/redo, `TextDocument.save()`, and reopen.

## Completion record — 2026-09-08

- The command is intentionally selection-driven; native context-menu target identity is not
  trusted. A retained SV snapshot captures exact/rendered source plus selection offsets before
  host focus crosses the webview. It rejects editor/mode/rendered/exact mismatches and source
  input, and programmatic restoration flows through ADR-0007 `requestCaret`.
- A host writeback correction was necessary: save-time semantic-noop minimization previously
  restored unpadded table bytes. Successfully applied exact transactions now suppress that
  semantic rewrite until the next baseline or ordinary edit.
- Focused evidence: table formatter/writeback units 39/39, Chromium 3/3, build and webview/
  real-spec typechecks, and the final real-VS-Code no-retry spec passed. `npm run quality` was
  attempted: task-local formatting was fixed, but the aggregate gate remains red from existing
  shared-tree formatting/tests, blocked npm audit DNS, dependency-cruiser's TypeScript-7
  zero-module limitation, and inherited bundle/startup budget excesses.

## Reopened acceptance correction — 2026-09-08

- Added focused source scanner coverage for a caret inside a fenced table, HTML blocks/comments,
  and two-space list/quote continuations; added outer-pipe/padding selection mapping, explicit
  read-only rejection, noncollapsed selection/scroll, rollback, mode and native-context-menu
  Chromium checks. Current focused units pass 41/41 and Chromium passes 4/4.
- Astra-low identified the failing probe as SV capture ownership, not caret authority. A real
  Playwright focus invalidates stale authority before the test installs its Range; the capture now
  maps a padded displayed table to its same-ordinal unpadded exact table through logical cells.
  The final real spec asserts the root-wide source/text offset, then undo/redo/save/reopen content.
  It passed in one serialized no-retry run. No temporary trace remains.
- Final review repair: scanner continuation context now crosses permitted blank continuation
  lines and recognizes both outer-pipe and bare-pipe table rows; fence state is evaluated before
  HTML/comment state. Chromium captures rollback before any reset and asserts both selection
  endpoints plus selected content. The real spec throws on missing selection and re-reads the
  exact host document after reopen. Focused unit 8/8, Chromium 4/4, build, typechecks and the
  updated one-run real spec passed.
- Scanner finalization: HTML void elements and explicit self-closing tags do not open persistent
  blocks; active HTML/comments treat fences as literal until their own terminators, while active
  Markdown fences still take precedence over later HTML-shaped text. Focused source tests pass
  10/10 with typecheck and targeted Biome clean; no browser rerun was needed for this pure scanner
  correction.
- HTML lifetime correction: void and explicitly self-closing block lines retain protection until
  Markdown's blank-line terminator rather than immediately exposing following pipe rows. HTML
  blocks still own embedded fence-looking text until their close/blank terminator; a blank then
  permits the following ordinary table. Focused units 10/10, typecheck and targeted Biome pass.
