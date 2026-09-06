# Task 563 — Two-row editor toolbar

**Status:** ✅ DONE · **Origin:** user request, 2026-09-06
**Related:** Tasks 492, 505, 550–557 and 564

## Problem and goal

The current single-row toolbar moves too many actions into overflow as editor width shrinks.
The additional authoring controls planned in Tasks 550–557 increase this pressure. Use two
visible toolbar rows, with deliberate grouping and predictable access to editing controls.
The supplied screenshot shows the current overflow menu; its undefined Undo label is tracked
separately in Task 564 and must not depend on this layout change.

## Layout contract

- [x] Provide a two-row toolbar by default in editable modes. Use explicit row containers/group
      placement, not unconstrained flex wrapping that can produce three or more rows.
- [x] Row 1 prioritizes inline formatting and links: headings, bold, italic, strike, the planned
      subscript/superscript/underline actions, and Link. Row 2 groups structural insertion and
      navigation/view controls: lists/indentation, quote/callout/details, code/math, assets/table,
      anchor/picture insertion, undo/redo, and existing navigation/view actions.
- [x] Finalize exact group placement against the implemented inventory before coding. Maintain
      existing actions and logical separators; reserved future controls must not appear as inert
      placeholders. Tasks 551–557 may ship independently of this task.
- [x] Reconcile Tasks 551–557's initial More-menu placements with this two-row layout: promote
      their implemented actions into the appropriate row when space permits, while preserving
      one action instance/handler and the same overflow fallback. Math remains one shared menu.
- [x] **Project Owner update:** Keep Undo, Redo, and Emoji on the visible toolbar rows, outside
      More. Preserve their labels, keyboard access, disabled states, and existing handlers; keep
      Emoji in Row 1 and Undo/Redo in Row 2. Give these controls visible-space priority during
      resizing and verify them directly in normal and narrow supported editor/split layouts.
- [x] At narrow editor/split widths, overflow whole groups where practical into the existing More
      menu. Keep two rows, reachable overflow, and no clipped controls or horizontal page scroll.
      At wide widths retain two deliberate rows rather than reverting to a single long strip.
- [x] Update toolbar sizing/overflow measurement for both rows. Avoid observer feedback loops,
      duplicate controls, stale open menus, or moving a focused control without restoring focus.
- [x] Account for both rows in sticky positioning, content offsets, focus reveal and scroll
      calculations. Preserve the visible document position during resizing and mode switching.
- [x] Preserve accessible names, active/disabled states, shortcut hints, focus return and the
      existing keyboard navigation conventions; keyboard order follows visible row/group order.
      Menus must remain usable at zoomed text sizes and near either viewport edge.
- [x] Retain existing read-only Preview control availability and mutation restrictions.

## Implementation boundaries

Inspect `media-src/src/chrome/toolbar.ts`, `toolbar-overflow.ts`, toolbar focus/submenu helpers,
`media-src/src/main.css`, and the existing toolbar specs before choosing the smallest change.
Do not implement the syntax features as part of this layout task or introduce duplicate hotkeys.
This task supersedes only the placement decisions in Tasks 551–557 when integrated; their
syntax, accessibility, command and source-fidelity requirements remain authoritative.

## Project Owner scope transfer — Emoji picker (Task 566)

The Project Owner moved the Emoji picker opening/closing and keyboard/focus issue to
Task 566 to resolve with the new searchable picker. It is not a Task 563 closure requirement.
Task 563 retains the direct, visible Emoji toolbar control, its row placement and geometry,
and the independently verified pointer access. Generic toolbar/menu lifecycle cleanup remains
in Task 563.

The current trusted browser-input trace opens the live Emoji panel and another writer closes
it about 12 ms later. The closing writer and Escape focus-return behavior remain unresolved;
no passing OS-level keyboard verification is claimed. Task 566 owns that diagnosis, fix, and
regression acceptance. Preserve this limitation in Task 563's closure evidence.

## Verification

- [x] Focused overflow/group-placement unit coverage for two rows, width changes and hidden items.
- [x] Chromium geometry/interaction coverage at wide, normal and narrow split widths, including
      zoom, open-menu resize, keyboard traversal, no duplicates, and reachable overflow actions.
- [x] Build first, then a focused real-VS-Code spec under xvfb: two-row geometry, split resize,
      menu activation/focus return, editing/undo, mode switching and stable document viewport.
- [x] Inspect actual screenshots for spacing, grouping and clipping in light/dark themes.
- [x] Run applicable focused gates and the individually executed network-free quality components.
      Dependency audits and aggregate `npm run quality` are intentionally omitted under the
      Project Owner's queue-wide instruction; neither is reported as passing.

## Completion evidence

Two-row layout and direct Emoji/Undo/Redo placement are complete for the owner-approved scope.
Focused overflow units passed 18/18; menu-disposal regressions passed 2/2; Chromium passed 13/13;
the focused no-retry real-VS-Code suite passed 5/5; full unit coverage passed 3,771 tests across
262 files. Build, applicable typechecks, lint, Knip, JSCPD, and the coverage ratchet passed.
Actual VS Code light/dark screenshots were inspected. Dependency-cruiser exited zero but
inspected zero modules because TypeScript 7 is unsupported; that limitation is retained.

The passing real-VS-Code scope covers live two-row geometry, direct Undo/Redo tooltip and host
history, narrow split Emoji pointer/panel bounds, mode/viewport preservation, Preview restrictions,
and toolbar hide/reinitialization. The transferred Emoji keyboard/focus issue remains open in
Task 566. OS-level keyboard delivery was not verified in this harness (native handle 1 was not
an X11 client); no OS-input pass is claimed. Failed and corrected harness attempts are recorded
in the execution report rather than hidden by the final no-retry pass.

Dependency audits were intentionally omitted under the Project Owner's queue-wide waiver;
network-free quality components were checked individually. Full Chromium/FAST/full real-VS-Code
tiers were omitted under the queue's focused-testing policy. No future syntax buttons were added;
Tasks 551–557 own adding their controls to the established row/group contracts.

**Size report:** 628,335 bytes / 613.61 KiB, +5,057 bytes / +4.94 KiB versus Task 565; 296 eager
modules (+2). Existing ceilings are unchanged and reporting-only by Project Owner instruction.

