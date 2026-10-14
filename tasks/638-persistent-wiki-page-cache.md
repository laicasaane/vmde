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
