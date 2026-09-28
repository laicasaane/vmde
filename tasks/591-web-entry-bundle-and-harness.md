# Task 591 — Web entry, browser bundle, packaging and the web test harness

> **For agentic workers:** Use `superpowers:executing-plans`. Checkboxes track implementation and acceptance.

**Status:** planned (draft, 2026-09-28). Needs program decisions D4 and D5.
**Goal:**
- VMDE ships a `browser` bundle in the same VSIX as desktop.
- It activates in the VS Code web extension host.
- Repository gates keep the web graph Node-free.
- A `@vscode/test-web` harness proves open, render, edit and save on a virtual file system.
- Optionally, desktop VS Code can run the extension in its web worker host.

**Spec:** This file and [Task 581](581-web-extension-support.md) sections 2 and 4.
**Dependencies:**
- Tasks 583–590 must be closed. The web-readiness ratchet must report zero entries for the web entry.
- D4 selects the web diagram store. D5 approves `@vscode/test-web`.

**Repository skills:** `.agents/skills/vmde-testing/SKILL.md` (read first).

## 1. Implementation

### Checkpoint 1 — Web entry, bundle, manifest and gates

- [ ] Add `src/app/extension-web.ts` (proposed). Its basename must be unique; `extension.ts` is taken. It exports `activate(context)`, which calls `activateWithRuntime(context, createWebRuntime(context))` from Task 584, and `deactivate`.
- [ ] Add `src/platform/web-runtime.ts` (proposed) with:
  - the Task 590 web Lute loader;
  - the Task 584 memory diagram store (D4 (a));
  - no prerender overlay (D3 sub-choice).
- [ ] Update `scripts/build-extension.mjs`.
  - Keep the single `fs.rm('dist', …)` at line 8, then build two esbuild contexts in the same run, including `--watch` mode:
    - **Node:** unchanged.
    - **Web:** entry `src/app/extension-web.ts`; `platform: 'browser'`; `format: 'cjs'`; `target: 'es2022'`; `external: ['vscode']`; `mainFields: ['browser', 'module', 'main']`; `define` of `__VMDE_BUILD_ID__` from Task 583; sourcemap unless `--production`; minify with `--production`; outfile `dist/web/extension.js`.
  - `vscode:prepublish` (`node build.mjs --production`) must produce both bundles.
- [ ] Add `tsconfig.web.json` (proposed) with `lib: ["ES2022", "WebWorker"]` and `types: []`, covering the web entry graph. Run it in the `build.mjs` typecheck step and in `npm run typecheck`.
- [ ] Switch the ratchet in `scripts/check-web-readiness.mjs` to the web entry and make it require zero entries. Delete `scripts/web-readiness-allowlist.json`.
- [ ] Add a post-build check (proposed `scripts/check-web-bundle.mjs`, run by `build.mjs` after bundling). It fails if `dist/web/extension.js` contains any of: `require(` other than `require("vscode")`, `process.`, `Buffer`, `__dirname`, `__filename`.
- [ ] Add `"browser": "./dist/web/extension.js"` to `package.json`. Keep `main` and `extensionKind`.
- [ ] Update the repository gates:
  - `scripts/module-manifest.mjs` and `test/backend/module-boundaries.test.ts` for the new modules and edges.
  - `knip.jsonc` entries: the web entry and the new scripts.
  - A `forbidden` rule in `.dependency-cruiser.cjs` that forbids `core` (Node built-in) dependencies from the web entry graph. Part 1 defines the path set.
  - The coverage ratchet in `scripts/check-coverage-modules.mjs`: give the thin web entry a unit test, or exclude it the same way `main.ts` is excluded, in both the script and `test/vitest.config.mts`.
- [ ] Update the tests and packaging checks:
  - `test/backend/manifest.test.ts:77,85`: assert `browser` and the kinds.
  - `test/backend/packaging-workflow.test.ts:21`: `main` plus `browser`.
  - `validateVsix` in `scripts/package-local-preview-core.mjs` (around lines 718–780): assert `extension/dist/web/extension.js`, `web` in `ExtensionKind`, and the `__web_extension` tag.

### Checkpoint 2 — `@vscode/test-web` harness and smoke test

- [ ] Add `@vscode/test-web` as a devDependency of `test/vscode-e2e/package.json` (D5), and an npm script `test:web` (proposed).
  - It builds nothing itself: run `node build.mjs` first.
  - It starts `@vscode/test-web` in Chromium, headless, with `--extensionDevelopmentPath` set to the repository and a fixture folder mounted as `vscode-test-web://mount/…`.
  - Part 1 chooses how the test is driven:
    - **(i)** Playwright drives the page, reusing the webview frame locators from the real-VS-Code helpers (recommended; supports real keyboard input);
    - **(ii)** `--extensionTestsPath` runs a Mocha bundle in the worker.
- [ ] Define the web E2E flag channel that replaces `VMDE_E2E` inside the worker, where environment variables do not reach. Part 1 picks either a test-profile setting or `ExtensionMode.Test`. The desktop keeps its environment flags.
- [ ] Add `test/vscode-e2e/web/smoke.web.spec.ts` (proposed). It checks, in order:
  1. activation;
  2. opening a fixture `.md` with **Reopen Editor With → VMDE**;
  3. the IR surface renders, including a relative image;
  4. typing in one block, saving, and reading the file back through the harness: exact expected bytes, with untouched blocks byte-identical (host Lute ready);
  5. one mermaid diagram renders;
  6. a wiki link resolves;
  7. an image paste writes into the mount (D2 (a)).

  It also records host Lute ready time and heap. Record, for reporting only, edit → `applyEdit` latency and the duration of the deferred no-op check. Measure a burst of typing in a 100 KB fixture on `@vscode/test-web`, with the same fixture on desktop VS Code for comparison.
- [ ] Add a nightly job to `.github/workflows/nightly.yml`: build, then `test:web` in headless Chromium.
- [ ] Add `.vscode-test-web/` to `.gitignore`.
- [ ] Update `DEVELOPMENT.md`: the web build output, the `test:web` command, and a row for the web test layer. Add a web launch configuration to `.vscode/launch.json` using `--extensionDevelopmentKind=web`.

### Checkpoint 3 — Desktop VS Code with the web extension host

- [ ] Extend `scripts/patch-vscode-test-playwright.mjs` with an environment-gated extra launch argument. For example, `VMDE_WEB_KIND=1` adds `--extensionDevelopmentKind=web`, following the existing gated `VMDE_XTEST` patch.
- [ ] Stage the extension (`package.json`, `dist/`, `media/`) in a temporary directory outside the repository when the flag is set. Otherwise the injected Node test runner under `test/vscode-e2e/node_modules/vscode-test-playwright` would load into the web worker host.
- [ ] Run the smoke flow and a representative set of existing real-VS-Code specs under the flag: open/edit/save exactness, diagram render, Find. Record the results here.

## 2. Scope

- **In scope:** the items above.
- **Out of scope:** webview behavior changes (Tasks 592–594).
- **Preservation:** the desktop bundle bytes' behavior, the VSIX contents apart from `dist/web/`, and existing test commands.

## 3. Verification

- Unit tests for the manifest, packaging, ratchet and module boundaries.
- The post-build bundle check passes.
- `npm run package:vsix` (or the documented local packaging command) produces a VSIX that passes `validateVsix`.
- `test:web` passes the smoke spec three times in a row with no retries.
- Desktop real-VS-Code specs pass unchanged, and the Checkpoint 3 subset passes under the web-kind flag.
- Changed-line coverage and the network-free quality stages run once on the final candidate.

## Execution progress

Not started.
