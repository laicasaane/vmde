# Task 589 — Wiki links, index and Create Page on virtual workspaces

> **For agentic workers:** Use `superpowers:executing-plans`. Checkboxes track implementation and acceptance.

**Status:** planned (draft, 2026-09-28). Create Page depends on program decision D2.
**Goal:** Wiki links, autocomplete, the page index and **Create Page** work on every supported scheme. The index keys cannot collide across repositories or branches, and desktop behavior does not change.
**Spec:** This file and [Task 581](581-web-extension-support.md) sections 2 and 4 (review-focus item 3).
**Dependencies:**
- [Task 586](586-open-virtual-documents.md), which provides the supported-scheme rule and document URIs.
- [Task 588](588-image-upload-on-virtual-file-systems.md) Checkpoint 1, which provides the write gate for Create Page.
- Task 582 rows P1 and P2: `readDirectory`, `findFiles` and watcher events on `vscode-vfs`.

**Repository skills:** `.agents/skills/vmde-testing/SKILL.md`.

## 1. Implementation

### Checkpoint 1 — Gate, keys, root and Create Page

- [ ] Replace the `file`-only gate in `src/wiki/wiki.ts:46` with the supported-scheme rule from Task 586.
- [ ] Key the cache by URI instead of `fsPath`:
  - `src/wiki/wiki.ts:66`;
  - `src/wiki/wiki-cache.ts` around lines 65–96, 117–144, 179 and 204.

  Build page keys from the page URI's path relative to the wiki root URI, and scope roots by `resourceKey(rootUri)`.
- [ ] Resolve `vmde.wiki.root` with `vscode.Uri.joinPath(workspaceFolder.uri, root)`. This keeps the Windows behavior where a backslashed root such as `notes\wiki` works today.
- [ ] Make Create Page (`wiki.ts` around line 118) check the Task 588 write gate and write with `utf8Encode`.
- [ ] Remove the `node:path` imports from `wiki.ts`, `wiki-cache.ts` and `wiki-session.ts`, and delete the resolved ratchet allowlist entries.

### Checkpoint 2 — Index scan and watching

- [ ] Replace the breadth-first `readDirectory` scan (`wiki.ts` around lines 73–107) with `vscode.workspace.findFiles(new vscode.RelativePattern(rootUri, '**/*.{md,markdown}'), <exclude>)`.
  - **Part 1 fixes `<exclude>` and the ordering**, so desktop keeps today's page order, exclusions and depth behavior.
  - Record them here, and cover them with a parity unit test.
- [ ] Keep the watcher on a `RelativePattern`, but stop depending on its events. VMDE's own Create Page and renames update the cache directly. Task 582 row P2 records whether providers without events (for example the File System Access watcher without `FileSystemObserver`) deliver them.

## 2. Scope

- **In scope:** the items above.
- **Preservation:** desktop wiki behavior, autocomplete ordering and Create Page naming. This task does not change wiki link syntax.

## 3. Verification

- Unit tests:
  - Keys for the same page path under two `vscode-vfs` authorities: no collision.
  - The Windows backslash root.
  - Scan parity against a mocked `findFiles`.
  - Cache updates on create and rename without watcher events.
- Real VS Code: run `node build.mjs` first. Then run the focused wiki specs (search `wiki`) with `--retries=0`.
- Web: Task 591's smoke test covers resolving a wiki link on a `vscode-test-web` mount.
- Changed-line coverage and the network-free quality stages run once on the final candidate.

## Execution progress

Not started.
