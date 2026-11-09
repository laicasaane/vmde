# Task 718 — WYSIWYG heading popover placed below a heading covers the next line of text

**Status:** planned (2026-11-09). Found during Task 716 (open question Q3 of its Part 1b).
**Origin:** Task 716 measurement of `html-link-display.spec.ts:235`.
**Severity:** low (estimated). The popover covers text and can take the pointer click meant for the line below the heading.
**Tech stack:** `media-src/src/chrome/native-popover-position.ts` (VMDE placement of Vditor's block popover for headings, since `d543a35b`), the contextual-panel clearance rules (Task 659, `contextual-panel-clearance.spec.ts`).
**Depends on:** none.

## Problem

In WYSIWYG, with the caret in a heading, VMDE moves Vditor's block popover below the heading. It then covers the first line of the next block. Task 716 measured it in `html-link-display.spec.ts`: the popover at 152–177 px covered a link line starting at 152 px, and its `input` and Remove button took the pointer events meant for the link. Task 716 fixed the stale case (the popover followed the heading after the caret had moved away), but the overlap while the caret is in the heading remains.

Not yet known: whether the overlap appears for every heading level and content theme, and whether placing the popover above the heading (as Vditor does for other blocks) is possible without covering the toolbar.

## Proposed work

1. Measure the popover box against the heading and the next block in WYSIWYG for each heading level and content theme, at the default and a narrow width.
2. Decide the placement rule (for example: above the heading when there is room, else below with the next block kept clear). Ask the Owner if the rule changes the Task 659 clearance intent.
3. Fix with a failing test first: a jsdom unit test for the placement and a real-VS-Code check in `contextual-panel-clearance.spec.ts`.

## Acceptance

- [ ] The overlap is measured for each heading level and content theme.
- [ ] With the caret in a heading, the popover covers neither the heading text nor the next line.
- [ ] `contextual-panel-clearance.spec.ts` and `html-link-display.spec.ts` pass.
- [ ] `npm run quality` passes.
