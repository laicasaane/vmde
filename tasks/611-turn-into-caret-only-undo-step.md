# Task 611 — Remove the caret-only Undo step after Turn Into

**Status:** planned (2026-09-29). The Project Owner decided the history boundary on 2026-10-08 (see Owner decisions); implementation has not started.
**Origin:** Task 604 checkpoint 2; coordinate with [Task 603](done/603-undo-routing-hygiene.md) item 3 and [Task 597](done/597-undo-restore-caret-without-marker.md).
**Scope:** the Turn Into history sequence. Task 603 item 3 measures a separate host-update sequence; share a fix only if the underlying snapshot rule is proved common.

## Problem

After a successful Turn Into, the Undo stack can gain two entries. One Ctrl+Z only changes the caret, leaving the host text unchanged, so the user needs another Undo to reverse the transform.

## Measured evidence

`tmp/task604-checks/cp2/vscode/s0b-r0-c-r1.json` records a real-VS-Code IR Turn Into control using a source-proven request-caret setup. The pre-transform Undo depth is 2 and the depth before Undo is 4. The recorded second Undo step has `secondUndoChangedHost: false` and `consumedCaretCheckpoint: true`; the later step recovers the original host text. The alternate addRange setup did not apply the transform, so it is not a valid history comparison. The exact writer of the extra step and other modes are unmeasured.

## Affected modes

- **IR:** observed with a successful Turn Into.
- **WYSIWYG/SV:** Turn Into and Vditor Undo paths exist, but this extra step has not been measured in those modes.

## Candidate approaches

1. Coalesce or reject a snapshot that changes only the caret after the transform's exact before/after history entry.
2. Move the transform checkpoint or post-apply caret restore so the caret is captured in the intended text-changing entry.
3. Reuse a general solution from Task 603 item 3 if the host-update and Turn Into traces share the same writer and history semantics.

## Owner decisions (2026-10-08)

Approved in chat by the Project Owner.

- One Ctrl+Z restores the exact pre-Turn-Into document, and one Ctrl+Y reapplies it.
- Caret-only history is never intended for this action.
- After Undo the caret returns to its pre-Turn-Into position. After Redo it sits at the start of the transformed block.
- If attribution finds the same writer as Task 603 item 3, reuse that rule (disarm the delayed after-render entry). Task 603 is done, so there is no fold-in.

## Tests

- Attribute every Turn Into checkpoint and delayed Vditor snapshot in a small exact-source control; cover IR, then measure WYSIWYG/SV before changing shared Undo code.
- Unit/Chromium checks for one text-changing Undo/Redo boundary, caret placement, exact source outside the target and no duplicate host post.
- Build first, then a focused real-VS-Code XTEST spec with no retries: apply Turn Into, press Ctrl+Z once and Ctrl+Y once, and assert exact host/disk text, stack depth, focus and caret membership. Include the Task 603 external-update route as a separate control if code is shared.

## Acceptance

- [ ] One OS Undo reverses a successful Turn Into's exact text change; one Redo reapplies it, without an intervening caret-only step.
- [ ] Caret and focus remain usable, and bytes outside the transformed block survive apply, Undo, Redo and save/reopen.
- [ ] Tests distinguish the Turn Into result from Task 603's external-update history policy and report any unmeasured mode separately.

## Part 1 handoff (2026-10-14)

Read-only review of the source and of the recorded IR measurement; writer identity is inferred and S1 confirms it.

- **Cause.** The extra entry is the Turn Into pre-checkpoint, not a delayed snapshot: `applyBlockTransformChoice` (`media-src/src/editing/block-transform-command.ts`) calls `checkpointEditorUndo` (`media-src/src/editing/rewrap-command.ts`) before the transform unless `isOwnCheckpoint` (Task 298 consecutive-transform guard); Vditor `addToUndoStack` pushes on any diff, including a caret-only (`<wbr>`) diff. After a settled edit plus a caret move into the target, the pre-entry differs only in the caret; the post-checkpoint then records the transform. The recorded depth arithmetic matches (opening 1; trusted edit 2; caret-only pre 3; post 4; first Undo 3 and exact; second Undo 2, host unchanged, caret-only).
- **Record correction.** The measured caret-only step is the **second** Ctrl+Z (below the transform entry); the first Ctrl+Z already restores the exact pre-Turn-Into text. The Owner rule ("no caret-only step") still covers it. The Chromium consecutive-transform test asserts only text and cannot see it.
- **Not the Task 603 item 3 writer.** The after-render record armed by `setValue` is cancelled synchronously by the post-checkpoint (`cancelPendingUndoSnapshot`) before its timer fires; the rAF caret re-assert writes no history. Reusing `disarmAfterRenderUndoEntry` would be redundant.
- **Contract.** (1) A Turn Into adds exactly one Undo entry; one Ctrl+Z restores the exact pre-Turn-Into text; one Ctrl+Y reapplies it; the next Ctrl+Z undoes the prior edit (or does nothing at the base). (2) Pre-checkpoint: a pending or unrecorded text edit (caret-stripped live snapshot differs from `lastText`) is flushed as its own entry, as today; a caret-only or no-op difference is **coalesced** — no push; the top entry is rewritten in place so its state equals the live snapshot with the current caret (`S_prev = patch_apply(top, lastText)`, top := `patch_make(T, S_prev)`, `lastText := T`), so Undo returns the caret to its pre-Turn-Into position; the base entry is handled the same way (mirrors Vditor `recordFirstPosition`). (3) Compare `addCaret` output stripped by the existing `withoutCaret` helper (`media-src/src/editing/undo-boundaries.ts`), not raw `innerHTML` (math, echarts and plantuml previews are normalized by `addCaret`). (4) Mutate the top patch array in place (identity is matched by `recordRewrapDocumentHistory` and `isOwnCheckpoint`; the latter becomes a sub-case of coalescing). (5) The rollback snapshot (`snapshotTableUndoForRollback`, `media-src/src/editing/table-actions.ts`) also copies the top entry's contents, so a failed apply restores the original patch. (6) The Undo caret is the live selection at pre-checkpoint time; if focus left the editor (QuickPick), place it from the bookmark first (probe).
- **Redo caret (Owner rule vs planner).** The Owner rule says the caret after Redo is at the transformed block start. The planner maps the caret by content offset (`media-src/src/editing/block-transform.ts`), so Redo would restore the mapped content position instead. Orchestrator ruling (provisional, until the Owner answers): follow the Owner rule as written — record the post-checkpoint with the caret at the transformed block start.
- **Part 2.** S1: tag each `addToUndoStack` caller with a stack (pre, post, after-render, seed); run edit, settle, caret into target, Turn Into H2 in IR, then WYSIWYG and SV; expected: the pre entry is caret-only and the after-render record is cancelled; another writer → stop and escalate. S2: a push-or-coalesce helper in `undo-boundaries.ts` used at the pre-checkpoint; rollback snapshot extended; unit tests (`undo-boundaries.test.ts`, `block-transform-command.test.ts`, real diff-match-patch: caret-only → no push and an in-place rewrite with the previous Undo still yielding `S_prev`; text diff → push; base depth 1; math-preview normalization; redo stack untouched; rollback restores the top contents; apply path calls coalesce — RED on HEAD) and Chromium (`media-src/e2e/block-transform.spec.ts`: IR, WYSIWYG, SV — depth +1, Undo exact with the caret at the pre position, Redo transformed, next Undo changes text, one host post per apply; strengthen the consecutive-transform test with depth assertions — RED on HEAD: depth +2). S3: real-VS-Code `test/vscode-e2e/turn-into-undo-step.spec.ts` (XTEST; IR, WYSIWYG, SV: type, settle, caret into target, Turn Into H2; Ctrl+Z ×1 exact host and disk text, caret in the pre block, focus in the editor; Ctrl+Y ×1 transformed; Ctrl+Z ×2 undoes the typed character; save/reopen bytes outside the block). Controls: `undo-routing-hygiene.spec.ts` leg 3, `block-transform.spec.ts`, `undo-restore-caret`, `undo-host-coupling`. S4: closure with the record correction.
- **Edge cases.** A pending edit inside 800 ms (flush, Task 601 drain applies); a non-empty redo stack (coalescing never touches it); consecutive Turn Intos (identity preserved); math/diagram blocks (normalized compare); a failed apply (exact stack restore); anchor ≠ focus (both endpoints recorded); IME (Turn Into already refused); Task 602 host coupling (coalescing posts nothing — verify no host post).
- **Risks.** The coalesce rewrites a Vditor-internal patch (depends on an exact `lastText`); Rewrap likely has the same caret-only pre-checkpoint (out of scope; offered as a follow-up); Task 609's tie rule decides where the caret marker lands in the post entry — run 611 after 609.
