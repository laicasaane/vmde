# Task 595 — Web documentation, manifest text and release acceptance

> **For agentic workers:** Use `superpowers:executing-plans`. Checkboxes track implementation and acceptance.

**Status:** planned (draft, 2026-09-28). Needs program decision D6.
**Goal:** Users and contributors can see what works on vscode.dev and github.dev, in which browsers, and with which limits. The web build is accepted on the real vscode.dev before release.
**Spec:** This file, [Task 581](581-web-extension-support.md) and decisions D1 and D6.
**Dependencies:**
- Tasks 591–593 must be closed.
- Task 594's Checkpoint 1 must be closed, and its engine results recorded.

## 1. Implementation

### Checkpoint 1 — Documentation and manifest text

- [ ] Add a "VS Code for the Web (vscode.dev / github.dev)" section to `README.md`. It covers:
  - the supported and preview browsers (D1);
  - the features available per workspace type: GitHub repository, local folder, untitled;
  - the limitations:
    - no git gutter;
    - file watching depends on the file system;
    - copy/paste chords are handled by the browser (Task 593);
    - remote images and map tiles without CORP headers are blocked by cross-origin isolation (Task 592);
    - private browsing, or blocked third-party storage, stops webviews from loading;
    - workspace trust affects image and wiki writes (D2).
  - Update the desktop-only requirement line (`README.md` around line 288).
- [ ] Update `DEVELOPMENT.md`:
  - the host now ships two bundles (around line 126);
  - the web development loop `code --extensionDevelopmentPath=. --extensionDevelopmentKind=web`;
  - the `test:web` commands from Task 591;
  - the HTTPS sideload flow (`mkcert`, `npx serve --cors`, **Developer: Install Extension From Location…**).
- [ ] Rewrite the `capabilities.virtualWorkspaces` and `capabilities.untrustedWorkspaces` descriptions in `package.json` (lines 13–22) to match the implemented behavior. Keep both at `limited`.
- [ ] Add a release-notes entry for the next changelog pass: web support, the browser stance, and the limitations.

### Checkpoint 2 — Pre-release acceptance on vscode.dev

- [ ] **Owner action (D6 (b)):** publish a Marketplace pre-release built from the final candidate. Record the version here.
- [ ] **Owner-run acceptance in Chrome**, recorded in section 3. Each row is run on a GitHub repository they own and on a local folder opened in the browser:
  1. install and activate;
  2. open with VMDE from the explorer and from the title buttons;
  3. relative images render;
  4. edit and save: compare the commit diff against the intended change only;
  5. links and fragment jumps;
  6. wiki links and Create Page;
  7. image paste;
  8. mermaid and geojson diagrams, including basemap tiles;
  9. the keyboard rows from Task 593;
  10. the copy buttons;
  11. a reload keeps the document state.
- [ ] Run the same rows in Firefox and Safari to the depth D1 requires, and record them.
- [ ] Record the evidence in [Task 581](581-web-extension-support.md). Close this task and the program only when every required row passes, or the Owner accepts it as a documented residual.

## 2. Scope

- **In scope:** documentation, manifest text and acceptance.
- **Out of scope:** code changes. A failing row returns to the task that owns the behavior.
- **Owner actions:** only the Owner publishes, and signs in to vscode.dev or GitHub.

## 3. Acceptance record

Filled in Checkpoint 2.

## Execution progress

Not started.
