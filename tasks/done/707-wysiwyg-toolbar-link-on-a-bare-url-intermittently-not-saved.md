# Task 707 — WYSIWYG toolbar Link on a bare URL is intermittently not saved

**Status:** ✅ done (2026-11-08).
**Origin:** Split from [Task 699](699-caret-focus-and-edit-surface-state-wrong-after-editing-commands.md) at its closure: after five fixes, `test/vscode-e2e/link-button-url.spec.ts:148` (WYSIWYG) still fails 1 of 6 runs.
**Severity:** medium (estimated). A Link action the user sees in the editor can be missing from the saved file.
**Tech stack:** `media-src/src/editing/undo-boundaries.ts` (boundary publish, `mustPublishBoundary`), `media-src/src/links/link-url.ts` (explicit-edit mark), `media-src/src/bridge/edit-sync.ts` (`flushEdit`, `takeExplicitBlock`), Vditor toolbar Link in WYSIWYG.
**Depends on:** none.

## Problem

Task 699 fixed the immediate flush that dropped the explicit block, and the boundary that judged `[url](url)` equal to the bare URL on disk. In the Task 699 Part 2d run the WYSIWYG case passed 5 of 6; the failing run timed out on the 20 s poll with the host text unchanged. No boundary trace was taken, so it is not known whether the link was never made in the DOM, the explicit mark was missing or expired, or the publish was skipped. Before Task 699 the case also failed about 15 percent of runs at the parent of `3d9855e7`.

## Proposed work

1. Run the Task 699 probe P2b (selection writers, explicit mark, `options.input`, posted edits, undo entries) with the boundary decision (`mustPublishBoundary` inputs and result) added, until at least two failing runs are captured.
2. Attribute each failing run to one cause.
3. Fix with a failing test first.

## Acceptance

- [x] Each captured failing run has a measured cause. (Part 1: 3 of 3 range start moved to the end of `See `.)
- [x] Each product cause is fixed with a test that fails before and passes after. (Part 2 RED to GREEN above.)
- [x] `link-button-url.spec.ts` passes 10 of 10 runs in WYSIWYG and IR with no retry. (12 of 12 each.)

## Tests to write

- A Vitest case per cause; `link-button-url.spec.ts` is the acceptance test.

## Part 1 results (2026-11-08)

Measurement only; no product change. Built at `df863198` (`node build.mjs` exit 0). Probe spec `zz-tmp707-link-probe.spec.ts` (the `:148` steps with a boundary trace and the same 20 s host poll), copied in for each run and removed after it. Logs and scripts: `tmp/707/` (untracked).

### Runs

| Call | Runs | Failed | Log |
|---|---|---|---|
| 1 | 12 | 2 (repeat 2, repeat 4) | `tmp/707/probe-run1.log` |
| 2 (adds a `surroundContents` wrapper, a window `error` listener, paragraph HTML and selection nodes) | 12 | 1 (repeat 6) | `tmp/707/probe-run2.log` |

Failure rate 3 of 24 (12.5 percent). Every failure timed out on the 20 s poll with the host text unchanged, the same symptom as Task 699 Part 2d.

### Attribution: (a) the link is never made in the DOM, 3 of 3

Mechanism (run 2 repeat 6, times relative to the click):
- In WYSIWYG the URL is decorated as `See <span class="vmde-bare-url" …>https://example.com/a-paper</span> for details.` (Task 655).
- `selectText` selects the span's text node, offsets 0 to 27.
- At +2.4 ms a late Vditor after-render undo snapshot runs (`addToUndoStack`, caller `run`, the Task 601 record helper). It restores the non-collapsed selection through its block-relative offset path (`vmdeCaretSelectionOffsets`, then `resolveBlockOffset`). Offset 4 in the paragraph resolves to the end of the `See ` text node, not the start of the span's text. Before: anchor `#text"https://exam"<SPAN` 0, focus the same node 27. After: anchor `#text"See "<P` 4, focus `#text"https://exam"<SPAN` 27. The selected text is unchanged.
- At +19.8 ms the patched Link branch sets the explicit-edit mark (`range.toString()` is still the URL). At +20.3 ms `range.surroundContents(node)` throws `InvalidStateError: Failed to execute 'surroundContents' on 'Range': The Range has partially selected a non-Text node.` A window `error` event follows. No `<a>` is made.
- At the boundary timer `getValue()` has no link. `mustPublishBoundary` stops at `markdown !== explicitBefore` (no mark read is logged), so no `input` and no `edit` post. That decision is correct for an unchanged source.
- The mark stays set and unread (age 11 ms at the timer) until its 5 s TTL runs out.

Runs 1 repeat 2 and repeat 4 show the same trace without the exception wrapper. A snapshot runs just before the click (at −27.9 and +8.9 ms). At the click the anchor is `See ` offset 4. The mark is set, there is no `<a>` after Vditor's handler, the timer `getValue()` has no link, and there is no mark read, `input` or `edit` post.

Split across the 24 runs: the 3 failures each had a snapshot between the selection write and the click, with the anchor moved to `See ` 4. All 21 passes had no snapshot in that window and the anchor at the span text 0. Causes (b) mark missing or expired and (c) boundary publish skipped: not seen (0 of 24). In all 21 passes the order was mark set, `surroundContents` ok, a link in the DOM, a fresh mark read, `input`, a mark read and clear, and one `edit` with `explicitBlock`.

Not a test-only race: a user drag selection that starts at the end of `See ` gives the same range, and so does any snapshot restore after the user selects the decorated URL.

### Fix contract (proposed; the orchestrator decides)

1. **Link branch range tightening (the cause fix).**
   - `media-src/src/links/link-url.ts`: in `installSelectedUrl` (line 52), add `__vmdeTightenLinkRange(range)` beside `__vmdeSelectedUrl`.
   - Rule: when the range start is at the end of a Text node, move it to offset 0 of the next non-empty Text node inside `range.commonAncestorContainer`. When the range end is at offset 0 of a Text node, move it to the end of the previous non-empty Text node inside that container. Move nothing when a boundary is mid-text, the range is collapsed, or there is no such Text node. `range.toString()` does not change.
   - `media-src/esbuild-shared.mjs:1898-1911` (`patchWysiwygLinkSelectedUrl`): call `(window as any).__vmdeTightenLinkRange?.(range);` first in the replacement, before `vmdeHref`. Vditor's `wysiwyg/toolbarEvent.ts:225-229` then runs `surroundContents` on a range inside the span text, which is the passing shape.
   - Optional, same patch, recommended: set the explicit-edit mark only after `range.surroundContents(node)` returns, so a throw leaves no mark that can attach `explicitBlock` to a later edit within 5 s. This needs the anchor extended to the `surroundContents` line.
2. **RED Vitest cases.**
   - `media-src/src/links/link-url.test.ts`: build `<p>See <span class="vmde-bare-url">https://example.com/a-paper</span> for details.</p>` with the range (`See `, 4) to (span text, 27). Call the installed `__vmdeTightenLinkRange(range)`. Expect `range.startContainer` to be the span text at offset 0, and `range.surroundContents(document.createElement('a'))` not to throw. Before the fix the helper is undefined, and `surroundContents` on the raw range throws `InvalidStateError`. Controls: a mid-text range and a same-node range are left unchanged.
   - `test/backend/vditor-source-patches.test.ts` (block at line 3557): the patched `wysiwyg/toolbarEvent.ts` calls `__vmdeTightenLinkRange?.(range)` before `range.surroundContents(node)`. If the optional ordering is applied, also assert that `__vmdeExplicitEdit?.()` comes after it.
   - Acceptance: `link-button-url.spec.ts --repeat-each=10` in WYSIWYG and IR, no retry.
3. **Hot-path allocation policy.** The helper runs only in the toolbar Link branch with a non-empty range, which is the explicit-edit path. It reads boundary offsets. It creates one TreeWalker only when a boundary sits at a Text edge. Nothing runs on typing, undo, snapshot or selection paths.

### Owner choice

- Q1. Where to fix the endpoint loss:
  - (A, recommended) Tighten only in the Link branch (contract above). It is local and deterministic, and it also covers a user's drag selection.
  - (B) Also make the undo snapshot's non-collapsed selection restore keep the original side of an element boundary (`vmdeCaretSelectionEndpoint`/`resolveBlockOffset`, `esbuild-shared.mjs:325-338`, `caret.ts:283-311`), for example with a forward affinity for a range start. This is wider: every snapshot restore in three modes, with the Task 553, 609 and 708 rules. It does not fix the user drag case alone.
  - (A+B) Both. (B) would go to a separate task.

## Decision Q1 (provisional, orchestrator on the Owner's behalf, 2026-11-08)

Option (A): fix in the Link branch only, per the Part 1 fix contract (`__vmdeTightenLinkRange` in `media-src/src/links/link-url.ts`, called first in the `patchWysiwygLinkSelectedUrl` replacement). Also take the recommended ordering change: set the explicit-edit mark only after `surroundContents` returns, so a throw leaves no stale mark. Option (B), the snapshot selection restore keeping the original side of an element boundary, is not in this task; it is recorded as a follow-up.

## Part 2 results (2026-11-08)

Decision Q1 option (A) plus mark ordering.

### Change
- `media-src/src/links/link-url.ts`: exported `tightenLinkRange(range)`, installed as `window.__vmdeTightenLinkRange` by `installSelectedUrl`. It moves a start at a Text end to the next non-empty Text start, and an end at a Text start to the previous non-empty Text end, within the range. `toString()` is unchanged. One TreeWalker, created only when a boundary sits at a Text edge.
- `media-src/esbuild-shared.mjs` `patchWysiwygLinkSelectedUrl`: calls `__vmdeTightenLinkRange?.(range)` first; sets the explicit-edit mark after `range.surroundContents(node)` (new second anchor, throws on drift).
- Tests: `link-url.test.ts` (6 cases: start tighten with `surroundContents` not throwing, end tighten, mid-text, same-node and collapsed controls, bridge install), `vditor-source-patches.test.ts` (tighten before `surroundContents`, mark after).

### RED to GREEN
- RED before the fix: 5 failed in `link-url.test.ts` (helper undefined) and 1 failed in `vditor-source-patches.test.ts` (6 of 377).
- GREEN after: `link-url.test.ts` 28 passed; both files 377 passed.

### Real VS Code (one wrapper call, `--repeat-each=12 --workers=1 --retries=0`, Openbox with the tracked empty config)
- `link-button-url.spec.ts` IR: 12 of 12. WYSIWYG: 12 of 12.
- Probe `zz-tmp707-link-probe.spec.ts` (WYSIWYG): 10 of 12. Copy and its test-results removed afterwards.
- The 2 probe failures are a different cause (d), not the Part 1 cause: `selectionchange` shows the selection set on the URL (27 chars), then collapsed to the start of the H1 `Links` about 3 ms later, before the click. The Link branch then sees an empty range (ZWSP anchor path), no link, host text unchanged. No `InvalidStateError`. Traces: `tmp/707/p2-real.log`. Not seen in the 24 Part 1 runs. It is not tied to the range tightening. Needs its own attribution (possible probe/XTEST selection race or a product selection reset); not fixed here.

### Gates
- `npm run lint:ci` exit 0; `npm run typecheck` exit 0; `node build.mjs` exit 0.
- `npm run quality`: first run knip failed on the unused `tightenLinkRange` export (the test now imports it); after that knip reports only the existing tag hint. Other stages PASS (brand, lint:ci, jscpd, depcruise, audit, test:coverage 8784 passed, coverage ratchet 9 of 9). Full `quality` not rerun end to end after the knip fix; knip, `biome ci`, typecheck and the focused Vitest were rerun.

### Acceptance
All three acceptance boxes above are ticked. Open: probe cause (d), 2 of 12.

## Closure (2026-11-08)

Cause (a) in all 3 captured failing runs: a late Undo snapshot moved the selection start to the end of the Text node before the bare-URL span, so `surroundContents` threw and no link was made. The toolbar Link branch now tightens the range at Text edges first (`tightenLinkRange`, `media-src/src/links/link-url.ts`, through `window.__vmdeTightenLinkRange`), and the explicit-edit mark is set only after `surroundContents` returns.

- Vitest: RED 6 of 377 before the fix, GREEN 377 of 377 after (`link-url.test.ts`, `vditor-source-patches.test.ts`).
- Real VS Code: `link-button-url.spec.ts` IR 12 of 12 and WYSIWYG 12 of 12 (`--repeat-each=12`, no retry).
- `npm run quality` on the final tree: all 8 stages pass.
- Follow-up recorded, not in scope: the probe copy failed 2 of 12 with a different shape (the selection collapses to the start of the H1 about 3 ms after the probe sets it, before the click; no exception). The real spec passed 24 of 24, and the cause is not attributed. The Undo snapshot restore losing the element-boundary side (option B) also stays a follow-up.
