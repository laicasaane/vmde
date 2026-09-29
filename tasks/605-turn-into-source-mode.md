# Task 605 — Turn Into with exact source in SV mode

**Status:** planned (2026-09-29). Task 604 deliberately scoped its exact selection proof to IR and WYSIWYG; the SV design and acceptance remain open.
**Origin:** [Task 604](done/604-turn-into-non-round-tripping-documents.md), Owner decision 2 and independent-review residual.
**Scope:** SV capture, exact apply/Undo/save, and SV or index-less passive Details capture while a Turn Into choice is pending. Do not change Task 604's IR/WYSIWYG proof or its pending-choice contract.
**Dependency:** Task 604's shared exact-source proof and host cancellation lifecycle.

## Problem and evidence

SV's `captureRewrapSourceRange` uses `clone.textContent` (`media-src/src/editing/rewrap-command.ts`), including an appended newline span, then requires whole-document equality with the exact source. The canonical fixture has 174,517 exact characters; direct SV renders at 174,527–174,529 characters and a WYSIWYG→SV switch renders at 181,844. The small round-tripping SV control F5b also declines: 32 exact characters versus 35 rendered, and host-style serialization differs from exact. SV apply also assumes the editor text and exact source correspond (`media-src/src/editing/block-transform-command.ts`, `replaceSvMarkdownRange`). Task 604's Details guard covers its indexed fallback only; SV/index-less passive capture can still insert markers while a choice is pending.

Evidence: Task 604 Checkpoint 1 D6 and F5b in `tmp/task604-checks/cp1/`, especially `tmp/task604-checks/cp1/vscode/r0-b.json`; S6 review disposition in the Task 604 record. The fixture is synthetic and its content must not be printed in diagnostics.

## Investigation and design boundary

1. Measure direct SV and IR/WYSIWYG→SV entry on the same exact fixture, including the small F5b control. Record the source, SV text and host identities by length/hash and prove caret/selection membership before Turn Into.
2. Design an exact↔SV-text alignment for both selection endpoints, using Task 604's `toExact` and Find's SV mapper as references. Reject ambiguous offsets, appended controls and any span whose source ownership cannot be proven. Keep exact source as the transform input and posted result.
3. Prove that applying the exact span changes only the intended block and records history against SV's rendered `getValue()` where required. Preserve one OS Undo, Redo where supported, host/disk/save/reopen fidelity and mode-switch behavior.
4. Measure SV/index-less Details capture with a pending choice. Decide how to defer source-affecting passive capture until apply/cancel without disabling indexed or explicit Details actions. Coordinate with Task 606's broader marker-capture work rather than duplicating it.

## Verification

- Real-Lute/unit cases for direct and switched SV, small F5b, appended-newline boundaries, CRLF, unmappable endpoints, and pending-choice apply/cancel.
- Chromium coverage for exact target-only transformation, Details resumption, and Undo/Redo.
- Build first, then focused real-VS-Code XTEST coverage for direct and switched SV QuickPick, exact host/save/Undo/reopen, focus and selection ownership. Compare Task 604 IR/WYSIWYG controls and report inherited gates separately.

## Acceptance

- [ ] Turn Into offers only source-proven targets from both direct and switched SV, including the small F5b control.
- [ ] Unprovable SV selections decline without posting or applying an approximate edit.
- [ ] Apply, one OS Undo and save/reopen preserve exact bytes outside the target; rendered bytes never become exact authority.
- [ ] A pending SV choice survives passive Details activity and Details resumes after apply or matching cancel.
