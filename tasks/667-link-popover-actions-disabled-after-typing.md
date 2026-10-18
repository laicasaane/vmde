# Task 667 — Link popover Edit and Unlink disabled after typing

**Status:** planned (2026-10-18). Filed at the close of Tasks 606 and 630; waits for a future batch.
**Origin:** Task 630.
**Severity:** low (estimated).
**Tech stack:** `media-src/src/editing/link-popover.ts` (~279-296 `clickSourceBinding`, ~755 `disabled = !record.sourceSpan`).
**Depends on:** Task 630.

## Problem

On a normalizing document the popover Edit and Unlink buttons stay disabled for about 1.2 s after typing. `clickSourceBinding` returns `sourceSpan: null` when the link index has no entry, because typing revoked the owned base; the index is rebuilt only after background acquisition finishes. The Task 630 real-VS-Code cell passes only because it reopens the popover up to 8 times.

## Proposed work

Acquire authority at click time so the binding exists when the popover opens, or rebuild the index synchronously from the acquired pair. Remove the retry loop from `openLinkPopover` in `exact-authority-other-actions.spec.ts`.

## Acceptance

- Edit and Unlink are enabled at once after typing on a normalizing document.
- The spec helper opens the popover without retries.
- `link-popover.spec.ts:241` is a failure that also occurs on `dev`; decide there whether it belongs here.
- [ ] Focused real-VS-Code spec written and run; `npm run quality` passes.
