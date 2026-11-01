# Task 689 — The test kit leaves `vmde.editor.defaultMode` set to `ir` in the shared test settings

**Status:** planned (2026-11-01). Filed at the close of Task 682.
**Origin:** Task 682 (measured non-cause and its provisional decision).
**Severity:** low (estimated; not a measured cause of any failure, test hygiene only).
**Tech stack:** `test/vscode-e2e/helpers/shortcut-xtest-kit.ts` (`makeKit`, the `defaultMode` handling at `:357` and `:586`), and the specs that run after kit users in a batch.
**Depends on:** none.

## Problem

`makeKit` in `test/vscode-e2e/helpers/shortcut-xtest-kit.ts:357` sets the user-global `vmde.editor.defaultMode` to `ir` and never restores it. User data is kept per worker, not per test, so the value stays in the worker's shared `settings.json` (`"vmde.editor.defaultMode": "ir"`). Later specs in a batch then start with `ir` instead of the default.

Task 682 measured this as a non-cause: the link-popover tests open in IR either way and fail later. Task 682 left the kit unchanged, because restoring the value changes the starting state of every later spec in a batch and widens its scope. Which later specs depend on the leaked `ir`, if any, is not measured.

## Proposed work

Restore the previous value of `vmde.editor.defaultMode` when the kit is disposed (or per test), using the same read of the global value that the direct-open helper already uses (`inspect(...).globalValue` near `:590`). Then check the specs that run after kit users for a changed starting mode: list the kit users, list the specs that follow them in the default batch order, and run them together.

## Acceptance

- [ ] The kit restores the previous value of `vmde.editor.defaultMode` (including "unset") at disposal.
- [ ] The specs that follow kit users pass in a combined real-VS-Code run.
- [ ] No spec relies on the leaked `ir`. A spec that does must set the mode itself, and the change is recorded.
- [ ] The direct-open helper still restores its own value.

## Tests to write

- Real VS Code: one combined invocation of the kit users and the specs that follow them. Check the user-data `settings.json` after the run to confirm the setting is not left at `ir`.
- No Vitest: the change is test-kit code only.
