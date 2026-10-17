# Task 663 — Clean up test tooling and document the window manager requirement

**Status:** open.
**Origin:** Project Owner request (known issue from Tasks 641, 642, 647, 649, 650, and 651).
**Severity:** low.
**Tech stack:** `scripts/check-coverage-modules.mjs` coverage ratchet; [DEVELOPMENT.md](../DEVELOPMENT.md); real-VS-Code OS-key tests under `xvfb-run`.
**Related:** none.

## Problem

1. `BASELINE_ZERO` in `scripts/check-coverage-modules.mjs` still lists `media-src/src/chrome/prerender-overlay.ts`. That module now has coverage, and the ratchet prints a prune notice.
2. `DEVELOPMENT.md` does not document that real-VS-Code OS-key (XTEST) cases need a window manager (`openbox`) inside the `xvfb-run` display. Without it, `xdotool getactivewindow` fails with "windowmanager claims not to support _NET_ACTIVE_WINDOW".

## Requirements

1. Remove the `media-src/src/chrome/prerender-overlay.ts` entry from `BASELINE_ZERO`.
2. Document in `DEVELOPMENT.md` that real-VS-Code OS-key (XTEST) cases need a window manager (`openbox`) inside the `xvfb-run` display.

## Open design points

- None recorded in this brief beyond the two requirements above.

## Scope

- In: the `BASELINE_ZERO` entry and the `DEVELOPMENT.md` note.
- Out: any other change to the coverage ratchet or the test harness.

## Acceptance

- [x] `media-src/src/chrome/prerender-overlay.ts` is absent from `BASELINE_ZERO`, and the ratchet prints no prune notice for it.
- [x] `DEVELOPMENT.md` states the `openbox` window manager requirement for OS-key (XTEST) cases under `xvfb-run`.

## Tests

- Run the coverage ratchet check and confirm the prune notice is gone. Exact commands are to be specified in Part 1.

## Execution progress — 2026-10-18

- Removed `media-src/src/chrome/prerender-overlay.ts` from `BASELINE_ZERO` in `scripts/check-coverage-modules.mjs`; no test lists the set.
- Added a paragraph and command example to the headless-run section of `DEVELOPMENT.md` stating that OS-key (XTEST) cases need `openbox` started inside the `xvfb-run -a` shell with `VMDE_XTEST=1`.
- `npm run test:coverage` fails with the default 5 s timeout on `toolbar-overflow.test.ts` ("never starts or ends a row with a rule"), reproduced twice under coverage; the file passes alone (22/22). With `-- --testTimeout=30000` the run passes (344 files, 6922 tests) and `npm run check:coverage-modules` prints "Coverage ratchet OK — 10 source module(s) at 0% (baseline 10)" with no prune notice.
- Not verified: the openbox command was not run (no real VS Code run in this step). `biome check` does not process `DEVELOPMENT.md` or the script (ignored by config).
