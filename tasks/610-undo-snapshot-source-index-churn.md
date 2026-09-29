# Task 610 — Avoid source-index rebuilds from Undo snapshot markers

**Status:** planned (2026-09-29). No implementation is approved.
**Origin:** Task 604 checkpoint 2 attribution; preserve [Task 578](done/578-ir-click-source-index-rebuild.md)'s shared index and performance contract.
**Scope:** source-neutral DOM mutations from Vditor's Undo snapshot. Do not suppress invalidation for real source or block-structure changes.

## Problem

Vditor's delayed `addToUndoStack` calls `addCaret`, temporarily inserting and removing `span.vditor-wbr`. The shared index in `media-src/src/nav/source-block-index.ts` treats every non-attribute mutation as relevant, advances `domRevision` and discards a warmed entry even when Markdown is unchanged. A following source-backed request rebuilds the large-fixture index; the observed request can take roughly 1–1.6 seconds. Isolate the build cost from other request work before setting a performance budget.

## Measured evidence

- `tmp/task604-checks/cp2/s6-r7-attribution.md`: controlled real-Vditor/Lute diagnostic passed 4/4. In both IR and WYSIWYG, warming before the opening checkpoint changed `domRevision` 1→2, Undo depth 0→1 and caused one request index build; waiting for the checkpoint first kept the revision and Undo depth stable and caused zero request builds. Exact Markdown stayed identical.
- The checkpoint generated three child-list records, including a split text node, and one character-data record. `source-block-index.ts::relevantMutations` admits all of them. `tmp/task604-checks/cp2/s6-roundtrip-trace/mapped-events.json` attributes a delayed marker writer to Vditor Undo during the Turn Into trace. The controlled diagnostic did not reproduce native VS Code timing; the earlier native failed run lacked a pre-hover index-key sample, so its writer is not retrospectively proved.

## Affected modes

- **IR and WYSIWYG:** causal index invalidation measured in the controlled diagnostic; native timing needs confirmation.
- **SV:** the shared source-block index is scoped to IR/WYSIWYG; check any SV consumer before claiming an effect.

## Candidate approaches

1. Make `relevantMutations` recognize a complete source-neutral Undo-marker insertion/removal, including the text split, while continuing to invalidate on real text and structure edits.
2. Suppress or batch index invalidation around a verified `addCaret` snapshot transaction, with a safe fallback if unrelated mutations occur in the same batch.
3. Prevent the transient snapshot marker from touching the live indexed root, if an anchored Vditor patch can preserve Undo and caret behavior.

## Owner decisions needed

- Which layer should own source-neutral snapshot detection: the shared index or the Vditor integration?
- What maximum warm-request time and index-build count should be required on the representative large fixture?

## Tests

- Unit/DOM tests with actual `addCaret` mutations: unchanged Markdown retains the warmed index; a mixed batch with a real edit or block replacement invalidates it. Cover IR and WYSIWYG.
- Chromium performance regression for a warmed request before and after the delayed snapshot, with `domRevision`, index builds, exact-source identity and elapsed work recorded.
- Build first, then focused real-VS-Code XTEST coverage with an opening-checkpoint control and a later request on the privacy-safe large fixture. Recheck Task 578's warm click/hover and source-index invalidation gates.

## Acceptance

- [ ] Source-neutral Undo snapshots cause zero avoidable index builds on the warmed IR/WYSIWYG paths.
- [ ] Actual Markdown or block-structure mutations still invalidate the index and return source-correct options.
- [ ] Focused native and Chromium measurements meet the Owner-approved budget without changing Undo, caret placement or host bytes.
