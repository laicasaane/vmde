# Task 657 — Store the last Preview toggle when toggles are rapid

**Status:** open.
**Origin:** Project Owner request (known issue from Task 651).
**Severity:** low.
**Tech stack:** VS Code extension host (`globalState` writes) and webview Preview toggle messages.
**Related:** [Task 651](done/651-remember-preview-toggle-state.md) (remember Preview toggle state), Task 631 (toolbar collapse), [Task 650](done/650-remember-outline-open-state-and-width.md) (remember Outline open state and width).

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

- [ ] Three Preview toggles about 100 ms apart (on, off, on) leave the stored value on.
- [ ] The next opened file reads the stored Preview state that matches the last toggle.
- [ ] The toolbar collapse write and the Outline open write keep the last value under the same rapid sequence.

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
