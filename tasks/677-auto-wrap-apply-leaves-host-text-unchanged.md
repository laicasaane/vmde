# Task 677 — Auto-wrap apply leaves the host text unchanged

**Status:** planned (2026-11-01). Filed at the close of Task 669.
**Origin:** Task 669 (step B2), Task 672.
**Severity:** medium (estimated; manual Rewrap works).
**Tech stack:** `media-src/src/boot/main.ts` (`captureAutoWrapTarget`, `autoWrapController`), `media-src/src/editing/rewrap-command.ts` (`runRewrapCommand`), `test/vscode-e2e/auto-wrap.spec.ts`, `test/vscode-e2e/auto-wrap-proof-cost.spec.ts`.
**Depends on:** none.

## Problem

In real VS Code the auto-wrap firing does not change the host text in the Source-mode pass of `auto-wrap.spec.ts:31` (it fails at `:603`: the paragraph stays `alpha beta gammaz delta epsilon`; the IR and WYSIWYG passes pass). Task 672 measured the same on the large IR fixture: the firing runs its proof (two whole-document serializations), but the wrapped text never reaches the host, while a manual Rewrap on the same state applies it. The Chromium harness applies the wrap. Measured on `90611a6b` and again on `5aaf5d16`. It does not use the Source-mode table and list commands changed by Task 669.

## Proposed work

Measure where the firing declines between `captureAutoWrapTarget` and the host post (target capture, the target-current check after the delay, the proof, or the post), then fix the decline without weakening the Task 606 proof rules.

## Tests to write

- Make `auto-wrap.spec.ts:31` pass (Source mode included), and let the large-fixture case in `auto-wrap-proof-cost.spec.ts` assert that the host text changed (it only prints it today).
- A Vitest case for the decline point once it is known.
