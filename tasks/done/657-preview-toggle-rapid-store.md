# Task 657 — Store the last Preview toggle when toggles are rapid

**Status:** done.
**Origin:** Project Owner request (known issue from Task 651).
**Severity:** low.
**Tech stack:** VS Code extension host (`globalState` writes) and webview Preview toggle messages.
**Related:** [Task 651](651-remember-preview-toggle-state.md) (remember Preview toggle state), Task 631 (toolbar collapse), [Task 650](650-remember-outline-open-state-and-width.md) (remember Outline open state and width).

## Problem

In real VS Code, three Preview toggles about 100 ms apart (on, off, on) left the stored value off once. The host received `save-preview-state` with true, false, true in that order, yet the next opened file read off. With 300 ms spacing the stored value was correct. The likely cause is the ordering of `globalState.update` writes when they overlap.

## Requirements

1. The last Preview toggle always wins: after any rapid sequence of toggles, the stored value equals the state of the last toggle.
2. The same check applies to the Task 631 toolbar collapse write and the Task 650 Outline open write, which use the same write pattern.

## Open design points

- To be settled in Part 1.

## Scope

- In: ordering of stored Preview toggle writes under rapid toggling; the same ordering check for the Task 631 toolbar collapse write and the Task 650 Outline open write.
- Out: Preview rendering and any other pane behaviour.

## Acceptance

- [x] Three Preview toggles about 100 ms apart (on, off, on) leave the stored value on.
- [x] The next opened file reads the stored Preview state that matches the last toggle.
- [x] The toolbar collapse write and the Outline open write keep the last value under the same rapid sequence.

## Tests

- To be specified in Part 1 (the stored value depends on VS Code integration, so real-VS-Code verification is required).

## Part 1 handoff (2026-10-18)

Read-only source mapping at HEAD `1985ceb2`. Nothing was built or run in the repository (no Vitest, Chromium, build or VS Code). The platform behaviour below comes from reading the installed VS Code bundles in `.vscode-test/` (read only). The failing interleaving itself is NOT reproduced; it is derived from the code and modelled in a Vitest fake (see Residual risks). Every fact below was checked by reading the cited lines.

### Verified facts

Our code (no defect found; the order is preserved up to the memento):
- Webview senders post synchronously in click order, and only when the state changed:
  - `media-src/src/chrome/open-preview.ts:51-66` (`installPreviewMemory`, posts `save-preview-state` at `:61`, guarded by `last` and `programmatic`).
  - `media-src/src/nav/outline-state.ts:18-33` (`installOutlineState`, posts `save-outline-open`).
  - `media-src/src/chrome/toolbar-collapse.ts:103-108` (`onClick` posts `save-toolbar-collapsed`).
- Host dispatch: `src/session/editor-session.ts:1803-1858` (`onDidReceiveMessage`): the shape check is synchronous, then `await handler(message)`. Each of the three handlers calls `globalState.update` as its first statement, so the updates run in message arrival order:
  - `onSavePreviewState` `:471-475` (`await this.context.globalState.update(KeyPreviewOn, message.on === true)`).
  - `onSaveToolbarCollapsed` `:480-505` (`written = globalState.update(KeyToolbarCollapsed, collapsed)` at `:484`, broadcast loop `:488-502` before `await written` at `:503`).
  - `'save-outline-open'` `:1576-1577` returns `globalState.update(KeyOutlineOpen, message.open)`; `'save-preview-state'` `:1580`; `'save-toolbar-collapsed'` `:1578-1579`.
  - Clear on setting change: `:1640` `void this.context.globalState.update(KeyOutlineOpen, undefined)` (no `.catch`).
- Reads happen at editor open in `buildInitOptions` `:394-428` (`readOutlineOpen` `:397`, `readPreviewOn` `:417`) and `readToolbarCollapsed` at `:347`, `:454`, `src/app/markdown-editor-provider.ts:258`. All use `globalState.get`, which returns the extension host's local copy at once (no wait for the write to settle).
- Other `globalState` writers in `editor-session.ts`: `:247` (emoji recents), `:463` (`save-options`), `:1572` (`save-outline-width`). They share the same memento.
- Task 651's own record: three messages arrived in order (true, false, true) yet a later read returned off; 300 ms spacing was correct (`tasks/done/651-remember-preview-toggle-state.md`, "Open finding 2"). Task 650's spec comment (`test/vscode-e2e/outline-state.spec.ts:89-93`) cites that as its only evidence; the specs wait `settle(frame, 1000)` after each toggle (`preview-memory.spec.ts:92-96`, `outline-state.spec.ts:93-97`). No independent measurement exists for the toolbar or Outline writes.

VS Code `Memento` (the cause). `@types/vscode` 1.110.0 (`node_modules/@types/vscode/index.d.ts:8587-8623`) only says `update(key, value): Thenable<void>`; it promises no ordering or consistency. The implementation, identical in 1.110.0, 1.129.0 (the harness default, `test/vscode-e2e/playwright.config.ts:233`) and 1.135.0 (files `.vscode-test/worker-0/vscode-linux-x64-1.129.0/resources/app/out/vs/workbench/api/node/extensionHostProcess.js`, class with `this._deferredPromises=new Map;this._id=`; the 1.110.0 and 1.135.0 copies are under `test/vscode-e2e/.vscode-test/worker-0/`):
- `update(key, value)`: sets `this._value[key] = value` at once; if a promise for that key is pending it returns the same one; otherwise creates one and starts a zero-delay scheduler if none is running.
- Scheduler tick: sends the WHOLE `this._value` object to the main thread (`setValue(shared, id, this._value)`), then completes the pending promises.
- `this._storageListener`: on a storage event for this extension it executes `this._value = o.value`, REPLACING the whole local object with the parsed event payload. Any local `update` not yet flushed is discarded.
- Main thread, `.../out/vs/workbench/workbench.desktop.main.js`, class with `_sharedStorageKeysToWatch`: it listens to profile-scope `onDidChangeValue`; for a watched extension id it reads the current stored raw JSON and posts `$acceptValue` back to the extension host. `$initializeExtensionStorage(shared=true, id)` adds the id to the watch set, so the global memento is watched. `$setValue` calls `storageService.store`, whose change event fires synchronously when the emitters resume, so EVERY changed write is echoed back to the writer, and the echo is queued before the reply to `$setValue`.
- The workspace memento is not watched (only `shared` ids), so `workspaceState` (fold state, reading position) has no echo and is not affected.
- `85) and was low-confidence on the other two (0.35, 0.31); those two rest on the literal code above (`this._value=o.value`; synchronous emit, reply after) and on reasoning about the message order. The fix below does not depend on the order claim.

Mechanism (derived, not reproduced). A stale echo overwrites a not-yet-flushed local update:
1. Toggle k: `update` then the 1 ms scheduler flush k sends snapshot Sk; the main thread stores it and echoes Ek.
2. Normally Ek returns within a few ms and equals the local value, so nothing happens.
3. If the extension host event loop is busy so that message k+1 is processed right after flush k is sent (stall of about the toggle spacing), `update(k+1)` runs while Ek is still in flight. Ek then lands between `update(k+1)` and its flush, and `_value` is reset to Sk. Flush k+1 sends the stale snapshot; the last write is lost. The main thread's value is unchanged, so no further echo repairs it; `get` also reads the stale value.
4. This needs the stall to be about the spacing, so it is likely at 100 ms and unlikely at 300 ms, which matches the one measured failure. The toolbar and Outline writes use the same pattern and the same memento, so they share the exposure; so does any other `globalState` key, and a write to one key can clobber a pending write of another key (the object is replaced as a whole).

Other hypotheses checked and ruled out:
- Concurrent `update` promises settling out of order: the memento coalesces same-key updates into one promise and flushes in order over one ordered RPC channel; settle order is not the loss.
- Read before settle in `buildInitOptions`: `get` is the local value, so settle timing alone cannot lose it (only a clobbered local value can).
- A second panel instance: all sessions share `context.globalState`; the writes are not per panel.
- The test's own timing: the host trace already showed correct arrival order; the missing piece is below the handler.
- Webview dropping a click: ruled out by the host trace (three messages received).

### Decisions

1. **Fix: write, then verify and repair, per key, on the host.** New leaf module `src/platform/last-write-wins.ts` (manifest id `last-write-wins`, module `platform`; basename is unique in `src/` and `media-src/src/`). It does NOT queue writes (a never-settled `update` must not block later writes; the existing test `editor-session.test.ts:1228-1252` relies on that for the toolbar broadcast). Instead:
   - Public API only: `lastWriteWinsFor(store: StateStore): LastWriteWins`, with `StateStore = { get(key: string): unknown; update(key: string, value: unknown): PromiseLike<void> }` and `LastWriteWins = { write(key: string, value: boolean | number | string | undefined): Promise<void> }`. Memoized per store object in a `WeakMap`, so every `EditorSession` sharing `context.globalState` shares the same per-key sequence numbers. Do not export the repair limit (knip).
   - `write(key, value)`:
     1. Takes the next per-key sequence number `mine` and records it as newest.
     2. Calls `store.update(key, value)` as its FIRST statement (synchronously, as today, so `get` is right at once and the call order equals message order), then awaits it.
     3. Loop after the await: if `mine` is no longer the newest for the key, return (the newer write owns the final value). If `Object.is(store.get(key), value)`, done. Else if `MAX_REPAIRS` (private constant, 3) repairs were spent, `debug('state write not confirmed', key)` and return. Else `await store.update(key, value)` again and loop.
     4. `finally`: delete the key's newest entry when it is still `mine`.
   - Why this is sufficient: every echo of an earlier flush is delivered before the acknowledgement of a later flush on the same ordered channel, so once an `update` is acknowledged, a mismatch of `get` with the intended value means a stale echo replaced it; one more `update` repairs it. If the order assumption is wrong, the loop still converges in at most `MAX_REPAIRS` extra writes because each repair writes the intended value again. Comparison is `Object.is` because the stored values are booleans or `undefined`.
   - A rejected `update` rejects `write` (as today; the dispatcher's try/catch reports it).
2. **Routing (in scope).** `editor-session.ts`: `onSavePreviewState` (`:474`), `onSaveToolbarCollapsed` (`:484`; keep the broadcast loop before `await written`), `'save-outline-open'` (`:1577`) and the outline-open clear (`:1640`, add `.catch((error) => debug('outline open flag not cleared', error))`) all call `lastWriteWinsFor(this.context.globalState).write(...)`. A private getter `stateWrites` on `EditorSession` reads `this.context.globalState` lazily (tests replace the memento after construction). Reads (`buildInitOptions` and the others) stay on `globalState.get`: the local value is repaired at the acknowledgement, a window of a few ms, so a read cache would only add call sites.
3. **Keep unrelated writes out.** `save-options`, `save-outline-width` and emoji recents stay as they are (Owner question Q1). The repair of a routed key still works when an unrouted key's echo is the stale one.
4. **No webview, protocol, shape-table or manifest-of-commands change.** The only non-test structural source of truth to update is `scripts/module-manifest.mjs` (platform ids list: add `'last-write-wins'` with a one-line comment `Task 657 — ordered memento writes that survive stale storage echoes`).
5. **Real VS Code is a regression guard, not a deterministic RED.** The interleaving needs an extension-host stall that a spec cannot create on demand; the deterministic RED is the Vitest fake. S1 states what the real-VS-Code run before the fix may show (it can pass); the closure record must not claim it was ever RED.
6. **The spec's `settle(frame, 1000)` waits stay** (out of scope to remove). Update their comments to point at Task 657 only after the real-VS-Code burst passes.

### State, messages, shapes

No new message, shape-table entry, protocol field or key. New host module and one private getter; value types unchanged (`KeyPreviewOn`, `KeyToolbarCollapsed`, `KeyOutlineOpen` strict booleans, `undefined` for the clear).

Test fake (new, test only), `test/backend/ext-host-memento.ts` (plain helper, not a `*.test.ts`; same folder as `vscode-mock.ts`). `createExtHostMemento()` models the VS Code behaviour above with manual steps:
- `get(key)`, `update(key, value)` (sets local, coalesces a pending promise per key, marks a flush due, no timer), `keys()`.
- `flush()`: the scheduler tick: snapshots the local object into a to-main queue together with the pending deferred promises.
- `main()`: the main thread: stores the oldest snapshot in `mainValue` and queues, in this order, the echo (clone of the stored snapshot) and the acknowledgement (completes those promises) to the to-host queue.
- `deliver()`: the extension host takes the next item: an echo sets `local = clone`; an acknowledgement completes the promises.
- `drain()`: repeats flush, main, deliver until idle; `deliverEcho()`: delivers only the next echo.
- `mainValue` (what the storage holds) and `calls` (every `update(key, value)` made).

### Part 2 steps

One step, **S1** (Light; RED first, then fix; ). Order inside S1:

1. **Fake and RED.** Write `test/backend/ext-host-memento.ts` and the host-level cases below in `test/backend/editor-session.test.ts` (replace `context.globalState` with the fake before `session.start()`); run them against the unfixed code. Expected RED: after the scripted interleaving `mainValue` and `get` hold the earlier value. Record the failing assertions.
2. **Unit cases** in new `test/backend/last-write-wins.test.ts` (module does not exist yet: its import failure is the RED of this file).
3. **Fix:** add `src/platform/last-write-wins.ts`, the manifest id, the getter and the four routed sites. Comment the module header: what it fixes (a stale storage echo replacing the memento's local object), why (the memento contract promises nothing about it; `extensionHostProcess` `_storageListener` reassigns `_value`), and how (write, confirm after the acknowledgement, repair), per the repository comment rules.
4. **GREEN:** the same Vitest files, then the build, then the real-VS-Code spec.
5. **Real-VS-Code spec** (edit `test/vscode-e2e/preview-memory.spec.ts`, restart test at `:404-507`; no new `test()` block): in the first launch, instead of a single Preview click, run three bursts with script-driven clicks 100 ms apart on the real toolbar buttons, from the default states to the opposite end state: Preview off to on (on, off, on), toolbar expanded to collapsed (collapse, expand, collapse), Outline closed to open (open, close, open). Helper `burst(frame, selector, count = 3, spacingMs = 100)`: `frame.locator('body').evaluate` that clicks the element and `await`s a 100 ms timer between clicks (the same listener path as a user click; confirm in S1 that `[data-type="preview"]`, `[data-type="outline"]` and `[data-type="collapse-toolbar"]` are the buttons the listeners are bound to, `open-preview.ts:25-28`). Then, without a `settle`, wait for each end state (`expectPreview`, `[data-type="collapse-toolbar"]` `aria-expanded=false`, outline panel shown as in `outline-state.spec.ts:36-77`), open the next file by Quick Open in the same launch and expect Preview on, toolbar collapsed, Outline open (Acceptance 2). Second launch: the next file opens with all three stored (restart reads what the storage holds, so a stale main-thread value would show here); then restore the defaults with one click each (single toggles, existing 1 s wait) so the third launch still checks the default. Keep the existing flow otherwise.
6. **Record:** update `tasks/657-preview-toggle-rapid-store.md` (design points settled, Acceptance ticks only for what ran, progress with the failing and passing outputs). Keep `LOCAL_AGENT_TASK.md` §1 table current (orchestrator-owned, untracked). Closure gates run once in the orchestrator's batch, not here.

Owned files:
- `src/platform/last-write-wins.ts` (new)
- `src/session/editor-session.ts` (getter plus the four sites only)
- `scripts/module-manifest.mjs` (one id)
- `test/backend/ext-host-memento.ts` (new)
- `test/backend/last-write-wins.test.ts` (new)
- `test/backend/editor-session.test.ts`
- `test/vscode-e2e/preview-memory.spec.ts`
- `tasks/657-preview-toggle-rapid-store.md`

Not touched: all `media-src/` files, `src/shared/protocol.ts`, `webview-message-shape.ts`, `state-keys.ts`, `package.json`.

Checks (exact):
- RED/GREEN: `npx vitest run --config test/vitest.config.mts test/backend/last-write-wins.test.ts test/backend/editor-session.test.ts test/backend/module-boundaries.test.ts test/backend/extension.test.ts`
- `node scripts/module-manifest.mjs` (totality)
- `npx tsc --noEmit -p ./`, `npm run typecheck:vscode-e2e`
- `npx biome check src/platform/last-write-wins.ts src/session/editor-session.ts scripts/module-manifest.mjs test/backend/ext-host-memento.ts test/backend/last-write-wins.test.ts test/backend/editor-session.test.ts test/vscode-e2e/preview-memory.spec.ts`
- `npm run depcruise` and `npm run knip` (new module and helper must not trip either)
- `node build.mjs`, then `cd test/vscode-e2e && env -u ELECTRON_RUN_AS_NODE timeout 3600 xvfb-run -a npx playwright test preview-memory.spec.ts --workers=1 --retries=0` (one run before the fix is optional and may pass; one run after is required)

### Tests mapped to Acceptance and edge cases

Cheapest layer for each; host logic is Vitest, the stored value across a restart needs real VS Code.

Vitest, `last-write-wins.test.ts` (fake memento):
- Model control (guards the fake against drift from VS Code): raw `update` true, false, true with a stale echo between the third `update` and its flush ends with `mainValue` false.
- Same interleaving through `write`: `mainValue` and `get` end true; the third write's promise resolves after the repair (Acceptance 1, 3 at the unit level).
- No clobber: three writes in order cause exactly three `update` calls (no spurious repairs); older writes resolve without checking once superseded.
- Superseded: `write(a)` then `write(b)` before the first acknowledgement: final value `b`; both promises resolve.
- Unacknowledged `update` does not block a later `write`: the later `update` is called at once and `get` shows it.
- Bounded: a store that always reverts stops after the repair limit, logs, resolves.
- `undefined` (clear) is written and confirmed; a rejecting `update` rejects `write`.
- `lastWriteWinsFor(a) === lastWriteWinsFor(a)` and differs for another store.

Vitest, `editor-session.test.ts` (new `describe` after the Task 650 block, `it.each` over three rows: `{ command: 'save-preview-state', field: 'on', key: 'vmde.previewOn', initRead: options.openInPreview }`, toolbar (`collapsed`, `toolbarCollapsed` in `init`), Outline (`open`, `options.outlineOpen`)). Script per row with the fake installed: receive(true) and drain; receive(false) and `flush()` then `main()` only (its echo stays queued); receive(true); `deliverEcho()`; drain; then await all three receives.
- Final `mainValue` and `get` equal the last message (Acceptance 1, 3).
- A session opened afterwards gets the matching `init` value (Acceptance 2; Preview needs `openInPreview: true`, Outline `outlineOpen: true`, toolbar `toolbarCollapsed: true`).
- Toolbar row: the broadcast to another ready panel still carries each value in message order and is posted before the acknowledgement (existing cases `:1228-1252` stay green).
- Edge: the Outline clear from a `vmde.outline.defaultOpen` change racing a pending `save-outline-open` ends with the key cleared (the later write wins) and no unhandled rejection.
- Existing cases (`:1190-1345`, `:1440-1480`, `:1530-1640`) must pass unchanged; they also prove one `update` per write in the normal case.

Real VS Code (restart test of `preview-memory.spec.ts`, step 5): Acceptance 1 (three Preview clicks 100 ms apart end on), Acceptance 2 (the next opened file and the next launch read it), Acceptance 3 (toolbar collapse and Outline open keep the last value under the same burst, same launch and after restart). It guards the integrated path; it cannot prove the repair path ran (the interleaving is not forced).

Not added (no acceptance item): Chromium tests (webview unchanged), repeated bursts, the opposite end states.

### Owner questions

Q1. Scope: which `globalState` writes get the same ordering?
1. (Recommended) Only the three keys named in the record, plus the Outline open clear on the same key. Same defect class remains for `save-options`, `save-outline-width` and emoji recents, tracked as a follow-up.
2. Also route `save-outline-width` (`editor-session.ts:1572`), `save-options` (`:463`) and emoji recents (`:247`) through the same helper: three more one-line call sites and a few more host cases, same module. Outline width is written on every resize key press, so it is the most exposed of them.

### Residual risks

- The failing interleaving is derived from the VS Code source and modelled, not reproduced in real VS Code; the only measurement is one failure in Task 651's run. If the cause is something else that leaves the local value correct but the stored value stale, `get` cannot detect it; the restart step of the real-VS-Code spec is where that would show.
- The order claim "the echo is queued before the acknowledgement" is derived by reading (low-confidence in `- Writes from another VS Code window of the same profile replace the local object the same way (whole-object echo); the helper repairs only keys it wrote, and only for the last local intent.
- Keys not routed (Q1) keep the exposure: an unrouted write can still lose its own value. A routed key is protected even when the stale echo comes from an unrouted write, because its confirmation runs after its own acknowledgement.
- The real-VS-Code burst may pass before the fix; it then proves no regression, not that the defect was fixed. Say so in the record.
- Removing the 1 s waits in `preview-memory.spec.ts` and `outline-state.spec.ts` is left out; after Task 657 they are only comments to update.
- The `Memento` contract (`@types/vscode`) promises nothing about consistency; a future VS Code version that changes the storage echo would change the exposure, not the helper's correctness.

**Owner answer (2026-10-18, chat):** Q1 option 2 — also route `save-outline-width`, `save-options` and emoji recents through the same helper (in scope for Part 2).

## Execution progress — 2026-10-18 (Part 2)

Steps 1-4 of S1 done; step 5 (real-VS-Code burst in `preview-memory.spec.ts`) and the Acceptance ticks are NOT done: they need a real-VS-Code run, which this pass did not have. No Acceptance item is ticked.

Scope per the Owner answer: all six writes go through `lastWriteWinsFor` (Preview on, toolbar collapsed, Outline open and its clear, Outline width, saved editor options, emoji recents). Deviation from the handoff API, forced by that answer: `write` takes `unknown` (not only boolean/number/string/undefined) and confirms stored objects by JSON form, because saved options and emoji recents are objects and a storage echo returns parsed copies.

- Step 1 (RED): `test/backend/ext-host-memento.ts` (stepped model of the extension-host memento, with `injectEcho` added to model a stale copy from another window). Against the unfixed code 7 new `editor-session.test.ts` cases failed: Preview `expected false to deeply equal true`, toolbar `expected false to deeply equal true`, Outline open `expected false to deeply equal true`, Outline width `expected 400 to deeply equal 500`, saved options `expected { mode: 'ir' } to deeply equal { mode: 'wysiwyg' }`, emoji recents lost the second sequence, Outline clear race `expected true to be undefined`. `last-write-wins.test.ts` failed on the missing module import. The toolbar broadcast-order case passed before the fix, as expected (the broadcast does not depend on the fix).
- Step 2: `test/backend/last-write-wins.test.ts` (model control, same interleaving through `write`, no spurious repair, superseded write, per-key independence, unacknowledged `update` does not block, bounded repair, `undefined` clear, object equality by JSON form, rejection, per-store memoization).
- Step 3: `src/platform/last-write-wins.ts`, manifest id `last-write-wins`, `EditorSession.stateWrites` getter and the seven call sites.
- Step 4 (GREEN): `npx vitest run --config test/vitest.config.mts test/backend/last-write-wins.test.ts test/backend/editor-session.test.ts test/backend/module-boundaries.test.ts test/backend/extension.test.ts` passed (4 files, 226 tests); `node scripts/module-manifest.mjs`, `npx tsc --noEmit -p ./`, `npm run typecheck`, biome on the changed files, `npm run depcruise` and `npm run knip` passed.
- Unit level only: Acceptance 1 and 3 are proven against the model, not against real VS Code (the interleaving is derived from the VS Code source, not reproduced). Real-VS-Code proof is still open.

### Step 5 result (real VS Code) — FAILED, fix is insufficient

`preview-memory.spec.ts` restart test extended with three 100 ms bursts (Preview, Outline, toolbar collapse), then the next file in the same launch, the next launch, and restored defaults. Run with the fix in place (`node build.mjs`, `xvfb-run -a` with `openbox`, `--workers=1 --retries=0`): the first launch fails when the next file opens (`expectPreview(next, true)` times out; the new editor opened with Preview off). Two runs, same failure. With 400 ms spacing the Preview part passed. The Preview-only burst failed the same way, so the failure is not caused by the other two bursts.

Temporary host trace (removed afterwards): all three writes were acknowledged with `get` true, so the confirm-after-acknowledgement check saw nothing to repair. About 300 ms later `get` flipped to false and stayed false; the next file's init read false. A stale storage echo of the earlier flush therefore landed AFTER the last acknowledgement. The handoff's order claim ("every echo of an earlier flush arrives before the acknowledgement of a later one") is wrong in real VS Code, and a check done at acknowledgement time cannot repair a later echo.

Consequence: the Part 1 fix does not fix the defect. No Acceptance item is ticked. The wait comments in `preview-memory.spec.ts` and `outline-state.spec.ts` were left unchanged. Open design question for the orchestrator: keep verifying for a bounded window after the acknowledgement (re-check and rewrite on drift), or another approach. The spec burst is kept in `preview-memory.spec.ts` as the failing real-VS-Code test.

## Part 1 revision (2026-10-18, after step 5)

Read-only consultation on the uncommitted candidate in the task worktree. Nothing was built or run. The VS Code facts below come from reading the installed bundles (1.110.0, 1.129.0, 1.135.0 under `test/vscode-e2e/.vscode-test/worker-0/`); the constants and the listener code are identical in all three. The timings are derived from those constants and match the step 5 measurement (flip about 300 ms after the last acknowledgement; 400 ms spacing passes). They are not separately measured.

### Mechanism: where the late value comes from

The late value does not come from the writer's own synchronous echo, which Part 1 modelled. It comes from the **cross-process storage broadcast**, which is debounced twice and reads the value only when it fires:

1. Extension host, `extensionHostProcess.js`, memento class (`this._deferredPromises=new Map`): `update` sets `this._value[key]`, and a zero-delay scheduler sends the WHOLE `this._value` via `setValue` → `$setValue`. `this._storageListener` runs `this._value=o.value` on every `onDidChangeStorage` for this extension id, which `Fg.$acceptValue` fires after `JSON.parse`.
2. Renderer, `workbench.desktop.main.js`:
   - `MainThreadStorage` (class with `_sharedStorageKeysToWatch`) handles `$setValue` with `setExtensionState` → `storageService.store(id, JSON.stringify(obj), PROFILE)`.
   - The storage class `RE` (`static DEFAULT_FLUSH_DELAY=100`) sets `cache` and `pendingInserts` and calls `flushDelayer.trigger(flushPending)`. The delayer (`an.trigger`: `cancelTimeout()`, then a new timeout) is trailing, so the renderer sends `updateItems` to the main process 100 ms after the latest `set` in that storage scope.
3. Main process, `out/main.js`, storage IPC channel (`STORAGE_CHANGE_DEBOUNCE_TIME=100`): `registerStorageChangeListeners` wraps the storage's `onDidChangeStorage` in a trailing `Event.debounce` of 100 ms. The timer is reset by every change. When it fires, `serializeStorageChangeEvents` reads `t.get(s.key)`: the value the MAIN PROCESS holds at fire time, not the value that was written. `listen("onDidChangeStorage")` hands that event to every window's storage client, including the window that wrote it. There is no origin filter.
4. Renderer, storage client `Yat.onDidChangeStorage` → `RE.onDidChangeItemsExternal` → `acceptExternal`: if `cache.get(key) !== value`, it REPLACES the renderer cache with the main-process value and fires a change with `external: true`. `MainThreadStorage`'s `onDidChangeValue` listener then reads `getExtensionStateRaw(key, true)` (now the main-process value) and calls `$acceptValue` → step 1 replaces the extension host's whole `_value`.

Failing timeline (clicks at 0, 100 and 200 ms): set S1, which is flushed to main; set S2, which reaches main at about 200 ms and restarts the main debounce; set S3 at about 200 ms, still waiting in the renderer delayer. The main debounce fires with S2 just before the renderer's S3 `updateItems` arrives. The renderer cache (S3) and then the extension host `_value` (S3, already acknowledged) are both replaced by S2. The broadcast therefore lands after every acknowledgement, a few hundred ms after the write it reverts. With 400 ms spacing every write finishes this round trip before the next, so the main-process value is never behind.

**Is the stored main-thread value stale too?** Not from this path alone. The renderer still holds S3 in `pendingInserts`, or the `updateItems` for it is already in flight. The main process then stores S3, its debounce fires again with S3, and about 100 ms later the renderer and the extension host are corrected. It becomes persistently stale (so a restart reads it) when the extension host **flushes during the stale window**: any `update` to ANY key of this memento sends the whole stale `_value`. That includes a routed write, an unrouted one, or a repair. The renderer then stores it with a fresh `pendingInserts`, and the main process keeps it. In the step 5 spec the Outline and toolbar bursts start right after the Preview burst, which is exactly such a flush. In the Preview-only burst the next file's init read falls inside the stale window (between the stale broadcast and the healing broadcast). Whether the trace's "stayed false" outlived the healing broadcast in the Preview-only run was not checked (unverified).

The Part 1 local race (an own-window echo landing between a later `update` and its flush) is still possible but needs an extension-host stall. The ordering claim it relied on ("every echo arrives before a later acknowledgement") is false for the broadcast path, because that path is not on the `$setValue` reply channel at all.

No `Memento` change event exists in the API (`@types/vscode` `Memento`: `keys`, `get`, `update` only), so the extension host cannot observe step 4 except by reading `get`.

### Decision: authoritative intent with a bounded verification window (a + b combined)

Rejected:
- (a) alone (re-check only): the next file's init can read the stale `get` before the next check.
- (b) alone (a permanent in-memory value): it hides other windows' genuine changes for the process lifetime.
- (c) serializing flushes does not help, because the stale value is produced in the renderer and main process. Moving the state off `globalState` (a file under `globalStorageUri`) would change the settings-sync keys (`extension.ts:187`) and need a migration, which is out of scope.

Contract for `src/platform/last-write-wins.ts` (replaces the candidate's body; same module id):

- API: `lastWriteWinsFor(store: StateStore): LastWriteWins`, memoized per store in the `WeakMap`.
  - `StateStore = { get(key: string): unknown; update(key: string, value: unknown): PromiseLike<void> }`.
  - `LastWriteWins = { write(key: string, value: unknown): Promise<void>; get(key: string): unknown; dispose(): void }`.
  - Private constants, not exported: `CHECK_MS = 250`, `WINDOW_MS = 1500`, `MAX_REPAIRS = 3`, `HISTORY_MAX = 8`.
- Per-key **intent** `{ value, history: unknown[], quietMs: number, repairs: number }` in a `Map` (use `has`, so an intent of `undefined`, a clear, is distinct from no intent).
  - `history` holds the value `store.get(key)` returned before the first write of this intent chain (the base), then every value written for the key while the intent lived. It is capped at `HISTORY_MAX` (drop the oldest, never the base) and compared by `sameValue`.
- `write(key, value)`:
  1. Set or replace the intent: `value`, append to `history`, `quietMs = 0`, `repairs = 0`. On the first write of a chain, record the base first.
  2. Call `store.update(key, value)` as the FIRST store call (synchronous, as now; call order equals message order; no queue).
  3. Ensure the store-level timer is running.
  4. Await the update. If it rejects, reject `write` (the dispatcher's existing try/catch reports it) and keep the intent: the timer still verifies it.
  5. After the acknowledgement, if this key's intent is still the one this call set (compare by object identity), run the drift check for this key (below). This keeps the Part 1 local-race repair.
  6. Resolve. `write` resolves at the acknowledgement, never at the end of the window, so the toolbar broadcast ordering and the handlers' latency stay as they are.
- `get(key)`: the intent's value while an intent exists, else `store.get(key)`. Every read of the six keys goes through it, so a read during a stale window returns the last local intent.
- **Store-level timer**: one `setInterval(CHECK_MS)` per helper, running only while at least one intent exists. One timer, not one per key, so that all drifted keys are repaired in the same tick and the repair `update`s go out in one memento flush, which does not re-flush another key's stale value. Each tick, for every intent, run the drift check, then add `CHECK_MS` to `quietMs` for each intent that was not repaired, and drop those with `quietMs >= WINDOW_MS`. Clear the interval when no intent is left.
- **Drift check** for `key` (shared by step 5 and the tick):
  1. If `sameValue(store.get(key), intent.value)`, do nothing.
  2. Otherwise, if the drifted value is NOT in `history`, another writer (another window) made a genuine change. Drop the intent, `debug('state changed elsewhere', key)`, and do not repair.
  3. Otherwise, if `repairs >= MAX_REPAIRS`, drop the intent and `debug('state write not confirmed', key)`.
  4. Otherwise `repairs++`, `quietMs = 0`, and call `store.update(key, intent.value)` without awaiting it, with `.then(undefined, (error) => debug('state repair failed', key, error))`.
- `sameValue`: unchanged (`Object.is`, else JSON form for objects). Stored objects come back from `$acceptValue` as `JSON.parse` copies.
- `dispose()`: clear the interval and drop every intent (no final write). Register it in `src/app/extension.ts` `activate`: `context.subscriptions.push({ dispose: () => lastWriteWinsFor(context.globalState).dispose() })`.

Window length, justified by the mechanism: the stale broadcast lands at most one renderer flush delay (100 ms, `RE.DEFAULT_FLUSH_DELAY`) plus one main debounce (100 ms, `STORAGE_CHANGE_DEBOUNCE_TIME`) plus two IPC hops and event-loop delay after the reverted write reaches the renderer. The measured landing was about 300 ms after the last acknowledgement. `WINDOW_MS = 1500` is a quiet period of 1.5 s with no drift, about five times the measured value. Every repair restarts it, because a repair is a new write with its own round trip. `CHECK_MS = 250` bounds how long a stale value can sit in the stored copy (reads are already covered by `get`).

Multi-window semantics:
- A genuine change from another window to a value this window never wrote in the current intent chain is accepted at once.
- A change to a value this window did write (unavoidable for booleans) is treated as stale and fought at most `MAX_REPAIRS` times within the window. The window lasts 1.5 s of quiet after the last local write or repair. Then the intent expires and `get` returns the store's value again.
- Two windows writing the same key within about 1.5 s of each other can therefore end with either value; each window's fight is bounded, so it cannot loop.
- Reads see another window's change once the intent expires.

Routing, all six writes plus every read of those keys (`editor-session.ts` line numbers are from the worktree candidate):
- Writes are unchanged from the candidate (`stateWrites.write` at `:254`, `:470`, `:481`, `:491`, `:1576`, `:1581`, `:1644`).
- Reads switch from `this.context.globalState` to `this.stateWrites` (the helper has `get`, which matches the `{ get(key) }` parameter of `readToolbarCollapsed`, `readPreviewOn` and `readOutlineOpen` in `state-keys.ts`): `:233`, `:249`, `:354`, `:403` (drop the `<unknown>` type argument), `:404`, `:409`, `:424`, `:461`.
- `src/app/markdown-editor-provider.ts:195` (`KeyVditorOptions`) and `:258` (`readToolbarCollapsed`) read through `lastWriteWinsFor(this._context.globalState)`.
- `state-keys.ts` is unchanged.

### Test fake and RED cases

`test/backend/ext-host-memento.ts` gains:
- `history: Json[]`: every snapshot `main()` stored, oldest first (`mainValue` stays the last).
- `deliverStaleEcho(index)`: at once replaces `local` with a clone of `history[index]`. This models the main-process broadcast of an older stored value arriving after the acknowledgements.
- The header comment explains both echo sources: the writer's own echo, and the debounced cross-process broadcast that reads the main-process value at fire time and can land after the last acknowledgement.
- `injectEcho` stays (another window). `drain()` stays timer-free; the new cases use `vi.useFakeTimers()` and `await vi.advanceTimersByTimeAsync(250)` followed by `drain()` per tick.

`test/backend/last-write-wins.test.ts`. Each case ends with `lastWriteWinsFor(fake).dispose()` and `expect(vi.getTimerCount()).toBe(0)` where timers are faked.
- L1 model control: raw `update` true, false, true, each drained; `deliverStaleEcho(1)` → `get` false. A raw `update` of another key plus `drain()` → `mainValue[key]` false (the stale value is persisted). This passes against the model and guards it.
- L2 late stale echo, no further write: three `write`s drained, `deliverStaleEcho(1)`. Then helper `get` is true at once, and after one tick plus `drain()`, `store.get`, helper `get` and `mainValue` are all true, with exactly one repair `update`.
- L3 stale re-flushed by another key: as L2, then `write(other, x)` and `drain()` before the tick, so `mainValue[key]` is false. After one tick, `mainValue[key]` is true and `mainValue[other]` is `x`.
- L4 window boundary: a stale echo at 1250 ms of quiet is repaired. After 1500 ms of quiet the timer is gone (`getTimerCount() === 0`), and a later stale echo is not repaired; helper `get` returns the store value.
- L5 another writer: `injectEcho` with a value never written (Outline width 777, or a different options object) → no repair `update`; helper `get` returns 777; the debug log was called.
- L6 base value: the first write ever to an absent key, then `deliverStaleEcho` of a snapshot without the key → repaired (the base `undefined` is in `history`).
- L7 bounded: a store that reverts to an older written value after every `update` → exactly `MAX_REPAIRS` repairs, the intent is dropped, the log is called, `write` has resolved.
- L8 one flush for all drifted keys: one stale echo reverts two keys → one tick issues both updates before the next `flush()`; the single snapshot holds both values.
- L9 `write` resolves at the acknowledgement while the window is still open (timer count 1). After `dispose()`, advancing 5 s issues no `update`.
- Keep the existing cases: same interleaving at the acknowledgement, no spurious repair, superseded write, per-key independence, an unacknowledged `update` does not block, `undefined` clear, JSON equality, rejection, memoization. Update "bounded" to the shared repair count.

`test/backend/editor-session.test.ts`, in the Task 657 `describe`:
- Fake timers for the new cases; `afterEach` disposes `lastWriteWinsFor(context.globalState)`.
- New `it.each` over the six writes (Preview on, toolbar collapsed, Outline open, Outline width, saved options, emoji recents). Script: three messages, each drained, then `deliverStaleEcho(1)`.
  - E1: a session opened immediately reads the last value in `init`. RED on the candidate (it reads the stale value), which is the step 5 failure.
  - E2: after one tick plus `drain()`, `globalState.get` equals the last value. RED on the candidate.
- E3 re-flush: Preview burst, stale echo, then `save-outline-open` true drained → `mainValue['vmde.previewOn']` false. After one tick, true, with the Outline open still true. RED on the candidate.
- E4 another window: `injectEcho` of an options object never written → the next `init` uses it after the intent drops; no repair.
- Existing cases pass unchanged. If any existing case writes through the host and then mutates the store directly within the same test and expects the read to see it, that is the within-window intent semantics. Record it and adjust only that assertion's timing (advance past the window); do not weaken the contract.

Real VS Code: keep the step 5 burst in `preview-memory.spec.ts` unchanged as the end-to-end proof. It is RED now (two runs, recorded). It must pass after the fix: the same launch's next file, and the next launch.

### Part 2 steps

One step, S1-rev (RED first, then fix):
1. Fake and RED: extend `ext-host-memento.ts`; add L1–L9 and E1–E4; run against the candidate and record the failures. L1 and the unchanged existing cases pass; E1–E3 and L2–L9 fail, with L9 failing on the missing `get`/`dispose`.
2. Fix: rewrite `src/platform/last-write-wins.ts` to the contract, with a header comment giving what it fixes, why (the four steps above with the identifiers `RE.DEFAULT_FLUSH_DELAY`, `STORAGE_CHANGE_DEBOUNCE_TIME`, `serializeStorageChangeEvents`, `acceptExternal`, `_storageListener`), and how. Route the reads in `editor-session.ts` and `markdown-editor-provider.ts`; register `dispose` in `extension.ts`. Update the `last-write-wins` manifest comment to `Task 657 — memento writes that survive stale storage broadcasts`.
3. GREEN: Vitest, then the build, then the real-VS-Code spec (required).
4. Record in `tasks/657-preview-toggle-rapid-store.md`: this revision, the RED and GREEN outputs, Acceptance ticks only for what ran. After the real-VS-Code pass, update the wait comments in `preview-memory.spec.ts` only. The `outline-state.spec.ts` comment is outside the owned set, so leave it and record it as a follow-up.

Owned files:
- `src/platform/last-write-wins.ts`
- `src/session/editor-session.ts` (read sites only, on top of the candidate)
- `src/app/markdown-editor-provider.ts` (two reads)
- `src/app/extension.ts` (one `dispose` registration)
- `scripts/module-manifest.mjs` (comment)
- `test/backend/ext-host-memento.ts`
- `test/backend/last-write-wins.test.ts`
- `test/backend/editor-session.test.ts`
- `test/vscode-e2e/preview-memory.spec.ts` (comments only after the pass)
- `tasks/657-preview-toggle-rapid-store.md`

Checks:
- `npx vitest run --config test/vitest.config.mts test/backend/last-write-wins.test.ts test/backend/editor-session.test.ts test/backend/module-boundaries.test.ts test/backend/extension.test.ts test/backend/active-panels.test.ts test/backend/asset-link-actions.test.ts` (the last two import the provider)
- `node scripts/module-manifest.mjs`; `npx tsc --noEmit -p ./`; `npm run typecheck:vscode-e2e`
- `npx biome check` on the owned files; `npm run depcruise`; `npm run knip` (no new exports beyond `lastWriteWinsFor` and the types)
- `node build.mjs`, then `cd test/vscode-e2e && env -u ELECTRON_RUN_AS_NODE timeout 3600 xvfb-run -a npx playwright test preview-memory.spec.ts --workers=1 --retries=0`. It must pass. If it fails, keep a temporary host trace of `get` per tick, the same as step 5, and report it; do not tune the constants blindly.

### Residual risks

- The timeline is derived from code constants and fits one measurement. A broadcast that lands more than `WINDOW_MS` after the last local write or repair is not repaired. That can happen when continuous profile-scope writes keep restarting the renderer's trailing delayer, from VS Code or other extensions, or during an extension-host stall. Reads then return the store value, and the stored value is still correct unless something re-flushes the stale copy.
- Booleans cannot tell a stale broadcast from another window's identical-valued change. Within the window, this window's last intent wins, up to `MAX_REPAIRS`.
- Closing the window during a stale window with a pending re-flush of the stale copy can persist it. `dispose` deliberately does not write.
- An intent hides another window's change for up to 1.5 s of quiet after a local write. Existing tests that mutate the store directly mid-test may observe this.
- Unrelated `globalState` keys (none remain unrouted after the Owner answer) and other extensions are unaffected. The memento contract promises nothing; a future VS Code change to the debounces or the broadcast changes the exposure, not the helper's bounds.
- Whether the Preview-only "stayed false" outlived the healing broadcast was not checked. The fix covers both cases (reads through the intent; the store is repaired by the tick).

**Orchestrator acceptance (2026-10-18):** revision accepted; owned files grow by `src/app/markdown-editor-provider.ts`, `src/app/extension.ts` and the 1 s wait comment in `test/vscode-e2e/outline-state.spec.ts`.

### Revision implementation — Vitest part (2026-10-18)

Implemented the "Part 1 revision": per-key intent with a bounded check window (`CHECK_MS` 250, `WINDOW_MS` 1500, `MAX_REPAIRS` 3, `HISTORY_MAX` 8), one interval per store, helper `get` for all reads of the six keys (`editor-session.ts`, `markdown-editor-provider.ts`), history-based acceptance of another window's change, `dispose()` registered in `extension.ts`. Fake memento gained `history` and `deliverStaleEcho`.

- RED (against the Part 1 candidate with only a pass-through `get` and a no-op `dispose` added so the reads compile): 19 failed, 164 passed — L2, L3, L5, L6, L8, L9 and, after fixing L4's assertion, L4; E1 and E2 for all six writes; E3. L1 and the existing cases passed. E4 and L7 pass on the candidate by design (they guard no-repair and the repair bound).
- GREEN: `npx vitest run --config test/vitest.config.mts` on last-write-wins, editor-session, module-boundaries, extension, active-panels and asset-link-actions: 6 files, 316 tests passed. The whole `test/backend` folder: 109 files, 2845 passed (1 expected fail), so the per-test `dispose` of used mementos keeps timers from leaking between tests.
- `node scripts/module-manifest.mjs`, `npx tsc --noEmit -p ./`, `npm run typecheck:vscode-e2e`, biome on the changed files, `npm run depcruise`, `npm run knip` pass.
- Real-VS-Code burst NOT re-run yet (token held elsewhere); no Acceptance item ticked; the wait comments are unchanged.

### Real-VS-Code result after the revision

`node build.mjs` exit 0; `env -u ELECTRON_RUN_AS_NODE VMDE_XTEST=1 timeout 3600 xvfb-run -a` (openbox in the shell) `npx playwright test preview-memory.spec.ts --workers=1 --retries=0`: exit 0, 2 passed, twice in a row (the burst test previously failed twice with the Part 1 candidate). The restart test covers three 100 ms bursts (Preview, Outline, toolbar collapse), the next file in the same launch, the next launch, and the restored defaults. Acceptance 1 to 3 are ticked on that basis. The burst cannot prove which path repaired the value (the stale broadcast is not forced); its earlier failure with the Part 1 candidate and the host trace are the evidence for the mechanism. The 1 s wait comments in `preview-memory.spec.ts` and `outline-state.spec.ts` now cite Task 657.

### Review follow-up (2026-10-18)

Two low findings fixed in `src/platform/last-write-wins.ts`, each with a RED test first (3 failed before, all pass after): a write or read after `dispose()` now passes straight to the store (no intent, no timer); a synchronous throw from `store.update` drops the intent and rethrows, and a throw while checking or repairing one key no longer skips the other keys or the idle cleanup.

Residual (accepted by contract): a clear or other change made in another window to a value this window wrote earlier in the same intent chain (for example a cross-window clear back to the base value) is treated as a stale value and repaired, at most 3 times within the 1.5 s window.

## Closure — 2026-10-18 (batch 3)

Gate run on HEAD `dbb3c104` (one run serves batches 3 and 4).

| Command | Exit | Result |
| --- | --- | --- |
| `node build.mjs` | 0 | built |
| `npm run lint:ci` | 0 | 1,226 files checked, no fixes |
| `npm run typecheck` | 0 | clean |
| `npx tsc --noEmit -p ./` | 0 | clean |
| `npm run knip` | 0 | clean |
| `npm run jscpd` | 0 | clean |
| `npm run depcruise` (host and webview) | 0 | clean |
| `npm run test:coverage` (gate run, then two more) | 0, 0, 0 | 358 files, 7,256 passed, 1 expected fail, in each of the three runs; no timeout, no unhandled error; statements 80.19%, branches 73.59%, functions 83.51%, lines 82.44% (gate run) |
| `npm run check:coverage-modules` | 0 | ratchet OK, 10 modules at 0% (baseline 10), no prune notice |
| `npm run check:brand-identifiers` | 0 | clean |
| `npm run check:bundle-size` | 1 | reporting only: `media/dist/main.js` 1,037,005 B (1,013 KB) against the 608 KB budget (inherited miss); lazy bundles within budget |
| `npm run check:startup-cost` | 1 | reporting only: 384 eager modules against 294 (inherited miss); largest module 30 KB of 34 KB |

`npm run quality` and `npm run audit` were not run (audit omitted by Owner instruction). No new failure; no real VS Code or Chromium run in the closure. Bundle: 1,037,005 B, +2,959 B against batch 2 (1,034,046 B); eager modules 384, +3 against batch 2 (381). The new webview modules since batch 2 are `toolbar-flow-install` (Task 661) and `preview-raw-headings` (Task 660), plus the changed section-indent and table code; the split was not measured.

Task commits: fa7c2216 (progress), a77e2483 (fix), e4635adc (tests); filed in 1985ceb2 and 20c08750.

Acceptance: All three acceptance items ticked earlier (real VS Code `preview-memory` 2 passed twice after the revision). Closure gates passed.

Residual risks: The stale storage broadcast is not forced in the real-VS-Code burst, so the spec cannot show which path repaired the value; a broadcast landing more than 1.5 s after the last write is not repaired; a cross-window clear to a value this window wrote earlier in the same chain is treated as stale and repaired up to 3 times.

Owner rulings already recorded: Owner answer: all six remembered-state writes go through the last-write-wins helper.
