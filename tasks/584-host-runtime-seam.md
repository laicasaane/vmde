# Task 584 — Host runtime seam for Lute and the diagram disk store

> **For agentic workers:** Use `superpowers:executing-plans`. Checkboxes track implementation and acceptance.

**Status:** planned (draft, 2026-09-28).
**Goal:** The two Node-only host capabilities, loading Lute with `node:vm` and the synchronous diagram disk store, sit behind one injected `HostRuntime`. A web entry can then supply its own implementations. The desktop behavior and its contracts stay identical.
**Spec:** This file and [Task 581](581-web-extension-support.md) section 2.
**Dependencies:** [Task 583](583-web-readiness-ratchet-and-node-free-globals.md) supplies `bytes.ts` and the ratchet. [Task 590](590-host-lute-in-web-worker.md) and [Task 591](591-web-entry-bundle-and-harness.md) consume this seam.
**Repository skills:** `.agents/skills/vmde-lute-features/SKILL.md` (host Lute prerender and `lute-host.ts`) and `.agents/skills/vmde-testing/SKILL.md`.

## 1. Implementation

### Checkpoint 1 — Lute loader seam

- [ ] Add `src/lute/lute-loader.ts` (proposed). It exports two types:
  - `LuteApi`, the members `lute-host.ts` uses today: `Md2VditorIRDOM`, `Md2VditorDOM`, `VditorIRDOM2Md`, `Md2HTML`, and the `Set*` options it calls.
  - `LuteLoader`, with three members:
    - `getSync(): LuteApi | undefined`. It returns the instance. When cold, it loads synchronously if its platform can; otherwise it returns `undefined`.
    - `prewarm(): void`. It starts a load without blocking.
    - `didFail(): boolean`.
- [ ] Move the `node:vm` sandbox loader from `src/lute/lute-host.ts` (the `loadLute` body around lines 75–128, and `prewarmLute` at 130–133) into `src/lute/lute-node-loader.ts` (proposed, Node-only).
  - Keep the code verbatim: sandbox globals, `SetHeadingID(true)`, the warm-up call, and the `setTimeout(…, 0)` prewarm.
  - It reads `LUTE_REL` from `extensionUri.fsPath`.
  - `getSync()` keeps today's synchronous cold load, which `canonicalizeIrMarkdown` and `reserializeMarkdown` rely on (Task 537 contract).
- [ ] Change `canonicalizeIrMarkdown` (line 198), `reserializeMarkdown` (222) and `renderForMode` (252) in `lute-host.ts` to take the loader instead of `extensionFsPath: string`. Keep `isLuteWarm` and `didLuteFailToLoad` as delegations to the loader. Update the callers:
  - `src/writeback/writeback-controller.ts:205,232,282` (`deps.extensionPath`);
  - `src/session/editor-session.ts:275`;
  - `src/app/markdown-editor-provider.ts` (`renderForMode`);
  - `src/app/extension.ts:62` (`prewarmLute`).
- [ ] Remove the `node:fs`, `node:path` and `node:vm` imports from `lute-host.ts`. The rendering, repair and wiki-chip logic stays there unchanged.

### Checkpoint 2 — Diagram store seam

- [ ] Split `src/webview-host/diagram-cache-host.ts`.
  - `DiagramCache` (line 67) keeps the policy: index, LRU, budget, eviction, flush timer.
  - Its persistence moves behind a synchronous `DiagramBlobStore` interface (proposed, same file or `diagram-store.ts`): `readIndex`, `writeIndex`, `readBlob`, `writeBlob`, `deleteBlob`, `listBlobs` (hash plus mtime).
- [ ] Move the current `fs` implementation into `src/webview-host/diagram-disk-store.ts` (proposed, Node-only). It keeps the temp-file-then-rename index write (including the `process.pid` name), the orphan sweep and the grace window.
- [ ] Add an in-memory implementation, `src/webview-host/diagram-memory-store.ts` (proposed). The web runtime uses it (program decision D4 (a)), and so do tests.

### Checkpoint 3 — Host runtime and shared activation

- [ ] Add `src/platform/host-runtime.ts` (proposed) with an interface of two members:
  - `lute: LuteLoader`
  - `createDiagramStore(storageUri: vscode.Uri | undefined): DiagramBlobStore | undefined`
- [ ] Add `src/platform/node-runtime.ts` (proposed, Node-only) with `createNodeRuntime(context)`, which returns the Node loader and the disk store.
- [ ] Move the body of `activate` from `src/app/extension.ts` into `src/app/activate.ts` (proposed) as `activateWithRuntime(context, runtime)`. Pass the runtime to every consumer that needs Lute or the diagram store. `src/app/extension.ts` keeps `activate` and `deactivate`, and calls `activateWithRuntime(context, createNodeRuntime(context))`. The return value (the test API) is unchanged.
- [ ] Switch the ratchet entry in `scripts/check-web-readiness.mjs` to `src/app/activate.ts`. Delete the allowlist entries that no longer appear: Node-only modules drop out of the shared graph.
- [ ] Register the new modules in `scripts/module-manifest.mjs`, with globally unique basenames, and add the new edges to `test/backend/module-boundaries.test.ts`.

## 2. Contract

- **Desktop output is identical.** The prerender overlay HTML, canonicalized and re-serialized Markdown, write-back bytes, diagram cache hits and misses, and eviction all stay the same.
- **The synchronous cold load stays on desktop.** A write-back that runs before prewarm finishes still loads Lute synchronously and never skips minimization.
- **The web contract is fixed now; Task 590 implements it.** A loader whose `getSync()` returns `undefined` while cold must make each dependent function return `undefined`, and every caller must already handle `undefined`.

## 3. Verification

- Unit tests:
  - The loader contract, with a fake loader: cold synchronous load, prewarm, failure.
  - Store contract tests run against both stores. They cover index round-trips, blob reads and writes, eviction by budget, and the orphan sweep. The disk store runs in a temp directory.
  - The existing `minimal-diff-writeback`, `writeback-controller`, `lute-host` and diagram-cache tests pass unchanged, apart from the injection points.
- Real VS Code: run `node build.mjs` first. Then run these focused, no-retry specs:
  - `prerender-style-parity.spec.ts`;
  - the diagram cache and render specs (search `diagram`);
  - one open → edit → save → reopen exact-bytes spec (search `exact` / `save`).
- Changed-line coverage and the network-free quality stages run once on the final candidate.

## Execution progress

Not started.
