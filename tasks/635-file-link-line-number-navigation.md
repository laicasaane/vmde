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

## Part 1 handoff (2026-10-14)

Read-only review of the source; the classifier and the vendored Lute were exercised with scratch scripts only. No tests were run.

- **Cause (verified).** `classifyHref` (`src/shared/link-target.ts`) strips only `#fragment`, so `src/foo.ts:42` stays in `local.path` and `onOpenLink` (`src/session/asset-link-actions.ts`) reports `File not found`. New finding: a bare same-folder name (`foo.ts:42`, `foo.ts:42:5`) never reaches the local branch, because `SCHEME_RE` reads `foo.ts:` as a scheme and the link is refused ("scheme is not allowed"). `#L42` is a plain fragment: non-markdown targets ignore it; markdown targets find no heading and return silently. The webview posts the raw href unchanged in every mode (IR uses the marker text); Lute keeps all notations through WYSIWYG, Preview and the round-trip (Preview percent-encodes backslashes).
- **Reuse.** `onOpenCodeRef` opens a text document with a collapsed selection at (line − 1, column − 1); extract its tail into a shared `openTextAtLine` helper (it resolves workspace-relative paths, so `onOpenLink` keeps its own resolution and containment). Markdown targets reuse `reveal-line` (`src/shared/protocol.ts`; webview `message-router.ts` → `revealLineWithRetry` → `revealSourceLine`), as `scrollToFragmentAfterOpen` already does for named anchors.
- **Contract.**
  1. Notations: `path:line`, `path:line:col` (1-based); `#L<n>`, `#L<n>-L<m>`, `#L<n>-<m>` (added: GitLab form), `#L<n>C<c>`, `#L<n>C<c>-L<m>C<d>`; `L` uppercase only (GitHub heading slugs are lowercase, so no collision).
  2. Parsing: split the fragment first; percent-decode the path; then match `:(\d{1,9})(?::(\d{1,9}))?$` on the decoded path. The base must be non-empty, not end in `/` or `\`, and not end in `:\d+` itself (`a.ts:1:2:3` has no location). A drive colon (`C:\`) never matches.
  3. Scheme lookalike: when `SCHEME_RE` matches a token that is not an allowed scheme, the href is a local path only if the token has a dot and an alphanumeric extension (`foo.ts`) and the rest is `\d{1,9}(:\d{1,9})?` plus an optional `#…`. Everything else stays refused (`command:`, `file:`, `javascript:`, `vscode:`, `data:`, `README:3`, `Makefile:12`, `localhost:8080`); extensionless files use `./Makefile:12` or `#L12`.
  4. A suffix and a `#L` fragment together: the suffix sets the line; the fragment keeps heading semantics.
  5. Output: `path` stays the literal decoded path; new optional `location: { path, line, column?, endLine?, endColumn?, via: 'suffix' | 'fragment' }`, undefined for other hrefs. Line or column 0 clamps to 1; a reversed range drops the end; more than 9 digits gives no location.
  6. Routing in `onOpenLink`: containment on both the literal and the base path. For a suffix, `stat` the literal path first (an existing literal-colon file opens as before, no line); otherwise `stat` the base (`File not found: <base>` if missing; a directory reveals in Explorer). Non-markdown file: `openTextAtLine`, line clamped to the file, a range selects start to end; only if `openTextDocument` throws, fall back to a plain open with no toast. Markdown with VMDE as the source editor (Task 468): open with `vmde.editor`, then post `reveal-line` (0-based, clamped, with `lineText`) through a private `postToTargetPanel` extracted from `scrollToFragmentAfterOpen`. Markdown with another source editor: open with selection options. Task 243 precedence: heading id, slug and named anchor first; `reveal-line` only when they all miss and the location came from a `#L` fragment.
- **Part 2.** S1: `src/shared/link-target.ts` (+ `test/backend/link-target.test.ts`; `media-src/src/links/same-doc-anchor.ts` needs no change). S2: `src/session/asset-link-actions.ts` (`openTextAtLine`, literal-first stat, `postToTargetPanel`, `#L` fallback) with `test/backend/asset-link-actions.test.ts` and `test/backend/open-link.test.ts`. S3: new `test/vscode-e2e/file-link-line.spec.ts` modelled on `local-link-open.spec.ts` (fixture tree with `a.ts` of 30 lines, `b.md`, a literal `lit.ts:7`, a binary-like file, a `../` escape; IR for every notation, one leg each for WYSIWYG, SV and Preview), plus `local-link-open.spec.ts` and `anchor-links.spec.ts`.
- **Vitest cases (classifier).** `src/foo.ts:42` → location 42 via suffix; `:42:5` → column 5; `./a.ts:3`, `../a.ts:3`, `/abs/a.ts:3`; bare `foo.ts:42` and `foo.ts:42:5` → local with location; `src/foo.ts#L42` → line 42 via fragment; `#L42-L50`, `#L42-50` → end 50; `#L42C5`; `#L42C5-L50C8`; `#L50-L42` → 50, no end; `#L0`, `foo.ts:0`, `foo.ts:0:0` → 1 (and column 1); `#l42`, `#L`, `#L42x`, `#L-5` → no location; `foo.ts:42#L50` → suffix wins; `C:\x\y.ts:12`, `C:/x/y.ts:12:5`, `C:\x\y.ts` (none), `C:\x\y.ts#L12`, `C:\12` (none); `my%20file.ts:42`; `src/foo.ts%3A42`; `100%.ts:3`; `a%23b.ts:42`; no location for `foo.ts`, `foo.ts:`, `:42`, `src/:42`, `foo.ts:abc`, `foo.ts:42x`, `foo.ts:1:2:3`, `foo.ts:12345678901`; `./Makefile:12` → location; `Makefile:12`, `README:3`, `command:42`, `file:42`, `javascript:1`, `vscode:1`, `command:workbench.x`, `ftp://x.ts:42` → refused; `tel:5551234`, `mailto:a@b.c` → scheme; `https://h:8080/x.ts:42` → external; `a.md#heading` → no location; bare `#L42` → same-document anchor (unchanged).
- **Routing cases (mocked `vscode`).** `foo.ts:42` with the literal missing → selection (41, 0), no plain open, no error; `:42:5` → (41, 4); literal and base both exist → plain open of the literal; base missing → `File not found: <base>`; `#L42-L50` → (41, 0) to end of line 50; line past the end → last line; `b.md:3` with VMDE → `openWith` plus `reveal-line` line 2; `b.md#L3` with a heading id `L3` → heading wins; `b.md#L3` with no match → `reveal-line`; markdown with another editor → open with selection; `../../etc/passwd:1` and `/etc/passwd#L1` refused as outside the workspace; directory base → reveal in Explorer; `openTextDocument` throws → plain open, no toast; `open-link.test.ts`: bare `foo.ts:42` gives no scheme error; existing `onOpenCodeRef` tests stay green.
- **Edge cases.** Windows alternate data streams may make the literal-first `stat` succeed (low risk); `example.com:8080` now reports `File not found` instead of the scheme error; revealing a blank or fenced line (probe in S3; snap to the next non-blank line if it fails silently); unsaved edits (reveal reads the live buffer); Preview Windows backslash links stay refused (pre-existing gap, out of scope).
- **Owner questions (provisional choices, reversible).** (1) Scheme lookalike: only dotted-extension tokens with a numeric remainder become local paths — adopted (the stricter option keeps the unknown-scheme refusal). (2) `reveal-line` works only when the target opens in IR or WYSIWYG (SV and Preview targets are a silent no-op, as for named anchors today): accepted; the acceptance "in IR, WYSIWYG, SV and Preview" is read as the mode of the clicking document; a follow-up for SV/Preview reveal is offered at queue end. (3) A bare same-document `#L42` stays a heading fragment — adopted. (4) A `#L42-L50` range selects the lines in text editors; VMDE reveals the start line — adopted.
