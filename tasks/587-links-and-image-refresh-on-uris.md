# Task 587 — Links, code references and image refresh on URIs

> **For agentic workers:** Use `superpowers:executing-plans`. Checkboxes track implementation and acceptance.

**Status:** planned (draft, 2026-09-28).
**Goal:** Resolve these through document URIs, so they work on every scheme and never throw for `untitled` documents:
- relative Markdown links, including `file.md#fragment` jumps;
- code references;
- the image-refresh watcher.

Desktop results stay the same.
**Spec:** This file and [Task 581](581-web-extension-support.md) sections 2 and 4 (review-focus items 1 and 2).
**Dependencies:** [Task 586](586-open-virtual-documents.md), which provides the active document URI. It builds on [Task 585](585-uri-path-helpers.md) and [Task 583](583-web-readiness-ratchet-and-node-free-globals.md).
**Repository skills:** `.agents/skills/vmde-testing/SKILL.md`.

## 1. Implementation

### Checkpoint 1 — Links and code references

- [ ] Resolve targets with `resolveLinkTarget(docUri, text)` and check containment with `isUnder` in `src/session/asset-link-actions.ts` at the open-link path (around lines 191–214) and the code-reference path (around lines 461–469).
  - Stat the resolved URI.
  - Keep the `Uri.file` branch for absolute and Windows paths when the document scheme is `file`.
  - Keep the existing "File not found" and outside-workspace messages.
- [ ] Read `file.md#fragment` targets (around line 284) with `utf8Decode(await vscode.workspace.fs.readFile(uri))`. Task 583 may already have done this; if so, only switch the target to a URI.
- [ ] For `untitled` documents, skip document-relative resolution for links, code references and images. Report the same way as an unresolved link today, and do not throw. Today, `resolve` on a relative `fsPath` calls `process.cwd()` on the web, and desktop resolves against the host's working directory.

### Checkpoint 2 — Image watcher and the `assets-changed` contract

- [ ] Change `src/session/image-asset-watcher.ts` to use URIs throughout.
  - Compute the referenced image URIs from the document URI (around lines 140–150).
  - Create each watcher (around lines 185–189) with `new vscode.RelativePattern(dirUri(img), baseName(img))`.
  - Create no watchers for `untitled` documents.
  - Keep the 100-watcher limit.
- [ ] Define the `assets-changed` payload (`src/shared/protocol.ts:223`, sent at `src/session/editor-session.ts:1225`) so the webview matcher works in both environments:
  - `imageMatchesPath` in `media-src/src/links/image-refresh.ts:33`;
  - `filePathOfResourceUrl` at lines 20–30, which strips the leading `/` before a drive letter and normalizes `\`.

  The environments are:
  - Windows desktop `file` URIs, whose resource URL pathname is `/c:/…`;
  - `vscode-vfs` resource URLs, whose pathname is `/owner/repo/…`.

  **Part 1 fixes the exact field**, for example the host sends `uri.path` and the webview compares after stripping the drive slash on both sides. The host and webview changes land together, with unit tests on both sides for POSIX, Windows-drive, UNC and `vscode-vfs` inputs.
- [ ] Remove the `node:path` imports these files no longer need, and delete the resolved ratchet allowlist entries.

## 2. Scope

- **In scope:** the items above.
- **Out of scope:** image writes (Task 588) and wiki links (Task 589).
- **Preservation:**
  - link navigation, fragment jumps and code-reference chips on desktop;
  - the refresh behavior of Tasks 513 and 562: in-place replacement, reference-style images, encoded paths.

## 3. Verification

- Unit tests:
  - link and code-reference resolution with `vscode-vfs`, Windows `file`, UNC and `untitled` fixtures;
  - watcher patterns;
  - host and webview `assets-changed` matching.
- Chromium: `media-src` unit tests for `image-refresh.ts`.
- Real VS Code: run `node build.mjs` first. Then run these focused, no-retry specs, found by search:
  - link navigation and fragment jump;
  - code references;
  - image refresh after an on-disk replacement.
- Changed-line coverage and the network-free quality stages run once on the final candidate.

## Execution progress

Not started.
