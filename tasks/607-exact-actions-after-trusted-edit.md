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
- The two builds gave the same results (logs `cls-pre2.log` on `8c2ec1f0` and `cls-head1.log` on `0138a286`). The first pre-580 run (`cls-pre1.log`) used Bold instead of Italic; its IR test case gave the same `stale` result, and its WYSIWYG test case failed in setup.
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
- Move Block (from Task 622): Vitest that after a trusted edit and an Undo that restores the exact text, `snapshotPair().exact` equals the host text or the block-action request falls back to a proven mapping, and that the host's `stale` decision is unchanged for real mismatches. Chromium: Move Block after an edit and its Undo moves the block, and one Undo restores it. Real VS Code (build first, `--retries=0`, OS-level XTEST): the four test cases in the table above in IR and WYSIWYG, plus Move Block Up, checking exact host text and one-step Undo.

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
- Task 622: its evidence predates Tasks 601/602; re-measure on HEAD first. If it does not reproduce, its test cases become GREEN regression tests.
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

**Positive controls.** Every normalizing cell checks that the rendered serialization differs from the source and that the trusted edit reached the host; the Move Block test cases check that the edit, the Ctrl+I and its Undo reached the host. All passed in all four runs; a cell that could not measure would carry a `measurementError` (none did).

**Result on HEAD 6862d15e (two identical full runs: 4 tests, 4 failed as designed; cells below):**

| Cell (IR and WYSIWYG give the same result)                                  | Result | Evidence                                                                                                                                                                                                                                                                                                                              |
| --------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| type+Turn Into, paste+Turn Into                                             | RED    | Webview posts `edit` `exact: true` with the whole normalized document; host after = 323-325 characters; changed interval starts at the table (offset 62-70), span is 33 characters at offset 238-239; host differs from the intended result; one Undo does not return the reference (host 320-322 characters instead of 303-304)      |
| type+Find Replace One, paste+Find Replace One                               | RED    | Same: `exact: true` whole-document post; interval 62-70 to 277-278 against an 8-character span at 273-274; one Undo does not return the reference (a first, earlier IR run of the typed test case did return it once; the two final runs did not)                                                                                  |
| type+table Insert Row Below, paste+table Insert Row Below                   | GREEN  | Webview posts `exact: false`; changed interval lies inside the table span; one pipe line added; disk equals host; Undo returns the reference; Redo returns the result. Measured, not reproduced: this action's bytes stay inside its span. The webview's own exact source differs from the host here (recorded, 1-3 characters fewer) |
| Move Block Down and Up, fresh                                               | GREEN  | Outcome `applied`; moved exactly; one Undo restores the exact source; Redo re-applies                                                                                                                                                                                                                                                 |
| Move Block Down and Up after Ctrl+I, 1.2 s, Ctrl+Z                          | RED    | Outcome `stale`, no `prepare-block-action`; host stays at the exact 224 characters; webview `before` is 236 (IR) or 234 (WYSIWYG) characters, host 224, differing from offset 168 (IR) or 187 (WYSIWYG)                                                                                                                               |
| Move Block Down and Up after a typed edit (no Undo), after a pasted edit    | RED    | Outcome `stale`; webview `before` is 12 (IR) or 10 (WYSIWYG) characters longer than the host (237-238 or 235-236 against 225-226), differing from offset 169-170 (IR) or 188-189 (WYSIWYG)                                                                                                                                            |
| A real mismatch (valid captured request replayed with a different `before`) | GREEN  | Outcome `stale`, host unchanged (224 characters, same hash)                                                                                                                                                                                                                                                                           |

**Findings and notes.**

- Task 622 reproduces on HEAD in both modes for Down and Up; the dirty-state difference it recorded does not (after Ctrl+I, Undo the host is clean in both modes). It is not specific to Undo: a plain typed or pasted edit with no Undo gives `stale` as well, because the webview `before` is the rendered serialization, which differs from the host text on this document after any trusted input. The difference starts in the task-list item (IR) or the table (WYSIWYG) of the fixture and ends inside the table, while the fresh document serializes identically.
- Move Block Up from `moveword paragraph`, whose previous block is a list, sends no request in either mode, even on the fresh document (host unchanged, only `editor-action`). Up therefore uses the caret in `after paragraph`, which swaps the same two paragraphs as Down from `moveword paragraph`. The list-neighbour case is recorded as a measurement-only test case, not asserted, and is a separate observation (no Task 607 contract).
- After Turn Into and Find Replace the native Undo does not return the reference because the host text already holds the whole-document normalization (the first Undo returns a text 17-18 characters different from the reference); the table action behaves as expected. These Undo test cases follow the existing grouping and assert only the contract line that one Undo restores the pre-action host text.
- Host, disk and the webview exact source agree after Turn Into and Find Replace only because the whole normalized document was written.

**Not covered in S1:** a Turn Into or table action run immediately after typing, before the edit is published (D3's local-rebase case); other exact-edit entry points (D5/D6); CRLF; the large synthetic fixture; Split View; unit and Chromium layers. Repair, host guard and the other design work are not started.

**Checks:** `node build.mjs` exit 0; `npx biome check` on the spec and `npx tsc -p test/vscode-e2e/tsconfig.json` clean; `npx playwright` through the real-VS-Code script: exit 1 with 4 failed, 0 passed, by design (RED).

## S2b contract (settled 2026-10-14, read-only design consultation)

- **Verified entry points.** Ownership is revoked in `media-src/src/bridge/edit-sync.ts` `markUserInput(true)`; `snapshotPair` then hands out the normalized rendering as exact when no pair exists and on a rendering mismatch; `postExact` sends no `before`; the host writes exact edits verbatim (`src/writeback/writeback-controller.ts` `syncToEditor` exact branch; `applyOnce` re-checks only equality); history `consumeEdit` never consumes exact edits; Move Block's guard compares raw text; Move Block settles then snapshots, and its rollback is `setValue(host content)` plus the table-undo restore; every `snapshotExactMarkdown() ?? getValue()` fallback in `boot/main.ts` and `boot/vditor-init.ts` fails open on a nullable exact.
- **1. EditSync state.** `hostBase` (the bytes the host holds, in queue order: set at creation, on reseed, on `postExact`, on adopted authority and on a refusal rollback; cleared by any plain edit post); `remembered: {exact, rendered|null}` (written when `markUserInput(true)` revokes a pair); `ownedBase` (base of the last owned pair returned; cleared by trusted input and plain posts, kept across an action's own `setValue`).
- **2. `snapshotPair(): { exact: string | null; rendered: string }`.** A non-null `exact` comes only from (a) the current pair with an unchanged rendering, (b) `remembered` (rendering equal, or `renderedFromExact(remembered.exact, rendered)` when its rendering is unknown), or (c) the D3 rebase, only when `remembered.exact === hostBase` (typing not yet published). Otherwise `null`; rendered bytes are never promoted to exact (including a mode started without initial markdown). `snapshotExactMarkdown(): string | null` follows the same rules.
- **3. D3 rebase (one span).** R0 = `remembered.rendered` ?? `serialize(render(E0))`; take the single common prefix/suffix span [p, q) of R0 vs R1; anchor it in E0 by an identical prefix or suffix; E1 = E0 with that span replaced by R1's; accept only if `renderedFromExact(E1, R1)` holds, else `null`. Two edits with normalized bytes between them always decline.
- **4. Authority seam.** `acquireExactAuthority(opts?: { publish?: boolean }): Promise<{exact, rendered} | null>`: owned and not `publish` → resolve at once; otherwise settle (flush) and post `{command: 'request-exact-authority', requestId}`; one request in flight; 1,500 ms timeout → `null`. `receiveExactAuthority({requestId, content})` ignores stale ids; proof in EditSync: the current rendering equals the rendering at request time, no trusted input since, and `renderedFromExact(content, rendered)` (SV: EOL-normalized equality); success sets the pair and `hostBase = ownedBase = content` and advances the revision. Move Block calls it with `publish: true` and never uses a rebased pair.
- **5. Host reply.** `request-exact-authority` is queued on the edit message chain and answered with `{command: 'exact-authority', requestId, content: document.getText()}` (no version field; INV-B compares text).
- **6. INV-B host guard.** `syncToEditor(…, expectedBefore?)` returns `'written' | 'unchanged' | 'refused'`; for an exact edit: EOL-normalized content equal to the host → `'unchanged'` (keeps history replays safe); missing `before` or normalized `before` ≠ host → `'refused'`; the check repeats inside the apply turn just before the edit. A refusal posts `{command: 'exact-edit-refused', requestId?, content: document.getText()}`. Plain edits unchanged.
- **7. `postExact(content, opts?: { rollback?; before? })`.** Stamps `before = opts.before ?? ownedBase` and a `requestId`; with neither, it sends no `before` and the host refuses — never a silent write. Keeps the pending-typing cancel that makes D3's combined write work (content = E1 plus the action, before = E0).
- **8. Refusal (D2).** `receiveExactRefusal({requestId, content})` acts only for the latest exact request: if no plain edit followed, roll back as Move Block does (apply mode, `setValue(content)`, table-undo restore when a rollback handle exists, drop that action's document-history entry, reseed exact = content, cancel pending typing); if a plain edit followed, leave the DOM and clear the pair, `hostBase` and `ownedBase` so the next action must acquire.
- **9. Callers.** Covered actions acquire before planning and pass `rollback` (Turn Into at bookmark creation, so the palette opens after acquisition; table actions; Find Replace — its action plan becomes async; Move Block, recomputing units after acquiring); `null` → decline with no DOM change and no post. Display consumers fail closed on a `null` exact (source block index: no units, handle hidden; Find source: no matches; selection source proof: unavailable; Turn Into bookmark: invalid; message-router history: none; preview: rendering for display only); the source index and Find each start one background acquire on `null`. The `??` fallbacks in `boot/main.ts` and `boot/vditor-init.ts` pass `null` through. Callers outside this task keep `postExact(content)` under rule 7 (callouts, Details toggle, inline picture, link popover, list normalize, named anchor, selection links, table format, outline move, exact-history sync); the history replay passes `before` from its record (`afterExact` for Undo, `beforeExact` for Redo).
- **10. Protocol.** `edit` gains `before?` and `requestId?` (exact edits only); new webview message `request-exact-authority {requestId}`; new host messages `exact-authority {requestId, content}` and `exact-edit-refused {requestId?, content}`; shape tables in `src/webview-host/webview-message-shape.ts` and `media-src/src/bridge/message-router.ts`; host and webview handlers routed to `editSync.receiveExactAuthority` / `receiveExactRefusal`. The Move Block host guard is unchanged.
- **Decisions (provisional, reversible; Owner asked about 1).** (1) After typing is published on a document whose rendering differs from its source, the block handle and Find show nothing until an authority round trip completes (a background acquire starts immediately) — a display gap, not a byte change; accepted provisionally, cost measured on large documents in Part 2. (2) A history replay the host refuses keeps the DOM and only drops ownership (rolling back would change visible Undo behaviour, reserved for the Owner). (3) D2's rollback discards typing done while a refusal is in flight (milliseconds; same as Move Block) — accepted. (4) Callers outside this task that plan on the rendering now refuse and roll back after a trusted edit instead of writing normalized bytes (D5); their planning fix is Task 630.
- **Split.** S2b-1 (core: rules 1–8 and 10, display consumers failing closed, the `??` fallbacks, history replay `before`) runs in a separate implementation session for the shared exact-ownership layer; S2b-2 (the four covered actions' acquisition and rollback wiring, rule 9) follows as its own step.

## Execution progress — 2026-10-14 (S2b)

Step S2b is the shared exact-ownership layer (S2b-1) plus the four covered actions (S2b-2). Neither part has been run through the Chromium S3-style test cases yet; CRLF, the large synthetic fixture, Split View and the other `postExact` entry points (D5/D6) are not covered.

### S2b-1 — core (commit `1d8e37a9`)

The core is implemented per the S2b contract (rules 1-8 and 10): `snapshotPair()` and `snapshotExactMarkdown()` return `null` instead of promoting rendered bytes; `acquireExactAuthority`, `receiveExactAuthority`, `receiveExactRefusal`, `setActionApplying` and `postExact(content, { rollback?, before? })` in `media-src/src/bridge/edit-sync.ts`; the host guard (`syncToEditor(…, expectedBefore?)`, `request-exact-authority`, `exact-authority`, `exact-edit-refused`) in `src/session/editor-session.ts` and `src/writeback/writeback-controller.ts`; display consumers fail closed on a `null` exact; string-typed consumers received `legacyExactMarkdown`/`legacyPair` fallbacks until their own task. Two review-driven repair rounds followed the first implementation:

- streaming suppression keeps no owned base (a streamed or host-driven rebuild never leaves a base that a later action could post against);
- typing is published before a refused action is rolled back, so the host text a refusal restores to still holds that typing;
- a remembered exact pair is recalled only when it matches the host text;
- an in-flight authority request is released when an exact post or a rollback replaces the document it was asked for;
- every waiter has a timeout (background waiters included);
- the host validates the fields of an exact edit and of an authority request before it uses them.

### S2b-2 — the four covered actions

Each action takes the owned exact bytes, or acquires authority before it plans. Owned: no request. Not owned: typing is settled and one `request-exact-authority` is sent. `null` (no proof, timeout): the action declines with no DOM change and no post. After the wait every action re-checks that its editor, table, selection or open Find widget is still the one that asked.

- **Turn Into** (`media-src/src/editing/block-transform-command.ts`): `requestBlockTransformOptionsAcquiring` is the palette's entry (`media-src/src/bridge/message-router.ts` routes `request-block-transform-options` through it), so the palette opens after acquisition. The bookmark is planned on the acquired bytes; a selection that moved during the wait drops the request. `applyBlockTransformChoice` passes a rollback handle that restores the Undo stacks. The source-index handle entry and the bubble menu stay synchronous and fail closed (no handle or bubble is shown without an owned source); the legacy `snapshotExactMarkdown` fallback is gone and the bookmark paths guard `null`.
- **Find Replace** (`media-src/src/editing/selection-scope.ts`): the action plan is acquired before it runs; owned bytes plan at once. Find's display no longer receives the legacy pair (`media-src/src/boot/finish-init.ts`): without an owned source it shows no matches and starts one background acquire. When the source is not owned at the first Replace, the request only brings the host bytes and refreshes the matches; the replacement needs a second activation on matches the user can see. The rollback handle restores the Undo stacks.
- **Table actions** (`media-src/src/editing/table-actions.ts`): `commitTableTransform` (moves, rectangle clear, rectangle operations) plans on owned bytes at once, or acquires and then runs once more against the live editor, which re-derives every identity; the key or click is consumed while the request is in flight. The rollback handle restores the Undo stacks and the logical cell. The table-format command is a separate entry point and keeps its fallback for Task 630. Clipboard copy of a rectangle never waits; without an owned source it returns no Markdown form.
- **Move Block** (`media-src/src/editing/block-action-client.ts`): `requestBlockAction` always acquires with `publish: true` (typing published, the host's bytes, never a rebased pair), recomputes the block units on those bytes after checking them against the basis its offsets came from, and keeps the existing two-phase rollback; one request at a time while it waits. The keyboard move (`vmde.moveBlockUp`/`Down`) resolves its block from units, which do not exist without an owned source, so `media-src/src/nav/block-handle.ts` pulls the host bytes first (`acquireBlockActionAuthority`, wired in `finish-init.ts`) and then plans the move once.

### Checks

- Unit tests added per action: owned (no request), not owned (settle and one request), `null` (decline, no post, DOM unchanged), refusal (Undo stacks restored), liveness after the wait. Turn Into is tested on the real EditSync and the real Lute projection of a normalizing document, with the host bytes proven and the table left unnormalized in the post. Full Vitest: 338 files, 6361 tests passed (1 expected fail). Webview typecheck, lint, knip and dependency-cruiser: clean.
- Chromium: the block-transform, find-replace, table, turn-into, block-handle, selection-bubble and structural-selection specs: 147 passed, 3 failed. `find-replace.spec.ts` "Task 599: an SV close…" and `table-hotkey.spec.ts` "the move commands move the caret cell…" (a 5 s poll, failing in IR on one run and WYSIWYG on another) fail identically on the commit before this step, so neither comes from this change.
- Real VS Code, `exact-actions-after-trusted-edit.spec.ts` (OS-level keys, one worker, no retries): 4 of 4 tests pass, every cell GREEN in IR and WYSIWYG. Turn Into and Find Replace after typed and pasted edits change only their span; the table Insert Row cells stay GREEN; Move Block Down and Up after Ctrl+I plus Undo, after a typed edit and after a pasted edit are `applied` (two authority replies: the keyboard move's, then the request's), fresh moves are unchanged apart from one authority reply, and a real mismatch still answers `stale` with the host unchanged.

### Notes and residual risks

- Move Block carries the exact text its offsets were computed from (the basis). If the host bytes pulled for the request differ from it, the old offsets are never reused: the keyboard move is re-derived from the live caret on the host bytes (or declines when the caret left the block layer), and the handle drag, menu Delete and Duplicate decline with no request.
- The table actions consume the key or click while the authority request is in flight and decline silently when authority is refused. This is fail-closed and accepted.
- Real-VS-Code Move Block test cases are intermittent in this step: across repeated runs of the Move Block tests a single test case now and then fails with "one Undo does not restore the host text from before the move" (the move itself is `applied`), or once with no request at all. The Undo flake also appeared with the basis check disabled (1 of 3 runs), so it does not come from the basis change; its cause (native Undo after a block action versus the history replay guard) is not yet found and needs its own probe.
- Chromium `find-replace.spec.ts` "Task 599: an SV close selects the match and keeps the SV toolbar state" fails on the commit before this step as well; it is not caused by this change.
- A refused action leaves its document-history record in place; the restored Undo stacks make that record unreachable, so it has no effect.
- Move Block now costs one authority round trip on a fresh document (two after an edit).
- Not yet done: Chromium test cases per action after a trusted edit (S3), the other `postExact` entry points (Task 630 and D5/D6), CRLF, large documents.

## Execution progress — 2026-10-14 (S3)

Step S3: Chromium test cases per exact action after a trusted edit. Tests only; no product edit.

**File:** `media-src/e2e/exact-actions-after-edit.spec.ts` (48 test cases). It runs the real webview entry (the `shortcut-negative` harness, `main.ts` with the shipped Vditor patches) against a small host model in the spec. The model answers with the extension host's own pure modules (minimal-diff write-back, history coupling, block-move planner) and applies the exact-edit rules: an exact edit is written only while its `before` equals the host text, otherwise it is refused with `exact-edit-refused`; `request-exact-authority` is answered with the host text; the model keeps native Undo steps, one per host write. No harness helper was added or changed. `HOST_GUARD=0` selects the host model of the commit before the exact-ownership work (exact edits written as posted, no authority reply, no refusal), so the same spec runs against that commit.

**Document.** A generic normalizing source: setext heading, `__strong__`, `*` bullets with a nested item, a repeated-number ordered list, a table with unaligned pipes and a trailing-space paragraph. Every case first checks that the rendering differs from the source. The reference for each case is the host text after the trusted edit (insert-only: a typed key or a pasted two characters, which each case checks).

**Test cases and the item each proves**

| Test cases | Count | Proves |
| --- | --- | --- |
| Turn Into, Find Replace one, Find Replace all, table Insert Row Below, table Move Row Down, Move Block Down, Move Block Up; each after a typed edit and after a pasted edit; IR and WYSIWYG | 28 | Acceptance 1 (only the intended span changes; the result equals the intended text where the contract gives one), 2 (no normalized bytes written), 3 (one Undo restores the host text from before the action). Insert Row posts a plain edit; Move Row Down posts a guarded exact edit |
| Move Block Down and Up after an edit (Italic) and its Undo; one Undo restores the document; IR and WYSIWYG | 4 | Acceptance 4 (the Task 622 case) |
| Turn Into, Find Replace one, table Move Row Down and Move Block Down with the host text changed just before the action's edit or request is handled; IR and WYSIWYG | 8 | Acceptance 5 and 7: nothing is written for the action, the webview takes the host text back (the action's result is absent), its exact source is the host text or unowned (decision D2 rollback) |
| Replace All whose matches surround the typed or pasted edit; IR and WYSIWYG | 4 | Edge case: the edit inside the replaced span survives; only the matches change; one Undo restores the reference |
| Turn Into and Move Block Down immediately after a typed key, before the 250 ms publication; IR and WYSIWYG | 4 | Edge case (decision D3): the key and the action are written together, or the action declines with no write and no DOM change, never other bytes |

**Results on HEAD** (`xvfb-run -a npx playwright test e2e/exact-actions-after-edit.spec.ts --workers=1 --retries=0`, from `media-src`): 48 passed.

**Results on the commit before the exact-ownership work** (`5db51f21`, built in an ignored scratch tree, same spec, `HOST_GUARD=0`): 44 failed, 4 passed. The 4 passes are Insert Row Below after a typed or pasted edit in IR and WYSIWYG, which posts a plain edit, so its bytes stay inside the table (the same as the real-VS-Code measurement in S1). Failure causes: Turn Into, Find Replace one and all, and Move Row Down change bytes outside the span (the whole normalized document is posted as exact); Move Block Down and Up never apply (`stale`); the forced-difference cases write the old host's verbatim exact edit over the outside change; the edge cases fail for the same reasons.

**Observation (D3).** Turn Into run immediately after typing in IR declines (no combined write); in WYSIWYG it writes the key and the action together. The case accepts both outcomes, as decision D3 allows, and checks that a declined action stays declined.

**Not covered in S3:** CRLF, the large synthetic fixture, Split View, other exact-edit entry points, and the keyboard-key Undo path of a real VS Code (the model's Undo is the command route that the keybinding posts). Real-VS-Code behaviour stays covered by the S1 spec.

**Checks:** `npm run typecheck` exit 0; `npx biome check` on the spec clean.

## Execution progress — 2026-10-14 (S4)

Step S4: the real-VS-Code spec `test/vscode-e2e/exact-actions-after-trusted-edit.spec.ts` (4 tests, 36 cells in total in IR and WYSIWYG) run against HEAD. Spec change only; no product edit.

**Method.** Real VS Code 1.129.0 on a private X11 display with a key-binding-free window manager, OS-level XTEST keys (`docs/os-keyboard-testing-setup.md`), after `node build.mjs`, one invocation at a time, `--workers=1 --retries=0`.

**Runs of the S1 spec.** Run 1 (the spec unchanged): 4 passed (9.8 min). Then the diagnosed test fix was applied: after OS Ctrl+Z and Ctrl+Y the host text is polled up to 6 s for the expected state (`UNDO_SETTLE_MS`), with the same assertions; no assertion changed and no retry was added. Run 2 (with the fix): 4 passed (10.1 min), `failed=0` in all four groups. The intermittent late-Undo failure of S2b did not appear in either run, so the poll is a guard that was not observed to be needed.

**Acceptance coverage.**

| Item | Where it is proven |
| --- | --- |
| 1 and 2 (only the intended span changes, no normalized bytes written) | Normalizing test, 6 cells per mode (type and paste, each with Turn Into, Find Replace, table Insert Row): bytes outside the action span unchanged; Turn Into and Find Replace equal the intended text; the table gains one row |
| 3 (host, saved bytes and Undo/Redo agree) | Normalizing test: Save, then the file read equals the host after the action; one Undo restores the host text from before the action; Redo restores the result. Added in S4 for Move Block: after the move, one Undo and one Redo, Save, then the file read equals the host (16 cells in total with a move: fresh, after Ctrl+I plus Undo, after typing, after paste; Down and Up; IR and WYSIWYG) |
| 4 (Move Block Down and Up after an edit and its Undo) | Move Block test cells `move-down-bold-undo`, `move-up-bold-undo` (and after typing and after paste): outcome `applied`, the moved text is exact, one Undo restores the reference |
| 5 (a real mismatch still answers `stale`) | Cell `move-real-mismatch-stale`: a replayed request with a different `before` answers `stale`, host unchanged |
| 6 (fresh-document Move Block and its one-step Undo unchanged) | Cells `move-down-fresh`, `move-up-fresh` |
| 7 (an edit that cannot be rebased or bounded fails closed with no write) | Not added here; covered by the forced-difference and refused cases of the Chromium spec (S3, Acceptance 5 and 7). No real-VS-Code state fits it in one or two assertions |

**Other real-VS-Code specs run** (they drive the four covered actions and import files changed by the exact-ownership commits): `block-transform.spec.ts`, `find-replace.spec.ts`, `table-operations.spec.ts`, `block-handle.spec.ts`, `turn-into-non-round-trip.spec.ts`. Result: 33 passed, 3 failed.

- `table-operations.spec.ts:48` (WYSIWYG markdown of the cell-rectangle test: `| r0a | r0b |` against `| r0a  | r0b  |`) and `:242` (the WYSIWYG range transaction never became ready, mode stays IR): both fail identically on the tree before the first exact-ownership commit (`1d8e37a9^`, built in an ignored scratch tree and removed afterwards). Not caused by this task.
- `block-handle.spec.ts:364` (handle Duplicate and Delete): **regression from this task.** The test passes on the tree before `1d8e37a9` and fails in isolation on `1d8e37a9` (the core commit), on `65129734` and on HEAD. After Duplicate and a native Undo, hovering the last paragraph leaves `.vmde-block-handle` hidden for the full 30 s click timeout (`locator.click` on `block-handle.spec.ts:411`). A probe copy of the spec showed the webview's exact source is still owned at that moment (`__vmdeE2EExactMarkdown()` is a string of the document's length), so the handle is not hidden by the null-snapshot path alone; the cause is not yet found. Open for a repair step: unit and Chromium layers do not show it, only the real-VS-Code spec.

**Checks.** `npm run typecheck:vscode-e2e` exit 0; `npx biome check` on the spec clean.

**Not covered in S4:** CRLF, the large synthetic fixture, Split View, other exact-edit entry points, the list-neighbour Move Block Up case (measurement only), a Turn Into or table action immediately after typing (decision D3).

## Execution progress — 2026-10-14 (S4b)

Step S4b: repair of the `block-handle.spec.ts:364` regression found in S4 (handle Duplicate, a click and OS Ctrl+Z, then hovering `omega` leaves `.vmde-block-handle` hidden).

**Measurement.** A temporary probe (a copy of the spec and logging wrappers around the source index's `snapshotPair`, `acquireExactAuthority` and `resolveUnits` in `finish-init.ts`, both removed afterwards) logged the index key, the cached entry, EditSync's exact and rendered text and the handle state at each step in real VS Code with OS-level keys:

- After Duplicate and after the native Undo, EditSync owns no exact source (`__vmdeE2EExactMarkdown()` returns `null`; the rendering equals the host text).
- The hover on `omega` builds the index entry with `exact: null`: the entry caches `units: null` for its key and starts one background acquire (`media-src/src/nav/source-block-index.ts`, `resolvePairUnits`). The handle is hidden, as decision 1 allows.
- The acquire succeeds within the next probe read: the exact source is owned again and the revision advances. But nothing re-resolves the hover: the block handle reads the index only on `mousemove` (`media-src/src/nav/block-handle.ts`, `hover`/`hoverUnit`), and the index announces a revision change only when a consumer next calls `currentKey()`. With the pointer resting on the block (Playwright waits for the handle to become visible without moving the mouse) the handle stays hidden indefinitely. A second hover in the probe showed the handle at once (entry with 3 units).
- Before `1d8e37a9` the pair never had a `null` exact (the rendering was promoted), so the first hover already showed the handle; the regression is the missing end of the display gap, not the gap itself.

**Fix.** The source index keeps the promise of its background acquire and, when the reply is adopted, calls `currentKey()`, which emits the existing `revision` invalidation (`source-block-index.ts`). The block handle remembers a hover whose entry had no units and, on a `revision` invalidation, re-runs that hover once with the same liveness checks as a deferred hover (target still connected in the active root, no menu, drag, native selection or shown handle) (`block-handle.ts`). A reply that is not adopted announces nothing, so the handle stays hidden (fail closed). The background acquire dependency now returns EditSync's promise (`vditor-init.ts`, `finish-init.ts` types). No exact-ownership rule changed: units still come only from an owned exact source.

**Tests (Vitest).** `media-src/src/nav/block-handle.test.ts`: a resting hover shows the handle once the background acquire succeeds (failed before the fix: `expected true to be false`); a failed acquire keeps it hidden; a hover target removed before the reply shows nothing. `media-src/src/nav/source-block-index.test.ts`: an adopted reply is announced as one `revision` invalidation; a reply that is not adopted announces nothing. Without-fix checks: removing the announcement fails the adopted-reply index test and the resting-hover test; announcing a reply that was not adopted fails the second index test. The Chromium harness was not used: the cheapest layer that shows the defect is the block handle with a shared index whose acquire resolves later, which Vitest reproduces directly.

**Checks.** Vitest `block-handle.test.ts`, `source-block-index.test.ts`, `vditor-init.test.ts`, `find-source.test.ts`: 80 passed. `finish-init.test.ts`: 10 failures with `VDITOR_VERSION is not defined` from a Vditor internal import; the same 10 fail on an unmodified export of HEAD in the same layout (shared `node_modules` link), so they come from the test environment, not this change. `npm run typecheck` exit 0; `npx biome check` on the six changed files clean. `node build.mjs` exit 0. Real VS Code (OS-level XTEST keys, one worker, no retries): `block-handle.spec.ts` 15 passed (including `:364`); `exact-actions-after-trusted-edit.spec.ts` 4 passed, `failed=0` in all four groups.

**Residual risks.** A hover whose entry has no units for another reason (a projection rejection) also retries on each announced revision while the pointer rests on it; each retry reuses the shared entry when another consumer has already built it. Find's display also refreshes on the announced revision (it listens to the same invalidation); Find's own snapshot path (Split View source) is unchanged.
