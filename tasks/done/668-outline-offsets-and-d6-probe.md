# Task 668 — Outline route (b) offsets and the D6 probe

**Status:** done (2026-11-01). Route (b) is fixed; the D6 probe result is recorded and the baseline fix is filed as [Task 673](../673-plain-write-baseline-keeps-exact-action-bytes.md). Filed 2026-10-18 at the close of Tasks 606 and 630.
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

### Acceptance status (2026-11-01)

- [x] A route (b) drop after typing never moves other bytes; a mismatch is refused. Proved by the new real-VS-Code spec `outline-native-drop-after-typing.spec.ts` (shifted case RED before the change with section C moved before A, then GREEN; control case passes) and by Vitest cases in the route, host and router tests. The route (b) cases inside `outline-reorder.spec.ts` stay unproven on this base: both of its tests fail earlier at Redo (`:108`, `:276`), the same failure points as before the change (Task 669).
- [x] The probe result is recorded (Part 1 handoff) and the fix is filed as Task 673. The live instrument was invalid (SV Format table is a no-op on this base; the probe's Shift key press clears the retained SV selection); the mechanism is confirmed at unit level only.
- [x] Focused real-VS-Code spec written and run. The quality stages were run individually; the aggregate `npm run quality` was not run (dependency audits are omitted in this queue). Results are below.

## Part 1 handoff (2026-11-01)

### Root cause, route (b)

- The host builds the drop from `document.getText()` at drop time (`src/markdown/outline-tree.ts` `handleDrop`): it checks the drag's document version, finds the dragged heading by `{start, level}`, takes the target from the `HeadingItem` offset without checking that it is still a heading, and posts `move-outline-section` with `{start, level}` only (`src/session/editor-session.ts` `moveOutlineSection`, `src/platform/active-panels.ts`).
- The webview (`media-src/src/nav/outline-move-routes.ts` `requestByIdentity`) first acquires with `publish: true`. Typing that is still inside the 800 ms edit debounce reaches the host at that point, so the host text and its offsets change. `planOutlineMoveByIdentity` then matches `{start, level}` on the acquired text and builds `rowLabels` from that same text, so the host label check in `prepareOutlineSectionMove` (`src/session/editor-session.ts`) passes by construction.
- Failure, worked by hand on the current code: a document `intro`, `# A`, `# B`, `# C`, `# D` with 8-byte sections (`# A\n\na\n\n`). Typing 8 characters into `intro` and dropping C before D while the typing is pending moves B before C: the old C offset now names B and the old D offset names C. Other shifts make the lookup fail, and the drop does nothing.

### Root cause, D6 (measured)

- The live probe `exact-action-neutral-bytes-probe.spec.ts` was run once with `VMDE_PROBES=1`. It passed as a test, but the instrument was invalid: `actionReachedHost: false` (initial and action result both length 302, hash `b49ddc50126d`). Scratch variants in IR, WYSIWYG and SV gave the same result, and so did an SV variant without the Shift_L gesture. Two reasons: (1) SV `vmde.formatTable` does not change the host on unchanged code either (`table-format.spec.ts:12` fails on this base: the host keeps `|a| longer |`); this is the SV table-format write that Task 669 owns. (2) The probe's `endSelectionGesture` presses Shift_L, and that keydown clears the retained SV selection (`table-format-command.ts`, `onEditorGesture`). The probe's second typing also failed to place its selection (`sv: selection on editword`).
- The mechanism was confirmed with a deterministic scratch unit check (pinned Lute, the probe fixture): the fixture table formatted by `FormatStr`, one character typed in another paragraph, then `minimalDiffWriteback(original, typed, reserialize)`. The result keeps the original table bytes and drops the padding (`writtenKeepsFormatted: false`, `writtenRevertsTable: true`). Nothing in `src/writeback/writeback-controller.ts` prevents it: `exactTransactionContent` is cleared by every plain sync, and `cleanBaseline` is reset only at open and save.

### Baseline on this branch (`9dc5c094`)

- `outline-reorder.spec.ts:15` fails at the Redo step (`:108`, the host stays on the original order after Ctrl+Y), before its route (b) cases run. `outline-reorder.spec.ts:187` fails the same way. Both are listed in Task 669 and are not changed here.
- `table-format.spec.ts:12` fails (SV Format table leaves the host unchanged). This is a pre-existing failure in the Task 669 area.

### Interface and invariants

- Protocol: `move-outline-section` becomes `{ command; source: { start: number; level: number; label: string }; target: { start: number; level: number; label: string }; placement: 'before' | 'after' }`. `label` is `sourceHeadingLabel(text, heading)` from `src/shared/section-move.ts`, computed on the host text. Host and webview ship in one bundle, so there is no compatibility path: the webview router ignores a message whose `source.label` or `target.label` is not a string.
- `ActivePanelEntry.moveOutlineSection` and `OutlineHeadingIdentity` take the same `{ start, level, label }` shape.
- Host: `handleDrop` resolves the target `HeadingItem` to a heading of the current text (start and level); if it is not one, nothing is posted and nothing is written. The no-target case (the last heading of the dragged level) carries its label too. The fallback path without a ready panel is unchanged.
- Webview: `planOutlineMoveByIdentity` uses a heading only when start, level and label all match on the acquired text; otherwise it returns `null` and nothing is posted (refused).
- Invariant: a route (b) drop writes either the move of the named sections on the text the host holds, or nothing. Bytes outside the moved sections and the typing are never changed.

### Provisional decisions

- Provisional decision (2026-11-01), reversible: route (b) names headings by host offset, level and label (`{start, level, label}`), and the webview refuses the drop unless all three match on the acquired text. Rejected: relocating to the single heading with the same level and label (more behaviour, probability 0.20) and a document version echo (refuses every drop made while typing is pending, probability 0.01). Selected by a recorded decision check (probability 0.78). Evidence: the root cause above; the record recommends labels; host and webview ship together.
- Provisional decision (2026-11-01), reversible: D6 is not fixed here. The probe result above is recorded, and a follow-up task is filed at closure as Task 673, "Plain-write baseline keeps exact-action bytes". It changes the plain-write baseline, fixes the probe instrument (no Shift_L before the command) and depends on Task 669's SV table-format repair for a valid live measurement. Selected by a recorded decision check (probability 1.0). Evidence: the live instrument is blocked by a pre-existing failure; the fix would change the core plain-write path without a valid live measurement; Task 630 decision (5) and this record both place the baseline change in a separate step. If the number is taken when the task closes, the next free number is used.
- Provisional decision (2026-11-01), reversible: the refusal is silent (no notification), as the existing `null` path already is. The new real-VS-Code spec goes in its own file, because `outline-reorder.spec.ts` fails at `:108` on this base and Task 669 owns it.

### Acceptance to test map

| Acceptance item | Layer | File | Test title |
| --- | --- | --- | --- |
| 1. Drop after typing never moves other bytes; mismatch refused | Real VS Code | `test/vscode-e2e/outline-native-drop-after-typing.spec.ts` (new) | `ir: a native outline drop while typing is pending is refused when the typing moved the headings` |
| 1. (positive control: a drop that typing did not affect still moves) | Real VS Code | same file | `ir: a native outline drop while typing is pending still moves when the headings did not move` |
| 1. Webview refuses a label mismatch | Vitest | `media-src/src/nav/outline-move-routes.test.ts` | `refuses an identity whose label differs on the acquired text` and `posts nothing when published typing moved the named headings` |
| 1. Host sends labels and refuses a stale target | Vitest | `test/backend/outline-tree.test.ts` | `a ready panel receives the dragged and target labels from the host text` and `refuses a target that is no longer a heading of the host text` |
| 1. Malformed message ignored | Vitest | `media-src/src/bridge/message-router.test.ts` | `move-outline-section without string labels is ignored` |
| 2. Probe result recorded; fix filed | Records | this section; Task 673 record at closure | - |
| 3. Focused real-VS-Code spec written and run; quality stages | Gates | the new spec; quality stages run individually | - |

### Edge cases and their cheapest layer

- Duplicate heading labels at different offsets: the offset decides (Vitest, routes).
- Typing that renames the dragged or the target heading: refused (Vitest, routes).
- Setext headings and CRLF text: labels and offsets agree on the host and acquired text (Vitest, routes and outline-tree).
- No target (drop at the end): the last heading of the dragged level, with its label (Vitest, outline-tree).
- A stale target `HeadingItem` (its offset is not a heading now): nothing is posted (Vitest, outline-tree).
- Typing already published before the drag: unchanged behaviour, covered by the existing Task 630 cases.
- Missing or non-string label in the message: ignored (Vitest, router).

### Part 2 step plan

- P2-S1 RED. Owns `media-src/src/nav/outline-move-routes.test.ts`, `media-src/src/bridge/message-router.test.ts`, `test/backend/outline-tree.test.ts` and the new `test/vscode-e2e/outline-native-drop-after-typing.spec.ts`. The spec uses a plain IR fixture `intro`, `# A`, `# B`, `# C`, `# D` with 8-byte sections. Case 1 types 8 characters into `intro` with XTEST, then drops C before D through the `outlineDragAndDrop` test seam in one host call. Instrument check: the host text read in that call still equals the text before the typing. Expected: the host text becomes the typed text with the sections unchanged. Case 2 types 8 characters into the last paragraph (`d`), drops D before C, and expects the move with the typing kept. Checks: `npx vitest run --config test/vitest.config.mts media-src/src/nav/outline-move-routes.test.ts media-src/src/bridge/message-router.test.ts test/backend/outline-tree.test.ts`, which must fail only on the new label assertions. Then `node build.mjs` and the wrapper run of the new spec: case 1 must fail with B moved (the RED proof) and case 2 must pass.
- P2-S2 GREEN. Owns `src/shared/protocol.ts`, `src/platform/active-panels.ts`, `src/markdown/outline-tree.ts`, `src/session/editor-session.ts` (the `moveOutlineSection` forwarder, type only), `media-src/src/bridge/message-router.ts`, `media-src/src/nav/outline-move-routes.ts`, `media-src/src/boot/main.ts` (signature only) and the label field in the existing route (b) tests. Checks: the same Vitest command (all pass), `npm run typecheck`, `node build.mjs`, the wrapper run of the new spec (both cases pass).
- P2-S3 closure. Write the Task 673 record. Update this record (status, acceptance boxes, verification). Run the quality stages individually: `npm run check:brand-identifiers`, `npm run lint:ci`, `npm run knip`, `npm run jscpd`, `npm run depcruise`, `npm run test:coverage`, `npm run check:coverage-modules`. The audit stage is omitted in this queue.

## Verification run (2026-11-01)

- Vitest (route, router, outline-tree, editor-session, active-panels and section-move suites): 469 passed. The 8 first RED tests failed before the change; the review repair added 9 more RED tests (stale tree items, refresh signature, same-label headings, heading count, router index/count) that failed on the first candidate and pass now.
- Real VS Code, `outline-native-drop-after-typing.spec.ts`: 2 passed (shifted case RED before the change, instrument conditions valid in both runs; after the repair both cases also assert that the webview received the drop and that no move was prepared when it was refused). `outline-reorder.spec.ts:15` and `:187` fail at Redo as before the change (Task 669).
- Quality stages: `check:brand-identifiers`, `lint:ci`, `knip`, `jscpd`, `depcruise` and `typecheck` exit 0. Unit coverage: 381 files, 8272 tests passed (1 expected fail); the coverage-module ratchet passes (9 modules at 0%, baseline 9). `check:bundle-size` exits 1 on the existing budget excess (reporting only); `media/dist/main.js` is 1,115,777 B.
- Not run: the aggregate `npm run quality` (audits omitted), IR/WYSIWYG Chromium e2e (no webview DOM behaviour changed; the webview change is message validation and identity matching).

## Decisions

- Provisional decision (2026-11-01), reversible: route (b) identities are `{start, level, label}`, matched strictly on the acquired text, refused silently, with the host refusing a stale target. Selected by a recorded decision check (probability 0.78). Extended after the independent review by the next two decisions.
- Provisional decision (2026-11-01), reversible: D6 is not fixed here; the baseline change is Task 673. Selected by a recorded decision check (probability 1.0).
- Provisional decision (2026-11-01), reversible: the refusal is silent and the new spec is a separate file because `outline-reorder.spec.ts` fails earlier on this base.
- Provisional decision (2026-11-01), reversible: the tree item keeps the label the user saw (`HeadingItem.label`, taken with `sourceHeadingLabel` when the item is built), the drag carries it, and `handleDrop` refuses unless the heading at the resolved offset still has that label, for the dragged and the dropped item; the tree refresh signature includes the offset. Reason: VS Code keeps old items after published typing shifts offsets but not lines, and a label taken from the current text always matches itself. Selected by a recorded decision check (probability 0.97).
- Provisional decision (2026-11-01), reversible: `move-outline-section` identities also carry `index` (position among the headings) and `count` (heading count) on the host text; the webview requires the same position and count on the acquired text, because equal headings share a label and equal-length sections shift onto each other. Selected by a recorded decision check (probability 0.97).
- Provisional decision (2026-11-01), reversible: the drag also carries the tree item's heading position and `handleDrop` requires the heading at the resolved offset to have that position (and the dropped item's position), because stale items of equal headings share a label; the item's source label has its own field (`sourceLabel`) so the displayed tree text stays the heading text. Selected by a recorded decision check (probability 0.97).

## Residuals

- D6 is unmeasured live until Task 669 repairs SV Format table (Task 673).
- `table-format.spec.ts:12` fails on this base (SV Format table is a no-op); it belongs to Task 669.
- A refused drop gives the user no feedback.
