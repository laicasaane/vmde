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
