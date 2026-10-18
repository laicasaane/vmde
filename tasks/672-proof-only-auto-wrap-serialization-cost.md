# Task 672 — Extra IR serialization of proof-only auto-wrap

**Status:** planned (2026-10-18). Filed at the close of Tasks 606 and 630; waits for a future batch.
**Origin:** Task 606.
**Severity:** low (estimated).
**Tech stack:** `media-src/src/editing/rewrap-command.ts`, `media-src/e2e/auto-wrap.spec.ts` ("large IR typing").
**Depends on:** Task 606.

## Problem

Proof-only auto-wrap adds one more full IR serialization on a large IR document (`fullIrSerializes` 1 to 2 in the "large IR typing" case). The Task 606 timing gates (which do not exercise auto-wrap typing) showed no change. Measure it in the Chromium "large IR typing" case before deciding.

## Proposed work

Measure the cost on a large document. If over budget, cache the proof input or reuse the serialization.

## Acceptance

- `fullIrSerializes` is back to 1 on a large IR document, or the measured cost is recorded as acceptable.
- [ ] Focused real-VS-Code spec written and run; `npm run quality` passes.
