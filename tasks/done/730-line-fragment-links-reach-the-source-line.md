# Task 730 — Links with a `#L<line>` fragment reach the correct source line

**Status:** done (2026-11-10).
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

- [x] `#L<line>` and `#L<a>-L<b>` links to the same document and to another Markdown file reach the right source line in IR, WYSIWYG, Split and Preview.
- [x] Heading ids and slugs still win over a line location (Task 635 rule).
- [x] The jump does not change the document, dirty state or Undo history.
- [x] Focused real-VS-Code spec and `npm run quality` pass.

## Cause

The reveal mapped a line through a line scanner that splits a list with blank lines between its items into one block per item (242 scanner blocks for 185 DOM blocks in the Owner's file), so line 674 mapped past the last block and the reveal gave up after 2 s. Split and Preview never revealed a line, a same-document `#L120` did nothing, a line inside a multi-line block landed on the block start, and a range revealed only its start.

## Decisions (worker, PROVISIONAL unless noted)

- D1 (PROVISIONAL): a same-document `#L42` / `#L42-L50` is resolved by the host against the document's own text, because the webview's serialization drops and adds blank lines (720 file lines vs 704 in IR, 683 in WYSIWYG). Heading ids, slugs and HTML ids are still resolved first. This replaces Task 635 decision 3 (a bare same-document `#L42` stayed a heading fragment).
- D2: IR and WYSIWYG map a line through the block handle's units (each top-level block and each list item with its source span), then find the line start inside the unit; the old scanner is the last fallback, and an index past the live blocks is a miss, never another block.
- D3 (PROVISIONAL): new module `media-src/src/bridge/line-reveal.ts` (surface dispatch, Split and Preview), registered in `scripts/module-manifest.mjs`; `links/` or `nav/` would create a module cycle or a disallowed edge.
- D4: `reveal-line` gains optional `endLine`/`endLineText`; IR, WYSIWYG and Split select the whole range, Preview reveals its start line.
- D5: Split's preview pane follows the source pane through the existing scroll sync.
- D6 (PROVISIONAL): in IR and WYSIWYG, a line inside a code, math or diagram block lands on the block start (its source is hidden); Split lands on the line, Preview on the rendered block.
- D7: a line that reads the same after list renumbering, table padding or marker spacing still matches; text absent from the document returns no target.
- D8: Reveal in Visual Editor (Task 52) uses the same message, so it is now line-precise and works in Split and Preview.

## Verification (orchestrator, 2026-11-10)

- `node build.mjs`: exit 0. `npm test`: 9467 passed, 1 expected fail.
- Real VS Code, through the wrapper: `line-fragment-links.spec.ts` (new: Owner case, ranges, open and not-open targets, same document, IR, WYSIWYG, Split, Preview), `file-link-line.spec.ts`, `source-line-reveal.spec.ts`, `anchor-links.spec.ts`, `id-target-navigation.spec.ts`, `local-link-open.spec.ts`: 15 passed.
- `npm run quality`: exit 0; every stage passes.
- Residual: Preview of a document over 50,000 characters that is still streaming is not exercised (the reveal retries for 2 s); a line with heavy inline syntax can land on its unit start.
