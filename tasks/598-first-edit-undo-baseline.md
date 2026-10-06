# Task 598 — The first edit after opening a document can be undone

**Status:** in progress. S1–S3 (handoff steps 1–3, and step 4 at the source-contract, Vitest and Chromium layers) were implemented on 2026-10-07. The real-VS-Code spec `undo-first-edit.spec.ts` is the next step. The Owner decisions below were settled by the rulings (`tmp/queue-part1/596-603-rulings.md` §598).
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
- **Open:**
  - Handoff step 4's real-VS-Code `undo-first-edit.spec.ts` (§2.3), including the cold-Mermaid detector, toolbar/command Undo, mode switches, save/reopen and the OS-key legs.
  - The remaining existing specs that wait for the first snapshot (`undo-dirty-probe`, `toolbar-overflow`, `github-color-literals`, `auto-wrap`, `selection-bubble` in real VS Code).
  - `test:coverage` and `check:coverage-modules`.

## Acceptance

- [ ] The first edit, in any mode and by typing, a format command, paste or drop, is undone exactly, and the host becomes clean. A second Undo does nothing, and Redo restores the edit.
- [ ] A cold diagram document passes the first-edit Undo leg.
- [ ] Every existing undo spec passes. The patch drift guards are in place.
