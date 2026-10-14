# Task 609 — Restore caret offsets on the intended side of marker boundaries

**Status:** planned (2026-09-29). The Project Owner approved the interaction policy on 2026-10-08 (see Owner decisions); implementation has not started.
**Origin:** follow-up to [Task 600](done/600-no-blockless-caret-in-ir.md); coordinate with [Task 597](done/597-undo-restore-caret-without-marker.md) and [Task 608](608-remaining-blockless-caret-routes.md).
**Scope:** caret restoration at text-node boundaries. Preserve Task 600's fence-info exemption and Task 597's separate root/missing-marker restore work unless measurement shows a shared cause.

## Problem

`resolveBlockOffset` and `resolveTextOffset` accept `node.data.length >= remaining`. At a tie between adjacent text nodes, the restore can choose the end of the preceding Markdown marker instead of the start of content. A live caret intent can then keep reasserting that landing.

## Measured evidence

- `tmp/task600-checks/opus-t1-consult.md` traces Vditor's 800 ms opening Undo checkpoint through `addToUndoStack` → `addCaret` → the patched `vmdeCaretBlockOffset` → `resolveBlockOffset` (`media-src/src/editing/caret.ts:186-219`). A heading's `# ` marker and following text both represent block offset 2; the `>=` at line 210 resolves to `# `@2. The writer and cold-versus-warm timing remain a source-based diagnosis, not a completed native attribution probe.
- `tmp/task600-reg-bubble/report.md` reproduces a Turn Into conversion to a code fence with real Lute and the caret authority in jsdom. The content-start flat offset 4 resolves through `resolveTextOffset` to preceding fence-info ZWSP@1. On current code, the live intent reasserts that position after a programmatic selection of the next paragraph; a pointer gesture invalidates it. Browser paint and the user-visible editing effect are unmeasured.

## Affected modes

- **IR:** both supplied routes are measured or diagnosed here; confirm their native behavior.
- **WYSIWYG:** in scope by Owner decision; the shared resolver may serve its restore paths, so measure the outcome.
- **SV:** out of scope; it has no hidden markers.

## Candidate approaches

1. Make boundary ties prefer the following content text when it is a valid, paintable position in the same logical block; retain end-of-block and empty-block behavior.
2. Carry an explicit affinity or node-relative intent from capture to restore, avoiding a guess from a flat or block offset when the boundary has multiple DOM representations.
3. Normalize only confirmed marker landings at the caller, if changing shared offset semantics would disturb existing caret contracts.

## Owner decisions (2026-10-08)

Approved in chat by the Project Owner.

- At a marker/content tie the restore prefers the start of the visible content.
- Markers stay editable through explicit gestures: clicking the shown marker, arrowing into it, or Backspacing into it.
- A selection that VMDE sets deliberately on the user's behalf supersedes a pending caret intent.
- Scope is IR and WYSIWYG. SV has no hidden markers, so it is out of scope.

## Tests

- Unit cases for both resolvers at marker/content ties, mid-text positions, empty nodes, empty blocks, final text ends and block paths that clamp after a DOM spin.
- Chromium coverage for heading and fence-info restore, caret paintability, intentional visible-marker editing and selection-intent lifetime.
- Build first, then focused real-VS-Code XTEST coverage for the opening-checkpoint and Turn Into routes. Record the actual writer, selection, next typing result and exact host bytes without retrying placement.

## Acceptance

- [ ] Each reproduced boundary restores to the visible content start (the Owner-approved position) without inserting text into a hidden marker or changing Markdown during restoration.
- [ ] Intentional visible-marker editing, empty-block landings and existing Undo/root fallback behavior remain intact.
- [ ] Focused Chromium and real-VS-Code results establish the affected modes and exact host/Undo behavior; SV is out of scope (no hidden markers).

## Part 1 handoff (2026-10-14)

Read-only review of the source; native writer and timing are inferred and S1 measures them.

- **Cause and entry points.** Both resolvers settle a tie toward the earlier text node: `resolveTextOffset` and `resolveBlockOffset` (`media-src/src/editing/caret.ts`). Opening checkpoint: the patched capture `vmdeCaretBlockOffset` (`media-src/esbuild-shared.mjs`) records `Probe@0` as `{blockPath:[0], offsetInBlock:2}` and the restore resolves it to the end of the `# ` marker; while an intent is live (up to 300 frames) the marker normalizer keeps the marker landing (`editor-caret.ts`, `hasLiveCaretIntent()`). Turn Into: `applyVisual` (`block-transform-command.ts`) reduces the sentinel to flat offset 4, which `caretFromTextOffsets` resolves to the fence-info ZWSP. New (verified): the empty-block branch in `resolveTextOffset` runs before any marker logic, so a tie at a heading marker end followed by an empty gap paragraph jumps to that paragraph. New (inferred): `document-start` lands at the end of the first text node (`# `@2 in a heading); its only caller is the empty-document path — left unchanged and recorded.
- **Contract (Owner rules, refined).** (1) Tie rule: P = earlier text node ending at the offset, F = next non-empty text node starting at it; choose F only when P is inside a hidden marker (`.vditor-ir__marker`, not `--pre`), F is content (not in a non-`--pre` marker, `[data-render]` or `.vditor-ir__preview`), F is in the same logical block, and the intent has no backward affinity; every other tie keeps P (a generic "prefer F" would move `bold|**` into hidden syntax). (2) Affinity: the capture (`vmdeCaretBlockOffset` and both endpoints of `vmdeCaretSelectionEndpoint`; optionally `caret-preserve.ts`) records `affinity: 'backward'` when its DOM position is inside a non-`--pre` marker, so fence-info typing (editable source, Task 600 exemption) survives a checkpoint; Turn Into, table, list and selection-scope `textOffset` callers send no affinity (content-first). This keeps markers editable by click, arrow or Backspace. (3) Order: the same-block marker tie check runs before the empty-block preference; empty-block, clamp, empty-node skip and the root `{node, offset}` (Task 613) behaviour stay. (4) A deliberate VMDE selection supersedes a live intent: `requestCaret` writers already replace it; direct writers that can run without a preceding gesture call `invalidateCaret()` first (candidates: `details-toggle.ts` — strongest, `reading-position.ts`, the Find-range restore in `block-transform-command.ts`, `link-click-fix.ts`, `named-anchor-insertion.ts`; confirm each in S1); raw selection changes from outside VMDE do not supersede. (5) Modes: IR affected; WYSIWYG expected unchanged (no marker text nodes — measure in S1); SV out of scope.
- **Part 2.** S1: native probe in the real webview (wrap `addToUndoStack` and `__vmdeRequestCaret`: time, intent, stack): IR heading open, IR Turn Into, fence-info typing then checkpoint, the same in WYSIWYG, `details-toggle` followed by an intent reassertion. S2: `caret.ts` (`affinity?` on `blockPath` and `textOffset` intents; a shared tie helper), the capture patch in `esbuild-shared.mjs`, `invalidateCaret()` at the confirmed direct writers; units in `caret.test.ts` and `test/backend/vditor-source-patches.test.ts`; rerun `undo-restore-caret.test.ts` (Task 597 resolves through the same resolver). S3: Chromium `media-src/e2e/caret-marker-ties.spec.ts` (heading restore lands at content@0 and is paintable, typing gives `# xTitle`; click or ArrowLeft into the shown marker keeps the caret there and Backspace edits the marker; fence-info typing survives an 800 ms checkpoint; caret at code content after Turn Into; the details-toggle selection not reasserted). S4: real-VS-Code `test/vscode-e2e/caret-marker-ties.spec.ts` (XTEST: opening checkpoint then typing gives `# xProbe`; Turn Into then typing gives `` ```\nxalpha\n``` ``; WYSIWYG routes; record writer, selection, typing result, host bytes). S5: closure.
- **Unit edge cases.** `# `|`Title` → F, with backward affinity → P; heading with an empty next gap paragraph → heading content; fence open + info ZWSP + code → code@0, info `js` with backward affinity → info end; inline `foo `|`**` → P, `bold`|`**` → P, `**`|` after` → ` after`@0 (inline, unmeasured); marker followed by preview text only → P; empty split leftovers skipped; final text end, clamps and deep block paths unchanged; selection anchor/focus follow the same rule.
- **Decisions (provisional, reversible; within the Owner's 2026-10-08 rule).** (1) Backward affinity protects fence-info and other in-marker editing positions — adopted (without it the tie rule breaks fence-info typing, contradicting "markers stay editable"). (2) The tie rule covers inline markers too, with unit cases, labelled unmeasured — adopted. (3) The direct-writer `invalidateCaret()` audit is in S2, limited to writers S1 shows running without a gesture — adopted.
- **Risks.** S2 shares `media-src/esbuild-shared.mjs` and `test/backend/vditor-source-patches.test.ts` with Tasks 619 and 623 (merge onto committed work); the resolver serves about ten `textOffset` callers — rerun their unit and e2e suites; queued after Task 608.

## Execution progress — 2026-10-14 (S2a)

Scope: the tie rule and affinity in the caret resolvers, the capture patch, and the tests that prove them. Contract item 4 (the `invalidateCaret()` audit of direct writers) is S2b and is not touched. The planned stand-alone S1 real-VS-Code measurement is not run (Owner test-scope rule); the S4 real-VS-Code spec records the native writer, selection, typing result and host bytes. Chromium shows the routes here.

**Changed**

- `media-src/src/editing/caret.ts`: `affinity?: 'backward'` on the `blockPath` and `textOffset` intents; one shared tie helper (`tiedContentStart`). At a tie it returns the next non-empty text node F only when the earlier node P is inside a non-`--pre` `.vditor-ir__marker`, F is not inside such a marker, `[data-render]` or `.vditor-ir__preview`, F is in the same logical block (nearest `[data-block]`, `li` or `tr`), and the intent has no backward affinity. Every other tie keeps P. In `resolveTextOffset` the tie is decided before the empty-block preference (contract 3). Empty split leftovers are skipped, as before. Clamps, the empty-block landing, the root `{node, offset}` intent and `document-start` are unchanged.
- `media-src/esbuild-shared.mjs` (`patchUndoCaretSplitRestore`): `vmdeCaretBlockOffset` adds `affinity: "backward"` when its DOM position is inside a non-`--pre` marker; `vmdeCaretSelectionEndpoint` reaches it for both selection endpoints. Content, code (`--pre`) and root positions record none. Anchors are unchanged and each still matches once; a second application still throws. `docs/vditor-patch-checklist.md` has no row for this patch and no anchor changed, so it is not edited.
- Tests: `media-src/src/editing/caret.test.ts`, `test/backend/vditor-source-patches.test.ts` (the two existing fake DOM elements now answer `closest('.vditor-ir__marker')` selector-aware), and the new `media-src/e2e/caret-marker-ties.spec.ts`.

**Failing first.** Before the fix, `caret.test.ts` had 8 failing cases (heading blockPath and textOffset tie, heading plus empty gap paragraph, fence open + info ZWSP + code, fence info `js` without affinity, closing `**`|` after`, empty leftovers, selection endpoints) and the capture-patch tests had 3 failing cases. With the previous resolver the new Chromium heading case lands at the `# ` marker end (`inMarker: true`, offset 2); with the resolver fixed but the capture patch reverted, the fence-info case loses the info text (the caret moves into the code).

**Test map**

| Proof | Test |
| --- | --- |
| Acceptance 1: `# `\|`Title` resolves to the content start (blockPath and textOffset) | `caret.test.ts` marker/content ties |
| Acceptance 1 / contract 3: heading followed by an empty gap paragraph resolves into the heading; content end still prefers the empty block | `caret.test.ts` |
| Acceptance 1: fence open + info ZWSP + code resolves to code@0 (Turn Into route) | `caret.test.ts` |
| Acceptance 2: backward affinity keeps the marker end; fence info `js` keeps the info end; affinity changes nothing off a tie | `caret.test.ts` |
| Edge cases: inline `foo `\|`**` and `bold`\|`**` keep P, `**`\|` after` moves to ` after`@0 (inline, unmeasured in a real webview); marker then preview only keeps P; marker then marker keeps P; next block's content does not attract a tie; empty leftovers skipped; final text end, clamps and deep block paths unchanged; selection anchor and focus follow the same rule | `caret.test.ts` |
| Capture patch: affinity inside a non-`--pre` marker, none for content or `--pre`, per selection endpoint, single assignment site, second application throws | `vditor-source-patches.test.ts` |
| Opening checkpoint restore at heading content@0 lands at content@0, holds for 20 frames, typing `x` gives `# xProbe` | `caret-marker-ties.spec.ts` (Chromium) |
| Fence-info typing survives an 800 ms checkpoint, then typing continues in the info | `caret-marker-ties.spec.ts` (Chromium) |

**Checks run**

- Vitest: `caret.test.ts`, `vditor-source-patches.test.ts`, `undo-restore-caret.test.ts` (same resolver, via `resolveCaretIntent`): 3 files, 468 tests passed.
- Typecheck passed; Biome clean on the five changed files; `node build.mjs` passed.
- Chromium: the new spec (2 tests) passed. Callers of the changed resolvers, by harness import: `block-transform`, `list`, `list-normalize`, `table-format`, `keybugs`, `inline-picture` (60 passed); `structural-selection`, `turn-into-non-round-trip`, `toolbar-overflow`, `ime-composition`, `auto-wrap` (68 passed, 1 known failure: `auto-wrap` SV); `selection-bubble`, `block-handle`, `held-drag-undo-snapshot`, `undo-pending-diagram` passed; `undo-boundaries`, `blockless-caret`, `undo-restore-caret` passed except the intermittent case below.
- Intermittent, not a regression: `undo-restore-caret.spec.ts:135` (`a caret marker at the editable root / inside a rendered preview is not used for the restore`) fails in some runs because the change site is the heading (`Probe@0`); the same intermittent failure occurs with the previous `caret.ts` (3 of 4 runs failed one of its cases there, and about half of the runs on the fixed code). `caret-link.spec.ts` (IR) failed once under two parallel workers and passed alone twice with the fix and twice without.

**Open**

- Real-VS-Code behaviour of the opening checkpoint, Turn Into, the WYSIWYG routes and the exact host bytes: S4 (not run here).
- Inline-marker cases are unit-level only (unmeasured in a real webview).
- `invalidateCaret()` audit of direct writers: S2b.
- The Chromium opening-checkpoint case calls Vditor's undo checkpoint function directly with the caret at content@0 rather than waiting for the debounce; the 800 ms debounce path is covered by the fence-info case.

## Execution progress — 2026-10-14 (S2b)

Scope: contract item 4 — a deliberate selection that VMDE writes supersedes a live caret intent. Each candidate direct writer was checked for whether it can run while an intent is live and be reasserted over; only a writer shown to need it gets `invalidateCaret()` before its selection write.

**Audit result**

| Writer | Result | Evidence |
| --- | --- | --- |
| `details-toggle.ts` (`runDetailsToggle`) | Needs the fix | Chromium (details harness with the caret authority installed as in the real webview): after the host-command route (`vmde-toggle-details`, no pointer or key event) the wrapped-body selection ended collapsed at the document start. Cause: the second undo checkpoint inside the command restores through the caret authority and arms an intent for the pre-rewrite caret; the command then writes its own selection, and the live intent re-asserts the old caret over it. Without the authority bridge the selection stays. |
| `reading-position.ts` (`restorePosition`) | Not needed | The mechanism exists (probe: with a `document-start` intent armed just before the restore, the restored caret was replaced), but no intent is live on the real path: a live-intent check at the restore showed none, and the only intent armed before the restore at open is `placeInitialCaret`'s, which runs for an empty document only (nothing to restore). The probe was temporary and is not kept. Open: a defensive `invalidateCaret()` there is possible if the Owner wants it. |
| Find-range restore (`captureDeferred` in `block-transform-command.ts`) | Not needed, not reproduced | It runs inside an explicit Turn Into request and its caller replaces the intent right after (`requestCaret` on apply). The only exposure is a refused or cancelled request after a Find or cold-index focus transfer with an intent armed after the last gesture; no cheap Chromium route builds that state, so it is unmeasured. |
| `link-click-fix.ts` (`replaceWithCaretAndReparse`) | Not needed | It runs inside a Delete or Backspace keydown handler; the caret authority's keydown listener is registered first (`installCaretInvalidation` before `fixLinkClick` in `boot/main.ts`) and already dropped the intent in the same event. |
| `named-anchor-insertion.ts` (`restoreCollapsedRange`) | Not needed | It runs from the dialog's submit (a pointer or key gesture), is followed by checkpoints that capture the same position, and the visual-mode path ends in `requestCaret`; SV writes its own caret. |

**Changed**

- `media-src/src/editing/details-toggle.ts`: `invalidateCaret()` after the second checkpoint and before the selection write, with a comment stating why.
- `media-src/e2e/details-harness.ts`: installs the caret invalidation listeners and the authority bridge, in the order `boot/main.ts` uses, so the harness reproduces the real checkpoint restore.

**Tests (failing first)**

- Vitest `details-toggle-controls.test.ts`: a checkpoint that arms an intent (as the bridge does) does not leave a live intent after the toggle, the wrapped-body selection holds, and a later `requestCaret` still arms and writes (edge: the normal intent path is unchanged). It failed before the fix on the live-intent check.
- Chromium `caret-marker-ties.spec.ts` (details toggle case): after the host-command toggle and 20 frames the selection is still the wrapped body. It failed before the fix (collapsed selection, empty text).

**Checks run**

- Vitest: `details-toggle-controls.test.ts`, `details-toggle.test.ts`, `details-turn-into-pending.test.ts`, `find-widget.test.ts` (importers of the changed writer): 4 files, 130 tests passed.
- Typecheck and Biome on the changed files passed.
- Chromium: `caret-marker-ties.spec.ts` (3 tests), `details.spec.ts` and `selection-performance.spec.ts` (they load the details harness): 15 passed.

**Open**

- Real-VS-Code confirmation of the host-command route and the Find-range refusal path: S4 or later.

## Execution progress — 2026-10-15 (S4)

Scope: the real-VS-Code proof for the committed tie fix, with OS-level (XTEST) typing, plus the open items that S2a and S2b assigned to this step. No product code changed. The planned stand-alone S1 measurement is folded in: the spec records the native writer, the selection, the typing result and the host bytes in `tmp/task609-checks/s4/` (ignored) and attaches them to each test result.

**Spec:** `test/vscode-e2e/caret-marker-ties.spec.ts` (5 tests, one VS Code boot each, XTEST via `createXtestInput`, skipped unless `VMDE_XTEST=1`). Pointer clicks only focus the webview; no pointer gesture follows the restore under test.

**Test map**

| Proof | Test |
| --- | --- |
| Acceptance 1 (IR): a caret at flat block offset 2 of `# Probe` (end of the hidden `# ` and start of `Probe`) is restored by the debounced Undo checkpoint to `Probe`@0, outside the marker, the Markdown is unchanged by the restore (webview and host bytes), the landing holds for 20 frames, and the next typed `x` gives `# xProbe` | IR heading |
| Acceptance 1 (IR): Turn Into Code Fence (native QuickPick and confirmation dialog) from a caret at the paragraph start restores the caret to the code content start (flat offset 4, painted, not the fence info line); typing `x` gives `` ```\nxalpha\n``` `` | IR Turn Into Code Fence |
| Acceptance 2 (markers stay editable): a caret at the end of the fence info text stays there across the 800 ms Undo checkpoint (backward affinity); a second typed character continues in the info line (host `` ```jsxy ``) | IR fence info |
| Affected modes: WYSIWYG heading (no marker text, so content start is offset 0): checkpoint restore keeps `Probe`@0, typing gives `# xProbe`; WYSIWYG Turn Into outcome recorded only | WYSIWYG |
| Contract 4 / S2b open item: the real toolbar Details toggle leaves the wrapped-body selection (non-collapsed, same text) after 20 frames, host bytes exact | IR Details toggle |

**Measurements (native)**

- Writer: every Undo checkpoint in the heading and fence-info tests is the debounced timer callback of Vditor's `processAfterRender` (`undoDelay`, matched in the bundle at `enableAddUndoStack && addToUndoStack` inside the timer); the opening checkpoint has the same caller and no selection, so it is not a tie. Turn Into's checkpoint is called from `apply-block-transform-choice`; the Details toggle's from the toolbar click handler.
- Heading tie: the caret after the Backspace is an element position in the heading (block offset 2). The checkpoint captures it as `{blockPath:[0], offsetInBlock:2}`; the restore request is the same intent and lands on `Probe`@0. Host stays at the original bytes until `x` is typed.
- Turn Into (IR): the post-apply request is `{blockPath:[0,2], offsetInBlock:0}` and the caret is at the code content start.
- Fence info: the capture records `{blockPath:[0], offsetInBlock:7, affinity:"backward"}` and the caret stays at the end of the info text.
- Details toggle: the toggle's second checkpoint arms a request (`{textOffset:0}` from the root caret); the selection of the wrapped body is not replaced.

**Finding (recorded, not asserted): WYSIWYG Turn Into Code Fence.** The restore after the apply places the caret in the code block's hidden source (`pre.vditor-wysiwyg__pre`, `display: none`; request `{blockPath:[0,0], offsetInBlock:0}`; the caret element has no layout box). A typed `x` is delivered (`beforeinput`) but the selection collapses to the editor root and the host bytes stay `` ```\nalpha\n``` ``. WYSIWYG has no marker text nodes, so the tie rule cannot change this path (by source: the tie helper acts only when the earlier node is inside an IR marker); it was not measured on the code before the fix. Separate from this task; for Task 608 (blockless caret routes) or a new task if the Owner wants it.

**Not covered**

- The Find-range refusal path (S2b open): no existing state reaches it cheaply; still unmeasured.
- Inline-marker cases remain unit-level.
- The opening checkpoint itself is not a tie in these documents (it ran with no selection); the tie route uses the same writer and was reached through a Backspace at the content start, because a caret placed during the first 800 ms would be timing dependent.
- Undo/Redo steps after the routes: not exercised here; the guards are the Chromium and unit cases from S2a and the existing Task 597 and Task 600 specs.

**Checks run**

- `caret-marker-ties.spec.ts`: 5 passed (`--workers=1 --retries=0`, XTEST shell with Openbox).
- Controls that exercise changed files: `blockless-caret.spec.ts` (resolver, Probe@0 routes) 2 passed; `details-toolbar.spec.ts` (Details toggle writer) 1 passed.
- `npm run typecheck:vscode-e2e` and Biome on the spec: clean.

**Open**

- Owner decision: whether the WYSIWYG Turn Into hidden-source landing needs a task.
- Acceptance 3 still needs the closure batch (S5).
