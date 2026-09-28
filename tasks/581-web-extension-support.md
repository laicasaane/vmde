# Task 581 — Run VMDE as a web extension on vscode.dev (program record)

> **For agentic workers:** This is the program record for Tasks 582–595. Implement the child tasks, not this file. Each child uses `superpowers:executing-plans`; checkboxes track progress.

**Status:** planned (draft, 2026-09-28). Owner decisions D1–D6 (section 3) are open.
**Goal:** The same VSIX that runs on desktop also installs and works in VS Code for the Web (vscode.dev and github.dev). VMDE opens, renders, edits and saves Markdown in three cases: GitHub repositories (`vscode-vfs`), local folders opened in the browser, and untitled documents. Documented limitations remain. Desktop behavior, including Windows, does not change.
**Tech stack:** TypeScript (extension host and webview), esbuild (Node and browser targets), the VS Code web extension host (a Web Worker), `@vscode/test-web`, Vitest, Chromium Playwright, real VS Code.
**Spec:** This file (global constraints, decisions, review focus) plus each child record.
**References:** https://code.visualstudio.com/api/extension-guides/web-extensions and https://code.visualstudio.com/api/extension-guides/virtual-workspaces.
**Evidence:** a read-only review on 2026-09-28 covering five areas: host URIs and file access, host runtime, webview loading, browser engines, and manifest, build and tests. Section 5 lists its key findings. Each child task cites the findings it owns.

## 1. Implementation: child tasks and order

Run the tasks in this order. A task starts only after its dependencies are closed.

| Task | Deliverable | Depends on |
| --- | --- | --- |
| [582](582-web-runtime-probe.md) | Measured facts for every `needs-runtime` finding (spike) | D5, D6 |
| [583](583-web-readiness-ratchet-and-node-free-globals.md) | Web-readiness ratchet; no `process`, `Buffer`, `__dirname`, `os` or `crypto` use in shared host code | none |
| [584](584-host-runtime-seam.md) | Node-only Lute loader and diagram disk store behind an injected host runtime | 583 |
| [585](585-uri-path-helpers.md) | URI path helpers with Windows desktop parity; git repository containment on URIs | 583 |
| [586](586-open-virtual-documents.md) | Open, render, edit and save non-`file` Markdown; external CSS on URIs | 585 |
| [587](587-links-and-image-refresh-on-uris.md) | Links, code references and image refresh on URIs; untitled safety | 586 |
| [588](588-image-upload-on-virtual-file-systems.md) | Image upload, paste and drop on writable virtual file systems | 586, D2 |
| [589](589-wiki-on-virtual-workspaces.md) | Wiki links, index and Create Page on virtual workspaces | 586, D2 |
| [590](590-host-lute-in-web-worker.md) | Host Lute in the web worker, so saves on the web stay lossless | 584, 582 (row P5), D3 |
| [591](591-web-entry-bundle-and-harness.md) | Web entry, `browser` bundle, packaging gates, `@vscode/test-web` harness | 583–590, D4, D5 |
| [592](592-webview-loading-on-vscode-dev.md) | Webview loading robustness and payload on vscode.dev | 591 |
| [593](593-web-keyboard-and-clipboard.md) | Keyboard and clipboard behavior on the web | 591, [Task 580](580-rectify-shortcuts-vscode-identity.md) |
| [594](594-firefox-safari-engine-compatibility.md) | Webview build target and Firefox/Safari engine fixes | D1, D5 |
| [595](595-web-docs-and-release-acceptance.md) | Docs, manifest text, pre-release acceptance on vscode.dev | 591–594, D6 |

- Task 582 changes no product code. Its evidence can revise decisions D2–D4 and D6 and the dependent child records before those tasks start.
- Task 594 changes only webview code and build config, so it can run at any point after D1 and D5.
- Program closure:
  - [ ] Every child task is closed. For Task 594, the Firefox and Safari results are recorded as D1 requires.
  - [ ] After Task 591, an independent review of the integrated diff against section 2 and section 4 has run, and its findings are fixed.
  - [ ] At program close, an independent review of the full program diff has run, and its findings are fixed or recorded as accepted residuals.
  - [ ] The Task 595 vscode.dev acceptance is recorded here.
  - [ ] This record and the child records are moved to `tasks/done/`, and the `tasks/README.md` entries are added only when everything above is complete.

## 2. Global constraints

These apply to every child task.

- **Node-free web graph.** No module reachable from the web entry may use `node:*`, `process`, `Buffer`, `__dirname`, `__filename`, or `require` of anything other than `vscode`. Node-only code lives in modules that only the desktop entry `src/app/extension.ts` imports.
- **One VSIX.** Ship `main` and `browser` in the same package. Keep `extensionKind: ["workspace"]`: VS Code and vsce add `web` when `browser` is present. Do not package with `--target web`.
- **Desktop unchanged, Windows included.** This covers link text, image destinations, tab titles, the git gutter, exact-source write-back bytes, the prerender overlay and the diagram disk cache.
- **URIs for identity and IO.**
  - Host code identifies and reads resources through `vscode.Uri`.
  - `fsPath` appears only inside desktop-only branches for the `file` scheme.
  - Map and set keys use `uri.toString()`.
  - Use `vscode.Uri.joinPath`, which applies Windows rules to `file` URIs. Never use `vscode-uri` `Utils.joinPath`, which is POSIX-only.
- **Dependencies.** Add no runtime dependency to the host bundle; it has none today. New dev or test dependencies need Owner approval (D5).
- **Webview syntax floor.** Chrome and Edge 111, Firefox 121, Safari 16.4. Task 594 sets the matching esbuild target.
- **Test layers** (see `AGENTS.md`):
  - Vitest covers host logic.
  - `@vscode/test-web` (Task 591) covers web behavior.
  - Real VS Code covers desktop regressions of changed behavior.
  - Before Task 591 lands, unit tests with non-`file` URI fixtures cover web behavior. End-to-end web acceptance happens in Tasks 591 and 595.

## 3. Owner decisions (open)

### D1. Which browsers VMDE supports on the web

- **In plain terms.** VMDE's editor has been tuned and tested only in Chromium, because desktop VS Code uses Electron. On vscode.dev, the editor runs in whatever browser the user has.
- **Detail.** The review found these engine gaps (Task 594):
  - In Safari, the Enter that commits Japanese/Chinese input can trigger Vditor's block logic.
  - Safari cannot encode WebP.
  - Safari needs the prefixed `user-select`.
  - Firefox before 150 lacks `caretRangeFromPoint`.
  - Caret invariants were measured only in Chromium.
- **Options:**
  - **(a)** Chrome and Edge are supported. Firefox and Safari are "preview": they work, with known gaps that are documented, until Task 594's engine runs pass.
  - **(b)** All four browsers are supported at release. Task 594's fixes and engine runs become release blockers.
  - **(c)** Chromium only; Firefox and Safari are documented as unsupported.
- **Recommendation:** (a).
- **Owner input:**

### D2. Write features in virtual workspaces

- **In plain terms.** Today, image paste/upload and wiki "Create Page" are switched off for anything that is not a local file. In GitHub repositories on vscode.dev, VS Code keeps the user's edits until they commit.
- **Detail.** `ensureCanWriteFiles` (`src/session/asset-link-actions.ts:26-27`) and the wiki gate (`src/wiki/wiki.ts:46`) reject every scheme except `file`.
- **Options:**
  - **(a)** Enable writes when `vscode.workspace.fs.isWritableFileSystem(scheme) === true` and the workspace is trusted.
  - **(b)** Keep writes off on the web for the first release.
- **Recommendation:** (a), after Task 582 row P1 confirms that `createDirectory` and `writeFile` work on `vscode-vfs`.
- **Owner input:**

### D3. Host Lute on the web

- **In plain terms.** When saving, VMDE keeps untouched parts of the file byte-for-byte by using a copy of the Markdown engine (Lute) in the extension host. Without it, saves on the web would reformat unrelated parts of the file, and those changes would show up in commits.
- **Detail.**
  - Write-back uses host Lute through `reserializeMarkdown` (`src/writeback/writeback-controller.ts:205,232,282`), and the editor seed uses it through `canonicalizeIrMarkdown` (`src/session/editor-session.ts:275`).
  - The web extension host's iframe CSP allows `'unsafe-eval'` but blocks `importScripts`.
  - Measured under Node 22: about 160 ms to compile and initialize, about 17 MB of heap.
- **Options:**
  - **(a)** Load Lute in the web extension host with a sandboxed `new Function` (Task 590).
  - **(b)** Turn host Lute off on the web and accept the reformatting.
  - **Sub-choice:** the first-paint prerender overlay on the web is either **off** for the first release or **on**.
- **Recommendation:** (a) with the overlay off.
- **Owner input:**

### D4. Diagram cache on the web

- **In plain terms.** On desktop, VMDE caches rendered diagrams on disk so they reappear instantly after a reopen.
- **Options:**
  - **(a)** On the web, keep the cache in memory for the session only.
  - **(b)** Persist it through `globalStorageUri`, which is browser storage on the web.
- **Recommendation:** (a) for the first release.
- **Owner input:**

### D5. New tooling and downloads

- **In plain terms.** Testing on the web needs tools that download browsers or VS Code builds.
- **Items:**
  - `@vscode/test-web` as a devDependency of `test/vscode-e2e`. It downloads VS Code web builds when tests run (Tasks 582 and 591).
  - Playwright Firefox and WebKit browser downloads (Task 594).
  - `mkcert` plus `serve` for HTTPS sideloading on the Owner's machine (Task 582 CP2, D6 (a)).
  - A font-subsetting dev tool for the emoji font (Task 592 CP2). Task 592 names the exact package before installing it.
- **Options:** approve or decline each item.
- **Recommendation:** approve `@vscode/test-web` now, the Playwright engines when Task 594 starts, and `mkcert` as D6 requires. The subsetter is optional; if it is declined, Task 592 skips its emoji-font step.
- **Owner input:**

### D6. How to verify on the real vscode.dev

- **In plain terms.** Some behavior only exists on the real vscode.dev: the Marketplace CDN, cross-origin isolation, GitHub repositories and the Owner's login. An agent cannot sign in on the Owner's behalf.
- **Options:**
  - **(a)** The Owner serves a local build over HTTPS and installs it with **Developer: Install Extension From Location…**, then runs the checks.
  - **(b)** The Owner publishes a Marketplace pre-release and tests the installed extension, which exercises the real CDN and COEP headers.
- **Recommendation:** (a) for Task 582 and (b) for Task 595. Publishing is an Owner action.
- **Owner input:**

## 4. Review focus

These are the failure modes that no single task's tests fully exercise. Each line names the task that owns its test.

1. **Chrome on Windows opens a Markdown file from a GitHub repository.** On Windows browsers, VS Code builds `fsPath` with backslashes. VMDE must open without an exception and resolve relative links and images. Owners: Task 585 CP2 parity fixtures, Task 586 CP2, Task 587 CP1.
2. **An untitled Markdown document contains a relative image or link.** Nothing throws, and relative resolution is skipped. Owner: Task 587 CP1.
3. **The same file path is open on two branches at once** (different `vscode-vfs` authorities). No conflict, wiki or state key is shared. Owners: Task 586 CP2, Task 589 CP1.
4. **A save on the web right after opening, while host Lute is still loading.** Untouched blocks return to their original bytes on the next edit tick, and undo reaches a clean document. Owner: Task 590 CP2.
5. **Remote tiles or images blocked by cross-origin isolation on vscode.dev.** The document and diagrams still render, the blocked resource shows the normal broken or blank state, and the editor raises no error. Owner: Task 592 CP1.

## 5. Evidence summary (2026-09-28 review)

- **Load blockers:**
  - `package.json` has no `browser` entry.
  - An in-memory esbuild browser build of `src/app/extension.ts` reports 23 unresolved `node:*` imports across 16 files.
  - `process.env` is read inside `activate()` (`src/app/extension.ts:188`) and on every open (`src/session/editor-session.ts:315,372`).
  - `Buffer` is used in `src/wiki/wiki.ts:118`, `src/session/asset-link-actions.ts:134,284` and `src/webview-host/diagram-cache-host.ts:221,241`.
- **Windows browsers:** VS Code picks backslashed `fsPath` from `navigator.userAgent`. `node:path` polyfills call `process.cwd()` for relative inputs, which throws in the worker.
- **Scheme gates:**
  - `SupportedSchemes = {file, untitled}` (`src/platform/tab-targeting.ts:9`).
  - The title-button `when` clauses at `package.json:305,310`.
  - The wiki gate at `src/wiki/wiki.ts:46` and the write gate at `src/session/asset-link-actions.ts:27`.
  - The custom editor `selector.scheme` keys (`package.json:268-280`) are ignored by VS Code.
- **Images on `vscode-vfs`:** the base href is built from `Uri.file(uri.fsPath)` (`src/app/markdown-editor-provider.ts:183-185`).
- **Webview on vscode.dev:**
  - Extension files load from the Marketplace CDN with correct MIME types and CORS headers.
  - vscode.dev sends `Cross-Origin-Embedder-Policy: require-corp` (checked with curl on 2026-09-28).
  - The existing CSP needs no change.
  - No web workers are used.
- **Keyboard on web:** VS Code's webview host lets the browser handle Ctrl/Cmd+C/V/X without forwarding them. It prevents only a few browser defaults (undo/redo, print, find, save, plus W/N/F1/F5).

## Execution progress

Not started. Drafted 2026-09-28 from the read-only review. No product code has changed.
