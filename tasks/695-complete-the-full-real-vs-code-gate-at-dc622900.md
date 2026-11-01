# Task 695 — Complete the full real-VS-Code gate: unrun tests and unconfirmed failures

**Status:** planned (2026-11-02). Filed from the full real-VS-Code gate of queue run 2026-11-01d.
**Origin:** Gate suite on `dc622900` (2026-11-01).
**Severity:** medium (estimated; 92 tests have no result and 30 failures are not yet confirmed or attributed).
**Tech stack:** `test/vscode-e2e/` (whole suite), `test/vscode-e2e/playwright.config.ts`.
**Depends on:** Tasks 692, 693 and 694 own the failures confirmed alone; this task owns the rest.

## Problem

The full suite ran in four sequential chunks of at most 60 minutes. Two chunks hit the limit, so 92 of 599 tests never ran: the `ir-*`, `katex`, `link-*`, `list-*` and `large-document-interaction` specs, and the `undo-*`, `vditor-*`, `wiki-*`, `writeback-*`, `webview` and `wysiwyg-*` specs. Each later chunk started while a VS Code process from the previous chunk was still running.

Of the 55 failures, Tasks 692–694 hold the ones confirmed alone. The others are not confirmed alone: Preview or diagram render not settled (11, for example `mode-switch-render-reuse`, `mermaid-flip-gate`, `preview-rehighlight`, `parity`, `preview-spacing`, `sv-split`), OS-level keyboard cases (12, for example `shortcut-identity`, `expand-selection-first-keys`, `enter-new-paragraph`), caret and focus (`callout-arrow-nav`, `contextual-panel-clearance`), `outline-state` (2), and others (`task-list-word-wrapping` reports `VditorIRDOM2Md` undefined). `toolbar-overflow.spec.ts:208` (two toolbar rows) failed alone.

Slowest spec files: `exact-authority-other-actions` 785 s, `shortcut-identity` 749 s, `exact-actions-after-trusted-edit` 570 s. 23 tests ran over 60 s.

## Proposed work

1. Split the suite into chunks sized by the measured durations so that no chunk reaches the 60-minute limit, and make sure each chunk starts with no VS Code process left from the previous one.
2. Run the 92 unrun tests.
3. Rerun each unconfirmed failing spec file alone; file a task per group that still fails, and record the ones that pass alone as load- or order-dependent.

## Acceptance

- [ ] Every one of the 599 tests has a result.
- [ ] Every failure is confirmed alone (and filed) or recorded as load- or order-dependent with its evidence.
- [ ] The chunk plan and per-chunk wall times are recorded.

## Tests to write

- None; this is a verification task.
