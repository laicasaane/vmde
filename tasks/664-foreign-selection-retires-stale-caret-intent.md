# Task 664 — A foreign selection write retires a stale caret intent

**Status:** open.
**Origin:** Project Owner request (follow-up of Tasks 649 and 652).
**Severity:** medium (caret reliability).
**Tech stack:** webview (caret authority in `media-src/src/editing/caret.ts`; Vditor editing surface in IR, WYSIWYG and Split source).
**Related:** [Task 649](done/649-section-indentation-by-heading-level.md) (section indentation by heading level, where the finding was recorded); [Task 652](652-restore-caret-after-preview-off.md) (restore caret after Preview is turned off, where the analysis was recorded).

## Problem

The caret authority keeps a live intent and re-asserts it on animation frames until a gesture invalidates it (`keydown`, `pointerdown`, `beforeinput` or `compositionstart`) or 300 ticks pass.

A selection written programmatically without `requestCaret`, such as an `addRange` or `setBaseAndExtent` call by another module or by test code, does not retire the intent. A later layout or configuration event can then restore an older caret over that selection.

Task 649 recorded this finding (`done/649-section-indentation-by-heading-level.md`). The analysis is in the Part 1 handoff of Task 652 (item D7b).

About 20 call sites use `requestCaret`. Vditor's own undo and spin writes are what the caret authority intentionally overrides, so a fix must tell VMDE-intended selection writes apart from Vditor churn.

## Requirements

1. Part 1 measures the actual Task 649 mechanism before any fix is designed.
2. A deliberate selection write by VMDE code retires or replaces a stale caret intent.
3. Vditor churn (undo and spin writes) is still overridden by the caret authority.

## Open design points

- How VMDE-intended selection writes are marked, distinct from Vditor writes.
- Whether a foreign write retires the intent or replaces it with the new selection.

## Scope

- In: retirement or replacement of a stale caret intent when VMDE code writes the selection without `requestCaret`; the measurement in Part 1.
- Out: the Vditor override behaviour for undo and spin writes; the Task 652 Preview restore; any other caret behaviour.

## Acceptance

- [ ] Part 1 records the measured Task 649 mechanism.
- [ ] A deliberate selection write by VMDE code retires or replaces a stale caret intent.
- [ ] Vditor undo and spin churn is still overridden by the caret authority.

## Tests

- To be specified in Part 1 (webview behaviour; real-VS-Code verification is required for behaviour that depends on the VS Code integration).
