# Task 608 — Resolve remaining blockless IR caret and toolbar routes

**Status:** planned (2026-09-29). The Project Owner assigned Task 600's OQ5 and OQ6 residuals to a follow-up; implementation and the resulting interaction policy remain undecided.
**Origin:** Task 600 Part 1 audit and S3a real-VS-Code probe.
**Scope:** IR only. Do not change Task 600's block-marker normalization or its seven-action format/list refusal without evidence that those contracts are involved.

## Problem and evidence

| Route | Evidence | Current consequence |
| --- | --- | --- |
| Ctrl+Home in a document beginning with a thematic break made from four hyphens | Measured in VS Code 1.129.0, Task 600 S3a: tmp/task600-checks/relay2/oq6.log and tmp/task600-checks/relay2/observations/oq6-results.json. The first IR node was HR[data-block="0"] and the selection became PRE.vditor-reset@0. | Native root landing has no block marker for Task 600 B1 to normalize. The Markdown remained unchanged in the probe; later editing from that caret is unmeasured. |
| Ctrl+Home in a document beginning with [toc] and markdown.toc enabled | Same S3a probe: caret remained in Echo text@15. | Navigation to the start was not proved. This is an investigation control, not a confirmed root landing. |
| Fresh open or another path with no live IR range, then Headings | Code audit in tmp/queue-part1/600-part1-handoff.md §5.C: Vditor getEditorRange can synthesize (editor, 0); processHeading in Vditor ir/process.ts can edit the first heading marker or insert at the root. | Predicted route; no post-Task-600 behavioral measurement yet. |
| The VMDE Link button at a blockless range | Same audit: media-src/src/chrome/toolbar.ts calls insertValue('[]()'). | Predicted new top-level paragraph; no post-Task-600 measurement yet. |
| Code and Table buttons at a blockless range | Same audit: Vditor inserts new top-level blocks. | An intentional insertion may be valid. Determine the desired contract before guarding either action. |

Task 600 now protects bold/italic/strike/inline-code and list/ordered-list/check at a blockless IR range. Those seven actions are controls here. Task 597 owns the distinct Undo root-range path, and Task 599 owns Find-close selection restoration.

## Investigation and decision boundary

1. Reproduce the hr-first root landing in the current build using real VS Code and a privacy-safe fixture. Record the native selection before and after Ctrl+Home, the active block, the next Right/Left/typing outcome, and exact host bytes. Repeat with a TOC-first document to establish whether that control can navigate to its first block.
2. In fresh-open and explicitly seeded root states, exercise Headings, Link, Code and Table by toolbar mouse click and the promoted hotkey where one exists. Record selection, document value, host write, Undo boundary and any pre-existing first block mutation. Include an ordinary in-block control for each action.
3. Return the measured outcomes to the Project Owner before choosing how to handle Headings and Link, and whether root insertion by Code and Table is allowed. Preserve their intended empty-editor and in-block behavior. Do not infer a blanket refusal policy from Task 600's seven-action guard.
4. Implement only the approved action policy and root-navigation repair. Prefer one owning layer per route, preserve source bytes and history, and avoid editor-wide caret scans.

## Verification

- Vitest for any new pure guard and anchor-asserted Vditor source patch; require a RED result against the reproduced route before implementation.
- Chromium tests for navigation and each toolbar route, including first-paragraph preservation, fresh-open fallback, empty-editor behavior and unchanged seven-action Task 600 controls.
- A focused no-retry real-VS-Code spec, built first with node build.mjs, for OS-level Ctrl+Home on hr-first and TOC-first documents and the Owner-approved toolbar actions. Assert exact host text, focus and caret membership after every action.
- Run the focused Task 600 blockless-caret specs and relevant marker/navigation regressions. Record inherited quality and budget results separately.

## Acceptance

- [ ] The Owner has decided which root-level Headings, Link, Code and Table actions are valid, based on measured host and Undo outcomes.
- [ ] Ctrl+Home and ordinary navigation in the confirmed hr-first case leave a usable caret inside an editable block, with no unintended Markdown change.
- [ ] Every guarded action at a blockless IR range leaves the document and first paragraph intact; every approved insertion remains source-faithful and undoable.
- [ ] Focused Chromium and real-VS-Code tests pass without retries, with exact host text and clear baseline comparison for any inherited failure.
