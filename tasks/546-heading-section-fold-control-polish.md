# Task 546 — Make heading-section fold controls precise and unobstructed

**Status:** planned · **Impact:** 🟢 low-risk interaction/visual polish · **Origin:** Project Owner report and screenshot, 2026-09-06

**Related:** Tasks 04 and 258

## Problem

Task 258 added source-safe heading-section folding with a gutter pseudo-element, but its pointer
activation area is broader than the icon it presents. `section-fold.ts` currently accepts any click
whose horizontal coordinate is at most 10 px past the heading's left edge, without checking a lower
or upper horizontal bound or any vertical bound. A click in the editor's caret position immediately
before the first heading character can therefore collapse or expand the section instead of placing
the caret.

The fold pseudo-element also occupies the same upper gutter area as Vditor's `H1`–`H6` heading-level
marker, so the two affordances overlap. Its current `⌄`/`›` glyphs do not clearly communicate the two
states requested by the Project Owner.

## Interaction and visual contract

- For pointer input, a heading section toggles only when the click lands inside the visible fold
  icon's bounded hit rectangle. Check both axes; do not retain an open-ended test such as
  `clientX <= heading.left + 10`.
- Clicking immediately before the first heading character, on the `H1`–`H6` marker, elsewhere in
  the heading gutter, or on the heading text does not change fold state. Normal Vditor caret and
  selection behavior remains available in those areas.
- Place the heading fold icon below the `H1`–`H6` marker in the left gutter, with a visible gap and
  no overlap in either IR or WYSIWYG mode. Keep the heading text origin and the existing fixed gutter
  width unchanged.
- An expanded, foldable heading displays `▼`; a collapsed heading displays `▶`. The collapsed
  block-count hint may remain after the `▶`, but the state glyph must be the first visible symbol.
- Keep the affordance serializer-safe: do not add controls or text that Lute can write into the
  Markdown document.
- Preserve the existing keyboard command/chord, automatic reveal for caret/find/outline/anchor/source
  navigation, per-document persistence, and mode/DOM-rebuild behavior. “Only click on this icon”
  narrows pointer activation; it does not remove non-pointer folding and reveal paths.
- This task changes heading-section affordances only. Preserve nested-list folding behavior and its
  current pointer target and presentation unless a shared refactor is strictly necessary and proven
  behavior-neutral.

## Implementation

- [ ] Add a failing unit regression for a named heading-icon hit-test contract. Cover the icon
      center, every rectangle edge, points immediately outside each edge, and the caret position
      before the first title character. The helper must reject non-foldable headings and must not
      broaden list-fold activation.
- [ ] In `media-src/src/nav/section-fold.ts`, replace the one-sided heading click threshold with a
      bounded two-dimensional hit test that matches the rendered heading icon. Keep event
      cancellation and `toggleAt()` limited to a successful hit; rejected clicks must continue to
      Vditor unchanged.
- [ ] In `media-src/src/main.css`, split heading and list pseudo-element rules where needed. Give the
      heading icon an explicit, named geometry contract shared with the hit test, position it below
      the heading-level marker for H1–H6, and render `▼` expanded / `▶` collapsed. Do not change the
      gutter width or heading-marker alignment established by Task 04.
- [ ] Extend `media-src/e2e/section-fold.spec.ts` (and its harness only as needed) to use real pointer
      coordinates. Prove that clicking the visible icon toggles exactly once, while clicking the
      caret position immediately before the first character and the heading-level marker does not
      toggle. Assert the `::after` glyph for both states and exact `getValue()` fidelity.
- [ ] Add a compact numeric geometry guard for all six heading levels in IR and WYSIWYG: the heading
      marker and fold-icon boxes must not intersect, the fold icon must be below the marker, and the
      heading text origin must not move between expanded and collapsed states. Do not rely on a
      screenshot alone for these assertions.
- [ ] Add or update an element-scoped `@visual` golden for the heading gutter. Inspect the resulting
      PNG so an intentional baseline update cannot conceal a marker/icon overlap.
- [ ] Extend `test/vscode-e2e/section-fold.spec.ts` with actual pointer clicks in the built VS Code
      webview. Cover the icon-center success and the immediately-before-title negative case, verify
      `▼` → `▶` → `▼`, and retain exact host value and saved-file bytes.
- [ ] Run the focused and routine gates below, inspect the final diff, and record only evidence that
      actually completed. Do not edit generated output.

## Acceptance

- [ ] In IR and WYSIWYG, clicking the center of `▼` collapses the correct heading section and the
      control becomes `▶`; clicking `▶` expands it and restores `▼`.
- [ ] The heading fold icon is visibly below, and never overlaps, the `H1`–`H6` marker at every
      heading level covered by the fixture.
- [ ] A click that places the caret immediately before the first heading character never changes
      the section's fold state. Clicks elsewhere outside the icon hit rectangle also do not toggle.
- [ ] Fold clicks still toggle once, preserve Markdown bytes, and do not move the heading text
      column. Existing keyboard, automatic-reveal, persistence, mode-switch, and nested-list paths
      remain green.
- [ ] Focused unit, Chromium, visual, and no-retry real-VS-Code regressions pass after a fresh build;
      changed lines are covered and the applicable routine gates pass.

## Verification

Follow `DEVELOPMENT.md` for the current command authority and the repository testing skills for the
required order and sandbox handling.

- Focused unit test for `media-src/src/nav/section-fold.test.ts`, followed by focused coverage with
  every changed TypeScript line exercised.
- Focused Chromium `section-fold.spec.ts` with no retries, including numeric geometry and real
  pointer input in both edit modes.
- `npm run test:visual`; update the element-scoped baseline only for the intended gutter change and
  inspect the new PNG.
- `node build.mjs` before the focused no-retry real-VS-Code `section-fold.spec.ts` run.
- Lint, webview/strict/VS-Code-e2e typechecks, bundle and startup budgets, full coverage plus the
  zero-coverage-module ratchet, and `npm run quality` as required for implementation work.
