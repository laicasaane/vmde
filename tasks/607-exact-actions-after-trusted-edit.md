# Task 607 — Preserve exact source for actions after a trusted edit

**Status:** planned (2026-09-29). Task 604 identified the broader N9 authority risk. The Project Owner ruled on the recovery boundary on 2026-10-08 (see Owner decisions) and merged Task 622 into this record; implementation has not started.
**Origin:** [Task 604](done/604-turn-into-non-round-tripping-documents.md), Checkpoint 2 N9 and Owner follow-up decision.
**Scope:** exact-source ownership after keyboard/paste edits across Turn Into, Find Replace, table actions and Move Block (`vmde.moveBlockUp`/`Down`, Alt+Up/Down, with the block-action request/prepare handshake; merged from Task 622). Do not change their individual action planners or treat rendered serialization as an exact baseline.
**Dependency:** coordinate with Task 602's host/webview Undo coupling and Task 196's exact Find authority.

## Problem and evidence

`markUserInput(true)` in `media-src/src/bridge/edit-sync.ts` revokes the prior exact seed. When the next snapshot takes Vditor's rendered serialization as exact, an action calling `postExact` can send the whole normalized document with `exact: true`; `src/writeback/writeback-controller.ts` then writes those bytes verbatim. On a document whose tables or lists normalize, this can change bytes outside the user's intended action. Task 604's N9 source audit identified the route; its trusted-edit controls did not establish a complete cross-action fix. Evidence: `tmp/queue-part1/604-cp2-4-handoff.md` N9 and Task 604's Checkpoint 1/2 diagnostics.

## Investigation and design boundary

1. Reproduce a trusted edit outside and near a normalizing region, followed separately by Turn Into, Find Replace and a table action. Compare pre-edit exact source, rendered bytes, edit span, host and disk by hashes/lengths and changed intervals; do not print fixture contents.
2. Trace when EditSync loses exact ownership, when the host accepts an exact post, and how native Undo groups the trusted edit and action. Separate an intended normalization of the edited span from any unintended change elsewhere.
3. Implement an authority recovery that rebases the trusted edit onto the prior exact source or proves a bounded replacement. Fail closed when the edit cannot be mapped. The Project Owner must decide any change that falls outside the boundary in Owner decisions (2026-10-08).
4. Coordinate the acceptance with Task 602 so a repair does not leave the host or native Undo out of step.

## Owner decisions (2026-10-08)

Approved in chat by the Project Owner.

- **Allowed without the Owner:** recover exact ownership by rebasing the trusted edit onto the prior exact source, or by proving a bounded replacement. If neither works, fail closed: the action declines and nothing is written.
- **Not allowed without the Owner:** changing how Undo groups the trusted edit and the action, or writing normalized bytes outside the edited span.
- **Move Block:** Task 622 is folded into this task (see below). Move Block joins the covered actions.

## Merged from Task 622 (2026-10-08)

Task 622 ("Move Block returns `stale` after an edit and its Undo", filed 2026-10-05, severity medium) is merged here. Move Block silently does nothing after any edit that the user undid; no source is lost. It is pre-existing: identical on the pre-580 build `8c2ec1f0` (native Alt+Down handler) and on HEAD `0138a286` (`vmde.moveBlockDown` editor action). Origin: Task 580 CP4-1 classification runs (2026-10-05). The large-fixture hidden block handle is a separate, known limit recorded in [Task 604](done/604-turn-into-non-round-tripping-documents.md); it is not part of this task.

### Measured evidence

Real VS Code 1.129.0, Linux X11, Xvfb + Openbox, OS-level XTEST keys, `--retries=0`. Fixture `test/vscode-e2e/fixtures/shortcut-identity-exact.md` (224 characters, round-trips exactly). Caret collapsed 2 characters into `moveword`, then Alt+Down.

| Mode | Prior steps | Host before Alt+Down | Host→webview messages after Alt+Down | Result |
| --- | --- | --- | --- | --- |
| IR | none (fresh) | exact | `prepare-block-action`, `block-action-outcome` `applied` | moved exactly |
| WYSIWYG | none (fresh) | exact | `prepare-block-action`, `block-action-outcome` `applied` | moved exactly |
| IR | Ctrl+I on `italicword`, wait 1.2 s, Ctrl+Z | exact, dirty | `block-action-outcome` `stale` only | unchanged |
| WYSIWYG | the same | exact, clean | `block-action-outcome` `stale` only | unchanged |

- On HEAD the message list also starts with `editor-action:move-block-down`.
- The two builds gave the same results (logs `cls-pre2.log` on `8c2ec1f0` and `cls-head1.log` on `0138a286`). The first pre-580 run (`cls-pre1.log`) used Bold instead of Italic; its IR leg gave the same `stale` result, and its WYSIWYG leg failed in setup.
- Evidence: session scratch logs from a temporary classification spec (`zz-cls580.spec.ts`) in a scratch worktree. Neither is committed; the numbers above are copied from them.

### Reproduction

1. Open `shortcut-identity-exact.md` in IR or WYSIWYG.
2. Select `italicword`, press Ctrl+I, wait 1.2 s, press Ctrl+Z. The host is back to the exact source.
3. Put the caret in `moveword paragraph` and press Alt+Down. Nothing moves.

### Suspected cause

- The host answers `stale` before `prepare-block-action` only from `prepareBlockAction` (`src/session/editor-session.ts:576-603`). It requires `message.before === this.document.getText()` (`:592`) and a valid plan.
- The webview's `before` is `deps.snapshotExactMarkdown()` (`media-src/src/editing/block-action-client.ts:142`), which is `EditSync.snapshotPair().exact` (`media-src/src/bridge/edit-sync.ts:430-450`).
- A trusted edit calls `markUserInput(true)` (`edit-sync.ts:878-889`), which drops the exact transaction. `snapshotPair()` then returns Vditor's rendered serialization as "exact". After Undo, that rendered text probably differs from the host text, so the comparison fails. Unverified: log the lengths and hashes of `before` and the host text at the `stale` decision.
- The IR host stays dirty after Undo while WYSIWYG is clean, so the host/webview history coupling may also differ by mode.

## Verification

- Unit tests for exact revision ownership, bounded changed spans, stale snapshots, CRLF and no-write decline.
- Chromium tests for each action after a trusted edit on a privacy-safe normalizing document.
- Built real-VS-Code XTEST tests for trusted typing/paste, action apply, OS Undo/Redo, exact host/save/reopen and bytes outside the intended span.
- Move Block (from Task 622): Vitest that after a trusted edit and an Undo that restores the exact text, `snapshotPair().exact` equals the host text or the block-action request falls back to a proven mapping, and that the host's `stale` decision is unchanged for real mismatches. Chromium: Move Block after an edit and its Undo moves the block, and one Undo restores it. Real VS Code (build first, `--retries=0`, OS-level XTEST): the four legs in the table above in IR and WYSIWYG, plus Move Block Up, checking exact host text and one-step Undo.

## Acceptance

- [ ] Trusted input followed by every covered exact action changes only the intended source spans.
- [ ] No path promotes unrelated normalized rendered bytes to exact authority or posts them as an exact edit.
- [ ] Host, webview, disk and native Undo/Redo agree on the final exact document.
- [ ] IR and WYSIWYG: Move Block (Down and Up) after an edit and its Undo moves the block exactly on a round-tripping document (real VS Code).
- [ ] A real host/webview mismatch still returns `stale` and changes nothing.
- [ ] Fresh-document Move Block and its one-step Undo are unchanged.
- [ ] An edit that cannot be rebased or bounded fails closed with no write.

## Part 1 handoff (2026-10-08)

Agent `opus-high` (Opus 5.5, requested effort high; runtime metadata unverified). Read-only; nothing built or run, so every runtime claim is unverified.

- Loss of ownership: a trusted `input` calls `markUserInput(true)` (`media-src/src/bridge/edit-sync.ts:889-901`), which drops the exact pair; `snapshotPair` then promotes Vditor's normalized serialization to exact authority (`:438`), and `postExact` posts `{exact: true}` without a `before` (`:932-946`). The host writes an exact edit verbatim (`src/writeback/writeback-controller.ts:357-359`). Plain typing is minimized against the disk baseline, so on documents up to 100,000 characters the host keeps untouched blocks' original bytes while the webview's exact text is normalized everywhere; the next Turn Into, Find Replace or table action then writes normalized bytes outside its span. Only Move Block has a host guard (`src/session/editor-session.ts:607-651`, `stale` when `before !== document.getText()`).
- Task 622: its evidence predates Tasks 601/602; re-measure on HEAD first. If it does not reproduce, its legs become GREEN regression tests.
- Design: INV-A in EditSync (an action plans only on an owned pair: exact bytes reported by the host or posted by this webview, tied to the current rendering by identity, the Lute projection proof `renderedFromExact`, or a remembered owned pair); INV-B in the host (an exact edit carries `before` and is written only when the host text equals it, EOL-normalized). Recovery is pull-based: the action settles typing, requests `exact-authority` from the host, and adopts the reply only with proof; otherwise it declines with no write. Optional local rebase for unpublished typing (common prefix/suffix mapped by `alignText`, proven by `renderedFromExact`).

### Owner decisions (2026-10-08, chat)

- D1: the reference for "only the intended span" is the host text after the trusted edit (today's plain-typing write path unchanged).
- D3: typing not yet published at action time: rebase locally with proof (keeps today's combined host write), else the action declines with no write. No Undo-grouping change.
- D2: when the host refuses a guarded exact write, the webview reverts the action with Move Block's two-phase rollback; webview Undo history is kept.
- D5/D6 scope: the host guard (INV-B) protects every `postExact` user now; this task adds authority acquisition and tests only for Turn Into, Find Replace, the table actions and Move Block. A follow-up task covers the other `postExact` entry points (details toggle, list normalize, inline picture, link actions, named anchor, outline move, heading shift, rewrap selection) and the suspected revert of neutral action bytes by later typing (D6 probe).
- D4 (orchestrator): bounded wait of about 1.5 s for the authority reply, then decline.
