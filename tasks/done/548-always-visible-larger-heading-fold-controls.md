# Task 548 — Keep heading fold controls visible and enlarge their hit targets

**Status:** done — 2026-09-06 · **Impact:** 🟢 low-risk interaction/accessibility polish · **Origin:** Project Owner follow-up, 2026-09-06

**Depends on:** Task 546 · **Related:** Tasks 04, 258, and 265

## Problem

Task 546 made heading-section folding precise and moved its `▼`/`▶` control below the `H1`–`H6`
marker. The expanded control is still hidden with `opacity: 0` until the heading is hovered, so the
feature is undiscoverable when the pointer is elsewhere. Its shipped pointer rectangle is only
18×12 px, which is unnecessarily difficult to acquire even though clicks outside that explicit box
now remain safe for caret placement.

## Interaction and visual contract

- Keep every foldable heading control visible at all times in IR and WYSIWYG. Both expanded `▼` and
  collapsed `▶` must have computed opacity `1` before hover, after pointer exit, and after a mode or
  DOM rebuild.
- Double the shipped heading-control hitbox in each dimension: 18×12 px becomes exactly 36×24 px.
  Keep the visible glyph at its current 12 px size; the larger region is interaction padding, not a
  doubled icon.
- Keep the enlarged box centered in the heading gutter and below the `H1`–`H6` marker. It must not
  intersect the heading-level marker, the first-character caret position, heading text, or another
  block's interactive content.
- A pointer click anywhere inside the 36×24 px box toggles exactly once. A click immediately outside
  any edge does not toggle and continues to Vditor unchanged.
- Preserve Task 546's heading-only scope. Nested-list controls and their hover behavior remain
  unchanged.
- Preserve the fixed gutter width, heading text origin, `▼`/`▶` state meanings, exact Markdown,
  keyboard command/chord, automatic reveal, persistence, and mode/DOM-rebuild behavior.
- Keep the control serializer-safe and theme-aware. Do not add editable DOM content or introduce a
  layout shift to create the larger pointer target.

## Implementation

- [x] Add failing unit cases around `headingFoldIconHitTest()` for the new 36×24 px rendered box.
      Cover its center and edges, points inside the newly added padding but outside the old 18×12 px
      box, and points immediately outside all four new edges.
- [x] Update the named heading-control geometry in `media-src/src/main.css`: expose a 36×24 px
      pseudo-element box while retaining the 12 px glyph, permanent visibility, pointer cursor,
      theme color, and centered glyph alignment.
- [x] Adjust the per-level vertical placement only as needed to keep the enlarged H1–H6 boxes below
      their markers and clear of following block content. Do not change the gutter width or heading
      text layout.
- [x] Keep `media-src/src/nav/section-fold.ts` deriving pointer geometry from the rendered
      pseudo-element. Do not introduce a second hard-coded TypeScript hitbox or broaden list-fold
      activation.
- [x] Extend `media-src/e2e/section-fold.spec.ts` with non-hover visibility assertions for expanded
      and collapsed headings in IR and WYSIWYG. Use trusted pointer clicks in the new padding outside
      the old box, plus immediately-outside negative clicks, and retain caret/marker/text negatives.
- [x] Expand the numeric H1–H6 geometry guard to prove 36×24 px dimensions, nonintersection with the
      marker and title text, stable text origin, and no overlap with the next visible block.
- [x] Update the element-scoped heading-gutter visual coverage so the expanded control is captured
      without first hovering. Inspect every changed PNG; do not refresh unrelated baselines.
- [x] Extend the built `test/vscode-e2e/section-fold.spec.ts` journey to prove always-visible
      expanded/collapsed controls and a trusted click within the newly added padding. Retain the
      immediately-before-title negative case and exact host/disk bytes.
- [x] Run the focused and routine gates below, inspect the final diff, and record only evidence that
      actually completed. Do not edit generated output.

## Acceptance

- [x] Every foldable heading shows `▼` while expanded and `▶` while collapsed without requiring
      hover, focus, caret placement, or prior interaction.
- [x] The visible glyph remains 12 px while its computed pointer box is exactly 36×24 px in IR and
      WYSIWYG for H1 through H6.
- [x] Trusted pointer clicks in the additional padding outside Task 546's former 18×12 px box toggle
      once; clicks immediately outside the new box do not toggle.
- [x] The enlarged box remains below and separate from the H1–H6 marker and does not steal caret,
      heading-text, or neighboring-block clicks.
- [x] Source fidelity, text alignment, persistence, keyboard/reveal paths, mode/DOM rebuilds, and
      nested-list behavior remain unchanged.
- [x] Focused unit, Chromium, visual, and no-retry real-VS-Code regressions pass after a fresh build;
      changed lines are covered and the applicable routine gates pass.

## Verification

Follow `DEVELOPMENT.md` for the current command authority and the repository testing skills for the
required order and sandbox handling.

- Focused `media-src/src/nav/section-fold.test.ts`, followed by focused changed-line coverage.
- Focused Chromium `section-fold.spec.ts --retries=0`, including trusted pointer, computed-style,
  and numeric geometry assertions in IR and WYSIWYG.
- `npm run test:visual`; update only intended heading-gutter baselines and inspect the PNGs.
- `node build.mjs` before the focused no-retry real-VS-Code `section-fold.spec.ts` run.
- Lint, webview/strict/VS-Code-e2e typechecks, bundle and startup budgets, full coverage plus the
  zero-coverage-module ratchet, and one final `npm run quality` candidate.

## Completion evidence

- RED/GREEN: the focused Chromium regression initially reported the shipped 18×12 px box and
  hover-only opacity, then passed 6/6 with `--retries=0` after the CSS change. Focused unit tests
  pass 14/14 and cover the 36×24 px center, edges, added padding, and immediately-outside points.
- Chromium geometry proves exact 36×24 px boxes and 12 px glyphs for H1–H6 in IR and WYSIWYG,
  with marker, heading text, and following content rectangles remaining separate. Trusted pointer
  clicks in new padding toggle once; immediately-outside, marker, and caret clicks do not toggle.
- Visual coverage passes 8/8 after updating only the two heading-gutter baselines. Both regenerated
  PNGs were inspected and show the always-visible expanded/collapsed glyph below the level marker.
- The fresh build and the no-retry real-VS-Code 1.129.0 `section-fold.spec.ts` journey pass 1/1,
  including the new padding click, non-hover opacity in IR/WYSIWYG, persistence/reveal/list paths,
  exact host value, and exact saved-file bytes.
- Webview, strict, and VS-Code-e2e typechecks pass. Bundle size (608/608 KB) and startup cost
  (294/294 eager modules) remain within budget. Full coverage passes 260 files / 3,759 tests, and
  the 13-module zero-coverage ratchet passes.
- The final quality candidate passed brand checks, lint, knip, jscpd, and dependency boundaries.
  Its sandboxed aggregate run could not complete the vendor OSV network audit and initially blocked
  child-process coverage tests; the latter passed separately outside the sandbox. The Project Owner
  explicitly authorized closure without the unavailable network quality check on 2026-09-06.
