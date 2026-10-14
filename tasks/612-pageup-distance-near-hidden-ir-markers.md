# Task 612 — Restore page-sized navigation near hidden IR markers

**Status:** planned (2026-09-29). The Project Owner decided the reference behavior and the repair order on 2026-10-08 (see Owner decisions); implementation has not started.
**Origin:** [Task 286](done/286-caret-marker-reveal.md) maintenance note at commit `c89b46f9`; coordinate with [Task 369](done/369-table-inline-code-row-height-delta.md)'s inline layout findings.
**Scope:** PageUp/PageDown travel distance in IR. Preserve Task 286's completed marker reveal and delimiter-safe typing behavior.

## Problem

In a document with hidden link or code markers, a native PageUp can travel only one line. Task 286's maintenance verification adapted its test anchor to reach a marker regardless of page distance; it did not repair the short navigation distance.

## Measured evidence

`tasks/done/286-caret-marker-reveal.md` §Maintenance records the first PageUp from a bottom anchor landing in `real-end-code`, one line above, below the intended hidden link-marker line. The result occurred on dev `01b12c63` and Task 286 commit `e2beed52`, in VS Code 1.129.0 and 1.110.0, at default Xvfb and 1600×1000 sizes. The exact environmental change was not identified. The note attributes the variation to Chromium page navigation near Vditor marker boxes and says a VMDE PageUp/PageDown handler or marker CSS change is needed. Vditor's collapsed IR markers use `display:inline-block; width:0; height:0; overflow:hidden`; Task 286 kept marker CSS out of scope. Task 369 separately documents inline-block marker line-break effects, so a CSS candidate needs layout checks.

## Affected modes

- **IR:** short PageUp travel was observed near hidden link/code markers.
- **WYSIWYG/SV:** no equivalent observation; use them as controls, not assumed defects.

## Candidate approaches

1. Handle PageUp/PageDown in VMDE using measured viewport geometry and a source-safe target caret, preserving native selection extension, scroll and focus behavior.
2. Change collapsed marker CSS so Chromium's native paging sees stable line boxes, while retaining hidden delimiters, copy behavior and Task 369's line layout.

## Owner decisions (2026-10-08)

Approved in chat by the Project Owner.

- The reference is VS Code's text editor: PageUp/Down travel about one viewport, Shift+PageUp/Down extend the selection, and wrapped lines count visually.
- Try a marker CSS/layout change first. Use a VMDE paging handler only if CSS cannot meet the reference without breaking Tasks 286 and 369.

## Tests

- Measure caret line, viewport, scroll offset and page travel in Chromium and real VS Code across link/code/strong markers, different caret x positions, font metrics, wrapping and viewport sizes. Compare plain-text and WYSIWYG/SV controls.
- Add focused Chromium coverage for PageUp/PageDown, Shift selection, marker visibility, copy and typing; include Task 369's inline-code wrapping/row-height controls for any CSS change.
- Build first, then focused real-VS-Code XTEST coverage with exact caret line and host text after native keys. Rerun Task 286's marker-reveal spec without retries.

## Acceptance

- [ ] PageUp/PageDown move by the Owner-approved page distance near collapsed IR markers, including wrapped lines and Shift selection, without one-line stalls.
- [ ] Landing remains paintable and delimiter-safe; marker reveal, copy, inline layout, scroll and exact host text remain correct.
- [ ] Chromium and real-VS-Code tests pass at representative viewport/font conditions, with any environment-dependent result recorded explicitly.

## Part 1 handoff (2026-10-14)

Read-only review of the source; the cause is an inference until the S1 probe runs.

- **Entry points (verified).** VMDE has no PageUp/PageDown handler in IR, WYSIWYG or SV; native Chromium paging runs unchanged. The single scroller is the contenteditable `.vditor-reset` (`media-src/src/main.css`). Stock collapsed markers are `display:inline-block; width:0; height:0; overflow:hidden` (Vditor `_ir.less`). Task 369 takes collapsed inline-code markers out of flow (`position:absolute; display:block; 0×0`, `main.css`, earlier than Task 286's pass — not the unidentified environment change). Task 286 reacts after the move (selectionchange-driven reveal plus `normalizeMarkerNavigationCaret`, `media-src/src/editing/editor-caret.ts`). IR copy is DOM-based (`cloneContents` then `VditorIRDOM2Md`), so marker CSS changes only the selection range that layout produces, not copied text.
- **Cause (inference).** Blink's page move steps line by line at a fixed goal x and stops when the next position is null, unchanged, has no caret y, or is beyond about one viewport. A goal x hitting a 0×0 atomic inline-block marker (link `[`/`](url)`) or an absolute code marker can put the candidate inside the marker's own formatting context, so the next step stalls after one line. Fits the recorded dependence on caret x and font metrics.
- **Contract (Owner 2026-10-08).** Match the VS Code text editor: PageUp/PageDown moves the caret about one viewport of visual lines (wrapped lines count) and scrolls by about a page; the goal x is kept across repeated presses; Shift+PageUp/PageDown extends from a fixed anchor; nothing stalls next to collapsed link, code or strong markers. Task 286 still holds (reveal on landing, caret normalized out of hidden delimiters, typing lands outside them, exact host text unchanged). Task 369 still holds (collapsed inline code stays in the text line; markers 0 wide collapsed, visible expanded).
- **Part 2.** S1 (measure): Chromium harness `media-src/e2e/marker-reveal.html` plus a `@probe` (or `*spike*`) spec — native PageUp/PageDown and separate `Selection.modify('move', …, 'line')` steps, recording per step the container class, the caret range's client rects, y change, scrollTop change, line count and which stop condition fired; vary link/code/strong/em lines, caret x (start, middle, end, over a marker), two font stacks, wrapped lines, default and 1600×1000 viewports; controls: plain text, WYSIWYG, SV. Then try live: (a) the Task 369 out-of-flow rule extended to all collapsed inline markers, (b) a link-marker-only rule, (c) no CSS route (record why). S2 (repair + Chromium): CSS in `main.css` next to the Task 369 rule with a reason comment (`.agents/rules/css.md`); fallback handler only if CSS cannot meet the contract without breaking Tasks 286/369 — a new `media-src/src/editing/` module (capture-phase keydown, IR only, skipped during composition; moves by the scroller's client height of visual lines at the goal x, Shift extends, scrolls by the same amount, landing left to the Task 286 normalizer; manifest + boundary test). Tests in `media-src/e2e/marker-reveal.spec.ts` or a new `ir-page-navigation.spec.ts`: page distance ≥ N lines from anchors under link, code and strong lines; three or more presses in a row (goal-x drift after the normalizer's selection write); Shift+PageUp selection text and copy output; typing after landing; the Task 369 inline-code line geometry and no new break opportunity or row-height change; the triple-click marker-inclusive copy check (Task 191 P0-11). S3: real-VS-Code `test/vscode-e2e/ir-page-navigation.spec.ts` (exact caret line and host Markdown after native keys at the default size and 1600×1000), reruns of `marker-reveal.spec.ts` and `ir-inline-code-line.spec.ts`. S4: closure.
- **Edge cases.** Goal-x drift over repeated presses; the 100 ms dwell expansion re-wrapping the landing line; document top and bottom; a page smaller than one line; code-block and math previews with collapsed markers; table cells; IME composition; links with an empty URL marker.
- **Decisions (within the Owner rule of 2026-10-08, "try marker CSS/layout first, a VMDE paging handler only if CSS cannot meet it without breaking Tasks 286/369").** (1) CSS candidate (a) would contradict Task 369's recorded scope guard ("every other collapsed marker type keeps stock inline-block") and may affect triple-click copy (inline-block markers make it include the markers); the guard may be rewritten only if S1/S2 show triple-click copy, wrapping and row heights unchanged — otherwise the handler. (2) "Viewport travel" includes the scroll offset moving by about a page, as VS Code does, measured as a scrollTop change within a tolerance.
- **Risks.** Cause unproven until S1; results depend on font and environment (record each); a handler must reproduce Shift-extend direction and anchor exactly.
