# Task 219 — Table column resize by mouse (spike-first)

**Status:** ⏸️ owner decision required — independent table operations complete; width-persistence gate retained · **Impact:** ⚪ low · **Origin:** task 192 §5

## Problem

No mouse column resizing (`responsive-tables.ts` is only an overflow-scroll wrapper).
BUT: markdown pipe tables cannot store column widths — so the core question is the
persistence story, and it may kill the feature.

## Scope

- [ ] **Spike (timeboxed):** decide persistence: (a) visual-only per-session widths
      (cheap, lost on reopen — is that useful enough?); (b) an HTML comment sidecar
      (`<!-- vmde:cols 120,80,* -->` above the table — round-trip risk, pollutes the doc
      for other viewers); (c) don't build it (record the decision in this file and close).
      Bring the options to the user with a demo — do not pick silently.
- [ ] If (a)/(b): drag handles on header cell borders (min-width clamp, double-click
      auto-fit), widths as `col` styles; interplay with `#fix-table-ir-wrapper` panel and
      responsive overflow wrapper.

## Column/row MOVE commands (added 2026-07-03 — independent of the resize spike, buildable now)

- [x] takumii.markdowntable parity (~246K installs): **move column left/right** and
      **move row up/down** in the existing table panel + hotkeys — the Vditor panel only
      inserts/deletes/aligns; reordering a column in WYSIWYG today means retyping every
      cell. One model edit through the normal pipeline, pipe-escape aware, one undo step.
      No persistence question (unlike widths) — this half is NOT gated on the spike.

## Cell-range selection (added 2026-07-03, WYSIWYG audit — prosemirror-tables pattern)

- [x] Drag across cells (or Shift+Arrow) selects a CELL RECTANGLE — the spreadsheet
      gesture users expect in tables. True multi-cell native selection is impossible in
      Chromium contenteditable (single-Range model), so do what prosemirror-tables does:
      a parallel fake-selection state painted as `.vmde-cell-selected` classes on
      existing td/th (class-only → Lute-safe). Ops over the range: Ctrl+C copies as TSV
      (text/plain) + markdown fragment, Delete clears cell contents, row/col insert-
      delete applies to the range; Esc drops the range (fits 288's ladder).
- [ ] **Merge cells: deliberately NEVER** — rowspan/colspan is not representable in GFM
      pipe tables (Toast UI resorts to custom syntax); record so nobody re-litigates.

## Out of scope

- Row height, column reorder by drag, alignment (exists via panel/hotkeys), merge cells
  (see above — permanent).

## Verification

- Spike exit: a decision + demo GIF/screenshot for the user (memory: show partial results
  for eval).
- If built — L2: drag changes width, clamps, `getValue()` byte-stable in mode (a) / exact
  sidecar in (b); table panel + hotkeys unaffected. L3 real-VS-Code: one leg incl.
  round-trip through save.

## Part 1 handoff — 2026-09-08

Reasoning performed on runner-selected `gpt-6-astra`, `reasoning_effort=medium`.
Caveman Mode unavailable; concise evidence fallback. Read the live queue, task/index,
DEVELOPMENT.md, Lute/testing skills and relevant source/tests. No implementation,
executable probes, acceptance runs or commits in this phase. Part 2 is assigned
`gpt-5.6-terra`, `reasoning_effort=high`. Existing Task 222 record edits belong to
another owner; do not change them. Both local queues remain untracked and unstaged.

### Readiness and retained decision

- Moves and rectangular selection are authorized now, independently of Tasks 222,
  256 and the width spike. Implement both IR and WYSIWYG editor surfaces; source mode
  remains ordinary source editing. Do not add a native context-menu command family
  merely because Task 215 is now complete: this task requests table panels + hotkeys.
- Widths remain an owner decision. Part 2 may make an isolated, disposable demo of
  session-only widths and a sidecar round-trip probe, then present screenshots plus
  options (a), (b), (c), consequences and a recommendation. Neither a shipped default
  nor a persistence format is authorized until the owner chooses. Keep this task
  open if the independent features finish before that decision.
- Correction to the old problem statement: `chrome/responsive-tables.ts` is NOT only
  an overflow wrapper. It forces fixed layout/100% width and strips width/min/max
  styles from `col`, `th`, `td` on mutations and resizes. A width demo must expose
  that conflict; changing production normalization belongs after the width decision.
- No merge cells, row heights, drag reorder, general table formatter, dependencies,
  vendor fork or broader command architecture. Preserve existing alignment controls.

### Reusable evidence and affected paths

- `media-src/src/editing/fix-table-ir.ts` owns the custom IR table panel and retained
  mouse selection. `table-hotkey.ts` maps only existing native Vditor alignment and
  insert/delete shortcuts: moves need a real command handler, not an invented native
  key dispatch. WYSIWYG has a separate Vditor panel; Part 2 must inspect its actual
  resolved source and extend both panels through the same operation dispatcher.
- `editing/table-source-selection.ts` maps ONE ordinary cell against a canonical
  snapshot using verified prefix/table/suffix partitions. It rejects cross-cell,
  ragged/spanned/nested/container tables and ambiguous backslash runs. Reuse its
  identity-proof approach, not its single-cell offsets as a rectangle mapper.
  `src/shared/md-scan.ts::splitRowCells` preserves raw cell text but uses a single
  negative lookbehind for escaped pipes; it is not a general parity-aware tokenizer.
  `src/markdown/table-pipe-escape.ts` and its backend test provide pipe-fidelity cases.
- `editing/html-subscript-command.ts` demonstrates revalidated retained targets,
  detached table canonicalization, rollback, native undo checkpoints and normal
  sync. `editing/rewrap-command.ts` provides checkpoint/history helpers;
  `bridge/edit-sync.ts` owns snapshot/exact snapshot, `postExact`, incremental seeds
  and normal invalidation/sync. Reuse the normal pipeline and its undo bridge.
  `postExact` alone does not prove undo-to-source fidelity or caret restoration.
- `editing/selection-scope.ts` owns Task 288's IR Escape/block ladder;
  `editing/escape-toolbar.ts` installs an earlier capture listener that arms
  Escape→Tab. Integrate rectangle dismissal before block widening while preserving
  the toolbar route. `util/caret-gesture.ts` supplies composition state and guards.
  `clipboard/clipboard-line.ts` expands collapsed copy/cut to a block: rectangle
  copy must intercept before that fallback, otherwise it copies the wrong scope.
- Proposed feature ownership: new `editing/table-operations.ts` (pure planner),
  `editing/table-actions.ts` (validated transaction/panel dispatcher),
  `editing/table-cell-selection.ts` (per-editor transient rectangle). Existing
  integration owners: `editing/fix-table-ir.ts`, `editing/table-hotkey.ts`,
  `editing/selection-scope.ts`, `boot/finish-init.ts`, `boot/main.ts`,
  `util/lang.ts`, `main.css`. Touch `esbuild-shared.mjs` and
  `test/backend/vditor-source-patches.test.ts` only if an anchored native WYSIWYG
  adapter is actually necessary. Avoid shared bridge changes unless the transaction
  probe proves a missing contract; return such evidence for bounded reasoning.

### Implementation contract and probes first

1. Prove a table-local edit in IR and WYSIWYG before wiring controls: identify the
   selected table against the current snapshot, transform one complete table, commit
   once, restore the logical moved cell/caret, undo once, redo once, then type and
   save. Include two identical tables and untouched noncanonical prose around them.
   If canonical rendering changes unrelated source, use the existing exact-source
   mapping/history route with a proved mapping; never normalize the entire document
   or match the first identical table by text. Revalidate mode, snapshot, selection,
   table identity and composition immediately before mutation. No-op means no edit,
   dirty change or undo entry. Rollback must restore selection as well as content.
2. Pure planner uses row/column coordinates on a rectangular GFM table. Swap an
   entire column across header, delimiter/alignment row and every body row. Swap body
   rows intact; keep the required header/delimiter structural pair fixed (header
   move and first-body-up/last-body-down are disabled). Columns at either boundary
   are likewise disabled. Move cell raw source, including inline markup and escaped
   pipes; alignment follows its column. Preserve surrounding bytes, EOLs, terminal
   newline state and untouched cells. Explicitly test empty cells, code-span pipes,
   backslash parity, Unicode, optional outer pipes and duplicate cell text.
3. Track `{table, anchorRow, anchorCol, focusRow, focusCol, snapshot/generation}`
   outside editable DOM. Paint only `.vmde-cell-selected` on existing cells; never
   mark actual cell content `data-render`, which would delete it on serialization.
   Leave same-cell pointer dragging as normal text selection; start rectangle capture
   when dragging crosses a cell boundary. Clamp within one table; handle backward
   drags, pointer cancellation and scrolling. Shift+Arrow extends from the active
   cell or existing rectangle, with opposite arrows shrinking/reversing it. Keep
   unmodified arrows and ordinary text editing usable after dismissal.
4. Selection-only gestures emit no edit/history entry and preserve serialized bytes.
   Clear or explicitly remap state on input, composition start, undo/redo, mode switch,
   external document update, rerender, detached table, click outside and disposal.
   Never retain stale cell nodes across Lute spin or assume classes survive a rebuild.
   Escape clears the rectangle first; a later Escape can use the existing ladder.
5. Ctrl/Cmd+C with a rectangle writes TSV to `text/plain` plus a GFM fragment to
   `text/markdown` in the synchronous copy event. Build Markdown from cell source,
   not `textContent`; TSV uses visible cell text. Test tabs/newlines and inline markup
   explicitly. A body-only fragment can use its first selected row as the fragment's
   header with an appropriate delimiter row; copying must never mutate the original.
   Intercept only when a valid rectangle exists. Prevent native cut/type-over from
   operating on an unrelated collapsed Range; preserve ordinary clipboard behavior
   once the rectangle is dismissed. Range cut/paste expansion is not added scope.
6. Delete clears selected cell contents in one transaction. Insert/delete row/column
   controls act on the rectangle's covered rows/columns, not repeated native key
   loops: insert the selected count adjacent to the range, delete the selected span.
   Define and test header inclusion/all-rows/all-columns behavior against the native
   table structural contract before adopting it; the result must remain valid GFM or
   intentionally remove the entire table, never leave a separator without a header.
   Reject unsupported spanned/nested/ragged HTML tables without mutation.
7. Both panels call one dispatcher and expose labelled, keyboard-reachable buttons
   with accurate disabled states. Keep retained selection on mouse activation and
   restore it on keyboard activation. Choose conflict-checked table-local move chords
   after inspecting existing Vditor/VS Code bindings; do not steal Shift+Arrow for moves
   or introduce AltGr text-input conflicts. Read CSS/theming and path-scoped rules
   before implementation; use existing theme variables for a visible selection in
   light/dark/high-contrast and narrow/split layouts. Announce range dimensions via
   accessible status UI outside source content; do not turn the editor into a new grid.

### Required Part 2 evidence

- Units: planner/source fidelity, rectangle bounds and direction, disabled/no-op
  decisions, clipboard payloads and rejected stale/unsupported targets. Add focused
  `.test.ts` files alongside the pure modules; run via the live root `npm test --`
  command/config (the skill's older `.ts` config example is not authoritative).
- Extend `media-src/e2e/harness.ts` and `table-hotkey.spec.ts` or register a focused
  table harness through `harness-entries.mjs`; import `coverage-fixture`. Cover both
  modes, actual panel clicks and keys, drag/Shift+Arrow, Escape→Tab, IME no-op, existing
  insert/delete/alignment, source invariance, one-step undo/redo and next typing.
  `getValue()` and `serializeForHost()` must agree with selection classes present.
- Add and RUN `test/vscode-e2e/table-operations.spec.ts` with a privacy-safe fixture.
  After `node build.mjs`, use `env -u ELECTRON_RUN_AS_NODE xvfb-run -a npm --prefix
  test/vscode-e2e test -- table-operations.spec.ts --retries=0`. Verify both modes,
  native clipboard/host document/save-reopen, logical caret and narrow/split controls.
  Reuse `table-nav-scroll.spec.ts`, `structural-selection.spec.ts` and paste-table
  fixtures as regression references. Use focused Chromium coverage and inspect new
  source lines; run the applicable routine real-VS-Code tier and implementation gates
  from DEVELOPMENT.md under current owner waivers. Only one real-VS-Code run at once.
- Live Task 222 records the shared mapped-XTEST prerequisite as failed (native XID
  `0x1`, invalid drawable). Do not repeat the unchanged prerequisite or call Playwright
  keys OS-input evidence. This limits OS acceptance only; it does not prevent pure,
  Chromium, scripted real-VS-Code work or the independent width demo.
- Preserve acceptance checkboxes until evidence exists. Record actual Part 2
  model/effort, probes, commands/results, changed-line coverage, bundle bytes/eager
  modules and remaining width/OS decisions. Task/index closure waits for all required
  acceptance and owner decision; local commits exclude both queue files. No push.

**Part 1 result:** ready for the lower-model transaction probe and independent table
implementation. Width spike execution/demo and all implementation/acceptance evidence
remain outstanding; no product persistence choice or test pass is claimed.

## Part 2 progress — 2026-09-08

Implementing/validation completed by `gpt-5.6-terra`, `reasoning_effort=high`.
No width persistence choice was made and no production width normalization changed.

- Shipped `table-operations.ts`, an exact-source GFM planner for whole-column/whole-body-row moves,
  raw source rectangle fragments, clear, and range-sized insert/delete. It retains raw cell text,
  delimiter alignment, CRLF, optional outer pipes, duplicate-table identity and surrounding bytes;
  header/delimiter remain structural, while all-row/all-column deletes intentionally remove the
  table rather than emit invalid GFM.
- Shipped one IR/WYSIWYG class-only rectangle controller and one exact transaction dispatcher.
  Cross-cell drag and Shift+Arrow paint existing cells only; first Escape dismisses, IME/input clear
  stale state, TSV uses visible text, and `text/markdown` uses raw source (including inline markup
  and escaped pipes). Delete/Backspace clears once; panel operations insert/delete the full selected
  span. WYSIWYG receives labelled move/range controls without replacing Vditor's existing controls.
- The transaction reuses exact edit-sync/history state and restores the logical moved cell through
  the shared caret mechanism after Vditor's post-`setValue` render. A real VS Code regression proves
  noncanonical CRLF source with two identical tables: first-table move only, logical caret, exactly
  one scripted undo/redo, save, and reopen all preserve the expected host/disk bytes. This is DOM
  automation, not OS-input evidence; the Task 222 XTEST limitation was not rerun and is not an
  independent Task 219 blocker.
- Verification: focused units `13/13`; targeted line coverage is `94.64%` for the planner and
  `76.66%` for the controller (interaction branches are covered in Chromium); `npm run typecheck`,
  `npm run typecheck:vscode-e2e`, focused Biome, and `node build.mjs` pass. Chromium table coverage
  is `26/26`; focused real VS Code `table-operations.spec.ts --retries=0` is `2/2`, covering both
  modes, WYSIWYG panel injection, raw clipboard, range insertion, exact source/history/caret, save
  and reopen. Built webview entry is 725.1 kB; no aggregate quality/audit, visual golden, or broad
  real-VS-Code tier was run under the explicit owner waiver.
- `tasks/README.md` has no open-task index entry to update. Both local queue files remain untracked,
  unstaged and uncommitted. The only remaining Task 219 blocker is the explicit width-persistence
  owner decision below.

### Width spike evidence (no product decision)

`responsive-tables.ts` confirms the handoff's conflict in the current source: each initial pass,
resize and relevant table mutation forces `table-layout: fixed` plus `width: 100%`, then removes
`width`, `min-width` and `max-width` from every `col`, `th` and `td`. Therefore a session-only
`<col style="width:…">` drag demo is visibly reset on the next observer pass, while a sidecar
comment is not merely a persistence choice: it would additionally need a deliberately scoped
normalizer exemption and exact comment round-trip proof. No screenshot was retained because no
production demo was authorized. Options for owner review remain: (a) explicitly change responsive
normalization and ship volatile session widths; (b) define a visible comment sidecar and its
cross-viewer cost; or (c) retain responsive GFM tables with no resize feature. Recommendation:
choose (c) unless a user explicitly accepts either volatility or document pollution.

## Review repair — 2026-09-08

Follow-up implementation/validation remained `gpt-5.6-terra`, `reasoning_effort=high`.

- Replaced the pipe-line source scan with a fence-length-aware GFM candidate scan. It rejects
  fenced, indented-code, quote, and list contexts; supports one-column/header-only tables; keeps
  EOF line endings attached to positions rather than moved rows; and refuses destructive final
  row/column deletion. A DOM table must be a source-addressable top-level rectangular table, and
  its ordinal, candidate count, and normalized rendered cells must agree with exact source before
  a transaction or raw clipboard fragment proceeds. Ambiguous/mismatched state is a no-op.
- Hardened transient rectangle state: ordinary other-cell/outside clicks, pointer cancellation,
  beforeinput/cut, composition start, history keys, detached-table mutations, mode-panel clicks,
  and disposal clear it. Native edits are prevented while a rectangle is armed. Transactions now
  revalidate source/render/mode/root identity immediately before commit, roll back a thrown
  `setValue`, and place a bounded fallback caret if a structural operation removes its original
  target.
- Added IR move chords (`Ctrl/Cmd+Shift+[`, `]`, `PageUp`, `PageDown`) without stealing
  Shift+Arrow. Boundary and destructive-last-column actions are disabled in the IR panel. The
  existing WYSIWYG insert/delete buttons now consume a live rectangle before Vditor's single-cell
  handler, while custom WYS controls are move-only.
- Focused unit evidence is 23/23, with changed-line coverage 97.14% planner / 80.62% controller;
  focused Chromium table coverage is 29/29. Typechecks and focused Biome pass. Focused real VS
  Code ran source-invisible clipboard in both modes and the exact CRLF move/history/save/reopen
  regression successfully; the added WYS range/history/IME regression is retained alongside them.
- Authorized disposable width evidence: `tmp/task219-width-demo-reset.png` records a `240px`
  session-only cell width before the responsive-table resize pass and no width afterward; the demo
  test passed 1/1 and was deleted. This confirms session-only drag widths cannot survive the
  current normalizer. The product owner must still choose: (a) change the normalizer for volatile
  widths, (b) accept a visible sidecar format, or (c) retain no resize feature. No option was
  selected.

## Second review repair — 2026-09-08

- Deleting one column from an optional-pipe table now writes explicit outer pipes, keeping the
  surviving one-column result unambiguously valid GFM. Armed-but-rejected range operations clear
  their rectangle and consume the panel event, so neither IR nor WYSIWYG falls through to Vditor's
  destructive one-cell command; no rectangle still preserves native behavior.
- IR/WYSIWYG move chords accept both the logical bracket keys and actual shifted `{`/`}` values.
  WYSIWYG now disables its native/custom move and destructive controls at boundary/one-column
  states, matching the IR panel. Caret lookup uses the same filtered source-addressable table list
  as identity mapping; deferred placement validates transaction generation, inner owner, mode and
  root. Rollback restores the captured Range when still live, otherwise the original cell fallback.
- Units now include optional-pipe one-column deletion (24 focused assertions). Chromium stayed
  29/29. The real WYS range/history/IME spec was corrected to rearm before composition. Three
  bounded real-VS-Code invocations reached VS Code 1.129.0 and its test server but exited before a
  terminal test result, each leaving an orphan lock; Astra-low diagnosed runner/process loss rather
  than a spec assertion. No further identical rerun was attempted. This is recorded as an
  environment-limited verification gap, not a pass.

## Final review repair — 2026-09-08

- WYSIWYG refreshes disabled controls on every table selection change even after its move group is
  already present. It derives destructive row/column disablement from the live rectangle, including
  header coverage and full-column coverage, rather than only the collapsed caret cell.
- Deferred table caret restoration now captures expected exact/rendered document state and is
  invalidated by ordinary input and accepted external table mutations. It restores only when owner,
  mode, root, transaction generation, exact bytes, and rendered bytes still agree.
- Transaction rollback snapshots Vditor undo/redo arrays before either checkpoint and restores those
  arrays with original content and selection fallback if `setValue` throws. Focused units pass 24/24;
  the focused WYS Chromium control regression passes. The single required no-retry real WYS attempt
  again reached VS Code 1.129.0 but ended before a terminal Playwright result, matching the already
  documented orphan-runner failure; no additional identical retry was run.

## Undo rollback repair — 2026-09-08

- Table transaction rollback now snapshots/restores Vditor's `undoStack`, `redoStack`, `lastText`,
  and `hasUndo` on the exact active mode slot, verifies the slot identity before restoring, and calls
  Vditor's `resetIcon` helper to refresh undo/redo toolbar state. The failure-injection regression
  mutates state as a failed second checkpoint would, restores it, then performs a simulated typed
  edit plus undo/redo from the restored baseline. Focused units are 25/25 and Chromium remains
  29/29; typecheck, focused Biome, and `node build.mjs` pass. Per the known runner limit, no new
  real-VS-Code retry was made for this change.
