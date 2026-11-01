# Task 683 — Blockless range restore may disagree with a live caret intent

**Status:** done (2026-11-01).
**Origin:** Task 664 (review note and residual).
**Severity:** low (estimated; unmeasured, may not exist).
**Tech stack:** `media-src/src/editing/undo-boundaries.ts` (`keepBlocklessRange`), `media-src/src/editing/selection-writes.ts`, `media-src/src/editing/caret.ts`.
**Depends on:** none.

## Problem

`keepBlocklessRange` (`undo-boundaries.ts:288`, used at `:520` and `:546`) saves a blockless range, lets Vditor's snapshot move it, and writes the saved range back. Task 664 classified this write as transparent: it keeps the live caret intent. The residual reads: "`keepBlocklessRange` writes back its range with the intent kept; this is the unchanged earlier behaviour (pre-existing)" (`tasks/done/664-foreign-selection-retires-stale-caret-intent.md`, Residuals). The review note raised a possible mismatch: the restored blockless range could be overridden by a stale caret intent that points elsewhere, so a later caret read would follow the intent and not the range. This has not been measured.

## Proposed work

Measure first. Write a scratch probe (not committed) that arms a caret intent, leaves a blockless range, runs the undo boundary that calls `keepBlocklessRange`, and compares the live selection with the intent afterwards. If no mismatch shows in the existing undo and Headings or Link cases, close this task as not reproduced and record the probe's output. Only if a mismatch shows, mark the write as deliberate (`writeSelectionKeepingIntent` versus a retiring write) following the Task 664 rules and add a Vitest case.

## Acceptance

- [x] The probe result is recorded (mismatch or none): mismatch reproduced (Part 1 handoff).
- [x] If none: the task is closed as not reproduced with the measured output. Not applicable: a mismatch was reproduced.
- [x] If a mismatch: it is fixed without weakening the Task 664 rules, with a Vitest case for the boundary.
- [x] If a fix changes webview behaviour: focused real-VS-Code spec written and run; quality stages pass (dependency audit omitted by queue policy; see Result).

## Part 1 handoff (2026-11-01)

### Measurement

A scratch Chromium probe (untracked, not committed) ran against the blockless-caret harness on a private port, after `node build.mjs`. Each case seeded a history baseline, optionally typed one character into the first paragraph (an edit checkpoint pending: the boundary's `dirty` flag is set for `undoDelay` + 50 ms), put a collapsed range on the editable root at offset 0, then ran a boundary route. It recorded the live range right after the route, after three frames and after 400 ms, and every `__vmdeRequestCaret` call.

| Route (heading-first and rule-first documents) | No pending edit | Edit pending |
| --- | --- | --- |
| Toolbar Headings click | range stays on the root; no caret request | range ends inside a block (`# Probe` or the first paragraph) |
| Toolbar Link click | stays on the root | ends inside a block |
| Headings `click()` without a focus move | stays on the root | ends inside a block |
| Enter | moves into a block (Enter's own edit; not this task) | moves into a block (not this task) |

A second probe traced every Selection write with its stack. With an edit pending, the order inside one frame is: the snapshot's `addToUndoStack` calls the patched `addCaret`, which arms a `{textOffset: 0}` caret intent and writes the caret into the heading marker text; `keepBlocklessRange` then writes the root range back through `writeSelectionKeepingIntent`, so the intent stays armed; on the next animation frame the caret authority's tick rewrites the selection to the intent (the heading marker text). The Headings panel then does not open, so the Task 608 rule (Headings and Link refuse at a blockless caret, and the panel's second click must still see the blockless range) fails. With no pending edit the boundary calls no snapshot that restores a caret, no intent is armed, and the range stays.

Counterfactual in the same probe: a capture click listener that runs right after the boundary and rewrites the same root range through the retiring `writeSelection` kept the range on the root (after three frames and after 400 ms) and the Headings panel opened, with and without a pending edit. The document bytes did not change in any case.

Result: **mismatch reproduced.** The live intent that overrides the restored range is not a stale intent from an earlier gesture; it is the intent the boundary's own snapshot arms a moment before `keepBlocklessRange` writes the range back. Severity: low (a Headings or Link click at a blockless caret within about 850 ms of typing).

### Root cause

`keepBlocklessRange` (`media-src/src/editing/undo-boundaries.ts`, `writeSelectionKeepingIntent(saved)` at the end of the function) classes its write-back as transparent. A transparent write is only correct when the live intent agrees with the restored selection. Here the snapshot's intent is derived from the same root range but cannot express a root position (a `{textOffset}` intent resolves to the nearest text), so the two always disagree when the snapshot restores a caret. The write-back is a deliberate correction of the snapshot's caret and must retire that intent.

### Scope and invariants

- One product change: `keepBlocklessRange` writes back with `writeSelection` (retiring). Its comment changes from "transparent" to "deliberate". `writeSelection` is already exported from `util/selection-write.ts` (and re-exported from `editing/caret.ts`); the import is added where `writeSelectionKeepingIntent` is imported today.
- Task 664 rules stay intact: every selection write still goes through `writeSelection` or `writeSelectionKeepingIntent`; the guard test (`test/backend/selection-writes.test.ts`) forbids only raw Selection writes and needs no change. The Task 664 record's classification of this site is superseded by this task's record; the done record is not edited.
- The vendored Undo patch (`media-src/esbuild-shared.mjs`) is not changed.
- Unchanged behaviour: the early return when the snapshot left the range where it was (no write, no retirement); ranges inside a block (no saved range); the empty editor; both call sites (the boundary's opening snapshot and the after-action checkpoint).
- Every boundary route that reaches this code already follows a user gesture (pointerdown, keydown, paste after keydown), which invalidates any older intent, so retiring here drops only the snapshot's own intent. The host editor-action route (the eight table actions) has no webview gesture; there a live older intent at a blockless range would already have been overridden by the authority, so retiring it is the same outcome.

### Decisions

- Provisional decision (2026-11-01), reversible: fix form. `keepBlocklessRange` writes the saved range back with the retiring `writeSelection` whenever the snapshot moved it. Alternatives were retiring only when the snapshot armed a new intent (needs a new intent-identity accessor in `caret.ts`) and changing the vendored Undo patch so it does not restore a caret for a root range (changes a patch shared by every snapshot). Evidence: the measured write order and the counterfactual above. Selected by a recorded decision check (probability 0.97; the other two 0.02 and 0.00).
- Provisional decision (2026-11-01), reversible: test placement. The Vitest case goes into the existing `blockless range at a toolbar click (Task 608)` describe in `media-src/src/editing/undo-boundaries.test.ts`; the real-VS-Code case goes into `test/vscode-e2e/blockless-routes.spec.ts` as a new test beside A1, reusing its session helpers. No new public names, numbering, compatibility rules or storage formats.

### Acceptance mapping

| Acceptance item | Proof |
| --- | --- |
| Probe result recorded | This section (mismatch reproduced, with the measured write order). |
| If none: close as not reproduced | Not applicable (mismatch). |
| Mismatch fixed without weakening Task 664, with a Vitest case | Vitest, `media-src/src/editing/undo-boundaries.test.ts`, describe `blockless range at a toolbar click (Task 608)`, new test `keeps a root caret when the pending checkpoint's snapshot arms a caret intent (Task 683)`: the modelled `addToUndoStack` places the caret through the real caret authority (`requestCaret({ textOffset: 0 })`), an `input` event marks the boundary dirty, the toolbar click runs, and after the authority's next frame the caret is still `(root, 0)` and `hasLiveCaretIntent()` is false. Plus the unchanged guard `test/backend/selection-writes.test.ts`. |
| Webview behaviour change: focused real-VS-Code spec, quality stages | Real VS Code, `test/vscode-e2e/blockless-routes.spec.ts`, new test `A2 Headings and Link refuse at a seeded root caret while an edit checkpoint is pending (Task 683)`; then the quality stages other than the dependency audit (lint, knip, jscpd, dependency-cruiser, unit coverage, zero-coverage ratchet). |

Edge cases and their cheapest layer:

- The snapshot does not move the range (no pending edit): no write and no retirement. Covered by the existing Vitest cases in the same describe (`keeps a root caret at offset %i …`).
- Root offset 1 (after a leading rule): Vitest, the new test parameterized over offsets 0 and 1.
- Non-collapsed selection starting at the root: existing Vitest case `keeps the root start of a non-collapsed selection`.
- Range inside a block: existing Vitest control `still records the after-action checkpoint for a caret inside a block` (no saved range, intent untouched).
- Link route with an edit pending: real-VS-Code A2 (Headings and Link).

### Step plan for Part 2 (Medium: RED step, then GREEN step)

Part 2 starts after Task 674 integrates (674 does not touch `undo-boundaries.ts`).

1. **R1 (RED).** Owned file: `media-src/src/editing/undo-boundaries.test.ts` (one new parameterized test in the Task 608 describe). Check: `npx vitest run --config test/vitest.config.mts media-src/src/editing/undo-boundaries.test.ts -t "blockless range at a toolbar click"`. Expected: the new test fails on the caret assertion (the caret is in the paragraph text, not `(root, offset)`); the seven existing tests pass. Notes for the test: `requestCaret` binds the editor through `window.vditor` (`activeModeElement`), so the test sets `window.vditor` to the modelled editor and clears it after; stub `requestAnimationFrame` and run the queued frame callback by hand, as `media-src/src/editing/caret.test.ts` does, plus `setCaretPaintabilityProbeForTests` if paint matters; call `resetCaretAuthorityForTests()` in `afterEach`.
2. **S1 (GREEN).** Owned files: `media-src/src/editing/undo-boundaries.ts` (import `writeSelection`, use it in `keepBlocklessRange`, update the comment), `test/vscode-e2e/blockless-routes.spec.ts` (test A2). Checks: the R1 command (all eight pass); `npx vitest run --config test/vitest.config.mts test/backend/selection-writes.test.ts` (pass); `node build.mjs`; through the real-VS-Code wrapper, `blockless-routes.spec.ts` with `--grep "A2"` (pass) and the unchanged A1 (pass).
3. **C (closure).** Owned files: this record, `tasks/README.md`. Quality stages other than the dependency audit; completion report.

## Result and verification (2026-11-01)

### Change

- `media-src/src/editing/undo-boundaries.ts`: `keepBlocklessRange` writes the saved range back with `writeSelection` (deliberate, retires the live caret intent) instead of `writeSelectionKeepingIntent`. The snapshot's caret restore arms an intent that cannot name a root position, so a kept intent moved the range into a block on the next frame.
- `media-src/src/editing/undo-boundaries.test.ts`: `keeps a root caret when the pending checkpoint's snapshot arms a caret intent (Task 683), offset %i` (offsets 0 and 1), using the real caret authority. It failed before the change (caret in the paragraph text, intent still live) and passes after.
- `test/vscode-e2e/blockless-routes.spec.ts`: `A2 Headings and Link refuse at a seeded root caret while an edit checkpoint is pending (Task 683)`. It failed with the old write (`headings: webview value`) and passes with the fix. The document is rule-first: with a heading first, the toolbar marks Headings current at a root range and its click removes the heading instead of opening the panel (separate, untouched behaviour).
- Task 664 rules intact: no raw selection write added; the guard test is unchanged and passes.

### Verification actually run

- Vitest: `undo-boundaries.test.ts -t "blockless range at a toolbar click"` 9 passed; `test/backend/selection-writes.test.ts` 2 passed.
- Real VS Code (through the queue wrapper, after `node build.mjs`): `blockless-routes.spec.ts` A1 and A2 passed; A2 failed with the old write restored.
- Quality stages, one by one: `check:brand-identifiers`, `lint:ci`, `typecheck`, `typecheck:vscode-e2e`, `knip`, `jscpd`, `depcruise` exit 0. `test:coverage`: the first run had two failures that pass alone (`lute-code-cache.test.ts` cache-hit case and `toolbar-overflow.test.ts` A3, load-dependent); the rerun with `--testTimeout=60000` passed (383 files, 8362 tests, 1 expected fail). `check:coverage-modules` exit 0 (9 zero-coverage modules, baseline 9). Dependency audit omitted (queue policy).
- Reporting only: `check:bundle-size` exit 1 (`main.js` 1092 KB against 608 KB) and `check:startup-cost` exit 1; the change adds no import (it swaps one helper already exported from `caret.ts`), so they are unlikely to come from this task (not investigated on unchanged code).

### Provisional decisions

See "Part 1 handoff": fix form `writeSelection` (selected by a recorded decision check, probability 0.97) and test placement (reversible).

### Residuals

- The A2 wait of 300 ms relies on the 800 ms undo delay (about 500 ms margin). After the independent review, A2 asserts right after the first click that the history grew (`clicked.undo > seeded.undo`, read before Vditor's own delayed checkpoint could add the entry), so a click that lands after the pending edit settled fails the test instead of passing vacuously. It passed with the guard (15.1 s).
- Heading-first Headings behaviour at a root range is unchanged and out of scope.
- The Task 664 done record still lists this site as transparent; it is not edited (done record).
