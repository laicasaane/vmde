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
