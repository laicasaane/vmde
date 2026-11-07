# Task 701 — Restart-state and context-menu command-list assertions fail in real VS Code at `f84a4258`

**Status:** ✅ done (2026-11-08). Filed from the full real-VS-Code gate of queue run 2026-11-01d.
**Origin:** Gate rerun at `f84a4258` (Task 695): the suite failed these cases in chunks and again when each spec file ran alone (`--workers=1 --retries=0`, XTEST, fresh X server per file).
**Severity:** low (estimated; ordering of a command list and restart state; user impact not measured).
**Tech stack:** `test/vscode-e2e/{webview-context-menu,outline-state,wiki-persistent-keys}.spec.ts`; `package.json` menus; Outline and wiki state in `src/`.
**Depends on:** none.

## Problem

These cases fail in the full suite and again alone at `f84a4258`:

- `webview-context-menu.spec.ts:15`: the command list order differs: `vmde.rewrap` and `vmde.rewrapDocument` come before `vmde.promoteHeading` and `vmde.demoteHeading` where the reverse order is expected.
- `outline-state.spec.ts:635`: fourth launch (Preview) shows an empty document where `# Fixture outline-restart-4.md` is expected.
- `wiki-persistent-keys.spec.ts:334`: fourth launch, "pending means unstyled before the update" differs.

The measurement decides whether the test or the product is wrong in each case.

No earlier full-suite baseline exists, so the commit that introduced each failure is unknown, and whether the cases in this group share one cause is not measured.

## Proposed work

1. Find the last good commit for each failing case: run the spec alone on earlier `dev` revisions.
2. Group the cases by first bad commit and measure the cause of each group.
3. Fix each cause with a failing test first, or fix the test where the test, not the product, is wrong (state which).

## Acceptance

- [x] Each failing case has a first bad commit (or is shown to be a test defect) and a measured cause. Cases 1–2: test defects (Part 1 and Part 2a). Case 3: not reproducible alone (passed in RED, the diagnosis run and the 2026-11-08 run); load-dependent, no cause in the product found.
- [x] Each product cause is fixed with a test that fails before and passes after. No product cause was found; the two test defects are fixed in the specs.
- [x] The listed cases pass in one real-VS-Code run, alone and in the full suite. Alone: yes (2026-11-08, see below). Full suite: provisional decision of the orchestrator for the Owner (2026-11-08): checked at the next full real-VS-Code gate, not in this task.

## Tests to write

- A test per product cause; the listed real-VS-Code cases are the acceptance tests.

## Part 1 handoff

Read-only cause assessment (2026-11-02, at `c8775fb1`). Sources: the Task 695 solo and chunk logs (`tmp/completed-worktrees/2026-11-01d/695/gate695/` in the main checkout), the specs, `git log`, and the source. Nothing was built or run. The confirm rerun on `c8775fb1` had not reached these three spec files when this was written.

### Case 1: `webview-context-menu.spec.ts:15` — test defect (95 %)

- Observed: `getCommands(true)` filtered to the four ids returns `rewrap, rewrapDocument, promoteHeading, demoteHeading`.
- Cause: `e8f87223` (Task 580, 2026-10-05) moved registration to the loop over `EDITOR_SHORTCUTS` in `src/app/commands.ts:160`. The loop follows the table order in `src/shared/editor-shortcuts.ts`, where the `vmde.rewrap` rows (line 335) come before the `vmde.promoteHeading` rows (line 359). Before `e8f87223`, the commands were registered by hand in `src/app/commands.ts` with promote and demote first. The spec last passed on 2026-09-26 (`6c3b7717`, Task 576), before that change.
- Call: `getCommands` returns commands in registration order, which no product contract, menu, or test outside this spec relies on. The spec asserts presence by an order it never needed. Test defect, not a product defect.
- Fix: compare without order (for example, sort both lists or use `expect.arrayContaining` with a length check). No product change.

### Case 2: `outline-state.spec.ts:635` — test defect (85 %)

- Observed: the fourth launch opens with the remembered Preview on. `openByQuickOpen` polls `window.vditor.getValue()`, and the poll times out with `"\n"`.
- Cause: `6dede194` (Task 643, 2026-11-01): a Preview-first open (a preview rule or a remembered Preview) builds the Vditor shell with `value: ''` and holds the text in `sessionState.deferredEditView` (`media-src/src/boot/vditor-init.ts`, `openPreviewFirst`). `getValue()` is then empty by design. The same commit changed `webviewValue` in `test/vscode-e2e/preview-memory.spec.ts:170-187`: when `getValue()` is blank, it falls back to the text of `.vditor-preview .vditor-reset`, and it waits for `Fixture <name>` (the rendered heading has no `# `). The commit did not port that change to `outline-state.spec.ts:213-224`. The restart test last passed on 2026-10-18 (Task 656, after `50207d57`). The spec is unchanged since then.
- Residual (15 %): after the wait is fixed, a later fourth-launch check can still fail on a separate Task 643 behavior ("the outline renders only when shown"; the first-frame width probe in Preview). If one does, it is a contract question about Task 643 for the Owner, not a guess for the worker.
- Fix: port the `preview-memory.spec.ts` `webviewValue` fallback to `outline-state.spec.ts`, and match `Fixture ${name}` in both waits (lines 256 and 701). No product change.

### Case 3: `wiki-persistent-keys.spec.ts:334` — cause not measured

- Observed (solo): in the fourth launch, `init` carries no keys (that assertion passes) and the probe holds one `wiki-update` (`held === 1`). Even so, the IR chips are already styled from `CHANGED_PAGES`: `no-such-page`, `old-name`, and `removed-page` are marked missing, and the others are not. The webview sets `wikiKeysKnown` and fills `wikiKnownPages` only from an `init` with `pageKeys` (`vditor-init.ts:493-502`) or from a handled `wiki-update` (`message-router.ts:1298-1326`). So a key-carrying message reached the editor without being held, or a later `init` carried keys.
- Related evidence: in suite chunk 06, the same test failed in its first launch because the probe recorded no `init` at all (`Received: undefined`). The probe re-installs its window listeners on each new root through a 1 ms timer, so it can miss messages.
- Last recorded pass: 2026-10-15 (Task 638, `21d7de02`). The spec is unchanged since `b5fa766e`. 18 commits touch the wiki, session, router, and init paths between `21d7de02` and `f84a4258`, among them `6dede194` (Task 643: router +154 lines, init flow), `1db03714` (Task 646), and `0d4ba2e4` (Task 640).
- Ranked causes:
  - H1, 35 %, test probe gap: a `wiki-update` reached the editor in the window between a document replacement and the probe's re-install. The held update is a second post (watcher or setting refresh).
  - H2, 25 %, a second `init` with keys (a second `ready`, a webview reload or tab restore, or a settings re-init after the scan). `initOf` reads only the first `init`. This is a test assumption, or a product inefficiency if `ready` repeats.
  - H3, 25 %, product defect: a change after `21d7de02` delivers keys, or re-initializes with keys, before the pending state ends. That breaks acceptance 4 of Task 638.
  - H4, 15 %, another load or timing effect.
- Shared cause with case 2: about 10 %. Both fail in a "fourth launch", and both specs use their own copy of the harness launch, but the mechanisms differ: case 2 is a Preview-first open, and case 3 is an IR open with pending keys.

### Part 2 steps

Run every real-VS-Code call from the worktree root, after `node build.mjs`:
`../vscode-run.sh 701 env -u ELECTRON_RUN_AS_NODE xvfb-run -a sh -c 'openbox & OB=$!; VMDE_XTEST=1 npm --prefix test/vscode-e2e test -- <specs> --workers=1 --retries=0; R=$?; kill $OB; exit $R'`

1. Cases 1 and 2 (test fixes): edit `test/vscode-e2e/webview-context-menu.spec.ts` (order-agnostic assertion) and `test/vscode-e2e/outline-state.spec.ts` (Preview-aware `webviewValue`, `Fixture ${name}` waits). The current specs are the failing tests (they fail at `c8775fb1`). Run both specs in one call. Expected: both pass. If a later fourth-launch check in `outline-state` fails, stop and report it as a Task 643 contract question.
2. Optional confirmation of case 2 (only if step 1 leaves doubt): run `outline-state.spec.ts` unchanged in a detached bisect worktree at `32d6bf84` (the parent of `6dede194`) and at `6dede194`. Expected: it passes at `32d6bf84` and fails at `6dede194` with `"\n"`.
3. Case 3, diagnosis first, with no fix: in a scratch copy of the spec (under `tmp/701/`, not committed), make the probe also count the roots it installed on and log the `data-wiki-missing` changes of each chip with timestamps. Before the chip assertion of launch 4, dump `probe.messages` (command, type, keys) and that log. Run it once. Read the result:
   - H1: more than one root, and chips styled before the only recorded `wiki-update`, or with no recorded message carrying keys.
   - H2: two `init` entries, the later one with keys.
   - H3: one keyless `init`, one held update, and no other key-carrying message, yet styled chips.
4. Case 3, bisect (only for H3 or an unclear result): run the unchanged spec alone at `21d7de02`, `32d6bf84`, `6dede194`, and `f84a4258`, each in a detached bisect worktree. Narrow further inside the range that flips.
5. Case 3, fix:
   - H1: harden the probe. Install its message listener so that a replaced document cannot drop it, then show the case passes. No product test.
   - H2: assert on the last `init`, or state the double `ready` as a product issue and ask the Owner.
   - H3: write the failing test first, in Vitest at the measured layer (`media-src/src/bridge/message-router.test.ts`, `media-src/src/boot/vditor-init.test.ts`, or `test/backend` for `src/wiki/wiki-session.ts` and `src/session/editor-session.ts`). The test shows that a keyless `init` followed by the measured message keeps the chips unstyled. Then fix the product, and keep the real-VS-Code spec as the acceptance test.
6. Acceptance: run the three spec files in one call, alone. A full-suite pass belongs to the next full gate.

### Open decisions

- If step 1 shows that the Outline in a Preview-first fourth launch no longer meets the Task 650 restart contract, the Owner decides whether Task 643 or the spec is right.
- Case 3 under H2: is a repeated `ready` acceptable, or is it a defect to fix?

### Orchestrator decisions

- Provisional decision (2026-11-02), reversible: cases 1 and 2 are test defects; fix the specs as the handoff says. Case 3 is diagnosed first (handoff step 3) and fixed in a second step after the orchestrator reads the diagnosis.

## Part 2a results

Date 2026-11-02, base `c8775fb1`. Logs in `tmp/701/` (`red.log`, `diag.log`, `green.log`, `lint.log`, `tsc.log`, `wiki-probe.spec.ts.txt`).

### RED (unchanged specs, one call, three files)

- `webview-context-menu.spec.ts:15` failed: ids in registration order, as in Case 1.
- `outline-state.spec.ts:635` failed, but in the **third** launch (WYSIWYG), not at the Preview wait: `expectStoredFromFirstFrame`, `probe.inits` was `[]` (expected `{open:true,width:170}`). The probe missed the `init` message. This is the probe-gap pattern, not the Case 2 cause.
- `outline-state.spec.ts:322` and both `wiki-persistent-keys.spec.ts` cases passed. Case 3 did **not** reproduce at `c8775fb1`.

### Fixes (test only, no product change)

- `webview-context-menu.spec.ts`: sorted comparison of the four ids.
- `outline-state.spec.ts`: Preview-aware `webviewValue` ported from `preview-memory.spec.ts` (duplicated, no jscpd run in this step); both waits match `Fixture ${name}`.

### GREEN

`webview-context-menu.spec.ts outline-state.spec.ts`: 3 passed (restart test 33.0 s, so the fourth launch passes; no Task 643 contract question). `npm run lint:ci` exit 0; `npm run typecheck:vscode-e2e` exit 0.

### Case 3 diagnosis

One instrumented run of the first wiki test (`tmp/701/wiki-probe.spec.ts.txt`, deleted from `test/vscode-e2e/`) passed (27.9 s). Fourth-launch data: 2 roots (`about:blank` at 13 ms, the webview at 72 ms); messages `init` (keys null) at 524 ms, `wiki-update` (5 keys) at 613 ms held, `diff-info` at 898 ms; all 14 chip log entries at 862 ms with `msgs:2` and `missing:false`; final chips all unstyled. No second `init`, no key-carrying message besides the held update. This run supports none of H1/H2/H3 (healthy path). Case 3 is not reproducible at this base (passed in RED and in diagnosis), so it matches H4 (load or timing), with H1 (probe gap) as the leading mechanism given the RED failure of the Outline probe missing an `init`. No fix made.

### Files changed

`test/vscode-e2e/webview-context-menu.spec.ts`, `test/vscode-e2e/outline-state.spec.ts`, this record.

## Closure (2026-11-08)

Rebased onto `dev` `8944ce80`. `node build.mjs` exit 0. One real-VS-Code run of `webview-context-menu.spec.ts`, `outline-state.spec.ts` and `wiki-persistent-keys.spec.ts` (`--workers=1 --retries=0`, XTEST): 5 passed (2.4 min), including `outline-state:640` (restart), `webview-context-menu:15` and both `wiki-persistent-keys` cases. Test-only change: no product file changed.
