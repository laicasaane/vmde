# Task 643 — Preview mode: stream large documents and render faster than the edit modes

**Status:** open.
**Origin:** Project Owner feature request.
**Severity:** feature (medium risk; replaces how Preview renders).
**Tech stack:** TypeScript webview (`media-src/src/chrome/open-preview.ts`, `editing/preview-state.ts`, `editing/preview-morph.ts`, `diagrams/stream-render.ts`, `diagrams/stream-chunk.ts`, `boot/vditor-init.ts`, `boot/finish-init.ts`), Lute (`Md2HTML`), diagram renderers, Vitest, Chromium, real VS Code.
**Related:** [Task 642](642-toolbar-layout-follow-ups.md) (Preview becomes the fourth mode with its own remembered toggle), [Task 641](done/641-open-to-ready-one-second.md) (open-to-ready time; its deferred "render what is on screen first" item).

## Problem

Preview is Vditor's overlay, not a mode VMDE renders. VMDE turns it on by clicking Vditor's Preview button (`chrome/open-preview.ts`). Vditor then reads the whole document back out of the edit view, converts it to HTML in one `Md2HTML` call, and runs every diagram, math and code renderer.

This has three costs:

- **Preview waits for an edit mode.** It reads its Markdown from the edit view, so the edit view must be built first, including the edit-only work that Preview does not need.
- **No streaming.** The edit modes stream documents over 700,000 characters in about 4 KB chunks (`diagrams/stream-render.ts`, `STREAM_MIN_CHARS`). Preview has no streaming path, so a large document is one long render. For that reason a large document never opens in Preview today (`boot/vditor-init.ts`).
- **Slower than it needs to be.** Preview is read-only, yet it pays for the edit modes' startup: the editable DOM, Undo history, the source index, caret and selection handling, and the edit-surface observers.

## Requirements

1. **Preview is its own mode.** Preview renders the document itself instead of driving Vditor's overlay. It renders from the document text the host sends, not from an edit view, and does not build an edit view first.
2. **Streaming.** Documents over the streaming threshold stream into Preview in chunks, as the edit modes do. Content appears progressively, and no single render step blocks the editor long enough to be noticed. Links and footnotes that point across chunks render exactly as in a one-pass render (reuse the cross-chunk definition handling in `stream-chunk.ts`).
3. **Faster than the edit modes.** For the same document, Preview reaches visible content and finishes rendering faster than IR, WYSIWYG and Split, because it skips edit-only work: no editable DOM, no Undo history, no source index, no caret or selection tracking, no edit-surface observers.
4. **Render what is on screen first.** Diagrams, math and other heavy blocks render when they are on or near the screen, not all at open.
5. **Same output.** Preview looks the same as today's Preview for the same document and settings: content theme, code highlighting, diagram palettes, callouts, Details, wiki links, anchors, images and remote-content rules.
6. **Same Preview features.** Everything Preview offers today keeps working: interactive task-list checkboxes (one exact source edit, one Undo step), link and wiki-link navigation, heading anchors, the outline and its highlighting, reading position when switching to and from an edit mode, copy, diagram controls, and the read-only toolbar state.
7. **Find works in Preview; Replace does not.** Find opens in Preview, searches the rendered document and highlights and scrolls to matches. The Replace row and its actions are unavailable in Preview, and Replace keys do nothing there.
8. **Mode switching.** Switching between Preview and an edit mode keeps the reading position and leaves the document, dirty state and Undo history unchanged. The edit view is built only when the user switches to an edit mode.
9. **Split's preview pane.** Part 1 decides whether Split's preview pane uses the same renderer and streaming.

## Open design points (settled in Part 1)

- Where the renderer lives (a new module beside `diagrams/stream-render.ts`) and how much of Vditor's `Preview.render` post-processing it reuses or replaces.
- How Preview gets the document text before an edit view exists (the `init` message and the incremental seed), and how it follows host edits while open (external changes, checkbox edits).
- How the existing current-render reuse (`editing/preview-state.ts`) and preview morphing (`editing/preview-morph.ts`) fit the new renderer.
- The streaming threshold and chunk size for Preview, which may differ from the edit modes because Preview has no editable DOM.
- How Find, the outline and reading-position anchoring work without Vditor's Preview pane.
- Measurable targets for requirement 3 (for example, open-to-visible and open-to-complete times relative to IR on the Task 641 fixtures), proposed in Part 1 for the Owner.

## Scope

- In: a VMDE-owned Preview renderer, streaming into Preview, on-screen-first rendering of heavy blocks, mode switching to and from Preview, and keeping every current Preview feature.
- Out: the Preview toggle's placement, icon and remembered state (Task 642), edit-mode streaming changes, new Preview features.

## Acceptance

- [ ] Opening a document in Preview builds no edit view; switching to an edit mode builds it then.
- [ ] A document over the streaming threshold opens in Preview with content visible before the whole document is rendered, and no long task above the Part 1 limit during streaming.
- [ ] Rendered output matches today's Preview for a fixture set covering links and footnotes across chunks, diagrams, math, callouts, Details, task lists, wiki links, anchors and images.
- [ ] On the Task 641 fixtures, Preview reaches visible content and finishes rendering faster than IR, by the Part 1 targets.
- [ ] Heavy blocks off screen render only when scrolled near.
- [ ] Task-list checkboxes, link and wiki navigation, anchors, the outline, copy and diagram controls work in Preview.
- [ ] Find works in Preview (matches highlighted, next/previous scroll to them); Replace is unavailable and its keys change nothing.
- [ ] Switching between Preview and each edit mode keeps the reading position, with no edit, dirty state or Undo step.
- [ ] Focused Vitest, Chromium and real-VS-Code specs are written and run; network-free gates pass at closure.

## Tests

- Vitest: chunked Preview rendering equals one-pass `Md2HTML` output (cross-chunk links and footnotes), the threshold decision, text updates while open.
- Chromium: progressive rendering and long-task limits on a large fixture, on-screen-first diagrams, feature checks (checkboxes, links, outline, Find, Replace unavailable), mode switching.
- Real VS Code (`test/vscode-e2e/`): open in Preview without an edit view, large-file streaming into Preview, timing against IR on the Task 641 fixtures, checkbox edit with one Undo step, switching to and from an edit mode.
