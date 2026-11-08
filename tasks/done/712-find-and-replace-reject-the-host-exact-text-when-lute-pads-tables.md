# Task 712 — Find and Replace reject the host's exact text when Lute pads tables

**Status:** ✅ done (2026-11-08).
**Origin:** Split from [Task 698](698-key-and-chord-results-differ-in-xtest-specs.md) at its closure (Part 2c, `shortcut-identity.spec.ts:877` and `:900`).
**Severity:** high (estimated). In a document with an unpadded table, after one edit and Undo, Find shows "No results" for text that exists (SV) and Replace All changes nothing (WYSIWYG).
**Tech stack:** `media-src/src/editing/find-source.ts:128-135`, `media-src/src/bridge/edit-sync.ts:1322-1338` and `:625-633`, `media-src/src/bridge/sv-source-relation.ts:249`; Task 607 exact ownership.
**Depends on:** none.

## Problem

Bisected in Task 698 Part 2c: first bad commit `1d8e37a9` (fix(607): keep exact ownership through trusted edits and guard exact host writes); last good `374df74c`. When the editor no longer holds an exact copy of the source, Find returns no results and asks the host for its exact text. That reply is used only if the host text maps exactly to what the editor shows.

- Large SV, measured: the host reply had 174517 characters; the SV text had 181846 (Lute table padding from offset 74). Find stayed at "No results". Which check inside the comparison rejects the reply is not measured.
- Small WYSIWYG, measured: after Replace One and Undo, Replace All sent the request. The reply had 224 characters against 234 in `getValue()` (table padding at offset 187); nothing was replaced.

Repro: in SV, open a file with an unpadded table, make and undo one edit, then press Ctrl+F for a word in the file.

## Proposed work

1. Measure which check rejects the reply (SV and WYSIWYG).
2. Write a failing test first (Vitest at the relation or edit-sync level).
3. Fix so a host reply that differs only by Lute's normalization (for example table padding) is still usable for Find and Replace, without weakening the Task 607 exact-write guard. Decide with evidence which side maps to which.

## Acceptance

- [x] The rejecting check is measured for SV and WYSIWYG. Evidence: Part 1 handoff.
- [x] A test fails before and passes after the fix. Evidence: Part 2 results, RED and GREEN.
- [x] `shortcut-identity.spec.ts:877` and `:900` pass in real VS Code. Evidence: Part 2 results, 6 of 6 (each case three times).
- [x] `npm run quality` passes. Evidence: Part 2 results.

## Part 1 handoff (2026-11-08)

Measurement only; no product or spec change. Probes in `tmp/712/probes/` (the real-VS-Code probe was a copy of `shortcut-identity.spec.ts` that wraps `window.vscode.postMessage` and the webview `message` listener, run as `zz-tmp712-capture.spec.ts` and removed; copy kept as `zz-tmp712-capture.spec.ts.txt`). Four probe runs through the wrapper on `37b29ece` after `node build.mjs`, `--workers=1 --retries=0`, Openbox with the tracked absolute config. Captures: `tmp/712/capture-large-sv.json`, `tmp/712/capture-small-*.json`; logs `tmp/712/capture{1..4}.out`.

### What `1d8e37a9` changed (Task 607 intent)

`snapshotPair()` returns `exact: null` instead of promoting Vditor's rendered serialization to exact authority (S2b rule 2); `receiveExactAuthority` adopts a host reply only with proof (rule 4: rendering unchanged since the request, no trusted input since, and the reply projects to the live rendering; SV: EOL-normalized equality, later widened by Task 675's `svSourceDerivesFrom`); the host writes an exact edit only when its `before` equals the host text (INV-B). `65129734` then removed Find's legacy rendered fallback, made Find show no matches and start one background acquire on a `null` exact (`find-source.ts:128-135`), and made the first Replace on a not-yet-owned source only refresh the matches ("second activation"). Intent: a guarded exact write must never carry normalized bytes outside the action span (Task 607 S1: Find Replace One wrote the whole normalized document).

### Large SV (`shortcut-identity.spec.ts:877`, `sv:find-family`): the reply is rejected by the relation

- Request at Ctrl+F (background acquire, `find-source.ts:132`). Reply: 174517 characters, equal to the opened file. Live Source text (`serializeSvForHost` form): 181845 characters, the same at request and reply; trusted input count unchanged between them. Find stays "No results" (3 of 3 runs that reached the leg).
- Rejecting check: `edit-sync.ts:1334-1337`. `provesExact` is false (SV projection is `normalizeEol(content)`, first difference at offset 74). `hostDerivesSourceText` is false: `svSourceDerivesFrom` (`sv-source-relation.ts:249`) fails at the line-count check of `linesRelate` (`sv-source-relation.ts:218`, 2335 host lines against 2321 shown lines); the trailing-line-break branch fails at the same check.
- The Source text is not the host text plus Task 675's classes. It is exactly the text of `SpinVditorSVDOM(VditorIRDOM2Md(Md2VditorIRDOM(host)))` without the final newline span (Vitest with the vendored Lute, equal after the trailing line break): the IR-to-Source switch. Besides table padding it drops blank lines, joins soft line breaks, re-indents list continuation lines and changes inline HTML, so no line relation can accept it. A whitespace-insensitive comparison and the host's own canonical IR comparison (`canonicalIrMarkdown` form) both differ as well (measured).
- Why ownership was gone: the earlier legs posted 12 plain edits of the Source text; the host kept its own bytes (174517) each time. After a plain post `hostBase` is `null`, so `recallRemembered` cannot recall the pair. The last plain post is byte-equal to the Source text at the reply (`hostReference === rendered`, measured).
- Also measured: Find's SV background acquire ignores its result (`find-source.ts:132` returns nothing to the widget), so an adopted reply does not refresh an open SV Find until the next input.

### Small WYSIWYG (`:900`, `wysiwyg:exact-find-replace`): the reply is adopted; Replace All is consumed by a refresh

- Failing runs 2 and 4 (runs 1 and 3 passed: WYSIWYG alone, and with probe delays). Run 4 timeline (ms): Replace One posts exact 224→221 (9112); Undo of the replacement (10465) changes the rendering to 234 characters, so `currentPairExact` revokes the pair; the history replay posts its exact Undo only at 11264. Ctrl+H (10645) refreshes Find on a `null` exact ("No results") and starts the acquire (10644). Reply 224 at 10665; in-page `VditorDOM2Md(Md2VditorDOM(reply)) === getValue()` is true (234), rendering and trusted count unchanged, so the reply is adopted. The index announces the new revision, but Find's `scheduleRefresh` waits `FIND_REFRESH_QUIET_MS` (150 ms, `selection-scope.ts:1014`) plus a frame: status is still "No results" at 10718. Ctrl+Alt+Enter at 10779.
- Rejecting check: `planOn` (`selection-scope.ts:1690-1695`): the plan has owned exact bytes (224), but `result` was computed on the `null` source, so `!result || result.source.exact !== before.exact` holds, it calls `refresh(false)` (status becomes "1 of 2") and returns `null`. No post. This is the S2b-2 "second activation" rule losing a race with the reply. The record's "224 against 234" is the normal projection difference, not the rejection.

### Fix contract (proposed; open choices below)

1. **WYSIWYG/IR, `selection-scope.ts` `withActionPlan`/`planOn` (`:1690-1720`).** When the plan's exact bytes (owned at once, or adopted after `acquire()`) differ from `result.source.exact` or `result` is `null`, recompute the result on the current source with the unchanged query and options (`findResult()`; the tracker caches per source key) and run the plan on it in the same activation if `result.source.exact === before.exact`; otherwise keep today's refresh. No extra work when `result` is current. Needs decision Q1 (it reverses the S2b-2 second-activation rule).
2. **SV reply proof, `edit-sync.ts` `receiveExactAuthority` (`:1325-1340`).** Add one SV-only clause; options in Q2. The adopted exact stays the host's bytes and the live Source text stays its rendering (as Task 675 already does).
3. **SV Find refresh, `find-source.ts:128-135`.** Keep the acquire's promise and, on a non-`null` reply, call a new optional dep `onSourceAdopted()` that `selection-scope.ts` wires to `scheduleRefresh` (or an immediate `refresh(false)`), mirroring `source-block-index.ts:321-326`.

Task 607 guard: unchanged. INV-B stays in the host; every exact post still names `before` = the owned (adopted) host bytes and is refused on mismatch; no rendered bytes become exact; item 1 changes only when a plan runs, never what it plans on; item 2 widens only the webview's proof that the live rendering belongs to the reply.

Allocation policy: owned exact or a current `result` costs nothing new. Item 1 recomputes once per stale activation. Item 2 runs only on a reply that the existing proofs refused (cost per option below).

RED Vitest cases (written and run in `tmp/712/probes/`):

- `media-src/src/bridge/edit-sync.test.ts`, in `Source-mode exact-authority relation (Task 675)`: "T712: adopts the host bytes when the Source text is the last plain post (normalized beyond the line relation)": host `# T\n\n\n|a|b|\n|---|---|\n|x|y|\n\nText <N> editword here.\n`, Source text with a dropped blank line, padded table and the inline tag removed; typing published; reply = host bytes with the typing; `expect(result?.exact).toBe(reply)`. Today: `undefined` (RED, `tmp/712/probes/edit-sync-712.test.ts`). Control "refuses the host bytes when the Source text changed after the last plain post": passes today. For Q2 option A the reply also carries the attestation field.
- `media-src/src/editing/selection-scope.test.ts`: without an owned source, open Find, type the query, let the acquire resolve, click `replace-all` before the 150 ms refresh: `expect(view.postExact).toHaveBeenCalledOnce()` with the replaced text. The existing case "asks the host once without an owned source; the first replace only shows the matches" encodes the old rule and changes with Q1.
- `media-src/src/editing/find-source.test.ts`: in SV with a `null` exact, an acquire that resolves to a pair calls `onSourceAdopted` once.

Real VS Code acceptance: `shortcut-identity.spec.ts` `:877` and `:900`. Regression set: `exact-actions-after-trusted-edit.spec.ts` (Task 607), `exact-authority-other-actions.spec.ts` (Task 675 SV cases), `find-replace.spec.ts`, `find-replace-large.spec.ts`.

### Questions for the Owner (with recommendation)

- **Q1 — Replace on a source that became owned after the matches were shown.** (a, recommended) Re-run the query on the owned bytes and replace in the same activation (Replace All: all matches; Replace One: the match at the clamped current index). (b) Keep the second activation and only refresh at once on adoption (no 150 ms wait): narrows the race, does not close it (the reply can arrive after the key).
- **Q2 — SV proof when the Source text is Lute's switch serialization.**
  - (A, recommended) Host attestation: each plain `edit` carries a sequence number; `exact-authority` echoes the last edit the host processed. The webview accepts in SV when `rendered === hostReference` (the last plain post; measured true) and the echoed sequence is that post's. Cost: one string comparison. Refuses a stale host (Task 675 negatives stay valid with the field). Protocol change in `src/shared/protocol.ts`, `webview-message-shape.ts`, `message-router.ts`, `editor-session.ts`: the routing note says to reconsider the classification for a relation-format change.
  - (B) Projection proof, no protocol change: accept when the Source text equals `SpinVditorSVDOM` of the reply's projection through the visual mode Source was entered from (measured exact on the large fixture). Cost measured in Node: 0.8-1.2 s per proof on the 174 KB fixture (IR round trip plus SV spin), once per acquisition and again after every published edit; needs Lute flag switching on the shared instance.
  - (C, not recommended) `rendered === hostReference` alone: makes the case pass but accepts a stale host; three existing Task 675 refusals fail with it (measured on a copy).
  - Also possible but not measured: seed Source mode with the owned exact bytes at a switch instead of Lute's serialization (a visible behavior change).
- With Q2 (A) or (B), the first Replace in SV writes the host bytes into the Source view, so the Lute normalization shown since the switch disappears from the whole Source text at that moment (the file was never normalized). Accept as is (recommended) or ask for a different display.

### Not covered

IR on the small fixture passed in every run; CRLF; a direct SV open of the large fixture (a Vitest probe suggests its Source text also fails the relation, unverified in VS Code).

## Decisions Q1–Q3 (provisional, orchestrator on the Owner's behalf, 2026-11-08)

- Q1 (a): when the exact bytes differ from the shown result, Replace re-runs the query on those bytes and acts in the same activation.
- Q2 (A): the host's exact-text reply echoes the sequence number of the last edit it processed; the SV webview accepts the reply as exact when that sequence equals its last plain post and the Source text equals that post. The Task 675 refusal tests stay as they are (their cases do not carry a matching sequence).
- Q3: accept. After the first adopted exact Replace in SV, the Source view shows the file's bytes again.

## Part 2 results (2026-11-08)

Implemented contract items 1-3 with decisions Q1 (a), Q2 (A) and Q3. The Task 607 host guard (INV-B) is unchanged; every exact post still names `before` = the owned (adopted) host bytes.

### Changes

- **Protocol and host.** `src/shared/protocol.ts`: a plain `edit` carries an optional `sequence`; `exact-authority` carries an optional `editSequence`. `src/session/editor-session.ts`: `queueEdit` clears `lastEditSequence` at the start of every edit turn and sets it to the plain edit's `sequence` (`plainEditSequence`) only when the edit was written or consumed as a history echo; a stale-refused, failed, exact or native-replay edit leaves it cleared. `queueExactAuthority` adds `editSequence` only when it is set, so older replies keep their shape.
- **SV proof.** `media-src/src/bridge/edit-sync.ts`: each plain post takes the next `plainSequence` and is remembered as `lastPlainPost`. `receiveExactAuthority` accepts, after `provesExact` and before the Task 675 relation, when `hostAnsweredSourcePost` holds: SV mode, the echoed `editSequence` equals `lastPlainPost.sequence`, `hostReference` is still that post, and the live Source text equals it (string comparisons only). The existing guards (rendering unchanged since the request, no trusted input since) stay in front.
- **Replace re-query.** `media-src/src/editing/selection-scope.ts` `planOn`: when the plan's exact bytes differ from the shown result (or the result is empty), it re-runs the query on the current source with `refresh(false)` and acts in the same activation when that source is the plan's bytes; otherwise it still declines. Nothing extra runs when the result is current.
- **SV Find refresh.** `media-src/src/editing/find-source.ts`: the SV background acquire keeps its promise and calls the new optional `onSourceAdopted` on a non-null reply; `selection-scope.ts` wires it to `scheduleRefresh`. The dependency type became `Promise<unknown> | undefined`.

### RED and GREEN

RED on the unchanged code (all five failed as expected):

- `edit-sync.test.ts` "Task 712: adopts the host bytes when the host echoes the post the Source text equals": `expected undefined to be '# T…'`. Its two refusals (no or another sequence; Source text changed after the request) pass before and after.
- `selection-scope.test.ts` "asks the host once without an owned source and replaces in the same activation" (replaces the case that asserted the second activation) and "replaces all at once when the source became owned after the shown result": `postExact` not called.
- `find-source.test.ts` "announces an adopted SV background acquire once, and a refused one never": `onSourceAdopted` called 0 times.
- `test/backend/editor-session.test.ts` "echoes the sequence of the last processed plain edit in request-exact-authority": missing `editSequence: 7`.

GREEN: the focused run (`edit-sync`, `sv-source-relation`, `selection-scope`, `find-source`, `editor-session`, `module-boundaries`, `message-router`, `webview-message-shape`) passed 747 of 747. Five existing `edit-sync.test.ts` assertions of the exact plain `edit` message now also expect `sequence: expect.any(Number)`. The Task 675 refusal tests are unchanged and pass.

### Real VS Code (one wrapper call, Openbox with the tracked absolute config, `--workers=1 --retries=0`, after `node build.mjs`)

- `shortcut-identity.spec.ts -g "large fixture, sv|small fixture" --repeat-each=3`: 6 passed (17.2 min). `:877` (large SV) 3 of 3, `:900` (small, all three modes) 3 of 3.
- `exact-actions-after-trusted-edit.spec.ts`, `exact-authority-other-actions.spec.ts`, `find-replace.spec.ts`, `find-replace-large.spec.ts`: 13 passed (31.7 min); Task 607 S1 cells and Task 630 S3 cells all `failed=0`.
- Log: `tmp/712/p2-vscode.out`.

### Checks

- `npm run typecheck`: clean. Host `tsc -p tsconfig.json --noEmit`: clean.
- `npm run lint:ci`: exit 0 (4 infos).
- `npm run quality`: exit 0; every stage PASS (brand identifiers, lint:ci, knip, jscpd, depcruise, audit, test:coverage with 390 files and 8794 tests passed plus 1 expected fail, coverage-modules ratchet at baseline 9).

### Notes and residual risks

- After the real-VS-Code run, a lint fix moved the host's sequence check into the helper `plainEditSequence` (same condition). The bundle under test had the same condition written inline. The host Vitest suite passed after the move (179 of 179).
- The WYSIWYG case was timing-dependent in Part 1. Q1 (a) removes the race at the action itself; three consecutive passes are the real-VS-Code evidence.
- The SV proof depends on the host processing edits in queue order (the existing `editMessageChain`). An outside change after the post posts an `update` that reseeds `hostReference`, so the proof then fails closed.
- Not covered: CRLF in SV through this proof, and a direct SV open of the large fixture.

## Closure (2026-11-08)

- Review: the orchestrator reviewed the diff and moved the host helper `plainEditSequence` above the class comment block (placement only). After that move, the focused suites (`editor-session`, `edit-sync`, `find-source`, `selection-scope`) pass 445/445, and `npm run typecheck` and `npm run lint:ci` exit 0.
- The real-VS-Code run used the earlier inline form of the host sequence check. The condition is the same, and the host suite covers it.
- Residual: CRLF documents in SV through the sequence proof, and opening the large fixture directly in SV, are not covered.
