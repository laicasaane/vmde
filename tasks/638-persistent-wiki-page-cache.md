# Task 638 — Persistent wiki page cache (stale-while-revalidate)

**Status:** planned (2026-10-14). Implementation has not started.
**Origin:** Task 636 conditional follow-up "persistent wiki page cache". The trigger fired in Task 636 S2: the time from `init` to `wiki-update` had a median of about 2.9 s (range 1.8–3.8 s) over 8 cold real-profile runs, above the 1–2 s trigger. Filed per the Project Owner decision of 2026-10-14.
**Severity:** low. The open itself already meets the Task 636 target; this shortens the "Loading pages…" window and the first-open key delay after a restart.
**Tech stack:** extension host wiki cache and session (`src/wiki/`), local workspace state, webview message router (`media-src/src/bridge/message-router.ts`), Vitest, Chromium, real VS Code.

## Problem

Every first wiki-file open after a window starts waits for a full page scan. Task 636 posts `init` without waiting and delivers the keys by a later `wiki-update`, but that arrival still takes about 2.9 s (median) on the real profile. During that time wiki chips carry no missing styling and `[[` completion shows the non-insertable "Loading pages…" row.

## Current code

- One in-memory cache per wiki root (`src/wiki/wiki-cache.ts`), kept current by a file watcher.
- A full scan runs once per extension-host lifetime and after a wiki setting change (`src/wiki/wiki-session.ts`, `onConfigChanged`), so every first open after a window starts pays the scan.
- Task 636 delivers the keys by `wiki-update` after a background build; warm reopens already carry the keys in `init`.

## Proposal

Stale-while-revalidate:

- Store the page list per wiki root in local workspace state.
- On the first open after a restart, send the stored keys in `init` at once.
- Revalidate in the background with the search from Task 636; if anything changed, post `wiki-update` through Task 636's delivery path and store the new list.
- Storage key per root, with a schema version and a size limit. Invalidate the stored list on a wiki root change or when the wiki is disabled.

Costs: brief stale chip state for pages changed while the editor was closed; one storage key per root; tests for the stale-to-fresh transition.

## Acceptance

- [ ] First open after a restart sends the stored keys in `init`; there is no pending-keys state when a stored list exists.
- [ ] Background revalidation posts `wiki-update` only when the list changed, and stores the new list.
- [ ] Pages changed while closed (added, removed, renamed) are corrected after revalidation: chips restyle with no edit, no dirty state and no Undo entry.
- [ ] A wiki root change or disabling the wiki invalidates the stored list.
- [ ] Storage is bounded: size limit and schema version; an unreadable or old-schema entry is ignored.
- [ ] A real-profile re-run shows the keys at `init` on a restart (cold open after a prior session).
- [ ] Focused tests written and run (see Tests); `npm run quality` passes.

## Tests

- Vitest: storage read/write, schema version, size limit, invalidation, stale-to-fresh transition.
- Chromium (`media-src/e2e`): a stale chip is corrected after `wiki-update`.
- Real VS Code (`test/vscode-e2e/`): a focused spec for a restart with a stored list. Run `node build.mjs` first, then the spec under `xvfb-run`.
- Real-profile measurement of the `init` to keys time after a restart.

## Dependencies

Builds on Task 636 (delivery path, keys-known flag, chip restyle helper, per-root generation). Combined with Task 637 (both concern wiki-key freshness; run together, same files).

## Related

- Task 636 (conditional follow-up "persistent wiki page cache"; S2 measurement).
- Task 637 (wiki keys after a wiki setting change).

## Part 1 handoff (2026-10-14)

Read-only review of the source on `dev` (Tasks 636 and 637 are in the tree); nothing was run. V = verified by reading (file:line); I = inferred, Part 2 probes it. **Owner decision (2026-10-14): green light for Task 638.**

### What exists today (V)

- **Cache.** One `WikiCache` per wiki root in a module map (`src/wiki/wiki-cache.ts:181`, `cacheByRoot`), built by `startBuild` (`:197-227`) and kept current by a file watcher whose create/delete events notify a debounced listener set (`:154-175`, 50 ms at `:11`). A build whose entry in `buildingByRoot` was removed or replaced is stale and is never stored (`:206-213`). `invalidateCache` disposes the cache and cancels the build (`:266-274`); `disposeAllCaches` runs on deactivation (`src/app/extension.ts:58`).
- **Plan and delivery.** `WikiSession.planInit` (`src/wiki/wiki-session.ts:98-120`) returns the built keys in the payload when `peekBuiltCache` has them (`:108-112`), otherwise a payload without keys plus `pending` (the shared build, `:113-119`). `deliverPending` (`:126-136`) posts the keys once the build resolves, unless the session is disposed or the generation moved on. `onConfigChanged` (`:70-83`) bumps the generation and invalidates the old root only when the effective root changed (Task 637 C4).
- **Host session.** `EditorSession.onReady` posts `init` with `wiki: wikiPlan.payload` (`src/session/editor-session.ts:321,330`) and then `deliverWikiPlan` (`:342`). `refreshWikiKeys` (`:367-374`) posts a `wiki-update` at once when the plan payload already has keys, then delivers the pending build. Files that are wiki files never use the inline init (`:404`), so the `postMessage` init is the only path that needs keys.
- **Webview.** `init` with `wiki.pageKeys` sets `wikiKeysKnown = true` and fills the sets (`media-src/src/boot/vditor-init.ts:449-460`); without them it stays pending. `wiki-update` replaces the sets, keeps the stored init message current and restyles chips by attributes only (`media-src/src/bridge/message-router.ts:1099-1126`, helper in `media-src/src/links/wiki-keys.ts`). Message types are in `src/shared/protocol.ts:168-170,364`. **No webview or protocol change is needed**: a stale list in `init` followed by a different `wiki-update` already works, and Chromium R14 (`media-src/e2e/wiki-deferred-keys.spec.ts:265`) proves that a second `wiki-update` with a different set flips both chip states with no edit.
- **Storage precedent.** `workspaceState` is already used per document for fold state (`editor-session.ts:269-277`, key `vmde.foldState:<uri>`) and as a bounded list for reading positions (`src/session/reading-position-store.ts:3-4`, limit 50). The Vitest mock context has `workspaceState.get/update` only, no `keys()` (`test/backend/vscode-mock.ts:951-956`). `workspaceState` is never part of Settings Sync (`setKeysForSync` lists globalState keys only, `src/app/extension.ts:182`).

### Design

**Invariant.** The stored list is a hint, never the authority: it mirrors the last state of the live per-root cache, is removed when that cache is invalidated, and is always revalidated by the existing background build. Correctness comes from revalidation; invalidation only keeps the store tidy.

#### 1. Where the list lives, schema, bound (acceptance 5)

- New module `src/wiki/wiki-key-store.ts` (module `wiki`; `scripts/module-manifest.mjs:115` needs the id `wiki-key-store` in the `wiki` ids list, a structural-source-of-truth update inside an existing module; the edges `app->wiki`, `session->wiki` already exist in `test/backend/module-boundaries.test.ts:215-236`). It holds a module-level store configured once from `activate` with `context.workspaceState` (next to `disposeAllCaches`, `extension.ts:58`) and a no-op default, so every existing test that constructs `WikiSession` or the cache without a store keeps its behaviour.
- One workspace-state key per wiki root: `vmde.wikiPages:<root uri string>`, the same naming style as `foldStateKey`. A workspace has its own state database, so the list is per workspace and per root.
- Value, schema version 1:
  - `version: 1`
  - `root`: the root uri string (must equal the root asked for; guards a key collision)
  - `savedAt`: epoch milliseconds (eviction order and diagnostics only; no expiry, because a very old list is still corrected by revalidation)
  - `pageKeys`: string array, as `WikiCache.allPageKeys()` returns it (sorted, `wiki-cache.ts:53-58`)
  - `displayNames`: string array, as `allDisplayNames()` returns it (sorted, `:65-89`)
  - There is no stored size field: size is counted from the strings at write time and recounted at read time, so a hand-edited value cannot claim to be small.
- **Bounds (provisional numbers, reversible).** Per list: at most 20,000 entries in each array and at most 512 KiB of UTF-8 string bytes in total. Roots: at most 4 stored lists per workspace. Reason for the byte cap: the whole workspace memento is loaded into the extension host at activation, so the stored value must stay small (rough size: each page adds up to two keys plus one display name, about 100 bytes per page, so 512 KiB is about 5,000 pages; a real count is measured in S5).
  - A list over either cap is not stored, and an existing entry for that root is deleted (so an oversize vault never serves an old small list).
  - An empty list is not stored and deletes the entry (an empty result may be a failed search, which `collectWikiMarkdownFiles` reports as no pages, `src/wiki/wiki.ts:221-223`; serving "no pages" at the next start would mark every chip missing).
  - Over the root cap on a write: delete the entry with the oldest `savedAt` among keys with the `vmde.wikiPages:` prefix. The pruning uses `Memento.keys()` (available at the declared engine, `package.json` `engines.vscode` `^1.110.0`) once per extension-host lifetime, guarded so a context without `keys()` skips pruning.
- **Unreadable, old-schema or oversize entry is ignored (acceptance 5).** `readStoredKeys(root)` returns `undefined` unless the value is an object with `version === 1`, `root` equal to the asked root, a finite `savedAt`, two arrays of non-empty strings within both caps. It never throws and never repairs: the planner then takes today's pending path (no keys in `init`, `wiki-update` after the build), and the next successful build overwrites the entry. A future version 2 is likewise ignored by version 1 code.

#### 2. Init path (acceptance 1, 2, 3)

- `planInit` order for an enabled wiki root: (1) built cache, as today; (2) otherwise a valid stored list: payload `{ ...context, pageKeys, displayNames }` from the store, `pending` = the shared build as today, and a new internal `served` field holding the stored keys; (3) otherwise today's pending plan. `wikiKeysKnown` is therefore true from the first render in cases 1 and 2: there is no pending-keys state when a stored list exists (acceptance 1). A build already in flight (started by another editor) is treated like case 2.
- `deliverPending` gains one rule: after the awaited build, when the plan has `served`, post the fresh keys only if either array differs from `served` (element-wise; both arrays count, because two pages with the same basename change the display names without changing the keys). Otherwise post nothing. The watcher subscription still starts either way. Editor session code stays as it is: `onReady` and `refreshWikiKeys` already pass the payload through and hand the plan to `deliverWikiPlan`.
- **Storing the new list (acceptance 2) is done by the cache, not the session**: see section 4. A changed list therefore reaches the webview (`wiki-update`) and the store by the same build result.
- **Chips restyle with no edit, dirty state or Undo change (acceptance 3):** the existing `wiki-update` handler restyles by attribute only (`wiki-keys.ts` `refreshWikiChips`); already shown by Chromium R14 and by the real-VS-Code spec `test/vscode-e2e/wiki-deferred-keys.spec.ts` for the pending case. The new real-VS-Code spec repeats the byte, dirty and Ctrl+Z checks for the stale-to-fresh case.
- Revalidation cost is unchanged: the one background search of Task 636. It runs once per extension-host lifetime per root, because a built cache is kept current by the watcher; a later open in the same lifetime takes case 1.

#### 3. Invalidation (acceptance 4)

- `invalidateCache(root)` (`wiki-cache.ts:266-274`) also deletes the stored entry for that root. It is called only from `onConfigChanged` when the effective root or enabled state changed (`wiki-session.ts:75-79`), so a root change clears the old root's list and disabling the wiki clears the list of the root that was in use. `disposeAllCaches` (deactivation) does not clear the store (it is what survives the restart).
- Best effort only: a setting changed while no editor is open, or while VS Code is closed, leaves the old entry in place (nothing remembers the old root). That entry is never read while the wiki is disabled or the root differs, is bounded by the root cap, and if the setting later points back at that root the entry serves as a stale hint that revalidation corrects.
- Watcher create/delete: the store is **updated, not marked stale**. The cache is authoritative and already holds the new keys, so a debounced write of the current lists is simpler than a stale flag and gives the next start the freshest hint. Writes are debounced (provisional 2 s trailing) so a burst (for example a branch switch touching hundreds of files) rewrites the value once. The timer lives in the cache object and is cleared by `WikiCache.dispose()` (`:105-109`); at fire time the write happens only if that cache is still the stored one for its root, so a pending write can never recreate an entry that `invalidateCache` just cleared. A burst still pending when the extension host shuts down is lost; the stale hint is then corrected at the next start (accepted).
- Not persisted: a result from a stale build. The write sits in the non-stale branch of `startBuild` right after `cacheByRoot.set` (`:214`), so a build invalidated while it scanned (the stale branch at `:206-213`, whose cancelled search returns an empty list) never reaches the store.

#### 4. Sharing, races, privacy

- **Multi-editor sharing (Task 637 C4).** One cache and one store entry per root. Persistence is attached to the cache (the first write when its build succeeds, later writes from a cache-internal change listener), not to sessions, so N editors on one root cause one write per change, and closing an editor mid-scan does not lose the write. Each session keeps its own `served` baseline, so each editor decides on its own whether a `wiki-update` is needed. An editor that opens while another editor's build is in flight serves the same stored hint and receives the same result. Invalidation by one editor still clears the shared entry (pre-existing 637 limitation for a second editor on the old root; it only costs that root its hint).
- **Dispose during revalidation.** `deliverPending` already returns before posting for a disposed session or a moved generation (`wiki-session.ts:132`), so nothing is posted. The shared build keeps running and stores its result at cache level, so the next open starts fresh.
- **Config change mid-flight.** The generation check drops the old delivery; `invalidateCache` cancels the build and clears the entry; the stale build is not stored (above); `onConfigChanged` asks for a re-plan when a delivery was pending (`:73,82`), which reads the stored list of the new root (if it has one, the re-plan posts it at once through `refreshWikiKeys` and then revalidates).
- **Failure.** `Memento.update` rejections are caught and logged as a generic line with no root, key or file name; a failed write leaves the previous entry in place; reads never throw.
- **Privacy.** Page keys and display names are file names inside the user's workspace. They are written only to the extension's workspace state (local, per workspace, never synced), are never logged and never put into telemetry or error text. Tests and the record use synthetic page names only. The real-profile run (S5) keeps raw data under the ignored `tmp/638/` and publishes only counts and times.

### Part 2 plan with acceptance mapping

Every Vitest expectation below comes from the task contract, not from the code under test.

- **S1 RED (host Vitest; failing first, shown in the report).**
  - `test/backend/wiki-key-store.test.ts` (new): write then read round trip with the exact schema (acceptance 5); old and unknown version, root mismatch, non-object, wrong element types, non-finite `savedAt`, entry-count overflow and byte overflow are ignored (acceptance 5); an oversize or empty list is not stored and deletes the entry; a third and fifth root evicts the oldest; a rejecting `update` neither throws nor logs a key or path; an unconfigured store is a no-op. Edge: non-ASCII page names counted in bytes, not characters.
  - `test/backend/wiki-cache.test.ts`: a successful build stores sorted keys and names (acceptance 2); watcher create and delete update the stored list after the debounce (fake timers; acceptance 3 data); `invalidateCache` deletes the entry (acceptance 4); a build invalidated while scanning stores nothing; a write pending at invalidation does not recreate the entry (race); `disposeAllCaches` keeps the entry (restart survives); an empty search result deletes the entry.
  - `test/backend/wiki-session.test.ts`: stored list and no built cache: `plan.payload` carries the stored keys and names, `pending` is defined (acceptance 1); `deliverPending` posts nothing when the scan equals the stored list and posts once when it differs, with three cases: page added, page removed, page renamed (acceptance 2, 3); only the display names differing still posts (same basename in two folders); a built cache wins over the stored list; unreadable, old-schema and oversize values give a payload without keys (acceptance 5); disabled wiki reads nothing; a root change deletes the old root's entry and a disable deletes the entry (acceptance 4); an unchanged root keeps it (C4); two sessions on one root cause one write.
  - `test/backend/editor-session.test.ts` (existing block style, restart simulated by `_resetCacheMap()` plus a pre-filled `workspaceState`): the posted `init` has `wiki.pageKeys` equal to the stored list and no earlier `wiki-update` (acceptance 1); no `wiki-update` when the scan equals it; exactly one `wiki-update` after the `init` when it differs, and `workspaceState` then holds the new list (acceptance 2); dispose before the build resolves posts nothing (race); a root change whose new root has a stored list posts it at once and revalidates.
  - Specs that import files in the diff (find with `git diff --name-only` and grep in `test/`, `media-src/e2e/`, `test/vscode-e2e/`): expected `test/backend/extension.test.ts` family only if it asserts the activation wiring, plus the existing wiki Vitest files above; no neighbour reruns.
- **S2 GREEN.** `src/wiki/wiki-key-store.ts` (new), `src/wiki/wiki-cache.ts` (persist hook in the non-stale branch of `startBuild`, cache-internal debounced writer, clear in `invalidateCache`), `src/wiki/wiki-session.ts` (stored read in `planInit`, `served` baseline, compare in `deliverPending`), `src/app/extension.ts` (configure the store with `context.workspaceState`), `scripts/module-manifest.mjs` (new id). Unchanged: `editor-session.ts`, protocol, webview. Checks: the Vitest files above, `npm run typecheck`, lint of the changed files, knip (new exports must be used), jscpd.
- **S3 Chromium: not planned.** The webview and protocol do not change, and R14 already covers the stale-to-fresh chip transition; adding a spec would prove nothing new. Add one only if S2 ends up touching the webview.
- **S4 real-VS-Code spec** `test/vscode-e2e/wiki-persistent-keys.spec.ts` (new; `node build.mjs` first, one invocation under `xvfb-run`, `--workers=1 --retries=0`). A restart is a second VS Code launch on the same user-data directory: the harness keeps one `--user-data-dir` per worker across tests (`test/vscode-e2e/node_modules/vscode-test-playwright/dist/index.js:109,121,167`; noted in `test/vscode-e2e/default-open-mode.spec.ts:17-20`), and workspace state is keyed by the workspace folder, so both launches must open the same folder. Plan: a serial pair of `test()` blocks; the `baseDir` override (precedent: `wiki-deferred-keys.spec.ts:96-108`) returns one shared folder; the second launch's override changes the pages on disk before VS Code opens (add one page, remove one, rename one), which models "changed while the editor was closed". Extension id from the shared `ExtensionId` constant in `test/vscode-e2e/webview-helpers.ts`, passed through `evaluateInVSCode`. The probe that records host messages in order (pattern from `wiki-deferred-keys.spec.ts`) is reused.
  - Test 1 (first launch): open the document, wait for the `wiki-update` (no stored list yet: `init` has no keys; unchanged Task 636 path), then close the editor. Proves the entry gets written (first write, acceptance 2) by the next launch finding it.
  - Test 2 (restart): the `init` carries the page keys (count above zero) and no chip is pending (acceptance 1; chips first styled from the stored list, so the removed page's chip is not yet marked missing and the added page's chip is); then exactly one `wiki-update` with the changed keys (acceptance 2); chips then show the added, removed and renamed pages correctly (acceptance 3); host text and file bytes unchanged, document clean, OS-level Ctrl+Z (trusted keydown recorded) changes nothing (acceptance 3). A second restart with no disk change in the same block is not added (one extra launch); "no `wiki-update` when unchanged" is covered by Vitest at the cheaper layer.
  - Edge cases per step: the stored entry is read only after the first launch had time to flush workspace state (I: the harness `electronApp.close()` must shut down gracefully; if the entry is missing at the second launch, probe whether the flush happens only on graceful quit and close the window through a command before the fixture teardown; fallback: a window reload keeps the main-process state and restarts only the extension host, weaker than a second launch but it does exercise an empty in-memory cache); a disabled wiki posts no keys even with an entry on disk (cheap Vitest case, not a launch); a root change deleting the entry is Vitest only.
- **S5 real-profile re-run (acceptance 6).** Follow the Task 636 rules (`tasks/done/636-slow-open-real-profile.md:20-24`, Owner approvals at `:49-54`): the Owner's profile stays read-only except for what the editor itself writes; comparison runs by launch flags only; raw data under `tmp/638/`; nothing sent to an external service; windows closed by the Owner for each batch. Procedure on the development build with the fix: one warm-up session that opens the wiki file (writes the entry), close, then 5 cold Explorer-click opens recording whether `init` carries the keys and the time from the click to chips styled; compare with the 636 numbers (keys at `wiki-update` median about 2.9 s, range 1.8-3.8 s over 8 cold runs). Pass: `init` carries the keys on every cold run after the warm-up; the time from `init` to correct chips is not above the `init` time itself (revalidation posts nothing when the list is unchanged); also record the stored value size (bytes, page count) to check the bound against a real workspace. Record only redacted numbers.
- **S6 closure.** Batched-closure rule: full network-free gates once on combined HEAD, `npm run quality`, acceptance checklist and Status updated in this record, `tasks/README.md` only when fully complete, privacy search of the record and diff (absolute paths, user or machine names, profile contents).

### Edge cases (Part 2 names the test that proves each)

- Stored keys with a page that no longer exists: chip not marked missing until `wiki-update`, then marked (S1, S4). A page added while closed: marked missing until the update, then unmarked.
- `[[` completion during the stale window offers stale names; an already open hint is not re-queried by the update (existing Task 637 note); a stale choice resolves to a missing chip at worst. Accepted, not tested.
- Two documents in one root, or a second editor opened during the scan: both serve the stored hint and both receive the same single update (S1 session tests).
- A very large workspace, or a root with a huge list: over the cap, nothing stored, behaviour equals Task 636 (S1).
- Stored entry with a different root at the same key, or hand-edited: ignored (S1).
- Extension upgrade that changes the schema: version mismatch is ignored and overwritten (S1).
- Failed or cancelled search giving an empty list: never stored and clears the entry (S1).
- A wiki setting change while a stored hint was served and revalidation is pending: the generation drops the old delivery; the re-plan reads the new root's entry (S1).
- Workspace state shared by several windows: not applicable (a workspace opens in one window; each workspace has its own database).

### Decisions

Provisional (reversible, adopted):

1. Persistence lives in the cache layer (module-level store configured in `activate`), not in the editor session, so there is one write per root change regardless of the number of editors.
2. Watcher events update the stored list (debounced, 2 s) instead of marking it stale.
3. Bounds: 20,000 entries per array, 512 KiB per list, 4 roots per workspace; an oversize or empty list is not stored and clears the entry.
4. No expiry by age; `savedAt` only orders eviction.
5. No stored size field; size is recounted at read and write.
6. No webview or protocol change; no Chromium spec unless S2 touches the webview.
7. Revalidation posts `wiki-update` only when keys or display names differ from what `init` carried; no extra "fresh" signal to the webview.

For the Owner:

1. **Real profile (S5).** The feature itself writes one new workspace-state entry in the Owner's profile (the extension's own state, like the fold and reading-position state). Task 636's real-profile constraints said not to change extension state beyond what opening the folder and file does. Please confirm that the entry written by this feature is allowed, and that the 636 approvals (state-database backup before scripted runs, debugger-protocol launch flags, the Owner closing the editor windows per batch) apply to this task.
2. The bound numbers (decision 3) are estimates; S5 measures the real page count and stored size, and the numbers can be revised then without a design change.

Not done: Part 2 (S1-S6). Task 637 is not closed (its S4 is open); this task depends only on the code that is already on `dev`.

## Execution progress — 2026-10-14 (S1+S2)

**Scope:** S1 (failing tests first) and S2 (host implementation) in one step. No webview, protocol or `editor-session.ts` change. Acceptance items stay unchecked: they need the S4 real-VS-Code spec (restart, chip restyle, no dirty state, no Undo entry) and the S5 real-profile run; this step proves the host-side data flow in Vitest only.

**RED (before any implementation).** The new tests were run against a no-op stub of `src/wiki/wiki-key-store.ts` (same exports, no behaviour): 39 failed, 171 passed across the four files. The tests that passed against the stub are the ones whose expected result is "nothing stored, nothing served" (ignored entries, built cache wins, disabled wiki, today's pending path).

**GREEN.** The same four files: 210 passed, 0 failed.

**Files**
- `src/wiki/wiki-key-store.ts` (new): module-level store configured once with the workspace state and a log function (the host log cannot be imported here because `platform` already imports `wiki`). One entry per root at `vmde.wikiPages:<root uri>`, schema version 1 (`version`, `root`, `savedAt`, `pageKeys`, `displayNames`). Bounds as decided: 20,000 entries per array, 512 KiB of UTF-8 string bytes per list, 4 stored roots per workspace; counted at write and again at read. An empty or over-bound list is not stored and deletes the entry. The oldest `savedAt` is evicted when a fifth root is written; the key set is read from `keys()` once per lifetime and skipped when the memento has no `keys()`. Read never throws; a rejected or throwing write logs one generic line with no root, key or error text.
- `src/wiki/wiki-cache.ts`: a non-stale build calls `startPersisting()` (first write); later watcher create/delete events rewrite the list on a 2 s trailing debounce, only while that cache is still the stored one for its root; `dispose()` clears the timer; `invalidateCache` clears the entry; `disposeAllCaches` does not.
- `src/wiki/wiki-session.ts`: `planInit` serves a valid stored list in the payload (with `served`) when no cache is built, still handing out the shared pending build; `deliverPending` posts the scanned keys only when keys or display names differ from `served`.
- `src/app/extension.ts`: `configureWikiKeyStore(context.workspaceState, debug)` in `activate`.
- `scripts/module-manifest.mjs`: id `wiki-key-store` added to the `wiki` module.
- Tests: `test/backend/wiki-key-store.test.ts` (new), plus new describes in `wiki-cache.test.ts`, `wiki-session.test.ts`, `editor-session.test.ts`.

**Test-to-contract map**
- A1 (stored keys in `init`, nothing pending): session plan test, editor-session `init` test while the scan is held.
- A2 (`wiki-update` only on a difference, new list stored; stale or cancelled builds never store): session and editor-session tests for equal and differing scans; cache tests for a build invalidated while scanning (also over an older entry).
- A3 (added, removed, renamed pages, host side): three session cases, plus a display-names-only difference (same basename in two folders).
- A4 (root change and disable clear the entry; `disposeAllCaches` keeps it): cache, session and editor-session tests, plus a test that `activate` wires the store and deactivation keeps the entry.
- A5 (bounds, schema version, unreadable, old, wrong-root, oversize ignored): key-store tests (table of ignored values, exact boundaries at 20,000 entries and 512 KiB, UTF-8 byte counting, root cap and eviction order, missing `keys()`), and session tests that an ignored value gives today's init.
- Edge cases from the Part 1 list: watcher burst writes once; a pending write never recreates a just-cleared entry; two sessions on one root share one scan and cause one write; dispose during revalidation posts nothing and the shared build still stores; a config change mid-flight drops the old delivery and stores nothing from the superseded build; a root change serves the new root's stored list at once and then revalidates; an empty search result deletes the entry; no page key, display name or path in log lines.
- Part 1 wording difference: the S1 list says "a third and fifth root evicts the oldest"; with the decided cap of 4 stored roots a third and a fourth root must evict nothing and the fifth evicts the oldest, which is what the tests assert.

**Checks run (worktree root)**
- `npx vitest run --config test/vitest.config.mts` on the four files above: 210 passed.
- Same command on every Vitest file importing a changed module (asset-link-actions, commands-and-handlers, custom-css, dispose, editor-session, extension, font-size, i18n-lang, image-upload, manifest, module-boundaries, open-link, status-bar, webview-html, webview-overlay, wiki-cache, wiki-key-store, wikilink-handler, wiki-perf, wiki-session): 19 files passed, 1 skipped (the webview-html overlay suite skips loudly because the Lute build output is absent in this worktree; unrelated to this change), 564 tests passed, 4 skipped.
- `npx tsc --noEmit -p ./` (host): exit 0. `npm run typecheck` (webview): exit 0.
- `npx biome ci` on the changed source, test and script files: exit 0.
- `npm run knip`: exit 0, no findings. `npm run depcruise`: exit 0, no dependency violations (the tool prints its usual note about the installed TypeScript version).

**Not run / open**
- Chromium and real-VS-Code specs (S3 not planned; S4 is the next step and needs the real-VS-Code token); jscpd and the full `npm run quality` (batched closure, S6).
- Real-profile measurement (S5) and the stored-size check against a real workspace; the bound numbers remain provisional.
- The test files are outside the host `tsc` project, so they are checked by Vitest and Biome only.

## Execution progress — 2026-10-14 (S4)

**Scope:** the focused real-VS-Code spec `test/vscode-e2e/wiki-persistent-keys.spec.ts` (one test case, four launches). No product change in this step. S5 (real profile) stays open: moved after the session pause by the Owner, not run.

**Finding that changed the plan.** The Part 1 plan modelled a restart as a second harness launch on the same user-data directory. It cannot work: the harness starts VS Code with `--extensionTestsPath`, and VS Code then keeps workspace storage in memory only (its storage service sets `useInMemoryStorage` when an extension-tests location is given). Observed: after the first launch closed, the workspace storage folder held only `meta.json`, never a `state.vscdb`, also after a graceful window close, and a second launch's `init` carried no keys. The Part 1 fallbacks do not work in this harness either: `Restart Extension Host` leaves the extension host process alive (same process id for 16 s after the command), and `Reload Window` ends the application (the window closes and no new window appears).

**Design used.** The spec does not use the harness's `electronApp` fixture. It launches the installed VS Code itself with the same arguments as the harness except `--extensionTestsPath`, plus `--extensionDevelopmentPath`, on the harness's user-data directory and one shared workspace folder, four times. This is a real process restart with the on-disk workspace state. The harness's `evaluateInVSCode` channel does not exist there, so the spec drives the UI (Quick Open), the file system (pages, the workspace settings file) and the webview. Pages and settings change while VS Code is closed. The same probe as the sibling wiki specs records host messages in order; for the launches that need the state before the `wiki-update`, the probe records the update and holds it back from the editor until the test releases it (in the harness the scan finishes before the editor draws its first chip, so that window is otherwise not observable).

**Assertions**
- Launch 1 (no stored list): `init` has no keys; one `wiki-update` with the page keys; chips follow the pages. The list is stored (proved by launch 2).
- Launch 2 (pages added, removed and renamed while closed): `init` carries exactly the list stored by launch 1 (acceptance 1); with the update held, chips are styled from that stored list; exactly one `wiki-update` after `init` carries the new keys (acceptance 2); after release, chips show the added, removed and renamed pages correctly (acceptance 3); file bytes unchanged, no dirty tab, OS-level (XTEST) Ctrl+Z reached the webview as a trusted key and changed nothing (acceptance 3).
- Launch 3 (pages unchanged): `init` carries the stored keys, chips follow them, no `wiki-update` in a 3 s observation window (acceptance 2). Disabling the wiki in the settings file removes the wiki chips (the config change was handled).
- Launch 4 (wiki enabled again while closed): `init` has no keys (the list was cleared; acceptance 4), chips are unstyled before the held update, then follow the pages after it.
- Acceptance 5 (bounds, schema) stays at the Vitest layer.

**Runs (worktree root; `node build.mjs` first, exit 0)**
- `wiki-persistent-keys.spec.ts` under `xvfb-run` with XTEST and a window manager, `--workers=1 --retries=0`: 1 passed (38 s). Earlier runs of the same spec failed for the reasons above (no persisted state under the harness launch; chips absent, not unstyled, when the wiki is disabled; Enter pressed before Quick Open had results); each was fixed in the test, no assertion was weakened.
- `wiki-deferred-keys.spec.ts` (2 passed) and `wiki-keys-after-setting.spec.ts` (3 passed), once each, same flags.
- `npm run typecheck:vscode-e2e`: exit 0. `npx biome ci` on the new spec: exit 0.

**Open**
- S5 real-profile measurement (acceptance 6) and the stored-size check on a real workspace.
- Acceptance checkboxes are left for S6, after the full gates.
- Residual risk: the spec depends on VS Code's Quick Open and on the editor association written to the workspace settings file; a future VS Code version that changes either shows up as a launch-1 failure, not as a vacuous pass.

## Execution progress — 2026-10-14 (S5)

**Scope:** real-profile re-run (acceptance 6) on the development build at the branch HEAD (`node build.mjs`, exit 0): cold Explorer-click opens of the same wiki workspace and file as the Task 636 W runs, four sessions in a row, each closed before the next. Settings Sync was on in the profile; the Owner accepted that for this run (no settings change; the only new state allowed is the one workspace-state entry, and workspace state is not synced). Pre-flight (no other VS Code process) passed before each launch; the profile was backed up first (copy, hashes recorded under ignored `tmp/638/`). All controls fired on every run (workbench long task, webview long task, webview message, chip observer).

| Run | `init` key count | `wiki-update` | `init` to `wiki-update` | ready |
|---|---|---|---|---|
| 1 (first, writes list) | none | yes, 6,040 keys, at 4,999 ms | 3,288 ms | 4,587 ms |
| 2 (after prior session) | none | yes, 6,040 keys, at 4,090 ms | 2,938 ms | 3,734 ms |
| 3 (after prior session) | none | yes, 6,040 keys, at 4,356 ms | 3,141 ms | 3,972 ms |
| 4 (after prior session) | none | yes, 6,040 keys, at 3,156 ms | 1,992 ms | 3,126 ms |

Times are milliseconds after the click. Missing-page chips were marked at `wiki-update` in every run; the existing-page chip was never marked missing.

**Result: acceptance 6 is NOT met on this workspace.** `init` carried no keys on runs 2-4, and no `vmde.wikiPages:<root>` entry existed in the workspace state after any run (entry count 0; the extension's workspace-state value stayed 7,025 bytes). Nothing was stored, so there was nothing to serve.

**Cause (inferred, not instrumented):** the real list is 6,040 keys; recomputing both arrays for this workspace's markdown files with the same key rules gives about 697,000 UTF-8 bytes, above the provisional 512 KiB (524,288 byte) cap, so the over-bound list is dropped at write by design. The provisional estimate of about 100 bytes per page (about 5,000 pages at the cap) is too low here: display names that repeat a basename are path-qualified, which makes this workspace's list about 115 bytes per key. This workspace is large mostly because the wiki root is the whole repository folder, including generated and evidence folders under `tmp/`. Open design question for the Owner: raise the cap (the numbers are marked provisional and reversible), store keys only, or exclude generated folders. Not decided here.

**Profile integrity:** `settings.json` and `extensions.json` hashes equal the pre-run backup (and `settings.json` equals the Task 636 manifest); the Task 636 manifest has no `extensions.json` hash; there is no `keybindings.json`. The workspace and global state databases are rewritten by VS Code on every session (new hashes, workspace database size unchanged at 110,592 bytes). No other new state was found.

**Open:** acceptance 6 until the bound decision is made and the run is repeated; checkboxes stay for S6.

## Execution progress — 2026-10-15 (S2b)

**Owner decision (2026-10-15, chat), verbatim:** "Allow wiki size to grows up to 4 MiB, do not limit the amount of pages. However should have a way to exclude folders and files (relative path, absolute path, pattern matching paths)".

**Owner confirmation (2026-10-15):** `vmde.wiki.exclude` follows VS Code's default behaviour: `scope: resource`, read with the normal resource-scoped configuration API (user, workspace and folder levels; the most specific level wins; arrays from different levels are not merged). There is no custom merging. The setting description and the README sentence say so briefly.

**Scope:** failing tests first, then the change. No real-VS-Code run (no token for this step).

**Change**
- Store (`src/wiki/wiki-key-store.ts`): one list may hold up to 4 MiB of UTF-8 string bytes (both arrays together, counted on write and on read); the 20,000-entries-per-array limit is removed, so the number of pages is not limited. The 4-roots-per-workspace bound stays. An oversize list is still not stored and deletes the old entry. The byte count is the text of the keys and display names, as before; the JSON framing is not counted (about 6 bytes per string).
- Setting (`package.json`): `vmde.wiki.exclude`, Wiki section, `scope: resource`, `type: array` of strings, default `[]`, description with examples and the levels note.
- Exclude logic (`src/wiki/wiki.ts`): each entry becomes workspace-relative globs. A relative path or an absolute path inside the workspace folder (a path outside it is ignored) without glob characters excludes that file or folder and everything under it (the path and a `/**` twin). A glob (`*`, `**`, `?`, `{a,b}`, `[...]`) is used as written. Backslashes become slashes; a leading `./` and trailing `/` are dropped; empty, blank and non-string entries and non-array values are ignored. The globs are rebased to the wiki root with the existing `rebaseExcludeToRoot` and merged into the set shared by the page search and the watcher (`isWikiPageExcluded`), next to `files.exclude` and `node_modules`. A glob that does not compile is now dropped from that set, so the search (one brace pattern, where one unclosed `{` broke every glob) and the watcher agree that it excludes nothing.
- Config change (`src/wiki/wiki-session.ts`): the session remembers the exclude set of its last plan; `onConfigChanged` treats a different set (or a different root) as a root change, so it invalidates the cache and the stored list and asks the caller to re-plan; the editor session then posts one `wiki-update`. An unchanged set keeps cache and subscription (Task 637 C4).
- README: one sentence in the Configuration paragraph.

**Tests (written first; the new and changed cases failed before the change: 19 failed, then 2 more for the config change)**
- `test/backend/wiki-key-store.test.ts`: a list of 26,000 pages (3.89 MiB) is stored and read; exactly 4 MiB is stored and read; 4 MiB plus one byte is not stored (keys or display names) and deletes the old entry; a hand-written oversize value is ignored on read; UTF-8 bytes, not characters, are counted.
- `test/backend/wiki.test.ts` (`vmde.wiki.exclude (task 638)`): relative file; relative folder (descendants), also with `./` and a trailing `/`; absolute folder and file inside the workspace; absolute outside (ignored); `**/tmp/**`; `drafts/*.md`; `{a,b}` and `[...]`; Windows separators; uncompilable glob; empty and non-string entries; a non-array value; merge with `files.exclude` and `node_modules`; wiki root in a subfolder (workspace-relative path, same-named folder outside the root not excluded, absolute path, glob). Every case asserts the page search result and `isWikiPageExcluded` give the same kept files.
- `test/backend/wiki-session.test.ts`: a `vmde.wiki.exclude` change returns true once, drops the cache and the stored list, the re-plan scans once and delivers keys without the excluded page; an unchanged set keeps cache and stored list. One existing case (oversize stored value) now uses a value over 4 MiB.
- `test/backend/editor-session.test.ts`: a `vmde.wiki.exclude` change posts exactly one `wiki-update` without the excluded page after one new scan.
- `test/backend/vscode-mock.ts`: `getConfiguration(section).get(key)` reads the section-qualified key first (`vmde.wiki.exclude`), so the two `exclude` settings can be set apart.

**Runs (worktree root)**
- Vitest on the 21 files that import the changed modules (asset-link-actions, commands-and-handlers, custom-css, dispose, editor-session, extension, font-size, i18n-lang, image-upload, manifest, module-boundaries, open-link, status-bar, webview-html, webview-overlay, wiki-cache, wiki-key-store, wikilink-handler, wiki-perf, wiki-session, wiki): 21 files, 604 tests passed.
- `npx tsc --noEmit -p ./` exit 0; `npm run typecheck` exit 0; `npx biome ci` on the changed files exit 0; `npm run knip` exit 0; `npm run depcruise` exit 0; `node build.mjs` exit 0.

**Not run / open**
- Chromium and real-VS-Code specs, jscpd and `npm run quality` (batched closure, S6). The real-VS-Code restart spec still uses a small list; a stored list above the old 512 KiB bound is proved at the Vitest layer only.
- Acceptance 6 (real-profile re-run) stays open: repeat S5 with the 4 MiB bound (the 6,040-key list of about 697 KB now fits).
- A second editor on the same root detects the exclude change on its own session state and may invalidate a cache that the first editor already rebuilt (one extra scan, still correct).
- `files.exclude` changes do not raise a configuration event for the wiki, so they are picked up at the next wiki setting change or reopen (unchanged from Task 636).

## Execution progress — 2026-10-15 (S4b)

**Scope:** the real-VS-Code restart spec `test/vscode-e2e/wiki-persistent-keys.spec.ts` gains a second test case for the S2b contract (Owner decision 2026-10-15: a stored list up to 4 MiB with no page limit, and `vmde.wiki.exclude`). Same own-launch restart design as S4 (one launch per state, on-disk workspace state, four launches). No product change in this step.

**Second test case: workspace with 1,500 pages in 30 folders that share 50 basenames (so every display name is path-qualified), plus one page each in `archive`, `private` and `work/tmp`**
- The premise is asserted in the test: the stored text (keys plus display names) is above 512 KiB and below 4 MiB (about 600 KB).
- Launch 1 (no stored list): `init` has no keys; one `wiki-update` carries exactly all keys (computed in the test from the generated paths); chips follow the pages.
- Launch 2 (nothing changed): `init` carries exactly those keys, so the list above the earlier 512 KiB bound was stored and is served; chips are right at once; no `wiki-update` in a 3 s observation window.
- `vmde.wiki.exclude` is then written to the workspace settings file while VS Code is closed: a relative folder (`archive`), an absolute path inside the workspace folder (the `private` page), and a glob (`**/tmp/**`).
- Launch 3: `init` still carries the stored list (a hint written before the setting changed, so it names the excluded pages); exactly one `wiki-update` follows with every key except the six keys of the excluded pages (asserted both as an exact list and per key); after release the three excluded chips show missing, the kept page's chip does not; the file bytes are unchanged and no tab is dirty.
- Launch 4: `init` carries the replaced list without any excluded key, the chips are right without a `wiki-update`, and none follows in a 3 s window (the stored list was replaced by launch 3's revalidation).
- Not covered at this layer: changing `vmde.wiki.exclude` while the editor is open (one `wiki-update`, cache and stored list dropped) is proved by Vitest in S2b.

**Runs (worktree root; `node build.mjs` first, exit 0; `--workers=1 --retries=0`, XTEST display with a window manager)**
- `wiki-persistent-keys.spec.ts`: 2 passed (the earlier test case 32.7 s, the new one 27.8 s). The new test case passed on its first run.
- `wiki-deferred-keys.spec.ts`: 2 passed.
- `wiki-keys-after-setting.spec.ts`: first run 1 failed, 2 passed. The failing case was the first one, at its first root change (to the workspace root): "config-changed after root \"\"" expected an index of at least 0 and got -1 (no `config-changed` message in the window after the setting write, although the chips matched). A second run of the same file passed all 3 cases (9.9 s, 15.3 s, 10.4 s). The cause was not investigated; the spec does not touch the exclude setting, the stored list or the files this step changed, but it does exercise `WikiSession.onConfigChanged`, which S2b changed, so treat it as an intermittent failure of unknown cause, not as proven unrelated.
- `npm run typecheck:vscode-e2e`: exit 0. `npx biome ci` on the spec: exit 0.

**Open**
- Acceptance 6 (the real-profile re-run with the 4 MiB bound) is still open; acceptance checkboxes stay for S6.
- The intermittent `wiki-keys-after-setting.spec.ts` failure above.
