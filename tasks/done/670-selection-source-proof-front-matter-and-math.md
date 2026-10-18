# Task 670 — Extend the selection source proof to front matter and math blocks

**Status:** done (2026-10-19). All twelve plain/prefixed comparisons pass in IR and WYSIWYG, including exact Save and Undo. Fresh full coverage and shared gates pass; baseline runtime failures and tooling limits remain recorded below.
**Origin:** Task 604, Task 606.
**Severity:** high. Owner requirement (2026-10-19, chat): treat as the first task of the next batch.
**Tech stack:** `media-src/src/editing/selection-source-proof.ts` and the block pairing it relies on; `rewrap-command.ts`.
**Depends on:** Task 604, Task 606.

## Owner requirement (2026-10-19, chat)

Front matter must be its own, separate block. It must not affect any other feature in any way: not Rewrap, auto-wrap or heading shift, and not block handles, Move Block, Turn Into, Details, callouts, links, outline, Find or Undo. A document with front matter must behave exactly like the same document without it, with all offsets shifted by the front matter length.

## Suspected cause (read from code, not yet tested)

`scanMovableBlocks` and `pairRenderedSpans` (`media-src/src/nav/block-handle.ts`) have no front matter handling. A leading `---` / `title: x` / `---` is probably scanned as a thematic break plus other blocks, while Lute renders one front matter unit, so the block pairing fails and the whole document is unprovable. The round-trip test (`pair.exact === pair.rendered` in `selection-source-proof.ts`) may also fail for front matter.

## Problem

Task 606 made selection Rewrap, auto-wrap and heading shift proof-only in IR and WYSIWYG. The proof cannot pair a front matter block, so these three actions do nothing on a document that has front matter (a non-round-trip document with a `$$` block is affected too). Known limitation for the preview release. Rewrap Document was left on its line-based caret mapping: its proof-only version was flaky in real VS Code after a document replace or mode switch (the owned exact snapshot differed from the host text by one byte), so it is part of this task.

## Proposed work

Teach the proof to pair front matter and `$$` math blocks. Find why the owned exact snapshot can differ from the host text by one byte after a replace or mode switch, then make Rewrap Document proof-only again (the removed cases are in the 606 history: Vitest, Chromium and real-VS-Code document steps). Pin the front matter limitation tests in `rewrap-non-round-trip.test.ts` the other way.

## Acceptance

- Front matter is a first-class block kind in the scanner, the pairing and the source block index, recognised only at byte zero and closed by the next `---` or `...` line.
- A cross-feature matrix runs on a document with front matter and on the same document without it (IR and WYSIWYG): selection Rewrap, auto-wrap, Rewrap Document, heading shift, block handle, Move Block, Turn Into, Details, callout apply, selection Link, outline move, Find Replace. Each gives the same result with offsets shifted by the front matter length.

- Rewrap Document, selection Rewrap, auto-wrap and heading shift work in IR and WYSIWYG on a document with front matter and a `$$` block.
- The CHANGELOG known-limitation bullet is removed.
- [x] Focused real-VS-Code spec written and run; all requested individual shared gates pass. Dependency audits and aggregate `npm run quality` were explicitly waived by the execution prompt.


## Implementation and verification — 2026-10-19

### Implemented

- Add separate `front-matter` and `math` source kinds and pair their real Lute DOM units. Recognize YAML only at byte zero. Preserve absolute body offsets and the front matter-owned separator, including deletion of the last body block.
- Keep front matter inert for handles, Move Block, Delete, Duplicate, Turn Into and Details. A body block cannot move before it. Preserve the existing planner rejection reasons.
- Preserve source offsets for body Rewrap, heading shifts, Find and selection Link. Exact selection Link capture is extended only when YAML is the sole source of normalization; already-normalizing bodies retain their previous behavior.
- Treat complete math blocks like fences for move/duplicate/delete and Details admission; Turn Into continues to decline math.
- Restore proof-only document Rewrap in visual modes. Validate prepared source, rendered text, host text and index key before applying. Source mode retains line mapping.
- Exclude YAML/math delimiter text from Find's serializable boundary map. Ignore YAML literal fence/Details tokens in Details source parsing.
- Re-adopt host-confirmed exact bytes after a non-round-tripping front matter/math block action, following the existing outline-move pattern. Ordinary round-trip actions incur no added serialization.
- With explicit scope approval, coordinate the pending IR auto-wrap timer with ordinary typing publication. Immediate Save/Undo flushing remains available; a proven one-span input rebase preserves the source-only YAML separator on a forced flush. The first coordination alone was insufficient; the confirmed checkpoint repair below completes the automatic transaction.

### One-byte diagnosis

Real Lute in both visual modes removes the blank line after a front matter closing delimiter: the ASCII fixture loses one LF byte. A marker capture over rendered Markdown therefore differs from the host-exact source by one byte. The proof now captures the owned exact text, including that separator, rather than promoting the rendering to source authority. Unit cases reproduce exactly this difference and reject stale host/DOM captures. The document regression keeps the original host bytes instead of canonicalizing the document before the command.

### Current acceptance evidence

- [x] First-class scanner, pairing and source-index units; byte-zero recognition, LF/CRLF offsets, inert front matter, planner rejections and body moves.
- [x] Selection Rewrap, Rewrap Document and heading shift after front matter/math pass in both real visual modes.
- [x] Block-handle and Move Block exact source, save and Undo pass in the repaired matrix in both visual modes.
- [x] Turn Into, Details, callout application, selection Link, outline move and Find Replace pass in both repaired real-mode matrix journeys.
- [x] WYSIWYG: all twelve plain/prefixed comparisons, shifted offsets, saved bytes and Undo pass.
- [x] IR: all twelve comparisons pass, including both auto-wrap variants, exact saved bytes and Undo, after the checkpoint repair.
- [x] Remove the front matter CHANGELOG limitation after both real-mode matrices pass; close the record and index.
- [x] Focused real-VS-Code matrix written and run with XTEST, one worker and zero retries. Its first IR run failed six steps. The first two approved follow-ups failed only the two IR auto-wrap variants. After renewed investigation and the checkpoint repair, both visual modes pass all twelve comparisons.
- [x] Fresh full unit coverage passes: 7,889 passed, 1 expected failure, 370 files. The ratchet passes at its existing 10-module baseline. The earlier unchanged cache timeout is retained as historical evidence below.
- Dependency audits and aggregate `npm run quality` are intentionally waived for this local run by the execution prompt. They were not run and are not recorded as passing.

### Verification actually run

All commands ran from the task worktree, except the isolated unchanged-base build. Private comparison configuration paths are omitted from this tracked record.

| Command or focused group | Exit | Result |
| --- | --- | --- |
| Initial focused Vitest: block move, block handle, non-round-trip Rewrap | 1 | RED: 10 failures, 164 passes |
| Same focused Vitest after scanner/pairing repair | 0 | 174 passes |
| Expanded affected-module Vitest group | 1 | 529 passes; new YAML Find map case failed, subsequently repaired |
| Document Rewrap proof RED cases | 1 | 4 intended failures after correcting a test replacement-string typo |
| Rewrap, selection-Link, Details and block-action focused group | 0 | 139 passes |
| Non-round-trip Rewrap including prefix-only capture parity | 0 | 84 passes |
| Source isolation/planner/Details focused group | 0 | 96 passes |
| Block-action host-confirmation adoption | 0 | 10 passes; the new case failed before the repair |
| Coordination unit RED | 1 | 5 new pending-publication failures, then 2 new source-preservation failures before the respective repairs |
| Coordination focused Vitest: auto-wrap, edit-sync, editor-session-state, vditor-init | 0 | 190 passes across 4 files; final controller error-release group also passes 23 cases (overlapping coverage, not additional unique cases) |
| `node build.mjs` under `timeout` | 0 | Candidate builds passed after source changes, including the final coordination tree; unchanged base build also passed |
| `xvfb-run -a npm --prefix media-src run test:e2e -- block-handle.spec.ts rewrap-non-round-trip.spec.ts details.spec.ts block-transform.spec.ts find-replace.spec.ts --workers=2 --retries=0` | 1 | 80 passes; only the documented `find-replace.spec.ts:560` baseline failed |
| `xvfb-run -a npm --prefix media-src run test:e2e:coverage -- rewrap.spec.ts rewrap-non-round-trip.spec.ts details.spec.ts --workers=2 --retries=0` | 0 | 32 passes; coverage collected before the final exact-range and host-adoption refinements |
| Required combined real-VS-Code run, XTEST, one worker, zero retries | 1 | 41/48 pass. Documented Rewrap scroll failure; four plain-document failures; two new matrix failures |
| Approved combined candidate/base follow-up, XTEST, one worker, zero retries | 1 | 1 test passes, 5 fail. Candidate WYSIWYG passes all 12 comparisons; candidate IR passes 11, auto-wrap remains open. All four old plain-document cases fail on the unchanged base, with the title-input mode distinction below |
| Approved coordination matrix follow-up, XTEST, one worker, zero retries | 1 | 1 test passes, 1 fails, 2.5 minutes. WYSIWYG: 12 comparisons, 0 failures. IR: 11 successful comparisons, 2 variant failures for auto-wrap. Both variants retain expected byte length and the prefixed variant retains its separator |
| `npm run lint:ci` | 0 | Passed after extracting small helpers to repair five complexity violations; final stopped tree also passes |
| `npm run typecheck` | 0 | Passed, including the final coordination tree |
| `npm run typecheck:vscode-e2e` | 0 | Repaired matrix passes static checking |
| `npm run knip` | 0 | Final stopped tree passes; one existing unused-tag hint in callouts |
| `npm run jscpd` | 0 | Final stopped tree: 6.10% duplicated lines |
| `npm run depcruise` | 0 | No reported boundary violations; tool warns its TypeScript transpiler does not support the installed compiler version |
| `npm run check:brand-identifiers` | 0 | Final stopped tree passes |
| `npx vitest run --coverage --config test/vitest.config.mts --testTimeout=60000` | 1 | 7,873 pass, 1 expected failure, 1 timeout; 369/370 files pass. The cache test overrides the CLI timeout with its own 30-second limit. No coverage report was emitted on failure |
| Isolated unchanged code-cache hit case, same assertions and timeout | 0 | 1 pass, 5 skipped, 10.82 seconds |
| `npm run check:coverage-modules` | 1 | Required coverage summary is missing after the failed aggregate run; ratchet is not proved |
| Root-cause diagnostic IR matrix, one worker, zero retries | 1 | Both auto-wrap variants reproduce; valid proof precedes a plain checkpoint flush and an exact post without a base |
| Checkpoint regression RED then GREEN | 1, 0 | 2 fail before the repair, 2 pass afterward; one additional stale-proof negative case passes in the focused group |
| Final affected-module Vitest group | 0 | 531 passes across edit-sync, auto-wrap, Undo coupling/boundaries and Rewrap (6 files) |
| Final XTEST real-VS-Code matrix, one worker, zero retries | 0 | 2 tests pass, 12 plain/prefixed comparisons in each visual mode, exact Save and Undo, 2.0 minutes |
| Final build, source/spec typechecks and individual static gates | 0 | All pass; existing knip tag hint and dependency-cruiser compiler warning remain |
| `npx vitest run --coverage --config test/vitest.config.mts --testTimeout=60000 --maxWorkers=2 --coverage.reportOnFailure` | 0 | 7,889 passes, 1 expected failure, 370 files, 472.05 seconds; original assertions and cache test timeout retained |
| Fresh `npm run check:coverage-modules` | 0 | 10 zero-coverage modules, matching the existing baseline |
| `git diff --check` | 0 | Passed |

The exact real-VS-Code baseline failures are multi-block Turn Into Redo, code-fence-language Redo, and callout panel pointer interception. The callout-authoring title-field case also fails on both trees, but at different mode steps: IR on the candidate and WYSIWYG on the base; that distinction is retained rather than claiming an identical assertion failure. The focused OS-level Turn Into Undo/Redo specifications pass on the candidate in both modes. The original Rewrap scroll assertion fails as documented, after its IR document Rewrap step passed.

### Earlier IR auto-wrap stop and repair attempts

The smallest retained reproduction is the `auto-wrap` branch in `test/vscode-e2e/front-matter-matrix.spec.ts`. Use IR with the existing synthetic BODY (headings, prose and a display-math block), wrap column 30 and delay 300 ms. Run it once without the YAML prefix and once with it. Acknowledge the delivered enabled configuration, put the caret after `three`, type one `z` through XTEST and acknowledge `threez` in host text. The expected exact `rewrapMarkdownRange` result never reaches the host. No retyping, retries or assertion relaxation is used. WYSIWYG passes the same sequence.

1. First repair approach: acknowledge asynchronous configuration delivery and correct the new matrix's setup. Repair host-confirmed block-action authority for the independent Save/Undo failures. The combined candidate/base follow-up leaves only IR auto-wrap failing. Before the coordination repair, the prefixed host loses one separator byte.
2. Second repair approach, explicitly approved: defer ordinary IR typing publication while the automatic attempt is pending, release it when the timer/apply settles, and preserve immediate Save/Undo flushing with exact source rebasing. RED/GREEN unit tests cover publication, cancellation, errors, Save/Undo and source preservation. The final real-mode run still fails both IR auto-wrap variants, although the prefixed host now retains the separator: plain host/expected length 143/143; prefixed 166/166; automatic formatting absent in both.

The normal IR typing post runs after 250 ms; a deferred prose re-spin can emit an empty untrusted `insertText` around 220 ms and restart the 300 ms automatic timer. The latest input probe records that synthetic event, while XTEST typing is independently acknowledged by host text. Remaining uncertainty is whether the automatic capture/proof loses ownership or an Undo history checkpoint (`onEntryRecorded` → `flushHistoryInput`) retires it before the exact transaction posts. That was the remaining hypothesis at the stop boundary. The resumed trace below confirms the checkpoint cause.

The execution prompt required stopping after two repair approaches. Work stopped and was reported. The subsequent direction to find the real cause and fix it explicitly resumed investigation; no assertion was relaxed.

### Resumed investigation: confirmed checkpoint cause and repair

A temporary state-only trace recorded this sequence in both IR prefix variants: trusted typing; deferred synthetic input; automatic capture; successful one-span rebase; successful source proof; first history checkpoint; ordinary typing post; exact wrap post with no owned `before` base. The formatter returned success locally, but the host correctly refused its unguarded write. Plain timing deferral could not fix the checkpoint's separate publication path.

The checkpoint now publishes already-proven pending automatic typing as a guarded exact edit before the automatic action posts. It retains that typed source as the next `before` base, so the host queue receives opening → typed → wrapped bytes and one Undo reaches the typed state. It reuses the cached one-span proof only if its remembered source still equals the host base and its rendered snapshot remains live. A stale proof follows the existing ordinary flush path. Save and Undo remain immediate. The new successful path replaces the ordinary flush's serialization read and performs no new Lute projection; tests assert these call counts for plain and prefixed documents.

The exact regression failed twice before the repair (missing `exact`/`before` fields) and passes twice after it. A separate stale-rendering case declines exact publication. The affected edit-sync, auto-wrap, Undo coupling/boundaries and Rewrap unit group passes 531 tests in six files. Final build, both typechecks, lint, knip, jscpd, dependency boundaries and identifier checks pass. Dependency-cruiser's compiler compatibility warning remains. Final XTEST matrix: 2 tests pass, 12 comparisons per mode, no failures, 2.0 minutes, one worker and zero retries. Temporary instrumentation is removed. Fresh full coverage passes: 81.41% statements, 74.67% branches, 84.20% functions and 83.76% lines. Edit-sync has 91.00% line coverage; the new guarded checkpoint post and retained-base statements are each exercised twice. The successful aggregate run supersedes the earlier cache timeout and missing-report ratchet result.

### Final diff review

Reviewed the diff against the separate inert front matter requirement, the body offset contract, planner rejection reasons and consumer bindings. No new module, dependency, vendor edit or tracked generated artifact is included. The front matter Link bridge keeps the general normalizing-body case deferred. Common round-trip block actions do not add serialization; the coordination adds pending-state checks and uses the existing rebase only for pending front matter input. The approved coordination changes pending IR publication timing; the final plain/prefixed real-mode matrix now passes Save and Undo as well as automatic formatting. Source/host checks and exact assertions remain intact. The required brief and final reviews were performed locally with explicit approval for the reviewer substitution.

### Consumer review and residuals

`source-block-index.ts`, `block-transform-command.ts`, `link-popover.ts` and `finish-init.ts` retain their existing bindings and group-order checks. `block-transform.ts` retains its protected-source admission rules; added tests pin shifted body transforms and YAML/math refusal. Changed source consumers are block handles/planners, Find mapping, selection proof, document Rewrap, Details and block-action authority adoption. No generated output, dependency or vendor source was edited.

Lute still does not recognize a YAML closing `...` marker. The source scanner recognizes it as required, while DOM pairing declines that unsupported rendering. Unclosed front matter also declines. Indented display math retains Lute's pre-existing serialization behavior; no vendor repair is included. Bundle size and eager-module deltas were not measured. Final diff whitespace and added-line privacy checks pass; no generated output or protected queue inputs are included in the completion commit. The final process inventory has no matching runtime processes. Release preparation is a separate next step.
