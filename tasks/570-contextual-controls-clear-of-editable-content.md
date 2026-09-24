# Task 570 — Keep contextual floating controls clear of editable content

**Status:** 📋 TODO · **Impact:** 🔴 editing visibility and pointer access ·
**Origin:** Project Owner report, 2026-09-24 · **Related:** Tasks 191, 285, 297, and 527

## Problem and current evidence

While editing a blockquote, its floating controls can sit on top of the quote and hide
the text underneath. The same placement problem must be checked for other Markdown
elements that show contextual controls. The desired result is to keep the active text
readable and editable while its controls remain close enough to use.

The IR quote/callout panel in `media-src/src/editing/callouts.ts` is currently placed at
the blockquote rectangle's `right - 260` and `top + 8`, which puts it inside the quote
for ordinary block widths. WYSIWYG uses Vditor's native floating block popover; VMDE
adds callout controls to that popover. The IR table panel in
`media-src/src/editing/fix-table-ir.ts` is positioned relative to the active cell, and
the selection bubble uses `media-src/src/chrome/floating-overlay.ts`. These are
different placement paths. The blockquote overlap is the reported defect; whether the
other panels obscure their active content needs measurement before changing them.
Existing callout and table tests primarily prove visibility, actions, and Markdown
fidelity, rather than clearance from the text being edited.

## Part 2 rendered measurement checkpoint (2026-09-24; no placement fix yet)

A read-only Chromium probe used the existing source harnesses with synthetic Markdown at
1200 × 800 and 520 × 800. Rectangles below are viewport coordinates in CSS pixels.
The callout harness supplies IR/WYSIWYG quote controls; the table, selection-bubble,
and block-handle harnesses supply their shipped surfaces. A separate no-retry real
VS Code probe used a synthetic file and fresh built artifacts; its temporary spec was
removed after the run. The real webview was 552 × 686 despite a requested wider
Playwright viewport, so it is evidence for a narrow pane only. Exact host document
and saved-file bytes stayed unchanged in that probe.

| Surface | Rendered measurement and positioning owner | Checkpoint |
| --- | --- | --- |
| IR plain quote and callout | `callouts.ts` places a body-owned fixed panel at `quote.right - 260`, `quote.top + 8`, without reading panel size. At 520 px, plain quote `x11..509, y152..173` and panel `x249..613.8, y160..192`; callout panel reaches `x684.2`. In the real 552 px webview, plain quote `x52..500, y159.6..180.6`, text `x69.2..279.9, y161.2..178`, panel `x240..609.8, y167.6..201.2`. The final text glyphs intersect the panel and 57.8 px of it extends beyond the viewport. Real callout panel extends to `x679.3`. | **Fail: confirmed overlap and clipping.** |
| IR quote after editor scroll | On a wrapped 168 px-high quote at 520 px, editor scroll moved the quote and caret up 80 px (`quote y236..404 → 156..324`, caret `y238..254 → 158..174`), while the panel stayed at `y244..276`. `callouts.ts` returns early for an unchanged block/source signature and has no scroll/resize reposition listener. | **Fail: confirmed stale placement.** |
| WYSIWYG plain quote and callout | Native Vditor `setPopoverPosition` (`highlightToolbarWYSIWYG.ts`) places the popover 21 px above the target offset, then clamps its top to `-8`. At 520 px, plain quote `y152..173`, caret `y154..170`, and panel `y134..166`: panel intersects the caret line and reaches under the toolbar (`bottom 142`). At 1200 px the same plain-quote overlap occurs (`quote y47..68`, panel `y29..61`). The 520 px callout panel `y134..166` intersects the quote/title rectangle `y152..210`, while its editable body starts at `y181`. In the real 552 px webview, the WYS plain-quote panel `x52..496.4, y138.8..174` intersects text/caret `y161.2..178`. | **Fail: confirmed plain-quote caret overlap; callout violates whole-quote clearance.** |
| WYSIWYG native heading/code/link/image | At 520 px, heading panel `y155..176` abuts heading `y176..215`; code panel `y145..166` abuts code `y166..188.6`. The link panel `x11..34, y134..155` intersects the link glyph rectangle `x25..88.1, y154..170` by about 1 px at its corner. The image popover `x11..426, y145..166` abuts the 1 × 1 px image at `y166`; this fixture is too small to establish useful image clearance. Native positioning uses the same Vditor path. | **Heading/code: text clear in sampled position. Link: edge contact/overlap. Image: inconclusive.** |
| IR table controls | `fix-table-ir.ts` anchors 25 px above the active cell and CSS translates the compact panel left by 25 px. At 520 px, active cell `x11.5..260, y154.5..191.5`, compact control `x-13.5..7.5, y129.5..150.5`. The active cell is clear, but most of the control is outside the viewport; simulated expanded state remained at `x-13.5..9.5` and grew vertically. | **Fail: clipping/reachability at narrow left edge; active cell clear.** |
| WYSIWYG table controls | Native Vditor panel at 520 px `x11..362.2, y99..120` intersects the table's top/header edge `y117..192`, but the active data cell begins at `y154.5`. It also overlaps the toolbar (`bottom 107`). | **Active cell clear; fail toolbar/edge clearance in sampled top position.** |
| Task 285 selection bubble | Body-owned `floating-overlay.ts` positions against the selected range. At 520 px, selection `x11..49.8, y14..30`, bubble `x8..305.9, y38..74`: selected text is clear and panel is on-screen. | **Pass for sampled selection; edge/scroll fallbacks still need the task's focused tests.** |
| Task 259 block handle/menu | At 520 px, block `x11..509, y117..138`, right-fallback handle `x497..509, y119..141`, opened menu `x349..509, y143..228`. At 1200 px the handle is in the left gutter `x148..160` beside a block starting at `x200`; its menu starts below at `y73`. | **Pass for sampled narrow and normal positions; distinct gutter control, not a quote popover.** |

The Chromium long-quote probe also showed that the WYSIWYG native panel follows an
80 px editor scroll but then intersects the first caret line near the scroller top:
`panel y135..167`, caret `y158..174`, toolbar bottom `141`. The IR panel did not
follow the scroll. The temporary real VS Code probe passed **1/1 with no retry** and
verified host/saved bytes, but its longer fixture did not produce a nonzero real
editor `scrollTop`; the real WYSIWYG callout panel also retained the previous plain
quote position after a synthetic caret move, so that one reading is a retargeting
lead rather than a confirmed normal interaction. A complete real scrolled/narrow
acceptance spec remains required after implementation. No product source was changed
in this measurement checkpoint.

## Scope and interaction contract

- [ ] Inventory the **currently shipped element-attached floating controls** in IR and
      WYSIWYG, recording the owning Markdown element, source of positioning, visible
      dimensions, and behavior at normal and narrow editor widths. Include plain
      blockquotes and callouts, IR and WYSIWYG table controls, and any native
      WYSIWYG heading, code, link, or image popovers that appear while editing.
      Check the selection bubble as a related selection-attached surface. Record
      which controls already satisfy this task and which require a change.
- [ ] For a plain blockquote and a callout in both edit modes, opening or using the
      contextual controls must leave the quote's editable text, caret line, and
      selection unobscured. Where the viewport has room, the visible control panel
      must sit outside the owning blockquote's rendered rectangle with a perceptible
      gap, rather than on top of its border or content.
- [ ] Apply the same clearance rule to each other shipped element-attached panel
      found in the inventory. A control must not cover the text or active cell of
      the element it operates on. Keep its relationship to that element clear; do
      not solve overlap by leaving a panel at the editor corner or far from its
      target.
- [ ] Measure the **rendered** target, editable content, panel, viewport, and editor
      scroll container. Choose an adjacent position that fits on screen. Near pane
      edges or in a narrow viewport, use a reachable fallback that still leaves the
      active caret line and text visible; controls may compact or move to a safe
      edge if needed. Do not leave controls clipped, underneath the pinned toolbar,
      or over the active text when the preferred side has no room.
- [ ] Keep placement correct as the caret moves within a block, its content wraps
      or grows, the editor scrolls or resizes, and modes change. Hide or retarget
      stale panels. Panel pointer targets must not intercept clicks meant for the
      underlying Markdown; the editor selection and scroll position must not jump
      merely because a panel appears or moves.
- [ ] Preserve existing actions, keyboard reachability, focus return, IME behavior,
      and dismissal rules. Keep controls outside serialized Markdown, with exact
      `getValue()` and saved-file bytes unchanged by showing, moving, or hiding them.
      Preserve the one-undo behavior of actions that edit the document.

## Implementation guidance

- [ ] Start with a focused blockquote reproduction in both modes and capture panel,
      block, text, caret, and viewport rectangles in Chromium and the real VS Code
      webview. Use those measurements to select placement rules; do not assume all
      surfaces share one DOM owner or coordinate system.
- [ ] Fix IR quote placement in `callouts.ts`. For WYSIWYG, inspect Vditor's native
      popover positioning and change its source or the build patch only if needed;
      never edit generated `media/vditor/dist/` output. Evaluate the IR table path
      in `fix-table-ir.ts` and the shared `floating-overlay.ts` path against the same
      contract. Reuse a geometry helper where it reduces duplication without
      forcing unrelated popovers into a new control system.
- [ ] Coordinate with Task 285's in-progress selection bubble and Task 297's planned
      link popover so their shared overlay primitive follows this placement contract.
      Do not implement Task 297's link actions here. Task 191's planned WYSIWYG
      popover battery must check useful anchoring **and** non-overlap, rather than
      accepting any position merely because it is away from `(0, 0)`.

## Acceptance and verification

- [ ] Add focused geometry tests for preferred placement and each fallback: top,
      bottom, left and right edges; a tall or wide panel; narrow editor; scroll
      offsets; content growth; and invalid or disconnected targets. Assert that
      the chosen visible panel does not intersect the active text or caret line.
- [ ] In Chromium, cover ordinary and multi-paragraph blockquotes and callouts in
      both IR and WYSIWYG. Place the caret near the first and last lines, scroll
      the block near each viewport edge, and resize to a narrow pane. Assert
      numerical nonintersection with the whole quote when room exists, and with
      its editable text in every supported fallback. Confirm trusted panel clicks
      still perform their original action and underlying text remains clickable.
- [ ] Cover every additional shipped element panel that the inventory identifies
      as overlapping content, with at least one representative edge case per
      distinct placement path. Keep a completed inventory and pass/fail matrix in
      this task record so “other elements” has a reviewable closure criterion.
- [ ] After `node build.mjs`, add and run a focused no-retry
      `test/vscode-e2e/` spec for blockquote/callout placement in the actual VS
      Code webview. Include a narrow pane and a scrolled document, numeric
      panel/text rectangles, keyboard focus and return, and exact host and saved
      Markdown. Exercise other changed placement paths there as needed.
- [ ] Run applicable focused unit, Chromium, typecheck/lint, and `npm run quality`
      gates from `DEVELOPMENT.md`. Record actual commands, results, and any
      environmental limits here before marking the task complete.

## Out of scope

Adding or redesigning formatting actions, the pinned toolbar and its dropdowns,
generic hover tooltips, link editing behavior from Task 297, and unrelated
Markdown rendering or source-format changes.
