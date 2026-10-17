# Task 648 — IR: arrow keys move through Markdown markers one character at a time

**Status:** open.
**Origin:** Project Owner report.
**Severity:** medium (keyboard editing of inline syntax is blocked; accessibility).
**Tech stack:** webview (`media-src/src/editing/editor-caret.ts`, marker reveal from [Task 286](done/286-caret-marker-reveal.md), vendored Vditor IR `expandMarker` and keydown handling), Vitest, Chromium, real VS Code with OS-level keys.
**Related:** [Task 286](done/286-caret-marker-reveal.md) (reveal the node under the caret on every selection change), [Task 609](done/609-caret-offset-marker-ties.md) (caret offset ties at marker boundaries), [Task 600](done/600-no-blockless-caret-in-ir.md) and [Task 608](done/608-remaining-blockless-caret-routes.md) (caret landings).

## Problem

In IR, Markdown markers such as `**` are hidden until the caret enters their node, then revealed as editable text. With the keyboard, the caret cannot move through those markers as ordinary characters: ArrowLeft and ArrowRight stop at the boundary of each `**` and do not step between the two `*` characters, or between a marker and the text next to it.

Example source line:

```markdown
**Confirm**
```

With the node revealed, the source has 12 caret positions (offsets 0 to 11):

```text
offset:  0  1  2  3  4  5  6  7  8  9 10 11
         | *| *| C| o| n| f| i| r| m| *| *|
```

Expected: starting at offset 0, eleven ArrowRight presses visit offsets 1, 2, 3, … 11 in order, one per press, and eleven ArrowLeft presses return through 10, 9, … 0. Today the caret is blocked at the `**` boundaries, so offsets 1 and 10 (between the two `*`) and the steps into and out of the markers cannot be reached by arrow keys.

## Requirements

1. **One character per press.** In IR, while an inline node's markers are revealed, each ArrowLeft or ArrowRight press moves the caret exactly one source character, through marker characters and content alike, in both directions.
2. **Entering and leaving a node.** Moving the caret into a node from the text before or after it reveals the markers and places the caret at the adjacent source position (just inside the outer marker character), not past the marker. Moving out of the node past its last marker character continues into the neighbouring text and hides the markers again (Task 286 behaviour).
3. **All inline markers.** The same applies to every inline construct whose markers IR reveals: strong (`**`, `__`), emphasis (`*`, `_`), strikethrough (`~~`), inline code (`` ` `` and longer runs), links and images (`[`, `](`, URL, `)`, `![`), wiki links (`[[`, `]]`), highlight (`==`), superscript and subscript markers, inline math (`$`), and inline HTML tags shown as source. Part 1 lists the constructs and confirms each.
4. **Shift+Arrow too.** Shift+ArrowLeft and Shift+ArrowRight extend the selection one source character at a time through markers, with the same positions.
5. **Typing where the caret is.** A character typed at any reachable position lands at that source offset; for example, typing `x` at offset 1 of `**Confirm**` gives `*x*Confirm**`. Nothing is silently inserted inside a hidden marker (Task 286's guarantee stays).
6. **No other change.** ArrowUp, ArrowDown, Home, End, Page keys, block-level markers (headings, lists, quotes, fences) and WYSIWYG and Split behaviour are unchanged unless Part 1 finds the same cause there; any such change is recorded.

## Open design points (settled in Part 1)

- Where the stop comes from: Vditor's IR keydown handling, the browser's caret movement across the zero-width hidden spans and the `display` switch on reveal, VMDE's caret normalizer in `editor-caret.ts` (its comment notes that normalizing an Arrow step inside an expanded block "would bounce ArrowLeft/ArrowRight back to the content edge"), or the Task 609 tie rule.
- Whether the fix lets the native caret move and only repairs landings, or moves the caret by source offset per key; the effect on IME, screen readers and RTL text.
- Nested constructs (`***both***`, `**[link](url)**`, `` **`code`** ``) and adjacent nodes (`**a**_b_`).
- Performance on large documents (Task 573 budgets): per-key cost of reveal and caret placement.

## Scope

- In: horizontal arrow navigation and Shift+Arrow selection through inline Markdown markers in IR.
- Out: vertical navigation, block-level markers, WYSIWYG, Split (unless they share the cause).

## Acceptance

- [ ] For `**Confirm**`, ArrowRight from offset 0 visits offsets 1 to 11 in order and ArrowLeft returns through 10 to 0, one per press, in real VS Code with OS-level keys.
- [ ] The same walk works for each inline construct listed in Part 1, including nested and adjacent cases.
- [ ] Shift+Arrow selections through markers cover exactly the expected source ranges.
- [ ] Typing at each reachable offset writes at that offset (host text checked), with one Undo step.
- [ ] Entering and leaving a node reveals and hides its markers as today.
- [ ] Vertical keys, Home/End, block markers, WYSIWYG and Split are unchanged.
- [ ] Large-document key handling stays within the Task 573 budgets.
- [ ] Focused Vitest, Chromium and real-VS-Code specs are written and run; network-free gates pass at closure.

## Tests

- Vitest: any pure caret-step or offset-mapping helper.
- Chromium: offset walks for each construct, both directions, Shift+Arrow ranges, typing at each offset, nested and adjacent cases.
- Real VS Code (`test/vscode-e2e/`): the `**Confirm**` walk and a link and inline-code walk with OS-level XTEST keys, host text after typing, Undo.
