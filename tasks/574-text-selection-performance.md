# Task 574 — Remove whole-document work from passive text selection

> **For agentic workers:** Use `superpowers:executing-plans` to implement the checkpoints sequentially. Checkboxes track implementation and acceptance; the earlier investigation is not a completed fix.

**Status:** planned — diagnosis available; implementation not started.
**Goal:** Make mouse-drag and keyboard text selection responsive in large IR and WYSIWYG documents while preserving Details, selection-toolbar and block-action behavior.
**Architecture:** Separate inexpensive selection display state from exact source capture at action execution. Reuse the existing `EditSync.snapshotRevision()` authority, keep passive selection reads free of live DOM markers, and suppress block-handle source resolution during native text-selection drags.
**Tech stack:** TypeScript, Vditor/Lute, Vitest, Chromium Playwright and real VS Code with OS-level keyboard input.
**Spec:** The evidence, behavior contract and acceptance criteria in this file are the specification. This task is self-contained; ignored local investigation artifacts are optional background.
**Dependencies:** [Task 573](done/573-large-document-open-scroll-performance.md) is complete; reuse its revision authority and presentation cache. Preserve completed Details, selection bubble and exact block-action contracts. Deferred Task 572 is not a prerequisite and must remain deferred.

## Evidence and reproduction

Use `test/vscode-e2e/fixtures/large-observable-models-synthetic.md` exclusively for the large-document reproduction. It contains 174,527 bytes and 2,334 lines; the measured IR surface had 265 top-level blocks. Its SHA-256 is `a4a39d6f6c605eb82b0e03a236f67388bceeae9a85450b0d4285053b28299f65`. Copy it into the real-VS-Code test's `baseDir` before interaction/save/history journeys. Keep fixture contents out of assertion diffs and diagnostic output.

Investigation on source commit `dcc2199e`, after `node build.mjs`, in VS Code 1.129.0 reproduced this with ordinary prose. Each drag used 12 actual browser-protocol mouse moves with the primary button held, at 40 ms cadence. Each keyboard case below used 12 browser-protocol Shift+ArrowRight steps at 60 ms cadence. Elapsed times include a 500 ms observation window. These establish causes, **not OS-level keyboard acceptance**; the new task must use the queue's OS-input requirement for final keyboard evidence.

| Mode / diagnostic control | Drag elapsed | Full getValue calls, drag | Keyboard elapsed | Full getValue calls, keyboard | Worst keyboard frame gap |
| --- | ---: | ---: | ---: | ---: | ---: |
| IR baseline, repeated | 11,576 ms | 52 | 4,108 ms | 26 | 283 ms |
| IR floating toolbar off | 11,594 ms | 50 | 4,122 ms | 24 | 300 ms |
| IR Details refresh suppressed only | 1,941 ms | 4 | 2,939 ms | 24 | 167 ms |
| IR both refreshes isolated | 1,990 ms | 2 | 1,343 ms | 0 | 22 ms |
| WYSIWYG baseline | 10,194 ms | 52 | 3,853 ms | 28 | 283 ms |
| WYSIWYG both isolated | 1,339 ms | 0 | 1,343 ms | 0 | 21 ms |
| Small prose IR control, both enabled | 1,317 ms | 52 | 1,328 ms | 34 | 25 ms |

The initial IR run also reproduced 11,296 ms / 52 drag snapshots. Eight no-retry diagnostic invocations passed nonempty-selection and exact host/disk equality checks. Timing varies with machine load; compare matched workloads and use deterministic work counts for regression gates. The diagnostic suppressions are not authorized production fixes. Inclusive serializer/callback timings overlap and must not be added together.

### Confirmed call paths

1. `media-src/src/editing/details-toggle.ts::installDetailsToggleControls` schedules `update` on `selectionchange`. `update → currentTarget → captureTarget → captureCalloutActionTarget → captureRewrapSourceSelection` invokes a whole-document `getValue`, then marked-document serialization; `captureTarget` subsequently requests `snapshotMarkdown`, which takes another full snapshot on this fixture. This is done to update the button's enabled/pressed state, before any Details action.
2. `media-src/src/editing/rewrap-command.ts::markerSourceSelectionFromDom` inserts/removes two live text markers for an expanded Range. The repeated IR drag produced 26 insertions for 13 selection events, and keyboard selection produced 24 for 12 events. Bytes remain unchanged, but genuine child-list/text mutations reach observers.
3. `media-src/src/nav/block-handle.ts::invalidatePresentationForMutations` correctly invalidates its cache for those records. Its `hover` guard excludes internal block dragging but not native text-selection dragging, so successive mouse moves repeat full source projection. Details used about 3,574 ms and block hover 6,809 ms during the repeated IR drag. Suppressing Details reduced hover to one cold proof. Preserve Task 573's real-edit invalidation; remove this source of read-side mutations instead of teaching all observers to ignore it.
4. `media-src/src/editing/selection-bubble.ts::selectionOwner` acquires `snapshotExactMarkdown()` and `outer.getValue()` for a display bookmark. Its 32 ms timer can run for every slower keyboard-selection step. With Details isolated, 12 such steps still produced 24 bubble snapshots costing 1,939 ms. Details can delay/coalesce the bubble timer, so fixing Details alone exposes this second cost.

Optional local evidence: `tmp/selection-performance-investigation.md`, `tmp/selection-performance-investigation-probe.ts`, and `tmp/selection-perf-*.json`. Do not make tests depend on these ignored files, their minified callback names, or diagnostic suppression flags.

## Global constraints

- Preserve selected text, selection direction, caret, focus, scroll, IME, accessibility, accurate Details enabled/pressed state, retained selections, and one-step native Undo/Redo. No source edits or dirty/history changes from passive selection.
- Preserve Details behavior in IR/WYSIWYG/SV: paragraph/list expansion, whole-fence/table admission, rejection of partial fences/cells and malformed wrappers, immediate-body unwrap, nested/subset wrap, custom summaries, CRLF and untouched body bytes. SV must remain functional even though this performance gate targets IR/WYSIWYG.
- Preserve bubble Bold/Italic/Strike/Inline Code, Link/Wiki Link, Turn Into, warning/consent and cancellation flows, including when the main toolbar is hidden. Keep Preview, composition and disabled-setting suppression.
- No disabled features, longer debounce as the sole fix, marker mutation during passive selection, editor normalization during a live selection, global observer bypass, Lute fork, new setting/dependency or generated-output edits.
- Reuse source and undo authorities. DOM-derived display eligibility is advisory; it must never authorize a Markdown mutation without the existing source validation at action execution.
- Read `DEVELOPMENT.md`, the VMDE Lute/testing skills and applicable path-scoped rules. During this local queue, follow the owner's verification overrides: no dependency/vendor audits, bundle/startup budgets reporting-only, network-free quality stages once per final candidate, and OS-level keyboard acceptance. Do not invoke aggregate `npm run quality` while it includes excluded audits.
- Keep local queue files untracked and unstaged. Make separate focused local commits; do not push. Leave `tasks/README.md` unchanged until actual task closure. Prior task gate exceptions are not new waivers for this task.

## Review focus

- Source bytes/revision can change while canonical DOM looks identical; stale retained selections must fail closed.
- Live text edits and detached/replaced nodes can precede observer delivery; drain pending relevant records before accepting an action.
- A Details body's strict subset must wrap, not unwrap the ancestor; nested and coalesced raw HTML must not acquire guessed source offsets.
- Mouseup outside the editor, pointer cancellation, window blur, IME and mode changes must release gesture state without resuming stale hover work.
- Toolbar pointerdown/keyboard focus transfer, native QuickPick and cancelled consent must preserve the intended range and history without serializing merely to display controls.

## Checkpoint 1 — Add failing selection-work regressions

**Create:** `media-src/e2e/selection-performance.spec.ts`, `test/vscode-e2e/selection-performance.spec.ts`.
**Reuse:** the synthetic fixture, `media-src/e2e/selection-bubble-harness.ts`, `media-src/e2e/block-handle-harness.ts`, `test/vscode-e2e/webview-helpers.ts`, and `test/vscode-e2e/helpers/xtest-input.ts`.

- [ ] Record HEAD/build, mode, fixture hash and current counters. Use the prior evidence above; do not repeat the entire eight-control investigation unless the current baseline contradicts it.
- [ ] Instrument in test code only: full `getValue` calls, Lute entry-point counts, live `Range.insertNode` calls, block-handle snapshot/proof counts, selection events, long tasks and rAF gaps. Start rAF sampling after webview readiness. Distinguish marked-root serialization from the smaller fragment proofs; exclude command activation from passive-selection phases.
- [ ] Write the mouse and keyboard red cases in both modes. Warm ordinary idle hover, then measure a 12-step native text drag and a 12-step Shift+Arrow selection at 60 ms cadence, plus a short burst below the old 32 ms debounce. Verify endpoints/selected length and unchanged bytes, not only elapsed time.
- [ ] Make the mechanism expectations explicit in the new spec's collected metrics:

```ts
expect(metrics.passive.fullGetValueCalls).toBe(0)
expect(metrics.passive.liveMarkerInsertions).toBe(0)
expect(metrics.drag.blockHandleSnapshots).toBe(0)
expect(metrics.drag.blockHandleProofs).toBe(0)
expect(metrics.passive.sampledFrames).toBeGreaterThan(0)
expect(hostText === initialText && diskText === initialText).toBe(true)
```

`metrics` is the test-local result object built from those counters, not a new production telemetry API. Counters must call the original methods and return their original values; no suppressed handlers in acceptance.

- [ ] Use `createXtestInput` to activate and verify the actual VS Code window for final Shift+Arrow, Undo/Redo and keyboard activation. Use `input.key('shift+Right')` for each selection step. A browser-protocol comparison may be retained as diagnostic data, clearly labelled; it cannot replace the OS-input gate. An unavailable mapped/focused XTEST target is an explicit acceptance gap.
- [ ] Run the focused red case and record the actual failed mechanism. Keep all implementation checkboxes pending until the following fixes and acceptance pass.

## Checkpoint 2 — Prevent block-hover proof during native text selection

**Modify:** `media-src/src/nav/block-handle.ts`.
**Tests:** `media-src/src/nav/block-handle.test.ts`, `media-src/e2e/block-handle.spec.ts`, the new selection specs.

- [ ] Add a unit/controller regression: with the primary button held, dispatch several editor `mousemove` events and assert the `BlockHandleActions.snapshot` spy is untouched. Existing `dragging` represents block drag state; do not reuse it to mean native text selection.
- [ ] Put the native-gesture guard before `units()`/`unitAt()`/snapshot acquisition. Track editor-originated primary pointer selection if necessary, and use `event.buttons` to cover moves whose pointerdown was missed:

```ts
if (nativeSelecting || (event.buttons & 1) !== 0) {
  positionHandle(null)
  return
}
```

`nativeSelecting` is controller-local transient state, set on primary pointerdown in editable content and cleared on document pointerup/pointercancel, window blur and disposal. Do not intercept or prevent the browser's selection events. Existing internal block drag/drop handlers remain independently responsible for their gesture.

- [ ] On release, allow the next ordinary hover; do not resolve source from the pointerup handler merely because selection ended. Clear hidden menu/indicator display safely without changing the document or cancelling a legitimate internal drag operation.
- [ ] Cover release outside the editor, cancellation, lost focus, normal hover afterward, internal block drag/drop, keyboard block moves, cached rejection and genuine source invalidation. Do not broaden the mutation-ignore list.
- [ ] Run focused units/Chromium, inspect the changed diff, and commit this bounded change. Final integrated real-VS-Code selection evidence belongs to Checkpoint 5.

## Checkpoint 3 — Make Details display-state computation read-only

**Modify:** `media-src/src/editing/details-toggle.ts`, `media-src/src/boot/main.ts`.
**Create:** `media-src/src/editing/details-selection-state.ts`, `media-src/src/editing/details-selection-state.test.ts`, `media-src/src/editing/details-toggle-controls.test.ts`.
**Existing tests:** `media-src/src/editing/details-toggle.test.ts`, `media-src/e2e/details.spec.ts`, `test/vscode-e2e/details-toolbar.spec.ts`.

**Interfaces:** add `snapshotRevision(): object | undefined` to `DetailsToggleDeps`, supplied from `sessionState.editSync?.snapshotRevision()` in `main.ts`. Reuse `DetailsBlockPair`/`pairDetailsBlocks` from `details.ts`. The new read-only helper has this contract:

```ts
export type DetailsSelectionState = 'disabled' | 'wrap' | 'unwrap'
export function readDetailsSelectionState(
  editor: HTMLElement,
  range: Range | null,
  pairs: readonly DetailsBlockPair[],
): DetailsSelectionState
```

- [ ] Add controller tests that spy on `captureCalloutActionTarget`, `getValue`, `snapshotMarkdown` and `Range.insertNode`. Thirty expanded-selection changes, timer/frame flushes, retained-selection reads and passive mutations must call none of them. Put controller mocks in the new controls test; keep existing pure transform tests intact.
- [ ] Implement the read-only helper using endpoint ancestry, ordered top-level blocks and Range boundary comparisons. It must not insert markers, mutate a Range/DOM, serialize, call `captureTarget`, or build a transformed Markdown document. Cache Details pairs/structural metadata by editor identity and content revision; refresh for relevant content/root changes, not every selection endpoint change.
- [ ] Encode the existing admission matrix: outside/collapsed unsupported selections are disabled; partial prose expands to its existing complete paragraph; list content uses the complete source-owning list group; partial fence bodies/table cells are disabled; complete fences/tables remain eligible; an entire immediate Details body shows unwrap, while a strict subset shows wrap. One-sided/malformed wrapper selections are disabled. Use both IR and WYSIWYG DOM fixtures, including nested/coalesced opening HTML. Keep SV on its current explicit source adapter unless an equally bounded read-only adapter is proved.
- [ ] Pin that matrix against `resolveDetailsBlockRange` plus `transformDetailsSelection` in tests **outside** the passive production path. If a supported nested/coalesced case cannot be represented by `DetailsBlockPair`, extend the cached structural metadata with the missing enclosure information and tests. Do not silently disable previously supported actions or guess offsets from `textContent`; return that specific source/DOM ambiguity for the queue's bounded reasoning step before proceeding.
- [ ] Change `update()` to consume display state only:

```ts
const state = readDetailsSelectionState(editor, liveRange, cachedPairs)
button.disabled = state === 'disabled'
button.setAttribute('aria-disabled', String(state === 'disabled'))
button.setAttribute('aria-pressed', String(state === 'unwrap'))
button.classList.toggle('vditor-menu--current', state === 'unwrap')
```

The existing controller supplies `editor` and an editor-owned `liveRange`; `cachedPairs` is the revision-keyed structural metadata above. Apply Preview/composition/lifecycle guards before reading it. If no Details button is mounted, do not perform display work; keep explicit `vmde-toggle-details` command handling available.

- [ ] Retain a cloned Range, owner/mode/root and source-revision identity for focus transfer instead of a passively mapped `SourceRange`. On actual button pointerdown/keyboard activation or explicit command, validate that cheap bookmark, capture the exact source target once, and execute the existing transform/transaction. Reuse `captureRewrapSourceRange`'s `authoritativeMarkdown` option to avoid taking the same snapshot again inside mapping. Preserve source proof and retained unwrap-after-toggle behavior. A changed revision, disconnected endpoint, external replacement or IME makes a retained capture unusable.
- [ ] Remove `retainedForCurrentSource`'s passive `getValue()` equality check; compare owner/revision and drain pending source-affecting records instead. Preserve a source check at the action boundary. Use `block-transform-command.ts::installCapture` as the existing focus-transfer pattern; do not modify its working command behavior.
- [ ] Run the pure matrix, controller and Chromium Details regressions; verify toolbar keyboard activation and exact wrap/unwrap history through the focused real-VS-Code spec after the final shared build. Commit the completed checkpoint.

## Checkpoint 4 — Separate bubble display bookmarks from action captures

**Modify:** `media-src/src/editing/selection-bubble.ts`, `media-src/src/boot/finish-init.ts`, and their existing tests/harnesses.
**Preserve:** existing `selection-link-actions.ts`, `selection-format-actions.ts` and block-transform command transactions; adjust only required interface plumbing.

**Interfaces:** add `snapshotRevision(): object | undefined` to `BubbleDeps` and pass the already-injected `snapshotRevision` callback from `runFinishInit`. Split the current bookmark into these two responsibilities:

```ts
interface DisplayBookmark {
  outer: NonNullable<Window['vditor']>
  inner: InnerVditor
  editor: HTMLElement
  mode: 'ir' | 'wysiwyg'
  range: Range
  revision: object
  rect: AnchorRect
}
interface ActionBookmark extends DisplayBookmark {
  exact: string
  rendered: string
}
```

The referenced `InnerVditor` and `AnchorRect` imports already exist in `selection-bubble.ts`. The action type continues satisfying the current link/format owner contracts.

- [ ] Extend `selection-bubble.test.ts` with throwing/spied snapshot methods. Selection changes, bubble show/reposition, format-active reads and observer validation must not call them. Assert the bubble still becomes visible with the correct buttons and range.
- [ ] Remove `exact`/`rendered` acquisition from `selectionOwner()` and the source equality calls from passive `valid`/`onMutation`. Check owner, mode, root, revision, endpoint identity, connectedness, editor ownership and composition instead. Drain relevant pending mutations before accepting a bookmark; a programmatic text/attribute mutation without a trusted input event must not slip through a still-equal revision token.
- [ ] Keep geometry and `formatIsActive` selection-local. Preserve the existing mouse-drag/IME/Preview guards. Do not scan/serialize/hash the document to compute a cache key, and do not let marker-free selection updates invalidate the block-handle proof.
- [ ] On button activation, validate the cheap bookmark first, then acquire a fresh action capture only for a source-requiring action. Formatting can use its existing Range owner; Link/Wiki Link requires a validated exact/rendered pair; Turn Into continues through its own validated command capture. Reuse an action's capture through that transaction instead of adding duplicate preflight serializations. Revalidate ownership/revision before any mutation or retained consent continuation.
- [ ] Preserve immediate stale-click rejection, focus transfer, outside selection, re-init/mode switch, exact bytes changing with identical DOM, Undo/Redo, consent cancellation, hidden main toolbar and disabled bubble setting. If revision authority is absent during setup, hide/invalidate the display bookmark until an editor is ready; update test/harness call sites to supply the real contract rather than a serializer-based fallback.
- [ ] Run focused bubble/controller and Chromium behavior tests, then commit. Do not count a hidden/disabled bubble as a performance success.

## Checkpoint 5 — Integrated performance, fidelity and closure

- [ ] Run both visual modes on a test-directory copy of the synthetic fixture, with normal Details/bubble controls enabled. Cover native text drag, OS-level Shift+Arrow slow cadence and burst cadence, repeated selection across paragraphs and a small-document control. Record a separate cold hover measurement; do not include initialization or an unrelated first proof in the passive-selection budget.
- [ ] Assert zero full `getValue` calls and zero live source-mapping marker insertion from passive Details/bubble updates, and zero block-handle source acquisitions/proofs while a native text-selection drag is active. Assert nonempty/directional selection, visible and correct controls, and nonzero frame samples. Do not suppress product handlers or change settings to satisfy acceptance.
- [ ] Run at least three matched serial final measurements. Record elapsed workload time, selection events, rAF p95/max, long tasks and work counts. Target at least 80% less large-document drag time and 90% less passive snapshot work versus the matched current baseline; use call-count invariants as deterministic CI gates. A cold proof after release must remain separately reported. Investigate regressions rather than dropping a slow run.
- [ ] Prove Details wrap/unwrap and rejected partial selections; bubble formatting, Link/Wiki Link and Turn Into including consent/cancel; internal block drag and keyboard move; OS-level Undo/Redo; exact host/disk save and reopen. Use CRLF/noncanonical surrounding text and unchanged-document versions for selection-only phases. Preserve selection direction, caret and scroll after actions.
- [ ] Run focused changed-line coverage, applicable typechecks, one final build and focused no-retry real-VS-Code tests. Reuse the unchanged build; no concurrent real-VS-Code invocations. Run network-free quality components once and report each result. Budget checks remain reporting-only; do not change ceilings.

```bash
npm test -- media-src/src/editing/details-selection-state.test.ts media-src/src/editing/details-toggle-controls.test.ts media-src/src/editing/details-toggle.test.ts media-src/src/editing/selection-bubble.test.ts media-src/src/nav/block-handle.test.ts media-src/src/boot/finish-init.test.ts
xvfb-run -a npm --prefix media-src run test:e2e -- selection-performance.spec.ts selection-bubble.spec.ts details.spec.ts block-handle.spec.ts
npm run typecheck
npm run typecheck:strict
npm run typecheck:vscode-e2e
node build.mjs
env -u ELECTRON_RUN_AS_NODE xvfb-run -a npm --prefix test/vscode-e2e test -- selection-performance.spec.ts selection-bubble.spec.ts details-toolbar.spec.ts block-handle.spec.ts --retries=0
npm run check:bundle-size
npm run check:startup-cost
npm run lint:ci
npm run knip
npm run jscpd
npm run depcruise
npm run test:coverage
npm run check:coverage-modules
```

Build before the Chromium invocation too if required generated assets are absent or stale. Select changed-line coverage using the current Vitest config from `package.json`; the earlier investigation itself did not run new regression gates. Do not claim browser-protocol keyboard input as OS input, diagnostic parity as an installed-VSIX test, or component quality checks as an aggregate quality pass. Dependency audits and broad suites are omitted under the queue's explicit current owner policy; record those omissions.

- [ ] Update this task with actual results, failures, handoff/progress, local commit hashes and remaining limitations. Close/archive it and update `tasks/README.md` only when acceptance is complete or the owner explicitly resolves an outstanding gate. Update only this task's local queue status and stop as that queue directs. No changelog rewrite or deferred-task execution is included in this assignment.

## Planning record

Created on 2026-09-26 from the completed 2026-09-25 selection investigation and current source review. Only task/queue documentation is authorized in this planning turn. No new runtime implementation, regression acceptance, or execution phase has started; all implementation checkboxes above are intentionally unchecked.

Planning validation: task/source links, reserved task number, pending queue status, dependency order and sequential numbering passed. The synthetic fixture, future queue and task index are unchanged. No runtime tests were run for this documentation-only update.
