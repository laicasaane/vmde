# Task 576 — Restore the pre-existing red repository gates

**Status:** closed (2026-09-26) — approved by the Project Owner on 2026-09-26 as the gate-cleanup follow-up to [Task 574](574-text-selection-performance.md). Every network-free quality gate is green (see "Ratchet pass" below); the knip findings that remain are pre-existing and untouched by this task.
**Goal:** Return every network-free quality stage to a meaningful state, so `test:coverage` and `check:coverage-modules` can pass again and new regressions become visible. Task 573 and Task 574 each had to record these reds as exceptions.
**Tech stack:** Vitest backend guards, `scripts/module-manifest.mjs`, `package.json` manifest, Biome, dependency-cruiser.

## Red inventory (measured 2026-09-26 at `d7bf2ae1`)

| # | Gate | Failure | Likely owner/cause |
| --- | --- | --- | --- |
| 1 | `test/backend/module-boundaries.test.ts` — manifest totality | Modules on disk but missing from `scripts/module-manifest.mjs`. Host: `emoji-recents`. Webview: `emoji-insertion`, `emoji-picker`, `emoji-recents`, `github-color-literals`, `list-normalize-source`, `list-normalize-source-command`, `table-actions`, `table-cell-selection`, `table-format`, `table-format-command`, `table-operations`, `table-resize`, `table-wysiwyg-controls`, `webview-context` | Modules added by earlier tasks without manifest entries |
| 2 | same — host edges | `markdown->platform` not in `HOST_ALLOWED_EDGES` | New cross-module import |
| 3 | same — webview edges | `editing->links` not in `WEBVIEW_ALLOWED_EDGES` | New cross-module import |
| 4 | `test/backend/probe-tier-convention.test.ts` | `context-menu-probe.spec.ts` has a test not tagged `@probe` ("context-menu visibility stamps leave shipped commands selection-driven") | `6cb310a7`/`030d9486` |
| 5 | `test/backend/manifest.test.ts` | The Editor settings group has a setting with no `order` | `a5d31572` or `8e3bc78b` |
| 6 | `test/backend/vendored-licenses.test.ts` | `media-src/vendor/emoji` has a `source.json` but no `VENDORED_ASSETS` entry | Emoji vendor addition |
| 7 | `test/backend/reference-source-lute.test.ts` | Pinned Lute WYSIWYG renders an empty `link-ref` span for a code-formatted label | Known engine defect documented by [Task 550](550-reference-style-link-editing.md); the fix is owned by deferred [Task 572](../572-native-lute-reference-links.md) |
| 8 | `npm run lint:ci` | Format-only errors in `media-src/e2e/list-harness.ts`, `media-src/src/editing/escape-toolbar.ts`, `test/backend/emoji-catalog.test.ts`, `test/vscode-e2e/block-handle.spec.ts`; unused parameter `frame` in `test/vscode-e2e/selection-performance.spec.ts:133`; `useTemplate` info in `large-document-interaction-probe.spec.ts:18` | Earlier tasks |
| 9 | `npm run depcruise` | Cruises 0 modules: dependency-cruiser does not support the installed TypeScript 7 | Tooling compatibility |
| 10 | `npm run check:coverage-modules` | Cannot run: Vitest writes no `coverage-summary.json` when any test fails | Clears once 1–7 are green |

## Rules

- **Fix the cause each guard reports; never weaken a guard to get green.** For the manifest, assign each module to its real owning module. Allow a new edge only after confirming it is intended (not a layering leak); otherwise remove the import.
- **Item 7 needs a Project Owner decision.** Changing that test's oracle (for example `it.fails` with a Task 572 pointer) would encode a known defect. Ask before changing it, and do not change Lute here.
- **Item 9:** investigate a supported dependency-cruiser/TypeScript configuration. If none exists without a dependency change, record it and ask; do not add or upgrade dependencies without approval.
- Item 5: choose the missing setting's `order` from its neighbors' documented intent.
- Item 6: add the entry to `media-src/vendor/vendored-assets.mjs`, taking license data from `media-src/vendor/emoji/source.json` (Unicode-3.0 data, OFL-1.1 font) and the upstream licenses. Do not invent license terms.
- Keep each gate fix a separate focused commit. Do not touch generated output.

## Part 1 handoff (2026-09-26, Claude Opus 5.5 `claude-opus-5-5`; no effort control exposed, so default effort)

Source review only; the one verification run is noted.

- **Item 1 (manifest totality).** All 15 files already sit in their target directories, so this is an id-only fix. Add ids to the existing entries in `scripts/module-manifest.mjs`: host `session` gets `emoji-recents` (`src/session/emoji-recents.ts`). Webview `editing` gets `emoji-insertion`, `emoji-picker`, `emoji-recents`, `github-color-literals`, `list-normalize-source`, `list-normalize-source-command`, `table-actions`, `table-cell-selection`, `table-format`, `table-format-command`, `table-operations` and `table-wysiwyg-controls`. Webview `chrome` gets `table-resize` and `webview-context`. Verify with `node scripts/module-manifest.mjs`.
- **Item 2 (`markdown->platform`).** `src/markdown/outline-tree.ts` imports `findPanelForUri` from `platform/active-panels`. It was added deliberately in `4c894c01` (outline heading reorder). `outline-tree` is a VS Code tree provider that already uses the `vscode` API heavily, and `platform` imports nothing from `markdown`, so there is no cycle. Add `'markdown->platform'` to `HOST_ALLOWED_EDGES` with a one-line comment naming the reason.
- **Item 3 (`editing->links`).** `media-src/src/editing/link-popover.ts` imports `links/link-open-policy` and `links/link-click-fix`, deliberately, in `b9fa6e57` (source-proven link popover). The allowlist already has `links->editing`, but no `links/` file imports `editing/` today, so the cycle check stays green. Moving the popover into `links/` would add new `links->chrome`/`links->nav` edges, so it is not better. Add `'editing->links'` to `WEBVIEW_ALLOWED_EDGES` with a comment.
- **Item 4 (probe tier).** The untagged test in `test/vscode-e2e/context-menu-probe.spec.ts` is a real acceptance check. It passed in real VS Code on 2026-09-26, which also covers Task 574's `e47124d3`. Tagging it `@probe` would drop it from the default suite. `git mv` it to `test/vscode-e2e/webview-context-menu.spec.ts`. The name is unused, and the `-probe` suffix only appears in the file name and the fixture name inside it, so the fixture name can stay. The spec runs green once after the move.
- **Item 5 (setting order).** `vmde.editor.emojiPickerCloseOnSelect` has no `order`. Give it `5.6`, after `toolbar` (5) and `selectionToolbar` (5.5), since the emoji picker is a toolbar dialog. `5.5` sets the precedent for decimals. Edit only `package.json`.
- **Item 6 (vendored licenses).** Add an `emoji` entry to `media-src/vendor/vendored-assets.mjs`, following the neighboring entries' shape. Take the licenses from `media-src/vendor/emoji/source.json` (Unicode-3.0 for the emoji-test and CLDR data; the Noto Color Emoji font's license from its `source.json` entry). The dir contains `OFL-1.1.txt`. Do not invent terms. If a required field cannot be filled from those files, stop and report.
- **Item 8 (lint).** Run `npx biome format --write` on the four format files. Fix the unused `frame` parameter at `test/vscode-e2e/selection-performance.spec.ts:133`: remove it and update callers, or prefix it with `_` if the signature is shared. Apply Biome's `useTemplate` fix in `test/vscode-e2e/large-document-interaction-probe.spec.ts:18`.
- **Item 7 (Lute WYS oracle)** and **item 9 (depcruise with TypeScript 7)** need Project Owner decisions; see the questions below. dependency-cruiser 18.2.0 parses TypeScript only through `tsc`, which does not work with the installed TypeScript 7.0.2, or `swc`, and `@swc/core` is not installed.

**Project Owner decisions (2026-09-26):**
- **Item 7:** split the test. Keep the IR assertion as a normal passing test. Put the WYSIWYG assertion in an `it.fails` test whose name/comment points at Task 572, so the gate turns green, the defect stays documented, and the test flips once Task 572 fixes Lute. Make no Lute change.
- **Item 9:** add the `@swc/core` devDependency (network install and lockfile change approved) and set `parser: 'swc'` in `.dependency-cruiser.cjs`, so `depcruise` actually checks modules again. If real modules then surface rule violations, report them. Do not weaken rules; that returns to Part 1.

## Checklist

- [x] Part 1: inspect each item's source and record the intended fix and any owner question here (items 7 and 9 at minimum).
- [x] Items 1–3: manifest entries and edge decisions added exactly as the handoff listed (plus one edge the handoff missed, `chrome->diagram-kit`, discovered and confirmed intended). The `emoji-recents` collision was resolved in the feedback-path pass (see below) by renaming the host file — `module-boundaries.test.ts` is now 7/7.
- [x] Item 4: probe suffix dropped via `git mv`; `probe-tier-convention.test.ts` green; real-VS-Code spec 1/1.
- [x] Item 5: setting order `5.6` added; `manifest.test.ts` green (43/43).
- [x] Item 6: vendored license entry added; `vendored-licenses.test.ts` green (95/95).
- [x] Item 8: `biome format --write` applied plus the two lint fixes (unused `frame` param removed + its 3 call sites, `useTemplate` applied); `lint:ci` clean (0 errors/warnings/info) on the whole tree; `typecheck` clean; `typecheck:vscode-e2e` shows only the pre-existing known `preview-task-checkbox.spec.ts:122` error, nothing new.
- [x] Item 7: owner's split decision applied (IR assertion kept passing, WYS assertion moved to `it.fails` naming Task 572); file green (10 passed, 1 expected fail).
- [x] Item 9: `@swc/core` installed and `parser: 'swc'` set; the 3 `no-circular` violations were resolved in the feedback-path pass (see below) by moving the cycle-forming types; `depcruise` is now 0 violations, 66 host / 264 webview modules cruised. Committed.
- [x] Final: `test:coverage` green (309/309 files, 4611 passed + 1 expected fail). `check:coverage-modules` green ("Coverage ratchet OK — 13 source module(s) at 0% (baseline 13)") after the Ratchet pass added real unit coverage for `table-format-command.ts` and `table-wysiwyg-controls.ts` (see below). `knip` reports only pre-existing findings in files this task never edited the content of; `jscpd`, `lint:ci`, `depcruise` all green. Dependency audits stay omitted under the local owner policy.

## Part 2 results (2026-09-26, Claude Sonnet 5 `claude-sonnet-5`; runner exposes no effort control, so default effort, not a confirmed effort=medium)

Ran the fixes and verifications myself (not source-review-only). Two new blockers surfaced during Part 2 that Part 1's source review did not catch, because Part 1 did not actually execute the combined verification. Neither is weakened or worked around; both are reported here for a Project Owner decision, per the same "never weaken a guard" rule that governs items 7 and 9.

### Items 1–3 — manifest entries, edges, and a new blocker

Added the ids/edges exactly as the Part 1 handoff listed: `scripts/module-manifest.mjs` gained host `session.emoji-recents`, webview `editing.{emoji-insertion, emoji-picker, emoji-recents, github-color-literals, list-normalize-source, list-normalize-source-command, table-actions, table-cell-selection, table-format, table-format-command, table-operations, table-wysiwyg-controls}`, webview `chrome.{table-resize, webview-context}`. `test/backend/module-boundaries.test.ts` gained `'markdown->platform'` and `'editing->links'` in `HOST_ALLOWED_EDGES`/`WEBVIEW_ALLOWED_EDGES` with one-line comments as specified.

Running `node scripts/module-manifest.mjs` and the vitest file surfaced two things the handoff's plan did not anticipate (Part 1 was source-review-only and did not run the combined check):

1. **A third new edge, `chrome->diagram-kit`.** Once `webview-context.ts` is correctly counted in the `chrome` module (per the handoff's own item-1 instruction), its pre-existing import of `engineLangSet` from `diagram-kit/engine-registry` (to classify diagram context-menu sections) becomes a newly-visible inter-module edge. I inspected it: `diagram-kit/` has no import back into `chrome/` (verified with grep — the one "chrome" hit in `diagram-palette.ts` is the substring in "monochrome"), and the relationship matches the existing pattern where `diagrams`, `editing`, `bridge`, and `boot` all already read `diagram-kit` as a shared registry. I judged this an intended edge (not a layering leak) and added `'chrome->diagram-kit'` to `WEBVIEW_ALLOWED_EDGES` in sorted position with a comment. This is a code-review judgment call within the "allow a new edge only after confirming it's intended" rule the task gives me authority to make; flagging it here for visibility since it wasn't in the original handoff's edge list.
2. **A cross-tree basename collision: `emoji-recents`.** Both `src/session/emoji-recents.ts` (host) and `media-src/src/editing/emoji-recents.ts` (webview) already exist on disk with the same basename — two genuinely different files (host validates a pinned catalog against `EmojiRecentState`/`pinnedEmojiSequences`; webview normalizes recent-emoji state client-side). `scripts/module-manifest.mjs`'s own header states the manifest's ids are "verified globally unique across `src/` + `media-src/src/`" and `checkManifest()` enforces this with an explicit cross-tree collision check. Before Part 1's fix, neither file was in either manifest, so the collision check (which only compares ids that ARE in the manifest) never fired — the violation was latent, not new. The handoff's literal instruction (add `emoji-recents` to both host `session` and webview `editing`) is the only way to satisfy items 1–3's "on disk but not in manifest" requirement, but doing so makes `checkManifest()` report `CROSS-TREE basename collisions (host vs webview): emoji-recents`, and `module-boundaries.test.ts`'s "manifest is total and disjoint" test fails as a result (6/7, not 7/7).
   - I did **not** rename either file. A rename touches `src/shared/protocol.ts`, `src/session/editor-session.ts`, `media-src/src/bridge/message-router.ts`, `media-src/src/editing/emoji-picker.ts`, and both files' `.test.ts` counterparts — a structural, scope-expanding change beyond a manifest fix, and naming an import target unilaterally isn't mine to decide given how deliberately this manifest documents every module-identity choice.
   - **This needs a Project Owner decision**: rename one of the two files (e.g. host → `emoji-recents-store.ts`, or webview → `emoji-recents-picker.ts`) and update its ~2–3 importers plus its test, or decide the global-uniqueness invariant should be relaxed for legitimately-unrelated host/webview modules (which would mean editing `checkManifest()`'s cross-tree check itself — also a rule change, not mine to make unilaterally).
   - Net effect: `scripts/module-manifest.mjs` reports `module-manifest: FAILED` (only for this collision — both sides are individually total/disjoint: `[HOST] ... ok=true`, `[WEBVIEW] ... ok=true`); `module-boundaries.test.ts` is 6 passed / 1 failed (7 total).

Committed anyway (`192393c9`, `test: account for new modules and edges in the module boundary manifest`) because the diff is correct and matches the handoff's explicit instructions — the residual failure is an orthogonal, pre-existing basename collision, not a defect in this commit's own content.

### Item 9 — swc parser and a second new blocker

`npm install --save-dev @swc/core` (network-approved) installed `@swc/core@1.16.2`. `.dependency-cruiser.cjs` gained `options.parser: 'swc'` with a comment. `node_modules/dependency-cruiser/types/options.d.mts` confirms `ParserType = "acorn" | "tsc" | "swc"` — `swc` is a real, documented option, not invented.

`npm run depcruise` now cruises real modules on both graphs (previously 0/0):
```
depcruise:host    → ✔ no dependency violations found (66 modules, 154 dependencies cruised)
depcruise:webview → x 3 dependency violations (3 errors, 0 warnings). 264 modules, 789 dependencies cruised.
```
The 3 webview violations, reported verbatim:
```
error no-circular: src/nav/block-handle.ts →
    src/nav/source-block-index.ts →
    src/nav/block-handle.ts
error no-circular: src/editing/emoji-picker.ts →
    src/editing/emoji-recents.ts →
    src/editing/emoji-picker.ts
error no-circular: src/diagrams/diagram-controls.ts →
    src/diagrams/diagram-fullscreen.ts →
    src/diagrams/diagram-controls.ts
```
(Both runs also print an unrelated `missing-typescript-transpiler` advisory about TypeScript 7 not being tsc-compatible — informational, not a failure; `swc` is exactly what routes around that.)

For context (not a fix, not acted on): in all three pairs, one direction is a type-only import (`import type { ... } from './x'`) and the other is a value import; `source-block-index.ts`'s own header comment says "Runtime dependencies are injected, so this module never imports `block-handle.ts`" at runtime. This looks like the classic false-positive shape where a type-only edge closes an otherwise-real DAG, but `no-circular`'s `to: { circular: true }` matcher doesn't distinguish dependency type, and scoping it (e.g. `dependencyTypesNot: ['type-only']`) would be a rule edit — squarely the "do not weaken or edit rules" instruction. I did not touch the rule or the source files.

Per the owner's own instruction ("if real modules then surface rule violations, report them; do not weaken rules; that returns to Part 1"), **this item is not committed.** `package.json`, `package-lock.json`, `.dependency-cruiser.cjs`, and `knip.jsonc` (see below) are left as uncommitted working-tree changes for review; `git status` shows them modified, nothing staged.

I also added `"@swc/core"` to `knip.jsonc`'s root `ignoreDependencies` (with a comment) because the raw install otherwise makes `npm run knip` report it as an unused devDependency — it's real, indirect (dependency-cruiser `require()`s it internally via the `parser: 'swc'` string, no import for knip to see), the same shape as the existing `@playwright/cli`/`media-src`/`vditor` entries in that same list. This edit is bundled with the other uncommitted item-9 files, not committed either, pending the collision-style decision above (rename one circular pair, or accept/allowlist the type-only cycles — not mine to decide).

Confirmed packaging is unaffected regardless of outcome: `@swc/core` is devDependencies-only (`dependencies` has no such key) and `.vscodeignore` excludes all of `node_modules`.

**This needs a Project Owner decision**: how to treat the 3 `no-circular` violations — fix the apparent type-only-import shape at the source (e.g. verify the pairs are truly runtime-acyclic and restructure so dependency-cruiser's extraction sees that), or make a rule-level call (out of my authority here) about type-only edges. Until decided, item 9's `@swc/core`/`.dependency-cruiser.cjs` change stays uncommitted.

### Items 4, 5, 6, 7, 8 — verification detail

- **Item 4**: `git mv test/vscode-e2e/context-menu-probe.spec.ts test/vscode-e2e/webview-context-menu.spec.ts`. Grepped the whole repo (excluding `node_modules`) for `context-menu-probe`: only the file's own internal fixture path (`context-menu-probe.md`, left as instructed) and two prose mentions in `tasks/576-restore-green-repository-gates.md` (this file) and `tasks/done/560-github-inline-color-literals.md` (historical, not touched). `probe-tier-convention.test.ts`: 3/3. Build: `node build.mjs` succeeded (full vendored-asset + webview bundle log, no errors). Real-VS-Code spec: `env -u ELECTRON_RUN_AS_NODE xvfb-run -a npm --prefix test/vscode-e2e test -- webview-context-menu.spec.ts --retries=0 --workers=1` → 1 passed. Commit `6c3b7717`.
- **Item 5**: `package.json`'s `vmde.editor.emojiPickerCloseOnSelect` gained `"order": 5.6`, matching the handoff exactly (neighbors: `toolbar` order 5, `selectionToolbar` order 5.5). `test/backend/manifest.test.ts`: 43/43. Commit `98fa8cc6`.
- **Item 6**: added an `emoji` entry to `media-src/vendor/vendored-assets.mjs` (`copy: []`, `license: ['OFL-1.1.txt']`, custom `label`, `installedNote`) modeled on the `elk`/`mermaid-layout-elk` "bytes consumed elsewhere, not copied verbatim" shape — `emoji-test-17.0.txt`/`cldr-47-annotations-en.json` feed `media-src/scripts/generate-emoji-catalog.mjs` → `media/emoji/emoji-catalog.json`, not a raw copy into `media/vditor/dist/js/emoji/`; `OFL-1.1.txt` is the only license FILE physically present in the vendor dir (Unicode-3.0 is recorded in `source.json` as an identifier, not a shipped license text); the Noto Color Emoji font itself is not vendored through this dir — it already ships from the tracked `media/fonts/NotoColorEmoji.ttf` with its own `media/fonts/NotoColorEmoji-LICENSE.txt`. No terms invented. `test/backend/vendored-licenses.test.ts`: 95/95. Cross-checked `test/backend/emoji-catalog.test.ts` (2/2, unaffected) and re-ran `node build.mjs`, which now logs `[emoji] vendored Unicode 17.0.0 + CLDR 47.0.0 verified + installed (catalog generated into media/emoji/ by generate-emoji-catalog.mjs)`. Commit `80ba2464`.
- **Item 7**: split `test/backend/reference-source-lute.test.ts`'s combined IR/WYS test into `'keeps a code-formatted reference label in pinned IR DOM'` (plain `it`, passes) and `it.fails('keeps a code-formatted reference label in pinned WYS DOM (defect owned by Task 572)', ...)` with a comment naming Task 550/572 and `tasks/572-native-lute-reference-links.md`. No Lute change. File: 10 passed, 1 expected fail. Commit `34214e8a`.
- **Item 8**: `npx biome format --write` on the four named files; removed the unused `frame` param from `sourceIsUnchanged` in `test/vscode-e2e/selection-performance.spec.ts` (3 call sites updated, same shared signature, no behavior change) instead of prefixing with `_` (the param was fully unused, not part of a shared callback shape that needed it); applied Biome's suggested `useTemplate` fix at `large-document-interaction-probe.spec.ts:18`. `npm run lint:ci`: `Checked 1053 files ... No fixes applied.` — clean, 0 errors/warnings/info. `npm run typecheck`: clean. `npm run typecheck:vscode-e2e`: only the pre-existing known `preview-task-checkbox.spec.ts:122` `TS2339` error — confirmed nothing new. Ran the two real-VS-Code specs touched by the fixes as a sanity check: `block-handle.spec.ts` (12 passed, 1 pre-existing OS-acceptance skip, unrelated to my edits) and `selection-performance.spec.ts` (1 pre-existing skip, unrelated). Commit `1602a3a2`.

### Final gates (run once, on the tree as it stood after all committed + the uncommitted item-9 changes)

- `npm run test:coverage`: **NOT green.** `Test Files 1 failed | 306 passed (307)`, `Tests 1 failed | 4584 passed | 1 expected fail (4586)`. The one failure is `test/backend/module-boundaries.test.ts > module boundaries (task 460) > manifest is total and disjoint against the tree on disk` — the same `emoji-recents` cross-tree collision reported under items 1–3. Message: `AssertionError: expected false to be true`.
- `npm run check:coverage-modules`: **cannot run** — `check-coverage-modules: coverage/coverage-summary.json not found — run npm run test:coverage first.` Vitest does not write the summary because one test failed, exactly item 10's documented mechanism.
- `npm run knip`: runs, not clean, but nothing here is new from Part 2's own source edits (no Part 2 commit touched any of these files' contents — only manifest bookkeeping and config). Reported verbatim: `Unused exports (9)` — `MIN_TABLE_COLUMN_WIDTH` and `clearSessionTableWidths` (`media-src/src/chrome/table-resize.ts`), `EmojiRecentsVersion`/`EmojiRecentsLimit` in both `media-src/src/editing/emoji-recents.ts` and `src/session/emoji-recents.ts`, `isSafeRasterImageLocation` (`media-src/src/editing/inline-picture.ts`), `loadSvgDataImageSanitizer` (`media-src/src/editing/svg-data-image-adapter.ts`), `OUTLINE_HEADING_MIME` (`src/markdown/outline-tree.ts`); `Unused exported types (1)` — `EmojiRecentState` (`media-src/src/editing/emoji-recents.ts`). (`@swc/core` no longer flags as an unused devDependency after the `knip.jsonc` addition above.)
- `npm run jscpd`: green — exit 0, `1386 clones`, `Duplicated lines 17216 (7.18%)`, `Duplicated tokens 113572 (8.55%)`, under the configured `threshold: 8.8`.
- `npm run lint:ci`: green — `Checked 1053 files ... No fixes applied.`
- `npm run depcruise`: **not clean** — see the item 9 section above (66/264 modules now cruised, 3 `no-circular` violations on the webview graph). Not committed.
- Dependency audits skipped per owner policy, as instructed.

### Commits made (all local, none pushed, no attribution trailers)

1. `192393c9` — `test: account for new modules and edges in the module boundary manifest`
2. `6c3b7717` — `test(e2e): drop the probe suffix from the context-menu acceptance spec`
3. `98fa8cc6` — `fix(manifest): order the emoji picker close setting`
4. `80ba2464` — `chore(vendor): list the emoji data in the vendored-asset inventory`
5. `34214e8a` — `test: mark the pinned-Lute WYSIWYG reference-label defect as expected until Task 572`
6. `1602a3a2` — `style: clear pre-existing lint findings`

Item 9's changes (`package.json`, `package-lock.json`, `.dependency-cruiser.cjs`, `knip.jsonc`) are **uncommitted** in the working tree, pending the Project Owner decision above. `LOCAL_AGENT_TASK.md` / `LOCAL_AGENT_TASK_FUTURE.md` were never staged in any commit (verified with `git diff --cached --name-only` before every commit).

### Status

Left **open** at the end of the first Part 2 pass. Two Project Owner decisions were needed; see the Feedback-path pass below for how both were resolved, and for a third blocker the resolution itself uncovered.

## Feedback-path pass (2026-09-26, Claude Sonnet 5 `claude-sonnet-5`; runner exposes no effort control, so default effort)

The coordinator returned a revised Part 1 handoff for the two blockers above (Opus 5.5 reasoning; Jev `jev_decide` selected this resolution at 0.97 confidence over relaxing either guard). Both fixes are in approved scope, behavior-neutral, and needed no guard/rule edit — applied as directed.

**A. `emoji-recents` collision, resolved.** `git mv src/session/emoji-recents.ts src/session/emoji-recents-store.ts`; updated its two importers (`src/session/editor-session.ts`, `test/backend/emoji-recents.test.ts` — import path only, test file itself not renamed); changed the host `session` manifest id from `emoji-recents` to `emoji-recents-store` (`scripts/module-manifest.mjs`). The webview `editing/emoji-recents` id was untouched. Verified: `node scripts/module-manifest.mjs` → `OK — total and disjoint`; `module-boundaries.test.ts`, `emoji-recents.test.ts`, `editor-session.test.ts` → 33/33 combined. Commit `b3dc2183` — `refactor: give the host emoji recents store a unique module id`.

**B. The 3 `no-circular` violations, resolved.** Moved each type into the lower module that already imported it as a type-only edge, verbatim including doc comments, and left a re-export from the original module so no other importer needed to change:
- `BlockHandleUnit`: moved from `media-src/src/nav/block-handle.ts` into `media-src/src/nav/source-block-index.ts` (which also needed a new `import type { MovableKind } from '../../../src/shared/block-move'` the interface body depends on); `block-handle.ts` now does `import { ..., type BlockHandleUnit, ... } from './source-block-index'` and `export type { BlockHandleUnit }`.
- `EmojiEntry`: moved from `media-src/src/editing/emoji-picker.ts` into `media-src/src/editing/emoji-recents.ts`; `emoji-picker.ts` now imports it as a type from `./emoji-recents` (alongside its existing value imports) and re-exports it.
- `DiagramFullscreenAction`: moved from `media-src/src/diagrams/diagram-controls.ts` into `media-src/src/diagrams/diagram-fullscreen.ts`; `diagram-controls.ts` now imports it as a type from `./diagram-fullscreen` (alongside its existing value imports) and re-exports it.

`npm run knip` after the move flags none of the three re-exports as unused (every existing importer still resolves through the original module path), so no importer paths were changed and no re-export was dropped, per the instruction. Verified: `npm run typecheck` clean; focused unit files (`diagram-controls.test.ts`, `diagram-fullscreen.test.ts`, `block-handle.test.ts`, `source-block-index.test.ts`, `emoji-recents.test.ts`, `emoji-picker.test.ts`, plus `test/backend/emoji-recents.test.ts` and `editor-session.test.ts`) → 74/74 combined; `npm run depcruise` with the (now-committed) swc config → 0 violations, 66 host / 264 webview modules cruised (previously 3 errors). `npm run lint:ci` clean before committing. Commit `cebfa0f4` — `refactor: move cycle-forming types into their lower modules`.

Then committed the item-9 work that had been left staged-but-uncommitted from the first pass: `package.json`, `package-lock.json`, `.dependency-cruiser.cjs` (the `parser: 'swc'` option), and `knip.jsonc` (kept the `@swc/core` → `ignoreDependencies` entry: re-confirmed knip still flags `@swc/core` as an unused devDependency without it, since dependency-cruiser only reaches it via the `parser: 'swc'` string, not an import). Commit `ccee9724` — `build: parse TypeScript with swc so dependency-cruiser works with TypeScript 7`.

**Production-file verification** (block-handle.ts/source-block-index.ts changed, not type-only from the build's perspective): `node build.mjs` succeeded (full vendored-asset + webview bundle, no errors, including the `[emoji]` line from item 6). Chromium: `xvfb-run -a npm --prefix media-src run test:e2e -- block-handle.spec.ts --retries=0` → 17/17 passed. Real VS Code: `env -u ELECTRON_RUN_AS_NODE xvfb-run -a npm --prefix test/vscode-e2e test -- block-handle.spec.ts large-document-interaction.spec.ts --retries=0 --workers=1` → 15 passed, 2 skipped (both pre-existing OS-keyboard-acceptance skips, unrelated to these changes — same skip pattern seen in the first pass). Emoji/diagram changes were type-only and typecheck showed nothing extra, so no additional e2e was run for those, per the instruction.

**Final gates, rerun once on the tree with both fixes + item 9 committed:**
- `npm run test:coverage`: **green** — `Test Files 307 passed (307)`, `Tests 4585 passed | 1 expected fail (4586)`.
- `npm run check:coverage-modules`: **FAILED — a third, previously-invisible blocker.** Now that `test:coverage` completes and writes `coverage/coverage-summary.json` for the first time this task, the coverage ratchet (`scripts/check-coverage-modules.mjs`, task 190) reports:
  ```
  Coverage ratchet FAILED — these source modules are at 0% coverage and are NOT in the baseline:
    media-src/src/editing/table-format-command.ts
    media-src/src/editing/table-wysiwyg-controls.ts

  Add a unit test (or an e2e whose coverage is merged) that exercises them. Do NOT add them to BASELINE_ZERO.
  ```
  Both files are genuine modules (373 and 185 lines) already wired into the webview e2e harness (`media-src/e2e/harness.ts`, `media-src/e2e/rewrap-harness.ts` reference them by name) but have **no unit test file at all** (`find` for `*table-format-command*`/`*table-wysiwyg-controls*` under `media-src/src`/`test` returns only the source files themselves). This is structurally the same shape as several already-`BASELINE_ZERO` entries (e.g. `table-hotkey.ts`, `prerender-overlay.ts`, `toolbar-dismiss.ts` — webview wiring exercised only by e2e, whose coverage isn't merged into this report), but the ratchet script's own header is explicit: "PRUNE an entry the moment it gains unit coverage; **NEVER add one to silence a failure** (that defeats the ratchet — write the test instead)." Writing real unit tests for two previously-untested table-editing modules is new test-authoring work, not a gate-bookkeeping fix, and item 10 in this task's original red inventory only anticipated this gate "clearing once 1–7 are green" — it did not anticipate a ratchet failure underneath. Per the coordinator's instruction ("if anything else fails, stop and report verbatim"), I did **not** attempt to write those tests or touch `BASELINE_ZERO`. Stopping here.
- `npm run knip`: same pre-existing findings as the first pass, nothing new: `Unused exports (9)` (`table-resize.ts` ×2, `emoji-recents.ts`/`emoji-recents-store.ts` ×2 each, `inline-picture.ts`, `svg-data-image-adapter.ts`, `outline-tree.ts`) and `Unused exported types (1)` (`EmojiRecentState`). None of these are Part 2 content edits — I never touched any of those files' bodies, only manifest/config bookkeeping and (for `emoji-recents.ts`/`emoji-recents-store.ts`) a straight rename. `@swc/core` does not appear (the `knip.jsonc` ignore is confirmed still necessary and effective).
- `npm run jscpd`: green — exit 0, `1386 clones`, `8.55%` duplicated tokens, under the `8.8%` threshold.
- `npm run lint:ci`: green — `Checked 1053 files ... No fixes applied.`
- `npm run depcruise`: green — 0 violations, 66 host / 264 webview modules cruised.

### Commits added in this pass
7. `b3dc2183` — `refactor: give the host emoji recents store a unique module id`
8. `cebfa0f4` — `refactor: move cycle-forming types into their lower modules`
9. `ccee9724` — `build: parse TypeScript with swc so dependency-cruiser works with TypeScript 7`

### Status (superseded — see Ratchet pass below)

At the end of the feedback-path pass, both Project Owner decisions were resolved but the coverage-ratchet blocker below was still open.

## Ratchet pass (2026-09-26, Claude Sonnet 5 `claude-sonnet-5`; routing Medium, Sonnet 5 high requested — runner exposes no effort control, so recording default effort, not a confirmed high)

Wrote real behavior tests for both modules per the coordinator's next Part 1 handoff, modeled on `table-format.test.ts`, `table-cell-selection.test.ts`, `table-operations.test.ts`, and the `../util/inner-vditor`-mocking pattern in `block-transform-command.test.ts`/`rewrap-command.test.ts`. `BASELINE_ZERO` was not touched. Every assertion checks observable behavior (DOM state, mock call arguments, return values) — no bare coverage-padding calls.

Before writing the final files, I validated every scenario against the REAL modules with disposable scratch tests (deleted before committing) to confirm exact behavior rather than guessing — for example, that `mapCaretOffsetByLine`/`mapRenderedTableSelectionToSource` are identity functions when their two markdown arguments are equal (confirmed straight from `mapCaretOffsetByLine`'s `if (canonical === authoritative) return caretOffset` early return), and that a fake `FormatStr` swapping `'a'` → `'A'` produces a fully deterministic, non-reflowing table transform. Module behavior matched this task's description in every case; no bug was found.

**`media-src/src/editing/table-wysiwyg-controls.test.ts`** (jsdom, 9 tests). Mocks `../util/inner-vditor`, `./table-actions` (`runTableMove`), `./table-cell-selection` (`tablePanelRectangleBounds`, `runTablePanelRectangleAction`). Builds a real 3-column table (1 header + 2 body rows) and a separate popover element exposed as `inner.wysiwyg.popover`. Covers: (a) one-time injection, skipped in IR/SV mode and outside `td`/`th`; (b) every disabled-button rule at each table edge, refreshed on a later selection, including the two rectangle-driven `deleteColumn`/`deleteRow` cases and a 1-column table — discovered along the way that `deleteRow`/`deleteColumn` are Vditor's OWN native buttons living directly in the popover (siblings of the injected group, not inside it), which `updateDisabledControls` queries the whole popover to find, so the test adds them as real popover children rather than assuming they're part of the injected `#vmde-table-moves` group; (c) a move-button click calls `runTableMove` and its `mousedown` is prevented; (d) native-range capture maps `insertRow`/`insertColumn`/`deleteRow`/`deleteColumn` buttons by `data-type` + ordinal, verified `'none'` lets the button's own bubble-phase handler run unprevented while `'applied'`/`'rejected'` both suppress it via `stopImmediatePropagation`; (e) the eight Ctrl/Shift keyboard chords, gated on Shift/Alt/cell/mode and on `runTableMove`'s own return value; (f) `dispose()` removing all three listeners and the group. The final case stubs `requestAnimationFrame` with fake timers exactly as `edit-sync.test.ts` does, to prove the click-triggered rebuild is scheduled through it rather than run synchronously.

**`media-src/src/editing/table-format-command.test.ts`** (jsdom, 17 tests). Uses the REAL `formatTableAtSelection`, `mapRenderedTableSelectionToSource`, and `mapCaretOffsetByLine` (kept real via a partial `./rewrap-command` mock: `importOriginal()` plus overriding only `checkpointEditorUndo`/`recordRewrapDocumentHistory`). Mocks `../util/inner-vditor`, `../util/caret-gesture`, `./caret`, `../chrome/toolbar-scroll-guard`, and `./table-actions`' snapshot/restore. One fixed SV `<pre>` (`before\n\n|a|b|\n|-|-|\n|1|2|\n\nafter\n`) with a fake `lute.FormatStr` that swaps `a`→`A` losslessly, so the rendered and "exact" markdown stay byte-identical and every caret offset reduces to plain arithmetic. Covers: (a) all five `captureTableFormatSvSelection` guard branches, including "before `configureTableFormatCommand` ever ran" — the only case needing `vi.resetModules()` + a dynamic `import()` for a genuinely fresh module instance, since `deps` lives in that module's own closure; (b) the full happy path — capture, run, formatted text, one `postExact` call, `setApplying(true)`/`(false)`, two `checkpointEditorUndo` calls, one `recordRewrapDocumentHistory` call with the exact before/after payload, `requestCaret` restoring the unchanged offset, and a second run correctly returning `false` (selection consumed); (c) all four run guards (exact bytes changed, editor text changed, `contenteditable="false"`, composition active) plus "nothing retained" — isolating "exact bytes changed" from "editor text changed" required `snapshotExactMarkdown.mockReturnValueOnce(...)` to decouple the mock's return value from the DOM for exactly one call, since both guards would otherwise trip together (the mock's default implementation reads `editor.textContent` directly); (d) rollback on a failed caret restore — source text restored, `restoreTableUndoForRollback` called, `postExact` never called; (e) retention — `input`/`pointerdown`/`keydown` inside the editor each clear the retained selection, and a start-of-editor sentinel capture after a real caret capture is rejected without clobbering the earlier retained caret; (f) a thrown formatter error reaching `onError` without applying anything.

One correctness snag caught by re-running the suite together (not by inspection): `vi.clearAllMocks()` in `beforeEach` clears call history but NOT a mock's `mockReturnValue` override, so an early test's `.mockReturnValue(true)`/`.mockReturnValue(false)` on a shared mock (`isCompositionActive`, `requestCaret`) leaked into later tests and made three of them fail when run as part of the full suite (they passed individually). Fixed by switching those two overrides to `.mockReturnValueOnce(...)`, which self-cleans after the one call each test actually needs — both files now pass individually and together, in either order.

A typecheck-only issue: the deps fields (`snapshotExactMarkdown`, `postExact`, `setApplying`, `onError`) needed inline `vi.fn((_x: T) => ...)` typing rather than a bare `ReturnType<typeof vi.fn>` annotation (the latter infers `Mock<Constructable | Procedure>`, which doesn't satisfy `TableFormatCommandDeps`'s concrete signatures) — matched to `block-transform-command.test.ts`'s existing pattern for the same shape.

No case needed to be skipped; nothing needed jsdom's Range support beyond what it already provides for this module.

**Verification, on the tree with both new test files:**
- The two new files individually: 9 + 17 = 26 passed.
- Together with `table-format.test.ts`, `table-cell-selection.test.ts`, `table-operations.test.ts`, `rewrap-command.test.ts`, `block-transform-command.test.ts`: 103 passed, 7 files (proves no cross-file mock-state pollution either).
- `npm run test:coverage`: green — `Test Files 309 passed (309)`, `Tests 4611 passed | 1 expected fail (4612)`. (One run hit an unrelated, pre-existing flaky timing assertion in `test/backend/markmap-security.test.ts` — `keeps long mailto linkification bounded`, a perf-ratio threshold sensitive to machine load under the full suite's CPU contention; it passed both in isolation and on an immediate full rerun, and this task never touched that file.)
- `npm run check:coverage-modules`: green — `Coverage ratchet OK — 13 source module(s) at 0% (baseline 13)` (the two new files are no longer in the zero set; the original 13-entry baseline is unchanged, nothing to prune).
- `npm run lint:ci`: green — `Checked 1055 files ... No fixes applied.`
- `npm run knip`: unchanged from the feedback-path pass — the same 9 unused exports + 1 unused type in files this task never edited the content of (`table-resize.ts`, `emoji-recents.ts`/`emoji-recents-store.ts`, `inline-picture.ts`, `svg-data-image-adapter.ts`, `outline-tree.ts`). Pre-existing, not a Part 2 regression.
- `npm run typecheck`: clean.
- `npm run jscpd`: green — 1388 clones, 8.53% duplicated tokens, under the 8.8% threshold.
- `npm run depcruise`: green — 0 violations, 66 host / 264 webview modules cruised.

### Commit

10. `cafddbd9` — `test: cover the SV table format command and WYSIWYG table controls`

### Status

Every gate is green except the knip findings, which are pre-existing and unrelated to this task's edits. Closing per the original instructions: Status closed (2026-09-26), moved to `tasks/done/`, indexed in `tasks/README.md`.
