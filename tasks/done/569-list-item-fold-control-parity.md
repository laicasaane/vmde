# Task 569 — Put the list-item fold control below its marker

**Status:** ✅ DONE (2026-09-24) · **Impact:** 🟡 list-fold interaction and visual polish ·
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
Task 259 supplies source-owned group handles in the nearby gutter. This task verifies their
placement beside list-fold controls without changing which source groups receive handles.

## Interaction and visual contract

- [x] Show `▼` for every expanded, foldable list item and `▶` for its collapsed state, without
      requiring hover, focus, or caret placement. Keep the triangle glyph at the heading control's
      12 px size, theme-aware color, and pointer cursor. A collapsed count hint may remain after
      `▶` if it stays legible and does not invade editable text or another control.
- [x] Place the **painted ▼/▶ glyph itself directly beneath and horizontally centered on the
      actual rendered symbol of its owning `<li>`** in the same left gutter; centering only its
      wider 36×24 pointer box or placing the glyph alongside the symbol does not satisfy this
      requirement. Keep visible vertical spacing comparable to the heading control's 3 px glyph
      offset. Derive alignment from each bullet, ordered marker (including multi-digit numbers),
      or task checkbox at every nesting depth in both IR and WYSIWYG. The control must stay with
      the owning item's first line when its text wraps or the list is loose. Assert the painted
      glyph center against the measured symbol center numerically and inspect expanded/collapsed
      IR/WYSIWYG screenshots.
- [x] Give the triangle a rendered 36×24 px pointer box, as for headings. For ordinary bullet and
      numbered items, make the visible marker, intervening gap, and triangle one contiguous,
      bounded two-axis click target; the combined target may be taller or wider than 36×24 px to
      enclose the actual marker. A trusted click anywhere inside toggles that item exactly once.
      Derive hit geometry from the rendered control and marker layout, not from an open-ended
      `clientX` threshold or a second disconnected TypeScript rectangle. Native list markers are
      not heading `::before` markers, so prove the chosen marker geometry in both edit modes.
- [x] Keep that target within the owning list gutter. It must not cover the item's text, its
      first-character caret position, links or other inline controls, another item's marker or
      text, or the first child-list item. Clicks immediately outside every target edge must keep
      native Vditor behavior and must not persist a fold-state change. Do not shift list
      indentation, text origin, marker placement, or neighboring block layout to make room.
- [x] Keep Task 259's block handles reachable and distinct from the list-fold target, including
      a parent arrow beside a nested child's handle and the narrow-pane right-edge fallback.
      Hovering or clicking one control must not activate the other. Adjust handle placement if
      needed rather than allowing overlapping pointer boxes.
- [x] For task-list items, retain the checkbox's native click and keyboard behavior. If its
      checkbox occupies the marker region, use a bounded arrow-and-gap fold target that excludes
      the checkbox; clicking the checkbox must never fold the list. Items without a direct child
      `<ul>` or `<ol>` show no fold control and have no fold hit target.
- [x] A successful list click hides or restores only that item's direct nested-list subtree.
      Preserve the existing keyboard command/chord, automatic reveal for hidden descendants,
      per-document persistence, mode/DOM-rebuild recovery, one-step toggles, and exact Markdown
      and saved-file bytes. Keep the affordance view-only and serializer-safe. Do not change
      heading folding or its geometry.

## Implementation guidance

- [x] Add a named list-gutter hit-test contract in `media-src/src/nav/section-fold.ts`, with
      finite-geometry and foldable-item guards. Run `toggleAt()` and cancel the click only after
      a successful hit; rejected clicks must pass through unchanged.
- [x] Give the list `::after` an explicit geometry contract in `media-src/src/main.css`. Keep
      marker, arrow paint, and pointer bounds separately understandable, as in the heading
      control. Handle tight/loose lists, wrapped parent text, nested levels, ordered markers,
      and task-list checkboxes without adding editable DOM content.
- [x] Extend the existing section-fold harness or fixture only as needed. Keep the source and
      coverage changes scoped to list-fold affordances, any necessary Task 259 handle clearance,
      and the existing fold/handle tests.

## Acceptance and verification

- [x] RED/GREEN unit coverage in `media-src/src/nav/section-fold.test.ts` for target center,
      marker, gap, triangle, all outer edges, immediately-outside points, malformed geometry,
      non-foldable items, and checkbox exclusion. Heading hit-test cases remain green.
- [x] Focused `media-src/e2e/section-fold.spec.ts` coverage in IR and WYSIWYG uses trusted pointer
      coordinates for expanded and collapsed states. Assert non-hover visibility, `▼` → `▶` →
      `▼`, exactly one toggle/persist per accepted click, outside/text/checkbox negatives,
      only the intended child subtree hidden, and exact `getValue()` before and after.
- [x] Numeric geometry checks cover bullet, single- and multi-digit ordered, nested, tight,
      loose, wrapped, and task-list parents. Prove the 12 px glyph, 36×24 px arrow box, marker
      and gap inclusion where applicable, no text or neighboring-item overlap, and stable text
      and marker origins in both modes at representative narrow and wide editor widths. Include
      numeric nonintersection and trusted pointer checks for the Task 259 handle.
- [x] Add element-scoped expanded/collapsed list-gutter `@visual` goldens; inspect both PNGs and
      update no unrelated baselines. Preserve the existing heading goldens.
- [x] After `node build.mjs`, extend and run the focused no-retry
      `test/vscode-e2e/section-fold.spec.ts` in the real VS Code webview with trusted list-marker,
      gap, and triangle clicks, plus text/checkbox negatives. Cover mode rebuild, persistence,
      descendant reveal, and exact host and saved-file bytes.
- [x] Run the applicable focused coverage, lint/typechecks, and `npm run quality` per
      `DEVELOPMENT.md` and the repository testing skill. Record actual outcomes and any
      environmental limits in this task before closing it.

## Out of scope

New foldable block types, changing which list items qualify, changing fold-state storage or
commands, moving the list text column, and revising heading-fold controls.

## Completion evidence (2026-09-24)

- Split the always-visible 12 px `▼`/`▶` paint from the 36×24 px pseudo-element hitbox.
  Per-item marker, numeral, and checkbox measurements set view-only CSS variables; width,
  font-load, mode, and DOM rebuild refresh those measurements. The hit test uses a bounded
  rendered marker-to-arrow union and excludes the checkbox. The Task 259 source-group handle
  stays 2 px clear, including the narrow-pane fallback. Task 259's owner-approved policy is
  one handle per complete source-owned group, including a nested child's owning parent.
- The four expanded/collapsed IR/WYSIWYG PNG goldens were regenerated and inspected. Pixel
  component centroids place bullet ink and painted triangle within 0.4 px in the inspected
  goldens; the collapsed `▶` uses a 2 px paint-only correction for the shipped font. Numeric
  Chromium cases cover bullets, ordered 8/10, nested and loose lists, wrapped first lines,
  tasks, 560/1000 px widths, trusted inside/outside clicks, checkbox passthrough, and handle
  separation. IR and WYSIWYG `getValue()` is unchanged by the CSS variables.
- `node build.mjs` passed before real VS Code. Its output measured webview
  `main.js` at 816.4 kB and `main.css` at 51.2 kB; eager module count was not
  separately recorded in this Task 569 run. The no-retry
  `section-fold.spec.ts` passed **1/1** (17.3 s): fresh group handle, trusted marker/gap/arrow
  and checkbox clicks, mode rebuild, persistence/reveal, and exact host/disk save. Its
  LF-terminated authored task child uses four-space CommonMark indentation; Vditor projects
  that line at two spaces, so rendered and authored bytes are asserted separately. A prior
  two-space authored variant correctly failed Task 259's conservative source-owner scan and
  hid the handle. The separate no-final-LF Task 259 handle question is not claimed here.
- Focused units: `npm test -- media-src/src/nav/section-fold.test.ts
  media-src/src/nav/block-handle.test.ts` **32/32**. Focused coverage ran those 32 tests;
  `section-fold.ts` had 74.30% lines and `block-handle.ts` 66.95% lines, while the
  repository-wide threshold expected from an aggregate run necessarily failed on this
  filtered invocation. `npm run typecheck`, `npm run typecheck:vscode-e2e`, scoped Biome,
  the final focused Chromium file **8/8**, and the four-snapshot visual case **1/1** passed.
  One preceding full Chromium pass was 7/8 after a transient pointer click; its isolated
  rerun was 1/1 and the complete file rerun was 8/8 without a product change.
- `npm run quality` ran and remained nonzero for unrelated repository state: former-brand
  identifiers in the Playwright patch scripts/tests; formatting outside Task 569; Knip
  exports outside Task 569; missing vendored emoji metadata; and five aggregate unit
  failures in manifest, module-boundaries, probe-tier-convention, and vendored-licenses
  (4374 passed, five failed). `jscpd` and dependency-cruiser passed. The coverage-module
  ratchet had no aggregate summary because coverage did not finish. Scoped Biome and all
  Task 569 tests above passed.
