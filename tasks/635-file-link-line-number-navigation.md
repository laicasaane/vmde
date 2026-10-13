# Task 635 — Open file links with line-number notation at that line

**Status:** planned (2026-10-14). The Project Owner requested this task on 2026-10-14. Implementation has not started.
**Origin:** Project Owner report (chat, 2026-10-14).
**Severity:** medium (estimated). A link that names a file and line shows an error toast instead of opening the file.
**Tech stack:** extension host link handling (`src/shared/link-target.ts`, `src/session/asset-link-actions.ts`), Vitest, Chromium, real VS Code.

## Problem

Clicking a markdown link to a file reference with line-number notation, such as `[x](src/foo.ts:42)` or `[x](src/foo.ts#L42)`, shows an error toast. It should open that file at that line.

## Current code and suspected cause (unverified)

- `classifyHref` in `src/shared/link-target.ts` splits only a `#fragment` off a local path. A `:42` suffix stays in the path.
- `onOpenLink` in `src/session/asset-link-actions.ts` resolves `src/foo.ts:42` as a literal filename, `workspace.fs.stat` fails, and it shows `File not found: …`.
- A `#L42` fragment is treated as a heading fragment (Task 243): for a non-markdown file it is ignored, for a markdown file it finds no heading.
- The code-ref chip path (`onOpenCodeRef`, Task 229) already opens a plain text editor at a 1-based line and column. It can be reused.

## Notations in scope (default; Project Owner may override)

- `path:line` and `path:line:col` (1-based), the form used by compilers and terminals.
- `path#L<line>`, `path#L<line>-L<end>` and `path#L<line>C<col>` (GitHub/GitLab style). A range selects or reveals its start line; the end line may select the range.
- Relative and absolute paths, percent-encoded paths, and Windows drive letters (`C:\x\y.ts:12` must not lose its drive colon).

## Default decisions (Project Owner may override)

- If a file whose literal name includes the suffix exists (for example a real file named `foo:42` on Linux), open that file; otherwise strip the line notation and open the base file at the line.
- Non-markdown targets open in the plain text editor at the line and column, like `onOpenCodeRef`.
- Markdown targets keep Task 468's editor choice (VMDE when reading in VMDE). A line target then reveals that line (the existing `reveal-line` message); a plain `#heading` fragment keeps Task 243's heading navigation.
- A line beyond the end of the file opens the file at its last line; it is not an error.
- Workspace containment, `File not found` and directory handling stay as they are for the base path.

## Acceptance

- [ ] Every notation above opens the right file at the right line (and column when given), in IR, WYSIWYG, SV and Preview.
- [ ] `file.md#heading` and plain file links behave as before; a missing base file still shows `File not found` naming the base path.
- [ ] Windows drive-letter paths and literal colon filenames are handled per the rules above (unit-tested).
- [ ] Outside-workspace targets are still refused.
- [ ] Focused real-VS-Code spec written and run; `npm run quality` passes.

## Tests

- Vitest: `link-target` parsing for every notation, edge cases (`:0`, no line, range, column, drive letter, percent-encoding, literal colon file), and the open-action routing with mocked `vscode`.
- Real VS Code (`test/vscode-e2e/`, related: `local-link-open.spec.ts`): click each notation in IR and check the active editor, file and selection line; a markdown target opened in VMDE reveals the line; no error toast. Run `node build.mjs` first, then the spec under `xvfb-run`.
