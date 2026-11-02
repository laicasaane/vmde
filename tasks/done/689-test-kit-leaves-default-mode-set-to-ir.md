# Task 689 — The test kit leaves `vmde.editor.defaultMode` set to `ir` in the shared test settings

**Status:** done (2026-11-02). Planned 2026-11-01. Filed at the close of Task 682.
**Origin:** Task 682 (measured non-cause and its provisional decision).
**Severity:** low (estimated; not a measured cause of any failure, test hygiene only).
**Tech stack:** `test/vscode-e2e/helpers/shortcut-xtest-kit.ts` (`makeKit`, the `defaultMode` handling at `:357` and `:586`), and the specs that run after kit users in a batch.
**Depends on:** none.

## Problem

`makeKit` in `test/vscode-e2e/helpers/shortcut-xtest-kit.ts:357` sets the user-global `vmde.editor.defaultMode` to `ir` and never restores it. User data is kept per worker, not per test, so the value stays in the worker's shared `settings.json` (`"vmde.editor.defaultMode": "ir"`). Later specs in a batch then start with `ir` instead of the default.

Task 682 measured this as a non-cause: the link-popover tests open in IR either way and fail later. Task 682 left the kit unchanged, because restoring the value changes the starting state of every later spec in a batch and widens its scope. Which later specs depend on the leaked `ir`, if any, is not measured.

## Proposed work

Restore the previous value of `vmde.editor.defaultMode` when the kit is disposed (or per test), using the same read of the global value that the direct-open helper already uses (`inspect(...).globalValue` near `:590`). Then check the specs that run after kit users for a changed starting mode: list the kit users, list the specs that follow them in the default batch order, and run them together.

## Acceptance

- [x] The kit restores the previous value of `vmde.editor.defaultMode` (including "unset") at disposal.
- [x] The specs that follow kit users pass in a combined real-VS-Code run (failures that also fail on unchanged `dev` excepted; see Closure).
- [x] No spec relies on the leaked `ir`. A spec that does must set the mode itself, and the change is recorded.
- [x] The direct-open helper still restores its own value.

## Tests to write

- Real VS Code: one combined invocation of the kit users and the specs that follow them. Check the user-data `settings.json` after the run to confirm the setting is not left at `ir`.
- No Vitest: the change is test-kit code only.

## Part 1 handoff (2026-11-02)

Source reading only. No product or test code changed. No real VS Code and no Vitest run (no Vitest applies: the change is test-kit code).

### Where the kit sets the value

- `test/vscode-e2e/helpers/shortcut-xtest-kit.ts:355-358`: `makeKit` (declared at `:331`) activates the extension and calls `getConfiguration('vmde').update('editor.defaultMode', 'ir', true)` (user-global, `:357`). Nothing reads the previous value and nothing restores it. `Kit` (`:62-71`) has no dispose function, and no kit user disposes a kit.
- `openEditor` (`:578-625`), the direct-open helper, reads `inspect('editor.defaultMode').globalValue` (`:590-597`), sets the target mode (`:598`, update at `:586`) and restores the value it found in `finally` (`:618-620`). Inside a kit test that found value is the kit's `ir`, so the direct-open helper puts `ir` back.

### Why the value persists, and what "unset" means at the next open

- The `electronApp` fixture (`test/vscode-e2e/node_modules/vscode-test-playwright/dist/index.js:138`) is test-scoped: one VS Code launch per `test()`. The user-data directory comes from the worker-scoped `_vscodeInstall` cache (`:110-136`, `--user-data-dir` at `:167`), so `User/settings.json` is shared by every test and spec of a worker.
- VS Code keeps all storage (application, profile and workspace) in memory when it runs with an extension-tests location (`getStorageOptions(){return{useInMemoryStorage:!!this.environmentService.extensionTestsLocationURI}}` in the installed VS Code 1.129.0 `main.js`). The saved Vditor options (`vmde.options`, `src/platform/state-keys.ts:5`, which hold the last toolbar mode, `media-src/src/chrome/toolbar-actions.ts:25-30`) and the remembered Preview toggle therefore start empty at every launch.
- With the setting unset, the default is `remember` (`package.json:794-813`), `resolveDefaultMode` returns `undefined` (`src/platform/default-mode.ts:71-85`), no saved mode exists, and Vditor starts in its init default `ir` (`media-src/src/boot/vditor-init.ts:318`). So restoring "unset" does not change the starting mode of later specs: they still open in IR. This corrects the Task 682 assumption that a restore changes the later starting state.

### Kit users

24 spec files call `makeKit`. Each kit test sits in a describe that skips unless `VMDE_XTEST=1`, so the leak exists only in XTEST runs.

- Already reset the setting to unset in `test.afterEach` (13): `enter-new-paragraph`, `enter-new-paragraph-probe` (`@probe`), `code-block-end-enter-probe` (`@probe`), `list-table-enter-undo`, `publication-delay-probe` (`@probe`), `publication-delay-throttled`, `section-indent`, `sv-line-start-edit`, `turn-into-undo-step`, `undo-host-coupling`, `undo-pending-checkpoint`, `undo-routing-hygiene`, `wrap-hints`.
- Leave `ir` behind (11): `exact-action-neutral-bytes` (uses `direct: true`), `exact-action-neutral-bytes-probe` (`@probe`, uses `direct: true`), `exact-actions-after-trusted-edit`, `exact-authority-other-actions`, `expand-selection-first-keys`, `outline-native-drop-after-typing`, `save-flush-routes` (also sets `ir` itself at `:525`), `select-all-delete`, `shortcut-identity`, `shortcut-remap`, `sv-selection-enter-backspace`.

### Specs that run after a leaking kit user

Default order is alphabetical, one worker, serial (`playwright.config.ts`: `fullyParallel: false`, `workers: 1`; `--list` gives 300 spec files without probes and spikes). A leak window runs from a leaking kit user to the next spec that touches `defaultMode`:

- After `outline-native-drop-after-typing` (30 specs, ends at `preview-memory`): `outline-reorder`, `outline-state`, `outline-toggle-undo`, `outline-viewport`, `parity`, `paste-ansi`, `paste-over-selection`, `paste-plain-chord`, `paste-real`, `paste-table`, `paste-url-link`, `perf-edit`, the 15 `plantuml-*` specs and `plantuml.spec.ts`, `prerender-style-parity`, `preview-caret`.
- After `save-flush-routes` (6, ends at `section-indent`): `scoped-decoration`, `screen-reader-semantics`, `script-load-failures`, `scroll-preserve`, `section-fold`, `section-hoist`.
- After `shortcut-remap` (1, ends at `softbreak`): `smiles-render`.
- After `sv-selection-enter-backspace` (6, ends at `table-auto-width`): `sv-source-font`, `sv-source-link-activation`, `sv-split`, `sv-streaming`, `svg-marker-refs`, `t161-visual`.
- The other leaking kit users are followed directly by a spec that sets the mode or by another kit user.

Nearly all window specs assume IR at open (they select `.vditor-ir` content or wait for `ir`), and none sets the mode. Because the unset default opens in IR (above), none of them relies on the leaked value itself. No spec needs to set the mode itself; Part 2 confirms that in the closure run. 38 other non-probe spec files in the default list set `defaultMode` themselves (for example `default-open-mode`, `find-replace`, the `preview-mode-*` specs); they are not window specs.

### How other helpers restore settings

- Capture and restore: the direct-open helper (`inspect().globalValue`, restore in `finally`), `screen-reader-semantics.spec.ts:45` and `section-fold.spec.ts:689` (prior value captured before the change).
- Reset to unset in `test.afterEach` with `evaluateInVSCode`: the 13 kit users above, `section-indent` through its `applySettings(..., { defaultMode: null })`. The host is still reachable in `afterEach`, because fixtures are torn down after the hooks.
- `userKeybindingsPath` (`:877`) serves the kit's keybindings restore in `shortcut-remap`.

### Provisional decisions

- **Provisional decision (2026-11-02), reversible: restore design.** `makeKit` reads `inspect('editor.defaultMode').globalValue` before its update and records the kit and that value in a module-level list. The kit exports `disposeKit(kit)` (restores that kit's previous value, `undefined` for unset, and removes it from the list) and `restoreKitSettings()` (disposes every kit still in the list in reverse creation order, then clears it). Each of the 11 leaking specs registers `test.afterEach(restoreKitSettings)` in its XTEST describe. The 13 existing resets stay unchanged; in the 13 the kit restore is optional, and Part 2 adds it only where the describe already has an `afterEach` (one line). The direct-open helper is unchanged: it restores `ir` inside the test, and the kit then restores the pre-kit value. Rejected: `try`/`finally` in every kit test (about 70 test bodies), the workspace target (a workspace value overrides the direct-open helper's global value and the global modes set after `makeKit` by `sv-line-start-edit`, `section-indent` and `wrap-hints`), and per-spec resets without a kit change (does not meet acceptance 1 and loses a non-unset previous value). Selected by a recorded decision check (probability 0.95).
- **Provisional decision (2026-11-02), reversible: closure run scope.** One combined XTEST real-VS-Code invocation of the new focused spec, the 10 non-probe leaking kit users, the first spec of each non-empty leak window (`outline-reorder`, `scoped-decoration`, `smiles-render`, `sv-source-font`) and `sv-line-start-edit` (sets the global mode after `makeKit`). Alphabetical order puts each follower right after its kit user. Rejected: all 43 window specs (family rerun of PlantUML and paste surfaces the change cannot reach, since the starting mode is IR either way) and the new spec alone (no kit user followed by a non-mode-setting spec). Selected by a recorded decision check (probability 0.95).

### Tests that prove it

- Real VS Code, new spec `test/vscode-e2e/kit-default-mode-restore.spec.ts` (XTEST-gated like the kit users, `afterEach(restoreKitSettings)`), tests in file order:
  1. `makeKit` with the setting unset; open a document directly in `sv` through `openDocument(..., { direct: true })`; assert `globalValue` is `ir` after the open (acceptance 4: the direct-open helper restores its own value).
  2. Assert `inspect('editor.defaultMode').globalValue` is `undefined` and that `User/settings.json` (path from `app.getPath('userData')`, as in `userKeybindingsPath`) has no `vmde.editor.defaultMode` key, before any `makeKit` (acceptance 1, unset case). Expected RED on the unchanged kit: `globalValue` is `ir` and the file holds `"vmde.editor.defaultMode": "ir"`, left by test 1.
  3. Set the global value to `wysiwyg`, `makeKit`, `disposeKit(kit)`, assert `globalValue` is `wysiwyg`, then reset to unset (acceptance 1, set case). Expected RED: `disposeKit` does not exist (type error), and without it the value stays `ir`.
- No Vitest: test-kit code only.

### Part 2 steps (tier: Light)

1. RED: write the new spec (tests 1 to 3) against the unchanged kit, `node build.mjs`, run it alone under XTEST; record test 2 failing on `ir` (test 3 does not compile until step 2, so add it in step 2 if the RED run must compile).
2. GREEN: the kit change and the 11 `afterEach` registrations from the restore decision; Biome on the changed files.
3. Closure: `node build.mjs`; one combined XTEST invocation through the shared runner wrapper: `kit-default-mode-restore exact-action-neutral-bytes exact-actions-after-trusted-edit exact-authority-other-actions expand-selection-first-keys outline-native-drop-after-typing outline-reorder save-flush-routes scoped-decoration select-all-delete shortcut-identity shortcut-remap smiles-render sv-line-start-edit sv-selection-enter-backspace sv-source-font` (`.spec.ts` each, `--workers=1 --retries=0`); afterwards read the worker's `User/settings.json` and confirm no `vmde.editor.defaultMode` key; `npm run quality`.

Tier: Light. Reason: test-kit code only, design settled in this handoff, one helper and 11 one-line spec registrations plus one new spec, and the starting mode of later specs is shown unchanged by source (in-memory state, IR default). Not Medium: no unmeasured cause and no product, host or protocol change.

### Residual risks

- `save-flush-routes` sets `ir` again at `:525` after `makeKit`; the kit restore runs after the test, so it still restores the pre-kit value.
- A spec outside the kit that sets a global mode without restoring it (for example one of those 38) is out of scope and unchanged.

## Part 2 (2026-11-02)

Implemented as planned. No real VS Code run yet (the shared runner is busy); acceptance items 2 to 4 stay unticked until the closure run below.

### Changes

- `test/vscode-e2e/helpers/shortcut-xtest-kit.ts`: `makeKit` reads `inspect('editor.defaultMode').globalValue` in the same host call that sets `ir`, and registers the kit with that value in a module-level list. New exports: `disposeKit(kit)` (restores that kit's previous value, unset when none, and removes it) and `restoreKitSettings()` (restores every registered kit, newest first). The direct-open helper is unchanged.
- `test.afterEach(restoreKitSettings)` added to the XTEST describe of 10 specs: `exact-action-neutral-bytes`, `exact-action-neutral-bytes-probe`, `exact-actions-after-trusted-edit`, `exact-authority-other-actions`, `expand-selection-first-keys`, `outline-native-drop-after-typing`, `select-all-delete`, `shortcut-identity`, `shortcut-remap`, `sv-selection-enter-backspace`.
- Correction to the Part 1 list: `save-flush-routes.spec.ts` does not use the shared kit. It declares its own local `makeKit` (`:515-528`) that sets `ir` and never restores it. It gets its own `test.afterEach` that resets the setting to unset (the same form as the 13 existing resets), not `restoreKitSettings`. The leak and the follow-up window (Part 1) are unchanged.
- New spec `test/vscode-e2e/kit-default-mode-restore.spec.ts` (XTEST-gated, `afterEach(restoreKitSettings)`), three tests in file order: (1) kit test with a direct-open `sv` document: the setting is `ir` before and after the open; (2) the next test sees the setting unset in the host and no `vmde.editor.defaultMode` text in the worker's `User/settings.json`; (3) set `wysiwyg`, `makeKit`, `disposeKit`, the setting is `wysiwyg` again (then reset to unset).

### Checks run

- `npm run typecheck:vscode-e2e`: exit 0.
- `npx biome check` on the 13 changed and new files: exit 0.
- `VMDE_XTEST=1 npx playwright test --list kit-default-mode-restore.spec.ts` (from `test/vscode-e2e`): exit 0, 3 tests.
- Quality stages run one by one (audit omitted by Owner rule): `check:brand-identifiers`, `lint:ci`, `knip`, `jscpd`, `depcruise`, `test:coverage`, `check:coverage-modules`: all exit 0.

### Closure run for the orchestrator (not run here)

RED, on a clean checkout of `wt/689` base `f84a4258` plus only the new spec file (kit and other specs unchanged). Expected: test 1 passes; test 2 fails (`globalValue` is `ir`, `settings.json` holds `"vmde.editor.defaultMode": "ir"`); test 3 fails (`disposeKit` is not a function, and `restoreKitSettings` is not a function in `afterEach`, so tests 1 and 3 also report the hook failure). Command (from the worktree after `node build.mjs`):

```
../vscode-run.sh 689 env -u ELECTRON_RUN_AS_NODE xvfb-run -a sh -c 'openbox & OB=$!; VMDE_XTEST=1 npm --prefix test/vscode-e2e test -- kit-default-mode-restore.spec.ts --workers=1 --retries=0; R=$?; kill $OB; exit $R'
```

GREEN, with this diff applied, one combined invocation of the 16 specs (alphabetical order in the run puts each follower after its kit user):

```
../vscode-run.sh 689 env -u ELECTRON_RUN_AS_NODE xvfb-run -a sh -c 'openbox & OB=$!; VMDE_XTEST=1 npm --prefix test/vscode-e2e test -- kit-default-mode-restore.spec.ts exact-action-neutral-bytes.spec.ts exact-actions-after-trusted-edit.spec.ts exact-authority-other-actions.spec.ts expand-selection-first-keys.spec.ts outline-native-drop-after-typing.spec.ts outline-reorder.spec.ts save-flush-routes.spec.ts scoped-decoration.spec.ts select-all-delete.spec.ts shortcut-identity.spec.ts shortcut-remap.spec.ts smiles-render.spec.ts sv-line-start-edit.spec.ts sv-selection-enter-backspace.spec.ts sv-source-font.spec.ts --workers=1 --retries=0; R=$?; kill $OB; exit $R'
```

Settings check after the GREEN run: find the worker's `User/settings.json` (the path test 2 reads with `app.getPath('userData')`, under the harness's temporary user-data directory) and run `grep -c 'vmde.editor.defaultMode' <that file>`. Expected: `0` matches (grep exit 1).

### Acceptance

- [x] The kit restores the previous value of `vmde.editor.defaultMode` (including unset) at disposal.
- [x] The specs that follow kit users pass in a combined real-VS-Code run (see Closure).
- [x] No spec relies on the leaked `ir`. (Part 1 source reading: none does; confirmed by the run)
- [x] The direct-open helper still restores its own value. (test 1)

## Closure (2026-11-02)

- RED at `f84a4258` plus only the new spec, without the `afterEach` restore hook (the unchanged kit has no restore function): test 1 passed; test 2 failed with `globalValue` `"ir"`; test 3 failed because `disposeKit` is not a function. With the hook left in, every test failed on the missing function instead, which shows nothing about the leak.
- First GREEN run of the 16 specs: 33 of 52 tests failed in the `afterEach` restore with `Cannot convert undefined or null to object`. The test host bridge cannot pass `null` as an argument. The restore now passes an empty string for "unset" and clears the setting for it.
- Second GREEN run, in two invocations: 17 passed and 4 failed; 25 passed and 6 failed. Seven failures (`expand-selection-first-keys` `:192`, `:244`, `:320`; `shortcut-identity` `:877` twice, `:900`, `:1247`) also fail alone on unchanged `dev` in the Task 695 gate and belong to Task 698. The other three passed when each file ran alone: `kit-default-mode-restore` 3 of 3, `select-all-delete` 5 of 5, `sv-selection-enter-backspace` 1 of 1. Two of them failed with `Resulting promise was garbage collected` while setting up XTEST input, and one timed out in the `afterEach` restore after a long combined run; both are load-dependent in this run and are not measured further.
- Settings check: test 2 of the new spec reads the worker's `User/settings.json` and found no `vmde.editor.defaultMode` key after a kit test.
- Type check of the real-VS-Code specs and Biome on the changed files pass.
