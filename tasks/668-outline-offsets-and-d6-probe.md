# Task 668 — Outline route (b) offsets and the D6 probe

**Status:** planned (2026-10-18). Filed at the close of Tasks 606 and 630; waits for a future batch.
**Origin:** Task 630.
**Severity:** medium (estimated).
**Tech stack:** `src/shared/protocol.ts`, `src/session/editor-session.ts`, `media-src/src/nav/outline-move-routes.ts`, `test/vscode-e2e/exact-action-neutral-bytes-probe.spec.ts`.
**Depends on:** Task 630.

## Problem

(1) The native outline drag (route b) sends only `{start, level}` host offsets. Publishing pending typing can change the host text first, so the offsets may point at other bytes, and the host label check cannot catch it because the labels come from the acquired text. (2) The D6 probe asks whether typing after an exact action lets the plain write, minimized against the disk baseline (`cleanBaseline`), revert semantically neutral action bytes such as table-format padding. The probe spec exists and has not been run.

## Proposed work

(1) Add the dragged and target labels, or a document version, to `move-outline-section` (protocol change; recommended). (2) Run the probe once with `VMDE_PROBES=1`. If the revert is confirmed, decide the plain-write baseline change as a separate step.

## Acceptance

- A route (b) drop after typing never moves other bytes; a mismatch is refused.
- The probe result is recorded; a fix is applied or filed.
- [ ] Focused real-VS-Code spec written and run; `npm run quality` passes.
