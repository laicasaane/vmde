# Task 569 — Put the list-item fold control below its marker

**Status:** 📋 TODO · **Impact:** 🟡 list-fold interaction and visual polish ·
**Origin:** Project Owner request, 2026-09-24 · **Depends on:** Tasks 258 and 259 ·
**Related:** Tasks 546, 548, and 565

## Problem and current state

Task 258 already folds a list item with a direct nested `<ul>` or `<ol>` by hiding that child list,
without changing Markdown. Its state survives DOM replacement, mode changes, and reopening. The
completed heading follow-ups made the heading control always visible, placed `▼`/`▶` beneath the
heading marker, and gave its rendered gutter a bounded two-axis pointer target.

List folding still uses the original presentation and hit test. In `media-src/src/main.css`, the
expanded `<li>::after` is `⌄` with `opacity: 0` until hover; the collapsed pseudo-element starts
with `›` and a count hint. Its `top: 0` places the symbol beside the list marker. In
`media-src/src/nav/section-fold.ts`, a list click is accepted whenever
`clientX <= li.getBoundingClientRect().left + 10`, with no lower X or Y bound. The current Chromium
list test toggles at the caret; the real-VS-Code journey exercises the list chord and persistence,
but neither proves trusted pointer geometry on the list control. A local render of the existing
unordered fixture confirmed the expanded glyph is invisible before hover in both IR and WYSIWYG.
Task 259 is adding block handles in the nearby gutter, including handles for list items; finish its
placement work before integrating this control so both targets can be verified together.

## Interaction and visual contract

- [ ] Show `▼` for every expanded, foldable list item and `▶` for its collapsed state, without
      requiring hover, focus, or caret placement. Keep the triangle glyph at the heading control's
      12 px size, theme-aware color, and pointer cursor. A collapsed count hint may remain after
      `▶` if it stays legible and does not invade editable text or another control.
- [ ] Place the painted triangle **below the owning item's list marker** in the same left gutter,
      with visible spacing comparable to the heading control's 3 px glyph offset. Align it with
      the marker at each nesting depth. Cover unordered bullets and ordered numbers, including
      multi-digit numbers, in both IR and WYSIWYG. The control must stay with the owning item's
      first line when its text wraps or the list is loose.
- [ ] Give the triangle a rendered 36×24 px pointer box, as for headings. For ordinary bullet and
      numbered items, make the visible marker, intervening gap, and triangle one contiguous,
      bounded two-axis click target; the combined target may be taller or wider than 36×24 px to
      enclose the actual marker. A trusted click anywhere inside toggles that item exactly once.
      Derive hit geometry from the rendered control and marker layout, not from an open-ended
      `clientX` threshold or a second disconnected TypeScript rectangle. Native list markers are
      not heading `::before` markers, so prove the chosen marker geometry in both edit modes.
- [ ] Keep that target within the owning list gutter. It must not cover the item's text, its
      first-character caret position, links or other inline controls, another item's marker or
      text, or the first child-list item. Clicks immediately outside every target edge must keep
      native Vditor behavior and must not persist a fold-state change. Do not shift list
      indentation, text origin, marker placement, or neighboring block layout to make room.
- [ ] Keep Task 259's block handles reachable and distinct from the list-fold target, including
      a parent arrow beside a nested child's handle and the narrow-pane right-edge fallback.
      Hovering or clicking one control must not activate the other. Adjust handle placement if
      needed rather than allowing overlapping pointer boxes.
- [ ] For task-list items, retain the checkbox's native click and keyboard behavior. If its
      checkbox occupies the marker region, use a bounded arrow-and-gap fold target that excludes
      the checkbox; clicking the checkbox must never fold the list. Items without a direct child
      `<ul>` or `<ol>` show no fold control and have no fold hit target.
- [ ] A successful list click hides or restores only that item's direct nested-list subtree.
      Preserve the existing keyboard command/chord, automatic reveal for hidden descendants,
      per-document persistence, mode/DOM-rebuild recovery, one-step toggles, and exact Markdown
      and saved-file bytes. Keep the affordance view-only and serializer-safe. Do not change
      heading folding or its geometry.

## Implementation guidance

- [ ] Add a named list-gutter hit-test contract in `media-src/src/nav/section-fold.ts`, with
      finite-geometry and foldable-item guards. Run `toggleAt()` and cancel the click only after
      a successful hit; rejected clicks must pass through unchanged.
- [ ] Give the list `::after` an explicit geometry contract in `media-src/src/main.css`. Keep
      marker, arrow paint, and pointer bounds separately understandable, as in the heading
      control. Handle tight/loose lists, wrapped parent text, nested levels, ordered markers,
      and task-list checkboxes without adding editable DOM content.
- [ ] Extend the existing section-fold harness or fixture only as needed. Keep the source and
      coverage changes scoped to list-fold affordances, any necessary Task 259 handle clearance,
      and the existing fold/handle tests.

## Acceptance and verification

- [ ] RED/GREEN unit coverage in `media-src/src/nav/section-fold.test.ts` for target center,
      marker, gap, triangle, all outer edges, immediately-outside points, malformed geometry,
      non-foldable items, and checkbox exclusion. Heading hit-test cases remain green.
- [ ] Focused `media-src/e2e/section-fold.spec.ts` coverage in IR and WYSIWYG uses trusted pointer
      coordinates for expanded and collapsed states. Assert non-hover visibility, `▼` → `▶` →
      `▼`, exactly one toggle/persist per accepted click, outside/text/checkbox negatives,
      only the intended child subtree hidden, and exact `getValue()` before and after.
- [ ] Numeric geometry checks cover bullet, single- and multi-digit ordered, nested, tight,
      loose, wrapped, and task-list parents. Prove the 12 px glyph, 36×24 px arrow box, marker
      and gap inclusion where applicable, no text or neighboring-item overlap, and stable text
      and marker origins in both modes at representative narrow and wide editor widths. Include
      numeric nonintersection and trusted pointer checks for the Task 259 handle.
- [ ] Add element-scoped expanded/collapsed list-gutter `@visual` goldens; inspect both PNGs and
      update no unrelated baselines. Preserve the existing heading goldens.
- [ ] After `node build.mjs`, extend and run the focused no-retry
      `test/vscode-e2e/section-fold.spec.ts` in the real VS Code webview with trusted list-marker,
      gap, and triangle clicks, plus text/checkbox negatives. Cover mode rebuild, persistence,
      descendant reveal, and exact host and saved-file bytes.
- [ ] Run the applicable focused coverage, lint/typechecks, and `npm run quality` per
      `DEVELOPMENT.md` and the repository testing skill. Record actual outcomes and any
      environmental limits in this task before closing it.

## Out of scope

New foldable block types, changing which list items qualify, changing fold-state storage or
commands, moving the list text column, and revising heading-fold controls.
