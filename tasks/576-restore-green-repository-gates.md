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

## Checklist

- [ ] Part 1: inspect each item's source and record the intended fix and any owner question here (items 7 and 9 at minimum).
- [ ] Items 1–3: manifest entries and edge decisions; `module-boundaries.test.ts` 7/7.
- [ ] Item 4: probe tag or exception with rationale; `probe-tier-convention.test.ts` green.
- [ ] Item 5: setting order; `manifest.test.ts` green.
- [ ] Item 6: vendored license entry; `vendored-licenses.test.ts` green.
- [ ] Item 8: `biome format --write` on the four files plus the two lint fixes; `lint:ci` clean.
- [ ] Item 7: apply the owner's decision.
- [ ] Item 9: apply a supported configuration or record the blocker and the owner's decision.
- [ ] Final: `test:coverage` green; `check:coverage-modules` runs; `knip`, `jscpd` and `typecheck` reported. Dependency audits stay omitted under the local owner policy. Update this record, move it to `tasks/done/` and index it.
