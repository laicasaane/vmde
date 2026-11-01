# Task 676 — Redo after an outline section move does not reapply the move

**Status:** done (2026-11-01).
**Origin:** Task 669 (step B2).
**Severity:** medium (estimated; Undo works, Redo leaves the original order).
**Tech stack:** `media-src/src/nav/outline-move-routes.ts`, `media-src/src/boot/main.ts` (outline wiring), `src/session/editor-session.ts`, `test/vscode-e2e/outline-reorder.spec.ts`.
**Depends on:** none.

## Problem

In IR, after a webview outline drag or an outline-tree move of a section, one Undo restores the original order, but Redo (VS Code's redo key) leaves the host text in the original order. `outline-reorder.spec.ts:15` fails at `:108` and `outline-reorder.spec.ts:187` at `:276` (OS keys). Measured on unchanged `dev` before Task 668 integrated (`90611a6b`) and again after Tasks 667 and 669 (`5aaf5d16`), with the same message: the expected `# B` section first is not restored.

## Proposed work

Find where Redo loses the exact-history transition that the outline routes record (the host-planned handshake of Task 630, the native Undo record committed by the webview route), and make Redo reapply the move exactly once, with the host, the editor text and the saved bytes agreeing. Keep the stale-drop protections of Task 668.

## Tests to write

- Vitest for the history transition of the outline route (record, undo, redo) in the route's testable state machine.
- Real VS Code: keep `outline-reorder.spec.ts:15` and `:187`, which must pass.

## Part 1 handoff (2026-11-01)

### Root cause (measured)

Measured on unchanged `9c0259f7` with a baseline run of `outline-reorder.spec.ts` (both tests fail: `:15` at `:108`, `:187` at `:276`) and with scratch probes under `tmp/676/` that log the webview's undo stacks and messages and, in an instrumented scratch copy of the built extension, every host history-coupling decision.

1. The spec drags right after the editor is ready. At that moment the IR undo stack is still empty (Vditor's first snapshot timer has not run, and no user action seeded it).
2. The outline route's `applyLocal` (`media-src/src/boot/main.ts:320-336`) runs `checkpointEditorUndo` (the first entry of an empty stack; since Task 641 its history base is read later, in an idle period), then `setValue(after)`, then `checkpointEditorUndo` again. The second `addToUndoStack` wrapper (`media-src/src/editing/undo-keybind.ts`) takes the pending base first and reads the document text, which is now the moved text.
3. The host pairs that base with its own text at that moment, which is still the original (the `apply-outline-section-move` message comes after). The host's base for `ir` is then `{ webview: moved, host: original }`, a false proof.
4. Undo works (its result is the original text, which the false base does not match). On Redo, `HistoryCouplingController.handle` (`src/writeback/history-coupling.ts`) proves the transition result (the moved text) against the original host text by the `base` proof, accepts it as already reached and runs no native Redo. The plain edit that the webview posts next (the moved text) is then consumed as a history echo, so the host keeps the original order.
5. The exact-history record of the route is not the failing part: a fast Redo cancels the Undo's pending input callback, so the record never flips to its `before` side and the Redo falls back to the plain edit, which is correct once the host's native Redo runs.

Evidence: probe log (3 of 3 runs at the spec's timing): `history-base` content is the moved text, sent before `apply-outline-section-move`; the Redo `handle` entry is followed by no native step and no `history coupling reached the transition result` line; `consumeEdit` shows `pending: { webviewContent: moved, hostContent: original }`. A probe that waits 1.5 s before the drag (the idle base is taken at open) passes. A scratch copy of the webview bundle that seeds the history (`vmdeSeedBaseline`) before the first checkpoint passed 3 of 3 probe runs (base is the original text; host Redo takes 1 native step, `proof: exact`) and passed both unchanged `outline-reorder.spec.ts` tests (`2 passed`).

### Scope and shared interfaces

- `OutlineMoveDeps` (`media-src/src/nav/outline-move-routes.ts`) gains one dependency, `seedHistory(): void`: take the editor's first undo snapshot if its history is empty, before the route mirrors the move. `prepare` calls it after the stale checks (Task 668 and Task 630 declines are unchanged and never seed) and immediately before `applyLocal`.
- `main.ts` wires it to `seedUndoBaseline(inner)` from `media-src/src/editing/undo-boundaries.ts` (the Task 598 seed: a no-op once the active mode has history; returns `false` during IME composition). Edits in `main.ts`: the `../editing/undo-boundaries` import at line 60 and the `createOutlineMoveRoutes({ ... })` object at lines 314-361. No change to `rewrap-command.ts`, `undo-keybind.ts`, the host or the protocol.
- Source-fidelity invariants kept: the host still owns the text and the plan; the history base reported for an empty stack is the text before the move; one Undo restores the original order; Redo reapplies the move exactly once through native Redo; the saved bytes are the host text.

### Decisions

- Provisional decision (2026-11-01), reversible: Redo loses the transition at the host's history coupling, because the webview reports a history base that pairs the moved text with the original host text (measured above; not a choice).
- Provisional decision (2026-11-01), reversible: fix the outline route locally with a new `seedHistory` dependency called by `prepare` before `applyLocal`, wired to `seedUndoBaseline`, selected by a recorded decision check (probability 0.99). Rejected: an inline seed in `applyLocal` only (0.01, no unit proof), a seed inside the shared `checkpointEditorUndo` (0, it would change the deferred base of host updates kept by Task 641 and touches a file of later tasks), a change detector for deferred bases in `undo-keybind.ts` (0, wider). Other VMDE actions whose first checkpoint can create the first entry of an empty history may share the latent pattern; that is not measured and is out of this task's scope (candidate follow-up).
- Provisional decision (2026-11-01), reversible: `outline-reorder.spec.ts:187`'s editor click between Undo and Redo is a product expectation, not a test defect; the test stays unchanged. Evidence: the click changed no undo or redo stack in the probe, and `:187` passed unchanged with the scratch fix.
- Provisional decision (2026-11-01), reversible: prove Redo after an outline-tree move by adding Undo and Redo steps after the tree move inside the existing `:15` test (no new VS Code boot), selected by a recorded decision check (probability 0.56; a separate test was 0.31).
- Public name: the dependency is `seedHistory`. No numbering, storage format or compatibility rule changes.

### Acceptance map

| Acceptance item | Test (layer, file, title) |
| --- | --- |
| Redo after a webview outline drag reapplies the move exactly once; host, editor and saved bytes agree | Real VS Code, `test/vscode-e2e/outline-reorder.spec.ts:15` "outline drag and Explorer controller move exact sections once and reject stale native drops" (Redo at `:108`; save and reopen at the end); `:187` "a webview section move undoes and redoes through focused X11 keys" (OS keys) |
| Redo after an outline-tree move reapplies it once | Real VS Code, `:15` with the new Undo/Redo steps after the tree move; Vitest, `media-src/src/nav/outline-move-routes.test.ts` "seeds an empty history before it mirrors the move (route b)" |
| The route's history transition (record, undo, redo) starts from a seeded base | Vitest, `outline-move-routes.test.ts` "seeds an empty history before it mirrors the move (route a)" (order `seedHistory`, `applyLocal`, `apply-outline-section-move`) |
| One Undo still restores the original order | Real VS Code, `:15` (`:106`) and `:187` (`:269`) |
| Task 668 stale-drop protections kept | Vitest, `outline-move-routes.test.ts` "a declined prepare does not seed the history" plus the existing decline tests; real VS Code, the stale-drop part of `:15` |

Edge cases and cheapest layer: empty history at the move (real VS Code `:15`, `:187`); history already seeded (Vitest: `seedHistory` is still called and the seed itself is a no-op, covered by the existing undo-boundaries tests); a stale or declined prepare (Vitest); IME composition during the move (seed refused; old behaviour, residual, not tested); route (b) Undo/Redo (real VS Code `:15`).

### Part 2 step plan

1. Step R1 (RED). Files: `media-src/src/nav/outline-move-routes.test.ts`, `test/vscode-e2e/outline-reorder.spec.ts`. Add a `seedHistory` mock that logs `seedHistory` to `setup()`; add the three Vitest tests above; add after the tree move in `:15` (after `toBe(ORIGINAL)` at `:135`): click `.vditor-ir`, `Control+z` expects `MOVED`, `Control+y` expects `ORIGINAL`. Check: `npx vitest run --config test/vitest.config.mts media-src/src/nav/outline-move-routes.test.ts`, expected: the two "seeds an empty history" tests fail because `seedHistory` is never called; the others pass. The real-VS-Code RED is the baseline failure at `:108` and `:276`.
2. Step G1 (GREEN). Files: `media-src/src/nav/outline-move-routes.ts` (the `seedHistory` dependency with its doc comment; the call in `prepare`), `media-src/src/boot/main.ts` (line 60 import of `seedUndoBaseline`; `seedHistory` in the `createOutlineMoveRoutes` object, lines 314-361). Checks: the Vitest file (all pass); `npm run typecheck`; `npx biome check` on the four files; `node build.mjs`; through the wrapper, `outline-reorder.spec.ts` with `VMDE_XTEST=1`, expected `2 passed`.
3. Step C1 (closure). Gates: `npm run lint`, `npm run typecheck`, `npm run knip`, `npm run jscpd`, `npm run depcruise`, `npm run test:coverage`, `npm run check:coverage-modules` (the audit stage is omitted by the queue rule); task record, completion report.

## Closure (2026-11-01)

### Implementation

- `media-src/src/nav/outline-move-routes.ts`: `OutlineMoveDeps.seedHistory(): void`; `prepare` calls it after the stale checks and immediately before `applyLocal`. A declined prepare returns earlier and never seeds.
- `media-src/src/boot/main.ts`: `seedHistory` wired to `seedUndoBaseline` for the live inner editor (a type cast is needed because the seed's inner type is not exported).
- Tests: `media-src/src/nav/outline-move-routes.test.ts` (route a and route b seed order; a declined prepare does not seed); `test/vscode-e2e/outline-reorder.spec.ts` (Undo and Redo after the tree move in the first test). The OS-key test is unchanged (it moved from `:187` to `:195`).

### Acceptance

- [x] Redo after a webview outline drag reapplies the move exactly once, with host text, editor text and saved bytes agreeing: `outline-reorder.spec.ts` first test (Redo step, then the save and reopen checks) and the OS-key test pass in real VS Code (`2 passed`).
- [x] Redo after an outline-tree move reapplies it once: the new Undo/Redo steps in the first test pass.
- [x] One Undo still restores the original order: both real VS Code tests.
- [x] Task 668 stale-drop protections kept: the stale-drop part of the first test passes; Vitest "a declined prepare does not seed the history" plus the existing decline tests.
- [x] Vitest for the route's history seed (route a, route b, declined prepare): `outline-move-routes.test.ts`, 22 passed. RED before the fix: 2 failed (`expected [ 'applyLocal' ] to deeply equal [ 'seedHistory', 'applyLocal' ]`).

### Verification actually run

- Real VS Code (wrapper, `VMDE_XTEST=1`): `outline-reorder.spec.ts` before the fix `2 failed` (`:108`, `:276`); after the fix `2 passed`.
- `npx vitest run` of the route test file: 22 passed.
- `check:brand-identifiers`, `lint:ci`, `typecheck`, `typecheck:vscode-e2e`, `knip`, `jscpd`, `depcruise`, `test:coverage` (383 files, 8354 passed, 1 expected fail), `check:coverage-modules` (9 modules at 0%, baseline 9): all exit 0. Dependency audits are omitted by the queue rule.
- `check:bundle-size` exits 1 on the eager bundle (`media/dist/main.js` 1092 KB of 608 KB). The bundle was already about 1118 KB before this change (about 100 bytes of difference); reporting only, not a regression of this task.

### Provisional decisions (2026-11-01), reversible

- Cause: the host history coupling accepted a false history base (moved text paired with the original host text) read after the move's `setValue` on an empty history (measured).
- Fix location: a `seedHistory` dependency on the outline route, selected by a recorded decision check (probability 0.99); not a change to the shared checkpoint helper.
- `outline-reorder.spec.ts` OS-key test's click between Undo and Redo is a product expectation, not a test defect (the test passes unchanged).
- Route (b) Redo proof by extending the existing first test, selected by a recorded decision check (probability 0.56; a separate test 0.31).

### Residuals

- An IME composition during the move refuses the seed (old behaviour; untested).
- Other actions whose first checkpoint creates the first entry of an empty history may share the false-base pattern (not measured; follow-up candidate).

### Review repair (2026-11-01)

- Test titles in the acceptance map above now match `outline-move-routes.test.ts`: "seeds an empty history before it mirrors the move (route a)", "seeds an empty history before it mirrors the move (route b)", "a declined prepare does not seed the history".
- Scope of the Vitest cases: they prove the call order (`seedHistory` before `applyLocal`) and the decline path (no seed, no apply). The mock does not model an empty history. Redo exactly once and Undo restoring the original order are proved by real VS Code: the first test in `outline-reorder.spec.ts` (`:15`, with the new Undo/Redo steps after the tree move) and the X11 keys case (`:195`).
- Residual: if `seedHistory` threw, the move would stay half-done (the host holds a binding, nothing is applied locally). It is only reachable before the editor is initialised, and `applyLocal` carries the same risk. Accepted, no change.
