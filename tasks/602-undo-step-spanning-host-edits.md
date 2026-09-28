# Task 602 — One webview undo step spans several host edits and leaves the host out of step

**Status:** planned (2026-09-28). The Project Owner approved the finding. Implementation has not started; the decisions below are open.
**Origin:** found during the Task 598 investigation (2026-09-28).
**Severity:** high. The saved document can differ from what the editor shows until the next save.
**Recommended implementer effort:** xhigh. The fix changes the undo coupling between webview and host.
**Tech stack:** extension host (`src/writeback/history-coupling.ts`, `src/session/editor-session.ts`), webview (`media-src/src/bridge/edit-sync.ts`, `media-src/src/editing/undo-keybind.ts`), Vitest, real VS Code with XTEST.
**Dependencies:**

- Run after **Tasks 598 and 601**. Both change when checkpoints are recorded and when a history transition is posted.
- Read Task 463 (undo routing) and Task 488 (checkpoint granularity) first.

**Evidence:** `tmp/task596-603-evidence/t598/results4.json` and `results5.json` in the main checkout. Real VS Code 1.129.0, `VMDE_XTEST=1`, Task 579 build.

## Task 579 overlap (Owner decision 2026-09-28)

Task 579 CP2 N9 owns the narrower duplicate Undo-echo repair: retain the accepted history result
while matching **plain** edit echoes arrive and the host remains at its exact result; clear that
expectation on a different/non-plain edit or a history transition. This prevents a second
normalized Undo echo from creating a host edit that clears native Redo. The owner accepted the
pre-existing attribution with medium confidence and approved fixing it inside Task 579. Exact,
explicit-block and rewrap actions bypass suppression. See
[Task 579's N9 record](done/579-split-find-and-find-replace.md).

This overlap does not close Task 602: its general case of one webview history step spanning several
real host edits, and the A/B/C design decision below, remain planned.

## Problem

Steps (measured):

1. Type `X`.
2. Pause 500–600 ms.
3. Type `Q`.
4. Wait 2.5 s.
5. Press Ctrl+Z.

What happens:

- The webview syncs to the host every 250 ms (`edit-sync.ts:758`), so the host receives **two** edits.
- Vditor records **one** undo entry covering both.
- On Ctrl+Z, the webview shows `delta.`, but native undo on the host reverts only the last edit, leaving `delta.X`.
- `HistoryCouplingController` accepts the native result whenever the host started at the transition's "before" text (`history-coupling.ts:55-73`). It then absorbs the webview's next edit message (`:87-100`).
- Result: the editor shows `delta.` while the document holds `delta.X`.
- Ctrl+S reconciles: disk becomes `delta.` and the document is clean.

With a 50 ms gap between keys, the host receives one edit, and Undo is correct.

This affects every undo step today. Once Task 598 lands, it also affects the first step.

## Design space (the implementer measures and chooses; the owner approves)

- **A. Verify after native undo.** After native undo, the host compares its text with the transition's `after` text. If they differ, it applies a corrective edit that replaces the difference, grouped into the same undo stop where possible. Alternatively, it repeats native undo until the host reaches `after`, if that can be done safely.
- **B. Align host undo stops with Vditor checkpoints.** The webview marks checkpoint boundaries, and the host merges the intermediate edits into one undo stop (for example with `undoStopBefore/After` on the `WorkspaceEdit` path).
- **C. Webview-authoritative Undo.** The host applies the transition's `after` text as one edit instead of running native undo. This changes the Task 463 design and needs an explicit owner decision.

Criteria for choosing:

- exact host bytes after Undo and Redo;
- the dirty flag returns to clean at the saved state;
- VS Code's native undo from the text editor still behaves;
- no feedback loop;
- exact behaviour with CRLF documents.

## Owner decisions needed

1. Which design (A, B or C)? The investigation recommends a measured comparison of A and B first; C is a design change.
2. Should Redo be covered with the same guarantee? (Recommended: yes.)

## Tests

- **Vitest** (`history-coupling.test.ts`, host side):
  - a transition whose native result differs from `after` is corrected;
  - the dirty flag is correct at the saved state;
  - no second correction for an already-consistent result.
- **Real VS Code** (XTEST, new spec `test/vscode-e2e/undo-host-coupling.spec.ts`):
  - Gaps of 50, 300, 600 and 1200 ms between `X` and `Q`, then Undo and Redo.
  - Assert the host equals the webview `getValue()` exactly after each step, and `isDirty` matches the saved state.
  - Save and reopen: the disk bytes are exact.
  - Also test a CRLF fixture.

## Acceptance

- [ ] After any Undo or Redo, host text equals webview text exactly, whatever the typing rhythm.
- [ ] The dirty flag and disk bytes after save and reopen are exact.
