# Task 562 — Reference-style image asset refresh

**Status:** ✅ DONE — 2026-09-07 · **Origin:** GitHub Markdown support audit, 2026-09-06

## Scope

Refresh locally referenced images after their on-disk bytes change without changing Markdown,
adding an undo entry, or adding toolbar controls. This task owns full, collapsed, and shortcut
reference-image watching only; reference-link interaction and definition serialization remain the
owners of Tasks 550 and 240.

## What shipped

- `src/session/image-asset-watcher.ts` now uses a bounded pure scanner for reference images. It
  normalizes labels case-insensitively with collapsed whitespace, keeps the first matching
  definition, accepts full/collapsed/shortcut forms, and retains the existing local-path,
  percent-decoding, query/fragment, de-duplication, and 100-watch cap contracts.
- The scanner ignores escaped syntax and inline, indented, and correctly sized fenced code; it
  excludes missing, remote, and anchor definitions. It neither renders through Lute nor mutates
  document source, protocol messages, CSP, or the webview refresh implementation.
- The existing watcher replacement lifecycle and `assets-changed` host-to-webview refresh are
  reused. Retargeting a definition replaces only the affected watcher.

## Verification

- [x] Full, collapsed, and shortcut references; normalized labels; first duplicate definition;
      encoded destinations; missing/remote/anchor definitions; escaped/malformed/literal-code
      guards; and definition retargeting: focused backend test, **17/17**.
- [x] Focused watcher coverage: **98.95% lines**, **100% functions**. The only uncovered line is
      the defensive unmatched-bracket return.
- [x] Real VS Code: manually authored `![shot][asset]` refreshes after the image file is replaced
      in place, with no edit/reopen; the saved document remains byte-identical and clean,
      **1/1** (`image-swap-refresh.spec.ts`). This direct host-to-webview assertion is the
      applicable e2e layer; no webview renderer code changed, so a separate Chromium change test
      was not added.
- [x] `node build.mjs`; `npm run typecheck`; `npm run typecheck:strict`;
      `npm run typecheck:vscode-e2e`; `npm run lint:ci`; `npm run audit`; aggregate coverage
      **3,879/3,879**; and `npm run check:coverage-modules` all pass.

## Recorded inherited gates

- `npm run quality` still reports the three checked-in `vmarkd` compatibility markers in
  `patch-vscode-test-playwright`; they predate this task and are required by that patch's legacy
  fixture contract.
- Bundle and startup budgets remain inherited reporting debt: `main.js` 663 KB / 608 KB and 303 /
  294 eager modules. This host-only task does not change either artifact.
