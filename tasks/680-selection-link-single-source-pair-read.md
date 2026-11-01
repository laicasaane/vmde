# Task 680 — Selection Link reads the source pair twice on a normalizing document

**Status:** planned (2026-11-01). Filed at the close of Task 666; waits for a future batch.
**Origin:** Task 666 (residual).
**Severity:** low (estimated; performance only, no wrong result).
**Tech stack:** `media-src/src/editing/rewrap-command.ts` (`captureNormalizingBodyRange`), `media-src/src/editing/selection-source-proof.ts` (`proveSelectionSource`), `media-src/src/editing/selection-link-actions.ts`.
**Depends on:** none.

## Problem

On a normalizing document the selection Link path takes the source pair twice for one gesture: `captureNormalizingBodyRange` calls `source.snapshotPair()` (`rewrap-command.ts:429`) to compare the authoritative text, and then calls `proveSelectionSource(source, editor, range)` (`rewrap-command.ts:432`), which calls `source.snapshotPair()` again (`selection-source-proof.ts:206`). Each pair read serializes the document, so a large normalizing document pays the cost twice. Task 666 recorded this and left it because passing the pair through changes the proof's signature. Round-trip documents and other callers (the option is off) are unaffected. The cost is not measured yet.

## Proposed work

Measure the extra serialization on a large normalizing fixture first. If it is material, let `proveSelectionSource` accept the already-read pair (an optional argument, other callers unchanged) and pass it from `captureNormalizingBodyRange`, keeping every Task 666 refusal rule (owned exact text must equal the acquired text; no marker fallback).

## Acceptance

- [ ] The Link path on a normalizing document reads the pair once (counted `snapshotPair` calls in a Vitest case).
- [ ] The measured saving is recorded; if it is negligible, close as not worth changing.
- [ ] Every Task 666 Vitest guard still passes unchanged (stale exact text declines; cross-unit proof declines).
- [ ] Focused real-VS-Code spec written and run; quality stages pass.
