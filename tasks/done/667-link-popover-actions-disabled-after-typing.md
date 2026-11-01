# Task 667 — Link popover Edit and Unlink disabled after typing

**Status:** done (2026-11-01). Filed at the close of Tasks 606 and 630.
**Origin:** Task 630.
**Severity:** low (estimated).
**Tech stack:** `media-src/src/editing/link-popover.ts` (~279-296 `clickSourceBinding`, ~755 `disabled = !record.sourceSpan`).
**Depends on:** Task 630.

## Problem

On a normalizing document the popover Edit and Unlink buttons stay disabled for about 1.2 s after typing. `clickSourceBinding` returns `sourceSpan: null` when the link index has no entry, because typing revoked the owned base; the index is rebuilt only after background acquisition finishes. The Task 630 real-VS-Code cell passes only because it reopens the popover up to 8 times.

## Proposed work

Acquire authority at click time so the binding exists when the popover opens, or rebuild the index synchronously from the acquired pair. Remove the retry loop from `openLinkPopover` in `exact-authority-other-actions.spec.ts`.

## Acceptance

- Edit and Unlink are enabled at once after typing on a normalizing document.
- The spec helper opens the popover without retries.
- `link-popover.spec.ts:241` is a failure that also occurs on `dev`; decide there whether it belongs here.
- [x] Focused real-VS-Code spec written and run; the quality stages pass (the dependency audit stage is omitted by Owner instruction; the aggregate `npm run quality` was not run).

## Part 1 handoff (2026-11-01)

Tier: **Medium** (confirmed). The fix is one module, but it connects the shared source index's authority signal to the popover binding, so Part 2 uses a RED step and then a GREEN step.

### Problem and measured root cause

After typing on a normalizing document, the owned exact base is revoked. A click on a link calls `clickSourceBinding`, which reads `index.read()`. That entry has `units: null` (no owned exact text), so the binding is `sourceSpan: null` and `show()` disables Edit and Unlink. The same `index.read()` already starts the background exact-authority request (`resolvePairUnits` in `media-src/src/nav/source-block-index.ts`). When the reply is adopted, the revision advances and `currentKey()` emits `onInvalidate('revision')`. The popover never subscribes to that signal, so an open popover keeps its click-time binding until it is opened again.

Measurement (scratch real-VS-Code probe, IR, `exact-authority-actions.md`, one typed character):

| Case | Popover shown (Edit disabled) | Exact-authority reply | Edit after 3 s, popover still open | Edit after reopening |
| --- | --- | --- | --- | --- |
| Typing already published | 11699 ms | 11728 ms (+29 ms) | disabled | enabled |
| Typing still pending | 16994 ms | 17021 ms (+27 ms) | disabled | enabled |
| No typing (control) | — | — | enabled at open | — |

The reply arrives within about 30 ms of the click. The "about 1.2 s" in the problem statement is the 1 s wait of the spec's retry loop, not acquisition latency. The defect is the missing rebind, not a slow acquisition.

A related failure has the same cause. `owner.exact` keeps the rendered fallback that `snapshotExactMarkdown` returned at click time. After the reply, `onClick` runs `sameLiveOwner(..., checkExact = true)`, which compares the now-acquired exact text with that fallback and hides the popover. So Open and Copy also stop working on an open popover after the reply, until it is reopened.

### Intended solution

In `media-src/src/editing/link-popover.ts` only:

- `installLinkPopover` subscribes to `deps.index.onInvalidate`. On `'revision'`, while an owner is shown and not editing, it queues one microtask, so the rebind never runs inside the index's own `currentKey()` call.
- The microtask continues only when the same owner is still current and its structural liveness holds (`sameLiveOwner(owner, deps, true, false)`). It then runs `clickSourceBinding` again for the same target and kind. It replaces `owner.exact`, `owner.rendered` and `owner.sourceSpan`, and sets the Edit and Unlink `disabled` state from the new span. It does not reposition the panel or reset the selection. If the liveness check fails, it hides the popover.
- The disposer unsubscribes.

No other module changes. The index already acquires authority at click time and already emits the signal. The actions still acquire authority and prove the span again (`prepareLinkAction`, `sourceSpanFor`) before any write, so source fidelity does not change. Background acquisition still never flushes typing, so Undo grouping does not change.

Source-fidelity invariants: Edit and Unlink become enabled only for a span proven against owned exact text by `sourceSpanFromIndex`. No write happens without the action-time proof. A reply that is not adopted leaves the buttons disabled. Open and Copy keep their behaviour.

### Decisions

- **Provisional decision (2026-11-01), reversible — binding mechanism.** The open popover rebinds on the index's `'revision'` signal (in a microtask, in `link-popover.ts` only). The rejected alternatives were acquiring with `publish` at click time (it flushes typing on a display click and changes Undo grouping), rebuilding the index entry synchronously in `source-block-index.ts` (wider scope, and the measured reply time leaves nothing to gain), and enabling the buttons without proof. Evidence: the measurement above and the source path. Selected by a recorded decision check (probability 0.94; the requirement checks supported this option on all three requirements).
- **Provisional decision (2026-11-01), reversible — `link-popover.spec.ts:241`.** It is not in this task's scope. It passed twice on unchanged `dev` `9dc5c094` with `--retries=0` (11.4 s and 11.3 s). Its flow types nothing before the first popover click, so it does not reach the after-typing null binding. Task 669 keeps the triage. Part 2 runs it once in the focused real-VS-Code batch as a regression check of the changed popover and records the result for Task 669. Selected by a recorded decision check (probability 0.98).
- No public names, numbering, storage formats or compatibility rules are introduced. The rebind helper is module-private. The test helper `openLinkPopover` keeps its name.

### Acceptance-to-test map

| Acceptance item | Layer | File | Test |
| --- | --- | --- | --- |
| 1. Edit and Unlink enabled at once after typing (normalizing) | Vitest | `media-src/src/editing/link-popover.test.ts` | new: "an open popover enables Edit and Unlink when exact authority arrives after typing, without reopening" |
| 1. (same, real pipeline) | real VS Code | `test/vscode-e2e/exact-authority-other-actions.spec.ts` | "ir: each action after a typed character changes only its span, Undo restores the typed state and Save writes the result", cells `ir:popover-edit` and `ir:popover-unlink` |
| 2. Spec helper opens the popover without retries | real VS Code | same spec | `openLinkPopover` makes one click, then asserts Edit URL and Unlink `toBeEnabled({ timeout: 2_000 })`; the same two cells |
| 3. `link-popover.spec.ts:241` ownership | real VS Code | `test/vscode-e2e/link-popover.spec.ts` | `:241`, run once in the Part 2 batch (regression check only; decision above) |
| 4. Focused real-VS-Code spec written and run; quality stages | — | — | the cells above; `lint:ci`, `knip`, `jscpd`, `depcruise`, `test:coverage`, `check:coverage-modules`, `check:brand-identifiers` (the dependency audit stage is omitted in this queue) |

Edge cases (all in `link-popover.test.ts` unless noted):

1. A reply that is not adopted (acquisition resolves `null`, no revision change): the buttons stay disabled and the popover stays open.
2. A revision signal while the URL field is open (editing): no rebind; the field and its value stay.
3. A revision signal after the popover was hidden: nothing is shown.
4. A revision signal after the target left the DOM: the popover hides and does not enable anything.
5. Open and Copy on an open popover after the reply: they act and are not hidden by the exact-text check.
6. A rebind whose units are rejected after the revision: the buttons stay disabled.
7. The rebind runs after the index's `currentKey()` returns (microtask), never inside it; the index builds once for the new key.
8. The disposer unsubscribes: a revision signal after dispose has no effect.
9. Image target after an exact action: `link-popover.spec.ts:241` (real VS Code, regression run only).

### Part 2 step plan

Part 2 starts only after Tasks 666, 664 and 671 are integrated and this worktree is fast-forwarded. Step P2-0 then re-reads `link-popover.ts` (Task 664 may migrate its selection writes to `writeSelection`), the Task 666 and 671 changes to `exact-authority-other-actions.spec.ts`, and confirms that the line references below still hold.

- **P2-1 RED** — owns `media-src/src/editing/link-popover.test.ts` and `test/vscode-e2e/exact-authority-other-actions.spec.ts`.
  - Extend the Vitest `setup` with an index whose `snapshotPair` returns `exact: null` until a controllable acquisition resolves; the resolution sets the owned exact text and a new revision object. Add the acceptance test and edge cases 1 to 8.
  - Replace the retry loop in `openLinkPopover` with one click and `toBeEnabled({ timeout: 2_000 })` on Edit URL and Unlink. Update the comment above it.
  - Check: `npx vitest run --config test/vitest.config.mts media-src/src/editing/link-popover.test.ts`. Expected: the acceptance test and edge cases 4, 5 and 8 fail because the buttons stay disabled or the popover hides on Copy; edge cases 1, 2, 3 and 6 may already pass (they guard the fix). The existing 28 tests pass.
  - Real-VS-Code RED: `node build.mjs`, then through the wrapper: `exact-authority-other-actions.spec.ts -g "ir: each action after a typed character"` (the title filter keeps only the IR test of the mode loop; the WYSIWYG title does not contain "ir: each"). Expected: cells `ir:popover-edit` and `ir:popover-unlink` record a `measurementError` naming the `toBeEnabled` timeout, and the test fails in `finish()`.
- **P2-2 GREEN** — owns `media-src/src/editing/link-popover.ts`.
  - Add the `onInvalidate` subscription, the microtask rebind and the unsubscribe, as in "Intended solution". Follow `.agents/rules/ts.md` for comments.
  - Checks: the Vitest file above, all tests pass; `npx vitest run --config test/vitest.config.mts media-src/src/nav/source-block-index.test.ts media-src/src/boot/finish-init.test.ts` passes; `npm run typecheck` exits 0.
- **P2-3 verification and closure** — owns the task record and `tmp/667/` reports.
  - `node build.mjs`, then one wrapper call: `exact-authority-other-actions.spec.ts link-popover.spec.ts -g "ir: each action after a typed character|real IR"` (the alternation keeps the IR action test and both `link-popover.spec.ts` tests). Expected: the IR action test passes (all cells, including the popover cells, without retries); `link-popover.spec.ts` `:110` and `:241` pass, or a `:241` failure is recorded for Task 669 with its first error line.
  - Quality stages, one at a time: `npm run check:brand-identifiers`, `npm run lint:ci`, `npm run knip`, `npm run jscpd`, `npm run depcruise`, `npm run test:coverage`, `npm run check:coverage-modules`. Expected: exit 0, apart from the known baseline findings.

### Scratch probe (untracked)

`tmp/667/latency.probe.ts` with `tmp/667/probe.config.ts` (and a `node_modules` link to the real-VS-Code suite's dependencies). The probe records the popover state, the button state and the exact-authority reply times in the page. Its results are in the measurement table above.

## Part 1 reconciliation (2026-11-01)

The worktree was fast-forwarded to `dev` `11208300`. That commit includes Tasks 666, 668, 664, 672 and 671. Every claim of the Part 1 handoff was checked again against this HEAD.

### What changed under the handoff

- `media-src/src/editing/link-popover.ts`: Task 664 changed only `mutateLinkDom`. Its two raw selection writes now call `writeSelection` (imported from `./caret`), so the file is one line longer. The binding path, `show()`, `sameLiveOwner`, `onClick`, `onMutation` and the disposer have the same code.
- `media-src/src/editing/rewrap-command.ts`: Task 666 and Task 671 added the opt-in options `proveNormalizingBody` and `proofMayCrossUnits` to `captureRewrapSourceRange`. The popover's call (`sourceSpanFor`, `:405`) passes only `authoritativeMarkdown` and does not opt in, so its mapping does not change.
- `media-src/src/nav/source-block-index.ts`, `media-src/src/boot/finish-init.ts`, `media-src/src/editing/link-popover.test.ts` and `test/vscode-e2e/link-popover.spec.ts`: no change.
- `test/vscode-e2e/exact-authority-other-actions.spec.ts`: Tasks 666 and 671 added test cases (a `duplicate` document, Details and callout cases, and a `knownUndoFailure` flag for Task 674). The `openLinkPopover` helper and the popover scenarios did not change. Only their line numbers moved.
- New guard: `test/backend/selection-writes.test.ts` rejects raw selection writes in non-test sources. The planned fix writes no selection.

### Current references (HEAD `11208300`)

| Item | Location |
| --- | --- |
| `clickSourceBinding` | `link-popover.ts:274`; the fallback with `sourceSpan: null` at `:290-296` |
| `sourceSpanFromIndex` | `link-popover.ts:303` |
| `captureRewrapSourceRange` call | `link-popover.ts:405` |
| `installLinkPopover` / `makeOwner` / `show` | `link-popover.ts:617` / `:706` / `:749` |
| Edit and Unlink `disabled` | `link-popover.ts:756-757` |
| `actionReady` / `onClick` liveness checks | `link-popover.ts:875` / `:968` |
| `onMutation` / disposer | `link-popover.ts:1029` / `:1050-1065` |
| Index `onInvalidate` (interface / implementation) | `source-block-index.ts:75` / `:387` |
| `'revision'` emit / reply re-check | `source-block-index.ts:267` / `:325` (`resolvePairUnits` at `:313`) |
| `openLinkPopover` retry loop | `exact-authority-other-actions.spec.ts:356-374` (loop at `:365`) |
| `runPopoverEdit` / `runPopoverUnlink` | `exact-authority-other-actions.spec.ts:376` / `:389` |
| Popover scenarios | `exact-authority-other-actions.spec.ts:608` (`popover-edit`), `:617` (`popover-unlink`) |
| IR action test | `exact-authority-other-actions.spec.ts:933` (title unchanged) |
| `link-popover.spec.ts` tests | `:110` and `:241` (unchanged) |

### Measurement on HEAD

The scratch probe ran again on HEAD through the real-VS-Code wrapper, after `node build.mjs`.

- Case A (typing already on the host, then a click) is unchanged. The popover opened with Edit disabled at 9525 ms. The exact-authority reply arrived at 9539 ms (+14 ms). Edit was still disabled 3 s later with the popover open, and reopening showed it enabled. The root cause and the fix stay as written.
- Case B (a click right after the key, while the keystroke is still rendering) behaves differently from `9dc5c094`. The popover showed with Edit enabled (the owned base was not revoked yet). It hid 24 ms later on the keystroke's own editor DOM mutation (`onMutation`, because the rendered document changed). This is the existing fail-closed hide when the document changes under the popover. It is not the defect this task fixes.

### Decisions

- The binding-mechanism decision (rebind on the index's `'revision'` signal, in `link-popover.ts` only) is **confirmed unchanged**. Nothing it depends on changed, and the HEAD measurement repeats the evidence.
- The `link-popover.spec.ts:241` decision (not this task's; one regression run in Part 2; Task 669 keeps the triage) is **confirmed unchanged**. The spec file did not change.
- **Provisional decision (2026-11-01), reversible — a click during a pending keystroke render.** Out of scope. Case B is recorded as an observation, and no test or change is added for it. Hiding on a document change stays as it is, and Part 2 keeps the case A fix. Selected by a recorded decision check (probability 0.93; a separate follow-up task had 0.07).

### Amended Part 2 step plan

This reconciliation replaces step P2-0 (the fast-forward and re-read are done). Part 2 starts with P2-1.

- **P2-1 RED** — owns `media-src/src/editing/link-popover.test.ts` and `test/vscode-e2e/exact-authority-other-actions.spec.ts` (only `openLinkPopover` and the comment above it, `:356-374`).
  - Vitest: as in the handoff (the acceptance test and edge cases 1 to 8). The raw-selection guard skips `*.test.ts`, so the tests may keep the existing style.
  - Spec: replace the loop with one `label.scrollIntoViewIfNeeded()`, one `label.click()`, `expect(popover).toBeVisible()`, and `toBeEnabled({ timeout: 2_000 })` on Edit URL and Unlink. Rewrite the comment so it no longer describes a retry.
  - Checks: `npx vitest run --config test/vitest.config.mts media-src/src/editing/link-popover.test.ts`. Expected: the 28 existing tests pass. The acceptance test and edge cases 4, 5 and 8 fail on disabled buttons or a hidden popover.
  - `node build.mjs`, then through the wrapper: `exact-authority-other-actions.spec.ts -g "ir: each action after a typed character"`. Expected: the test fails in `finish()`. The `ir:popover-edit` and `ir:popover-unlink` test cases record a `measurementError` naming the `toBeEnabled` timeout. The other test cases match `dev`, and the `knownUndoFailure` (Task 674) cases record their expected failure.
- **P2-2 GREEN** — owns `media-src/src/editing/link-popover.ts`. The change is as in "Intended solution", with no selection writes.
  - Checks: `npx vitest run --config test/vitest.config.mts media-src/src/editing/link-popover.test.ts media-src/src/nav/source-block-index.test.ts media-src/src/boot/finish-init.test.ts test/backend/selection-writes.test.ts`. Expected: all pass. `npm run typecheck` exits 0.
- **P2-3 verification and closure** — owns the task record and the `tmp/667/` reports.
  - `node build.mjs`, then one wrapper call: `exact-authority-other-actions.spec.ts link-popover.spec.ts -g "ir: each action after a typed character|real IR"`. Expected: the IR action test passes, including both popover test cases with no retry. `link-popover.spec.ts` `:110` and `:241` pass, or a `:241` failure is recorded for Task 669 with its first error line.
  - Quality stages, one at a time: `npm run check:brand-identifiers`, `npm run lint:ci`, `npm run knip`, `npm run jscpd`, `npm run depcruise`, `npm run test:coverage`, `npm run check:coverage-modules`. Expected: exit 0, apart from the known baseline findings.

## Closure (2026-11-01)

### Implementation

`media-src/src/editing/link-popover.ts`: `installLinkPopover` subscribes to the source index's `onInvalidate`. On `'revision'` with a shown popover that is not editing and has no pending Edit/Unlink, one microtask re-runs `clickSourceBinding` for the same target, assigns the new exact text, rendered text and source span onto the existing owner, and sets the Edit and Unlink `disabled` state. The rebind is skipped while an action is pending, and its selection check waits while the image selection settle window is open. The disposer unsubscribes. No selection is written.

A review after the first implementation found two low-severity paths (a rebind during a pending Unlink could null the span and make the Unlink do nothing; a rebind could hide an image popover during the 32 ms settle window). Tests for both were written first and failed on that candidate; the two guards above fix them. Tests also pin the exact bytes `postExact` receives for Unlink and for Edit then Save after a rebind.

`test/vscode-e2e/exact-authority-other-actions.spec.ts`: `openLinkPopover` clicks once and requires Edit URL and Unlink enabled within 2 s; the retry loop is gone.

### Acceptance

- [x] Edit and Unlink are enabled at once after typing on a normalizing document: Vitest "an open popover enables Edit and Unlink when the exact text arrives after typing, without reopening", and the real VS Code `ir:popover-edit` / `ir:popover-unlink` cases.
- [x] The spec helper opens the popover without retries.
- [x] `link-popover.spec.ts:241` does not belong to this task: it stays with Task 669. Evidence: it passed twice on unchanged `dev`; with the change it failed once in `replaceUrl` (lost leading characters; passed on a rerun alone) and once at its first image-click trace assertion (a `selectionchange` event before `pointerdown`), both before any rebind can matter, so it looks like OS-level input timing in the long combined run. It is unresolved evidence for Task 669, and the spec is unchanged here.
- [x] Focused real-VS-Code spec written and run; quality stages pass.

### Verification run

- Vitest (`link-popover.test.ts` 41, `finish-init.test.ts`, `source-block-index.test.ts`, `selection-writes.test.ts`): 83 passed.
- `typecheck`, `lint:ci`, `typecheck:vscode-e2e`, `check:brand-identifiers`, `knip`, `jscpd`, `depcruise`: exit 0. `test:coverage`: exit 0 (382 files, 8325 passed, 1 expected fail). `check:coverage-modules`: exit 0 (9 modules at 0%, baseline 9).
- Real VS Code (one call): the IR action test (26 cases), the WYSIWYG action test (20), both stale-host tests (4 each) and `link-popover.spec.ts:110` passed; `:241` failed as described.
- Bundle: `media/dist` JavaScript total 1,116,499 bytes after the change (reporting only; no budget applies). The eager-module count was not recomputed (reporting only).

### Provisional decisions (2026-11-01), reversible

- Rebind on the index `'revision'` signal, in `link-popover.ts` only: selected by a recorded decision check (probability 0.94).
- `link-popover.spec.ts:241` stays with Task 669: selected by a recorded decision check (probability 0.98); the closure evidence above does not change it.
- A click during a pending keystroke render (the popover hides on the keystroke's own render): out of scope, recorded as an observation: selected by a recorded decision check (probability 0.93).

### Residuals

- A keystroke render during the acquisition window still hides the popover (existing fail-closed behaviour).
- `:241` flake (Task 669).
- The final completion check gave no contradiction; one claim ("nothing runs while hidden or editing") was only partly supported by the excerpt it saw, and the code guards it (`!owner`, `editing`).

## Attribution of link-popover.spec.ts:241 (2026-11-01)

Question: does this task's change cause or worsen the `:241` failures seen in both combined real-VS-Code runs?

Method: a copy of `dev` at the same commit, taken without changing git state and built the same way, ran the same combined command (`exact-authority-other-actions.spec.ts link-popover.spec.ts`, one worker, no retries) through the same wrapper.

| Run | `exact-authority-other-actions.spec.ts` | `link-popover.spec.ts:110` | `link-popover.spec.ts:241` |
| --- | --- | --- | --- |
| Candidate, run 1 | 4 passed | passed | failed: the first four typed URL characters were lost (URL field open) |
| Candidate, run 2 | 4 passed | passed | failed: the first event of the first image click was `selectionchange` (no target), not `pointerdown` on the image |
| Candidate, `:241` alone | — | — | passed |
| Baseline (`dev`), same order | 4 passed | **failed**: popover geometry, panel top 0, expected at least the toolbar bottom (61.375) | passed |

Analysis: both candidate failures happen at points where the new code does nothing. In run 1 the URL field is open, so `editing` is true and the revision listener returns at once. In run 2 no popover owner exists yet at the first image click, so the listener returns at once. The change writes no selection, no focus and no DOM except the two buttons' `disabled` property. On the baseline, a different test of the same file fails in the same order, with a failure the change never touches. So `link-popover.spec.ts` is order- and load-dependent after the long spec before it, on `dev` as well.

**Provisional decision (2026-11-01), reversible:** the `:241` failures are pre-existing, order- and load-dependent failures of `link-popover.spec.ts` after the long spec. They are not caused or worsened by this task, belong to Task 669, and do not block integration. The baseline `:110` failure goes to Task 669 as well. Selected by a recorded decision check (probability 0.99).
