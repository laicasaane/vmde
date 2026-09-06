# Task 565 — Make the heading marker and fold control one click target

**Status:** 📋 TODO · **Impact:** 🟢 focused heading-fold interaction polish ·
**Origin:** Project Owner follow-up and screenshot, 2026-09-06 · **Depends on:** Task 548 ·
**Related:** Tasks 04, 258, and 546

## Problem

Task 548 enlarged the arrow's isolated pointer box, but the resulting target does not match the
way the gutter control reads visually. The `H1`–`H6` marker and the `▼`/`▶` arrow form one vertical
control in the reserved heading gutter, while only the lower arrow box currently toggles folding.
The dead marker and gap make the larger target unpredictable. The arrow also needs about 3 px more
space above it to align cleanly with the heading underline in the reported layout.

## Interaction and geometry contract

- [ ] Treat the visible heading-level marker, the gap beneath it, and the fold arrow as one
      contiguous pointer target in IR and WYSIWYG. A trusted click anywhere in that combined gutter
      rectangle, including directly on `H1`–`H6`, toggles the owning heading section exactly once.
- [ ] Derive the combined target from the rendered `::before` heading-marker and `::after` fold-
      control geometry. Keep one named hit-test contract; do not add a disconnected hard-coded
      TypeScript rectangle or depend on `event.target` distinguishing pseudo-elements.
- [ ] Keep the combined region entirely inside the fixed left gutter. It must not intersect the
      first-character caret position, heading text, or interactive content in neighboring blocks.
      Rejected clicks must continue to Vditor without cancellation.
- [ ] When `vmde.editor.showHeadingMarkers` is off and `::before` is not rendered, fall back to the
      visible arrow's existing target rather than retaining an invisible marker-sized click area.
- [ ] Preserve the always-visible expanded `▼` and collapsed `▶` states, the 12 px glyph, theme
      color, pointer cursor, fixed gutter width, heading text origin, and serializer-safe pseudo-
      element implementation.
- [ ] Add exactly 3 px of visual top spacing before the arrow glyph so it sits slightly lower
      relative to the heading underline. Move only the painted glyph within the combined control;
      do not shrink the target, move the heading marker/text, or create document layout shift.
- [ ] Preserve heading-only scope. Nested-list fold targets and hover behavior remain unchanged.
      Keyboard folding, automatic reveal, persistence, mode/DOM rebuilds, source fidelity, and
      one-step toggle behavior must remain unchanged.

## Implementation guidance

- [ ] Replace or generalize `headingFoldIconHitTest()` in
      `media-src/src/nav/section-fold.ts` so its rendered target is the union/bounding rectangle of
      the visible heading marker and arrow boxes. Keep explicit finite-geometry failure handling.
- [ ] Update the heading pseudo-element geometry in `media-src/src/main.css` without changing the
      gutter or text column. Express the 3 px arrow offset independently of the pointer rectangle so
      paint alignment and hit testing cannot drift again.
- [ ] Keep pointer cancellation and `toggleAt()` behind a successful combined-target hit. Do not
      broaden activation to the full heading element or its text line.
- [ ] Update Task 548's element-scoped expanded/collapsed heading-gutter baselines and inspect both
      images. The screenshot must show the arrow's 3 px downward adjustment and the unchanged marker
      and text positions.

## Required verification

- [ ] RED/GREEN unit coverage for the combined H1–H6 marker/arrow rectangle: marker center, arrow
      center, the gap between them, all outer edges, immediately-outside points, malformed computed
      geometry, and marker-hidden fallback. Retain non-foldable-heading and list-item negatives.
- [ ] Focused Chromium coverage with trusted clicks on the marker, gap, arrow, and immediately
      outside every combined edge in IR and WYSIWYG. Prove exactly one toggle, native caret/text
      behavior outside the gutter, marker-off fallback, and exact Markdown.
- [ ] Numeric H1–H6 geometry assertions prove the combined target contains both painted affordances,
      remains separate from title/neighbor content, preserves the heading text origin, and applies
      the exact 3 px arrow paint offset without changing the pointer rectangle.
- [ ] Run the complete local visual suite, update only the two heading-gutter baselines, and inspect
      both expanded and collapsed PNGs.
- [ ] Build first, then extend the focused no-retry real-VS-Code `section-fold.spec.ts` journey with
      trusted marker/gap/arrow clicks, the 3 px computed paint offset, IR/WYSIWYG rebuild behavior,
      marker-off fallback, exact host value, and exact saved-file bytes.
- [ ] Run focused changed-line coverage, applicable typechecks and budgets, lint, full coverage and
      the zero-coverage-module ratchet, and one final quality candidate per `DEVELOPMENT.md` before
      closure. Record any separately authorized network-check omission honestly.

## Out of scope

- Changing heading-marker text or typography, widening the fixed gutter, moving the heading text
  column, redesigning section-fold persistence/commands, or changing nested-list folding.

Session work: task creation only; no implementation or runtime verification yet.
