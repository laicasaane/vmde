# Task 693 — `caret-tab-return.spec.ts` loses the anchor line in IR, WYSIWYG and SV

**Status:** done (2026-11-02; test defect, fixed in the spec). Filed from the full real-VS-Code gate of queue run 2026-11-01d.
**Origin:** Gate suite on `dc622900` (2026-11-01), confirmed by a rerun of the spec file alone (2026-11-02).
**Severity:** medium (estimated; the caret-after-tab-return behavior or its fixture setup is broken in all three modes).
**Tech stack:** `test/vscode-e2e/caret-tab-return.spec.ts` (`:181`, `:241`), the caret restore on webview focus return (`media-src/src/editing/caret-preserve.ts`, `media-src/src/editing/focus-restore.ts`).
**Depends on:** none.

## Problem

All three cases fail alone and in the suite with the same assertion: the expected substring `Anchor line BRAVOα` is not in the received text, which starts with `# Torture document`. The cases are `:181` (IR) and `:241` (WYSIWYG and SV). Whether the anchor text is never inserted, inserted elsewhere, or read from the wrong place is not measured. The first bad commit is unknown.

## Proposed work

1. Read the failing assertion and the received text in full; decide whether the caret or the fixture setup fails.
2. Find the first bad commit by running the spec alone on earlier `dev` revisions.
3. Fix the cause with a failing test first, or fix the test if it is wrong (state which).

## Acceptance

- [x] The cause and the first bad commit (or test defect) are recorded. Evidence: Part 2 M2: test input defect; the XTEST keystroke for `α` arrives with no character and no input event, before any editor code runs. No first bad commit in the product.
- [x] The three cases pass in real VS Code. Evidence: Part 2 closure run, `caret-tab-return.spec.ts` 4 of 4 under XTEST.
- [x] Any product fix has a regression test that fails before the fix. Not applicable: no product change. The three cases themselves failed before the spec fix (orchestrator check at `e39bb013`: WYSIWYG and SV; gate: all three) and pass after it.

## Tests to write

- The three existing cases are the acceptance tests; a Vitest case for any product cause.

## Part 1 handoff (2026-11-02)

Source reading, gate logs and gate artifacts only. No real VS Code was run, no Vitest was needed, and no product code was changed.

### What the spec does

`test/vscode-e2e/caret-tab-return.spec.ts`, cases `:181` (IR) and `:241` (WYSIWYG, SV). The case `:305` (scroll) passes; it types nothing.

1. `boot()` writes a copy of `fixtures/torture.md` to a unique temporary path, closes all editors, opens the copy with `vmde.editor`, waits for `.vditor-ir` and settles 1.5 s.
2. WYSIWYG and SV only: the case clicks the edit-mode toolbar button and the mode button, waits for the mode surface, and polls until its text contains `Anchor line BRAVO`.
3. `caretAfter()`: a pointer click at (4, 4) of the surface (to focus the webview), then a script-written collapsed selection just after `Anchor line BRAVO` in its text node. The `focus()` call on the paragraph does nothing, because a `<p>` is not focusable.
4. `settle(400)`, then `createSpecKeyboard()`. With `VMDE_XTEST=1` this activates the X11 client and types through `xdotool`. Without it, the keyboard goes through the browser protocol.
5. `input.type('α')`, then the case polls the host `TextDocument` for 20 s for `Anchor line BRAVOα`. **All three cases fail here** (`:205`, `:281`). The tab switch, the focus checks and the `Ω` check are never reached.

### Measured facts from the gate artifacts

- The gate and the alone rerun used `VMDE_XTEST=1` (the log has `[keyboard XTEST]` before each case) on VS Code 1.129.0.
- At the failure, the received host text is the fixture without `α`. The page snapshot shows the anchor paragraph without `α` too, so the character is in neither the DOM nor the host. Focus (`[active]`) is on the editable surface. The status bar's Notifications button shows no new notification, so the host's stale-edit warning (Task 646) was probably not shown.
- In the same gate, XTEST typing of non-ASCII text passes in `caret-empty-typing.spec.ts` (`Zażółć` on an empty document, no script-written selection), and `caret-on-open.spec.ts` passes.

### Product path exercised

Trusted key in the webview → capture listeners: `undo-boundaries.ts` `onKeydown`/`onSeedEvent` (Task 598 first-action seed, `seedUndoBaseline`), `undo-keybind.ts` deferred history base (Task 641), `caret.ts`/`editor-caret.ts` gesture and caret-intent handling → Vditor's native insertion and render timer → `edit-sync.ts` debounced `edit` post with `revision` → host `editor-session.ts` `queueEdit` (`refuseStaleEdit`, Task 646) → `WorkspaceEdit` on the `TextDocument`. The focus-return code (`focus-restore.ts`, `caret-preserve.ts`) named in the header is not reached by the failing step.

### Last pass and commits on the path

- Last recorded pass: Task 578 acceptance run (2026-09-28, 4/4 under XTEST, VS Code 1.129.0), on the tree that became `7a5d340b`. The spec file has not changed since `7a5d340b`. No other recorded run of this spec exists between that run and the gate at `dc622900`. 509 commits separate the two.
- Commits on the path in that range (newest first, selection): `fbe97b56` (677, auto-wrap owns the next IR typing publication), `e7e73b39` (673), `179fa1b8` (683, caret intent after undo snapshot), `ce4931d5` (664, selection writes retire a caret intent), `e8325451` (624, late debounce timer), `1db03714` (646, stale-edit refusal by revision), `6dede194` (643, Preview-first open and deferred edit view), `773372a1` (630), `ec671180` (641, history base in idle time; Task 692 proved it breaks fresh-open Redo), `129e43a3` (641, init before incremental seed), `ce71a34b` (609), `4a67f16d` (615), `6f1b9f37` (603), `922a0686` (598, first undo snapshot seeded at the first user action), `2cfe9077` (601), `929c6f6d` (613, root-range selections through Vditor's delayed snapshot), `2faa9fbc` (580, native editing guard), `52cb32ff` (held drags and caret re-arm).
- After the gate (on this branch, not in `dc622900`): `446e7aa0` (688, seed history before first actions after open), `80871f91` (692, deferred base before an action's checkpoint), `6efcab8d` (690). These touch the same first-action history path, so the failure must be re-confirmed at the branch head first.

### Candidate causes (ranked)

1. **0.30 — the first trusted key after open is rolled back by the first-action history seed or the deferred history base** (`922a0686`, `ec671180`). The typed character is the first edit after open, made on a script-written selection. A seed or base read that restores or re-renders from the pre-edit text would remove `α` from the DOM before it is posted. Fits "absent in DOM and host" and the Task 692 precedent.
2. **0.20 — the script-written selection is overwritten before the key, and the insertion lands where it is dropped** (`929c6f6d`, `ce71a34b`, `ce4931d5`, `179fa1b8`). Task 580's helper notes that Vditor's first undo snapshot arms a caret re-assert loop that overwrites a spec-written selection for up to 5 s; this spec does not wait for that snapshot. If the fix is to wait, it is a test defect; if the loop drops a typed character, it is a product defect.
3. **0.20 — another change in the range** (`6dede194` deferred edit view, `fbe97b56` auto-wrap owning the typing publication, `e8325451`), not specific enough to rank alone.
4. **0.15 — the host refuses the edit as stale and re-posts the old text** (`1db03714`). Fits the absent `α`, but no warning notification was visible.
5. **0.15 — test input defect: the XTEST `α` keystroke never reaches the editor.** Weakened: non-ASCII XTEST typing passes in the same gate, and focus is in the editor.

**Product or test defect:** not measured. Provisional decision (2026-11-02), reversible: treat it as a product defect (probability about 0.65), because the spec and its input helper did not change in the failing range except for helper additions, and the evidence points at the first-edit path.

### Part 2 plan

Provisional decision (2026-11-02), reversible: measure first, then bisect (probability 0.86 against bisecting first, 0.10). The bisect still runs to record the first bad commit, which the acceptance requires; the measurement chooses its check points.

**M1 — confirm at the branch head.** `node build.mjs`, then the spec alone:

```
../vscode-run.sh 693 env -u ELECTRON_RUN_AS_NODE xvfb-run -a sh -c 'openbox & OB=$!; VMDE_XTEST=1 npm --prefix test/vscode-e2e test -- caret-tab-return.spec.ts --workers=1 --retries=0; R=$?; kill $OB; exit $R'
```

If all four pass at the head, record that `446e7aa0`/`80871f91` fixed it (bisect the fixing commit only if the record needs it) and close with the gate evidence.

**M2 — one instrumented run (IR case, then WYSIWYG if IR does not explain both).** A temporary probe copy of the spec in `test/vscode-e2e/` (deleted before closure), run with the same wrapper and `-g "leaving the VMDE tab"`. Log, from just before `caretAfter` until the poll ends:
- webview: capture-phase `keydown`, `beforeinput`, `input` (`inputType`, `data`, `defaultPrevented` after dispatch, target), `selectionchange` (start container text and offset), `document.activeElement`, the anchor paragraph's `textContent` at 0, 50, 200, 1000 ms after the key, the active mode's `undoStack.length` before and after the key, and Vditor's `setValue`/undo `renderDiff` calls (wrap them);
- webview → host: every posted `edit` message (`content` contains `α`?, `revision`), and every `update` the webview receives (`revision`, contains `α`?);
- host: `onDidChangeTextDocument` events for the file (whether any contains `α`).

Reading: no `beforeinput` → test input (cause 5); `beforeinput` cancelled → a guard; `input` then the paragraph loses `α` with an undo/`setValue` call → cause 1; selection moved before the key → cause 2; `edit` with `α` posted and an `update` without it → cause 4.

**B — bisect `7a5d340b..dc622900`** in a detached worktree under `tmp/693/` created by the orchestrator (no git state change in this worktree). Per step: `node build.mjs`, then the IR case alone with the M1 wrapper and `-g "leaving the VMDE tab"`. Bad = the `:205` failure (`Anchor line BRAVOα` missing); any other failure or a build failure = skip. Confirm the good end (`7a5d340b`) first. Use the M2 result to test the matching candidate commits first (for cause 1: `922a0686`, then `ec671180`). Stop rule: stop at the first bad commit, confirmed by a second run at it and at its parent; if a step gives mixed results in two runs, stop and report it as intermittent; at most 12 runs.

**Fix and closure.**
- Product cause: a Vitest case in the owning module that fails before the fix (for cause 1, a first-key seed on a document with content and a script-written selection keeps the typed character), shown RED, then the fix.
- Test defect: fix the spec (for cause 2, wait for Vditor's initial undo snapshot with `waitForInitialUndoSnapshot` before `caretAfter`), and state it as a test defect with the measurement.
- Closure checks: the four cases of `caret-tab-return.spec.ts` with the M1 wrapper; the real-VS-Code specs of the changed module's surface (for the history path: `caret-on-open`, `caret-empty-typing`, `undo-redo-steps`); the focused Vitest files; `npm run typecheck`, `biome check` on changed files, and `npm run quality` for a product change.

**Tier:** Provisional decision (2026-11-02), reversible: high-effort tier for all of Part 2 (probability 0.94), because the cause is unmeasured and crosses host, webview history and real-VS-Code focus, as in Task 692. Not higher: the plan is bounded by M2 and a stop-ruled bisect.

## Part 2 — measurement (2026-11-02)

Base: `e39bb013` (includes Tasks 688, 690, 691 and 692). Orchestrator check before this part: the IR case and the scroll case passed; WYSIWYG and SV failed at `:241`.

**M2.** A temporary probe spec (`test/vscode-e2e/caret-tab-return-693-spike.spec.ts`, deleted before closure; a copy is kept in `tmp/693/`). It repeats the WYSIWYG/SV case steps up to the first keystroke. Webview logging: capture- and bubble-phase `keydown`, `keyup`, `beforeinput`, `input` and composition events (`key`, `code`, `keyCode`, `inputType`, `data`, `defaultPrevented`), `selectionchange`, `activeElement`, the anchor line text, the undo stack length per mode, and calls of `setValue` and the undo methods. Host logging: `onDidChangeTextDocument` for the file, and every host message the webview receives. Wrapper command: XTEST form with `VMDE_SPIKES=1` and `--workers=1 --retries=0`.

| Run | Case order in one X server session | First character delivered? |
| --- | --- | --- |
| 1 | WYSIWYG, SV | WYSIWYG yes; SV no |
| 2 | IR, WYSIWYG, SV, IR, WYSIWYG, SV | first IR yes; the other five no |

- In every lost case the only event is one `keydown` with `key` `"\0"`, empty `code` and `keyCode` 0, then `keyup`. No `beforeinput`, no `input`, no DOM change, no `edit` and no host change. Focus and the script-written selection are on the anchor line when the key arrives.
- In every delivered case: `keydown` `key` `"α"`, then `beforeinput`/`input` `insertText "α"`, and the host document receives `α`.
- `xdotool` 3.20160805 types a character that is not in the X keymap by binding its keysym to a spare keycode for one keystroke and unbinding it after (checked in a private X server: no Greek keysym remains in the keymap after each `type`). The webview receives the lost keystrokes with no keysym.
- The XTEST helper (`test/vscode-e2e/helpers/xtest-input.ts`) has not changed its typing path since the last pass (`7a5d340b`). The packages `xvfb`, `xserver-xorg-core` and `xserver-common` were upgraded on 2026-11-01 at 01:00, before the gate run that evening. This is the likely reason the run that last passed (2026-09-28) delivered every `α`. It is not proved.

**Answers to the open points.**
- Where the first typed character goes: nowhere. It is lost in X11 input delivery, before the webview gets a character.
- IR now passes only because it is the first case in the file, so its `α` is the first in the X server session. Run 2 shows a later IR case fails the same way. Tasks 688/692 do not explain it. Their first-action seeds never run in a lost case, because no input event arrives.
- Bisect: skipped. The measurement names the mechanism, and the product is not involved.

**Part 1 correction.** The provisional "product defect (0.65)" decision is reversed by this measurement: test input defect. Part 1 candidate 5 was the cause.

## Part 2 — fix (2026-11-02)

The spec now types the ASCII markers `q` and `z` (constants `BEFORE` and `AFTER`, with a comment that gives the measurement) in place of `α` and `Ω`. Every assertion stays the same: the typed character must land right after `Anchor line BRAVO` before and after the tab round trip. ASCII letters are in the keymap, so `xdotool` binds nothing. Neither letter follows `Anchor line BRAVO` in the fixture. No product code changed, so there is no Vitest regression case. The RED evidence is the real-VS-Code failure of the three cases before the change.

## Part 2 — closure checks (2026-11-02)

| Command | Exit | Result |
| --- | --- | --- |
| `npx biome check test/vscode-e2e/caret-tab-return.spec.ts` | 0 | clean |
| `npm run typecheck:vscode-e2e` | 0 | clean |
| `npm run typecheck` | 0 | clean |
| `node build.mjs` | 0 | built |
| XTEST wrapper, `caret-tab-return`, `caret-on-open`, `caret-empty-typing`, `undo-redo-steps`, `first-action-history` (`--workers=1 --retries=0`) | 0 | 16 passed (caret-tab-return 4, caret-on-open 2, caret-empty-typing 1, undo-redo-steps 1, first-action-history 8) |
| Quality stages except audit (Owner rule): `check:brand-identifiers`, `lint:ci`, `knip`, `jscpd`, `depcruise`, `test:coverage`, `check:coverage-modules` | 0 each | `test:coverage`: 384 files, 8,509 tests passed, 1 expected failure |

The audit stage was not run (Owner rule). `npm run quality` runs every stage in one command and has no option to skip one, so the other stages were run one at a time.

Independent diff review: correctness and spec match high, blast radius low. It marked the change for review, not automatic acceptance, because a spec-only fix has no unit test layer.

**Residual risks.**
- Other XTEST cases that type characters missing from the keymap can lose them the same way, after the first such character in an X server session. This includes `caret-empty-typing` (`Zażółć`), which passes now because it runs first. Task 695's unconfirmed XTEST typing failures (for example `github-inline-math`, `html-superscript-editing`) should be checked for this cause; a helper-level fix is a separate task.
- The X server upgrade as the trigger is inferred from package dates, not proved by a downgrade.
