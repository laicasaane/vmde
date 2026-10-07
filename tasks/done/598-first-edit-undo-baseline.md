# Task 598 — The first edit after opening a document can be undone

**Status:** ✅ DONE (2026-10-07) on `dev`. The cold-diagram re-render acceptance item moved to [Task 623](../../623-cold-mermaid-undo-rerender.md) under ruling Q3.
**Origin:** investigation for Task 596 (2026-09-28). The defect predates Task 579.
**Recommended implementer effort:** high.
**Tech stack:** build-time Vditor patch (`media-src/esbuild-shared.mjs`), `media-src/src/editing/undo-boundaries.ts`, Vitest, Chromium, real VS Code with XTEST.
**Dependencies:**

- Land **Task 597** first. Both tasks patch `vditor/src/ts/undo/index.ts`, at different anchors, so sequence the patch chain carefully. Task 597's restore fallback also covers this task's residual risk for diagrams that are still rendering.
- **Task 601** (Undo before a pending checkpoint) builds on this task.
- **Task 602** (host/webview divergence) will apply to this first step once it becomes undoable.

**Evidence:** `tmp/task596-603-evidence/t598/` in the main checkout (`results-run1.json`, `results2.json` … `results8.json`). Real VS Code 1.129.0, `VMDE_XTEST=1`, Task 579 build.

## Problem

An edit made within about 0.4 s of the editor becoming visible can never be undone. This reproduced in all 13 scenarios:

- IR with Ctrl+Z at 0, 300, 1500 and 3000 ms after the edit;
- a second edit, where the first is still lost;
- Ctrl+B as the first edit;
- the toolbar Undo button, which stays disabled;
- the `vmde.format.undo` command;
- WYSIWYG and SV;
- a mode switch followed by an immediate edit;
- a document containing a mermaid diagram.

Undo is a silent no-op. The host version does not change, and native undo never runs. When the user waits at least 1 s before editing, undo works in every mode.

An earlier probe of the Task 597 investigation saw the first edit undo correctly. That probe edited after its setup delay, so it was outside the race window. Both results are consistent.

Root cause (file:line in Vditor 3.11.3 unless noted):

1. `undo/index.ts:206-225` initialises every mode with an empty `undoStack` and `lastText ""`. The first snapshot is only scheduled: `EditMode.ts:61-65/92-96/127-131` sets a timer (`ir/process.ts:50-77`, `wysiwyg/afterRenderEvent.ts:14-41`, `sv/process.ts:135-140`), using `undoDelay` 800 ms (`vditor-init.ts:295-298`). It lands 640–1570 ms after mount.
2. Each input first calls `clearTimeout` on the same per-mode timer, so an early edit cancels the pending baseline.
3. The first `addToUndoStack` always pushes (the early return at `:116` needs `undoStack.length > 0`). The baseline therefore already contains the first edit.
4. `undo()` needs at least two entries (`:58-60`), and the toolbar enables only when `length > 1`. `recordFirstPosition` (`:88`) rewrites only a stack of length 1.
5. A second edit becomes entry 2 and is undoable. The first edit is permanently part of the baseline.
6. Ctrl+B: `boundary()` (`undo-boundaries.ts:134`) checkpoints only when the editor already has unsaved typing, so its after-action checkpoint becomes the baseline.
7. Mode switch: each mode has its own empty stack.
8. VMDE already works around the same race in `section-hoist.ts:237-243`. Host updates avoid it through `setValue(content, true)` → `clearStack`.

## Design

Seeding the baseline once at init was rejected. When a diagram's first render is not yet cached, the render finishes after the seed. Undo then put the caret outside the text, the mermaid SVG was not re-rendered, and the next key was lost (2 of 2 runs, `results7.json`).

Chosen design: seed the baseline at the user's first action, just before it changes anything. This was emulated in 7 of 7 scenarios (`results8.json`) and gave:

- exact host text restored, the version raised by one, and the document clean;
- the caret inside the paragraph;
- a second Ctrl+Z doing nothing;
- Redo working;
- `Y` then typing as `delta.Y`.

1. **F1 — build-time patch `patchUndoSeedBaseline`** in `esbuild-shared.mjs`, chained with the `undo/index.ts` patches. Anchors throw when not found.
   - Add a new method, `public vmdeSeedBaseline(vditor): boolean`, before `public addToUndoStack` (`:111`). It:
     - returns false unless both of the active mode's stacks are empty;
     - cancels that mode's pending timer (`wysiwyg.afterRenderTimeoutId`, otherwise `[mode].processTimeoutId`);
     - takes `text = this.addCaret(vditor)` without restoring the caret, as `recordFirstPosition` already does;
     - pushes `patch_make(text, "", diff_main(text, "", true))` and sets `lastText = text`.
   - In `recordFirstPosition`, right after the `rangeCount` guard (`:85-87`), add `if (this.vmdeSeedBaseline(vditor)) return;`. This covers every Vditor keydown path.
2. **F2 — VMDE side, in `undo-boundaries.ts`.** Add `seedUndoBaseline(inner) = inner.undo?.vmdeSeedBaseline?.(inner)` and extend the `UndoInner` type. Call it from three places:
   - the first line of `boundary()`, which covers toolbar actions, paste, Enter, syntax promotion and command chords;
   - `onKeydown`, after the composition and Find checks and before the check that skips hotkey keydowns forwarded through the host; never for a bare modifier key;
   - a new capture listener on `beforeinput`, which skips the Find widget and `isComposing`. It covers drag-drop, context-menu cut and paste, and spellcheck.
3. **Cancelling the pending timer is safe (inferred; pin it in unit tests).** While a mode's stack is empty, the only pending timer is a render timer: setEditMode, setValue, stream-render or the wiki re-render. All of them use `enableInput:false`.

## Owner decisions needed

1. Is a third build-time patch to `undo/index.ts` acceptable (recommended)? The alternative is VMDE-only access to Vditor's private `addCaret`/`dmp`.
2. IME composition as the first edit: leave it uncovered, or seed at `compositionstart`? Seeding there risks disturbing the composition.
3. Undoing to a baseline taken before a diagram finished rendering does not re-render the diagram (seen with mermaid). Fold that into Task 597's restore work, or track it separately?

## Tests

- **Vitest**
  - `test/backend/vditor-source-patches.test.ts`: `patchUndoSeedBaseline` throws on drift, inserts exactly once, and composes with `patchDmpInterop`, `patchUndoCaretSplitRestore` and Task 597's patch on the real source.
  - `undo-boundaries.test.ts`:
    - `seedUndoBaseline` delegates to Vditor and is a no-op when the method is missing;
    - a non-modifier keydown seeds before the forwarded-hotkey return;
    - modifier-only, composing and Find-widget events do not seed;
    - `beforeinput` seeds;
    - `boundary()` seeds before its checkpoint (use spies to check the order).
- **Chromium:** a new `describe` block without the existing 900 ms wait.
  - At `__ready`, the stack is empty; this proves the race window is live.
  - Type `X` immediately, wait about 1.1 s, and expect 2 entries.
  - `__undo()` gives an empty value; a second `__undo()` changes nothing; `__redo()` restores `X`.
  - Repeat with a toolbar Bold click as the first action.
- **Real VS Code:** `test/vscode-e2e/undo-first-edit.spec.ts`, gated with `VMDE_XTEST=1`, after `node build.mjs`.
  - Run IR, WYSIWYG and SV through `defaultMode`, and reset it in `afterEach`.
  - Precondition: the stack is empty at readiness. Otherwise fail with "race window missed".
  - Type `X`, then poll until the host is exactly DOC with `delta.X` and the stack has 2 entries.
  - Ctrl+Z: the host is exactly DOC, the version rises by one, and `isDirty` is false.
  - A second Ctrl+Z, then a 1 s negative wait: nothing changes.
  - Type `Y`: the host has `delta.Y`.
  - Variants:
    - Ctrl+B first;
    - the toolbar Undo button and `vmde.format.undo`;
    - IR→SV and IR→WYSIWYG switches;
    - a unique cold mermaid block: the caret is inside a block after Undo, and `.language-mermaid svg` exists.
  - Send a warm-up Ctrl+Z on an untouched document first. In 6 of 8 probe sessions the first XTEST Ctrl chord of a VS Code session never reached the webview; that cause is not investigated. Never retry Ctrl+Z.
- The existing specs that deliberately wait for the first snapshot must still pass: `undo-dirty-probe`, `undo-redo-steps`, `toolbar-overflow`, `github-color-literals`, `auto-wrap`, `selection-bubble`, `lockstep-undo-spike`, and Chromium `undo-boundaries`.

## Execution progress

**S1–S3 (2026-10-07, HEAD `923f0fbe`, Claude Opus 5.5).** Authority: `tmp/queue-part1/598-native-handoff.md` §1 steps 1–4, §2.1, §2.2 and §2.4.

- **Reconciled with the post-580/597 source.** `MODEL_COMMAND_KEYS` is gone; the Enter boundary covers unmodified Enter and Shift+Enter only. Undo/Redo arrive as `trigger-toolbar-hotkey`. Formatting commands click the toolbar button (an untrusted click, so `boundary()` runs), and editor actions call `takeEditorActionUndoBoundary`. The live `undo/index.ts` chain was `patchUndoRestoreCaretFallback(patchUndoCaretSplitRestore(patchDmpInterop(code)))`.
- **Behavioral RED on HEAD** (source-patched Chromium harness `media-src/e2e/undo-boundaries-harness.ts`, extended with `mode`/`doc` parameters, read-only stack/seed/publication observers, and the composition, caret and Task 597 restore bridges installed in `boot/main.ts` order):
  - The precondition held: both stacks were empty at ready and just before the key.
  - After an immediate `X`, the stack stayed at one entry, which already contained `X`, in IR, WYSIWYG and SV. With fewer than two entries, `undo()` returns without doing anything.
  - With the product files at HEAD, all 26 first-action cases in the new `describe` failed. The 5 settled-history cases, the exclusion case and the 3 IME-publication guards passed.
- **Implemented:**
  - `patchUndoSeedBaseline` in `media-src/esbuild-shared.mjs`, chained last in the `undo/index.ts` registry entry; the 597 and 613 anchors are untouched. It adds `vmdeSeedBaseline(vditor, event?)` before `addToUndoStack`, and a hook in `recordFirstPosition` after the zero-range return that is skipped for `isComposing`, keyCode 229 and `data-vmde-composing`. Each anchor must occur exactly once, and a second application throws. A row was added to `docs/vditor-patch-checklist.md`.
  - In `media-src/src/editing/undo-boundaries.ts`: `seedUndoBaseline(inner, event?)`, which respects `isCompositionActive()`. It is called first in `boundary()`, in capture `keydown` for every key except bare modifiers (after the composition and Find exits), and in seed-only capture listeners for `beforeinput`, `cut` and `drop` on the active editor root. `takeEditorActionUndoBoundary` seeds for every editor action, so a Command Palette route is covered too. Every listener is removed on disposal.
- **Three narrow repairs beyond the handoff, each measured first (orchestrator review requested):**
  1. **IME publication hold.** An IME first edit takes no seed (ruling Q2). In IR and WYSIWYG, its compositionend schedules the timer that publishes it. A later seed in the same window (ArrowRight in the probe) cancelled that timer, and `options.input` was never called (0 publications against 1 without the key). VMDE now records that timer in `undo.vmdeHeldTimer` in a window bubble `compositionend` listener while the history is empty, and the seed refuses while it is the pending timer. SV publishes synchronously and was not affected. With the listener disabled, the new guard spec fails in all three modes.
  2. **Element-endpoint selection re-sync inside the seed.** This is the Task 613/617 mechanism: after `addCaret`, Chromium kept the Range but shrank its internal selection.
     - With the root selected in the empty window, the first Delete removed one character; on HEAD it emptied the document.
     - `structural-selection` "triple-click paragraph type-over", which runs 250 ms after ready, kept `**bold scope**`. It failed on the candidate and passed on HEAD.
     - The seed now writes the same live endpoints again with `setBaseAndExtent` when either endpoint is an element. This is not a caret-authority request.
  3. **No upstream rewrite for a keydown the seed already served.** After VMDE's keydown seed, Vditor's `recordFirstPosition` on the same keydown saw a one-entry stack and ran its own `addCaret` rewrite, which desynchronized the selection again. The seed records `vmdeSeedEvent`, and the hook returns for that event.
- **Task 617 overlap (not folded in).** 617's upstream path is unchanged. A whole-document selection made after an earlier seed, followed by Delete (for example Ctrl+A's own keydown seeds, then the Delete keydown takes the upstream rewrite), still keeps the last paragraph, as HEAD does after `undoDelay`. Task 598 makes that pre-existing settled behavior reachable before `undoDelay` too. A 617 fix to `recordFirstPosition` covers both. The seed does not fix 617.
- **Verification:**
  - Vitest (focused, 7 files, 524 passed): `vditor-source-patches` (282: anchors, missing/duplicate/double-apply throws, ordering, forbidden calls, the compiled method's runtime semantics in all three modes, the held timer, element re-sync, the seeded-event skip, unchanged 445/487/553/597 methods, registry composition), `patch-mutation`, `undo-boundaries` (123; every changed line and branch covered), `undo-keybind`, `module-boundaries`, `undo-restore-caret`, `harness-registry`.
  - Chromium `--workers=1 --retries=0`: `undo-boundaries.spec.ts` 43/43, covering:
    - IR, WYSIWYG and SV typing in an empty and an existing paragraph, with exact Undo, an inert second Undo, Redo, and the next key landing at the restored caret;
    - a backward-selection replacement;
    - toolbar Bold in three modes, and the command route;
    - paste with no doubled checkpoint;
    - keyless `Input.insertText` in three modes, and Backspace;
    - Vditor cut, an external HTML drop, and a real internal drag-drop across paragraphs;
    - IR→SV and IR→WYSIWYG mode switches;
    - the exclusions;
    - the IME publication hold in three modes;
    - arrow-first navigation;
    - the method contract in three modes, plus refusals;
    - backward, root-level and held-drag selection preservation;
    - whole-document Delete.
  - The full related Chromium set passed 159/159 (`undo-*`, `held-drag-undo-snapshot`, `ime-composition`, `blockless-caret`, `vditor-chords`, `shortcut-negative`, `dragdrop`, `mode-roundtrip`, `paste-pipeline`, `toolbar-selection`, `selection-bubble`, `structural-selection`, `mouse-selection`, `caret-link`).
  - Static gates:
    - `node build.mjs` and `typecheck` pass.
    - `typecheck:strict` shows its 15 baseline findings, none in changed files.
    - `lint:ci` and `depcruise` are clean.
    - `knip` reports its 10 baseline findings.
    - `jscpd` is at 6.50%; the only new clone is a 6-line text walker shared with the 597 harness.
  - Real VS Code (existing specs only, as a regression check; `VMDE_XTEST=1`, Openbox without key bindings, `--workers=1 --retries=0`, one invocation, final build): `undo-redo-steps`, `undo-boundaries`, `undo-restore-caret` (4), `list-enter-undo-caret`, `held-drag-undo-snapshot` (2): 9/9 passed.
- **Open after S1–S3:** the real-VS-Code spec (done in S4 below); `test:coverage` and `check:coverage-modules` (run in S4).

**S4 (2026-10-07, HEAD `922a0686`, Claude Opus 5.5).** Authority: handoff §2.3, §2.4, §3.

- **New spec `test/vscode-e2e/undo-first-edit.spec.ts`** (XTEST, `VMDE_XTEST=1`; 6 tests, 13 legs). Each leg opens a fresh document, so the active mode's history is naturally empty, and acts without waiting out the race. A read-only wrapper on `vmdeSeedBaseline` records the stacks it saw, the snapshot count before it and the calling event; a leg fails as "race window missed" unless the first seed found both stacks empty, no snapshot had been taken, and the seed came from the measured action. Every test first sends a warm-up Ctrl+Z to an untouched, settled document. Measured keys are never retried. Mechanisms are named in each leg record:
  - Typing in IR, WYSIWYG and SV (XTEST `X`): exact host, two entries, one Ctrl+Z restores the opened bytes with the host version +1 and the host clean, an editable painted caret after `delta.`, a second Ctrl+Z inert over 1 s (text, version, dirty, stacks), Ctrl+Y, Ctrl+Z, then `Y` lands as `delta.Y`. Disk keeps the opened bytes until Save; Save and reopen keep the final bytes.
  - Formatting first: XTEST Ctrl+B and `executeCommand('vmde.format.bold')` on a selected word. The leg waits for the Bold button to lose `vditor-menu--disabled` before the action (Task 596's stale toolbar class, as `shortcut-identity.spec.ts` does). Exactly one `trigger-toolbar-hotkey:bold` message, two entries, the toolbar Undo enabled, the same Undo/Redo journey, and `Y` at the restored caret before the word.
  - Paste: XTEST Ctrl+V of VS Code's clipboard; the trusted Ctrl+V keydown takes the seed and a trusted `paste` follows. Cut: `executeCommand('editor.action.clipboardCutAction')` (the command the webview context menu and Edit menu run); the trusted `cut` takes the seed.
  - Drag/drop: an XTEST pointer drag (xdotool) of a selected word into the next paragraph. `dragstart` and `drop` arrive trusted, and the capture `drop` takes the seed in the window. The text does not move: VS Code's webview host frame cancels every drop (`handleInnerDropEvent` calls `preventDefault()` in its `pre/index.html`), and Vditor's internal-drop handler only schedules a render. A scratch probe measured the same on the pre-598 build (S1–S3 product files swapped from `HEAD~1`, rebuilt, restored with `cmp`, rebuilt) and with settled history, so this predates Task 598. The leg asserts that the drop and its seed change nothing (host, dirty, webview, history `1/0`), then that a typed edit undoes back to the opened bytes from that seed. The drop edit itself is covered only by the Chromium harness.
  - Undo entry points: keyboard (typing legs), a Playwright mouse click on the toolbar Undo, and `executeCommand('vmde.format.undo')`; each reaches the engine once.
  - Mode switch: IR settled, then the toolbar switch to SV and to WYSIWYG; the new mode is `0/0` at the key, the switch publishes nothing, and IR's history stays `1/0`.
- **Cold-Mermaid detector (fails; acceptance left open).** A unique 30-pair flowchart, armed without a click as soon as Vditor exists. The window was cold in 3 of 3 final runs: the seed found `0/0` with no snapshot and no SVG (`svgAtReady` false). Source restoration, the host clean, an editable caret after `delta.` and the next key all pass. The diagram does not come back: after Undo the preview exists with `data-render="1"`, its `.language-mermaid` element has no children (reserved height 357 px, in view), and no SVG appears within 10 s, nor within 10 s more after scrolling it into view. Before Undo it had rendered (SVG 688×15, 218 shapes, no error). This is the Q3 mechanism: the seed snapshot captured the preview while its render was in flight, already flagged `data-render="1"`, so the restore is never re-rendered. Per ruling Q3 this is the separate follow-up; no renderer or Task 597 code was changed. Two earlier smaller diagrams rendered before the editor accepted input, so they were recorded as missed cold windows, not as passes.
- **Runs (final build of `922a0686`; `--workers=1 --retries=0`, Xvfb + Openbox without key bindings):**
  - `undo-first-edit.spec.ts` run a: 4/6 tests passed. Formatting failed in setup, before any leg: `electronApplication.browserWindow: Resulting promise was garbage collected` in `createXtestInput`. Task 578 relay 6 recorded the same window-mapping failure. Cold Mermaid failed as above.
  - Run b: 5/6 passed; only cold Mermaid failed. Across both runs every non-Mermaid leg passed inside the empty-history window (12 of 12 in run b).
  - A third Mermaid-only run reproduced the detector with the seed record.
  - Regression, once: `undo-redo-steps`, `undo-boundaries`, `undo-restore-caret`, `list-enter-undo-caret`, `held-drag-undo-snapshot`, `structural-selection`, `noop-check-on-save` and `save-flush-routes` gave 15/16. `undo-restore-caret` WYSIWYG failed in setup with the same `createXtestInput` garbage-collection error; its rerun passed. `shortcut-identity` and `find-replace` gave 10/10.
- **Gates:**
  - `test:coverage`: 330 files, 5922 passed plus 1 expected fail.
  - `check:coverage-modules`: OK, 11 modules at 0%, the baseline.
  - Changed-line coverage of `undo-boundaries.ts`: all 87 changed lines and their branches covered. `esbuild-shared.mjs` is outside the coverage include; the patch is covered by `vditor-source-patches.test.ts`.
  - `typecheck` passes. `typecheck:strict` shows its 15 baseline findings, none in changed files. `typecheck:vscode-e2e` shows only the known `preview-task-checkbox:122`.
  - `lint:ci` and `depcruise` are clean. `knip` reports its 10 baseline findings.
  - `jscpd` is at 6.47%. The new spec has three small clones: one with `section-fold.spec.ts`, one with `undo-restore-caret.spec.ts` (test setup), and one within itself.
- **Not run:** the remaining specs that wait for the first snapshot in real VS Code (`undo-dirty-probe`, `toolbar-overflow`, `github-color-literals`, `auto-wrap`, `selection-bubble`). They were outside the S4 regression set.

**Close-out (2026-10-07, HEAD `804b6f3b`, Claude Opus 5.5).** Authority: handoff §2.3 leg 6 and §3, ruling Q3.

- **Remaining specs that wait for the first snapshot** (real VS Code 1.129.0, build of `804b6f3b`, `VMDE_XTEST=1`, Xvfb + Openbox without key bindings, `--workers=1 --retries=0`, one invocation): 14 of 18 passed.

  | Spec | Result | Classification |
  | --- | --- | --- |
  | `undo-dirty-probe` | 1/1 passed | — |
  | `github-color-literals` (XTEST) | 1/1 passed | — |
  | `selection-bubble` | 4/4 passed | — |
  | `toolbar-overflow` | 8/11 passed; `:8`, `:195`, `:590` failed | known pre-existing (queue list) |
  | `auto-wrap` | 0/1; `:31` failed at `:637` | pre-existing: identical on the pre-598 build |

  - `auto-wrap:31` is not on the known list. After the typed `z` and its wrap, the first `inner.undo.undo` in IR returned the host to the original text instead of the typed text (`gammaz` missing). Its test waits for the first snapshot before typing, so the seed should not act there (inferred). With `media-src/esbuild-shared.mjs` and `media-src/src/editing/undo-boundaries.ts` swapped from `923f0fbe` (rebuilt; `vmdeSeedBaseline` absent from `media/dist/main.js`), it failed identically at `:637` with the same diff. Both files were restored (`cmp` against `HEAD` identical) and rebuilt. Task 196 recorded an `auto-wrap` failure that was identical on its baseline too.
  - Not run: `lockstep-undo-spike`, a historical spike that is opt-in (handoff §3).
- **Q3 disposition.** The detector leg reproduced in a cold window for the fourth time (seed at `0/0`, no SVG at the seed; after Undo the source, clean host, caret and next key are correct, but the preview keeps `data-render="1"` with an empty `.language-mermaid` and no SVG within 20 s). Per ruling Q3 the re-render moved to [Task 623](../623-cold-mermaid-undo-rerender.md), filed with the sanitized evidence. No renderer or Task 597 code was changed.
  - `test/vscode-e2e/undo-first-edit.spec.ts`: the leg marks the test `test.fail` with a Task 623 reason only for that exact outcome. A missed cold window or any other failure still fails the test. A drawn diagram fails it with "Task 623 looks fixed", so the fix is noticed and the marker removed. The spec is skipped without `VMDE_XTEST=1`. Verified: `undo-first-edit.spec.ts -g "cold Mermaid"` reported 1 passed as an expected failure (exit 0), with the detector record above. `typecheck:vscode-e2e` shows only the known `preview-task-checkbox:122`; `biome ci` on the spec is clean.
- **Drop limitation.** In real VS Code the drop is seeded, but VS Code's webview host frame cancels every drop, so no drop edit reaches the editor; this predates Task 598 (S4). The drop edit is verified only in the Chromium harness.
- **Residuals:** IME as the first edit stays uncovered (ruling Q2). The Task 617 whole-document Delete path is unchanged and owned by Task 617.

## Acceptance

- [x] The first edit, in any mode and by typing, a format command, paste or drop, is undone exactly, and the host becomes clean. A second Undo does nothing, and Redo restores the edit. (Real VS Code: typing in three modes, Ctrl+B and the Bold command, paste, clipboard Cut, mode switches. A drop is seeded in real VS Code, but VS Code's webview host cancels every drop, which predates this task; the drop edit is verified in Chromium.)
- [ ] A cold diagram document passes the first-edit Undo leg. **Not satisfied; moved to [Task 623](../623-cold-mermaid-undo-rerender.md) under ruling Q3.** The source, clean host, caret and next key pass; the diagram is not re-rendered. The detector leg stays in the spec as an expected failure.
- [x] Every existing undo spec passes. The patch drift guards are in place. (The drift guards, the S4 regression set, `undo-dirty-probe`, `github-color-literals` and `selection-bubble` pass. `toolbar-overflow` `:8`/`:195`/`:590` are known pre-existing failures, and `auto-wrap:31` fails identically on the pre-598 build; see Close-out.)
