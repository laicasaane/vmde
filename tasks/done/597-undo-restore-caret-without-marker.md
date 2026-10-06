# Task 597 — Undo/Redo keep the caret in the editor when a snapshot has no usable caret marker

**Status:** ✅ DONE (2026-10-07) on `dev`.
**Origin:** Task 579 real-VS-Code acceptance, 2026-09-28. The defect predates Task 579.
**Recommended implementer effort:** xhigh. The work is a build-time Vditor patch that every editing path relies on.
**Tech stack:** a build-time Vditor source patch (`media-src/esbuild-shared.mjs`), a webview bridge module, Vitest, Chromium, and real VS Code with XTEST.
**Dependencies:**

- Run after **Task 579**.
- **Task 598** patches the same file (`vditor/src/ts/undo/index.ts`) at different anchors. Land this task first: its restore fallback also covers Task 598's diagram-render risk.
- Keep Tasks 445/487/553 (`patchUndoCaretSplitRestore`) unchanged.
- **Task 599** (Find close selection) and this task each remove one of the two ways the Find route causes this defect.

**Evidence:** `tmp/task596-603-evidence/t597/` in the main checkout. Real VS Code 1.129.0, `VMDE_XTEST=1`, Task 579 build. The fix emulation is in `fix-emulation.ts`, with results in `results-fix-change-first.json`.

## Problem

Vditor's `addCaret` (`undo/index.ts:229-236`) writes a `<wbr>` caret marker into a snapshot only when the live range starts inside the editor. There is a second case: a range that an `innerHTML` rebuild just collapsed to `(root, 0)` counts as inside, so it produces a `<wbr>` at the root level.

On restore, `Undo.renderDiff` handles these snapshots as follows:

- **No `<wbr>`** (`undo/index.ts:168-172`): it calls `range.setEndBefore(root)`, which puts the selection outside the editable host.
- **Root-level `<wbr>`**: `setRangeByWbr` gives `(root, 0)`.

In both cases, `highlightToolbarIR.ts:13` / `highlightToolbarWYSIWYG.ts:46` return early (`selectIsEditor`), so toolbar classes stay stale. Neither branch scrolls.

Measured (small fixture; a large fixture gave the same result):

| Sequence | Mode | Selection after Undo/Redo | Next typed key |
| --- | --- | --- | --- |
| Ctrl+H, find `bravo`, replace `BRAVO`, Enter (Replace One), Escape, Ctrl+Z | IR | `DIV.vditor-ir@0` | **dropped**; host byte-identical |
| same | WYSIWYG | `DIV.vditor-wysiwyg@0` | dropped |
| same | SV | `DIV.vditor-content@1` | dropped |
| same, then Ctrl+Y | IR/WYSIWYG/SV | outside the host | dropped |
| Type `X`, Ctrl+F within the 800 ms `undoDelay`, Escape, type `Y`, Ctrl+Z | IR | `DIV.vditor-ir@0` | dropped |
| Replace One by keybinding (Ctrl+Shift+1) while the editor has focus, Undo, Redo | IR | `PRE.vditor-reset@0` (root-level `<wbr>`) | an empty `<p>` is inserted above the H1; keys dropped |
| External WorkspaceEdit, type `Y`, Ctrl+Z twice | IR | `PRE@0` after a caret-only step | dropped |

A marker-less restore also sets `lastText` without a marker. Every later edit is diffed against that text, so undoing any later edit lands in the same state. This matches the Task 579 trace, where Replace→Undo and then Ctrl+G→Undo both reach the branch.

Paths that record a snapshot without a usable caret:

- **Measured:**
  - Find apply (`selection-scope.ts:681`, `:690`).
  - Vditor's debounced snapshot while focus is in another input (`ir/process.ts:76`, `wysiwyg/afterRenderEvent.ts:40`, `sv/process.ts:136-140`).
  - A host `update` (`message-router.ts:229` → `setValue` → `clearStack`).
- **Inferred:**
  - `table-actions.ts:234/237`
  - `named-anchor-insertion.ts:251/262`
  - `inline-picture.ts:526/528`
  - `link-popover.ts:870/588`
  - `block-action-client.ts:206/208`
  - Outline section moves (`boot/main.ts:261/265`, `:352/354`)
  - the preview checkbox (`message-router.ts:226/231`)
  - `details-toggle.ts:125`
  - the `section-hoist.ts:242` base snapshot
  - paste boundaries in popover inputs (`undo-boundaries.ts:148`)

## Design: one restore-time fallback

`renderDiff` is shared by Undo and Redo in every mode, so one patch covers every writer, including stacks already in memory.

1. Add a new transform, `patchUndoRestoreCaretFallback`, in `media-src/esbuild-shared.mjs`, chained at the `undo/index.ts` registry (`:2704-2709`). Each anchor appears exactly once, and a missing anchor throws:
   - **R1** (before `lastText = text; element.innerHTML = text;`, lines 149-150): capture `window.__vmdeUndoRestoreCaret?.capture(root, previousLastText, text)` before the old DOM and live selection are destroyed.
   - **R2** (line 168): replace the plain `querySelector("wbr")` test with `bridge.usableMarker(root)`. A marker is unusable when it sits at the root (and the root has element children) or inside a preview or `[contenteditable=false]` element. Such a marker is removed. Without the bridge, keep the original test.
   - **R3** (lines 170-172): run the upstream collapse only when `!(capture && bridge.restore(capture)) && getSelection().rangeCount > 0`. The guard also avoids a `getRangeAt(0)` throw that would skip `execAfterRender` (inferred).
2. Add a new bridge module, `media-src/src/editing/undo-restore-caret.ts`. Install it next to `installCaretWindowBridge()` in `boot/main.ts`, add `declare global`, and add it to the module manifest. It restores the caret in this order:
   1. **The change site.** Parse the previous and restored HTML into inert `<template>` elements, without `<wbr>` markers or previews. Find the first top-level block whose tag or `textContent` differs, and place the caret at `{blockPath, offsetInBlock}` of the first differing text. Compare text, not HTML: raw HTML differences such as `id` or `data-vmde-foldable` mislocated the site in emulation.
   2. **The pre-Undo caret:** the live focus endpoint, when it is inside a non-root block.
   3. **The document start.**
   4. **Upstream behaviour:** only when the bridge is absent.

   It places the caret through `__vmdeRequestCaret` (caret authority). The existing `highlightToolbar(vditor)` call runs 200 ms later and sees the restored caret.

Emulated in real VS Code, the fallback gave these results:

- Replace→Undo in IR, WYSIWYG and SV typed `Alpha Qbravo…` exactly.
- Redo typed `…QBRAVO…`.
- External change with a double Undo placed the caret at the pre-Undo `P@12`.
- On the large fixture, the caret went to the token, and the viewport scrolled to it.
- The toolbar refreshed within 600 ms.

Putting the pre-Undo caret first (the earlier draft's order) failed. After Escape that caret is at the document start, so IR and WYSIWYG typed `# QProbe`, SV corrupted the heading as `Q# Probe`, and the large fixture jumped to the top.

Optional hardening at capture time (owner decision 5):

- Find places the editor caret on the match before `:681` and at the end of the replacement before `:690`.
- The host update records its base snapshot after the caret is restored, which also removes the caret-only undo step.

## Owner decisions needed

1. **Restore order:** the change site first (recommended; measured), or the pre-Undo caret first?
2. **Caret shape:** a collapsed caret at the start of the change (upstream parity), or select the restored range as VS Code does?
3. **Scrolling:** reveal the change site when it is off-screen (recommended), or no scrolling (upstream `<wbr>` parity)?
4. **Keyboard-focused toolbar:** Undo from there moves focus to the editor, as the existing `<wbr>` path does. Is that acceptable?
5. **Capture-time hardening:** include it here (Find carets, host-update base snapshot)?
6. **Large fixture:** ordinary typing on `large-observable-models-synthetic.md` publishes Vditor's normalized serialization (about +7,339 characters; first difference at a table on line 3). Is this known and accepted? The answer decides how exact the large-fixture host assertions can be.
7. **Fixture:** may the real-VS-Code legs that do not use Find, such as the external-update leg, use a small inline document?

## Tests

- **Vitest**
  - `test/backend/vditor-source-patches.test.ts`:
    - R1, R2 and R3 each appear exactly once in the pre-patch source;
    - the capture comes before `lastText = text` and reads the pre-Undo `lastText`;
    - `addCaret` is untouched;
    - a missing anchor throws with its label;
    - patching the same output twice throws;
    - the registry output contains all chained patches.
  - `media-src/src/editing/undo-restore-caret.test.ts` (jsdom):
    - change-site cases: the probe's replacement at `[1]/6`, attribute noise, a caret-only change returning null, preview noise, a block removed, a tail removed, and an SV single block;
    - live-caret cases: outside, at root, nested LI, and backward;
    - `usableMarker` cases;
    - restore order with a stubbed request function.
- **Chromium**
  - Use a harness that installs both bridges.
  - In IR, WYSIWYG and SV, create a snapshot with no marker by focusing an external `<input>` past `undoDelay`, edit elsewhere, and undo. Assert the anchor is in a block and the next key gives the exact `__value()`.
  - Also cover a root-level marker, and bold being enabled again 250 ms after Undo from an inline-code context.
- **Real VS Code:** `test/vscode-e2e/undo-restore-caret.spec.ts`, run with `VMDE_XTEST=1` after `node build.mjs`, on a copy of the large fixture.
  - Replace One with Alt+C (case-sensitive): the token also appears in upper case at line 26.
  - After Escape and Ctrl+Z, assert the host exactly equals the fixture, the selection is in `[data-block]`, and the toolbar is refreshed.
  - Type `Q` and assert the exact splice.
  - Legs: Redo; WYSIWYG and SV Undo; Ctrl+Shift+1 then Undo then Redo; external update.
  - The typed key is dropped before the fix (measured).

## Execution progress

**S1–S3 (2026-10-07, HEAD `1adf323b`, Claude Opus 5.5).**

- **Anchors re-checked** against the installed Vditor 3.11.3 `undo/index.ts`: R1 (the `lastText`/`innerHTML` pair), R2 (the no-marker `querySelector("wbr")` test) and R3 (the three-line collapse) each occur exactly once. `patchUndoCaretSplitRestore` is unchanged; a test asserts that the prelude and `addCaret` are byte-identical with and without the new transform.
- **Behavioral RED on HEAD** (Chromium, source-patched harness `media-src/e2e/undo-restore-caret.spec.ts` before the fix): 13 of 14 cases failed for the intended reason. In IR, WYSIWYG and SV, Undo and Redo of a snapshot recorded while an external `<input>` held focus left the selection outside the editable blocks (`inBlock: false`), and the next key was dropped. The root-level marker and the preview marker cases did the same. Undo with no selection range threw `IndexSizeError: … getRangeAt … 0 is not a valid index`. The toolbar kept bold disabled after Undo out of inline code. Off-screen change sites were not revealed in either direction, and a mouse Undo on the toolbar did not reveal the site. The valid-marker compatibility case passed before and after.
- **Implemented:**
  - `patchUndoRestoreCaretFallback` in `media-src/esbuild-shared.mjs`, chained after `patchUndoCaretSplitRestore` in the `undo/index.ts` registry entry. Each anchor must occur exactly once, and a second application throws. A row was added to `docs/vditor-patch-checklist.md`.
  - The `media-src/src/editing/undo-restore-caret.ts` bridge: `capture`, `usableMarker` and `restore`. Restore order: change site (Undo at the start, Redo at the end), then the pre-Undo focus, then offset zero of the first editable block. It places the caret through `__vmdeRequestCaret`, and it reveals only a change site.
  - Wiring in `boot/main.ts` right after `installCaretWindowBridge()`, and a module manifest entry.
- **Toolbar scroll guard conflict, demonstrated:** a mouse Undo with the change site above the viewport. The reveal wrote `scrollTop` 74, and `guardToolbarScroll`'s synchronous click restore put back 1902 in the same task. The narrow fix is `markIntentionalHistoryReveal()` in `chrome/toolbar-scroll-guard.ts`. The bridge calls it only when it actually scrolls; a guard that sees it since its mousedown does not pin that click. Every other toolbar action keeps the pin (unit-tested).
- **Verification:**
  - Vitest (focused): the new bridge (52 cases, 100% lines), the guard (4 cases), source patches, module boundaries, harness registry, patch mutation, caret and finish-init all pass.
  - Chromium `--retries=0`: the new spec 14/14, plus the existing undo/caret/scroll/Find/IME specs, 72 passed in total.
  - Existing real-VS-Code undo specs as a regression check, with XTEST: 8/8 passed (`undo-redo-steps`, `undo-boundaries`, `list-enter-undo-caret`, `held-drag-undo-snapshot`, `structural-selection`).
- S4 was open at this point; see below.

**S4 (2026-10-07, HEAD `387c65d8`, Claude Opus 5.5).**

- **Real-VS-Code spec** `test/vscode-e2e/undo-restore-caret.spec.ts` (`VMDE_XTEST=1`, OS keys through XTEST). It has four tests:
  - IR on a copy of the large fixture, with six legs:
    - Replace One (Ctrl+H, Match Case, Enter, Escape), then Undo.
    - The same, then Undo and Redo.
    - Type X, press Ctrl+F before `undoDelay`, close Find, type Y, click the heading, Undo.
    - Ctrl+Shift+1 Replace One with the editor focused, then Undo and Redo.
    - Keyboard-focused toolbar Undo (Escape, Tab, arrows, Enter).
    - Mouse toolbar Undo with the change site above the viewport.
  - WYSIWYG: Replace One Undo, and Redo.
  - SV: Replace One Undo, and Redo.
  - A small inline document in IR: an external WorkspaceEdit, typing, two Undos; and a Command Palette Undo.

  Each leg asserts:
  - the exact host text after the Undo/Redo (the fixture, or the fixture with the one replacement);
  - a collapsed caret inside an editable block, at the change start for Undo or the change end for Redo, revealed in the viewport;
  - the toolbar state in IR/WYSIWYG, polled through Vditor's debounce;
  - the first OS key after it. The expected text is derived from `getValue()` captured just before the key, and the host must publish exactly that. SV drops Vditor's appended newline span and trailing ZWSP (`serializeSvForHost`).

  Every leg except the Palette leg also asserts that the bridge fallback ran (`restores > 0`).
- **Which reproductions still reach the unusable-marker path after Task 599** (measured through the bridge's `restore` count):
  - Replace One records its snapshots with focus in the Find input, so Undo and Redo both take the fallback in all three modes.
  - The Find checkpoint leg fires the X checkpoint while the Find input has focus. `lastText` has no `<wbr>`, so Undo of Y restores a snapshot with no marker. Task 599 restores the caret on close, so Y follows X.
  - In the Ctrl+Shift+1 leg, the Undo restored a usable marker (upstream path, no reveal). The Redo restored a root-level marker and took the fallback.
  - External update: the undo depth was 1 before typing, so there was no extra caret-only step on this build. The first Undo returns to the host update's base snapshot, which has no usable marker, and takes the fallback. The second Undo is a no-op.
- **Behavioral RED:**
  - On the pre-597 build (`media-src/esbuild-shared.mjs` from `1adf323b` and the S4 router change reverted, rebuilt), the spec failed 4/4. Each test failed at its first leg with `inBlock: false, atBefore/atAfter: false` (IR, WYSIWYG and SV Undo, and the external-update Undo).
  - The files were then restored and checked with `cmp`, and the build was redone.
- **Defects found in real VS Code on the S1–S3 build, fixed in S4:**
  1. **Command Palette Undo was pulled back to an older caret (the design question).**
     - Reproduced: type `XY` at `b|ravo`, press native F1 before `undoDelay`, then run "VMDE: Undo" about 0.4–0.5 s after the checkpoint. Undo restored the usable marker, but the checkpoint's still-live caret request re-asserted itself, and Q landed at `braQvo` instead of `bQravo`.
     - Fix: `invalidateCaret()` in the Undo/Redo branch of `bridge/message-router.ts`, before the engine call. The fallback arms a fresh request itself.
     - Unit RED→GREEN: `message-router.test.ts`, "drops a live caret request before undo/redo runs the undo engine" (it saw `{textOffset: 3}` live during the engine call before the fix).
  2. **The reveal missed on the large fixture.** The document is in the content-visibility band, so one scroll left the caret about 1,460 px below the view (scrollTop 0 → 8875, caret top 2247 against a view of 70–785).
     - Fix: `revealChangeSite` now re-measures on the task after each rendering update and corrects at most `REVEAL_STEPS` = 8 times. Find's reveal uses the same bound. It waits without scrolling while the caret's block is still skipped (`checkVisibility`) and keeps the same cancellation guards.
     - **Deliberate deviation from the handoff** (accepted by the orchestrator, 2026-10-07): the handoff allowed "one guarded animation-frame reveal". This correction is bounded, uses the same bound as Find, and the large fixture measurably needs it, but it runs over more than one frame.
  3. **SV Redo landed at the end of the document.** The pre-Replace snapshot held VMDE's empty EOF trailing paragraph (`p[data-vmde-trailing]`) and the post-Replace snapshot did not, so the single SV block was paired with that paragraph.
     - Fix: an empty trailing or gap paragraph is excluded from the change-site projection. A tagged paragraph that holds text still counts.
     - Unit RED→GREEN: "an empty trailing/gap paragraph in one snapshot only is not part of the change".
- **GREEN:**
  - Real VS Code: the new spec passed twice, 4/4 each time (2.7 m and 2.6 m). Timing:
    - fallback `restore` cost: up to about 37 ms in IR/WYSIWYG and 123 ms in SV on the large fixture;
    - toolbar state after the key: 19–55 ms beyond the polling start;
    - mouse reveal: scrollTop 22431 → 9547.
  - Vitest:
    - the bridge (59 cases) with 100% of its lines covered;
    - `message-router.test.ts` (146) and `toolbar-scroll-guard` pass;
    - S1–S4 changed lines: all covered in `undo-restore-caret.ts`, `message-router.ts` and `toolbar-scroll-guard.ts`. `boot/main.ts` is excluded from unit coverage, and the transform is covered by `vditor-source-patches.test.ts`.
  - `npm run test:coverage`: 330 files, 5867 passed plus 1 expected fail. `check:coverage-modules`: OK, 11 at baseline.
  - `typecheck` passes. `typecheck:vscode-e2e` shows only the known `preview-task-checkbox:122`. `typecheck:strict` shows its 15 baseline findings.
  - `lint:ci` and `depcruise` are clean. `knip` reports its baseline only. `jscpd` is at 6.53%, with one 6-line clone with `section-fold.spec.ts`.
- **Regression specs, real VS Code, XTEST, `--retries=0`, one invocation:** 14 of 15 passed:
  - `find-replace` 3/3;
  - `held-drag-undo-snapshot` 2/2;
  - `list-enter-undo-caret`, `undo-boundaries` and `undo-redo-steps`;
  - `shortcut-identity`: 6 of 7 passed.

  The failure is `shortcut-identity` "large fixture, wysiwyg", leg `wysiwyg:bold-undo-redo`. Its first Ctrl+B did not format (`ctrl+b formats`), and the host held the normalized serialization.
  - It is not on the known list. The test failed 5/5 on S4 builds, including with only the S4 bridge, with the helper-paragraph exclusion disabled, or without the new import. It passed 2/2 with `undo-restore-caret.ts` and `message-router.ts` at HEAD.
  - Instrumentation from the webview's first script showed no `capture` or `restore` call before the Ctrl+B. No S4 code runs before that step. With the extra page round trip the instrumentation adds before the key, the test passed.
  - The spec's own comment records that WYSIWYG's first Bold after the mode switch can do nothing (`shortcut-identity.spec.ts:736`).
  - **Classified as pre-existing (orchestrator ruling, confirming measurement).**
    - Measurement: a test-only wrapper around the Bold button's click dispatch, with no page round trip before the key. On every failing run, Bold carried the heading context's `vditor-menu--disabled` when the router's click arrived. The click returned `false` and the word stayed plain.
    - This is the Task 596 mechanism.
    - Why it was deterministic here: a keyup-time long-task probe showed about 0.8–0.9 s of main-thread work right after the selection's Shift keyup on the large WYSIWYG fixture. It is whole-document `getValue` serialization, called from Find's `snapshotPair` (`finish-init.ts`), the details-toggle target capture (`details-toggle.ts` `captureTarget`/`exactFallbackState`) and `main.ts` `snapshotMarkdown`. That work delays Vditor's 200 ms highlight timer until after the Ctrl+B.
    - The same probe with `undo-restore-caret.ts` and `message-router.ts` at HEAD failed the same way: same stale class, same ~0.9 s task. The earlier HEAD passes were timing luck.
    - The bridge was never called before the key (`capture`/`restore`/`usableMarker` all 0). This is not caused by Task 597.
  - The fixed 500 ms settle from `shortcut-remap.spec.ts` was tried first. It still failed in WYSIWYG (rerun 2/2: one setup error, one stale-Bold failure), because the long task outlasts it.
  - `formatLeg` in `shortcut-identity.spec.ts` now waits for the toolbar state itself: the target button is no longer `vditor-menu--disabled`. The comment names Task 596 and the serialization delay.
  - The keyup-time serialization of a large document is a separate performance issue (Task 578 class) for follow-up.
  - **Rerun of the full `shortcut-identity`, twice, XTEST, `--retries=0`, with the toolbar-state wait.** `wysiwyg:bold-undo-redo` passed in both runs. Neither run is fully green:
    - Run a: 6/7. In large WYSIWYG, the later `wysiwyg:former-keys` leg failed with "ctrl+Return: setup changed the document": the host took the WYSIWYG normalized serialization (181842 characters) before the key. That leg passed in run b and in the earlier regression batch.
    - Run b: 6/7. Large IR failed at VS Code startup ("Timed out waiting for VSCodeTestServer address"), which is an environment failure. Large WYSIWYG passed every leg.
    - Neither remaining failure is in Task 597's code path, but neither is on the known list. The orchestrator decides.
- **Chromium:** `undo-restore-caret.spec.ts` passed 14/14 on a second run (13/14 on the first). Repeated runs fail intermittently: the root-marker and preview-marker cases failed 3 of 32 runs with `--repeat-each=4`, both on this change and with `undo-restore-caret.ts` at HEAD (the same 3 of 32). The next key lands at the document start or end. This S1–S3 harness flake predates S4.

## Acceptance

- [x] After any Undo/Redo in IR, WYSIWYG or SV, the selection is inside an editable block, the next key lands at the expected place, and the toolbar matches the caret.
- [x] Every measured sequence in the table passes with exact host text. The real-VS-Code spec fails before the fix.
- [x] Patch drift guards and bridge coverage are in place. The zero-coverage ratchet passes.
