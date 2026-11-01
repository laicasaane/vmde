# Task 696 — Source Rewrap Document does not apply after a direct open

**Status:** done (2026-11-02).
**Origin:** Task 684 (Part 2 step 1, cell `rewrap-document-sv-direct`).
**Severity:** medium (estimated; Rewrap Document in Source mode silently does nothing on a document opened directly in Source).
**Tech stack:** `media-src/src/editing/rewrap-command.ts` (`documentTarget`, the line-based caret mapping), `media-src/src/boot/main.ts` (Rewrap Document wiring), `test/vscode-e2e/exact-authority-other-actions.spec.ts` (`rewrap-document-sv` cells).
**Depends on:** Task 684 (adds the measuring cells).

## Problem

In Task 684's real-VS-Code measurement, Rewrap Document in Source mode applies after a switch from another mode but not after a direct open in Source. The direct-open cell fails before its Undo step: the host keeps the typed state, the result differs from the intended exact text, and the one Undo then removes the typed character instead of a rewrap.

Unmeasured hypothesis: after a direct open, Vditor renumbers the list and appends one line break to the Source text, so the line-based caret mapping in `documentTarget` returns no target and the command fails closed. This is the same family as Task 675's relation defect.

## Proposed work

1. Probe which gate returns no target after a direct open, with the switch case as the positive control.
2. Fix with a failing test first, keeping the Task 606/607 proof rules.
3. Re-enable the `rewrap-document-sv` direct-open cell.

## Acceptance

- [x] The failing gate is measured and recorded.
- [x] Rewrap Document applies after a direct open in Source, and one Undo restores the typed state.
- [x] A Vitest case fails before the fix and passes after it.
- [x] The `sv:` test of `exact-authority-other-actions.spec.ts` passes with the direct-open rewrap cell enabled.

## Tests to write

- A Vitest case for the caret mapping after the direct-open normalization.

## Part 1 handoff (2026-11-02)

Part 1 read source, tests, git history and done task records only. Nothing was built or run.

### Problem restated

After a document is opened directly in Source mode, `vmde.rewrapDocument` changes nothing: the host keeps the typed state, so the `rewrap-document-sv-direct` cell fails before its Undo step. The same command applies after a switch from IR to Source (`rewrap-document-sv-switch` passes).

### Root-cause hypothesis (source evidence, not yet measured)

The Task 684 hypothesis (the line mapping in `documentTarget` returns no target) is unlikely. `mapCaretOffsetByLine` (`media-src/src/editing/rewrap-command.ts:191-241`) returns `null` only when the source text has no line at all; on a missing line it falls back to the next or previous matching line, or to a clamped offset. So `documentTarget` (`rewrap-command.ts:862-889`) cannot fail at `:879` for this document.

The more likely gate is earlier, at prepare time:

1. The host command posts `prepare-rewrap-document`; the webview runs `prepareDocumentRewrap` (`media-src/src/boot/main.ts:258-263`), which captures the caret with `captureRewrapSourceSelection(window, { proofOnly: true })` before EditSync flushes the typing (`media-src/src/bridge/edit-sync.ts:1531-1536`).
2. In Source mode `captureRewrapSourceSelection` (`rewrap-command.ts:632-642`) uses the legacy marker capture `captureRewrapSourceRange` (`rewrap-command.ts:485-525`). With no supplied authoritative text it compares the capture with `vditor.getValue()` and returns the selection only on strict equality (`rewrap-command.ts:524`). In Source mode the capture's text is the editor's `textContent` (`serializeForMode`, `rewrap-command.ts:387-397`).
3. Task 675 (Decision D1) measured Vditor's Source `getValue()` as `code160to32(`${textContent}\n`.replace(/\n\n$/, '\n'))`. After a switch the editor text ends with a line break and `getValue()` equals it. After a direct open the editor text ends in U+200B and `getValue()` adds one line break, so the equality at `:524` fails and the capture is `null`.
4. `runDocumentRewrap` (`main.ts:279-289`) passes that `null` to `runRewrapDocumentCommand`; `documentTarget` takes a defined `null` capture as final (`rewrap-command.ts:867-871`) and returns no target, so the command fails closed. The host then answers the typing flush with `rewrap-document` (`src/session/editor-session.ts:603-605`) but nothing is applied.

The renumbered list (`4. beta` against the host's `5. beta`) is not the cause: the caret line is the unique Rewrap paragraph, and the switch case also differs from the host text (Lute table padding, renumbered list) and passes.

### Shared interfaces and invariants

- Task 606 proof rules: IR and WYSIWYG Rewrap and Rewrap Document capture only through `captureProvenSelection` (`rewrap-command.ts:574-620`). No change reaches that path, `provenDocumentTarget` or `proofSourceFor`.
- Task 607 rules: Rewrap Document plans on the host-sent text and its exact post names that text as `before` (`documentTarget` sets `hostBefore`; `syncExactHistory`, `main.ts:383-411`). Unchanged.
- The Source capture must still prove it describes the current Source text. Only Vditor's own `getValue()` transform (one appended line break when the text does not end with one, U+00A0 read as a space) is accepted; any other difference still returns `null`.
- Other Source callers of `captureRewrapSourceRange` (Details, links, anchors, emoji, math, Turn Into, id insertion) keep strict equality.
- The history pair is already recorded in `getValue()` form for Rewrap Document (`renderedBeforeMarkdown = vditor.getValue()` at the first checkpoint, `afterRendered = vditor.getValue()` in `syncExactHistory`), so the Task 684 Undo/Redo replay needs no change.

### Intended solution

In `captureRewrapSourceRange`, when strict equality fails, also return the capture when all of these hold: `options.proofOnly` is set, the mode is Source (`inner.currentMode === 'sv'`), no `authoritativeMarkdown` was supplied, and Vditor's Source value formula applied to `mapped.markdown` equals `getValue()`. The formula is a small local pure function in `rewrap-command.ts` (append `\n`, collapse a final `\n\n` to `\n`, map U+00A0 to a space), with a one-line comment naming Task 675 D1 and this task. The returned selection keeps its `textContent` form; `documentTarget` maps its caret onto the host-sent text as before.

### Affected paths

- `media-src/src/editing/rewrap-command.ts` (`captureRewrapSourceRange` and one local helper).
- `media-src/src/editing/rewrap-command.test.ts` (new `describe` block).
- `test/vscode-e2e/exact-authority-other-actions.spec.ts` (`openModes`, `:1130-1136`: run both open modes for `rewrap-document-sv`; remove the Task 696 comment).
- Probe only, not committed: `test/vscode-e2e/rewrap-document-sv-direct-spike.spec.ts` (a `*spike*` file, excluded from the default suite; delete after recording).

### Part 2 steps (Light: one probe step, one merged RED+fix step, closure)

- **P2-1 probe (real VS Code).** Owned file: the spike spec above. Using the shared kit as the `sv:` test does, open the `sv` document of `exact-authority-other-actions.spec.ts` once by a switch and once directly (`openDocument(..., 'sv', { direct })`), type one character as `actionAfterTyping` does, place the caret as `runSvCommand` does (`rewrapword`, offset 2, then `selectionchange`), and in the webview frame read: `window.__vmdeCaptureRewrapSelectionForTest()`, the last 4 characters of the Source editor's `textContent` and of `window.vditor.getValue()` (as code points), and whether `textContent === getValue()`. Commands: `node build.mjs`, then `vscode-run.sh 696 env -u ELECTRON_RUN_AS_NODE xvfb-run -a sh -c 'openbox & OB=$!; VMDE_XTEST=1 npm --prefix test/vscode-e2e test -- rewrap-document-sv-direct-spike.spec.ts --workers=1 --retries=0; R=$?; kill $OB; exit $R'` (foreground, `timeout 3600`), log in `tmp/696/p21-probe.log`. Positive control: the switch open returns non-null offsets and equal texts. Decision rule: direct open returns `null` and its text ends in U+200B with `getValue()` one line break longer: the gate is confirmed, go to P2-2. Direct open returns non-null offsets: the gate is downstream (`documentTarget` mapping, `rewrapMarkdownDocument` `changed: false`, or `replaceSvMarkdownRange`); stop and report the readings, do not fix. Switch open returns `null`: instrument invalid, report. Record the result in this file and delete the spike spec.
- **P2-2 RED+fix (Vitest).** Owned files: `media-src/src/editing/rewrap-command.ts`, `media-src/src/editing/rewrap-command.test.ts`. Add `describe('Source-mode Rewrap Document after a direct open (Task 696)')` with a Source editor stub in the style of `Source-mode Rewrap authoritative text` (`rewrap-command.test.ts:826`): `textContent` is the Source text of a long paragraph plus `4. beta` ending in `\n\n​`, `getValue` is stubbed with Vditor's formula, and the host text is CRLF with `5. beta`. Cases: (1) `applies Rewrap Document when the Source text ends in a zero-width space`: the `proofOnly` capture is non-null, `runRewrapDocumentCommand(window, deps, host, prepared)` returns `true`, `syncExact` receives the rewrapped host text and `hostBefore === host`; (2) `declines a Source capture that differs from getValue() other than by Vditor's formula`: `getValue` returns the text with one changed word; the capture is `null` and the run returns `false`. Run RED first and show the output (expected: case 1 fails, capture `null`; case 2 passes), then apply the intended solution. Checks: `npx vitest run --config test/vitest.config.mts media-src/src/editing/rewrap-command.test.ts media-src/src/editing/rewrap-non-round-trip.test.ts` (all pass), `npm run typecheck`, `npx biome check` on the two files.
- **P2-3 closure.** Owned files: `test/vscode-e2e/exact-authority-other-actions.spec.ts` (`openModes` only) and this record. Checks: `npm run typecheck:vscode-e2e`; `node build.mjs`; wrapper run of `exact-authority-other-actions.spec.ts -g "sv:"` with `--workers=1 --retries=0` (expected: every `sv:` cell passes, including `rewrap-document-sv-direct`: the action applies, only its span changes, one Undo restores the typed state, Redo and Save hold); quality stages one by one per DEVELOPMENT.md (audit omitted by the queue rule).

### Edge cases

- Switch open (text already ends in a line break): strict equality still applies first; behavior unchanged (covered by the `-switch` cell).
- U+00A0 in the Source text: accepted by the formula (Vditor reads it as a space); the caret maps by line onto the host text, and a line that differs only by U+00A0 falls back to the neighbor line mapping. Caret placement only, no bytes.
- Caret on the trailing U+200B line: no host line matches; `mapCaretOffsetByLine` falls back to the previous line's end. Caret placement only.
- A stale or otherwise different capture: refused (P2-2 case 2).
- `authoritativeMarkdown` supplied, or a caller without `proofOnly`: strict equality, unchanged.
- IR and WYSIWYG: never reach this branch (`proofOnly` routes them to the proven capture).

### Focused checks and expected outcomes

- P2-1 probe: direct open capture `null`, switch open capture non-null (confirms the gate).
- Vitest `rewrap-command.test.ts`: case 1 fails before the fix, passes after; case 2 passes before and after; existing cases unchanged.
- Real VS Code `exact-authority-other-actions.spec.ts -g "sv:"`: all cells pass with the direct-open Rewrap Document cell enabled.

### Tier

**Light.** One guard in one product function, with a pure helper, one Vitest block and a one-line spec change. The hypothesis has direct source evidence and a measured cause in Task 675 D1; the probe only confirms it.

### Provisional decisions

- **Provisional decision (2026-11-02), reversible: fix shape.** Accept Vditor's Source value formula in the Rewrap Document Source capture only (`proofOnly`, Source mode, no supplied authoritative text); every other caller keeps strict equality. Selected with probability 0.96. Alternatives: drop the equality for that capture (`requireExactMarkdown: false`), which loses the check that the capture is the current Source text (probability 0.01); compare in `getValue()` form for every Source caller, which changes callers outside this task (probability 0.00).
- **Provisional decision (2026-11-02), reversible: measurement.** A temporary real-VS-Code spike spec reads the production capture through the existing test hook, opened by a switch (positive control) and directly, and is deleted after the result is recorded. Selected with probability 0.99. Alternative: a Chromium probe of the webview entry, which cannot open directly in Source through VS Code's default-mode setting (probability 0.01).

### Residual risks

- If the probe finds a non-null direct-open capture, the cause is downstream and this plan stops at P2-1 for a new Part 1.
- Other Source callers of the marker capture may fail the same way after a direct open; they are outside this task and unmeasured.

## P2-1 probe result (2026-11-02)

A temporary real-VS-Code spike spec (deleted afterwards; log `tmp/696/p21-probe.log`) opened the Source document by a switch and directly, typed one character, placed the caret in the Rewrap paragraph and read the production capture through the test hook. Run exit 0, 1 passed.

| open | capture | editor text tail | `getValue()` tail | texts equal |
| --- | --- | --- | --- | --- |
| switch | offsets (68) | `\n\n` | same | yes (214 chars) |
| direct | `null` | `\n\n` + U+200B | `\n\n` + U+200B + `\n` | no (215 vs 216 chars) |

The cause is confirmed: the strict equality at the end of `captureRewrapSourceRange` fails after a direct open, so the prepared capture is `null` and the command fails closed. The switch open is the positive control.

## P2-2 RED and fix (2026-11-02)

- RED (`tmp/696/p22-red.log`): `npx vitest run --config test/vitest.config.mts media-src/src/editing/rewrap-command.test.ts -t "Task 696"` failed `applies Rewrap Document when the Source text ends in a zero-width space` with `AssertionError: expected null not to be null`; the decline case passed.
- Fix: `captureRewrapSourceRange` (`media-src/src/editing/rewrap-command.ts`) also accepts the capture when `proofOnly` is set, the mode is Source, no authoritative text was supplied and Vditor's Source value formula applied to the captured text equals `getValue()` (helper `svEditorValue`). Every other caller keeps strict equality.
- GREEN: `rewrap-command.test.ts` and `rewrap-non-round-trip.test.ts` 135 passed; `npm run typecheck` exit 0; biome clean.

## P2-3 closure (2026-11-02)

- `exact-authority-other-actions.spec.ts`: `openModes` now runs both open modes for every Source scenario (the Task 696 exclusion is removed).
- Real VS Code `-g "sv:"` (`tmp/696/p23-vscode.log`): exit 0, `cells=24 failed=0`, 1 passed; `sv:rewrap-document-sv-direct` applies, changes only its span, and one Undo and Redo hold.
- `npm run quality` (`tmp/696/p23-quality.log`): check:brand-identifiers PASS, lint:ci PASS, knip PASS, jscpd PASS, depcruise PASS, audit FAIL (omitted in this run, does not block), test:coverage PASS, check:coverage-modules PASS (9 modules at 0%, baseline 9).
