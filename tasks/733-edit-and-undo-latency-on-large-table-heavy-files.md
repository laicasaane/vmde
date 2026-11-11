# Task 733 — Edit and Undo/Redo latency on large table-heavy files

**Status:** in progress (2026-11-11). Approach C approved by the Owner; design complete; first task family planned and settled (design steps S0 to S4, eight tasks, ready to implement); no code changed yet.
**Origin:** Owner report, 2026-11-10.
**Severity:** high. Every editing operation, Undo and Redo on the Owner's 67 KB table-heavy document takes 100 to 570 ms, 2 to 11 times the Owner's 50 ms ceiling.
**Tech stack:** webview serializer and edit sync (`media-src/src/bridge/edit-sync.ts`, `bridge/incremental-md.ts`, `src/shared/incremental-admission.ts`), Undo engine patches and restore (`media-src/esbuild-shared.mjs`, `media-src/src/editing/undo-*.ts`), content CSS (`media-src/src/main.css`), decorators and observers (`media-src/src/links/*-decorate.ts`, `util/mutation-impact.ts`, `nav/source-block-index.ts`, `chrome/diff-markers.ts`), per-key spin (`editing/edit-activity.ts`, Vditor `ir/input.ts`), host write-back (`src/writeback/writeback-controller.ts`).
**Depends on:** none.

## Owner request

"Performance of all editing operations on this file is extremely bad. Severe regression. Performance of Undo/Redo also be worsen than the state at commit 5e7e1952."

Owner rule (2026-11-10): no operation may delay or block the user for more than 50 ms, in any file, at any size. Lower is better (40, 30, 20, down to 1 ms). Re-architecture and refactoring are allowed where feasible.

The Owner's document is private and is never committed. Committed tests use a synthetic fixture of the same shape: YAML front matter with 3 keys, 4 headings, a few short paragraphs, two wide GFM tables of about 130 and 65 body rows by 5 columns holding most of the text, many inline code spans and relative `.md` links in cells, one long cell, a few wide characters and escaped pipes.

## Measurements (real VS Code 1.129, xvfb, IR mode, before any fix)

Probe: `test/vscode-e2e/edit-latency-probe.spec.ts` (`@probe`, `VMDE_PROBES=1`, `VMDE_PERF_FILE=<document>`).

| Build | Paragraph typing median / p90 | Backspace median | Undo p90 | Redo p90 | Long-task ms during typing |
|---|---|---|---|---|---|
| 5e7e1952 | 309 / 497 | 117 | 564 | 590 | 4141 |
| 6829b14f | 106 / 278 | 101 | 730 | 423 | 2182 |

Single runs, noisy. A regression against 5e7e1952 is not clearly reproduced; both builds are far over the ceiling. The task therefore targets the 50 ms ceiling, not only a bisect.

Second-opinion measurements (Event Timing, no profiler, on `9f00ccf4`): typing at 300 ms cadence 160 to 208 ms per key with two long tasks; each Undo or Redo followed by one long task of 417 to 566 ms; Backspace in a table cell 128 to 144 ms; Enter in a cell followed by a 324 ms long task.

## Causes (confirmed by orchestrator spot-check against the code, 2026-11-10)

1. **The incremental serializer is never admitted.** `incrementalAdmission` (`src/shared/incremental-admission.ts:118`) needs 700 top-level blocks, or 350 blocks with 30,000 characters and nested structure. The document has 12 blocks, two of them tables with 97% of the text. So `serializeForHost` (`edit-sync.ts:552`) ends in a full `vditor.getValue()` (134 to 172 ms here), `historyText` (`:605`) does the same, and `checkpointHasNothingNew` (`:1453`) never skips. Typing runs 3 full serializations per burst (overdue post inside the `input` handler, idle post, recorded-entry flush); each Undo runs 3 or 4.
2. **The block is the wrong unit.** A table block costs 70 ms to serialize and 389 ms to re-spin. Admitting the incremental path at block level is not enough; table cells must be units. A row cannot be serialized alone (Lute pads cells to the column width); a cell can.
3. **Document-wide style recalculation.** The child-form `:has()` rules in `media-src/src/main.css` (36 occurrences; for example `:3596`, `:3601`) make any element insertion cost about 25 ms of style recalculation; each keystroke forces 2 to 4 of them (caret marker, `<wbr>`, `addRange`). Measured by the second opinion; which rule or rules cause it is not yet isolated.
4. **Whole-editor Undo snapshots.** `addCaret` clones the editor and reads `innerHTML` (25.7 ms per call); `addToUndoStack` diffs two 321 KB strings; `renderDiff` plus `restoreSnapshotBlocks` and caret restore parse both snapshots and project blocks.
5. **Decorators walk the document.** `code-ref-decorate.ts:337` and `bare-url-decorate.ts:323` do a full walk on every `selectionchange` (`run([])`); `scopeMutations` falls back to a full walk above 6 touched blocks (`mutation-impact.ts:109`); `source-block-index` drops its index on any mutation; `diff-markers.ts:121` runs a full `getValue()` after each host `diff-info`.
6. **Cell edits spin the whole table.** `edit-activity.ts` skips the per-key spin only for letters and a few safe characters; punctuation, deletion, Enter and paste spin the caret's top-level block, which for a cell is the table.
7. **Other modes and the host** (inferred from code): WYSIWYG has no incremental path; Source clones the editor per post; mode switch renders the whole document; front-matter and table actions call `getValue()` several times and `setValue`; every plain edit posts the whole serialized text.

Second-opinion document and detailed report: local files under `tmp/733/`, not committed.

## Approach

Recommended by the second opinion and accepted by the orchestrator as the plan (subject to the Owner's answers below): reach a text-model architecture in stages, starting with Step 1, which removes whole-document work from the IR edit, Undo and Redo paths.

- Step 1a: replace the costly `:has()` rules with state classes set by the owning modules.
- Step 1b: admit the incremental serializer for every IR document, add table-cell units with a JavaScript table assembler that takes column widths from Lute's own output, serve history reads and checkpoints from the cache, move the full-`getValue()` audit off the edit path.
- Step 1c: unit-level Undo snapshots and entries behind Vditor's existing `Undo` interface.
- Step 1d: decorators and indexes follow dirty units; no full walks on `selectionchange`.
- Step 1e: spin the edited cell, not the table.
- Later steps (pending the Owner): edit-delta protocol and text model (C), history as unit transactions, other modes, Worker for oversize units (D).

## Decisions

1. Owner, 2026-11-10: approach C is approved as the destination. The webview keeps the host's exact Markdown text and an index of units (top-level block, top-level list item, table cell) as its primary state, and sends text deltas to the host. The earlier Step 1 parts (CSS, unit-level Undo, scoped decorators, cell spin) are steps of that design, not a separate plan.
2. Design status, 2026-11-10: the design document (`tmp/733/approach-c-design.md`, local) defines steps S0 to S12 and was reviewed against the code by an independent reviewer. It is not yet planned as a task family; no code has changed.
3. Provisional decisions PD-1 to PD-8 (in the design document, section 15), pending the Owner:
   - PD-1: a table row or column change writes only the changed lines, without Lute's padding. In-cell edits keep today's bytes in the common case.
   - PD-2: documents with reference definitions, footnotes or a table of contents block stay on the whole-text path until the last step.
   - PD-3: the webview may use a `blob:` Worker (one CSP change) for oversize units, seeding and audits.
   - PD-4: no acknowledgement per delta; a refused delta causes one host update.
   - PD-5: the Undo engine's storage is replaced behind an interface.
   - PD-6: the 50 ms ceiling is for the webview main thread; the host write completes asynchronously.
   - PD-7: the save audit becomes a rotating per-unit audit in idle time.
   - PD-8: blank-line runs between untouched blocks keep their bytes.
4. Owner, 2026-11-10: existing open-source libraries are to be researched so that the approach reuses community code and keeps the project's own code small. Replacing libraries the project depends on today (including the editor core) is an allowed choice. The research and its recommendation are recorded in the design document.
5. Owner, 2026-11-10: security stays a hard requirement for every library choice, dependency replacement and architecture change. The design document states the resulting rules (host validation of webview messages, no unsanitized path to the DOM, no looser Content-Security-Policy by default, the audit gate for every new dependency, no document content in logs). PD-3 (a `blob:` Worker) needs a Content-Security-Policy change and is therefore a separate Owner decision at that step, not a default.
6. Library research, 2026-11-10 (design document, section 18). Recommendation: keep Vditor and Lute and build approach C; use `@codemirror/state` for change sets in the text model (PD-9), `fast-check` for property tests, the already bundled `diff-match-patch` for multi-span diffs; replace Vditor's Source mode with CodeMirror 6 in the Source step (PD-10); serialize oversize units in the extension host before considering a Worker (PD-3 changed). A full replacement of the editor core by CodeMirror 6 and Lezer is the only replacement that meets byte fidelity and the latency rule, and is not recommended now because pure WYSIWYG and rich table cells would have to be built and about 87% of the webview code rewritten. Upstream Vditor and Lute offer nothing that shortens the design.
7. Library measurements, 2026-11-11 (design document, section 18.7; the Owner approved installing the candidate packages in a scratch folder outside the repository). `@codemirror/state` costs 48.4 KB of the `main.js` size budget and is not needed for speed (a plain string splice costs under 5 ms up to size factor 16); PD-9 stays provisional, with own change arithmetic tested against `@codemirror/state` as the recorded alternative. Neither `scanMovableBlocks` nor `@lezer/markdown` agrees with Lute on every fixture, so the per-unit proof stays. `diff-match-patch` cuts surrogate pairs; every computed range is widened to pair edges before it enters a delta. The audit of the candidate packages is clean. Serializing an oversize unit in an extension-host worker thread adds under 8 ms to the Lute call.

8. Task family, 2026-11-11. The first family covers design steps S0 to S4 and the first part of S7 in eight tasks (checklist below). Its contracts are local planning documents and are not committed. Provisional choices that the plan acts on, pending the Owner: PD-1, PD-2, PD-4, PD-6, PD-7, PD-8; PD-9 changed to own change arithmetic with `@codemirror/state` as a development-only test oracle (steps S0 to S4 need only three operations, and the library would add 48.4 KB to the eagerly loaded bundle); the `:has()` step replaces the 8 partner rules and keeps the hub rules (measured: 0 ms with the partner rules removed); no `diff-match-patch` use before the step that needs multi-span diffs; counter gates run in the real-VS-Code suite, not in the unit-test pipeline; documents that the block scanner declines (indented code and two other cases, 8 of 140 fixtures) stay on the whole-text path until a scanner follow-up; the `main.js` size budget is raised by the measured size of the model modules when its gate fails. PD-3, PD-5 and PD-10 concern later steps.
9. Settling, 2026-11-11 (Owner: settle everything so that the family can run). The plan's interfaces were reviewed against the code by an independent reader; its 12 findings are folded into the contracts. Main corrections: a write by the host outside the delta stream (whole-text fallback, history transition, block action, save-time correction) must never be followed by a delta against the old text, so the webview waits for the host's answer and the host starts a new epoch for its own writes; a resynchronization update is always posted; a fallback publication clears the model's dirty state so that the host's answer can be applied. Measured in VS Code 1.129: one ranged edit gives one change event whose change list is a minimal diff in descending order, so the host recognizes its own write by the predicted text, not by the change list; one Undo reverts one ranged edit; CRLF documents stay CRLF. Lute facts checked: an ordered list item serialized alone becomes `1.`, so such items change through the list path; delimiter rows are written unpadded. The source-level handoffs for tasks 2 to 7 are written; 14 view-only writer modules get quiet writes so that decorations do not mark units as changed.

## Task family 1 (design steps S0 to S4)

- [x] 1. Synthetic fixture, counters, counter gates recorded as expected failures, latency and style probes, baseline numbers (S0).
- [x] 2. The 8 partner `:has()` rules replaced by sibling selectors or state set by the owning modules; a test freezes the remaining rules (S1).
- [ ] 3. Text model core, pure: change arithmetic, per-unit Lute functions, build, proof, rebind, publication rules, property tests (S2).
- [ ] 4. Unit DOM on the live IR editor in shadow mode: one observer, idle and pre-touch proofs, rotating audit, comparison with the host bytes, pairing coverage report (S3).
- [ ] 5. Source-block index and block handle read model units: no whole-document Lute call on pointer move or selection change (first part of S7).
- [x] 6. Delta protocol, host side: validation, epoch, sequence and `oldText` guards, own-write detection, resynchronization (S4).
- [ ] 7. Delta publication in the webview, live for IR: no whole-document serialization and no whole-text message while typing (S4).
- [ ] 8. Family review, repairs, closure gates.

After this family, typing letters in IR is expected at or under the 50 ms ceiling. Backspace, Enter and punctuation in a table cell (unit spin, S5) and Undo and Redo (unit history, S6) stay above it until the next family.

## Acceptance

- [ ] On the synthetic fixture at size factors 1, 4 and 16, in IR mode, every gated operation (type at 80 and 300 ms cadence, Backspace, Enter, paste, Undo, Redo in a paragraph, a table cell, a list item and a code block) is 50 ms or less (Event Timing duration), with no long task over 50 ms in the 3 s after it.
- [ ] The same holds on the Owner's document through the latency probe (local only).
- [ ] Counter gate: zero full `getValue()` calls, zero whole-editor `cloneNode` and zero root `innerHTML` reads during typing, Backspace, Undo and Redo.
- [ ] Serializer output is byte-identical to `getValue()` (incremental fuzz extended with tables; table assembler differential test against Lute).
- [ ] Save fidelity, exact ownership and Undo/host coupling specs pass unchanged.
- [ ] Focused real-VS-Code specs and `npm run quality` pass.

## Verification

### Step 1 (S0): fixture, counters, gates, probes — 2026-11-11

- Unit tests: `npm test` 403 files, 9556 passed, 1 expected failure. New: `test/backend/table-heavy-markdown.test.ts`, `media-src/src/testing/edit-counters.test.ts`.
- Counter gates (`test/vscode-e2e/edit-counter-gates.spec.ts`, one real-VS-Code run): the positive control proves every counter family fires (`fullGetValue` 1, `luteDocument` 1, `luteTable` 1, `rootClone` 1, `rootInnerHtmlRead` 2); the four annotated gates fail as expected. Counter values that make them fail, synthetic fixture factor 1:

  | Gate (red until) | Place | Values |
  |---|---|---|
  | Typing and Backspace publish as deltas (step 7) | paragraph / table cell / list item / code block | `fullGetValue` 11 each; `luteDocument` 11 / 56 / 11 / 11; `legacyEditPosts` 11 each; `deltaPosts` 0; `maxPostBytes` about 96,800 |
  | Pointer move and selection change (step 5) | table, then paragraph | `luteDocument` 10, `luteTable` 6, `fullGetValue` 1 |
  | Keys in a table cell (S5) | table cell | `luteTable` 4, `luteDocument` 15 |
  | Typing, Undo and Redo (S6b) | paragraph | `rootClone` 12, `rootInnerHtmlRead` 38, `fullGetValue` 25 |

- Latency probe (`@probe`, local, factor 1; Event Timing maximum in ms / long tasks in the 3 s after): first pointer move over a table 1296 / 2; paragraph: type at 80 ms 64 / 4, Backspace 72 / 2, Enter 416 / 4, Undo 224 / 6, Redo 280 / 6; table cell: type at 300 ms 264 / 23, Backspace 368 / 8, Enter 464 / 3, Undo 232 / 11; list item Enter 768 / 5; code block Enter 760 / 5. All 30 gated operations exceed the ceiling at factor 1; at factor 16 the worst is 11,496 ms (first pointer move).
- Style probe (`@probe`, local): one span inserted into a table cell, median 6.8 ms, maximum 9.4 ms (target after step 2: 2 ms or less).
- Bundle: `media/dist/main.js` 1140 KB (budget 608 KB, already exceeded before this step at 1137 KB; reporting only).

### Step 2 (S1): partner `:has()` rules to state — 2026-11-11

- The 8 partner rules are replaced: two by sibling or subject selectors with no state, six by state that the owning modules write (`vmde-emoji-open` on the toolbar, `data-vmde-source-pane="hidden"` on the content element from a new source-pane state module, the existing submenu `aria-expanded`, and a collapse-item class). No writer observes the editor root. `test/backend/css-has-rules.test.ts` freezes the remaining `:has()` rules.
- Style probe (`@probe`, assert flag on, factor 1): one span inserted into a table cell, median 0 ms, maximum 0.1 ms (step 1 baseline: median 6.8 ms, maximum 9.4 ms).
- Unit tests: `npm test` 405 files, 9577 passed, 1 expected failure. Real VS Code: `has-state-rules.spec.ts` and the dependent toolbar, preview, front-matter and diagram specs pass (42 tests over two rounds); Chromium toolbar and code specs 109 passed. Visual goldens: 7 passed, 2 failed (`visual.spec.ts:221` and `:229`, table render), which fail the same way on the step 1 commit.
- Found and fixed while verifying: the submenu-state observer read a stale emoji panel after the picker replaced it, which set the emoji control's popup type to menu.

### Step 6 (S4, host side): delta protocol — 2026-11-11

- The host accepts `edit-delta` messages: shape table entry, a pure validator (integer epoch and sequence, 1 to 256 ascending non-overlapping changes, 4,000,000-character limit, ranges inside the document, no edge inside a surrogate pair, no no-op change), the epoch and sequence guards and the `oldText` guard per change, one `WorkspaceEdit` per delta through the existing write queue, and own-write (echo) detection by the predicted text. A refused delta starts a new epoch and posts one `update`; after 5 refusals within 10 s the host refuses deltas for 10 s and answers the first refused delta of each epoch with an `update`.
- Every host write other than an accepted delta, a whole-text edit and an accepted history transition starts a new epoch. A whole-text edit that asks for it, and a history transition that carries a sequence, are answered exactly once with `rebind`. A block action or an outline section move announces its new epoch on its existing outcome message, so the webview's content and Undo history stay as before. `baseline` follows a clean save; `restore-baseline` replaces the deferred no-op restore once deltas were accepted. Logs carry kinds, counts, lengths, epochs and sequences only.
- The webview ignores the new host messages until step 7.
- Unit tests: `npm test` 408 files, 9708 passed, 1 expected failure; coverage ratchet unchanged (9 modules at 0%). Real VS Code: `save-fidelity`, `undo-host-coupling`, `undo-routing-hygiene`, `external-disk-change`, `exact-actions-after-trusted-edit` pass (an Undo-after-block-move regression found in the first run was fixed; the two files rerun: 12 passed).
- Independent review: 2 major and 8 minor findings, all fixed or recorded; one follow-up finding fixed after the re-review.
