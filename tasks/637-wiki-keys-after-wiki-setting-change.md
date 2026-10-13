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
