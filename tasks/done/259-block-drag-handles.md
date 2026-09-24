# Task 259 — Block drag handles: reorder ANY block by mouse (Notion-style)

**Status:** ✅ DONE (2026-09-24) — one handle per complete source-owned group; malformed/unprovable ownership declines · **Impact:** ⚪ low-med · **Depends:** shares task 222's engine · **Origin:** task 192 §10

## Problem

Only drags in the codebase are outline WIDTH-resize and Vditor's selected-text drag.
Task 222 reorders heading-sections via the OUTLINE only — there is no in-editor handle to
grab a paragraph/list/code fence/table and move it (the Notion staple).

## Scope

- [x] Hover gutter handle (⋮⋮) for every source-proven block or complete HTML
      enclosure, anchored at its first rendered sibling; HTML5 drop indicator and
      drop = ONE guarded model edit + one undo step. Unprovable ownership declines.
- [x] Generalize task 222's section-move engine to source-proven block ranges,
      including list items with nested descendants and complete HTML enclosures;
      heading handles delegate to whole-section semantics.
- [x] Modes: ir/wysiwyg v1 (sv is raw text — out); keyboard alternative = Alt+Up/Down
      block move (cheap, pairs with 244; same engine).
- [x] Must not fight text-selection drag (handle-originated drags only) nor the diagram
      zoom gate.
- [x] **Drop-cursor indicator** (added 2026-07-03, prosemirror-dropcursor parity): a 2px
      horizontal line at the exact target boundary while dragging — pure overlay from
      dragover→nearest-block-boundary; ALSO shown for OS-file image drops (the only drag
      that exists today, currently indicator-less).
- [x] **Handle click-menu**: clicking (not dragging) the ⋮⋮ handle opens the task-298
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

## Part 2 guarded handle/host checkpoint — 2026-09-24

The external IR/WYSIWYG overlay now owns one hover handle, click menu and 2px drop
indicator without inserting nodes into Vditor's serializer DOM. Handle-originated
internal drops are consumed even if stale or unsupported; ordinary text and OS-file
drags remain with Vditor, while the file drag shows the indicator. The source planner
also handles Delete/Duplicate as exact one-block actions; heading marker actions still
decline pending whole-section delegation. The client and host use a prepare/apply
handshake bound to editor, mode, exact source, URI and version, then one guarded host
edit. A pending host binding has a live timeout object; a regression requires that
only seven serializable fields appear in the prepare message. The handle's 12px width
fits the measured real VS Code 52px content gutter with a 2px clearance before the
36px heading-fold region. Wider and split layouts still need explicit geometry checks.

Focused evidence: `npm test -- test/backend/block-move.test.ts
media-src/src/nav/block-handle.test.ts media-src/src/boot/finish-init.test.ts`
43/43; `npm run typecheck` and `npx tsc --noEmit -p ./` passed; `node build.mjs`
passed; `xvfb-run -a npm --prefix media-src run test:e2e -- block-handle.spec.ts`
4/4; `env -u ELECTRON_RUN_AS_NODE xvfb-run -a npm --prefix test/vscode-e2e
test -- block-handle.spec.ts --retries=0` 1/1, including exact host move,
Ctrl+Z/Y, save and reopen. The real test initially found an unavailable handle in
the 52px gutter, then a non-cloneable timeout spread into the host prepare message;
both were corrected and the final focused run passed. Disposable diagnostic probes
were removed. This is a checkpoint, not task closure: physical Alt+Up/Down XTEST,
real click-menu actions, broader mixed-document ownership/availability, narrow
layout geometry, mode-stale rollback and whole-section heading moves remain open.

## Part 2 source-proven interactions and remaining universal ownership — 2026-09-24

The complete supported path is implemented. The external overlay provides IR and
WYSIWYG block handles, the 2px drop indicator, Alt+Up/Down, source-targeted
Turn Into via Task 298's one native QuickPick, and guarded Delete/Duplicate.
Heading handles delegate to Task 222's whole-section planner and carry body and
child headings. Direct list-item handles carry nested descendants; a hovered
nested child targets its parent. Identical text uses the hovered source ordinal.
An internal drag is consumed even when stale or unsupported, while ordinary
text/file drags remain with Vditor. The 12px handle stays left of the 36px
heading-fold hit region when the gutter permits and uses the block's far right
edge in narrow panes. Real split-view tests measure a reachable table-cell
interior outside the column-resize hitboxes.

Exact source offsets remain authoritative. When Vditor canonicalizes a document,
the mapper renders the exact snapshot into a detached Lute DOM in the active mode
and requires its full serialization to equal live `getValue()`. It also requires
ordered kind/container agreement, a one-unit source-fragment reparse, and
per-unit canonical content agreement with the live DOM. A tagged, empty/ZWSP
trailing caret paragraph is excluded; filled or untagged extra blocks decline.
The cache invalidates on live text, child, and source-significant attribute
mutations, and its observers are disposed on reinit. The host still checks the
exact before bytes, URI, version, and planned after bytes before one model edit.
A post-Undo edit-sync regression cancels only a pending canonical serializer post
while an exact transaction still owns the rendered baseline and no trusted input
is pending. Trusted typing still flushes normally. A request after host Undo can
arrive before the webview receives the exact reseed; it declines safely until
that update settles.

**Focused evidence:** `npm test -- test/backend/block-move.test.ts
media-src/src/nav/block-handle.test.ts media-src/src/bridge/edit-sync.test.ts
media-src/src/boot/finish-init.test.ts` passed; targeted coverage ran 71/71
(planner 95.54% lines; handle 66.32% unit lines with the interaction branches
covered in Chromium/real VS Code; edit-sync 72.53% whole-module lines).
`xvfb-run -a npm --prefix media-src run test:e2e -- block-handle.spec.ts`
passed 8/8. After `node build.mjs`, the full focused real VS Code spec passed
9/9 with its opt-in XTEST case skipped. The opt-in isolated Xvfb/Openbox
`VMDE_XTEST=1` Alt+Down/Ctrl+Z/Ctrl+Y/Alt+Up case passed 1/1. After moving the
adapter to the editing module to remove an introduced editing↔nav cycle, a final
build and focused real drag/Undo/save smoke passed 1/1. Real cases additionally
cover mixed IR/WYS canonical rendering with exact host move/delete/save, the
shared native palette, heading section moves, a real split editor, mode-stale
cancellation, and external host divergence after prepare.

**Gate limits:** Task 259's scoped Biome, host/webview type checks, and real-spec
type check pass. `npm run typecheck:strict` reports seven preexisting diagnostics
in other modules; no Task 259 diagnostic remains. Bundle size is 788.8/608 KB
and startup cost is 329/294 eager modules, both already over budget at the
previous Task 259 checkpoint. `npm run quality` fails in inherited brand
identifiers, whole-tree lint/knip, emoji vendor audit, and seven aggregate unit
cases across manifest, module-boundaries, probe-tier and vendor-license checks;
its jscpd and dependency-cruiser stages pass. The module-boundary suite after
Task 259's relocation has 5/7 passing: only existing manifest omissions
(no Task 259 IDs) and host `markdown->platform` remain. Aggregate coverage
cannot emit its coverage-module summary while those tests fail.

**Checkpoint-only acceptance limit (superseded by the owner policy below):** the literal "ANY block" and "every top-level
`data-block`" checkboxes remain open. Raw HTML/protected blocks, unproven lazy
continuations and ambiguous loose/nested-list boundaries fail closed. Their
exact source ownership needs a separately proven parser path before handle
availability can be universal; this checkpoint does not claim those cases.

## Part 2 complete-source-group prototype — 2026-09-24

At this checkpoint the remaining ownership work had a bounded prototype, pending the owner's
choice on whether one handle per complete source-owned HTML enclosure is the
intended interaction. A single-block raw HTML source unit is recognized across
CommonMark classes 1–7 with distinct close/blank lifetimes, including comments
whose contents look like Markdown markers. Paired and nested `<details>`
openings/body/closings become one exact source group, with `memberKinds` proving
its ordered rendered siblings; the only handle is anchored at the first HTML
block. The whole group moves, duplicates or deletes through the existing guarded
host transaction. Turn Into is disabled on HTML/table/thematic units because
Task 298 has no such target transform. Strict fragment and complete-document
Lute projections still have to agree with live IR/WYSIWYG DOM; the planner also
re-scans the result and rejects an edit if any untouched source group changes
kind, member shape, content, or order.

The source scan now counts marker content columns across tabs, carries proven
unindented paragraph continuations inside list items and quotes, and keeps a
loose sibling item with its authored blank and indented continuation. A lazy
line is never its own handle. Ambiguous empty list markers followed by unindented
prose, blank quote lines followed by lazy prose, under-indented ordered children,
and unproven leaf/container transitions still decline. A blank-line-split
non-`details` HTML enclosure (`<div>` or custom tag) also declines: offering its
opening tag alone could detach the body and closing tag. Other HTML enclosure
policies remained part of the pending owner decision. The literal universal
checkboxes above were still open at this checkpoint; the owner policy and generic
tag-stack follow-up below supersede that interim limit.

Red-to-green evidence: `npm test -- test/backend/block-move.test.ts
media-src/src/nav/block-handle.test.ts` passed 66/66; `xvfb-run -a npm --prefix
media-src run test:e2e -- block-handle.spec.ts` passed 14/14, covering HTML
classes 1–7, paired/nested details, loose/lazy list and quote, nested-item
ownership, and split non-details HTML rejection. `npm run typecheck`,
`npx tsc --noEmit -p ./`, and `node build.mjs` passed. After that build, the
focused real VS Code details and lazy-list specs passed 2/2. The details path
includes one opening handle, exact source move, Ctrl+Z/Y, save, and WYSIWYG
availability; the lazy-list path includes exact host move and Ctrl+Z.

## Owner policy and closure — 2026-09-24

The Project Owner chose **one handle per complete source-owned group**, resolving
the earlier literal "every rendered block" wording. A paired HTML enclosure may
render opening/body/closing siblings, but only its first sibling exposes the
handle; the whole exact source group moves, duplicates or deletes. The source
scanner now matches complete `<details>`, `<div>` and custom-tag enclosures with
a strict nested tag stack and exact UTF-16 spans. A mismatched, unclosed, orphan
or otherwise unprovable enclosure has no handle or source edit. This rule also
protects source ambiguity in under-indented children, empty-marker lazy lines,
unclosed fences and other uncertain containers. These safety declines are part
of the approved group policy, not independent rendered-fragment actions.

Final affected verification: pure/DOM `block-move.test.ts` and
`block-handle.test.ts` passed 69/69; Chromium `block-handle.spec.ts` passed
15/15 across drag/keyboard/menu/file indicator, duplicate identity, nested
lists, HTML classes 1–7, paired/nested enclosures, loose/lazy list/quote and
mismatched-HTML decline. After `node build.mjs`, focused real VS Code paired
`<details>` and `<div>` cases passed 2/2, covering exact host bytes, native
Ctrl+Z/Y, save, and WYSIWYG handle availability. The earlier full focused real
spec passed 9/9 plus an opt-in isolated Xvfb/Openbox XTEST Alt+Up/Down and
Undo/Redo 1/1; its remaining cases cover source-targeted Turn Into, Delete and
Duplicate, split-pane/table geometry, stale mode requests and external host
divergence. Host/webview types and scoped Biome pass. The built webview bundle
is 801.1 KB with the separately committed Task 285 checkpoint also included,
so that number is not a Task-259-only size delta.

`npm run quality` was run after this source change. It remains nonzero for
preexisting brand identifier/lint/knip/vendor-audit issues and five aggregate
unit failures (manifest setting order, module manifest totality, host
`markdown->platform`, probe-tier convention and vendored licenses). No Task 259
case failed; jscpd and dependency-cruiser passed. `typecheck:strict` still
reports seven diagnostics outside Task 259, while its own changed lines are
clear. The module-boundary suite previously passed 5/7 after moving the
Task 259 client into the editing module; remaining omissions do not name any
Task 259 module. `tasks/README.md` now indexes this completed task; protected
local queue files remain untracked and unstaged.
