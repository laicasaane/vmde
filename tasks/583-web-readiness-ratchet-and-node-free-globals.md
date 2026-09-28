# Task 583 — Web-readiness ratchet and Node-free host globals

> **For agentic workers:** Use `superpowers:executing-plans`. Checkboxes track implementation and acceptance.

**Status:** planned (draft, 2026-09-28).
**Goal:**
- A test fails whenever host code gains a new Node dependency that would break the web bundle, and it reports the remaining ones.
- Shared host code stops using the Node globals `process`, `Buffer`, `__dirname`, `os` and `crypto`.
- Desktop behavior does not change.

**Spec:** This file and the global constraints in [Task 581](581-web-extension-support.md) section 2.
**Dependencies:** None. [Task 584](584-host-runtime-seam.md) and [Task 585](585-uri-path-helpers.md) build on it.
**Repository skills:** `.agents/skills/vmde-testing/SKILL.md`.

## 1. Implementation

### Checkpoint 1 — Web-readiness ratchet

- [ ] Add `scripts/check-web-readiness.mjs` (proposed). It runs esbuild in memory with these options:
  - `entryPoints: ['src/app/extension.ts']` (Task 584 switches this to the shared activation module, and Task 591 to the web entry);
  - `bundle: true`, `write: false`, `metafile: true`;
  - `platform: 'browser'`, `format: 'cjs'`;
  - `mainFields: ['browser', 'module', 'main']`;
  - `external: ['vscode', 'node:*']`;
  - `logLevel: 'silent'`.
- [ ] From `metafile.inputs`, collect every import with `external: true` whose path starts with `node:`, as `"<input file> -> <module>"`.
- [ ] Scan the non-minified bundle output for `process.`, `Buffer`, `__dirname` and `__filename`. Attribute each hit to the nearest preceding `// src/...` module marker that esbuild emits, and record it as `"<file>: <token>"`.
- [ ] Add `scripts/web-readiness-allowlist.json` (proposed) with two sorted arrays, `imports` and `globals`, seeded with today's results. Today's results are the 23 import pairs across 16 files found in the 2026-09-28 review, plus the global uses that this script reports.
- [ ] Add `test/backend/web-readiness.test.ts` (proposed). It runs the check and fails in two cases, printing each entry:
  - a found entry is missing from the allowlist ("new Node dependency");
  - an allowlist entry is no longer found ("stale entry: delete it from the allowlist").
- [ ] Register the new script in `knip.jsonc` entries.

### Checkpoint 2 — Remove Node globals from shared host code

- [ ] Add `src/shared/bytes.ts` (proposed) with:
  - `utf8Encode(text: string): Uint8Array`
  - `utf8Decode(bytes: Uint8Array): string`
  - `utf8ByteLength(text: string): number`
  - `base64ToBytes(base64: string): Uint8Array`

  Use only `TextEncoder`, `TextDecoder` and `atob`. Replace every `Buffer` use:
  - `src/wiki/wiki.ts:118` → `utf8Encode(...)`;
  - `src/session/asset-link-actions.ts:134` → `base64ToBytes(file.base64)`;
  - `src/session/asset-link-actions.ts:284` → `utf8Decode(await vscode.workspace.fs.readFile(targetUri))`, keeping the current encoding;
  - `src/webview-host/diagram-cache-host.ts:221,241` → `utf8ByteLength(svg)`.
- [ ] Add `src/platform/test-flags.ts` (proposed) with `readEnv(name: string): string | undefined`. It reads `(globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[name]`. Replace each read and keep its exact comparison:
  - `src/app/extension.ts:188`: `=== '1'`;
  - `src/platform/edit-perf.ts:97`: `=== '1'`;
  - `src/app/markdown-editor-provider.ts:113`: truthy;
  - `src/session/editor-session.ts:315,372`: truthy;
  - `src/webview-host/html-builder.ts:175`: the `VMDE_PRERENDER_PARITY_HOLD` value.
- [ ] Replace the `Math.random` nonce loop in `src/app/markdown-editor-provider.ts` (around lines 38–44). Use `crypto.getRandomValues(new Uint8Array(32))` mapped onto the same alphabet and length.
- [ ] Replace the runtime md5 `CACHE_BUST` in `src/webview-host/html-builder.ts:212-224`, which uses `createHash` and `readFileSync(__dirname…)`, with a build-time constant `__VMDE_BUILD_ID__` injected by esbuild `define` in `scripts/build-extension.mjs`. Declare it as `declare const __VMDE_BUILD_ID__: string | undefined` and fall back to `''` when it is undefined, as in Vitest.
  - **Part 1 decides the id source.** Either (i) a per-build random id, or (ii) the md5 of `media/dist/main.js` plus `main.css`, with `build.mjs` running the host bundle after the webview build. Both satisfy the contract: the id changes whenever those files change, and nothing reads files synchronously at runtime.
  - Update `test/backend/webview-html.test.ts`.
  - Remove the `node:fs`, `node:crypto` and `node:path` imports from `html-builder.ts` when no other use remains.
- [ ] Remove the `os.tmpdir()` fallback at `src/app/markdown-editor-provider.ts:98-102`. When `globalStorageUri` is undefined, run without a disk cache. Give tests that relied on the fallback an explicit storage location, and remove the `node:os` import.
- [ ] Load the emoji catalog asynchronously in `src/session/emoji-recents-store.ts`:
  - Add `loadPinnedEmojiSequences(extensionUri: vscode.Uri): Promise<ReadonlySet<string> | undefined>`. It reads `vscode.Uri.joinPath(extensionUri, 'media', 'emoji', 'emoji-catalog.json')` with `vscode.workspace.fs.readFile` and `utf8Decode`, applies the same validation as today, and caches the result by `extensionUri.toString()`.
  - Add a synchronous `cachedPinnedEmojiSequences(extensionUri)` that returns the cached result.
  - Update the callers in `src/session/editor-session.ts` (`emojiRecents()` around line 193, `recordEmojiRecent()` around line 203) so the init payload carries recents whenever the catalog is valid. In practice, await the load before building the payload.
  - Remove the `node:fs` import.
- [ ] Delete the ratchet allowlist entries this checkpoint resolves.

## 2. Scope

- **In scope:** the items above.
- **Out of scope:**
  - `node:path` and `fsPath` uses (Tasks 585–589).
  - The Lute `vm` loader and the diagram disk store (Task 584).
  - A web-only channel for E2E flags (Task 591).
- **Preservation:** desktop behavior, the real-VS-Code tests that set `VMDE_E2E` or `VMDE_PRERENDER_PARITY_HOLD`, the webview cache busting on every rebuild, and the emoji recents validation.

## 3. Verification

- Unit tests:
  - `bytes.ts`: round-trips against Node `Buffer` in the test, plus empty strings, non-BMP text and base64 padding.
  - `test-flags.ts`: with and without `process`.
  - The nonce: length and alphabet.
  - `CACHE_BUST`: with the define present and absent.
  - The emoji loader: valid, damaged and missing catalog, and caching.
  - The ratchet test, green with the updated allowlist.
- Existing unit tests for the diagram cache, wiki, asset links, emoji store and webview HTML pass.
- Real VS Code: run `node build.mjs` first. Then run one focused, no-retry spec for each changed behavior, found by search:
  - a spec that reads the E2E test API;
  - `prerender-style-parity.spec.ts`;
  - image upload or paste;
  - wiki Create Page;
  - the emoji picker recents.
- Changed-line coverage and the network-free quality stages run once on the final candidate.

## Execution progress

Not started.
