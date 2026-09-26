# Task 575 — Reliable native Turn Into QuickPick reopen after Escape

**Status:** open — approved by the Project Owner on 2026-09-26 as the follow-up to [Task 574](done/574-text-selection-performance.md).
**Goal:** Make the second `vmde.turnInto` after an Escape-dismissed Turn Into QuickPick open its picker every time, in the product and in `test/vscode-e2e/block-transform.spec.ts`.
**Tech stack:** TypeScript extension host (`src/`), webview message router, real-VS-Code Playwright.
**Dependencies:** Task 574 is closed. Its closure evidence identified this failure as pre-existing and outside that task's scope.

## Evidence

`test/vscode-e2e/block-transform.spec.ts` "native Turn Into QuickPick uses retained source target, one undo, and exact save" intermittently fails at its second `await expect(picker).toBeVisible()`. That is the first assertion after `picker.press('Escape')` → hidden → `executeCommand('vmde.turnInto')`. The QuickPick input exists (placeholder `Current: Paragraph`), but it stays hidden until the 20 s timeout.

- HEAD `963ce0ee` (before Task 574's fix): 1 of 5 runs failed.
- After `e0114c1a`/`e47124d3`: 1 of 3 clean runs failed, and 1 of 8 in a `--repeat-each=8` run.
- A temporary webview trace (removed) in `requestBlockTransformOptions` showed the second request **accepted** in the failing run, with every validity check true. The trace was identical to passing runs. The webview router posts `block-transform-options` whenever that function returns options. So the loss happens after the webview replies.

## Hypotheses for Part 1 (unconfirmed)

1. `EditorSession.onBlockTransformOptions` (`src/session/editor-session.ts`) returns silently when `!this.webviewPanel.active`. Panel active state is updated asynchronously through view-state events. Right after an Escape-dismissed QuickPick, it may briefly read `false`, so the options would be dropped. A user who reopens Turn Into quickly could hit the same race, so this would be a product bug, not only a test-timing issue.
2. The first `showQuickPick` promise may still be settling when the second picker is requested (`blockOptionsEpoch` is advanced, but VS Code may coalesce or suppress the show).
3. A test-side race: the command is executed before focus has returned from the QuickPick.

Confirm with host-side evidence (a temporary log of each early return and of `showQuickPick` entry/exit) before changing code. Do not guess.

## Part 1 handoff (2026-09-26, Claude Opus 5.5 `claude-opus-5-5`; no effort control exposed, so default effort)

**Cause: a test-side focus race (hypothesis 3); no product bug.** All instrumentation was temporary and has been removed.
- Host trace, 10 runs: `webviewPanel.active` and `visible` were `true` for every options message. Both pickers reached `showQuickPick`. In the failing run, the second `showQuickPick` resolved `undefined` **50 ms after showing**, so it was dismissed, not skipped. Hypotheses 1 and 2 are refuted.
- Webview focus log, 12 runs: after the first Escape, the inner webview document's `focus` event arrives 50–180 ms after the first picker resolves. In several runs it arrives *after* the second picker is shown. A native QuickPick hides on focus loss, so a late focus return dismisses it.
- The spec invokes the second `vmde.turnInto` through `executeCommand` right after the picker hides. A user keybinding or menu fires only after focus has settled, so users do not hit this race.
- Polling only the inner `document.hasFocus()` can hang. In one run focus stayed on the webview's outer iframe and never reached the inner document for 10 s.
- Scratch fix, validated **20/20** (baseline failure rate about 1 in 5–8): after `await expect(picker).toBeHidden()` and the `docText` check, run `executeCommand('workbench.action.focusActiveEditorGroup')`, then `expect.poll(() => frame.locator('body').evaluate(() => document.hasFocus())).toBe(true)` before the second `vmde.turnInto`. The wait took 40–175 ms.
- Jev `jev_decide`: spec fix selected (1.0) over `ignoreFocusOut: true` or a host retry heuristic. Both alternatives change UX or add timing heuristics and are rejected.

**Part 2 instructions:** apply only the spec change above in `test/vscode-e2e/block-transform.spec.ts`, with a one-line comment giving the reason. Make no product change and add no host unit test, since the product path was proven correct. Verify with the checklist's `--repeat-each` run, raised to **20**, and the whole spec once.

## Scope

- In scope: the host options path (`onBlockTransformOptions` and the `vmde.turnInto` command), and the spec only where evidence shows the test itself races.
- Preserve: the active-panel guard's safety intent (never show a picker for an inactive or foreign panel); the `blockOptionsEpoch`, URI, and version checks; exact-source transactions; the webview capture contract.
- Out of scope: webview capture or edit-sync changes (Task 574 verified them for this path); other flaky specs.

## Checklist

- [x] Part 1: reproduce with a host-side trace. Identify which early return or missing show loses the second picker, and record the evidence here.
- [x] Add a failing regression test at the lowest layer that reproduces it. Not applicable: hypotheses 1 and 2 are refuted, and the existing real-VS-Code spec is the reproducer (about 1 in 5–8 failures).
- [ ] Fix with the smallest change that keeps the guard's intent. If a spec race is the cause, fix the spec's wait condition, not a sleep.
- [ ] Verification: focused units, `node build.mjs`, then `block-transform.spec.ts` "native Turn Into QuickPick" with `--repeat-each=20 --retries=0 --workers=1` (0 failures), and the whole `block-transform.spec.ts` once. Report the changed-line coverage. Run typecheck and Biome on changed files.
- [ ] Update this record with results and commit hashes. Move it to `tasks/done/` and index it in `tasks/README.md` when complete.
