# Task 622 — Move Block returns `stale` after an edit and its Undo

**Status:** planned (2026-10-05). The Project Owner approved filing this record on 2026-10-05. Implementation has not started.
**Origin:** Task 580 CP4-1 classification runs (2026-10-05). Pre-existing: identical on the pre-580 build `8c2ec1f0` (native Alt+Down handler) and on HEAD `0138a286` (`vmde.moveBlockDown` editor action).
**Severity:** medium. Move Block silently does nothing after any edit that the user undid. No source is lost.
**Scope:** IR and WYSIWYG Move Block (`vmde.moveBlockUp`/`Down`, Alt+Up/Down) and the block-action request/prepare handshake. The large-fixture hidden block handle is a separate, known limit recorded in [Task 604](done/604-turn-into-non-round-tripping-documents.md); it is not part of this task.

## Problem

On a document that round-trips exactly, Move Block moves the block on a fresh document. After an edit and its Undo, the same Move Block returns `stale`, and nothing moves.

## Measured evidence

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

## Reproduction

1. Open `shortcut-identity-exact.md` in IR or WYSIWYG.
2. Select `italicword`, press Ctrl+I, wait 1.2 s, press Ctrl+Z. The host is back to the exact source.
3. Put the caret in `moveword paragraph` and press Alt+Down. Nothing moves.

## Suspected cause

- The host answers `stale` before `prepare-block-action` only from `prepareBlockAction` (`src/session/editor-session.ts:576-603`). It requires `message.before === this.document.getText()` (`:592`) and a valid plan.
- The webview's `before` is `deps.snapshotExactMarkdown()` (`media-src/src/editing/block-action-client.ts:142`), which is `EditSync.snapshotPair().exact` (`media-src/src/bridge/edit-sync.ts:430-450`).
- A trusted edit calls `markUserInput(true)` (`edit-sync.ts:878-889`), which drops the exact transaction. `snapshotPair()` then returns Vditor's rendered serialization as "exact". After Undo, that rendered text probably differs from the host text, so the comparison fails. Unverified: log the lengths and hashes of `before` and the host text at the `stale` decision.
- The IR host stays dirty after Undo while WYSIWYG is clean, so the host/webview history coupling may also differ by mode.

Related records: [Task 607](607-exact-actions-after-trusted-edit.md) (exact-source ownership after a trusted edit; it covers Turn Into, Find Replace and table actions, not Move Block) and [Task 602](602-undo-step-spanning-host-edits.md) (host/webview Undo coupling).

## Owner decisions needed

- Fold this into Task 607's authority recovery (add Move Block to its covered actions), or fix it here first?

## Tests

- **Vitest:** after a trusted edit and an Undo that restores the exact text, `snapshotPair().exact` equals the host text, or the block-action request falls back to a proven mapping; the host's `stale` decision is unchanged for real mismatches.
- **Chromium:** Move Block after an edit and its Undo moves the block, and one Undo restores it.
- **Real VS Code** (build first, `--retries=0`, OS-level XTEST): the four legs above in IR and WYSIWYG, plus Move Block Up, checking exact host text and one-step Undo.

## Acceptance

- [ ] IR and WYSIWYG: Move Block after an edit and its Undo moves the block exactly on a round-tripping document (real VS Code).
- [ ] A real host/webview mismatch still returns `stale` and changes nothing.
- [ ] Fresh-document Move Block and its one-step Undo are unchanged.
