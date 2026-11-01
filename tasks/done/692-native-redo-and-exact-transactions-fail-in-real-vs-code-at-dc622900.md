# Task 692 — Native Redo and exact-transaction cases fail in real VS Code at `dc622900`

**Status:** done (2026-11-02; C5 is intermittent and stays with Task 695). Filed from the full real-VS-Code gate of queue run 2026-11-01d.
**Origin:** Gate suite on `dc622900` (2026-11-01), confirmed by a rerun of the spec files alone (2026-11-02).
**Severity:** high (estimated; the failures are deterministic document-text differences on Redo and on exact actions, so user edits may not round-trip).
**Tech stack:** `test/vscode-e2e/block-transform.spec.ts`, `test/vscode-e2e/callout-authoring.spec.ts`, `test/vscode-e2e/toolbar-overflow.spec.ts`; host history coupling (`src/writeback/history-coupling.ts`), the exact-edit path (`media-src/src/bridge/edit-sync.ts`) and the native Undo/Redo keybindings.
**Depends on:** none.

## Problem

These cases fail in the full suite and again when their spec files run alone at `dc622900` (`--workers=1 --retries=0`, XTEST):

- `block-transform.spec.ts:47` (Turn Into QuickPick): after Undo, `Control+y` does not restore the heading; the document stays `alpha **beta**` instead of `## alpha **beta**` (`:114`).
- `block-transform.spec.ts:239` (multi-block Turn Into): the same Redo failure over two blocks.
- `block-transform.spec.ts:437` (Code Fence menu): the language edit leaves ```` ```js ```` where ```` ```ts ```` is expected.
- `callout-authoring.spec.ts:6`: the callout title field shows `Created` where `IR title` is expected.
- `toolbar-overflow.spec.ts:702` (Emoji 17 pointer selection) and `:1019` (Emoji picker in SV): the second emoji insertion is missing (`🫪` instead of `🫪🫪`).

Whether these are one cause or several is not measured. No earlier full-suite baseline exists, so the commit that introduced each failure is unknown.

## Proposed work

1. Find the last good commit for each failing case: run the spec alone on earlier `dev` revisions (bisect over the commits since the last recorded pass of each spec).
2. Group the cases by first bad commit and measure the cause of each group.
3. Fix each cause with a failing test first, or fix the test where the test, not the product, is wrong (state which).

## Acceptance

- [x] Each failing case has a first bad commit (or is shown to be a test defect) and a measured cause. Evidence: Part 2 B1 and B2 (C1 to C3: `ec671180`; C4: test defect after `773372a1`; C6: `773372a1`). C5 passed on `79c0a367` and failed only intermittently in the bisect, so it has no first bad commit; Task 695 owns it.
- [x] Each product cause is fixed with a test that fails before and passes after. Evidence: Part 2 fix (Vitest RED lines below; the C4 spec change fails before and passes after by the B0 and B2 runs).
- [x] The six cases pass in one real-VS-Code run. Evidence: Part 2 fix round (three wrapper invocations): C1 to C3 in `block-transform.spec.ts` (9 of 9), C4 in `callout-authoring.spec.ts`, C5 and C6 in `toolbar-overflow.spec.ts`. C5 is intermittent (B1), so one pass is not proof of stability.
- [x] Specs sharing the changed code pass. Evidence: `turn-into-undo-step`, `exact-action-neutral-bytes` and `undo-host-coupling` (13 passed with `callout-authoring`), toolbar-overflow Emoji transactions in IR, WYSIWYG and SV.

## Tests to write

- A Vitest case per product cause.
- The six real-VS-Code cases above are the acceptance tests; add a case only if a cause is not covered.

## Part 1 handoff (2026-11-02)

Source, test, history and done-record reading only. Nothing was built or run in this step (another task held real VS Code). Every cause below is a hypothesis with source evidence; Part 2 measures before any code changes. Line numbers are at `79c0a367` unless a revision is named.

### Problem restated per case

The record names the test, not the failing assertion line, for four cases. Part 2 step B0 records the line for each.

| Case | Test (title) | Failure as recorded | Most likely failing assertion (inferred) |
|---|---|---|---|
| C1 | `block-transform.spec.ts:47` "native Turn Into QuickPick uses retained source target, one undo, and exact save" | after Turn Into H2 and `Control+z` (host back at `alpha **beta**`), `Control+y` leaves the host text at `alpha **beta**` | `:114` (recorded) |
| C2 | `block-transform.spec.ts:239` "multi-block Turn Into uses one exact source transaction through native Undo and save" | same Redo failure over two blocks | `:291` (Redo poll) |
| C3 | `block-transform.spec.ts:437` "current Code Fence menu edits language through native input with exact undo" | host keeps ```` ```js ```` where ```` ```ts ```` is expected | `:484` (Redo poll after a passing Undo); `:474` (the language edit itself) is the alternative |
| C4 | `callout-authoring.spec.ts:6` "callout authoring stays source-derived across toolbar, IR, WYSIWYG, and SV" | the IR context panel title input reads `Created` where `IR title` is expected | `:146`: the input is reset to the block's source title after `fill('IR title')`, so the panel re-rendered from source between the fill and the check |
| C5 | `toolbar-overflow.spec.ts:702` "Emoji 17 pointer selection saves, reopens, and has one undo/redo step" | host `🫪\n` where `🫪🫪\n` is expected | `:800` (toolbar Redo after the second insertion and toolbar Undo) or `:796` (the second insertion after save and reopen) |
| C6 | `toolbar-overflow.spec.ts:1019` "Emoji picker preserves exact prose, inline-code, and code-block transactions in sv" (the `sv` instance of the loop at `:1014`) | an emoji missing from the host text | one of the per-target polls at `:1155`, `:1157` or `:1159` (insertion, Undo, Redo) |

Shared shape: C1, C2 and C3 press OS `Control+y` (VMDE binding `vmde.format.redo`, `package.json` keybinding `ctrl+y`), after an OS `Control+z` that passed. C5 and likely C6 click the toolbar Redo after a toolbar Undo that passed. Both routes run the same wrapped Vditor engine call (`media-src/src/editing/undo-keybind.ts:147-165`). If C3, C5 and C6 fail on Redo, five of six cases are one failure: Redo after a passing Undo leaves the host at the pre-action text. C4 is a separate failure shape.

### Code path per case and last commit that touched it

Redo path (C1, C2, C3; C5 and C6 if they fail on Redo):

1. Webview: `undo[kind]` wrapper calls `prepare(inner)` (`undo-keybind.ts:155`; `preparePendingHistory`, `media-src/src/editing/undo-boundaries.ts:495`), reads `before`, runs Vditor's redo, reads `after`, and posts `history-transition` only when the two differ (`undo-keybind.ts:158-163`). Last touched: `ec671180` (Task 641, 2026-10-15, history base taken in idle time). `undo-boundaries.ts` last touched by `179fa1b8` (Task 683, 2026-11-01) and `ce4931d5` (Task 664, 2026-11-01).
2. Webview, IR: Vditor's `processAfterRender` calls `options.input` after `undoDelay` in a timer (`media-src/node_modules/vditor/src/ts/ir/process.ts`, `processAfterRender`), so in IR the transition reaches the host before any replay. `input()` posts an exact replay when a recorded history pair matches (`media-src/src/boot/vditor-init.ts:646-660`; `takeRewrapDocumentHistoryReplay`, `media-src/src/editing/rewrap-command.ts:113-148`). Turn Into records the pair (`recordBlockHistory`, `media-src/src/editing/block-transform-command.ts:1142-1170`); the Emoji insertion does not (no `recordRewrapDocumentHistory` caller in `media-src/src/editing/emoji-insertion.ts`). Last touched: `vditor-init.ts` and `rewrap-command.ts` by `79c0a367` (Task 685), before it `fbe97b56` (Task 677, 2026-11-01); `block-transform-command.ts` by `ce4931d5` (Task 664) and `f0cbf772` (Task 605, 2026-11-01).
3. Host: `queueHistoryTransition` (`src/session/editor-session.ts:767`) runs `HistoryCouplingController.handle` (`src/writeback/history-coupling.ts:84-127`), which walks native Redo through `traverse` (`:202`). `history-coupling.ts` is unchanged between `83984892` (Task 602, 2026-10-07) and `dc622900`; `79c0a367` only adds `replayExact`.
4. Host change listener: since `1db03714` (Task 646, 2026-11-01), a content change during VMDE's own write that the echo check does not match counts as an outside change (`skipDuringOwnWrite`, `editor-session.ts:625-631`), which forgets every history pair (`:1807`) and posts the host text to the webview (`:1822`). Before `1db03714`, every change during an own write returned early (`if (this.docSync.syncState.isApplyingEdit()) return`).
5. Host writes: `WritebackController.syncToEditor` (`src/writeback/writeback-controller.ts:350-490`), last touched by `79c0a367`, before it by `e7e73b39` (Task 673, 2026-11-01: `exactWriteSinceBaseline`, `endExactStateOnBaseline` at `:390`, the exact refusal at `:407`, the deferred no-op check armed only outside the exact state at `:487`).

C4 (callout title reset): the IR context panel is built in `media-src/src/editing/callouts.ts` (Part 2 B2 locates the refresh call). Last touched in the window: `2a66d831` (Task 674, delayed history entry after a callout apply), `11208300` (Task 671, proof on normalizing documents), `ce4931d5` (Task 664, selection writes), all 2026-11-01; `773372a1` (Task 630, 2026-10-18, host exact text acquired before `postExact`). Any host update (`editor-session.ts:1822`) or editor re-render between the fill and the check would rebuild the panel from source.

C5 and C6 (Emoji): `media-src/src/editing/emoji-insertion.ts` (acquire at `:480`), last touched by `773372a1` (Task 630); `emoji-picker.ts` by the same commit. The Undo and Redo use the toolbar buttons and the Redo path above.

### Can Task 685 (`79c0a367`) change any case?

Task 685 lands after the failing gate revision. It changes only the host handling of an exact replay that carries `history` (`replayExact`, `history-coupling.ts:129-177`; `noteExactReplay`, `writeback-controller.ts`).

- C1, C2, C3: possible but unlikely (estimated 0.2). Turn Into records an exact pair, so its Undo and Redo post replays. In IR the transition arrives first (point 2), so the host already holds the replay bytes and the replay is `unchanged`, the same as before Task 685. If the replay arrives first in real VS Code (order not measured), Task 685 now walks native history instead of writing forward, which keeps VS Code's redo stack and could make the Redo pass.
- C4: no (estimated 0.05). The callout apply records no history pair.
- C5, C6: no (estimated 0.05). The Emoji insertion records no history pair.

So Part 2 runs the six cases on `79c0a367` first (B0); a case that passes there needs no bisect.

### Last recorded passes (done task records)

| Spec | Last recorded real-VS-Code pass | Later record |
|---|---|---|
| `block-transform.spec.ts` (all 9 tests) | Task 611 controls, 9 passed, on the Task 611 fix tree `be4ec7b0` (2026-10-15) | none; Task 670 ran only the Chromium spec. The spec file is unchanged since `8b546d1f` (2026-09-29). |
| `toolbar-overflow.spec.ts` (C5, C6) | Task 642 S2, 9 of 11 passed; the two failures were the edit-mode transition and the Emoji high-contrast tile, so C5 and C6 passed; spec commit `67036de4` (2026-10-18) | Task 659 and Task 665 ran single tests only. The Emoji tests are unchanged since; `9dc5c094` only moved a helper. |
| `callout-authoring.spec.ts` | Task 570, 1/1, `d543a35b` (2026-09-24) | Task 196 recorded a failure on the pre-task baseline `e52a64e2` (2026-09-26) at an earlier assertion (toolbar count), so the title check was not reached. The spec changed on 2026-10-04 (`396d7a20`). |

History between `be4ec7b0` and `dc622900` is linear (215 commits, no merges), and no lock file changed in it, so one dependency install serves every candidate revision.

### Ranked cause hypotheses

Redo group (C1, C2, C3; C5 and C6 if B0 shows they fail on Redo). The key observation to make first: does the webview post a Redo `history-transition` at all, and if it does, does the host's native walk make progress?

1. **H1 (0.30): a host update after the Undo resets the webview history, so Redo has nothing to redo.** Source: `skipDuringOwnWrite` (`editor-session.ts:625-631`, from `1db03714`) now treats a non-echo change during an own write as an outside change; that path forgets the history pairs (`:1807`) and schedules a host update (`:1822`), and the webview's `setValue` resets Vditor's stacks. With an empty redo stack, `before === after` and no transition is posted (`undo-keybind.ts:161`). Against: own writes set the echo text first (`writeback-controller.ts:574`), so a miss needs a change event whose text differs from the written text. Signal: a `refresh`/`update` message to the webview between Undo and Redo, and no `history-transition` for the Redo.
2. **H2 (0.25): an own write lands between the native Undo and the Redo, so VS Code's redo stack is empty.** Source: `e7e73b39` changed when the exact state ends and when the deferred no-op check and repair run (`writeback-controller.ts:390`, `:487`); `fbe97b56` changed when pending typing is published around Vditor's delayed entry (`media-src/src/bridge/edit-sync.ts`, `flushHistoryInput`). Signal: a host write with a version increase after the Undo, then the Redo transition's coupling debug line reports a `no-progress` stop and a rollback.
3. **H3 (0.15): the webview refuses or skips the Redo.** Source: `prepare(inner)` returns false (`undo-keybind.ts:155`) when `preparePendingHistory` declines; recent changes in `undo-boundaries.ts` (`179fa1b8`, `ce4931d5`) and the outline seed (`03a20622`, Task 676, `media-src/src/boot/main.ts`) touch the entry and caret state around history. Signal: no transition and no engine call, with Vditor's redo stack non-empty.
4. **H4 (0.10): the history base taken in idle time (`ec671180`, `undo-keybind.ts:111-131`) is missing or stale on a freshly opened document, so a proof fails.** All failing Redo tests act on a fresh document without typing; Task 611's Turn Into Redo spec, which types first, is a useful contrast. Signal: coupling debug `host does not match transition start`.
5. **H5 (0.10): test or environment, not product** (key delivery, focus after the `(4, 4)` click, load). Against: the failures were deterministic alone. Signal: the case passes at a revision whose product code is the same.
6. Remaining 0.10: other commits in the window.

C4 (callout title reset):

1. **H6 (0.40): a late host update or re-render rebuilds the IR panel after the fill.** The typing `' edited'` and the panel open come shortly before the fill; the same host-update path as H1 (`1db03714`) or the wrap-hint DOM writes (`b335d64b`, Task 640) could rebuild the panel.
2. **H7 (0.30): a webview refresh trigger added in the window** (`2a66d831` delayed entry retirement after a callout apply; `ce4931d5` selection-write marks; `11208300` target proof) re-renders the panel on a selection or entry event.
3. **H8 (0.20): an older cause before `be4ec7b0`** (the spec already failed on 2026-09-26 for another reason, and no pass is recorded after 2026-09-24).
4. Remaining 0.10: test timing.

### Part 2 steps

Rules for every step: real VS Code only through the wrapper, after `node build.mjs`, `--workers=1 --retries=0`, one spec file per invocation, OS-key specs under the XTEST launch. No change to git state in the task worktree; the scratch worktree is detached and removed at the end.

**B0 (first step, on `79c0a367`, the task worktree).** Build, then run three invocations from the task worktree:

```bash
node build.mjs
../vscode-run.sh 692 env -u ELECTRON_RUN_AS_NODE xvfb-run -a sh -c 'openbox & OB=$!; VMDE_XTEST=1 npm --prefix test/vscode-e2e test -- block-transform.spec.ts -g "native Turn Into QuickPick|multi-block Turn Into|current Code Fence menu" --workers=1 --retries=0; R=$?; kill $OB; exit $R'
../vscode-run.sh 692 env -u ELECTRON_RUN_AS_NODE xvfb-run -a sh -c 'openbox & OB=$!; VMDE_XTEST=1 npm --prefix test/vscode-e2e test -- callout-authoring.spec.ts --workers=1 --retries=0; R=$?; kill $OB; exit $R'
../vscode-run.sh 692 env -u ELECTRON_RUN_AS_NODE xvfb-run -a sh -c 'openbox & OB=$!; VMDE_XTEST=1 npm --prefix test/vscode-e2e test -- toolbar-overflow.spec.ts -g "Emoji 17 pointer|transactions in sv" --workers=1 --retries=0; R=$?; kill $OB; exit $R'
```

Record per case: pass or fail, the failing assertion line from the stack (`spec.ts:NNN`), received and expected values. Save logs under `tmp/692/b0/`. Cases that pass on `79c0a367` leave the bisect (record "fixed by Task 685" only if they also failed at `dc622900`, which the record states). Group the remaining cases by failing assertion shape (Redo poll, insertion poll, panel input).

**B1 (bisect, scratch worktree).** Create once, from the task worktree:

```bash
git worktree add --detach tmp/692/bisect be4ec7b0
cd tmp/692/bisect
ln -s ../../../node_modules node_modules
ln -s ../../../../media-src/node_modules media-src/node_modules
ln -s ../../../../../test/vscode-e2e/node_modules test/vscode-e2e/node_modules
ln -s ../../../../../../../vmde/test/vscode-e2e/.vscode-test test/vscode-e2e/.vscode-test
```

The `.vscode-test` link points at the main checkout's downloaded VS Code; verify it resolves before the first run (`ls test/vscode-e2e/.vscode-test`). Per revision, from `tmp/692/bisect`:

```bash
git checkout --detach <rev>
git status --porcelain   # must be empty apart from the four links
node build.mjs
../../../../vscode-run.sh 692 env -u ELECTRON_RUN_AS_NODE xvfb-run -a sh -c 'openbox & OB=$!; VMDE_XTEST=1 npm --prefix test/vscode-e2e test -- <spec> -g "<titles of the group>" --workers=1 --retries=0; R=$?; kill $OB; exit $R'
```

Run only the spec files of the groups still open, with the same title filters as B0 (titles, not line numbers, because lines move). Record per run: revision, spec blob (`git rev-parse <rev>:test/vscode-e2e/<spec>`), result, failing line. Logs go to `tmp/692/b1/<rev>-<spec>.log`.

Candidate revisions in order:

1. `be4ec7b0`: expected good for every group (anchor). If a Redo case fails here, stop that group and report (the record says it passed here).
2. `30426a37` (2026-10-19): splits the 181 commits of 2026-10-15 to 2026-10-19 from the 34 of 2026-11-01.
3. If `30426a37` is good, bisect `30426a37..dc622900` starting at `9dc5c094`. Prefer, at each split, the product commit nearest the middle of `git rev-list --reverse GOOD..BAD`; the expected first bad commits by source evidence are `1db03714` (H1), `e7e73b39` (H2), `fbe97b56` (H2), `179fa1b8` and `ce4931d5` (H3), `03a20622` (H3).
4. If `30426a37` is bad, bisect `be4ec7b0..30426a37` the same way; expected first bad commits: `ec671180` (H4), `773372a1`, `bdc66583`, `6da78555`.
5. C4 only: if C4 fails at `be4ec7b0`, test `396d7a20` (first revision with the current spec text); if that fails too, record H8 and continue bisecting `d543a35b..396d7a20` with each revision's own spec, noting where the spec text differs.

Skip a commit that changes nothing under `src/`, `media-src/src/`, `media-src/vendor/`, `build.mjs` or `package.json` (`git diff --quiet A^ A -- <paths>`): it cannot change behaviour. A revision that does not build is skipped once (try its neighbour) and recorded.

Stop rule, per group: stop when the last good and first bad revisions are adjacent product commits, then rerun the first bad revision once to confirm it is not intermittent. Stop early and return the measurements when a group exceeds 9 runs, when the anchor contradicts the records, or when results at one revision disagree between two runs. When B1 ends, remove the scratch worktree from the task worktree: `git worktree remove --force tmp/692/bisect`, then `git worktree prune`.

**B2 (measure the cause per group, on `79c0a367`).** For each first bad commit, write a scratch `@probe` spec copied from the failing test, run it with `VMDE_PROBES=1` and log in host order: each `edit` (exact, `history`, version before and after), each `history-transition` (kind; coupling debug line with steps and proof or the skip reason), each update posted to the webview, and the webview's Vditor undo and redo stack lengths before and after each key. Decision rule: H1 holds if an update reaches the webview between Undo and Redo and no Redo transition is posted; H2 holds if a version increase follows the Undo and the Redo walk stops with `no-progress`; H3 holds if the stacks are non-empty and no transition is posted; otherwise return the measurement for a new plan. For C4, log the panel's rebuild calls and their trigger between `fill` and the check. Delete the probe after recording, unless the orchestrator keeps it tagged `@probe`.

**R (RED, per product cause).** A Vitest case at the layer of the cause (for H1: `test/backend` session test that an own write's change event does not post an update; for H2: `test/backend/writeback-controller.test.ts`; for H3: `media-src/src/editing/undo-boundaries.test.ts` or `undo-keybind.test.ts`; for C4: `media-src/src/editing/callouts.test.ts`), failing on `79c0a367`. If B2 shows a test defect instead, state it and change only the spec. The six real-VS-Code cases are the acceptance tests; add a real-VS-Code case only for a cause they do not cover.

**G (GREEN).** The smallest fix per cause; the R cases pass; `node build.mjs`; one wrapper invocation per changed group's spec file.

**Closure.** One real-VS-Code run of the six cases (three invocations, one per spec file, in one wrapper round), plus once each the specs that share the changed code (chosen at G by importer search; for a history fix at least `turn-into-undo-step.spec.ts` and `exact-action-neutral-bytes.spec.ts`; for a session fix also `external-disk-change.spec.ts`). Then the quality stages, the record update and a final review of the diff.

### Tier

**Heavy.** Causes are unknown and may be up to three; the evidence needs a real-VS-Code bisect of up to about 20 runs and a host-plus-webview measurement before any code, and the likely fixes cross the session, writeback and webview history modules.

### Provisional decisions

- Provisional decision (2026-11-02), reversible — first measurement: run the six cases on `79c0a367` before any bisect run, recording each failing assertion line, and bisect only the cases that still fail. Probability 0.82. Alternatives: start at `dc622900` in the scratch worktree (0.11); start by confirming `be4ec7b0` (0.02).
- Provisional decision (2026-11-02), reversible — spec text per revision: run each revision's own committed spec file and record its blob. The failing test bodies are identical across `be4ec7b0..dc622900`. Probability 0.98. Alternative: copy the `dc622900` specs into every revision (0.00; a helper moved in `9dc5c094`).
- Provisional decision (2026-11-02), reversible — C4 window: test `be4ec7b0` first with the other groups; only if C4 fails there, go back to `396d7a20` and then `d543a35b`. Probability 0.82. Alternative: bisect `d543a35b..dc622900` directly (0.10).

### Open questions

None for the Owner. B0 can change the plan: cases that pass on `79c0a367`, or failing lines that differ from the inferred ones, regroup the bisect.

## Part 2 B0 and B1 (2026-11-02)

B0 and B1 of the Part 1 handoff were carried out as written. No probe and no fix. Logs: `tmp/692/b0/` (B0) and `tmp/692/b1/` (one log per revision and spec group, the rerun logs in `tmp/692/b1/rerun/`). Each run used `--workers=1 --retries=0`, the XTEST launch, `node build.mjs` first, and the revision's own committed spec file. VS Code 1.129.0.

### B0: the six cases on `79c0a367` (Task 685 included)

| Case | Result on `79c0a367` | Failing line and value |
|---|---|---|
| C1 `block-transform.spec.ts:47` | fail | `:114` Redo poll: host stays `alpha **beta**`, expected `## alpha **beta**` |
| C2 `block-transform.spec.ts:239` | fail | `:294` Redo poll: host stays at the pre-action text (two blocks) |
| C3 `block-transform.spec.ts:437` | fail | `:483` Redo poll: host stays ```` ```js ```` where ```` ```ts ```` is expected (the Undo poll at `:481` passed) |
| C4 `callout-authoring.spec.ts:6` | fail | `:174`, not the inferred `:146`: after the SV toolbar callout apply the host text ends with one `\n` where `\n\n` is expected (`> [!CAUTION] SV title\n> alpha body edited\n`). The `Created` title reading in the Problem section was not reproduced in this run. |
| C5 `toolbar-overflow.spec.ts:702` | **pass** | passed once on `79c0a367`; see the intermittency note below |
| C6 `toolbar-overflow.spec.ts:1019` (sv) | fail | `:1162` host poll (`expect.poll(text)`) after the emoji insertion: the host keeps `SV-PROSE prose-sv` where `SV-PROSE 🫪` is expected, while the webview value poll at `:1141-1161` had already matched |

So Task 685 did not repair C1, C2, C3, C4 or C6. The Part 1 guess that C3, C5 and C6 fail on Redo was right for C3 only: C6 fails on the insertion's host write (before any Undo), and C4 fails on a trailing-newline difference in SV.

### B1: bisect

Range `be4ec7b0..30426a37` holds 181 commits, of which 48 change `src/`, `media-src/src/`, `media-src/vendor/`, `build.mjs` or `package.json` (product commits; listed by index 1 to 48 in `tmp/692/prod.txt`). Revisions are the product commits only. `bt` is the three `block-transform.spec.ts` cases (C1, C2, C3), `co` is C4, `em` is C5 and C6. Unrun cells were not needed.

| # | Revision | bt (C1 C2 C3) | co (C4) | em C5 | em C6 |
|---|---|---|---|---|---|
| anchor | `be4ec7b0` (2026-10-15, Task 611) | pass 3/3 | pass | pass | pass |
| 48 | `30426a37` (2026-10-19) | fail 3/3 (`:114`, `:294`, `:483`) | fail (`:174`) | pass | fail (`:1178`) |
| 24 | `fd8d1fd4` | fail 3/3 | pass | pass | pass |
| 12 | `19ad75da` | fail 3/3 | not run | not run | not run |
| 36 | `cfdc5a6b` | not run | pass | **fail** (`:799`, host `🫪` where `🫪🫪` expected) | pass |
| 6 | `5752ff7c` | pass 3/3 | not run | not run | not run |
| 42 | `b335d64b` | not run | pass | pass | pass |
| 9 | `df2e68ac` | fail 3/3 | not run | not run | not run |
| 45 | `bce260fc` | not run | pass | pass | pass |
| 7 | `ec671180` | fail 3/3 | not run | not run | not run |
| 46 | `773372a1` | not run | fail (`:174`) | **fail** (`:799`-type, first run) | fail |
| 7 rerun | `ec671180` | fail 3/3 | | | |
| 46 rerun | `773372a1` | | fail | pass | fail |
| HEAD | `79c0a367` (B0) | fail 3/3 | fail | pass | fail |

Run count: block-transform group 6 revisions plus the rerun (7 runs); callout and Emoji group 7 revisions plus the rerun (8 runs). Both groups stayed under the 9-run limit. The anchor agreed with the records (no contradiction). The two runs at each first bad revision agree, except the Emoji 17 case (below).

### First bad commit per group

- **Redo group (C1, C2, C3): `ec671180`** `perf(641): align fold glyphs after first paint and capture the history base in idle time` (2026-10-15, Task 641). Last good `5752ff7c`. `ec671180` is the only product commit between them (`b92d3e3e` after it is documentation). Confirmed by a second run (fail 3/3 at both lines). Changed files: `media-src/src/editing/undo-keybind.ts` (+75, the deferred history base: `scheduleIdle`, `deferHistoryBase`, `takePendingBase`, the wrappers of `addToUndoStack` and the Undo/Redo call), `media-src/src/nav/section-fold.ts` (+203, glyph alignment after first paint), and their unit tests plus `media-src/e2e/open-deferred-work.spec.ts`. This matches hypothesis H4 of Part 1 in direction (the history-base capture), but the glyph change in `section-fold.ts` is a second candidate in the same commit; B2 must separate the two. Task 611's own real-VS-Code pass (9 of 9 on `be4ec7b0`) predates this commit by one commit, so the record is consistent.
- **C4 and C6: `773372a1`** `feat(630): acquire the host's exact text before the remaining postExact actions` (2026-10-18, Task 630). Last good `bce260fc` (no other commit between them). Both cases fail in two runs at `773372a1` with the same lines as on `79c0a367`. The commit changes 34 files, among them the two modules on the failing paths: `media-src/src/editing/callouts.ts` (+99, the SV callout apply) and `media-src/src/editing/emoji-insertion.ts` (+66, `acquireExactAuthority` at the picker insertion), plus `rewrap-command.ts`, `finish-init.ts`, `main.ts`, `vditor-init.ts` and `src/session/editor-session.ts` (+9). This points at the acquire-before-`postExact` path (the SV insertion and apply write is lost or normalized when the acquire declines or answers late). The two cases are one group by first bad commit, not yet shown to be one cause.
- **C5 (`toolbar-overflow.spec.ts:702`): no first bad commit; intermittent.** It failed on the gate (`dc622900`) and in this bisect at `cfdc5a6b` (#36) and at `773372a1` on its first run (the second insertion missing, `:799`), and passed at #24, #42, #45, `773372a1` on its rerun, `30426a37` and `79c0a367`. By the stop rule (two runs at one revision disagree), the bisect for C5 stops here and the case is reported as a load- or timing-dependent failure with this evidence. Its failure shape (the second picker insertion, after save and reopen, not reaching the host) is close to C6's, and the failing runs cluster at and after `773372a1`'s neighbourhood plus one earlier at #36 (the bare-URL work, `cfdc5a6b`). Part 2 B2 should reproduce it with `--repeat-each` on one revision rather than bisect further.

### Notes for B2 and the next step

- The first bad commit for the Redo group touches no code on the host side, so the Part 1 hypotheses H1 and H2 (host update, own write between Undo and Redo) are not supported as first causes; H4 (history base) and a section-fold effect are the live candidates. The Part 1 H3 candidates (`179fa1b8`, `ce4931d5`, `03a20622`) are not needed to explain the failure, since it starts at `ec671180`.
- C4's failure is the SV trailing newline, so B2 for C4 should compare the SV host text with and without `acquireExactAuthority` at `773372a1`, not look for a panel rebuild.
- Environment: the VS Code 1.129.0 install was copied into the task worktree (`test/vscode-e2e/.vscode-test/worker-0/`, ignored by git) and linked into the scratch worktree. The scratch worktree `tmp/692/bisect` was removed with `git worktree remove` and `git worktree prune`; the task worktree is still at `79c0a367` with only this record modified.

## Part 2 B2 (2026-11-02)

Measurements ran in a scratch worktree at `79c0a367`, with temporary instrumentation in that worktree only: host debug lines written to a file, a probe copy of one spec, and a decline log in `emoji-insertion.ts`. The scratch worktree was removed afterwards. The task worktree has no product change. Logs are in `tmp/692/b2log/`. Each real-VS-Code run used the wrapper, `node build.mjs` first, the XTEST launch and `--workers=1 --retries=0`.

C5 (`toolbar-overflow.spec.ts:702`) is intermittent (B1) and is left to Task 695.

### Redo group (C1, C2, C3): cause

**Split of `ec671180`.** On `79c0a367`, with only the history-base deferral switched off (`undo-keybind.ts:130`, `if (deferBase)` made never true, so the base is read at once as before `ec671180`), the three cases pass 3/3 (`A-bt.log`). The `section-fold.ts` half is not involved.

**Mechanism, measured on unchanged `79c0a367`** (`P3-host.log`, C1, failing):

1. On open, Vditor's first undo entry is recorded and its history base is deferred to an idle period (`undo-keybind.ts:111-131`).
2. Turn Into runs from the native QuickPick before that idle callback. Its pre-checkpoint, `checkpointEditorUndoCoalescing` (`block-transform-command.ts:1197`), goes to `checkpointOrCoalesceUndo` (`undo-boundaries.ts:187-196`). That function rewrites the top entry in place (Task 611) and does not call the wrapped `addToUndoStack`. So `takePendingBase` (`undo-keybind.ts:100`, called only from the wrapped `addToUndoStack` and `vmdeSeedBaseline`, from Undo and Redo, and from `compositionstart`) does not run before the DOM changes.
3. `applyVisual` (`block-transform-command.ts:1219`) changes the DOM. The post-checkpoint (`:1237`, the wrapped `addToUndoStack`) then takes the pending base and reads the transformed text. Host log: `history-base` with content `before\n\n## alpha **beta**\n\nafter\n`, paired with host text `before\n\nalpha **beta**\n\nafter\n` (`synced: true`). Ten ms later the exact Turn Into edit arrives.
4. Undo works: one native step, exact proof.
5. Redo: the transition (before `alpha…`, after `## alpha…`) is proved already at its result through the wrong base, because the base maps the webview's `## alpha…` to the host's `alpha…` (`history-coupling.ts:98`, `alreadyAtResult`). It is accepted with no native step (version stays 3). The webview's later plain edit of `## alpha…` is swallowed as the history echo (`consumeEdit`, `history-coupling.ts:180`). The host stays at the pre-action text, which is the failure.

**Timing control.** A probe copy of C1 that adds webview reads after readiness passes in both of its runs (`P1`, `P2`). In those runs the idle callback took the base at the correct text before Turn Into (`history-base` content `alpha…`), and Redo walked one native step. So the failure needs an action whose first undo-stack call is a coalescing pre-checkpoint, made before the first idle period after open. The specs act right after readiness. A user can do the same right after opening a file.

**Cause.** Task 641's deferred history base (`ec671180`) does not account for Task 611's in-place pre-checkpoint, which bypasses the wrapped `addToUndoStack`. The base is then read after an editor action has changed the DOM, and that wrong base later proves a Redo with no native step.

### C4 and C6 (first bad `773372a1`): two causes, not one

**C4 (`callout-authoring.spec.ts:174`) is a test defect.** Since `773372a1` the callout apply plans on the acquired exact host text and keeps every host byte outside the callout span (the Task 630 rule). Before it, the SV apply transformed `getValue()`, which carries Vditor's appended Source newline, so the host gained a trailing blank line. The spec's expectations at `:173` and `:185` (`…edited\n\n`) encoded that leaked newline. The host held `> [!TIP] WYS title\n> alpha body edited\n` before the SV apply, and the spec's own removal expectation at `:182` has one `\n`. Measured: with only `:173` and `:185` changed to `…edited\n'`, the whole spec passes on unchanged `79c0a367` (`P6-run.log`, 1 passed).

**C6 (`toolbar-overflow.spec.ts:1162`) is a product defect.** The failing poll is the webview value poll (`:1141-1162`), not the host poll: the SV insertion makes no DOM change and posts nothing (`P4-host.log`: no `edit` after the SV history base). Decline log (`P5-web.log`) for the SV prose target:
- the acquired pair has `rendered` 187 characters ending `\n` (edit-sync snapshot form);
- the captured `renderedMarkdown` (`emoji-insertion.ts:264`, `outer.getValue()`) is 188 characters ending `\n\n` (Vditor's appended Source newline);
- `renderedEqual: false`, `bookmarkIsCurrent: true`.

The strict check `pair.rendered !== captured.renderedMarkdown` (`emoji-insertion.ts:483-488`) declines. In IR the two forms are equal (187/187) and the insertion works. This is the same SV form mismatch as Tasks 677 and 684. Sibling actions in the same commit family compare with `sameRenderedText` (`id-insertion.ts:288`, `inline-picture.ts:537`; defined at `rewrap-command.ts:269`), which ignores line-ending form and trailing blank lines.

### Fix plan

**Step F1: Redo group (product).**
- RED (Vitest, `media-src/src/editing/undo-keybind.test.ts`, new `describe('installVditorHistoryCoupling deferred base')`): install the coupling on a fake engine whose first entry is recorded by `addToUndoStack` (base deferred, idle not run), change the document text, then run `checkpointOrCoalesceUndo` on the coalescing path. Expected: `onHistoryBase` reports the text before the change. Fails today, because the base is reported only at the next wrapped call, with the changed text. A second case in `undo-boundaries.test.ts`: `checkpointOrCoalesceUndo` calls the pending-base take before it reads or rewrites the stack, on the coalesced, unchanged and pushed paths.
- Fix: expose the pending-base take on the shared undo object (installed by `installVditorHistoryCoupling`, for example `undo.vmdeTakePendingBase`) and call it first in `checkpointOrCoalesceUndo`. Keep the idle-time deferral of Task 641 for the open, so no serialization moves back onto the open path. Leave the history-coupling proofs unchanged (Task 606/607 rules unrelaxed).
- Checks: the two Vitest files; `node build.mjs`; real VS Code `block-transform.spec.ts` (the three cases, title filter); `turn-into-undo-step.spec.ts` once (Turn Into Undo/Redo after typing).

**Step F2: C6 (product).**
- RED (Vitest, `media-src/src/editing/emoji-insertion.test.ts`): SV bookmark whose `renderedMarkdown` ends with Vditor's extra newline while the acquired `rendered` lacks it. Expected: the insertion applies on `pair.exact` and posts `syncExact` with exact bytes; today it returns `null`. Keep a case where the acquired rendering differs inside the text (typing settled by the acquire): it must still decline.
- Fix: replace the strict equality at `emoji-insertion.ts:485` with `!sameRenderedText(pair.rendered, captured.renderedMarkdown)`. `bookmarkIsCurrent(captured, deps, false)` still checks the live `getValue()` against the capture, and the offsets are still mapped and proven on `pair.exact`.
- Checks: the Vitest file; `node build.mjs`; real VS Code `toolbar-overflow.spec.ts -g "transactions in (ir|wysiwyg|sv)"`.

**Step F3: C4 (test only).** In `test/vscode-e2e/callout-authoring.spec.ts`, set the expectations at `:173` and `:185` to `'> [!CAUTION] SV title\n> alpha body edited\n'`, with a one-line comment: the SV apply keeps the host's bytes outside the callout (Task 630). Check: the spec once (already measured green on `79c0a367`).

**Closure.** One wrapper round with the six acceptance cases (three invocations, one spec file each), then `turn-into-undo-step.spec.ts`, `exact-action-neutral-bytes.spec.ts` and `undo-host-coupling.spec.ts` once each as the specs sharing the changed history code. Then `npm run quality`, the record update and a final diff review.

### Tier

F1 and F2: **Medium** (one mechanism each, a small product change with Vitest RED, real-VS-Code confirmation). F3: **Light**. F1 and F2 touch different files and can be one combined RED+fix step.

### Provisional decisions

- Provisional decision (2026-11-02), reversible — Redo fix: take the pending history base at the start of `checkpointOrCoalesceUndo` through a hook installed by the history coupling, keeping Task 641's idle deferral. Probability 0.99. Alternatives: take the base in the message router before every host-triggered editor action (0.01); revert the deferral (0.00; it loses the measured open-time gain); a host guard that refuses a base whose webview text does not render like the paired host text (0.00).
- Provisional decision (2026-11-02), reversible — C6 fix: compare the acquired and captured renderings with `sameRenderedText`, as the sibling Insert ID and Insert Picture actions do. Probability 0.81. Alternatives: capture the rendering in edit-sync snapshot form in SV (0.10); strip one trailing newline in SV only (0.08).
- Provisional decision (2026-11-02), reversible — C4 is a test defect, fixed in the spec only. The new bytes are the Task 630 contract, so no product change. Probability 0.95 (measured: the spec passes with the corrected expectations). Alternative: restore the extra newline in the product (0.05; it would reintroduce a host-byte change outside the action's span).

### Open questions

None for the Owner. Before F2, the implementer should check whether a typed Enter at the document end (a trailing-newline-only change) can race the acquire and pass `sameRenderedText`. `bookmarkIsCurrent` re-checks the live `getValue()` against the capture, so such a case should still decline. The F2 RED must include it.

## Part 2 fix (2026-11-02)

Worktree fast-forwarded to `dev` (`927cffac`) first; only this record was modified.

### Changes

- **F1 (Redo group), `media-src/src/editing/undo-keybind.ts` and `undo-boundaries.ts`.** `installVditorHistoryCoupling` now installs `undo.vmdeTakePendingBase` (the existing `takePendingBase`). `checkpointOrCoalesceUndo` calls it first (a coalesced or unchanged checkpoint never reaches the wrapped `addToUndoStack`) and again after its own push (on an empty history that push creates the base and defers reading it). Task 641's idle deferral for Vditor's own timer stays; no allocation was added on the keystroke path (a call of an existing closure, and only inside the editor-action checkpoint).
- **Correction to the B2 plan.** The first version of F1 (take the base only before coalescing) did not fix the cases: a real-VS-Code run still failed the three Redo polls. A host log of that run showed why: on a freshly opened document the stack is empty, so Turn Into's pre-checkpoint is the push that creates the base, and the base was still read after the transform. The second call after the push fixes it. The B2 write-up named the coalescing path only; the empty-history push is part of the cause.
- **F2 (C6), `media-src/src/editing/emoji-insertion.ts:485`.** `pair.rendered !== captured.renderedMarkdown` became `!sameRenderedText(pair.rendered, captured.renderedMarkdown)`, the same helper Insert ID and Insert Picture use, imported from `rewrap-command`.
- **F3 (C4), `test/vscode-e2e/callout-authoring.spec.ts:174` and `:186`.** The two SV expectations lose the extra trailing newline, with a one-line comment (Task 630 contract).

### RED lines

- `undo-boundaries.test.ts` (`-t "Task 692"` on the unchanged product): the coalescing case fails at `:1839` (`onHistoryBase` called 0 times); the unchanged-or-pushed case fails at `:1857` (0 calls); the empty-history push case (added after the real-VS-Code correction) fails with 0 calls. All pass after the change.
- `emoji-insertion.test.ts` (unchanged product): the two accept cases (one extra trailing newline in the acquired form; CRLF in the acquired rendering) fail with `expected undefined to be 'success'`; the decline-inside-text case passes before and after. 2 failed, 24 passed before; 26 passed after.
- F3: failed at `callout-authoring.spec.ts:174` in B0, passes after (below).

### Checks

| Check | Exit | Result |
|---|---|---|
| `vitest` on `undo-boundaries`, `undo-keybind`, `emoji-insertion` tests | 0 | 3 files, 282 passed |
| `npx biome check` on the six changed files | 0 | clean |
| `npm run typecheck` | 0 | clean |
| `npm run typecheck:vscode-e2e` | 0 | clean |
| `node build.mjs` | 0 | built (after the final change) |
| Real VS Code `block-transform.spec.ts`, whole file | 0 | 9 passed |
| Real VS Code `callout-authoring`, `turn-into-undo-step`, `exact-action-neutral-bytes`, `undo-host-coupling` | 0 | 13 passed (28.5 min) |
| Real VS Code `toolbar-overflow.spec.ts -g "Emoji 17 pointer|Emoji picker preserves exact"` | 0 | 4 passed (C5, C6 in SV, and the IR and WYSIWYG instances) |
| `npm run quality` | 1 | `check:brand-identifiers`, `lint:ci`, `knip`, `jscpd`, `depcruise`, `test:coverage` (384 files, 8484 passed, 1 expected failure), `check:coverage-modules` pass; `audit` fails (omitted by Owner rule, not blocking; the network audit was not investigated) |

A first real-VS-Code round with the first version of F1 (before the correction) passed 19 of 22: the three Redo cases failed, everything else passed. Logs are in `tmp/692/fix/`.

### Residual risks

- C5 (`Emoji 17 pointer selection`) is intermittent and passed in this round; Task 695 owns the repeat runs.
- The empty-history push now reads the document text in place at the first editor action of a session, as before Task 641 for that action only; the open path keeps the idle deferral. The 277-340 ms serialization on a 150 KB file can move to a user's first Turn Into, Rewrap or similar action. Not measured here.
- Other callers of `checkpointOrCoalesceUndo` (Rewrap, Details, tables) now take the base too; the three specs above and the Chromium paths were not rerun for them.
- Changed-line coverage was not inspected separately; the new branches are covered by the Vitest cases above.
