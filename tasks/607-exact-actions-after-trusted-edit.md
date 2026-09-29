# Task 607 — Preserve exact source for actions after a trusted edit

**Status:** planned (2026-09-29). Task 604 identified the broader N9 authority risk; behavior and repair design need independent acceptance.
**Origin:** [Task 604](done/604-turn-into-non-round-tripping-documents.md), Checkpoint 2 N9 and Owner follow-up decision.
**Scope:** exact-source ownership after keyboard/paste edits across Turn Into, Find Replace and table actions. Do not change their individual action planners or treat rendered serialization as an exact baseline.
**Dependency:** coordinate with Task 602's host/webview Undo coupling and Task 196's exact Find authority.

## Problem and evidence

`markUserInput(true)` in `media-src/src/bridge/edit-sync.ts` revokes the prior exact seed. When the next snapshot takes Vditor's rendered serialization as exact, an action calling `postExact` can send the whole normalized document with `exact: true`; `src/writeback/writeback-controller.ts` then writes those bytes verbatim. On a document whose tables or lists normalize, this can change bytes outside the user's intended action. Task 604's N9 source audit identified the route; its trusted-edit controls did not establish a complete cross-action fix. Evidence: `tmp/queue-part1/604-cp2-4-handoff.md` N9 and Task 604's Checkpoint 1/2 diagnostics.

## Investigation and design boundary

1. Reproduce a trusted edit outside and near a normalizing region, followed separately by Turn Into, Find Replace and a table action. Compare pre-edit exact source, rendered bytes, edit span, host and disk by hashes/lengths and changed intervals; do not print fixture contents.
2. Trace when EditSync loses exact ownership, when the host accepts an exact post, and how native Undo groups the trusted edit and action. Separate an intended normalization of the edited span from any unintended change elsewhere.
3. Propose an authority recovery that rebases the trusted edit onto the prior exact source or proves a bounded replacement. Fail closed when the edit cannot be mapped. The Project Owner decides any broader change to exact transaction/history semantics before implementation.
4. Coordinate the acceptance with Task 602 so a repair does not leave the host or native Undo out of step.

## Verification

- Unit tests for exact revision ownership, bounded changed spans, stale snapshots, CRLF and no-write decline.
- Chromium tests for each action after a trusted edit on a privacy-safe normalizing document.
- Built real-VS-Code XTEST tests for trusted typing/paste, action apply, OS Undo/Redo, exact host/save/reopen and bytes outside the intended span.

## Acceptance

- [ ] Trusted input followed by every covered exact action changes only the intended source spans.
- [ ] No path promotes unrelated normalized rendered bytes to exact authority or posts them as an exact edit.
- [ ] Host, webview, disk and native Undo/Redo agree on the final exact document.
