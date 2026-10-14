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
