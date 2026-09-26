# Task 576 — Restore the pre-existing red repository gates

**Status:** open — approved by the Project Owner on 2026-09-26 as the gate-cleanup follow-up to [Task 574](done/574-text-selection-performance.md).
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
| 7 | `test/backend/reference-source-lute.test.ts` | Pinned Lute WYSIWYG renders an empty `link-ref` span for a code-formatted label | Known engine defect documented by [Task 550](done/550-reference-style-link-editing.md); the fix is owned by deferred [Task 572](572-native-lute-reference-links.md) |
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
- [x] Items 1–3: manifest entries and edge decisions added exactly as the handoff listed (plus one edge the handoff missed, `chrome->diagram-kit`, discovered and confirmed intended — see Part 2 results). `module-boundaries.test.ts` is 6/7, **not** 7/7: a new blocker surfaced (see below) and is NOT resolved.
- [x] Item 4: probe suffix dropped via `git mv`; `probe-tier-convention.test.ts` green; real-VS-Code spec 1/1.
- [x] Item 5: setting order `5.6` added; `manifest.test.ts` green (43/43).
- [x] Item 6: vendored license entry added; `vendored-licenses.test.ts` green (95/95).
- [x] Item 8: `biome format --write` applied plus the two lint fixes (unused `frame` param removed + its 3 call sites, `useTemplate` applied); `lint:ci` clean (0 errors/warnings/info) on the whole tree; `typecheck` clean; `typecheck:vscode-e2e` shows only the pre-existing known `preview-task-checkbox.spec.ts:122` error, nothing new.
- [x] Item 7: owner's split decision applied (IR assertion kept passing, WYS assertion moved to `it.fails` naming Task 572); file green (10 passed, 1 expected fail).
- [ ] Item 9: `@swc/core` installed and `parser: 'swc'` set; `depcruise` now cruises real modules (66 host / 264 webview, previously 0) — but it also surfaces 3 real `no-circular` violations. Per the owner's own instruction ("if real modules then surface rule violations, report them; do not weaken rules"), this is **not committed** and left as an open blocker requiring a Project Owner decision — see Part 2 results.
- [ ] Final: `test:coverage` is **not** green (1 failure: the same items-1–3 blocker); `check:coverage-modules` cannot run as a result (no `coverage-summary.json` is written when a test fails); `knip`, `jscpd`, `lint:ci`, `depcruise` reported below. Dependency audits stay omitted under the local owner policy. Status stays **open**; the record is **not** moved to `tasks/done/` per the "if any gate is not green" instruction.

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

Left **open**. Two Project Owner decisions are needed before this task can close:
1. The `emoji-recents` host/webview basename collision (items 1–3) — rename one file (recommend, since it is the smaller blast radius: 2–3 importers + 1 test each) or relax the manifest's global-uniqueness invariant.
2. The 3 `no-circular` violations depcruise now surfaces (item 9) — restructure the type-only-import pairs so dependency-cruiser sees them as acyclic, or make a scoped rule decision (e.g. excluding type-only edges from `no-circular`) — not mine to make unilaterally.

Not moved to `tasks/done/`; no `tasks/README.md` index line added, per the "if any gate is not green" instruction.
