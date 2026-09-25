# Task 573 — Large-document opening and pointer/scroll performance

> **For agentic workers:** Use `superpowers:executing-plans` to implement this record one checkpoint at a time. This is the complete implementation handoff; do not start a new architecture investigation.

**Status:** closed — Project Owner approved closure on 2026-09-25 with baseline gate exceptions preserved. Behavioral acceptance is complete; the final repository-wide gate below remains unchecked and no quality-green claim is made. Checkpoint commits: cf00f335, ff6e19b0, ce1c81a5, 43943b5a, 8c0e6ce0; final validation evidence commit: 200385b9.
**Goal:** Remove redundant whole-document work during opening and repeated pointer movement, and make table resize decorations scale with the viewport during scrolling.
**Architecture:** Keep Vditor/Lute and the existing exact-source transaction path. Reuse the known initial content for caret admission, use layout-free code-copy text reads, cache block-handle presentation before acquiring Markdown, and separate table-handle geometry reads from writes.
**Tech stack:** TypeScript, Vditor source patches, Lute, Vitest, Chromium Playwright, real VS Code Playwright.
**Spec:** The problem, evidence, constraints, and acceptance sections in this task are the specification. Origin: Project Owner report of slow opening and scrolling in a large Markdown document, 2026-09-25.

## Reproduction input and boundaries

Use `test/vscode-e2e/fixtures/large-observable-models-synthetic.md` for every committed test and benchmark. The owner explicitly requested a gibberish copy preserving characters per word, and then requested that copy be used for tests. Never commit the original file or print its content in profiles, reports, screenshots, or failures. Read-only measurements may open the committed fixture directly; editing/save/history journeys must copy it into the test's `baseDir` first.

Prerequisites already exist: Tasks 219 (session table widths), 259 (validated block actions), 413 (large-document containment), 439/446 (empty-file caret), 529/537 (incremental serialization), and 538 (host propagation). Do not reopen the deferred native-Lute reference-link Task 572. Keep both local queue files untracked and unstaged. At closure, the Project Owner explicitly authorized updating only the Task 573 marker/progress/link in `LOCAL_AGENT_TASK.md`; `LOCAL_AGENT_TASK_FUTURE.md` stayed unchanged. Keep this task in `tasks/` while active; archive it and update `tasks/README.md` only after implementation is complete.

## Global constraints

- No changes to Markdown bytes, source ownership, undo/redo, host writeback, or save/reopen semantics. Do not drop source-proof checks to improve a timing.
- No Lute fork, Worker, document virtualization, new performance setting/dependency, lowered streaming threshold, or disabled code highlighting/folding/handles.
- Do not remove the table-whitespace repair or its `Md2HTML` oracle. It is visible in the profile but protects authored source.
- Preserve `content-visibility` and its existing heading/gutter exclusions. An initial estimated scroll height changing as blocks become visible is not proof of a broken scroll handler.
- Preserve table widths as session-only state, 48 px minimum, keyboard steps, double-click auto-fit, horizontal overflow, exclusions for unsupported tables, and width reset on reopen.
- Change source/anchored patches only. Do not edit `node_modules`, `dist`, `media/dist`, or vendored/generated output.
- Read `DEVELOPMENT.md` and applicable VMDE Lute/testing skills; apply TypeScript/CSS rules. Build before real VS Code; run only one real-VS-Code invocation at a time.
- Each checkpoint gets its own focused local commit after its tests pass. Do not push. Unexpected source/history ambiguity requires a bounded handoff, not a guessed fix.

## Diagnosis: call paths and causal mechanisms

1. **Opening: unnecessary full serialization.** `boot/finish-init.ts::runFinishInit` calls `editing/initial-caret.ts::placeInitialCaret`. That function calls `vditor.getValue()` before deciding a nonempty document needs no initial caret. The authoritative initial `msg.content` is already available. On the reported file, CPU sampling attributed about 191 ms to this full serialization (about 193 ms including caret admission).
2. **Opening: forced rendered-text/layout reads.** Vditor `ts/markdown/codeRender.ts` reads `e.innerText`, inserts copy-control DOM and writes styles, then reads the next block's `innerText`. The mapped profile attributed about 148 ms self time to this loop. This is copy-button text extraction, not evidence that C# syntax highlighting itself is the dominant cost.
3. **Pointer movement while scrolling: snapshot before cache.** `nav/block-handle.ts::hover → unitAt → units` calls `actions.snapshot()` on every document `mousemove` inside the editor. `finish-init.ts` supplies both `snapshotExactMarkdown()` and unconditional `window.vditor.getValue()`. Only afterward can `resolveBlockHandleUnits` look at its cache. On misses, it can serialize the root, render a detached copy and prove individual source groups; rejected maps are not cached. Thus even an unchanged document pays for full serialization before a potential cache hit.
4. **Pure scrolling: global table overlay work.** `chrome/table-resize.ts::sync` runs from a capture-phase scroll listener. It rescans every table, checks its complete row shape, and alternates each header-cell rectangle read with handle style/attribute writes. On the reported file, 100 scroll frames caused about 2,700 header reads (27 headers), including offscreen tables. This is a confirmed unnecessary workload, but its observed 1–3 ms/frame did not by itself explain a severe freeze on this machine.

The initial source-file profile was collected at `75443d50`, after `node build.mjs`, in real VS Code 1.129.0. The document is 174,527 bytes, 2,334 lines; the IR DOM had 265 direct blocks, 11 tables, 27 header cells and 36 code-block nodes. It enables the ≥100 KB containment path and does not reach the >700 KB streaming path. A cold opening observation included a roughly 985 ms long task. The open profile's inclusive totals overlap; do not add them together. These are local diagnostic measurements, not universal performance guarantees or installed-VSIX evidence.

## Synthetic-fixture measurements (2026-09-25)

The recreated fixture is 174,527 bytes / 174,517 characters / 2,334 lines. All 22,380 ASCII alphabetic-run lengths and the full punctuation/whitespace skeleton match the source. The transformation replaced 21,473 token occurrences, retaining 579 syntax occurrences: 538 C# reserved keywords, 36 fence labels, one URI scheme and four relative-link extensions. Its SHA-256 is `a4a39d6f6c605eb82b0e03a236f67388bceeae9a85450b0d4285053b28299f65`. Letter substitution preserves lengths, not glyph widths; the synthetic DOM had 2,863 descendants versus 2,973 in the initial source-file run, while direct-block/table/header/code-block counts matched. Treat absolute timings as fixture-specific.

Controlled real-VS-Code IR experiment, unchanged production build:

| Measurement | Baseline | Only block-handle hover suppressed |
| --- | ---: | ---: |
| 12 actual pointer + wheel steps | 7,134 ms | 584 ms |
| Block-handle hover callback | 6,548 ms total; 798 ms worst | suppressed for diagnosis |
| Full `getValue` calls inside hover | 24; 2,202 ms total | zero from that handler |
| Pointer-phase long tasks | 12; 497–800 ms | none observed |

This is a causal diagnostic, not an acceptable production fix: hiding/disabling block actions is prohibited. The same run's pure-scroll phases had no >50 ms frame gaps; 100 frames still performed 2,700 table-header reads. This separates the major pointer/scroll interaction failure from the smaller table-decoration cost. Rejected block mappings need caching too: the costly baseline hover never reached handle geometry (`rects=0`).

A synthetic startup CPU profile mapped about 232 ms inclusive to the initial-caret full serialization and about 179 ms self time to the code-copy `innerText` loop. The broader Lute render/repair work remains necessary. Local raw diagnostic aggregates and source-mapped profiles are in ignored `tmp/large-open-scroll-synthetic-baseline.json` and `tmp/large-open-synthetic-baseline-0.cpuprofile`; these optional local artifacts are not prerequisites for implementing the task. The retained `large-document-interaction-probe.spec.ts` reproduces the unmodified workload without suppressing any product handler.

## Review focus

- Same DOM, different exact source: external replacement/Undo can change raw whitespace or reference definitions without a useful visual difference. Cached offsets must expire.
- Same nodes, edited content: `characterData`, `href`, `src`, source attributes, and pending observer records must invalidate before the next action, even before observer delivery.
- Unsupported/ambiguous documents: cache a rejected presentation result, but retry after genuine invalidation; never enable actions from stale offsets.
- Hidden surfaces and distant tables: IR/WYSIWYG/Preview switching, re-init, detached roots and horizontal scroll must not leave ghost resize or block handles.
- Empty/whitespace-only files and code-copy edge cases: preserve the existing painted caret contract, tabs/NBSP/newlines, highlighted spans and line-number exclusion.

## Checkpoint 1 — Freeze a meaningful baseline

**Files:** use the synthetic fixture and the retained real-VS-Code diagnostic; extend `media-src/e2e/block-handle.spec.ts`, `media-src/e2e/table-resize.spec.ts` and a focused `test/vscode-e2e/large-document-interaction.spec.ts` during implementation.

- [x] Read this task plus the related source functions above. Record current commit, build identity, VS Code version, mode, content-visibility state, file bytes and structural counts.
- [x] Separate four phases: opening to the existing `__vmdeE2EReadiness` editor-ready signal, programmatic scroll with the pointer outside content, pointer movement over unchanged content, and actual `workbox.mouse.move` plus `workbox.mouse.wheel` input. Do not call programmatic `scrollTop` changes a user-input reproduction.
- [x] Count full `getValue`/Lute serialize calls and time them, count header-cell rectangle reads, and sample rAF gaps. Instrument only in tests; aggregate counts/times only. Never include Markdown in an assertion failure.
- [x] Run the unchanged baseline three times serially. Record median, worst frame gap and long-task count; distinguish the first proof from warmed repeated hover. Record a small-document control using the existing small block-handle fixture.
- [x] Add initially failing mechanism regressions in the owning checkpoints below, one checkpoint at a time. The existing measurement probe passing means it executed, not that performance is fixed. Run it with:

```bash
node build.mjs
env -u ELECTRON_RUN_AS_NODE xvfb-run -a npm --prefix test/vscode-e2e run test:probes -- large-document-interaction-probe.spec.ts --retries=0
```

## Checkpoint 2 — Avoid serializing nonempty documents for initial caret admission

**Modify:** `media-src/src/editing/initial-caret.ts`, `media-src/src/boot/finish-init.ts`.
**Tests:** `media-src/src/editing/initial-caret.test.ts`, `media-src/src/boot/finish-init.test.ts`, `test/vscode-e2e/caret-on-open.spec.ts`, the new large-document spec.
**Interface:** `placeInitialCaret(vditor: unknown, initialMarkdown?: string): boolean`.

- [x] Add a unit regression with a known nonempty initial payload and a throwing/spied `getValue`. Assert no serialization, no selection/focus change, and consumption of the existing one-shot guard.

```ts
it('does not serialize a known nonempty initial document', () => {
  const { editor } = mountEditor('<p>Nonempty</p>')
  const getValue = vi.fn(() => { throw new Error('unexpected serialization') })
  const outer = { vditor: { currentMode: 'ir', ir: { element: editor } }, getValue }
  expect(placeInitialCaret(outer, '# Nonempty\n')).toBe(false)
  expect(getValue).not.toHaveBeenCalled()
  expect(window.getSelection()?.rangeCount).toBe(0)
})
```

- [x] Run the focused unit and observe the behavioral failure before changing production code.
- [x] After the existing `placed`/editable-root guards, add only the known-nonempty short circuit:

```ts
if (initialMarkdown !== undefined && /\S/u.test(initialMarkdown)) {
  placed = true
  return false
}
```

- [x] Pass `msg.content` at `runFinishInit`'s call. For absent, empty or whitespace-only initial content, retain the current live `getValue()` check and `requestCaret('document-start')` flow. This conservative fallback protects an initially empty document edited before initialization completes.
- [x] Cover whitespace-only input, no root, existing caret, second call/re-init, and unknown-content fallback. Keep the real empty-document typing/paint assertion intact; verify the large fixture opens without a caret-triggered full serialize.
- [x] Run focused tests, review the diff and commit this checkpoint.

## Checkpoint 3 — Remove layout-dependent text reads from code-copy decoration

**Modify:** `media-src/esbuild-shared.mjs`, `test/backend/vditor-source-patches.test.ts`, `docs/vditor-patch-checklist.md`.
**Tests:** add `media-src/e2e/code-copy-text.spec.ts`; extend the focused real-VS-Code large-document spec.
**Interface:** export `patchCodeRenderTextContent(code: string): string`; compose it with `patchCodeRenderSkipDiagram` and `patchCodeRenderCopyButton` in `VDITOR_TS_PATCHES`.

- [x] Add an anchor-contract test against the actual pinned Vditor `codeRender.ts`. It must replace both text reads and throw if either expected anchor is absent. Exercise composition with the existing diagram/copy patches.
- [x] Implement these exact anchored replacements, with the repository's fail-loud error pattern:

```ts
'let codeText = e.innerText;'             // becomes:
'let codeText = e.textContent || "";'
'codeText = codeElement.innerText;'       // becomes:
'codeText = codeElement.textContent || "";'
```

- [x] Preserve `highlight-chroma` cloning/removal of `.highlight-ln`, ordinary trailing-newline removal, `code160to32`, renderMenu, diagram exclusions, existing max-height behavior and delegated copy event handling. Do not replace `innerText` globally.
- [x] In Chromium, render code with tabs, blank lines, an ending newline, NBSP, escaped `<>&`, highlighted nested spans and line numbers. Compare copy textarea/clipboard payloads with the expected text, not just their lengths. Compare `getValue()` before/after decoration. Include IR, WYSIWYG and Preview.
- [x] Wrap the code elements' `innerText` getter in the test before decoration and assert zero reads from this code-copy path. Keep copy controls present and keyboard/mouse copy usable.
- [x] Rebuild, run the focused real-VS-Code opening/copy check, record the change in opening long tasks, then commit.

## Checkpoint 4 — Cache block-handle presentation before taking Markdown snapshots

**Modify:** `media-src/src/nav/block-handle.ts`, `media-src/src/bridge/edit-sync.ts`, `media-src/src/boot/vditor-init.ts`, `media-src/src/boot/finish-init.ts`, `media-src/e2e/block-handle-harness.ts`. Task owner authorized a bounded extension on 2026-09-25 in `media-src/src/editing/block-transform-command.ts` to stop `selectionchange`-driven full snapshots while retaining source proof.
**Tests:** `media-src/src/nav/block-handle.test.ts`, `media-src/src/bridge/edit-sync.test.ts`, `media-src/src/editing/block-transform-command.test.ts`, `media-src/src/boot/finish-init.test.ts`, `media-src/e2e/block-handle.spec.ts`, the focused large-document real-VS-Code spec, and existing QuickPick/history real-VS-Code specs.

**Interfaces:** add `EditSync.snapshotRevision(): object`; add `snapshotRevision(): object | undefined` to `FinishInitDeps` and `BlockHandleActions`. It is a stable opaque identity for current exact-source authority, not a hash or serialized string. Supply it from the current `sessionState.editSync`; when authority is unavailable, bypass the presentation cache rather than inventing a reusable key.

- [x] Add a unit regression that sends 30 mousemoves across two unchanged blocks and spies on `actions.snapshot`. Expect one resolution/snapshot for the generation, including when the resolver returns `null`. Cover movement within one block and across blocks.
- [x] Implement the revision token in `createEditSync`:

```ts
let snapshotRevision = {}
const invalidateSnapshotRevision = () => { snapshotRevision = {} }
// Returned read-only method:
// snapshotRevision: () => snapshotRevision
```

- [x] Advance the token on trusted `markUserInput`, `postExact`, `reseed`, `invalidate`, `dispose`, and when `snapshotExactMarkdown` revokes a mismatched exact/rendered pair. Reading/establishing an unchanged rendered baseline must not advance it. Add tests for each transition, especially new exact bytes with identical canonical DOM. Keep writeback behavior untouched.
- [x] Implement `flushPendingMutations()` locally by draining the active observer and incrementing `domRevision` for any relevant records. Implement `readCheapKey()` by reading `getActiveRoot()`, `currentBlockProjection()` owner/mode and `actions.snapshotRevision()`; return no key and bypass reuse when any authority is absent. Implement `sameKey()` as identity equality for all five fields: `root`, `owner`, `mode`, `revision`, `domRevision`. Rename existing `units()` to `resolveFreshUnits()` for the unchanged snapshot/proof path.
- [x] Add a separate controller-local presentation cache ahead of `actions.snapshot()`. Key it by active root, Lute owner, mode, revision identity and a drained DOM-mutation generation. Store both `BlockHandleUnit[]` and `null`. Reuse the existing source proof unchanged on misses.

```ts
// Algorithm inside presentation lookup; these names describe the new local state.
flushPendingMutations()
const key = readCheapKey() // root, owner, mode, snapshotRevision; no Markdown work
if (presentation && sameKey(presentation.key, key)) return presentation.units
const units = resolveFreshUnits() // existing snapshot + validated resolver
presentation = { key: readCheapKey(), units } // snapshot may revoke exact authority
return units
```

- [x] Observe `childList` and `characterData` plus semantic attributes on the active root. Drain `takeRecords()` synchronously before cache reuse. Class/style/ARIA-only decorations may be ignored; changes to `href`, `src`, `data-marker`, `data-type`, `data-block`, `data-render`, `contenteditable` and other source-bearing attributes must invalidate. Be conservative on unrecognized records. Rebind/dispose on root/mode/owner changes. Do not install a global observer dispatcher.
- [x] Update every `installBlockHandleLayer` call site and mock. In the Chromium harness, advance a stable token on `apply`, `setValue`, and assignments to the exact-source test seam so identical-DOM/raw-source tests cannot accidentally reuse old offsets.
- [x] Retain proof and fresh-source validation for drag start/drop, keyboard move, Duplicate/Delete/Turn Into. A presentation cache must never itself authorize an edit. Before a menu action, re-resolve the current target element against fresh units and reject it if detached, ambiguous, or no longer the hovered source group. Avoid reusing `active.start` after intervening input. Clear active/menu/drag state on invalidation where it cannot be safely revalidated.
- [x] Add tests for cached rejection becoming valid, text-node edits before observer delivery, changed URL/image attributes, exact bytes changing without DOM change, external replacement, Undo/Redo, hidden Preview, root replacement, disposal, duplicate paragraphs and HTML/details/list groups. Reuse the existing Task 259 fidelity fixtures and action pipeline.
- [x] Assert zero additional snapshots/full serializations during 30 warmed mousemoves and pointer+wheel events in both IR and WYSIWYG. Assert one fresh resolution after an invalidation and no edit from a stale handle. Record the initial cold-proof cost separately; do not hide it in a warmed average.
- [x] Run focused units, Chromium and rebuild-first real VS Code, review source/history results, then commit.

## Checkpoint 5 — Bound table resize geometry work to visible headers

**Modify:** `media-src/src/chrome/table-resize.ts`; split a helper only if required to keep lifecycle/measurement responsibilities clear.
**Tests:** `media-src/src/chrome/table-resize.test.ts`, `media-src/e2e/table-resize.spec.ts`, `test/vscode-e2e/table-column-resize.spec.ts`, the focused large-document spec.

- [x] Add a failing Chromium regression with the synthetic file. Instrument `getBoundingClientRect` on table headers: scrolling a viewport containing no table header must not read all offscreen headers. A visible table's handles must still track its borders within 3 px.
- [x] Split the existing `sync` into membership reconciliation and geometry update. Reconcile table eligibility/header arrays on structure changes and mode/root replacement. Scroll events schedule only geometry; do not revalidate every row of every table per scroll tick.
- [x] Track visible header rows using `IntersectionObserver` rooted in the actual editor scroller, not the webview window. Observe one header-row target per eligible table; retain an actively dragged table until mouseup. Hide handles immediately when their table/header exits the viewport or the editor surface is hidden. Use observer clipping plus explicit root bounds for horizontal-overflow wrappers.
- [x] In each geometry frame, read all needed rectangles first, then write handle styles/ARIA. Compare existing values before writing. Do not read a later cell rectangle after writing an earlier handle.

```ts
const measurements = visibleEntries.flatMap(({ cells, handles }) =>
  cells.map((cell, index) => ({ handle: handles[index], rect: cell.getBoundingClientRect() })),
)
for (const measurement of measurements) applyHandleGeometry(measurement)
```

- [x] Membership changes, window/editor resize, table resize, font/layout changes, horizontal scrolling, mode switches and re-init must schedule the appropriate pass. Disconnect observers and remove handlers on dispose. Keep detached-table width cleanup and no-source-metadata rules intact.
- [x] Verify drag/clamp/auto-fit/keyboard behavior on the first and a distant table, horizontal overflow, offscreen→onscreen→offscreen transitions, Preview visibility, and width reset after reopen in both edit modes. Preserve all existing unsupported-table exclusions.
- [x] Run focused tests, review viewport-bounded read counts and source-byte stability, then commit.

## Final acceptance and validation

- [x] Synthetic-fixture opening performs no full-document serialization merely for nonempty caret admission and no code-copy `innerText` reads.
- [x] Repeated pointer/wheel movement on an unchanged document does not reacquire Markdown or rerun source proof. Negative results are bounded to one resolution per valid generation. Actual edits/actions still validate against fresh source.
- [x] Table-header geometry reads scale with visible/actively dragged headers, not all document tables; reads precede writes.
- [x] On three matched serial runs, record open-to-ready, longest open task, cold first hover, warmed pointer+wheel time, full-serialize counts and scroll rAF p95/max. Target at least 90% less repeated pointer serialization time and a measurable opening reduction; use mechanism assertions for CI, not a machine-specific absolute millisecond ceiling. Investigate any pure-scroll or small-document regression rather than averaging it away.
- [x] Exact host and disk Markdown remain unchanged after open, hover, wheel, table resizing and mode changes. For editing journeys, test one real edit/save plus Undo/Redo and reopen against a test-directory copy.
- [ ] Run focused coverage and inspect changed lines. Run the applicable focused Chromium specs and build-first no-retry real-VS-Code specs; then the routine tier and final implementation gates in `DEVELOPMENT.md`.

```bash
npm test -- media-src/src/editing/initial-caret.test.ts media-src/src/boot/finish-init.test.ts media-src/src/nav/block-handle.test.ts media-src/src/chrome/table-resize.test.ts test/backend/vditor-source-patches.test.ts
xvfb-run -a npm --prefix media-src run test:e2e -- block-handle.spec.ts table-resize.spec.ts code-copy-text.spec.ts
node build.mjs
env -u ELECTRON_RUN_AS_NODE xvfb-run -a npm --prefix test/vscode-e2e test -- large-document-interaction.spec.ts caret-on-open.spec.ts block-handle.spec.ts table-column-resize.spec.ts --retries=0
env -u ELECTRON_RUN_AS_NODE xvfb-run -a npm run test:vscode:fast
npm run typecheck
npm run typecheck:strict
npm run typecheck:vscode-e2e
npm run check:bundle-size
npm run check:startup-cost
npm run quality
```

Run the edit-sync regression files selected in Checkpoint 4 in addition to the explicit focused list above. Report every failed/omitted/environment-blocked check honestly; the quality aggregate does not imply that separate typechecks or bundle/startup budgets passed. Do not increase inherited budget ceilings to hide unrelated failures. Finish with an evidence table, focused commit hashes, remaining limitations and task/index updates only after acceptance is actually satisfied.

## Planning-deliverable verification — 2026-09-25

- `node build.mjs`: passed before the real-VS-Code investigation. No runtime source files were modified.
- Synthetic fixture: independent byte/character/ordered-word-length/nonletter-skeleton comparison passed; only the synthetic fixture is committed.
- Controlled synthetic diagnostic: passed; the hover-suppression comparison above is diagnostic evidence only. A separate temporary startup experiment removed the caret serialize from the CPU profile and reduced sampled code-copy work from about 182 ms to 7 ms. Its global test-only getter override was not a production implementation or copy-fidelity proof. Spontaneous pointer events contaminated its aggregate open interval, so that interval is not presented as a startup improvement.
- Retained diagnostic: three serial repetitions reproduced 24 full snapshots for 12 pointer/wheel steps. After correcting its frame sampler to start in the mounted webview, the final no-retry run passed with real samples: opening 3,147 ms / longest open task 1,007 ms; pure-scroll p95/max 22/24 ms with zero full snapshots; first pointer worst gap 950 ms; repeated pointer/wheel 8,816 ms, 24 snapshots totaling 2,318 ms, p95/max gap 700/833 ms, 12 long tasks. Host and disk equality passed. Different run timings reflect local load; deterministic work counts establish the regression.
- Focused Biome check on the retained probe: passed. Whole real-VS-Code typecheck reports an existing error in unchanged `test/vscode-e2e/preview-task-checkbox.spec.ts:122` (`Window.vditor` declaration); it reported no error in the new probe.
- Runtime fixes, changed-behavior acceptance, WYSIWYG performance, packaged-VSIX verification and `npm run quality` are not completed by this planning deliverable. Their applicable implementation checks remain unchecked above. The full quality suite was not run for this task/fixture/diagnostic-only change.


## Part 1 handoff and implementation progress — 2026-09-25

- Part 1 handoff completed with actual routing GPT-6 Luna Max. Source review found no blocker or redesign need. Checkpoint 2 uses the already available msg.content and keeps live getValue fallback for absent/empty/whitespace initial content. Checkpoint 3 stays in the anchored Vditor source-patch path. Checkpoint 4 must keep exact-source revision separate from presentation caching, synchronously drain relevant pending mutations, and re-prove each action against fresh source. Checkpoint 5 separates table membership reconciliation from scroll geometry and batches reads before writes.
- Checkpoint 1 baseline uses source/build commit fff32675, node build.mjs, VS Code 1.129.0, and the synthetic fixture at 174,527 bytes. All three runs were serial and no-retry. The editor was IR with content-visibility enabled and 265 direct blocks, 11 tables, 27 header cells, and 36 code blocks. The four phases are open-to-readiness, programmatic scroll, first pointer proof, and actual workbox pointer-plus-wheel input. Each run's host and disk equality assertions passed. The probe prints only aggregate measurements and shapes; fixture Markdown is excluded from output and failure messages.

| Run | Open to ready ms | Open full serializations / ms | Open longest task ms | Pure-scroll TH reads / frames / p95-max gap ms | Cold first-pointer serializations / ms / max gap ms | 12 pointer-wheel steps ms | Warm serializations / ms | Warm p95-max gap ms | Long tasks across phases |
| --- | ---: | ---: | --- | --- | --- | ---: | --- | --- | ---: |
| 1 | 2737 | 1 / 192 | 1012 | 2700 / 107 / 20-23 | 2 / 267 / 867 | 7667 | 24 / 1960 | 617-633 | 17 |
| 2 | 2721 | 1 / 169 | 918 | 2700 / 107 / 20-23 | 2 / 261 / 833 | 7655 | 24 / 1986 | 583-667 | 16 |
| 3 | 2720 | 1 / 168 | 911 | 2700 / 107 / 21-25 | 2 / 251 / 833 | 7545 | 24 / 1974 | 579-650 | 16 |

- Baseline medians: open-to-ready 2721 ms; 12 pointer-wheel steps 7655 ms; warm serialization time 1974 ms. Worst sampled frame gap was 867 ms during cold first-pointer proof; median total long-task count was 16, worst 17. Pure programmatic scroll had no full serialization, 2700 header reads, and a 25 ms worst sampled frame gap. The first proof and warmed repeated hover are reported separately.
- Small-document control: the retained probe opens the same short block-handle Markdown used by test/vscode-e2e/block-handle.spec.ts as a separate temp file. After Checkpoint 2's caret short-circuit, one real-VS-Code control run (1.129.0) measured 513 ms to ready, IR, content-visibility off, 3 direct blocks, 0 tables, 0 headers, and 1 code block. First pointer had 2 serializations / 8 ms / 17 ms max gap; 12 pointer-wheel inputs had 24 serializations / 34 ms / 17 ms p95 and max gaps, with no pointer-phase long tasks. Host and disk equality passed. This is the small-document control after the caret change; later checkpoints should compare their small-input behavior against this measurement.
- Post-Checkpoint-2 large-fixture probe, one no-retry run: open-to-ready 2509 ms and 0 full serializations in the open phase; content-visibility remained enabled and structural counts matched. Pure scroll remained at 2700 header reads. Warm pointer-wheel had 24 serializations / 1958 ms, so the block-handle fix remains pending in Checkpoint 4. Host and disk equality passed. This single run is mechanism evidence, not a final three-run performance claim.
- Checkpoint 2 TDD: the known-nonempty unit test failed before implementation at initial-caret.ts calling getValue; the finish-init integration test failed because msg.content was not forwarded. After the short-circuit and forwarding change, the focused unit pair passed 18/18. node build.mjs passed; no-retry real-VS-Code caret-on-open passed 2/2, and the new focused large-document-interaction.spec.ts passed 1/1. The retained no-retry probe passed with 0 open-phase getValue calls on the large fixture and host/disk equality for both large and small copies. Focused Biome passed. Initial-caret coverage passed with 100% line coverage and 95.45% branches. The combined coverage report ran 18/18 tests and showed the changed finish-init call line covered, but exited because finish-init.ts whole-file function coverage was 27.58%, below its configured threshold; thresholds were not changed. npm run typecheck passed. typecheck:strict reports 13 diagnostics in unchanged project files (plus 1,878 filtered Vditor-source diagnostics); typecheck:vscode-e2e reports only the already-recorded Window.vditor error at unchanged preview-task-checkbox.spec.ts:122, with no errors in the new spec or modified probe. Neither failure is attributable to Checkpoint 2. No broad tier or aggregate quality run was performed in this checkpoint phase.
- Historical handoff note: at this point Checkpoints 1–3 were committed (cf00f335, ff6e19b0, ce1c81a5) and Checkpoints 4–5 were still pending; their completion and commits are recorded below.
- Checkpoint 3: the pinned codeRender anchors are guarded by patchCodeRenderTextContent and composed with the existing diagram/copy patches. Source-patch tests passed 224/224; harness registry passed 5/5; the focused Chromium code-copy spec passed 1/1. Chromium asserted 36 Preview code blocks have delegated copy markers and no inline handlers; exact ordinary and highlight-chroma payloads covered tabs, blank lines, NBSP, escaped markup and the distinct trailing-newline rules. The innerText getter counter stayed at zero across IR, WYSIWYG and Preview, and getValue was byte-stable around decoration/copy. The no-retry real-VS-Code large-document spec passed 1/1 after node build.mjs: opening had zero getValue/innerText calls, mouse copy reached the VS Code clipboard, getValue stayed unchanged, and host/disk equality passed.
- Post-Checkpoint-3 retained-probe sample: open-to-ready 3018 ms, 3 open long tasks, 704 ms longest; the prior single post-Checkpoint-2 sample was 2509 ms / 3 tasks / 771 ms longest. This one run showed the same task count and a 67 ms lower longest task, while open-to-ready varied upward; it does not establish a stable latency reduction. Pure-scroll remained 2700 header reads with 18/23 ms p95/max; warm pointer-wheel remained 24 serializations / 2187 ms, which is pending Checkpoint 4.
- Checkpoint 3 checks: node build.mjs passed; npm run typecheck passed; focused Biome passed. npm run typecheck:vscode-e2e reports only the unchanged preview-task-checkbox.spec.ts:122 Window.vditor error. Targeted coverage ran 2/2 tests and the coverage JSON confirms every new patch/registry statement line was hit, but the whole esbuild-shared.mjs report exits below configured global floors (31.12% lines, 6.25% functions); no threshold was changed. Broad FAST/quality and bundle/startup checks remain for the final Task 573 candidate.

- Checkpoint 4 complete — presentation lookup is cached by active root, Lute owner, mode, opaque exact-source revision, and synchronously drained relevant DOM-mutation generation. It stores both null and resolved units. Source proof remains unchanged on misses; drag, drop, menu, and keyboard actions freshly re-resolve current units and offsets. Exact-source revision tests cover trusted edits, post/reseed/invalidate/dispose, mismatch revocation, unchanged baseline reads, and same-DOM source-byte changes. Chromium harness writes advance the revision token.
- Owner-authorized bounded selection-capture extension: `selectionchange` now marks selection state dirty without serializing; it cancels a stale pending selection request using only live selection path/revision identity. A dirty live non-sentinel selection is captured on editor focusout, and a live command request synchronously captures and retains its validated bookmark before QuickPick focus transfer. Existing exact/rendered checks remain at request and apply. Tests cover 30 selectionchange events (including path and revision changes), request-time capture, focusout retention through root-zero sentinel, pending cancellation after selection changes, cancel/reopen with lost selection, and rejection after exact source changes.
- Focused unit tests: 5 files, 67/67 tests passed. Focused coverage: 4 source modules, 66/66 tests passed; no thresholds were changed. `npm run typecheck` passed. Biome passed all 14 checked TypeScript files, including every changed TypeScript file. `node build.mjs` passed after the source changes. The focused `npm run typecheck:vscode-e2e` still reports only the previously recorded error at unchanged `test/vscode-e2e/preview-task-checkbox.spec.ts:122` (`Window.vditor`); no error points to the changed spec.
- Chromium: `xvfb-run -a npm --prefix media-src run test:e2e -- block-handle.spec.ts` passed 16/16. The new browser acceptance includes warmed cache and source-fidelity cases in IR and WYSIWYG.
- Real VS Code, no retry: the selected native QuickPick/Undo/save, handle Turn Into, and handle/bubble history tests passed 3/3. The large-document IR/WYSIWYG acceptance passed 1/1. IR cold hover took 1,124 ms, with 1 block-handle snapshot and 2 getValue calls / 280 ms; 30 pointer moves plus 12 wheel events then made zero full serializations or block-handle snapshots. WYSIWYG idle after mode/root readiness had zero getValue calls, block-handle snapshots, or block-transform captures (4 relevant DOM mutations). Cold hover took 391 ms, with 1 block-handle snapshot and 2 getValue calls / 175 ms. No-pointer quiescence arrived after 3 intervals / 1,494 ms with zero snapshots, captures, or mutations; 30 pointer moves plus 12 wheel events then had zero serializer calls, snapshots, captures, or mutations. Exact source stayed unchanged.
- QuickPick investigation: two intermediate no-retry attempts failed while reopening after Escape (one missing Heading 2 option, one hidden picker). An opt-in read-only diagnostic, removed afterward, showed the successful requests both returned `currentType=paragraph`, `h2=changed`, live selection true, focus sentinel false, retained/pending true, and exact/rendered equality true. The final clean no-retry QuickPick/Undo/Redo/save run passed, as did the handle and bubble history tests. No Markdown was emitted in diagnostics.
- Aggregate quality, coverage-module ratchet, strict typecheck, bundle-size/startup-cost gates are deferred to the final Task 573 gate; no aggregate quality run was performed in this checkpoint.

- Checkpoint 5 complete — `table-resize.ts` now reconciles table membership on structural/lifecycle changes and runs geometry-only work on scroll. One IntersectionObserver target per eligible table header row uses `findScroller(activeRoot)` as its root; in the real VS Code webview this is the active `PRE.vditor-reset` scroller (overflow-y:auto, 717px viewport, 21,517px content). Observer clipping plus explicit scrollport and nested overflow-wrapper bounds determine visible handle geometry. Reads are batched before style/ARIA writes, unchanged values are skipped, and the actively dragged table remains in membership until mouseup. Existing session-only width, minimum, keyboard, double-click, unsupported-table, and detached cleanup paths remain.
- CP5 RED→GREEN: the large synthetic Chromium fixture has 11 tables and 27 header cells. Before the refactor, scrolling to a viewport with no visible table header read all 27 offscreen header rects; after, the same scroll produced zero header reads. The same test confirms visible table borders align with handles within 3px, first and distant eligible tables support drag and keyboard resize, offscreen→onscreen→offscreen visibility, Preview separation, and source stability.
- CP5 checks: `npm test -- media-src/src/chrome/table-resize.test.ts` passed 3/3. Full `xvfb-run -a npm --prefix media-src run test:e2e -- table-resize.spec.ts` passed 6/6. Browser E2E coverage also passed 6/6 and reports `table-resize.ts` at 88.55% statements, 84.18% branches, 96.49% functions, and 91.08% lines. A module-only Vitest coverage run exercised 3/3 tests but exited below repository-wide coverage floors when only `table-resize.ts` was included (8.97% lines); thresholds were not changed. `npm run typecheck`, Biome, and `node build.mjs` passed.
- Real VS Code, both no-retry after build: `large-document-interaction.spec.ts` passed 1/1 with the same 11-table/27-header fixture, zero offscreen header reads, visible handle alignment error 0.000008px, and exact source/host/disk equality. `table-column-resize.spec.ts` passed 1/1: IR and WYSIWYG drags preserved exact bytes, the handle stayed within 3px of the header edge, and session widths were reset after reopen in both modes. `npm run typecheck:vscode-e2e` reports only the existing error in unchanged `test/vscode-e2e/preview-task-checkbox.spec.ts:122` (`Window.vditor`).
- Coverage review: the browser report covers the main membership, IO visibility, geometry, clipping, drag, keyboard, auto-fit, and width persistence paths. It still reports a few lifecycle-only branches as uncovered (document-hidden callback, no-active-surface cleanup, and disposal); real reopen/mode-switch acceptance exercises the principal cleanup path. No thresholds were increased. The routine FAST tier, aggregate quality, bundle/startup gates, and final three-run performance acceptance remain for the final Task 573 gate.


## Final acceptance evidence and open completion gate — 2026-09-25

- Final `node build.mjs` passed after a strict-type fix to `childNodePath`. The one Task 573-owned strict diagnostic was corrected with an explicit `ParentNode | null` annotation. `npm run typecheck` passes; `npm run typecheck:strict` still reports 13 diagnostics in unchanged project files plus 1,878 filtered Vditor-source diagnostics. `npm run typecheck:vscode-e2e` reports only the existing `Window.vditor` declaration error at unchanged `test/vscode-e2e/preview-task-checkbox.spec.ts:122`. Targeted Biome checks on changed Task 573 TypeScript pass.
- Three matched serial no-retry real-VS-Code probes passed against the 174,527-byte synthetic fixture (VS Code 1.129.0, IR, content-visibility enabled, 265 blocks / 11 tables / 27 headers / 36 code blocks). Host and disk equality passed after open and pointer/wheel phases on each run. The probe emitted aggregate counters only, never fixture Markdown.

| Run | Open to ready / longest open task (ms) | Cold first hover: serializations / time / max gap | 12 pointer+wheel steps: time / serializations / serializer time / p95-max gap | Pure scroll: TH reads / frames / p95-max gap | Long tasks across measured phases |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 | 2267 / 608 | 2 / 318 ms / 900 ms | 608 ms / 0 / 0 ms / 24-24 ms | 52 / 107 / 17-18 ms | 4 |
| 2 | 2244 / 648 | 2 / 318 ms / 883 ms | 622 ms / 0 / 0 ms / 20-21 ms | 52 / 107 / 17-19 ms | 4 |
| 3 | 2382 / 631 | 2 / 340 ms / 1000 ms | 623 ms / 0 / 0 ms / 20-21 ms | 52 / 108 / 19-24 ms | 3 |

- Compared with the baseline recorded above, open-to-ready median decreased 2721→2267 ms (−16.7%); longest open task median decreased 918→631 ms (−31.3%); warmed pointer+wheel phase median decreased 7655→622 ms (−91.9%), with full serializations 24→0 and serializer time 1974→0 ms. Pure-scroll header reads decreased 2700→52 while rAF p95/max remained in the baseline range. Cold first proof remains a cost: two full serializations per run, median 318 ms, and a worst sampled gap of 1000 ms; it is reported separately from warmed movement.
- Small control: current runs measured 497/631/545 ms open-to-ready and 698/694/674 ms pointer+wheel phase time with zero warmed serializations; warmed rAF p95/max gaps were 22-24/23-24 ms. The one recorded post-CP2 control had 17 ms p95/max and 34 ms total serializer time, but no comparable phase wall time. The p95 difference is 5-7 ms against a single historical control, so it is not enough to attribute a product regression. The current warmed control has zero serializations; elapsed-phase comparison remains unavailable.
- Exact source/history acceptance passed. The large table real spec kept host and disk bytes equal to the synthetic source before/after table resize and WYSIWYG↔IR changes. Rendered `getValue()` is not a raw-byte oracle here (181,855 chars at IR baseline versus 174,517 exact host/disk bytes); it stayed equal across session-only resize and returned to its prior IR serialization after the mode round trip. A separate test-directory copy received one OS XTEST keystroke, was saved, restored by Ctrl+Z, restored by Ctrl+Y byte-for-byte, saved, and reopened with host and disk equal to the saved edit (1/1, no retry).
- Focused checks: 9 Vitest files passed 325/325; after the CP4 type annotation, `block-transform-command.test.ts` passed 12/12. Focused Chromium block-handle/table-resize/code-copy passed 23/23. The no-retry real-VS-Code focused set passed 20/20 with one worker under Xvfb/Openbox and `VMDE_XTEST=1`. E2E table-resize coverage reports 88.55% statements, 84.18% branches, 96.49% functions, and 91.08% lines; lifecycle-only uncovered branches are described in the CP5 review above.
- Routine FAST tier ran 59 tests and finished 58 passed / 1 failed; its configured retry also failed. `escape-toolbar.spec.ts` failed after Escape returned focus from the toolbar: the next Tab focused a toolbar button rather than inserting a tab. A minimal identical sequence reproduced the same behavior in the pre-CP4 `a201b03b` build and current build; this finding is not attributable to CP4/CP5. The other 58 tests passed.
- Whole-tree `lint:ci` fails on formatting in four unchanged files: `media-src/e2e/list-harness.ts`, `media-src/src/editing/escape-toolbar.ts`, `test/backend/emoji-catalog.test.ts`, and `test/vscode-e2e/block-handle.spec.ts`. The retained probe has one non-blocking `useTemplate` info. Targeted Biome on changed Task 573 files passes. `knip` reports 9 unused exports and 1 unused exported type. `jscpd` reports 1,358 clones, 7.20% duplicated lines and 8.58% tokens against its 8.8% threshold. `depcruise` exits 0 with no violations, but its installed TypeScript is unsupported, so it cruised 0 modules and the graph scan is incomplete.
- Full unit coverage ran 4,509 tests: 4,502 passed and 7 failed in existing policy/reference checks (package setting order, module manifest totality/host and webview allowlists, untagged context-menu probe, vendored emoji license mapping, and pinned Lute WYS reference-code DOM). All seven reproduced on pre-Task 573 commit `75443d50`; Task 573 did not change the affected package, manifest/policy tests, license table, or host `src/`. No coverage summary was generated, so `npm run check:coverage-modules` could not run (`coverage/coverage-summary.json` missing); do not treat the ratchet as green.
- Bundle/startup numbers are reporting-only under `LOCAL_AGENT_TASK.md` §5: final `media/dist/main.js` is 877,928 bytes / 857.35 KiB versus 895,092 bytes / 874.11 KiB at `75443d50` (−17,164 bytes / −16.76 KiB). Eager modules decreased 356→339 (−17); largest eager module remained 29.8 KB. The legacy scripts still report 857 KB / 608 KB and 339 / 294 modules; limits were not changed. Dependency audits were intentionally omitted under the Project Owner update in §5, and aggregate `npm run quality` was not run because it invokes those audits.
- The full real-VS-Code suite and full Chromium suite were not run. The focused layers and required FAST tier were run; no packaged VSIX claim is made. Final implementation gates remain open due the documented repository-wide red/blocked results above.

- Closure exception: the Project Owner explicitly approved closing Task 573 as-is. The failed/blocked final repository-wide checks remain visible above, and the final implementation-gates checklist is intentionally unchecked.
- Local queue bookkeeping: the final `LOCAL_AGENT_TASK.md` Task 573 marker/progress/link update was explicitly owner-authorized and remains untracked/unstaged; `LOCAL_AGENT_TASK_FUTURE.md` was not changed.
