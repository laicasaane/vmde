# Task 656 — Outline drag-resize drifts the stored width by 1 px

**Status:** open.
**Origin:** Project Owner request (follow-up of Task 650).
**Severity:** low.
**Tech stack:** webview (Outline drag-resize, `media-src/src/nav/outline-resize.ts`).
**Related:** [Task 650](done/650-remember-outline-open-state-and-width.md) (remember Outline open state and width).

## Problem

The Outline drag-resize stores `outlineEl.offsetWidth` in `onUp` of `media-src/src/nav/outline-resize.ts`. That value is the content width plus the 1 px border. The `--me-outline-width` variable holds the content width. Each drag can therefore grow the stored width by 1 px.

## Requirements

1. The drag-resize stores the content width, the same value held by `--me-outline-width`.
2. Repeated drags without a size change do not change the stored width.

## Open design points

- None beyond confirming the content width source in `onUp`.

## Scope

- In: the stored width written by the Outline drag-resize.
- Out: Outline open state memory (Task 650) and other resize paths.

## Acceptance

- [ ] After a drag, the stored width equals the value of `--me-outline-width`.
- [ ] Ten drag-and-release cycles with no pointer movement leave the stored width unchanged.
- [ ] The Outline width restores as before after reopening.

## Tests

- To be specified in Part 1 (webview behaviour; real-VS-Code verification is required for behaviour that depends on the VS Code integration).
