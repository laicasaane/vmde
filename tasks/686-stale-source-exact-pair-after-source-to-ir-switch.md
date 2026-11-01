# Task 686 — Stale Source-anchored exact pair after a Source→IR switch fails the first IR rebase

**Status:** planned (2026-11-01). Filed at the close of Task 677.
**Origin:** Task 677 (diagnosis of the intermittent IR long-delay pass in `auto-wrap.spec.ts`).
**Severity:** low (estimated; the failure is closed: no data is lost, only an automatic wrap is skipped).
**Tech stack:** `media-src/src/bridge/edit-sync.ts` (`rebaseUnpublished`, `reanchorAfterModeSwitch`, `snapshotPair`), `test/vscode-e2e/auto-wrap.spec.ts`.
**Depends on:** none.

## Problem

Straight after a Source→IR switch, edit-sync can still hold its exact pair anchored in Source mode. The pair then carries Vditor's Source form of the text, which has one more trailing line break than the host text. The first typed character in IR cannot be mapped onto the host bytes, and the failed result is cached for that rendering.

Measured in real VS Code with an instrumented scratch build under the full `auto-wrap.spec.ts` order, repeating the IR pass at an auto-wrap delay of 1000 ms ten times, each time after a switch to Source or WYSIWYG and back to IR:

- 3 of 10 repetitions declined, all after a Source→IR switch (none of 5 after WYSIWYG→IR).
- In a declining repetition, at the first trusted key: the pair was anchored in Source mode while the editor was in IR (`anchorMode` Source, mode IR); the pair's exact text was 99 characters, the host text (a 98-character fixture) and the remembered rendering were 98; the one-span rebase either found no anchor (start `-1`) or failed its projection proof, and `lastRebase` cached the failure; at the automatic firing the capture's proof returned `unavailable`, the Rewrap declined, and the deferred typing was then published as a plain edit (host text typed, unwrapped).
- In a succeeding repetition the pair was anchored in IR with 98 characters, the rebase was proven, and the wrap was posted exactly.

The auto-wrap fix of Task 677 does not cause this: the decline follows from the failed rebase alone. Task 677 isolates its spec from the state by reseeding from the host before the IR pass.

## Proposed work

Find where the 99-character Source-form pair becomes the exact pair after a Source visit (the Source exact-authority relation of Task 675, `reanchorAfterModeSwitch`, or the Source history-pair recording), and make the first IR rebase succeed or the pair be dropped when its bytes differ from the host text. Keep the Task 606 and 607 proof rules: no proof is relaxed.

## Acceptance

- [ ] After a Source→IR switch, the first typed character in IR still allows an automatic wrap (IR pass at a long auto-wrap delay, repeated, with no decline).
- [ ] A Vitest case for the pair state that failed (pair anchored in Source, host one line break shorter, IR rendering).
- [ ] No exact-authority proof is weakened; the Task 675 Source cases still pass.

## Tests to write

- A Vitest case in `media-src/src/bridge/edit-sync.test.ts` for the rebase after a mode switch from Source.
- Remove the reseed step from the IR 1000 ms pass in `test/vscode-e2e/auto-wrap.spec.ts` and run it repeatedly after the Source pass.
