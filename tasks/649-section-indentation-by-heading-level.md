# Task 649 — Indent each section by its heading level

**Status:** open.
**Origin:** Project Owner feature request.
**Severity:** feature (low to medium risk; display only, across every mode).
**Tech stack:** extension host settings (`package.json` contributes, `src/platform/editor-config.ts`, `src/shared/protocol.ts`, `src/webview-host/html-builder.ts`), webview (`media-src/src/boot/live-config.ts`, section structure from [Task 258](done/258-section-folding.md)), CSS (`media-src/src/main.css`, content themes), Vitest, Chromium, real VS Code.
**Related:** [Task 258](done/258-section-folding.md) (section folding: the heading-to-section structure), [Task 438](done/438-vscode-native-preview-margins.md) and [Task 497](done/497-full-width-top-padding.md) (page margins and `--vmde-gutter`), [Task 300](300-content-width-presets.md) (content-width presets, planned), [Task 250](250-heading-numbering.md) (automatic heading numbering, planned).

## Problem

Every section of a document starts at the same left edge, whatever its heading level. In a long document with nested headings (`##` inside `#`, `###` inside `##`), the nesting is visible only from heading sizes, so it is hard to see where a subsection belongs.

## Requirements

1. **Indent sections recursively.** A new setting, off by default, indents each section by its depth: the content under a level-2 heading is indented one step, under a level-3 heading two steps, and so on, for every level. A section ends at the next heading of the same or a higher level, so its indentation ends there too.

   ```markdown
   # Guide                     ← no indent
   Intro text.                 ← no indent
   ## Install                  ← 1 step
   Install text.               ← 1 step
   ### Linux                   ← 2 steps
   Linux text.                 ← 2 steps
   ## Use                      ← 1 step
   ```

2. **One size setting.** A second setting sets the size of one indentation step, applied at every depth (depth × step).
3. **Every mode.** Both settings take effect in WYSIWYG, Instant Rendering, Split (source pane and preview pane) and Preview.
4. **Display only.** Indentation never changes the document text, dirty state, Undo history, caret or selection, and is not copied, exported or saved.
5. **Live and scoped.** Both settings apply live, without reopening the editor, and have `resource` scope like the other `vmde.editor.*` settings. Invalid values fall back to the default.
6. **Layout stays correct.** Indented content keeps working with: section folding and hoisting, the outline and its viewport highlights, block and list gutter handles, fold glyphs, Git change bars, wide content (tables, code blocks, diagrams, images), the full-width and narrow layouts, and the Split View scroll sync.

## Open design points (settled in Part 1)

- Setting names and value format (proposed: `vmde.editor.sectionIndent` boolean and `vmde.editor.sectionIndentSize` in pixels, with a default and an allowed range).
- Whether the heading line itself is indented with its section's content (as in the example) or one step less, and whether the first level starts at depth 0 when a document's top heading is `##`.
- How depth is computed: from the heading level in the source, or relative to the nearest enclosing heading (a `####` directly under `##`); headings inside lists, quotes, Details or callouts.
- How Split's source pane shows indentation for raw Markdown (visual offset per source line), and how that interacts with Task 645's line-number gutter.
- How wide blocks behave when the indent plus their width exceeds the column (shrink, scroll, or overflow), and the cost on large documents (Task 573 budgets) during streaming.

## Scope

- In: the two settings, depth calculation, indentation in all four modes, compatibility with the listed layout features.
- Out: changing heading styles or sizes, heading numbering (Task 250), content-width presets (Task 300).

## Acceptance

- [ ] With the setting on, measured left offsets of headings and section content match depth × step in WYSIWYG, IR, Split (both panes) and Preview, for a fixture with levels 1–6 and level skips.
- [ ] A section's indentation ends at the next heading of the same or a higher level.
- [ ] Changing the step size changes every depth's offset proportionally, live.
- [ ] With the setting off, layout is unchanged from today.
- [ ] Folding, hoisting, outline highlights, gutter handles, fold glyphs, change bars, wide blocks and scroll sync keep working with indentation on.
- [ ] Document text, dirty state, Undo history, caret and selection are unchanged; copy and export carry no indentation.
- [ ] Large-document scrolling and typing stay within the Task 573 budgets with indentation on.
- [ ] Focused Vitest, Chromium and real-VS-Code specs are written and run; network-free gates pass at closure.

## Tests

- Vitest: depth calculation (levels, skips, nested containers), setting validation.
- Chromium: measured offsets per mode and depth, live size change, interaction checks (folding, hoisting, outline, handles, change bars, wide blocks), copy content, large-document timing.
- Real VS Code (`test/vscode-e2e/`): settings applied live in each mode with measured offsets; document bytes, dirty state and Undo unchanged.
