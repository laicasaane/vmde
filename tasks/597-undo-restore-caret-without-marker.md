# Task 597 — Undo/Redo keep the caret in the editor when a snapshot has no usable caret marker

**Status:** planned (2026-09-28). The Project Owner approved the finding. Implementation has not started; the decisions below are open.
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

## Acceptance

- [ ] After any Undo/Redo in IR, WYSIWYG or SV, the selection is inside an editable block, the next key lands at the expected place, and the toolbar matches the caret.
- [ ] Every measured sequence in the table passes with exact host text. The real-VS-Code spec fails before the fix.
- [ ] Patch drift guards and bridge coverage are in place. The zero-coverage ratchet passes.
