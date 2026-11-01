# Task 688 — Other first-checkpoint actions may share the outline move's missing undo starting point

**Status:** done (2026-11-02). Filed at the close of Task 676 (residual).
**Origin:** Task 676 (Problem and Residuals).
**Severity:** low to medium (estimated; unmeasured for every action other than the outline move, where Redo was a no-op).
**Tech stack:** `media-src/src/editing/rewrap-command.ts` (`checkpointEditorUndo`), `media-src/src/editing/undo-keybind.ts` (`addToUndoStack` and `vmdeSeedBaseline` wrappers), `media-src/src/nav/outline-move-routes.ts` (`seedHistory`), `media-src/src/boot/main.ts` (`seedHistory` wiring), and the callers of `checkpointEditorUndo` and `addToUndoStack` in `media-src/src/editing/`, `media-src/src/bridge/message-router.ts`, `media-src/src/boot/main.ts` and `media-src/src/nav/section-hoist.ts`.
**Depends on:** none.

## Problem

In Task 676 the outline move created the first entry of an empty Vditor history. The host then read a false history base (the moved text paired with the original host text), and Redo was a no-op. Task 676 fixed only the outline route, by seeding an empty history first (`seedHistory`) and leaving the shared checkpoint helper unchanged.

Other actions whose first checkpoint creates the first entry of an empty history may share the same false base. This is not measured. Callers to inventory (lines as of `dc622900`):

- `media-src/src/editing/list-normalize-source-command.ts:411` and `:418`
- `media-src/src/editing/html-subscript-command.ts:677` and `:709`
- `media-src/src/editing/id-insertion.ts:320` and `:331`
- `media-src/src/editing/table-actions.ts:269`
- `media-src/src/editing/rewrap-command.ts:979`, `:1105` and `:1121`
- `media-src/src/editing/block-action-client.ts:286` and `:288`
- `media-src/src/editing/callouts.ts:632`
- `media-src/src/bridge/message-router.ts:252` and `:268`
- `media-src/src/boot/main.ts:335` and `:337`
- `media-src/src/nav/section-hoist.ts:252`

## Proposed work

1. Inventory every action that records a checkpoint on a possibly empty history (grep `checkpointEditorUndo` and `addToUndoStack` callers; confirm which are reachable as the first action after open).
2. For each, measure Undo and then Redo as the first action after open. Record the result per action: correct, or false base (Redo no-op or wrong text).
3. Fix only the failing actions, each with a failing test first, the same way as Task 676 (seed the empty history before the action's first write). If more than one action fails, decide whether one shared seed in the checkpoint helper is smaller, and record the reason.

## Acceptance

- [x] An inventory lists each action with a measured result for Undo then Redo as the first action after open.
- [x] Each failing action has a failing test first and is fixed; Undo restores the typed state and Redo reapplies the action exactly once, with the host text, the editor text and the saved bytes agreeing.
- [x] If no action fails, the inventory is recorded as the result and no product code changes.
- [x] Real VS Code: a focused case for each fixed action (Undo then Redo as the first action after open) written and run.
- [x] The outline move cases of Task 676 still pass.

## Tests to write

- Vitest per fixed action (the history is seeded before the first write on an empty history; a non-empty history is not reseeded).
- Real VS Code: one case per fixed action, opening the document and running the action before any typing (batch with the other real-VS-Code specs of the round).

## Part 1 handoff (2026-11-02)

Source reading only (no build, test or probe run in this step). Lines are as of `927cffac`.

### Problem restated

A history base is the webview text of a mode's first undo entry, paired by the host with its own text when the message arrives. It must hold the document text before the user's first change. If an action's change lands in the base and the host pairs it with its unchanged text, the host holds a false proof `{ webview: after, host: before }`. After Undo, the Redo transition's result (`after`) is then "proved" against the host's `before` text, the host runs no native Redo, and the webview's next plain edit is consumed as a history echo (Task 676, measured for the outline move). The task: find every other action that can produce this false base as the first action after open, measure each, fix only the failing ones.

### Root-cause hypothesis (not measured)

Mechanism, from source:

1. `media-src/src/editing/undo-keybind.ts:133-146` wraps `addToUndoStack` and `vmdeSeedBaseline`. Every wrapper call first takes a pending base (`takePendingBase`, `:98-110`), which reads the document text at that moment.
2. A first entry made by `addToUndoStack` defers its base to an idle period (`reportEntry`, `:118-132`, Task 641). A first entry made by `vmdeSeedBaseline` reads the text in place.
3. The common transaction shape is `checkpointEditorUndo` (`media-src/src/editing/rewrap-command.ts:707`), then a synchronous `setValue` or SV splice, then `checkpointEditorUndo` again. The second wrapper call takes the pending base after the change. `onEntryRecorded` (`media-src/src/boot/finish-init.ts:245-247`) flushes the edit only after that, so `history-base` reaches the host before the edit. `queueHistoryBase` (`src/session/editor-session.ts:748-765`) pairs it with the unchanged host text, and `prove` (`src/writeback/history-coupling.ts:292-297`) accepts it as `base`.

Two variants reach step 3:

- Variant A (Task 676's case): the active mode's stack is empty when the action's first checkpoint runs (open, before Vditor's first snapshot timer; or a first visit to a mode). The first checkpoint creates the first entry with a deferred base.
- Variant B: Vditor's timer has already made the first entry, but its base is still waiting for idle time (up to 2 s, `HISTORY_BASE_IDLE_TIMEOUT_MS`, `undo-keybind.ts:40`). The action's first checkpoint does not call the wrapper: `checkpointEditorUndoCoalescing` (`rewrap-command.ts:717`, via `checkpointOrCoalesceUndo`, `media-src/src/editing/undo-boundaries.ts:188-196`) coalesces or returns `'unchanged'` without calling `addToUndoStack`; and `suppressDelayedUndoSnapshots` (`rewrap-command.ts:681-705`) swaps the wrapper for a no-op while it is armed. The base is then read at the post-change checkpoint. Variant B is a new candidate found in this reading (Turn Into, `media-src/src/editing/block-transform-command.ts:1197` then `:1237`).

Why most routes are safe: a seed (`seedUndoBaseline`, `undo-boundaries.ts:94`) takes any pending base and seeds an empty stack before the change. Seeds run on webview keydown, `beforeinput`, `cut`, `drop`, the toolbar-click boundary (also reached by `trigger-toolbar-hotkey`) and every `runEditorAction` (`takeEditorActionUndoBoundary`, `undo-boundaries.ts:465-473`, called at `media-src/src/bridge/editor-actions.ts:245`). A key pressed in the webview seeds before VS Code runs its keybinding.

Unseeded entry points, so the candidates: the host editing-command messages in `media-src/src/bridge/message-router.ts:1165-1234` when they are started from the Command Palette, a menu, a QuickPick or `executeCommand` (no webview keydown). They all go through `whenEditViewComplete` (`:1129-1137`), which takes no seed. Webview pointer routes that are not toolbar clicks (block gutter menu, link popover buttons, callout and details controls, table context controls, section hoist) also take no seed. They are reachable first only by a pointer action on an untouched editor.

The window is short: Variant A ends when Vditor's first snapshot timer runs after open (Task 676: a 1.5 s wait passed); Variant B ends at the next idle period. Real users rarely act that fast; real-VS-Code specs often do. This explains the "low to medium" severity.

### Inventory (static, to be measured in step P1)

| Route (entry) | Caller | Seeded entry | Expected |
| --- | --- | --- | --- |
| Outline move (webview drag, tree) | `media-src/src/boot/main.ts:328-338` | yes, Task 676 `seedHistory` | correct (control) |
| Fix List Numbering, Renormalize All Lists (SV) | `media-src/src/editing/list-normalize-source-command.ts:411`, `:418` | no (host command) | false base (A) |
| Format Table (SV) | `media-src/src/editing/table-format-command.ts:409`, `:418` | no | false base (A) |
| Rewrap Selection | `rewrap-command.ts:1126`, `:1142` | no | false base (A) |
| Rewrap Document | `rewrap-command.ts:1000` | no | measure (one checkpoint; Task 696 path) |
| Turn Into (QuickPick) | `block-transform-command.ts:1197` (coalescing), `:1237` | no | false base (A or B) |
| Block action (prepare/outcome) | `media-src/src/editing/block-action-client.ts:286`, `:288` | no | false base (A) |
| Shift Heading Level | handler at `message-router.ts:1203` | no | measure |
| Paste Plain | handler at `message-router.ts:1156` | no | measure |
| Find Replace One / All | `media-src/src/editing/selection-scope.ts:858`, `:867` | Find widget seed (`message-router.ts:1116`) | correct |
| Owned checkbox host update | `message-router.ts:252`, `:268` | host update | correct: the host already holds `after`, so the deferred base `{after, after}` is true |
| Toolbar-panel insertions (emoji, math, ID, sub/superscript, inline picture) | `emoji-insertion.ts`, `math-insertion.ts`, `id-insertion.ts:320`/`:331`, `html-subscript-command.ts:677`/`:709`, `inline-picture.ts:557`/`:559` | toolbar click boundary | correct, unless the panel opens from a host command (measure one) |
| Table actions (context, WYSIWYG controls) | `media-src/src/editing/table-actions.ts:269` | editor action or pointer | measure the pointer route |
| Callouts, details, link popover, selection link actions | `callouts.ts:632`, `details-toggle.ts:239`/`:258`, `link-popover.ts:602`/`:911`, `selection-link-actions.ts:190`/`:204` | pointer, no seed | measure one pointer route |
| Section hoist | `media-src/src/nav/section-hoist.ts:252` | no; view state, own baseline | measure (view-only change; Undo may be a no-op by design) |

The task's caller list (as of `dc622900`) is incomplete; the table adds `table-format-command`, `block-transform-command`, `selection-scope`, `emoji-insertion`, `math-insertion`, `inline-picture`, `link-popover`, `selection-link-actions` and `details-toggle`.

### Shared interfaces and invariants

- Never relaxed: Task 606/607 proof rules (exact actions keep their exact bytes, their exact records and the exact-only proof of Task 685's `replayExact`); the host owns the text; a base is paired only when the host is synced (`isAlreadySynced`).
- The base for an owned host update stays deferred (Task 641 behaviour; a seed there would pair `{before, after host}`, a false base the other way). So no seed in `checkpointEditorUndo` or `checkpointEditorUndoCoalescing` (Task 676 rejected that location too).
- `seedUndoBaseline` stays the only seed. It is a no-op when history exists, it takes a pending base first, and it refuses during IME composition.
- Public names: the new router wrapper (if step G1 needs one) is `withHistorySeed`. No protocol, storage or numbering change.

### Intended solution (if step P1 confirms more than one failing host command)

- One shared seed at the router's host editing-command entry: `withHistorySeed(handler)` in `message-router.ts`, which calls `seedUndoBaseline` on the live inner editor before the handler, applied only to the handlers of measured failing commands (next to `whenEditViewComplete`; a refused command seeds nothing). This covers Variant A and Variant B, because the seed takes the pending base before any change.
- A failing webview pointer route gets a per-route seed in the Task 676 style, in its own module.
- If only one route fails, seed that route only (Task 676 style) and record the reason.
- If no route fails, record the inventory as the result; no product code changes.

### Affected paths

- Probe (scratch, not committed): `test/vscode-e2e/first-action-history-spike.spec.ts` (a `*spike*` file, excluded from the default suite), notes in `tmp/688/`.
- Product (only if P1 shows failures): `media-src/src/bridge/message-router.ts` (wrapper and handler map, `:1129-1234`; import of `seedUndoBaseline` from `../editing/undo-boundaries`); per-route modules only for failing pointer routes.
- Tests: `media-src/src/bridge/message-router.test.ts` (or the router's existing handler test file), and one real-VS-Code case per fixed action added to its existing spec (`list-normalize-history.spec.ts`, `table-format.spec.ts`, `rewrap.spec.ts`, `block-transform.spec.ts`, `heading-level-shift.spec.ts` as applicable).

### Part 2 steps (tier: Medium)

1. Step P1 (measurement). Write `test/vscode-e2e/first-action-history-spike.spec.ts`. For each route in the inventory marked "false base" or "measure": open a fresh fixture, wait only for editor ready, run the action at once through its command (`executeCommand`, no webview key), wait for the host text to change, press `Control+z` (expect the original text), press `Control+y` (expect the action's text), and read the host text, the editor text and the saved bytes after a save. Same route again after a 2.5 s wait before the action: positive control, expected to pass. Outline drag at ready: control, expected to pass (Task 676). Enable the host debug log for the history coupling. Command: `node build.mjs`, then the XTEST wrapper command from the common rules with this spec, `--workers=1 --retries=0`. Decision rule: a route that fails at ready and passes after the wait, with the Redo entry showing a `base` proof and no native step, is a false base. A route that fails in both is a different cause: record it, do not fix it in this task, and report it. A route that passes at ready is correct.
2. Step R1 (RED). Vitest: for each failing host command, the handler's message runs `seedUndoBaseline` before the handler's first checkpoint (order log); a refused command (`whenEditViewComplete` declines) does not seed; a non-empty history is not reseeded (the seed's own no-op, existing undo-boundaries tests). Add a Vitest for Variant B in `media-src/src/editing/undo-keybind.test.ts` only if P1 shows Turn Into failing: with a pending base, a coalesced pre-checkpoint, a change and a second checkpoint, the posted base is the text before the change after the seed. Real VS Code: one case per failing action, added to its spec (action at ready, Undo, Redo). Expected: the new Vitest order tests fail; the real-VS-Code cases fail as in P1.
3. Step G1 (GREEN). Add `withHistorySeed` and apply it to the failing handlers (per-route seeds for pointer routes). Checks: the Vitest files (pass); `npm run typecheck`; `npx biome check` on changed files; `node build.mjs`; the new real-VS-Code cases plus `outline-reorder.spec.ts` in one wrapper run, expected all passed; for any Task 692 case covered, `block-transform.spec.ts:47` and `:239` in the same run (record the outcome, do not claim Task 692).
4. Step C1 (closure). `npm run quality` stages per DEVELOPMENT.md (audit as the queue rule says); task record; delete the spike spec.

Tier: Medium. Reason: one mechanism and one likely shared fix site, but the result depends on a real-VS-Code measurement over about ten routes, and up to five specs gain a case. Not Light: the fix is not settled before measurement. Not Heavy: no protocol, host or proof-rule change.

### Edge cases

- First visit to a mode (IR to SV switch, then a command at once): same Variant A; add one SV case in P1 (Format Table runs in SV).
- IME composition: the seed refuses; old behaviour, residual, not tested.
- A command refused by `whenEditViewComplete` (Preview-first open, streaming): no seed, no entry (Vitest).
- Host already changed (host update not yet received): the host drops the base (`isAlreadySynced`); unchanged.
- Exact actions: Task 685's exact replay may reach the right bytes on Redo even after a false base. P1 must record whether the plain transition or the exact replay wins, from the host log.
- Section hoist changes view state only; an Undo with no text change is not a failure.

### Focused checks and expected outcomes

- P1: at-ready cases of the "false base" routes fail on Redo (host keeps the original text); the 2.5 s cases and the outline control pass.
- After G1: every new real-VS-Code case passes; `outline-reorder.spec.ts` `2 passed`; the new Vitest tests pass; typecheck and lint exit 0.

### Provisional decisions (2026-11-02), reversible

- Fix location, if more than one host command fails: one shared seed at the router's host editing-command entry (`withHistorySeed`), applied to the failing handlers only, with per-route seeds for failing pointer routes (probability 0.91). Alternatives: a seed in each action (0.04; it misses Variant B unless placed before the coalescing checkpoint and touches more files), a seed in the shared checkpoint helper (0.04; it changes the owned host-update base), a change detector for deferred bases in `undo-keybind.ts` (0; wider).
- Overlap with Task 692 (Turn Into Redo failures bisected to the Task 641 idle-time base): Task 688 includes Turn Into in its inventory and measurement; if Turn Into fails by the false base, the shared seed covers it and the closure report states which Task 692 cases it may close; Task 692 keeps ownership of its record and other cases (probability 0.85). Alternatives: exclude block-transform routes (0.05), merge Task 692's Redo cases into this task (0).
- Measurement before any fix (step P1): the false base is a hypothesis from source reading; the task requires a measured result per action.

## Part 2 step P1 measurement (2026-11-02)

Measured on `dev` at `80871f91` (Task 692 integrated). One real-VS-Code run of the scratch spec `test/vscode-e2e/first-action-history-spike.spec.ts` (kept untracked until closure; raw lines in `tmp/688/p1-results.jsonl`), `VMDE_SPIKES=1 VMDE_XTEST=1`, `--workers=1 --retries=0`: 24 tests, all ran to a result (`24 passed` is the harness status only). Each route ran twice in a fresh document: as the first action once the editor reported ready ("ready"; the active undo stack held 0 entries when the action started), and after a further 2.5 s wait ("wait"; the stack held 1 entry). The action ran through its command (`executeCommand`) or its pointer control; then Undo and Redo ran as OS keys (X11), then Save. The webview's `history-base`, `edit` and `history-transition` posts were logged in order.

### Effect of Task 692 on the inventory

Task 692 makes `checkpointOrCoalesceUndo` take the pending base before and after its push (`vmdeTakePendingBase`). Only Turn Into (`checkpointEditorUndoCoalescing`) goes through it, so Variant B is closed for Turn Into and every route that uses plain `checkpointEditorUndo` is unchanged. Measured: Turn Into is correct at ready (its `history-base` is the text before the action).

### Per-route result

| Route | Ready | After wait | Verdict | Evidence at ready |
| --- | --- | --- | --- | --- |
| Outline drag (control) | Undo restored, Redo reapplied | same | correct | `history-base` = original text, posted before the move's `edit` |
| Fix List Numbering (Source) | Undo restored, Redo reapplied | same | correct, latent false base | `history-base` = text after the action, but the edits are exact (`exact: true`, `history: undo/redo`) and the native exact replay of Task 685 restores both directions |
| Renormalize All Lists (Source) | same | same | correct, latent false base | same as Fix List Numbering |
| Format Table (Source) | same | same | correct, latent false base | `history-base` = formatted text; exact replay |
| Format Table (IR) | not a route | not a route | not applicable | host text unchanged in both timings: the command formats only in Source |
| Rewrap Selection (IR) | Undo restored, Redo left the original text | correct | false base | `history-base` = wrapped text, then `edit` (stack 1 then 2); the Redo `history-transition` ran no native step |
| Rewrap Document (IR) | Undo restored, Redo left the original text | correct | false base | same shape as Rewrap Selection |
| Shift Heading Level (`demoteHeading`, IR) | Undo restored, Redo left `## Child` | correct | false base | `history-base` = `# A\n\n### Child\n` (the text after the action) |
| Paste Plain (IR) | Undo changed nothing | correct | first edit has no undo start | `edit` (stack 1) with the pasted text, then `history-base` = the pasted text; the webview holds one entry, so Undo has nothing to return to (Task 598 class; same fix site: a seed before the change) |
| Block action, Duplicate (IR, block handle menu) | Undo restored, Redo left the original text | correct | false base | `history-base` = text with the duplicate; `prepare-block-action` is a host message, so it passes the same router entry |
| Turn Into (IR) | Undo restored, Redo reapplied | same | correct | Task 692 fix; `history-base` = original text |
| Table Align Center (IR, editor action control) | same | same | correct | seeded entry (`takeEditorActionUndoBoundary`) |

In every failing case the wait variant is correct, so the cause is the empty-history window and not the action. Save and reopen: the saved bytes equal the host text in every run that reached Save.

### Confirmed failing routes for R1 and G1

1. Rewrap Selection (`rewrap-selection` host message).
2. Rewrap Document (`prepare-rewrap-document` and `rewrap-document` host messages).
3. Shift Heading Level (`shift-heading-level` host message).
4. Paste Plain (`paste-plain` host message): different symptom (Undo no-op), same remedy.
5. Block action Duplicate (`prepare-block-action` host message). Delete and Move share the entry; they were not measured separately.

All five reach the webview as host messages that pass `whenEditViewComplete` and take no seed, which is the fix site of the plan.

### Routes failing in both timings (different cause)

None. Format Table (IR) is not a route (the command declines in IR).

### Not measured

Toolbar-panel insertions (emoji, math, ID, subscript, inline picture), Find Replace One/All, link popover, callouts, details toggle, selection link actions and section hoist were not run. Toolbar clicks are seeded by the click boundary and Find by its own seed (static reading, Part 1); the other pointer controls take no seed in the static reading. They need a follow-up measurement (one pointer route each) if the Owner wants the inventory complete; none shares a handler with the five confirmed routes.

### Does the fix plan hold?

Yes (probability 0.91 stands, now supported by measurement). `withHistorySeed(handler)` in `media-src/src/bridge/message-router.ts` calls `seedUndoBaseline` on the live inner editor before the handler. Apply it to `rewrap-selection`, `prepare-rewrap-document`, `rewrap-document`, `shift-heading-level`, `paste-plain` and `prepare-block-action`, inside `whenEditViewComplete` so a refused command seeds nothing. Changes to the Part 1 plan:

- Block Duplicate needs no per-route seed: its message is a router handler.
- The latent false bases of the Source exact actions (Fix List Numbering, Renormalize All Lists, Format Table) are not failures: Undo and Redo are correct through the exact replay. They stay out of scope under the rule "fix only the failing actions". Seeding them too would be harmless and would remove the latent base; recorded as an open choice for R1.
- Paste Plain also needs its own real-VS-Code case: Undo is the failing step there, not Redo.

### Provisional decisions (2026-11-02), reversible

- Leave the three Source exact actions unfixed (latent false base, correct outcome): probability 0.7. Alternative: seed them in the same wrapper (0.3).
- Replace the scratch spec by one final spec `test/vscode-e2e/first-action-history.spec.ts` with one test per fixed action (ready timing only; the wait timing is the positive control already measured): probability 0.8. Alternative: add each case to its action's existing spec (0.2).

### Tier recommendation

Light: one merged RED+fix step. The cause is measured, the fix site is one wrapper plus six handler entries in one file, no host, protocol or proof-rule change. The RED real-VS-Code evidence exists already (the five ready-timing failures above); the Vitest test checks the seed order and the refused-command case.

### Pointer and Find routes (measured after the first table)

Same method (first action as soon as the editor is ready, against the same action after a 2.5 s wait; Undo, Redo, Save). Two controls also ran.

| Route | Ready | After wait | Verdict | Evidence at ready |
| --- | --- | --- | --- | --- |
| Link popover, Unlink (IR) | Undo restored, Redo left the link | correct | false base | `history-base` = text without the link, posted after the change |
| Callout panel, Apply (IR) | Undo restored, Redo left `[!NOTE]` | correct | false base | `history-base` = `> [!WARNING]...` |
| Find, Replace One (IR) | Undo restored, Redo left `two` | correct | false base | `history-base` = text with `TWO` |
| Selection bubble, Link (IR) | Undo restored, Redo reapplied | same | correct | `history-base` = original text (the bubble's selection gesture and click run first) |
| Details toolbar button (IR) | same | same | correct (toolbar click seeds) | control |
| Section hoist, then typing (IR) | same | same | correct | the typing key seeds before the first change; hoisting alone changes no text |
| Toolbar-panel insertions (emoji, math, ID, subscript, picture) | not run | not run | toolbar click only, seeded | no host command opens them |

Find Replace All shares the Replace One transaction (`applyFindReplaceResult`), so it takes the same seed (unit test covers both).

## Part 2 fix (2026-11-02)

### Provisional decisions (2026-11-02), reversible

- The three Source exact actions (Fix List Numbering, Renormalize All Lists, Format Table) stay unfixed: their history base is the text after the action, but the exact replay restores both Undo and Redo (probability 0.7). Alternative: seed them in the same wrapper (0.3).
- One final spec, `test/vscode-e2e/first-action-history.spec.ts`, with one test per fixed action at ready timing (0.8). The wait timing was the positive control in the measurement. The scratch measurement spec is deleted.
- `prepare-rewrap-document` is not seeded; only `rewrap-document` is. Measured: with the seed on both messages Rewrap Document did not apply at all (the document stayed unchanged), because the seed ran between the caret and the selection capture that the prepare message takes. The `rewrap-document` message changes the text and seeds, and the captured selection is held as offsets (probability 0.85; the alternative of capturing before seeding inside the prepare handler was 0.1).

### Implementation

- `media-src/src/editing/undo-boundaries.ts`: `seedHistoryOf(inner: unknown)`, a typed wrapper over `seedUndoBaseline`.
- `media-src/src/bridge/message-router.ts`: `withHistorySeed(handler)` calls `seedHistoryOf(innerVditor())` before the handler. Applied inside `whenEditViewComplete` to `rewrap-selection`, `rewrap-document`, `shift-heading-level`, `paste-plain` and `prepare-block-action`, so a refused command seeds nothing.
- Per-route seeds before the first checkpoint, after the action is validated: `link-popover.ts` (link action transaction), `callouts.ts` (callout action transaction), `selection-scope.ts` (`applyFindReplaceResult`, Replace and Replace All).
- No seed in `checkpointEditorUndo` or `checkpointEditorUndoCoalescing`; no host, protocol or proof-rule change.

### Tests

- Vitest RED before the fix: `message-router.test.ts` 6 failed (the five seeded commands and `prepare-block-action`: `expected "vi.fn()" to be called once with arguments ... Number of calls: 0`); `callouts.test.ts` 1, `link-popover.test.ts` 2 and `selection-scope.test.ts` 2 failed (`expected [ 'checkpoint', 'checkpoint' ] to deeply equal [ 'seed', 'checkpoint', 'checkpoint' ]`). After the fix the five files pass (668 passed in the first run; `message-router.test.ts` 250 passed after the Rewrap Document change).
- Real VS Code RED on unchanged product: `first-action-history.spec.ts` 8 failed. Redo failed at the final `toBe(item.acted)` for rewrap-selection, rewrap-document, shift-heading-level, block-duplicate, link-unlink, callout-apply and find-replace-one; Undo failed at `toBe(item.initial)` for paste-plain.
- Real VS Code GREEN (one wrapper call, `VMDE_XTEST=1`, `--workers=1 --retries=0`): `first-action-history.spec.ts` (8), `outline-reorder.spec.ts` (2) and `block-transform.spec.ts` (9): `19 passed`. An earlier run of the same call, with the seed also on `prepare-rewrap-document`, failed the Rewrap Document case (`18 passed`, `1 failed`: the document stayed unwrapped); the decision above records the change.

### Verification actually run

- `npm run typecheck`, `npm run typecheck:vscode-e2e`, `npx biome check` on the changed files: exit 0.
- `npm run quality`: `check:brand-identifiers`, `lint:ci`, `knip`, `jscpd`, `depcruise`, `test:coverage` and `check:coverage-modules` (9 modules at 0%, baseline 9) pass. `audit` fails on dependency advisories (omitted by the queue rule; reported only).

### Acceptance

- [x] Inventory with a measured Undo then Redo result per action: the P1 table and the pointer table above (unmeasured by design: toolbar-panel insertions, which have no host command and are seeded by the toolbar click).
- [x] Failing actions fixed with a failing test first: eight routes (Rewrap Selection, Rewrap Document, Shift Heading Level, Paste Plain, Block Duplicate, Link Unlink, Callout Apply, Find Replace One); Undo restores the typed state and Redo reapplies once with host text, editor text and saved bytes agreeing (`first-action-history.spec.ts`).
- [x] Latent Source exact actions recorded with their evidence, no change (decision above).
- [x] Real VS Code case for each fixed action, written and run (RED 8 failed, GREEN 8 passed).
- [x] Outline move cases of Task 676 still pass (`outline-reorder.spec.ts`, 2 passed).

### Residuals

- Rewrap Document applies only after the second message seeds; a first action that arrives between the two messages is covered by the same seed.
- Replace All, Block Delete and Block Move share their transaction or message with a tested route but have no case of their own.
- The Source exact actions keep a false base that the exact replay hides.
- Review (2026-11-02), accepted with residuals:
  - The router seed runs before the command's saved selection is restored. A restored caret that differs from the live one may add a caret-only Undo step after the seed. The 2.5 s baseline has the same exposure, and no case presses Undo twice.
  - The seed also runs before an action declines (for example an unknown block request). It only adds a base entry with the unchanged text and posts a true base, so it is accepted.
  - Every measured case starts from a collapsed caret. Rewrap Selection and Paste Plain over a non-collapsed selection as the first action are not measured.
  - On rollback in the callout, link and Find paths, the restored history drops the seed entry, while the host keeps the true base it received. The next action seeds again.
  - Provisional decision (2026-11-02), reversible: record these as residuals instead of adding cases, because the shared real-VS-Code runner is busy with a timing measurement (0.7).
