# Task 664 — A foreign selection write retires a stale caret intent

**Status:** done (2026-11-01).
**Origin:** Project Owner request (follow-up of Tasks 649 and 652).
**Severity:** medium (caret reliability).
**Tech stack:** webview (caret authority in `media-src/src/editing/caret.ts`; Vditor editing surface in IR, WYSIWYG and Split source).
**Related:** [Task 649](649-section-indentation-by-heading-level.md) (section indentation by heading level, where the finding was recorded); [Task 652](652-restore-caret-after-preview-off.md) (restore caret after Preview is turned off, where the analysis was recorded).

## Problem

The caret authority keeps a live intent and re-asserts it on animation frames until a gesture invalidates it (`keydown`, `pointerdown`, `beforeinput` or `compositionstart`) or 300 ticks pass.

A selection written programmatically without `requestCaret`, such as an `addRange` or `setBaseAndExtent` call by another module or by test code, does not retire the intent. A later layout or configuration event can then restore an older caret over that selection.

Task 649 recorded this finding (`done/649-section-indentation-by-heading-level.md`). The analysis is in the Part 1 handoff of Task 652 (item D7b).

About 20 call sites use `requestCaret`. Vditor's own undo and spin writes are what the caret authority intentionally overrides, so a fix must tell VMDE-intended selection writes apart from Vditor churn.

## Requirements

1. Part 1 measures the actual Task 649 mechanism before any fix is designed.
2. A deliberate selection write by VMDE code retires or replaces a stale caret intent.
3. Vditor churn (undo and spin writes) is still overridden by the caret authority.

## Open design points

- How VMDE-intended selection writes are marked, distinct from Vditor writes.
- Whether a foreign write retires the intent or replaces it with the new selection.

## Scope

- In: retirement or replacement of a stale caret intent when VMDE code writes the selection without `requestCaret`; the measurement in Part 1.
- Out: the Vditor override behaviour for undo and spin writes; the Task 652 Preview restore; any other caret behaviour.

## Acceptance

- [x] Part 1 records the measured Task 649 mechanism.
- [x] A deliberate selection write by VMDE code retires or replaces a stale caret intent.
- [x] Vditor undo and spin churn is still overridden by the caret authority.

## Tests

- To be specified in Part 1 (webview behaviour; real-VS-Code verification is required for behaviour that depends on the VS Code integration).

## Part 1 handoff (2026-11-01)

### Measured mechanism (acceptance item 1)

Scratch Chromium probe on the prerender harness (untracked, `tmp/664/probe-649.spec.ts`), run in IR, WYSIWYG and Split on the current code and on a build of the Task 649 commit `f1bbc2fc`. Selection writes were traced by wrapping the `Selection` write methods in the page.

- **The Task 649 sequence alone does not reproduce.** A caret and then a range, both written with `addRange` by `selectEditorText`, with and without three live `config-changed` messages (indentation on, size 40, off) in between: the range is unchanged after the next frames and after every configuration change, on both builds. No VMDE code wrote the selection after the test's own writes (zero traced product writes). A programmatic `addRange` does not arm an intent, and a configuration change does not restore a caret by itself.
- **The actual mechanism is the live intent's frame loop.** With an intent armed through the authority (`window.__vmdeRequestCaret({ textOffset: 10 })`, or a `{ anchor, focus }` intent), a range written with `addRange` is overwritten on the next animation frame in all three modes (the selection read in the following three frames is the intent's position), and it stays overwritten after the configuration changes. `tick()` rewrites because the live selection no longer matches the resolved target (`caret.ts` `tryPlace`: a collapsed intent requires a collapsed range at the target; a selection intent compares both endpoints).
- **The window is bounded by the intent's lifetime.** After waiting 6 seconds (beyond `MAX_TOTAL_TICKS`, 300 frames), the same foreign range survives the frames and the configuration changes.
- Conclusion: the configuration change in the Task 649 note was not the cause; it was the first observation point. A stale intent overrides any foreign selection write for up to about 5 seconds after the last `requestCaret` (or until a gesture). In Task 649 an intent was most likely armed by another authority caller during the test's setup (the exact caller of that run cannot be recovered; the spec as committed sets caret and range in separate pages). Task 652's inference F11 ("a later layout or configuration event") is refuted as the trigger; the frame loop alone is enough.

### Problem, root cause and scope

- Root cause: the authority cannot tell a deliberate VMDE selection write from Vditor churn, so every write outside `requestCaret` is treated like churn and overwritten while an intent is live.
- Raw selection writes in non-test webview source outside `caret.ts`: 83 calls in 29 files (pattern below). `gap-nav-fixture.ts` (2 calls) is a test fixture imported only by `gap-nav.test.ts` and `gap-click.test.ts`, so 81 calls in 28 product files are in scope.
- `requestCaret` has 93 references in 29 non-test files (the record's "about 20" counted call sites in ADR-0007's list only); `requestCaret` callers are not changed.
- Shared interfaces: `caret.ts` exports and the window bridge declared in its `declare global` block. No host message, setting, state key, storage format or DOM attribute changes.
- Source-fidelity invariants: no document text, Undo history, dirty state or scroll change; Vditor's vendored code is not modified; the undo bridge `window.__vmdeRequestCaret` keeps its behaviour.

### Provisional decisions

- **Provisional decision (2026-11-01), reversible — D1, how VMDE writes are marked.** Explicit helpers in `caret.ts`, selected by a recorded decision check (probability 0.98): `writeSelection(target)` retires the live intent, then writes; `writeSelectionKeepingIntent(target)` writes and leaves the intent untouched. Vditor writes stay unmarked, so they keep today's behaviour (overridden). A detector based on `selectionchange` or on `tick()` divergence, and a global wrap of `Selection.prototype`, were rejected: neither can tell Vditor churn from a VMDE write without patching vendored code, and neither fails safe. Evidence: the probe above; Task 652 item D7b.
- **Provisional decision (2026-11-01), reversible — D2, retire or replace.** Retire, selected by a recorded decision check (probability 0.99). Many writers set a range and then run a Vditor command that moves the caret (emoji, math, picture, link popover, subscript insertion); a replacement intent would pull the caret back on the next frame. A retired intent reproduces the measured state in which a foreign range survives.
- **Provisional decision (2026-11-01), reversible — D3, migration scope.** Migrate all 81 product calls to one of the two helpers, and add a source guard test, selected by a recorded decision check (probability 1.0). Classification rule: a write is transparent (`writeSelectionKeepingIntent`) only if it writes back a selection read earlier in the same synchronous operation; every other write is deliberate (`writeSelection`). A doubtful site uses `writeSelectionKeepingIntent` (today's behaviour), and the step report records it.
- **Provisional decision (2026-11-01), reversible — D4, public names and signatures** (settled for Part 2):
  ```ts
  export interface SelectionEnds {
    anchorNode: Node
    anchorOffset: number
    focusNode: Node
    focusOffset: number
  }
  /** Deliberate selection write: retires the live caret intent, then writes. */
  export function writeSelection(target: Range | SelectionEnds): boolean
  /** Transparent restore: writes and leaves the live caret intent armed. */
  export function writeSelectionKeepingIntent(target: Range | SelectionEnds): boolean
  ```
  A `Range` is written with `removeAllRanges()` and `addRange()`; `SelectionEnds` with `setBaseAndExtent()` (a collapsed `collapse(node, offset)` site passes the same node and offset twice). Both return `false` and swallow the error when the write throws (a stale endpoint); `writeSelection` has retired the intent before the write in that case too (fails open). Neither depends on `primaryPointerHeld`. `installCaretWindowBridge()` also sets `window.__vmdeWriteSelection = writeSelection`, declared next to `__vmdeRequestCaret`, so vendored or test code can mark a deliberate write. No numbering or storage format is involved. ADR-0007 gets one paragraph naming the two helpers.
- **Provisional decision (2026-11-01), reversible — D5, guard.** `test/backend/selection-writes.test.ts` reads every non-test `.ts` file under `media-src/src` and fails on `\.(addRange|setBaseAndExtent|removeAllRanges|collapseToStart|collapseToEnd|selectAllChildren|setPosition|extend|empty)\(` or `\.collapse\([^)]*,` (the two-argument `Selection.collapse`; one-argument `Range.collapse` is allowed), except in `editing/caret.ts` and `editing/gap-nav-fixture.ts`. A textual guard is used because the installed TypeScript 7.0.2 has no JavaScript compiler API (`ts.createProgram` is undefined). No current non-test site uses `.extend(`, `.empty(`, `.setPosition(` or `.selectAllChildren(` on another type.

### Acceptance and edge cases mapped to tests

| Item or edge case | Layer, file and test title |
|---|---|
| A1: measured mechanism | This handoff (probe results above). |
| A2: a deliberate VMDE write retires a stale intent | Vitest `media-src/src/editing/caret.test.ts`, new describe "Task 664: marked selection writes": "writeSelection retires a live collapsed intent and the written range survives later frames"; "writeSelection retires a live selection intent and keeps a backward selection's direction". Real VS Code `test/vscode-e2e/foreign-selection-intent.spec.ts`: "a marked selection write survives a stale caret intent and a live setting change" (IR, WYSIWYG, Split: arm `__vmdeRequestCaret({ textOffset: 10 })`, write a range through `__vmdeWriteSelection`, wait three frames, toggle `vmde.editor.sectionIndent` on and off as in `preview-caret.spec.ts`, then anchor, focus and selected text are unchanged). Vitest `test/backend/selection-writes.test.ts`: "webview source writes the selection only through the caret authority's helpers" (every VMDE path is marked). |
| A3: Vditor undo and spin churn still overridden | Vitest `caret.test.ts`: "an unmarked addRange while an intent is live is overwritten on the next frame"; "writeSelectionKeepingIntent leaves the live intent armed". Real VS Code new spec: "an unmarked selection write is still overridden by a live intent". Existing real VS Code: `undo-restore-caret.spec.ts` (Task 597 cases, needs `VMDE_XTEST=1`), `caret-authority-rebuild.spec.ts`, `list-enter-undo-caret.spec.ts`. |
| Stale endpoint: write throws | Vitest: "writeSelection with a detached endpoint returns false and still retires the intent". |
| Write during a held primary press | Vitest: "writeSelection during a held primary press writes once and leaves no intent". |
| Bridge installed | Vitest: "installCaretWindowBridge exposes __vmdeWriteSelection". |
| Migrated modules keep their behaviour | Each migrated module's existing Vitest file (focused run in S3 and S4). |
| No live intent at write time | Covered by the retire cases (a retire with no intent is a no-op; asserted in the first A2 case's precondition variant). |

A Chromium spec is not needed: the behaviour is the authority's frame loop, covered by Vitest (with injected frames) and by the real-VS-Code spec.

### Part 2 steps

- **S1 – RED.** Owned: `media-src/src/editing/caret.test.ts`, new `test/backend/selection-writes.test.ts`, new `test/vscode-e2e/foreign-selection-intent.spec.ts`. Import the helpers so a missing export fails at run time. Checks: `npx vitest run --config test/vitest.config.mts media-src/src/editing/caret.test.ts test/backend/selection-writes.test.ts` (expected: new cases fail with "is not a function", the 80 existing cases pass, and the guard lists the 28 product files); `node build.mjs`, then the new spec through the real-VS-Code wrapper (expected: the marked-write case fails because `__vmdeWriteSelection` is undefined; the unmarked-write control passes).
- **S2 – GREEN, helpers.** Owned: `media-src/src/editing/caret.ts`, `docs/adr/0007-caret-ownership.md`. Implement D4. Checks: the caret Vitest file (all green); `npm run typecheck`; `npx biome check` on the changed files; `node build.mjs`; the new real-VS-Code spec (both cases green). The guard stays red until S4.
- **S3 – GREEN, migration part 1.** Owned: `chrome/toolbar.ts`, `clipboard/clipboard-line.ts`, `links/link-click-fix.ts`, `nav/reading-position.ts`, and under `editing/`: `block-action-client.ts`, `block-transform-command.ts`, `callout-nav.ts`, `code-block-enter.ts`, `dblclick-word-select.ts`, `details-toggle.ts`, `edit-activity.ts`, `emoji-insertion.ts`, `format-hotkey-guard.ts`, `html-subscript-command.ts` (all under `media-src/src/`). Apply the D3 rule; the step report lists each call with its class and reason. Checks: the Vitest files of these modules; the guard now lists only the S4 files; `npm run typecheck`; `npx biome check` on the changed files.
- **S4 – GREEN, migration part 2.** Owned (under `media-src/src/editing/`): `html-subscript.ts`, `id-insertion.ts`, `inline-picture.ts`, `ir-whole-document-edit.ts`, `link-popover.ts`, `list-normalize.ts`, `math-insertion.ts`, `selection-format-actions.ts`, `selection-link-actions.ts`, `selection-scope.ts`, `sv-selection-edit-dom.ts`, `table-actions.ts`, `undo-boundaries.ts`, `wysiwyg-code-highlight.ts`. Same rule and report. Checks: these modules' Vitest files; the guard green; `npm run typecheck`; `npx biome check`; `node build.mjs`; real VS Code: `foreign-selection-intent.spec.ts`, `undo-restore-caret.spec.ts`, `caret-authority-rebuild.spec.ts`, `list-enter-undo-caret.spec.ts` in one wrapper call.
- **Independent review** of the caret diff and the classification tables, then closure (record, gates as the queue defines them).

### Open questions and risks

- Classification errors: a transparent restore marked deliberate could let late Vditor churn win in that path. Mitigation: the doubtful-site rule and the review of the classification tables.
- The exact authority caller that armed the intent in the Task 649 run is not recoverable; the mechanism itself is measured.

### Amendment D6 (2026-11-01): where the write helpers live

The first migration step found that importing `editing/caret.ts` from `chrome/toolbar.ts`, `clipboard/clipboard-line.ts` and `nav/reading-position.ts` adds the inter-module edges `chrome->editing`, `clipboard->editing` and `nav->editing` and the cycle `chrome, editing, links, nav`, which `test/backend/module-boundaries.test.ts` rejects. Those four files were left unchanged; the ten `editing/` files were migrated.

- **Provisional decision (2026-11-01), reversible — D6, a low-level home for the helpers.** Selected by a recorded decision check (probability 1.0). A new `media-src/src/util/selection-write.ts` owns `SelectionEnds`, `writeSelection`, `writeSelectionKeepingIntent` and the private write (`applySelection`), plus `setIntentRetirer(retire: () => void): void`. `writeSelection` calls the registered retirer, then writes. `caret.ts` calls `setIntentRetirer(invalidateCaret)` at module load and re-exports the three names, so `caret.test.ts`, the window bridge and the ten migrated `editing/` files keep working unchanged. Evidence: the allow list already holds `chrome->util`, `clipboard->util`, `editing->util`, `links->util` and `nav->util`; the new file imports nothing, so it adds no edge. Initialization: the live intent exists only inside `caret.ts`, so a write made before `caret.ts` has loaded cannot meet a live intent, and the default retirer (a no-op) is correct. No work is added to the per-frame path. Rejected: calling the window bridge from the four files (untyped, depends on install order), leaving them raw in the guard allow list (three of them are deliberate writes, so Requirement 2 would not hold), and moving `caret.ts` into `util` (it imports `editing/trailing-paragraph.ts`, which would add `util->editing`).
- `scripts/module-manifest.mjs` gets one id, `selection-write`, in the `util` module (its manifest check fails on any unlisted file). The guard allow list becomes `editing/caret.ts` (the authority's own `tryPlace` writes), `util/selection-write.ts` and `editing/gap-nav-fixture.ts`. The ADR-0007 paragraph names the new file.
- **Review of the `html-subscript-command.ts` change.** The removed `addRange` branch ran only when `Selection.setBaseAndExtent` is missing. It exists in every engine this extension runs in (VS Code's Chromium webview) and in jsdom, so that branch never ran. The first review found the error path changed: a throwing write used to be caught by the command's outer `catch` and reported through `deps.onError`. After the repair a rejected write throws again from `restoreTargetRange`, `setDirectionalSelection` (html-inline commands) and `setSelection` (math commands), so it is reported through `deps.onError` as before; only a read-back mismatch returns `false` (the caller rolls back, the earlier improvement).

### Revised Part 2 steps (replacing S3's unfinished part and S4)

- **S3b – helpers move and the four cross-module files.** Owned: new `media-src/src/util/selection-write.ts`, `media-src/src/editing/caret.ts` (move the helpers out, register the retirer, re-export), `scripts/module-manifest.mjs` (one id), `test/backend/selection-writes.test.ts` (allow list), `docs/adr/0007-caret-ownership.md` (name the file), and the four files `chrome/toolbar.ts` (transparent), `clipboard/clipboard-line.ts` (three deliberate), `links/link-click-fix.ts` (deliberate; drop the unused `sel` parameter), `nav/reading-position.ts` (deliberate), importing from `../util/selection-write`. The reverted diff in the step's scratch patch is the reference, with the import path changed. Checks: `npx vitest run --config test/vitest.config.mts` on `media-src/src/editing/caret.test.ts`, `test/backend/module-boundaries.test.ts`, `test/backend/selection-writes.test.ts` (now lists only the S4 files' offenders) and the four modules' test files; `npm run typecheck`; `npx biome check` on the changed files.
- **S4 – migration part 2.** Unchanged owned files and checks (the 14 `editing/` files listed above); the S4 files keep importing from `./caret`. The guard turns green here.


## Result and verification (2026-11-01)

### Implemented

- `media-src/src/util/selection-write.ts` (new): `SelectionEnds`, `writeSelection` (retire the live intent, then write), `writeSelectionKeepingIntent` (write, leave the intent armed), `setIntentRetirer`. `caret.ts` registers `invalidateCaret` at load, re-exports both helpers and installs `window.__vmdeWriteSelection`. All 81 raw Selection writes in 28 webview source files now use one of the two helpers; `scripts/module-manifest.mjs` lists the new file under `util`; ADR-0007 paragraph 2a names it.
- `test/backend/selection-writes.test.ts` fails on any raw Selection write outside `editing/caret.ts`, `util/selection-write.ts` and `editing/gap-nav-fixture.ts` (comments stripped, whole-file scan, multi-line `collapse(`, `modify`; a fixture proves the detector).

### Provisional decisions (all reversible)

- D1 explicit helpers mark VMDE writes; Vditor writes stay unmarked and overridden (selected by a recorded decision check, probability 0.98).
- D2 a marked write retires the intent rather than replacing it (0.99).
- D3 migrate every product call site by the rule "transparent only if it writes back a selection read earlier in the same synchronous operation; doubtful sites keep the intent", plus a source guard (1.0).
- D4 public names and signatures as in the Part 1 handoff; the window bridge is `__vmdeWriteSelection`.
- D5 textual guard, because the installed TypeScript has no JavaScript compiler API.
- D6 the helpers live in `util/selection-write.ts` with a registered intent retirer, so no module edge or cycle is added (1.0).

### Per-site classification

Deliberate (`writeSelection`): block-transform-command restore, code-block-enter, callout-nav, block-action-client, dblclick-word-select, details-toggle, emoji-insertion (caret and rollback), html-subscript `placeCaretInBody`, html-subscript-command `setDirectionalSelection`, inline-picture reveal, ir-whole-document-edit, link-popover (two), list-normalize `placeTextOffset`, math-insertion `setSelection`, selection-scope (two), sv-selection-edit-dom (two), clipboard-line (three), link-click-fix, reading-position.

Transparent (`writeSelectionKeepingIntent`): format-hotkey-guard, edit-activity (two), html-subscript-command (`restoreTargetRange`, `restoreToolbarSelectionOrigin`, `restoreRetainedRange`), list-normalize dragstart restore, math-insertion `restoreRange`, selection-format-actions, selection-link-actions, table-actions, undo-boundaries `keepBlocklessRange`, wysiwyg-code-highlight, and the three doubtful sites `inline-picture.ts` `restoreRange`, `id-insertion.ts` `restoreCollapsedRange` and `chrome/toolbar.ts` `restoreEditorRange` (they write back a stored range, but not in the same synchronous operation as the read, so they keep today's behaviour).

### Tests that prove the acceptance items

- Item 1: the Part 1 handoff (measured, Chromium probe on current code and the Task 649 build).
- Item 2: `caret.test.ts` "Task 664: marked selection writes"; real-site `code-block-enter.test.ts` "the relocated caret survives later frames and the intent is retired" (fails when the site is flipped to the keep-intent helper); `selection-writes.test.ts`; real VS Code `foreign-selection-intent.spec.ts` "a marked selection write survives a stale caret intent and a live setting change" (IR, WYSIWYG, Split).
- Item 3: `caret.test.ts` unmarked-write and keep-intent cases; real-site `format-hotkey-guard.test.ts` "restoreCommandSelection puts the selection back and leaves a live caret intent armed"; real VS Code `foreign-selection-intent.spec.ts` "an unmarked selection write is still overridden by a live caret intent"; existing `undo-restore-caret`, `caret-authority-rebuild` and `list-enter-undo-caret` specs.

### Verification actually run

Vitest for all changed modules, `caret.test.ts`, `selection-writes.test.ts`, `module-boundaries.test.ts` (green); `npm run typecheck`, `typecheck:vscode-e2e`, `lint:ci`, `check:brand-identifiers`, `knip`, `jscpd`, `depcruise` (exit 0); `test:coverage` exit 0 (statements 81.95 %, branches 75.04 %, functions 84.7 %, lines 84.36 %) and the zero-coverage ratchet (9 of baseline 9); real VS Code (one wrapper call after `node build.mjs`): `foreign-selection-intent` (2), `undo-restore-caret` (4), `caret-authority-rebuild`, `list-enter-undo-caret`: 8 passed. Dependency audits were omitted by instruction. Reporting only: `check:bundle-size` and `check:startup-cost` exit 1 on the already-over budgets (`main.js` 1089 KB against 608 KB; 407 eager modules against 294), the same stage the known-failures list names for the eager-module count.

### Residuals

- `keepBlocklessRange` (`undo-boundaries.ts`) writes back its range with the intent kept; this is the unchanged earlier behaviour (pre-existing).
- The guard and the helpers cover writes made in the main webview window only; a write in another document (an embedded frame) is not covered.
- A transparent site that is really a new selection would still be overridden while an intent is live; the doubtful-site rule keeps today's behaviour there.
