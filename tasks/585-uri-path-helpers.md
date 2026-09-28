# Task 585 — URI path helpers with Windows desktop parity

> **For agentic workers:** Use `superpowers:executing-plans`. Checkboxes track implementation and acceptance.

**Status:** planned (draft, 2026-09-28).
**Goal:**
- Add one tested helper module that replaces `node:path` on `fsPath` strings in host code.
- It must work for every URI scheme VS Code for the Web uses.
- It must produce the same results as today on desktop, including Windows.
- Git repository containment is the first consumer to move to it.

**Spec:** This file and [Task 581](581-web-extension-support.md) section 2. Review-focus item 1 belongs to this task.
**Dependencies:** [Task 583](583-web-readiness-ratchet-and-node-free-globals.md). Tasks 586–589 consume these helpers.
**Repository skills:** `.agents/skills/vmde-testing/SKILL.md`.

## 1. Implementation

### Checkpoint 1 — Inventory

- [ ] List every `NodePath.*`, `node:path` and `.fsPath` use in `src/`, excluding `*.test.ts`, in a table in section 4. Give each use:
  - file and line;
  - the operation;
  - its category: identity/key, IO target, link text, display, glob/watch pattern, or containment;
  - the owning task (586, 587, 588 or 589).
- [ ] Record the importers of `node:path`: `markdown-editor-provider.ts`, `copy-files-destination.ts` (`posix` only), `editor-config.ts`, `tab-targeting.ts`, `asset-link-actions.ts`, `editor-session.ts`, `emoji-recents-store.ts` (removed by Task 583), `image-asset-watcher.ts`, `diagram-cache-host.ts` (moved by Task 584), `html-builder.ts` (Task 583), `wiki-cache.ts`, `wiki-session.ts`, `wiki.ts`, `git-diff.ts` and `lute-host.ts` (Task 584).

### Checkpoint 2 — Helpers and parity tests

- [ ] Add `src/platform/uri-path.ts` (proposed). It must not import `node:*`. Part 1 finalizes the signatures under the rules below.
  - `dirUri(uri)` returns `vscode.Uri.joinPath(uri, '..')`.
  - `baseName(uri)`, `extName(uri)` and `stem(uri)` read from `uri.path`.
  - `resourceKey(uri)` returns `uri.toString()`.
  - `isSameResource(a, b)` and `isUnder(child, parent)`:
    - scheme and authority must match;
    - `isUnder` also needs a path-segment prefix match;
    - for `file` URIs with a drive letter, path comparison ignores case, matching today's `path.win32` behavior on Windows;
    - otherwise comparison is case-sensitive.
  - `resolveLinkTarget(docUri, linkText)`:
    - normalizes `\` to `/` in `linkText` before resolving;
    - resolves relative text against `dirUri(docUri)`;
    - resolves `/`-rooted text against the workspace folder, as today;
    - handles absolute Windows paths (`C:/…`, `C:\…`) only for `file` documents, through `vscode.Uri.file`;
    - returns `undefined` for `untitled` documents instead of throwing.
  - `relativeLinkPath(fromDocUri, targetUri)`:
    - returns forward-slash relative text when scheme and authority match;
    - when drive letters or authorities differ, returns exactly what today's code produces on that platform (for example an absolute `d:\…` path on Windows). Record the chosen outputs in the parity table.
- [ ] Add `test/backend/uri-path.test.ts` (proposed). Use the `vscode` mock with `Uri.file`, `Uri.parse` and `Uri.joinPath` behaving like VS Code's for POSIX and Windows-style `file` paths (`/c:/repo/...`). Include these fixtures:
  - `vscode-vfs://github/owner/repo/...` and `vscode-vfs://github+<ref>/owner/repo/...`;
  - `vscode-test-web://mount/...`;
  - `untitled:Untitled-1`;
  - a UNC `file://server/share/...`.
- [ ] Add a parity table test. For each inventory pattern in section 4, compute the legacy output in the test with Node's `path.win32` and `path.posix`, and assert the helper output matches. Tests may import `node:path`; they are not in the web graph. Cover:
  - backslash link text (`images\a.png`, `..\b.md`);
  - drive-letter case differences;
  - links that cross drives;
  - UNC paths;
  - `vmde.wiki.root` values with backslashes.

### Checkpoint 3 — Git repository containment

- [ ] Replace `fsPath === root || fsPath.startsWith(root + NodePath.sep)` in `src/writeback/git-diff.ts:33-35` with `isUnder(documentUri, repo.rootUri)` or equality.
  - Change `getHeadContent` and its scheduler caller to pass the document URI instead of `fsPath`.
  - Compute the path relative to the repository (line 38) with the helper, matching today's desktop output.
  - Remove the `node:path` import.

## 2. Scope

- **In scope:** the helper module, its tests and the git containment change.
- **Out of scope:** migrating the other consumers (Tasks 586–589).
- **Preservation:** every legacy desktop output in the parity table, and the git gutter on Windows and POSIX.

## 3. Verification

- Unit: the helper and parity tests. `git-diff` unit tests use POSIX, Windows and case-differing drive fixtures.
- Real VS Code: run `node build.mjs` first. Then run the git gutter spec, found by searching for `git` / `gutter`, with `--retries=0`.
- CI runs on Linux, so the parity tests are the Windows evidence. An independent review checks the Windows rows.
- Changed-line coverage and the network-free quality stages run once on the final candidate.

## 4. Inventory

Filled in Checkpoint 1.

## Execution progress

Not started.
