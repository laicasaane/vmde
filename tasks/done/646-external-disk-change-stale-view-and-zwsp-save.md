# Task 646 — External disk changes may not reach an open VMDE editor, and a saved file gained a zero-width space

**Status:** open.
**Origin:** Project Owner report, from an observed incident.
**Severity:** high (est.; possible silent loss of newer file content, and an internal character written to the user's file).
**Tech stack:** extension host (`src/session/editor-session.ts`, `src/writeback/writeback-controller.ts`, `src/writeback/sync-state.ts`, `src/app/extension.ts`), webview (`media-src/src/bridge/edit-sync.ts`, `bridge/message-router.ts`, `boot/vditor-init.ts`, `editing/caret-preserve.ts`), Vitest, Chromium, real VS Code.

## Incident

A task record in this repository was open in VMDE while the same file was changed on disk by another process and committed several times within a few minutes. Two unexpected changes reached the file on disk:

1. **Older text written over newer text.** After a commit that added new paragraphs and acceptance text, the file on disk again held the text from before that commit: the three changed passages were reverted, and nothing else changed.
2. **A zero-width space saved into the file.** A later on-disk change appended a blank line and a line holding only U+200B ZERO WIDTH SPACE (bytes `e2 80 8b`) at the end of the file. The same change also removed two spaces of indentation from one line inside a fenced `text` block; that edit may have been the user's own.

VMDE uses U+200B internally (for example as a caret placeholder), so it should never reach a saved file. A known source is the WYSIWYG inline-code caret pad in Vditor's code rendering, which [Task 191](../191-mouse-ops-test-plan.md) found in copied inline code and normalized only on the copy path. It is not known whether the editor tab had unsaved edits when the disk changed, which mode it was in, or whether VS Code showed its "file is newer" prompt on save.

## Questions to answer

1. When a file open in VMDE with no unsaved edits changes on disk, does VMDE show the new text, in IR, WYSIWYG and Split, including while a write-back or an input flush is pending?
2. Can VMDE write its older content back after such a reload, through a delayed write-back, an Undo checkpoint, a flush on blur or save, or a reconnect after the webview was hidden?
3. When the document has unsaved edits and the disk changes, does VMDE behave as VS Code does for text editors (no silent reload; the save conflict prompt appears), and does it never write the disk version's content into its history in a way that loses either side?
4. Which path writes U+200B into the document text: a caret placeholder, an empty paragraph created by Enter at the document end, a gap line between blocks, or another site? Does it reach the host text, the saved file, or both?

## Requirements

1. **Reproduce first.** Write real-VS-Code cases for each question above before changing code. Record what passes and fails, with the mode and timing that trigger each failure.
2. **New disk content always reaches the view.** For a document with no unsaved edits, an external change is shown in the open VMDE editor in every mode, and no later VMDE write-back, flush or Undo checkpoint writes the previous content back.
3. **No silent loss with unsaved edits.** For a document with unsaved edits, VMDE follows VS Code's text-editor behaviour: it does not overwrite the disk version without the user's choice, and the user's edits are not lost.
4. **No internal characters in saved text.** U+200B and any other editor-internal placeholder never reach the host text or the saved file, except where the user typed them or they were already in the file.
5. **Fix where needed.** Fix each confirmed cause at its source, with a test that fails without the fix. Causes that do not reproduce are recorded with the cases that cleared them.

## Scope

- In: external-change handling for open VMDE editors, write-back and flush ordering around a reload, the save conflict path, and every site that can insert U+200B or another placeholder into document text.
- Out: VS Code's own conflict UI, Git integration, multi-window editing of one file.

## Acceptance

- [x] Real-VS-Code cases exist for questions 1–4, in IR, WYSIWYG and Split, with results recorded (`test/vscode-e2e/external-disk-change.spec.ts`, results in the S1 and S1b tables below).
- [x] An external change to a clean document is shown in VMDE and survives the next key, save, Undo and Redo: the saved file holds the new disk text plus the typed key only (C1 and C2, all modes, final run 2026-11-01).
- [x] With unsaved edits, an external change never silently overwrites the disk or loses the edits (C4, all modes; C3 shows the stale key is refused, the disk text kept).
- [x] No case writes U+200B (or another internal placeholder) into the host text or the saved file unless it was typed or already present (C1–C6, all modes; no leak found, so no U+200B fix was needed).
- [x] Every confirmed cause has a fix and a failing-first test; non-reproducing hypotheses are recorded (H1/H2 host tests S2/S3, H3 Chromium S4/S5, C3 real VS Code; H5 and H6 did not reproduce; H4 has a fix and no test, see risks).
- [x] Focused Vitest, Chromium and real-VS-Code specs are written and run; network-free gates pass at closure (build, typecheck, lint, focused Vitest, Chromium and `npm run quality` stages pass; the `audit` stage reports advisories in development dependencies, not caused by this task, recorded not fixed).

## Tests

- Real VS Code (`test/vscode-e2e/`): open a clean document in each mode, change it on disk from outside, check the view, then type one key, save, and compare the file bytes; repeat with a pending write-back and after hiding and showing the tab; repeat with unsaved edits and check the save conflict path. Check for U+200B in host text and on disk after Enter at the document end, gap lines, empty paragraphs and caret moves. Reuse helpers from `doc-sync.spec.ts`, `save-fidelity.spec.ts` and `writeback-own-race.spec.ts`.
- Vitest: write-back and sync-state ordering around an external change; placeholder stripping at every serialization exit.
- Chromium: placeholder sites in the webview (serialization never emits U+200B that was not in the source).

## Part 1 handoff (2026-11-01)

Status of this section: design settled for Part 2. Everything under "Root-cause hypotheses" is inference from source reading and one read-only Lute probe; nothing is measured in real VS Code yet. Step S1 measures it.

### Problem

The incident shows two failures: (1) older text written over newer disk text, with exactly the externally changed passages reverted; (2) a U+200B-only line appended at the end of a saved file. The pattern in (1) — only the externally changed passages reverted, nothing else changed — is what a full-document webview edit serialized from a DOM that never received the external change produces: the host minimal-diff write-back keeps unchanged blocks byte-identical and writes the webview's (old) form of the changed blocks plus any typed key.

### Path map (source evidence)

External change to host and webview:
- VS Code reloads a clean `TextDocument` when the file changes on disk (a dirty one is never reloaded; the save then shows VS Code's "file is newer" conflict). The reload fires `onDidChangeTextDocument` with `isDirty === false`.
- `src/session/editor-session.ts` change listener: `isEcho` (own write) returns; then `isApplyingEdit()` returns early **for any change**; then the external branch forgets history mappings, adopts the clean baseline when `!isDirty` (`WritebackController.setCleanBaseline`), and calls `DocSyncController.schedulePostUpdate()` (75 ms debounce, `src/writeback/doc-sync.ts`).
- `DocSyncController.postUpdate()` skips the post when `SyncState.isAlreadySynced(text)` (text equals `lastSyncedContent`).
- VMDE's own file watcher (`setupFileWatcher`) exists only when the file is inside a workspace folder; otherwise the document change event is the only path.
- Webview `handleUpdate` (`media-src/src/bridge/message-router.ts`): drops the update while a large document streams in (`sessionState.streaming`; the comment says "external changes re-fire later", which nothing guarantees); otherwise `setValue` when `getValue() !== content`, then `editSync.reseed(...)`. Pending typing is neither flushed nor cancelled.

Webview to host write-back:
- `media-src/src/bridge/edit-sync.ts`: plain `edit` posts from `postEdit` (250 ms idle debounce) and `flushEdit` (save flush, Undo flush, block-action settle, rewrap); exact posts from `postExact` carry `before` and are refused by the host when stale (Task 607).
- Host `queueEdit` → `historyCoupling.consumeEdit` → `onEdit` → `WritebackController.syncToEditor`: a plain edit is minimized against the clean baseline and written over the whole document with **no base or version check**.
- `applyOnce` on success sets `lastSyncedContent = document.getText()` — the current text, which may already include an external change that landed during the await.
- Save: `flushWebviewForSave` skips the flush when the host holds text the webview has not received (correct guard, save path only). `checkNoopOnWillSave` / `resolveNoopCheck` may write the clean baseline back; both depend on the baseline being current.
- Undo: Vditor history is cleared by `setValue(content, true)` on a host update; host history mappings are forgotten on an external change (Task 602).
- `retainContextWhenHidden: true` (`src/app/extension.ts`), so a hidden VMDE tab keeps its webview and receives messages.

U+200B sites:
- Read-only probe (vendored Lute, 2026-11-01): `VditorIRDOM2Md` and `VditorDOM2Md` drop every U+200B (trailing ZWSP paragraph, mid-text ZWSP, and a ZWSP line already in the source). IR and WYSIWYG full serialization is therefore clean; an already-present U+200B survives only in blocks the minimal-diff write-back keeps byte-identical.
- Split (`sv`) serialization is DOM `textContent` (`serializeSvForHost` in `edit-sync.ts`); it removes only a U+200B followed by newlines to the end of the text. Vditor's own `getMarkdown` for `sv` strips nothing.
- DOM sites that insert U+200B: Vditor `insertAfterBlock` / paragraph splits (`fixBrowserBehavior.ts`, `<p data-block="0">ZWSP<wbr>\n</p>`), Vditor code paste, VMDE trailing and gap paragraphs (`editing/trailing-paragraph.ts`, `editing/gap-paragraph.ts`, `gap-nav.ts`, `gap-click.ts`), wiki chip caret landing (`boot/vditor-init.ts`, stripped in `links/wiki-serialize.ts`), host render repairs (`src/shared/lute-block-repair.ts`, `lute-gap-repair.ts`, render-only).
- Sites that only read or strip U+200B (no insertion into text): `undo-boundaries.ts`, `inline-picture.ts`, `math-insertion.ts`, `html-inline-token.ts`, `html-subscript*.ts`, `details-selection-state.ts`, `wrap-hint-*.ts`, `named-anchor-insertion.ts`, `code-copy.ts`, `src/shared/code-ref-core.ts`.

### Root-cause hypotheses (inference until S1 measures them)

- **H1 — stale plain edit overwrites a newer host text (Q2).** A plain edit serialized before the webview applied the external update is written without a check. Windows: host 75 ms update debounce, webview processing, the 250 ms idle post, and every flush. Matches incident (1). Likelihood high.
- **H2 — external change swallowed during VMDE's own write (Q1).** A change that lands while `applyingWebviewEdit` is true returns early (no post, no baseline adoption); `applyOnce` then marks the external text as synced, so later `postUpdate` calls are deduplicated and the view stays stale until the next H1 write reverts the file. Likelihood medium; deterministic in a host Vitest with the mocked `vscode`.
- **H3 — pending typing silently dropped by a host update (Q3, webview-only unsaved edits).** Up to 250 ms of typing that never reached the host is replaced by `setValue` with no notice. The host document is clean, so VS Code reloads it. Likelihood high by reading.
- **H4 — update dropped during large-document streaming (Q1).** The streaming branch drops the update; nothing re-sends it. Edge case; not reachable with the small S1 fixture.
- **H5 — U+200B through the Split (`sv`) textContent exit or an exact-source builder (Q4).** IR/WYSIWYG full serialization is cleared by the probe. Likelihood medium for Split; S1 sweep decides.
- **H6 — host-dirty case (Q3).** VS Code does not reload a dirty document and its save conflict prompt applies. Expected to pass; S1 confirms.
- Not pursued: the two-space indentation change in the fenced `text` block (incident note: may have been the user's own). S1's fixture includes an indented fenced line so any normalization shows up in the saved-bytes assertions.

### Scope

In: the change listener, `SyncState`, `DocSyncController`, `queueEdit` stale guard, the update/edit protocol fields, webview `handleUpdate`, the edit posts in `edit-sync.ts`, stream-end replay, and each U+200B site S1 confirms. Out: VS Code's conflict UI, Git, multi-window editing, a merge of stale typing onto newer text.

### Settled decisions (provisional, reversible)

- **D1 — Provisional decision (2026-11-01), reversible: stale-edit guard by host revision stamp.** Selected by a recorded decision check (probability 0.98; alternatives: update acknowledgement window 0.02, three-way block merge 0, host-only pending-timer guard 0). Evidence: no base check on plain edits (H1), ordered host/webview messages, exact edits already use the same refuse-and-report pattern. Contract:
  - `SyncState` gains `private externalRevision = 0`, `noteExternalChange(): number` (increments and returns), `getExternalRevision(): number`.
  - The change listener calls `noteExternalChange()` for every non-echo event with `contentChanges.length > 0`, including events that land while `isApplyingEdit()` is true. The `isApplyingEdit()` early return applies only to events without content changes; a content change in that window takes the normal external path (history-mapping reset, clean-baseline adoption when `!isDirty`, `schedulePostUpdate`). This is the H2 fix.
  - `DocSyncController.postUpdate` adds `revision: syncState.getExternalRevision()` to every `update`/`init`, records `postedRevision`, and skips a non-init post only when `isAlreadySynced(text) && postedRevision === getExternalRevision()`.
  - Protocol (`src/shared/protocol.ts`): `update` gains optional `revision?: number`; webview `edit` gains optional `revision?: number`. Both optional; `src/webview-host/webview-message-shape.ts` stays `content`-only (the host checks `typeof revision === 'number'`).
  - Host `queueEdit`: before `consumeEdit`, a plain edit (`!exact`) whose `revision` is a number different from `getExternalRevision()` is stale: write nothing, call `void this.docSync.postUpdate()`, and show `vscode.window.showWarningMessage('VMDE: The file changed before your last edit reached it. The editor now shows the current text; your last edit was not applied.')` at most once per external revision. A plain edit without `revision` keeps the legacy path (compatibility).
  - Webview: `EditorSessionState` (`media-src/src/boot/editor-session-state.ts`) gains `hostRevision: number | undefined` (initially `undefined`) and `deferredHostUpdate: UpdateMessage | null`. `handleUpdate` records `msg.revision` as `hostRevision` when it applies or accepts the content (init, inline-init echo, equal content, `setValue`). In the non-init `setValue` branch it first calls `sessionState.editSync?.flushHistoryInput()` (existing API: posts pending typing only when some is pending) while `hostRevision` still holds the old value, so H3 typing reaches the host as a stale edit and is refused with the warning instead of vanishing (D2). The streaming branch stores the message in `deferredHostUpdate` instead of dropping it; `endStream` in `boot/vditor-init.ts` replays it through `handleUpdate` (H4).
  - `edit-sync.ts`: one new optional dep `hostRevision?: () => number | undefined` (wired in `boot/vditor-init.ts` from `sessionState.hostRevision`); `postEdit` and both `flushEdit` branches add `revision` when defined. No other change in this shared file (Task 624 follows).
- **D1 amendment — Provisional decision (2026-11-01), reversible: native history traversal has its own flag.** Selected by a recorded decision check (probability 1.00; matching by content 0; reverting the H2 fix 0). VS Code's native Undo/Redo, run for the webview's history, changes the document with the applying flag set and no pending content. Counting such a change as an outside change moved the revision mid-traversal, reset the history-mapping proofs, scheduled an update and made the next typing refused with a false warning. Contract: `SyncState.applyingHistory` is set by the history controller around the native command; document events during it take the old full early return and are not counted. The D1 outside-change counting applies only inside the WritebackController write window.
- **D2 — Provisional decision (2026-11-01), reversible: in-flight webview typing overtaken by an external change is refused visibly, not merged.** Part of the same recorded decision check as D1 (probability 0.98). VS Code's text editor never has this window; a merge is out of scope; the warning makes the loss visible.
- **D3 — Provisional decision (2026-11-01), reversible: U+200B fixed per confirmed site, line-preserving.** Selected by a recorded decision check (probability 0.96; host-wide strip 0, strip at every webview exit 0). Contract: for each site S1 confirms, fix at that site. A textContent-based exit (the Split serializer, an exact-source builder) uses one new pure helper `stripPlaceholderZwsp(next: string, reference: string): string` in new file `media-src/src/bridge/placeholder-zwsp.ts` (add `'placeholder-zwsp'` to the `bridge` ids in `scripts/module-manifest.mjs`): every line of `next` that occurs verbatim in `reference` (the host text the webview last received) is kept; U+200B is removed from all other lines. A line that is only U+200B and not in `reference` becomes empty, and a trailing empty line created only by that removal is dropped together with the line break that introduced it (so the incident's "blank line + U+200B line" does not become a new blank line). IR and WYSIWYG Lute exits are not touched (probe: already clean).
- **D4 — Provisional decision (2026-11-01), reversible: the host-dirty case keeps VS Code's own behaviour.** No VMDE prompt is added; VS Code does not reload a dirty document and its save conflict prompt applies. A fix step is added only if S1 case C4 fails. Smallest-scope option on the evidence; no choice between candidates was needed.
- **D5 — Provisional decision (2026-11-01), reversible: test names and tiers.** Real-VS-Code spec `test/vscode-e2e/external-disk-change.spec.ts` with fixture `test/vscode-e2e/fixtures/external-disk-change.md`; not added to `SMOKE_SPECS`/`FAST_SPECS` (runs in the full tier). Host Vitest `test/backend/external-change-guard.test.ts`; webview Vitest `media-src/src/bridge/placeholder-zwsp.test.ts` (only if D3 is triggered); Chromium spec `media-src/e2e/external-update-pending-typing.spec.ts`.

- **D6 — Provisional decision (2026-11-01), reversible: the Split `---` → `***` rewrite is a pre-existing general Split normalization, recorded as a follow-up, not fixed in 646.** Selected by a recorded decision check (probability 0.93; changing the fixture to `***` 0.06; fixing it in 646 0.01). Evidence (source reading plus a read-only probe of the vendored Lute): `SpinVditorSVDOM` and `Md2VditorSVDOM` render `---` as `***`; Vditor builds the Split DOM with them on open (the host prerender skips Split), on every host update (`setValue`) and on each Split input; VMDE serializes Split edits from DOM `textContent`; the host minimal-diff keeps original block bytes only when the IR reserialization of the original block equals the new block, which `***` never does. So any Split edit rewrites `---`, with or without an external change. Consequences: (a) follow-up for the orchestrator to queue: "Split mode rewrites thematic breaks `---` as `***` (and possibly other Lute-SV spellings) on the first edit; keep authored spelling"; (b) the 646 spec keeps the `---` fixture and, for Split only, compares host text and file after mapping a whole line `***` back to `---` (helper `splitRuleSpelling(text)`), with a comment naming the follow-up; IR and WYSIWYG keep the exact comparison.
- **D7 — Provisional decision (2026-11-01), reversible: the hidden-tab case C2 writes its file inside the workspace folder.** Selected by a recorded decision check (probability 0.74; all cases in the workspace 0.19; record as open 0.04). Evidence: VS Code's editor service watches files outside the workspace only while one of their editors is visible (`handleVisibleEditorsChange`, `activeOutOfWorkspaceWatchers` in the 1.129 workbench); hiding the editor drops the watch and showing it again does not re-check a change made meanwhile. The S1 spec used the OS temp directory (outside the workspace). The test harness opens its per-test `baseDir` fixture as the workspace folder (passed as the folder argument at launch; the fixture is already used by `block-handle.spec.ts`), and files there are watched regardless of visibility; VMDE's own file watcher (`setupFileWatcher`) is also active only for in-workspace files. This is a real disk change, matching the incident's in-workspace file. C1, C3, C4 and C5 keep the OS temp directory (results already measured).
- **D8 — Provisional decision (2026-11-01), reversible: widen the U+200B sweep before deciding on S6/S7.** Selected by a recorded decision check (probability 1.0; skip and record 0; defensive host guard 0). New case C6 per mode (see step S1b). S6/S7 run only for a site C6 (or any later case) confirms; if C6 passes in all modes, S6/S7 are dropped and the incident line is recorded as unexplained with the ruled-out list below.

### U+200B status after S1 (2026-11-01)

Ruled out by evidence: IR and WYSIWYG full serialization (Lute drops every U+200B, probe); Enter twice at the document end, arrow moves across a thematic break, a table and a fence, a click below the last block and Enter (C5, all three modes); the Split serializer for a U+200B followed only by newlines to the end. Still unswept (C6 covers the first three): a document whose last block is a fenced block, a table or a list (Vditor `insertAfterBlock` adds `<p data-block="0">ZWSP<wbr>\n</p>` after such a block on ArrowDown or Enter, and Ctrl+Shift+Enter); paste into a fence (Vditor adds U+200B on code paste); exact-source transactions built from DOM text (auto-wrap, rewrap, find and replace). Unexplained so far: the incident's blank line plus U+200B-only line at the end of the file, and the two-space indentation change inside its fenced `text` block (possibly the user's own edit).

### Invariants

- I1: A plain webview edit is written only when it was serialized from a DOM that had applied the host's latest external revision (or carries no revision).
- I2: Every content change VMDE did not make reaches the webview (no dedupe across a revision change).
- I3: The clean baseline follows every clean external change, including one inside VMDE's own write window.
- I4: Typing that cannot be written is never dropped silently (warning).
- I5: U+200B appears in host text or on disk only where it was typed or already present.
- I6: Exact edits (Task 607 `before` guard), history coupling (Tasks 601/602), save flush (Task 580) and the no-op correction (Task 434) keep their current behaviour.

### Edge cases

- CRLF documents: echo comparison is EOL-normalized; a VMDE write must not count as external (I6). Covered by the existing `writeback-own-race`/`doc-sync` regression specs in S8.
- Text-editor tab on the same file (`edit-in-text-editor.spec.ts`): its edits now bump the revision; concurrent webview typing is refused with the warning instead of overwriting it.
- Several stale edits from one burst (idle post plus a flush): one warning per revision.
- Host-originated edits that do not go through `WritebackController` (checkbox toggle, picker insertion, block actions) are either echoes or take the external path; the external path now also bumps the revision (correct: the webview has not seen them).
- An old webview build without `revision`: legacy path.
- Large-document streaming: deferred update replayed at stream end.
- Undo after an external update: Vditor history starts at the update; Undo/Redo of the typed key must leave disk = new text + key.

### Part 2 step plan

Shared rules for every step: work only in this worktree; `node build.mjs` before any real-VS-Code run; real-VS-Code runs under the token with `--workers=1 --retries=0`; record results in this task file; tick only proven items.

**S1 — Real-VS-Code reproduction (real-VS-Code; Partial by design).** Result: the spec and fixture exist, run once, and the results table below is filled per case and mode. Owned files: `test/vscode-e2e/external-disk-change.spec.ts`, `test/vscode-e2e/fixtures/external-disk-change.md`, this task file (results only). Proves acceptance 1 (cases exist, results recorded); its failing cases are the RED evidence for acceptance 2–4.
- Fixture: headings, several paragraphs, a fenced `text` block with an indented line, a thematic break, a table, and one paragraph that already contains a U+200B (to prove "already present" is kept). Copy it to a temp file per test.
- Mode per test via `vmde.editor.defaultMode` (`ir`, `wysiwyg`, `sv`), Global target, reset in `afterEach` (pattern: `default-open-mode.spec.ts`). Helpers: `wf`, `docText` from `webview-helpers.ts`; keystroke focus pattern from `doc-sync.spec.ts`.
- External change = `writeFileSync` from the spec process, then poll the host `TextDocument` text until it equals the new bytes (20 s). If VS Code never reloads the document (the harness opens no workspace folder), do not substitute `workbench.action.files.revert` or an `applyEdit` (neither is a disk change); stop that case and record it as a harness blocker with the observed host text.
- Cases, each a `test()` per mode (asserts the correct behaviour, so a failure is a confirmed cause):
  - C1 clean, visible (Q1, Q2): external write; the view shows the new text; type `K`; wait for the host; Save; disk = new text + `K`; Undo; Redo; Save; disk = new text + `K`; host text and disk hold U+200B only where the fixture had it.
  - C2 clean, hidden (Q1, Q2): open another editor in the same group to hide the VMDE tab; external write; reopen the VMDE tab (`vscode.openWith`); then as C1.
  - C3 held update (Q2, deterministic H1): in the webview frame install a capture-phase `message` listener that holds `update` messages (`stopImmediatePropagation`, queue them); external write; wait for the host reload; type `K`; wait until the host receives the edit or 3 s pass; release the held messages. Correct: disk/host keep the new text (no revert of the changed passages); the view ends on the new text.
  - C4 dirty (Q3): type `K`, wait until the host is dirty; external write; the view and host keep `K`; disk = external bytes; `document.save()` does not overwrite the disk silently (resolves `false` or leaves disk = external bytes); host still holds `K`.
  - C5 U+200B sweep (Q4): Enter twice at the document end, Ctrl+End then Enter, ArrowDown across the thematic break and table (gap paragraphs), click below the last block, type nothing; Save; host text and disk contain no new U+200B; the fixture's own U+200B is still present.
- Check: `node build.mjs` (exit 0); `env -u ELECTRON_RUN_AS_NODE xvfb-run -a npm --prefix test/vscode-e2e test -- external-disk-change.spec.ts --workers=1 --retries=0` (expected: runs to completion; failures are recorded, not fixed). Record start time and result paths.
- Return: the table, and which of H1–H6 are confirmed. If C3 passes in all modes and C1/C2 pass, report that H1 did not reproduce; S2–S5 still proceed for H2 (deterministic host case) and H3 (Chromium case), and the record says which cause each test proves.

**S1b — Real-VS-Code spec amendment (real-VS-Code; Partial by design).** Result: the spec reflects D6–D8 and the amended cases are run once; results added to the S1 results table. Owned files: `test/vscode-e2e/external-disk-change.spec.ts`, this task file (results only). Changes: (1) C2 takes the harness `baseDir` fixture (`async ({ workbox, evaluateInVSCode, baseDir }) =>`) and writes `doc.md` and `other.txt` under `baseDir` instead of the OS temp directory; keep the "reloaded while hidden" log and require the host reload (20 s) after the tab is shown; (2) helper `splitRuleSpelling(text) = text.replace(/^\*\*\*$/gm, '---')`, applied in `keySaveUndoRedo` to host and disk text before the equality checks only when `mode === 'sv'`, with a comment naming the D6 follow-up; (3) new case C6 per mode, "U+200B sweep at document ends": three temp files created in the test from inline strings (no new fixture), each the shared prefix `# C6\n\nIntro paragraph.\n\n` plus a last block of one kind: a fenced `text` block (` ```text\nline one\n  line two\n``` `), a two-row table, a three-item `-` list; for each file in turn open it, place the caret at the end of the last block's last text, press ArrowDown, Enter, Enter, Control+Shift+Enter, type nothing, then Save; for the fence file also paste `pasted line` into the fence (write the clipboard with `vscode.env.clipboard.writeText` and press Control+v with the caret at the end of `line two`); assert host text and file hold no U+200B and the fence's indented line keeps its two spaces. Checks: `node build.mjs` (exit 0); `npm run typecheck:vscode-e2e` (exit 0); `npx biome check test/vscode-e2e/external-disk-change.spec.ts` (exit 0); `env -u ELECTRON_RUN_AS_NODE xvfb-run -a npm --prefix test/vscode-e2e test -- external-disk-change.spec.ts --workers=1 --retries=0 -g "C1 .*, sv:|C2 |C6 "` (expected: C1 Split passes; C2 runs (no harness blocker) and records pass or fail per mode; C6 records pass or fail per mode). Proves acceptance 1 (C2 measured) and the evidence for acceptance 4. A C2 or C6 failure is a finding to record, not to fix in this step.

**S2 — Host RED (RED).** Result: `test/backend/external-change-guard.test.ts` with failing cases: (a) a plain edit with an older `revision` is not written, one `update` is posted, one warning is shown for two stale edits of one revision; (b) a content change during an in-flight `applyEdit` bumps the revision, adopts the clean baseline when clean, and the next `postUpdate` posts despite `lastSyncedContent` equality; (c) `update`/`init` carry `revision`; (d) an edit without `revision` is written as before. Use the `editor-session.test.ts` mocked-`vscode` setup. Owned: that test file only. Proves acceptance 5 (failing-first) for H1/H2. Check: `npx vitest run --config test/vitest.config.mts test/backend/external-change-guard.test.ts` (expected: (a)–(c) fail, (d) passes).

**S3 — Host GREEN.** Result: D1 host contract implemented. Owned: `src/writeback/sync-state.ts`, `src/writeback/doc-sync.ts`, `src/session/editor-session.ts`, `src/shared/protocol.ts`. Proves acceptance 2/3 host side and 5. Checks: the S2 command (all pass); `npx vitest run --config test/vitest.config.mts test/backend/sync-state.test.ts test/backend/doc-sync.test.ts test/backend/editor-session.test.ts test/backend/writeback-controller.test.ts test/backend/history-coupling.test.ts` (all pass); `npm run typecheck` (exit 0).

**S4 — Webview RED (RED).** Result: `media-src/e2e/external-update-pending-typing.spec.ts` (Chromium harness; reuse a harness whose `window.vscode` stub records posts, see DEVELOPMENT.md "The `window.vscode` stub"): (a) typing then an `update` delivered inside the 250 ms window posts the typing as an `edit` carrying the previous `revision` before the DOM takes the update; (b) every plain `edit` after an applied `update` carries that update's `revision`. Owned: that spec (and a harness file only if no existing one records posts). Proves acceptance 3/5 for H3. Check: `node build.mjs`; `xvfb-run -a npm --prefix media-src run test:e2e -- external-update-pending-typing.spec.ts` (expected: both fail).

**S5 — Webview GREEN.** Result: D1 webview contract implemented (revision recording, flush before `setValue`, deferred streaming update, `revision` on plain edits). Owned: `media-src/src/bridge/message-router.ts`, `media-src/src/bridge/edit-sync.ts` (only the dep and the three post sites), `media-src/src/boot/editor-session-state.ts`, `media-src/src/boot/vditor-init.ts`. Checks: S4 command (passes); `npm run typecheck` (exit 0); `xvfb-run -a npm --prefix media-src run test:e2e -- save-flush.spec.ts` plus any Chromium spec that already covers `handleUpdate` (find with `rg -l "command: 'update'" media-src/e2e`), expected pass apart from the listed pre-existing failures.

**S6 — DROPPED (D8: C5 and C6 found no U+200B leak). Original text: U+200B RED (RED; only if C5, C6 or any later case shows a new U+200B).** Result: `media-src/src/bridge/placeholder-zwsp.test.ts` for `stripPlaceholderZwsp` (kept reference lines, removed placeholder line, no new blank line, CRLF input) plus one Vitest or Chromium case per confirmed site that fails without the fix. Owned: those tests. Check: `npx vitest run --config test/vitest.config.mts media-src/src/bridge/placeholder-zwsp.test.ts` (expected: fails, module missing) and the site test (expected: fails).

**S7 — DROPPED with S6. Original text: U+200B GREEN (only after S6).** Result: helper plus a call at each confirmed site. Owned: `media-src/src/bridge/placeholder-zwsp.ts`, `scripts/module-manifest.mjs`, the confirmed site file(s) (for the Split exit: `serializeSvForHost` in `edit-sync.ts`, reference = the webview's host reference text). Checks: S6 commands pass; `node scripts/module-manifest.mjs` (exit 0); `npx vitest run --config test/vitest.config.mts test/backend/module-boundaries.test.ts` (pass).

**S8 — Real-VS-Code verification (real-VS-Code).** Result: the whole `external-disk-change.spec.ts` (C1–C6, all modes) passes; regressions checked. If S1b showed a C2 failure that the D1 fix does not cover, report it as a design question instead of editing product code here. Owned: none (results in this file; a spec assertion changes only if it contradicts a settled decision, reported as a design question). Check: `node build.mjs`; one invocation `env -u ELECTRON_RUN_AS_NODE xvfb-run -a npm --prefix test/vscode-e2e test -- external-disk-change.spec.ts doc-sync.spec.ts save-fidelity.spec.ts writeback-own-race.spec.ts edit-in-text-editor.spec.ts --workers=1 --retries=0` (expected: all pass). Proves acceptance 1–4.

**S9 — Closure.** Focused gates: `node build.mjs`, `npm run typecheck`, `npm run lint`, the focused Vitest files above, the focused Chromium spec(s), `npm run quality` (record each stage; network audit failure recorded, not fixed); update checklists; completion report. Proves acceptance 6.

### S1 results (2026-11-01)

Spec: `test/vscode-e2e/external-disk-change.spec.ts` (15 tests, one per case and mode), fixture `test/vscode-e2e/fixtures/external-disk-change.md`. Full run: 8 passed, 7 failed (first start 02:12 local time on the run day, run duration about 5 min; the run log and parsed per-test results are kept outside the repository). Every failing test asserts the correct behaviour, so a failure is a confirmed cause or a recorded blocker. The external change is a real file write from outside VS Code; VS Code reloaded the document from disk in the visible cases.

| Case | IR | WYSIWYG | Split | Notes |
|---|---|---|---|---|
| C1 clean, visible: shown, then key, Save, Undo, Redo | pass | pass | fail | Q1 passes in all modes: the view shows the disk change. In IR and WYSIWYG the file after key, Save, Undo, Redo, Save equals the new disk text plus the key. In Split the only deviation is that the thematic break `---` is written as `***` in host text and file after the first key (text length equal). Not measured yet: whether that rewrite also happens without an external change. |
| C2 clean, tab hidden during the change | blocked | blocked | blocked | Harness blocker: VS Code did not reload the document from disk while the tab was hidden (8 s) nor within 20 s after the tab was shown again, so there was no external change to observe. No substitute (revert or `applyEdit`) was used. Q1/Q2 for a hidden tab stay unmeasured. |
| C3 held update: key typed before the webview applies the change | fail | fail | fail | **H1 confirmed in all three modes.** The webview held the `update` (its view still showed the old text), the key was typed, and the host text became the old text plus the key: all three changed passages (the rewritten paragraph, the added paragraph, the line added inside the fence) were reverted in the host text and, after Save, in the file. This matches the incident. In Split the Save step passed (the file kept the passages) while the host text was already reverted. |
| C4 unsaved edits, then external change | pass | pass | pass | VS Code kept the dirty document, the host text and the view kept the key, the file kept the external bytes, and `save()` resolved `false` without overwriting the file. H6 (host-dirty case) does not reproduce; D4 stands. |
| C5 U+200B sweep (Enter twice at the end, arrow moves across the thematic break, table and fence, click below the last block, Enter) | pass | pass | pass | Host text and file held exactly one U+200B (the fixture's own) in every mode; the fixture's own U+200B was kept. H5 does not reproduce for these paths. |

Which causes are confirmed:
- **H1 confirmed** (stale plain edit overwrites newer host text), IR, WYSIWYG and Split, deterministically with the held update. Real VS Code timing without the hold was not measured: in C1 the update reached the view before the key.
- **H2, H3, H4 not measured in S1** (they need the mocked host or the Chromium harness; S2 and S4 prove them).
- **H5 not reproduced** (no U+200B written in the swept paths). The incident's U+200B line stays unexplained; S6/S7 run only if a later case shows a leak. Not swept: Enter at the end of a document that ends in a fenced block, a list, or a table, and Enter at the end in a document with an empty first paragraph.
- **H6 not reproduced** (C4).
- **New finding (Split):** `---` becomes `***` after an edit in Split mode following an external change. Unrelated to the incident unless a baseline run without an external change shows the same; to be classified in S3 (host check: whether the Split edit goes through the minimal-diff write-back against the new baseline) or reported as a separate task.
- **Harness blocker:** C2 (hidden tab) could not trigger a reload.

### S1b results (2026-11-01)

Run of `-g "C1 .*, sv:|C2 |C6 "` (start 02:25 local on the run day), then C6 alone after fixing the spec's ready-text wait (start 02:28). Final state of the amended cases:

| Case | IR | WYSIWYG | Split | Notes |
|---|---|---|---|---|
| C1 clean, visible (Split with the `***` → `---` spelling mapping, D6) | pass (S1) | pass (S1) | pass | Split: the only earlier deviation was the thematic-break spelling. |
| C2 clean, tab hidden (file inside the workspace folder, D7) | pass | pass | pass | The host document reloaded while the tab was hidden; the view showed the change after the tab was shown; key, Save, Undo, Redo kept the new disk text plus the key. The S1 blocker was the out-of-workspace watch, as decided in D7. |
| C6 U+200B sweep at document ends (fence, table, list; ArrowDown, Enter twice, Ctrl+Shift+Enter, paste into the fence) | pass | pass | pass | Host text and file held no U+200B in any of the nine documents; the fence's indented line kept its two spaces. In WYSIWYG the pasted text did not appear in the fence (the paste step has no effect there); the other keys ran. |

Consequences:
- Acceptance 1 is proven: cases for Q1–Q4 exist in all three modes with results recorded.
- **D8 outcome:** C5 and C6 found no U+200B leak in any mode, so steps S6 and S7 are dropped. The incident's U+200B line (and the two-space indentation change in the fenced block) stay unexplained; ruled out: IR/WYSIWYG serialization, Split serializer end case, Enter/ArrowDown/Ctrl+Shift+Enter at the end of a document ending in a paragraph, fence, table or list, click below the last block, paste into a fence (IR and Split). Not swept: exact-source transactions built from DOM text (auto-wrap, rewrap, find and replace), and edits while an external change lands (H1 window). The H1 fix (D1) is the main candidate: an older-text write after a stale edit also explains an indentation change.
- Acceptance 2–4 (clean document survives; unsaved edits; no U+200B) have their RED evidence only in C3; they close in S8.

### S2 result (2026-11-01)

`test/backend/external-change-guard.test.ts` (5 tests, mocked host). Run: `npx vitest run --config test/vitest.config.mts test/backend/external-change-guard.test.ts` → 3 failed, 2 passed, failing for the missing guard:
- (c) init carries no `revision` (`expected undefined to deeply equal Any<Number>`);
- (a) a plain edit made from an older revision after an external change is written (document ends as `# Hi\n\nbody K\nK\n` instead of keeping `# Hi\n\nEXTERNAL change on disk\n`);
- (b) a clean external change during VMDE's own `applyEdit` is ignored (`setCleanBaseline` called 0 times, no update posted).
Passing before and after the fix: (d) an edit without a revision is written; (d) an edit carrying the current (absent) revision is written.

### S3 result (2026-11-01)

Host side of D1 implemented: `SyncState` (`externalRevision`, `noteExternalChange`, `getExternalRevision`, posted-revision tracking), `DocSyncController.postUpdate` (every update carries `revision`; a repost is skipped only when the text and the revision were both already posted), `EditorSession` (outside changes counted also while VMDE's own write is in flight, via `skipDuringOwnWrite`; `refuseStaleEdit` in `queueEdit` refuses a plain edit with an older numeric `revision`, re-posts the host text, warns once per revision), protocol (`revision?` on `update` and `edit`). Edits without `revision` keep the legacy path. The S2 test file was adjusted only to drop a helper that left unused queued `applyEdit` implementations behind (they consumed later tests' writes); no assertion was weakened.

Checks: `external-change-guard.test.ts` 5 passed; the five regression files (`sync-state`, `doc-sync`, `editor-session`, `writeback-controller`, `history-coupling`) plus the guard file: 273 passed; the whole `test/backend` directory: 113 files, 2891 passed, 1 expected fail; `npm run typecheck` exit 0; host `tsc -p tsconfig.json --noEmit` exit 0; `biome check` on the changed files clean.

### S4 result (2026-11-01)

`media-src/e2e/external-update-pending-typing.spec.ts` (Chromium, real webview entry, IR; the caret goes one character before the paragraph end because a caret at the very end of a block lands in the next block). Run: `xvfb-run -a npm --prefix media-src run test:e2e -- external-update-pending-typing.spec.ts` → 2 failed, both for the missing behaviour:
- (a) typing inside the 250 ms debounce, then an `update` with revision 4: the typed key is never posted before the DOM takes the update (expected one edit with revision 3, received none): H3 confirmed in the webview.
- (b) a plain `edit` after an applied update carries no revision (expected 3, received `undefined`).

### S5 result (2026-11-01)

Webview side of D1 implemented: `EditorSessionState` (`hostRevision`, `deferredHostUpdate`); `handleUpdate` records the host revision (init, equal-content and replacing branches) and, before replacing the DOM, publishes pending typing with `flushHistoryInput()` while the old revision is still held (the replacement branch moved into `applyHostUpdate` to keep `handleUpdate` within the complexity limit); an update that arrives while a large document streams in is kept and replayed through the window when the stream ends; `edit-sync.ts` gets one optional dep `hostRevision` and adds `revision` to `postEdit` and both `flushEdit` branches; `vditor-init.ts` wires the dep and the replay. Four stubs in `message-router.test.ts` gained `flushHistoryInput` (they lacked the method the router now calls).

Checks: Chromium `external-update-pending-typing.spec.ts` 2 passed (was 2 failed); neighbouring Chromium specs (`save-flush`, `external-update-undo-base`, `exact-actions-after-edit`, `prepaint-scroll`, `open-deferred-work`, `text-field-history`): 95 passed, 3 failed, all three the known pre-existing `text-field-history.spec.ts:178` (IR, WYSIWYG, Split); Vitest `media-src/src/bridge`, `media-src/src/boot`, `module-boundaries`, `external-change-guard`: 17 files, 515 passed; `npm run typecheck` exit 0; `biome check` on changed webview files clean.

### S8 result (2026-11-01)

First run (all of `external-disk-change.spec.ts` plus `doc-sync`, `save-fidelity`, `writeback-own-race`, `edit-in-text-editor`): C3 passed in all modes (the held-update key is now refused, the host keeps the new disk text), but C1 and C2 failed in every mode: after Undo, Redo did not restore the key. Cause, found by reading: the host's native Undo/Redo for the webview's history changes the document with the applying flag set; the S3 change counted any content change during that flag as an outside change, so the revision moved without the webview receiving an update and the following Redo edit (older revision) was refused. Fix inside the S3-owned files: `SyncState` gets `applyingHistory`; the history controller's `setApplying` sets it; `skipDuringOwnWrite` ignores document events while it is set. Failing-first test: case (e) in `test/backend/external-change-guard.test.ts` (fails without the flag, passes with it).

Final run (start 02:58 local, `env -u ELECTRON_RUN_AS_NODE xvfb-run -a npm --prefix test/vscode-e2e test -- external-disk-change.spec.ts doc-sync.spec.ts save-fidelity.spec.ts writeback-own-race.spec.ts edit-in-text-editor.spec.ts undo-routing-hygiene.spec.ts --workers=1 --retries=0`): exit 0, 23 passed, 7 skipped (the skipped tests are in `undo-routing-hygiene.spec.ts`, which needs the OS-level key setup; they are not part of this task's acceptance). All C1–C6 cases pass in IR, WYSIWYG and Split. Host Vitest: whole `test/backend` 113 files, 2891 passed, 1 expected fail (before adding (e)); guard file 6 passed.

### R1 result (2026-11-01, review repair)

Review findings and what was done:
1. History traversal (HIGH): the `applyingHistory` flag from S8 meets every point. Case (e) now also asserts no revision bump, no history-mapping reset (`forgetHostMappings` not called), no baseline adoption, no update and no warning; it fails without the flag.
2. `applyHostUpdate` flushed pending typing even for an update with the revision already applied. Now it flushes only when `msg.revision !== hostRevision`. Failing-first: Chromium case (c) in `external-update-pending-typing.spec.ts` failed without the change and passes with it.
3. The inlined init payload had no `revision`. Added the current external revision; host case (f) fails without it.
4. `edit-sync.ts`: `revision` is assigned directly in the three post literals (helper removed).
5. Audit of host edits outside the write-back controller: only the history controller sets the applying flag without pending content (fixed by finding 1). `applyExactGuarded`, the routine write and the save-time no-op correction set the flag and also set the pending content, so their echoes match before the outside-change check. The Preview task-checkbox `applyEdit` (editor session) and the outline tree `applyEdit` set no flag; they are outside changes by design and each posts or schedules an update that carries the revision. No other `applyEdit` call site exists.

Checks: host Vitest `test/backend` plus `media-src/src/bridge` and `media-src/src/boot`: 3 failures, all load-related or the new case before its fix (final: guard file 7 passed; `finish-init.test.ts` passes alone, 11 passed, and timed out only inside the large parallel run); Chromium `external-update-pending-typing`, `save-flush`, `external-update-undo-base`: 23 passed; `npm run typecheck` exit 0; host `tsc` clean; Biome clean on changed files.

Real VS Code through the wrapper (start 03:12): `external-disk-change`, `doc-sync`, `save-fidelity`, `writeback-own-race`, `edit-in-text-editor`, `undo-host-coupling`, `undo-redo-steps`, `undo-first-edit` → exit 0, 24 passed, 14 skipped (the undo specs skip without the OS key setup). Second run with the OS key setup (start 03:19) for `undo-host-coupling`, `undo-redo-steps`, `undo-first-edit`: 14 tests, 13 passed, 1 failed (`formatting first: OS Ctrl+B and the Bold command`, "race window missed", a timing-window failure of that spec); rerun of that test alone passed.

### S9 closure (2026-11-01)

Gates: `node build.mjs` exit 0; `npm run typecheck` exit 0; `npm run lint` exit 0 (1266 files); `npm run typecheck:vscode-e2e` exit 0; focused Vitest (`external-change-guard`, `sync-state`, `doc-sync`, `editor-session`, `writeback-controller`, `history-coupling`, `module-boundaries`, `message-router`, `finish-init`): 9 files, 486 passed; Chromium `external-update-pending-typing`, `save-flush`, `external-update-undo-base`: 23 passed; `npm run quality`: `check:brand-identifiers`, `lint:ci`, `knip`, `jscpd`, `depcruise`, `test:coverage` (371 files, 7916 tests passed, 1 expected fail) and `check:coverage-modules` (10 modules at 0%, baseline 10) pass; `audit` fails on advisories in development dependencies (`@azure/msal-node`, `@vitest/mocker`), unrelated to this change. Real VS Code was not rerun after R1 (no product code changed since).

Open risks:
- The incident's U+200B-only line and the two-space indentation change inside the fenced block stay unexplained. Ruled out: IR/WYSIWYG serialization, the Split serializer's end case, and the swept Enter/arrow/click/paste paths (C5, C6). Not swept: exact-source transactions built from DOM text (auto-wrap, rewrap, find and replace). The H1 fix is the main candidate for an older-text write that also changes indentation.
- Follow-up (D6): Split mode rewrites a thematic break `---` as `***` on the first edit; the 646 spec maps the spelling for Split only.
- Typing right after a Preview checkbox toggle or an outline-tree host edit: those host edits count as outside changes and bump the revision when the change event fires; the update that carries the new revision follows (immediately for the checkbox, after the 75 ms debounce for the outline edit). Typing posted by the webview inside that window carries the older revision and is refused with the warning (before this task it would have overwritten the host edit). Reasoned from the code, not measured.
- The deferred-update replay during large-document streaming (H4) has no test.
- `undo-first-edit.spec.ts` "formatting first: OS Ctrl+B and the Bold command" is timing-sensitive in a long OS-key batch ("race window missed"); it passed alone.
- The final completion check returned "escalate": no claim was contradicted; three claims were rated unsupported because the evidence was a summary of test output, and the limiting rubric was test gap (H4 replay; no single test drives all modes of the Chromium path).

### Checkpoint

- Phase: all steps done (S1, S1b, S2, S3, S4, S5, S8, R1, S9; S6 and S7 dropped per D8). Ready to close; the closing owner moves the file and updates the index.
- Proven: acceptance 1–6.
- Follow-up for the orchestrator to queue (D6): Split mode rewrites `---` as `***` on the first edit.
