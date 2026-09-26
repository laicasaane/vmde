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

## Checklist

- [x] Part 1: inspect each item's source and record the intended fix and any owner question here (items 7 and 9 at minimum).
- [ ] Items 1–3: manifest entries and edge decisions; `module-boundaries.test.ts` 7/7.
- [ ] Item 4: probe tag or exception with rationale; `probe-tier-convention.test.ts` green.
- [ ] Item 5: setting order; `manifest.test.ts` green.
- [ ] Item 6: vendored license entry; `vendored-licenses.test.ts` green.
- [ ] Item 8: `biome format --write` on the four files plus the two lint fixes; `lint:ci` clean.
- [ ] Item 7: apply the owner's decision.
- [ ] Item 9: apply a supported configuration or record the blocker and the owner's decision.
- [ ] Final: `test:coverage` green; `check:coverage-modules` runs; `knip`, `jscpd` and `typecheck` reported. Dependency audits stay omitted under the local owner policy. Update this record, move it to `tasks/done/` and index it.
