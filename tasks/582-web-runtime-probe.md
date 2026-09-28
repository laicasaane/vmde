# Task 582 — Measure the web runtime facts VMDE depends on (spike)

> **For agentic workers:** Use `superpowers:executing-plans`. Checkboxes track progress. This spike changes no product code.

**Status:** spike (draft, 2026-09-28).
**Goal:** Replace the review's `needs-runtime` assumptions with measured facts before the dependent tasks start. The facts cover file-system support per scheme, URI shapes, the web extension host environment, Lute evaluation cost, and webview isolation and clipboard behavior.
**Spec:** The probe matrix in section 2 and the program constraints in [Task 581](581-web-extension-support.md).
**Dependencies:**
- Program decision D5 approves `@vscode/test-web` and, on the Owner's machine, `mkcert` plus `serve`.
- Program decision D6 (a): the Owner performs every step that needs their GitHub login or a real vscode.dev session.
- Independent of every code task.

## 1. Implementation

### Checkpoint 1 — Probe extension and a `@vscode/test-web` run

- [ ] Create a throwaway probe extension in `tmp/web-probe/` (proposed). `tmp/` is ignored at `.gitignore:106`; never commit the probe.
  - `package.json`:
    - `"browser": "./probe.js"`;
    - `"activationEvents": ["onCommand:vmdeProbe.run"]`;
    - one contributed command `vmdeProbe.run`;
    - `engines.vscode` equal to VMDE's (`^1.110.0`).
  - `probe.js`: plain CommonJS with no bundler. It runs rows P1–P6 in order and catches errors per row, so one failure does not stop the others. It writes one JSON report to an output channel named `VMDE Probe`, and also to `vmde-probe-report.json` in the first workspace folder when that folder is writable.
  - `lute.min.js`: copied from `media/vditor/dist/js/lute/lute.min.js` by the documented setup command, for row P5.
- [ ] Create a fixture folder in `tmp/web-probe/fixture/` with `a.md`, `sub/b.md` and `img/p.png`.
- [ ] Run the probe headless in Chromium on `@vscode/test-web`, with the probe as the extension development path and the fixture as the folder. Save the report as `tmp/web-probe/reports/test-web.json`. Record the exact command line in section 3.

### Checkpoint 2 — Runs on vscode.dev (Project Owner)

- [ ] The Owner serves `tmp/web-probe/` over HTTPS with CORS on their own machine: `npx serve --cors -l 5000 --ssl-cert <cert> --ssl-key <key>`, using an `mkcert` certificate. They install it in Chrome on vscode.dev with **Developer: Install Extension From Location…** and `https://localhost:5000`.
- [ ] The Owner runs **vmdeProbe.run** in each of these, then saves each report under `tmp/web-probe/reports/`:
  - (a) a GitHub repository they own, default branch;
  - (b) the same repository on another branch;
  - (c) a local folder opened with **Open Folder** (browser File System Access);
  - (d) case (a) in Chrome on Windows, if a Windows machine is available.
- [ ] Optional, only if program decision D1 needs preview evidence: repeat (a) in Firefox and Safari.

### Checkpoint 3 — Record the results and update decisions

- [ ] Fill the results table in section 3, one row per probe row and environment. Mark a cell `not run` or `not measurable` with its reason.
- [ ] Update decisions D2, D3, D4 and D6 in [Task 581](581-web-extension-support.md) with the evidence.
- [ ] Edit every dependent child record whose plan the evidence changes, and list those edits here.

## 2. Probe matrix

| Row | What it answers | Exact check | Used by |
| --- | --- | --- | --- |
| P1 | File-system operations per scheme | For each workspace folder, record success or the error text plus the time in ms for each of: `vscode.workspace.fs.stat(folder)`; `readDirectory(folder)`; `createDirectory(folder/vmde-probe-tmp)`; `writeFile` of `probe.txt` there; `readFile` of the same file; `delete` with `recursive: true`; `vscode.workspace.fs.isWritableFileSystem(folder.scheme)`. | 586, 588, 589 |
| P2 | Search and watch | `vscode.workspace.findFiles(new vscode.RelativePattern(folder, '**/*.md'))`: count and ms. `createFileSystemWatcher(new vscode.RelativePattern(folder, '**/*.md'))`: events within 5 s after the probe writes `vmde-probe-tmp/w.md`. In Checkpoint 2, also record events after the Owner edits and saves `a.md`. | 586, 587, 589 |
| P3 | URI shapes | For each workspace folder and the active document: `uri.toString()` and `uri.fsPath`. Also `navigator.userAgent`, and the authority string on the branch run (b). | 585–589 |
| P4 | Extension host environment | `vscode.workspace.isTrusted`. `vscode.extensions.getExtension('vscode.git') !== undefined`. `context.extensionUri.toString()`, `context.extensionPath`, `context.globalStorageUri.toString()`. `typeof process`, `typeof Buffer`. `workspace.fs.readFile(Uri.joinPath(extensionUri, 'package.json'))`: ok and ms. `fetch(Uri.joinPath(extensionUri, 'package.json').toString(true))`: ok and ms. | 583, 584, 590, 591 |
| P5 | Lute in the worker | Read `lute.min.js` through `workspace.fs.readFile`, then evaluate it with `new Function('self', 'window', 'global', src).call(sb, sb, undefined, undefined)`, where `sb = Object.create(globalThis)`. Record: read ms, compile ms, eval ms; `typeof sb.Lute`, `typeof globalThis.Lute`, `typeof globalThis.fs`; `Error.stackTraceLimit` before and after; the first `Lute.New().Md2VditorIRDOM('# a')` call in ms; and the `performance.memory` delta when that API exists. | 590 |
| P6 | Webview isolation and clipboard | Open a webview panel whose script reports `self.crossOriginIsolated`. It loads one image from `upload.wikimedia.org` (sends no CORP header) and one from `raw.githubusercontent.com` (sends CORP), each with and without `crossorigin="anonymous"`, recording load or error per case. In a button click handler it calls `navigator.clipboard.writeText('probe-webview')`, and reports the result. The extension then calls `vscode.env.clipboard.writeText('probe-host')` after one message round trip and reads it back with `readText()`. | 592, 593 |

## 3. Results

| Row | test-web | vscode.dev repo (a) | branch (b) | local folder (c) | Windows (d) |
| --- | --- | --- | --- | --- | --- |
| P1 | not run | not run | not run | not run | not run |
| P2 | not run | not run | not run | not run | not run |
| P3 | not run | not run | not run | not run | not run |
| P4 | not run | not run | not run | not run | not run |
| P5 | not run | not run | not run | not run | not run |
| P6 | not run | not run | not run | not run | not run |

## 4. Scope and rules

- **In scope:** the probe in ignored `tmp/web-probe/`, the evidence in this record, and updates to Task 581 decisions and to dependent child records.
- **Out of scope:** any change under `src/`, `media-src/`, `test/`, `scripts/` or `package.json`.
- **Owner-only steps:** the Owner performs every GitHub sign-in and vscode.dev step. No agent enters credentials.
- **Downloads:** only what decision D5 approves.

## 5. Verification

- Every probe row has a value or a recorded reason for each environment that was run.
- `git status` shows no tracked change except task records.

## Execution progress

Not started.
