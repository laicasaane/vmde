# Task 657 — Store the last Preview toggle when toggles are rapid

**Status:** open.
**Origin:** Project Owner request (known issue from Task 651).
**Severity:** low.
**Tech stack:** VS Code extension host (`globalState` writes) and webview Preview toggle messages.
**Related:** [Task 651](done/651-remember-preview-toggle-state.md) (remember Preview toggle state), Task 631 (toolbar collapse), [Task 650](done/650-remember-outline-open-state-and-width.md) (remember Outline open state and width).

## Problem

In real VS Code, three Preview toggles about 100 ms apart (on, off, on) left the stored value off once. The host received `save-preview-state` with true, false, true in that order, yet the next opened file read off. With 300 ms spacing the stored value was correct. The likely cause is the ordering of `globalState.update` writes when they overlap.

## Requirements

1. The last Preview toggle always wins: after any rapid sequence of toggles, the stored value equals the state of the last toggle.
2. The same check applies to the Task 631 toolbar collapse write and the Task 650 Outline open write, which use the same write pattern.

## Open design points

- To be settled in Part 1.

## Scope

- In: ordering of stored Preview toggle writes under rapid toggling; the same ordering check for the Task 631 toolbar collapse write and the Task 650 Outline open write.
- Out: Preview rendering and any other pane behaviour.

## Acceptance

- [ ] Three Preview toggles about 100 ms apart (on, off, on) leave the stored value on.
- [ ] The next opened file reads the stored Preview state that matches the last toggle.
- [ ] The toolbar collapse write and the Outline open write keep the last value under the same rapid sequence.

## Tests

- To be specified in Part 1 (the stored value depends on VS Code integration, so real-VS-Code verification is required).
