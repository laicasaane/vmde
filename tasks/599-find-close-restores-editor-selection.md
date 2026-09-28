# Task 599 — Closing Find restores the editor selection

**Status:** planned (2026-09-28). The Project Owner approved the finding. Implementation has not started. Decision 1 below may move this work into Task 579.
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

## Owner decisions needed

1. Fold this into **Task 579** as an acceptance gap in "Escape returns focus to the editor" (recommended), or keep it as a separate task?
2. When the user closes without navigating (only typed in the input), restore the caret from before Find opened (recommended), or select the current match? The inferred VS Code behaviour is to select the current match, with find-as-you-type moving the editor selection.
3. Refresh the toolbar at close, or depend on Task 596?

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

- [ ] Every close route leaves the selection on the match, or on the caret from before Find opened (per decision 2), inside a block. No close route leaves it at the document start.
- [ ] Ctrl+B and typing right after close act at that selection, with exact host text.
- [ ] Task 579's spec asserts the selection position after close.
