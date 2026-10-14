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

## Execution progress — 2026-10-14 (S1)

Step S1: RED reproductions per action after a trusted edit. Tests only; no product edit.

**Files:** `test/vscode-e2e/exact-actions-after-trusted-edit.spec.ts` (four tests: IR and WYSIWYG, each for the normalizing document and for Move Block), `test/vscode-e2e/fixtures/exact-actions-normalizing.md` (302 characters: a table with uneven padding and an alignment row, a starred and nested list, a repeated-number ordered list, plain paragraphs; its rendered serialization differs from its source in both modes). Move Block uses the existing round-tripping `shortcut-identity-exact.md` (224 characters). Per-cell evidence is written to ignored `tmp/607/s1-<mode>.jsonl`.

**Method.** Real VS Code 1.129.0, Linux X11 under a private virtual display with a key-binding-free window manager, OS-level XTEST keys (typing, paste, Ctrl+Z, Ctrl+Y, Ctrl+S, Alt+Down/Up, Ctrl+F/H, Ctrl+Shift+1), run after `node build.mjs`, one invocation at a time, `--workers=1 --retries=0`. Per cell the spec records host length and 12-hex-digit hash before and after, the changed interval of the host text, the intended span in the reference, whether bytes outside the span changed, the exact flag and length of every `edit` the webview posted, disk after Save, host after Undo and Redo, and for Move Block the host-to-webview message names and `block-action-outcome` statuses plus lengths and hashes of the posted `before` against the host text at the decision. No document text is printed or stored.

**Reference and contract (D1).** The reference is the host text after the trusted edit, which was insert-only in every cell (host = initial with the typed `x` or the pasted two characters at the caret, 303 or 304 characters). A cell asserts: bytes outside the action span unchanged; the host equals the reference with only the intended change (Turn Into: `## ` at the paragraph start; Find Replace One: the word replaced; table: one more pipe line and nothing outside the table); disk after Save equals the host; one Undo restores the reference and Redo restores the action result; Move Block applies after an edit and its Undo and moves exactly; a fresh move is unchanged with one-step Undo; a real mismatch answers `stale` and changes nothing. The webview's internal exact source is recorded but not asserted.

**Positive controls.** Every normalizing cell checks that the rendered serialization differs from the source and that the trusted edit reached the host; the Move Block cells check that the edit, the Ctrl+I and its Undo reached the host. All passed in all four runs; a cell that could not measure would carry a `measurementError` (none did).

**Result on HEAD 6862d15e (two identical full runs: 4 tests, 4 failed as designed; cells below):**

| Cell (IR and WYSIWYG give the same result)                                  | Result | Evidence                                                                                                                                                                                                                                                                                                                              |
| --------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| type+Turn Into, paste+Turn Into                                             | RED    | Webview posts `edit` `exact: true` with the whole normalized document; host after = 323-325 characters; changed interval starts at the table (offset 62-70), span is 33 characters at offset 238-239; host differs from the intended result; one Undo does not return the reference (host 320-322 characters instead of 303-304)      |
| type+Find Replace One, paste+Find Replace One                               | RED    | Same: `exact: true` whole-document post; interval 62-70 to 277-278 against an 8-character span at 273-274; one Undo does not return the reference (a first, earlier IR run of the typed leg did return it once; the two final runs did not)                                                                                  |
| type+table Insert Row Below, paste+table Insert Row Below                   | GREEN  | Webview posts `exact: false`; changed interval lies inside the table span; one pipe line added; disk equals host; Undo returns the reference; Redo returns the result. Measured, not reproduced: this action's bytes stay inside its span. The webview's own exact source differs from the host here (recorded, 1-3 characters fewer) |
| Move Block Down and Up, fresh                                               | GREEN  | Outcome `applied`; moved exactly; one Undo restores the exact source; Redo re-applies                                                                                                                                                                                                                                                 |
| Move Block Down and Up after Ctrl+I, 1.2 s, Ctrl+Z                          | RED    | Outcome `stale`, no `prepare-block-action`; host stays at the exact 224 characters; webview `before` is 236 (IR) or 234 (WYSIWYG) characters, host 224, differing from offset 168 (IR) or 187 (WYSIWYG)                                                                                                                               |
| Move Block Down and Up after a typed edit (no Undo), after a pasted edit    | RED    | Outcome `stale`; webview `before` is 12 (IR) or 10 (WYSIWYG) characters longer than the host (237-238 or 235-236 against 225-226), differing from offset 169-170 (IR) or 188-189 (WYSIWYG)                                                                                                                                            |
| A real mismatch (valid captured request replayed with a different `before`) | GREEN  | Outcome `stale`, host unchanged (224 characters, same hash)                                                                                                                                                                                                                                                                           |

**Findings and notes.**

- Task 622 reproduces on HEAD in both modes for Down and Up; the dirty-state difference it recorded does not (after Ctrl+I, Undo the host is clean in both modes). It is not specific to Undo: a plain typed or pasted edit with no Undo gives `stale` as well, because the webview `before` is the rendered serialization, which differs from the host text on this document after any trusted input. The difference starts in the task-list item (IR) or the table (WYSIWYG) of the fixture and ends inside the table, while the fresh document serializes identically.
- Move Block Up from `moveword paragraph`, whose previous block is a list, sends no request in either mode, even on the fresh document (host unchanged, only `editor-action`). Up therefore uses the caret in `after paragraph`, which swaps the same two paragraphs as Down from `moveword paragraph`. The list-neighbour case is recorded as a measurement-only cell, not asserted, and is a separate observation (no Task 607 contract).
- After Turn Into and Find Replace the native Undo does not return the reference because the host text already holds the whole-document normalization (the first Undo returns a text 17-18 characters different from the reference); the table action behaves as expected. These Undo cells follow the existing grouping and assert only the contract line that one Undo restores the pre-action host text.
- Host, disk and the webview exact source agree after Turn Into and Find Replace only because the whole normalized document was written.

**Not covered in S1:** a Turn Into or table action run immediately after typing, before the edit is published (D3's local-rebase case); other exact-edit entry points (D5/D6); CRLF; the large synthetic fixture; Split View; unit and Chromium layers. Repair, host guard and the other design work are not started.

**Checks:** `node build.mjs` exit 0; `npx biome check` on the spec and `npx tsc -p test/vscode-e2e/tsconfig.json` clean; `npx playwright` through the real-VS-Code script: exit 1 with 4 failed, 0 passed, by design (RED).
