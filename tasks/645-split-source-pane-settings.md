# Task 645 — Split View source pane: font size, line numbers, background, current-line highlight and pane gap

**Status:** open.
**Origin:** Project Owner feature request.
**Severity:** feature (low to medium risk; settings and Split View styling; line numbers and the current line touch the source pane's layout).
**Tech stack:** extension host settings (`package.json` contributes, `src/platform/editor-config.ts`, `src/shared/protocol.ts`, `src/webview-host/html-builder.ts`), webview (`media-src/src/boot/live-config.ts`, Split View source pane `.vditor-sv`), CSS (`media-src/src/main.css`), Vitest, Chromium, real VS Code.
**Builds on:** [Task 634](done/634-split-view-source-monospace-font.md) (`vmde.editor.sourceFontFamily`: a source-only setting carried as a CSS variable, applied live, with a safe fallback).

## Problem

Split View shows the Markdown source on the left and the rendered preview on the right. Apart from its font family (Task 634), the source pane has no settings of its own:

- Its font size follows `vmde.editor.fontSize`, which also sizes the rendered document, so source and preview cannot be sized separately.
- It has no line numbers, so a line reported elsewhere (a link such as `README.md:42`, a Git change, a lint message) is hard to find.
- Its background is the same as the preview's, so the two panes are hard to tell apart.
- The line holding the caret is not highlighted.
- The space between the source pane and the preview pane is fixed.

## Requirements

Setting names (approved): `vmde.editor.sourceFontSize`, `vmde.editor.sourceLineNumbers`, `vmde.editor.sourceBackground`, `vmde.editor.sourceHighlightCurrentLine`, `vmde.editor.sourceCurrentLineBackground`, `vmde.editor.splitGap`.

1. **Source font size.** A new setting sets the source pane's font size independently of `vmde.editor.fontSize`. By default the source pane keeps today's size. Line height and the caret follow the new size.
2. **Line numbers.** A new setting shows line numbers in a gutter at the left of the source pane, off by default. Each number belongs to one source line and is shown on its first visual row. When a long line wraps, each further row shows a continuation mark with a sub-number counted from 1, in a smaller, dimmer style than the line numbers:

   ```text
     42 │ first row of line 42
     ↳1 │ first wrapped row of line 42
     ↳2 │ second wrapped row of line 42
     43 │ line 43
   ```

   Sub-numbers update when the pane is resized or edits change how a line wraps. Numbers update as lines are added or removed, are not part of the document text (copy, Find, save and Undo never see them), and use a muted theme color.
3. **Source background color.** A new setting sets the source pane's background color. Empty means today's background.
4. **Current-line highlight.** A new setting highlights the source line that holds the caret, off by default, and a second setting sets its background color (empty means a theme color, as for the Find match colors). The highlight covers only the visual row that holds the caret: when a long source line wraps, each wrapped row counts as its own line for the highlight. It follows the caret as it moves, including between wrapped rows of the same source line. It is hidden while a selection is not collapsed, and when the source pane does not have focus.
5. **Pane gap.** A new setting sets the width of the space between the source pane and the preview pane, in pixels. By default the gap keeps today's width.
6. **Live and scoped.** Every setting applies live, without reopening the editor, and has `resource` scope like the other `vmde.editor.*` settings. Invalid values fall back to the default without breaking the layout.
7. **Split View only.** The settings change only Split View's source pane and the gap. IR, WYSIWYG, Preview and the rendered pane are unchanged.
8. **No effect on the document.** None of these settings change the document text, dirty state, Undo history, caret or selection.

## Open design points (settled in Part 1)

- Value formats and validation for the approved setting names: `vmde.editor.sourceFontSize` (same format as `vmde.editor.fontSize`: `"editor"` to follow it, or a pixel value), `vmde.editor.sourceLineNumbers` (boolean), `vmde.editor.sourceBackground` (color string, empty for theme), `vmde.editor.sourceHighlightCurrentLine` (boolean), `vmde.editor.sourceCurrentLineBackground` (color string, empty for theme), `vmde.editor.splitGap` (number of pixels).
- Color validation: which CSS color forms are accepted, and how the values are sanitized before they reach CSS (follow the Find match color settings).
- How to number lines and draw the current line in the source pane, which is one editable block of Lute spans rather than one element per line: a gutter beside the editable block measured from the rendered rows, or line elements inside it. The approach must keep the source pane's caret, IME, paste, Undo and the source-to-preview scroll sync working, and must stay fast on large documents (Task 573 gate) and during streaming.
- Where today's gap between the panes comes from (padding, margin or border), its current measured width, and the allowed range for the new setting.
- Whether line numbers and the current line should also apply to Source mode as reached from the status bar (if it shares the Split source pane).

## Scope

- In: the six settings above, their live application, the source pane gutter and current-line highlight, the pane gap.
- Out: changing the rendered pane, IR or WYSIWYG styling, resizing the panes by dragging, code-block line numbers (`vmde.editor.codeLineNumbers`).

## Acceptance

- [ ] The source font size setting changes only the source pane's measured font size; `vmde.editor.fontSize` still sizes the rendered pane.
- [ ] With line numbers on, each source line shows its number on its first row and each wrapped row shows `↳1`, `↳2`, … in order; marks update after a pane resize; numbers update after typing Enter, deleting lines, paste and Undo; copy, Find, save and Undo never include them.
- [ ] The source background setting changes the source pane's measured background color; empty restores today's color.
- [ ] With the current-line highlight on, only the visual row holding the caret has the configured background (on a wrapped line, one wrapped row, not the others); it follows arrow keys and clicks, and is hidden with a non-collapsed selection or without focus.
- [ ] The gap setting changes the measured distance between the source and preview panes.
- [ ] Changing any setting applies live; invalid values fall back to the default.
- [ ] No setting changes document text, dirty state, Undo history, caret or selection.
- [ ] Large-document typing and scrolling stay within the Task 573 budgets with line numbers and the current-line highlight on.
- [ ] Focused Vitest, Chromium and real-VS-Code specs are written and run; network-free gates pass at closure.

## Tests

- Vitest: setting validation and defaults (font size, colors, gap), host-to-webview config shape, line-number planning from rendered rows if a pure planner exists.
- Chromium: measured font size, background colors, gap width; line numbers and `↳n` wrapped-row marks with wrapping and resize, Enter, delete, paste and Undo; current-line highlight on one visual row, moving between wrapped rows of one source line, and hiding with a selection; copy and Find exclude numbers; large-document timing.
- Real VS Code (`test/vscode-e2e/`): settings applied live in Split View, line numbers and current line with OS-level keys, document bytes, dirty state and Undo unchanged.
