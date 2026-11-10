# Task 730 — Links with a `#L<line>` fragment reach the correct source line

**Status:** planned (2026-11-10).
**Origin:** Owner request, 2026-11-10.
**Severity:** medium. A link such as `notes.md#L42` or `#L42` must land on source line 42 of its target in edit mode (IR, WYSIWYG, Split) and in Preview.
**Tech stack:** host link actions (`src/session/asset-link-actions.ts`: `scrollToFragmentAfterOpen`, `revealLineMessage`, line locations from Task 635), webview link clicks (`media-src/src/links/link-click.ts`, `link-click-fix.ts`, `same-doc-anchor.ts`), source-line reveal in the webview (`media-src/src/util/source-map.ts`), Preview.
**Depends on:** none. Related: Task 635 (line locations `#L42`, `#L42-L50`, `file.md:42` for other files), Task 243 (cross-file heading fragments).

## Owner request

A hyperlink with a `#L<line>` fragment reaches the correct source line, in both edit mode and Preview.

## Owner example

- `[point 14](scoping-proposal.md#L674)`: `scoping-proposal.md` has no heading `L674`, yet clicking the link does not scroll to line 674 (Owner, 2026-11-10). The spec reproduces this case first.

## Known before the task

- Task 635 already reveals a line location after opening another file in a VMDE panel or a text editor; a heading id or slug named like the fragment (a heading `L3`) wins over the line location.
- Not yet established: whether same-document `#L<line>` links work, whether the revealed line is correct in every mode (front matter, folded sections, hidden source, wrapped lines), and whether Preview reveals the line at all.

## Proposed work

1. Investigation: list every case (same document and another Markdown file; IR, WYSIWYG, Split source and preview panes, Preview; `#L42` and `#L42-L50`; with front matter, folded or hoisted sections, long documents still streaming into Preview; link clicked in edit mode and in Preview) and record what happens now, with the cause of each failure.
2. Fix each failing case so the target line is scrolled into view and, in edit mode, the caret lands at the start of that line (a range selects its lines where the mode supports a selection). Preview scrolls the rendered block that holds the line into view.
3. Real-VS-Code spec covering the matrix above.

## Acceptance

- [ ] `#L<line>` and `#L<a>-L<b>` links to the same document and to another Markdown file reach the right source line in IR, WYSIWYG, Split and Preview.
- [ ] Heading ids and slugs still win over a line location (Task 635 rule).
- [ ] The jump does not change the document, dirty state or Undo history.
- [ ] Focused real-VS-Code spec and `npm run quality` pass.
