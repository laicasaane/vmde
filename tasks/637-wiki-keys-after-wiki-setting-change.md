# Task 637 — Refresh wiki page keys in open editors after a wiki setting change

**Status:** planned (2026-10-14). Implementation has not started.
**Origin:** Task 636 Part 1 (2026-10-14). The Project Owner approved filing it as a follow-up (chat, 2026-10-14).
**Severity:** low to medium (estimated). After changing a wiki setting, open editors show wrong missing-page styling and `[[` completion until they are reopened.
**Tech stack:** extension host wiki session and cache (`src/wiki/`), webview message router (`media-src/src/bridge/message-router.ts`), Vitest, Chromium, real VS Code.

## Problem

After `vmde.wiki.enabled` or `vmde.wiki.root` changes, an editor that is already open keeps the wiki page keys of the previous root. Wiki links then show the wrong missing/existing styling and `[[` completion offers the old root's pages, until the editor is closed and reopened.

## Current code and cause

- `onConfigChanged` in `src/wiki/wiki-session.ts` (about lines 30–36) calls `invalidateCache` (`src/wiki/wiki-cache.ts`, about line 203) for the old root and recomputes the context. Nothing rebuilds the cache for the new root and delivers its keys to the open webview.
- The webview `wiki-update` handler (`media-src/src/bridge/message-router.ts`, about line 1079) is fed only by watcher events.
- A configuration re-init in the same file (about lines 479–499) reuses the wiki keys stored in the last init message (`lastInitMsg.wiki`), so it keeps the stale keys.
- Separate, covered by Task 636: a build that finishes after `invalidateCache` is still stored (`src/wiki/wiki-cache.ts`, about lines 190–193). Task 636 fixes that with a per-root generation; it is not part of this task.

## Expected behaviour

- After a wiki setting change, open editors receive the keys for the new root through the deferred delivery path that Task 636 adds (`wiki-update` after a background build).
- Wiki chips re-style (existing pages unmarked, missing pages marked) with no edit, no dirty state and no Undo entry.
- `[[` completion shows the new root's pages.
- Disabling the wiki stops updates and leaves no stale missing styling.
- The stored init message is updated, so a later configuration re-init keeps the new keys.

## Dependencies

Builds on Task 636 (delivery path, keys-known flag, chip restyle helper). If the conditional persistent wiki page cache follow-up recorded in Task 636 triggers, combine the two, since both concern wiki-key freshness.

Combined with Task 638 (both concern wiki-key freshness; run together). See `638-persistent-wiki-page-cache.md`.

## Acceptance

- [ ] Changing `vmde.wiki.root` with an editor open delivers the new root's keys: chips and `[[` completion update, the host bytes are unchanged, the document is not dirty, and no Undo step is added.
- [ ] Disabling the wiki sends no update and leaves no missing styling; re-enabling delivers the keys.
- [ ] A configuration re-init after the change keeps the new keys.
- [ ] Focused tests written and run (see Tests); `npm run quality` passes.

## Tests

- Vitest: host delivery of keys on a wiki configuration change (root change, disable, re-enable, stored init message updated).
- Chromium (`media-src/e2e`): chip restyle on a `wiki-update` with no edit, dirty state or Undo entry.
- Real VS Code (`test/vscode-e2e/`): a focused spec that changes `vmde.wiki.root` with an editor open and checks chips, `[[` completion, source bytes, dirty state and Undo. Run `node build.mjs` first, then the spec under `xvfb-run`.

## Related

- Task 636 (delivery path, keys-known flag, chip restyle helper, per-root generation, conditional persistent wiki page cache follow-up).

## Part 1 handoff (2026-10-14)

Read-only review of the source; nothing was run. V = verified; I = inferred, Part 2 probes it. **Owner decision (2026-10-14): this task starts alone; Task 638 is not combined with it** (supersedes the "Combined with Task 638" line above).

- **Cause and entry points.** (1) V: the host config listener (`src/session/editor-session.ts`) calls `WikiSession.onConfigChanged` (`src/wiki/wiki-session.ts`) and then `postLiveConfig`; `onConfigChanged` bumps the generation, releases the watcher subscription, invalidates the old root's cache and recomputes the context, but nothing re-plans or delivers (`planInit`/`deliverPending` run only from `onReady`); `config-changed` carries options only (`wikiEnabled`, no root, no keys). (2) V: a root change does not re-initialise the webview (`wikiEnabled` unchanged), so the old known-page sets stay until reopen. (3) V: an enable/disable flip is init-only and re-inits from the stored init message with the old `pageKeys`; disabling is clean; re-enabling after an open with the wiki off leaves keys pending forever ("Loading pages…", chips never styled); re-enabling after a prior disable reuses stale keys. (4) V: after any wiki setting change the editor loses its watcher subscription for good (released, never re-subscribed), so create/delete events no longer reach it — the re-plan fixes this too. (5) V: the webview `wiki-update` handler already replaces the sets, marks keys known, updates the stored init message and restyles chips by attributes only; only the enable-flip re-init needs a webview change.
- **Contract.** C1: after a wiki config change, once the init has been posted, the host re-plans for the new context: a built cache posts `wiki-update` at once, otherwise `deliverPending` posts it after the build; never before the init; share the post and watcher callbacks with `onReady` (duplicate-code gate). C2: the `wiki-update` always follows `postLiveConfig`'s `config-changed`, so a flip re-init cannot overwrite fresher keys. C3: disabled (or no root): post nothing, cache invalidated, no subscription; re-enable delivers as C1. C4: invalidate the old root only when the effective root or the enabled state changed; an unchanged effective root keeps its cache and subscription and posts nothing (prevents one editor's invalidation killing another editor's fresh build on the same root). C5: a re-init caused by a `wikiEnabled` change builds the wiki object without `pageKeys`/`displayNames` (pending until the host's `wiki-update`); other init-only re-inits keep the keys. C6: a root change keeps the old styling until the new keys arrive; no new message type; the stale window equals the scan time (0 with a built cache). C7: a newer change supersedes a pending delivery (generation); a disposed session posts nothing; updates are attributes only (no edit, dirty state or Undo entry). C8 (watcher findings): (a) the watcher create path indexes files the search excludes (`src/wiki/wiki-cache.ts` `indexFile` without a filter — `node_modules` and `files.exclude` not applied); (b) the watcher glob `**/*.{md,markdown}` is case-sensitive while the search accepts `[mM][dD]` variants (`src/wiki/wiki.ts`) — fix with one shared page-glob constant exported from `wiki.ts` and an exclusion check on create; I: whether the watcher glob engine accepts the character classes, and the smallest exclusion check (a small in-process brace-aware matcher, or a per-event one-file search with the same exclude) — Part 2 picks the smaller one that passes the real-VS-Code case; a deleted folder emitting no per-file deletes is out of scope.
- **Part 2.** S1 RED: host Vitest in `test/backend/editor-session.test.ts` and `test/backend/wiki-session.test.ts` (root change posts exactly one `wiki-update` with the new keys after `config-changed` and after the init; built-cache path posts at once; disable posts nothing and invalidates; re-enable delivers; two quick changes deliver only the last root; a change before ready posts nothing; dispose before resolve posts nothing; unchanged effective root posts nothing and keeps the cache; the watcher callback works again after a config change); watcher units in `test/backend/wiki-cache.test.ts` (a created file under `node_modules` or a `files.exclude` glob adds no key; the watcher pattern covers an upper-case extension); Chromium in `media-src/e2e/wiki-deferred-keys.spec.ts` (a second `wiki-update` flips both chip states with no edit; `config-changed` enabling the wiki after a disabled open stays pending until a `wiki-update` and then styles chips and fills `[[`; stale keys not reused on re-enable). S2 GREEN: `src/session/editor-session.ts`, `src/wiki/wiki-session.ts`, `src/wiki/wiki-cache.ts`, `src/wiki/wiki.ts`, `media-src/src/bridge/message-router.ts` (C5); protocol unchanged. S3: real-VS-Code `test/vscode-e2e/wiki-keys-after-setting.spec.ts` (generated workspace: top-level pages, folders `alpha` and `gamma`, an upper-case-extension page, a document linking `home`, `alpha`, `gamma`, `no-such-page`; root `alpha` → empty → `gamma` via the configuration API, asserting chip states, `[[` lists via OS keys, host and file bytes unchanged, clean, Ctrl+Z changes nothing; second test: disabled → enabled → disabled → re-enabled; third: after a root change, create a page and an `.MD` page on disk → keys arrive, a page under an excluded folder adds none). S4: closure.
- **Edge cases.** Multi-editor on one root (C4; test it); settings UI typing partial root paths (generation drops stale deliveries; a missing root gives empty keys, every chip missing — correct); `files.exclude` changes do not refresh keys (out of scope); an open `[[` hint with real rows re-queries on the next key; a change before the first ready posts nothing.
- **Decisions (provisional, reversible).** (1) Keep the old chip styling during a root change until the new keys arrive (no new protocol) — adopted. (2) Record wording superseded by the Owner's "start alone" decision — done above. (3) A document outside any workspace folder: the host wiki context is disabled while the `wikiEnabled` option follows the setting, so an enable flip re-inits as enabled with no keys delivered (pending forever) — pre-existing; recorded as a known limitation, not fixed here — adopted.

## Execution progress — 2026-10-14 (S1)

S1 RED done: failing tests written for the Part 1 contract; no product code changed.

- Host Vitest, `test/backend/editor-session.test.ts` (new block "wiki keys after a wiki setting change"): root change posts one `wiki-update` after `config-changed` and the init; built-cache path posts at once without a new scan; disable posts nothing and invalidates; re-enable delivers; two quick changes deliver only the last root; change before ready posts nothing; dispose before resolve posts nothing; unchanged effective root posts nothing and keeps the cache; the watcher callback works after a config change.
- Host Vitest, `test/backend/wiki-session.test.ts` (new block "config change invalidation"): unchanged root keeps the cache and the watcher subscription (also with a second session on the same root); root change invalidates only the old root; disable invalidates.
- Watcher Vitest, `test/backend/wiki-cache.test.ts`: created file under `node_modules` or a `files.exclude` glob adds no key; watcher pattern covers upper-case extensions.
- Chromium, `media-src/e2e/wiki-deferred-keys.spec.ts` (R14-R16): second `wiki-update` flips both chip states with no edit; enabling after a disabled open stays pending until a `wiki-update`; stale `pageKeys` are not reused on re-enable.

Results on the unchanged product code:
- editor-session: 6 failed (root change, built-cache at once, re-enable, two quick changes, unchanged root keeps cache, watcher callback after change), 80 passed. Controls passing: disable, change before ready, dispose before resolve.
- wiki-session: 3 failed (unchanged root keeps cache, keeps subscription, second session keeps cache), 9 passed.
- wiki-cache: 3 failed (node_modules, `files.exclude`, upper-case pattern), 31 passed.
- Chromium spec: 11 passed, 1 failed (R16, stale keys reused on re-enable). R14 and R15 pass already (the webview already handles them); they guard the contract.
- `npm run typecheck`, `tsc --noEmit -p ./`, and biome check pass.

Not done: Part 2 S2 (green), S3 (real VS Code), S4.

## Execution progress — 2026-10-14 (S2)

S2 GREEN done: the Part 1 contract (C1–C8) is implemented; the S1 tests were not edited. Protocol unchanged.

- `src/wiki/wiki-session.ts`: `onConfigChanged` returns whether the caller must re-plan. It invalidates the old root and drops the watcher subscription only when the effective root (or the enabled state) changed (C4); an unchanged root keeps its cache and subscription. Every change still supersedes the generation, so a delivery pending at that moment is dropped; a `deliveryPending` flag makes `onConfigChanged` ask for a re-plan in that case (the scan is shared, so no second scan starts). This keeps the Task 636 case "a config change after the plan drops its pending delivery" green. `keysOf` and `WikiKeys` are exported for the host session.
- `src/session/editor-session.ts`: `planWikiKeys`, `postWikiUpdate` and `deliverWikiPlan` are shared by `onReady` and the new `refreshWikiKeys`. The configuration listener calls `refreshWikiKeys` right after `postLiveConfig`, so the `wiki-update` always follows `config-changed` (C2). It posts nothing before the init (`panelEntry.ready`), a built cache posts at once, a disabled wiki posts nothing (C3), and a stale or disposed plan posts nothing (C7).
- `src/wiki/wiki.ts`, `src/wiki/wiki-cache.ts` (C8): one exported page glob (`WikiPageGlob`) is used by both the search and the watcher, so the watcher covers upper-case extensions. A small in-process glob matcher (`isWikiPageExcluded`, brace-aware, path prefixes tested so an excluded folder excludes its files; a glob that does not compile, such as an unclosed `{`, matches nothing so a bad setting cannot break the watcher) lets the create path skip files under `node_modules` or a `files.exclude` glob without an async round trip; the exclude glob list is shared with the search.
- `media-src/src/bridge/message-router.ts` (C5): a configuration re-init caused by a `wikiEnabled` change builds the wiki object without `pageKeys`/`displayNames` (pending until the host's `wiki-update`); other init-only re-inits keep the stored keys.

Results:
- `npx vitest run --config test/vitest.config.mts test/backend`: 106 files passed, 2567 tests passed, 1 expected fail (the pre-existing `it.fails` for the code-formatted reference label, Task 572, in `test/backend/reference-source-lute.test.ts`).
- Chromium `wiki-deferred-keys.spec.ts`: 12 passed (R16 now passes); `wiki-*.spec.ts`: 50 passed, 4 skipped.
- `npm run typecheck`, `npx biome check` on the touched files: clean.

Open items and risks:
- The watcher pattern's `[mM]` character classes are verified only by text (the Vitest pattern test); whether the real VS Code watcher engine accepts them is left to S3.
- A wiki setting change that arrives between the init post's start and `panelEntry.ready` is not re-planned (the init payload carries the context read before the change); not covered by a test.
- A root change invalidates the old root's shared cache; an editor still on that old root (a different resource-scoped setting) is not re-planned and would keep a cache without a live watcher.

Not done: S3 (real VS Code), S4.
