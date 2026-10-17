# Task 659 — Resolve known real-VS-Code toolbar failures

**Status:** open.
**Origin:** Project Owner request (known issue from Task 642).
**Severity:** medium (verification reliability; possible product defects).
**Tech stack:** real-VS-Code e2e specs in `test/vscode-e2e` run under `xvfb-run`; webview toolbar.
**Related:** [Task 642](done/642-toolbar-layout-follow-ups.md) (toolbar layout follow-ups).

## Problem

Four known real-VS-Code failures remain around the toolbar:

1. `toolbar-collapse.spec.ts`, restart case: intermittent. The own-launched VS Code started right after the previous case's VS Code sometimes does not activate VMDE, or Quick Open does not list the file. This also occurs on the build before Task 642.
2. `escape-toolbar.spec.ts:267`, "Tab inserted a tab character after the toolbar return": fails before Task 642 too.
3. `toolbar-overflow.spec.ts`, "two toolbar rows survive edit-mode and Preview transitions": Alt+Control+9 leaves Source mode hidden.
4. The Emoji high-contrast tile test: outline is 2.4 px where 3 px is expected.

## Requirements

1. Find the cause of each failure.
2. Fix product defects where the cause is in the product.
3. Make each test deterministic.
4. Remove each fixed item from the known-failure list.

## Open design points

- To be settled in Part 1.

## Scope

- In: the four failures above, their causes, and the specs named above.
- Out: toolbar behaviour not covered by these failures.

## Acceptance

- [ ] The restart case in `toolbar-collapse.spec.ts` passes in repeated runs, with VMDE activated and the file listed in Quick Open.
- [ ] `escape-toolbar.spec.ts:267` passes and the Tab character is inserted after the toolbar return.
- [ ] `toolbar-overflow.spec.ts` "two toolbar rows survive edit-mode and Preview transitions" passes, with Source mode visible after Alt+Control+9.
- [ ] The Emoji high-contrast tile test passes with a 3 px outline.
- [ ] Each of the four items is removed from the known-failure list.

## Tests

- Real-VS-Code e2e specs named above. Run `node build.mjs` first, then run each spec under `xvfb-run`. Exact commands are to be specified in Part 1.
