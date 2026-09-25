# Task 574 — Remove whole-document work from passive selection and cold block proof

> **For agentic workers:** Use `superpowers:executing-plans` to implement the checkpoints sequentially. Checkboxes track implementation and acceptance; the earlier investigation is not a completed fix.

**Status:** in progress — plan consolidated on 2026-09-26 (Task 573 residual folded in, shared source index adopted); implementation and acceptance underway.
**Goal:** Make mouse-drag and keyboard text selection responsive in large IR and WYSIWYG documents, and halve the cold block-proof serialization cost left by Task 573, while preserving Details, selection-toolbar and block-action behavior.
**Architecture:** One per-revision **source block index** is shared by the block handle, the Details button and the selection bubble. It is extracted from Task 573's block-handle presentation cache and is built at most once per source/DOM revision. Details display state comes from a status-only classifier that the Details action also uses, so the admission rules exist once. The exact source is captured again only when an action runs. The snapshot pair comes from one serialization (`EditSync.snapshotPair()`).
**Tech stack:** TypeScript, Vditor/Lute, Vitest, Chromium Playwright and real VS Code with OS-level keyboard input.
**Spec:** The evidence, behavior contract and acceptance criteria in this file are the specification. This task is self-contained; ignored local investigation artifacts are optional background.
**Dependencies:** [Task 573](done/573-large-document-open-scroll-performance.md) is complete. This task reuses its revision authority, drained-mutation generation and presentation cache, and takes over its cold-proof residual (below). Preserve completed Details, selection bubble and exact block-action contracts. Deferred Task 572 is not a prerequisite and must remain deferred.

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

### Residual carried over from Task 573

Task 573's final three-run evidence (IR, same fixture) left one interaction cost open:

| Measurement | Run 1 | Run 2 | Run 3 |
| --- | ---: | ---: | ---: |
| Cold first hover: full serializations | 2 | 2 | 2 |
| Cold first hover: serializer time | 318 ms | 318 ms | 340 ms |
| Cold first hover: worst frame gap | 900 ms | 883 ms | 1,000 ms |

WYSIWYG cold hover was 391 ms with 2 `getValue` calls / 175 ms. The two calls come from the block-handle `snapshot` in `boot/finish-init.ts`, which returns `{ exact: snapshotExactMarkdown(), rendered: window.vditor.getValue() }`. `snapshotExactMarkdown()` already runs `serializeForHost()` internally: the incremental serializer in large IR, and `vditor.getValue()` in WYSIWYG. So `rendered` repeats a serialization that was just done (in WYSIWYG, the same full call twice). The same pair is taken by `selection-bubble.ts::selectionOwner()` and `valid()`. The cold first hover recurs after every trusted edit, because the source revision advances.

Out of scope for this task: open-to-ready (~2.27 s) and the longest open task (~630 ms). Both are dominated by required Lute render and table-whitespace repair (Task 573 constraints). Also out of scope: the repository-wide gate reds recorded in Task 573, which existed before it.

### Confirmed call paths

1. `media-src/src/editing/details-toggle.ts::installDetailsToggleControls` schedules `update` on `selectionchange`. `update → currentTarget → captureTarget → captureCalloutActionTarget → captureRewrapSourceSelection` invokes a whole-document `getValue`, then marked-document serialization; `captureTarget` subsequently requests `snapshotMarkdown`, which takes another full snapshot on this fixture. This is done to update the button's enabled/pressed state, before any Details action.
2. `media-src/src/editing/rewrap-command.ts::markerSourceSelectionFromDom` inserts/removes two live text markers for an expanded Range. The repeated IR drag produced 26 insertions for 13 selection events, and keyboard selection produced 24 for 12 events. Bytes remain unchanged, but genuine child-list/text mutations reach observers.
3. `media-src/src/nav/block-handle.ts::invalidatePresentationForMutations` correctly invalidates its cache for those records. Its `hover` guard excludes internal block dragging but not native text-selection dragging, so successive mouse moves repeat full source projection. Details used about 3,574 ms and block hover 6,809 ms during the repeated IR drag. Suppressing Details reduced hover to one cold proof. Preserve Task 573's real-edit invalidation; remove this source of read-side mutations instead of teaching all observers to ignore it.
4. `media-src/src/editing/selection-bubble.ts::selectionOwner` acquires `snapshotExactMarkdown()` and `outer.getValue()` for a display bookmark. Its 32 ms timer can run for every slower keyboard-selection step. With Details isolated, 12 such steps still produced 24 bubble snapshots costing 1,939 ms. Details can delay/coalesce the bubble timer, so fixing Details alone exposes this second cost.
5. `selection-bubble.ts::onMutation → valid()` repeats `snapshotExactMarkdown()` plus `outer.getValue()` for **every** `#app` subtree mutation batch while a bookmark exists, including the Details markers from path 2. The two costs multiply each other.
6. `details.ts::transformDetailsSelection` (run by Details `update` only to read `status`) rescans the whole document (`maskFencedMarkdown`, `detailsTags`) and concatenates a new ~175 KB string on every call. `details-toggle.ts::resolveDetailsBlockRange` rebuilds `sourceLines` and scans lines linearly on every call. `retainedForCurrentSource` makes one more full `getValue()` per update.
7. `bridge/edit-sync.ts::snapshotExactMarkdown` always calls `snapshotMarkdown()` to prove the rendered baseline, so every consumer pays a serialization even when the key is unchanged.

Optional local evidence: `tmp/selection-performance-investigation.md`, `tmp/selection-performance-investigation-probe.ts`, and `tmp/selection-perf-*.json`. Do not make tests depend on these ignored files, their minified callback names, or diagnostic suppression flags.

## Design decisions (Project Owner approved 2026-09-26)

| Decision | Choice | Rejected alternative and reason |
| --- | --- | --- |
| Passive Details state | Shared per-revision source index + status-only classifier reused by the action | DOM-only admission matrix: a second copy of the admission rules that can drift, and nested/coalesced HTML needs guessed metadata. Settle-time-only recompute: the state lags, and a longer debounce as the only fix is prohibited. |
| Task 573 residual | Take the snapshot pair from one serialization (`snapshotPair`) | Incremental re-proof of changed units: heavy shared-state work, deferred. |
| Index unavailable (resolver rejects the document) | Run today's exact capture once per **settled** selection (pointerup, or keyup + 1 frame) | Advisory enable: the button could show enabled and then do nothing. |

## Global constraints

- Preserve selected text, selection direction, caret, focus, scroll, IME, accessibility, accurate Details enabled/pressed state, retained selections, and one-step native Undo/Redo. No source edits or dirty/history changes from passive selection.
- Preserve Details behavior in IR/WYSIWYG/SV: paragraph/list expansion, whole-fence/table admission, rejection of partial fences/cells and malformed wrappers, immediate-body unwrap, nested/subset wrap, custom summaries, CRLF and untouched body bytes. SV keeps its current explicit source adapter; this performance gate targets IR/WYSIWYG.
- Preserve bubble Bold/Italic/Strike/Inline Code, Link/Wiki Link, Turn Into, warning/consent and cancellation flows, including when the main toolbar is hidden. Keep Preview, composition and disabled-setting suppression.
- No disabled features, longer debounce as the sole fix, marker mutation during passive selection, editor normalization during a live selection, global observer bypass, Lute fork, Worker, new setting/dependency or generated-output edits.
- Reuse source and undo authorities. Index-derived display state is advisory; it must never authorize a Markdown mutation without the existing source validation at action execution.
- The index never builds while the primary pointer button is held. It builds at most once per key. It never scans, serializes or hashes the document to compute a key.
- Read `DEVELOPMENT.md`, the VMDE Lute/testing skills and applicable path-scoped rules. During this local queue, follow the owner's verification overrides: no dependency/vendor audits, bundle/startup budgets reporting-only, network-free quality stages once per final candidate, and OS-level keyboard acceptance. Do not invoke aggregate `npm run quality` while it includes excluded audits.
- Keep local queue files untracked and unstaged. Make separate focused local commits; do not push. Leave `tasks/README.md` unchanged until actual task closure. Prior task gate exceptions are not new waivers for this task.

## Review focus

- Source bytes/revision can change while canonical DOM looks identical; stale retained selections and cached index entries must fail closed.
- Live text edits and detached/replaced nodes can precede observer delivery; drain pending relevant records before reading or accepting any index entry.
- `snapshotPair().rendered` must equal `vditor.getValue()` byte-for-byte in IR (incremental and full) and WYSIWYG; otherwise block units misalign.
- A Details body's strict subset must wrap, not unwrap the ancestor; nested and coalesced raw HTML must not acquire guessed source offsets.
- Mouseup outside the editor, pointer cancellation, window blur, IME and mode changes must release gesture state without resuming stale hover work.
- Toolbar pointerdown/keyboard focus transfer, native QuickPick and cancelled consent must preserve the intended range and history without serializing merely to display controls.

## Checkpoint 1 — Add failing selection-work regressions

**Created (red evidence recorded below):** `media-src/e2e/selection-performance.spec.ts`, `test/vscode-e2e/selection-performance.spec.ts`, `test/vscode-e2e/selection-performance-probe.ts`.
**Reuse:** the synthetic fixture, `media-src/e2e/selection-bubble-harness.ts`, `media-src/e2e/block-handle-harness.ts`, `test/vscode-e2e/webview-helpers.ts`, and `test/vscode-e2e/helpers/xtest-input.ts`.

- [x] Record HEAD/build, mode, fixture hash and current counters. Use the prior evidence above; do not repeat the entire eight-control investigation unless the current baseline contradicts it.
- [x] Instrument in test code only: full `getValue` calls, Lute entry-point counts, live `Range.insertNode` calls, block-handle snapshot/proof counts, selection events, long tasks and rAF gaps. Start rAF sampling after webview readiness. Distinguish marked-root serialization from the smaller fragment proofs; exclude command activation from passive-selection phases.
- [x] Write the mouse and keyboard red cases in both modes. Warm ordinary idle hover, then measure a 12-step native text drag and a 12-step Shift+Arrow selection at 60 ms cadence, plus a short burst below the old 32 ms debounce. Verify endpoints/selected length and unchanged bytes, not only elapsed time.
- [x] Add a **cold-after-edit** phase: one OS-level keystroke on a test-directory copy, then Undo (bytes restored, revision advanced), then the first hover and the first Shift+Arrow selection. Count full serializations in each. Report it separately from the warm passive phases.
- [x] Make the mechanism expectations explicit in the new spec's collected metrics:

```ts
expect(metrics.passive.fullGetValueCalls).toBe(0)
expect(metrics.passive.liveMarkerInsertions).toBe(0)
expect(metrics.passive.indexBuilds).toBe(0) // warmed by the idle hover
expect(metrics.drag.blockHandleSnapshots).toBe(0)
expect(metrics.drag.blockHandleProofs).toBe(0)
expect(metrics.coldAfterEdit.fullGetValueCalls).toBeLessThanOrEqual(1)
expect(metrics.passive.sampledFrames).toBeGreaterThan(0)
expect(hostText === initialText && diskText === initialText).toBe(true)
```

`metrics` is the test-local result object built from those counters, not a new production telemetry API. Counters must call the original methods and return their original values; no suppressed handlers in acceptance. `indexBuilds` reads the existing opt-in `__vmdeBlockHandleCacheMetrics` window object; extend it with an `indexBuilds` field in Checkpoint 4.

- [x] Use `createXtestInput` to activate and verify the actual VS Code window for final Shift+Arrow, Undo/Redo and keyboard activation. Use `input.key('shift+Right')` for each selection step. A browser-protocol comparison may be retained as diagnostic data, clearly labelled; it cannot replace the OS-input gate. An unavailable mapped/focused XTEST target is an explicit acceptance gap.
- [x] Run the focused red case and record the actual failed mechanism. Keep all implementation checkboxes pending until the following fixes and acceptance pass.

## Checkpoint 2 — Prevent block-hover proof during native text selection

**Modify:** `media-src/src/nav/block-handle.ts`.
**Tests:** `media-src/src/nav/block-handle.test.ts`, `media-src/e2e/block-handle.spec.ts`, the new selection specs.
**Working tree (2026-09-26):** `block-handle.ts` already contains uncommitted `nativeSelecting`/`nativeSelectionRoot`/`nativeSelectionOwner`/`nativeSelectionMode` state, `onNativePointerDown`, `finishNativeSelection` (document `pointerup`/`pointercancel` capture, window `blur`) and the `hover` guard below. `media-src/e2e/block-handle.spec.ts` is also modified. Verify this work against the steps; do not rewrite it.

- [x] Unit/controller regression: with the primary button held, dispatch several editor `mousemove` events and assert the `BlockHandleActions.snapshot` spy is untouched. Existing `dragging` represents block drag state; do not reuse it to mean native text selection.
- [x] Guard before `units()`/`unitAt()`/snapshot acquisition:

```ts
if (nativeSelecting || (event.buttons & 1) !== 0) {
  positionHandle(null)
  return
}
```

`nativeSelecting` is controller-local transient state, set on primary pointerdown in editable content and cleared on document pointerup/pointercancel, window blur, root/owner/mode change and disposal. Do not intercept or prevent the browser's selection events. Existing internal block drag/drop handlers remain independently responsible for their gesture.

- [x] On release, allow the next ordinary hover; do not resolve source from the pointerup handler merely because selection ended. Clear hidden menu/indicator display safely without changing the document or cancelling a legitimate internal drag operation.
- [x] Cover release outside the editor, cancellation, lost focus, normal hover afterward, internal block drag/drop, keyboard block moves, cached rejection and genuine source invalidation. Do not broaden the mutation-ignore list.
- [x] Run focused units/Chromium, inspect the changed diff, and commit this bounded change. Final integrated real-VS-Code selection evidence belongs to Checkpoint 7.

## Checkpoint 3 — One serialization per snapshot pair (Task 573 residual)

**Modify:** `media-src/src/bridge/edit-sync.ts`, `media-src/src/boot/main.ts`, `media-src/src/boot/finish-init.ts`, `media-src/e2e/block-handle-harness.ts`, `media-src/e2e/selection-bubble-harness.ts`.
**Tests:** `media-src/src/bridge/edit-sync.test.ts`, `media-src/src/boot/finish-init.test.ts`, `media-src/e2e/block-handle.spec.ts`.

**Interface:** add to `EditSync`:

```ts
/** Exact bytes plus the rendered serialization computed by the same call. */
snapshotPair(): { exact: string; rendered: string }
```

- [x] Unit red test: spy on `vditor.getValue`. One `snapshotPair()` in WYSIWYG makes exactly 1 call. In large IR with the incremental serializer seeded, it makes 0 full calls. Today's pair (`snapshotExactMarkdown()` + `getValue()`) makes 2 and 1 respectively.
- [x] Implement it by factoring the body of `snapshotExactMarkdown` into one local function that returns `{ exact, rendered }`. `rendered` is the value `snapshotMarkdown()` returned. Keep the exact-transaction revocation and `advanceSourceRevision()` side effects identical. `snapshotExactMarkdown()` becomes `snapshotPair().exact`.
- [x] Parity test: after seeding, after an incremental edit, after `reseed`/`invalidate`, and when `seedState === 'pending'` (full fallback), `snapshotPair().rendered === vditor.getValue()` in IR and in WYSIWYG. Include CRLF and trailing-blank-line fixtures. If any case differs, stop and return the case for bounded reasoning; do not special-case the resolver.
- [x] SV: `snapshotPair()` is not used for SV consumers. Assert that block-handle and bubble consumers never call it in SV (they already exit on mode).
- [x] Wire `snapshotPair` through `FinishInitDeps` (supplied in `main.ts` from `sessionState.editSync?.snapshotPair()`, with fallback `{ exact: getValue(), rendered: <same string> }` when `editSync` is absent). In `finish-init.ts`, the block-handle `snapshot` returns `snapshotPair()` and keeps the `blockHandleSnapshotCalls` counter.
- [x] Update both Chromium harnesses to supply `snapshotPair` from their existing exact-source seam; assignments still advance the revision token.
- [x] Run the focused units and `block-handle.spec.ts`, then commit.

## Checkpoint 4 — Extract the shared source block index

**Create:** `media-src/src/nav/source-block-index.ts`, `media-src/src/nav/source-block-index.test.ts`.
**Modify:** `media-src/src/nav/block-handle.ts`, `media-src/src/boot/finish-init.ts`, `media-src/e2e/block-handle-harness.ts`.
**Tests:** existing `block-handle.test.ts` and `media-src/e2e/block-handle.spec.ts` must pass unchanged in behavior.

**Interface** (injected dependencies avoid an import cycle with `block-handle.ts`):

```ts
export interface SourceBlockIndexKey {
  root: HTMLElement
  owner: object
  mode: 'ir' | 'wysiwyg'
  revision: object
  domRevision: number
}
export interface SourceBlockIndex {
  key: SourceBlockIndexKey
  exact: string
  rendered: string
  units: BlockHandleUnit[] | null // null = resolver rejected this key
  /** Built lazily from `exact` by the first Details read; cached on the entry. */
  details(): DetailsSourceIndex
}
export interface SourceBlockIndexDeps {
  getActiveRoot(): HTMLElement | null
  projection(): { owner: object; mode: 'ir' | 'wysiwyg' } | null
  snapshotPair(): { exact: string; rendered: string } | null
  snapshotRevision(): object | undefined
  resolveUnits(root: HTMLElement, exact: string, rendered: string): BlockHandleUnit[] | null
}
export interface SourceBlockIndexHandle {
  currentKey(): SourceBlockIndexKey | null // drains pending records; no Markdown work
  peek(): SourceBlockIndex | null // cached entry for currentKey(), never builds
  read(): SourceBlockIndex | null // peek() or build once for currentKey()
  onInvalidate(listener: (reason: 'dom' | 'revision' | 'authority', root: HTMLElement | null) => void): () => void
  dispose(): void
}
export function createSourceBlockIndex(deps: SourceBlockIndexDeps): SourceBlockIndexHandle
```

- [x] Move without behavior change from `block-handle.ts` into the new module: `PresentationKey` (renamed `SourceBlockIndexKey`), `samePresentationKey`, the relevant-mutation filter, `observeRoot`, `flushPendingMutations`, `readCheapKey`, and the `lastKey` authority/revision comparison. `read()` caches under the **post-snapshot** key, exactly like the current `units()` (a snapshot can revoke exact authority). It stores `units: null` results too.
- [x] Keep in `block-handle.ts`: `resolveBlockHandleUnits`, `invalidateUnitProof`, `clearUnsafeState`, active/dragging handling. Register `onInvalidate`: on `'dom'` call `invalidateUnitProof(root)` and the existing active/dragging disconnection checks; on `'authority'` call `clearUnsafeState()`. `units()` becomes `index.read()?.units ?? null`. `resolveFreshUnits()` (action-time re-proof) still calls `snapshotPair()` directly and never reads the cache.
- [x] `finish-init.ts` creates one index instance and passes it to `installBlockHandleLayer`, the selection bubble (Checkpoint 6) and `installDetailsToggleControls` (Checkpoint 5). Dispose it with the block-handle observer entry. `resolveUnits` is `(root, exact, rendered) => resolveBlockHandleUnits(root, exact, rendered, currentBlockProjection())`.
- [x] Increment `__vmdeBlockHandleCacheMetrics.indexBuilds` inside `read()` builds (opt-in object only).
- [x] Unit tests (moved and new): one build for 30 reads on an unchanged key; `null` units cached; rebuild after a `characterData` edit drained before observer delivery; rebuild after a `href`/`src` change; revision change with identical DOM; root/owner/mode change fires `'authority'`; `peek()` never calls `snapshotPair`; disposal disconnects the observer.
- [x] Run the focused units and `block-handle.spec.ts` (warmed-cache and fidelity cases must still pass), then commit.

## Checkpoint 5 — Details display state from the index, without markers

**Modify:** `media-src/src/editing/details.ts`, `media-src/src/editing/details-toggle.ts`, `media-src/src/boot/finish-init.ts`.
**Create:** `media-src/src/editing/details-selection-state.ts`, `media-src/src/editing/details-selection-state.test.ts`, `media-src/src/editing/details-toggle-controls.test.ts`.
**Existing tests:** `media-src/src/editing/details.test.ts`, `media-src/src/editing/details-toggle.test.ts`, `media-src/e2e/details.spec.ts`, `test/vscode-e2e/details-toolbar.spec.ts`.

### 5a. Split the source rules (one implementation, two callers)

```ts
// details.ts
export interface DetailsSourceIndex {
  markdown: string
  lineStarts: number[] // ascending start offset of each source line
  lineEnds: number[] // offset before each line break
  fences: Array<[number, number]> // first/last line index, from fenceRanges()
  tags: DetailsTag[] // from detailsTags(maskFencedMarkdown(markdown))
  pairs: SourceDetailsPair[]
}
export function buildDetailsSourceIndex(markdown: string): DetailsSourceIndex
export function classifyDetailsSelection(
  index: DetailsSourceIndex,
  startOffset: number,
  endOffset: number,
): 'wrap' | 'unwrap' | 'disabled'
```

- [x] Move `sourceLines`, `lineForOffset`, `fenceRanges`, the role helpers and `resolveDetailsBlockRange` from `details-toggle.ts` into `details.ts` (or a sibling `details-source.ts` if that keeps `details.ts` more cohesive; update `scripts/module-manifest.mjs` if a new module is added). Add an index-taking overload `resolveDetailsBlockRangeIn(index, start, end)` that uses binary search on `lineStarts`. The existing `resolveDetailsBlockRange(markdown, start, end)` becomes `resolveDetailsBlockRangeIn(buildDetailsSourceIndex(markdown), start, end)`.
- [x] `classifyDetailsSelection` holds the status logic now inside `transformDetailsSelection` (`resolved`/empty guard, `selectionHasBalancedDetails`, the `immediate` pair search). It builds no new document string. `transformDetailsSelection` calls it first and returns `unchanged()` for `'disabled'`. It builds strings only for `'wrap'`/`'unwrap'`, using the same `immediate` pair. The output bytes must not change.
- [x] Parity test in `details.test.ts`: for every existing transform fixture and a generated grid of `(start, end)` offsets over mixed prose/list/fence/table/nested and coalesced `<details>`/CRLF documents, `classifyDetailsSelection(build(md), s, e) === transformDetailsSelection({markdown: md, startOffset: s, endOffset: e, resolved: true}).status`, and `resolveDetailsBlockRangeIn` equals the old resolver.

### 5b. Map the live Range to source offsets through index units

```ts
// details-selection-state.ts
export type DetailsSelectionState = 'disabled' | 'wrap' | 'unwrap' | 'unknown'
export function readDetailsSelectionState(
  entry: SourceBlockIndex,
  range: Range,
): DetailsSelectionState
```

- [x] Endpoint → unit: resolve the boundary node (for an element container use `childNodes[offset]` or its previous sibling at the end). Choose the unit whose `members` contains that node. No unit, or the endpoints outside `entry.key.root` → `'disabled'`. `units === null` → `'unknown'`.
- [x] Partial fence/table: if an endpoint unit has kind `fence` or `table` and the Range does not cover all of that unit's members (compare boundary points with a `selectNodeContents` Range over the first/last member) → `'disabled'`. This matches the resolver's partial-fence/table rejection.
- [x] Partial `html` unit (raw HTML block, including `<details>` opening/closing blocks) → `'unknown'`. The fallback path decides; never guess offsets inside raw HTML.
- [x] Line mapping for the other kinds (paragraph, heading, list-item, quote, thematic): count `\n` in the unit's rendered text before the endpoint (TreeWalker over text nodes of the unit's members, stopping at the endpoint). Add that count to the unit's first source line, `lineOf(unit.start)`. Guard: the unit's rendered `\n` count must equal the line-break count of `exact.slice(unit.start, unit.end)`. Cache that check per unit on the entry. On a mismatch (hard breaks, inline HTML, marker text) → `'unknown'`. Use offsets `start = lineStarts[startLine]` and `end = lineEnds[endLine]`, or `unit.start`/`unit.end` when the Range fully covers the unit.
- [x] Then run `resolveDetailsBlockRangeIn(details, start, end)` → `null` gives `'disabled'`, otherwise `classifyDetailsSelection(details, r.startOffset, r.endOffset)`.
- [x] Tests in `details-selection-state.test.ts`, using real Lute IR and WYSIWYG DOM for each admission-matrix row: outside/collapsed; partial prose (single and multi-line); list content; partial and whole fence; partial cell and whole table; entire immediate Details body → unwrap; strict subset → wrap; one-sided/malformed wrapper; nested and coalesced openings → `'unknown'` or the same status as the old path, never a different status. Parity oracle: the old `captureTarget` + `transformDetailsSelection` run **in the test only**.

### 5c. Controller: passive display without source capture

- [x] Change `installDetailsToggleControls(index?: SourceBlockIndexHandle)`. In `update()`:

```ts
frame = 0
if (previewOpen() || isCompositionActive() || !button) return applyState('disabled')
const range = liveEditorRange() // selection range inside the active edit root, or null
if (!range || range.collapsed) return applyState(retainedState())
if (primaryPointerHeld) return // keep the current state; pointerup schedules update
const entry = index?.peek() ?? (settled ? index?.read() : null) ?? null
const state = entry ? readDetailsSelectionState(entry, range) : 'unknown'
if (state !== 'unknown') return applyState(state)
if (settled) return applyState(exactFallbackState()) // today's capture path, once per settle
// not settled: keep the current state until settle
```

`applyState` sets `disabled`, `aria-disabled`, `aria-pressed` and `vditor-menu--current` exactly as today. `settled` becomes true on editor `pointerup`, and on `keyup` followed by one `requestAnimationFrame` when no further `selectionchange` arrived. `selectionchange` resets it. `exactFallbackState()` is the current `captureTarget(exactMarkdown)` + `transformDetailsSelection` status. It runs at most once per settle and never while `primaryPointerHeld`.

- [x] Remove the `getValue()` from `retainedForCurrentSource`. Retained state becomes `{ range: Range clone, key: SourceBlockIndexKey, status }`, valid only while `index.currentKey()` is identical (drained) and both Range containers are connected inside `key.root`.
- [x] Action path (`onPointerDown` on the button, `vmde-toggle-details`): validate the retained/current Range and key, then capture the exact target once with the existing `captureTarget`. Pass the index entry's `exact` as `authoritativeMarkdown` to `captureRewrapSourceRange` when the key is unchanged, so the mapping doesn't take the same snapshot again. Run the unchanged `runDetailsToggle`. Keep the source proof and the retained unwrap-after-toggle behavior. A changed revision, disconnected endpoint, external replacement or IME makes a retained capture unusable. Follow the focus-transfer pattern of `block-transform-command.ts::installCapture` without modifying it.
- [x] SV: keep the current explicit source adapter unchanged (no index in SV).
- [x] `details-toggle-controls.test.ts`: spy on `captureCalloutActionTarget`, `getValue`, `snapshotMarkdown`, `snapshotPair` and `Range.insertNode`. With a warm index, 30 expanded-selection changes, rAF flushes, retained-selection reads and passive mutations call none of them. A primary-held drag builds no index. An `'unknown'` state calls the fallback exactly once per settle. Button pointerdown captures exactly once.
- [x] Run the matrix, controller, `details.test.ts`, `details-toggle.test.ts` and Chromium `details.spec.ts`. Verify toolbar keyboard activation and exact wrap/unwrap history through the focused real-VS-Code `details-toolbar.spec.ts` after the final shared build. Commit.

## Checkpoint 6 — Separate bubble display bookmarks from action captures

**Modify:** `media-src/src/editing/selection-bubble.ts`, `media-src/src/boot/finish-init.ts`, `media-src/e2e/selection-bubble-harness.ts`.
**Preserve:** existing `selection-link-actions.ts`, `selection-format-actions.ts` and block-transform command transactions; adjust only required interface plumbing.

**Interfaces:** replace `snapshotExactMarkdown` in `BubbleDeps` with `snapshotPair(): { exact: string; rendered: string }` and add `index: SourceBlockIndexHandle`. Split the bookmark:

```ts
interface DisplayBookmark {
  outer: NonNullable<Window['vditor']>
  inner: InnerVditor
  editor: HTMLElement
  mode: 'ir' | 'wysiwyg'
  range: Range
  key: SourceBlockIndexKey
  rect: AnchorRect
}
interface ActionBookmark extends DisplayBookmark {
  exact: string
  rendered: string
}
```

The action type continues satisfying the current link/format owner contracts.

- [ ] Extend `selection-bubble.test.ts` with throwing spies on `snapshotPair` and `getValue`. Selection changes, bubble show/reposition, `formatIsActive` reads and `onMutation` validation must not call them. Assert that the bubble still becomes visible with the correct buttons and range.
- [ ] `selectionOwner()` stores `key: index.currentKey()` instead of `exact`/`rendered`. Return `null` (hide) while the key is `null`. `valid()` keeps its identity/connectedness/composition checks and replaces the two serializations with `sameKey(record.key, index.currentKey())`. `currentKey()` drains pending records, so a programmatic text/attribute mutation changes `domRevision` even when the revision token is still equal.
- [ ] `onMutation` keeps its hide/reschedule behavior. It must no longer serialize.
- [ ] On button activation: `valid(owner)` first, then build `ActionBookmark` with one `snapshotPair()`, only for Link/Wiki Link. Formatting uses its existing Range owner. Turn Into continues through its own validated command capture. Reuse that capture through the transaction. Revalidate the key before any mutation or retained consent continuation.
- [ ] Preserve immediate stale-click rejection, focus transfer, outside selection, re-init/mode switch, exact bytes changing with identical DOM (revision changes → key differs → reject), Undo/Redo, consent cancellation, hidden main toolbar and disabled bubble setting. Update test/harness call sites to supply the real contract, not a serializer-based fallback.
- [ ] Run the focused bubble/controller and Chromium `selection-bubble.spec.ts`, then commit. Do not count a hidden/disabled bubble as a performance success.

## Checkpoint 7 — Integrated performance, fidelity and closure

- [ ] Run both visual modes on a test-directory copy of the synthetic fixture, with normal Details/bubble controls enabled. Cover native text drag, OS-level Shift+Arrow slow cadence and burst cadence, repeated selection across paragraphs, the cold-after-edit phase and a small-document control. Record a separate cold hover measurement; do not include initialization or an unrelated first proof in the passive-selection budget.
- [ ] Deterministic gates (CI-safe):

| Phase | Gate |
| --- | --- |
| Passive selection (warm), both modes | 0 full `getValue`, 0 live `insertNode`, 0 index builds |
| Native text drag | 0 block-handle snapshots/proofs; 0 index builds while the button is held |
| Cold first hover after open or edit | ≤ 1 full serialization (WYSIWYG) and 0 full serializations when IR incremental is seeded (baseline 2) |
| First selection after edit | ≤ 1 index build and no marker insertion |
| Details classifier | Status parity with the old path across the full matrix |

- [ ] Assert nonempty/directional selection, visible and correct controls, and nonzero frame samples. Do not suppress product handlers or change settings to satisfy acceptance.
- [ ] Run at least three matched serial final measurements. Record elapsed workload time, selection events, rAF p95/max, long tasks and work counts. Targets versus the matched current baseline: at least 80% less large-document drag time, at least 90% less passive snapshot work, and at least 40% less cold-hover serializer time (baseline median 318 ms IR). Investigate regressions rather than dropping a slow run.
- [ ] Prove Details wrap/unwrap and rejected partial selections; bubble formatting, Link/Wiki Link and Turn Into including consent/cancel; internal block drag and keyboard move; OS-level Undo/Redo; exact host/disk save and reopen. Use CRLF/noncanonical surrounding text and unchanged-document versions for selection-only phases. Preserve selection direction, caret and scroll after actions.
- [ ] Run focused changed-line coverage, applicable typechecks, one final build and focused no-retry real-VS-Code tests. Reuse the unchanged build; no concurrent real-VS-Code invocations. Run network-free quality components once and report each result. Budget checks remain reporting-only; do not change ceilings.

```bash
npm test -- media-src/src/bridge/edit-sync.test.ts media-src/src/nav/source-block-index.test.ts media-src/src/nav/block-handle.test.ts media-src/src/editing/details.test.ts media-src/src/editing/details-selection-state.test.ts media-src/src/editing/details-toggle-controls.test.ts media-src/src/editing/details-toggle.test.ts media-src/src/editing/selection-bubble.test.ts media-src/src/boot/finish-init.test.ts
xvfb-run -a npm --prefix media-src run test:e2e -- selection-performance.spec.ts selection-bubble.spec.ts details.spec.ts block-handle.spec.ts
npm run typecheck
npm run typecheck:strict
npm run typecheck:vscode-e2e
node build.mjs
env -u ELECTRON_RUN_AS_NODE xvfb-run -a npm --prefix test/vscode-e2e test -- selection-performance.spec.ts selection-bubble.spec.ts details-toolbar.spec.ts block-handle.spec.ts large-document-interaction.spec.ts --retries=0
npm run check:bundle-size
npm run check:startup-cost
npm run lint:ci
npm run knip
npm run jscpd
npm run depcruise
npm run test:coverage
npm run check:coverage-modules
```

Build before the Chromium invocation too if required generated assets are absent or stale. `large-document-interaction.spec.ts` is included because Checkpoints 3–4 change the Task 573 block-handle cache owner; its warm zero-serialization and cold-hover assertions must still pass. Select changed-line coverage using the current Vitest config from `package.json`. Do not claim browser-protocol keyboard input as OS input, diagnostic parity as an installed-VSIX test, or component quality checks as an aggregate quality pass. Dependency audits and broad suites are omitted under the queue's explicit current owner policy; record those omissions.

- [ ] Update this task with actual results, failures, handoff/progress, local commit hashes and remaining limitations. Close/archive it and update `tasks/README.md` only when acceptance is complete or the owner explicitly resolves an outstanding gate. Update only this task's local queue status and stop as that queue directs. No changelog rewrite or deferred-task execution is included in this assignment.

## Commit plan

| Checkpoint | Commit scope |
| --- | --- |
| 1 | Red selection-performance specs + probe (test-only) |
| 2 | Block-handle native-selection guard |
| 3 | `EditSync.snapshotPair` + wiring |
| 4 | `source-block-index.ts` extraction (behavior-neutral) |
| 5 | Details classifier split + index-backed display state |
| 6 | Bubble display/action bookmark split |
| 7 | Acceptance evidence / task record |

## Execution progress

Part 1 reviewed the current source and the measured diagnosis without running a new probe. The implementation handoff keeps passive Details and bubble state read-only, retains the existing exact source authority at action execution, and releases block-handle hover work during native text selection. Nested openings coalesced into one HTML block require cached enclosure metadata in addition to `pairDetailsBlocks()`; a single visual pair cannot identify the immediate wrapper for display state. If implementation requires a new rendered-to-exact source offset or history contract, return that concrete evidence for bounded reasoning before changing the mapping authority.

Part 2 is underway. No implementation checkpoint or acceptance gate is marked complete yet.

Checkpoint 1 red evidence, after fixture settlement and valid text endpoints:

- Chromium: `xvfb-run -a npm --prefix media-src run test:e2e -- selection-performance.spec.ts` exited 1 at `metrics.passive.fullGetValueCalls === 0` (received 144). The same test-local counters reported 66 live marker insertions and 663 sampled frames. Details slow keyboard made 26 full reads and 26 markers in each mode; bubble slow keyboard made 24 (IR) and 26 (WYSIWYG) full-root reads.
- Real VS Code: `xvfb-run -a /tmp/vmde-task574-openbox-runner.sh` started Openbox and ran `env -u ELECTRON_RUN_AS_NODE VMDE_XTEST=1 npm --prefix test/vscode-e2e test -- selection-performance.spec.ts --retries=0 --workers=1`. It exited 1 at the same zero-work assertion (received 126), with 78 live marker insertions, 18 block-handle snapshots and 1,094 test-classified fragment proof calls during native drags. OS-level `shift+Right` reached the visible XTEST target; host and disk fixture bytes stayed exact in every phase. The separate cold hover is excluded from passive-selection counts. These are intended pre-fix failures, not acceptance passes.
- `node build.mjs` passed for the pre-fix real run. `npm run typecheck:vscode-e2e` reports only the existing error in unchanged `test/vscode-e2e/preview-task-checkbox.spec.ts:122` (`Window.vditor`).

Part 2 is proceeding to the source checkpoints; no final acceptance gate is marked complete yet.

#### Checkpoint 2 (2026-09-26, local Part 2, Claude Sonnet 5)

Verified the working-tree native-selection guard against the steps and applied the H3 correction in `media-src/src/nav/block-handle.ts`: the `hover` body is now split into `nativeSelectionSuppressesHover`, which also releases a gesture when a mouse move shows the primary button is up (a release outside the webview can skip both `pointerup` and `blur`), then continues with the ordinary hover. The split keeps `hover` under the Biome cognitive-complexity limit. Unit tests in `block-handle.test.ts` now hold the button on moves during a gesture (`buttons: 1`, as real drags do), and a new case proves the missed-release fallback; it fails with the fallback line disabled and passes with it.

- Focused units: `media-src/src/nav`, `finish-init.test.ts` and the boundary test ran; `block-handle.test.ts` 25/25. Chromium `block-handle.spec.ts` (`--retries=0`): 17/17, including the warmed-cache, fidelity, internal drag/drop, keyboard-move and native-selection cases. `npm run typecheck` and `typecheck:strict` pass; `biome check` is clean on the three files.
- **Pre-existing, unrelated:** `test/backend/module-boundaries.test.ts` fails 3 of 7 at HEAD without this change (manifest totality, host edge `markdown->platform`, webview edge `editing->links`). It is not introduced here. Checkpoint 4 must add `source-block-index` to the manifest and should record that these three stay red for the same unrelated reasons, rather than treating them as its own regression.
- Real-VS-Code evidence for the guard belongs to Checkpoint 7; the Checkpoint 1 real run already shows 0 native-drag block-handle snapshots with it.

#### Checkpoint 1 additions (2026-09-26, local Part 2)

Added the consolidation items to both specs and the probe (test-only, commit plan row 1): `indexBuilds` plus an `indexBuildsInstrumented` flag (H9: reads `?? 0` until Checkpoint 4; Checkpoint 7 must assert it is instrumented), `fullGetValueCalls()` for quiescence polling, a cold-open gate (`coldOpen.fullGetValueCalls ≤ 1`), a cold-after-edit hover and selection phase, and the `indexBuilds`/cold-edit assertions. Work counters are asserted before source-equality so a red run names the mechanism first.

- **Cold-after-edit runs in IR only.** One OS-level `type('x')` at the end of the first paragraph, save, click, OS-level `ctrl+z`, save, then a 600 ms no-`getValue` quiescence wait, restores the exact bytes (verified twice in IR). The same cycle in WYSIWYG cannot: an edit there posts WYSIWYG's own serialization (181,843 chars), and Undo yields 181,855, not the 174,517 original. WYSIWYG cold coverage is the cold-open hover after the mode switch. Undo issued before edit-sync goes quiet, or without the intervening save, also produced the rendered document.
- **Selection isolation:** the cold-selection caret is placed by script (no mouse movement, so no block-handle hover warms the index), and the drag phase collapses the selection first. A mousedown inside the previous 11-character selection started native text drag-and-drop, which rewrote the host to 181,855 chars and defeated the phase; that was a test defect, not a product one.
- **Red evidence (source `8da2790f` plus the uncommitted Checkpoint 2 guard, after `node build.mjs`):** Chromium `selection-performance.spec.ts` exited 1 at `metrics.passive.fullGetValueCalls` (received 136; 58 marker insertions; `indexBuildsInstrumented=false`). Real VS Code (`VMDE_XTEST=1`, Openbox, `--retries=0 --workers=1`) exited 1 at the same assertion (received 92; 80 marker insertions; native-drag block-handle snapshots 0 with the guard, 29 test-classified fragment proofs from Details markers). Cold hover: 2 `getValue` calls after open (IR and WYSIWYG) and 2 after edit (IR, 376 ms workload); cold-after-edit selection: 12 `getValue`, 10 markers, 0 index builds. Host and disk bytes stayed exact in every phase.
- `npm run typecheck` passes; `npm run typecheck:vscode-e2e` still reports only the existing `preview-task-checkbox.spec.ts:122` error. `biome check --write` reformatted the three test files (the committed baseline was unformatted; one pre-existing unused-parameter warning in `sourceIsUnchanged` remains).

Consolidation note (2026-09-26): the plan changed after the red evidence above. The cold-after-edit phase and the `indexBuilds` counter (Checkpoint 1) are new; add them to the existing specs before continuing. The DOM-only Details admission matrix from the previous plan is superseded by Checkpoint 5 (index + shared classifier). The "nested/coalesced enclosure metadata" note above no longer applies: those cases return `'unknown'` and use the settle-time exact fallback. Checkpoint 2 source work in the working tree is kept as is.

#### Checkpoint 3 (2026-09-26, local Part 2)

`EditSync.snapshotPair()` returns `{ exact, rendered }` from one `snapshotMarkdown()` run; `snapshotExactMarkdown()` is now `snapshotPair().exact`, so the exact-transaction revocation and `advanceSourceRevision()` side effects are shared rather than copied. The block-handle `snapshot` in `finish-init.ts` returns `snapshotPair()` and keeps the `blockHandleSnapshotCalls` counter. The Chromium block-handle harness takes one `getValue()` per pair.

- **Wiring (H1):** `snapshotPair` is supplied in `boot/vditor-init.ts` (the `finishInit` closure), with a `{ exact: getValue(), rendered: same }` fallback when `editSync` is absent. `main.ts` is unchanged.
- **Selection-bubble harness:** unchanged in this checkpoint. `BubbleDeps` gains `snapshotPair` only in Checkpoint 6, so the harness changes with that interface.
- **Tests:** `edit-sync.test.ts` covers one WYSIWYG `getValue` versus two for the old pair, zero in large incremental IR versus one, and identical revocation/revision side effects. A parity block runs the vendored Lute (new test-only `testing/real-lute.ts`, added to the manifest) on a 737-block noncanonical document in LF and CRLF, with trailing blank lines. `rendered` equals a full serializer call in the first incremental read, after an incremental edit, after `invalidate`, while the seed is pending, after seeding, after `reseed`, after `postExact` (exact-seeded) and in WYSIWYG. No parity case differed. `finish-init.test.ts` proves one `snapshotPair` and no `getValue` per cold hover, and no pair in SV. The red run failed with `snapshotPair is not a function` (9 tests) and on the finish-init pair assertion.
- **Results:** `edit-sync.test.ts` 38/38; `finish-init.test.ts` + `block-handle.test.ts` 32/32; Chromium `block-handle.spec.ts --retries=0` 17/17; `npm run typecheck` passes. `npm run typecheck:strict` exits 1 with the same diagnostic set at HEAD without this change (`main.ts`, `fix-table-ir.ts`, `link-popover.ts`, `list-normalize-source-command.ts`, `selection-bubble.test.ts` and others), so it is pre-existing. The Checkpoint 2 note that it passed is not reproduced here.

#### Checkpoint 4 (2026-09-26, local Part 2)

`nav/source-block-index.ts` now owns the key (`SourceBlockIndexKey`), the relevant-mutation filter, root observation, pending-record draining, the authority/revision comparison and the post-snapshot caching of `read()`, including cached `units: null`. Per H4 it has no runtime import: `block-handle.ts` is a type-only import, and consumers attach derived data through `memo(slot, build)` instead of a `details()` field. `block-handle.ts` keeps the resolver, `invalidateUnitProof`, `clearUnsafeState` and active/dragging handling. Its listener handles `'dom'` (proof invalidation plus the disconnection checks) and `'authority'` (`clearUnsafeState`). `units()` is `index.read()?.units`. `resolveFreshUnits()` is unchanged and never reads the cache.

- **Default index:** `installBlockHandleLayer(getActiveRoot, actions, sharedIndex?)` creates and disposes its own index from `actions` when none is passed. The unit tests and the Chromium block-handle harness therefore run unchanged; the harness needed no edit because the index counts `indexBuilds` on the probe's opt-in `__vmdeBlockHandleCacheMetrics` object in any harness.
- **Neutrality details:** without a cacheable key (no projection or revision authority), `units()` still resolves uncached, as before. Rebinding to another root emits `'dom'` for the old root, so its unit proof is dropped as before. On disposal the layer invalidates proofs for the owned roots, the roots seen through `'dom'` and the current active root; before, it used the last observed root.
- **`finish-init.ts`:** one index is created before the block handle, from a counted `snapshotPair` wrapper (`blockHandleSnapshotCalls` covers index builds and action-time re-proofs). The `'block-handle'` observer entry disposes both. Checkpoints 5 and 6 pass this index to Details and the bubble.
- **Tests:** `source-block-index.test.ts` has 11 cases: one build for 30 reads plus per-entry memo; cached `null` units; `peek()` never snapshots; rebuild after a `characterData` edit drained before delivery; rebuild after `href`/`src` changes but not `class`/`style`/`aria-*`/fold attributes; revision change with identical DOM; caching under the post-snapshot key; `'authority'` for mode, owner and root changes; no key without revision or projection; opt-in `indexBuilds`; disposal. Two source mutations were caught: caching under the pre-snapshot key, and not draining pending records. `finish-init.test.ts` proves one counted build across two hovers (`{ blockHandleSnapshotCalls: 1, indexBuilds: 1 }`) and no snapshot after disposal.
- **Results:** `media-src/src/nav` + `finish-init.test.ts` 152/152 passing. `module-boundaries.test.ts` stays 3/7 red for the same pre-existing reasons (manifest totality lists other unrelated files, `markdown->platform`, `editing->links`). `source-block-index` and `real-lute` are in the manifest and absent from its missing list. Chromium `block-handle.spec.ts --retries=0` 17/17, including the warmed-cache and fidelity cases. `npm run typecheck` passes.

#### Checkpoint 5 (2026-09-26, local Part 2, Claude Opus 5.5)

**5a.** `editing/details-source.ts` (new, in the manifest) now holds the resolver moved from `details-toggle.ts`, plus `buildDetailsSourceIndex` (lines, fences, Details tags and pairs, built once per Markdown string), `resolveDetailsBlockRangeIn` with a binary-search line lookup, and `classifyDetailsSelection`. `details.ts` exports `detailsSelectionStatus`, which holds the balanced-tag and immediate-pair rules. `transformDetailsSelection` calls it first and builds strings only for wrap or unwrap, so the rules exist once and the output bytes are unchanged.

**5b.** `editing/details-selection-state.ts` (new, in the manifest) maps a live Range to rendered offsets. Per H5 it works in rendered space: `buildDetailsSourceIndex(entry.rendered)` and `nav/block-handle.ts::pairRenderedSpans` (a rescan of the rendered bytes, accepted only for a one-to-one member pairing), both memoized on the index entry. It counts DOM line breaks (`<br>` included; `data-render` previews and zero-width spaces excluded), guarded per unit by equality with the unit's rendered line breaks. An end boundary at a line's DOM start needs the source prefix to decide `lineForOffset(end - 1)`; it is derived only from an exact suffix match or a text node directly in a block element. The parity oracle (live-marker capture plus transform, in the test only) produced these rules, each confirmed by a failing sweep before the rule:
- Endpoints inside an `html`/`html-group` unit (every Details enclosure is one group unit) are `'unknown'`. The block-handle resolver declines coalesced and one-sided wrappers, so every state there is `'unknown'`.
- Element-container endpoints (root between blocks, `(p, 0)`, `(p, childCount)`) and endpoints inside IR's `# ` heading marker are `'unknown'`: the old marker capture itself fails there and reports `disabled`.
- A fence or table endpoint strictly inside the unit is `'disabled'`. At the unit's first or last DOM text position it is `'unknown'`, because IR shows fence markers as text and WYSIWYG hides them. A fully covered unit uses its span.
- A pipe on an endpoint line (the resolver's table role) and units overlapping a fence are `'unknown'`. An empty mapped range is `'disabled'` only when both columns are exact.

**5c.** `installDetailsToggleControls(index?)`: IR/WYSIWYG read `index.peek()`, or `read()` once settled. The selection settles on primary release, or after one quiet frame with no key or primary button held, which also covers programmatic selections. Nothing is built, captured or marked while the primary button is held. `'unknown'` runs today's `captureTarget` once per settled selection generation. The action captures once, from the live Range with `authoritativeMarkdown: entry.rendered` when the entry is warm (no `getValue`/`snapshotMarkdown`), and otherwise with today's `captureTarget`. SV and index-less installs keep the old per-selection capture. `finish-init.ts` passes the shared index; the Chromium Details harness mirrors that wiring (shared index, block handle, `setValue`-advanced revision, opt-in cache metrics).

**Rulings (deviations from the plan text):**
- Retained state: the plan's key-bound `{ range, key, status }` failed the real-VS-Code `details-toolbar.spec.ts` (after wrapping, the button showed disabled, not pressed). The old controller relied on `captureTarget(...) ?? retained`, where the post-toggle capture can fail and a collapsed caret keeps the pressed state. It now keeps the old semantics, validating the toggle result against `entry.rendered` (the bytes `getValue()` returns) once per entry instead of calling `getValue()` per update. A new controller test fails without that fallback.
- No containing unit, or element-container endpoints, give `'unknown'`, not `'disabled'`, per the oracle.
- The classifier parity grid is in `details-source.test.ts`. The resolver change (binary search, precomputed fences) is proven by reused-index equals fresh-index resolution over the grid and a line-boundary property test, not by a copied old resolver: jscpd tokens are 8.58% against the 8.8% threshold.
- `testing/real-lute.ts` is a new test-only loader. The oracle sweep samples three points per text node, plus block-element boundaries; a five-point sweep also passed (about 245 s).

**Checks (all `--retries=0`):**
- Units: 19 focused files, 266 tests passing. `details-selection-state.test.ts` has 11 IR/WYSIWYG oracle sweeps over prose (with a hard break and inline markup), mixed blocks, Details, unresolved Details and CRLF. Text selections in prose never need the fallback. Two rule mutations (heading marker, fence edge) were caught.
- `details-toggle-controls.test.ts`, 7 cases: 30 warm selection changes plus retained reads and passive mutations make no calls to callout capture, `insertNode`, `getValue`, `snapshotMarkdown` or `snapshotPair`; a held drag builds nothing, and release builds once; the fallback runs once per settle; button pointerdown makes one capture (two markers); unwrap is pressed after a toggle; the retained fallback. Forcing the legacy path fails 4 of them.
- Chromium: `details.spec.ts` 11/11, `block-handle.spec.ts` 17/17.
- Real VS Code after an interim `node build.mjs`: `details-toolbar.spec.ts` 1/1; `block-handle.spec.ts` + `large-document-interaction.spec.ts` 15/15, including Task 573's warmed zero-serialization gates.
- `npm run typecheck` passes. `typecheck:strict` has the same diagnostics as HEAD. Biome is clean except the two pre-existing format errors (`list-harness.ts`, `escape-toolbar.ts`). knip reports nothing new; the Checkpoint 4 `SourceBlockIndexInvalidation` export was made module-local.
- Changed-line coverage: new logic is covered except defensive returns. Uncovered changed lines are moved resolver code, re-indented `finish-init.ts` action callbacks and guard branches.
- `npm run depcruise` cruises 0 modules (installed TypeScript 7 is unsupported by dependency-cruiser; environment limitation, not a pass). The `edit-sync.test.ts` real-Lute parity describe got a 60 s timeout because coverage instrumentation exceeded the 5 s default.

**Diagnostic (Chromium `selection-performance.spec.ts`, not acceptance):** the Details harness went from 26 full reads plus 26 marker insertions per slow-keyboard phase to 1 full read and 0 markers, in both modes. The bubble still performs 24–26 full reads until Checkpoint 6.

**Open risk for Checkpoint 7, feedback path:** the one remaining read per keyboard phase is an index rebuild. On an unedited document, Vditor's `Undo.recordFirstPosition` → `addCaret` inserts and removes a caret element on keydown, and `fixCJKPosition` inserts a zero-width space for keys such as Home at line start. Both are genuine DOM mutations, and production does not patch them. The index must not ignore them (no broadening of the ignore list), so the warm passive gate "0 index builds" may see one rebuild per keyboard phase in real VS Code. Mouse drags are unaffected. Decide in Checkpoint 7 from real-VS-Code evidence.

#### Review of Checkpoints 3–5 (2026-09-26)

A fresh-context review of `8960ae07..d8ae3563`, focused on the task's Review focus, found the Checkpoint 3 and 4 changes sound and the extraction behavior-neutral. It raised these points on the Checkpoint 5 controller, all fixed in one pass. Each fix has a test that failed first:
- **Settling could stall (Important).** Keys are held only for physical keydowns (non-empty `code`), so the IR table panel's synthetic keydowns without a keyup no longer block settling. A keyup with no modifier down clears the set, which covers macOS dropping letter keyups under Cmd. Test: a synthetic `=` keydown, then a Meta+A chord released without the A keyup, both settle.
- **Retained result on the action path (Important, alternative fix).** Tying the retained result to the source revision, as suggested, would drop the pressed state across native Undo/Redo, which the real-VS-Code `details-toolbar.spec.ts` asserts. Display keeps the old rendered-bytes check. Applying the retained result on the action path now also requires the entry's exact bytes to equal it, so an invisible external change (for example CRLF) is never reverted. Test: after changing exact bytes invisibly, activating with a collapsed caret posts nothing.
- **Preview boundaries (Minor).** A boundary inside a `data-render` preview or non-editable chrome is `'unknown'`. Test: an IR inline-math preview endpoint.
- **No index key (Minor).** A settled selection with no cacheable key now uses today's exact capture instead of keeping a stale state. Test: no revision authority, then one key step captures once.
- Helpers moved to top-level functions for the Biome complexity limit.
- **Deferred to Checkpoint 7 (Minor, cost):** the exact fallback's markers invalidate the shared entry, so `'unknown'` regions pay a rebuild per settled selection. The review also noted that `pending` from a button pointerdown that never becomes a click survives until the next toggle; this predates Task 574 and is outside its scope.

Re-run after the fixes: focused units 266/266; Chromium `details.spec.ts` 11/11; `node build.mjs`, then real-VS-Code `details-toolbar.spec.ts` 1/1 (`--retries=0`). Typecheck is clean, and Biome shows only the two pre-existing format errors.

### Part 1 handoff — 2026-09-26 (fresh bounded reasoning pass on the consolidated plan)

Source-only review of the current working tree. No probe, build or test was run in this pass. Where this handoff differs from a checkpoint above, the handoff wins; the owner-approved design (shared index, one shared status classifier, `snapshotPair`, settle-time exact fallback) is unchanged.

**H1. `snapshotPair()` parity (Checkpoint 3) — confirmed by construction.**

- `rendered` is the value `serializeForHost()` returns. It is `vditor.getValue()` in WYSIWYG, in IR below the incremental admission, and in IR while `seedState === 'pending'`. Only seeded incremental IR returns the incremental cache, which Task 69/537 keep byte-identical and which `flushEdit` audits on save.
- A drifted incremental `rendered` fails closed: `resolveBlockHandleUnits` first checks `proof.serialize(root.innerHTML) === rendered` and returns `null`. No misaligned unit can be produced.
- Keep the side effects exactly: set `exactTransactionRendered` on first read, revoke plus `advanceSourceRevision()` on mismatch.
- **Correction:** `runFinishInit` deps are built in `media-src/src/boot/vditor-init.ts` (the `finishInit` closure), not in `main.ts`. Wire `snapshotPair` there. `main.ts` needs no change for Checkpoint 3.

**H2. Cold-hover gate for the committed fixture (Checkpoints 1 and 7).**

- The synthetic fixture has 265 top-level IR blocks. That is below both incremental admission thresholds (700 blocks, or 350 blocks plus nested structure). Seeded incremental IR therefore never runs on this fixture, and IR cold hover calls `getValue` twice today: once inside `snapshotExactMarkdown`, once for `rendered`.
- Fixture expectation after Checkpoint 3: **1** full `getValue` per cold hover in IR **and** WYSIWYG (baseline 2). The "0 when IR incremental is seeded" case is proven only by the Checkpoint 3 unit test. Do not add a new large fixture.
- The resolver still runs its own full `proof.serialize(root.innerHTML)` and, when `exact !== rendered` (true on this fixture), the projection render and serialize. These are not `getValue` calls. The ≥ 40 % cold-hover target applies to the `getValue` serializer time that Task 573 measured (median 318 ms). The `root.innerHTML` check repeats the `rendered` serialization byte-for-byte; removing it would be a resolver change outside the approved scope. Record it as a possible follow-up only.
- Cold-after-edit phase: the keystroke and Undo schedule the 250 ms edit-sync idle post, and that post runs a full `getValue`. Start the cold counters only after that post completes (the host has received the `edit` message and the webview has no pending edit timer). Otherwise the post is counted as hover work.

**H3. Checkpoint 2 working-tree guard — verified, one gap.**

- The uncommitted `nativeSelecting` state, the capture `pointerdown`/`pointerup`/`pointercancel` listeners, window `blur`, the root/owner/mode reset, disposal and the `hover` guard match the plan. Internal block drag starts outside the root and is not affected. A native text drag gets `pointercancel` at `dragstart` and releases.
- **Gap:** a release outside the webview can skip both `pointerup` and `blur`. `nativeSelecting` then stays true and hides the handle until the next click. Add: in `hover`, when `nativeSelecting && (event.buttons & 1) === 0`, call `finishNativeSelection()` and carry on with the ordinary hover. Add a unit case for it.

**H4. Shared index and module boundaries (Checkpoint 4).**

- `test/backend/module-boundaries.test.ts` allows `editing->nav` but not `nav->editing`, and requires an acyclic module graph. So `nav/source-block-index.ts` must not import `editing/details.ts` at runtime. Replace `details(): DetailsSourceIndex` with a generic per-entry memo, for example `memo<T>(slot: symbol, build: (entry: SourceBlockIndex) => T): T`. `editing/details-selection-state.ts` owns its slot and builder.
- Type-only imports between `block-handle.ts` and `source-block-index.ts` are fine: the boundary test strips `import type`, and dependency-cruiser does not count pre-compilation-only type edges. Keep every runtime dependency injected, as the plan says.
- Add `'source-block-index'` to the `nav` ids in `scripts/module-manifest.mjs`. Add `'details-selection-state'` to `editing`, and `'details-source'` if 5a creates it.
- Metrics: keep `blockHandleSnapshotCalls` on the injected `snapshotPair` wrapper, so it covers index builds and action-time re-proofs. Increment `indexBuilds` only inside `read()` builds.
- `currentKey()` may fire `onInvalidate('authority')` when the bubble or Details calls it. The block handle then clears its display. This is correct; do not suppress it.

**H5. Details source space — correction to Checkpoint 5 (required for status parity).**

- The Details action works in **rendered** coordinates, not exact bytes. `captureCalloutActionTarget` → `captureRewrapSourceSelection` → `captureRewrapSourceRange` maps offsets through the mode serializer. It accepts the result only when it equals `authoritativeMarkdown`, which defaults to `vditor.getValue()`. `configureDetailsToggle` supplies `editSync.snapshotMarkdown()`, which is also rendered. On this fixture exact and rendered differ (174,517 vs 181,855 chars).
- Therefore:
  1. Build the Details source index from `entry.rendered`, not `entry.exact`.
  2. Unit offsets from the resolver are exact-byte offsets and cannot be used here. Export a pure helper from `nav/block-handle.ts`, for example `pairRenderedSpans(rendered, units)`. It runs `scanMovableBlocks(rendered)` and `pairSourceGroups` against `units.flatMap(u => u.members)`, and returns rendered `[start, end]` spans only when the pairing is one-to-one with the same member groups; otherwise `null` → `'unknown'`. It uses no Lute. Memoize it per entry.
  3. Line mapping, the `\n` count guard and `lineOf` all use the rendered spans and the rendered text.
  4. **Action path:** pass `entry.rendered` (not `entry.exact`) as `authoritativeMarkdown`. Passing `exact` makes `captureRewrapSourceRange` return `null` whenever `exact !== rendered`, which would break Details on noncanonical documents. For IR/WYSIWYG, call `captureRewrapSourceRange(window, range, { authoritativeMarkdown: entry.rendered })` directly. When the key is unchanged, use its `.markdown` in place of `configuredDeps.snapshotMarkdown()`. That saves two full serializations per action; the one marked serialization remains. When the key changed, use today's `captureTarget` unchanged.
  5. Keep the old `exactMarkdown` retained-after-toggle comparison, which ignores trailing breaks.
- Rendered space uses `\n` only, so CRLF parity with the old path is automatic. Keep the CRLF cases in the `transformDetailsSelection` parity grid.

**H6. Range → rendered offset edge cases (5b).**

- End boundary with no unit text before it (offset 0 of the next block, as with Shift+Down or a triple-click): map `end` to the end of the **previous** unit. Map a start boundary at the very end of a unit to the start of the next unit. The old marker path excludes that neighbouring block through `lineForOffset(end - 1)`; the parity grid must include both cases.
- A partial `fence`/`table` endpoint unit → `'disabled'`. A partial `html` unit → `'unknown'`. `units === null` or unpaired rendered spans → `'unknown'`. SV → no index; run today's SV path unchanged, including its passive update.
- `boundaryWhitespace(markdown.slice(...))` inside the classifier can slice a large enclosing region. It is linear and runs only for enclosing pairs, so it is acceptable; check it with the synthetic fixture timing before optimizing.

**H7. Details controller state (5c).**

- `primaryPointerHeld`: set on primary `pointerdown` inside the edit root. Clear it on document `pointerup`/`pointercancel`, window `blur`, `keydown`, and a capture `mousemove` with `(buttons & 1) === 0` that only acts while the flag is set. Clearing on pointer release marks the selection settled.
- After a successful toggle, `outer.setValue` and `postExact` change both `domRevision` and the revision. Bind the retained key on the next `update()` (after the rAF, when the rebuild microtasks are done), and treat that one update as settled. Then the pressed/unwrap state rebuilds the index once instead of keeping the pre-toggle state.
- Async preview rendering inside the root (`[data-render]`) counts as relevant for the index and can end retained state early. This fails closed, which is acceptable; do not widen the mutation-ignore list.

**H8. Bubble (Checkpoint 6).**

- `BubbleDeps extends SelectionLinkDeps`, and `runSelectedLink` needs `snapshotExactMarkdown`. Keep that field, derived as `() => snapshotPair().exact` in `finish-init.ts`, or pass link deps separately. Link actions must not lose their exact-source check.
- In `valid()`, also require `record.editor === record.key.root`. The production `editSync` always exists before `runFinishInit` (created in `vditor-init.ts`), so a `null` key means SV or an unavailable authority, not a normal visual state.

**H9. Checkpoint 1 additions.**

- `indexBuilds` does not exist until Checkpoint 4. In the red spec, read it as `?? 0` and label that value as not yet instrumented. In the Checkpoint 7 run, assert the field is defined.

**Implementation order and checks** stay as in Checkpoints 1–7 and the commit plan. Additional focused checks: the H3 release-fallback unit; the H5 rendered-span pairing unit on real Lute IR/WYSIWYG DOM, including list items, tables, fences and `<details>` groups; the H6 boundary rows in `details-selection-state.test.ts`; `module-boundaries.test.ts` after the manifest update.

**Open risks for Part 2 evidence (return them through the §2a feedback path if they occur):** rendered-span pairing may fail on parts of the fixture, so Details would fall back at settle and the passive zero-work gate would fail; incremental-IR parity could not be exercised on this fixture; the Checkpoint 7 ≥ 40 % cold-hover target assumes the Task 573 `getValue`-only timing definition.

**Part 1 status:** ready to implement. No owner decision is needed.

## Planning record

Created on 2026-09-26 from the completed 2026-09-25 selection investigation and current source review. Only task/queue documentation is authorized in this planning turn. No new runtime implementation, regression acceptance, or execution phase has started; all implementation checkboxes above are intentionally unchecked.

Planning validation: task/source links, reserved task number, pending queue status, dependency order and sequential numbering passed. The synthetic fixture, future queue and task index are unchanged. No runtime tests were run for this documentation-only update.

Consolidation on 2026-09-26 (Project Owner approved design): Task 573's cold-proof residual was folded in as Checkpoint 3. The block-handle presentation cache becomes the shared source block index (Checkpoint 4). Passive Details state uses that index and a status-only classifier shared with the action (Checkpoint 5). The bubble split now keys on the index (Checkpoint 6). The previous Checkpoint 5 became Checkpoint 7. Findings added from source review: call paths 5–7. This was a documentation-only change; no source, tests, queue file or task index were modified, and no runtime checks were run.
