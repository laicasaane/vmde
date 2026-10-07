# Task 624 — The webview sometimes stops publishing edits for about 4 s while typing

**Status:** planned (2026-10-07).
**Origin:** found by Task 602 S1e measurement (`tmp/task602-checks/`, see `comparison.md`). The Owner chose on 2026-10-07 to track it outside Task 602.
**Severity:** medium. During the stall the host does not receive the user's typing. Task 602's checkpoint flush and resync fallback limit the Undo damage, but the cause is unknown.
**Tech stack:** TypeScript webview (`media-src/src/bridge/edit-sync.ts`, `media-src/src/editing/edit-activity.ts`, `media-src/src/boot/finish-init.ts`), real VS Code with XTEST.

## Problem

In 1 of 8 twelve-key typing runs in IR on real VS Code 1.129.0, the webview posted no `edit` message to the host for about 4 s while keys were arriving. Vditor still recorded its history entries, so one webview Undo step covered text the host never received. No native VS Code undo step can restore such a step.

## Evidence

- Measured during Task 602 S1e with the post wrapper capturing webview messages; the probe and logs are under `tmp/task602-checks/s1e/` (ignored, local).
- No stall occurred while the experimental checkpoint flush ("F") was enabled, so whether F hides or prevents it is unproven.
- The cause is open. Candidates to check first: the edit-sync debounce and its reset on each input, the IR settle re-spin in `edit-activity.ts`, and main-thread work after key events on larger documents.

## Acceptance

- [ ] A real-VS-Code probe reproduces the stall or proves a bound on publication delay during continuous typing in IR, WYSIWYG and SV.
- [ ] The cause is identified with evidence.
- [ ] Publication delay during typing stays within the edit-sync debounce plus one frame, or the reason it cannot is recorded.
- [ ] Task 602's Undo behavior and its focused specs stay green.

## Tests

- Real VS Code with XTEST: long typing runs that record every webview post time and host edit event.
- Vitest for any debounce or scheduling change.
