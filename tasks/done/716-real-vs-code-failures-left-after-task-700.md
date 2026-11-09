# Task 716 — Real-VS-Code failures that already exist on dev (after Task 700)

**Status:** done (2026-11-09). Fix `56a6b385`, tests `82ff835d`. Split out of Task 700 (decision D18).
**Origin:** Task 700 full real-VS-Code run, one spec file per call, compared with the base `d6859ac4`.
**Severity:** medium (estimated). The full real-VS-Code suite is not green, so new regressions are harder to see.
**Depends on:** none.

## Problem

These cases fail when run alone on the Task 700 result and on the base `d6859ac4`:

- `html-link-display.spec.ts:235` (WYSIWYG HTML link): `locator.click` times out after 30 s.
- `toolbar-overflow.spec.ts:702` (Emoji 17 pointer selection): an equality check fails.
- `wiki-front-matter-aliases.spec.ts:124` (alias chip): `locator.waitFor` times out after 15 s, or a focus check fails.
- `turn-into-non-round-trip.spec.ts:395` (R9, SV): the QuickPick opens. Timing race: base fails 1 of 5 with `--repeat-each=5`. Diagnosis from Task 700: the spec's `selectTarget` arms the caret authority (`__vmdeRequestCaret`), which places the text caret back over the element caret the test sets. A verified test fix passes the `addRange` placement to `selectTarget` (6 of 6).
- `contextual-panel-clearance.spec.ts:25` (line 194): after Escape in the callout panel `select`, the IR editor is not focused. Timing race: base fails 2 of 5. Diagnosis from Task 700: the structural Escape handler in `selection-scope.ts` takes the Escape (focuses the editor, leaves the panel open), and the 50 ms refocus in `callouts.ts` moves focus back to the `select`. Cancelling the refocus on a trusted key did not fix it (3 of 6 still fail). Untested proposal: skip the structural Escape when the event target is inside `.vmde-callout-context-panel`, like the Task 659 toolbar exclusion.

## Decisions

- D1 (provisional, 2026-11-09, orchestrator, R3): R9 gets the test-only fix A: R9 calls `selectTarget(ctx, smallTarget, '', false, 'addRange')`, so no caret intent is armed over the element caret the test sets. Option B (change the caret authority) rejected.
- D2 (provisional, 2026-11-09, orchestrator, R3): contextual panel gets fix P-B: `selection-scope.ts` skips the structural Escape when the event target is inside `.vmde-callout-context-panel`, like the Task 659 toolbar exclusion. If P-B alone still fails, measure again before adding a second change.
- D3 (provisional, R3): `html-link-display:235` is a product defect (first bad `d543a35b`): fix A, `native-popover-position.ts` clears the stale owner target when the caret block is not one VMDE positions, and leaves Vditor's own placement. Option B (position every block) rejected as wider.
- D4 (provisional, R3): `wiki-front-matter-aliases:124` test fix T2: click the paragraph before placing the caret (the webview sometimes never gets focus; `.vditor-ir` cannot take focus).
- D5 (provisional, R3): `toolbar-overflow:702` test fix: `await waitForInitialUndoSnapshot(frame)` after the reopen, before the selection is written.
- Open (not in scope): the heading popover placed below an H1 still overlaps the next text line. Recorded for a possible follow-up task; the Owner decides.
- Split: Part 2a implements D1 and D2 (RED first). Part 1b measures the other three cases.

## Progress

- 2026-11-09 Part 2a: D1 (R9 `addRange`) and D2 (`selection-scope.ts` skips the structural Escape inside `.vmde-callout-context-panel`, Vitest RED then GREEN). Real VS Code repeat 5: contextual-panel-clearance 5 of 5 pass; R9 4 of 5 (the first iteration still opens the QuickPick).
- 2026-11-09 Part 1b: causes measured for the other three (report kept with the run logs): html-link-display product defect (stale popover target, first bad `d543a35b`, parent `eced5185` passes); toolbar-overflow test defect (selection written before Vditor's first undo snapshot, which clears it; copy with the wait 5 of 5); wiki-front-matter-aliases test defect (webview not focused; copy with a click 5 of 5).
- 2026-11-09 Part 2b: D3 popover fix (a still-live owner is cleared when the caret block is not one VMDE positions; a disconnected owner still hides the stale panel), Vitest RED then GREEN; D4, D5 test fixes; R9 also waits for the first undo snapshot (its first iteration failed for the same reason as D5).
- 2026-11-09 orchestrator: real VS Code `--repeat-each=5`: html-link-display:235 6 of 6, wiki-front-matter-aliases:124 6 of 6, toolbar-overflow:702 (now :707) 5 of 5, R9 (now :399) 5 of 5, contextual-panel-clearance:25 5 of 5; the whole html-link-display, contextual-panel-clearance, wiki-front-matter-aliases and toolbar-overflow specs 16 of 16. `npm run quality` exit 0. Full-suite runs move to the next full gate (provisional).

## Proposed work

1. For each case, measure the cause and find whether the test or the product is wrong. Find the first bad commit where the product is wrong.
2. Fix each cause with a failing test first.

## Acceptance

- [x] Each case has a measured cause, and the first bad commit where it is a product defect.
- [x] Each case passes alone 5 of 5 (`--repeat-each=5`). Full suite: at the next full gate (provisional).
- [x] `npm run quality` passes.
