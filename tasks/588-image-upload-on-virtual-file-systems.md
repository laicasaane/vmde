# Task 588 — Image upload, paste and drop on writable virtual file systems

> **For agentic workers:** Use `superpowers:executing-plans`. Checkboxes track implementation and acceptance.

**Status:** planned (draft, 2026-09-28). Blocked on program decision D2.
**Goal:** Pasted, dropped and uploaded images are written next to the document on any writable, trusted file system, including GitHub repositories on vscode.dev. VMDE inserts a correct relative link. Desktop destinations and link text stay the same, including Windows and UNC paths.
**Spec:** This file, [Task 581](581-web-extension-support.md) section 2 and decision D2.
**Dependencies:**
- [Task 586](586-open-virtual-documents.md), which provides document URIs. It builds on [Task 585](585-uri-path-helpers.md) and [Task 583](583-web-readiness-ratchet-and-node-free-globals.md) (`base64ToBytes`).
- Task 582 row P1 must confirm that `createDirectory` and `writeFile` work on `vscode-vfs`.
- A separate fix for UNC authority loss may land first (see Checkpoint 2). Reread `src/platform/editor-config.ts` before Part 1.

**Repository skills:** `.agents/skills/vmde-testing/SKILL.md`.

## 1. Implementation

### Checkpoint 1 — Write gate and bytes

- [ ] Change `ensureCanWriteFiles(uri)` in `src/session/asset-link-actions.ts:26-27`. With D2 (a), it allows writes when `vscode.workspace.fs.isWritableFileSystem(uri.scheme) === true` and `vscode.workspace.isTrusted`.
  - Otherwise it shows one message covering read-only and untrusted workspaces, replacing "…unavailable in virtual workspaces."
  - Keep both callers (lines 97 and 418).
- [ ] Write image bytes with `base64ToBytes(file.base64)` (line 134). Task 583 may already have done this.

### Checkpoint 2 — Destinations and link text on URIs

- [ ] Rework the destination code in `src/platform/editor-config.ts`: the `${file}`, `${dir}` and `${projectRoot}` templating (around lines 312–331) and `markdown.copyFiles.destination` (around lines 340–357).
  - Build the target as a `vscode.Uri` that keeps the document's scheme and authority, with `uri.with({ path })` or `vscode.Uri.joinPath`. Do not use `vscode.Uri.file(destination).fsPath` built from `uri.path`.
  - This also fixes the desktop UNC bug: `file://server/share/…` documents currently write to `\share\…` on the current drive.
  - Resolve `vmde.image.saveFolder` against the workspace folder URI with `vscode.Uri.joinPath`.
  - Accept absolute Windows paths only for `file` documents, as a desktop branch.
- [ ] Keep `src/platform/copy-files-destination.ts` a pure POSIX function. Callers pass `uri.path` values and apply the result with `uri.with({ path })`.
- [ ] Change the write path (around lines 105–139): `createDirectory` and `writeFile` on the target URIs. Build the inserted link text with `relativeLinkPath(docUri, targetUri)`, giving desktop parity for forward slashes and cross-drive output (Task 585 parity table).
- [ ] Update the `vmde.image.saveFolder` description (`package.json` around line 1076) for virtual workspaces.
- [ ] Remove the `node:path` imports these files no longer need, and delete the resolved ratchet allowlist entries.

## 2. Scope

- **In scope:** the items above.
- **Out of scope:** the paste pipeline in the webview. Its data already arrives as base64 through the host.
- **Preservation:** desktop destinations, link text, the save-folder templating, conflict naming and the untrusted-workspace behavior.

## 3. Verification

- Unit tests:
  - The gate matrix: `file`, writable virtual, read-only virtual, untrusted.
  - Destination templating on POSIX, Windows-drive, UNC and `vscode-vfs` documents.
  - Link-text parity, including cross-drive.
- Real VS Code: run `node build.mjs` first. Then run the focused image paste and upload specs, found by search, and a save → reopen exact-bytes check, with `--retries=0`.
- Web: Task 591's smoke test covers an image paste into a `vscode-test-web` mount. Task 595 covers a GitHub repository.
- Changed-line coverage and the network-free quality stages run once on the final candidate.

## Execution progress

Not started.
