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
