# Task 259 — Block drag handles: reorder ANY block by mouse (Notion-style)

**Status:** 🚧 in progress — pure exact-source move planner delivered; handle/host/UI pending · **Impact:** ⚪ low-med · **Depends:** shares task 222's engine · **Origin:** task 192 §10

## Problem

Only drags in the codebase are outline WIDTH-resize and Vditor's selected-text drag.
Task 222 reorders heading-sections via the OUTLINE only — there is no in-editor handle to
grab a paragraph/list/code fence/table and move it (the Notion staple).

## Scope

- [ ] Hover gutter handle (⋮⋮) on every top-level `data-block` node; HTML5 drag with a
      drop indicator line between blocks; drop = ONE model edit + one undo step.
- [ ] Generalize task 222's section-move engine from heading-sections to arbitrary block
      ranges — list items WITH children are the tricky case (drag the whole item subtree;
      pin the nesting rules).
- [ ] Modes: ir/wysiwyg v1 (sv is raw text — out); keyboard alternative = Alt+Up/Down
      block move (cheap, pairs with 244; same engine).
- [ ] Must not fight text-selection drag (handle-originated drags only) nor the diagram
      zoom gate.
- [ ] **Drop-cursor indicator** (added 2026-07-03, prosemirror-dropcursor parity): a 2px
      horizontal line at the exact target boundary while dragging — pure overlay from
      dragover→nearest-block-boundary; ALSO shown for OS-file image drops (the only drag
      that exists today, currently indicator-less).
- [ ] **Handle click-menu**: clicking (not dragging) the ⋮⋮ handle opens the task-298
      "turn into" menu + delete/duplicate — the Notion handle contract.

## Out of scope

- Cross-document drag, multi-block selection drag v1, Notion column layouts.

## Verification

L1: block-range move units (list subtrees, around tables/diagrams, doc edges).
L2: drag paragraph below code fence → `getValue()` exact, one edit post, one undo; Alt+Up/
Down parity. L3 real-VS-Code (mandatory): drag over the real pipeline + save fidelity.

## Part 1 handoff and dependency resolution — 2026-09-24

Reasoned with `gpt-6-sol`, `reasoning_effort=max`; Part 2 uses `gpt-6-sol`,
`reasoning_effort=high`. Task 222's exact section engine and XTEST acceptance are
closed. Its `moveSourceRange` is the raw UTF-16 splice/mapping primitive, while
this task must own block/list-item boundaries and separator policy. Task 298's
source-derived `describeBlockAt` plus token-guarded
`requestBlockTransformOptions`/`applyBlockTransformChoice` API is committed in
`1a74c6fd` and is the one Turn Into core for the future handle click-menu.
Never duplicate that menu or infer a destructive source target from clicked text.

The remaining implementation must use one external overlay for handle and drop
indicator, keep the heading-fold gutter's rendered hit boxes free, limit moves to
IR/WYSIWYG, and preserve text drag/file upload semantics. Drag, Alt+Up/Down,
Delete and Duplicate must share exact source ownership and one guarded host
transaction; a stale document/editor/mode or ambiguous list/container mapping
must decline without history. The OS-file image drop gets an indicator without
hijacking Vditor's upload. Run focused real VS Code plus OS XTEST keyboard
acceptance after a build; keep the local queues unstaged and never push.

## Part 2 pure source planner checkpoint — 2026-09-24

`src/shared/block-move.ts` adds a conservative top-level block/list-item scanner
and a separator-aware planner over Task 222's raw `moveSourceRange`. Source and
target identities are exact start offsets in one Markdown snapshot, so duplicate
text is harmless. A list item carries its indented descendants; sibling moves
are allowed only within one proven contiguous list run at the same root. Marker
width controls continuation ownership for bullets, ordered and task items;
under-indented or nested-child-as-root moves are rejected. Paragraph, quote, fence/diagram, thematic and table blocks are scanned as
complete units. Heading identities are recognized, but heading-handle moves
explicitly decline until they delegate to Task 222 whole-section semantics; a
marker-only move would detach the section body/descendants. Raw HTML, indented
code, unclosed fences, under-indented nested markers and unproven lazy quote/list
continuations fail closed for now. Front matter
stays in place. EOF moves transfer the authored separator without changing
terminal newline state; caret mapping includes the moved core, untouched blocks,
transferred separators and the half-open boundary after a moved block.

Focused `npm test -- test/backend/block-move.test.ts` passed 29/29, including
CRLF, EOF/no-final-newline, list subtree, table/escaped pipe, fenced code,
front matter, duplicate identity, no-op/stale targets and UTF-16 caret mapping.
Coverage: 95.45% lines, 87.75% branches, 100% functions. `npx tsc --noEmit -p ./`
and focused Biome pass. The new shared module is registered in
`scripts/module-manifest.mjs`; that command still reports inherited missing IDs
from earlier tasks, not `block-move`. No Chromium or real-VS-Code result is claimed
for this pure-only checkpoint. Task status and all implementation checkboxes stay
open until the handle, keyboard, menu, file-drop and host acceptance are complete.
