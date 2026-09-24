# Task 571 — Reorder the two-row toolbar controls and separators

**Status:** ✅ DONE (2026-09-25) · **Origin:** Project Owner request, 2026-09-24 · **Related:** Tasks 492 and 563

## Goal

Change the order of the existing top-level toolbar controls and group separators to match the Project Owner's two numbered lists below. These lists specify the target two-row order before responsive overflow, with wiki navigation enabled. The two wiki controls appear only when wiki navigation is enabled. Menu entries inside Headings, Math, Edit Mode, and More are not separate row controls.

The Project Owner has revised the two lists. They are the sole authority for row membership and left-to-right control and separator order. Keep each named control exactly once; Separator entries may repeat. Do not infer a preferred order or grouping from the current source.

## Row 1

1. Headings
2. Separator
3. Bold
4. Italic
5. Strikethrough
6. Subscript
7. Superscript
8. Underline
9. Separator
10. Link
11. Bulleted List
12. Numbered List
13. Checklist
14. Separator
15. Outdent
16. Indent
17. Separator
18. Blockquote
19. Callout
20. Details
21. Horizontal Rule
22. Code Block
23. Inline Code
24. Separator
25. Emoji
26. Separator
27. Math

## Row 2

1. Insert Before
2. Insert After
3. Separator
4. Upload
5. Table
6. Separator
7. Undo
8. Redo
9. Separator
10. Outline
11. Preview
12. Separator
13. Go Back
14. Wiki Pages
15. Separator
16. Edit In VS Code
17. Edit Mode
18. More

## Implementation contract

- [x] Implement the exact control and separator placement in the two Project Owner lists. If a control is missing or duplicated after a later edit, resolve that ambiguity with the Project Owner before changing toolbar code.
- [x] Update the authored order and row assignment together. Keep the revised relative order when controls move into More at narrow widths and when they return to a row. Keep the owner-specified separators with their adjacent groups; hide any separator whose group is absent or overflowed so no row or menu starts, ends, or doubles up with a separator. When wiki navigation is disabled, omit its controls and normalize the remaining separators in the same way.
- [x] Preserve every control's existing action, submenu contents, tooltip, shortcut, enabled/active state, wiki availability, keyboard access, focus return, and read-only Preview behavior. Keep the toolbar at exactly two rows and preserve responsive overflow and reachable More access.
- [x] Find or make a visible icon for the Math control, which currently has no icon configured in `media-src/src/chrome/toolbar.ts`. Check the bundled Vditor sprite and existing Codicon-style toolbar icons first; reuse a suitable math icon, or add a small source-owned icon through `media-src/src/chrome/toolbar-icons.ts`. Keep the Math menu, accessible name, tooltip, and actions unchanged.
- [x] Limit product changes to toolbar ordering, the Math icon, and the layout/overflow/focus adjustments required to honor the revised lists. Do not implement new toolbar actions as part of this task.

## Verification for implementation

- [x] Add or update focused unit coverage that compares the top-level control inventory, separator positions, and row order with the revised lists, including wiki enabled and disabled states.
- [x] Verify wide and narrow Chromium toolbar layouts, separators after overflow/restore, keyboard traversal, menu access, a visible Math icon in the row and More, and no missing or duplicated controls.
- [x] Run `node build.mjs`, then write and run a focused real-VS-Code spec under `xvfb-run` for the revised two-row order, responsive behavior, and visible Math icon in the actual webview. Inspect the icon in light, dark, and high-contrast themes.
- [x] Run applicable focused gates and `npm run quality` from `DEVELOPMENT.md`; record actual outcomes and any limitations before closing this task.

## Implementation and closure evidence (2026-09-25)

The authored flat toolbar order now matches the revised owner lists. `toolbar-layout.ts`
assigns the exact Row 1 controls to the first row, and `toolbar-overflow.ts` gives way
by the same adjacent groups while keeping Emoji and Undo/Redo pinned in their specified
rows. Existing separator cleanup hides dividers whose neighboring group is absent or
overflowed. With wiki navigation disabled, the two wiki controls disappear and the
surviving Row 2 groups retain normalized separators. The existing live action elements
are moved rather than cloned, so their handlers, state, labels, and submenu contents
remain intact. Math now uses a 16×16 source-owned summation SVG filled with `currentColor`.

Focused unit tests assert the complete 34-control owner inventory and exact row/separator
order for wiki enabled and disabled states; the disabled state has 32 controls. The same
tests verify unique controls, Math icon assignment, and preserved Math menu behavior.
The toolbar suite passed **38/38**. The combined focused command, which also included
Task 220's independent source-marker tests, passed **52/52**:

```bash
npx vitest run --config test/vitest.config.mts \
  media-src/src/chrome/toolbar.test.ts \
  media-src/src/chrome/toolbar-layout.test.ts \
  media-src/src/chrome/toolbar-overflow.test.ts \
  media-src/src/editing/list-normalize-source.test.ts
```

Changed-surface coverage ran **38/38** toolbar tests. `toolbar-overflow.ts` reported
97.59% line coverage; the whole `toolbar.ts` file reported 23.07% because the file
also contains unrelated click handlers and action implementations. The assertions
exercise the authored order and Math configuration directly; the file-wide figure is
not a changed-line coverage claim.

The focused Chromium spec passed **1/1** for exact wide rows, wiki enabled/disabled
normalization, narrow overflow and restore, keyboard/menu access, and the Math icon
in the row and overflow menu. The harness checks no missing or duplicated controls and
no leading, trailing, or adjacent dividers. A fresh `node build.mjs` passed before
real-VS-Code verification.

The regular focused real-VS-Code case passed **1/1**. It configured and read back
`vmde.wiki.enabled` at `WorkspaceFolder` scope for both `true` and `false`, verified
the corresponding exact row lists, and exercised narrow overflow and wide restore.
The Math SVG rendered with a visible `currentColor` fill in Light, Dark, and High
Contrast themes; screenshots were captured and inspected for all three.

The separate isolated Xvfb/Openbox XTEST case passed **1/1** after mapping the visible
VS Code client (`DISPLAY=:105`, XID `0x400003`, PID `116552`, VS Code 1.129.0). Trusted
XTEST input navigated to More, opened it with Return, focused its sole `headings` item,
and delivered a trusted ArrowDown that correctly left focus on that only item. Escape
closed the panel and returned focus to the editor. The menu's hidden state and editor
focus were asserted; the test does not depend on Escape appearing in the inner document's
keydown listener.

`npm run typecheck`, `npm run typecheck:vscode-e2e`, focused Biome checks, and
`git diff --check` passed. `npm run typecheck:strict` reported 13 diagnostics in
unrelated modules; no unrelated type fixes were made.

The one requested `npm run quality` run on the shared candidate did **not** pass as a
whole. `jscpd` passed (7.18% duplicated lines); `depcruise` exited successfully but
inspected zero host/webview modules because its TypeScript support excludes TS7.
`check:brand-identifiers` found three historical `vmarkd` compatibility markers;
`lint:ci` reported `useTemplate` concatenations in Task571/Task220 tests that were
corrected afterward, and scoped Biome then passed. `knip` remained red. Host and webview
dependency audits each reported zero vulnerabilities; the vendor audit could not
classify the emoji executable's vendor metadata. Unit coverage reported **4,427 passed
and 7 failed**: one probe-tier tag convention, one emoji vendor-license metadata case,
one manifest-setting-order case, two module-boundary cases, and two deliberate
Task550 reference-source WYSIWYG RED cases. The coverage-module ratchet then lacked its
summary file because the unit run failed. These shared aggregate results are recorded
without claiming a green quality run; no second aggregate run was made.

The shared candidate measured `media/dist/main.js` at **862,055 bytes / 841.85 KiB**;
the report-only bundle checker showed **842 KB vs 608 KB**. Startup measurement was
**338 eager modules vs 294**; its largest module was 29.8 KB against the 34 KB limit.
The build also contained concurrent Task220/Task550 work, so those aggregate size and
startup measurements cannot be attributed to Task571 alone. No budget ceiling changed.
