# Task 222 — Outline: drag headings to restructure the document

**Status:** ✅ complete — 2026-09-08 · **Impact:** ⚪ low · **Origin:** task 192 §5

## Problem

Both outline surfaces navigate only: the webview panel's drag is width-resize
(`outline-resize.ts`) and the explorer tree has no `DragAndDropController`
(`src/outline-tree.ts`). Moving a section means manual cut/paste of its whole subtree.

## Scope

- [ ] Section-move engine (the real work, shared by both surfaces): given heading H, its
      section = H + content up to the next heading of level ≤ H's; move before/after
      another section as ONE model edit + ONE undo step. Edge cases: front-matter stays
      first, trailing section, setext headings, headings inside code fences (source-map
      knows real blocks — reuse it).
- [ ] Explorer tree: `TreeDragAndDropController` wiring → WorkspaceEdit/model edit through
      the session.
- [ ] Webview panel: HTML5 drag on outline items with a drop indicator; same engine via a
      message.
- [ ] Optional guard: level-preserving move only in v1 (no promote/demote on drop).

## Out of scope

- Drag BETWEEN documents, promote/demote by horizontal drop position, multi-select drag.

## Verification

- L1: section-move engine unit — the full edge-case matrix above (this is where the value
  is; be exhaustive).
- L2: webview panel drag → document text reordered, `getValue()` exact, caret/scroll sane,
  one undo restores.
- L3 real-VS-Code (mandatory): tree-view controller invoked directly (`handleDrag`/
  `handleDrop` — native DnD isn't drivable), document persisted correctly after save.

## Part 1 handoff — 2026-09-08

Reasoning performed with `gpt-6-astra`, `reasoning_effort=medium`, as dispatched by the
runner. Caveman Mode unavailable; concise evidence fallback. Read-only source inspection
only: no executable probes, acceptance runs, implementation or commits. Part 2 is assigned
`gpt-5.6-terra`, `reasoning_effort=high`. Task 215 is complete in the live index; Task 566's
separate OS-input blocker does not prevent this independent work. Initial tracked worktree
was clean; the two local queue files were untracked. Keep them unstaged.

### Evidence and reuse

- Actual paths supersede the old problem statement: `src/markdown/outline-tree.ts` parses
  only ATX headings through `src/shared/md-scan.ts`; its fence tracker ignores fence length
  and closing suffix. `src/app/extension.ts` uses `registerTreeDataProvider`, so it must use
  `createTreeView` with the controller to enable native drag/drop.
- `media-src/src/nav/section-range.ts` already implements DOM subtree boundaries and a
  private offset-aware `sourceHeadings` scanner for heading promotion. It recognizes ATX,
  single-line setext, frontmatter, length-aware fences and HTML blocks. Extract/reuse its
  pure scanning portion under `src/shared/`, retaining its existing promotion tests.
  Audit multiline setext, container continuations, indented code and invalid backtick
  opener handling before trusting it for moves. Do not introduce another ATX-only scanner.
- `media-src/src/util/source-map.ts` is a conservative top-level line ownership scanner,
  not a parser-provided source map. Its `markdownBlockRanges` leaves blank separators
  unmapped and its setext recognition is adjacent-line only. Lute provides no Vditor source
  offsets. Therefore rendered ordinals or approximate text matching alone cannot authorize
  a destructive move; prove the selected source heading and current snapshot agree.
- Exact source infrastructure exists: `EditSync.snapshotExactMarkdown()` / `postExact()`
  in `media-src/src/bridge/edit-sync.ts`; `syncExactHistory` in `boot/main.ts`; checkpoints,
  delayed-snapshot suppression and exact history records in `editing/rewrap-command.ts`.
  `editing/emoji-insertion.ts` demonstrates guarded snapshot ownership and rollback, but
  this task must not change Task 566 behavior. Host `session/editor-session.ts` serializes
  edit/history messages; `writeback/writeback-controller.ts` bypasses minimization for
  `exact: true` and applies the result through the existing document pipeline.

### Source move contract and chosen v1 rules

1. Pure shared planner takes exact Markdown, source/target heading identities from that
   snapshot and `before | after`. Heading identity includes source start offset and level;
   callers bind it to document URI and version/session generation. Duplicate titles and
   slugs are legal and never substitute for identity. Return a discriminated result:
   `ok` with exact next Markdown, moved range/new heading offset and offset mapping;
   `noop` for unchanged placement; or a specific rejected reason. Invalid integers,
   out-of-range identities, stale snapshots and unsupported mappings cause no mutation.
2. A section starts at the first source character of its heading (including authored
   indent and the complete multiline setext title). It ends at the next top-level heading
   with level less than or equal to its own, or EOF. Descendant headings, content, comments,
   reference definitions and separating blank lines travel with it. Frontmatter and all
   pre-heading preamble remain before the first section and cannot be drop destinations.
   Nested headings inside a list/quote/HTML container are not standalone movable sections;
   they remain owned by that container. Exclude them from destructive ordinal mapping.
3. Use the task's optional level-preserving guard: accept source/target of the same heading
   level only; retain every heading marker and descendant level verbatim. Moving between
   different parents at that level is allowed and changes the parent according to document
   order. Never infer promotion from horizontal position. `after` means after the entire
   target subtree, not after its heading line. Reject self/overlapping subtree drops;
   adjacent equivalent boundaries are no-ops with no edit or history entry.
4. Shared lower primitive is `moveSourceRange(markdown, { start, end }, insertionOffset)`
   with half-open UTF-16 offsets into the original snapshot. It returns the reordered
   string, moved range and point mapping; it contains no DOM, heading or VS Code imports.
   Insertion within or at the moved range is a no-op. Outside that range, adjust the
   insertion point after removal. Task 259 can reuse this primitive with its own list/block
   ownership and separator rules; do not implement its handles or menu now.
5. Preserve raw chunk contents, CRLF/LF/mixed endings, Unicode, setext markers, trailing
   spaces and blank separators. Handle an unterminated final section explicitly: naïvely
   moving it before another heading concatenates text. Preserve the document's terminal
   newline state by transferring the boundary newline run from the section becoming last
   to the former EOF section when rotating across EOF. Example: `# A\n\n# B` becomes
   `# B\n\n# A`; CRLF remains CRLF. Keep this heading-specific boundary policy outside the
   raw range primitive and return mappings for the actual splice. Pin exact expected
   strings for both move directions, one/multiple trailing newlines and mixed EOLs.

### Transaction and surface integration

- Both surfaces submit the same move intent and use the same planner/transaction. Prefer
  the established rewrap preparation pattern: flush pending live edits, drain the session
  edit chain, then plan against authoritative host bytes. Add typed preparation/result
  messages in `src/shared/protocol.ts`, carrying request ID, URI/session ownership, base
  version and before/after bytes or verified offsets. On return the renderer must still
  match the captured exact snapshot/mode/session; a newer edit, mode switch, document switch
  or disposal cancels the request. Final exact write must check the expected host version
  inside the serialized host chain; a stale result must resynchronize, never overwrite.
- Do not apply a native WorkspaceEdit and then separately perform a renderer edit. The
  renderer records one before/after native Vditor checkpoint pair, suppresses delayed
  snapshots, registers exact history using the existing `syncExactHistory` seam and posts
  one exact edit; the host applies that one model transaction. A plain-text-only Explorer
  document may use the same planner and one WorkspaceEdit without a renderer. Define the
  session callback through `src/platform/active-panels.ts` rather than importing the
  provider back into the session and creating a cycle. Await operation completion for tests.
- Selection is not the move target. Capture it before outline focus steals it. Remap a
  collapsed caret or selection wholly inside one retained/moved interval, preserving
  anchor/focus direction. If a selection crosses intervals that become discontiguous,
  collapse to the moved heading's editable title; never select unrelated text. If no
  editor bookmark exists (Explorer focus), use that same moved-heading fallback. Restore
  through the existing caret authority, focus without scrolling, then reveal only as needed;
  clamp scroll and avoid jumping to document top. Failed apply restores source/history and
  sends no edit. Both toolbar and native undo/redo must restore exact bytes once.
- Webview: new `media-src/src/nav/outline-reorder.ts`, delegated HTML5 events on the current
  outline content, draggable row spans, before/after indicator based on row midpoint.
  Use actual source/DOM agreement, not text matching. Reject unrelated MIME/text/file drags;
  clear state/indicator on dragend, Escape, leave, rebuild, mode change and disposal. Preserve
  `outline-keyboard.ts` ARIA/roving focus, fold/hoist visibility and width-resize gestures.
  Wire via `boot/finish-init.ts`/`boot/main.ts` and message router; style outside editable DOM
  in the appropriate outline CSS source. IR/WYSIWYG/SV remain eligible when writable and
  their mapping is proven; Preview is read-only and must not initiate a move.
- Explorer: controller in `src/markdown/outline-tree.ts` or adjacent module, registered by
  `src/app/extension.ts`, single item/custom MIME with document version. The stable API
  `handleDrop` gives a target item, not a pointer half-row. Define native item-drop as
  **before target** and root/empty-area drop as **end of document** subject to level guard;
  webview supplies both explicit before/after placements. Do not invent pointer geometry
  in the native controller. Same-document only; revalidate drag item and target at drop.

### Implementation and focused verification sequence

1. Extract and harden shared heading scanning; add `src/shared/section-move.ts` (or equivalent)
   and `test/backend/section-move.test.ts`. Update outline parsing and promotion imports.
   Preserve `test/backend/outline-tree.test.ts` and `media-src/src/nav/section-range.test.ts`.
   Matrix: forward/backward/same-position, full descendants/skipped levels, same-level
   cross-parent moves, duplicate/empty/formatted titles, indented ATX, multiline setext,
   frontmatter/preamble, matching/mismatching/short/unclosed fences, indented code,
   raw HTML/comments, lists/quotes, reference definitions, CRLF/mixed EOL, no/final newline,
   trailing spaces, EOF moves and surrogate-pair offset mapping. Assert exact entire strings.
2. Build the typed session route and exact renderer transaction; extend backend protocol,
   session/controller and VS Code mock tests. Assert stale/version/cross-document/cancelled
   requests cause zero edits; accepted request causes one apply; preceding pending typing
   remains distinct; undo/redo and save do not produce echo edits. Add the required DOM
   transaction tests without touching Emoji logic. Update module-manifest only if the new
   source module placement needs registration; retain host/webview boundaries.
3. Wire both surfaces and a focused `media-src/e2e/outline-reorder.spec.ts` with production
   edit-sync/history plumbing in `outline-harness.ts` (or a registered dedicated harness).
   Drive real drag events; assert exact source snapshot plus canonical `getValue()`, order,
   one edit, one undo/redo, caret/selection direction, rejection cleanup, width resize,
   keyboard navigation and all writable modes. For CRLF/setext-normalized fixtures,
   distinguish exact host source from canonical serializer output; do not falsely require
   Vditor to serialize authored setext or CRLF. Indicator presence must not affect either.
4. Add `test/vscode-e2e/outline-reorder.spec.ts`: invoke the actual registered tree controller
   through a narrowly scoped test seam, perform the webview drag through the real session,
   inspect document bytes, save/reopen, test one-step undo/redo and stale request rejection.
   Run build first, then `env -u ELECTRON_RUN_AS_NODE xvfb-run -a npm --prefix test/vscode-e2e
   test -- outline-reorder.spec.ts --retries=0`. Keyboard acceptance uses OS XTEST input,
   not DOM/CDP keys; if unavailable, report that actual limitation and return evidence to
   reasoning rather than relabeling another input source as a pass.
5. Run focused unit/changed-line coverage, Chromium under `xvfb-run -a`, affected type checks,
   and final network-free quality components once. Follow the live queue's explicit waiver:
   skip dependency audits and aggregate `npm run quality` while it invokes them; omit broad
   suites unless focused evidence proves insufficient. Report measured bundle bytes/KiB,
   delta and eager modules; ceilings are reporting-only. Keep generated artifacts and local
   queue files unstaged. Only after all acceptance is satisfied update the task index,
   close the task and create the separate focused local commit; never push.

### Remaining risks / feedback gate

No owner decision blocks implementation. Scanner agreement for multiline setext/container
content, cross-EOF boundary transfer, exact history after host-originated moves, and stale
result recovery require Part 2 evidence. The proposed request handshake is new plumbing,
not an existing API. If a safe scanner/renderer mapping cannot be proved, reject that move
explicitly and return the concrete fixture for Astra-medium reasoning; do not mark this
task complete with required setext/EOF cases unsupported. No acceptance item is checked yet.

## Part 2 completion — 2026-09-08

Implemented with `gpt-5.6-terra`, `reasoning_effort=high`. The shared scanner/planner now
owns source sections and is used by both the Explorer controller and the webview. Explorer
DnD is same-document/version-bound and uses the registered `createTreeView` controller; a
ready VMDE panel delegates to its exact-source webview transaction, while a plain document
receives one `WorkspaceEdit`. The webview uses delegated HTML5 row events, refreshes draggable
rows after Vditor rebuilds them, exposes before/after indicators, and maps row ordinals only
against the current exact snapshot. It clears transient drag state on leave, Escape, rebuild,
and disposal. The exact transaction now publishes only after its local `setValue` suppression
ends and creates pre/post Vditor checkpoints so one undo/redo round-trip remains source-exact.

Focused evidence: 73/73 unit tests (`section-move`, outline tree and protocol routing), the
dedicated Chromium outline-reorder spec (1/1), and the build-first real-VS-Code outline-reorder
spec (1/1, 7.8 s). The real editor test drives the webview drag, checks one-step undo/redo,
invokes the actual registered Explorer controller through a `VMDE_E2E`-only seam, rejects a
stale drop, saves, and reopens. Scoped Biome and webview/real-suite type checks passed; build
passed. `main.js` measured 725,173 bytes (708 KiB) and 313 eager modules. The inherited
608 KiB/294-module reporting budgets remain exceeded; no ceiling was changed. Dependency
audits, aggregate quality, and broad suites were intentionally omitted under the active focused
validation waiver. The local queue files remain untracked and unchanged. No push.
