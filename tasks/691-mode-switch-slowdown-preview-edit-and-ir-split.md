# Task 691 — Switching between Preview and Edit, and between IR and Split view, feels slower

**Status:** planned (2026-11-01). Filed from an Owner report during light manual use.
**Origin:** Owner report (2026-11-01).
**Severity:** medium (estimated; user-visible, not measured).
**Tech stack:** `media-src/src/editing/preview-state.ts`, `media-src/src/editing/preview-render.ts`, `media-src/src/editing/preview-morph.ts`, `media-src/src/editing/preview-caret.ts`, `media-src/src/nav/preview-scroll-preserve.ts`, `media-src/src/nav/split-scroll-sync.ts`, `media-src/src/bridge/edit-sync.ts` (`reanchorAfterModeSwitch`), `media-src/src/editing/vditor-chord-actions.ts` (`switchEditMode`, the entry point of the edit-mode switches including IR↔Split; registered in `media-src/src/boot/main.ts`).
**Depends on:** none.

## Problem

The Owner feels that switching Preview on and off (Preview ↔ Edit) and switching between IR mode and Split view is a bit slower than before. No measurement exists yet. Everything below is unmeasured.

"Before" is not pinned. The reference point is the pre-release cut after Task 670 (commit `30426a37`, 2026-10-19, `feat(670): preserve front matter across exact-source editing`).

Candidate commits since then that touch these paths (unverified as causes):

- `6dede194` `feat(643): render Preview itself, stream large documents and defer the edit view`.
- `8b8740be` `fix(652): restore the caret and selection after Preview off`.
- `88cc673d` `feat(645): add Split View source pane font size, line numbers, background, current-row highlight and pane gap`.
- The Task 675 and 677 mode-switch changes in `media-src/src/bridge/edit-sync.ts` (`reanchorAfterModeSwitch`), commits `47ae8ee5` and `fbe97b56`.

## Proposed work

1. Measure first, in real VS Code on a quiet machine. Time the path from the user gesture to the settled view for four switches: Preview on, Preview off, IR→Split, Split→IR. Use a small, a mid-size and a large fixture, several runs each, on `30426a37` and on current `dev`. Use `performance` marks or CDP traces.
2. If current `dev` is slower, bisect the candidate commits and attribute the cost with a CPU profile.
3. Fix the attributed cost without removing the behaviour those tasks added. Or record the measured cost as accepted, with the Owner informed.
4. If no difference is measured, record the numbers and close.

## Acceptance

- [ ] Switch times are measured on both revisions. The numbers are recorded with fixture sizes and run counts.
- [ ] The cause is attributed to a commit and a function, or "no regression measured" is recorded.
- [ ] Any fix brings the switch time back within the measured noise of `30426a37`, or states the remaining cost.
- [ ] A real-VS-Code timing spec or probe is written and run.
- [ ] The quality stages pass.

## Tests to write

- A real-VS-Code probe (tag `@probe`) in `test/vscode-e2e/` that measures the four switches.
- A regression test for any fix.
