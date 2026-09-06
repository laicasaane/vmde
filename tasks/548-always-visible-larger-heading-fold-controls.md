# Task 548 — Keep heading fold controls visible and enlarge their hit targets

**Status:** planned · **Impact:** 🟢 low-risk interaction/accessibility polish · **Origin:** Project Owner follow-up, 2026-09-06

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

- [ ] Add failing unit cases around `headingFoldIconHitTest()` for the new 36×24 px rendered box.
      Cover its center and edges, points inside the newly added padding but outside the old 18×12 px
      box, and points immediately outside all four new edges.
- [ ] Update the named heading-control geometry in `media-src/src/main.css`: expose a 36×24 px
      pseudo-element box while retaining the 12 px glyph, permanent visibility, pointer cursor,
      theme color, and centered glyph alignment.
- [ ] Adjust the per-level vertical placement only as needed to keep the enlarged H1–H6 boxes below
      their markers and clear of following block content. Do not change the gutter width or heading
      text layout.
- [ ] Keep `media-src/src/nav/section-fold.ts` deriving pointer geometry from the rendered
      pseudo-element. Do not introduce a second hard-coded TypeScript hitbox or broaden list-fold
      activation.
- [ ] Extend `media-src/e2e/section-fold.spec.ts` with non-hover visibility assertions for expanded
      and collapsed headings in IR and WYSIWYG. Use trusted pointer clicks in the new padding outside
      the old box, plus immediately-outside negative clicks, and retain caret/marker/text negatives.
- [ ] Expand the numeric H1–H6 geometry guard to prove 36×24 px dimensions, nonintersection with the
      marker and title text, stable text origin, and no overlap with the next visible block.
- [ ] Update the element-scoped heading-gutter visual coverage so the expanded control is captured
      without first hovering. Inspect every changed PNG; do not refresh unrelated baselines.
- [ ] Extend the built `test/vscode-e2e/section-fold.spec.ts` journey to prove always-visible
      expanded/collapsed controls and a trusted click within the newly added padding. Retain the
      immediately-before-title negative case and exact host/disk bytes.
- [ ] Run the focused and routine gates below, inspect the final diff, and record only evidence that
      actually completed. Do not edit generated output.

## Acceptance

- [ ] Every foldable heading shows `▼` while expanded and `▶` while collapsed without requiring
      hover, focus, caret placement, or prior interaction.
- [ ] The visible glyph remains 12 px while its computed pointer box is exactly 36×24 px in IR and
      WYSIWYG for H1 through H6.
- [ ] Trusted pointer clicks in the additional padding outside Task 546's former 18×12 px box toggle
      once; clicks immediately outside the new box do not toggle.
- [ ] The enlarged box remains below and separate from the H1–H6 marker and does not steal caret,
      heading-text, or neighboring-block clicks.
- [ ] Source fidelity, text alignment, persistence, keyboard/reveal paths, mode/DOM rebuilds, and
      nested-list behavior remain unchanged.
- [ ] Focused unit, Chromium, visual, and no-retry real-VS-Code regressions pass after a fresh build;
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
