# Task 586 — Open, render, edit and save Markdown from virtual workspaces

> **For agentic workers:** Use `superpowers:executing-plans`. Checkboxes track implementation and acceptance.

**Status:** planned (draft, 2026-09-28).
**Goal:** VMDE opens, renders, edits and saves `.md` files whose URI is not `file:`. That includes GitHub repositories on vscode.dev (`vscode-vfs`), `@vscode/test-web` mounts, and local folders opened in the browser. The entry points behave the same way for every scheme:
- the title buttons;
- **Open with VMDE**;
- **Reopen Editor With**;
- the outline;
- the status bar.

Relative images render, and external CSS applies. Desktop behavior does not change.
**Spec:** This file and [Task 581](581-web-extension-support.md) sections 2 and 4 (review-focus items 1 and 3).
**Dependencies:** [Task 585](585-uri-path-helpers.md).
**Repository skills:** `.agents/skills/vmde-testing/SKILL.md`.

## 1. Implementation

### Checkpoint 1 — Which documents VMDE accepts

- [ ] Change the supported-scheme rule behind `isSupportedMarkdownUri` (`src/platform/tab-targeting.ts:9-20`). Replace `SupportedSchemes = new Set(['file', 'untitled'])`: a URI is supported when its scheme is `untitled` or when `vscode.workspace.fs.isWritableFileSystem(uri.scheme) !== undefined` (a file-system provider exists). The Markdown extension check is unchanged.
- [ ] Keep the consumers on this one rule:
  - `src/app/commands.ts:52`;
  - the outline at `src/app/extension.ts:83`;
  - the status bar at `src/app/status-bar.ts:118`.
- [ ] Change the error text at `commands.ts:53` from "Markdown editor can only open local markdown files." to a scheme-neutral message, for example "VMDE can only open Markdown files from a file system VS Code can read." Update the tests that assert the old text.
- [ ] In `package.json`, replace `(resourceScheme == file || resourceScheme == untitled)` in the two `editor/title` `when` clauses (lines 305 and 310) with `(isFileSystemResource || resourceScheme == untitled)`. `isFileSystemResource` is a VS Code resource context key, checked in the pinned 1.135 bundle.
- [ ] Remove the `scheme` keys from the four `customEditors[].selector` entries (lines 268–280); VS Code ignores them. Update the selector assertions in `test/backend/manifest.test.ts` (around lines 100–111).

### Checkpoint 2 — Document identity, base href and resource roots

- [ ] Replace the base href in `src/app/markdown-editor-provider.ts:183-185`. It is currently `NodePath.dirname(webview.asWebviewUri(vscode.Uri.file(uri.fsPath)).toString()) + '/'`.
  - The new value is `webview.asWebviewUri(dirUri(uri)).toString()`, with exactly one trailing `/`.
  - For `untitled` documents, use the workspace folder root when one exists, and otherwise no base href. Nothing may throw.
- [ ] In `webviewRoots` (`src/platform/editor-config.ts:115-126`), replace the fallback for a document without a workspace folder. It is currently `vscode.Uri.file(NodePath.dirname(documentUri.fsPath))` and only applies when the scheme is `file`. The new fallback is `dirUri(documentUri)` for every scheme except `untitled`.
- [ ] Key `_conflictOverrides` (`markdown-editor-provider.ts:127,137,151`) and every other `fsPath`-keyed map or set in the provider and in `src/session/editor-session.ts` by `resourceKey(uri)`.
- [ ] In `editor-session.ts`, replace `activeFsPath` with the active document `vscode.Uri`, and pass URIs to its consumers (git-diff after Task 585, the image watcher, asset-link actions).
  - Take the tab title and `documentName` from `baseName(uri)`.
  - Build the document watcher (around lines 228–243) with `new vscode.RelativePattern(dirUri(uri), baseName(uri))`, not a path computed with `relative()`.
- [ ] Remove the `node:path` imports these files no longer need, and delete the resolved ratchet allowlist entries.

### Checkpoint 3 — External CSS on URIs

- [ ] Rework the `vmde.css.external` loading in `src/platform/editor-config.ts:150-174`.
  - Resolve each relative entry with `vscode.Uri.joinPath` against the document's workspace folder URI; with no workspace folder, against `dirUri(document)`. Today it uses `workspaceFolders[0]`.
  - Accept absolute OS paths only when the document scheme is `file`, as a desktop branch using `vscode.Uri.file`.
  - Read each file with `await vscode.workspace.fs.readFile` and `utf8Decode`.
  - Finish every read before building the HTML, so there is no flash of unstyled content.
  - Remove `readFileSync`.
- [ ] Build the watcher in `src/webview-host/panel-config.ts:66` with `new vscode.RelativePattern(dirUri(cssUri), baseName(cssUri))` for each entry. Keep the existing `reload-css` path for changes.
- [ ] Update the `vmde.css.external` description (`package.json` around line 1023): absolute paths work only for local files.

## 2. Scope

- **In scope:** the items above.
- **Out of scope:**
  - Link and code-reference resolution and the image watcher (Task 587).
  - Image writes (Task 588).
  - The wiki (Task 589).
- **Preservation:** desktop open flows, conflict handling, titles, the document watcher, relative images, and external CSS on POSIX and Windows.

## 3. Verification

- Unit tests with `vscode-vfs`, `vscode-test-web`, `untitled` and Windows `file` fixtures:
  - the scheme rule, with a mocked `isWritableFileSystem`;
  - the base href and roots;
  - key separation between two branch authorities for the same path;
  - titles;
  - the watcher pattern;
  - CSS resolution: relative, absolute on `file`, rejected absolute on `vscode-vfs`.
- Real VS Code: run `node build.mjs` first. Then run these focused, no-retry specs, found by search:
  - open/edit/save/reopen exactness;
  - relative image rendering;
  - external CSS and its reload;
  - the save-conflict flow;
  - the outline and status bar.
- Web: Task 591's smoke test covers opening a `vscode-test-web` document with a relative image.
- Changed-line coverage and the network-free quality stages run once on the final candidate.

## Execution progress

Not started.
