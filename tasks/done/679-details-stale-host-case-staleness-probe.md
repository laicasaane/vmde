# Task 679 — Details stale-host case may run on a resynced editor

**Status:** done (2026-11-01).
**Origin:** Task 666 (Part 1 amendment and residuals), Task 630.
**Severity:** low (estimated; the refusal may be vacuous, no product defect is known).
**Tech stack:** `test/vscode-e2e/exact-authority-other-actions.spec.ts` (`STALE_DRIVERS`, `staleHostCell`).
**Depends on:** none.

## Problem

The stale-host test arms an outside edit and then triggers an action; the expected result for a stale editor is a refusal. Task 666 found that the editor can resync with the outside edit before the click, which makes a refusal check vacuous. It added a staleness probe for the bubble Link driver only: `probeStale: true` at `exact-authority-other-actions.spec.ts:836`, the `evalFrame` read of `window.vditor.getValue()` at `:828-832`, and the classification at `:897-905` (stale: `after === external`; resynced: only the action span may change). In IR and WYSIWYG the probe reported `webviewStale: false`, so the editor had resynced.

The Task 630 Details driver (`stale-host-details`, `:818-824`) has no probe. Its selection is lost when the editor re-renders, so its refusal may be vacuous for the same reason (Task 666 residual, "pre-existing test, not changed").

## Proposed work

Add a `probeStale` read to the Details driver, taken right before the Details click and reading whether the editor already shows the outside edit, and record `webviewStale` and the outcome in the result. Assert as for the bubble driver: a stale editor must refuse; a resynced one may change only its own span. If the editor is always resynced, record that the case proves "outside edit kept, only the span changed" and name the Vitest guard that proves the refusal.

## Acceptance

- [x] The Details stale case reports `webviewStale` in both modes, and its assertion follows the measured value (measured `webviewStale: true`, outcome `refused`, in IR and WYSIWYG).
- [x] A vacuous refusal can no longer pass unnoticed (the probe must run, as for the bubble case; a resynced editor must run the action and change only its span).
- [x] Test-only: no product file changes; the spec runs in real VS Code with one worker and zero retries.

## Part 1 handoff (2026-11-01)

### Findings

- Spec on `dev` `00abeca2`: `StaleDriver` (`exact-authority-other-actions.spec.ts:841-849`) already carries `probeStale?: boolean`, and `click` may resolve to `{ webviewStale }`. The bubble driver (`:861-879`) reads `window.vditor.getValue()` for the `<!-- external -->` mark right before its Link click. `staleHostCell` (`:882-968`) applies the probe assertions only to drivers with `probeStale` (`:939-950`): the action ran, the probe ran, a stale editor refused (`after === external`), a resynced one changed only its span (`rest === intended`). The Details driver (`:852-860`) has no probe and returns `undefined`, so its cell checks only that the outside edit survives and that the rest is the reference or the intended result.
- Baseline (stale-host tests only, through the real-VS-Code wrapper, one worker, zero retries; exit 0, 2 passed): `stale-host-details` reports `clicked: true`, `outcome: "refused"`, no `webviewStale`, in IR and WYSIWYG; `stale-host-bubble-link` reports `webviewStale: false`, `outcome: "rebased"`. So the Details refusal is not yet attributable: it is either a real refusal on a stale editor or a no-op on a resynced editor whose selection was lost.
- Difference between the drivers: the bubble driver focuses the editor and selects again before its click, the Details driver clicks right after the outside edit. The Details editor may therefore still be stale; only the probe can tell. The resync channel seen by Task 666 stays unidentified and out of scope.
- Refusal guard at the unit layer (exists, unchanged): `media-src/src/editing/details-toggle-controls.test.ts`, "Details toggle refuses a stale host: no write, rollback runs, the DOM shows the host text".

### Decisions

- **Provisional decision (2026-11-01), reversible — Details resynced-case assertion.** Set `probeStale: true` on the Details driver and reuse the existing `staleHostCell` assertions unchanged: a stale editor must refuse; a resynced editor must produce exactly the intended result (only its own span changed). If the measured run shows a resynced editor with a refusal (selection lost on re-render), the cell fails visibly; the same Part 2 step then makes the Details click select the paragraph again (focus, `selectDetailsParagraph`) before the probe, as the bubble driver does, and records that the case proves "outside edit kept, only the span changed", with the refusal proven by the Vitest guard named above. Selected by a recorded decision check (probability 0.98 against 0.01 for accepting either outcome on a resynced editor and 0.01 for always selecting again).
- **Provisional decision (2026-11-01), reversible — probe helper.** Move the bubble driver's inline read into one module-level helper, `readWebviewStale(ctx)` (resolves to `true` when `window.vditor.getValue()` lacks `<!-- external -->`), and call it from both drivers, so the two probes cannot drift and no duplicated block is added. Settled from the source (no alternative changes the result).
- **Provisional decision (2026-11-01), reversible — no new Vitest guard.** The refusal on a stale editor is already proven by the existing Details Vitest case above; the task is test-only and adds no unit test. Settled from the source.
- No public names, numbering, compatibility rules or storage formats are involved beyond the test-local helper name and the existing result field `webviewStale`.

### Acceptance to test map

| Acceptance item | Layer | File | Test, cell |
| --- | --- | --- | --- |
| 1. `webviewStale` reported in both modes; assertion follows it | Real VS Code | `test/vscode-e2e/exact-authority-other-actions.spec.ts` | `ir: an outside edit the webview never saw is not overwritten by a following action` and `wysiwyg: …`, cell `stale-host-details`: result has a boolean `webviewStale`, and the `probeStale` branch asserts refused (stale) or intended (resynced) |
| 2. A vacuous refusal cannot pass unnoticed | Real VS Code | same | same cells: `the staleness probe did not run` and `the action never ran` checks now apply to Details; a resynced refusal fails `a resynced editor changed more than its span`. RED evidence: the baseline Details result above has no `webviewStale` |
| 3. Test-only; one worker, zero retries | Diff and run | same | `git diff --stat` lists only the spec and this record; the run command uses `--workers=1 --retries=0` |

Edge cases and cheapest layer: the probe read itself must not change the editor (read-only `getValue`, real VS Code result unchanged for the bubble cell); a disabled Details button after a resync makes the click throw, which leaves `webviewStale` unset and fails `the action never ran` (real VS Code, same cell); stale refusal in isolation (Vitest guard above, already green).

### Part 2 plan (Light: one RED+fix step)

- **Step P2 (RED+fix).** Files: `test/vscode-e2e/exact-authority-other-actions.spec.ts` (Details driver gets the probe and `probeStale: true`; `readWebviewStale` helper used by both drivers; update the `probeStale` interface comment and the header line about stale-host cells), this task record (progress, acceptance, verification), `tmp/679/step-P2-report.md`.
- Checks: `npm run typecheck:vscode-e2e` exits 0; `npx biome check test/vscode-e2e/exact-authority-other-actions.spec.ts` exits 0; `timeout 900 node build.mjs` exits 0; then, through the real-VS-Code wrapper, `exact-authority-other-actions.spec.ts -g "outside edit" --workers=1 --retries=0`. Expected: 2 passed, `stale-host-details` reports a boolean `webviewStale` in both modes with `refused` when true. If it reports `webviewStale: false` with `refused`, apply the contingency of the first decision and rerun the same command once (expected `rebased`). Finally run the whole spec once with the same flags (expected 4 passed) to show the other cells are unaffected.

## Part 2 result (2026-11-01)

- RED evidence: before the change the Details result carried no `webviewStale` field (IR and WYSIWYG, outcome `refused`), so a refusal on a resynced editor could not be told apart from a real one. The first run after adding the probe also showed why the value must survive a failed click: in IR the Details button click timed out (`locator.click: Timeout 5000ms exceeded.`) and the probe value was lost with it, which failed the case.
- Change (test only, `test/vscode-e2e/exact-authority-other-actions.spec.ts`): one shared `readWebviewStale` read used by the Details and bubble drivers; drivers report the probe through a `reportStale` callback before the click, so it survives a click that fails on a disabled control; the Details driver sets `probeStale`. Assertions: the probe must have run; a stale editor must leave the outside edit untouched (a disabled control counts as a refusal); a resynced editor must run the action and change only its own span.
- Measured: `stale-host-details` reports `webviewStale: true`, outcome `refused`, in IR and WYSIWYG, so the editor is stale at the click and the refusal is real. The resynced contingency was not needed. `stale-host-bubble-link` is unchanged (`webviewStale: false`, `rebased`).
- The refusal on a stale editor is also proven at the unit layer by "Details toggle refuses a stale host: no write, rollback runs, the DOM shows the host text" in `details-toggle-controls.test.ts`.
- Verification: `typecheck:vscode-e2e` exit 0; `biome ci` on the spec exit 0; `check:brand-identifiers` exit 0; `jscpd` exit 0; build exit 0; stale-host tests through the real-VS-Code wrapper (one worker, zero retries) 2 passed. Lint of other files, knip, dependency-cruiser and coverage are not affected by a test-only change to one spec and were not run.
- Residual: in one IR run the Details click timed out before the final run passed with the click working; the new assertions accept a disabled or unclickable control only when the probe says the editor is stale.
