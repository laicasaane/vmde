# Task 630 — Exact-source authority for the remaining postExact actions

**Status:** planned (2026-10-08). The Project Owner approved filing this record on 2026-10-08. Implementation has not started.
**Origin:** Follow-up of [Task 607](607-exact-actions-after-trusted-edit.md) Owner decisions D5 and D6.
**Severity:** medium (estimated).
**Tech stack:** extension host exact-edit path and session (`src/session/editor-session.ts`), webview action entry points, real VS Code with XTEST.
**Depends on:** Task 607.

## Problem

Task 607 adds a host guard: an exact edit carries `before` and is refused when the host text differs. That guard covers every `postExact` user. Authority acquisition (getting the exact source before the action) is wired only for Turn Into, Find Replace, table actions and Move Block. The other entry points still lack it.

## Evidence

Task 607 scope, as recorded in its decisions. Not re-measured here.

## Suspected cause (unverified)

For D6: after an exact action, typing may let the plain write, which is minimized against the disk baseline (`cleanBaseline`, set only at open and save in `src/session/editor-session.ts`), revert semantically neutral action bytes such as table-format padding. Needs a probe.

## Tests

- For each entry point below, a test that the action acquires authority and that a stale host is refused.
- Details toggle, list normalize, inline picture, link actions, named anchor, outline move, heading shift, rewrap selection.
- A probe for D6: run an exact action that adds neutral bytes (for example table-format padding), type, and compare host bytes to the action result.
- Real-VS-Code spec for the changed behavior, run under `xvfb-run` after `node build.mjs`.

## Acceptance

- [ ] Authority acquisition wired for: details toggle, list normalize, inline picture, link actions, named anchor, outline move, heading shift, rewrap selection.
- [ ] Each has a test, including the refused-when-stale case.
- [ ] D6 probe run and result recorded; fix filed or applied if the revert is confirmed.
- [ ] Focused real-VS-Code specs written and run; `npm run quality` passes.

Related: [Task 607](607-exact-actions-after-trusted-edit.md).

## Part 1 handoff (2026-10-14)

Read-only review of the source on `dev`; nothing was run. Task 607 is not implemented yet, so its authority API (acquire authority; exact post with `before`) is an assumed dependency. V = verified; I = inferred.

- **Entry points.** Details toggle (V: `media-src/src/editing/details-toggle.ts` plans on `snapshotMarkdown()` — rendered — and posts exact; I: on a normalizing document this posts normalized bytes for the whole document as exact even without a trusted edit). Inline picture (V: `editing/inline-picture.ts` plans on `snapshotMarkdown()` with an offset from `getCursorSourceOffset` over `getValue()`, posts exact; same exposure, I). Named anchor (V: `editing/named-anchor-insertion.ts` uses `snapshotMarkdown()` in IR/WYSIWYG despite its comment, captured when the dialog opens and applied on submit — a stale window across the modal). Link actions (V: selection bubble `editing/selection-link-actions.ts` and link popover `editing/link-popover.ts` plan on `snapshotExactMarkdown()` or the source-index pair; I: the bubble's projection proof passes trivially once a trusted edit makes exact equal rendered — the plain Task 607 N9 hole). List normalize (V: only the SV branch posts exact, `bridge/message-router.ts` → `editing/list-normalize-source-command.ts`; I: SV text is raw source, so the risk is unpublished typing and the missing `before`). Outline move (V): (a) webview reorder is host-planned with `applyExactGuarded` (`src/session/editor-session.ts`), but the webview check `exact !== message.before` returns silently (`boot/main.ts`) — no outcome, the pending promise never resolves and the host binding is never cleared (I: the Task 622 "stale" class after a trusted edit); (b) native outline-tree drag (`src/markdown/outline-tree.ts` → `editor-session.ts` → `move-outline-section` → `boot/main.ts`) plans webview-side on `snapshotExactMarkdown()` and posts unguarded with host-text offsets applied to the webview exact text (I: mismatch after a trusted edit). Not exact users (V): heading shift and selection Rewrap (`editing/rewrap-command.ts`) use the plain write; document Rewrap is already pull-based. Exact users not on the list (V): callout actions (`editing/callouts.ts`, plan on `getValue()` — rendered), emoji insertion (`editing/emoji-insertion.ts`, maps rendered offsets to exact), table format (`editing/table-format-command.ts`, exact snapshot), the exact-history replay (`boot/vditor-init.ts`, Task 602 area, out of scope). D6 mechanism (I): plain posts minimize against `cleanBaseline ?? currentText` (`src/writeback/writeback-controller.ts`), reset only at open and save, so neutral bytes left by an earlier exact action (e.g. table padding) can be reverted by the next typing — needs the probe below.
- **Contract (Task 607's mechanism for every action).** (1) Settle typing (as `settleBlockActionInput`); acquire authority through Task 607 (local rebase with proof, else a host `exact-authority` reply within about 1.5 s); else decline with no write and no DOM change. (2) Plan on the acquired exact text only; map DOM/rendered offsets into exact coordinates by proof (`captureRewrapSourceRange` then `mapCaretOffsetByLine` or `alignText`, as emoji insertion and SV list normalize already do); a failed mapping declines. (3) Re-check liveness after every await (owner, selection, mode, source revision). (4) Exact post with `before = acquiredExact`; a host refusal uses Task 607 D2's two-phase rollback; Undo grouping unchanged (Owner rule). (5) Dialogs (named anchor, inline picture) acquire on submit, not on open. (6) Outline (a) sends a stale/decline outcome and resolves the pending promise instead of returning silently. (7) Outline (b) goes through the host-planned handshake (the host owns the text and the offsets).
- **Part 2.** S1 RED (one per action plus a stale-host case; normalizing fixture, simulated trusted edit): the plan uses the acquired exact text and bytes outside the action span equal the host text; a host text differing from `before` gives no write and a rollback; a failed acquisition gives no write; plus fresh-document cases for Details, picture and anchor (no trusted edit, bytes outside the span stay exact). Files: `editing/{details-toggle,inline-picture,named-anchor-insertion,selection-link-actions,link-popover,list-normalize-source-command}.test.ts`, a testable helper for the `boot/main.ts` outline routes, host session tests for the outline outcome. S2 (one step per action, in order): Details toggle, inline picture, named anchor, selection-bubble link, link popover, SV list normalize, outline (a), outline (b); emoji insertion gets `before` and a test. S3: real-VS-Code `exact-authority-other-actions.spec.ts` (typing → action → Undo → save/reopen per action; host, disk and outside-span bytes by hash and length), extending `details-toolbar`, `inline-picture-editing`, `named-anchor-mode-fidelity`, `link-popover`, `list-normalize` (SV) and `outline-reorder` (both routes); `@probe` `exact-action-neutral-bytes-probe.spec.ts` for D6 (table-format padding, then typing elsewhere). S4: closure.
- **Edge cases.** CRLF documents; SV vs IR/WYSIWYG; Preview open; a modal left open while the host changes; reply timeout; an action during streaming or an extension update; documents above the minimal-diff cap (D6 cannot occur there); outline host binding cleanup on decline.
- **Decisions (orchestrator, 2026-10-14; reversible).** (1) Heading shift and selection Rewrap are dropped from this task's acquisition list (plain write; Task 606 owns their normalizing-document behaviour); regression tests only. (2) Callouts are added here; emoji insertion gets `before` and a test. Coordination with Task 606 S3 (which repairs Details and callouts when they fail by the marker-capture mechanism): whichever task runs first repairs the shared action, the other adds only its own step and regression tests. (3) The table format command is covered by Task 607's "table actions" — confirm there. (4) Details, picture and anchor writing normalized bytes without a trusted edit are fixed here under the same contract (the "no normalized bytes outside the span" rule). (5) D6, if confirmed by the probe, changes the plain-write baseline — offered to the Owner as a separate task, not fixed here. (6) Routing: per-action S2 steps stay on Sonnet 5.5 `high`; the offset-mapping actions (Details, picture, anchor) and the host-touching outline routes are flagged for the escalation ladder (consultation after two failed repairs).
- **Risks.** Everything depends on Task 607's unbuilt API; async acquisition makes click handlers async (focus and selection drift).
