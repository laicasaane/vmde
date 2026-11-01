# Task 675 — SV exact-authority relation after a mode switch and for Source text Vditor changed

**Status:** done (2026-11-01).
**Origin:** Task 669 (steps A1b and A1c).
**Severity:** medium (estimated; the actions fail closed, so no bytes are lost).
**Tech stack:** `media-src/src/bridge/edit-sync.ts` (`projectRendered`, `provesExact`, `receiveExactAuthority`), `test/vscode-e2e/exact-authority-other-actions.spec.ts`, `test/vscode-e2e/helpers/shortcut-xtest-kit.ts`.
**Depends on:** Task 669.

## Problem

The exact SV actions (Format table, Fix list numbering, Renormalize all lists and the other exact Source-mode actions) acquire the host's exact text after typing. In Source mode the host-request relation is plain equality: `normalizeEol(exact) === rendered`. It fails in two measured cases, and then the acquisition returns nothing and the action declines with no write:

- After a switch from IR or WYSIWYG to Source mode, the Source text is Lute's serialization (a padded table, for example) while the host text stays raw. Once trusted typing has revoked the owned exact text, `receiveExactAuthority` sees `sameRendered: true`, `sameTrusted: true`, `provesExact: false`.
- On a document opened directly in Source mode, Vditor itself changes the text it shows: an ordered list `3. alpha` / `5. beta` is shown renumbered (`4. beta`) while the host keeps `5. beta`. The relation fails at that line.

Task 669 replaced the line mapping inside the SV commands with an alignment proof, but the commands are never reached in these cases. The cases `list-normalize-sv` and `table-format-sv` of the Task 630 exact-authority matrix therefore still cannot run in Source mode.

## Proposed work

Replace the equality in the Source-mode relation by a proof that accepts text Vditor or Lute changed and still refuses stale text. One candidate is the bounded alignment of Task 605 (`alignText`) between the host text and the Source text, requiring that every difference lies inside a region the commands later re-prove (normalized table padding, list numbers) and that the typed span is the only other difference. The relation must fail closed on any other difference.

Restore the Source-mode cases in `exact-authority-other-actions.spec.ts`:

- Add `'sv'` to the action loop and the scenarios `list-normalize-sv` (a misnumbered list; the command renumbers it) and `table-format-sv` (a raw CRLF table; the command formats it), on a CRLF document with a raw table and a list. Each case must apply, change only its span, restore with one Undo, and write the result on Save, like the visual-mode cases.
- Open the document in Source mode both by a mode switch and, through an opt-in switch in the shared kit (`openDocument(..., direct)` setting `vmde.editor.defaultMode` and restoring it afterwards), directly.
- Place the caret, dispatch `selectionchange` after the gesture end (the gesture end clears the retained Source selection, a real pointer gesture is followed by its own `selectionchange`), then run the command from the host.

## Tests to write

- Vitest in `edit-sync.test.ts`: a Lute-padded table, a renumbered list, a stale host text and an unrelated difference (accepted, accepted, refused, refused).
- Real VS Code: the two Source-mode cases above, in both open modes.

## Part 1 handoff (2026-11-01)

### Measured root cause

A Chromium probe (the real webview entry with a host model that applies plain edits through the minimal-diff write-back) opened the CRLF document `# SV actions` / `editword paragraph here.` / `|a| longer |`, `|:-|---:|`, `|x\|y|全角|` / `3. alpha`, `5. beta` / `Tail.`, typed one character into the paragraph and compared the Source text (as `serializeSvForHost` reads it) with the host text after `normalizeEol`. The host kept its raw bytes in every case.

- **Direct Source open.** The Source text keeps the raw table, shows `4. beta` for the host's `5. beta`, and ends with `Tail.\n\n` where the host ends with `Tail.\n` (one more trailing line break). With a consistent list (`4. beta`) the trailing line break is the only difference. This is the unmeasured cause recorded in Task 669 (A1c, "a document whose list is already consistent also did not apply"): the Task 669 probe had already logged a Source text one character longer than the host text.
- **Switch from IR to Source.** The Source text is Lute's serialization: `| a    | longer |`, `| :--- | -----: |`, `| x\|y |   全角 |`, and `4. beta`. The trailing text is equal.

In both cases the line count is the same apart from that trailing line break, and `receiveExactAuthority` refuses because `provesExact` is plain equality in Source mode. The SV commands are never reached.

### Shared interfaces and invariants

- `provesExact` (`edit-sync.ts`, about `:619`) serves `receiveExactAuthority` (about `:1314`) and the one-span rebase `rebaseOneSpan` (about `:677`). Only the host-request check in `receiveExactAuthority` changes. `provesExact`, `projectRendered`, `projectLikeHost`, `rebaseOneSpan` and every IR and WYSIWYG path stay as they are.
- The accepted pair stores the host bytes as the exact text and the live Source text as its rendering, so `exactTransactionRendered` is no longer `normalizeEol(exact)`. Later `provesExact` checks on that pair fail. The pair still holds while the Source text is unchanged (`currentPairExact` compares the rendering only), Undo back to that rendering is recalled through `remembered.rendered`, and later typing revokes the pair so the next action asks the host again. This is acceptable: it fails closed and costs one more host request.
- The SV commands still re-prove their own region after acquisition (Task 669 alignment proof, Lute `FormatStr` comparison of the table). The relation only decides whether the host text is the document the Source text shows.
- Source fidelity: the host bytes (CRLF, raw table, authored list numbers) are never replaced by Source text. Only the command's own span changes.

### Settled design

- **Relation.** A pure function `svSourceDerivesFrom(exact: string, rendered: string): boolean` in a new file `media-src/src/bridge/sv-source-relation.ts`. With `host = normalizeEol(exact)`:
  1. `host === rendered` is accepted.
  2. The rendered text may end with exactly one more `\n` than the host text, and only when the host text ends with `\n`.
  3. Otherwise both texts are split into lines and must have the same number of lines. Each line pair that differs must be one of:
     - a **table row**: both lines belong to a table block (a run of non-blank lines that all contain `|`, with a delimiter row as the block's second line in both texts); the cells, split on unescaped `|` with the optional outer pipes removed and each cell trimmed, are equal in number and text; delimiter cells are compared by alignment only (`:-`, `-:`, `:-:`, `-`);
     - an **ordered-list number**: both lines match `^( *)(\d{1,9})([.)])( .*)?$` with the same indent, delimiter and text, and the rendered number equals the rendered number of the nearest earlier ordered item with the same indent and delimiter, plus one (Vditor's sequential renumbering; a first item never differs).
  4. A differing line inside a fenced code block (``` or ~~~, tracked on the rendered text) is never accepted. Anything else refuses.
- **Use.** `receiveExactAuthority` accepts the reply when `provesExact(content, rendered)` holds or, in Source mode only, when `svSourceDerivesFrom(content, rendered)` holds. The other guards (rendering unchanged since the request, no trusted input since the request) stay.
- **Module map.** The id `sv-source-relation` joins the `bridge` entry in `scripts/module-manifest.mjs`. The import is inside the bridge module, so no new cross-module edge appears. The file imports nothing outside `bridge/` (it must not import `editing/sv-source-proof.ts`, which pulls `rewrap-command.ts`).
- **Kit.** `openDocument(kit, name, content, mode, options?: OpenOptions)` with an exported `interface OpenOptions { direct?: boolean }` (documented: open straight in `mode` through `vmde.editor.defaultMode` instead of IR and a toolbar switch). `Ctx.direct?: boolean` is stored so `recover()` reopens the same way. With `direct` and a mode other than IR, `openEditor` reads the previous user-global value (`inspect('editor.defaultMode')?.globalValue`), sets `mode`, waits for readiness in `mode` (not IR), then restores the previous value in a `finally` block (an undefined value is removed). Without `options` every one of the 23 importing specs behaves as before. `makeKit`'s own unrestored `ir` setting is not changed here (Task 682 candidate).
- **Spec.** The action loop becomes `['ir', 'wysiwyg', 'sv']`. The `sv` test runs each SV scenario twice, opened by a switch and directly (`{ direct: true }`), with cell ids `<scenario>-switch` and `<scenario>-direct` and file names to match. The SV scenarios `list-normalize-sv` and `table-format-sv` use the `sv` document from the Task 669 draft (CRLF, raw table, `3. alpha` / `5. beta`). `runSvCommand` places the caret, dispatches `selectionchange` in the webview frame (the gesture end clears the retained Source selection; a real pointer gesture is followed by its own `selectionchange`), then runs `vmde.fixListNumbering` or `vmde.formatTable` from the host. The visual-mode cases and the stale-host test stay unchanged.

### Acceptance items and their tests

1. Relation accepts Lute- or Vditor-changed Source text and refuses stale or unrelated host text: Vitest, `media-src/src/bridge/edit-sync.test.ts`, a new top-level `describe('Source-mode exact-authority relation (Task 675)')` appended at the end of the file (Task 678 only changes timeouts elsewhere in it):
   - `accepts a host text whose table Lute padded after a mode switch`
   - `accepts a host text whose ordered list Vditor renumbered on a direct Source open`
   - `refuses a stale host text that lacks the typed character`
   - `refuses a host text with an unrelated difference`
2. SV cases in the exact-authority matrix, in both open modes: real VS Code, `test/vscode-e2e/exact-authority-other-actions.spec.ts`, test `sv: each action after a typed character changes only its span, Undo restores the typed state and Save writes the result`, cells `list-normalize-sv-switch`, `list-normalize-sv-direct`, `table-format-sv-switch`, `table-format-sv-direct` (apply, change only the span, one Undo restores the typed state, Save writes the result).
3. Focused real-VS-Code spec written and run, quality stages pass: the wrapper run of the spec above (the whole file once at closure) and the quality stages run one by one except the audit stage.

### Edge cases and their cheapest layer

All in Vitest, `media-src/src/bridge/sv-source-relation.test.ts` (pure function): identical texts; one extra trailing `\n` accepted, two refused, an extra one when the host has no final `\n` refused; padded table accepted; delimiter alignment changed refused; table cell text changed refused (a character typed into a cell); whitespace added beside a pipe accepted (not meaningful in a table, recorded as accepted); a pipe line outside a table block refused; renumbered list accepted; first item number changed refused; non-sequential number refused; different delimiter refused; nested list numbered on its own indent accepted; a typed character missing in a paragraph refused; different line count (Lute collapsed blank lines) refused; a difference inside a fenced code block refused; CRLF host text handled. IR and WYSIWYG keep plain projection proof: covered by the existing Task 607 cases in `edit-sync.test.ts`.

### Part 2 step plan

- **P2-1 RED (Vitest).** Owned file: `media-src/src/bridge/edit-sync.test.ts` (append only). Add the four acceptance-item-1 cases (SV boot with an SV element whose text is the Source text, typed text published as a plain edit, then `acquireExactAuthority` and `receiveExactAuthority`). Check: `npx vitest run --config test/vitest.config.mts media-src/src/bridge/edit-sync.test.ts`. Expected: the two "accepts" cases fail (`null` instead of the host text), the two "refuses" cases pass (they guard the later change).
- **P2-2 RED (real VS Code, tests only).** Owned files: `test/vscode-e2e/helpers/shortcut-xtest-kit.ts`, `test/vscode-e2e/exact-authority-other-actions.spec.ts`. Add `OpenOptions`, `Ctx.direct` and the direct open; add the `sv` document, scenarios, `runSvCommand` and `'sv'` in the action loop with both open modes. Before writing the expected table, confirm `SV_TABLE_FORMATTED` against Lute `FormatStr` of the raw table (the Task 669 draft value was never seen applied). Checks: `npm run typecheck:vscode-e2e`; `npx biome check` on both files; `node build.mjs`; wrapper run of `exact-authority-other-actions.spec.ts -g "sv:"`. Expected: the four SV cells fail with "the action did not change the host"; the opens succeed in both modes.
- **P2-3 GREEN.** Owned files: `media-src/src/bridge/sv-source-relation.ts` (new), `media-src/src/bridge/sv-source-relation.test.ts` (new), `media-src/src/bridge/edit-sync.ts` (`receiveExactAuthority` only, plus the import), `scripts/module-manifest.mjs` (the bridge id). Checks: Vitest on `edit-sync.test.ts`, `sv-source-relation.test.ts` and `test/backend/module-boundaries.test.ts` (all pass); `node scripts/module-manifest.mjs`; `npm run typecheck`; `node build.mjs`; wrapper run of `exact-authority-other-actions.spec.ts -g "sv:"` (four cells pass).
- **P2-4 closure.** Owned files: this task record and the step and completion reports. Checks: wrapper run of the whole `exact-authority-other-actions.spec.ts` once (ir, wysiwyg, sv and the stale-host tests; known `knownUndoFailure` flags of Task 674 stay); quality stages one by one: `check:brand-identifiers`, `lint:ci`, `knip`, `jscpd`, `depcruise`, `test:coverage`, `check:coverage-modules` (audit omitted by the queue rule).

### Provisional decisions

- **Provisional decision (2026-11-01), reversible: the Source-mode relation.** A line-wise relation that accepts only table padding and delimiter dashes inside a table block, Vditor's sequential ordered-list renumbering and one extra trailing line break, and refuses every other difference (see "Settled design"). Rejected: checking the gaps of the Task 605 bounded alignment (it exposes only mapping runs and leaves large middles unmappable) and comparing Lute's formatting of both whole texts (it would accept any normalization Lute performs). Selected by a recorded decision check (probability 0.92).
- **Provisional decision (2026-11-01), reversible: where the relation lives.** A new pure file `media-src/src/bridge/sv-source-relation.ts` with its own unit tests and the id `sv-source-relation` in the bridge entry of the module map. Rejected: a local function inside `edit-sync.ts` (edge cases testable only through a booted EditSync) and a file under `editing/` (0.26). The check flagged a new dependency edge for this option; the import stays inside the bridge module, so no cross-module edge is added. Selected by a recorded decision check (probability 0.48).
- **Provisional decision (2026-11-01), reversible: the kit switch.** An options argument `openDocument(kit, name, content, mode, { direct: true })` with an exported `OpenOptions`, stored on the context for `recover()`, restoring the previous user-global `vmde.editor.defaultMode` value in a `finally` block. Rejected: a positional boolean that restores the literal `ir`, and a separate `openDocumentDirect` function. Selected by a recorded decision check (probability 0.99).
- **Provisional decision (2026-11-01), reversible: the one-span rebase stays unchanged.** `rebaseOneSpan` keeps plain projection proof, so a Source-mode pair that needed the new relation is not rebased onto unpublished typing; the action asks the host again. This follows the task's fail-closed priority and the instruction not to widen the rebase.
- **Provisional decision (2026-11-01), reversible: state after acceptance.** An accepted pair whose rendering differs from `normalizeEol(exact)` is acceptable: it holds while the Source text is unchanged, Undo recalls it, and later typing revokes it.
- **Provisional decision (2026-11-01), reversible: the spec gesture end and the two open modes.** The spec dispatches `selectionchange` in the webview frame after placing the caret, as the Task 669 draft did, and the `sv` test runs each SV scenario opened by a switch and directly in the same VS Code launch.

### Residual risks

- The expected formatted table of the Task 669 draft (`| a   | longer |`) differs from Lute's IR serialization measured here (`| a    | longer |`, `| :--- |`). P2-2 confirms the `FormatStr` result before it writes the expectation.
- Whitespace added beside a table pipe in the Source text but missing from the host is accepted. GFM ignores it, and the table command reformats that whitespace anyway.
- Lute normalizations outside the measured classes (bullet characters, blank-line collapsing, heading styles, escapes) still refuse after a mode switch. That is fail closed and outside this task's measured scope.

## Decision D1 (2026-11-01): Undo after a direct Source open

### Cause (confirmed)

After a direct Source open, one native Undo after Format table or Fix list numbering left the host at the action result; after a mode switch it restored the typed state. Vditor's Source-mode `getValue()` is `code160to32(`${sv.element.textContent}\n`.replace(/\n\n$/, '\n'))`, so it equals the editor's `textContent` only when that text ends with a line break and holds no U+00A0. A Chromium probe on the real webview measured both cases: after a switch the text ends `Tail.\n\n` and `getValue()` equals it; after a direct open the text ends `Tail.\n\n​` and `getValue()` adds one more `\n`. The two Source commands record their native-history pair from the editor text (`beforeRendered` is the retained `textContent`, `afterRendered` is derived from it; `table-format-command.ts` and `list-normalize-source-command.ts`). The Undo and Redo replay (`input()` in `boot/vditor-init.ts`) passes `window.vditor.getValue()` to `takeRewrapDocumentHistoryReplay`, which requires that text to equal the recorded rendering (`rewrap-command.ts`). On a direct open the two never match, the exact replay is skipped, the Undo is posted as a plain edit, and the host keeps the action result. The skipped replay fails closed (no wrong exact write), but acceptance item 2 requires one Undo in both open modes.

- **Provisional decision (2026-11-01), reversible: record the Source commands' history pair in the replay's form.** In the two Source commands only, record `beforeRendered` as `window.vditor.getValue()` read just before the splice (the live-text check has already proved the editor text equals the retained text) and `afterRendered` as `window.vditor.getValue()` read just after the splice, falling back to the current editor-text values when `getValue` is unavailable. Every other recorder already records `getValue()` (`boot/main.ts`, `bridge/message-router.ts`). The offset proofs keep using the editor text. Rejected: normalizing inside `takeRewrapDocumentHistoryReplay` (shared by every recorder; other tasks touch `rewrap-command.ts`) and moving direct-open Undo to a follow-up (acceptance item 2 would stay unmet). Selected by a recorded decision check (probability 1.0).

### Next step: P2-3b (one RED+fix step; show the RED output before the fix)

- **Owned files:** `media-src/src/editing/table-format-command.ts`, `media-src/src/editing/list-normalize-source-command.ts`, `media-src/src/editing/table-format-command.test.ts`, `media-src/src/editing/list-normalize-source-command.test.ts`. No other file. (Task 681 later edits `table-format-command.ts`; keep the change to the `recordRewrapDocumentHistory` call and two local reads.)
- **RED (Vitest).** In each command test, add one case: the Source editor text ends without a line break (for example `…\n​`, as after a direct open), `window.vditor.getValue` is stubbed with Vditor's formula (`` `${editor.textContent}\n`.replace(/\n\n$/u, '\n') `` with U+00A0 mapped to a space), the command runs, and the mocked `recordRewrapDocumentHistory` must receive `beforeRendered` equal to the stubbed `getValue()` before the run and `afterRendered` equal to `getValue()` after it. Titles: `records the history pair in the form the native Undo replay compares (direct Source open)` in both files. Expected RED: `beforeRendered` is the editor text without the extra `\n`.
- **GREEN.** Read `const historyBefore = win.vditor.getValue?.() ?? <current beforeRendered>` immediately before `spliceSvRenderedSpan(...)` and `const historyAfter = win.vditor.getValue?.() ?? afterRendered` immediately after it; pass them as `beforeRendered`/`afterRendered` to `recordRewrapDocumentHistory` only. Add a one-line comment naming the reason (the replay compares `getValue()`, which differs from the editor text after a direct open).
- **Checks:** `npx vitest run --config test/vitest.config.mts media-src/src/editing/table-format-command.test.ts media-src/src/editing/list-normalize-source-command.test.ts media-src/src/bridge/edit-sync.test.ts media-src/src/bridge/sv-source-relation.test.ts` (all pass; existing cases unchanged because they stub no `getValue` and fall back); `npm run typecheck`; `npx biome check` on the four files; `node build.mjs`; wrapper run of `exact-authority-other-actions.spec.ts -g "sv:"` (expected: `cells=8 failed=0`, all four action cases including both `-direct` ones pass, log `tmp/675/p23b-vscode.log`).
- **Residual:** other Source-mode recorders that use editor text instead of `getValue()` are not audited here; any found becomes a follow-up, not part of this task.

## Closure (2026-11-01)

### What changed

- `media-src/src/bridge/sv-source-relation.ts` (new): `svSourceDerivesFrom(exact, rendered)`. Equality up to line endings, plus line-wise differences that are a table row of a table block (cells compared trimmed, delimiter cells by alignment), an ordered-list number that follows the previous shown number of the same list, and one more trailing line break. Any other difference, any difference inside a fenced code block, and a different line count are refused.
- `media-src/src/bridge/edit-sync.ts`: `receiveExactAuthority` also accepts a reply in Source mode when `svSourceDerivesFrom` holds. `provesExact`, `projectRendered` and `rebaseOneSpan` are unchanged.
- `scripts/module-manifest.mjs`: id `sv-source-relation` in the `bridge` entry.
- `media-src/src/editing/table-format-command.ts` and `list-normalize-source-command.ts`: the history pair is recorded in the form of `window.vditor.getValue()` (read just before and just after the splice) so that the native Undo replay matches after a direct Source open.
- `test/vscode-e2e/helpers/shortcut-xtest-kit.ts`: `OpenOptions { direct?: boolean }`, `Ctx.direct`, `openDocument(..., options)`; a direct open sets `vmde.editor.defaultMode` to the mode and restores the previous user value in a `finally` block.
- `test/vscode-e2e/exact-authority-other-actions.spec.ts`: `'sv'` in the action loop; scenarios `list-normalize-sv` and `table-format-sv`, each opened by a mode switch and directly (cases `<scenario>-switch` and `<scenario>-direct`); helper `actionCell`.
- Tests: `edit-sync.test.ts` (new block `Source-mode exact-authority relation (Task 675)`), `sv-source-relation.test.ts` (new), one new case in each of `table-format-command.test.ts` and `list-normalize-source-command.test.ts`.

### Acceptance

- [x] Source-mode relation accepts text Vditor or Lute changed and refuses stale host text and any unrelated difference: `edit-sync.test.ts` (padded table accepted, renumbered list accepted, stale host refused, unrelated difference refused, plus a control) and `sv-source-relation.test.ts` (7 accept and 14 refuse cases). RED first (two accept cases failed), then green.
- [x] The Source cases of `exact-authority-other-actions.spec.ts` apply, change only their span, restore with one Undo and write on Save, in both open modes: real VS Code `sv:` test, `cells=8 failed=0`; whole spec `5 passed` (ir 26 cases, wysiwyg 20, sv 8, two stale-host tests 4 each). The RED run failed all four action cases with "the action did not change the host"; the direct-open Undo failure found after the relation (history pair recorded from the editor text) was fixed under Decision D1 below.
- [x] Focused real-VS-Code spec written and run; quality stages pass (see below; the audit stage is omitted by the queue rule, and the bundle-size and startup-cost budgets are reporting only).

### Verification run (2026-11-01)

- Vitest: `edit-sync.test.ts`, `sv-source-relation.test.ts`, `table-format-command.test.ts`, `list-normalize-source-command.test.ts`, `test/backend/module-boundaries.test.ts`: all pass. `npm run test:coverage`: `Test Files 384 passed`, `Tests 8384 passed | 1 expected fail`. `node scripts/module-manifest.mjs`: OK.
- Real VS Code through the wrapper: `exact-authority-other-actions.spec.ts` whole file, `5 passed (13.9m)`.
- Stages: `check:brand-identifiers`, `lint:ci`, `typecheck`, `typecheck:vscode-e2e`, `knip`, `jscpd` (no clone in the changed files), `depcruise` (no violations), `check:coverage-modules` (9 modules at 0%, baseline 9): all exit 0.
- Reporting only: `check:bundle-size` exit 1 (`media/dist/main.js` 1094 KB against a 608 KB budget), `check:startup-cost` exit 1 (408 eager modules against 294); both budgets were already exceeded before this task (the new module is about 6 KB source).

### Decisions

- **Provisional decision (2026-11-01), reversible: the Source-mode relation.** Line-wise classes: table padding and delimiter dashes in a table block, sequential ordered-list renumbering, one extra trailing line break; fenced code and everything else refuse. Selected by a recorded decision check (probability 0.92).
- **Provisional decision (2026-11-01), reversible: where the relation lives.** New pure file `media-src/src/bridge/sv-source-relation.ts` with its own tests and an id in the bridge entry of the module map. Selected by a recorded decision check (probability 0.48; the editing module scored 0.26; the import stays inside the bridge module).
- **Provisional decision (2026-11-01), reversible: the kit switch.** `openDocument(..., { direct: true })` with an exported `OpenOptions`, restoring the previous user value. Selected by a recorded decision check (probability 0.99).
- **Provisional decision (2026-11-01), reversible: the one-span rebase stays unchanged.** `rebaseOneSpan` keeps plain projection proof.
- **Provisional decision (2026-11-01), reversible: state after acceptance.** An accepted pair whose rendering differs from `normalizeEol(exact)` is acceptable: it holds while the Source text is unchanged, Undo recalls it, and later typing revokes it.
- **Provisional decision (2026-11-01), reversible: the spec gesture end and open modes.** `selectionchange` after `placeCaret`; each Source scenario runs by a switch and directly.
- **Provisional decision (2026-11-01), reversible: Undo after a direct Source open (Decision D1 above).** Record the Source commands' history pair in `getValue()` form inside the two commands. Selected by a recorded decision check (probability 1.0).

### Residuals

- Whitespace beside a table pipe that exists only in the Source text is accepted (it is not meaningful in a table; the table command reformats it anyway).
- Lute normalizations outside the three accepted classes (bullet characters, blank-line collapsing, heading styles, escapes) still refuse after a mode switch: fail closed.
- Other Source-mode recorders that record editor text instead of `getValue()` are not audited.
- `makeKit` still sets the user-global `vmde.editor.defaultMode` to `ir` and never restores it (Task 682 candidate).
- Task 681 edits `table-format-command.ts` later; this task's change there is confined to the history record call.

## Repair R1 (2026-11-01): independent review findings

- **M1 (fixed).** A fenced block did not end the open lists, so a list item numbered across a fenced block was accepted. A shown fence line now drops the open lists at its indent or deeper (the content of the fence stays text).
- **M2 (fixed).** Indented code (4 or more spaces that do not continue an open list item) is no longer read as a list or a table: an item at that indent counts only inside an open list, and a table row line indented by 4 or more spaces ends the table block. A `$$` math block is treated like a fenced block (no difference inside it is accepted). HTML blocks are not excluded: residual (an HTML block that contains lines shaped like table rows or ordered items could be accepted; the offset and region proofs of the commands still apply).
- **L3 (documented).** The relation's header comment states that typed bytes inside an accepted class (Enter at the end, a typed list number, typed padding) cannot be told apart from what Lute or Vditor changed, and that safety also rests on `settleExactInput` flushing before the request and on the rendering and trusted-input check in `receiveExactAuthority`.
- **L4 (recorded).** A host text without a final line break, and an empty host text against `\n`, are refused (the extra trailing line break is accepted only when both texts end in `\n`). This fails closed; the spec does not exercise it.
- **L5 (filed).** Follow-up [Task 684](../684-sv-history-pairs-recorded-in-editor-text-form-after-direct-open.md): other callers of `recordRewrapDocumentHistory` may still record editor-text forms after a direct Source open (unverified; measure first).
- **Tests.** Four refusing cases added to `sv-source-relation.test.ts`, RED first (all four failed on the unrepaired module: fenced-block list, indented-code list, indented-code table padding, math block), then green.
- **Provisional decision (2026-11-01), reversible: repair scope.** Fix M1 and M2 in this task, document L3, record L4, and file L5 as a follow-up. Selected by a recorded decision check (probability 1.0).
- **Residual (R1).** An item indented 4 or more spaces directly under an open list item is read as a nested item (it could also be indented code inside that item); HTML blocks are not excluded. Both stay fail-closed at the command level because the commands re-prove their own region after acquisition.

## Repair R2 (2026-11-01): focused re-review findings

CommonMark is approximated, not modelled: the relation refuses whenever a block type could change the meaning of a line.

- **Finding 1 (fixed).** A table indented by a tab was accepted. Any differing line whose leading whitespace contains a tab is refused.
- **Finding 2 (fixed).** Indented code inside a list item was read as a nested list (also a 4-space fence). Any differing line with an indent of 4 or more spaces, on either side, is refused. The earlier nested-item exception for deep indents was removed.
- **Finding 3 (fixed).** An ordered item other than 1 right after paragraph text is text, not a list. A list may start only after a blank line, a list item or the document start unless its number is 1; otherwise the line gets no list role and a difference is refused.
- **Finding 4 (fixed).** HTML blocks: from a line that starts with a tag (up to three spaces of indent) to the next blank line, or for `pre`, `script`, `style` and `textarea` through the line with the closing tag, no difference is accepted, and no table or list role applies. HTML and fenced content still ends the open lists at its indent or deeper.
- **Finding 5 (fixed).** A table needs a header row and a delimiter row with the same number of cells.
- **Finding 6 (fixed).** A table run ends at a line that starts a quote (`>`), a heading (`#`), a list item or a fence.
- **Tests.** Six refusing cases added to `sv-source-relation.test.ts` (tab indent; indented code and 4-space fence in a list item; non-1 number after a paragraph; two HTML blocks; header and delimiter cell counts; two body rows that start another block), RED first (`6 failed | 24 passed`), then green (30 relation tests; every earlier accept case stays green).
- **Verification.** Vitest (5 files) 234 passed; `typecheck`, `lint:ci`, `knip`, `node build.mjs` exit 0; wrapper `-g "sv:"` `cells=8 failed=0` (`1 passed (1.9m)`).
- **Residual.** The relation refuses more than CommonMark requires (any line indented by 4 or more spaces, any tag-led block, a table inside a quote or list item that starts with those markers): a Source action after a switch on such a document declines instead of applying. This fails closed and costs only the action on those lines. The final completion check on the whole diff after R2 asked for review (no claim contradicted); two independent reviews had already examined the relation.
