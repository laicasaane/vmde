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

## Owner decisions (2026-10-07)

After the S1a baseline showed that Undo then Save writes the wrong text to disk on current `dev`:

- Priority: finish Task 602 first (remaining S1 measurements, design choice, implementation). No interim stop-gap; Tasks 596 and 603 wait.
- Scope: 602 acceptance also covers the SV case (text ends matching, but the document stays dirty and VS Code's undo history is rewritten) and the large-document case (native Redo after a wrong Undo is skipped and repaired only 1 to 2.5 s later).

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

## Execution progress

**S1a, natural baseline (2026-10-07, HEAD `d4db2abb`, Claude Opus 5.5, measurement only).**
Authority: `tmp/queue-part1/602-native-handoff.md` §1–§3. Artifacts: `tmp/task602-checks/s1a/`
(`final-report.md`, `@probe` spec, isolated config, two run directories). Real VS Code 1.129.0,
`VMDE_XTEST=1`, Xvfb + Openbox without bindings, `--workers=1 --retries=0`. Run A: IR, 1 passed.
Run B: IR, WYSIWYG, SV, large IR, large WYSIWYG, 5 passed. No product change.

- **Reproduced on HEAD, IR.** One Vditor entry spans two host writes (X published at +265 ms, XQ at
  Q + about 258 ms; checkpoint at Q + about 1,025 ms). Undo leaves the host at `delta.X` while the webview shows
  `delta.`, dirty, stable for 2.6 s. Seen at 331 and 633 ms and with CRLF (CRLF preserved), in 6/6
  journeys with that shape. The large fixture behaves the same: the host keeps the canonicalized
  document with X. Controls: 25 ms (one host write) and 1,232 ms (two entries) are exact. In run A, 2
  of the 633 ms journeys published X only with Q (one write), so Undo was exact there. Whether the
  defect appears depends on X being published before Q.
- **Save no longer reconciles.** Undo, then Save, writes `delta.X` to disk and marks the document
  clean while the editor shows `delta.`. The N9 retained pair absorbs the will-save flush; this is
  inferred from the host events. This contradicts "Ctrl+S reconciles" above.
- **Redo after a divergent IR or large Undo** skips native Redo; a plain write about 1.1–2.5 s later
  restores the text. The end state agrees, but native Redo is lost and the stability window is
  broken.
- **SV**, same shape, 5/5: the text agrees after Undo, but through native Undo, a rollback Redo and a
  plain write. The document is dirty at the saved bytes and native history is rewritten.
  `getValue()`'s trailing newline makes the start unaligned.
- **WYSIWYG small**, 0/5: it publishes inside the after-render timer, so host writes align with
  checkpoints and the defect shape cannot form. Large WYSIWYG 636 ms: Undo is exact, Redo is skipped
  and repaired by a late plain write. The first edit on an opened large WYSIWYG document uses
  `undoDelay` 800 ms, not 2,000 ms.
- **Contracts.** The handoff's source facts still hold (`history-coupling.ts` unchanged; one
  whole-document `applyEdit` per write, one native stop each). 598 makes these first edits undoable,
  so the defect reaches the first step. 601 drained nothing in 27/27 settled Undos and does not affect
  this case. B (grouping already-applied writes) and A (verify after native history, retiring N9)
  both remain applicable. S1b, S1c, S1d and S1e all remain necessary; small WYSIWYG cells are
  controls only.
- **Open for the Owner:** the higher severity (wrong bytes saved, document shown clean), and whether
  the SV dirty/history defect and the large-document Redo skip belong to this task's acceptance.

**S1b–S1e, design comparison (2026-10-07, HEAD `77850819`, Claude Opus 5.5, measurement only).**
Authority: handoff §2, §3, §5 and §6. Report: `tmp/task602-checks/comparison.md`. Per-cell coverage,
including every unrun cell: `tmp/task602-checks/matrix-coverage.txt`. The throwaway prototype was
built and run, then restored. The product files are byte-identical to HEAD and the rebuilt HEAD hashes
match S1a.

- **S1b. B is infeasible on the supported route.** `workspace.applyEdit` has no undo-stop option, and
  the extension host sends no undo group. Each write is its own closed native stop: 12 writes gave 12
  stops. Holding writes until the checkpoint, a hidden text editor, or undo-and-reapply are different
  designs, and none was run.
- **Baseline gap fill (HEAD).**
  - Webview posts are now captured (S1a's wrapper failed silently on the frozen API object). They
    confirm that the N9 pair absorbs the after-render echo.
  - The defect also reproduces on the large CRLF fixture.
  - Large SV is never coupled natively: the SV echo rewrites the authored bytes.
  - Primed large WYSIWYG (`undoDelay` 2,000 ms) publishes once per entry.
  - Native text-editor Redo after an SV Undo reaches the rewritten `T0`.
- **S1c. A1 (bounded native traversal, proved target, verified rollback).**
  - Unit model: 21/21.
  - Real VS Code: 20/20 one-entry/multi-write IR journeys exact in both directions (2, 6 and 12 native
    steps; 19–139 ms).
  - SV 8/8, CRLF and large IR/WYSIWYG/SV: clean at the saved state, native Redo kept, stable for 2.6 s.
  - Undo→Save→reopen is exact.
  - Requirements: a value-based history-base proof, the retained pair as the Redo start proof, and SV
    transitions in host form.
  - Bound 8 refused 3/3 entries of 12 writes. Bound 32 passed.
  - A publication stall (1 of 8 twelve-key journeys) left a webview entry state unpublished, so no
    native stop could reach it. A1 refused there.
- **S1d. A2 (corrective edit).** Bytes are right and Undo→Save→reopen is correct. It failed the
  decisive criteria: dirty at the saved bytes after Undo (2/2), native Redo lost (plain write at
  +1.1 s), and native text-editor history rewritten. Broader A2 runs were stopped.
- **S1e.** The recommendation is A1 with the checkpoint flush F for unpublished entries. F is unproven
  at runtime. Confidence is medium-high on the measured cells and medium overall: 32/48 A1 cells are
  unrun, and the cause of the stall is open. The Owner design decision is pending.

## Acceptance

- [ ] After any Undo or Redo, host text equals webview text exactly, whatever the typing rhythm.
- [ ] The dirty flag and disk bytes after save and reopen are exact.
