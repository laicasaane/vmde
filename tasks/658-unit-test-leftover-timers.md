# Task 658 — Remove leftover timers and slow cases from unit tests

**Status:** open.
**Origin:** Project Owner request (known issue from Tasks 641 and 642).
**Severity:** low (test reliability).
**Tech stack:** Vitest unit tests in `media-src/src` (webview helpers).
**Related:** [Task 641](done/641-open-to-ready-one-second.md) (open to ready in one second), [Task 642](done/642-toolbar-layout-follow-ups.md) (toolbar layout follow-ups).

## Problem

Batch gate runs of Tasks 641 and 642 showed three intermittent unit test problems:

1. An unhandled `ReferenceError: window is not defined` at `media-src/src/diagrams/render-cache-client.ts:731`, raised by a timer in `render-cache-client.test.ts` after teardown.
2. The case "never starts or ends a row with a rule, and never doubles one" in `media-src/src/chrome/toolbar-overflow.test.ts` took about 6 s under load and hit the 5 s timeout twice. It passes when run alone.
3. A timing assertion in `markmap-security.test.ts` failed once.

## Requirements

1. `npm run test:coverage` exits 0 reliably under normal parallel load.
2. Leftover timers are cleared or awaited so that no timer fires after teardown.
3. Slow cases are made fast or bounded without weakening their assertions.

## Open design points

- To be settled in Part 1.

## Scope

- In: the three problems above, in the named test files and the named source line.
- Out: changes to assertions that reduce what the tests prove.

## Acceptance

- [ ] `npm run test:coverage` exits 0 across repeated runs under normal parallel load.
- [ ] No unhandled `ReferenceError` from a timer appears after `render-cache-client.test.ts` teardown.
- [ ] The toolbar-overflow case no longer approaches the 5 s timeout under load.
- [ ] The `markmap-security.test.ts` timing assertion passes reliably, with its assertion unchanged in strength.

## Tests

- Unit tests in the named files (Vitest). Exact commands are to be specified in Part 1.
