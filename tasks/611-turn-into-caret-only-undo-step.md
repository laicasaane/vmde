# Task 611 — Remove the caret-only Undo step after Turn Into

**Status:** planned (2026-09-29). The desired history boundary and implementation are undecided.
**Origin:** Task 604 checkpoint 2; coordinate with [Task 603](603-undo-routing-hygiene.md) item 3 and [Task 597](done/597-undo-restore-caret-without-marker.md).
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

## Owner decisions needed

- Should one Ctrl+Z after Turn Into always restore the exact pre-transform document, with Redo reapplying it in one step?
- Is caret-only history ever intentional for this action, and where should the caret land after Undo/Redo?
- Should this work be folded into Task 603 if attribution proves the same rule owns both defects?

## Tests

- Attribute every Turn Into checkpoint and delayed Vditor snapshot in a small exact-source control; cover IR, then measure WYSIWYG/SV before changing shared Undo code.
- Unit/Chromium checks for one text-changing Undo/Redo boundary, caret placement, exact source outside the target and no duplicate host post.
- Build first, then a focused real-VS-Code XTEST spec with no retries: apply Turn Into, press Ctrl+Z once and Ctrl+Y once, and assert exact host/disk text, stack depth, focus and caret membership. Include the Task 603 external-update route as a separate control if code is shared.

## Acceptance

- [ ] One OS Undo reverses a successful Turn Into's exact text change; one Redo reapplies it, without an intervening caret-only step.
- [ ] Caret and focus remain usable, and bytes outside the transformed block survive apply, Undo, Redo and save/reopen.
- [ ] Tests distinguish the Turn Into result from Task 603's external-update history policy and report any unmeasured mode separately.
