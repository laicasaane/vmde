# Task 599 — Closing Find restores the editor selection

**Status:** ✅ DONE (2026-10-07) on `dev`.
**Origin:** found during the Task 596 investigation (2026-09-28). The `close()` code dates from Task 196 and did not change in Task 579.
**Recommended implementer effort:** high.
**Tech stack:** TypeScript webview (`media-src/src/editing/selection-scope.ts`), caret authority (`__vmdeRequestCaret`), Vitest, Chromium, real VS Code with XTEST.
**Dependencies:**

- **Task 579** owns the Find/Replace widget and promises VS Code parity for Escape.
- **Task 600** fixes the caret position outside every block that this defect exposes. It is needed independently: Ctrl+Home reproduces the corruption without Find.
- **Task 596** covers the stale toolbar classes after a close via the widget's button.
- **Task 597** covers the undo snapshots that Find records while the widget has focus.

**Evidence:** `tmp/task596-603-evidence/t599/` (`results.json`, `results2.json`) and `tmp/task596-603-evidence/pre579-probe/` in the main checkout. Real VS Code 1.129.0, `VMDE_XTEST=1`, Task 579 build.

## Problem

All cases use the document `# Probe\n\nAlpha bravo charlie delta.\n\nEcho \`foxtrot\` golf hotel.\n`. Each case opens Find, searches for `bravo`, optionally navigates, and then closes Find. After every close route, the editor has focus but the caret is at the start of the document. The match and the caret from before Find opened are both lost.

| Close route | Selection after close | Ctrl+B | Typing `Q` |
| --- | --- | --- | --- |
| Enter, then Escape (also Shift+Escape; no Enter; F3; Ctrl+H + Enter) | `PRE.vditor-reset@0` | `****\n\n# Probe…` (**new paragraph at the top**) | `**Q**\n\n# Probe…` |
| Enter, then the widget's close button | `PRE@0`; toolbar still shows the inline-code context (D/D/C) | no-op | `# QProbe…` |
| Paragraph-first document | `P "Alpha "@0`, the document start, not the match | `****Alpha bravo…` | `**Q**Alpha…` |

Measured cause:

1. `move()` (`selection-scope.ts:1207-1224`) selects the match in the editor (`:1215`). It then gives focus back to the Find input (`:1222`), and Chromium moves the document selection into that input. Vditor's blur handler saved `ir.range` = "bravo", but `getEditorRange` prefers the live selection, so the saved range is never used.
2. `close()` (`:1297-1304`) only calls `focus()` on the editor. The editor has no selection, so Chromium places the caret at the first text, the heading marker `"# "@0`. Then `normalizeMarkerNavigationCaret` moves it to `PRE@0`; see Task 600.

Task 579's spec does not cover the caret position. It asserts only that the widget is hidden and the editor has focus (`test/vscode-e2e/find-replace.spec.ts:295-297, 326-328, 356-358, 385-395`). Its formatting loop re-selects the word before every key (`:411-428`), which hides this defect.

## Design

All changes are in `media-src/src/editing/selection-scope.ts`, in `installFindReplace`.

1. **`open()` from the closed state.** Before `invalidateCaret()` and before focusing the input, save the editor selection if it is inside the editor. Save a cloned Range, plus a text-offset fallback from `caretTextOffset`.
2. **`move()` and Replace.** Mark the widget as navigated when `move()` selects a match. After a Replace, the current match is the next one.
3. **`close()`, before `result = null`.** Compute the target, in this order:
   1. if navigated, the current match remapped through `liveMapper()?.range(result.matches[current])`;
   2. otherwise the saved open-time Range, if it is still connected;
   3. otherwise the text-offset fallback.

   Hide the widget, then write the target with `requestCaret({anchor, focus})`. That call focuses the editor and prevents the marker normalizer from moving the caret. Do **not** call `focus()` first: that triggers Chromium's placement at the document start.
4. **Toolbar refresh after close.** Either schedule Vditor's highlight after the close, or rely on Task 596's gate. Decision 3 chooses.

## Owner decisions (2026-09-28, settled)

1. Keep this a **separate task**; Task 579 is closed.
2. Closing **after navigation** (or a replacement) selects the current mapped match. Closing after only typing a query **restores the selection or caret from before Find opened**. This deliberately departs from VS Code's find-as-you-type behaviour.
3. Closing **refreshes the toolbar** through Vditor's own delayed highlight after the selection is restored; this task does not depend on Task 596. Undo snapshots stay with Task 597, toolbar command gating with Task 596, and the remaining root-caret cases with Task 608.

## Tests

- **Vitest** (`find-widget.test.ts`, jsdom, IR editor stub):
  - navigate, then close through the action and through Escape: the selection is the match, anchored in the P, and the editor has focus;
  - close without navigating: the saved caret returns;
  - after `replace-one`: the current match is selected, connected, and not at the root;
  - the saved DOM was re-rendered: the text-offset fallback is used.
- **Chromium** (`media-src/e2e/find-replace.spec.ts`): heading-first fixture. Caret in the inline code, open, search `bravo`, Enter, Escape. `getSelection().toString() === 'bravo'` with the anchor in the "Alpha" P. A toolbar Bold click then renders `Alpha **bravo** charlie`.
- **Real VS Code** (XTEST; extend `test/vscode-e2e/find-replace.spec.ts` or add a new focused spec):
  - For close routes {Escape, Shift+Escape, close button} × prior actions {Enter, F3, Ctrl+H + Enter}:
    - the selection is the non-collapsed `bravo`;
    - Ctrl+B makes the host exactly `# Probe\n\nAlpha **bravo** charlie delta.\n\nEcho \`foxtrot\` golf hotel.\n`;
    - typing `Q` gives the exact host that was measured on the fixed build.
  - Close without navigating from the inline-code caret: the caret returns to `foxtrot@3`, and Ctrl+B leaves the host byte-identical.
  - Add one Ctrl+B with **no** re-select right after Escape to the existing Task 579 formatting loop.

## Acceptance

- [x] Every close route leaves the selection on the match, or on the caret from before Find opened (per decision 2), inside a block. No close route leaves it at the document start.
- [x] Ctrl+B and typing right after close act at that selection, with exact host text.
- [x] Task 579's spec asserts the selection position after close.

## Execution progress

Resumed 2026-10-07 on `dev` at `9273b5fc` (post-580). The earlier implementer's uncommitted work was
reviewed against the [native handoff](../../tmp/queue-part1/599-native-handoff.md) slices 1–4 and the
Task 580 command routes; its earlier verification claims were not reused.

**Implementation** (`media-src/src/editing/selection-scope.ts`, `installFindReplace` only):
`open()` from hidden captures the editor selection (cloned Range, direction, text offsets) before
the refresh, caret retirement and input focus, and keeps it across Ctrl+F/Ctrl+H switches. `move()`
and Replace One/All mark the opening navigated; a replacement also records its caret and frame.
`close()` (input Escape, Shift+Escape, close button, and the `vmde.closeFindWidget` command all run
it) resolves the target before clearing `result`: the current match re-run against the current
source, else the replacement caret, else the opening Range, else its text-offset fallback. Every
endpoint must be inside the editor and, outside SV, inside a block. It cancels the replacement
caret frame, discards a pending chord selection snapshot (`discardCommandSelection`), hides the
widget, writes the caret through `requestCaret`, focuses the editor afterwards and re-asserts if
focus moved it, then runs Vditor's `highlightToolbar`. A deferred replacement refresh no longer
repopulates a closed widget.

**Review fixes in this session:** added a real-VS-Code `vmde.closeFindWidget` command leg followed by
a chord-less `vmde.format.bold`, and a Chromium SV close-button leg (selection restored, SV toolbar
classes unchanged). No product-code change was needed.

**RED** (HEAD `selection-scope.ts` swapped in, rebuilt, then restored; `cmp` identical, rebuilt):

| Layer | Result on HEAD product code |
| --- | --- |
| Vitest `find-widget.test.ts` | 11 of 13 new tests fail (four navigated close routes, no-navigation caret, backward selection across Ctrl+H, text-offset fallback, toolbar refresh, chord snapshot discard, Replace One then close, replacement frame after close). The zero-match guard and Replace All caret tests pass on HEAD. |
| Chromium `find-replace.spec.ts -g "Task 599"` | 4/4 fail: Escape and close-button legs (`token`/`proseBlock` false), no-navigation caret, SV close. |
| Real VS Code XTEST | Task 579 test fails at the new Ctrl+B-after-Escape step; the Task 599 matrix fails on its first leg (Enter / Escape), selection not on the match. |

**GREEN** (after `node build.mjs`):

| Gate | Result |
| --- | --- |
| `npm run typecheck` | pass |
| `npm run typecheck:strict` | 15 errors, identical (modulo line numbers) to HEAD with the same file swap; none in changed lines |
| `npm run typecheck:vscode-e2e` | 1 error in untouched `preview-task-checkbox.spec.ts` (pre-existing) |
| Focused Vitest (find-widget, selection-scope, format-hotkey-guard/-selection, find-*, module-boundaries) | 9 files pass |
| `npm run lint:ci`, `npm run jscpd` | pass |
| Chromium `find-replace`, `find-replace-large`, `structural-selection`, `blockless-caret`, `toolbar-selection` `--retries=0` | 51/51 pass |
| Real VS Code XTEST `find-replace.spec.ts` `--workers=1 --retries=0` | 3/3 pass (Task 599 matrix 3 priors × 3 close routes × {Ctrl+B, typing Q} plus command route and no-navigation leg) |
| Real VS Code XTEST `find-replace-large`, `blockless-caret`, `format-hotkeys`, `shortcut-identity` | 18/18 pass |

Changed-line coverage of `selection-scope.ts` (Vitest): uncovered changed statements are only the
`applyFindReplaceResult` failure returns (790, 813, 832; previously `return false`, already
uncovered) and the defensive `!opening` guard; uncovered branches are the backward text-offset
fallback, a null selection at open and a missing editor at close.

Not run: aggregate `npm run quality` (queue policy excludes audits) and the full real-VS-Code tier.
