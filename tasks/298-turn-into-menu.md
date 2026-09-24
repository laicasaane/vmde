# Task 298 — "Turn into" block transform menu

**Status:** 🚧 in progress — pure transform core delivered; native/context/palette and 259/285 integration pending · **Impact:** 🟡 med-high · **Surfaces in:** 285 bubble + 259 handle + 215 menu · **Origin:** task 192 §12

## What it is & the effect

Notion's staple, shipped by BlockNote as the FIRST element of its formatting toolbar: one
dropdown that converts the current block between paragraph / H1–H6 / quote / bullet /
ordered / task list / code fence / callout — "make this a heading" without touching
markdown syntax.

**Today in VMDE:** block-type changes are scattered and partial — the heading popover
(WYSIWYG only) does levels, list toggles live in the toolbar, quote/callout/code
conversions mean hand-editing markers. There is no single "what is this block → make it
that" affordance (grep 'turn into' → zero; task 254 covers heading LEVELS only).
**After:** caret in any block → one menu → any block type; the transform is a clean model
edit, so undo is one step and serialization is exact.

## Scope

- [ ] Core = a pure `blockTransform(blockMd, targetType)` util: rewrite the leading
      markers/structure (para↔heading↔quote↔bullet↔ordered↔task↔fence↔callout), preserving
      inline content; multi-line blocks defined per pair (quote→para strips `> ` per line;
      para→fence wraps; fence→para unwraps losing lang — confirm-gated). Unit-test EVERY
      source→target pair — the matrix is the deliverable.
      **Callout ownership:** Task 527 lands the canonical marker parser/formatter and focused
      insert/update/remove transforms. Import and compose that core here; do not implement a second
      callout parser or transaction path.
- [ ] Apply through the normal pipeline (re-spin, one model edit, one undo — the task-219
      col-ops pattern); with a multi-block selection (from 288), transform each.
- [ ] Surfaces: dropdown in the 285 bubble, click-menu on the 259 drag handle, entries in
      the 215 context menu, palette command with a quick-pick — ONE command core, four
      entry points.
- [ ] Current-type detection + checkmark; destructive pairs (→fence, callout→) get the
      lossy-note styling.

## Out of scope

- Turn-into for VOID blocks (diagram↔code is just the fence lang — cheap, include;
  table↔anything — exclude), Notion-style "turn into page" (that's 276 extract-to-note).

## Verification

L1: the full pair matrix (this is 80% of the work — be exhaustive, incl. nested list
items and callout bodies). L2: menu on each surface → `getValue()` exact per pair, caret
kept, one undo. L3 real-VS-Code: bubble-dropdown journey + save fidelity.

## Part 1 handoff and staged execution — 2026-09-24

Reasoned with `gpt-6-sol`, `reasoning_effort=max`; Part 2 uses `gpt-6-sol`,
`reasoning_effort=high`. The queue's staged exception permits the pure core and the
Task 215 selection-driven native context/palette entries now. Task 259 drag-handle
and Task 285 bubble surfaces, their integration checks, and full task closure remain
blocked on their own prerequisite chain. Keep this record in progress until all four
entry points and final real-VS-Code acceptance are complete.

The pure planner takes a caller-proven exact source span, explicit source-derived
current type and target descriptor, and anchor/focus offsets. It returns a changed,
no-op, unsupported, or confirm-required result without touching editor DOM. Preserve
all surrounding bytes, EOLs, selection direction, and untouched inline content;
reject ambiguous list/quote ownership, protected containers and void/table blocks.
Task 527 is the authority for callout marker parsing and transforms. Fences and
callout-removal paths that need a product confirmation policy stay non-mutating.

## Part 2 pure transform checkpoint — 2026-09-24

`editing/block-transform.ts` now contains the source-only parser/renderer and exact-span
planner. H1–H6 are distinct types. All 13×13 source/target pairs have explicit outcomes;
changed results reclassify as the target and repeat as no-ops. Simple paragraph,
heading, quote, bullet, ordered, task, and callout conversions preserve inline source;
Task 527's `transformCalloutMarkdown` creates, retargets or removes callout markers.
`→fence`, `fence→other`, and `callout→nonquote` return `confirm-required` without a
write until the owner chooses the UX for those lossy edges. Nested/multiple list items,
partial quote/prose roots, tables, raw HTML, comments, math, front matter, and indented
or quoted fenced code fail closed. The planner preserves CRLF and maps retained
anchor/focus through line-prefix changes; it does not yet perform an editor transaction.

Focused verification: `npm test -- media-src/src/editing/block-transform.test.ts
test/backend/block-transform-lute.test.ts` passed 202/202. The second file parses
representative heading, quote, bullet, ordered, task and callout outputs through the
shipped host Lute. `npm run typecheck` and focused Biome pass. Final focused coverage reports 91.23% lines, 81.81% branches and 100%
functions across the new pure planner. No Chromium or real-VS-Code acceptance is claimed for this
pure-only checkpoint. Neither queue file was staged or changed; no push.

Next stage: validate exact DOM/source ownership for IR/WYSIWYG/SV, wire one guarded
transaction/undo pipeline and source-derived metadata, then add Task 215 context and
native QuickPick routes. Do not expose unsupported or confirm-required targets as
mutating actions. Task 259/285 remain later integration work.

## Part 2 guarded action, native context and palette checkpoint — 2026-09-24

The core stage now has one reusable menu/action contract. `src/shared/block-types.ts`
owns the 13 block-type IDs, labels and result statuses. `describeBlockAt(markdown,
anchor, focus)` returns the exact source-owned span, current type and status for every
target. `requestBlockTransformOptions(window)` retains that source-verified bookmark
before native focus transfer and returns the same metadata plus an opaque token;
`applyBlockTransformChoice(window, token, target)` consumes the token, revalidates
editor instance, mode, exact/rendered snapshots, editable state and live source
ownership, then performs one guarded transaction. Task 259's handle and Task 285's
bubble can call these same functions, including when the toolbar is hidden. They
must not clone the planner or treat a clicked DOM node as source authority.

The existing Task 215 native webview context stamp exposes `vmde.turnInto` only for
`webviewSection == editor`; code blocks retain `webviewSection == code`. The native
command ignores clicked-node arguments and asks the webview for the retained
selection's metadata. `EditorSession` shows a source-derived QuickPick with a
current-type checkmark, sends the chosen type back with the token and checks the
panel/URI/document version after focus transfer. Unsupported and
`confirm-required` targets are omitted from that picker and rejected by the
adapter, so they cannot mutate source while the product confirmation policy is
undecided. Cancel, same-type and stale requests create no edit. Native clicked-node
target awareness is **not** claimed; Task 215's direct-command proxy is the testable
L3 route because Playwright cannot click Electron's native context menu.

Focused evidence for this core stage (Part 2 `gpt-6-sol`, `reasoning_effort=high`):

- Pure/adapter/Lute/host-command/message-shape units: 260/260. The focused Turn Into
  manifest test passed 1/1. Focused unit coverage on the pure planner is 91.38% lines,
  84.92% branches and 100% functions; on the adapter it is 48.02% lines and 49.64%
  branches, with live transaction branches exercised in Chromium/real VS Code.
- `env -u ELECTRON_RUN_AS_NODE xvfb-run -a npm --prefix media-src run test:e2e --
  block-transform.spec.ts`: 5/5 for IR transformation/undo, WYSIWYG and SV parity,
  stale/confirm-required no-ops, a red-to-green palette focus-sentinel guard and
  paragraph-to-callout serialization/undo through Task 527. The harness imports
  patched Vditor source, matching production; a package-main Vditor probe produced
  different built-in callout markup and was discarded.
- `node build.mjs` and `env -u ELECTRON_RUN_AS_NODE xvfb-run -a npm --prefix
  test/vscode-e2e test -- block-transform.spec.ts --retries=0`: build and 2/2 real
  VS Code pass. The tests drive native QuickPick cancellation and Heading 2 choice,
  exact host Undo/Redo/save/reopen, editor/code visibility stamps, and a forged
  context argument that cannot override the actual prose selection.
- `npm run typecheck`, `npm run typecheck:vscode-e2e`, focused Biome and staged diff
  checks pass. The built webview entry is 787,563 bytes (769.1 kB) with 326 eager
  modules; inherited reporting-only limits remain exceeded (608 KB / 294 modules).
- `scripts/module-manifest.mjs` now lists Task 298's three new source IDs, but the
  module-boundary gate remains red for 15 unrelated pre-existing omitted IDs and
  the inherited `markdown->platform` import in `src/markdown/outline-tree.ts`.
  The full manifest suite also has an unrelated missing `order` on
  `vmde.editor.emojiPickerCloseOnSelect`; the focused Turn Into case passes.
  Dependency audits, aggregate quality and broad suites were not run under the
  queue's focused, network-free validation waiver.

**Still open:** Task 259 drag-handle and Task 285 bubble entry points and final
cross-surface integration; multi-block selection transforms; owner confirmation UX
for lossy fence/callout edges; final L3 journey spanning all four surfaces. The
core/native/palette checkpoint does not close Task 298 or update `tasks/README.md`.
The local queue remains untracked and unstaged. No push.
