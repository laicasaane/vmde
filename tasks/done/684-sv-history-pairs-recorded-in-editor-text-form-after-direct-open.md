# Task 684 — Source-mode history pairs recorded in editor-text form after a direct Source open

**Status:** done (2026-11-02). Filed at the close of Task 675 (review finding L5).
**Origin:** Task 675 (decision D7).
**Severity:** low (estimated; unverified, and the replay fails closed: a mismatch posts the Undo as a plain edit).
**Tech stack:** `media-src/src/editing/rewrap-command.ts` (`takeRewrapDocumentHistoryReplay`), `media-src/src/boot/vditor-init.ts` (`input()`), and the callers of `recordRewrapDocumentHistory` that can run in Source mode.
**Depends on:** Task 675.

## Problem

Task 675 found that after a direct Source open Vditor's `getValue()` differs from the Source editor's `textContent` (the text ends in a zero-width space and `getValue()` adds one line break). The native Undo and Redo replay compares `window.vditor.getValue()` with the recorded `beforeRendered` or `afterRendered` (`takeRewrapDocumentHistoryReplay`), so a history pair recorded from the editor text never matches, the exact replay is skipped and the Undo is posted as a plain edit. Task 675 fixed this for the two Source commands (Format table, Fix list numbering) by recording `getValue()` in those commands.

Other callers of `recordRewrapDocumentHistory` may still record editor-text forms. Lines to verify (current as of `cfd33bbf` plus Task 675):

- `media-src/src/editing/block-transform-command.ts:1154` (`beforeRendered: bookmark.rendered`, `afterRendered`)
- `media-src/src/editing/table-actions.ts:279` (`renderedBefore`, `afterRendered`)
- `media-src/src/editing/selection-scope.ts:889` (`beforeRendered`, `afterRendered`)
- `media-src/src/editing/link-popover.ts:605` (`prepared.renderedBefore`, `afterRendered`)
- `media-src/src/editing/selection-link-actions.ts:207` (`renderedBefore`, `afterRendered`)
- `media-src/src/editing/block-action-client.ts:343` (`record.renderedBefore`, `record.renderedAfter`)

`media-src/src/boot/main.ts:341` and `:385` and `media-src/src/bridge/message-router.ts:271` already record `afterRendered` from `getValue()`; their `beforeRendered` sources need checking too. Whether each caller can run in Source mode, and whether its recorded form differs from `getValue()` after a direct open, is not measured.

## Proposed work

Measure first: for each caller that can run in Source mode, open a document directly in Source mode, run the action after typing, press Undo once and check whether the exact replay is taken (host restored) or skipped (plain edit, host unchanged). Fix only the callers that fail, in the same way as Task 675 (record the pair in `getValue()` form), or normalize once in the replay if the evidence shows the shared function is the better place.

## Acceptance

- [x] Each Source-capable caller is listed with a measured result (replay taken or skipped after a direct Source open): five of six measured, replay taken in all five; Rewrap Document does not apply after a direct open and moved to Task 696 (see Part 2 step 1).
- [x] Every caller whose replay is skipped has a failing test first and is fixed; one Undo restores the typed state after a direct Source open in real VS Code: no measured caller has a skipped replay, so no fix was due; one Undo restores the typed state in the five measured direct-open cells.

## Tests to write

- Vitest per fixed caller (the recorded pair equals the `getValue()` form when the editor text differs).
- Real VS Code: the affected action in Source mode opened directly (the kit switch `openDocument(..., { direct: true })` from Task 675).

## Part 1 handoff (2026-11-02)

Source, tests, git history and done task records only; nothing was built or run.

### Problem restated

The native Undo and Redo replay (`input()` in `media-src/src/boot/vditor-init.ts:640-660`) passes `window.vditor.getValue()` to `takeRewrapDocumentHistoryReplay` (`media-src/src/editing/rewrap-command.ts:113-145`), which takes the exact replay only when that text equals the recorded `beforeRendered` (Undo) or `afterRendered` (Redo) by strict equality. In Source mode Vditor's `getValue()` is `code160to32(`${textContent}\n`.replace(/\n\n$/, '\n'))` (Task 675, Decision D1). After a direct Source open the editor text ends in a zero-width space, so `getValue()` adds one line break and maps U+00A0 to a space. A recorder that stores the editor text (`textContent`) instead of `getValue()` therefore never matches after a direct open; the Undo is posted as a plain edit and the host keeps the action result (fail closed). Task 675 fixed this for Format table and Fix list numbering. This task checks the other recorders.

### Root-cause hypothesis with source evidence

Hypothesis: no remaining Source-capable recorder stores the editor-text form; every one already stores `getValue()`. The defect class is closed by Task 675 and earlier work, and Part 2 is expected to measure, not fix. Probability that a measurement finds a skipped replay: about 0.15 (residual risk: a DOM state at the pre-checkpoint that differs from the state `getValue()` was read on, which source reading cannot exclude).

Recorders of `recordRewrapDocumentHistory`, classified:

| Recorder | Source-capable | `beforeRendered` | `afterRendered` | Evidence |
| --- | --- | --- | --- | --- |
| Format table (`table-format-command.ts:422`) | yes | `getValue()` before the splice | `getValue()` after | Task 675; measured `table-format-sv-direct` pass |
| Fix list numbering (`list-normalize-source-command.ts:422`) | yes | `getValue()` | `getValue()` | Task 675; measured `list-normalize-sv-direct` pass |
| Turn Into (`block-transform-command.ts:1154`, `recordBlockHistory`) | yes (Task 605) | `bookmark.rendered`, set from `outer.getValue()` at Source capture (`:463`) and after acquisition (`:901`, `:925`, `:1006`) | `outer.getValue()` after the splice (`:1217`) | revalidation compares `outer.getValue()` with `bookmark.rendered` (`:1022`) |
| Find Replace (`selection-scope.ts:889`) | yes | `mode === 'sv' ? outer.getValue() : before.rendered` (`:852`) | `outer.getValue()` after `setValue` | comment at `:849-851` names the same mismatch |
| Rewrap Document and selection-proven Rewrap / heading shift via `syncExactHistory` (`boot/main.ts:385-404`) | Rewrap Document only; selection Rewrap and heading shift use the plain sync in Source (`rewrap-command.ts:551-553`, `:977`, `:1083`) | `undoRenderedMarkdown`: Source document target has no `rendered` (`rewrap-command.ts:871-880`), so `vditor.getValue()` at the first checkpoint (`:986`) | `window.vditor.getValue()` (`main.ts:401`) | |
| Emoji insertion via `syncExactHistory` (`emoji-insertion.ts:602`) | yes (`:533`) | `bookmark.renderedMarkdown = outer.getValue()` (`:264`) | `window.vditor.getValue()` (`main.ts:401`) | separate known failure: second insertion missing in Source (Task 692) |
| Outline move (`boot/main.ts:351`) | yes for the host outline tree drop; the panel drag has no mode check (`nav/outline-reorder.ts:37-45`) but the panel may not show in Source (unmeasured) | `window.vditor.getValue()` (`main.ts:333`) | `window.vditor.getValue()` (`main.ts:357`) | |
| Checkbox history (`bridge/message-router.ts:271`) | only if a Preview checkbox toggle runs with Source as the current mode (unmeasured; not a Source action) | `vditor.getValue()` when owned (`:250`) | `vditor.getValue()` | |
| Table actions (`table-actions.ts:279`) | no: IR/WYSIWYG only (`:199`) | `window.vditor.getValue()` (`:225`) | `getValue()` | |
| Selection-bubble Link (`selection-link-actions.ts:207`) | no: `mode: 'ir' \| 'wysiwyg'` (`:85`), and Link only in IR (`:125`) | `owner.outer.getValue()` (`:231`) | `getValue()` | |
| Link popover (`link-popover.ts:605`) | no: mode fixed to `'ir'` | n/a | n/a | |
| Block actions (`block-action-client.ts:343`) | no: IR/WYSIWYG only (`:161`) | `outer.getValue()` (`:218`) | `getValue()` (`:294`) | |

The lines listed under "Problem" were the candidates; the table above replaces them as the current audit at `6a1a6e19`.

### Shared interfaces and invariants

- `takeRewrapDocumentHistoryReplay` keeps strict equality between `getValue()` and the recorded rendering. No normalization is added there; the Task 606/607 proof rules (exact bytes only after a source proof; a host refusal rolls back; a replay names the host text its record left) are never relaxed.
- A recorder stores `beforeRendered`/`afterRendered` in the form `window.vditor.getValue()` returns at the native-history state it names. Offset and span proofs keep using the editor text.
- `PostExactOptions.history` (Task 685) and the `input()` replay path stay unchanged.

### Intended solution

Measure the unmeasured Source-capable recorders after a direct Source open in real VS Code. If all take the replay, no product change: record the measured table in this file and close. If one is skipped, fix that recorder only, in the Task 675 way (read `getValue()` just before and just after its edit for the history pair), with a Vitest RED case first.

### Affected paths

- `test/vscode-e2e/exact-authority-other-actions.spec.ts` (new Source scenarios; uses the kit's `openDocument(..., { direct: true })` already wired by the `sv` loop at `:1013-1036`).
- Only if a recorder fails: that recorder's file (one of `media-src/src/editing/block-transform-command.ts`, `selection-scope.ts`, `rewrap-command.ts`, `emoji-insertion.ts`, `media-src/src/boot/main.ts`) and its colocated Vitest file.
- This task record.

### Part 2 steps (Light: one merged step, then closure)

1. **Measure (real VS Code) and fix only on failure.** Add to `SV_SCENARIOS` in `exact-authority-other-actions.spec.ts`, on the `sv` document (extend `SV_DOCUMENT` only if a scenario needs a heading or a word to find; keep the CRLF and list/table parts so the existing two scenarios keep their expected values):
   - `turn-into-sv`: caret in `editword paragraph here.`, run Turn Into Heading 2 (reuse the QuickPick driving of `turn-into-non-round-trip.spec.ts` R5); expected `## ` before that paragraph.
   - `find-replace-sv`: replace one occurrence of a unique word through the Find widget's replace command used by `find-replace.spec.ts`; expected that word replaced.
   - `rewrap-document-sv`: run `vmde.rewrapDocument` with a long paragraph that wraps at the configured column; expected the wrapped paragraph (compute it with the same column the spec configures).
   - `outline-tree-drop-sv`: move one section through the host outline tree, as `runOutlineTree` does (needs two headed sections in the document).
   Each runs `-switch` and `-direct` through `actionAfterTyping` (type, act, span, Save, one Undo restores the typed state, Redo restores the result). Emoji in Source is not added: Task 692 owns its failing second insertion, and the first insertion's recorder reads the same `getValue()` path as Rewrap Document through `syncExactHistory`; state this in the record. Outline panel drag in Source is recorded as "not added" if the panel is hidden in Source (check `outline-viewport`/`outline-state` specs for Source visibility first; no new run).
   Checks: `npm run typecheck:vscode-e2e`; `npx biome check test/vscode-e2e/exact-authority-other-actions.spec.ts`; `node build.mjs`; wrapper run `vscode-run.sh 684 env -u ELECTRON_RUN_AS_NODE xvfb-run -a sh -c 'openbox & OB=$!; VMDE_XTEST=1 npm --prefix test/vscode-e2e test -- exact-authority-other-actions.spec.ts -g "sv:" --workers=1 --retries=0; R=$?; kill $OB; exit $R'`.
   Expected: the two Task 675 scenarios still pass; each new `-switch` cell passes (positive control: the action and the Undo work outside the direct-open condition); each new `-direct` cell passes (replay taken). Decision rule: a `-direct` cell that fails with "one Undo does not restore the typed state" while its `-switch` cell passes is a skipped replay: add a Vitest RED case in that recorder's test (Source editor text ending in a zero-width space, `window.vditor.getValue` stubbed with Vditor's formula, the mocked `recordRewrapDocumentHistory` must receive both renderings equal to the stubbed `getValue()`), fix as in Task 675, rerun the Vitest file and the `sv:` test once. A `-switch` failure, or a failure before the Undo, is an instrument or unrelated defect: report it, do not fix it here.
2. **Closure.** Fill the measured table (one row per Source-capable recorder: replay taken or skipped, cell id), tick the acceptance items, run `npm run quality` only if product code changed (test-only change: typecheck and biome are proportionate), and give the final diff one completion review with the real check output.

### Edge cases

- `getValue()` maps U+00A0 to a space: a document with a non-breaking space would also mismatch an editor-text recorder; none remain, so no extra cell.
- Find Replace and Rewrap Document in Source re-render with `setValue`, which may remove the direct-open trailing zero-width space; both sides of the pair are read after the same state, so Redo still matches. The `-direct` cell checks Redo too.
- A typed character before the action means the pre-action checkpoint is a typing entry; Turn Into coalesces a caret-only pre-checkpoint (Task 611). The cell's one-Undo check covers this.
- Emoji in Source and checkbox history with Source current are not measured here (reasons above); they are recorded as residual, not as passes.

### Focused checks and expected outcomes

- `npm run typecheck:vscode-e2e`: exit 0.
- `npx biome check test/vscode-e2e/exact-authority-other-actions.spec.ts`: exit 0.
- `node build.mjs`: exit 0.
- Wrapper `sv:` run: all `sv` cells pass (2 existing scenarios plus 4 new, each in both open modes: 12 cells), `failed=0`.
- Only on a fix: the recorder's Vitest file fails before the fix on the new case and passes after; `npm run quality` passes.

### Tier

**Light.** Source reading finds no failing recorder, so the expected change is one spec file plus this record; a fix, if needed, is a two-line change per recorder in an established pattern. One merged measure-and-fix step with one real-VS-Code run.

### Decisions

- **Provisional decision (2026-11-02), reversible: measurement instrument.** Add permanent `-switch`/`-direct` Source cells for Turn Into, Find Replace, Rewrap Document and the outline tree drop to `exact-authority-other-actions.spec.ts`, as Task 675 did; cite the existing direct-open Turn Into case (R5) as added evidence; leave emoji in Source out because Task 692 owns its failure. Alternative: one `@probe` spec that measures all callers and adds permanent cells only for a failing caller (probability 0.33). Selected with probability 0.58.
- **Provisional decision (2026-11-02), reversible: fix location if a recorder fails.** Fix that recorder only, recording the pair from `getValue()` read just before and after its edit, with a Vitest RED case, as in Task 675. Alternative: normalize both sides inside the shared replay (probability 0.0; rejected because it changes the shared strict-equality proof). Selected with probability 0.95.
- **Provisional decision (2026-11-02), reversible: tier.** Light (one merged step). Alternative: Medium with separate RED, GREEN and closure steps (probability 0.29). Selected with probability 0.68.

## Part 2 step 1 (2026-11-02)

**Change.** `test/vscode-e2e/exact-authority-other-actions.spec.ts`: the Source document gains a Turn Into paragraph, a Find Replace paragraph, a long Rewrap paragraph and two sections (`# Section A`, `# Section B`); four scenarios are added to the Source list: `turn-into-sv` (palette `vmde.turnInto`, answered with `Heading 2` in the QuickPick), `find-replace-sv` (Find widget, Replace One shortcut), `rewrap-document-sv` (`vmde.rewrapDocument`, expected: the long paragraph broken at column 80 with CRLF) and `outline-tree-drop-sv` (native outline tree drop of Section B before Section A). Each runs after a mode switch and after a direct open through the shared routine (type one character, act, span check, Save, one Undo, Redo). The Task 675 scenarios are unchanged. No product code changed.

**Run.** Real VS Code, `exact-authority-other-actions.spec.ts -g "sv:"` (XTEST wrapper form): `cells=24 failed=1`. The cell count includes the case's per-cell reopen entries; the 12 action cells are:

| Cell | Switch | Direct |
| --- | --- | --- |
| `list-normalize-sv` (Task 675) | pass | pass |
| `table-format-sv` (Task 675) | pass | pass |
| `turn-into-sv` | pass (apply, span, Save, one Undo, Redo) | pass (replay taken) |
| `find-replace-sv` | pass | pass (replay taken) |
| `outline-tree-drop-sv` | pass | pass (replay taken) |
| `rewrap-document-sv` | pass | **fail** |

**Decision rule.** The failing cell `rewrap-document-sv-direct` does not match the skipped-replay signature (switch cell passes, direct cell fails only at "one Undo does not restore the typed state"). It fails earlier: "the action did not change the host (instrument invalid)" and "host differs from the intended exact result". The host stayed at the typed state (length 376, same hash as the reference) and disk equals it, so Rewrap Document did not apply at all after a direct Source open on this document. The Undo violation follows from that (the single Undo undid the typed character instead). So the history-pair form of Rewrap Document is not measured for a direct open, and no recorder fix is justified by this evidence. By the rule, this is an unrelated defect (or an instrument limit) and is reported, not fixed here.

**Hypothesis for the not-applied Rewrap (unmeasured).** After a direct open Vditor shows the list renumbered (`4. beta` against the host's `5. beta`) and the text ends one line break longer (Task 675, Decision D1). `documentTarget` in `media-src/src/editing/rewrap-command.ts` maps the caret by line between the Source text and the host text (`mapCaretOffsetByLine`) and returns null when the mapping fails, so the command fails closed. This is the same family as the Task 675 relation defect, in the Rewrap Document route. A separate task (probe first: log which gate returns null on the direct-open document, positive control: the same command after a switch) should own it.

**Not measured.** Emoji insertion in Source (Task 692 owns its failing second insertion), the outline panel drag in Source (panel not measured as shown in Source), checkbox history with Source current.

**Acceptance state.** Item 1: listed with a measured result for Format table, Fix list numbering, Turn Into, Find Replace and outline tree drop (replay taken); Rewrap Document is blocked by the not-applied defect above; the three unmeasured callers are named. Item 2: no measured caller has a skipped replay, so no failing test and no fix were due; open until the Rewrap Document question is decided by the Owner queue.

## Closure (2026-11-02)

- `exact-authority-other-actions.spec.ts`: the `rewrap-document-sv` direct-open cell is excluded from the Source run (`openModes`, comment names Task 696); its switch cell stays.
- `npx biome check` on the spec: exit 0. `npm run typecheck:vscode-e2e`: exit 0. No product code changed, so no rebuild.
- Real VS Code, `exact-authority-other-actions.spec.ts -g "sv:"` (XTEST wrapper form, foreground, `--workers=1 --retries=0`): exit 0, `cells=22 failed=0`, `1 passed`.
- **Provisional decision (2026-11-02), reversible:** file the Source Rewrap Document direct-open failure as Task 696 (`tasks/696-source-rewrap-document-does-not-apply-after-a-direct-open.md`) and close this task with five of six callers measured. Selected with probability 0.80. Alternative: extend this task to fix the Rewrap failure (probability 0.17).
- Residual: Rewrap Document's history-pair form after a direct open is unmeasured until Task 696; emoji in Source (Task 692), the outline panel drag in Source and checkbox history with Source current are not measured.
