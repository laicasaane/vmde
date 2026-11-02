# Task 695 — Complete the full real-VS-Code gate: unrun tests and unconfirmed failures

**Status:** done (2026-11-02). Run at `f84a4258`. Filed from the full real-VS-Code gate of queue run 2026-11-01d.
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

- [x] Every one of the tests has a result. Evidence: 608 tests planned at `f84a4258` (the suite grew from 599 after Tasks 692 to 696); 553 passed, 53 failed, 2 skipped, 0 not run (Part 2 table).
- [x] Every failure is confirmed alone (and filed) or recorded as load- or order-dependent with its evidence. Evidence: Part 2 failure table; Tasks 697 to 701 filed.
- [x] The chunk plan and per-chunk wall times are recorded. Evidence: Part 2 chunk table.

## Tests to write

- None; this is a verification task.

## Part 2 result at `f84a4258` (2026-11-02)

Build: `node build.mjs` passed (the guard against inputs outside the repository raised nothing). Run: `--workers=1 --retries=0`, `VMDE_XTEST=1`, one foreground wrapper call per chunk, no VS Code or Xvfb process left before any chunk (process check recorded before each).

### Chunk plan and wall times

Chunks are contiguous runs of the alphabetical spec list, sized from the per-spec durations of the earlier gate (specs with no earlier duration were estimated at 14 s per test). The estimate was low for the specs that had never run, so chunk 05 reached the 3600 s limit with 85 of its 112 tests done; the remaining 27 tests ran as chunk 06 (25 tests) and chunk 07 (2 tests, the two `vditor-chords.spec.ts` cases that were in flight at the kill).

| Chunk | Specs | Tests | Passed | Failed | Skipped | Wall | Exit |
|---|---|---|---|---|---|---|---|
| 00 | 76 | 152 | 145 | 7 | 0 | 2197 s | 1 |
| 01 | 7 | 39 | 35 | 4 | 0 | 2155 s | 1 |
| 02 | 76 | 140 | 132 | 8 | 0 | 2801 s | 1 |
| 03 | 72 | 104 | 91 | 11 | 2 | 1858 s | 1 |
| 04 | 29 | 61 | 52 | 9 | 0 | 2012 s | 1 |
| 05 | 24 | 112 planned, 85 run | 78 | 7 | 0 | 3600 s | 124 (limit) |
| 06 | 16 | 25 | 18 | 7 | 0 | 445 s | 1 |
| 07 | 1 | 2 | 2 | 0 | 0 | 33 s | 0 |
| Total | | 608 | 553 | 53 | 2 | 15101 s (4 h 12 m) | |

Skipped: `plantuml-stdlib-more.spec.ts:148` and `:218` (k8s icon checks), as before. Chunk 05 had no hang: the summed test time was 3402 s and the limit cut the run during `vditor-chords.spec.ts`.

### Failures rerun alone

Each of the 43 failing spec files ran alone in its own Playwright invocation and its own X server (two wrapper calls, 21 and 22 files). 32 files (39 tests) fail alone; 11 files pass alone. Two suite failures sit in files that fail alone with fewer failing tests (for example `outline-state` 2 in the suite, 1 alone), so those suite failures did not reproduce alone.

| Verdict | Files | Task |
|---|---|---|
| Fail alone: Preview and diagram renders | diagram-render-sweep, diagram-sizing, mode-switch-render-reuse (2), preview-rehighlight, wavedrom-theme, parity, wysiwyg-parity, preview-spacing, sv-split | 697 |
| Fail alone: key and chord results (XTEST, typed text is ASCII only, so not the Task 693 keymap cause) | expand-selection-first-keys (3), shortcut-identity (4), sv-line-start-edit, github-inline-math, paste-plain-chord, auto-wrap, cut-backspace-stability, wiki-inline-code-edit | 698 |
| Fail alone: caret, focus, edit-surface state | id-insertion-mode-fidelity, link-button-url, table-operations (2), rewrap, marker-reveal, callout-edit, callout-arrow-nav, section-fold, bare-url-autolink | 699 |
| Fail alone: performance thresholds | incremental-seed, selection-performance, large-document-interaction | 700 |
| Fail alone: restart state, command list | webview-context-menu, outline-state, wiki-persistent-keys | 701 |
| Pass alone: load- or order-dependent | exact-authority-other-actions (5 of 5 in 17.2 min; 1 failed in chunk 01), html-superscript-editing (4 of 4), plantuml-edit-recovery (2 of 2; the Task 694 build fix), preview-task-checkbox (1 of 1), smiles-render (2 of 2), task-list-word-wrapping (1 of 1; the `VditorIRDOM2Md` error did not recur), toolbar-overflow (11 of 11, so `:208` two rows and the Emoji case C5 pass alone and are intermittent), undo-restore-caret (4 of 4), vditor-3.11.3-compat (1 of 1), wiki-deferred-keys (2 of 2), wiki-keys-after-setting (3 of 3) | none |

Evidence for load or order dependence is the chunk log failure against the clean alone pass in a fresh X server. The suite runs every file in one worker and one X server per chunk, so earlier specs in the chunk are the likely difference; the cause was not measured. The 150 KB check of `preview-mode-timing.spec.ts` passed in this run (chunk 03).

### Filed tasks

- 697 — Preview and diagram renders do not settle, or measure wrong, in the Preview pane
- 698 — Typed-key and chord results differ from the expected bytes or actions in XTEST specs
- 699 — Caret, focus and edit-surface state or command results are wrong after editing commands
- 700 — Three performance and timing assertions fail in real VS Code
- 701 — Restart-state and context-menu command-list assertions fail in real VS Code

The groups are by symptom, not by measured cause; each filed task starts with a bisect.
